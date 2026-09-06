import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dataPaths } from "../../paths.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ChildRunRequest, ChildRunResult, ChildRunner, ChildTerminalState } from "../runner.ts";

const DEFAULT_KILL_GRACE_MS = 1_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

export interface GjcExternalRunnerOptions {
  readonly root: string;
  /** Defaults to the system gjc from PATH, then the vendored binary. Tests inject a hermetic fixture. */
  readonly gjcPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Model every external child runs on; the same value as the main session. */
  readonly modelPattern?: string;
  readonly killGraceMs?: number;
  readonly maxOutputBytes?: number;
}

/**
 * Runs a separate non-interactive GJC process. `--mode json` is supported by
 * GJC 0.15.6 (`gjc -p --mode json`); the adapter consumes only JSON stdout and
 * maps its terminal payload into the process-neutral ChildRunner result.
 */
export class GjcExternalRunner implements ChildRunner {
  public readonly name = "gjc-external";
  private readonly gjcPath: string;
  private readonly killGraceMs: number;
  private readonly maxOutputBytes: number;

  public constructor(private readonly options: GjcExternalRunnerOptions) {
    this.gjcPath = options.gjcPath ?? process.env.GJC_BIN ?? bundledGjcPath();
    this.killGraceMs = positiveDuration(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS, "killGraceMs");
    this.maxOutputBytes = positiveDuration(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, "maxOutputBytes");
  }

  public async run(request: ChildRunRequest, signal: AbortSignal): Promise<ChildRunResult> {
    if (signal.aborted) {
      return cancelledResult("External child was cancelled before it started.");
    }

    const workingDirectory = join(this.options.root, "work", request.childId);
    const sessionDirectory = join(this.options.root, "sessions", request.childId);
    mkdirSync(workingDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });

    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = spawn(this.gjcPath, [
        "-p",
        "--mode", "json",
        "--no-lsp",
        "--no-mcp",
        "--no-pty",
        "--no-title",
        "--session-dir", sessionDirectory,
        ...(this.options.modelPattern ? ["--model", this.options.modelPattern] : []),
        request.prompt,
      ], {
        cwd: workingDirectory,
        // Vendored gjc is a `#!/usr/bin/env bun` shim; make sure a bun resolves
        // even under launchd's PATH by exposing our own runtime dir first.
        env: this.options.env ?? withRuntimeOnPath(process.env),
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      return failedResult("external_spawn_failed", messageOf(error));
    }
    if (!child || !child.stdout || !child.stderr) {
      return failedResult("external_stdio", "External GJC did not expose piped stdout and stderr.");
    }
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;

    let stdout = "";
    let stderr = "";
    let outputExceededLimit = false;
    let aborted = false;
    let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
    const append = (current: string, chunk: Buffer): string => {
      const remaining = this.maxOutputBytes - Buffer.byteLength(current);
      if (remaining <= 0) {
        outputExceededLimit = true;
        return current;
      }
      const text = chunk.toString("utf8");
      if (Buffer.byteLength(text) > remaining) {
        outputExceededLimit = true;
        return `${current}${Buffer.from(text).subarray(0, remaining).toString("utf8")}`;
      }
      return `${current}${text}`;
    };
    const appendOutput = (current: string, chunk: Buffer): string => {
      const next = append(current, chunk);
      if (Buffer.byteLength(next) > Buffer.byteLength(current)) {
        request.onProgress?.({});
      }
      return next;
    };
    stdoutStream.on("data", (chunk: Buffer) => {
      stdout = appendOutput(stdout, chunk);
    });
    stderrStream.on("data", (chunk: Buffer) => {
      stderr = appendOutput(stderr, chunk);
    });

    const abort = (): void => {
      if (aborted) {
        return;
      }
      aborted = true;
      killProcessGroup(child.pid, "SIGTERM", child.kill.bind(child));
      hardKillTimer = setTimeout(() => {
        killProcessGroup(child.pid, "SIGKILL", child.kill.bind(child));
      }, this.killGraceMs);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }

    const outcome = await waitForChild(child);
    signal.removeEventListener("abort", abort);
    if (hardKillTimer) {
      clearTimeout(hardKillTimer);
    }

    if (aborted || signal.aborted) {
      return cancelledResult("External child was cancelled.");
    }
    if (outcome.error) {
      return failedResult("external_spawn_failed", messageOf(outcome.error));
    }
    if (outputExceededLimit) {
      // A child that emits >1 MiB read something it should not have (its own
      // transcript, a log); the path guard prevents that, this is the backstop.
      return failedResult("external_output_limit", "Child output exceeded 1 MiB: it read a huge file (transcript/log) instead of answering. Path guard should have blocked this; check the child's tool calls.");
    }
    if (outcome.code !== 0) {
      const reported = explicitExternalTerminal(stdout);
      if (reported && reported.state !== "completed") {
        return reported;
      }
      const detail = truncate(stderr.trim() || stdout.trim() || `process exited with ${String(outcome.code)}`, 500);
      return failedResult("external_exit", detail);
    }

    try {
      return parseExternalTerminal(stdout);
    } catch (error) {
      return failedResult("external_protocol", messageOf(error));
    }
  }
}

interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
}

function waitForChild(child: ReturnType<typeof spawn>): Promise<ChildExit> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: ChildExit): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(outcome);
    };
    child.once("error", (error) => finish({ code: null, signal: null, error }));
    child.once("close", (code, signal) => finish({ code, signal }));
  });
}

function killProcessGroup(
  pid: number | undefined,
  signal: NodeJS.Signals,
  fallback: (signal?: NodeJS.Signals | number) => boolean,
): void {
  if (!pid || pid <= 0) {
    return;
  }
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // A process may exit between the group kill and this fallback.
    }
  }
  try {
    fallback(signal);
  } catch {
    // Cancellation is best effort; lifecycle still exposes its typed result.
  }
}

function parseExternalTerminal(stdout: string): ChildRunResult {
  const records = parseJsonRecords(stdout);
  if (records.length === 0) {
    throw new Error("external GJC emitted no JSON result");
  }

  const terminal = records.map(findTerminalRecord).find((record) => record !== undefined);
  if (terminal) {
    return terminal;
  }

  // An assistant message that ended in a provider error (404 model, 401 key,
  // 429) is a failure even when the process exited 0.
  const providerError = records.map(findProviderError).find((e) => e !== undefined);
  if (providerError) {
    return { state: "failed", summary: `External child failed: ${providerError}`, errorCode: "provider_error", errorMessage: providerError };
  }
  const text = records.map(extractVisibleText).filter(Boolean).join("").trim();
  if (text.length === 0) {
    return { state: "failed", summary: "External child produced no visible text.", errorCode: "empty_output" };
  }
  return { state: "completed", summary: truncate(text, 16_000) };
}

function explicitExternalTerminal(stdout: string): ChildRunResult | undefined {
  try {
    return parseJsonRecords(stdout).map(findTerminalRecord).find((record) => record !== undefined);
  } catch {
    return undefined;
  }
}

function parseJsonRecords(stdout: string): unknown[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }
  try {
    return [JSON.parse(trimmed)];
  } catch {
    const records: unknown[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        records.push(JSON.parse(line));
      } catch {
        throw new Error("external GJC stdout was not JSON");
      }
    }
    return records;
  }
}

function findProviderError(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const message = (value as { readonly message?: { readonly role?: unknown; readonly stopReason?: unknown; readonly errorMessage?: unknown } }).message;
  if (message?.role === "assistant" && message.stopReason === "error" && typeof message.errorMessage === "string") {
    return message.errorMessage.slice(0, 300);
  }
  return undefined;
}

function findTerminalRecord(value: unknown): ChildRunResult | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const state = normalizeState(record.state ?? record.status);
  if (!state) {
    return undefined;
  }
  const summary = firstString(record.summary, record.text, record.message, record.output)
    ?? extractVisibleText(record)
    ?? `External child ${state}.`;
  const errorCode = firstString(record.errorCode, record.code);
  const errorMessage = firstString(record.errorMessage, record.error);
  const sessionFile = firstString(record.sessionFile, record.session_file);
  return {
    state,
    summary: truncate(summary, 16_000),
    ...(sessionFile === undefined ? {} : { sessionFile }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(errorMessage === undefined ? {} : { errorMessage: truncate(errorMessage, 500) }),
  };
}

function normalizeState(value: unknown): ChildTerminalState | undefined {
  if (value === "completed" || value === "success" || value === "succeeded") {
    return "completed";
  }
  if (value === "failed" || value === "error") {
    return "failed";
  }
  if (value === "timeout" || value === "timed_out") {
    return "timeout";
  }
  if (value === "cancelled" || value === "canceled") {
    return "cancelled";
  }
  return undefined;
}

function extractVisibleText(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const direct = firstString(record.delta, record.text);
  if (direct) {
    return direct;
  }
  const assistantEvent = record.assistantMessageEvent;
  if (assistantEvent && typeof assistantEvent === "object") {
    const delta = firstString((assistantEvent as Record<string, unknown>).delta);
    if (delta) {
      return delta;
    }
  }
  const content = record.content;
  if (Array.isArray(content)) {
    const text = content
      .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object")
      .filter((entry) => entry.type === "text" && typeof entry.text === "string")
      .map((entry) => entry.text as string)
      .join("");
    if (text) {
      return text;
    }
  }
  const assistantText = latestAssistantText(record.messages);
  if (assistantText) {
    return assistantText;
  }

  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function latestAssistantText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === null || typeof message !== "object" || (message as Record<string, unknown>).role !== "assistant") {
      continue;
    }
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
      continue;
    }
    const text = content
      .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object")
      .filter((entry) => entry.type === "text" && typeof entry.text === "string")
      .map((entry) => entry.text as string)
      .join("")
      .trim();
    if (text) {
      return text;
    }
  }
  return undefined;
}

function cancelledResult(summary: string): ChildRunResult {
  return {
    state: "cancelled",
    summary,
    errorCode: "cancelled",
    errorMessage: "child runner was cancelled",
  };
}

function failedResult(errorCode: string, errorMessage: string): ChildRunResult {
  return {
    state: "failed",
    summary: `External child failed: ${truncate(errorMessage, 500)}`,
    errorCode,
    errorMessage: truncate(errorMessage, 500),
  };
}

function positiveDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function truncate(value: string, maximumCharacters: number): string {
  return Array.from(value).slice(0, maximumCharacters).join("");
}

function withRuntimeOnPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const runtimeDir = dirname(process.execPath);
  const current = env.PATH ?? "";
  if (current.split(":").includes(runtimeDir)) {
    return env;
  }
  return { ...env, PATH: current.length === 0 ? runtimeDir : `${runtimeDir}:${current}` };
}

function bundledGjcPath(): string {
  // Only the binary OpenInstinct installed (version-locked to the vendored
  // SDK). Falling back to a host gjc reintroduces schema drift.
  const owned = dataPaths().gjcBinary;
  if (existsSync(owned)) {
    return owned;
  }
  const vendored = fileURLToPath(new URL("../../../node_modules/.bin/gjc", import.meta.url));
  if (existsSync(vendored)) {
    return vendored;
  }
  throw new Error(`gjc binary missing at ${owned}; re-run the installer`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
