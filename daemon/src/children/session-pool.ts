import type { ChildRecord } from "../store/index.ts";
import type { ChildConversation, ChildReport, ChildReportOutcome, ConversationalChildRunner } from "./conversation.ts";

export interface ChildSessionPoolOptions {
  readonly runner: ConversationalChildRunner;
  readonly now?: () => Date;
  readonly onEvent?: (event: string, fields: Record<string, unknown>) => void;
  readonly onReport?: (input: { readonly childId: string; readonly title: string; readonly report: ChildReport }) => ChildReportOutcome;
}

export interface PooledConversation {
  readonly conversation: ChildConversation;
  readonly generation: number;
}

/** Holds warm session objects only; ChildLifecycle owns every state transition. */
export class ChildSessionPool {
  private readonly entries = new Map<string, PooledConversation>();
  private readonly generations = new Map<string, number>();

  public constructor(private readonly options: ChildSessionPoolOptions) {}

  public async open(child: ChildRecord, signal: AbortSignal): Promise<PooledConversation> {
    const existing = this.entries.get(child.id);
    if (existing) {
      return existing;
    }
    const generation = (this.generations.get(child.id) ?? 0) + 1;
    this.generations.set(child.id, generation);
    const conversation = await this.options.runner.open({
      childId: child.id,
      title: child.title,
      ...(child.sessionFile === undefined ? {} : { sessionFile: child.sessionFile }),
      ...(this.options.onReport === undefined
        ? {}
        : { onReport: (report: ChildReport) => this.options.onReport!({ childId: child.id, title: child.title, report }) }),
    }, signal);
    const entry = { conversation, generation };
    this.entries.set(child.id, entry);
    this.event("child_session_opened", {
      childId: child.id,
      generation,
      ...(child.sessionFile === undefined ? {} : { resumed: true }),
      ...(conversation.promptHash === undefined ? {} : { promptHash: conversation.promptHash }),
    });
    return entry;
  }

  public get(childId: string): PooledConversation | undefined {
    return this.entries.get(childId);
  }

  public async dispose(childId: string, expectedGeneration: number): Promise<void> {
    const entry = this.entries.get(childId);
    if (!entry || entry.generation !== expectedGeneration) {
      return;
    }
    this.entries.delete(childId);
    await entry.conversation.dispose();
    this.event("child_session_disposed", { childId, generation: expectedGeneration });
  }

  /** Drops a warm object before ChildLifecycle durably moves the child to cold. */
  public disposeToCold(childId: string, expectedGeneration: number): Promise<void> {
    return this.dispose(childId, expectedGeneration);
  }

  public async disposeAll(): Promise<void> {
    const entries = [...this.entries.entries()];
    this.entries.clear();
    await Promise.all(entries.map(async ([childId, entry]) => {
      await entry.conversation.dispose();
      this.event("child_session_disposed", { childId, generation: entry.generation });
    }));
  }

  private event(event: string, fields: Record<string, unknown>): void {
    this.options.onEvent?.(event, fields);
  }
}
