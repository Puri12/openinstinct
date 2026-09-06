import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bindChatCursor, ChatDbReader } from "../../src/imessage/reader.ts";
import { openStateStore } from "../../src/store/index.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createChatDb(root: string): string {
  const messages = join(root, "home", "Library", "Messages");
  mkdirSync(messages, { recursive: true });
  const path = join(messages, "chat.db");
  const db = new Database(path);
  try {
    db.exec(`
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
    db.query("INSERT INTO handle (id) VALUES (?)").run("+821012345678");
    db.query("INSERT INTO chat (guid) VALUES (?)").run("chat-1");
    db.query(`
      INSERT INTO message (guid, handle_id, text, is_from_me, date, thread_originator_guid, associated_message_guid)
      VALUES (?, 1, ?, 0, ?, ?, ?)
    `).run("message-1", "first inbound", 1, "thread-origin", "reply-guid");
    db.query("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1)").run();
    db.query("INSERT INTO attachment (filename, mime_type, transfer_name) VALUES (?, ?, ?)")
      .run("file:///tmp/photo%20one.jpg", "image/jpeg", "photo one.jpg");
    db.query("INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (1, 1)").run();
    db.query("INSERT INTO message (guid, handle_id, text, is_from_me, date) VALUES (?, 1, ?, 1, ?)")
      .run("message-2", "self message", 2);
    db.query("INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 2)").run();
  } finally {
    db.close();
  }
  return path;
}

describe("ChatDbReader", () => {
  test("reads WAL-aware cursor batches with thread and attachment joins", () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-reader-"));
    directories.push(root);
    const chatDbPath = createChatDb(root);
    const store = openStateStore(join(root, "state.db"));

    try {
      const reader = new ChatDbReader({ chatDbPath, store });
      // First contact never replays history: it anchors at the present and
      // returns nothing. Only rows written after that point are prompts.
      expect(reader.readNewMessages()).toEqual([]);
      expect(store.getChatCursor()).toBeGreaterThan(0);
      bindChatCursor(store, chatDbPath, 0);
      const initial = reader.readNewMessages();
      expect(initial).toEqual([
        {
          guid: "message-1",
          rowid: 1,
          senderHandle: "+821012345678",
          text: "first inbound",
          isFromMe: false,
          threadOriginatorGuid: "thread-origin",
          replyToGuid: "reply-guid",
          attachments: [{ path: "/tmp/photo one.jpg", mime: "image/jpeg", transferName: "photo one.jpg" }],
          timestamp: "2001-01-01T00:00:01.000Z",
        },
        {
          guid: "message-2",
          rowid: 2,
          senderHandle: "+821012345678",
          text: "self message",
          isFromMe: true,
          threadOriginatorGuid: undefined,
          replyToGuid: undefined,
          attachments: [],
          timestamp: "2001-01-01T00:00:02.000Z",
        },
      ]);

      reader.advanceCursor(initial.at(-1)!.rowid);
      const db = new Database(chatDbPath);
      try {
        db.query("INSERT INTO message (guid, handle_id, text, is_from_me, date) VALUES (?, 1, ?, 0, ?)")
          .run("message-3", "later", 3);
      } finally {
        db.close();
      }

      expect(reader.readNewMessages().map(({ guid, rowid, text }) => ({ guid, rowid, text }))).toEqual([
        { guid: "message-3", rowid: 3, text: "later" },
      ]);
    } finally {
      store.close();
    }
  });
});

describe("attributedBody decoding", () => {
  test("extracts the NSString body when text is NULL (macOS 13+ rows)", async () => {
    const { decodeAttributedBody } = await import("../../src/imessage/reader.ts");
    const short = Buffer.concat([
      Buffer.from("\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+", "latin1"),
      Buffer.from([Buffer.byteLength("ㅕ안녕")]),
      Buffer.from("ㅕ안녕"),
      Buffer.from("\x86\x84\x02iI\x01\x03", "latin1"),
    ]);
    expect(decodeAttributedBody(short)).toBe("ㅕ안녕");
    const longText = "x".repeat(300);
    const long = Buffer.concat([
      Buffer.from("NSString\x01\x94\x84\x01+\x81", "latin1"),
      Buffer.from([300 & 0xff, 300 >> 8]),
      Buffer.from(longText),
    ]);
    expect(decodeAttributedBody(long)).toBe(longText);
    expect(decodeAttributedBody(null)).toBeUndefined();
    expect(decodeAttributedBody(Buffer.from("garbage"))).toBeUndefined();
  });
});
