import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChildLifecycle } from "../../src/children/lifecycle.ts";
import { ChildRegistry } from "../../src/children/registry.ts";
import type { ChildRunResult, ChildRunner } from "../../src/children/runner.ts";
import { TerminalJournal } from "../../src/children/terminal-journal.ts";
import { openStateStore, type ChildRecord, type StateStore } from "../../src/store/index.ts";
import { Deferred, FakeConversationRunner } from "./fakes.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class BlockingRunner implements ChildRunner {
  public readonly name = "blocking";
  public readonly calls: Array<{ readonly title: string; readonly childId: string }> = [];
  private readonly gates = new Map<string, Deferred<ChildRunResult>>();

  public run(request: { readonly childId: string; readonly title: string }, signal: AbortSignal): Promise<ChildRunResult> {
    this.calls.push(request);
    const gate = new Deferred<ChildRunResult>();
    this.gates.set(request.childId, gate);
    signal.addEventListener("abort", () => gate.resolve({ state: "cancelled", summary: "cancelled by test", errorCode: "cancelled" }), { once: true });
    return gate.promise;
  }

  public complete(childId: string): void {
    this.gates.get(childId)?.resolve({ state: "completed", summary: `done ${childId}` });
  }
}

function createStore(): { readonly root: string; readonly store: StateStore } {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-lifecycle-hardening-"));
  directories.push(root);
  return { root, store: openStateStore(join(root, "state.db")) };
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 1_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("timed out waiting for lifecycle state");
    await Bun.sleep(5);
  }
}

async function waitForState(store: StateStore, childId: string, state: ChildRecord["state"]): Promise<ChildRecord> {
  return waitFor(() => {
    const child = store.getChild(childId);
    return child?.state === state ? child : undefined;
  });
}

describe("ChildLifecycle scheduling and recovery", () => {
  test("enforces the concurrency cap while preferring monitor FIFO over conversational backlog", async () => {
    const { root, store } = createStore();
    const daemon = new BlockingRunner();
    const conversation = new FakeConversationRunner();
    const lifecycle = new ChildLifecycle({
      registry: new ChildRegistry(store),
      journal: new TerminalJournal(join(root, "journal")),
      runner: daemon,
      conversation,
      maxConcurrent: 1,
    });

    try {
      const first = lifecycle.delegate({ title: "conversation-1", prompt: "one" });
      const firstConversation = await waitFor(() => conversation.conversation(first.id));
      const second = lifecycle.delegate({ title: "conversation-2", prompt: "two" });
      const monitor = lifecycle.spawnDaemon({ title: "monitor-1", prompt: "three", origin: "monitor" });

      expect(lifecycle.activeCount).toBe(1);
      expect(lifecycle.queuedCount).toBe(2);
      expect(daemon.calls).toEqual([]);
      expect(store.getChild(second.id)?.state).toBe("admitted");
      expect(store.getChild(monitor.id)?.priority).toBe("monitor");

      firstConversation.complete();
      await waitFor(() => daemon.calls[0]);
      expect(daemon.calls.map((call) => call.title)).toEqual(["monitor-1"]);

      daemon.complete(monitor.id);
      const secondConversation = await waitFor(() => conversation.conversation(second.id));
      secondConversation.complete();
      await waitForState(store, second.id, "idle");
    } finally {
      await lifecycle.stop();
      store.close();
    }
  });

  test("releases a queued conversational child without starting a runner or receipt", async () => {
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
      const active = lifecycle.delegate({ title: "active", prompt: "one" });
      await waitFor(() => conversation.conversation(active.id));
      const queued = lifecycle.delegate({ title: "queued", prompt: "two" });
      expect(lifecycle.release(queued.id)).toEqual({ status: "released" });
      await waitForState(store, queued.id, "terminated");
      expect(store.getChild(queued.id)).toMatchObject({ state: "terminated", terminalSummary: "released" });
      expect(conversation.conversation(queued.id)).toBeUndefined();
      expect(store.listPersistedReceipts()).toHaveLength(0);
    } finally {
      await lifecycle.stop();
      store.close();
    }
  });

  test("routes daemon children through the one-shot daemon runner while task-tool children stay conversational", async () => {
    const { root, store } = createStore();
    const taskCalls: string[] = [];
    const daemonCalls: string[] = [];
    const conversation = new FakeConversationRunner({ autoResult: { state: "completed", text: "task complete" } });
    const daemonRunner: ChildRunner = {
      name: "daemon-runner",
      run: async (request) => {
        daemonCalls.push(request.childId);
        return { state: "completed", summary: "daemon complete" };
      },
    };
    const lifecycle = new ChildLifecycle({
      registry: new ChildRegistry(store),
      journal: new TerminalJournal(join(root, "journal")),
      runner: daemonRunner,
      daemonRunner,
      conversation,
      onReceipt: (receipt) => { taskCalls.push(receipt.childId); },
    });

    try {
      const task = lifecycle.delegate({ title: "task", prompt: "task" });
      const daemon = lifecycle.spawnDaemon({ title: "daemon", prompt: "daemon", origin: "monitor" });
      await waitForState(store, task.id, "idle");
      await waitForState(store, daemon.id, "completed");
      expect(conversation.conversation(task.id)).toBeDefined();
      expect(daemonCalls).toEqual([daemon.id]);
      expect(taskCalls).toContain(task.id);
    } finally {
      await lifecycle.stop();
      store.close();
    }
  });

  test("requeues admitted work and admits an orphan receipt for an unprovable running daemon", async () => {
    const { root, store } = createStore();
    const registry = new ChildRegistry(store);
    const admitted = registry.register({
      kind: "task_tool",
      priority: "conversational",
      origin: "owner",
      title: "queued before crash",
      prompt: "queued",
      timeoutMs: 1_000,
    });
    registry.markAdmitted(admitted.id);
    const running = registry.register({
      kind: "daemon",
      priority: "monitor",
      origin: "monitor",
      title: "running before crash",
      prompt: "running",
      timeoutMs: 1_000,
    });
    registry.markAdmitted(running.id);
    registry.markRunning(running.id);
    const lifecycle = new ChildLifecycle({
      registry,
      journal: new TerminalJournal(join(root, "journal")),
      runner: { name: "recovery", run: async () => ({ state: "completed", summary: "daemon" }) },
      conversation: new FakeConversationRunner({ autoResult: { state: "completed", text: "requeued result" } }),
    });

    try {
      await lifecycle.reconcile();
      await waitForState(store, admitted.id, "idle");
      expect(store.getChild(running.id)).toMatchObject({ state: "orphaned", errorCode: "orphaned" });
      expect(store.listPersistedReceipts().some((receipt) => receipt.childId === running.id && receipt.idempotencyKey === `child-orphan:${running.id}`)).toBe(true);
    } finally {
      await lifecycle.stop();
      store.close();
    }
  });

  test("orphans unresumable task-tool children and running task-tool children during boot reconciliation", async () => {
    const { root, store } = createStore();
    const registry = new ChildRegistry(store);
    const running = registry.register({
      kind: "task_tool",
      priority: "conversational",
      origin: "owner",
      title: "running task",
      prompt: "work",
      timeoutMs: 1_000,
    });
    registry.markAdmitted(running.id);
    registry.markRunning(running.id);
    const idle = registry.register({
      kind: "task_tool",
      priority: "conversational",
      origin: "owner",
      title: "missing transcript",
      prompt: "work",
      timeoutMs: 1_000,
    });
    registry.markAdmitted(idle.id);
    registry.markRunning(idle.id);
    registry.markIdle(idle.id, { sessionFile: join(root, "missing.jsonl"), lastAssistantText: "done", turnSeq: 1 });
    const resumablePath = join(root, "resumable.jsonl");
    writeFileSync(resumablePath, "conversation");
    const resumable = registry.register({
      kind: "task_tool",
      priority: "conversational",
      origin: "owner",
      title: "resumable transcript",
      prompt: "work",
      timeoutMs: 1_000,
    });
    registry.markAdmitted(resumable.id);
    registry.markRunning(resumable.id);
    registry.markIdle(resumable.id, { sessionFile: resumablePath, lastAssistantText: "done", turnSeq: 1 });
    const receipts: string[] = [];
    const lifecycle = new ChildLifecycle({
      registry,
      journal: new TerminalJournal(join(root, "journal")),
      runner: { name: "recovery", run: async () => ({ state: "completed", summary: "unused" }) },
      conversation: new FakeConversationRunner(),
      onReceipt: (receipt) => { receipts.push(receipt.childId); },
    });

    try {
      await lifecycle.reconcile();
      expect(store.getChild(running.id)).toMatchObject({ state: "orphaned", errorCode: "orphaned" });
      expect(store.getChild(idle.id)).toMatchObject({ state: "orphaned", errorCode: "orphaned" });
      expect(store.getChild(resumable.id)).toMatchObject({ state: "cold", sessionFile: resumablePath });
      expect(store.listPersistedReceipts().filter((receipt) => receipt.idempotencyKey.startsWith("child-orphan:"))).toHaveLength(2);
      expect(receipts).toEqual(expect.arrayContaining([running.id, idle.id]));
    } finally {
      await lifecycle.stop();
      store.close();
    }
  });
  test("cleans up a daemon row when admission fencing throws and frees the live-cap slot", async () => {
    const { root, store } = createStore();
    const conversation = new FakeConversationRunner();
    const receipts: string[] = [];
    const lifecycle = new ChildLifecycle({
      registry: new ChildRegistry(store),
      journal: new TerminalJournal(join(root, "journal")),
      runner: { name: "daemon", run: async () => ({ state: "completed", summary: "done" }) },
      conversation,
      maxConcurrent: 1,
      maxLive: 1,
      onReceipt: (receipt) => { receipts.push(receipt.childId); },
    });
    try {
      expect(() => lifecycle.spawnDaemon({
        title: "fenced",
        prompt: "work",
        origin: "monitor",
        onAdmitted: () => { throw new Error("dispatch_fence_lost"); },
      })).toThrow("dispatch_fence_lost");
      const failed = store.listChildren()[0]!;
      expect(failed).toMatchObject({ state: "cancelled", errorCode: "child_admission_failed" });
      expect(store.countLiveChildren()).toBe(0);
      expect(receipts).toEqual([failed.id]);
      const replacement = lifecycle.delegate({ title: "replacement", prompt: "work" });
      expect(replacement.id).not.toBe(failed.id);
    } finally {
      await lifecycle.stop();
      store.close();
    }
  });
});
