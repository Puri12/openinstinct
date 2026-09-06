import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChildLifecycle } from "../../src/children/lifecycle.ts";
import { ChildRegistry } from "../../src/children/registry.ts";
import type { ChildRunner } from "../../src/children/runner.ts";
import { createTerminalReport, TerminalJournal } from "../../src/children/terminal-journal.ts";
import { openStateStore, type ChildRecord, type StateStore } from "../../src/store/index.ts";
import { FakeConversationRunner } from "./fakes.ts";

export interface RunnerContractAdapter {
  readonly name: string;
  create(root: string): ChildRunner;
}

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

export function registerRunnerContract(adapter: RunnerContractAdapter): void {
  describe(`${adapter.name} ChildRunner contract`, () => {
    test("returns a typed cancellation result after AbortSignal cancellation", async () => {
      const root = createRoot();
      const runner = adapter.create(root);
      const controller = new AbortController();
      const result = runner.run({ childId: "cancel-child", title: "Cancel", prompt: "HANG" }, controller.signal);

      await Bun.sleep(15);
      controller.abort();

      await expect(result).resolves.toMatchObject({ state: "cancelled", errorCode: "cancelled" });
    });

    test("lifecycle converts a deadline into a timeout receipt", async () => {
      const { root, store } = createStore();
      const lifecycle = createLifecycle(adapter.create(root), root, store);
      try {
        const child = lifecycle.spawnDaemon({ title: "Timeout", prompt: "HANG", origin: "monitor", timeoutMs: 20 });
        const terminal = await waitForTerminal(store, child.id);

        expect(terminal).toMatchObject({ state: "timeout", errorCode: "child_timeout" });
        expect(store.listPersistedReceipts()).toHaveLength(1);
      } finally {
        await lifecycle.stop();
        store.close();
      }
    });

    test("turns an adapter crash into a failed terminal receipt", async () => {
      const { root, store } = createStore();
      const lifecycle = createLifecycle(adapter.create(root), root, store);
      try {
        const child = lifecycle.spawnDaemon({ title: "Crash", prompt: "CRASH", origin: "monitor", timeoutMs: 1_000 });
        const terminal = await waitForTerminal(store, child.id);
        const [receipt] = store.listPersistedReceipts();

        expect(terminal.state).toBe("failed");
        expect(receipt).toMatchObject({ childId: child.id, state: "persisted" });
        expect(new TextEncoder().encode(receipt!.projection).byteLength).toBeLessThanOrEqual(1_024);
        expect(receipt!.contentHash).toMatch(/^[a-f0-9]{64}$/);
      } finally {
        await lifecycle.stop();
        store.close();
      }
    });

    test("publishes a bounded completed receipt with journal evidence", async () => {
      const { root, store } = createStore();
      const lifecycle = createLifecycle(adapter.create(root), root, store);
      try {
        const child = lifecycle.spawnDaemon({ title: "Complete", prompt: "COMPLETE", origin: "monitor", timeoutMs: 1_000 });
        const terminal = await waitForTerminal(store, child.id);
        const [receipt] = store.listPersistedReceipts();

        expect(terminal).toMatchObject({ state: "completed" });
        expect(receipt).toMatchObject({ childId: child.id, state: "persisted" });
        expect(new TextEncoder().encode(receipt!.projection).byteLength).toBeLessThanOrEqual(1_024);
        expect(receipt!.artifactPath).toContain(`${child.id}.json`);
      } finally {
        await lifecycle.stop();
        store.close();
      }
    });

    test("publishes journal evidence before receipt admission and recovers the crash seam exactly once", async () => {
      const { root, store } = createStore();
      const journal = new TerminalJournal(join(root, "journal"));
      const registry = new ChildRegistry(store);
      const child = registry.register({
        kind: "task_tool",
        priority: "conversational",
        title: "Crash seam",
        origin: "owner",
        prompt: "COMPLETE",
        timeoutMs: 1_000,
      });
      registry.markAdmitted(child.id);
      registry.markRunning(child.id);
      const report = createTerminalReport({
        childId: child.id,
        title: child.title,
        state: "completed",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:01.000Z",
        summary: "journal-only result",
      });
      journal.writeTerminal(report);
      const lifecycle = new ChildLifecycle({ registry, journal, runner: adapter.create(root), conversation: new FakeConversationRunner() });

      try {
        expect(store.listPersistedReceipts()).toHaveLength(0);
        await lifecycle.reconcile();
        const first = lifecycle.recoverTerminal(child.id);
        const second = lifecycle.recoverTerminal(child.id);

        expect(first?.child).toMatchObject({ state: "completed", terminalChecksum: report.checksum });
        expect(second?.receipt.id).toBe(first?.receipt.id);
        expect(journal.recoverTerminal(child.id)).toEqual(report);
        expect(store.listPersistedReceipts()).toHaveLength(1);
      } finally {
        await lifecycle.stop();
        store.close();
      }
    });
  });
}

function createLifecycle(runner: ChildRunner, root: string, store: StateStore): ChildLifecycle {
  return new ChildLifecycle({
    registry: new ChildRegistry(store),
    journal: new TerminalJournal(join(root, "journal")),
    runner,
    conversation: new FakeConversationRunner(),
  });
}

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-runner-contract-"));
  directories.push(root);
  return root;
}

function createStore(): { readonly root: string; readonly store: StateStore } {
  const root = createRoot();
  return { root, store: openStateStore(join(root, "state.db")) };
}

async function waitForTerminal(store: StateStore, childId: string, timeoutMs = 2_000): Promise<ChildRecord> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const child = store.getChild(childId);
    if (child && ["completed", "failed", "timeout", "cancelled", "orphaned"].includes(child.state)) {
      return child;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for terminal child ${childId}`);
    }
    await Bun.sleep(5);
  }
}
