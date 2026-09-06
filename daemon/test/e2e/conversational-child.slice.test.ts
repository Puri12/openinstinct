import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChildLifecycle } from "../../src/children/lifecycle.ts";
import { ChildRegistry } from "../../src/children/registry.ts";
import { ReceiptInbox } from "../../src/children/receipts.ts";
import { StateStoreChildStatusReader } from "../../src/children/status.ts";
import {
  createChildNudgeTool,
  createChildStatusTool,
} from "../../src/omo-session/child-tools.ts";
import type { MainTurnResult } from "../../src/omo-session/main-session.ts";
import { TerminalJournal } from "../../src/children/terminal-journal.ts";
import { openStateStore, type StateStore } from "../../src/store/index.ts";
import type { OutboundDelivery } from "../../src/delivery/service.ts";
import { FakeConversationRunner } from "../children/fakes.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class FakeMainSession {
  public ownerDelivery?: (input: { readonly idempotencyKey: string; readonly text: string; readonly childId?: string }) => { readonly id: string };
  public readonly prompts: string[] = [];

  public async turn(prompt: string): Promise<MainTurnResult> {
    this.prompts.push(prompt);
    return { kind: "reply", text: "Owner-facing child update" };
  }

  public admitOwnerReply(input: { readonly idempotencyKey: string; readonly text: string; readonly childId?: string }): { readonly id: string } {
    return this.ownerDelivery?.(input) ?? { id: input.idempotencyKey };
  }
}

class FakeDelivery {
  public readonly outbounds: OutboundDelivery[] = [];

  public admit(outbound: OutboundDelivery): { readonly id: string } {
    if (outbound.authoredBy !== "main_session") {
      throw new Error("owner reply was not authored by MainSession");
    }
    this.outbounds.push(outbound);
    return { id: `delivery-${this.outbounds.length}` };
  }
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 1_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("timed out waiting for conversational slice");
    await Bun.sleep(5);
  }
}

async function execute(tool: any, params: unknown): Promise<any> {
  return await tool.execute("tool-call", params, undefined, {});
}

describe("conversational child slice", () => {
  test("delivers the first turn, warms a nudge, reads status, steers, and releases", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-conversational-slice-"));
    directories.push(root);
    const store: StateStore = openStateStore(join(root, "state.db"));
    const main = new FakeMainSession();
    const delivery = new FakeDelivery();
    main.ownerDelivery = (input) => delivery.admit({ idempotencyKey: input.idempotencyKey, handle: "+821012345678", text: input.text, authoredBy: "main_session", ...(input.childId === undefined ? {} : { childId: input.childId }) });
    const inbox = new ReceiptInbox({ store, mainSession: main });
    const conversation = new FakeConversationRunner();
    const lifecycle = new ChildLifecycle({
      registry: new ChildRegistry(store),
      journal: new TerminalJournal(join(root, "journal")),
      runner: { name: "daemon", run: async () => ({ state: "completed", summary: "daemon" }) },
      conversation,
      onReceipt: (receipt) => inbox.process(receipt),
    });
    const nudgeTool = createChildNudgeTool({
      nudge: (childId, text, input) => lifecycle.nudge(childId, text, input),
      release: (childId) => lifecycle.release(childId),
    });
    const reader = new StateStoreChildStatusReader(store);
    const statusTool = createChildStatusTool({ reader });

    try {
      const child = lifecycle.delegate({ title: "Slice task", prompt: "first" });
      const fake = await waitFor(() => conversation.conversation(child.id));
      await waitFor(() => fake.turns.length === 1 ? fake.turns[0] : undefined);
      fake.complete("first answer");
      await waitFor(() => store.getChild(child.id)?.state === "idle" ? store.getChild(child.id) : undefined);
      await waitFor(() => delivery.outbounds[0]);
      expect(delivery.outbounds[0]).toMatchObject({ idempotencyKey: expect.stringContaining("receipt-follow-up:"), childId: child.id, authoredBy: "main_session" });
      expect(store.getReceiptByIdempotencyKey(`child-turn:${child.id}:1`)).toMatchObject({ state: "delivered" });
      expect(lifecycle.activeCount).toBe(0);

      const second = await execute(nudgeTool as never, { childId: child.id, op: "nudge", text: "second" });
      expect(second.details).toEqual({ childId: child.id, op: "nudge", status: "started", queued: false, receipt: false });
      await waitFor(() => fake.turns.length === 2 ? fake.turns[1] : undefined);
      fake.complete("second answer");
      await waitFor(() => store.getChild(child.id)?.turnSeq === 2 ? store.getChild(child.id) : undefined);
      expect(delivery.outbounds).toHaveLength(1);
      reader.refresh();

      const status = await execute(statusTool as never, { childId: child.id });
      expect(status.details).toMatchObject({ state: "idle", turnSeq: 2, lastAssistantText: "second answer" });

      await execute(nudgeTool as never, { childId: child.id, op: "nudge", text: "third" });
      await waitFor(() => fake.turns.length === 3 ? fake.turns[2] : undefined);
      const steered = await execute(nudgeTool as never, { childId: child.id, op: "nudge", text: "also check this" });
      expect(steered.details.status).toBe("steered");
      expect(fake.steers).toEqual(["also check this"]);
      fake.complete("third answer");
      await waitFor(() => store.getChild(child.id)?.turnSeq === 3 ? store.getChild(child.id) : undefined);

      const released = await execute(nudgeTool as never, { childId: child.id, op: "release" });
      expect(released.details.status).toBe("released");
      await waitFor(() => store.getChild(child.id)?.state === "terminated" ? store.getChild(child.id) : undefined);
      expect(store.getChild(child.id)).toMatchObject({ state: "terminated" });
      reader.refresh();
      const list = await execute(statusTool as never, {});
      expect(list.details.children.some((entry: { readonly childId: string }) => entry.childId === child.id)).toBe(false);
    } finally {
      await lifecycle.stop();
      store.close();
    }
  });
});
