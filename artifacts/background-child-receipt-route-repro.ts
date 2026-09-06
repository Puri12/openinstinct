import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { MonitorPropagation } from "../daemon/src/monitors/propagation.ts";
import { MonitorStore } from "../daemon/src/monitors/store.ts";
import { TerminalJournal, createTerminalReport } from "../daemon/src/children/terminal-journal.ts";
import { openStateStore } from "../daemon/src/store/index.ts";

const root = mkdtempSync(join(tmpdir(), "openinstinct-red-team-correlated-receipt-"));
const store = openStateStore(join(root, "state.db"));
const journal = new TerminalJournal(join(root, "journal"));
const monitors = new MonitorStore(store, { hostTimeZone: "UTC" });
const monitor = monitors.create({
  id: "route-monitor",
  name: "Route",
  trigger: { kind: "webhook", token: "R".repeat(24) },
  instruction: "route",
});
const now = "2026-01-01T00:00:00.000Z";
const event = monitors.admitEvent(monitor, { eventType: "webhook", payload: { id: 1 }, occurrenceKey: "route-1" });
const child = store.createChild({
  id: randomUUID(),
  kind: "daemon",
  priority: "monitor",
  origin: "monitor",
  title: "Monitor: Route",
  prompt: "work",
  timeoutMs: 1_000,
}, now);
store.markChildAdmitted(child.id, now);
store.markChildRunning(child.id, now);
const report = createTerminalReport({
  childId: child.id,
  title: child.title,
  state: "failed",
  startedAt: now,
  completedAt: "2026-01-01T00:00:01.000Z",
  summary: "failed child",
  errorCode: "provider_error",
});
const journalPath = journal.writeTerminal(report);
const terminal = store.markChildTerminal(child.id, {
  state: "failed",
  journalPath,
  terminalChecksum: report.checksum,
  terminalSummary: report.summary,
  errorCode: report.errorCode,
}, "2026-01-01T00:00:01.000Z");
const receipt = store.admitReceipt({
  id: randomUUID(),
  childId: terminal.id,
  idempotencyKey: `child-terminal:${terminal.id}:failed`,
  contentHash: "a".repeat(64),
  projection: "failed durable receipt",
}, "2026-01-01T00:00:01.000Z");

let lease = store.claimMonitorEvent(event.id, ["admitted"], "route-worker", "lease-1", "2026-01-01T00:01:00.000Z", now)!;
store.transitionMonitorEvent({ lease: { id: lease.id, owner: lease.leaseOwner!, leaseId: lease.leaseId!, epoch: lease.epoch }, expectedStage: "admitted", nextStage: "batched", now, releaseLease: true });
lease = store.claimMonitorEvent(event.id, ["batched"], "route-worker", "lease-2", "2026-01-01T00:01:00.000Z", now)!;
store.transitionMonitorEvent({ lease: { id: lease.id, owner: lease.leaseOwner!, leaseId: lease.leaseId!, epoch: lease.epoch }, expectedStage: "batched", nextStage: "dispatched", now, childId: child.id, releaseLease: true });
lease = store.claimMonitorEvent(event.id, ["dispatched"], "route-worker", "lease-3", "2026-01-01T00:01:00.000Z", now)!;
store.failMonitorEvent({ id: lease.id, owner: lease.leaseOwner!, leaseId: lease.leaseId!, epoch: lease.epoch }, "2026-01-01T00:00:02.000Z", "propagation_failed", "forced terminal event failure");

const prompts: string[] = [];
const deliveries: unknown[] = [];
const propagation = new MonitorPropagation({
  store,
  monitors,
  lifecycle: { spawnDaemon: () => { throw new Error("not expected"); } },
  mainSession: {
    turn: async (prompt: string) => { prompts.push(prompt); return { kind: "reply", text: "triaged" }; },
    admitOwnerReply: (input: { readonly idempotencyKey: string; readonly text: string; readonly childId?: string }) => {
      deliveries.push(input);
      return { id: `delivery-${deliveries.length}` };
    },
  },
  now: () => new Date("2026-01-01T00:00:03.000Z"),
});
try {
  const consumed = await propagation.onChildReceipt(receipt);
  const fallbackConsumed = consumed ? false : await propagation.onUncorrelatedChildReceipt(receipt);
  const receiptState = store.getReceipt(receipt.id)?.state;
  const eventStage = store.getMonitorEvent(event.id)?.stage;
  console.log(JSON.stringify({
    consumed,
    fallbackConsumed,
    eventStage,
    receiptState,
    triageTurns: prompts.length,
    ownerDeliveries: deliveries.length,
    expected: "failed correlated event falls through to action-first triage and safe owner delivery",
    violated: consumed || !fallbackConsumed || eventStage !== "failed" || receiptState !== "delivered" || prompts.length !== 1 || deliveries.length !== 1,
  }, null, 2));
} finally {
  propagation.stop();
  store.close();
  rmSync(root, { recursive: true, force: true });
}
