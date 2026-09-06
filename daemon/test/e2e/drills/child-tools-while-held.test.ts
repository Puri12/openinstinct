import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChildLifecycle } from "../../../src/children/lifecycle.ts";
import { ChildRegistry } from "../../../src/children/registry.ts";
import { TerminalJournal } from "../../../src/children/terminal-journal.ts";
import { StateStoreChildStatusReader } from "../../../src/children/status.ts";
import { DrillConversationRunner, DrillDeliveryPort, DrillMainSession } from "../../../src/drills/runtime.ts";
import { DeliveryService } from "../../../src/delivery/service.ts";
import {
  MainSession,
  type MainSessionFactory,
} from "../../../src/sdk-session/main-session.ts";
import { createChildNudgeTool, createChildStatusTool } from "../../../src/sdk-session/child-tools.ts";
import { openStateStore, type StateStore } from "../../../src/store/index.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore(): { readonly root: string; readonly store: StateStore } {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-child-tools-held-"));
  directories.push(root);
  return { root, store: openStateStore(join(root, "state.db")) };
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 1_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("timed out waiting for held child");
    await Bun.sleep(2);
  }
}

describe("child-tools-while-held drill", () => {
  test("executes child directives through the real lifecycle while a child turn is held", async () => {
    const { root, store } = createStore();
    const priorMode = process.env.OI_DRILL_MODE;
    const priorHold = process.env.OI_DRILL_HOLD;
    process.env.OI_DRILL_MODE = "1";
    process.env.OI_DRILL_HOLD = "mid-child";
    const conversation = new DrillConversationRunner();
    const lifecycle = new ChildLifecycle({
      registry: new ChildRegistry(store),
      journal: new TerminalJournal(join(root, "journal")),
      runner: { name: "daemon", run: async () => ({ state: "completed", summary: "daemon" }) },
      conversation,
      maxConcurrent: 1,
    });
    const child = lifecycle.delegate({ title: "Held child", prompt: "work", timeoutMs: 60_000 });
    await waitFor(() => store.getChild(child.id)?.state === "running" ? store.getChild(child.id) : undefined);
    const reader = new StateStoreChildStatusReader(store);
    const actions: string[] = [];
    const nudge = createChildNudgeTool({
      nudge: (childId, text, input) => {
        actions.push(`nudge:${childId}:${text}:${input.receipt}`);
        return lifecycle.nudge(childId, text, input);
      },
      release: (childId) => {
        actions.push(`release:${childId}`);
        return lifecycle.release(childId);
      },
      latencyAlertMs: 50,
    });
    const status = createChildStatusTool({ reader, latencyAlertMs: 50, statusListLimit: 20, statusTextMaxBytes: 512 });
    const session = new DrillMainSession(join(root, "drill-main.jsonl"), [status, nudge]);
    const rawEvents: Array<{ readonly event: unknown; readonly at: number }> = [];
    session.subscribe((event) => rawEvents.push({ event, at: Date.now() }));
    const telemetry: Array<{ readonly event: string; readonly fields: Record<string, unknown> }> = [];
    const factory: MainSessionFactory = { create: async () => session };
    const main = new MainSession({ session, store, workingDirectory: root, factory, watchdogMs: 1_000, onEvent: (event, fields) => telemetry.push({ event, fields }) });
    const delivery = new DeliveryService({ store, port: new DrillDeliveryPort(), pollIntervalMs: 5 });
    delivery.start();

    try {
      const heldAt = Date.now();
      const result = await main.turn({
        owner: true,
        turnId: "drill-inbound-1",
        text: `[[tool:child_status {}]] [[tool:child_nudge {"childId":"${child.id}","op":"nudge","text":"hi"}]] [[tool:child_nudge {"childId":"${child.id}","op":"release"}]]`,
      });
      expect(result).toEqual({ kind: "reply", text: "Hermetic drill reply." });
      expect(actions).toEqual([`nudge:${child.id}:hi:false`, `release:${child.id}`]);
      const starts = rawEvents.filter(({ event }) => (event as { readonly type?: string }).type === "tool_execution_start");
      const ends = rawEvents.filter(({ event }) => (event as { readonly type?: string }).type === "tool_execution_end");
      expect(starts).toHaveLength(3);
      expect(ends).toHaveLength(3);
      expect(starts.every(({ at }) => at >= heldAt)).toBe(true);
      expect(ends.map(({ event }) => (event as { readonly result?: { readonly details?: { readonly status?: string } } }).result?.details?.status)).toEqual([undefined, "steered", "cancelling"]);
      const latency = telemetry.filter(({ event }) => event === "tool_latency");
      expect(latency).toHaveLength(3);
      expect(latency.every(({ fields }) => typeof fields.ms === "number" && (fields.ms as number) <= 50 && fields.ownerTurnId === "drill-inbound-1")).toBe(true);
      await waitFor(() => store.getChild(child.id)?.state === "cancelled" ? store.getChild(child.id) : undefined);
      await waitFor(() => lifecycle.activeCount === 0 ? true : undefined);

      const outbound = delivery.admit({ idempotencyKey: "inbound-turn:drill-inbound-1", handle: "+15550000001", text: "Hermetic drill reply." });
      main.notifyTurnDelivered({ turnId: "drill-inbound-1", deliveryId: outbound.id, turnKind: "reply" });
      await delivery.flush();
      expect(store.getDelivery(outbound.id)?.state).toBe("confirmed");
    } finally {
      await delivery.stop();
      await main.stop();
      await lifecycle.stop();
      if (priorMode === undefined) delete process.env.OI_DRILL_MODE; else process.env.OI_DRILL_MODE = priorMode;
      if (priorHold === undefined) delete process.env.OI_DRILL_HOLD; else process.env.OI_DRILL_HOLD = priorHold;
      store.close();
    }
  });
});
