import { describe, expect, test } from "bun:test";

import { createDelegateBackgroundTool } from "../../src/omo-session/main-session.ts";

describe("delegate_background tool", () => {
  test("registers and returns a child id without waiting for child work", async () => {
    const calls: Array<{ readonly title: string; readonly prompt: string }> = [];
    const tool = createDelegateBackgroundTool((request) => {
      calls.push(request);
      return { id: "child-123" };
    });

    const result = await tool.execute(
      "tool-call-1",
      { title: "  Investigate  ", prompt: "  Find the answer  " } as never,
      undefined,
      undefined,
      {} as never,
    );

    expect(tool.name).toBe("delegate_background");
    expect(calls).toEqual([{ title: "Investigate", prompt: "Find the answer" }]);
    expect(result.content).toEqual([{
      type: "text",
      text: "Background task child-123 was accepted. Confirm to the owner that it is underway; its result will arrive in a later follow-up.",
    }]);
  });
});
