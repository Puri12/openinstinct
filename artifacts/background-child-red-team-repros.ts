import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { OmoConversationRunner } from "../daemon/src/children/runners/omo-conversation.ts";
import { ChildLifecycle } from "../daemon/src/children/lifecycle.ts";
import { ChildRegistry } from "../daemon/src/children/registry.ts";
import { TerminalJournal } from "../daemon/src/children/terminal-journal.ts";
import { openStateStore } from "../daemon/src/store/index.ts";
import { FakeConversationRunner } from "../daemon/test/children/fakes.ts";

class StaleSession {
  public readonly sessionFile = "/tmp/red-team-stale.jsonl";
  public readonly activePromptHandle: unknown = undefined;
  public readonly promptGate = Promise.withResolvers<void>();
  private lastText = "";
  private readonly listeners = new Set<(event: unknown) => void>();

  public async prompt(_text: string): Promise<void> {
    await this.promptGate.promise;
  }
  public subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  public emit(event: unknown): void {
    if (event !== null && typeof event === "object" && (event as { readonly type?: unknown }).type === "message_update") {
      this.lastText = ((event as { readonly assistantMessageEvent?: { readonly delta?: unknown } }).assistantMessageEvent?.delta as string | undefined) ?? this.lastText;
    }
    for (const listener of this.listeners) listener(event);
  }
  public getLastAssistantText(): string {
    return this.lastText;
  }
  public async dispose(): Promise<void> {}
}

async function staleGenerationRepro(): Promise<Record<string, unknown>> {
  const session = new StaleSession();
  const runner = new OmoConversationRunner({
    root: "/tmp/red-team",
    factory: { create: async () => session },
  });
  const conversation = await runner.open({ childId: "stale-child", title: "stale" }, new AbortController().signal);
  const first = conversation.turn("first", new AbortController().signal, () => undefined);
  await Bun.sleep(1);
  session.emit({ type: "agent_start", runToken: "run-1" });
  session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "first-answer" } });
  session.emit({ type: "agent_end", runToken: "run-1", stopReason: "completed" });
  await first;

  const second = conversation.turn("second", new AbortController().signal, () => undefined);
  await Bun.sleep(1);
  session.emit({ type: "agent_start" });
  session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "late-old-text" } });
  session.emit({ type: "agent_end", stopReason: "completed" });
  session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "second-answer" } });
  session.promptGate.resolve();
  const result = await second;
  return {
    scenario: "late tokenless agent_end/message_update after next agent_start",
    observed: result,
    expected: { state: "completed", text: "second-answer" },
    violated: result.text !== "second-answer",
  };
}

async function repeatedAgentStartRepro(): Promise<Record<string, unknown>> {
  const session = new StaleSession();
  const runner = new OmoConversationRunner({
    root: "/tmp/red-team",
    factory: { create: async () => session },
  });
  const conversation = await runner.open({ childId: "repeated-start-child", title: "repeated start" }, new AbortController().signal);
  const turn = conversation.turn("work", new AbortController().signal, () => undefined);
  await Bun.sleep(1);
  session.emit({ type: "agent_start", runToken: "run-1" });
  session.emit({ type: "agent_start", runToken: "maintenance" });
  session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "work-answer" } });
  session.emit({ type: "agent_end", runToken: "run-1", stopReason: "completed" });
  const beforeMaintenanceEnd = await Promise.race([turn.then(() => "settled"), Bun.sleep(20).then(() => "pending")]);
  if (beforeMaintenanceEnd === "pending") {
    session.emit({ type: "agent_end", runToken: "maintenance", stopReason: "completed" });
  }
  const result = await turn;
  return {
    scenario: "second agent_start does not overwrite the captured token",
    beforeMaintenanceEnd,
    observed: result,
    expected: { state: "completed", text: "work-answer" },
    violated: beforeMaintenanceEnd !== "settled" || result.text !== "work-answer",
  };
}

async function admissionCallbackLeakRepro(): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-red-team-cap-"));
  const store = openStateStore(join(root, "state.db"));
  const lifecycle = new ChildLifecycle({
    registry: new ChildRegistry(store),
    journal: new TerminalJournal(join(root, "journal")),
    runner: { name: "daemon", run: async () => ({ state: "completed", summary: "done" }) },
    conversation: new FakeConversationRunner(),
    maxConcurrent: 1,
    maxLive: 1,
  });
  try {
    let callbackError = "";
    try {
      lifecycle.spawnDaemon({
        title: "fenced daemon",
        prompt: "work",
        origin: "monitor",
        onAdmitted: () => { throw new Error("dispatch_fence_lost"); },
      });
    } catch (error) {
      callbackError = error instanceof Error ? error.message : String(error);
    }
    const child = store.listChildren()[0];
    let secondAdmissionError = "";
    let secondAdmissionId: string | undefined;
    try {
      secondAdmissionId = lifecycle.delegate({ title: "replacement", prompt: "work" }).id;
    } catch (error) {
      secondAdmissionError = error instanceof Error ? error.message : String(error);
    }
    return {
      scenario: "spawnDaemon onAdmitted fencing callback throws",
      callbackError,
      observedChild: child === undefined ? undefined : { id: child.id, state: child.state },
      activeCount: lifecycle.activeCount,
      queuedCount: lifecycle.queuedCount,
      liveCount: store.countLiveChildren(),
      secondAdmissionError,
      secondAdmissionId,
      violated: child?.state === "admitted" && lifecycle.activeCount === 0 && lifecycle.queuedCount === 0 && secondAdmissionError === "child_cap_reached",
    };
  } finally {
    await lifecycle.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({ staleGeneration: await staleGenerationRepro(), repeatedAgentStart: await repeatedAgentStartRepro(), admissionCallbackLeak: await admissionCallbackLeakRepro() }, null, 2));
