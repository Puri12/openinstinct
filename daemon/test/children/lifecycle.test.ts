import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChildLifecycle } from "../../src/children/lifecycle.ts";
import { ChildRegistry } from "../../src/children/registry.ts";
import type { ChildRunner } from "../../src/children/runner.ts";
import { TerminalJournal } from "../../src/children/terminal-journal.ts";
import { openStateStore, type ReceiptRecord, type StateStore } from "../../src/store/index.ts";
import { FakeConversationRunner } from "./fakes.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function waitFor<T>(read: () => T | undefined, timeoutMs = 1_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for child lifecycle");
    }
    await Bun.sleep(5);
  }
}

function createStore(): { readonly store: StateStore; readonly root: string } {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-child-lifecycle-"));
  directories.push(root);
  return { root, store: openStateStore(join(root, "state.db")) };
}

describe("ChildLifecycle", () => {
  test("persists the first conversational result as an idle turn receipt", async () => {
    const { store, root } = createStore();
    const journal = new TerminalJournal(join(root, "journal"));
    const registry = new ChildRegistry(store, { now: () => new Date("2026-01-01T00:00:00.000Z") });
    const conversation = new FakeConversationRunner({ sessionFile: "/tmp/child.jsonl" });
    const daemonRunner: ChildRunner = { name: "daemon", run: async () => ({ state: "completed", summary: "daemon" }) };
    const receipts: ReceiptRecord[] = [];
    const lifecycle = new ChildLifecycle({
      registry,
      journal,
      runner: daemonRunner,
      conversation,
      now: () => new Date("2026-01-01T00:00:01.000Z"),
      onReceipt: (receipt) => { receipts.push(receipt); },
    });

    try {
      const child = lifecycle.delegate({ title: "Research", prompt: "Return CHILD_RESULT", timeoutMs: 1_000 });
      const fake = await waitFor(() => conversation.conversation(child.id));
      fake.complete("CHILD_RESULT");
      const receipt = await waitFor(() => receipts[0]);

      expect(store.getChild(child.id)).toMatchObject({
        state: "idle",
        lastAssistantText: "CHILD_RESULT",
        sessionFile: "/tmp/child.jsonl",
        turnSeq: 1,
      });
      expect(store.getReceipt(receipt.id)).toMatchObject({ state: "persisted", childId: child.id, idempotencyKey: `child-turn:${child.id}:1` });
      expect(store.getReceipt(receipt.id)?.projection).toContain("update: CHILD_RESULT");
      expect(lifecycle.activeCount).toBe(0);
    } finally {
      await lifecycle.stop();
      store.close();
    }
  });

  test("lets a child exceed its idle duration while progress keeps arriving", async () => {
    const { store, root } = createStore();
    const timeoutMs = 50;
    const runner: ChildRunner = {
      name: "progressing",
      run: async (request, signal) => {
        for (let index = 0; index < 6; index += 1) {
          await Bun.sleep(15);
          if (signal.aborted) {
            return { state: "cancelled", summary: "cancelled" };
          }
          request.onProgress?.({ toolCalls: index + 1 });
        }
        return { state: "completed", summary: "progressed" };
      },
    };
    const lifecycle = new ChildLifecycle({
      registry: new ChildRegistry(store),
      journal: new TerminalJournal(join(root, "journal")),
      runner,
      conversation: new FakeConversationRunner(),
    });

    try {
      const child = lifecycle.spawnDaemon({ title: "Progress", prompt: "progress", timeoutMs, origin: "monitor" });
      const terminal = await waitFor(() => {
        const current = store.getChild(child.id);
        return current && ["completed", "failed", "timeout", "cancelled", "orphaned"].includes(current.state)
          ? current
          : undefined;
      });

      expect(terminal).toMatchObject({ state: "completed", terminalSummary: "progressed" });
    } finally {
      await lifecycle.stop();
      store.close();
    }
  });

  test("times out only after a progressing child becomes idle", async () => {
    const { store, root } = createStore();
    const timeoutMs = 50;
    let progressAt = 0;
    const runner: ChildRunner = {
      name: "silent-after-progress",
      run: async (request, signal) => {
        await Bun.sleep(15);
        request.onProgress?.({ toolCalls: 1 });
        progressAt = Date.now();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { state: "cancelled", summary: "cancelled" };
      },
    };
    const lifecycle = new ChildLifecycle({
      registry: new ChildRegistry(store),
      journal: new TerminalJournal(join(root, "journal")),
      runner,
      conversation: new FakeConversationRunner(),
    });

    try {
      const child = lifecycle.spawnDaemon({ title: "Idle", prompt: "idle", timeoutMs, origin: "monitor" });
      const terminal = await waitFor(() => {
        const current = store.getChild(child.id);
        return current && ["completed", "failed", "timeout", "cancelled", "orphaned"].includes(current.state)
          ? current
          : undefined;
      });

      expect(terminal).toMatchObject({ state: "timeout", errorCode: "child_timeout" });
      expect(terminal.terminalSummary).toContain("inactivity timeout");
      expect(Date.now() - progressAt).toBeGreaterThanOrEqual(timeoutMs - 5);
    } finally {
      await lifecycle.stop();
      store.close();
    }
  });
  test("does not start a runner after synchronous running-event cancellation", async () => {
    const { store, root } = createStore();
    let runCalls = 0;
    const runner: ChildRunner = {
      name: "must-not-start",
      run: async () => {
        runCalls += 1;
        return { state: "completed", summary: "unexpected" };
      },
    };
    let lifecycle: ChildLifecycle;
    lifecycle = new ChildLifecycle({
      registry: new ChildRegistry(store),
      journal: new TerminalJournal(join(root, "journal")),
      runner,
      conversation: new FakeConversationRunner(),
      onEvent: (event, fields) => {
        if (event === "running") {
          void lifecycle.cancel(fields.childId as string);
        }
      },
    });

    try {
      const child = lifecycle.delegate({ title: "Cancel before runner", prompt: "unused", timeoutMs: 50 });
      const terminal = await waitFor(() => {
        const current = store.getChild(child.id);
        return current && ["completed", "failed", "timeout", "cancelled", "orphaned"].includes(current.state)
          ? current
          : undefined;
      });

      expect(terminal).toMatchObject({ state: "cancelled", errorCode: "cancelled" });
      expect(runCalls).toBe(0);
    } finally {
      await lifecycle.stop();
      store.close();
    }
  });
});
