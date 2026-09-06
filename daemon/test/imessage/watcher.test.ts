import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InboundMessage, InboundMessageReader } from "../../src/imessage/reader.ts";
import { ImessageWatcher } from "../../src/imessage/watcher.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class QueueReader implements InboundMessageReader {
  public readonly cursors: number[] = [];
  public reads = 0;
  public readonly batches: InboundMessage[][] = [];

  public readNewMessages(): InboundMessage[] {
    this.reads += 1;
    return this.batches.shift() ?? [];
  }

  public advanceCursor(rowid: number): void {
    this.cursors.push(rowid);
  }
}

function message(rowid: number): InboundMessage {
  return {
    guid: `message-${rowid}`,
    rowid,
    senderHandle: "+821012345678",
    text: "hello",
    isFromMe: false,
    threadOriginatorGuid: undefined,
    replyToGuid: undefined,
    attachments: [],
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for watcher");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe("ImessageWatcher", () => {
  test("does not read before the bootstrap gate and coalesces WAL file events", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openinstinct-watcher-"));
    directories.push(directory);
    const chatDb = join(directory, "chat.db");
    const wal = `${chatDb}-wal`;
    writeFileSync(chatDb, "db");
    writeFileSync(wal, "wal");

    const reader = new QueueReader();
    const received: InboundMessage[][] = [];
    let gate = false;
    const watcher = new ImessageWatcher({
      chatDbPath: chatDb,
      reader,
      gate: () => gate,
      onMessages: (batch) => {
        received.push([...batch]);
      },
      debounceMs: 30,
      pollIntervalMs: 500,
    });

    watcher.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(reader.reads).toBe(0);
    expect(watcher.isRunning).toBe(false);

    gate = true;
    watcher.start();
    await waitFor(() => reader.reads >= 1);
    reader.batches.push([message(1)]);
    appendFileSync(wal, "a");
    appendFileSync(wal, "b");
    appendFileSync(wal, "c");

    await waitFor(() => received.length === 1);
    expect(received).toEqual([[message(1)]]);
    expect(reader.cursors).toEqual([1]);
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    expect(received).toHaveLength(1);
    await watcher.stop();
  });

  test("polls for a batch when no relevant filesystem event arrives", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openinstinct-watcher-poll-"));
    directories.push(directory);
    const chatDb = join(directory, "chat.db");
    writeFileSync(chatDb, "db");

    const reader = new QueueReader();
    const received: InboundMessage[][] = [];
    const watcher = new ImessageWatcher({
      chatDbPath: chatDb,
      reader,
      gate: () => true,
      onMessages: (batch) => {
        received.push([...batch]);
      },
      debounceMs: 5,
      pollIntervalMs: 25,
    });

    watcher.start();
    await waitFor(() => reader.reads >= 1);
    reader.batches.push([message(2)]);
    writeFileSync(join(directory, "unrelated-file"), "ignored");

    await waitFor(() => received.length === 1);
    expect(received).toEqual([[message(2)]]);
    expect(reader.cursors).toEqual([2]);
    await watcher.stop();
  });
});
