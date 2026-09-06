import type { StateStore } from "../store/index.ts";

export const DAEMON_PAUSED_META = "daemon.paused";
const SUPPRESSED_COUNT_META = "daemon.paused.suppressed_count";

export function isDaemonPaused(store: StateStore): boolean {
  return store.getMeta(DAEMON_PAUSED_META) === "true";
}

export function setDaemonPaused(store: StateStore, paused: boolean): void {
  store.setMeta(DAEMON_PAUSED_META, paused ? "true" : "false");
}

/**
 * Durably counts owner messages dropped while paused. The watcher cursor still
 * advances past them, so without this record the daemon would have no way to
 * tell the owner on resume that anything was missed.
 */
export function recordSuppressedWhilePaused(store: StateStore, count: number): number {
  if (count <= 0) {
    return suppressedWhilePaused(store);
  }
  const next = suppressedWhilePaused(store) + count;
  store.setMeta(SUPPRESSED_COUNT_META, String(next));
  return next;
}

export function suppressedWhilePaused(store: StateStore): number {
  const raw = store.getMeta(SUPPRESSED_COUNT_META);
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return 0;
  }
  return Number(raw);
}

/** Reads and clears the suppressed backlog; returns what the owner missed. */
export function drainSuppressedWhilePaused(store: StateStore): number {
  const total = suppressedWhilePaused(store);
  store.deleteMeta(SUPPRESSED_COUNT_META);
  return total;
}

export function suppressedNotice(count: number): string {
  const plural = count === 1 ? "message" : "messages";
  return `[paused] ${count} owner ${plural} arrived while I was paused and were not answered. Resend anything that still matters.`;
}
