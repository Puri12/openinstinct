import { describe, expect, test } from "bun:test";

import { OmoConversationRunner } from "../../src/children/runners/omo-conversation.ts";
import type { ChildAgentSession, ChildSessionFactory } from "../../src/children/runners/omo-inprocess.ts";

class FakeSession implements ChildAgentSession {
  public readonly sessionFile = "/tmp/conversation.jsonl";
  public activePromptHandle: unknown = {};
  public readonly listeners = new Set<(event: unknown) => void>();
  public readonly promptGate = Promise.withResolvers<void>();
  public readonly promptCalls: string[] = [];
  public promptResolvesImmediately = false;
  public waitForIdleCalls = 0;
  public waitForIdleError: Error | undefined;
  public abortCalls = 0;
  public lastText = "last assistant text";

  public async prompt(text: string): Promise<void> {
    this.promptCalls.push(text);
    if (this.promptResolvesImmediately) return;
    return this.promptGate.promise;
  }

  public subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async waitForIdle(): Promise<void> {
    this.waitForIdleCalls += 1;
    if (this.waitForIdleError) {
      throw this.waitForIdleError;
    }
  }

  public getLastAssistantText(): string {
    return this.lastText;
  }

  public async abort(): Promise<void> {
    this.abortCalls += 1;
  }

  public emit(event: unknown): void {
    if (event !== null && typeof event === "object" && (event as { readonly type?: unknown }).type === "message_update") {
      const delta = (event as { readonly assistantMessageEvent?: { readonly delta?: unknown } }).assistantMessageEvent?.delta;
      if (typeof delta === "string") {
        this.lastText = delta;
      }
    }
    for (const listener of this.listeners) listener(event);
  }
}

function runnerFor(session: FakeSession, calls: unknown[] = [], events: Array<{ readonly event: string; readonly fields: Record<string, unknown> }> = []): OmoConversationRunner {
  const factory: ChildSessionFactory = {
    create: async (input) => {
      calls.push(input);
      return session;
    },
  };
  return new OmoConversationRunner({ root: "/tmp/children", factory, onEvent: (event, fields) => events.push({ event, fields }) });
}

async function nextTick(): Promise<void> {
  await Bun.sleep(1);
}

describe("OmoConversationRunner", () => {
  test("settles only on a correlated non-maintenance agent_end", async () => {
    const session = new FakeSession();
    const runner = runnerFor(session);
    const conversation = await runner.open({ childId: "child", title: "Child" }, new AbortController().signal);
    const turn = conversation.turn("work", new AbortController().signal, () => undefined);
    let settled = false;
    void turn.then(() => { settled = true; });
    await nextTick();

    session.emit({ type: "agent_start", runToken: "run-1" });
    session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "answer" } });
    session.emit({ type: "agent_end", runToken: "run-1", stopReason: "maintenance", maintenanceOutcome: "completed" });
    await nextTick();
    expect(settled).toBe(false);
    session.emit({ type: "agent_end", runToken: "other", stopReason: "completed" });
    await nextTick();
    expect(settled).toBe(false);
    session.emit({ type: "agent_end", runToken: "run-1", stopReason: "completed" });

    await expect(turn).resolves.toEqual({ state: "completed", text: "answer" });
    session.promptGate.resolve();
  });

  test("uses waitForIdle fallback only after prompt settlement without terminal evidence", async () => {
    const session = new FakeSession();
    session.promptResolvesImmediately = true;
    session.activePromptHandle = undefined;
    const events: Array<{ readonly event: string; readonly fields: Record<string, unknown> }> = [];
    const runner = runnerFor(session, [], events);
    const conversation = await runner.open({ childId: "child", title: "Child" }, new AbortController().signal);

    await expect(conversation.turn("work", new AbortController().signal, () => undefined)).resolves.toEqual({
      state: "completed",
      text: "last assistant text",
    });
    expect(session.waitForIdleCalls).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({ event: "child_turn_settled_without_agent_end" }));
  });

  test("returns agent_failed diagnostics, supports cancellation, and passes a stored session file to the factory", async () => {
    const session = new FakeSession();
    const calls: unknown[] = [];
    const runner = runnerFor(session, calls);
    const conversation = await runner.open({ childId: "child", title: "Child", sessionFile: "/tmp/existing.jsonl" }, new AbortController().signal);
    const failed = conversation.turn("fail", new AbortController().signal, () => undefined);
    await nextTick();
    session.emit({ type: "agent_start", runToken: "run-1" });
    session.emit({ type: "agent_failed", runToken: "run-1", error: { code: "provider_error", message: "provider refused" } });
    await expect(failed).resolves.toEqual({ state: "failed", text: "", errorCode: "provider_error", errorMessage: "provider refused" });
    session.promptGate.resolve();


    const controller = new AbortController();
    const cancelled = conversation.turn("cancel", controller.signal, () => undefined);
    await nextTick();
    session.emit({ type: "agent_start", runToken: "run-2" });
    controller.abort();
    session.emit({ type: "agent_end", runToken: "run-2", stopReason: "cancelled" });
    await expect(cancelled).resolves.toMatchObject({ state: "cancelled", errorCode: "cancelled" });
    expect(session.abortCalls).toBe(1);
    expect(calls).toEqual([expect.objectContaining({ childId: "child", sessionFile: "/tmp/existing.jsonl", conversational: true })]);
  });
  test("does not let a second agent_start overwrite the first token", async () => {
    const session = new FakeSession();
    const runner = runnerFor(session);
    const conversation = await runner.open({ childId: "child", title: "Child" }, new AbortController().signal);
    const turn = conversation.turn("work", new AbortController().signal, () => undefined);
    await nextTick();
    session.emit({ type: "agent_start", runToken: "run-1" });
    session.emit({ type: "agent_start", runToken: "maintenance" });
    session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "work-answer" } });
    session.emit({ type: "agent_end", runToken: "run-1", stopReason: "completed" });
    await expect(turn).resolves.toEqual({ state: "completed", text: "work-answer" });
    session.promptGate.resolve();
  });

  test("ignores tokenless stale terminal/text events and uses the idle fallback", async () => {
    const session = new FakeSession();
    session.activePromptHandle = undefined;
    const events: Array<{ readonly event: string; readonly fields: Record<string, unknown> }> = [];
    const runner = runnerFor(session, [], events);
    const conversation = await runner.open({ childId: "child", title: "Child" }, new AbortController().signal);
    const turn = conversation.turn("work", new AbortController().signal, () => undefined);
    await nextTick();
    session.emit({ type: "agent_start" });
    session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "late-old-text" } });
    session.emit({ type: "agent_end", stopReason: "completed" });
    session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "fresh-text" } });
    session.promptGate.resolve();
    await expect(turn).resolves.toEqual({ state: "completed", text: "fresh-text" });
    expect(events).toContainEqual(expect.objectContaining({ event: "child_turn_settled_without_agent_end" }));
  });

  test("rejects a waitForIdle failure without leaving the turn pending", async () => {
    const session = new FakeSession();
    session.promptResolvesImmediately = true;
    session.activePromptHandle = undefined;
    session.waitForIdleError = new Error("idle check failed");
    const conversation = await runnerFor(session).open({ childId: "child", title: "Child" }, new AbortController().signal);

    await expect(conversation.turn("work", new AbortController().signal, () => undefined)).resolves.toEqual({
      state: "failed",
      text: "",
      errorCode: "child_run_failed",
      errorMessage: "idle check failed",
    });
    expect(session.waitForIdleCalls).toBe(1);
  });

  test("classifies a waitForIdle rejection as cancelled after abort", async () => {
    const session = new FakeSession();
    session.promptResolvesImmediately = true;
    session.activePromptHandle = undefined;
    session.waitForIdleError = new Error("idle check failed");
    const controller = new AbortController();
    controller.abort();
    const conversation = await runnerFor(session).open({ childId: "child", title: "Child" }, new AbortController().signal);

    await expect(conversation.turn("work", controller.signal, () => undefined)).resolves.toMatchObject({
      state: "cancelled",
      errorCode: "cancelled",
    });
  });

  test("rejects a late prior-generation token before binding the current turn", async () => {
    const session = new FakeSession();
    session.promptResolvesImmediately = true;
    const conversation = await runnerFor(session).open({ childId: "child", title: "Child" }, new AbortController().signal);

    const first = conversation.turn("first", new AbortController().signal, () => undefined);
    await nextTick();
    session.emit({ type: "agent_start", runToken: "run-1" });
    session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "first-answer" } });
    session.emit({ type: "agent_end", runToken: "run-1", stopReason: "completed" });
    await expect(first).resolves.toEqual({ state: "completed", text: "first-answer" });

    const second = conversation.turn("second", new AbortController().signal, () => undefined);
    await nextTick();
    session.emit({ type: "agent_start", runToken: "run-1" });
    session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "late-old-text" } });
    session.emit({ type: "agent_end", runToken: "run-1", stopReason: "completed" });
    session.emit({ type: "agent_start", runToken: "run-2" });
    session.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "second-answer" } });
    session.emit({ type: "agent_end", runToken: "run-2", stopReason: "completed" });

    await expect(second).resolves.toEqual({ state: "completed", text: "second-answer" });
  });
});
