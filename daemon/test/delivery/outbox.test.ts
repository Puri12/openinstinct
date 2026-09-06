import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DeliveryPort, DeliveryReceipt } from "../../src/delivery/port.ts";
import { OwnerOutbox, type OwnerOutbound } from "../../src/delivery/outbox.ts";
import { DeliveryService } from "../../src/delivery/service.ts";
import { NdjsonLogger } from "../../src/log.ts";
import { openStateStore, type StateStore } from "../../src/store/index.ts";

const directories: string[] = [];
const OWNER_HANDLE = "+821012345678";

class FakePort implements DeliveryPort {
  public readonly reads: string[] = [];
  public readonly typings: Array<{ readonly handle: string; readonly typing: boolean }> = [];

  public async sendText(_handle: string, _text: string): Promise<DeliveryReceipt> {
    return { messageId: "text" };
  }

  public async sendReply(_messageGuid: string, _text: string): Promise<DeliveryReceipt> {
    return { messageId: "reply" };
  }

  public async sendFile(_handle: string, _path: string): Promise<DeliveryReceipt> {
    return { messageId: "file" };
  }

  public async markRead(handle: string): Promise<void> {
    this.reads.push(handle);
  }

  public async setTyping(handle: string, typing: boolean): Promise<void> {
    this.typings.push({ handle, typing });
  }
}

interface Harness {
  readonly root: string;
  readonly store: StateStore;
  readonly service: DeliveryService;
  readonly outbox: OwnerOutbox;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-outbox-"));
  directories.push(root);
  const store = openStateStore(join(root, "state.db"));
  const service = new DeliveryService({ store, port: new FakePort() });
  const outbox = new OwnerOutbox({ logger: new NdjsonLogger(join(root, "daemon.ndjson")) });
  return { root, store, service, outbox };
}

function readLogs(root: string): Record<string, unknown>[] {
  const raw = readFileSync(join(root, "daemon.ndjson"), "utf8").trim();
  return raw.length === 0 ? [] : raw.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

function text(key: string): OwnerOutbound {
  return { idempotencyKey: key, text: "hello" };
}

describe("OwnerOutbox", () => {
  test("a detached binding drops permanently and presence is not forwarded", async () => {
    const { root, store, service, outbox } = createHarness();
    try {
      const binding = outbox.bind("turn-detached");
      expect(binding.attachedAtBind).toBe(false);
      expect(binding.handle).toBeUndefined();
      expect(binding.admit(text("detached-first"))).toBeUndefined();
      expect(await binding.markRead()).toBe(false);
      expect(await binding.setTyping(true)).toBe(false);

      outbox.attach(service, OWNER_HANDLE);
      expect(binding.admit(text("detached-after-attach"))).toBeUndefined();
      expect(await binding.markRead()).toBe(false);
      expect(await binding.setTyping(false)).toBe(false);

      const dropped = readLogs(root).filter((entry) => entry.event === "delivery_skipped_no_imessage_lane");
      expect(dropped).toHaveLength(2);
      expect(dropped).toEqual(expect.arrayContaining([
        expect.objectContaining({
          idempotencyKey: "detached-first",
          kind: "text",
          turnId: "turn-detached",
          reason: "detached_at_turn_start",
          detachReason: "detached",
        }),
        expect.objectContaining({
          idempotencyKey: "detached-after-attach",
          kind: "text",
          turnId: "turn-detached",
          reason: "detached_at_turn_start",
          detachReason: "detached",
        }),
      ]));
    } finally {
      store.close();
    }
  });

  test("an attached binding is invalidated when the lane changes", async () => {
    const { root, store, service, outbox } = createHarness();
    try {
      outbox.attach(service, OWNER_HANDLE);
      const binding = outbox.bind("turn-lane-change");
      const admitted = binding.admit(text("before-detach"));
      expect(admitted).toMatchObject({ handle: OWNER_HANDLE, body: "hello" });
      const boundGeneration = binding.generation;

      outbox.detach("fda_denied");
      outbox.attach(service, "+821012345679");
      expect(binding.admit(text("after-reattach"))).toBeUndefined();
      expect(await binding.markRead()).toBe(false);

      expect(readLogs(root)).toContainEqual(expect.objectContaining({
        event: "delivery_skipped_no_imessage_lane",
        idempotencyKey: "after-reattach",
        kind: "text",
        turnId: "turn-lane-change",
        reason: "lane_changed",
        boundGeneration,
        generation: outbox.generation,
      }));
    } finally {
      store.close();
    }
  });

  test("a live detached admission logs a drop with the current detach reason", () => {
    const { root, store, outbox } = createHarness();
    try {
      outbox.detach("no_owner_handle");
      expect(outbox.admit(text("proactive-detached"))).toBeUndefined();
      expect(readLogs(root)).toContainEqual(expect.objectContaining({
        event: "delivery_skipped_no_imessage_lane",
        idempotencyKey: "proactive-detached",
        kind: "text",
        reason: "detached",
        detachReason: "no_owner_handle",
      }));
    } finally {
      store.close();
    }
  });

  test("an attached binding delegates with its pinned handle and attach is idempotent", async () => {
    const { store, service, outbox } = createHarness();
    try {
      outbox.attach(service, OWNER_HANDLE);
      const generation = outbox.generation;
      const binding = outbox.bind("turn-attached");
      outbox.attach(service, OWNER_HANDLE);

      expect(outbox.generation).toBe(generation);
      expect(outbox.attached).toBe(true);
      expect(outbox.handle).toBe(OWNER_HANDLE);
      expect(binding.admit(text("attached"))).toMatchObject({ handle: OWNER_HANDLE, body: "hello" });
      expect(await binding.markRead()).toBe(true);
      expect(await binding.setTyping(true)).toBe(true);
    } finally {
      store.close();
    }
  });

  test("drop logs derive text, filePath, and segment kinds from owner outbound shape", () => {
    const { root, store, outbox } = createHarness();
    try {
      const binding = outbox.bind("turn-kinds");
      expect(binding.admit({ idempotencyKey: "plain", text: "text" })).toBeUndefined();
      expect(binding.admit({ idempotencyKey: "image", filePath: "/tmp/image.png", caption: "image" })).toBeUndefined();
      expect(binding.admit({ idempotencyKey: "segment:one", text: "segment" })).toBeUndefined();

      expect(readLogs(root).map((entry) => entry.kind)).toEqual(["text", "filePath", "segment"]);
    } finally {
      store.close();
    }
  });
});
