import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InterimInbox } from "../../src/children/interim.ts";
import type { OutboundDelivery } from "../../src/delivery/service.ts";
import { openStateStore, type StateStore } from "../../src/store/index.ts";
import { FakeMainTurner } from "./fakes.ts";

const directories: string[] = [];
const OWNER = "+821012345678";

class FakeDelivery {
  public readonly calls: OutboundDelivery[] = [];

  public constructor(private readonly store: StateStore) {}

  public admit(outbound: OutboundDelivery): { readonly id: string } {
    this.calls.push(outbound);
    const id = `delivery-${this.calls.length}`;
    this.store.admitDelivery({
      id,
      idempotencyKey: outbound.idempotencyKey,
      kind: "text",
      handle: outbound.handle,
      body: outbound.text,
      ...(outbound.childId === undefined ? {} : { childId: outbound.childId }),
    }, "2026-01-01T00:00:00.000Z");
    return { id };
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup(): { readonly store: StateStore; readonly main: FakeMainTurner; readonly delivery: FakeDelivery } {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-interim-"));
  directories.push(root);
  const store = openStateStore(join(root, "state.db"));
  store.createChild({
    id: "child-1",
    kind: "task_tool",
    priority: "conversational",
    origin: "owner",
    title: "Research",
    prompt: "work",
    timeoutMs: 1_000,
  }, "2026-01-01T00:00:00.000Z");
  return { store, main: new FakeMainTurner(), delivery: new FakeDelivery(store) };
}

function inbox(
  store: StateStore,
  main: FakeMainTurner,
  delivery: FakeDelivery,
  options: { readonly now?: () => Date; readonly batchMs?: number; readonly events?: Array<{ readonly event: string; readonly fields: Record<string, unknown> }> } = {},
): InterimInbox {
  main.ownerDelivery = (input) => delivery.admit({ idempotencyKey: input.idempotencyKey, handle: OWNER, text: input.text, ...(input.childId === undefined ? {} : { childId: input.childId }) });
  return new InterimInbox({
    store,
    mainSession: main,
    batchMs: options.batchMs ?? 5,
    now: options.now,
    onEvent: (event, fields) => options.events?.push({ event, fields }),
  });
}

async function waitFor(check: () => boolean, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for condition");
    }
    await Bun.sleep(1);
  }
}

describe("InterimInbox", () => {
  test("AC-13 admits reports durably and batches them into one internal turn", async () => {
    const { store, main, delivery } = setup();
    const updates = inbox(store, main, delivery, { batchMs: 5 });
    try {
      expect(updates.admit({ childId: "child-1", title: "Research", text: "first finding", toolCallId: "one" })).toMatchObject({ accepted: true });
      expect(updates.admit({ childId: "child-1", title: "Research", text: "second finding", toolCallId: "two" })).toMatchObject({ accepted: true });
      expect(store.listUnbatchedInterim()).toHaveLength(2);

      await waitFor(() => main.turns.length === 1);
      expect(main.turns[0]).toContain("[interim-batch ");
      expect(main.turns[0]).toContain("first finding");
      expect(main.turns[0]).toContain("second finding");
      expect(delivery.calls).toHaveLength(1);
      expect(store.listInterimBatches("delivered")).toHaveLength(1);
    } finally {
      updates.stop();
      store.close();
    }
  });

  test("persists UTF-8-truncated report bodies instead of rejecting them", () => {
    const { store, main, delivery } = setup();
    const updates = inbox(store, main, delivery, { batchMs: 100 });
    try {
      const result = updates.admit({
        childId: "child-1",
        title: "Research",
        text: "가".repeat(400),
        toolCallId: "long",
      });
      const message = store.listUnbatchedInterim()[0]!;
      expect(result).toMatchObject({ accepted: true, truncated: true });
      expect(result.bytes).toBeLessThanOrEqual(1_024);
      expect(message.truncated).toBe(true);
      expect(new TextEncoder().encode(message.body).byteLength).toBeLessThanOrEqual(1_024);
    } finally {
      updates.stop();
      store.close();
    }
  });

  test("deduplicates repeated report_progress tool call ids", () => {
    const { store, main, delivery } = setup();
    const updates = inbox(store, main, delivery, { batchMs: 100 });
    try {
      updates.admit({ childId: "child-1", title: "Research", text: "same update", toolCallId: "same-call" });
      updates.admit({ childId: "child-1", title: "Research", text: "same update", toolCallId: "same-call" });
      expect(store.listUnbatchedInterim()).toHaveLength(1);
    } finally {
      updates.stop();
      store.close();
    }
  });

  test("AC-14 steers an owner turn and waits for its correlated outbound admission", async () => {
    const { store, main, delivery } = setup();
    const updates = inbox(store, main, delivery);
    main.busy = true;
    main.ownerTurnId = "owner-1";
    try {
      updates.admit({ childId: "child-1", title: "Research", text: "owner update", toolCallId: "one" });
      const flushing = updates.flush();
      await waitFor(() => main.steers.length === 1);
      const batch = store.listInterimBatches("injected")[0]!;
      expect(batch).toMatchObject({ mode: "steer", ownerTurnId: "owner-1", attempt: 1 });
      expect(store.listInterimBatches("delivered")).toHaveLength(0);
      expect(main.turns).toHaveLength(0);

      store.admitDelivery({
        id: "owner-delivery",
        idempotencyKey: "owner-turn:owner-1",
        kind: "text",
        handle: OWNER,
        body: "owner text",
      }, "2026-01-01T00:00:00.000Z");
      main.emitTurnDelivered({ turnId: "owner-1", deliveryId: "owner-delivery" });
      await flushing;
      expect(store.getInterimBatch(batch.id)).toMatchObject({ state: "delivered", deliveryId: "owner-delivery", outcome: "owner_text" });
      expect(delivery.calls).toHaveLength(0);
    } finally {
      updates.stop();
      store.close();
    }
  });

  test("AC-14 uses an internal turn when busy state has no concrete owner turn id", async () => {
    const { store, main, delivery } = setup();
    const updates = inbox(store, main, delivery);
    main.busy = true;
    main.steerResult = false;
    try {
      updates.admit({ childId: "child-1", title: "Research", text: "race update", toolCallId: "one" });
      await updates.flush();
      const batch = store.listInterimBatches("delivered")[0]!;
      expect(main.steers).toHaveLength(0);
      expect(main.turns).toHaveLength(1);
      expect(batch).toMatchObject({ mode: "turn", attempt: 1, outcome: "owner_text" });
      expect(delivery.calls[0]?.idempotencyKey).toBe(`interim-batch:${batch.id}`);
    } finally {
      updates.stop();
      store.close();
    }
  });

  test("retries a steered batch through an internal turn after the owner turn fails", async () => {
    const { store, main, delivery } = setup();
    const updates = inbox(store, main, delivery);
    main.busy = true;
    main.ownerTurnId = "owner-failed";
    try {
      updates.admit({ childId: "child-1", title: "Research", text: "retry update", toolCallId: "one" });
      const flushing = updates.flush();
      await waitFor(() => main.steers.length === 1);
      main.emitTurnDelivered({ turnId: "owner-failed", turnKind: "failed" });
      await flushing;
      expect(main.turns).toHaveLength(1);
      expect(store.listInterimBatches("delivered")[0]).toMatchObject({ mode: "turn", attempt: 2, outcome: "owner_text" });
    } finally {
      updates.stop();
      store.close();
    }
  });

  test("AC-15 rate-limits the seventh report and carries a durable omission snapshot", async () => {
    const { store, main, delivery } = setup();
    const events: Array<{ readonly event: string; readonly fields: Record<string, unknown> }> = [];
    const fixed = new Date("2026-01-01T00:00:00.000Z");
    const updates = inbox(store, main, delivery, { now: () => fixed, batchMs: 100, events });
    try {
      for (let index = 1; index <= 6; index += 1) {
        expect(updates.admit({ childId: "child-1", title: "Research", text: `update ${index}`, toolCallId: String(index) })).toMatchObject({ accepted: true });
      }
      expect(updates.admit({ childId: "child-1", title: "Research", text: "dropped", toolCallId: "seven" })).toMatchObject({
        accepted: false,
        reason: "rate_limited",
      });
      expect(store.getChild("child-1")?.interimOmitted).toBe(1);
      expect(events).toContainEqual(expect.objectContaining({ event: "interim_dropped", fields: expect.objectContaining({ childId: "child-1", omitted: 1 }) }));

      await updates.flush();
      const batch = store.listInterimBatches("delivered")[0]!;
      expect(batch.omitted).toEqual({ "child-1": 1 });
      expect(batch.prompt).toContain("1 earlier update from “Research” was dropped by the rate limit");
      expect(store.getChild("child-1")?.interimOmitted).toBe(0);
    } finally {
      updates.stop();
      store.close();
    }
  });

  test("keeps a durable omission when an in-memory rate window restarts", async () => {
    const { store, main, delivery } = setup();
    const fixed = new Date("2026-01-01T00:00:00.000Z");
    const first = inbox(store, main, delivery, { now: () => fixed, batchMs: 100 });
    const restarted = inbox(store, main, delivery, { now: () => fixed, batchMs: 100 });
    try {
      for (let index = 1; index <= 7; index += 1) {
        first.admit({ childId: "child-1", title: "Research", text: `update ${index}`, toolCallId: String(index) });
      }
      expect(store.getChild("child-1")?.interimOmitted).toBe(1);
      first.stop();

      expect(restarted.admit({ childId: "child-1", title: "Research", text: "after restart", toolCallId: "after" })).toMatchObject({ accepted: true });
      await restarted.flush();
      expect(store.listInterimBatches("delivered")[0]?.prompt).toContain("1 earlier update from “Research” was dropped by the rate limit");
    } finally {
      first.stop();
      restarted.stop();
      store.close();
    }
  });

  test("AC-16 replays assigned batches once after a crash before injection", async () => {
    const { store, main, delivery } = setup();
    const original = inbox(store, main, delivery, { batchMs: 100 });
    const restarted = inbox(store, main, delivery, { batchMs: 100 });
    try {
      original.admit({ childId: "child-1", title: "Research", text: "assigned crash", toolCallId: "one" });
      const assigned = store.assignInterimBatch("2026-01-01T00:00:01.000Z")!.batch;
      expect(assigned.state).toBe("assigned");

      await restarted.replay();
      expect(main.turns).toHaveLength(1);
      expect(main.turns[0]).toContain(`[interim-batch ${assigned.id}]`);
      expect(store.getInterimBatch(assigned.id)).toMatchObject({ state: "delivered", attempt: 1 });
    } finally {
      original.stop();
      restarted.stop();
      store.close();
    }
  });

  test("AC-16 recognizes a persisted marker after injected-before-delivered crash without reinjection", async () => {
    const { store, main, delivery } = setup();
    const original = inbox(store, main, delivery, { batchMs: 100 });
    const restarted = inbox(store, main, delivery, { batchMs: 100 });
    try {
      original.admit({ childId: "child-1", title: "Research", text: "marker crash", toolCallId: "one" });
      const assigned = store.assignInterimBatch("2026-01-01T00:00:01.000Z")!.batch;
      store.markInterimBatchInjected(assigned.id, "turn", "2026-01-01T00:00:02.000Z");
      main.messages.push({ content: [{ type: "text", text: `[interim-batch ${assigned.id}]` }] });

      await restarted.replay();
      expect(main.turns).toHaveLength(0);
      expect(store.getInterimBatch(assigned.id)).toMatchObject({ state: "delivered", attempt: 1, outcome: "reply_lost" });
    } finally {
      original.stop();
      restarted.stop();
      store.close();
    }
  });

  test("AC-16 reinjects a marker-absent injected batch with attempt two and dedupes owner delivery", async () => {
    const { store, main, delivery } = setup();
    const original = inbox(store, main, delivery, { batchMs: 100 });
    const restarted = inbox(store, main, delivery, { batchMs: 100 });
    try {
      original.admit({ childId: "child-1", title: "Research", text: "missing marker", toolCallId: "one" });
      const assigned = store.assignInterimBatch("2026-01-01T00:00:01.000Z")!.batch;
      store.markInterimBatchInjected(assigned.id, "turn", "2026-01-01T00:00:02.000Z");

      await restarted.replay();
      expect(main.turns).toHaveLength(1);
      expect(store.getInterimBatch(assigned.id)).toMatchObject({ state: "delivered", attempt: 2, outcome: "owner_text" });
      expect(delivery.calls).toHaveLength(1);
      expect(delivery.calls[0]?.idempotencyKey).toBe(`interim-batch:${assigned.id}`);

      await restarted.replay();
      expect(main.turns).toHaveLength(1);
      expect(delivery.calls).toHaveLength(1);
    } finally {
      original.stop();
      restarted.stop();
      store.close();
    }
  });
  test("marks a sentinel internal reply silent without an owner delivery", async () => {
    const { store, main, delivery } = setup();
    const updates = inbox(store, main, delivery);
    main.turnResult = { kind: "reply", text: "[[no-owner-message]]" };
    try {
      updates.admit({ childId: "child-1", title: "Research", text: "silent update", toolCallId: "one" });
      await updates.flush();
      expect(store.listInterimBatches("delivered")[0]).toMatchObject({ outcome: "silent" });
      expect(delivery.calls).toEqual([]);
    } finally {
      updates.stop();
      store.close();
    }
  });

  test("retries a thrown steer in-process instead of waiting for restart", async () => {
    const { store, main, delivery } = setup();
    const updates = inbox(store, main, delivery, { batchMs: 5 });
    const originalSteer = main.steer.bind(main);
    let attempts = 0;
    main.busy = true;
    main.ownerTurnId = "owner-throw";
    main.steer = async (input) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("steer failed");
      }
      return await originalSteer(input);
    };
    try {
      updates.admit({ childId: "child-1", title: "Research", text: "retry steer", toolCallId: "throw" });
      await updates.flush();
      await waitFor(() => main.turns.length === 1);
      const batch = store.listInterimBatches("delivered")[0]!;
      expect(attempts).toBe(1);
      expect(batch).toMatchObject({ state: "delivered", attempt: 2, outcome: "owner_text" });
      expect(delivery.calls).toHaveLength(1);
    } finally {
      updates.stop();
      store.close();
    }
  });
  test("catches a rejected internal turn and retries the same batch in process", async () => {
    const { store, main, delivery } = setup();
    const updates = inbox(store, main, delivery, { batchMs: 5 });
    const originalTurn = main.turn.bind(main);
    let attempts = 0;
    main.turn = async (prompt) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("turn failed once");
      }
      return originalTurn(prompt);
    };
    try {
      updates.admit({ childId: "child-1", title: "Research", text: "retry turn", toolCallId: "turn-throw" });
      await updates.flush();
      await waitFor(() => store.listInterimBatches("delivered").length === 1);
      expect(attempts).toBe(2);
      expect(main.turns).toHaveLength(1);
      expect(delivery.calls).toHaveLength(1);
      expect(store.listInterimBatches("delivered")[0]).toMatchObject({ attempt: 2, outcome: "owner_text" });
    } finally {
      updates.stop();
      store.close();
    }
  });
  test("flushes an omission-only batch when no later report is accepted", async () => {
    const { store, main, delivery } = setup();
    const updates = inbox(store, main, delivery, { batchMs: 5 });
    try {
      for (let index = 0; index < 6; index += 1) {
        updates.admit({ childId: "child-1", title: "Research", text: `update ${index}`, toolCallId: `accepted-${index}` });
      }
      await updates.flush();
      expect(updates.admit({ childId: "child-1", title: "Research", text: "dropped only", toolCallId: "dropped-only" })).toMatchObject({ accepted: false, reason: "rate_limited" });
      await waitFor(() => store.listInterimBatches("delivered").length === 2);
      const omissionBatch = store.listInterimBatches("delivered").at(-1)!;
      expect(omissionBatch.prompt).toContain("1 earlier update from “Research” was dropped by the rate limit");
      expect(omissionBatch.omitted).toEqual({ "child-1": 1 });
      expect(main.turns).toHaveLength(2);
    } finally {
      updates.stop();
      store.close();
    }
  });
  test("AC-16 recovers an owner delivery admitted before the batch was marked delivered", async () => {
    const { store, main, delivery } = setup();
    const original = inbox(store, main, delivery, { batchMs: 100 });
    const restarted = inbox(store, main, delivery, { batchMs: 100 });
    try {
      original.admit({ childId: "child-1", title: "Research", text: "owner delivery crash", toolCallId: "one" });
      const assigned = store.assignInterimBatch("2026-01-01T00:00:01.000Z")!.batch;
      store.markInterimBatchInjected(assigned.id, "turn", "2026-01-01T00:00:02.000Z");
      store.admitDelivery({
        id: "pre-mark-delivery",
        idempotencyKey: `interim-batch:${assigned.id}`,
        kind: "text",
        handle: OWNER,
        body: "already admitted",
      }, "2026-01-01T00:00:02.000Z");

      await restarted.replay();
      expect(main.turns).toHaveLength(0);
      expect(store.getInterimBatch(assigned.id)).toMatchObject({
        state: "delivered",
        deliveryId: "pre-mark-delivery",
        outcome: "owner_text",
      });
    } finally {
      original.stop();
      restarted.stop();
      store.close();
    }
  });

});
