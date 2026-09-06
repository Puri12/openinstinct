import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  CHILD_REPORTING_INSTRUCTION,
  createReportProgressTool,
} from "../../src/children/report-progress-tool.ts";
import {
  SdkConversationRunner,
} from "../../src/children/runners/sdk-conversation.ts";
import {
  childSystemPrompt,
  SdkInProcessRunner,
  type ChildAgentSession,
  type ChildSessionFactory,
} from "../../src/children/runners/sdk-inprocess.ts";
import { truncateUtf8 } from "../../src/children/utf8.ts";

async function execute(tool: any, params: unknown): Promise<any> {
  return await tool.execute("report-call", params, undefined, {});
}

class FakeChildSession implements ChildAgentSession {
  public readonly sessionFile = "/tmp/report-progress-child.jsonl";

  public async prompt(): Promise<void> {}
}

describe("report_progress", () => {
  test("uses the strict schema and reports UTF-8 truncation details", async () => {
    const admitted: Array<{ readonly childId: string; readonly title: string; readonly text: string; readonly toolCallId: string; readonly truncated?: boolean }> = [];
    const tool = createReportProgressTool({
      childId: "child-1",
      title: "Research",
      admit: (input) => {
        admitted.push(input);
        return { accepted: true, truncated: true, bytes: 1_024 };
      },
    });
    const long = "가".repeat(400);

    expect((tool.parameters as any).safeParse({ text: "update", extra: true }).success).toBe(false);
    expect((tool.parameters as any).safeParse({ text: "" }).success).toBe(false);
    expect((tool.parameters as any).safeParse({ text: "x".repeat(4_001) }).success).toBe(false);
    await expect(execute(tool, { text: long })).resolves.toEqual({
      content: [{ type: "text", text: "Reported (truncated to 1024 bytes)." }],
      details: { accepted: true, truncated: true, bytes: 1_024 },
    });
    expect(admitted).toEqual([{
      childId: "child-1",
      title: "Research",
      text: truncateUtf8(long, 1_024),
      toolCallId: "report-call",
      truncated: true,
    }]);
  });

  test("returns the exact rate-limit envelope without waiting for a main turn", async () => {
    const tool = createReportProgressTool({
      childId: "child-1",
      title: "Research",
      admit: () => ({ accepted: false, reason: "rate_limited", retryAfterSec: 12 }),
    });

    await expect(execute(tool, { text: "still working" })).resolves.toEqual({
      content: [{ type: "text", text: "Dropped: over the reporting rate limit (6 per minute); keep working and report again after 12s." }],
      details: { accepted: false, reason: "rate_limited", retryAfterSec: 12 },
    });
  });

  test("AC-19 registers report_progress only for conversational child sessions and appends its instruction", async () => {
    const calls: Array<Parameters<ChildSessionFactory["create"]>[0]> = [];
    const session = new FakeChildSession();
    const factory: ChildSessionFactory = {
      create: async (input) => {
        calls.push(input);
        return session;
      },
    };
    const conversational = new SdkConversationRunner({ root: "/tmp/report-progress", factory });
    const oneShot = new SdkInProcessRunner({ root: "/tmp/report-progress", factory });

    const conversation = await conversational.open({
      childId: "conversation-child",
      title: "Conversation child",
      onReport: () => ({ accepted: true }),
    }, new AbortController().signal);
    await oneShot.run({ childId: "daemon-child", title: "Daemon child", prompt: "work" }, new AbortController().signal);

    expect(conversation.sessionFile).toBe("/tmp/report-progress-child.jsonl");
    expect(calls[0]).toMatchObject({ conversational: true, customTools: [expect.objectContaining({ name: "report_progress" })] });
    expect(calls[1]).toMatchObject({ conversational: false });
    expect(calls[1]?.customTools).toBeUndefined();
    expect(childSystemPrompt([], true)).toContain(CHILD_REPORTING_INSTRUCTION);
    expect(childSystemPrompt([], false)).not.toContain(CHILD_REPORTING_INSTRUCTION);

    const mainSource = readFileSync(new URL("../../src/sdk-session/main-session.ts", import.meta.url), "utf8");
    expect(mainSource).not.toContain("report-progress-tool");
  });
});
