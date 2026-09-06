import { spawn } from "node:child_process";
import { existsSync, realpathSync, watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, isAbsolute, resolve, sep } from "node:path";

import { MonitorStore } from "./store.ts";
import type { MonitorSpec, MonitorTriggerEvent } from "./types.ts";

const MAX_WEBHOOK_BYTES = 256 * 1024;
const MAX_SCRIPT_OUTPUT_BYTES = 64 * 1024;

export interface MonitorRuntimeConfig {
  readonly watcherRoots: readonly string[];
  readonly scriptRoot?: string;
  readonly webhookPort: number;
}

export interface MonitorTriggerSink {
  (monitor: MonitorSpec, event: MonitorTriggerEvent): void | Promise<void>;
}

export interface WebhookServerOptions {
  readonly monitors: MonitorStore;
  readonly onTrigger: MonitorTriggerSink;
  readonly port?: number;
  readonly onEvent?: (event: string, fields: Record<string, unknown>) => void;
}

/** Loopback-only webhook ingress. Tokens are stored in each durable spec. */
export class WebhookServer {
  private server: Server | undefined;
  private readonly requestedPort: number;

  public readonly host = "127.0.0.1";

  public constructor(private readonly options: WebhookServerOptions) {
    this.requestedPort = options.port ?? 17_358;
    if (!Number.isSafeInteger(this.requestedPort) || this.requestedPort < 0 || this.requestedPort > 65_535) {
      throw new Error("webhook port must be between 0 and 65535");
    }
  }

  public get port(): number | undefined {
    const address = this.server?.address();
    return address && typeof address !== "string" ? address.port : undefined;
  }

  public async start(): Promise<void> {
    if (this.server || !this.hasWebhookMonitors()) {
      return;
    }
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        this.event("webhook_failed", { message: messageOf(error) });
        if (!response.headersSent) {
          response.statusCode = 500;
          response.end("internal error");
        }
      });
    });
    await new Promise<void>((resolveStart, rejectStart) => {
      server.once("error", rejectStart);
      server.listen(this.requestedPort, this.host, () => {
        server.off("error", rejectStart);
        resolveStart();
      });
    });
    this.server = server;
    this.event("webhook_listening", { host: this.host, port: this.port });
  }

  public async refresh(): Promise<void> {
    if (this.hasWebhookMonitors()) {
      await this.start();
      return;
    }
    await this.stop();
  }

  public async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) {
      return;
    }
    await new Promise<void>((resolveStop, rejectStop) => {
      server.close((error) => error ? rejectStop(error) : resolveStop());
    });
  }

  private hasWebhookMonitors(): boolean {
    return this.options.monitors.list().some((monitor) => monitor.enabled && monitor.trigger.kind === "webhook");
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST") {
      response.statusCode = 405;
      response.setHeader("allow", "POST");
      response.end("method not allowed");
      return;
    }
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const match = /^\/hook\/([A-Za-z0-9_-]{16,128})$/.exec(path);
    if (!match) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    const monitor = this.options.monitors.list().find((candidate) => (
      candidate.enabled && candidate.trigger.kind === "webhook" && candidate.trigger.token === match[1]
    ));
    if (!monitor) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    const payload = await readWebhookPayload(request);
    await this.options.onTrigger(monitor, {
      eventType: "webhook",
      payload,
      occurrenceKey: webhookOccurrence(request, payload),
    });
    response.statusCode = 202;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ accepted: true, monitorId: monitor.id }));
    this.event("webhook_admitted", { monitorId: monitor.id });
  }

  private event(event: string, fields: Record<string, unknown>): void {
    this.options.onEvent?.(event, fields);
  }
}

export interface WatcherTriggerOptions {
  readonly monitors: MonitorStore;
  readonly watcherRoots: readonly string[];
  readonly onTrigger: MonitorTriggerSink;
  readonly debounceMs?: number;
  readonly onEvent?: (event: string, fields: Record<string, unknown>) => void;
}

/** Config-root constrained fs.watch ingress with per-monitor/path debounce. */
export class WatcherTrigger {
  private readonly debounceMs: number;
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

  public constructor(private readonly options: WatcherTriggerOptions) {
    this.debounceMs = options.debounceMs ?? 250;
    if (!Number.isSafeInteger(this.debounceMs) || this.debounceMs < 1) {
      throw new Error("watcher debounceMs must be a positive safe integer");
    }
  }

  public start(): void {
    this.refresh();
  }

  public refresh(): void {
    this.stopWatchers();
    for (const timer of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
    const monitors = this.options.monitors.list().filter((monitor) => monitor.enabled && monitor.trigger.kind === "watcher");
    if (monitors.length === 0) {
      return;
    }
    for (const root of this.options.watcherRoots) {
      if (!existsSync(root)) {
        this.event("watcher_root_missing", { root });
        continue;
      }
      try {
        const watcher = watch(root, { recursive: true }, (changeType, filename) => {
          const relativePath = filename === null ? "" : String(filename);
          for (const monitor of monitors) {
            if (!matchesWatcherRoot(monitor, root)) {
              continue;
            }
            this.debounce(monitor, root, relativePath, changeType);
          }
        });
        watcher.on("error", (error) => this.event("watcher_error", { root, message: error.message }));
        this.watchers.set(root, watcher);
      } catch (error) {
        this.event("watcher_start_failed", { root, message: messageOf(error) });
      }
    }
  }

  public stop(): void {
    this.stopWatchers();
    for (const timer of this.pending.values()) {
      clearTimeout(timer);
    }
    this.pending.clear();
  }

  private stopWatchers(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
  }

  private debounce(monitor: MonitorSpec, root: string, relativePath: string, changeType: string): void {
    const eventType = `watcher.${changeType}`;
    if (!acceptsEventType(monitor, eventType, changeType)) {
      return;
    }
    const key = `${monitor.id}\u0000${root}\u0000${relativePath}`;
    const previous = this.pending.get(key);
    if (previous) {
      clearTimeout(previous);
    }
    this.pending.set(key, setTimeout(() => {
      this.pending.delete(key);
      void Promise.resolve(this.options.onTrigger(monitor, {
        eventType,
        payload: { root, path: relativePath, changeType },
        occurrenceKey: `watcher:${root}:${relativePath}:${changeType}`,
      })).then(() => {
        this.event("watcher_admitted", { monitorId: monitor.id, root, path: relativePath, changeType });
      }).catch((error) => {
        this.event("watcher_trigger_failed", { monitorId: monitor.id, message: messageOf(error) });
      });
    }, this.debounceMs));
  }

  private event(event: string, fields: Record<string, unknown>): void {
    this.options.onEvent?.(event, fields);
  }
}

export interface ScriptTriggerOptions {
  readonly monitors: MonitorStore;
  readonly scriptRoot?: string;
  readonly onTrigger: MonitorTriggerSink;
  readonly onEvent?: (event: string, fields: Record<string, unknown>) => void;
}

/** Script ingress confines the executable path to config.scriptRoot. */
export class ScriptTrigger {
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly running = new Set<string>();

  public constructor(private readonly options: ScriptTriggerOptions) {}

  public start(): void {
    this.refresh();
  }

  public refresh(): void {
    this.stop();
    if (!this.options.scriptRoot) {
      return;
    }
    for (const monitor of this.options.monitors.list()) {
      if (!monitor.enabled || monitor.trigger.kind !== "script") {
        continue;
      }
      const timer = setInterval(() => {
        void this.runOnce(monitor).catch((error) => {
          this.event("script_trigger_failed", { monitorId: monitor.id, message: messageOf(error) });
        });
      }, monitor.trigger.intervalMs);
      this.timers.set(monitor.id, timer);
    }
  }

  public stop(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  public async runOnce(monitor: MonitorSpec): Promise<void> {
    if (!monitor.enabled || monitor.trigger.kind !== "script") {
      return;
    }
    if (this.running.has(monitor.id)) {
      return;
    }
    this.running.add(monitor.id);
    try {
      const scriptRoot = this.options.scriptRoot;
      if (!scriptRoot) {
        throw new Error("scriptRoot is not configured");
      }
      const argv = confinedArgv(scriptRoot, monitor.trigger.argv);
      const result = await runScript(argv, scriptRoot);
      await this.options.onTrigger(monitor, {
        eventType: "script",
        payload: result,
        occurrenceKey: `script:${monitor.id}:${Date.now()}`,
      });
      this.event("script_admitted", { monitorId: monitor.id, exitCode: result.exitCode });
    } finally {
      this.running.delete(monitor.id);
    }
  }

  private event(event: string, fields: Record<string, unknown>): void {
    this.options.onEvent?.(event, fields);
  }
}

export interface MonitorTriggerRuntimeOptions {
  readonly monitors: MonitorStore;
  readonly config: MonitorRuntimeConfig;
  readonly onTrigger: MonitorTriggerSink;
  readonly onEvent?: (event: string, fields: Record<string, unknown>) => void;
}

/** Owns non-cron ingress; cron scheduling is intentionally separate. */
export class MonitorTriggerRuntime {
  public readonly webhook: WebhookServer;
  public readonly watcher: WatcherTrigger;
  public readonly script: ScriptTrigger;

  public constructor(options: MonitorTriggerRuntimeOptions) {
    this.webhook = new WebhookServer({
      monitors: options.monitors,
      onTrigger: options.onTrigger,
      port: options.config.webhookPort,
      onEvent: options.onEvent,
    });
    this.watcher = new WatcherTrigger({
      monitors: options.monitors,
      watcherRoots: options.config.watcherRoots,
      onTrigger: options.onTrigger,
      onEvent: options.onEvent,
    });
    this.script = new ScriptTrigger({
      monitors: options.monitors,
      scriptRoot: options.config.scriptRoot,
      onTrigger: options.onTrigger,
      onEvent: options.onEvent,
    });
  }

  public async start(): Promise<void> {
    await this.webhook.start();
    this.watcher.start();
    this.script.start();
  }

  public async refresh(): Promise<void> {
    await this.webhook.refresh();
    this.watcher.refresh();
    this.script.refresh();
  }

  public async stop(): Promise<void> {
    this.watcher.stop();
    this.script.stop();
    await this.webhook.stop();
  }
}

export function defaultMonitorRuntimeConfig(): MonitorRuntimeConfig {
  return { watcherRoots: [], webhookPort: 17_358 };
}

export async function readMonitorRuntimeConfig(path: string): Promise<MonitorRuntimeConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`config.json cannot be read for monitors: ${messageOf(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error("config.json must contain an object");
  }
  const defaults = defaultMonitorRuntimeConfig();
  const watcherRoots = parsed.watcherRoots === undefined ? defaults.watcherRoots : readConfiguredRoots(parsed.watcherRoots);
  const scriptRoot = parsed.scriptRoot === undefined ? undefined : configuredAbsolutePath(parsed.scriptRoot, "scriptRoot");
  const webhookPort = parsed.webhookPort === undefined ? defaults.webhookPort : parseWebhookPort(parsed.webhookPort);
  return { watcherRoots, ...(scriptRoot === undefined ? {} : { scriptRoot }), webhookPort };
}

export function confinedArgv(scriptRoot: string, argv: readonly string[]): readonly string[] {
  const root = configuredAbsolutePath(scriptRoot, "scriptRoot");
  if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== "string") {
    throw new Error("script argv must include an executable");
  }
  if (isAbsolute(argv[0])) {
    throw new Error("script executable must be relative to scriptRoot");
  }
  const executable = resolve(root, argv[0]);
  if (!isInside(root, executable)) {
    throw new Error("script executable escapes scriptRoot");
  }
  const realRoot = existsSync(root) ? realpathSync(root) : root;
  const realExecutable = existsSync(executable) ? realpathSync(executable) : executable;
  if (!isInside(realRoot, realExecutable)) {
    throw new Error("script executable resolves outside scriptRoot");
  }
  return [executable, ...argv.slice(1)];
}

async function readWebhookPayload(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_WEBHOOK_BYTES) {
      throw new Error("webhook body exceeds 256 KiB");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function webhookOccurrence(request: IncomingMessage, payload: unknown): string {
  const supplied = request.headers["x-openinstinct-event-id"];
  if (typeof supplied === "string" && supplied.trim()) {
    return `webhook:${supplied.trim()}`;
  }
  return `webhook:${Date.now()}:${JSON.stringify(payload)}`;
}

function matchesWatcherRoot(monitor: MonitorSpec, root: string): boolean {
  if (monitor.trigger.kind !== "watcher" || monitor.trigger.roots.length === 0) {
    return true;
  }
  return monitor.trigger.roots.includes(root) || monitor.trigger.roots.includes(basename(root));
}

function acceptsEventType(monitor: MonitorSpec, full: string, short: string): boolean {
  return monitor.eventTypes.includes("*") || monitor.eventTypes.includes(full)
    || monitor.eventTypes.includes(short) || monitor.eventTypes.includes("watcher");
}

function runScript(argv: readonly string[], cwd: string): Promise<{ readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    const append = (current: string, chunk: Buffer): string => {
      const remaining = MAX_SCRIPT_OUTPUT_BYTES - Buffer.byteLength(current);
      return remaining <= 0 ? current : `${current}${chunk.subarray(0, remaining).toString("utf8")}`;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", rejectRun);
    child.once("close", (exitCode) => resolveRun({ exitCode, stdout, stderr }));
  });
}

function readConfiguredRoots(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error("watcherRoots must be an array");
  }
  return value.map((entry) => configuredAbsolutePath(entry, "watcherRoots entry"));
}

function configuredAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return resolve(value);
}

function parseWebhookPort(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 65_535) {
    throw new Error("webhookPort must be between 0 and 65535");
  }
  return value as number;
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
