import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineTool } from "@code-yeongyu/senpi";

import {
  childSystemPrompt,
  hashPrompt,
  OmoChildSessionFactory,
  OmoInProcessRunner,
  type ChildAgentSession,
  type ChildSessionFactory,
} from "../../src/children/runners/omo-inprocess.ts";
import { ensureOmoAgentDir } from "../../src/omo-session/omo-runtime.ts";
import { Type } from "../../src/omo-session/tool-types.ts";

/** Offline provider: session creation and tool listing need a model, never a network call. */
const TEST_PROVIDER = {
  providers: {
    "oi-test": {
      name: "OI Test",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "test-key",
      api: "openai-completions",
      models: [{
        id: "oi-model",
        name: "OI Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8_192,
      }],
    },
  },
};

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class FakeChildSession implements ChildAgentSession {
  public readonly sessionFile = "/tmp/child-session.jsonl";
  public readonly calls: string[] = [];
  public disposed = false;
  private readonly listeners = new Set<(event: unknown) => void>();

  public constructor(private readonly events: readonly unknown[] = [{
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "CHILD_OK" },
  }]) {}

  public async prompt(text: string): Promise<void> {
    this.calls.push(text);
    for (const event of this.events) {
      for (const listener of this.listeners) {
        listener(event);
      }
    }
  }

  public subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
  }
}

/** A private `~/.openinstinct` root whose engine state only knows the offline provider. */
function createOmoRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-child-factory-"));
  directories.push(root);
  writeFileSync(ensureOmoAgentDir(root).modelsJson, JSON.stringify(TEST_PROVIDER), { mode: 0o600 });
  return root;
}

const probeTool = defineTool({
  name: "oi_child_probe",
  label: "OI Child Probe",
  description: "Returns a fixed acknowledgement used to prove custom tool registration.",
  parameters: Type.Object({}, { additionalProperties: false }),
  async execute() {
    return { content: [{ type: "text" as const, text: "probe" }], details: {} };
  },
});

describe("OmoInProcessRunner", () => {
  test("uses an injected child session factory and returns its terminal text", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-omo-child-"));
    directories.push(root);
    const session = new FakeChildSession();
    const factoryCalls: Array<{ readonly childId: string; readonly title: string; readonly workingDirectory: string; readonly sessionDirectory: string; readonly conversational: boolean }> = [];
    const factory: ChildSessionFactory = {
      create: async (input) => {
        factoryCalls.push(input);
        return session;
      },
    };
    const runner = new OmoInProcessRunner({ root, factory });
    let progressEvents = 0;

    const result = await runner.run({
      childId: "child-1",
      title: "Find the answer",
      prompt: "Reply with CHILD_OK",
      onProgress: () => {
        progressEvents += 1;
      },
    }, new AbortController().signal);

    expect(result).toEqual({
      state: "completed",
      summary: "CHILD_OK",
      sessionFile: "/tmp/child-session.jsonl",
    });
    expect(session.calls).toEqual(["Reply with CHILD_OK"]);
    expect(progressEvents).toBe(1);
    expect(session.disposed).toBe(true);
    expect(factoryCalls).toEqual([{
      childId: "child-1",
      title: "Find the answer",
      workingDirectory: join(root, "work", "child-1"),
      sessionDirectory: join(root, "sessions", "child-1"),
      conversational: false,
    }]);
  });

  test("reports omo engine tool lifecycle events as progress heartbeats", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-omo-child-"));
    directories.push(root);
    const session = new FakeChildSession([
      { type: "tool_execution_start" },
      { type: "tool_execution_update" },
      { type: "tool_execution_end" },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "DONE" } },
    ]);
    const runner = new OmoInProcessRunner({
      root,
      factory: { create: async () => session },
    });
    const progress: Array<{ readonly tokens?: number; readonly toolCalls?: number }> = [];

    const result = await runner.run({
      childId: "child-tool-progress",
      title: "Use tools",
      prompt: "finish",
      onProgress: (event) => progress.push(event),
    }, new AbortController().signal);

    expect(result).toMatchObject({ state: "completed", summary: "DONE" });
    expect(progress).toHaveLength(4);
    expect(progress[0]).toMatchObject({ toolCalls: 1 });
  });
});

describe("OmoChildSessionFactory", () => {
  test("gives a conversational child its custom tools, the browser MCP surface, and the conversational prompt", async () => {
    // Given: an isolated engine root and a child asking for one custom tool
    const root = createOmoRoot();
    const factory = new OmoChildSessionFactory("oi-test/oi-model", root);

    // When: the factory creates a conversational child session
    const session = await factory.create({
      childId: "conversational-child",
      title: "Conversational child",
      workingDirectory: join(root, "work"),
      sessionDirectory: join(root, "sessions"),
      conversational: true,
      customTools: [probeTool],
    });

    try {
      // Then: the tool surface carries the custom tool and the enforcer's browser server,
      // the daemon-excluded engine tools stay hidden, and the prompt is the conversational one
      const tools = session.getActiveToolNames?.() ?? [];
      expect(tools).toContain("oi_child_probe");
      expect(tools).toContain("mcp_browser_navigate_page");
      expect(tools).toContain("mcp_browser_take_snapshot");
      expect(tools).not.toContain("eval");
      expect(tools).not.toContain("todo");
      expect(session.promptHash).toBe(hashPrompt(childSystemPrompt(true)));
      expect(session.sessionFile).toStartWith(join(root, "sessions"));
    } finally {
      await session.dispose?.();
    }
  }, 30_000);

  test("resumes a stored transcript and withholds custom tools from a one-shot child", async () => {
    // Given: a transcript written by a first child session
    const root = createOmoRoot();
    const factory = new OmoChildSessionFactory("oi-test/oi-model", root);
    const first = await factory.create({
      childId: "one-shot-child",
      title: "One-shot child",
      workingDirectory: join(root, "work"),
      sessionDirectory: join(root, "sessions"),
      conversational: false,
    });
    const sessionFile = first.sessionFile;
    await first.dispose?.();

    // When: a one-shot child reopens that transcript while offering a custom tool
    const resumed = await factory.create({
      childId: "one-shot-child",
      title: "One-shot child",
      workingDirectory: join(root, "work"),
      sessionDirectory: join(root, "sessions"),
      ...(sessionFile === undefined ? {} : { sessionFile }),
      conversational: false,
      customTools: [probeTool],
    });

    try {
      // Then: it writes to the same transcript, has no custom tool, and carries the one-shot prompt
      expect(sessionFile).toBeString();
      expect(resumed.sessionFile).toBe(sessionFile);
      expect(resumed.getActiveToolNames?.() ?? []).not.toContain("oi_child_probe");
      expect(resumed.promptHash).toBe(hashPrompt(childSystemPrompt(false)));
      expect(resumed.promptHash).not.toBe(hashPrompt(childSystemPrompt(true)));
    } finally {
      await resumed.dispose?.();
    }
  }, 30_000);
});
