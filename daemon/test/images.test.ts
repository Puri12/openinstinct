import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BootstrapProbes } from "../src/bootstrap/states.ts";
import { DeliveryService } from "../src/delivery/service.ts";
import type { DeliveryPort, DeliveryReceipt } from "../src/delivery/port.ts";
import { startDaemon } from "../src/main.ts";
import { dataPaths } from "../src/paths.ts";
import type {
  MainAgentSession,
  MainSessionFactory,
  PromptImage,
} from "../src/sdk-session/main-session.ts";
import { bindChatCursor } from "../src/imessage/reader.ts";
import { openStateStore } from "../src/store/index.ts";

const directories: string[] = [];
const OWNER = "+821012345678";

// 1x1 transparent PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class RecordingSession implements MainAgentSession {
  public readonly sessionFile = "/tmp/images-main.jsonl";
  public readonly sessionId = "images-main";
  public readonly prompts: { text: string; images: readonly PromptImage[] }[] = [];

  public async prompt(text: string, options?: { readonly images?: readonly PromptImage[] }): Promise<void> {
    this.prompts.push({ text, images: options?.images ?? [] });
  }

  public get messages(): unknown {
    return [{ role: "assistant", content: [{ type: "text", text: "ack" }] }];
  }
}

class CapturingPort implements DeliveryPort {
  public readonly texts: { handle: string; body: string }[] = [];
  public readonly files: { handle: string; path: string }[] = [];
  public failFiles = false;

  public async sendText(handle: string, body: string): Promise<DeliveryReceipt> {
    this.texts.push({ handle, body });
    return { messageId: `text-${this.texts.length}` };
  }

  public async sendReply(_guid: string, body: string): Promise<DeliveryReceipt> {
    this.texts.push({ handle: OWNER, body });
    return { messageId: `reply-${this.texts.length}` };
  }

  public async sendFile(handle: string, path: string): Promise<DeliveryReceipt> {
    if (this.failFiles) {
      throw new Error("file was not pasted");
    }
    this.files.push({ handle, path });
    return { messageId: `file-${this.files.length}` };
  }
}

function createChatDb(path: string, attachmentPath: string | undefined, mime: string | undefined): void {
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
    database.query("INSERT INTO handle (id) VALUES (?)").run(OWNER);
    database.query(
      "INSERT INTO message (guid, handle_id, text, is_from_me, date) VALUES (?, 1, ?, 0, 0)",
    ).run("owner-image-guid", "what is in this picture?");
    if (attachmentPath !== undefined) {
      database.query("INSERT INTO attachment (filename, mime_type, transfer_name) VALUES (?, ?, ?)")
        .run(attachmentPath, mime ?? null, "photo.png");
      database.query("INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (1, 1)").run();
    }
  } finally {
    database.close();
  }
}

const allPassing: BootstrapProbes = {
  config: async () => ({ status: "passed", allowlistHandle: OWNER }),
  credentials: async () => ({ status: "passed" }),
  fda: async () => ({ status: "passed" }),
  messages: async () => ({ status: "passed" }),
  accessibility: async () => ({ status: "passed" }),
};

async function runInboundDaemon(
  attachmentPath: string | undefined,
  mime: string | undefined,
): Promise<RecordingSession> {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-image-in-"));
  directories.push(root);
  const paths = dataPaths(join(root, "home"));
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({ allowlistHandle: OWNER }));
  const chatDbPath = join(paths.home, "Library", "Messages", "chat.db");
  createChatDb(chatDbPath, attachmentPath, mime);

  const session = new RecordingSession();
  const factory: MainSessionFactory = { create: async () => session };
  // Tests seed chat.db before boot; opt back into replay so the seeded rows are read.
  {
    const seeded = openStateStore(paths.stateDb);
    bindChatCursor(seeded, chatDbPath, 0);
    seeded.close();
  }
  const runtime = await startDaemon({
    paths,
    probes: allPassing,
    chatDbPath,
    sender: new CapturingPort(),
    mainSessionFactory: factory,
    reprobeIntervalMs: 60_000,
    maintenanceIntervalMs: 60_000,
  });
  try {
    const deadline = Date.now() + 5_000;
    while (session.prompts.length === 0 && Date.now() < deadline) {
      await Bun.sleep(25);
    }
  } finally {
    await runtime.stop();
  }
  return session;
}

describe("AC-9 image ingress", () => {
  test("passes an owner image attachment to the main session as image content", async () => {
    const imageRoot = mkdtempSync(join(tmpdir(), "openinstinct-image-src-"));
    directories.push(imageRoot);
    const imagePath = join(imageRoot, "photo.png");
    writeFileSync(imagePath, Buffer.from(PNG_BASE64, "base64"));

    const session = await runInboundDaemon(imagePath, "image/png");

    expect(session.prompts).toHaveLength(1);
    const [turn] = session.prompts;
    expect(turn!.images).toHaveLength(1);
    expect(turn!.images[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    // The daemon must forward the real bytes, not a path reference.
    expect(turn!.images[0]!.data).toBe(PNG_BASE64);
    expect(turn!.text).toContain("what is in this picture?");
  });

  test("describes an unreadable attachment in text rather than dropping it silently", async () => {
    const session = await runInboundDaemon("/nonexistent/openinstinct/missing.png", "image/png");

    expect(session.prompts).toHaveLength(1);
    const [turn] = session.prompts;
    expect(turn!.images).toHaveLength(0);
    expect(turn!.text).toContain("could not be read");
  });

  test("describes a non-image attachment instead of sending it as an image", async () => {
    const docRoot = mkdtempSync(join(tmpdir(), "openinstinct-image-doc-"));
    directories.push(docRoot);
    const docPath = join(docRoot, "notes.pdf");
    writeFileSync(docPath, "not an image");

    const session = await runInboundDaemon(docPath, "application/pdf");

    expect(session.prompts).toHaveLength(1);
    const [turn] = session.prompts;
    expect(turn!.images).toHaveLength(0);
    expect(turn!.text).toContain("non-image file");
  });
});

describe("AC-9 image egress", () => {
  test("sends an admitted image as a file through the delivery ledger", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-image-out-"));
    directories.push(root);
    const store = openStateStore(join(root, "state.db"));
    const port = new CapturingPort();
    const service = new DeliveryService({ store, port, pollIntervalMs: 5 });
    const record = service.admit({
      idempotencyKey: "outbound-image:one",
      handle: OWNER,
      filePath: "/tmp/chart.png",
      caption: "Here is the chart you asked for.",
    });
    try {
      await service.flush();
      expect(port.files).toEqual([{ handle: OWNER, path: "/tmp/chart.png" }]);
      expect(port.texts).toHaveLength(0);
      expect(store.getDelivery(record.id)?.state).toBe("confirmed");
    } finally {
      store.close();
    }
  });

  test("degrades a failed image send to the caption and marks the row degraded", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-image-degrade-"));
    directories.push(root);
    const store = openStateStore(join(root, "state.db"));
    const port = new CapturingPort();
    port.failFiles = true;
    const service = new DeliveryService({ store, port, pollIntervalMs: 5 });
    const record = service.admit({
      idempotencyKey: "outbound-image:degrade",
      handle: OWNER,
      filePath: "/tmp/chart.png",
      caption: "Here is the chart you asked for.",
    });
    try {
      await service.flush();
      expect(port.files).toHaveLength(0);
      expect(port.texts).toEqual([{ handle: OWNER, body: "Here is the chart you asked for." }]);
      const settled = store.getDelivery(record.id);
      expect(settled?.state).toBe("confirmed");
      // A pasted-attachment failure must never look like a clean image send.
      expect(settled?.degraded).toBe(true);
    } finally {
      store.close();
    }
  });
});
