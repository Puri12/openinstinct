import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BootstrapProbes } from "../src/bootstrap/states.ts";
import type { DeliveryPort, DeliveryReceipt } from "../src/delivery/port.ts";
import { startDaemon } from "../src/main.ts";
import { dataPaths } from "../src/paths.ts";
import type { MainAgentSession, MainSessionFactory } from "../src/sdk-session/main-session.ts";
import { bindChatCursor } from "../src/imessage/reader.ts";
import { openStateStore } from "../src/store/index.ts";

const directories: string[] = [];
const OWNER = "+821012345678";

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Replies with nothing, so every real turn fails with empty_reply. */
class SilentSession implements MainAgentSession {
  public readonly sessionFile = "/tmp/inbox-safety.jsonl";
  public readonly sessionId = "inbox-safety";
  public readonly prompts: string[] = [];

  public async prompt(text: string): Promise<void> {
    this.prompts.push(text);
  }

  public get messages(): unknown {
    return [];
  }
}

class CountingPort implements DeliveryPort {
  public sent = 0;
  public readonly typing: boolean[] = [];
  public reads = 0;

  public async markRead(): Promise<void> {
    this.reads += 1;
  }

  public async setTyping(_handle: string, typing: boolean): Promise<void> {
    this.typing.push(typing);
  }

  public async sendText(): Promise<DeliveryReceipt> {
    this.sent += 1;
    return { messageId: `t${this.sent}` };
  }

  public async sendReply(): Promise<DeliveryReceipt> {
    this.sent += 1;
    return { messageId: `r${this.sent}` };
  }

  public async sendFile(): Promise<DeliveryReceipt> {
    this.sent += 1;
    return { messageId: `f${this.sent}` };
  }
}

function createChatDb(path: string, texts: readonly (string | null)[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const database = new Database(path);
  try {
    database.exec(`
      CREATE TABLE handle (id TEXT NOT NULL);
      CREATE TABLE message (
        guid TEXT NOT NULL, handle_id INTEGER, text TEXT, attributedBody BLOB, is_from_me INTEGER NOT NULL,
        date INTEGER, thread_originator_guid TEXT, associated_message_guid TEXT
      );
      CREATE TABLE chat (guid TEXT NOT NULL);
      CREATE TABLE chat_message_join (chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL);
      CREATE TABLE attachment (filename TEXT, mime_type TEXT, transfer_name TEXT);
      CREATE TABLE message_attachment_join (message_id INTEGER NOT NULL, attachment_id INTEGER NOT NULL);
    `);
    database.query("INSERT INTO handle (id) VALUES (?)").run(OWNER);
    texts.forEach((text, index) => {
      database.query("INSERT INTO message (guid, handle_id, text, is_from_me, date) VALUES (?, 1, ?, 0, ?)")
        .run(`guid-${index + 1}`, text, index);
    });
  } finally {
    database.close();
  }
}

const allPassing: BootstrapProbes = {
  config: async () => ({ status: "passed", allowlistHandle: OWNER }),
  credentials: async () => ({ status: "passed" }),
  fda: async () => ({ status: "passed" }),
  accessibility: async () => ({ status: "passed" }),
  messages: async () => ({ status: "passed" }),
};

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for inbox cursor");
    }
    await Bun.sleep(10);
  }
}

async function boot(texts: readonly (string | null)[], replay: boolean, sequential = false): Promise<{
  readonly session: SilentSession;
  readonly port: CountingPort;
  readonly stateDb: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-inbox-safety-"));
  directories.push(root);
  const paths = dataPaths(join(root, "home"));
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({ allowlistHandle: OWNER }));
  const chatDbPath = join(paths.home, "Library", "Messages", "chat.db");
  createChatDb(chatDbPath, sequential ? texts.slice(0, 1) : texts);
  if (replay) {
    const seeded = openStateStore(paths.stateDb);
    bindChatCursor(seeded, chatDbPath, 0);
    seeded.close();
  }
  const session = new SilentSession();
  const port = new CountingPort();
  const factory: MainSessionFactory = { create: async () => session };
  const runtime = await startDaemon({
    paths,
    probes: allPassing,
    chatDbPath,
    sender: port,
    mainSessionFactory: factory,
    reprobeIntervalMs: 60_000,
    maintenanceIntervalMs: 60_000,
  });
  try {
    if (sequential) {
      for (let index = 1; index < texts.length; index += 1) {
        await waitFor(() => runtime.store.getChatCursor() === index);
        const database = new Database(chatDbPath);
        try {
          database.query("INSERT INTO message (guid, handle_id, text, is_from_me, date) VALUES (?, 1, ?, 0, ?)")
            .run(`guid-${index + 1}`, texts[index], index);
        } finally {
          database.close();
        }
      }
      await waitFor(() => runtime.store.getChatCursor() === texts.length);
    } else {
      await Bun.sleep(1_500);
    }
  } finally {
    await runtime.stop();
  }
  return { session, port, stateDb: paths.stateDb };
}

/** Streams slowly so later texts arrive mid-turn; records steers. */
class SlowSession implements MainAgentSession {
  public readonly sessionFile = "/tmp/inbox-steer.jsonl";
  public readonly sessionId = "inbox-steer";
  public readonly prompts: string[] = [];
  public readonly steers: string[] = [];
  private listeners = new Set<(event: unknown) => void>();

  public async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    for (const listener of this.listeners) {
      listener({ type: "agent_start" });
      listener({ type: "message_start", message: { role: "user" } });
    }
    await Bun.sleep(1_500);
    for (const listener of this.listeners) {
      listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `answered ${this.prompts.length}+${this.steers.length}` } });
      listener({ type: "message_end", message: { role: "assistant" } });
      listener({ type: "agent_end" });
    }
  }

  public async steer(text: string): Promise<void> {
    this.steers.push(text);
    for (const listener of this.listeners) {
      listener({ type: "message_start", message: { role: "user" } });
    }
  }

  public subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

describe("steering", () => {
  test("texts arriving mid-turn steer the running turn and share its one reply", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-steer-"));
    directories.push(root);
    const paths = dataPaths(join(root, "home"));
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.config, JSON.stringify({ allowlistHandle: OWNER }));
    const chatDbPath = join(paths.home, "Library", "Messages", "chat.db");
    createChatDb(chatDbPath, ["first"]);
    {
      const seeded = openStateStore(paths.stateDb);
      bindChatCursor(seeded, chatDbPath, 0);
      seeded.close();
    }
    const session = new SlowSession();
    const port = new CountingPort();
    const runtime = await startDaemon({
      paths,
      probes: allPassing,
      chatDbPath,
      sender: port,
      mainSessionFactory: { create: async () => session },
      reprobeIntervalMs: 60_000,
      maintenanceIntervalMs: 60_000,
    });
    try {
      await Bun.sleep(400); // first turn is now streaming
      const db = new Database(chatDbPath);
      db.query("INSERT INTO message (guid, handle_id, text, is_from_me, date) VALUES ('guid-2', 1, 'second', 0, 2)").run();
      db.query("INSERT INTO message (guid, handle_id, text, is_from_me, date) VALUES ('guid-3', 1, 'third', 0, 3)").run();
      db.close();
      await Bun.sleep(2_800);
      expect(session.prompts).toHaveLength(1);
      expect(session.prompts[0]!.endsWith("first")).toBe(true);
      expect(session.steers).toEqual(["second", "third"]);
      // One reply for all three, not three.
      expect(port.sent).toBe(1);
      // "typing…" bracketed the single turn.
      expect(port.typing).toEqual([true, true, true, false]);
      // One read receipt per inbound batch (the whole thread is marked).
      expect(port.reads).toBeGreaterThanOrEqual(1);
      expect(port.reads).toBeLessThanOrEqual(3);
    } finally {
      await runtime.stop();
    }
  });
});

describe("inbox safety", () => {
  test("a cursor bound to a different chat.db is re-anchored, never reused", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-cursor-identity-"));
    directories.push(root);
    const { ChatDbReader } = await import("../src/imessage/reader.ts");
    const store = openStateStore(join(root, "state.db"));
    try {
      const first = join(root, "a", "chat.db");
      createChatDb(first, ["a1", "a2"]);
      const events: string[] = [];
      const readerA = new ChatDbReader({ chatDbPath: first, store, onCursorAnchored: (e) => events.push(e.reason) });
      expect(readerA.readNewMessages()).toEqual([]);
      expect(store.getChatCursor()).toBe(2);

      // A different library with more history: the stale cursor (2) would
      // otherwise replay rows 3..5 as fresh prompts.
      const second = join(root, "b", "chat.db");
      createChatDb(second, ["b1", "b2", "b3", "b4", "b5"]);
      const readerB = new ChatDbReader({ chatDbPath: second, store, onCursorAnchored: (e) => events.push(e.reason) });
      expect(readerB.readNewMessages()).toEqual([]);
      expect(store.getChatCursor()).toBe(5);
      expect(events).toEqual(["first_contact", "identity_changed"]);

      // Same library again: no re-anchor, normal reads resume.
      expect(readerB.readNewMessages()).toEqual([]);
      expect(events).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  test("first boot against an existing chat.db never replays history", async () => {
    const { session, port, stateDb } = await boot(["old message one", "old message two", "old message three"], false);
    expect(session.prompts).toEqual([]);
    expect(port.sent).toBe(0);
    const store = openStateStore(stateDb);
    try {
      // Anchored at the newest row, so only later rows will ever be read.
      expect(store.getChatCursor()).toBe(3);
    } finally {
      store.close();
    }
  });

  test("empty and tapback rows never become turns or replies", async () => {
    const { session, port } = await boot(["", null, "   ", "\uFFFC", "\uFFFC\uFFFC", "real question"], true);
    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0]!.endsWith("real question")).toBe(true);
    // The one real turn fails (silent session) and produces exactly one notice.
    expect(port.sent).toBe(1);
  });

  test("a streak of turn failures is capped instead of spamming the owner", async () => {
    const { session, port } = await boot(["q1", "q2", "q3", "q4", "q5", "q6"], true, true);
    expect(session.prompts).toHaveLength(6);
    // AC-7 wants failures visible, but past the breaker they go to the log only.
    // Breaker allows two notices, and each distinct owner turn gets its reply.
    expect(port.sent).toBe(2);
  });
});

/** Emits text → tool call → text → read(image) → final text, like a real agentic turn. */
class AgenticSession implements MainAgentSession {
  public readonly sessionFile = "/tmp/inbox-agentic.jsonl";
  public readonly sessionId = "inbox-agentic";
  public readonly prompts: string[] = [];
  private listeners = new Set<(event: unknown) => void>();

  public async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    const emit = (e: unknown): void => { for (const l of this.listeners) l(e); };
    const say = (t: string): void => emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: t } });
    say("결제 버튼 다시 찾아볼게.");
    emit({ type: "tool_execution_start", toolCallId: "1", toolName: "browser", args: { action: "click" } });
    await Bun.sleep(20);
    say("팝업 떴다. 스크린샷 찍을게.");
    emit({ type: "tool_execution_start", toolCallId: "2", toolName: "read", args: { path: "/tmp/oi-test-shot.png" } });
    await Bun.sleep(20);
    say("전체 페이지 스크린샷 보냈어. 확인되면 알려줘.");
    // Steered follow-up: a second assistant message in the same turn.
    emit({ type: "message_end", message: { role: "assistant" } });
    say("아 그거였구나. 인정.");
    emit({ type: "message_end", message: { role: "assistant" } });
    say("됐고, 시킬 거 있으면 던져.");
  }

  public subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

describe("agentic turn streaming", () => {
  test("each pre-tool text segment is its own message and read(image) is forwarded as an attachment", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-agentic-"));
    directories.push(root);
    const paths = dataPaths(join(root, "home"));
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.config, JSON.stringify({ allowlistHandle: OWNER }));
    const chatDbPath = join(paths.home, "Library", "Messages", "chat.db");
    createChatDb(chatDbPath, ["QR 떴어?"]);
    { const seeded = openStateStore(paths.stateDb); bindChatCursor(seeded, chatDbPath, 0); seeded.close(); }
    writeFileSync("/tmp/oi-test-shot.png", "png");
    const port = new CountingPort();
    const runtime = await startDaemon({
      paths, probes: allPassing, chatDbPath, sender: port,
      mainSessionFactory: { create: async () => new AgenticSession() },
      reprobeIntervalMs: 60_000, maintenanceIntervalMs: 60_000,
    });
    try {
      await Bun.sleep(1_800);
      const store = openStateStore(paths.stateDb);
      const bodies = store.listDeliveries().map((d) => d.kind === "file" ? `FILE:${d.filePath}` : d.body);
      store.close();
      expect(bodies).toEqual([
        "결제 버튼 다시 찾아볼게.",
        "팝업 떴다. 스크린샷 찍을게.",
        "FILE:/tmp/oi-test-shot.png",
        "전체 페이지 스크린샷 보냈어. 확인되면 알려줘.",
        "아 그거였구나. 인정.",
        "됐고, 시킬 거 있으면 던져.",
      ]);
      // A fully segment-streamed turn ends with an empty result text; the
      // exchange still has to reach the daily capture axis, or memory only
      // ever sees explicit notes.
      const daily = readFileSync(join(paths.memory, "daily", `${new Date().toISOString().slice(0, 10)}.md`), "utf8");
      expect(daily).toContain("QR 떴어?");
      expect(daily).toContain("됐고, 시킬 거 있으면 던져.");
    } finally {
      await runtime.stop();
    }
  });
});

describe("watchdog", () => {
  test("is an inactivity timer: a long turn that keeps streaming is not killed", async () => {
    const { MainSession } = await import("../src/sdk-session/main-session.ts");
    const root = mkdtempSync(join(tmpdir(), "openinstinct-watchdog-"));
    directories.push(root);
    const store = openStateStore(join(root, "state.db"));
    let listeners = new Set<(e: unknown) => void>();
    const session: MainAgentSession = {
      sessionFile: "/tmp/wd.jsonl", sessionId: "wd",
      async prompt() {
        // 6 activity beats 100ms apart = 600ms total, watchdog 250ms of silence.
        for (let i = 0; i < 6; i += 1) {
          await Bun.sleep(100);
          for (const l of listeners) l({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "." } });
        }
      },
      subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
    };
    const main = new MainSession({ session, store, workingDirectory: root, factory: { create: async () => session }, watchdogMs: 250 });
    try {
      const result = await main.turn("go");
      expect(result).toEqual({ kind: "reply", text: "......" });
      // And a truly silent turn still dies.
      const silent: MainAgentSession = { sessionFile: "/tmp/s.jsonl", sessionId: "s", async prompt() { await Bun.sleep(1_000); } };
      const main2 = new MainSession({ session: silent, store, workingDirectory: root, factory: { create: async () => silent }, watchdogMs: 250 });
      const dead = await main2.turn("go");
      expect(dead).toMatchObject({ kind: "failed", code: "watchdog_timeout" });
      await main2.stop();
    } finally {
      await main.stop();
      store.close();
    }
  });
});

describe("auto compaction", () => {
  test("compacts after a turn once context usage reaches 50%", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-compact-"));
    directories.push(root);
    const paths = dataPaths(join(root, "home"));
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.config, JSON.stringify({ allowlistHandle: OWNER }));
    const chatDbPath = join(paths.home, "Library", "Messages", "chat.db");
    createChatDb(chatDbPath, ["hi"]);
    { const seeded = openStateStore(paths.stateDb); bindChatCursor(seeded, chatDbPath, 0); seeded.close(); }
    let percent = 20;
    let compactions = 0;
    const listeners = new Set<(e: unknown) => void>();
    const session: MainAgentSession = {
      sessionFile: "/tmp/compact.jsonl", sessionId: "compact",
      async prompt() { for (const l of listeners) l({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ok" } }); },
      subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
      getContextUsage() { return { tokens: percent * 1000, contextWindow: 100_000, percent }; },
      async compact() { compactions += 1; percent = 10; },
    };
    const runtime = await startDaemon({ paths, probes: allPassing, chatDbPath, sender: new CountingPort(), mainSessionFactory: { create: async () => session }, reprobeIntervalMs: 60_000, maintenanceIntervalMs: 60_000 });
    try {
      await Bun.sleep(900);
      expect(compactions).toBe(0);
      percent = 55;
      const db = new Database(chatDbPath);
      db.query("INSERT INTO message (guid, handle_id, text, is_from_me, date) VALUES ('g2', 1, 'again', 0, 2)").run();
      db.close();
      await Bun.sleep(1_200);
      expect(compactions).toBe(1);
    } finally {
      await runtime.stop();
    }
  });
});

describe("owner text during an internal turn", () => {
  test("is steered into the running turn and that turn starts streaming to the owner", async () => {
    const { MainSession } = await import("../src/sdk-session/main-session.ts");
    const root = mkdtempSync(join(tmpdir(), "openinstinct-internal-steer-"));
    directories.push(root);
    const store = openStateStore(join(root, "state.db"));
    const listeners = new Set<(e: unknown) => void>();
    const steers: string[] = [];
    const segments: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const session: MainAgentSession = {
      sessionFile: "/tmp/is.jsonl", sessionId: "is",
      async prompt() {
        const say = (t: string) => { for (const l of listeners) l({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: t } }); };
        for (const l of listeners) l({ type: "agent_start" });
        for (const l of listeners) l({ type: "message_start", message: { role: "user" } });
        say("internal thinking");
        for (const l of listeners) l({ type: "tool_execution_start", toolCallId: "1", toolName: "browser", args: {} });
        await gate;
        say("답: 모니터 보는 중인데 그건 이렇습니다");
        for (const l of listeners) {
          l({ type: "message_end", message: { role: "assistant" } });
          l({ type: "agent_end" });
        }
      },
      async steer(text) {
        steers.push(text);
        for (const l of listeners) l({ type: "message_start", message: { role: "user" } });
      },
      subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
    };
    const main = new MainSession({ session, store, workingDirectory: root, factory: { create: async () => session }, watchdogMs: 5_000, onSegment: (t) => segments.push(t) });
    try {
      const turn = main.turn({ text: "Monitor X produced a result. Relay it." }); // internal: no owner flag
      await Bun.sleep(50);
      expect(main.busy).toBe(false);
      expect(main.running).toBe(true);
      expect(await main.steer({ owner: true, turnId: "internal-steer", text: "야 그거 뭐야" })).toEqual({ kind: "admitted" });
      expect(steers).toEqual(["야 그거 뭐야"]);
      release();
      await turn;
      // Pre-steer internal text stayed silent; post-steer text reached the owner.
      expect(segments).toEqual(["답: 모니터 보는 중인데 그건 이렇습니다"]);
    } finally {
      await main.stop();
      store.close();
    }
  });
});
