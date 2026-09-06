import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChildRegistry } from "../../src/children/registry.ts";
import { projectTerminalReceipt, ReceiptInbox } from "../../src/children/receipts.ts";
import { createTerminalReport, TerminalJournal } from "../../src/children/terminal-journal.ts";
import type { OutboundDelivery } from "../../src/delivery/service.ts";
import type { MainTurnResult } from "../../src/omo-session/main-session.ts";
import { openStateStore, type StateStore } from "../../src/store/index.ts";

const directories: string[] = [];
const OWNER = "+821012345678";


afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class FakeMainSession {
  public ownerDelivery?: (input: { readonly idempotencyKey: string; readonly text: string; readonly childId?: string }) => { readonly id: string };
  public readonly prompts: string[] = [];

  public constructor(private readonly result: MainTurnResult = { kind: "reply", text: "Owner-facing result" }) {}

  public async turn(prompt: string): Promise<MainTurnResult> {
    this.prompts.push(prompt);
    return this.result;
  }

  public admitOwnerReply(input: { readonly idempotencyKey: string; readonly text: string; readonly childId?: string }): { readonly id: string } {
    return this.ownerDelivery?.(input) ?? { id: input.idempotencyKey };
  }
}

class ScriptedMainSession {
  public ownerDelivery?: (input: { readonly idempotencyKey: string; readonly text: string; readonly childId?: string }) => { readonly id: string };
  public readonly prompts: string[] = [];
  private index = 0;

  public constructor(private readonly replies: readonly string[]) {}

  public async turn(prompt: string): Promise<MainTurnResult> {
    this.prompts.push(prompt);
    return { kind: "reply", text: this.replies[this.index++] ?? "[[no-owner-message]]" };
  }

  public admitOwnerReply(input: { readonly idempotencyKey: string; readonly text: string; readonly childId?: string }): { readonly id: string } {
    return this.ownerDelivery?.(input) ?? { id: input.idempotencyKey };
  }
}

class CapturingDelivery {
  public readonly outbounds: OutboundDelivery[] = [];

  public admit(outbound: OutboundDelivery): { readonly id: string } {
    this.outbounds.push(outbound);
    return { id: `delivery-${this.outbounds.length}` };
  }
}


class RetryDelivery {
  public readonly outbounds: OutboundDelivery[] = [];

  public constructor(private fail = true) {}

  public admit(outbound: OutboundDelivery): { readonly id: string } {
    if (this.fail) {
      this.fail = false;
      throw new Error("delivery admission interrupted");
    }
    this.outbounds.push(outbound);
    return { id: `delivery-${this.outbounds.length}` };
  }
}
function wireOwnerDelivery(
  session: { ownerDelivery?: (input: { readonly idempotencyKey: string; readonly text: string; readonly childId?: string }) => { readonly id: string } },
  delivery: { admit(outbound: OutboundDelivery): { readonly id: string } },
): void {
  session.ownerDelivery = (input) => delivery.admit({
    idempotencyKey: input.idempotencyKey,
    handle: OWNER,
    text: input.text,
    authoredBy: "main_session",
    ...(input.childId === undefined ? {} : { childId: input.childId }),
  });
}


function createStore(): { readonly root: string; readonly store: StateStore } {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-receipts-"));
  directories.push(root);
  return { root, store: openStateStore(join(root, "state.db")) };
}

function createTimeoutReceipt(
  store: StateStore,
  id: string,
  state: "timeout" | "failed" = "timeout",
): { readonly childId: string; readonly receiptId: string } {
  const now = "2026-01-01T00:00:00.000Z";
  const childId = `${id}-child`;
  const receiptId = `${id}-receipt`;
  store.createChild({
    id: childId,
    kind: "task_tool",
    priority: "conversational",
    origin: "owner",
    title: "Timed out work",
    prompt: "Keep working",
    timeoutMs: 1_000,
  }, now);
  store.markChildTerminal(childId, {
    state,
    journalPath: `/tmp/${id}.jsonl`,
    terminalChecksum: "a".repeat(64),
    terminalSummary: "child became inactive",
    errorCode: "child_timeout",
  }, now);
  store.admitReceipt({
    id: receiptId,
    childId,
    idempotencyKey: `child-terminal:${childId}:timeout`,
    contentHash: "b".repeat(64),
    projection: `raw timeout projection ${id} (child_timeout)`,
  }, now);
  return { childId, receiptId };
}

describe("background receipts", () => {
  test("bounds UTF-8 projections and dedupes journal recovery by child id plus content hash", () => {
    const { root, store } = createStore();
    const registry = new ChildRegistry(store);
    const journal = new TerminalJournal(join(root, "journal"));
    const child = registry.register({
      kind: "task_tool",
      priority: "conversational",
      origin: "owner",
      title: "Long result",
      prompt: "result",
      timeoutMs: 1_000,
    });
    registry.markAdmitted(child.id);
    registry.markRunning(child.id);
    const report = createTerminalReport({
      childId: child.id,
      title: child.title,
      state: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
      summary: "🧪".repeat(2_000),
    });

    try {
      const journalPath = journal.writeTerminal(report);
      const projection = projectTerminalReceipt(report, journalPath);
      const first = registry.admitTerminal(report, journalPath);
      const second = registry.admitTerminal(report, journalPath);

      expect(new TextEncoder().encode(projection.projection).byteLength).toBeLessThanOrEqual(1_024);
      expect(projection.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(second.receipt.id).toBe(first.receipt.id);
      expect(store.listPersistedReceipts()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("replays a completed-but-undelivered receipt after boot", async () => {
    const { store } = createStore();
    const now = "2026-01-01T00:00:00.000Z";
    const child = store.createChild({
      id: "replay-child",
      kind: "task_tool",
      priority: "conversational",
      origin: "owner",
      title: "Replay",
      prompt: "result",
      timeoutMs: 1_000,
    }, now);
    const receipt = store.admitReceipt({
      id: "replay-receipt",
      childId: child.id,
      idempotencyKey: "child-terminal:replay-child:hash",
      contentHash: "b".repeat(64),
      projection: "Background task “Replay” completed: durable output.",
      artifactPath: "/tmp/replay-child.json",
    }, now);
    const delivery = new RetryDelivery();
    const firstSession = new FakeMainSession();
    wireOwnerDelivery(firstSession, delivery);
    const firstBoot = new ReceiptInbox({
      store,
      mainSession: firstSession,
    });

    try {
      await firstBoot.drain();
      expect(store.getReceipt(receipt.id)).toMatchObject({ state: "persisted" });

      const restartedSession = new FakeMainSession();
      wireOwnerDelivery(restartedSession, delivery);
      const restartedInbox = new ReceiptInbox({
        store,
        mainSession: restartedSession,
      });
      await restartedInbox.drain();

      expect(restartedSession.prompts).toHaveLength(1);
      expect(delivery.outbounds).toEqual([{
        idempotencyKey: "receipt-follow-up:replay-receipt",
        handle: OWNER,
        authoredBy: "main_session",
        text: "Owner-facing result",
        childId: "replay-child",
      }]);
      expect(store.getReceipt(receipt.id)).toMatchObject({ state: "delivered" });
    } finally {
      store.close();
    }
  });

  test("routes a timeout receipt through the main session and delivers only its authored reply", async () => {
    const { store } = createStore();
    const { childId, receiptId } = createTimeoutReceipt(store, "timeout-success");
    const session = new FakeMainSession({ kind: "reply", text: "The child stopped responding; I recovered the work." });
    const delivery = new RetryDelivery(false);
    wireOwnerDelivery(session, delivery);
    const inbox = new ReceiptInbox({
      store,
      mainSession: session,
    });

    try {
      await inbox.process(store.getReceipt(receiptId)!);
      expect(session.prompts).toHaveLength(1);
      expect(session.prompts[0]).toContain("Background task timed out from inactivity");
      expect(session.prompts[0]).toContain("First triage");
      expect(session.prompts[0]).toContain("child_timeout");
      expect(delivery.outbounds).toEqual([{
        idempotencyKey: `receipt-follow-up:${receiptId}`,
        handle: OWNER,
        authoredBy: "main_session",
        text: "The child stopped responding; I recovered the work.",
        childId,
      }]);
      expect(delivery.outbounds[0]?.text).not.toContain("raw timeout projection");
      expect(store.getReceipt(receiptId)).toMatchObject({ state: "delivered" });
    } finally {
      store.close();
    }
  });

  test("settles a timeout receipt without outbound when the main session is silent", async () => {
    const { store } = createStore();
    const { receiptId } = createTimeoutReceipt(store, "timeout-silent", "failed");
    const session = new FakeMainSession({ kind: "reply", text: " [[no-owner-message]] " });
    const delivery = new RetryDelivery(false);
    wireOwnerDelivery(session, delivery);
    const inbox = new ReceiptInbox({
      store,
      mainSession: session,
    });

    try {
      await inbox.process(store.getReceipt(receiptId)!);
      expect(session.prompts).toHaveLength(1);
      expect(delivery.outbounds).toHaveLength(0);
      expect(store.getReceipt(receiptId)).toMatchObject({ state: "delivered" });
    } finally {
      store.close();
    }
  });

  test("keeps a timeout receipt persisted when the main session turn fails", async () => {
    const { store } = createStore();
    const { receiptId } = createTimeoutReceipt(store, "timeout-failed");
    const session = new FakeMainSession({ kind: "failed", code: "watchdog_timeout", message: "main session unavailable" });
    const delivery = new RetryDelivery(false);
    wireOwnerDelivery(session, delivery);
    const events: string[] = [];
    const inbox = new ReceiptInbox({
      store,
      mainSession: session,
      onEvent: (event) => events.push(event),
    });

    try {
      await inbox.process(store.getReceipt(receiptId)!);
      expect(session.prompts).toHaveLength(1);
      expect(delivery.outbounds).toHaveLength(0);
      expect(store.getReceipt(receiptId)).toMatchObject({ state: "persisted" });
      expect(events).toContain("follow_up_retry_scheduled");
    } finally {
      store.close();
    }
  });

  test("stopping clears a scheduled retry so only a restarted inbox drains the receipt", async () => {
    const { store } = createStore();
    const { receiptId } = createTimeoutReceipt(store, "stop-retry");
    const firstSession = new FakeMainSession({ kind: "failed", code: "provider_error", message: "main session unavailable" });
    const firstInbox = new ReceiptInbox({ store, mainSession: firstSession });
    try {
      await firstInbox.process(store.getReceipt(receiptId)!);
      firstInbox.stop();
      await Bun.sleep(1_050);
      expect(firstSession.prompts).toHaveLength(1);

      const restartedSession = new FakeMainSession();
      const delivery = new RetryDelivery(false);
      wireOwnerDelivery(restartedSession, delivery);
      const restartedInbox = new ReceiptInbox({ store, mainSession: restartedSession });
      await restartedInbox.drain();
      restartedInbox.stop();

      expect(restartedSession.prompts).toHaveLength(1);
      expect(delivery.outbounds).toHaveLength(1);
      expect(store.getReceipt(receiptId)).toMatchObject({ state: "delivered" });
    } finally {
      store.close();
    }
  });
  test("keeps every background receipt persisted when its main-session turn fails", async () => {
    const { store } = createStore();
    const now = "2026-01-01T00:00:00.000Z";
    const child = store.createChild({
      id: "normal-failure-child",
      kind: "task_tool",
      priority: "conversational",
      origin: "owner",
      title: "Normal failure",
      prompt: "work",
      timeoutMs: 1_000,
    }, now);
    const receipt = store.admitReceipt({
      id: "normal-failure-receipt",
      childId: child.id,
      idempotencyKey: "child-terminal:normal-failure:hash",
      contentHash: "d".repeat(64),
      projection: "raw background failure must not be delivered",
    }, now);
    const session = new FakeMainSession({ kind: "failed", code: "provider_error", message: "unavailable" });
    const delivery = new RetryDelivery(false);
    wireOwnerDelivery(session, delivery);
    const events: string[] = [];
    const inbox = new ReceiptInbox({
      store,
      mainSession: session,
      onEvent: (event) => events.push(event),
    });

    try {
      await inbox.process(receipt);
      expect(session.prompts).toHaveLength(1);
      expect(delivery.outbounds).toHaveLength(0);
      expect(store.getReceipt(receipt.id)).toMatchObject({ state: "persisted" });
      expect(events).toContain("follow_up_retry_scheduled");
    } finally {
      store.close();
    }
  });

  test("skips monitor-routed receipts without spinning the durable replay drain", async () => {
    const { store } = createStore();
    const now = "2026-01-01T00:00:00.000Z";
    const child = store.createChild({
      id: "monitor-child",
      kind: "daemon",
      priority: "monitor",
      origin: "monitor",
      title: "Monitor",
      prompt: "work",
      timeoutMs: 1_000,
    }, now);
    store.admitReceipt({
      id: "monitor-receipt",
      childId: child.id,
      idempotencyKey: "child-terminal:monitor-child:hash",
      contentHash: "c".repeat(64),
      projection: "Monitor receipt.",
    }, now);
    const session = new FakeMainSession();
    const inbox = new ReceiptInbox({
      store,
      mainSession: session,
    });

    try {
      await inbox.drain();
      expect(session.prompts).toHaveLength(0);
      expect(store.listPersistedReceipts()).toHaveLength(1);
    } finally {
      store.close();
    }
  });
  test("triages owner orphan receipts without exposing raw state, code, stack, or projection", async () => {
    const { store } = createStore();
    const registry = new ChildRegistry(store);
    const makeReceipt = (id: string) => {
      const child = registry.register({
        kind: "task_tool",
        priority: "conversational",
        origin: "owner",
        title: `Task ${id}`,
        prompt: "work",
        timeoutMs: 1_000,
      });
      registry.markAdmitted(child.id);
      registry.markRunning(child.id);
      return registry.admitOrphanReceipt(child, "session_file_missing").receipt;
    };
    const rawReceipt = makeReceipt("raw");
    const safeReceipt = makeReceipt("safe");
    const silentReceipt = makeReceipt("silent");
    const main = new ScriptedMainSession([
      rawReceipt.projection,
      "The saved task could not resume; please choose whether to retry it.",
      "[[no-owner-message]]",
    ]);
    const delivery = new CapturingDelivery();
    wireOwnerDelivery(main, delivery);
    const inbox = new ReceiptInbox({ store, mainSession: main });

    try {
      await inbox.drain();
      expect(delivery.outbounds).toHaveLength(1);
      expect(delivery.outbounds[0]?.text).toBe("The saved task could not resume; please choose whether to retry it.");
      expect(delivery.outbounds[0]?.text).not.toContain("orphaned");
      expect(delivery.outbounds[0]?.text).not.toContain("session_file_missing");
      expect(delivery.outbounds[0]?.text).not.toContain("stack");
      expect(delivery.outbounds[0]?.text).not.toContain(rawReceipt.projection);
      expect(store.getReceipt(rawReceipt.id)?.state).toBe("delivered");
      expect(store.getReceipt(safeReceipt.id)?.state).toBe("delivered");
      expect(store.getReceipt(silentReceipt.id)?.state).toBe("delivered");
    } finally {
      store.close();
    }
  });
  test("leaves twice-unsafe main triage retryable without an outbound fallback", async () => {
    const { store } = createStore();
    const registry = new ChildRegistry(store);
    const child = registry.register({ kind: "task_tool", priority: "conversational", origin: "owner", title: "Retry task", prompt: "work", timeoutMs: 1_000 });
    registry.markAdmitted(child.id);
    registry.markRunning(child.id);
    const receipt = registry.admitOrphanReceipt(child, "session_file_missing").receipt;
    const main = new ScriptedMainSession(["orphaned session_file_missing", "still provider_error at /tmp/secret"]);
    const delivery = new CapturingDelivery();
    wireOwnerDelivery(main, delivery);
    const inbox = new ReceiptInbox({ store, mainSession: main });
    try {
      await inbox.process(receipt);
      expect(store.getReceipt(receipt.id)?.state).toBe("persisted");
      expect(delivery.outbounds).toHaveLength(0);
      await inbox.drain();
      expect(delivery.outbounds).toHaveLength(0);
    } finally {
      store.close();
    }
  });
  test("rejects orphan reasons, paths, raw state tokens, and full projections without owner delivery", async () => {
    const { store } = createStore();
    const registry = new ChildRegistry(store);
    const cases = [
      "session_file_missing",
      "/tmp/private/journal-path.jsonl",
      "timeout",
      "Background task “Unsafe” completed: sensitive output (provider_error) [journal: /tmp/private/journal-path.jsonl]",
    ];
    const replies = cases.flatMap((value) => [value, value]);
    const main = new ScriptedMainSession(replies);
    const delivery = new CapturingDelivery();
    wireOwnerDelivery(main, delivery);
    const inbox = new ReceiptInbox({ store, mainSession: main });
    const receipts = cases.map((projection, index) => {
      const child = registry.register({ kind: "task_tool", priority: "conversational", origin: "owner", title: `Unsafe ${index}`, prompt: "work", timeoutMs: 1_000 });
      return store.admitReceipt({
        id: `unsafe-receipt-${index}`,
        childId: child.id,
        idempotencyKey: `unsafe-receipt:${index}`,
        contentHash: `${index}`.padEnd(64, "a"),
        projection,
      }, "2026-01-01T00:00:00.000Z");
    });
    try {
      for (const receipt of receipts) {
        await inbox.process(receipt);
        expect(store.getReceipt(receipt.id)?.state).toBe("persisted");
      }
      expect(delivery.outbounds).toHaveLength(0);
      expect(main.prompts).toHaveLength(cases.length * 2);
    } finally {
      store.close();
    }
  });
  test("permits safe prose that merely contains a non-sensitive underscore phrase", async () => {
    const { store } = createStore();
    const registry = new ChildRegistry(store);
    const child = registry.register({ kind: "task_tool", priority: "conversational", origin: "owner", title: "Safe prose", prompt: "work", timeoutMs: 1_000 });
    const receipt = store.admitReceipt({
      id: "safe-prose-receipt",
      childId: child.id,
      idempotencyKey: "safe-prose-receipt",
      contentHash: "e".repeat(64),
      projection: "Background task update: useful findings.",
    }, "2026-01-01T00:00:00.000Z");
    const main = new ScriptedMainSession(["The long_term plan is ready for review."]);
    const delivery = new CapturingDelivery();
    wireOwnerDelivery(main, delivery);
    const inbox = new ReceiptInbox({ store, mainSession: main });
    try {
      await inbox.process(receipt);
      expect(delivery.outbounds).toHaveLength(1);
      expect(delivery.outbounds[0]?.text).toBe("The long_term plan is ready for review.");
      expect(store.getReceipt(receipt.id)?.state).toBe("delivered");
    } finally {
      store.close();
    }
  });
});
