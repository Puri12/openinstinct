import { createHash } from "node:crypto";

import type { ChildRecord, ReceiptRecord, StateStore } from "../store/index.ts";
import { type MainTurnResult, type OwnerReplyInput } from "../omo-session/main-session.ts";
import { OWNER_SILENT_MARKER, isSafeOwnerText } from "../omo-session/owner-text.ts";
import type { TerminalReport } from "./terminal-journal.ts";
import { truncateUtf8, utf8Bytes } from "./utf8.ts";

const MAX_RECEIPT_PROJECTION_BYTES = 1_024;
const MAX_FOLLOW_UP_PROMPT_BYTES = 1_200;
const RECEIPT_RETRY_BACKOFF_MS = 1_000;
const SILENT_MARKER = OWNER_SILENT_MARKER;
export const FOLLOW_UP_PROMPT_PREFIX = "A background task has completed.";

export interface ReceiptTurner {
  turn(prompt: string): Promise<MainTurnResult>;
  /** MainSession is the sole owner-facing authority. */
  admitOwnerReply(input: OwnerReplyInput): { readonly id: string };
}

export interface ReceiptInboxOptions {
  readonly store: StateStore;
  readonly mainSession: ReceiptTurner;
  readonly now?: () => Date;
  readonly onEvent?: (event: string, fields: Record<string, unknown>) => void;
}

export interface ReceiptProjection {
  readonly contentHash: string;
  readonly projection: string;
}

/**
 * Creates the only owner-session payload retained for a background child. The
 * content hash is computed before truncation, so same-child duplicate terminal
 * content is idempotent even when its 1024-byte projection is shortened.
 */
export function projectTerminalReceipt(report: TerminalReport, journalPath: string): ReceiptProjection {
  const contentHash = hashReceiptContent(report);
  const prefix = `Background task “${report.title}” ${report.state}: `;
  const suffix = `${report.errorCode === undefined ? "" : ` (${report.errorCode})`} [journal: ${journalPath}]`;
  const suffixBytes = utf8Bytes(suffix);
  const projection = suffixBytes >= MAX_RECEIPT_PROJECTION_BYTES
    ? truncateUtf8(suffix, MAX_RECEIPT_PROJECTION_BYTES)
    : `${truncateUtf8(`${prefix}${report.summary}`, MAX_RECEIPT_PROJECTION_BYTES - suffixBytes)}${suffix}`;
  return { contentHash, projection };
}

export function projectTurnReceipt(
  child: Pick<ChildRecord, "title" | "sessionFile">,
  turnSeq: number,
  text: string,
): ReceiptProjection {
  return {
    contentHash: hashProjectionContent({ kind: "turn", turnSeq, summary: text }),
    projection: truncateUtf8(`Background task “${child.title}” update: ${text}`, MAX_RECEIPT_PROJECTION_BYTES),
  };
}

export function projectOrphanReceipt(
  child: Pick<ChildRecord, "title">,
  reason: "session_file_missing" | "liveness_unprovable",
): ReceiptProjection {
  const suffix = " (orphaned)";
  const suffixBytes = utf8Bytes(suffix);
  return {
    contentHash: hashProjectionContent({ kind: "orphan", reason }),
    projection: suffixBytes >= MAX_RECEIPT_PROJECTION_BYTES
      ? truncateUtf8(suffix, MAX_RECEIPT_PROJECTION_BYTES)
      : `${truncateUtf8(`Background task “${child.title}” orphaned: ${reason}`, MAX_RECEIPT_PROJECTION_BYTES - suffixBytes)}${suffix}`,
  };
}

/**
 * Converts persisted owner receipts into serialized main-session follow-ups.
 * Background components never admit to OwnerOutbox directly: MainSession
 * triages the evidence and is the only owner-facing delivery authority.
 */
export class ReceiptInbox {
  private readonly now: () => Date;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly blocked = new Map<string, number>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;

  public constructor(private readonly options: ReceiptInboxOptions) {
    this.now = options.now ?? (() => new Date());
  }

  public stop(): void {
    this.stopped = true;
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    this.blocked.clear();
  }

  public async process(receipt: ReceiptRecord): Promise<void> {
    if (this.stopped || receipt.state === "delivered" || this.isBlocked(receipt.id)) {
      return;
    }
    const existing = this.inFlight.get(receipt.id);
    if (existing) {
      return existing;
    }
    const processing = this.processOne(receipt).finally(() => {
      this.inFlight.delete(receipt.id);
    });
    this.inFlight.set(receipt.id, processing);
    return processing;
  }

  /** Drains terminal-but-undelivered owner receipts, including boot replays. */
  public async drain(): Promise<void> {
    while (!this.stopped) {
      const receipts = this.options.store.listPersistedReceipts({ origin: "owner" })
        .filter((receipt) => !this.isBlocked(receipt.id));
      if (receipts.length === 0) {
        return;
      }
      for (const receipt of receipts) {
        if (this.stopped) {
          return;
        }
        await this.process(receipt);
      }
    }
  }

  private isBlocked(receiptId: string): boolean {
    const retryAt = this.blocked.get(receiptId);
    if (retryAt === undefined) {
      return false;
    }
    const now = this.now().getTime();
    if (Number.isFinite(now) && now >= retryAt) {
      this.blocked.delete(receiptId);
      return false;
    }
    return true;
  }

  private async processOne(receipt: ReceiptRecord): Promise<void> {
    if (this.stopped) {
      return;
    }
    const current = this.options.store.getReceipt(receipt.id);
    if (!current || current.state === "delivered" || this.stopped) {
      return;
    }
    const child = this.options.store.getChild(current.childId);
    this.event("follow_up_started", {
      childId: current.childId,
      receiptId: current.id,
      contentHash: current.contentHash,
    });
    let result: MainTurnResult;
    try {
      result = await this.options.mainSession.turn(followUpPrompt(current, child));
    } catch (error) {
      if (this.stopped) {
        return;
      }
      this.event("follow_up_turn_failed", {
        childId: current.childId,
        receiptId: current.id,
        message: messageOf(error),
      });
      this.deferRetry(current, messageOf(error), "turn_failed");
      return;
    }
    if (this.stopped) {
      return;
    }
    if (result.kind !== "reply") {
      this.event("follow_up_turn_failed", { childId: current.childId, receiptId: current.id, code: result.code });
      this.deferRetry(current, `${result.code}: ${result.message}`, "turn_failed");
      return;
    }

    let candidate = result.text.trim();
    let text = safeOwnerText(candidate, current, child);
    if (text === undefined && candidate !== SILENT_MARKER) {
      let retry: MainTurnResult;
      try {
        retry = await this.options.mainSession.turn(rephraseFollowUpPrompt(current, child));
      } catch (error) {
        if (this.stopped) {
          return;
        }
        this.deferRetry(current, messageOf(error), "rephrase_failed");
        return;
      }
      if (this.stopped) {
        return;
      }
      if (retry.kind !== "reply") {
        this.event("follow_up_turn_failed", { childId: current.childId, receiptId: current.id, code: retry.code });
        this.deferRetry(current, `${retry.code}: ${retry.message}`, "rephrase_failed");
        return;
      }
      candidate = retry.text.trim();
      text = safeOwnerText(candidate, current, child);
    }
    if (this.stopped) {
      return;
    }
    if (text === undefined) {
      if (candidate === SILENT_MARKER || candidate.length === 0) {
        this.markDeliveredWithoutOutbound(current, candidate.length === 0 ? "silent_empty" : "silent");
        return;
      }
      this.event("follow_up_rephrased_unsafely", { childId: current.childId, receiptId: current.id });
      this.deferRetry(current, "main triage reply failed safety policy", "unsafe_rephrase");
      return;
    }

    let admitted: { readonly id: string };
    try {
      const authority = this.options.mainSession.admitOwnerReply;
      if (typeof authority !== "function") {
        throw new Error("owner delivery authority is not configured");
      }
      admitted = authority.call(this.options.mainSession, {
        idempotencyKey: `receipt-follow-up:${current.id}`,
        text,
        childId: current.childId,
      });
    } catch (error) {
      if (this.stopped) {
        return;
      }
      this.deferRetry(current, messageOf(error), "owner_delivery_failed");
      return;
    }
    if (this.stopped) {
      return;
    }
    this.options.store.markReceiptDelivered(current.id, this.now().toISOString());
    this.event("follow_up_admitted", {
      childId: current.childId,
      receiptId: current.id,
      contentHash: current.contentHash,
      ...(admitted.id.length === 0 ? { dropped: true } : { deliveryId: admitted.id }),
    });
  }

  private deferRetry(receipt: ReceiptRecord, message: string, reason: string): void {
    if (this.stopped) {
      return;
    }
    const now = this.now().getTime();
    this.blocked.set(receipt.id, (Number.isFinite(now) ? now : Date.now()) + RECEIPT_RETRY_BACKOFF_MS);
    this.event("follow_up_retry_scheduled", {
      childId: receipt.childId,
      receiptId: receipt.id,
      reason,
      retryAfterMs: RECEIPT_RETRY_BACKOFF_MS,
      message: message.slice(0, 500),
    });
    if (!this.retryTimers.has(receipt.id)) {
      const timer = setTimeout(() => {
        if (this.stopped) {
          return;
        }
        this.retryTimers.delete(receipt.id);
        this.blocked.delete(receipt.id);
        let current: ReceiptRecord | undefined;
        try {
          current = this.options.store.getReceipt(receipt.id);
        } catch {
          return;
        }
        if (this.stopped || !current || current.state === "delivered") {
          return;
        }
        void this.process(current).catch((error) => {
          if (this.stopped) {
            return;
          }
          this.event("follow_up_retry_failed", { receiptId: receipt.id, message: messageOf(error) });
        });
      }, RECEIPT_RETRY_BACKOFF_MS);
      timer.unref?.();
      this.retryTimers.set(receipt.id, timer);
    }
    if (reason === "unsafe_rephrase") {
      this.event("follow_up_retryable", { childId: receipt.childId, receiptId: receipt.id, reason });
    }
  }

  private markDeliveredWithoutOutbound(receipt: ReceiptRecord, reason: string): void {
    if (this.stopped) {
      return;
    }
    this.options.store.markReceiptDelivered(receipt.id, this.now().toISOString());
    this.event("follow_up_suppressed", {
      childId: receipt.childId,
      receiptId: receipt.id,
      contentHash: receipt.contentHash,
      reason,
    });
  }

  private event(event: string, fields: Record<string, unknown>): void {
    if (this.stopped) {
      return;
    }
    this.options.onEvent?.(event, fields);
  }
}

function hashReceiptContent(report: TerminalReport): string {
  return hashProjectionContent({
    state: report.state,
    title: report.title,
    summary: report.summary,
    ...(report.errorCode === undefined ? {} : { errorCode: report.errorCode }),
    ...(report.errorMessage === undefined ? {} : { errorMessage: report.errorMessage }),
  });
}

function hashProjectionContent(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function followUpPrompt(receipt: ReceiptRecord, child: ChildRecord | undefined): string {
  const outcome = isChildTimeout(child) ? "timed out from inactivity" : "finished";
  return truncateUtf8([
    `${FOLLOW_UP_PROMPT_PREFIX} Background task ${outcome}. This durable receipt is internal evidence, not owner-facing text.`,
    "First triage and take the appropriate action (retry, resume, redelegate, repair, clean state, or silently ignore) using available tools.",
    `Only if the owner must make a judgment, write one concise natural-language sentence. If no owner message is needed, reply exactly ${SILENT_MARKER}. Never quote raw state tokens, error codes, stack traces, file paths, or the receipt projection.`,
    receipt.projection,
  ].join("\n\n"), MAX_FOLLOW_UP_PROMPT_BYTES);
}

function rephraseFollowUpPrompt(receipt: ReceiptRecord, child: ChildRecord | undefined): string {
  return `${followUpPrompt(receipt, child)}\n\nYour previous draft was unsafe. Rephrase without raw tokens/paths; preserve the actionable owner decision. Do not quote receipt evidence.`;
}

function safeOwnerText(text: string, receipt: ReceiptRecord, child: ChildRecord | undefined): string | undefined {
  const candidate = text.trim();
  if (!candidate || candidate === SILENT_MARKER) {
    return undefined;
  }
  const fragments = [
    receipt.projection,
    receipt.artifactPath,
    child?.journalPath,
    child?.sessionFile,
    child?.errorCode,
    child?.terminalSummary,
    ...projectionFields(receipt.projection),
  ];
  return isSafeOwnerText(candidate, {
    forbiddenFragments: fragments,
    rejectInternalTokens: true,
  }) ? candidate : undefined;
}

function projectionFields(projection: string): string[] {
  const fields: string[] = [];
  for (const match of projection.matchAll(/\(([^()]{2,200})\)/g)) {
    fields.push(match[1]!);
  }
  const journal = /\[journal:\s*(.*?)\]/i.exec(projection)?.[1];
  if (journal) {
    fields.push(journal);
  }
  for (const match of projection.matchAll(/\b(?:session_file_missing|liveness_unprovable|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/gi)) {
    fields.push(match[0]!);
  }
  for (const match of projection.matchAll(/\b(?:error[_ ]?(?:code|message)|message|reason)\s*[:=]\s*([^\n\[\]()]{2,200})/gi)) {
    fields.push(match[1]!.trim());
  }
  try {
    collectSensitiveStrings(JSON.parse(projection) as unknown, fields);
  } catch {
    // Projections are normally plain text; JSON parsing is only an optional field extractor.
  }
  return fields;
}

function collectSensitiveStrings(value: unknown, fields: string[], key = ""): void {
  if (typeof value === "string") {
    if (/^(?:code|errorCode|errorMessage|reason|journalPath|sessionFile|artifactPath|projection|state)$/i.test(key)) {
      fields.push(value);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectSensitiveStrings(item, fields, key);
    }
    return;
  }
  for (const [entryKey, entry] of Object.entries(value as Record<string, unknown>)) {
    collectSensitiveStrings(entry, fields, entryKey);
  }
}

function isChildTimeout(child: ChildRecord | undefined): boolean {
  return child?.state === "timeout" || child?.errorCode === "child_timeout";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
