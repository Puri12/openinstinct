import type {
  ChildConversation,
  ChildReport,
  ChildReportOutcome,
  ChildTurnResult,
  ConversationalChildRunner,
} from "../../src/children/conversation.ts";
import type { InterimTurnDelivery, InterimTurner } from "../../src/children/interim.ts";
import type { MainTurnInput, MainTurnResult } from "../../src/sdk-session/main-session.ts";

export class Deferred<T> {
  public readonly promise: Promise<T>;
  private readonly deferred = Promise.withResolvers<T>();

  public constructor() {
    this.promise = this.deferred.promise;
  }

  public resolve(value: T): void {
    this.deferred.resolve(value);
  }

  public reject(reason: unknown): void {
    this.deferred.reject(reason);
  }
}

export interface FakeConversationRunnerOptions {
  readonly sessionFile?: string;
  readonly promptHash?: string;
  readonly autoResult?: ChildTurnResult;
}

export class FakeConversationRunner implements ConversationalChildRunner {
  public readonly name = "fake-conversation";
  public readonly opens: Array<{
    readonly childId: string;
    readonly title: string;
    readonly sessionFile?: string;
    readonly onReport?: (report: ChildReport) => ChildReportOutcome;
  }> = [];
  public readonly conversations = new Map<string, FakeConversation>();

  public openGate: Deferred<void> | undefined;
  public constructor(private readonly options: FakeConversationRunnerOptions = {}) {}

  public async open(input: {
    readonly childId: string;
    readonly title: string;
    readonly sessionFile?: string;
    readonly onReport?: (report: ChildReport) => ChildReportOutcome;
  }): Promise<ChildConversation> {
    this.opens.push(input);
    const gate = this.openGate;
    if (gate) {
      await gate.promise;
    }
    const conversation = new FakeConversation(input.childId, input.sessionFile ?? this.options.sessionFile, this.options.autoResult, this.options.promptHash);
    this.conversations.set(input.childId, conversation);
    return conversation;
  }

  public conversation(childId: string): FakeConversation | undefined {
    return this.conversations.get(childId);
  }
}

export class FakeConversation implements ChildConversation {
  public readonly steers: string[] = [];
  public readonly turns: Array<{
    readonly prompt: string;
    readonly signal: AbortSignal;
    readonly onProgress: (progress: { readonly tokens?: number; readonly toolCalls?: number }) => void;
  }> = [];
  public disposed = false;
  private readonly pending: Deferred<ChildTurnResult>[] = [];
  private latestText = "";

  public constructor(
    private readonly childId: string,
    public readonly sessionFile: string | undefined = "/tmp/fake-child.jsonl",
    private readonly autoResult?: ChildTurnResult,
    public readonly promptHash: string | undefined = undefined,
  ) {}

  public turn(
    prompt: string,
    signal: AbortSignal,
    onProgress: (progress: { readonly tokens?: number; readonly toolCalls?: number }) => void,
  ): Promise<ChildTurnResult> {
    this.turns.push({ prompt, signal, onProgress });
    if (this.autoResult) {
      this.latestText = this.autoResult.text;
      return Promise.resolve(this.autoResult);
    }
    const deferred = new Deferred<ChildTurnResult>();
    this.pending.push(deferred);
    return deferred.promise.then((result) => {
      this.latestText = result.text;
      return result;
    });
  }

  public steer(text: string): void {
    this.steers.push(text);
  }

  public lastAssistantText(): string {
    return this.latestText;
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
  }

  public complete(text = `done ${this.childId}`): void {
    this.settleNext({ state: "completed", text });
  }

  public fail(errorCode = "child_run_failed", errorMessage = "fake child failed"): void {
    this.settleNext({ state: "failed", text: "", errorCode, errorMessage });
  }

  public cancel(): void {
    this.settleNext({ state: "cancelled", text: "", errorCode: "cancelled", errorMessage: "fake child cancelled" });
  }

  public progress(progress: { readonly tokens?: number; readonly toolCalls?: number }): void {
    this.turns.at(-1)?.onProgress(progress);
  }

  private settleNext(result: ChildTurnResult): void {
    const deferred = this.pending.shift();
    if (!deferred) {
      throw new Error("no pending fake child turn");
    }
    deferred.resolve(result);
  }
}

export class FakeMainTurner implements InterimTurner {
  public busy = false;
  public ownerTurnId: string | undefined;
  public steerResult = true;
  public turnResult: MainTurnResult = { kind: "reply", text: "owner update" };
  public readonly turns: string[] = [];
  public readonly steers: MainTurnInput[] = [];
  public readonly messages: unknown[] = [];
  private readonly deliveredListeners = new Set<(delivery: InterimTurnDelivery) => void>();
  public ownerDelivery?: (input: { readonly idempotencyKey: string; readonly text: string; readonly childId?: string }) => { readonly id: string };

  public async steer(input: MainTurnInput): Promise<boolean> {
    this.steers.push(input);
    if (this.steerResult) {
      this.messages.push({ content: [{ type: "text", text: input.text }] });
    }
    return this.steerResult;
  }

  public async turn(prompt: string): Promise<MainTurnResult> {
    this.turns.push(prompt);
    this.messages.push({ content: [{ type: "text", text: prompt }] });
    return this.turnResult;
  }

  public admitOwnerReply(input: { readonly idempotencyKey: string; readonly text: string; readonly childId?: string }): { readonly id: string } {
    if (this.ownerDelivery) {
      return this.ownerDelivery(input);
    }
    return { id: input.idempotencyKey };
  }

  public currentOwnerTurnId(): string | undefined {
    return this.ownerTurnId;
  }

  public transcriptContains(marker: string): boolean {
    return JSON.stringify(this.messages).includes(marker);
  }

  public onTurnDelivered(listener: (delivery: InterimTurnDelivery) => void): () => void {
    this.deliveredListeners.add(listener);
    return () => this.deliveredListeners.delete(listener);
  }

  public emitTurnDelivered(delivery: InterimTurnDelivery): void {
    for (const listener of this.deliveredListeners) {
      listener(delivery);
    }
  }
}
