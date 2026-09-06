import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NdjsonLogger } from "../src/log.ts";
import { MAX_FRAME_BYTES, MAX_CONNECTION_BUFFER_BYTES, type ChatHistoryResponse } from "../src/control/schema.ts";
import type { ChatEventSink } from "../src/chat/hub.ts";
import { startControlServer, type ControlServer } from "../src/control/socket.ts";
import { openStateStore, type StateStore } from "../src/store/index.ts";

const directories: string[] = [];

interface FrameReader {
  next(timeoutMs?: number): Promise<Record<string, unknown>>;
}

type LogCall = readonly [string, string, string, Record<string, unknown> | undefined];

function fakeLogger(calls: LogCall[]): NdjsonLogger {
  return {
    write(...args: LogCall) {
      calls.push(args);
    },
  } as unknown as NdjsonLogger;
}

function makeReader(socket: Socket): FrameReader {
  let buffered = "";
  const frames: Record<string, unknown>[] = [];
  const waiters: Array<{
    readonly resolve: (frame: Record<string, unknown>) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }> = [];
  let ended = false;
  let socketError: Error | undefined;

  const settle = (): void => {
    while (frames.length > 0 && waiters.length > 0) {
      const frame = frames.shift();
      const waiter = waiters.shift();
      if (frame === undefined || waiter === undefined) {
        return;
      }
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    }
    if ((ended || socketError !== undefined) && waiters.length > 0) {
      const error = socketError ?? new Error("socket ended");
      while (waiters.length > 0) {
        const waiter = waiters.shift();
        if (waiter === undefined) {
          break;
        }
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
  };

  socket.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const line = buffered.slice(0, newline).replace(/\r$/, "");
      buffered = buffered.slice(newline + 1);
      frames.push(JSON.parse(line) as Record<string, unknown>);
    }
    settle();
  });
  socket.on("end", () => {
    ended = true;
    settle();
  });
  socket.on("error", (error) => {
    socketError = error;
    settle();
  });

  return {
    next(timeoutMs = 1_000): Promise<Record<string, unknown>> {
      const frame = frames.shift();
      if (frame !== undefined) {
        return Promise.resolve(frame);
      }
      if (ended || socketError !== undefined) {
        return Promise.reject(socketError ?? new Error("socket ended"));
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.timer === timer);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          reject(new Error("timed out waiting for frame"));
        }, timeoutMs);
        waiters.push({ resolve, reject, timer });
      });
    },
  };
}

async function connected(path: string): Promise<{ socket: Socket; reader: FrameReader }> {
  const socket = createConnection({ path });
  await once(socket, "connect");
  const reader = makeReader(socket);
  socket.write(`${JSON.stringify({ type: "hello", v: 1, client: "control-subscription-test" })}\n`);
  expect((await reader.next()).type).toBe("negotiated");
  return { socket, reader };
}

function request(socket: Socket, id: string, verb: string, payload: Record<string, unknown>): void {
  socket.write(`${JSON.stringify({ type: "request", id, verb, payload })}\n`);
}

async function startHarness(options: {
  readonly chat?: {
    readonly send?: (text: string) => Promise<{ readonly turnId: string; readonly outcome: string }>;
    readonly history?: (limit: number) => ChatHistoryResponse;
    readonly subscribe?: (sink: ChatEventSink) => () => void;
  };
  readonly logger?: NdjsonLogger;
} = {}): Promise<{ control: ControlServer; store: StateStore; path: string }> {
  const directory = mkdtempSync(join(tmpdir(), "openinstinct-control-subscription-"));
  directories.push(directory);
  const path = join(directory, "run", "control.sock");
  const store = openStateStore(join(directory, "state.db"));
  const control = await startControlServer({
    path,
    store,
    logger: options.logger,
    getStatus: () => ({ state: "running", probes: { config: { status: "passed" }, credentials: { status: "passed" } } }),
    ...(options.chat === undefined ? {} : {
      chat: {
        send: options.chat.send ?? (async () => ({ turnId: "panel:test", outcome: "started" })),
        history: options.chat.history ?? (() => ({ messages: [], seq: 0, tail: [] })),
        subscribe: options.chat.subscribe ?? (() => () => undefined),
      },
    }),
  });
  return { control, store, path };
}

async function stopHarness(harness: { control: ControlServer; store: StateStore }): Promise<void> {
  await harness.control.close();
  harness.store.close();
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("control chat subscription lifecycle", () => {
  test("delivers subscribed events only to the subscribing socket and drops pre-ack events", async () => {
    let sink: ChatEventSink | undefined;
    const harness = await startHarness({
      chat: {
        subscribe: (candidate) => {
          sink = candidate;
          candidate("chat.message", { seq: 1, role: "assistant", text: "before ack" });
          return () => undefined;
        },
      },
    });
    let first: Socket | undefined;
    let second: Socket | undefined;
    try {
      const firstConnection = await connected(harness.path);
      first = firstConnection.socket;
      const firstReader = firstConnection.reader;
      const secondConnection = await connected(harness.path);
      second = secondConnection.socket;
      const secondReader = secondConnection.reader;

      request(first, "subscribe", "chat.subscribe", {});
      expect(await firstReader.next()).toEqual({
        type: "response",
        id: "subscribe",
        ok: true,
        payload: { subscribed: true },
      });
      expect(sink).toBeDefined();
      sink!("chat.message", { seq: 2, role: "assistant", text: "after ack" });
      expect(await firstReader.next()).toEqual({
        type: "event",
        topic: "chat.message",
        payload: { seq: 2, role: "assistant", text: "after ack" },
      });
      await expect(secondReader.next(75)).rejects.toThrow("timed out waiting for frame");
    } finally {
      first?.destroy();
      second?.destroy();
      await stopHarness(harness);
    }
  });

  test("rejects a duplicate subscription while keeping the connection open", async () => {
    const harness = await startHarness({ chat: {} });
    let socket: Socket | undefined;
    try {
      const connection = await connected(harness.path);
      socket = connection.socket;
      const reader = connection.reader;
      request(socket, "subscribe-1", "chat.subscribe", {});
      expect((await reader.next()).payload).toEqual({ subscribed: true });
      request(socket, "subscribe-2", "chat.subscribe", {});
      expect(await reader.next()).toEqual({
        type: "error",
        id: "subscribe-2",
        ok: false,
        code: "invalid_frame",
        message: "chat subscription already active",
      });
      request(socket, "status", "status.get", {});
      expect((await reader.next()).type).toBe("response");
    } finally {
      socket?.destroy();
      await stopHarness(harness);
    }
  });

  test("maps unavailable and inactive chat sends to internal errors", async () => {
    const unavailable = await startHarness();
    let unavailableSocket: Socket | undefined;
    try {
      const connection = await connected(unavailable.path);
      unavailableSocket = connection.socket;
      request(unavailableSocket, "send", "chat.send", { text: "hello" });
      expect(await connection.reader.next()).toEqual({
        type: "error",
        id: "send",
        ok: false,
        code: "internal_error",
        message: "chat is unavailable",
      });
    } finally {
      unavailableSocket?.destroy();
      await stopHarness(unavailable);
    }

    const inactive = await startHarness({
      chat: {
        send: async () => {
          throw new Error("main session is not running");
        },
      },
    });
    let inactiveSocket: Socket | undefined;
    try {
      const connection = await connected(inactive.path);
      inactiveSocket = connection.socket;
      request(inactiveSocket, "send", "chat.send", { text: "hello" });
      expect(await connection.reader.next()).toEqual({
        type: "error",
        id: "send",
        ok: false,
        code: "internal_error",
        message: "main session is not running",
      });
    } finally {
      inactiveSocket?.destroy();
      await stopHarness(inactive);
    }
  });

  test("validates chat.history limits at the protocol boundary", async () => {
    const harness = await startHarness({ chat: {} });
    let socket: Socket | undefined;
    try {
      const connection = await connected(harness.path);
      socket = connection.socket;
      request(socket, "history", "chat.history", { limit: 51 });
      expect(await connection.reader.next()).toEqual({
        type: "error",
        ok: false,
        code: "invalid_frame",
        message: "chat.history.limit must be no greater than 50",
      });
    } finally {
      socket?.destroy();
      await stopHarness(harness);
    }
  });

  test("close ends an open subscriber and resolves promptly", async () => {
    const harness = await startHarness({ chat: {} });
    const connection = await connected(harness.path);
    request(connection.socket, "subscribe", "chat.subscribe", {});
    expect((await connection.reader.next()).payload).toEqual({ subscribed: true });
    const eof = once(connection.socket, "end");
    const close = harness.control.close();
    await Promise.race([
      close,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("control close timed out")), 2_000)),
    ]);
    await eof;
    harness.store.close();
    connection.socket.destroy();
  });

  test("drops oversized events, logs the drop, and keeps the socket alive", async () => {
    const calls: LogCall[] = [];
    let sink: ChatEventSink | undefined;
    const harness = await startHarness({
      logger: fakeLogger(calls),
      chat: {
        subscribe: (candidate) => {
          sink = candidate;
          return () => undefined;
        },
      },
    });
    let socket: Socket | undefined;
    try {
      const connection = await connected(harness.path);
      socket = connection.socket;
      request(socket, "subscribe", "chat.subscribe", {});
      expect((await connection.reader.next()).payload).toEqual({ subscribed: true });
      sink!("chat.message", { seq: 8, role: "assistant", text: "x".repeat(MAX_FRAME_BYTES) });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(calls).toContainEqual([
        "warn",
        "control",
        "event_frame_oversized",
        { topic: "chat.message", seq: 8 },
      ]);
      request(socket, "status", "status.get", {});
      expect((await connection.reader.next()).type).toBe("response");
    } finally {
      socket?.destroy();
      await stopHarness(harness);
    }
  });

  test("closes only the socket that exceeds the event backpressure bound", async () => {
    const calls: LogCall[] = [];
    const sinks: ChatEventSink[] = [];
    const harness = await startHarness({
      logger: fakeLogger(calls),
      chat: {
        subscribe: (candidate) => {
          sinks.push(candidate);
          return () => undefined;
        },
      },
    });
    let slow: Socket | undefined;
    let fast: Socket | undefined;
    try {
      const slowConnection = await connected(harness.path);
      slow = slowConnection.socket;
      request(slow, "slow-subscribe", "chat.subscribe", {});
      expect((await slowConnection.reader.next()).payload).toEqual({ subscribed: true });
      slow.pause();

      const fastConnection = await connected(harness.path);
      fast = fastConnection.socket;
      request(fast, "fast-subscribe", "chat.subscribe", {});
      expect((await fastConnection.reader.next()).payload).toEqual({ subscribed: true });

      const serverConnections = [...(harness.control as unknown as { readonly connections: Set<Socket> }).connections];
      const slowServerSocket = serverConnections.find((candidate) => candidate.remotePort === slow!.localPort);
      expect(slowServerSocket).toBeDefined();
      Object.defineProperty(slowServerSocket, "writableLength", { configurable: true, value: MAX_CONNECTION_BUFFER_BYTES + 1 });
      const slowClosed = once(slow, "close");
      for (const sink of sinks) {
        sink("chat.message", { seq: 1, role: "assistant", text: "event" });
      }
      slow.resume();
      await Promise.race([
        slowClosed,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("slow subscriber stayed open")), 2_000)),
      ]);
      expect(calls.some((call) => call[2] === "subscriber_backpressure_closed")).toBe(true);
      expect(fast.destroyed).toBe(false);
      expect((await fastConnection.reader.next()).type).toBe("event");
      request(fast, "status", "status.get", {});
      expect((await fastConnection.reader.next()).type).toBe("response");
    } finally {
      slow?.destroy();
      fast?.destroy();
      await stopHarness(harness);
    }
  });

  test("fits an oversized history tail before writing the response", async () => {
    const harness = await startHarness({
      chat: {
        history: () => ({
          messages: [],
          seq: 20,
          tail: [{ topic: "chat.message", payload: { seq: 19, role: "assistant", text: "x".repeat(MAX_FRAME_BYTES) } }],
        }),
      },
    });
    let socket: Socket | undefined;
    try {
      const connection = await connected(harness.path);
      socket = connection.socket;
      request(socket, "history", "chat.history", { limit: 50 });
      const frame = await connection.reader.next();
      expect(frame.type).toBe("response");
      const payload = frame.payload as Record<string, unknown>;
      expect(payload.tailTruncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(frame), "utf8")).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    } finally {
      socket?.destroy();
      await stopHarness(harness);
    }
  });

});
