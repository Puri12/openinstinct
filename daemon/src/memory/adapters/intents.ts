import { randomUUID } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

import { holdForDrill } from "../../drills/hooks.ts";

import type { MemoryIntentRecord, StateStore } from "../../store/index.ts";
import { axisEntries, initializeMemory, memoryGit, memoryRoot, regenerateMap } from "../vendor/doctrine.ts";
import { loadRegistry } from "../vendor/registry.ts";
import { writeDailyCapture } from "./capture.ts";

export type MemoryOriginKind = "owner-chat" | "maintenance" | `task:${string}` | `monitor:${string}`;

export interface MemoryCaptureOrigin {
  readonly kind: MemoryOriginKind;
  readonly reference?: string;
}

export interface MemoryCaptureRequest {
  readonly origin: MemoryCaptureOrigin;
  readonly userText: string;
  readonly replyText: string;
  readonly idempotencyKey?: string;
  /**
   * When the exchange actually happened. Live turns omit it and get the
   * queue clock; a backfill supplies it so the entry lands in the daily file
   * for its real date instead of today's.
   */
  readonly occurredAt?: string;
}

export interface MemoryMaintenanceRequest {
  readonly label: string;
  readonly idempotencyKey: string;
}

export type MemoryClosureFaultPoint = "after-intent" | "after-write" | "after-commit";

export interface MemoryRecoveryReport {
  readonly queued: number;
  readonly written: number;
  readonly committed: number;
  readonly receipted: number;
  readonly quarantined: number;
}

export interface MemoryClosureQueueOptions {
  readonly store: StateStore;
  /** The OpenInstinct state root; its memory corpus is `<home>/memory`. */
  readonly home: string;
  readonly now?: () => Date;
  /** Test-only crash seam. Throwing leaves the durable rung behind for boot recovery. */
  readonly onFault?: (point: MemoryClosureFaultPoint, intentId: string) => void;
  readonly onEvent?: (event: string, fields: Record<string, unknown>) => void;
}

interface CapturePayload {
  readonly origin: MemoryCaptureOrigin;
  readonly userText: string;
  readonly replyText: string;
  readonly occurredAt?: string;
}

interface MaintenancePayload {
  readonly label: string;
}

class UnrecoverableMemoryIntentError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UnrecoverableMemoryIntentError";
  }
}

/**
 * Serializes the closure ladder. StateStore admission is the acceptance boundary;
 * filesystem, Git, and receipt work may happen later and are restart-replayable.
 */
export class MemoryClosureQueue {
  private readonly now: () => Date;
  private tail: Promise<void> = Promise.resolve();
  private initializing: Promise<MemoryRecoveryReport> | undefined;

  public constructor(private readonly options: MemoryClosureQueueOptions) {
    this.now = options.now ?? (() => new Date());
  }

  public get corpusRoot(): string {
    return memoryRoot(this.options.home);
  }

  public initialize(): Promise<MemoryRecoveryReport> {
    if (!this.initializing) {
      const active = this.recover();
      this.initializing = active;
      void active.finally(() => {
        if (this.initializing === active) {
          this.initializing = undefined;
        }
      }).catch(() => undefined);
    }
    return this.initializing;
  }

  public enqueueCapture(input: MemoryCaptureRequest): string {
    assertCaptureRequest(input);
    const id = randomUUID();
    const intent = this.options.store.admitMemoryIntent({
      id,
      idempotencyKey: input.idempotencyKey ?? `memory:capture:${id}`,
      kind: "capture",
      payloadJson: JSON.stringify({
        origin: input.origin,
        userText: input.userText,
        replyText: input.replyText,
        ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
      } satisfies CapturePayload),
    }, this.timestamp());
    this.fault("after-intent", intent.id);
    this.schedule(intent.id);
    return intent.id;
  }

  public enqueueMaintenance(input: MemoryMaintenanceRequest): string {
    assertMaintenanceRequest(input);
    const intent = this.options.store.admitMemoryIntent({
      id: randomUUID(),
      idempotencyKey: input.idempotencyKey,
      kind: "maintenance",
      payloadJson: JSON.stringify({ label: input.label } satisfies MaintenancePayload),
    }, this.timestamp());
    this.fault("after-intent", intent.id);
    this.schedule(intent.id);
    return intent.id;
  }

  /** Schedules work accepted atomically by a different coordinator. */
  public enqueueExistingId(id: string): void {
    this.schedule(id);
  }

  public async drain(): Promise<void> {
    await this.tail;
  }

  private schedule(id: string): void {
    const work = this.tail.then(async () => {
      const recoveryWasActive = this.initializing !== undefined;
      await this.initialize();
      if (!recoveryWasActive) {
        return;
      }
      const intent = this.options.store.getMemoryIntent(id);
      if (intent && intent.state !== "receipted" && intent.state !== "quarantined") {
        await this.process(intent);
      }
    });
    this.tail = work.catch((error) => {
      this.event("closure_failed", { intentId: id, message: messageOf(error) });
    });
  }

  private async recover(): Promise<MemoryRecoveryReport> {
    const root = await initializeMemory(this.options.home);
    const report: Mutable<MemoryRecoveryReport> = {
      queued: 0,
      written: 0,
      committed: 0,
      receipted: 0,
      quarantined: 0,
    };
    for (const intent of this.options.store.listMemoryIntents()) {
      if (intent.state === "receipted" || intent.state === "quarantined") {
        continue;
      }
      report[intent.state] += 1;
      try {
        await this.process(intent, root);
        report.receipted += 1;
      } catch (error) {
        if (error instanceof UnrecoverableMemoryIntentError) {
          this.options.store.quarantineMemoryIntent(intent.id, error.message, this.timestamp());
          report.quarantined += 1;
          this.event("intent_quarantined", { intentId: intent.id, reason: error.message });
          continue;
        }
        this.event("recovery_deferred", { intentId: intent.id, message: messageOf(error) });
      }
    }
    return report;
  }

  private async process(original: MemoryIntentRecord, initializedRoot?: string): Promise<void> {
    const root = initializedRoot ?? await initializeMemory(this.options.home);
    const payload = parsePayload(original);
    let intent = this.options.store.getMemoryIntent(original.id);
    if (!intent || intent.state === "receipted" || intent.state === "quarantined") {
      return;
    }

    if (intent.state === "queued") {
      if (intent.kind === "capture") {
        await this.ensureCapture(root, intent.id, payload as CapturePayload);
      } else {
        await regenerateMap(root);
      }
      intent = this.options.store.markMemoryIntentWritten(intent.id, this.timestamp());
      this.event("capture_written", { intentId: intent.id, kind: intent.kind });
      this.fault("after-write", intent.id);
      await holdForDrill("mid-closure");
    }

    if (intent.state === "written") {
      if (intent.kind === "capture" && !(await this.captureExists(root, intent.id))) {
        throw new UnrecoverableMemoryIntentError(`capture evidence is missing for written intent ${intent.id}`);
      }
      let commit = await this.commitFor(root, intent.id);
      if (!commit) {
        await memoryGit(root, ["add", "--all", "."]);
        const changes = await memoryGit(root, ["status", "--porcelain"]);
        if (!changes) {
          throw new UnrecoverableMemoryIntentError(`commit evidence is missing for written intent ${intent.id}`);
        }
        await memoryGit(root, ["commit", "-m", `Memory mutation\n\nOpeninstinct-Mutation-Id: ${intent.id}`]);
        commit = await this.commitFor(root, intent.id);
      }
      if (!commit) {
        throw new UnrecoverableMemoryIntentError(`commit trailer is missing for intent ${intent.id}`);
      }
      intent = this.options.store.markMemoryIntentCommitted(intent.id, commit, this.timestamp());
      this.event("corpus_committed", { intentId: intent.id, commit });
      this.fault("after-commit", intent.id);
    }

    if (intent.state === "committed") {
      const commit = intent.commitHash ?? await this.commitFor(root, intent.id);
      if (!commit) {
        throw new UnrecoverableMemoryIntentError(`commit evidence is missing for committed intent ${intent.id}`);
      }
      if (!(await this.hasReceipt(intent.id))) {
        await appendFile(
          join(this.options.home, "memory-receipts.jsonl"),
          `${JSON.stringify({ id: intent.id, commit, at: this.timestamp() })}\n`,
          "utf8",
        );
      }
      this.options.store.markMemoryIntentReceipted(intent.id, this.timestamp());
      this.event("receipt_appended", { intentId: intent.id, commit });
    }
  }

  private async ensureCapture(root: string, intentId: string, payload: CapturePayload): Promise<void> {
    if (await this.captureExists(root, intentId)) {
      await regenerateMap(root);
      return;
    }
    await writeDailyCapture(root, {
      originRefJson: JSON.stringify({
        kind: payload.origin.kind,
        ...(payload.origin.reference === undefined ? {} : { reference: payload.origin.reference }),
        mutationId: intentId,
      }),
      userText: payload.userText,
      replyText: payload.replyText,
      now: capturedAt(payload.occurredAt) ?? this.now(),
    });
  }

  private async captureExists(root: string, intentId: string): Promise<boolean> {
    const registry = await loadRegistry(root);
    const daily = registry.byId("daily");
    if (!daily) {
      throw new UnrecoverableMemoryIntentError("memory registry has no daily axis");
    }
    const evidence = `"mutationId":"${intentId}"`;
    for (const path of await axisEntries(root, daily)) {
      try {
        if ((await readFile(join(root, path), "utf8")).includes(evidence)) {
          return true;
        }
      } catch (error) {
        this.event("capture_evidence_read_failed", { intentId, path, message: messageOf(error) });
      }
    }
    return false;
  }

  private async commitFor(root: string, intentId: string): Promise<string | undefined> {
    try {
      const output = await memoryGit(root, [
        "log",
        "--all",
        "--format=%H",
        "--fixed-strings",
        "--grep",
        `Openinstinct-Mutation-Id: ${intentId}`,
      ]);
      return output.split("\n").find(Boolean);
    } catch (error) {
      const message = messageOf(error);
      if (message.includes("does not have any commits")) {
        return undefined;
      }
      throw error;
    }
  }

  private async hasReceipt(intentId: string): Promise<boolean> {
    try {
      return (await readFile(join(this.options.home, "memory-receipts.jsonl"), "utf8"))
        .split("\n")
        .some((line) => {
          if (!line) {
            return false;
          }
          try {
            return (JSON.parse(line) as { readonly id?: unknown }).id === intentId;
          } catch {
            return false;
          }
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  private fault(point: MemoryClosureFaultPoint, intentId: string): void {
    this.options.onFault?.(point, intentId);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private event(event: string, fields: Record<string, unknown>): void {
    this.options.onEvent?.(event, fields);
  }
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function parsePayload(intent: MemoryIntentRecord): CapturePayload | MaintenancePayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(intent.payloadJson);
  } catch {
    throw new UnrecoverableMemoryIntentError(`intent payload is invalid JSON: ${intent.id}`);
  }
  if (intent.kind === "capture") {
    if (!isRecord(parsed)
      || !isRecord(parsed.origin)
      || typeof parsed.origin.kind !== "string"
      || (parsed.origin.reference !== undefined && typeof parsed.origin.reference !== "string")
      || typeof parsed.userText !== "string"
      || typeof parsed.replyText !== "string") {
      throw new UnrecoverableMemoryIntentError(`capture intent payload is invalid: ${intent.id}`);
    }
    const origin: MemoryCaptureOrigin = {
      kind: parsed.origin.kind as MemoryOriginKind,
      ...(parsed.origin.reference === undefined ? {} : { reference: parsed.origin.reference }),
    };
    try {
      assertOrigin(origin);
    } catch {
      throw new UnrecoverableMemoryIntentError(`capture intent origin is invalid: ${intent.id}`);
    }
    return {
      origin,
      userText: parsed.userText,
      replyText: parsed.replyText,
      ...(typeof parsed.occurredAt === "string" ? { occurredAt: parsed.occurredAt } : {}),
    };
  }
  if (!isRecord(parsed) || typeof parsed.label !== "string" || parsed.label.trim().length === 0) {
    throw new UnrecoverableMemoryIntentError(`maintenance intent payload is invalid: ${intent.id}`);
  }
  return { label: parsed.label };
}

function assertCaptureRequest(input: MemoryCaptureRequest): void {
  if (!isRecord(input)) {
    throw new Error("memory capture input is invalid");
  }
  assertOrigin(input.origin);
  if (input.occurredAt !== undefined) {
    assertBoundedText(input.occurredAt, "memory capture occurredAt", 64);
    if (Number.isNaN(new Date(input.occurredAt).getTime())) {
      throw new Error("memory capture occurredAt must be an ISO-8601 instant");
    }
  }
  assertBoundedText(input.userText, "memory capture userText", 12_000, true);
  assertBoundedText(input.replyText, "memory capture replyText", 12_000, true);
  if (input.idempotencyKey !== undefined) {
    assertBoundedText(input.idempotencyKey, "memory capture idempotencyKey", 512);
  }
}

function assertMaintenanceRequest(input: MemoryMaintenanceRequest): void {
  if (!isRecord(input)) {
    throw new Error("memory maintenance input is invalid");
  }
  assertBoundedText(input.label, "memory maintenance label", 160);
  assertBoundedText(input.idempotencyKey, "memory maintenance idempotencyKey", 512);
}

function assertOrigin(origin: MemoryCaptureOrigin): void {
  if (!isRecord(origin) || typeof origin.kind !== "string") {
    throw new Error("memory capture origin is invalid");
  }
  const valid = origin.kind === "owner-chat" || origin.kind === "maintenance"
    || /^task:[^\s:][^\s]{0,159}$/.test(origin.kind)
    || /^monitor:[^\s:][^\s]{0,159}$/.test(origin.kind);
  if (!valid) {
    throw new Error("memory capture origin kind is invalid");
  }
  if (origin.reference !== undefined) {
    assertBoundedText(origin.reference, "memory capture origin reference", 512);
  }
}

function assertBoundedText(value: unknown, label: string, maximum = 12_000, allowEmpty = false): asserts value is string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > maximum) {
    throw new Error(`${label} must be ${allowEmpty ? "a string" : "a non-empty string"} no longer than ${maximum} characters`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function messageOf(error: unknown): string {
  return Array.from(error instanceof Error ? error.message : String(error)).slice(0, 500).join("");
}

/** Parses a backfilled capture instant; anything unusable falls back to the queue clock. */
function capturedAt(value: unknown): Date | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
