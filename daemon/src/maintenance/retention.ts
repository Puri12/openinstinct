import {
  existsSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import type { NdjsonLogger } from "../log.ts";
import type { StateStore } from "../store/index.ts";

export const RETENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
export const DAILY_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const DAEMON_LOG_MAX_BYTES = 32 * 1024 * 1024;
export const DAEMON_LOG_ROTATION_COUNT = 5;

export interface RetentionResult {
  readonly ran: boolean;
  readonly deliveryLedgerPruned: number;
  readonly monitorEventsPruned: number;
  readonly receiptsPruned: number;
  readonly interimPruned: number;
  readonly journalsPruned: number;
  readonly logRotated: boolean;
}

export interface RetentionRunOptions {
  readonly store: StateStore;
  readonly daemonLog: string;
  readonly now?: () => Date;
}

export interface RetentionMaintenanceOptions extends RetentionRunOptions {
  readonly isRunning: () => boolean;
  readonly intervalMs?: number;
  readonly logger?: NdjsonLogger;
}

/**
 * Performs the bounded daily cleanup. Monitor evidence and interim batches are removed before
 * delivery rows so SQLite foreign-key references remain valid during pruning.
 */
export function runRetention(options: RetentionRunOptions): RetentionResult {
  const now = (options.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - RETENTION_WINDOW_MS).toISOString();
  // Journal artifacts belong to the receipts being pruned; capture their paths
  // before the rows disappear so the 7-day retention covers the files too.
  const prunableJournals = collectPrunableJournalPaths(options.store, cutoff);
  const monitorEventsPruned = options.store.pruneTerminalMonitorEvents(cutoff);
  const interimPruned = options.store.pruneDeliveredInterim(cutoff);
  const deliveryLedgerPruned = options.store.pruneSettledDeliveries(cutoff);
  const receiptsPruned = options.store.pruneDeliveredReceipts(cutoff);
  let journalsPruned = 0;
  for (const path of prunableJournals) {
    if (existsSync(path)) {
      unlinkSync(path);
      journalsPruned += 1;
    }
  }
  const logRotated = rotateNdjsonLog(options.daemonLog);
  return { ran: true, deliveryLedgerPruned, monitorEventsPruned, receiptsPruned, interimPruned, journalsPruned, logRotated };
}

function collectPrunableJournalPaths(store: StateStore, cutoff: string): string[] {
  const paths = new Set<string>();
  for (const receipt of store.listReceipts()) {
    if (receipt.state !== "delivered" || receipt.updatedAt >= cutoff) {
      continue;
    }
    const child = store.getChild(receipt.childId);
    if (child?.journalPath !== undefined) {
      paths.add(child.journalPath);
    }
  }
  return [...paths];
}

/**
 * Owns the daemon's internal daily timer. A blocked or degraded bootstrap
 * state is a hard gate: no retention state is changed until the daemon runs.
 */
export class RetentionMaintenance {
  private readonly now: () => Date;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  public constructor(private readonly options: RetentionMaintenanceOptions) {
    this.now = options.now ?? (() => new Date());
    this.intervalMs = positiveInterval(options.intervalMs ?? DAILY_MAINTENANCE_INTERVAL_MS);
  }

  public start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      try {
        this.run();
      } catch (error) {
        this.options.logger?.write("error", "maintenance", "retention_failed", { message: messageOf(error) });
      }
    }, this.intervalMs);
  }

  public stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = undefined;
  }

  public run(): RetentionResult {
    if (!this.options.isRunning()) {
      return emptyResult();
    }
    const result = runRetention({
      store: this.options.store,
      daemonLog: this.options.daemonLog,
      now: this.now,
    });
    this.options.logger?.write("info", "maintenance", "retention_completed", { ...result });
    return result;
  }
}

/** Rotates `daemon.ndjson` only after it exceeds 32 MiB and retains `.1`–`.5`. */
export function rotateNdjsonLog(
  path: string,
  maximumBytes = DAEMON_LOG_MAX_BYTES,
  retain = DAEMON_LOG_ROTATION_COUNT,
): boolean {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("maximumBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(retain) || retain < 1) {
    throw new Error("retain must be a positive safe integer");
  }
  if (!existsSync(path) || statSync(path).size <= maximumBytes) {
    return false;
  }

  const directory = dirname(path);
  const filename = basename(path);
  const rotatedPattern = new RegExp(`^${escapeRegExp(filename)}\\.(\\d+)$`);
  for (const entry of readdirSync(directory)) {
    const match = rotatedPattern.exec(entry);
    if (match && Number(match[1]) >= retain) {
      unlinkSync(join(directory, entry));
    }
  }
  for (let index = retain - 1; index >= 1; index -= 1) {
    const source = `${path}.${index}`;
    if (existsSync(source)) {
      renameSync(source, `${path}.${index + 1}`);
    }
  }
  renameSync(path, `${path}.1`);
  writeFileSync(path, "", { mode: 0o600 });
  return true;
}

function emptyResult(): RetentionResult {
  return {
    ran: false,
    deliveryLedgerPruned: 0,
    journalsPruned: 0,
    monitorEventsPruned: 0,
    receiptsPruned: 0,
    interimPruned: 0,
    logRotated: false,
  };
}

function positiveInterval(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("maintenance interval must be a positive safe integer");
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
