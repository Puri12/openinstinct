import { describe, expect, test } from "bun:test";

import { FOLLOW_UP_PROMPT_PREFIX } from "../../src/children/receipts.ts";
import {
  applyHistoryByteBudget,
  OPERATOR_NOTE_PREFIX,
  readOwnerFacingHistory,
} from "../../src/chat/history.ts";
import { PANEL_SOURCE_MARKER } from "../../src/chat/hub.ts";
import { TRIAGE_PROMPT_PREFIX } from "../../src/monitors/propagation.ts";
import { ORIENTATION_HEAD, ORIENTATION_SEPARATOR } from "../../src/persona/orientation.ts";
import type { ChatHistoryResponse } from "../../src/control/schema.ts";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
const now = (): Date => new Date("2026-01-01T00:00:00.000Z");
const encodedBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe("readOwnerFacingHistory", () => {
  test("filters internal turns, strips routing metadata, and renders transcript blocks defensively", () => {
    const transcript: unknown[] = [
      {
        role: "user",
        content: `${ORIENTATION_HEAD} (daemon restart).${ORIENTATION_SEPARATOR}**hello owner**`,
        timestamp: 1_000,
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "**first reply**" },
          { type: "text", text: "second reply" },
          { type: "thinking", thinking: "not owner-facing" },
          { type: "unknown", data: "skip me" },
        ],
        timestamp: 2_000,
      },
      {
        role: "user",
        content: `${OPERATOR_NOTE_PREFIX}, not from the owner] reload settings`,
        timestamp: 3_000,
      },
      { role: "assistant", content: [{ type: "text", text: "hidden operator reply" }], timestamp: 4_000 },
      {
        role: "user",
        content: `${FOLLOW_UP_PROMPT_PREFIX} Give the owner a concise update.`,
        timestamp: 5_000,
      },
      { role: "assistant", content: [{ type: "text", text: "hidden receipt reply" }], timestamp: 6_000 },
      {
        role: "user",
        content: `${TRIAGE_PROMPT_PREFIX}daily-check triage details`,
        timestamp: 7_000,
      },
      { role: "assistant", content: [{ type: "text", text: "hidden triage reply" }], timestamp: 8_000 },
      {
        role: "user",
        content: `panel owner text\n\n${PANEL_SOURCE_MARKER}`,
        timestamp: 9_000,
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I checked the image." },
          { type: "toolCall", name: "read", arguments: { path: "/tmp/vision.png:1-20" } },
          { type: "toolCall", name: "send_image", arguments: { filePath: "/tmp/chart.png", caption: "**chart caption**" } },
          { type: "toolCall", name: "bash", arguments: { command: "printf skip" } },
        ],
        timestamp: 10_000,
      },
      {
        role: "user",
        content: `marker in the middle ${PANEL_SOURCE_MARKER} remains text`,
        timestamp: 11_000,
      },
      {
        role: "assistant",
        content: [
          null,
          { type: "text", text: "reply without a timestamp" },
          { type: "toolCall", name: "read", arguments: { path: "/tmp/not-an-image.txt" } },
          { type: "toolCall", name: "send_image", arguments: { filePath: 42, caption: "skip" } },
        ],
        timestamp: "not-a-number",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "what is in this?" },
          { type: "image", data: PNG_BASE64, mimeType: "image/png" },
          { type: "unsupported", data: PNG_BASE64 },
        ],
      },
      { role: "toolResult", content: [{ type: "text", text: "do not show" }], timestamp: 13_000 },
      { role: "custom", content: "also do not show", timestamp: 14_000 },
      null,
      ["not a message"],
    ];

    const result = readOwnerFacingHistory(transcript, 50, undefined, () => {
      throw new Error("history reader must not call now() for a missing timestamp");
    });

    expect(result.messages as unknown).toEqual([
      { role: "owner", source: "imessage", text: "hello owner", at: "1970-01-01T00:00:01.000Z" },
      { role: "assistant", text: "first reply", at: "1970-01-01T00:00:02.000Z" },
      { role: "assistant", text: "second reply", at: "1970-01-01T00:00:02.000Z" },
      { role: "owner", source: "panel", text: "panel owner text", at: "1970-01-01T00:00:09.000Z" },
      { role: "assistant", text: "I checked the image.", at: "1970-01-01T00:00:10.000Z" },
      {
        role: "assistant",
        image: { path: "/tmp/vision.png", caption: "(looking at vision.png)" },
        at: "1970-01-01T00:00:10.000Z",
      },
      {
        role: "assistant",
        image: { path: "/tmp/chart.png", caption: "chart caption" },
        at: "1970-01-01T00:00:10.000Z",
      },
      {
        role: "owner",
        source: "imessage",
        text: `marker in the middle ${PANEL_SOURCE_MARKER} remains text`,
        at: "1970-01-01T00:00:11.000Z",
      },
      { role: "assistant", text: "reply without a timestamp" },
      { role: "owner", source: "imessage", text: "what is in this?\n(photo)" },
    ]);
    expect(result.messages.map((message) => message.text)).not.toContain("hidden operator reply");
    expect(result.messages.map((message) => message.text)).not.toContain("hidden receipt reply");
    expect(result.messages.map((message) => message.text)).not.toContain("hidden triage reply");
  });

  test("clamps the owner-facing result to the last 50 bubbles", () => {
    const transcript = Array.from({ length: 60 }, (_, index) => ({
      role: "user",
      content: `owner-${index}`,
      timestamp: index,
    }));

    const result = readOwnerFacingHistory(transcript, 500, undefined, now);

    expect(result.messages).toHaveLength(50);
    expect(result.messages.map((message) => message.text)).toEqual(
      Array.from({ length: 50 }, (_, index) => `owner-${index + 10}`),
    );
  });

  test("excludes rows at and after a transcript boundary and ignores the fallback sentinel", () => {
    const transcript = [
      { role: "user", content: "before", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "before reply" }], timestamp: 2 },
      { role: "user", content: "at boundary", timestamp: 3 },
      { role: "assistant", content: [{ type: "text", text: "boundary reply" }], timestamp: 4 },
    ];

    expect(readOwnerFacingHistory(transcript, 50, 2, now).messages).toEqual([
      { role: "owner", source: "imessage", text: "before", at: "1970-01-01T00:00:00.001Z" },
      { role: "assistant", text: "before reply", at: "1970-01-01T00:00:00.002Z" },
    ]);
    expect(readOwnerFacingHistory(transcript, 50, -1, now).messages).toHaveLength(4);
    expect(readOwnerFacingHistory(transcript, 50, 0, now).messages).toEqual([]);
  });

  test("does not throw for a non-array transcript or unknown block shapes", () => {
    expect(readOwnerFacingHistory({ role: "user", content: "nope" }, 50, undefined, now)).toEqual({ messages: [] });
    expect(readOwnerFacingHistory([{
      role: "assistant",
      content: [null, 1, {}, { type: "toolCall", name: "read", arguments: null }],
    }], 50, undefined, now)).toEqual({ messages: [] });
  });
});

describe("applyHistoryByteBudget", () => {
  test("drops oldest messages before tail rows and marks each truncation", () => {
    const response: ChatHistoryResponse = {
      messages: [
        { role: "owner", source: "imessage", text: "oldest".repeat(20) },
        { role: "owner", source: "imessage", text: "middle".repeat(20) },
        { role: "assistant", text: "newest".repeat(20) },
      ],
      seq: 7,
      tail: [
        { topic: "chat.message", payload: { seq: 6, role: "assistant", text: "tail" } },
      ],
      inFlight: { turnId: "turn-7", typing: true },
    };
    const target = { ...response, messages: response.messages.slice(1), truncated: true as const };
    const fitted = applyHistoryByteBudget(response, encodedBytes(target));

    expect(fitted.messages).toEqual(response.messages.slice(1));
    expect(fitted.tail).toEqual(response.tail);
    expect(fitted.truncated).toBe(true);
    expect(fitted.tailTruncated).toBeUndefined();
    expect(encodedBytes(fitted)).toBeLessThanOrEqual(encodedBytes(target));
    expect(response.messages).toHaveLength(3);
  });

  test("drops oldest tail events after all messages when required", () => {
    const response: ChatHistoryResponse = {
      messages: [
        { role: "owner", source: "imessage", text: "message".repeat(20) },
        { role: "assistant", text: "reply".repeat(20) },
      ],
      seq: 9,
      tail: [
        { topic: "chat.message", payload: { seq: 8, role: "assistant", text: "old tail".repeat(20) } },
        { topic: "chat.message", payload: { seq: 9, role: "assistant", text: "new tail".repeat(20) } },
      ],
    };
    const target = {
      ...response,
      messages: [],
      tail: response.tail.slice(1),
      truncated: true as const,
      tailTruncated: true as const,
    };
    const fitted = applyHistoryByteBudget(response, encodedBytes(target));

    expect(fitted.messages).toEqual([]);
    expect(fitted.tail).toEqual(response.tail.slice(1));
    expect(fitted.truncated).toBe(true);
    expect(fitted.tailTruncated).toBe(true);
    expect(encodedBytes(fitted)).toBeLessThanOrEqual(encodedBytes(target));
  });
});
