import { describe, expect, test } from "bun:test";

import { DrillConversationRunner } from "../../src/drills/runtime.ts";
import { holdForDrill, readDrillSettings } from "../../src/drills/hooks.ts";

describe("drill hooks", () => {
  test("are inert without OI_DRILL_* environment settings", async () => {
    expect(readDrillSettings({})).toEqual({ enabled: false });
    expect(readDrillSettings({ OI_DRILL_HOLD: "mid-child" })).toEqual({ enabled: false });
    await expect(holdForDrill("post-journal-pre-receipt", {})).resolves.toBeUndefined();
    await expect(holdForDrill("post-journal-pre-receipt", { OI_DRILL_HOLD: "post-journal-pre-receipt" })).resolves.toBeUndefined();
  });

  test("recognizes only declared opt-in hold points", () => {
    expect(readDrillSettings({ OI_DRILL_MODE: "1", OI_DRILL_HOLD: "mid-child" })).toEqual({
      enabled: true,
      holdPoint: "mid-child",
    });
    expect(readDrillSettings({ OI_DRILL_MODE: "1", OI_DRILL_HOLD: "mid-interim-batch" })).toEqual({
      enabled: true,
      holdPoint: "mid-interim-batch",
    });
    expect(readDrillSettings({ OI_DRILL_MODE: "1", OI_DRILL_HOLD: "unknown" })).toEqual({ enabled: true });
  });

  test("lets conversational drill children issue report_progress directives", async () => {
    const reports: Array<{ readonly text: string; readonly toolCallId: string }> = [];
    const runner = new DrillConversationRunner();
    const conversation = await runner.open({
      childId: "drill-child",
      title: "Drill child",
      onReport: (report) => {
        reports.push(report);
        return { accepted: true };
      },
    }, new AbortController().signal);
    await expect(conversation.turn("work [[report: found a blocker ]]", new AbortController().signal, () => undefined))
      .resolves.toMatchObject({ state: "completed" });
    expect(reports).toEqual([{ text: "found a blocker", toolCallId: "drill-report:drill-child:1" }]);
  });
});
