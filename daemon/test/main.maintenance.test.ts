import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BootstrapProbes } from "../src/bootstrap/states.ts";
import type { DeliveryPort, DeliveryReceipt } from "../src/delivery/port.ts";
import { startDaemon } from "../src/main.ts";
import { dataPaths } from "../src/paths.ts";
import type { MainAgentSession, MainSessionFactory } from "../src/omo-session/main-session.ts";
import { openStateStore } from "../src/store/index.ts";
import { requestControl } from "../../scripts/lib/control-client.ts";

const directories: string[] = [];
const OLD = "2026-01-01T00:00:00.000Z";

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class IdleSession implements MainAgentSession {
  public readonly sessionFile = "/tmp/maintenance-main.jsonl";
  public readonly sessionId = "maintenance-main";

  public async prompt(): Promise<void> {}
}

class FakePort implements DeliveryPort {
  public async sendText(): Promise<DeliveryReceipt> {
    return { messageId: "text" };
  }

  public async sendReply(): Promise<DeliveryReceipt> {
    return { messageId: "reply" };
  }

  public async sendFile(): Promise<DeliveryReceipt> {
    return { messageId: "file" };
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
  } finally {
    database.close();
  }
}

describe("main retention wiring", () => {
  test("exposes the running-gated retention run through maintenance.run", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-main-maintenance-"));
    directories.push(root);
    const paths = dataPaths(join(root, "home"));
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.config, JSON.stringify({ allowlistHandle: "+821012345678" }));
    const chatDbPath = join(paths.home, "Library", "Messages", "chat.db");
    createChatDb(chatDbPath);
    const seeded = openStateStore(paths.stateDb);
    seeded.admitDelivery({
      id: "old-delivery",
      idempotencyKey: "old-delivery",
      kind: "text",
      handle: "+821012345678",
      body: "old",
    }, OLD);
    seeded.claimDelivery("old-delivery", OLD);
    seeded.confirmDelivery("old-delivery", { messageId: "old-message" }, OLD);
    seeded.close();

    const probes: BootstrapProbes = {
      config: async () => ({ status: "passed", allowlistHandle: "+821012345678" }),
      credentials: async () => ({ status: "passed" }),
      fda: async () => ({ status: "passed" }),
      accessibility: async () => ({ status: "passed" }),
      messages: async () => ({ status: "passed" }),
    };
    const factory: MainSessionFactory = { create: async () => new IdleSession() };
    const runtime = await startDaemon({
      paths,
      probes,
      chatDbPath,
      sender: new FakePort(),
      mainSessionFactory: factory,
      reprobeIntervalMs: 60_000,
      maintenanceIntervalMs: 60_000,
    });
    try {
      const response = await requestControl(paths.controlSocket, "maintenance.run");
      expect(response.payload).toMatchObject({ ran: true, deliveryLedgerPruned: 1 });
      expect(runtime.store.getDelivery("old-delivery")).toBeUndefined();
    } finally {
      await runtime.stop();
    }
  });
});
