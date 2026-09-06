import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { browserProfileEnforcer } from "../../browser/enforce.ts";
import { dataPaths } from "../../paths.ts";
import { loadSoul } from "../../persona/soul.ts";
import { createOmoServices, ensureOmoAgentDir, openOmoSession, resolveModel } from "../../omo-session/omo-runtime.ts";
import type { CustomTool } from "../../omo-session/tool-types.ts";
import type { ChildRunRequest, ChildRunResult, ChildRunner } from "../runner.ts";
import { CHILD_REPORTING_INSTRUCTION } from "../report-progress-tool.ts";
export interface ChildAgentSession {
  readonly sessionFile?: string;
  readonly messages?: unknown;
  readonly activePromptHandle?: unknown;
  readonly promptHash?: string;
  prompt(text: string): Promise<void>;
  steer?(text: string): Promise<void> | void;
  subscribe?(listener: (event: unknown) => void): () => void;
  abort?(options?: { readonly timeoutMs?: number }): Promise<void> | void;
  dispose?(): Promise<void>;
  getLastAssistantText?(): string;
  getContextUsage?(): { readonly tokens: number | null } | undefined;
  getActiveToolNames?(): readonly string[];
  waitForIdle?(): Promise<void>;
}

export interface ChildSessionFactory {
  create(input: {
    readonly childId: string;
    readonly title: string;
    readonly workingDirectory: string;
    readonly sessionDirectory: string;
    readonly sessionFile?: string;
    readonly conversational: boolean;
    readonly customTools?: readonly CustomTool[];
  }): Promise<ChildAgentSession>;
}

export interface OmoInProcessRunnerOptions {
  readonly root: string;
  readonly factory?: ChildSessionFactory;
  /** Required when no factory is injected: the production omo engine child model. */
  readonly modelPattern?: string;
}

/**
 * The conversational task-tool runner owns a separate file-backed omo engine session
 * below ~/.openinstinct/children; it never shares the main session object.
 */
export class OmoInProcessRunner implements ChildRunner {
  public readonly name = "omo-inprocess";
  private readonly factory: ChildSessionFactory;

  public constructor(private readonly options: OmoInProcessRunnerOptions) {
    if (!options.factory && !options.modelPattern) {
      throw new Error("OmoInProcessRunner needs modelPattern when using the production omo engine factory");
    }
    this.factory = options.factory ?? new OmoChildSessionFactory(options.modelPattern!);
  }

  public async run(request: ChildRunRequest, signal: AbortSignal): Promise<ChildRunResult> {
    const workingDirectory = join(this.options.root, "work", request.childId);
    const sessionDirectory = join(this.options.root, "sessions", request.childId);
    let session: ChildAgentSession | undefined;
    let unsubscribe: (() => void) | undefined;
    let abortListener: (() => void) | undefined;

    try {
      session = await this.factory.create({
        childId: request.childId,
        title: request.title,
        workingDirectory,
        sessionDirectory,
        conversational: false,
      });
      abortListener = () => {
        if (session?.abort) {
          void Promise.resolve(session.abort({ timeoutMs: 5_000 })).catch(() => undefined);
        }
      };
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) {
        abortListener();
        return {
          state: "cancelled",
          summary: "Background task was cancelled before it started.",
          ...(session.sessionFile === undefined ? {} : { sessionFile: session.sessionFile }),
          errorCode: "cancelled",
          errorMessage: "child lifecycle cancelled the task",
        };
      }

      const capture = capturePrompt(session, request.prompt, request.onProgress);
      unsubscribe = capture.unsubscribe;
      const summary = await capture.result;
      if (signal.aborted) {
        return {
          state: "cancelled",
          summary: "Background task was cancelled.",
          ...(session.sessionFile === undefined ? {} : { sessionFile: session.sessionFile }),
          errorCode: "cancelled",
          errorMessage: "child lifecycle cancelled the task",
        };
      }
      return {
        state: "completed",
        summary: summary || "Child completed without a textual response.",
        ...(session.sessionFile === undefined ? {} : { sessionFile: session.sessionFile }),
      };
    } catch (error) {
      return {
        state: signal.aborted ? "cancelled" : "failed",
        summary: signal.aborted ? "Background task was cancelled." : `Background task failed: ${messageOf(error)}`,
        ...(session?.sessionFile === undefined ? {} : { sessionFile: session.sessionFile }),
        errorCode: signal.aborted ? "cancelled" : errorCodeOf(error),
        errorMessage: messageOf(error),
      };
    } finally {
      if (abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
      unsubscribe?.();
      if (session?.dispose) {
        await session.dispose().catch(() => undefined);
      }
    }
  }
}

export class OmoChildSessionFactory implements ChildSessionFactory {
  /** `omoRoot` is the `~/.openinstinct` root that owns the engine state, the Chrome profile, and the paths children may not read. */
  public constructor(private readonly modelPattern: string, private readonly omoRoot: string = dataPaths().root) {}

  public async create(input: {
    readonly childId: string;
    readonly title: string;
    readonly workingDirectory: string;
    readonly sessionDirectory: string;
    readonly sessionFile?: string;
    readonly conversational: boolean;
    readonly customTools?: readonly CustomTool[];
  }): Promise<ChildAgentSession> {
    mkdirSync(input.workingDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(input.sessionDirectory, { recursive: true, mode: 0o700 });
    const tabPrefix = `${input.childId.slice(0, 8)}-`;
    const appendSystemPrompt = childSystemPrompt(input.conversational, tabPrefix);
    const services = await createOmoServices({
      cwd: input.workingDirectory,
      agentDir: ensureOmoAgentDir(this.omoRoot).dir,
      appendSystemPrompt,
      // Children get a generous but finite budget: a monitor that needs 40 tool calls is doing something wrong.
      extensions: [{
        name: "openinstinct-child-enforcer",
        factory: browserProfileEnforcer(join(this.omoRoot, "chrome-profile"), { forbiddenRoot: this.omoRoot, maxToolCallsPerTurn: 40, tabPrefix }),
      }],
    });
    const resolved = await resolveModel(services, this.modelPattern);
    const session = await openOmoSession({
      services,
      cwd: input.workingDirectory,
      sessionDir: input.sessionDirectory,
      ...(input.sessionFile === undefined ? {} : { sessionFile: input.sessionFile }),
      model: resolved.model,
      customTools: input.conversational ? input.customTools ?? [] : [],
    });
    // The engine session is adapted rather than returned raw: its `dispose()` is
    // synchronous, and every child call site awaits a promise from it.
    return {
      promptHash: hashPrompt(appendSystemPrompt),
      get sessionFile(): string | undefined { return session.sessionFile; },
      get messages(): unknown { return session.messages; },
      prompt: (text) => session.prompt(text),
      steer: (text) => session.steer(text),
      subscribe: (listener) => session.subscribe(listener),
      abort: () => session.abort(),
      dispose: async () => { session.dispose(); },
      // The engine's accessor rather than a re-scan of `messages`: it skips aborted empty turns.
      getLastAssistantText: () => session.getLastAssistantText() ?? "",
      getContextUsage: () => session.getContextUsage(),
      getActiveToolNames: () => session.getActiveToolNames(),
      waitForIdle: () => session.waitForIdle(),
    };
  }
}

/**
 * Appended after the engine's own base prompt. `tabPrefix` is still part of the
 * child's browser identity (the enforcer takes it), but the MCP browser has
 * page ids instead of named tabs, so no sentence interpolates it.
 */
export function childSystemPrompt(conversational: boolean, _tabPrefix?: string): string[] {
  const chromeProfile = dataPaths().chromeProfile;
  return [
    loadSoul().text,
    `Browser: use the mcp_browser_* tools (navigate_page, take_snapshot, take_screenshot, click, fill, evaluate_script, wait_for, list_pages/new_page/select_page/close_page). They are already attached to OmO's own persistent Chrome profile at ${chromeProfile}; there is no profile to choose and no other browser tool. Work in one page per task: create it with new_page, keep its id, and close it when done; if a site is logged out, say so in one line and ask the owner to sign in via the panel's "Open OmO's browser" button.`,
    "Runtime context: you are OmO running as a background worker inside OpenInstinct; the soul above is unchanged. Complete the assigned task independently and return a concise, factual result for the owner-facing OmO session to relay. That result is texted to the owner over iMessage, so write it as plain text: no Markdown headings, bold, code fences, tables, or list syntax.",
    ...(conversational ? [CHILD_REPORTING_INSTRUCTION] : []),
  ];
}

export function hashPrompt(prompt: readonly string[]): string {
  return createHash("sha256").update(prompt.join("\n")).digest("hex");
}

function capturePrompt(session: ChildAgentSession, prompt: string, onProgress?: (p: { readonly tokens?: number; readonly toolCalls?: number }) => void): {
  readonly result: Promise<string>;
  readonly unsubscribe: () => void;
} {
  let deltas = "";
  let toolCalls = 0;
  const reportProgress = (progress: { readonly tokens?: number; readonly toolCalls?: number } = {}): void => {
    const usage = (session as { getContextUsage?: () => { tokens: number | null } | undefined }).getContextUsage?.();
    onProgress?.({ ...progress, ...(usage?.tokens == null ? {} : { tokens: usage.tokens }) });
  };
  const unsubscribe = session.subscribe?.((event) => {
    const type = (event as { readonly type?: unknown }).type;
    if (type === "tool_execution_start") {
      toolCalls += 1;
      reportProgress({ toolCalls });
      return;
    }
    if (isTextDelta(event)) {
      deltas += event.assistantMessageEvent.delta;
      if (event.assistantMessageEvent.delta.length > 0) {
        reportProgress();
      }
      return;
    }
    if (type === "message_update" || type === "message_end" || type === "tool_execution_end" || type === "tool_execution_update") {
      reportProgress();
    }
  }) ?? (() => undefined);

  const result = Promise.resolve()
    .then(() => session.prompt(prompt))
    .then(() => deltas.trim() || latestAssistantText(session.messages));
  return { result, unsubscribe };
}

function isTextDelta(event: unknown): event is {
  readonly type: "message_update";
  readonly assistantMessageEvent: { readonly type: "text_delta"; readonly delta: string };
} {
  return event !== null
    && typeof event === "object"
    && (event as { readonly type?: unknown }).type === "message_update"
    && (event as { readonly assistantMessageEvent?: { readonly type?: unknown; readonly delta?: unknown } })
      .assistantMessageEvent?.type === "text_delta"
    && typeof (event as { readonly assistantMessageEvent?: { readonly delta?: unknown } }).assistantMessageEvent?.delta === "string";
}

function latestAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) {
    return "";
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === null || typeof message !== "object" || (message as { readonly role?: unknown }).role !== "assistant") {
      continue;
    }
    const content = (message as { readonly content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    const text = content
      .filter((block): block is { readonly type: "text"; readonly text: string } => (
        block !== null
        && typeof block === "object"
        && (block as { readonly type?: unknown }).type === "text"
        && typeof (block as { readonly text?: unknown }).text === "string"
      ))
      .map((block) => block.text)
      .join("")
      .trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function errorCodeOf(error: unknown): string {
  if (error !== null && typeof error === "object" && typeof (error as { readonly code?: unknown }).code === "string") {
    return (error as { readonly code: string }).code;
  }
  return "child_run_failed";
}

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return Array.from(message).slice(0, 500).join("");
}
