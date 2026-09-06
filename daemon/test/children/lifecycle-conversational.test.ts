import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChildLifecycle } from "../../src/children/lifecycle.ts";
import { ChildRegistry } from "../../src/children/registry.ts";
import { TerminalJournal } from "../../src/children/terminal-journal.ts";
import { openStateStore, type ReceiptRecord, type StateStore } from "../../src/store/index.ts";
import { Deferred, FakeConversationRunner } from "./fakes.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore(): { readonly root: string; readonly store: StateStore } {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-conversational-lifecycle-"));
  directories.push(root);
  return { root, store: openStateStore(join(root, "state.db")) };
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 1_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("timed out waiting for conversational child state");
    await Bun.sleep(5);
  }
}

function assertActiveInvariant(lifecycle: ChildLifecycle, store: StateStore): void {
  expect(lifecycle.activeCount).toBe(store.listChildren().filter((child) => child.state === "running").length);
}

function stateOf(lifecycle: ChildLifecycle, childId: string): { readonly phase: string; readonly receiptWanted: boolean } {
  return (lifecycle as unknown as {
    readonly conversations: Map<string, { readonly phase: string; readonly receiptWanted: boolean }>;
  }).conversations.get(childId)!;
}

describe("conversational ChildLifecycle", () => {
  test("idles the first turn, releases its slot, and starts a nudge synchronously", async () => {
    const { root, store } = createStore();
    const conversation = new FakeConversationRunner();
    const lifecycle = new ChildLifecycle({
      registry: new ChildRegistry(store),
      journal: new TerminalJournal(join(root, "journal")),
      runner: { name: "daemon", run: async () => ({ state: "completed", summary: "daemon" }) },
      conversation,
      maxConcurrent: 1,
    });

    try {
      const first = lifecycle.delegate({ title: "first", prompt: "first turn" });
      const firstConversation = await waitFor(() => conversation.conversation(first.id));
      await waitFor(() => firstConversation.turns.length === 1 ? firstConversation.turns[0] : undefined);
      assertActiveInvariant(lifecycle, store);
      firstConversation.complete("first result");
      await waitFor(() => store.getChild(first.id)?.state === "idle" ? store.getChild(first.id) : undefined);
      assertActiveInvariant(lifecycle, store);
      expect(store.getChild(first.id)).toMatchObject({ state: "idle", turnSeq: 1, lastAssistantText: "first result" });

      const second = lifecycle.delegate({ title: "second", prompt: "second turn" });
      const secondConversation = await waitFor(() => conversation.conversation(second.id));
      await waitFor(() => secondConversation.turns.length === 1 ? secondConversation.turns[0] : undefined);
      assertActiveInvariant(lifecycle, store);
      secondConversation.complete("second result");
      await waitFor(() => store.getChild(second.id)?.state === "idle" ? store.getChild(second.id) : undefined);

      const nudge = lifecycle.nudge(first.id, "follow up", { receipt: false });
      expect(nudge).toEqual({ status: "started" });
      await waitFor(() => firstConversation.turns.length === 2 ? firstConversation.turns[1] : undefined);
      expect(firstConversation.turns.at(-1)?.prompt).toBe("follow up");
      assertActiveInvariant(lifecycle, store);
      firstConversation.complete("follow up result");
      await waitFor(() => store.getChild(first.id)?.turnSeq === 2 ? store.getChild(first.id) : undefined);
      assertActiveInvariant(lifecycle, store);
    } finally {
      await lifecycle.stop();
      store.close();
    }
  });

  test("steers a running child and ORs receipt:true until that generation settles", async () => {
    const { root, store } = createStore();
    const receipts: ReceiptRecord[] = [];
    const conversation = new FakeConversationRunner();
    const lifecycle = new ChildLifecycle({
      registry: new ChildRegistry(store),
      journal: new TerminalJournal(join(root, "journal")),
      runner: { name: "daemon", run: async () => ({ state: "completed", summary: "daemon" }) },
      conversation,
      onReceipt: (receipt) => { receipts.push(receipt); },
    });

    try {
      const child = lifecycle.delegate({ title: "race", prompt: "initial" });
      const fake = await waitFor(() => conversation.conversation(child.id));
      await waitFor(() => fake.turns.length === 1 ? fake.turns[0] : undefined);
      fake.complete("initial result");
      await waitFor(() => store.getChild(child.id)?.state === "idle" ? store.getChild(child.id) : undefined);
      expect(receipts).toHaveLength(1);

      expect(lifecycle.nudge(child.id, "turn two", { receipt: false })).toEqual({ status: "started" });
      await waitFor(() => fake.turns.length === 2 ? fake.turns[1] : undefined);
      expect(lifecycle.nudge(child.id, "please send this", { receipt: true })).toEqual({ status: "steered" });
      expect(fake.steers).toEqual(["please send this"]);
      expect(stateOf(lifecycle, child.id)).toMatchObject({ phase: "running", receiptWanted: true });
      assertActiveInvariant(lifecycle, store);

      fake.complete("second result");
      await waitFor(() => store.getChild(child.id)?.turnSeq === 2 ? store.getChild(child.id) : undefined);
      expect(receipts).toHaveLength(2);
      expect(receipts.at(-1)?.idempotencyKey).toBe(`child-turn:${child.id}:2`);
      expect(stateOf(lifecycle, child.id)).toMatchObject({ phase: "idle", receiptWanted: false });
      assertActiveInvariant(lifecycle, store);

      expect(lifecycle.nudge(child.id, "turn three", { receipt: false })).toEqual({ status: "started" });
      await waitFor(() => fake.turns.length === 3 ? fake.turns[2] : undefined);
      fake.complete("third result");
      await waitFor(() => store.getChild(child.id)?.turnSeq === 3 ? store.getChild(child.id) : undefined);
      expect(receipts).toHaveLength(2);
      expect(stateOf(lifecycle, child.id)).toMatchObject({ phase: "idle", receiptWanted: false });
      assertActiveInvariant(lifecycle, store);
    } finally {
      await lifecycle.stop();
      store.close();
    }
  });

  test("coalesces warm-idle nudges while the last slot is occupied and preserves receipt OR", async () => {
    const { root, store } = createStore();
    const receipts: ReceiptRecord[] = [];
    const conversation = new FakeConversationRunner();
    const lifecycle = new ChildLifecycle({
      registry: new ChildRegistry(store),
      journal: new TerminalJournal(join(root, "journal")),
      runner: { name: "daemon", run: async () => ({ state: "completed", summary: "daemon" }) },
      conversation,
      maxConcurrent: 1,
      onReceipt: (receipt) => { receipts.push(receipt); },
    });
    try {
      const child = lifecycle.delegate({ title: "warm", prompt: "initial" });
      const warm = await waitFor(() => conversation.conversation(child.id));
      await waitFor(() => warm.turns[0]);
      warm.complete("initial done");
      await waitFor(() => store.getChild(child.id)?.state === "idle" ? true : undefined);

      const blocker = lifecycle.delegate({ title: "blocker", prompt: "hold slot" });
      const occupied = await waitFor(() => conversation.conversation(blocker.id));
      await waitFor(() => occupied.turns[0]);
      expect(lifecycle.nudge(child.id, "first warm nudge", { receipt: true })).toEqual({ status: "started" });
      expect(lifecycle.nudge(child.id, "second warm nudge", { receipt: false })).toEqual({ status: "queued" });
      expect(warm.turns).toHaveLength(1);

      occupied.complete("slot free");
      const turn = await waitFor(() => warm.turns[1]);
      expect(turn.prompt).toBe("first warm nudge\n\nsecond warm nudge");
      warm.complete("combined done");
      await waitFor(() => store.getChild(child.id)?.turnSeq === 2 ? true : undefined);
      expect(receipts.filter((receipt) => receipt.childId === child.id)).toHaveLength(2);
      expect(receipts.at(-1)?.idempotencyKey).toBe(`child-turn:${child.id}:2`);
      assertActiveInvariant(lifecycle, store);
    } finally {
      await lifecycle.stop();
      store.close();
    }
  });

  test("releases an idle child without a receipt and terminally publishes failed turns", async () => {
    const { root, store } = createStore();
    const receipts: ReceiptRecord[] = [];
    const conversation = new FakeConversationRunner();
    const lifecycle = new ChildLifecycle({
      registry: new ChildRegistry(store),
      journal: new TerminalJournal(join(root, "journal")),
      runner: { name: "daemon", run: async () => ({ state: "completed", summary: "daemon" }) },
      conversation,
      onReceipt: (receipt) => { receipts.push(receipt); },
    });

    try {
      const releasable = lifecycle.delegate({ title: "releasable", prompt: "initial" });
      const idleConversation = await waitFor(() => conversation.conversation(releasable.id));
      await waitFor(() => idleConversation.turns.length === 1 ? idleConversation.turns[0] : undefined);
      idleConversation.complete("done");
      await waitFor(() => store.getChild(releasable.id)?.state === "idle" ? store.getChild(releasable.id) : undefined);
      const receiptCount = receipts.length;
      expect(lifecycle.release(releasable.id)).toEqual({ status: "released" });
      await waitFor(() => store.getChild(releasable.id)?.state === "terminated" ? store.getChild(releasable.id) : undefined);
      expect(store.getChild(releasable.id)).toMatchObject({ state: "terminated", terminalSummary: "released" });
      expect(store.listLiveChildren().some((child) => child.id === releasable.id)).toBe(false);
      expect(receipts).toHaveLength(receiptCount);
      assertActiveInvariant(lifecycle, store);

      const failing = lifecycle.delegate({ title: "failing", prompt: "fail" });
      const failingConversation = await waitFor(() => conversation.conversation(failing.id));
      await waitFor(() => failingConversation.turns.length === 1 ? failingConversation.turns[0] : undefined);
      failingConversation.fail("provider_error", "provider refused request");
      await waitFor(() => store.getChild(failing.id)?.state === "failed" ? store.getChild(failing.id) : undefined);
      expect(receipts.at(-1)).toMatchObject({ childId: failing.id, state: "persisted" });
      expect(store.getChild(failing.id)).toMatchObject({ errorCode: "provider_error" });
      assertActiveInvariant(lifecycle, store);
    } finally {
      await lifecycle.stop();
      store.close();
    }
  });
  test("cancellation generation wins when completion races release", async () => {
    const { root, store } = createStore();
    const conversation = new FakeConversationRunner();
    const lifecycle = new ChildLifecycle({
      registry: new ChildRegistry(store),
      journal: new TerminalJournal(join(root, "journal")),
      runner: { name: "daemon", run: async () => ({ state: "completed", summary: "daemon" }) },
      conversation,
    });

    try {
      const child = lifecycle.delegate({ title: "cancel race", prompt: "initial" });
      const fake = await waitFor(() => conversation.conversation(child.id));
      await waitFor(() => fake.turns[0]);
      expect(lifecycle.release(child.id)).toEqual({ status: "cancelling" });
      fake.complete("completion raced cancellation");
      await waitFor(() => store.getChild(child.id)?.state === "cancelled" ? store.getChild(child.id) : undefined);
      expect(store.getChild(child.id)).toMatchObject({ state: "cancelled", errorCode: "cancelled" });
      expect(stateOf(lifecycle, child.id)).toMatchObject({ phase: "terminated" });
    } finally {
      await lifecycle.stop();
      store.close();
    }
  });

  test("bounds a rejecting or hanging dormant dispose and always exits disposing", async () => {
    const { root, store } = createStore();
    const conversation = new FakeConversationRunner();
    const lifecycle = new ChildLifecycle({
      registry: new ChildRegistry(store),
      journal: new TerminalJournal(join(root, "journal")),
      runner: { name: "daemon", run: async () => ({ state: "completed", summary: "daemon" }) },
      conversation,
      disposeTimeoutMs: 10,
      maxLive: 1,
      maxConcurrent: 1,
    });

    try {
      const child = lifecycle.delegate({ title: "dispose race", prompt: "initial" });
      const fake = await waitFor(() => conversation.conversation(child.id));
      await waitFor(() => fake.turns[0]);
      fake.complete("initial");
      await waitFor(() => store.getChild(child.id)?.state === "idle" ? store.getChild(child.id) : undefined);
      (fake as unknown as { dispose: () => Promise<void> }).dispose = async () => await new Promise<void>(() => undefined);
      expect(lifecycle.release(child.id)).toEqual({ status: "released" });
      expect(lifecycle.status(child.id)?.state).toBe("terminated");
      const replacement = lifecycle.delegate({ title: "replacement after release", prompt: "next" });
      expect(replacement.id).not.toBe(child.id);
      await waitFor(() => store.getChild(child.id)?.state === "terminated" ? true : undefined);
      await waitFor(() => stateOf(lifecycle, child.id).phase === "terminated" ? true : undefined);
      expect(stateOf(lifecycle, child.id)).toMatchObject({ phase: "terminated" });
    } finally {
      await lifecycle.stop();
      store.close();
    }
  });
  test("moves a warm child to cold after a rejecting dispose", async () => {
    const { root, store } = createStore();
    let clock = new Date("2026-01-01T00:00:00.000Z");
    const conversation = new FakeConversationRunner();
    const lifecycle = new ChildLifecycle({
      registry: new ChildRegistry(store),
      journal: new TerminalJournal(join(root, "journal")),
      runner: { name: "daemon", run: async () => ({ state: "completed", summary: "daemon" }) },
      conversation,
      warmTtlMs: 1,
      disposeTimeoutMs: 10,
      now: () => clock,
    });

    try {
      const child = lifecycle.delegate({ title: "reject dispose", prompt: "initial" });
      const fake = await waitFor(() => conversation.conversation(child.id));
      await waitFor(() => fake.turns[0]);
      fake.complete("initial");
      await waitFor(() => store.getChild(child.id)?.state === "idle" ? store.getChild(child.id) : undefined);
      (fake as unknown as { dispose: () => Promise<void> }).dispose = async () => {
        throw new Error("dispose failed");
      };
      clock = new Date(clock.getTime() + 1);
      lifecycle.sweep(clock);
      await waitFor(() => store.getChild(child.id)?.state === "cold" ? store.getChild(child.id) : undefined);
      expect(stateOf(lifecycle, child.id)).toMatchObject({ phase: "cold" });
    } finally {
      await lifecycle.stop();
      store.close();
    }
  });

  test("sweeps warm idle sessions to cold and terminates expired idle children without a receipt", async () => {
    const { root, store } = createStore();
    let clock = new Date("2026-01-01T00:00:00.000Z");
    const sessionFile = join(root, "child.jsonl");
    writeFileSync(sessionFile, "conversation");
    const receipts: ReceiptRecord[] = [];
    const conversation = new FakeConversationRunner({ sessionFile });
    const lifecycle = new ChildLifecycle({
      registry: new ChildRegistry(store, { now: () => clock }),
      journal: new TerminalJournal(join(root, "journal")),
      runner: { name: "daemon", run: async () => ({ state: "completed", summary: "daemon" }) },
      conversation,
      warmTtlMs: 600_000,
      idleTimeoutMs: 86_400_000,
      onReceipt: (receipt) => { receipts.push(receipt); },
      now: () => clock,
    });

    try {
      const child = lifecycle.delegate({ title: "sweep", prompt: "initial" });
      const warm = await waitFor(() => conversation.conversation(child.id));
      await waitFor(() => warm.turns[0]);
      warm.complete("initial answer");
      await waitFor(() => store.getChild(child.id)?.state === "idle" ? store.getChild(child.id) : undefined);
      expect(receipts).toHaveLength(1);
      assertActiveInvariant(lifecycle, store);

      clock = new Date(clock.getTime() + 600_000);
      lifecycle.sweep(clock);
      await waitFor(() => store.getChild(child.id)?.state === "cold" ? store.getChild(child.id) : undefined);
      expect(store.getChild(child.id)).toMatchObject({ state: "cold", sessionFile });
      expect(warm.disposed).toBe(true);
      expect(stateOf(lifecycle, child.id)).toMatchObject({ phase: "cold", receiptWanted: false });
      assertActiveInvariant(lifecycle, store);

      clock = new Date(clock.getTime() + 86_400_000);
      lifecycle.sweep(clock);
      expect(store.getChild(child.id)).toMatchObject({ state: "terminated", terminalSummary: "idle_timeout" });
      expect(store.listLiveChildren().some((entry) => entry.id === child.id)).toBe(false);
      expect(receipts).toHaveLength(1);
      assertActiveInvariant(lifecycle, store);
    } finally {
      await lifecycle.stop();
      store.close();
    }
  });

  test("queues cold resume without blocking, coalesces nudges, and resumes the persisted session file", async () => {
    const { root, store } = createStore();
    let clock = new Date("2026-01-01T00:00:00.000Z");
    const sessionFile = join(root, "resumable.jsonl");
    writeFileSync(sessionFile, "conversation");
    const receipts: ReceiptRecord[] = [];
    const conversation = new FakeConversationRunner({ sessionFile });
    const lifecycle = new ChildLifecycle({
      registry: new ChildRegistry(store, { now: () => clock }),
      journal: new TerminalJournal(join(root, "journal")),
      runner: { name: "daemon", run: async () => ({ state: "completed", summary: "daemon" }) },
      conversation,
      warmTtlMs: 1,
      onReceipt: (receipt) => { receipts.push(receipt); },
      now: () => clock,
    });

    try {
      const child = lifecycle.delegate({ title: "resume", prompt: "initial" });
      const warm = await waitFor(() => conversation.conversation(child.id));
      await waitFor(() => warm.turns[0]);
      warm.complete("initial answer");
      await waitFor(() => store.getChild(child.id)?.state === "idle" ? store.getChild(child.id) : undefined);
      clock = new Date(clock.getTime() + 1);
      lifecycle.sweep(clock);
      await waitFor(() => store.getChild(child.id)?.state === "cold" ? store.getChild(child.id) : undefined);

      const gate = new Deferred<void>();
      conversation.openGate = gate;
      const startedAt = Date.now();
      expect(lifecycle.nudge(child.id, "resume one", { receipt: false })).toEqual({ status: "cold", queued: true });
      expect(Date.now() - startedAt).toBeLessThan(50);
      await waitFor(() => conversation.opens.length === 2 ? conversation.opens[1] : undefined);
      expect(store.getChild(child.id)?.state).toBe("running");
      assertActiveInvariant(lifecycle, store);
      expect(lifecycle.nudge(child.id, "resume two", { receipt: true })).toEqual({ status: "queued" });
      gate.resolve();
      const resumed = await waitFor(() => {
        const candidate = conversation.conversation(child.id);
        return candidate && candidate !== warm ? candidate : undefined;
      });
      await waitFor(() => resumed.turns[0]);
      expect(conversation.opens[1]).toMatchObject({ childId: child.id, sessionFile });
      expect(resumed.turns[0]?.prompt).toBe("resume one\n\nresume two");
      resumed.complete("resumed answer");
      await waitFor(() => store.getChild(child.id)?.state === "idle" && store.getChild(child.id)?.turnSeq === 2 ? store.getChild(child.id) : undefined);
      expect(receipts).toHaveLength(2);
      expect(receipts.at(-1)?.idempotencyKey).toBe(`child-turn:${child.id}:2`);
      assertActiveInvariant(lifecycle, store);
    } finally {
      await lifecycle.stop();
      store.close();
    }
  });

  test("publishes a resume_failed receipt when a cold session cannot be opened", async () => {
    const { root, store } = createStore();
    let clock = new Date("2026-01-01T00:00:00.000Z");
    const sessionFile = join(root, "broken-resume.jsonl");
    writeFileSync(sessionFile, "conversation");
    const receipts: ReceiptRecord[] = [];
    const conversation = new FakeConversationRunner({ sessionFile });
    const lifecycle = new ChildLifecycle({
      registry: new ChildRegistry(store, { now: () => clock }),
      journal: new TerminalJournal(join(root, "journal")),
      runner: { name: "daemon", run: async () => ({ state: "completed", summary: "daemon" }) },
      conversation,
      warmTtlMs: 1,
      onReceipt: (receipt) => { receipts.push(receipt); },
      now: () => clock,
    });

    try {
      const child = lifecycle.delegate({ title: "broken resume", prompt: "initial" });
      const warm = await waitFor(() => conversation.conversation(child.id));
      await waitFor(() => warm.turns[0]);
      warm.complete("initial answer");
      await waitFor(() => store.getChild(child.id)?.state === "idle" ? store.getChild(child.id) : undefined);
      clock = new Date(clock.getTime() + 1);
      lifecycle.sweep(clock);
      await waitFor(() => store.getChild(child.id)?.state === "cold" ? store.getChild(child.id) : undefined);

      rmSync(sessionFile);
      expect(lifecycle.nudge(child.id, "resume", { receipt: false })).toEqual({ status: "cold", queued: true });
      await waitFor(() => store.getChild(child.id)?.state === "failed" ? store.getChild(child.id) : undefined);
      expect(store.getChild(child.id)).toMatchObject({ state: "failed", errorCode: "resume_failed" });
      expect(receipts.at(-1)).toMatchObject({ childId: child.id, state: "persisted" });
      assertActiveInvariant(lifecycle, store);
    } finally {
      await lifecycle.stop();
      store.close();
    }
  });

  test("evicts the oldest dormant child at the live cap and rejects admission when no child is evictable", async () => {
    const { root, store } = createStore();
    let clock = new Date("2026-01-01T00:00:00.000Z");
    const events: Array<{ readonly event: string; readonly fields: Record<string, unknown> }> = [];
    const conversation = new FakeConversationRunner();
    const lifecycle = new ChildLifecycle({
      registry: new ChildRegistry(store, { now: () => clock }),
      journal: new TerminalJournal(join(root, "journal")),
      runner: { name: "daemon", run: async () => ({ state: "completed", summary: "daemon" }) },
      conversation,
      maxConcurrent: 2,
      maxLive: 2,
      now: () => clock,
      onEvent: (event, fields) => events.push({ event, fields }),
    });

    try {
      const oldest = lifecycle.delegate({ title: "oldest", prompt: "one" });
      const oldestConversation = await waitFor(() => conversation.conversation(oldest.id));
      await waitFor(() => oldestConversation.turns[0]);
      oldestConversation.complete("one");
      await waitFor(() => store.getChild(oldest.id)?.state === "idle" ? store.getChild(oldest.id) : undefined);
      clock = new Date(clock.getTime() + 1);
      const newest = lifecycle.delegate({ title: "newest", prompt: "two" });
      const newestConversation = await waitFor(() => conversation.conversation(newest.id));
      await waitFor(() => newestConversation.turns[0]);
      newestConversation.complete("two");
      await waitFor(() => store.getChild(newest.id)?.state === "idle" ? store.getChild(newest.id) : undefined);

      const replacement = lifecycle.delegate({ title: "replacement", prompt: "three" });
      expect(store.getChild(oldest.id)).toMatchObject({ state: "terminated", terminalSummary: "evicted" });
      expect(store.getChild(replacement.id)?.state).toBe("admitted");
      expect(events).toContainEqual(expect.objectContaining({ event: "child_evicted", fields: expect.objectContaining({ childId: oldest.id, kind: "task_tool", origin: "owner" }) }));
      assertActiveInvariant(lifecycle, store);
    } finally {
      await lifecycle.stop();
      store.close();
    }

    const blocked = createStore();
    const runningConversation = new FakeConversationRunner();
    const blockedLifecycle = new ChildLifecycle({
      registry: new ChildRegistry(blocked.store),
      journal: new TerminalJournal(join(blocked.root, "journal")),
      runner: { name: "daemon", run: async () => ({ state: "completed", summary: "daemon" }) },
      conversation: runningConversation,
      maxConcurrent: 2,
      maxLive: 2,
    });
    try {
      const first = blockedLifecycle.delegate({ title: "running one", prompt: "one" });
      const second = blockedLifecycle.delegate({ title: "running two", prompt: "two" });
      await waitFor(() => runningConversation.conversation(first.id));
      await waitFor(() => runningConversation.conversation(second.id));
      let error: unknown;
      try {
        blockedLifecycle.delegate({ title: "blocked", prompt: "three" });
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ message: "child_cap_reached", code: "child_cap_reached" });
      assertActiveInvariant(blockedLifecycle, blocked.store);
    } finally {
      await blockedLifecycle.stop();
      blocked.store.close();
    }
  });
});
