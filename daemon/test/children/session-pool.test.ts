import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChildRegistry } from "../../src/children/registry.ts";
import { ChildSessionPool } from "../../src/children/session-pool.ts";
import { openStateStore } from "../../src/store/index.ts";
import { FakeConversationRunner } from "./fakes.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ChildSessionPool", () => {
  test("binds a warm object to a generation and ignores stale disposal", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-session-pool-"));
    directories.push(root);
    const store = openStateStore(join(root, "state.db"));
    const child = new ChildRegistry(store).register({
      kind: "task_tool",
      priority: "conversational",
      origin: "owner",
      title: "pool task",
      prompt: "work",
      timeoutMs: 1_000,
    });
    const runner = new FakeConversationRunner({ promptHash: "a".repeat(64) });
    const events: Array<{ readonly event: string; readonly fields: Record<string, unknown> }> = [];
    const pool = new ChildSessionPool({ runner, onEvent: (event, fields) => events.push({ event, fields }) });

    try {
      const first = await pool.open(child, new AbortController().signal);
      expect(events).toContainEqual(expect.objectContaining({ event: "child_session_opened", fields: expect.objectContaining({ promptHash: "a".repeat(64) }) }));
      const second = await pool.open(child, new AbortController().signal);
      expect(second).toBe(first);
      await pool.dispose(child.id, first.generation + 1);
      expect(pool.get(child.id)).toBe(first);
      expect(runner.conversation(child.id)?.disposed).toBe(false);
      await pool.dispose(child.id, first.generation);
      expect(pool.get(child.id)).toBeUndefined();
      expect(runner.conversation(child.id)?.disposed).toBe(true);

      const reopened = await pool.open(child, new AbortController().signal);
      expect(reopened.generation).toBeGreaterThan(first.generation);
      await pool.disposeAll();
      expect(pool.get(child.id)).toBeUndefined();
    } finally {
      store.close();
    }
  });
  test("forwards child-bound report admission only when opening a conversational session", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-session-pool-report-"));
    directories.push(root);
    const store = openStateStore(join(root, "state.db"));
    const child = new ChildRegistry(store).register({
      kind: "task_tool",
      priority: "conversational",
      origin: "owner",
      title: "report task",
      prompt: "work",
      timeoutMs: 1_000,
    });
    const runner = new FakeConversationRunner();
    const reports: Array<{ readonly childId: string; readonly title: string; readonly text: string; readonly toolCallId: string }> = [];
    const pool = new ChildSessionPool({
      runner,
      onReport: ({ childId, title, report }) => {
        reports.push({ childId, title, ...report });
        return { accepted: true };
      },
    });
    try {
      await pool.open(child, new AbortController().signal);
      expect(runner.opens[0]?.onReport?.({ text: "finding", toolCallId: "call-1" })).toEqual({ accepted: true });
      expect(reports).toEqual([{ childId: child.id, title: "report task", text: "finding", toolCallId: "call-1" }]);
    } finally {
      await pool.disposeAll();
      store.close();
    }
  });

});
