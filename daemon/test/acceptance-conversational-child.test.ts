import { describe, expect, test } from "bun:test";

import { hasCadenceReport, isPromptHash } from "../../scripts/acceptance/conversational-child-checks.ts";

describe("conversational acceptance predicates", () => {
  test("accepts only a bounded lowercase SHA-256 prompt hash", () => {
    expect(isPromptHash("a".repeat(64))).toBe(true);
    expect(isPromptHash("A".repeat(64))).toBe(false);
    expect(isPromptHash("a".repeat(63))).toBe(false);
    expect(isPromptHash("a".repeat(65))).toBe(false);
    expect(isPromptHash(undefined)).toBe(false);
  });

  test("requires a cadence token in a report created at or after child start", () => {
    const messages = [
      { body: "token before", createdAt: "2026-01-01T00:00:00.000Z" },
      { body: "cadence OI_TOKEN", createdAt: "2026-01-01T00:00:01.000Z" },
    ];
    expect(hasCadenceReport(messages, "OI_TOKEN", "2026-01-01T00:00:01.000Z")).toBe(true);
    expect(hasCadenceReport(messages, "OI_TOKEN", "2026-01-01T00:00:02.000Z")).toBe(false);
    expect(hasCadenceReport(messages, "MISSING", "2026-01-01T00:00:00.000Z")).toBe(false);
  });
});
