import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RetentionMaintenance,
  rotateNdjsonLog,
  runRetention,
} from "../../src/maintenance/retention.ts";
import { openStateStore, type StateStore } from "../../src/store/index.ts";

const directories: string[] = [];
const OLD = "2026-01-01T00:00:00.000Z";
const FRESH = "2026-01-08T00:00:00.000Z";
const NOW = new Date("2026-01-09T00:00:00.000Z");
const HASH = "a".repeat(64);

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup(): { readonly root: string; readonly log: string; readonly store: StateStore } {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-retention-"));
  directories.push(root);
  const log = join(root, "logs", "daemon.ndjson");
  mkdirSync(join(root, "logs"), { recursive: true });
  writeFileSync(log, "{}\n");
  return { root, log, store: openStateStore(join(root, "state.db")) };
}

function confirmDelivery(store: StateStore, id: string, at: string): void {
  store.claimDelivery(id, at);
  store.confirmDelivery(id, { messageId: `message-${id}` }, at);
}

function terminalMonitorEvent(store: StateStore, id: string, monitorId: string, at: string): void {
  store.createMonitor({ id: monitorId, enabled: true, specJson: "{}" }, at);
  store.admitMonitorEvent({
    id,
    monitorId,
    idempotencyKey: `event:${id}`,
    eventType: "test",
    payloadJson: "{}",
    burstKey: id,
    catchUp: false,
  }, at);
  const claimed = store.claimMonitorEvent(id, ["admitted"], "retention-test", `lease-${id}`, at, at)!;
  store.transitionMonitorEvent({
    lease: { id, owner: claimed.leaseOwner!, leaseId: claimed.leaseId!, epoch: claimed.epoch },
    expectedStage: "admitted",
    nextStage: "failed",
    now: at,
    releaseLease: true,
    lastErrorCode: "test",
    lastErrorMessage: "terminal test event",
  });
}

function deliveredReceipt(store: StateStore, childId: string, receiptId: string, at: string): void {
  store.createChild({
    id: childId,
    kind: "task_tool",
    priority: "conversational",
    origin: "owner",
    title: childId,
    prompt: "test",
    timeoutMs: 1_000,
  }, at);
  store.admitReceipt({
    id: receiptId,
    childId,
    idempotencyKey: `receipt:${receiptId}`,
    contentHash: HASH,
    projection: "retention receipt",
  }, at);
  store.markReceiptDelivered(receiptId, at);
}

function deliveredInterim(store: StateStore, childId: string, at: string): string {
  store.createChild({
    id: childId,
    kind: "task_tool",
    priority: "conversational",
    origin: "owner",
    title: childId,
    prompt: "test",
    timeoutMs: 1_000,
  }, at);
  store.admitInterimMessage({
    id: `interim-message:${childId}`,
    childId,
    idempotencyKey: `interim:${childId}:call`,
    body: "retention update",
    truncated: false,
  }, at);
  const batch = store.assignInterimBatch(at)!.batch;
  store.markInterimBatchInjected(batch.id, "turn", at);
  const deliveryId = `interim-delivery:${childId}`;
  store.admitDelivery({
    id: deliveryId,
    idempotencyKey: `interim-batch:${batch.id}`,
    kind: "text",
    handle: "+821012345678",
    body: "retention update",
  }, at);
  confirmDelivery(store, deliveryId, at);
  store.markInterimBatchDelivered(batch.id, { deliveryId, outcome: "owner_text" }, at);
  return batch.id;
}

describe("retention maintenance", () => {
  test("prunes only settled terminal evidence older than seven days", () => {
    const { log, store } = setup();
    try {
      store.admitDelivery({ id: "old-delivery", idempotencyKey: "old-delivery", kind: "text", handle: "+821012345678", body: "old" }, OLD);
      confirmDelivery(store, "old-delivery", OLD);
      store.admitDelivery({ id: "fresh-delivery", idempotencyKey: "fresh-delivery", kind: "text", handle: "+821012345678", body: "fresh" }, FRESH);
      confirmDelivery(store, "fresh-delivery", FRESH);
      terminalMonitorEvent(store, "old-event", "old-monitor", OLD);
      terminalMonitorEvent(store, "fresh-event", "fresh-monitor", FRESH);
      deliveredReceipt(store, "old-child", "old-receipt", OLD);
      deliveredReceipt(store, "fresh-child", "fresh-receipt", FRESH);
      const oldInterimBatch = deliveredInterim(store, "old-interim-child", OLD);
      const freshInterimBatch = deliveredInterim(store, "fresh-interim-child", FRESH);

      expect(runRetention({ store, daemonLog: log, now: () => NOW })).toEqual({
        ran: true,
        deliveryLedgerPruned: 2,
        monitorEventsPruned: 1,
        receiptsPruned: 1,
        interimPruned: 2,
        journalsPruned: 0,
        logRotated: false,
      });
      expect(store.getDelivery("old-delivery")).toBeUndefined();
      expect(store.getMonitorEvent("old-event")).toBeUndefined();
      expect(store.getReceipt("old-receipt")).toBeUndefined();
      expect(store.getDelivery("fresh-delivery")).toBeDefined();
      expect(store.getMonitorEvent("fresh-event")).toBeDefined();
      expect(store.getReceipt("fresh-receipt")).toBeDefined();
      expect(store.getInterimBatch(oldInterimBatch)).toBeUndefined();
      expect(store.getInterimBatch(freshInterimBatch)).toBeDefined();
      expect(store.getDelivery("interim-delivery:old-interim-child")).toBeUndefined();
      expect(store.getDelivery("interim-delivery:fresh-interim-child")).toBeDefined();
    } finally {
      store.close();
    }
  });

  test("unlinks the terminal journal artifacts of pruned receipts", () => {
    const { root, log, store } = setup();
    try {
      const oldJournal = join(root, "old-child.journal.ndjson");
      const freshJournal = join(root, "fresh-child.journal.ndjson");
      writeFileSync(oldJournal, "{}\n");
      writeFileSync(freshJournal, "{}\n");
      deliveredReceipt(store, "old-child", "old-receipt", OLD);
      store.markChildTerminal("old-child", {
        state: "completed",
        journalPath: oldJournal,
        terminalChecksum: HASH,
        terminalSummary: "old terminal",
      }, OLD);
      deliveredReceipt(store, "fresh-child", "fresh-receipt", FRESH);
      store.markChildTerminal("fresh-child", {
        state: "completed",
        journalPath: freshJournal,
        terminalChecksum: HASH,
        terminalSummary: "fresh terminal",
      }, FRESH);

      const result = runRetention({ store, daemonLog: log, now: () => NOW });
      expect(result.receiptsPruned).toBe(1);
      expect(result.journalsPruned).toBe(1);
      // The seven-day retention covers the journal artifact, not only the row.
      expect(existsSync(oldJournal)).toBe(false);
      expect(existsSync(freshJournal)).toBe(true);
    } finally {
      store.close();
    }
  });

  test("keeps retention inert while the daemon is not running", () => {
    const { log, store } = setup();
    let running = false;
    try {
      store.admitDelivery({ id: "old-delivery", idempotencyKey: "old-delivery", kind: "text", handle: "+821012345678", body: "old" }, OLD);
      confirmDelivery(store, "old-delivery", OLD);
      const maintenance = new RetentionMaintenance({ store, daemonLog: log, isRunning: () => running, now: () => NOW });

      expect(maintenance.run()).toMatchObject({ ran: false, deliveryLedgerPruned: 0 });
      expect(store.getDelivery("old-delivery")).toBeDefined();
      running = true;
      expect(maintenance.run()).toMatchObject({ ran: true, deliveryLedgerPruned: 1 });
      expect(store.getDelivery("old-delivery")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("rotates an oversized NDJSON log and retains exactly five generations", () => {
    const { log, store } = setup();
    try {
      writeFileSync(log, "current-log-is-oversized");
      for (let index = 1; index <= 7; index += 1) {
        writeFileSync(`${log}.${index}`, `old-${index}`);
      }

      expect(rotateNdjsonLog(log, 10, 5)).toBe(true);
      expect(readFileSync(`${log}.1`, "utf8")).toBe("current-log-is-oversized");
      expect(readFileSync(`${log}.2`, "utf8")).toBe("old-1");
      expect(readFileSync(`${log}.5`, "utf8")).toBe("old-4");
      expect(readFileSync(log, "utf8")).toBe("");
      expect(existsSync(`${log}.6`)).toBe(false);
      expect(existsSync(`${log}.7`)).toBe(false);
    } finally {
      store.close();
    }
  });
  test("runs its internal timer only while the bootstrap running gate is true", async () => {
    const { log, store } = setup();
    let running = false;
    let maintenance: RetentionMaintenance | undefined;
    try {
      store.admitDelivery({ id: "scheduled-delivery", idempotencyKey: "scheduled-delivery", kind: "text", handle: "+821012345678", body: "old" }, OLD);
      confirmDelivery(store, "scheduled-delivery", OLD);
      maintenance = new RetentionMaintenance({
        store,
        daemonLog: log,
        isRunning: () => running,
        now: () => NOW,
        intervalMs: 5,
      });
      maintenance.start();
      await Bun.sleep(20);
      expect(store.getDelivery("scheduled-delivery")).toBeDefined();
      running = true;
      await Bun.sleep(20);
      maintenance.stop();
      expect(store.getDelivery("scheduled-delivery")).toBeUndefined();
    } finally {
      maintenance?.stop();
      store.close();
    }
  });
});
