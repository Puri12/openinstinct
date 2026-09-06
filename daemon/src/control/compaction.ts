import { randomUUID } from "node:crypto";

import type { CompactAcceptanceState, CompactOperationState } from "./schema.ts";
import type { StateStore } from "../store/index.ts";

interface PersistedOperation {
  readonly operationId: string;
  readonly requestKey: string;
  readonly state: CompactOperationState;
  readonly errorCode?: string;
}

export interface CompactAcceptance {
  readonly operationId: string;
  readonly state: CompactAcceptanceState;
}

export interface CompactStatus {
  readonly operationId: string;
  readonly state: CompactOperationState;
  readonly errorCode?: string;
}

/** Performs the actual context compaction; resolves when the transcript is compacted. */
export type CompactRunner = () => Promise<void>;

const ACTIVE_KEY = "session.compact.active";
const STATUS_PREFIX = "session.compact.status.";

/**
 * Durable single-flight owner of `session.compact`. An accepted operation runs
 * the supplied compactor and settles as succeeded or failed; a daemon death
 * mid-compaction is recovered on next boot as `restart_interrupted` so an
 * operation never stays `running` forever.
 */
export class SessionCompaction {
  private runner: CompactRunner | undefined;
  private inFlight: Promise<void> | undefined;

  public constructor(
    private readonly store: StateStore,
    private readonly onSettled?: (status: CompactStatus) => void,
  ) {
    this.failInterruptedOperation();
  }

  /**
   * Installs the compactor once the main session exists. Until then the verb is
   * accepted only to be failed immediately, rather than silently pretending.
   */
  public setRunner(runner: CompactRunner | undefined): void {
    this.runner = runner;
  }

  /**
   * Retry contract (deliberately narrow): compaction is single-flight per
   * daemon. While one operation is active, every request — same `requestKey` or
   * not — receives `already_running` with the active operation id. Once an
   * operation settles (succeeded/failed/restart_interrupted), any request,
   * including a repeat of an earlier `requestKey`, starts a fresh operation:
   * `requestKey` is recorded for audit attribution, not idempotent dedup,
   * because re-compacting after a settle is always a meaningful new act.
   */
  public accept(requestKey: string): CompactAcceptance {
    const active = this.readActive();
    if (active) {
      return { operationId: active.operationId, state: "already_running" };
    }

    const operation: PersistedOperation = {
      operationId: randomUUID(),
      requestKey,
      state: "running",
    };
    this.writeOperation(operation);
    this.store.setMeta(ACTIVE_KEY, JSON.stringify(operation));
    this.inFlight = this.run(operation);
    return { operationId: operation.operationId, state: "accepted" };
  }

  public status(operationId: string): CompactStatus | undefined {
    const value = this.store.getMeta(`${STATUS_PREFIX}${operationId}`);
    if (value === undefined) {
      return undefined;
    }
    const operation = parseOperation(value);
    return {
      operationId: operation.operationId,
      state: operation.state,
      ...(operation.errorCode === undefined ? {} : { errorCode: operation.errorCode }),
    };
  }

  /** Test/shutdown seam: resolves once any in-flight compaction has settled. */
  public async drain(): Promise<void> {
    await this.inFlight;
  }

  private async run(operation: PersistedOperation): Promise<void> {
    const runner = this.runner;
    if (!runner) {
      this.settle(operation, "failed", "no_active_session");
      return;
    }
    try {
      await runner();
      this.settle(operation, "succeeded");
    } catch (error) {
      this.settle(operation, "failed", errorCodeOf(error));
    }
  }

  private settle(operation: PersistedOperation, state: CompactOperationState, errorCode?: string): void {
    this.writeOperation({
      ...operation,
      state,
      ...(errorCode === undefined ? {} : { errorCode }),
    });
    this.store.deleteMeta(ACTIVE_KEY);
    this.onSettled?.({
      operationId: operation.operationId,
      state,
      ...(errorCode === undefined ? {} : { errorCode }),
    });
  }

  private failInterruptedOperation(): void {
    const active = this.readActive();
    if (!active) {
      return;
    }

    this.writeOperation({
      ...active,
      state: "failed",
      errorCode: "restart_interrupted",
    });
    this.store.deleteMeta(ACTIVE_KEY);
  }

  private readActive(): PersistedOperation | undefined {
    const value = this.store.getMeta(ACTIVE_KEY);
    return value === undefined ? undefined : parseOperation(value);
  }

  private writeOperation(operation: PersistedOperation): void {
    this.store.setMeta(`${STATUS_PREFIX}${operation.operationId}`, JSON.stringify(operation));
  }
}

function errorCodeOf(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) {
      return code;
    }
  }
  return "compaction_failed";
}

function parseOperation(value: string): PersistedOperation {
  let candidate: unknown;
  try {
    candidate = JSON.parse(value);
  } catch {
    throw new Error("stored session.compact operation is invalid JSON");
  }

  if (!isRecord(candidate)
    || typeof candidate.operationId !== "string"
    || typeof candidate.requestKey !== "string"
    || !isOperationState(candidate.state)
    || (candidate.errorCode !== undefined && typeof candidate.errorCode !== "string")) {
    throw new Error("stored session.compact operation has an invalid shape");
  }

  return {
    operationId: candidate.operationId,
    requestKey: candidate.requestKey,
    state: candidate.state,
    ...(candidate.errorCode === undefined ? {} : { errorCode: candidate.errorCode }),
  };
}

function isOperationState(value: unknown): value is CompactOperationState {
  return value === "running" || value === "succeeded" || value === "failed" || value === "canceled";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}
