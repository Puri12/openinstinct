import { afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { ChildLifecycle } from "../../src/children/lifecycle.ts";
import { ChildRegistry } from "../../src/children/registry.ts";
import { OmoConversationRunner } from "../../src/children/runners/omo-conversation.ts";
import { OmoChildSessionFactory, OmoInProcessRunner } from "../../src/children/runners/omo-inprocess.ts";
import { TerminalJournal } from "../../src/children/terminal-journal.ts";
import {
  openMainSession,
  OmoMainSessionFactory,
} from "../../src/omo-session/main-session.ts";
import { ensureOmoAgentDir } from "../../src/omo-session/omo-runtime.ts";
import { openStateStore, type ReceiptRecord } from "../../src/store/index.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function waitFor<T>(read: () => T | undefined, timeoutMs = 240_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for real delegated child completion");
    }
    await Bun.sleep(250);
  }
}

/**
 * The daemon root whose `omo/` engine dir carries real credentials: OI_REAL_ROOT
 * when set, otherwise a temp root seeded from the host's `~/.omo/agent`.
 */
function realRoot(): string {
  const configured = process.env.OI_REAL_ROOT;
  if (configured) {
    return configured;
  }
  const root = mkdtempSync(join(tmpdir(), "openinstinct-real-session-"));
  directories.push(root);
  const agent = ensureOmoAgentDir(root);
  const hostAgent = join(homedir(), ".omo", "agent");
  for (const [source, target] of [["auth.json", agent.authJson], ["models.json", agent.modelsJson]] as const) {
    const path = join(hostAgent, source);
    if (existsSync(path)) {
      copyFileSync(path, target);
    }
  }
  return root;
}

const runRealSession = process.env.OI_REAL_SESSION === "1" ? test : test.skip;

runRealSession("opens one real omo session and completes a delegate_background child", async () => {
  const root = realRoot();
  const store = openStateStore(join(root, "state.db"));
  const registry = new ChildRegistry(store);
  const journal = new TerminalJournal(join(root, "children", "journal"));
  const model = process.env.OI_REAL_MODEL ?? "anthropic/claude-sonnet-4-5";
  const childFactory = new OmoChildSessionFactory(model, root);
  const runner = new OmoInProcessRunner({ root: join(root, "children"), factory: childFactory });
  const conversation = new OmoConversationRunner({ root: join(root, "children"), factory: childFactory });
  const receipts: ReceiptRecord[] = [];
  const lifecycle = new ChildLifecycle({
    registry,
    journal,
    runner,
    conversation,
    onReceipt: (receipt) => {
      receipts.push(receipt);
    },
  });
  const factory = new OmoMainSessionFactory({
    persona: () => ({ ownerHandle: "+821012345678", imessage: "attached" }),
    chromeProfile: join(root, "chrome-profile"),
    modelPattern: model,
    delegateBackground: (request) => lifecycle.delegate(request),
    sendImage: () => ({ kind: "queued", deliveryId: "unused-in-this-integration" }),
    omoRoot: root,
  });
  const main = await openMainSession({
    store,
    workingDirectory: join(root, "session"),
    factory,
    watchdogMs: 300_000,
  });

  try {
    const turn = await main.turn(
      "Call delegate_background exactly once now with title 'real integration' and prompt 'Reply with exactly CHILD_OK and no other text.' After the tool accepts it, reply exactly DELEGATED.",
    );
    expect(turn).toMatchObject({ kind: "reply" });
    // Pin the engine transcript shape used by the history reader: both standard
    // messages carry numeric timestamps, and tool calls are content blocks.
    expect(main.transcript).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", timestamp: expect.any(Number) }),
      expect.objectContaining({
        role: "assistant",
        timestamp: expect.any(Number),
        content: expect.arrayContaining([
          expect.objectContaining({
            type: "toolCall",
            name: "delegate_background",
            arguments: expect.any(Object),
          }),
        ]),
      }),
    ]));
    const receipt = await waitFor(() => receipts[0]);
    expect(journal.recoverTerminal(receipt.childId)).toMatchObject({ state: "completed" });
    expect(store.getReceipt(receipt.id)).toMatchObject({ state: "persisted" });
  } finally {
    await lifecycle.stop();
    await main.stop();
    store.close();
  }
}, 300_000);
