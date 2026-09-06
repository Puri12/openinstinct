import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BootstrapProbes } from "../src/bootstrap/states.ts";
import type { DeliveryPort, DeliveryReceipt } from "../src/delivery/port.ts";
import { startDaemon } from "../src/main.ts";
import { setDaemonPaused } from "../src/control/pause.ts";
import { bindChatCursor } from "../src/imessage/reader.ts";
import { openStateStore } from "../src/store/index.ts";

import { dataPaths } from "../src/paths.ts";
import type { MainAgentSession, MainSessionFactory } from "../src/sdk-session/main-session.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class FakeMainSession implements MainAgentSession {
  public readonly sessionFile = "/tmp/pipeline-main.jsonl";
  public readonly sessionId = "pipeline-main";
  public readonly prompts: string[] = [];
  private readonly listeners = new Set<(event: unknown) => void>();

  public async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    for (const listener of this.listeners) {
      listener({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Owner reply" },
      });
    }
  }

  public subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async dispose(): Promise<void> {}
}

class FakePort implements DeliveryPort {
  public readonly calls: string[] = [];

  public async sendText(handle: string, text: string): Promise<DeliveryReceipt> {
    this.calls.push(`text:${handle}:${text}`);
    return { messageId: "text-1" };
  }

  public async sendReply(guid: string, text: string): Promise<DeliveryReceipt> {
    this.calls.push(`reply:${guid}:${text}`);
    return { messageId: "reply-1", threadId: "thread-1" };
  }

  public async sendFile(): Promise<DeliveryReceipt> {
    return { messageId: "file-1" };
  }
}

function createChatDb(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const database = new Database(path);
  try {
    database.exec(`
      CREATE TABLE handle (id TEXT NOT NULL);
      CREATE TABLE message (
        guid TEXT NOT NULL,
        handle_id INTEGER,
        text TEXT,
        attributedBody BLOB,
        is_from_me INTEGER NOT NULL,
        date INTEGER,
        thread_originator_guid TEXT,
        associated_message_guid TEXT
      );
      CREATE TABLE chat (guid TEXT NOT NULL);
      CREATE TABLE chat_message_join (chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL);
      CREATE TABLE attachment (filename TEXT, mime_type TEXT, transfer_name TEXT);
      CREATE TABLE message_attachment_join (message_id INTEGER NOT NULL, attachment_id INTEGER NOT NULL);
    `);
    database.query("INSERT INTO handle (id) VALUES (?)").run("+821012345678");
    database.query("INSERT INTO chat (guid) VALUES (?)").run("chat-1");
    database.query("INSERT INTO message (guid, handle_id, text, is_from_me, date) VALUES (?, 1, ?, 0, ?)")
      .run("owner-message-1", "hello agent", 1);
    database.query("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1)").run();
  } finally {
    database.close();
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for pipeline");
    }
    await Bun.sleep(10);
  }
}

describe("main owner pipeline", () => {
  test("serializes an allowed inbound message through the main session and threaded delivery", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-main-pipeline-"));
    directories.push(root);
    const home = join(root, "home");
    const paths = dataPaths(home);
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.config, JSON.stringify({ allowlistHandle: "+821012345678" }));
    const chatDbPath = join(home, "Library", "Messages", "chat.db");
    createChatDb(chatDbPath);
    const capturePath = join(paths.memory, "daily", `${new Date().toISOString().slice(0, 10)}.md`);

    const session = new FakeMainSession();
    const factory: MainSessionFactory = { create: async () => session };
    const port = new FakePort();
    const probes: BootstrapProbes = {
      config: async () => ({ status: "passed", allowlistHandle: "+821012345678" }),
      credentials: async () => ({ status: "passed" }),
      fda: async () => ({ status: "passed" }),
      accessibility: async () => ({ status: "passed" }),
      messages: async () => ({ status: "passed" }),

    };
    // Tests seed chat.db before boot; opt back into replay so the seeded rows are read.
  {
    const seeded = openStateStore(paths.stateDb);
    bindChatCursor(seeded, chatDbPath, 0);
    seeded.close();
  }
  const runtime = await startDaemon({
      paths,
      probes,
      chatDbPath,
      sender: port,
      mainSessionFactory: factory,
      reprobeIntervalMs: 60_000,
    });

    try {
      await waitFor(() => port.calls.length === 1);
      expect(session.prompts).toHaveLength(1);
      expect(session.prompts[0]!.endsWith("hello agent")).toBe(true);
      expect(session.prompts[0]).toMatch(/re-read your SOUL/);
      expect(port.calls).toHaveLength(1);
      expect(port.calls[0]).toBe("text:+821012345678:Owner reply");
      await waitFor(() => existsSync(capturePath));
      expect(readFileSync(capturePath, "utf8")).toContain("- origin: {\"kind\":\"owner-chat\"");
      expect(readFileSync(capturePath, "utf8")).toContain("- user: hello agent");
      expect(readFileSync(capturePath, "utf8")).toContain("- reply: Owner reply");
    } finally {
      await runtime.stop();
    }
  });

  test("advances paused inbound rows without starting an owner turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-main-paused-"));
    directories.push(root);
    const home = join(root, "home");
    const paths = dataPaths(home);
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.config, JSON.stringify({ allowlistHandle: "+821012345678" }));
    const chatDbPath = join(home, "Library", "Messages", "chat.db");
    createChatDb(chatDbPath);
    const persisted = openStateStore(paths.stateDb);
    setDaemonPaused(persisted, true);
    persisted.close();

    const session = new FakeMainSession();
    const factory: MainSessionFactory = { create: async () => session };
    const port = new FakePort();
    const probes: BootstrapProbes = {
      config: async () => ({ status: "passed", allowlistHandle: "+821012345678" }),
      credentials: async () => ({ status: "passed" }),
      fda: async () => ({ status: "passed" }),
      accessibility: async () => ({ status: "passed" }),
      messages: async () => ({ status: "passed" }),
    };
    // Tests seed chat.db before boot; opt back into replay so the seeded rows are read.
  {
    const seeded = openStateStore(paths.stateDb);
    bindChatCursor(seeded, chatDbPath, 0);
    seeded.close();
  }
  const runtime = await startDaemon({
      paths,
      probes,
      chatDbPath,
      sender: port,
      mainSessionFactory: factory,
      reprobeIntervalMs: 60_000,
    });

    try {
      await waitFor(() => runtime.store.getChatCursor() === 1);
      expect(session.prompts).toEqual([]);
      expect(port.calls).toEqual([]);
    } finally {
      await runtime.stop();
    }
  });
});
