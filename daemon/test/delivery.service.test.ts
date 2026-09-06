import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DeliveryPort, DeliveryReceipt } from "../src/delivery/port.ts";
import { DeliveryService } from "../src/delivery/service.ts";
import { openStateStore, type StateStore } from "../src/store/index.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class ControlledFailure extends Error {
  public constructor(
    public readonly code: string,
    public readonly ambiguous: boolean,
    message = code,
  ) {
    super(message);
  }
}

class FakePort implements DeliveryPort {
  public readonly calls: string[] = [];
  public replyFailure: Error | undefined;
  public textFailure: Error | undefined;
  public fileFailure: Error | undefined;

  public async sendText(handle: string, text: string): Promise<DeliveryReceipt> {
    this.calls.push(`text:${handle}:${text}`);
    if (this.textFailure) {
      throw this.textFailure;
    }
    return { messageId: `text-${this.calls.length}` };
  }

  public async sendReply(messageGuid: string, text: string): Promise<DeliveryReceipt> {
    this.calls.push(`reply:${messageGuid}:${text}`);
    if (this.replyFailure) {
      throw this.replyFailure;
    }
    return { messageId: `reply-${this.calls.length}`, threadId: "thread-1" };
  }

  public async sendFile(handle: string, path: string): Promise<DeliveryReceipt> {
    this.calls.push(`file:${handle}:${path}`);
    if (this.fileFailure) {
      throw this.fileFailure;
    }
    return { messageId: `file-${this.calls.length}` };
  }
}

function createStore(): { readonly store: StateStore; readonly root: string } {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-delivery-"));
  directories.push(root);
  return { root, store: openStateStore(join(root, "state.db")) };
}

describe("DeliveryService", () => {
  test("admits exactly one idempotent text intent and confirms text and image sends", async () => {
    const { store } = createStore();
    const port = new FakePort();
    let now = new Date("2026-01-01T00:00:00.000Z");
    const service = new DeliveryService({ store, port, now: () => now });

    try {
      const admitted = service.admit({
        idempotencyKey: "turn-1",
        handle: "+821012345678",
        text: "first body",
      });
      const duplicate = service.admit({
        idempotencyKey: "turn-1",
        handle: "+821012345678",
        text: "ignored duplicate body",
      });
      const file = service.admit({
        idempotencyKey: "image-1",
        handle: "+821012345678",
        filePath: "/tmp/image.jpg",
      });
      expect(duplicate.id).toBe(admitted.id);
      expect(store.listDeliveries()).toHaveLength(2);

      await service.flush();
      expect(port.calls).toEqual([
        "text:+821012345678:first body",
        "file:+821012345678:/tmp/image.jpg",
      ]);
      expect(store.getDelivery(admitted.id)).toMatchObject({
        state: "confirmed",
        attempts: 1,
        externalMessageId: "text-1",
      });
      expect(store.getDelivery(file.id)).toMatchObject({
        state: "confirmed",
        attempts: 1,
        externalMessageId: "file-2",
      });
    } finally {
      store.close();
    }
  });

  test("uses bounded non-ambiguous retries and marks a timeout ambiguous", async () => {
    const { store } = createStore();
    const port = new FakePort();
    let now = new Date("2026-01-01T00:00:00.000Z");
    const service = new DeliveryService({ store, port, now: () => now });

    try {
      port.textFailure = new ControlledFailure("cli_error", false, "temporary CLI failure");
      const retrying = service.admit({ idempotencyKey: "retry-1", handle: "+821012345678", text: "retry" });
      await service.flush();
      expect(store.getDelivery(retrying.id)).toMatchObject({
        state: "pending",
        attempts: 1,
        nextAttemptAt: "2026-01-01T00:00:05.000Z",
      });

      now = new Date("2026-01-01T00:00:05.000Z");
      await service.flush();
      expect(store.getDelivery(retrying.id)).toMatchObject({
        state: "pending",
        attempts: 2,
        nextAttemptAt: "2026-01-01T00:00:30.000Z",
      });

      now = new Date("2026-01-01T00:00:30.000Z");
      await service.flush();
      expect(store.getDelivery(retrying.id)).toMatchObject({
        state: "expired",
        attempts: 3,
        lastErrorCode: "cli_error",
      });

      port.textFailure = new ControlledFailure("timeout", true, "unknown send outcome");
      const ambiguous = service.admit({ idempotencyKey: "timeout-1", handle: "+821012345678", text: "maybe sent" });
      await service.flush();
      expect(store.getDelivery(ambiguous.id)).toMatchObject({
        state: "failed_ambiguous",
        attempts: 1,
        lastErrorCode: "timeout",
      });
    } finally {
      store.close();
    }
  });

  test("replies are plain flat texts (no reply-to on the scripting bridge)", async () => {
    const { store } = createStore();
    const port = new FakePort();
    const service = new DeliveryService({ store, port, now: () => new Date("2026-01-01T00:00:00.000Z") });
    const quoted = "x".repeat(90);

    try {
      const delivery = service.admit({
        idempotencyKey: "thread-1",
        handle: "+821012345678",
        text: "flat recovery",
        replyToGuid: "origin-guid",
        quotedText: quoted,
      });
      await service.flush();

      expect(port.calls).toEqual(["text:+821012345678:flat recovery"]);
      expect(store.getDelivery(delivery.id)).toMatchObject({
        state: "confirmed",
        degraded: false,
        attempts: 1,
      });
    } finally {
      store.close();
    }
  });

  test("requeues stale inflight rows with a redelivery marker before boot delivery", async () => {
    const { store } = createStore();
    const port = new FakePort();
    let now = new Date("2026-01-01T00:00:00.000Z");
    const service = new DeliveryService({ store, port, now: () => now });

    try {
      const delivery = service.admit({ idempotencyKey: "crash-1", handle: "+821012345678", text: "recover me" });
      expect(store.claimDelivery(delivery.id, now.toISOString())).toMatchObject({ state: "inflight", attempts: 1 });
      now = new Date("2026-01-01T00:05:01.000Z");

      service.start();
      await service.flush();
      await service.stop();
      expect(store.getDelivery(delivery.id)).toMatchObject({
        state: "confirmed",
        redelivered: true,
        attempts: 2,
      });
    } finally {
      store.close();
    }
  });
});

describe("duplicate text suppression", () => {
  test("never suppresses a reply to a distinct owner turn, while deduping background noise", async () => {
    const { store } = createStore();
    const port = new FakePort();
    let clock = new Date("2026-01-01T00:00:00.000Z");
    const service = new DeliveryService({ store, port, now: () => clock });
    try {
      const a = service.admit({ idempotencyKey: "segment:1", handle: "+821012345678", text: "호진이 디엠에 박혀 있습니다." });
      clock = new Date("2026-01-01T00:02:00.000Z");
      const b = service.admit({ idempotencyKey: "inbound-turn:x", handle: "+821012345678", text: "호진이 디엠에 박혀 있습니다.  " });
      clock = new Date("2026-01-01T00:04:00.000Z");
      const c = service.admit({ idempotencyKey: "monitor-event:y", handle: "+821012345678", text: "호진이 디엠에 박혀 있습니다." });
      expect(b.id).not.toBe(a.id);

      expect(c.id).toBe(a.id);
      expect(store.listDeliveries()).toHaveLength(2);
      clock = new Date("2026-01-01T00:15:00.000Z");
      const d = service.admit({ idempotencyKey: "segment:2", handle: "+821012345678", text: "호진이 디엠에 박혀 있습니다." });
      expect(d.id).not.toBe(a.id);
      // images are never deduped by caption
      service.admit({ idempotencyKey: "img:1", handle: "+821012345678", filePath: "/tmp/x.png", caption: "same" });
      service.admit({ idempotencyKey: "img:2", handle: "+821012345678", filePath: "/tmp/x.png", caption: "same" });
      expect(store.listDeliveries()).toHaveLength(5);
    } finally {
      store.close();
    }
  });
});
