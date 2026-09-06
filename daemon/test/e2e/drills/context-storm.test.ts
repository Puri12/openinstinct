import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReceiptInbox, projectTerminalReceipt } from "../../../src/children/receipts.ts";
import { createTerminalReport } from "../../../src/children/terminal-journal.ts";
import { SessionCompaction } from "../../../src/control/compaction.ts";
import type { OutboundDelivery } from "../../../src/delivery/service.ts";
import {
  MainSession,
  type MainAgentSession,
  type MainSessionFactory,
} from "../../../src/sdk-session/main-session.ts";
import { openStateStore, type StateStore } from "../../../src/store/index.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class StormSession implements MainAgentSession {
  public readonly sessionFile = "/tmp/context-storm.jsonl";
  public readonly sessionId = "context-storm";
  public readonly prompts: string[] = [];
  public maxConcurrentPrompts = 0;
  private activePrompts = 0;
  public compactions = 0;
  public compactionError: Error | undefined;
  private readonly listeners = new Set<(event: unknown) => void>();

  public async prompt(prompt: string): Promise<void> {
    this.prompts.push(prompt);
    this.activePrompts += 1;
    this.maxConcurrentPrompts = Math.max(this.maxConcurrentPrompts, this.activePrompts);
    try {
      if (this.prompts.length === 1) {
        this.emit({ type: "auto_compaction_start", reason: "threshold", action: "context-full" });
      }
      await Bun.sleep(1);
      this.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "bounded update" },
      });
      if (this.prompts.length === 1) {
        this.emit({
          type: "auto_compaction_end",
          action: "context-full",
          aborted: false,
          willRetry: false,
        });
      }
    } finally {
      this.activePrompts -= 1;
    }
  }

  public async compact(): Promise<void> {
    if (this.compactionError) {
      throw this.compactionError;
    }
    this.compactions += 1;
    await Bun.sleep(1);
  }

  public subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: unknown): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

class FakeDelivery {
  public readonly outbounds: OutboundDelivery[] = [];

  public admit(outbound: OutboundDelivery): { readonly id: string } {
    this.outbounds.push(outbound);
    return { id: `delivery-${this.outbounds.length}` };
  }
}

function createStore(): { readonly root: string; readonly store: StateStore } {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-context-storm-"));
  directories.push(root);
  return { root, store: openStateStore(join(root, "state.db")) };
}

describe("context-storm drill", () => {
  test("keeps receipt follow-up context bounded while serializing a monitor-heavy burst", async () => {
    const { root, store } = createStore();
    const session = new StormSession();
    const factory: MainSessionFactory = { create: async () => session };
    const compactionEvents: string[] = [];
    const delivery = new FakeDelivery();
    const main = new MainSession({
      session,
      store,
      workingDirectory: root,
      factory,
      watchdogMs: 1_000,
      ownerHandle: "+821012345678",
      ownerDelivery: (input) => delivery.admit({ idempotencyKey: input.idempotencyKey, handle: "+821012345678", text: input.text, ...(input.childId === undefined ? {} : { childId: input.childId }) }),
      onEvent: (event) => compactionEvents.push(event),
    });
    const inbox = new ReceiptInbox({
      store,
      mainSession: main,
    });
    const now = "2026-01-01T00:00:00.000Z";
    const receipts = [];

    try {
      for (let index = 0; index < 64; index += 1) {
        const child = store.createChild({
          id: `storm-${index}`,
          kind: index % 3 === 0 ? "daemon" : "task_tool",
          priority: index % 3 === 0 ? "monitor" : "conversational",
          origin: index % 3 === 0 ? "monitor" : "owner",
          title: `storm task ${index}`,
          prompt: "unused",
          timeoutMs: 1_000,
        }, now);
        const report = createTerminalReport({
          childId: child.id,
          title: child.title,
          state: "completed",
          startedAt: now,
          completedAt: "2026-01-01T00:00:01.000Z",
          summary: `result ${index}: ${"x".repeat(8_000)}`,
        });
        const projection = projectTerminalReceipt(report, `/tmp/${child.id}.json`);
        receipts.push(store.admitReceipt({
          id: `receipt-${index}`,
          childId: child.id,
          idempotencyKey: `child-terminal:${child.id}:${projection.contentHash}`,
          contentHash: projection.contentHash,
          projection: projection.projection,
          artifactPath: `/tmp/${child.id}.json`,
        }, now));
      }

      await Promise.all(receipts.map((receipt) => inbox.process(receipt)));

      expect(session.prompts).toHaveLength(64);
      expect(session.maxConcurrentPrompts).toBe(1);
      expect(Math.max(...session.prompts.map((prompt) => new TextEncoder().encode(prompt).byteLength))).toBeLessThanOrEqual(1_200);
      expect(delivery.outbounds).toHaveLength(64);
      expect(store.listPersistedReceipts()).toHaveLength(0);
      expect(compactionEvents).toEqual(["auto_compaction_start", "auto_compaction_end"]);
    } finally {
      await main.stop();
      store.close();
    }
  });

  test("compacts for real under storm pressure without losing queued turns", async () => {
    const { root, store } = createStore();
    const session = new StormSession();
    const factory: MainSessionFactory = { create: async () => session };
    const main = new MainSession({
      session,
      store,
      workingDirectory: root,
      factory,
      watchdogMs: 1_000,
    });
    const compaction = new SessionCompaction(store);
    compaction.setRunner(() => main.compact());

    try {
      // Queue a turn, then request compaction, then queue another. The queued
      // work must survive and still run: compaction is not allowed to drop it.
      const before = main.turn("before compaction");
      const accepted = compaction.accept("storm-compact");
      expect(accepted.state).toBe("accepted");
      const after = main.turn("after compaction");

      await Promise.all([before, after, compaction.drain()]);

      expect(compaction.status(accepted.operationId)).toEqual({
        operationId: accepted.operationId,
        state: "succeeded",
      });
      expect(session.compactions).toBe(1);
      expect(session.prompts).toEqual(["before compaction", "after compaction"]);
      // Serialization must hold across the compaction boundary too.
      expect(session.maxConcurrentPrompts).toBe(1);
    } finally {
      await main.stop();
      store.close();
    }
  });

  test("reload rebuilds the session over the same transcript and preserves queued turns", async () => {
    const { root, store } = createStore();
    const sessions: StormSession[] = [];
    const factory: MainSessionFactory = { create: async () => { const s = new StormSession(); sessions.push(s); return s; } };
    const first = new StormSession(); sessions.push(first);
    const main = new MainSession({ session: first, store, workingDirectory: root, factory, watchdogMs: 1_000 });
    try {
      const before = main.turn("before reload");
      const reload = main.reload();
      const after = main.turn("after reload");
      await Promise.all([before, reload, after]);
      expect(sessions).toHaveLength(2);
      expect(sessions[0]!.prompts).toEqual(["before reload"]);
      expect(sessions[1]!.prompts).toEqual(["after reload"]);
      expect(store.getMeta("sdk.main_session.id")).toBe(sessions[1]!.sessionId);
    } finally {
      await main.stop();
      store.close();
    }
  });

  test("reports a failed compaction rather than a silent no-op", async () => {
    const { root, store } = createStore();
    const session = new StormSession();
    session.compactionError = Object.assign(new Error("model unavailable"), { code: "model_unavailable" });
    const factory: MainSessionFactory = { create: async () => session };
    const main = new MainSession({
      session,
      store,
      workingDirectory: root,
      factory,
      watchdogMs: 1_000,
    });
    const compaction = new SessionCompaction(store);
    compaction.setRunner(() => main.compact());

    try {
      const accepted = compaction.accept("storm-compact-fail");
      await compaction.drain();
      expect(compaction.status(accepted.operationId)).toEqual({
        operationId: accepted.operationId,
        state: "failed",
        errorCode: "model_unavailable",
      });
      // A failed compaction must leave the session usable.
      await main.turn("still alive");
      expect(session.prompts).toEqual(["still alive"]);
    } finally {
      await main.stop();
      store.close();
    }
  });
});
