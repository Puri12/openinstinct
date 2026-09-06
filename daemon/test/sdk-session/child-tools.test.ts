import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StateStoreChildStatusReader } from "../../src/children/status.ts";
import {
  createChildNudgeTool,
  createChildStatusTool,
} from "../../src/sdk-session/main-session.ts";
import { openStateStore, type StateStore } from "../../src/store/index.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore(): StateStore {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-child-tools-"));
  directories.push(root);
  return openStateStore(join(root, "state.db"));
}

async function execute(tool: any, params: unknown): Promise<any> {
  return await tool.execute("tool-call", params, undefined, {});
}

function createLiveChild(store: StateStore, id: string, at: string): void {
  store.createChild({
    id,
    kind: "task_tool",
    priority: "conversational",
    origin: "owner",
    title: `Task ${id}`,
    prompt: "work",
    timeoutMs: 1_000,
  }, at);
  store.markChildRunning(id, at);
}

describe("child_nudge tool", () => {
  test("returns exact synchronous outcomes, defaults receipt false, and emits the guard event", async () => {
    const events: Array<{ readonly event: string; readonly fields: Record<string, unknown> }> = [];
    const calls: string[] = [];
    const tool = createChildNudgeTool({
      nudge: (childId, text, input) => {
        calls.push(`${childId}:${text}:${input.receipt}`);
        return { status: "steered" };
      },
      release: (childId) => {
        calls.push(`${childId}:release`);
        return { status: "released" };
      },
      onEvent: (event, fields) => events.push({ event, fields }),
    });

    const nudge = await execute(tool as never, { childId: "child-1", op: "nudge", text: "  continue  " });
    const release = await execute(tool as never, { childId: "child-1", op: "release", receipt: true });

    expect((tool.parameters as any).safeParse({ childId: "x", op: "nudge", text: "hi", unexpected: true }).success).toBe(false);
    expect(calls).toEqual(["child-1:continue:false", "child-1:release"]);
    expect(nudge).toEqual({
      content: [{ type: "text", text: "Nudge delivered into the running task child-1." }],
      details: { childId: "child-1", op: "nudge", status: "steered", queued: false, receipt: false },
    });
    expect(release).toEqual({
      content: [{ type: "text", text: "Task child-1 released." }],
      details: { childId: "child-1", op: "release", status: "released", queued: false, receipt: true },
    });
    await Bun.sleep(1);
    expect(events).toHaveLength(2);
    expect(events.every(({ event, fields }) => event === "child_tool_latency_alert" && fields.tool === "child_nudge" && typeof fields.ms === "number")).toBe(true);
  });


  test("uses the fixed text for queued, cold, started, and cancelling outcomes", async () => {
    const cases = [
      { status: "started" as const, text: "Task child woke up and is working on it." },
      { status: "queued" as const, text: "Nudge queued for task child; it runs next." },
      { status: "cold" as const, text: "Task child is asleep; nudge queued, it resumes in the background." },
    ];
    for (const expected of cases) {
      const tool = createChildNudgeTool({
        nudge: () => expected.status === "cold" ? { status: "cold", queued: true } : { status: expected.status },
        release: () => ({ status: "cancelling" }),
      });
      const result = await execute(tool as never, { childId: "child", op: "nudge", text: "go" });
      expect(result.content[0].text).toBe(expected.text);
      expect(result.details.queued).toBe(expected.status === "queued" || expected.status === "cold");
    }
    const releaseTool = createChildNudgeTool({ nudge: () => ({ status: "steered" }), release: () => ({ status: "cancelling" }) });
    await expect(execute(releaseTool as never, { childId: "child", op: "release" })).resolves.toMatchObject({
      content: [{ type: "text", text: "Task child is being cancelled; its receipt will follow." }],
      details: { status: "cancelling", queued: false },
    });
  });
  test("preserves fixed nudge errors", async () => {
    const tool = createChildNudgeTool({
      nudge: (childId) => {
        throw new Error(`child_not_live: ${childId} is terminated`);
      },
      release: (childId) => {
        throw new Error(`child_not_found: ${childId}`);
      },
    });

    await expect(execute(tool as never, { childId: "missing", op: "release" })).rejects.toThrow("child_not_found: missing");
    await expect(execute(tool as never, { childId: "dead", op: "nudge", text: "hi" })).rejects.toThrow("child_not_live: dead is terminated");
    await expect(execute(tool as never, { childId: "child", op: "nudge", text: "   " })).rejects.toThrow("nudge_text_required");
  });
});

describe("child_status tool", () => {
  test("returns a bounded detail and projects terminal state without touching SDK state", async () => {
    const store = createStore();
    const at = "2026-01-01T00:00:00.000Z";
    createLiveChild(store, "detail-child", at);
    store.markChildIdle("detail-child", {
      sessionFile: "/tmp/detail-child.jsonl",
      lastAssistantText: "🧪".repeat(300),
      turnSeq: 1,
    }, "2026-01-01T00:00:01.000Z");
    const reader = new StateStoreChildStatusReader(store);
    const tool = createChildStatusTool({ reader, statusTextMaxBytes: 512 });

    try {
      const result = await execute(tool as never, { childId: "detail-child" });
      expect(result.details).toMatchObject({
        childId: "detail-child",
        title: "Task detail-child",
        state: "idle",
        createdAt: at,
        lastActivityAt: "2026-01-01T00:00:01.000Z",
        toolCalls: 0,
        turnSeq: 1,
      });
      expect(new TextEncoder().encode(result.details.lastAssistantText).byteLength).toBeLessThanOrEqual(512);
      expect(result.details.lastAssistantText.endsWith("…")).toBe(true);
      store.markChildTerminated("detail-child", "released", "2026-01-01T00:00:02.000Z");
      reader.refresh();
      const terminal = await execute(tool as never, { childId: "detail-child" });
      expect(terminal.details).toMatchObject({ state: "terminated", terminalState: "terminated", terminalReason: "released" });
      await expect(execute(tool as never, { childId: "missing" })).rejects.toThrow("child_not_found: missing");
    } finally {
      store.close();
    }
  });

  test("lists at most twenty live children ordered by last activity", async () => {
    const store = createStore();
    const reader = new StateStoreChildStatusReader(store);
    const tool = createChildStatusTool({ reader, statusListLimit: 20 });
    try {
      for (let index = 0; index < 25; index += 1) {
        createLiveChild(store, `child-${index}`, `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`);
      }
      reader.refresh();
      const result = await execute(tool as never, {});
      expect(result.details.total).toBe(25);
      expect(result.details.truncated).toBe(true);
      expect(result.details.children).toHaveLength(20);
      expect(result.details.children[0]).toMatchObject({ childId: "child-24", state: "running" });
      expect(result.details.children.at(-1)).toMatchObject({ childId: "child-5" });
      expect(result.details.children.some((child: { readonly lastAssistantText?: string }) => child.lastAssistantText !== undefined)).toBe(false);
    } finally {
      store.close();
    }
  });
  test("uses the cached status snapshot without store reads during execution", async () => {
    const store = createStore();
    createLiveChild(store, "cached-child", "2026-01-01T00:00:00.000Z");
    const reader = new StateStoreChildStatusReader(store);
    (store as any).getChild = () => { throw new Error("unexpected status store read"); };
    (store as any).listLiveChildren = () => { throw new Error("unexpected status store read"); };
    (store as any).countLiveChildren = () => { throw new Error("unexpected status store read"); };
    const tool = createChildStatusTool({ reader });
    try {
      await expect(execute(tool as never, { childId: "cached-child" })).resolves.toMatchObject({ details: { childId: "cached-child", state: "running" } });
      await expect(execute(tool as never, {})).resolves.toMatchObject({ details: { total: 1, truncated: false } });
    } finally {
      store.close();
    }
  });
  test("queues latency alerts after tool result resolution", async () => {
    let logged = false;
    const tool = createChildStatusTool({
      reader: { getChild: () => undefined, listLiveChildren: () => [], countLiveChildren: () => 0 },
      latencyAlertMs: 5,
      onEvent: () => {
        const until = performance.now() + 25;
        while (performance.now() < until) {}
        logged = true;
      },
    });
    const result = await execute(tool as never, {});
    expect(result.details.total).toBe(0);
    expect(logged).toBe(false);
    await Bun.sleep(5);
    expect(logged).toBe(true);
  });
});
