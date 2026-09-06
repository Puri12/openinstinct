import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChildLifecycle, type DaemonChildRequest } from "../../src/children/lifecycle.ts";
import { ChildRegistry } from "../../src/children/registry.ts";
import type { ChildRunner } from "../../src/children/runner.ts";
import { createTerminalReport, TerminalJournal } from "../../src/children/terminal-journal.ts";
import { DeliveryService } from "../../src/delivery/service.ts";
import type { DeliveryPort, DeliveryReceipt } from "../../src/delivery/port.ts";
import { MonitorPropagation } from "../../src/monitors/propagation.ts";
import { MonitorStore } from "../../src/monitors/store.ts";
import { openStateStore, type ChildRecord, type StateStore } from "../../src/store/index.ts";
import { FakeConversationRunner } from "../children/fakes.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class FakeDaemonLifecycle {
  public readonly requests: DaemonChildRequest[] = [];

  public constructor(private readonly store: StateStore) {}

  public spawnDaemon(request: DaemonChildRequest): ChildRecord {
    this.requests.push(request);
    const child = this.store.createChild({
      id: randomUUID(),
      kind: "daemon",
      priority: request.priority ?? "monitor",
      origin: request.origin,
      title: request.title,
      prompt: request.prompt,
      timeoutMs: request.timeoutMs ?? 1_000,
    }, "2026-01-01T00:00:00.000Z");
    request.onAdmitted?.(child);
    return child;
  }
}

class FakePort implements DeliveryPort {
  public async sendText(): Promise<DeliveryReceipt> {
    return { messageId: "message" };
  }

  public async sendReply(): Promise<DeliveryReceipt> {
    return { messageId: "reply" };
  }

  public async sendFile(): Promise<DeliveryReceipt> {
    return { messageId: "file" };
  }
}

function createStore(): { readonly root: string; readonly store: StateStore } {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-monitor-propagation-"));
  directories.push(root);
  return { root, store: openStateStore(join(root, "state.db")) };
}

const OWNER = "+821012345678";
function ownerMain(
  delivery: DeliveryService,
  turn: (
    prompt: string,
  ) => Promise<
    | { readonly kind: "reply"; readonly text: string }
    | { readonly kind: "failed"; readonly code: string; readonly message: string }
  > = async () => ({ kind: "reply", text: "Monitor update" }),
) {
  return {
    turn,
    admitOwnerReply(input: { readonly idempotencyKey: string; readonly text: string; readonly childId?: string }): { readonly id: string } {
      const admitted = delivery.admit({
        idempotencyKey: input.idempotencyKey,
        handle: OWNER,
        text: input.text,
        authoredBy: "main_session",
        ...(input.childId === undefined ? {} : { childId: input.childId }),
      });
      return { id: admitted.id };
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for monitor propagation");
    }
    await Bun.sleep(10);
  }
}

function completeChild(store: StateStore, journal: TerminalJournal, child: ChildRecord): void {
  const report = createTerminalReport({
    childId: child.id,
    title: child.title,
    state: "completed",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    summary: "Monitor child completed.",
  });
  const path = journal.writeTerminal(report);
  store.markChildTerminal(child.id, {
    state: report.state,
    journalPath: path,
    terminalChecksum: report.checksum,
    terminalSummary: report.summary,
  }, "2026-01-01T00:00:01.000Z");
}

function failChild(store: StateStore, journal: TerminalJournal, child: ChildRecord, errorCode: string): void {
  const report = createTerminalReport({
    childId: child.id, title: child.title, state: "failed",
    startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:01.000Z",
    summary: "monitor child failed", errorCode,
  });
  const path = journal.writeTerminal(report);
  store.markChildTerminal(child.id, { state: "failed", journalPath: path, terminalChecksum: report.checksum, terminalSummary: report.summary, errorCode }, "2026-01-01T00:00:01.000Z");
}

function timeoutChild(store: StateStore, journal: TerminalJournal, child: ChildRecord): void {
  const report = createTerminalReport({
    childId: child.id, title: child.title, state: "timeout",
    startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:01.000Z",
    summary: "monitor child exceeded its inactivity timeout", errorCode: "child_timeout",
  });
  const path = journal.writeTerminal(report);
  store.markChildTerminal(child.id, {
    state: "timeout",
    journalPath: path,
    terminalChecksum: report.checksum,
    terminalSummary: report.summary,
    errorCode: "child_timeout",
  }, "2026-01-01T00:00:01.000Z");
}

function admitTerminalReceipt(
  store: StateStore,
  journal: TerminalJournal,
  input: {
    readonly state: "completed" | "failed" | "timeout" | "cancelled";
    readonly origin?: "owner" | "monitor" | "memory";
    readonly errorCode?: string;
    readonly title?: string;
  },
): { readonly child: ChildRecord; readonly receipt: import("../../src/store/index.ts").ReceiptRecord } {
  const now = "2026-01-01T00:00:00.000Z";
  const child = store.createChild({
    id: randomUUID(),
    kind: "daemon",
    priority: "monitor",
    origin: input.origin ?? "monitor",
    title: input.title ?? "Uncorrelated daemon child",
    prompt: "work",
    timeoutMs: 1_000,
  }, now);
  store.markChildAdmitted(child.id, now);
  store.markChildRunning(child.id, now);
  const report = createTerminalReport({
    childId: child.id,
    title: child.title,
    state: input.state,
    startedAt: now,
    completedAt: "2026-01-01T00:00:01.000Z",
    summary: `${input.state} summary`,
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
  });
  const journalPath = journal.writeTerminal(report);
  const terminal = store.markChildTerminal(child.id, {
    state: input.state,
    journalPath,
    terminalChecksum: report.checksum,
    terminalSummary: report.summary,
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
  }, "2026-01-01T00:00:01.000Z");
  const receipt = store.admitReceipt({
    id: randomUUID(),
    childId: terminal.id,
    idempotencyKey: `child-terminal:${terminal.id}:${input.state}:${input.errorCode ?? "none"}`,
    contentHash: new Bun.CryptoHasher("sha256").update(`${terminal.id}:${input.state}:${input.errorCode ?? "none"}`).digest("hex"),
    projection: `${input.state} durable receipt`,
  }, "2026-01-01T00:00:01.000Z");
  return { child: terminal, receipt };
}

function admitOrphanReceipt(store: StateStore, title = "Uncorrelated orphan"): { readonly child: ChildRecord; readonly receipt: import("../../src/store/index.ts").ReceiptRecord } {
  const now = "2026-01-01T00:00:00.000Z";
  const child = store.createChild({
    id: randomUUID(),
    kind: "daemon",
    priority: "monitor",
    origin: "monitor",
    title,
    prompt: "work",
    timeoutMs: 1_000,
  }, now);
  store.markChildAdmitted(child.id, now);
  store.markChildRunning(child.id, now);
  return store.admitChildOrphanReceipt(child.id, {
    id: randomUUID(),
    childId: child.id,
    idempotencyKey: `child-orphan:${child.id}`,
    contentHash: new Bun.CryptoHasher("sha256").update(`orphan:${child.id}`).digest("hex"),
    projection: "orphaned durable receipt",
  }, "2026-01-01T00:00:01.000Z");
}

function leaseOfTest(event: { readonly id: string; readonly leaseOwner?: string; readonly leaseId?: string; readonly epoch: number }): { readonly id: string; readonly owner: string; readonly leaseId: string; readonly epoch: number } {
  if (!event.leaseOwner || !event.leaseId) throw new Error("test event has no lease");
  return { id: event.id, owner: event.leaseOwner, leaseId: event.leaseId, epoch: event.epoch };
}

function dispatchMonitorEventToChild(store: StateStore, eventId: string, childId: string): void {
  const now = new Date();
  let lease = store.claimMonitorEvent(
    eventId,
    ["admitted"],
    "test",
    randomUUID(),
    new Date(now.getTime() + 60_000).toISOString(),
    now.toISOString(),
  );
  if (!lease) throw new Error("test event admission claim failed");
  const batched = store.transitionMonitorEvent({
    lease: leaseOfTest(lease),
    expectedStage: "admitted",
    nextStage: "batched",
    now: now.toISOString(),
    releaseLease: false,
  });
  if (!batched) throw new Error("test event batching failed");
  const dispatched = store.transitionMonitorEvent({
    lease: leaseOfTest(batched),
    expectedStage: "batched",
    nextStage: "dispatched",
    now: now.toISOString(),
    childId,
    releaseLease: true,
  });
  if (!dispatched) throw new Error("test event dispatch failed");
}
describe("MonitorPropagation triage", () => {
  test("hands failed outcomes to the main session and sends its verdict; the silent marker sends nothing", async () => {
    const { root, store } = createStore();
    const monitors = new MonitorStore(store, { hostTimeZone: "UTC" });
    const monitor = monitors.create({ id: "m", name: "Flaky", trigger: { kind: "cron", expression: "0 9 * * *" }, instruction: "Do X." });
    const lifecycle = new FakeDaemonLifecycle(store);
    const delivery = new DeliveryService({ store, port: new FakePort() });
    const prompts: string[] = [];
    let reply = "Flaky 모니터가 실패했는데 지시문이 모호해서 제가 고쳐뒀어요.";
    const propagation = new MonitorPropagation({
      store, monitors, lifecycle,
      mainSession: ownerMain(delivery, async (p) => { prompts.push(p); return { kind: "reply", text: reply }; }),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const journal = new TerminalJournal(join(root, "journal"));
    try {
      const first = await propagation.admitTrigger(monitor, { eventType: "cron", payload: {}, occurrenceKey: "cron:1" });
      const child1 = store.getChild(store.getMonitorEvent(first.id)!.childId!)!;
      failChild(store, journal, child1, "timeout");
      await propagation.onChildReceipt({ childId: child1.id } as never);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatch(/FAILED\. Triage/);
      expect(prompts[0]).toMatch(/monitor_author/);
      expect(store.listDeliveries()).toHaveLength(1);
      expect(store.listDeliveries()[0]!.body).toBe(reply);
      expect(store.getMonitorEvent(first.id)).toMatchObject({ stage: "delivered" });

      reply = "[[no-owner-message]]";
      const second = await propagation.admitTrigger(monitor, { eventType: "cron", payload: {}, occurrenceKey: "cron:2" });
      const child2 = store.getChild(store.getMonitorEvent(second.id)!.childId!)!;
      failChild(store, journal, child2, "transient");
      await propagation.onChildReceipt({ childId: child2.id } as never);
      expect(prompts).toHaveLength(2);
      expect(store.listDeliveries()).toHaveLength(1);
      expect(store.getMonitorEvent(second.id)).toMatchObject({ stage: "delivered" });
    } finally {
      store.close();
    }
  });

  test("keeps a failed timeout triage retryable without a raw owner message", async () => {
    const { root, store } = createStore();
    const monitors = new MonitorStore(store, { hostTimeZone: "UTC" });
    const monitor = monitors.create({ id: "timeout", name: "Slow", trigger: { kind: "cron", expression: "0 9 * * *" }, instruction: "Do slow work." });
    const lifecycle = new FakeDaemonLifecycle(store);
    const delivery = new DeliveryService({ store, port: new FakePort() });
    const prompts: string[] = [];
    const events: string[] = [];
    const propagation = new MonitorPropagation({
      store, monitors, lifecycle,
      mainSession: ownerMain(delivery, async (prompt) => {
        prompts.push(prompt);
        return { kind: "failed", code: "watchdog_timeout", message: "main session unavailable" };
      }),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      onEvent: (event) => events.push(event),
    });
    const journal = new TerminalJournal(join(root, "journal"));

    try {
      const event = await propagation.admitTrigger(monitor, { eventType: "cron", payload: {}, occurrenceKey: "cron:timeout" });
      const child = store.getChild(store.getMonitorEvent(event.id)!.childId!)!;
      timeoutChild(store, journal, child);
      await propagation.onChildReceipt({ childId: child.id } as never);

      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("child_timeout");
      expect(store.listDeliveries()).toHaveLength(0);
      expect(store.getMonitorEvent(event.id)).toMatchObject({
        stage: "authored",
      });
      expect(events).toContain("triage_turn_failed");
      expect(events).toContain("triage_retryable");
    } finally {
      store.close();
    }
  });
  test("keeps every failed monitor triage retryable without raw delivery", async () => {
    const { root, store } = createStore();
    const monitors = new MonitorStore(store, { hostTimeZone: "UTC" });
    const monitor = monitors.create({ id: "failed", name: "Failed", trigger: { kind: "cron", expression: "0 9 * * *" }, instruction: "Do work." });
    const lifecycle = new FakeDaemonLifecycle(store);
    const delivery = new DeliveryService({ store, port: new FakePort() });
    const events: string[] = [];
    const propagation = new MonitorPropagation({
      store, monitors, lifecycle,
      mainSession: ownerMain(delivery, async () => ({ kind: "failed", code: "provider_error", message: "unavailable" })),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      onEvent: (event) => events.push(event),
    });
    const journal = new TerminalJournal(join(root, "journal"));

    try {
      const event = await propagation.admitTrigger(monitor, { eventType: "cron", payload: {}, occurrenceKey: "cron:failed" });
      const child = store.getChild(store.getMonitorEvent(event.id)!.childId!)!;
      failChild(store, journal, child, "provider_error");
      await propagation.onChildReceipt({ childId: child.id } as never);

      expect(store.listDeliveries()).toHaveLength(0);
      expect(store.getMonitorEvent(event.id)).toMatchObject({
        stage: "authored",
      });
      expect(events).toContain("triage_turn_failed");
      expect(events).toContain("triage_retryable");
    } finally {
      store.close();
    }
  });

});

describe("MonitorPropagation", () => {
  test("runs admitted → batched → dispatched → authored → delivered with one intent", async () => {
    const { root, store } = createStore();
    const monitors = new MonitorStore(store, { hostTimeZone: "UTC" });
    const monitor = monitors.create({
      id: "monitor-1",
      name: "Daily",
      trigger: { kind: "cron", expression: "0 9 * * *" },
      instruction: "Report daily status.",
    });
    const lifecycle = new FakeDaemonLifecycle(store);
    const delivery = new DeliveryService({ store, port: new FakePort() });
    const propagation = new MonitorPropagation({
      store,
      monitors,
      lifecycle,
      mainSession: ownerMain(delivery),
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const journal = new TerminalJournal(join(root, "journal"));

    try {
      const admitted = await propagation.admitTrigger(monitor, {
        eventType: "cron",
        payload: { scheduledFor: "2026-01-01T09:00:00.000Z" },
        occurrenceKey: "daily-1",
      });
      const dispatched = store.getMonitorEvent(admitted.id)!;
      const child = store.getChild(dispatched.childId!)!;

      expect(dispatched).toMatchObject({ stage: "dispatched", childId: child.id });
      expect(lifecycle.requests).toHaveLength(1);
      expect(child).toMatchObject({ kind: "daemon", priority: "monitor", timeoutMs: 2_700_000 });

      completeChild(store, journal, child);
      await propagation.onChildReceipt({ childId: child.id } as never);
      await propagation.onChildReceipt({ childId: child.id } as never);

      expect(store.getMonitorEvent(admitted.id)).toMatchObject({ stage: "delivered" });
      expect(store.listDeliveries()).toHaveLength(1);
      expect(store.listDeliveries()[0]).toMatchObject({
        idempotencyKey: `monitor-event:${admitted.id}`,
        childId: child.id,
      });
    } finally {
      store.close();
    }
  });

  test("fences competing workers and replays a kill between dispatch and delivery without duplicate intent", async () => {
    const { root, store } = createStore();
    const monitors = new MonitorStore(store, { hostTimeZone: "UTC" });
    const monitor = monitors.create({
      id: "monitor-lease",
      name: "Lease",
      trigger: { kind: "webhook", token: "B".repeat(24) },
      instruction: "Report event.",
      burstPolicy: "pass",
    });
    const lifecycle = new FakeDaemonLifecycle(store);
    const delivery = new DeliveryService({ store, port: new FakePort() });
    const first = new MonitorPropagation({ store, monitors, lifecycle, mainSession: ownerMain(delivery) });
    const second = new MonitorPropagation({ store, monitors, lifecycle, mainSession: ownerMain(delivery) });
    const journal = new TerminalJournal(join(root, "journal"));

    try {
      const event = monitors.admitEvent(monitor, { eventType: "webhook", payload: { id: 1 }, occurrenceKey: "one" });
      await Promise.all([first.drain(), second.drain()]);
      const dispatched = store.getMonitorEvent(event.id)!;
      const child = store.getChild(dispatched.childId!)!;
      expect(lifecycle.requests).toHaveLength(1);
      expect(dispatched.stage).toBe("dispatched");

      completeChild(store, journal, child);
      const restarted = new MonitorPropagation({ store, monitors, lifecycle, mainSession: ownerMain(delivery) });
      await restarted.reconcile();
      await restarted.reconcile();

      expect(store.getMonitorEvent(event.id)).toMatchObject({ stage: "delivered" });
      expect(store.listDeliveries()).toHaveLength(1);
      expect(store.listDeliveries()[0]?.idempotencyKey).toBe(`monitor-event:${event.id}`);
    } finally {
      store.close();
    }
  });

  test("uses lease epochs to fence stale writers and caps failed claims at three", () => {
    const { store } = createStore();
    const monitors = new MonitorStore(store, { hostTimeZone: "UTC" });
    const monitor = monitors.create({
      id: "monitor-fence",
      name: "Fence",
      trigger: { kind: "webhook", token: "C".repeat(24) },
      instruction: "Report event.",
    });

    try {
      const event = monitors.admitEvent(monitor, { eventType: "webhook", payload: { value: 1 } });
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const claimed = store.claimMonitorEvent(
          event.id,
          ["admitted"],
          "worker-a",
          `lease-${attempt}`,
          `2026-01-01T00:00:0${attempt}.000Z`,
          "2026-01-01T00:00:00.000Z",
        )!;
        if (attempt === 1) {
          expect(store.transitionMonitorEvent({
            lease: { id: event.id, owner: "worker-b", leaseId: "wrong", epoch: claimed.epoch },
            expectedStage: "admitted",
            nextStage: "batched",
            now: "2026-01-01T00:00:00.000Z",
          })).toBeUndefined();
        }
        store.failMonitorEvent({
          id: claimed.id,
          owner: claimed.leaseOwner!,
          leaseId: claimed.leaseId!,
          epoch: claimed.epoch,
        }, "2026-01-01T00:00:00.000Z", "test_failure", "forced");
      }
      expect(store.getMonitorEvent(event.id)).toMatchObject({ stage: "failed", attempts: 3 });
      expect(store.claimMonitorEvent(
        event.id,
        ["admitted"],
        "worker-c",
        "lease-4",
        "2026-01-01T00:01:00.000Z",
        "2026-01-01T00:00:00.000Z",
      )).toBeUndefined();
    } finally {
      store.close();
    }
  });

  test("binds monitor child identity before unified lifecycle execution and routes its terminal receipt directly", async () => {
    const { root, store } = createStore();
    const monitors = new MonitorStore(store, { hostTimeZone: "UTC" });
    const monitor = monitors.create({
      id: "unified-monitor",
      name: "Unified",
      trigger: { kind: "webhook", token: "D".repeat(24) },
      instruction: "Report event.",
    });
    const delivery = new DeliveryService({ store, port: new FakePort() });
    const runner: ChildRunner = {
      name: "completed-monitor-runner",
      async run() {
        return { state: "completed", summary: "Unified child completed." };
      },
    };
    let propagation: MonitorPropagation | undefined;
    const lifecycle = new ChildLifecycle({
      registry: new ChildRegistry(store),
      journal: new TerminalJournal(join(root, "journal")),
      runner,
      conversation: new FakeConversationRunner(),
      daemonRunner: runner,
      onReceipt: async (receipt) => {
        await propagation?.onChildReceipt(receipt);
      },
    });
    propagation = new MonitorPropagation({
      store,
      monitors,
      lifecycle,
      mainSession: ownerMain(delivery),
    });

    try {
      const event = await propagation.admitTrigger(monitor, { eventType: "webhook", payload: { id: 1 } });
      await waitFor(() => store.getMonitorEvent(event.id)?.stage === "delivered");
      expect(store.getMonitorEvent(event.id)).toMatchObject({ stage: "delivered" });
      expect(store.listDeliveries()).toHaveLength(1);
      expect(store.listPersistedReceipts()).toHaveLength(0);
      expect(store.listReceipts()).toHaveLength(1);
      expect(store.listReceipts()[0]).toMatchObject({ state: "delivered" });
    } finally {
      await lifecycle.stop();
      store.close();
    }
  });

  test("retains queued monitor work while paused and dispatches it after resume", async () => {
    const { store } = createStore();
    const monitors = new MonitorStore(store, { hostTimeZone: "UTC" });
    const monitor = monitors.create({
      id: "paused-monitor",
      name: "Paused monitor",
      trigger: { kind: "webhook", token: "E".repeat(24) },
      instruction: "Wait for resume.",
    });
    const lifecycle = new FakeDaemonLifecycle(store);
    const delivery = new DeliveryService({ store, port: new FakePort() });
    let paused = true;
    const propagation = new MonitorPropagation({
      store,
      monitors,
      lifecycle,
      mainSession: ownerMain(delivery),
      isPaused: () => paused,
    });

    try {
      const event = monitors.admitEvent(monitor, { eventType: "webhook", payload: { id: 1 } });
      await propagation.reconcile();
      expect(store.getMonitorEvent(event.id)).toMatchObject({ stage: "admitted" });
      expect(lifecycle.requests).toHaveLength(0);

      paused = false;
      await propagation.drain();
      expect(store.getMonitorEvent(event.id)).toMatchObject({ stage: "dispatched" });
      expect(lifecycle.requests).toHaveLength(1);
    } finally {
      store.close();
    }
  });
  test("retries a leased event after the prior worker lease expires", async () => {
    const { store } = createStore();
    const monitors = new MonitorStore(store, { hostTimeZone: "UTC" });
    const monitor = monitors.create({
      id: "lease-retry-monitor",
      name: "Lease retry",
      trigger: { kind: "webhook", token: "F".repeat(24) },
      instruction: "Retry after the lease.",
    });
    const lifecycle = new FakeDaemonLifecycle(store);
    const delivery = new DeliveryService({ store, port: new FakePort() });
    const propagation = new MonitorPropagation({
      store,
      monitors,
      lifecycle,
      mainSession: ownerMain(delivery),
      leaseMs: 25,
    });
    try {
      const event = monitors.admitEvent(monitor, { eventType: "webhook", payload: { id: 2 } });
      const now = new Date();
      store.claimMonitorEvent(
        event.id,
        ["admitted"],
        "prior-worker",
        "prior-lease",
        new Date(now.getTime() + 25).toISOString(),
        now.toISOString(),
      );
      await propagation.reconcile();
      await waitFor(() => store.getMonitorEvent(event.id)?.stage === "dispatched", 1_000);
      expect(lifecycle.requests).toHaveLength(1);
    } finally {
      propagation.stop();
      store.close();
    }
  });
});

describe("MonitorPropagation uncorrelated receipts", () => {
  test("triages failure terminal states by durable state regardless of error code and silently consumes completed/cancelled", async () => {
    const { root, store } = createStore();
    const monitors = new MonitorStore(store, { hostTimeZone: "UTC" });
    const lifecycle = new FakeDaemonLifecycle(store);
    const delivery = new DeliveryService({ store, port: new FakePort() });
    const journal = new TerminalJournal(join(root, "journal"));
    const prompts: string[] = [];
    const events: Array<{ readonly event: string; readonly fields: Record<string, unknown> }> = [];
    const propagation = new MonitorPropagation({
      store,
      monitors,
      lifecycle,
      mainSession: ownerMain(delivery, async (prompt) => { prompts.push(prompt); return { kind: "reply", text: `Recovered child failure ${prompts.length}.` }; }),
      onEvent: (event, fields) => events.push({ event, fields }),
      now: () => new Date("2026-01-01T00:00:02.000Z"),
    });

    try {
      const failures = ["child_run_failed", "provider_error", "empty_output", "rate_limit_exceeded", undefined] as const;
      for (const code of failures) {
        const { child, receipt } = admitTerminalReceipt(store, journal, { state: "failed", errorCode: code });
        expect(await propagation.onChildReceipt(receipt)).toBe(false);
        expect(await propagation.onUncorrelatedChildReceipt(receipt)).toBe(true);
        expect(store.getReceipt(receipt.id)).toMatchObject({ state: "delivered" });
        expect(store.getDeliveryByIdempotencyKey(`child-recovery:${receipt.id}`)).toMatchObject({ childId: child.id });
      }
      const timedOut = admitTerminalReceipt(store, journal, { state: "timeout", errorCode: "child_timeout" });
      const orphaned = admitOrphanReceipt(store);
      expect(await propagation.onUncorrelatedChildReceipt(timedOut.receipt)).toBe(true);
      expect(await propagation.onUncorrelatedChildReceipt(orphaned.receipt)).toBe(true);
      expect(store.getReceipt(timedOut.receipt.id)).toMatchObject({ state: "delivered" });
      expect(store.getReceipt(orphaned.receipt.id)).toMatchObject({ state: "delivered" });
      expect(prompts).toHaveLength(7);
      expect(prompts[0]).toContain("FAILED after a restart");
      expect(prompts.some((prompt) => prompt.includes("\"errorCode\":\"child_run_failed\""))).toBe(true);
      expect(prompts.some((prompt) => prompt.includes("\"errorCode\":null"))).toBe(true);

      const cancelled = admitTerminalReceipt(store, journal, { state: "cancelled", errorCode: "cancelled" });
      const completed = admitTerminalReceipt(store, journal, { state: "completed" });
      const promptCount = prompts.length;
      const deliveryCount = store.listDeliveries().length;
      expect(await propagation.onUncorrelatedChildReceipt(cancelled.receipt)).toBe(true);
      expect(await propagation.onUncorrelatedChildReceipt(completed.receipt)).toBe(true);
      expect(store.getReceipt(cancelled.receipt.id)).toMatchObject({ state: "delivered" });
      expect(store.getReceipt(completed.receipt.id)).toMatchObject({ state: "delivered" });
      expect(prompts).toHaveLength(promptCount);
      expect(store.listDeliveries()).toHaveLength(deliveryCount);
      expect(events).toContainEqual(expect.objectContaining({ event: "uncorrelated_receipt_ignored", fields: expect.objectContaining({ state: "cancelled" }) }));
      expect(events).toContainEqual(expect.objectContaining({ event: "uncorrelated_receipt_triaged", fields: expect.objectContaining({ state: "orphaned" }) }));
    } finally {
      propagation.stop();
      store.close();
    }
  });

  test("replays a persisted uncorrelated receipt once and leaves owner receipts unclaimed", async () => {
    const { root, store } = createStore();
    const monitors = new MonitorStore(store, { hostTimeZone: "UTC" });
    const lifecycle = new FakeDaemonLifecycle(store);
    const delivery = new DeliveryService({ store, port: new FakePort() });
    const journal = new TerminalJournal(join(root, "journal"));
    const prompts: string[] = [];
    const propagation = new MonitorPropagation({
      store,
      monitors,
      lifecycle,
      mainSession: ownerMain(delivery, async (prompt) => { prompts.push(prompt); return { kind: "reply", text: "Recovered." }; }),
    });

    try {
      const failed = admitTerminalReceipt(store, journal, { state: "failed", errorCode: "provider_error", origin: "memory" });
      await propagation.reconcile();
      await propagation.reconcile();
      expect(prompts).toHaveLength(1);
      expect(store.getReceipt(failed.receipt.id)).toMatchObject({ state: "delivered" });
      expect(store.getDeliveryByIdempotencyKey(`child-recovery:${failed.receipt.id}`)).toBeDefined();

      const owner = admitTerminalReceipt(store, journal, { state: "failed", origin: "owner" });
      expect(await propagation.onUncorrelatedChildReceipt(owner.receipt)).toBe(false);
      expect(store.getReceipt(owner.receipt.id)).toMatchObject({ state: "persisted" });
    } finally {
      propagation.stop();
      store.close();
    }
  });
});

  test("action-first triage suppresses raw monitor receipt text and permits safe or silent owner outcomes", async () => {
    const { root, store } = createStore();
    const monitors = new MonitorStore(store, { hostTimeZone: "UTC" });
    const lifecycle = new FakeDaemonLifecycle(store);
    const delivery = new DeliveryService({ store, port: new FakePort() });
    const journal = new TerminalJournal(join(root, "journal"));
    const prompts: string[] = [];
    const replies = [
      "Background task failed (provider_error) [stack trace]",
      "The monitor task needs attention; decide whether to retry it.",
      "[[no-owner-message]]",
      "[[no-owner-message]]",
    ];
    const propagation = new MonitorPropagation({
      store,
      monitors,
      lifecycle,
      mainSession: ownerMain(delivery, async (prompt) => { prompts.push(prompt); return { kind: "reply", text: replies.shift()! }; }),
    });
    try {
      const raw = admitTerminalReceipt(store, journal, { state: "failed", origin: "monitor", errorCode: "provider_error" });
      const safe = admitTerminalReceipt(store, journal, { state: "failed", origin: "monitor", errorCode: "provider_error" });
      const silent = admitTerminalReceipt(store, journal, { state: "failed", origin: "monitor", errorCode: "provider_error" });
      await propagation.onUncorrelatedChildReceipt(raw.receipt);
      await propagation.onUncorrelatedChildReceipt(safe.receipt);
      await propagation.onUncorrelatedChildReceipt(silent.receipt);
      expect(store.getReceipt(raw.receipt.id)?.state).toBe("delivered");
      expect(store.getReceipt(safe.receipt.id)?.state).toBe("delivered");
      expect(store.getReceipt(silent.receipt.id)?.state).toBe("delivered");
      const recoveryDeliveries = store.listDeliveries().filter((entry) => entry.idempotencyKey.startsWith("child-recovery:"));
      expect(recoveryDeliveries).toHaveLength(1);
      expect(recoveryDeliveries[0]?.body).toBe("The monitor task needs attention; decide whether to retry it.");
      expect(recoveryDeliveries[0]?.body).not.toContain("provider_error");
      expect(recoveryDeliveries[0]?.body).not.toContain("stack");
      expect(prompts).toHaveLength(4);
    } finally {
      propagation.stop();
      store.close();
    }
  });

  test("falls through when a correlated monitor event is already failed", async () => {
    const { root, store } = createStore();
    const monitors = new MonitorStore(store, { hostTimeZone: "UTC" });
    const lifecycle = new FakeDaemonLifecycle(store);
    const delivery = new DeliveryService({ store, port: new FakePort() });
    const journal = new TerminalJournal(join(root, "journal"));
    const monitor = monitors.create({ id: "already-failed", name: "Already failed", trigger: { kind: "webhook", token: "F".repeat(24) }, instruction: "recover" });
    const event = monitors.admitEvent(monitor, { eventType: "webhook", payload: { id: 1 }, occurrenceKey: "already-failed-1" });
    const admission = admitTerminalReceipt(store, journal, { state: "failed", origin: "monitor", errorCode: "provider_error", title: "Monitor: Already failed" });
    let lease = store.claimMonitorEvent(event.id, ["admitted"], "test", "lease-a", "2026-01-01T00:01:00.000Z", "2026-01-01T00:00:00.000Z")!;
    store.transitionMonitorEvent({ lease: leaseOfTest(lease), expectedStage: "admitted", nextStage: "batched", now: "2026-01-01T00:00:00.000Z", releaseLease: true });
    lease = store.claimMonitorEvent(event.id, ["batched"], "test", "lease-b", "2026-01-01T00:01:00.000Z", "2026-01-01T00:00:00.000Z")!;
    store.transitionMonitorEvent({ lease: leaseOfTest(lease), expectedStage: "batched", nextStage: "dispatched", now: "2026-01-01T00:00:00.000Z", childId: admission.child.id, releaseLease: true });
    lease = store.claimMonitorEvent(event.id, ["dispatched"], "test", "lease-c", "2026-01-01T00:01:00.000Z", "2026-01-01T00:00:00.000Z")!;
    store.failMonitorEvent(leaseOfTest(lease), "2026-01-01T00:00:02.000Z", "propagation_failed", "forced");
    const propagation = new MonitorPropagation({
      store,
      monitors,
      lifecycle,
      mainSession: ownerMain(delivery, async () => ({ kind: "reply", text: "The monitor task needs attention; decide whether to retry it." })),
    });
    try {
      expect(await propagation.onChildReceipt(admission.receipt)).toBe(false);
      expect(await propagation.onUncorrelatedChildReceipt(admission.receipt)).toBe(true);
      expect(store.getReceipt(admission.receipt.id)?.state).toBe("delivered");
      expect(store.getDeliveryByIdempotencyKey(`child-recovery:${admission.receipt.id}`)?.body).toBe("The monitor task needs attention; decide whether to retry it.");
    } finally {
      propagation.stop();
      store.close();
    }
  });

describe("MonitorPropagation correlated triage safety", () => {
  test("keeps correlated receipts retryable when both main drafts are unsafe", async () => {
    const { root, store } = createStore();
    const monitors = new MonitorStore(store, { hostTimeZone: "UTC" });
    const monitor = monitors.create({
      id: "correlated-unsafe",
      name: "Correlated unsafe",
      trigger: { kind: "webhook", token: "U".repeat(24) },
      instruction: "recover",
    });
    const lifecycle = new FakeDaemonLifecycle(store);
    const delivery = new DeliveryService({ store, port: new FakePort() });
    const journal = new TerminalJournal(join(root, "journal"));
    const prompts: string[] = [];
    const propagation = new MonitorPropagation({
      store,
      monitors,
      lifecycle,
      mainSession: ownerMain(delivery, async (prompt) => {
        prompts.push(prompt);
        return { kind: "reply", text: "timeout" };
      }),
    });
    try {
      const event = monitors.admitEvent(monitor, { eventType: "webhook", payload: { id: 1 }, occurrenceKey: "unsafe-1" });
      const admission = admitTerminalReceipt(store, journal, { state: "failed", origin: "monitor", errorCode: "provider_error", title: "Monitor: Correlated unsafe" });
      let lease = store.claimMonitorEvent(event.id, ["admitted"], "test", "lease-a", "2026-01-01T00:01:00.000Z", "2026-01-01T00:00:00.000Z")!;
      store.transitionMonitorEvent({ lease: leaseOfTest(lease), expectedStage: "admitted", nextStage: "batched", now: "2026-01-01T00:00:00.000Z", releaseLease: true });
      lease = store.claimMonitorEvent(event.id, ["batched"], "test", "lease-b", "2026-01-01T00:01:00.000Z", "2026-01-01T00:00:00.000Z")!;
      store.transitionMonitorEvent({ lease: leaseOfTest(lease), expectedStage: "batched", nextStage: "dispatched", now: "2026-01-01T00:00:00.000Z", childId: admission.child.id, releaseLease: true });

      expect(await propagation.onChildReceipt(admission.receipt)).toBe(true);
      expect(prompts).toHaveLength(2);
      expect(store.getReceipt(admission.receipt.id)).toMatchObject({ state: "persisted" });
      expect(store.getMonitorEvent(event.id)).toMatchObject({ stage: "authored" });
      expect(store.listDeliveries()).toHaveLength(0);
    } finally {
      propagation.stop();
      store.close();
    }
  });
  test("retries authored triage on the same lease and delivers a later safe verdict", async () => {
    const { root, store } = createStore();
    const monitors = new MonitorStore(store, { hostTimeZone: "UTC" });
    const monitor = monitors.create({ id: "triage-retry", name: "Triage retry", trigger: { kind: "webhook", token: "R".repeat(24) }, instruction: "recover" });
    const lifecycle = new FakeDaemonLifecycle(store);
    const delivery = new DeliveryService({ store, port: new FakePort() });
    const journal = new TerminalJournal(join(root, "journal"));
    const prompts: string[] = [];
    let turns = 0;
    const propagation = new MonitorPropagation({
      store,
      monitors,
      lifecycle,
      mainSession: ownerMain(delivery, async (prompt) => {
        prompts.push(prompt);
        turns += 1;
        return turns === 1 ? { kind: "failed", code: "provider_error", message: "temporary" } : { kind: "reply", text: "The monitor recovered safely." };
      }),
    });
    try {
      const event = monitors.admitEvent(monitor, { eventType: "webhook", payload: { id: 1 }, occurrenceKey: "triage-retry-1" });
      const admission = admitTerminalReceipt(store, journal, { state: "failed", origin: "monitor", errorCode: "provider_error", title: "Monitor: Triage retry" });
      dispatchMonitorEventToChild(store, event.id, admission.child.id);
      expect(await propagation.onChildReceipt(admission.receipt)).toBe(true);
      expect(store.getMonitorEvent(event.id)).toMatchObject({ stage: "authored", attempts: 2 });
      await waitFor(() => store.getMonitorEvent(event.id)?.stage === "delivered", 2_500);
      expect(prompts).toHaveLength(2);
      expect(store.getReceipt(admission.receipt.id)).toMatchObject({ state: "delivered" });
      expect(store.listDeliveries()).toHaveLength(1);
    } finally {
      propagation.stop();
      store.close();
    }
  });

  test("exhausts authored triage without consuming another dispatch claim", async () => {
    const { root, store } = createStore();
    const monitors = new MonitorStore(store, { hostTimeZone: "UTC" });
    const monitor = monitors.create({ id: "triage-exhaust", name: "Triage exhaust", trigger: { kind: "webhook", token: "X".repeat(24) }, instruction: "recover" });
    const lifecycle = new FakeDaemonLifecycle(store);
    const delivery = new DeliveryService({ store, port: new FakePort() });
    const journal = new TerminalJournal(join(root, "journal"));
    const events: string[] = [];
    const propagation = new MonitorPropagation({
      store,
      monitors,
      lifecycle,
      mainSession: ownerMain(delivery, async () => ({ kind: "failed", code: "provider_error", message: "unavailable" })),
      onEvent: (event) => events.push(event),
    });
    try {
      const event = monitors.admitEvent(monitor, { eventType: "webhook", payload: { id: 2 }, occurrenceKey: "triage-exhaust-1" });
      const admission = admitTerminalReceipt(store, journal, { state: "failed", origin: "monitor", errorCode: "provider_error", title: "Monitor: Triage exhaust" });
      dispatchMonitorEventToChild(store, event.id, admission.child.id);
      expect(await propagation.onChildReceipt(admission.receipt)).toBe(true);
      await waitFor(() => store.getMonitorEvent(event.id)?.stage === "failed", 3_500);
      expect(store.getMonitorEvent(event.id)).toMatchObject({ stage: "failed", attempts: 2, lastErrorCode: "triage_exhausted" });
      expect(store.getMonitorEvent(event.id)?.leaseOwner).toBeUndefined();
      expect(store.getReceipt(admission.receipt.id)).toMatchObject({ state: "persisted" });
      expect(events).toContain("triage_retryable");
      expect(events).toContain("failed");
    } finally {
      propagation.stop();
      store.close();
    }
  });

  test("stopping an in-flight authored triage prevents a stale retry timer", async () => {
    const { root, store } = createStore();
    const monitors = new MonitorStore(store, { hostTimeZone: "UTC" });
    const monitor = monitors.create({ id: "triage-stop", name: "Triage stop", trigger: { kind: "webhook", token: "S".repeat(24) }, instruction: "recover" });
    const lifecycle = new FakeDaemonLifecycle(store);
    const delivery = new DeliveryService({ store, port: new FakePort() });
    const journal = new TerminalJournal(join(root, "journal"));
    const prompts: string[] = [];
    let releaseTurn!: () => void;
    const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
    const propagation = new MonitorPropagation({
      store,
      monitors,
      lifecycle,
      mainSession: ownerMain(delivery, async (prompt) => {
        prompts.push(prompt);
        await turnGate;
        return { kind: "failed", code: "provider_error", message: "unavailable" };
      }),
    });
    try {
      const event = monitors.admitEvent(monitor, { eventType: "webhook", payload: { id: 3 }, occurrenceKey: "triage-stop-1" });
      const admission = admitTerminalReceipt(store, journal, { state: "failed", origin: "monitor", errorCode: "provider_error", title: "Monitor: Triage stop" });
      dispatchMonitorEventToChild(store, event.id, admission.child.id);
      const pending = propagation.onChildReceipt(admission.receipt);
      await waitFor(() => prompts.length === 1);
      propagation.stop();
      releaseTurn();
      expect(await pending).toBe(false);
      await Bun.sleep(1_050);
      expect(store.getMonitorEvent(event.id)).toMatchObject({ stage: "authored", attempts: 2 });
      expect(store.listDeliveries()).toHaveLength(0);
    } finally {
      propagation.stop();
      store.close();
    }
  });
});
