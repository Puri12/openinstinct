import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InterimInbox, type InterimDeliveryAdmitter, type InterimTurnDelivery, type InterimTurner } from "../../../src/children/interim.ts";
import { DrillDeliveryPort, DrillMainSession } from "../../../src/drills/runtime.ts";
import { DeliveryService } from "../../../src/delivery/service.ts";
import {
  MainSession,
  type MainTurnInput,
  type MainSessionFactory,
} from "../../../src/omo-session/main-session.ts";
import { openStateStore, type StateStore } from "../../../src/store/index.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore(): { readonly root: string; readonly store: StateStore } {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-mid-interim-batch-"));
  directories.push(root);
  return { root, store: openStateStore(join(root, "state.db")) };
}

describe("mid-interim-batch drill", () => {
  test("replays an injected-before-main-call batch once after a simulated process kill", async () => {
    const { root, store } = createStore();
    const child = store.createChild({
      id: "drill-interim-child",
      kind: "task_tool",
      priority: "conversational",
      origin: "owner",
      title: "Interim child",
      prompt: "unused",
      timeoutMs: 60_000,
    }, "2026-01-01T00:00:00.000Z");
    store.markChildAdmitted(child.id, "2026-01-01T00:00:00.000Z");
    store.markQueuedChildTerminated(child.id, "released", "2026-01-01T00:00:00.000Z");
    store.admitInterimMessage({
      id: "drill-message",
      childId: child.id,
      idempotencyKey: "interim:drill-interim-child:seed",
      body: "The batch was interrupted after injection.",
      truncated: false,
    }, "2026-01-01T00:00:00.000Z");
    const assigned = store.assignInterimBatch("2026-01-01T00:00:01.000Z")!.batch;
    const injected = store.markInterimBatchInjected(assigned.id, "turn", "2026-01-01T00:00:02.000Z");
    expect(injected).toMatchObject({ state: "injected", attempt: 1 });

    const session = new DrillMainSession(join(root, "drill-main.jsonl"), []);
    const delivery = new DeliveryService({ store, port: new DrillDeliveryPort(), pollIntervalMs: 5 });
    const factory: MainSessionFactory = { create: async () => session };
    const main = new MainSession({
      session,
      store,
      workingDirectory: root,
      factory,
      watchdogMs: 1_000,
      ownerHandle: "+15550000001",
      ownerDelivery: (outbound) => delivery.admit(outbound),
    });

    const interimSession: InterimTurner & InterimDeliveryAdmitter = {
      get busy() {
        return main.busy;
      },
      steer: async (input: MainTurnInput): Promise<boolean> => (await main.steer(input)).kind === "admitted",
      turn: (prompt: string) => main.turn(prompt),
      onTurnDelivered: (listener: (delivery: InterimTurnDelivery) => void) => main.onTurnDelivered(listener),
      currentOwnerTurnId: () => main.currentOwnerTurnId(),
      transcriptContains: (marker: string) => main.transcriptContains(marker),
      get messages() {
        return main.messages;
      },
      admitOwnerReply: (input) => main.admitOwnerReply(input),
    };
    const events: Array<{ readonly event: string; readonly fields: Record<string, unknown> }> = [];
    const restarted = new InterimInbox({
      store,
      mainSession: interimSession,
      onEvent: (event, fields) => events.push({ event, fields }),
    });
    delivery.start();

    try {
      await restarted.replay();
      await delivery.flush();
      const batches = store.listInterimBatches();
      expect(batches).toHaveLength(1);
      expect(batches[0]).toMatchObject({ id: assigned.id, state: "delivered", attempt: 2, outcome: "owner_text" });
      const deliveries = store.listDeliveries().filter((entry) => entry.idempotencyKey === `interim-batch:${assigned.id}`);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.state).toBe("confirmed");
      expect(events.filter(({ event }) => event === "interim_replayed")).toEqual([
        expect.objectContaining({ fields: expect.objectContaining({ batchId: assigned.id, attempt: 2 }) }),
      ]);
      expect(JSON.stringify(session.messages)).toContain(`[interim-batch ${assigned.id}]`);
    } finally {
      restarted.stop();
      await delivery.stop();
      await main.stop();
      store.close();
    }
  });
});
