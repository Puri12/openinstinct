import { join } from "node:path";

import { probeConfig } from "../bootstrap/probes.ts";
import type { BootstrapProbes } from "../bootstrap/states.ts";
import type { DataPaths } from "../paths.ts";
import type { ChildConversation, ChildTurnResult, ConversationalChildRunner } from "../children/conversation.ts";
import type { ChildRunResult, ChildRunner } from "../children/runner.ts";
import type { DeliveryPort, DeliveryReceipt } from "../delivery/port.ts";
import type { MainAgentSession, MainSessionFactory, MainSessionFactoryInput } from "../sdk-session/main-session.ts";
import type { CustomTool } from "@gajae-code/coding-agent";
import { holdForDrill } from "./hooks.ts";

/**
 * Hermetic adapters used only by `scripts/drills/failure-drills.sh`.
 *
 * The config probe delegates to the real one so the seeded `allowlistHandle`
 * is reported and the optional iMessage lane attaches exactly as in
 * production; it is a plain file read, so it stays hermetic. Only the TCC and
 * credential probes are stubbed, since those would touch the host.
 */
export function createDrillProbes(paths: DataPaths): BootstrapProbes {
  return {
    config: () => probeConfig(paths.config),
    credentials: async () => ({ status: "passed" }),
    fda: async () => ({ status: "passed" }),
    messages: async () => ({ status: "passed" }),
    accessibility: async () => ({ status: "passed" }),
  };
}

export class DrillMainSessionFactory implements MainSessionFactory {
  public readonly sessions: DrillMainSession[] = [];

  public constructor(private readonly options: { readonly customTools?: readonly CustomTool[] } = {}) {}

  public async create(input: MainSessionFactoryInput): Promise<MainAgentSession> {
    const session = new DrillMainSession(input.sessionFile ?? join(input.workingDirectory, "drill-main.jsonl"), this.options.customTools ?? []);
    this.sessions.push(session);
    return session;
  }
}

export class DrillChildRunner implements ChildRunner {
  public readonly name = "drill-child-runner";

  public async run(): Promise<ChildRunResult> {
    await holdForDrill("mid-child");
    return { state: "completed", summary: "Hermetic drill child completed." };
  }
}

/** Conversational drill adapter used to hold a live task turn without blocking the main session. */
export class DrillConversationRunner implements ConversationalChildRunner {
  public readonly name = "drill-conversation-runner";
  public readonly conversations = new Map<string, DrillConversation>();

  public async open(input: {
    readonly childId: string;
    readonly title: string;
    readonly sessionFile?: string;
    readonly onReport?: (report: { readonly text: string; readonly toolCallId: string }) => { readonly accepted: boolean };
  }, _signal: AbortSignal): Promise<ChildConversation> {
    const conversation = new DrillConversation(input.childId, input.sessionFile, input.onReport);
    this.conversations.set(input.childId, conversation);
    return conversation;
  }
}

export class DrillConversation implements ChildConversation {
  public readonly steers: string[] = [];

  private reportSequence = 0;

  public constructor(
    private readonly childId: string,
    public readonly sessionFile: string | undefined,
    private readonly onReport?: (report: { readonly text: string; readonly toolCallId: string }) => { readonly accepted: boolean },
  ) {}

  public async turn(prompt: string, _signal: AbortSignal, _onProgress: (progress: { readonly tokens?: number; readonly toolCalls?: number }) => void): Promise<ChildTurnResult> {
    for (const match of prompt.matchAll(/\[\[report:\s*([\s\S]*?)\]\]/g)) {
      const text = match[1]?.trim();
      if (text) {
        this.onReport?.({ text, toolCallId: `drill-report:${this.childId}:${++this.reportSequence}` });
      }
    }
    await holdForDrill("mid-child");
    return { state: "completed", text: "Hermetic drill turn." };
  }

  public steer(text: string): void {
    this.steers.push(text);
  }

  public lastAssistantText(): string {
    return "Hermetic drill turn.";
  }

  public async dispose(): Promise<void> {}
}

export class DrillDeliveryPort implements DeliveryPort {
  private sequence = 0;

  public async sendText(): Promise<DeliveryReceipt> {
    return { messageId: this.nextId() };
  }

  public async sendReply(): Promise<DeliveryReceipt> {
    return { messageId: this.nextId(), threadId: "drill-thread" };
  }

  public async sendFile(): Promise<DeliveryReceipt> {
    return { messageId: this.nextId() };
  }

  private nextId(): string {
    this.sequence += 1;
    return `drill-message-${this.sequence}`;
  }
}

/** In-memory main-session adapter that can exercise custom tools in drills. */
export class DrillMainSession implements MainAgentSession {
  public readonly sessionId = "drill-main";
  public readonly messages: unknown[] = [];
  private readonly listeners = new Set<(event: unknown) => void>();
  private toolSequence = 0;

  public constructor(
    public readonly sessionFile: string,
    private readonly customTools: readonly CustomTool[],
  ) {}

  public async prompt(text: string): Promise<void> {
    await holdForDrill("mid-turn");
    await this.executeToolDirectives(text);
    this.messages.push({ role: "user", content: [{ type: "text", text }] });
    const reply = drillReplyFor(text);
    this.messages.push({ role: "assistant", content: [{ type: "text", text: reply }] });
    this.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: reply },
    });
  }

  public subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async dispose(): Promise<void> {}

  private async executeToolDirectives(text: string): Promise<void> {
    for (const directive of parseToolDirectives(text)) {
      const tool = this.customTools.find((candidate) => candidate.name === directive.toolName);
      if (!tool) {
        throw new Error(`unknown drill tool: ${directive.toolName}`);
      }
      const toolCallId = `drill-tool:${++this.toolSequence}`;
      this.emit({
        type: "tool_execution_start",
        toolCallId,
        toolName: directive.toolName,
        args: directive.args,
      });
      process.stdout.write(`OI_DRILL_TOOL_EXECUTION_START ${toolCallId} ${directive.toolName} ${new Date().toISOString()}\n`);
      try {
        const execute = tool as unknown as {
          execute(
            toolCallId: string,
            params: Record<string, unknown>,
            context?: unknown,
            metadata?: Record<string, unknown>,
          ): Promise<unknown> | unknown;
        };
        const result = await execute.execute(toolCallId, directive.args, undefined, {});
        this.emit({ type: "tool_execution_end", toolCallId, toolName: directive.toolName, result, isError: false });
        process.stdout.write(`OI_DRILL_TOOL_EXECUTION_END ${toolCallId} ${directive.toolName} ${new Date().toISOString()} ${JSON.stringify(result)}\n`);
      } catch (error) {
        const result = { message: error instanceof Error ? error.message : String(error) };
        this.emit({ type: "tool_execution_end", toolCallId, toolName: directive.toolName, result, isError: true });
        process.stdout.write(`OI_DRILL_TOOL_EXECUTION_END ${toolCallId} ${directive.toolName} ${new Date().toISOString()} ${JSON.stringify(result)}\n`);
        throw error;
      }
    }
  }

  private emit(event: unknown): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function drillReplyFor(prompt: string): string {
  if (prompt.includes("A background task has")) {
    return "Hermetic receipt triage reply.";
  }
  if (prompt.includes("Triage it before") || prompt.includes("FAILED after a restart") || prompt.includes("TIMED OUT due to inactivity")) {
    return "Hermetic monitor triage reply.";
  }
  return "Hermetic drill reply.";
}

export function parseToolDirectives(text: string): readonly { readonly toolName: string; readonly args: Record<string, unknown> }[] {
  const directives: Array<{ readonly toolName: string; readonly args: Record<string, unknown> }> = [];
  const pattern = /\[\[tool:([A-Za-z0-9_-]+)\s+(\{[\s\S]*?\})\]\]/g;
  for (const match of text.matchAll(pattern)) {
    const toolName = match[1];
    const rawArgs = match[2];
    if (!toolName || !rawArgs) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawArgs);
    } catch {
      throw new Error(`invalid drill tool JSON for ${toolName}`);
    }
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error(`drill tool args must be an object: ${toolName}`);
    }
    directives.push({ toolName, args: parsed as Record<string, unknown> });
  }
  return directives;
}
