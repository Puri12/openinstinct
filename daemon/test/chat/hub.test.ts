import { describe, expect, test } from "bun:test";

import type { NdjsonLogger } from "../../src/log.ts";
import {
  ChatHub,
  PANEL_SOURCE_MARKER,
  type ChatEventSink,
} from "../../src/chat/hub.ts";

type LogCall = readonly [string, string, string, Record<string, unknown> | undefined];

function fakeLogger(calls: LogCall[]): NdjsonLogger {
  return {
    write(...args: LogCall) {
      calls.push(args);
    },
  } as unknown as NdjsonLogger;
}

describe("ChatHub", () => {
  test("assigns one monotonic sequence across messages and presence", () => {
    const hub = new ChatHub();
    const events: Array<{ topic: string; payload: Record<string, unknown> }> = [];
    hub.subscribe((topic, payload) => events.push({ topic, payload }));

    const messageSeq = hub.message({ role: "owner", source: "panel", text: "hello", at: "2026-01-01T00:00:00.000Z" });
    const presenceSeq = hub.presence({ source: "panel", turnId: "panel:1", typing: true, at: "2026-01-01T00:00:01.000Z" });

    expect(messageSeq).toBe(1);
    expect(presenceSeq).toBe(2);
    expect(hub.lastSeq).toBe(2);
    expect(events).toEqual([
      {
        topic: "chat.message",
        payload: {
          seq: 1,
          role: "owner",
          source: "panel",
          text: "hello",
          at: "2026-01-01T00:00:00.000Z",
        },
      },
      {
        topic: "chat.presence",
        payload: {
          seq: 2,
          source: "panel",
          turnId: "panel:1",
          typing: true,
          at: "2026-01-01T00:00:01.000Z",
        },
      },
    ]);
  });

  test("delivers every event to every subscriber with its topic", () => {
    const hub = new ChatHub();
    const first: Array<{ topic: string; payload: Record<string, unknown> }> = [];
    const second: Array<{ topic: string; payload: Record<string, unknown> }> = [];

    hub.subscribe((topic, payload) => first.push({ topic, payload }));
    hub.subscribe((topic, payload) => second.push({ topic, payload }));

    hub.message({ role: "assistant", text: "reply", at: "2026-01-01T00:00:00.000Z" });
    hub.presence({ source: "imessage", turnId: "imessage:1", read: true, at: "2026-01-01T00:00:01.000Z" });

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(first.map((event) => event.topic)).toEqual(["chat.message", "chat.presence"]);
    expect(second.map((event) => event.topic)).toEqual(["chat.message", "chat.presence"]);
    expect(first[0]?.payload).toEqual(second[0]?.payload);
    expect(first[1]?.payload).toEqual(second[1]?.payload);
  });

  test("removes a throwing sink, logs the failure, and preserves other sinks", () => {
    const logCalls: LogCall[] = [];
    const hub = new ChatHub(fakeLogger(logCalls));
    let throwingCalls = 0;
    let healthyCalls = 0;
    const throwingSink: ChatEventSink = () => {
      throwingCalls += 1;
      throw new Error("subscriber broke");
    };

    hub.subscribe(throwingSink);
    hub.subscribe(() => {
      healthyCalls += 1;
    });

    expect(() => hub.message({ role: "assistant", text: "first", at: "2026-01-01T00:00:00.000Z" })).not.toThrow();
    expect(() => hub.presence({ source: "panel", turnId: "panel:1", at: "2026-01-01T00:00:01.000Z" })).not.toThrow();
    expect(throwingCalls).toBe(1);
    expect(healthyCalls).toBe(2);
    expect(logCalls).toEqual([
      ["error", "chat", "subscriber_failed", { topic: "chat.message", message: "subscriber broke" }],
    ]);
  });

  test("unsubscribe stops delivery and is safe to call twice", () => {
    const hub = new ChatHub();
    let calls = 0;
    const unsubscribe = hub.subscribe(() => {
      calls += 1;
    });

    hub.message({ role: "owner", source: "imessage", text: "before", at: "2026-01-01T00:00:00.000Z" });
    unsubscribe();
    unsubscribe();
    hub.message({ role: "owner", source: "imessage", text: "after", at: "2026-01-01T00:00:01.000Z" });

    expect(calls).toBe(1);
  });

  test("omits optional fields unless supplied", () => {
    const hub = new ChatHub();
    const payloads: Record<string, unknown>[] = [];
    hub.subscribe((_topic, payload) => payloads.push(payload));

    hub.message({ role: "assistant", at: "2026-01-01T00:00:00.000Z" });
    hub.presence({ source: "panel", turnId: "panel:1", at: "2026-01-01T00:00:01.000Z" });
    hub.message({
      role: "assistant",
      image: { path: "/tmp/reply.png", caption: "A reply image" },
      turnId: "panel:1",
      final: true,
      at: "2026-01-01T00:00:02.000Z",
    });
    hub.presence({ source: "panel", turnId: "panel:1", read: true, at: "2026-01-01T00:00:03.000Z" });

    expect(payloads[0]).toEqual({ seq: 1, role: "assistant", at: "2026-01-01T00:00:00.000Z" });
    expect(payloads[1]).toEqual({ seq: 2, source: "panel", turnId: "panel:1", at: "2026-01-01T00:00:01.000Z" });
    expect(payloads[2]).toEqual({
      seq: 3,
      role: "assistant",
      image: { path: "/tmp/reply.png", caption: "A reply image" },
      at: "2026-01-01T00:00:02.000Z",
      turnId: "panel:1",
      final: true,
    });
    expect(payloads[3]).toEqual({ seq: 4, source: "panel", turnId: "panel:1", read: true, at: "2026-01-01T00:00:03.000Z" });
    expect(PANEL_SOURCE_MARKER).toBe("[sent from the Chat window]");
  });
});
