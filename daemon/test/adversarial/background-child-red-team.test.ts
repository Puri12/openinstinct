import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import { tmpdir } from "node:os";

import { ChildLifecycle } from "../../src/children/lifecycle.ts";
import { ChildRegistry } from "../../src/children/registry.ts";
import { TerminalJournal } from "../../src/children/terminal-journal.ts";
import { InterimInbox, type InterimTurnDelivery, type InterimTurner } from "../../src/children/interim.ts";
import { createChildNudgeTool, createChildStatusTool } from "../../src/sdk-session/child-tools.ts";
import type { MainTurnResult } from "../../src/sdk-session/main-session.ts";
import { openStateStore, type StateStore } from "../../src/store/index.ts";
import { Deferred, FakeConversationRunner } from "../children/fakes.ts";

const directories: string[] = [];
const OWNER = "+821012345678";

interface MainStub extends InterimTurner {
  readonly turns: string[];
  readonly steers: string[];
}

class UnavailableTranscriptMain implements MainStub {
  public ownerDelivery?: (input: { readonly idempotencyKey: string; readonly text: string; readonly childId?: string }) => { readonly id: string };
  public busy = false;
  public readonly turns: string[] = [];
  public readonly steers: string[] = [];

  public async steer(input: { readonly text: string; readonly owner?: boolean }): Promise<boolean> {
    this.steers.push(input.text);
    return false;
  }

  public async turn(prompt: string): Promise<MainTurnResult> {
    this.turns.push(prompt);
    return { kind: "reply", text: "owner answer" };
  }

  public admitOwnerReply(input: { readonly idempotencyKey: string; readonly text: string; readonly childId?: string }): { readonly id: string } {
    return this.ownerDelivery?.(input) ?? { id: input.idempotencyKey };
  }

  public onTurnDelivered(_listener: (delivery: InterimTurnDelivery) => void): () => void {
    return () => undefined;
  }
}

class MemoryDelivery {
  public readonly calls: Array<{ readonly idempotencyKey: string; readonly text: string }> = [];

  public constructor(private readonly store: StateStore) {}

  public admit(input: { readonly idempotencyKey: string; readonly handle: string; readonly text: string; readonly childId?: string }): { readonly id: string } {
    const id = `delivery-${this.calls.length + 1}`;
    this.calls.push({ idempotencyKey: input.idempotencyKey, text: input.text });
    this.store.admitDelivery({
      id,
      idempotencyKey: input.idempotencyKey,
      kind: "text",
      handle: input.handle,
      body: input.text,
      ...(input.childId === undefined ? {} : { childId: input.childId }),
    }, "2026-01-01T00:00:00.000Z");
    return { id };
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore(): { readonly root: string; readonly store: StateStore } {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-red-team-"));
  directories.push(root);
  return { root, store: openStateStore(join(root, "state.db")) };
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 1_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("timed out waiting for adversarial condition");
    await Bun.sleep(2);
  }
}

function lifecycle(root: string, store: StateStore, conversation: FakeConversationRunner, options: {
  readonly maxConcurrent?: number;
  readonly maxLive?: number;
  readonly warmTtlMs?: number;
  readonly idleTimeoutMs?: number;
  readonly now?: () => Date;
  readonly onReceipt?: (receipt: import("../../src/store/index.ts").ReceiptRecord) => void;
} = {}): ChildLifecycle {
  return new ChildLifecycle({
    registry: new ChildRegistry(store, { now: options.now }),
    journal: new TerminalJournal(join(root, "journal")),
    runner: { name: "daemon", run: async () => ({ state: "completed", summary: "daemon" }) },
    conversation,
    maxConcurrent: options.maxConcurrent,
    maxLive: options.maxLive,
    warmTtlMs: options.warmTtlMs,
    idleTimeoutMs: options.idleTimeoutMs,
    now: options.now,
    onReceipt: options.onReceipt,
  });
}

describe("background-child adversarial boundary checks", () => {
  test("cold nudge stays synchronous while open is permanently unresolved and releases without a slot leak", async () => {
    const { root, store } = createStore();
    let clock = new Date("2026-01-01T00:00:00.000Z");
    const sessionFile = join(root, "huge-unreadable-transcript.jsonl");
    writeFileSync(sessionFile, "x".repeat(4 * 1024 * 1024));
    chmodSync(sessionFile, 0o000);
    const conversation = new FakeConversationRunner({ sessionFile });
    const lifecycleInstance = lifecycle(root, store, conversation, {
      warmTtlMs: 1,
      now: () => clock,
    });

    try {
      const child = lifecycleInstance.delegate({ title: "cold child", prompt: "initial" });
      const warm = await waitFor(() => conversation.conversation(child.id));
      await waitFor(() => warm.turns[0]);
      warm.complete("initial answer");
      await waitFor(() => store.getChild(child.id)?.state === "idle" ? store.getChild(child.id) : undefined);

      clock = new Date(clock.getTime() + 1);
      lifecycleInstance.sweep(clock);
      await waitFor(() => store.getChild(child.id)?.state === "cold" ? store.getChild(child.id) : undefined);
      conversation.openGate = new Deferred<void>();

      const started = performance.now();
      expect(lifecycleInstance.nudge(child.id, "resume now", { receipt: false })).toEqual({ status: "cold", queued: true });
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(50);

      await waitFor(() => store.getChild(child.id)?.state === "running" ? store.getChild(child.id) : undefined);
      expect(lifecycleInstance.activeCount).toBe(1);
      expect(lifecycleInstance.release(child.id)).toEqual({ status: "cancelling" });
      expect(lifecycleInstance.activeCount).toBe(1);
      conversation.openGate.resolve();
      await waitFor(() => store.getChild(child.id)?.state === "cancelled" ? store.getChild(child.id) : undefined);
      await waitFor(() => lifecycleInstance.activeCount === 0 ? true : undefined);
      expect(store.getChild(child.id)?.state).toBe("cancelled");
    } finally {
      conversation.openGate?.resolve();
      await lifecycleInstance.stop();
      store.close();
    }
  });

  test("sixteen opening children tolerate a status read and nudge storm without awaiting their opens", async () => {
    const { root, store } = createStore();
    const conversation = new FakeConversationRunner();
    conversation.openGate = new Deferred<void>();
    const lifecycleInstance = lifecycle(root, store, conversation, { maxConcurrent: 16, maxLive: 16 });
    const children = [] as Array<{ readonly id: string }>;

    try {
      for (let index = 0; index < 16; index += 1) {
        children.push(lifecycleInstance.delegate({ title: `child-${index}`, prompt: "work" }));
      }
      await waitFor(() => lifecycleInstance.activeCount === 16 ? true : undefined);
      const status = createChildStatusTool({
        reader: {
          getChild: (id) => store.getChild(id),
          listLiveChildren: (limit) => store.listLiveChildren(limit),
          countLiveChildren: () => store.countLiveChildren(),
        },
      });
      const started = performance.now();
      const result = await (status as any).execute("status-storm", {}, undefined, {});
      for (const child of children) {
        expect(lifecycleInstance.nudge(child.id, "keep going", { receipt: false })).toEqual({ status: "queued" });
      }
      expect(performance.now() - started).toBeLessThan(50);
      expect((result as { readonly details: { readonly total: number } }).details.total).toBe(16);
      for (const child of children) {
        expect(lifecycleInstance.release(child.id)).toEqual({ status: "cancelling" });
      }
      conversation.openGate.resolve();
      await waitFor(() => lifecycleInstance.activeCount === 0 ? true : undefined);
      expect(store.countLiveChildren()).toBe(0);
    } finally {
      conversation.openGate?.resolve();
      await lifecycleInstance.stop();
      store.close();
    }
  });

  test("nudges coalesced during opening OR receipt flags and release during opening is asynchronous", async () => {
    const { root, store } = createStore();
    const conversation = new FakeConversationRunner();
    conversation.openGate = new Deferred<void>();
    const receipts: import("../../src/store/index.ts").ReceiptRecord[] = [];
    const lifecycleInstance = lifecycle(root, store, conversation, { onReceipt: (receipt) => receipts.push(receipt) });

    try {
      const child = lifecycleInstance.delegate({ title: "coalesced", prompt: "first" });
      await waitFor(() => store.getChild(child.id)?.state === "running" ? store.getChild(child.id) : undefined);
      expect(lifecycleInstance.nudge(child.id, "silent follow-up", { receipt: false })).toEqual({ status: "queued" });
      expect(lifecycleInstance.nudge(child.id, "please relay", { receipt: true })).toEqual({ status: "queued" });
      conversation.openGate.resolve();
      const fake = await waitFor(() => conversation.conversation(child.id));
      await waitFor(() => fake.turns[0]);
      expect(fake.turns[0]?.prompt).toBe("first\n\nsilent follow-up\n\nplease relay");
      fake.complete("one coalesced answer");
      await waitFor(() => store.getChild(child.id)?.state === "idle" ? store.getChild(child.id) : undefined);
      expect(receipts).toHaveLength(1);
      expect((lifecycleInstance as unknown as { readonly conversations: Map<string, { readonly receiptWanted: boolean }> }).conversations.get(child.id)?.receiptWanted).toBe(false);

      expect(lifecycleInstance.nudge(child.id, "silent next turn", { receipt: false })).toEqual({ status: "started" });
      await waitFor(() => fake.turns.length === 2 ? fake.turns[1] : undefined);
      fake.complete("silent next answer");
      await waitFor(() => store.getChild(child.id)?.turnSeq === 2 ? store.getChild(child.id) : undefined);
      expect(receipts).toHaveLength(1);
    } finally {
      conversation.openGate?.resolve();
      await lifecycleInstance.stop();
      store.close();
    }
  });
});

describe("interim replay with unavailable transcript", () => {
  test("does not silently mark an injected batch delivered when messages are absent", async () => {
    const { store } = createStore();
    const main = new UnavailableTranscriptMain();
    const delivery = new MemoryDelivery(store);
    main.ownerDelivery = (input) => delivery.admit({ idempotencyKey: input.idempotencyKey, handle: OWNER, text: input.text, ...(input.childId === undefined ? {} : { childId: input.childId }) });
    store.createChild({
      id: "child-1",
      kind: "task_tool",
      priority: "conversational",
      origin: "owner",
      title: "Research",
      prompt: "work",
      timeoutMs: 1_000,
    }, "2026-01-01T00:00:00.000Z");
    const original = new InterimInbox({ store, mainSession: main, batchMs: 1 });
    const restarted = new InterimInbox({ store, mainSession: main, batchMs: 1 });

    try {
      original.admit({ childId: "child-1", title: "Research", text: "marker unavailable", toolCallId: "report-1" });
      const assigned = store.assignInterimBatch("2026-01-01T00:00:01.000Z")!.batch;
      store.markInterimBatchInjected(assigned.id, "turn", "2026-01-01T00:00:02.000Z");
      await restarted.replay();
      expect(main.turns).toHaveLength(1);
      expect(store.getInterimBatch(assigned.id)).toMatchObject({ state: "delivered", attempt: 2, outcome: "owner_text" });
      expect(delivery.calls).toHaveLength(1);
      expect(delivery.calls[0]?.idempotencyKey).toBe(`interim-batch:${assigned.id}`);
    } finally {
      original.stop();
      restarted.stop();
      store.close();
    }
  });
});
