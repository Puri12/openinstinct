import { randomUUID } from "node:crypto";

import type {
  ChildKind,
  ChildOrigin,
  ChildPriority,
  ChildRecord,
  ReceiptRecord,
  StateStore,
} from "../store/index.ts";
import { projectOrphanReceipt, projectTerminalReceipt, projectTurnReceipt } from "./receipts.ts";
import { type TerminalReport, verifyTerminalReport } from "./terminal-journal.ts";

export interface ChildRegistration {
  readonly kind: ChildKind;
  readonly priority: ChildPriority;
  readonly origin: ChildOrigin;
  readonly title: string;
  readonly prompt: string;
  readonly timeoutMs: number;
}

export interface TerminalAdmission {
  readonly child: ChildRecord;
  readonly receipt: ReceiptRecord;
}

/**
 * The child registry is deliberately a thin StateStore facade: no child module
 * reaches into SQLite directly, and journal evidence is required before a
 * journal-backed terminal state becomes externally visible.
 */
export class ChildRegistry {
  private readonly now: () => Date;

  public constructor(
    private readonly store: StateStore,
    options: { readonly now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  public updateProgress(id: string, progress: { readonly tokens?: number; readonly toolCalls?: number }): ChildRecord {
    return this.store.updateChildProgress(id, progress, this.timestamp());
  }

  public register(input: ChildRegistration): ChildRecord {
    return this.store.createChild({
      id: randomUUID(),
      kind: input.kind,
      priority: input.priority,
      origin: input.origin,
      title: input.title,
      prompt: input.prompt,
      timeoutMs: input.timeoutMs,
    }, this.timestamp());
  }

  public list(): ChildRecord[] {
    return this.store.listChildren();
  }

  public listLive(limit?: number): ChildRecord[] {
    return this.store.listLiveChildren(limit);
  }

  public countLive(): number {
    return this.store.countLiveChildren();
  }

  public listEvictable(): ChildRecord[] {
    return this.store.listEvictableChildren();
  }

  public markAdmitted(childId: string): ChildRecord {
    return this.store.markChildAdmitted(childId, this.timestamp());
  }

  public markRunning(childId: string): ChildRecord {
    return this.store.markChildRunning(childId, this.timestamp());
  }

  public markIdle(
    childId: string,
    input: { readonly sessionFile?: string; readonly lastAssistantText?: string; readonly turnSeq: number },
  ): ChildRecord {
    return this.store.markChildIdle(childId, input, this.timestamp());
  }

  public markCold(childId: string): ChildRecord {
    return this.store.markChildCold(childId, this.timestamp());
  }

  public markTerminated(childId: string, reason: "released" | "idle_timeout" | "evicted"): ChildRecord {
    return this.store.markChildTerminated(childId, reason, this.timestamp());
  }

  public markQueuedTerminated(childId: string): ChildRecord {
    return this.store.markQueuedChildTerminated(childId, "released", this.timestamp());
  }

  public markOrphaned(childId: string): ChildRecord {
    return this.store.markChildOrphaned(childId, this.timestamp());
  }

  public admitTurnReceipt(
    child: ChildRecord,
    turnSeq: number,
    text: string,
    sessionFile?: string,
  ): TerminalAdmission {
    const now = this.timestamp();
    const receiptProjection = projectTurnReceipt({ ...child, ...(sessionFile === undefined ? {} : { sessionFile }) }, turnSeq, text);
    return this.store.admitChildTurnReceipt(child.id, {
      ...(sessionFile === undefined ? {} : { sessionFile }),
      lastAssistantText: text,
      turnSeq,
    }, {
      id: randomUUID(),
      childId: child.id,
      idempotencyKey: `child-turn:${child.id}:${turnSeq}`,
      contentHash: receiptProjection.contentHash,
      projection: receiptProjection.projection,
      ...(sessionFile === undefined ? {} : { artifactPath: sessionFile }),
    }, now);
  }

  public admitOrphanReceipt(
    child: ChildRecord,
    reason: "session_file_missing" | "liveness_unprovable",
  ): TerminalAdmission {
    const now = this.timestamp();
    const receiptProjection = projectOrphanReceipt(child, reason);
    return this.store.admitChildOrphanReceipt(child.id, {
      id: randomUUID(),
      childId: child.id,
      idempotencyKey: `child-orphan:${child.id}`,
      contentHash: receiptProjection.contentHash,
      projection: receiptProjection.projection,
    }, now);
  }

  /**
   * The caller must atomically publish the checksum-verified journal report
   * first. Only then may this method transition the child and admit its durable
   * receipt row.
   */
  public admitTerminal(report: TerminalReport, journalPath: string): TerminalAdmission {
    verifyTerminalReport(report);
    const now = this.timestamp();
    const receiptProjection = projectTerminalReceipt(report, journalPath);
    return this.store.admitChildTerminalReceipt(report.childId, {
      state: report.state,
      journalPath,
      terminalChecksum: report.checksum,
      terminalSummary: report.summary,
      ...(report.errorCode === undefined ? {} : { errorCode: report.errorCode }),
      ...(report.sessionFile === undefined ? {} : { sessionFile: report.sessionFile }),
    }, {
      id: randomUUID(),
      childId: report.childId,
      idempotencyKey: `child-terminal:${report.childId}:${receiptProjection.contentHash}`,
      contentHash: receiptProjection.contentHash,
      projection: receiptProjection.projection,
      artifactPath: journalPath,
    }, now);
  }

  public get(childId: string): ChildRecord | undefined {
    return this.store.getChild(childId);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}
