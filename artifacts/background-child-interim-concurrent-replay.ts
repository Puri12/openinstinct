import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { InterimInbox } from "../daemon/src/children/interim.ts";
import { openStateStore } from "../daemon/src/store/index.ts";

const root = mkdtempSync(join(tmpdir(), "openinstinct-red-team-interim-race-"));
const store = openStateStore(join(root, "state.db"));
store.createChild({
  id: "child-1",
  kind: "task_tool",
  priority: "conversational",
  origin: "owner",
  title: "Research",
  prompt: "work",
  timeoutMs: 1_000,
}, "2026-01-01T00:00:00.000Z");
const turnGate = Promise.withResolvers<{ readonly kind: "reply"; readonly text: string }>();
const deliveries: string[] = [];
const delivery = {
  admit: (input: { readonly idempotencyKey: string; readonly handle: string; readonly text: string; readonly childId?: string; readonly authoredBy?: "main_session" }) => {
    const id = `delivery-${deliveries.length + 1}`;
    deliveries.push(input.idempotencyKey);
    store.admitDelivery({
      id,
      idempotencyKey: input.idempotencyKey,
      kind: "text",
      handle: input.handle,
      body: input.text,
      ...(input.childId === undefined ? {} : { childId: input.childId }),
    }, "2026-01-01T00:00:00.000Z");
    return { id };
  },
};
const main = {
  busy: false,
  turns: [] as string[],
  steer: async () => false,
  turn: async (prompt: string) => {
    main.turns.push(prompt);
    return await turnGate.promise;
  },
  admitOwnerReply: (input: { readonly idempotencyKey: string; readonly text: string; readonly childId?: string }) => delivery.admit({
    idempotencyKey: input.idempotencyKey,
    handle: "+821012345678",
    text: input.text,
    authoredBy: "main_session",
    ...(input.childId === undefined ? {} : { childId: input.childId }),
  }),
  onTurnDelivered: () => () => undefined,
};
const inbox = new InterimInbox({ store, mainSession: main, batchMs: 100_000 });
try {
  inbox.admit({ childId: "child-1", title: "Research", text: "one update", toolCallId: "call-1" });
  const flushing = inbox.flush();
  for (let attempt = 0; attempt < 100 && main.turns.length < 1; attempt += 1) await Bun.sleep(1);
  const replaying = inbox.replay();
  for (let attempt = 0; attempt < 100 && main.turns.length < 2; attempt += 1) await Bun.sleep(1);
  const observedTurns = main.turns.length;
  turnGate.resolve({ kind: "reply", text: "owner answer" });
  const outcomes = await Promise.allSettled([flushing, replaying]);
  console.log(JSON.stringify({
    observedTurns,
    deliveryCount: deliveries.filter((key) => key.startsWith("interim-batch:")).length,
    batch: store.listInterimBatches()[0],
    outcomes: outcomes.map((outcome) => outcome.status),
    expected: "one main-session injection per batch id even when replay overlaps an in-flight flush",
    violated: observedTurns !== 1 || deliveries.filter((key) => key.startsWith("interim-batch:")).length !== 1,
  }, null, 2));
} finally {
  inbox.stop();
  store.close();
  rmSync(root, { recursive: true, force: true });
}
