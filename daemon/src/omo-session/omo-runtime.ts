import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  resolveCliModel,
  SessionManager,
  SettingsManager,
} from "@code-yeongyu/senpi";
import type {
  AgentSession,
  AgentSessionServices,
  InlineExtension,
  ToolDefinition,
} from "@code-yeongyu/senpi";

/**
 * Settings the daemon requires from the engine regardless of what the owner
 * left on disk: every queued owner text is delivered (steering/follow-up "all")
 * and compaction is driven by the daemon at 50%, not by the engine's default.
 */
const DAEMON_SETTINGS = {
  steeringMode: "all",
  followUpMode: "all",
  compaction: { enabled: false },
  quietStartup: true,
} as const;

/** Engine state directory owned by the daemon, isolated from the host's `~/.omo/agent`. */
export interface OmoAgentDir {
  readonly dir: string;
  readonly authJson: string;
  readonly modelsJson: string;
  readonly settingsJson: string;
  readonly sessions: string;
}

/** Layout of the engine state under the `~/.openinstinct` root. Pure path math. */
export function omoAgentDir(root: string): OmoAgentDir {
  const dir = join(root, "omo");
  return {
    dir,
    authJson: join(dir, "auth.json"),
    modelsJson: join(dir, "models.json"),
    settingsJson: join(dir, "settings.json"),
    sessions: join(dir, "sessions"),
  };
}

/** Creates the engine state directory and seeds its files. Idempotent. */
export function ensureOmoAgentDir(root: string): OmoAgentDir {
  const paths = omoAgentDir(root);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.sessions, { recursive: true, mode: 0o700 });
  seedPrivateFile(paths.settingsJson, JSON.stringify(DAEMON_SETTINGS));
  seedPrivateFile(paths.modelsJson, JSON.stringify({ providers: {} }));
  seedPrivateFile(paths.authJson, JSON.stringify({}));
  return paths;
}

function seedPrivateFile(path: string, content: string): void {
  if (!existsSync(path)) {
    writeFileSync(path, content, { mode: 0o600 });
  }
}

/**
 * Every environment variable the engine consults for its agent directory. The
 * engine reads `SENPI_*`; the `OMO_`/`PI_` aliases keep a child process started
 * through a different launcher generation on the same isolated state.
 */
export const OMO_AGENT_DIR_ENV_NAMES = [
  "SENPI_CODING_AGENT_DIR",
  "OMO_CODING_AGENT_DIR",
  "PI_CODING_AGENT_DIR",
] as const;

/** Environment overlay pinning a spawned engine process to `dir`. */
export function omoAgentDirEnv(dir: string): Record<string, string> {
  return Object.fromEntries(OMO_AGENT_DIR_ENV_NAMES.map((name) => [name, dir]));
}

/**
 * Engine tools the daemon never exposes: its own delegation and scheduling
 * primitives (the daemon owns children, wakeups, and goals), plus tools whose
 * side effects have no owner-visible surface here.
 */
export const DAEMON_EXCLUDED_TOOLS = [
  "eval",
  "schedule_wakeup",
  "create_goal",
  "update_goal",
  "get_goal",
  "todo",
  "apply_patch",
  "generate_image",
  "read_video",
  "monitor",
  "powershell",
] as const;

/** Settings for one session, held in memory so a disk edit cannot change a live session. */
export function isolatedSettings(): SettingsManager {
  return SettingsManager.inMemory({ ...DAEMON_SETTINGS }, {});
}

export interface OmoServicesOptions {
  readonly cwd: string;
  readonly agentDir: string;
  readonly appendSystemPrompt?: readonly string[];
  readonly extensions?: readonly InlineExtension[];
}

/**
 * Creates the cwd-bound engine services. Every resource the engine would
 * discover from disk is off: the daemon supplies its own persona text and
 * extensions, so an unrelated file in the working tree cannot change behaviour.
 */
export async function createOmoServices(options: OmoServicesOptions): Promise<AgentSessionServices> {
  return await createAgentSessionServices({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager: isolatedSettings(),
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [...(options.extensions ?? [])],
      appendSystemPrompt: [...(options.appendSystemPrompt ?? [])],
    },
  });
}

export type Model = NonNullable<AgentSession["model"]>;

export interface ResolvedModel {
  readonly model: Model;
  readonly warning?: string;
}

/**
 * Resolves a `provider/id` pattern, falling back to the first model that has
 * credentials so a stale configured pattern degrades to a working session
 * instead of a dead daemon.
 */
export async function resolveModel(services: AgentSessionServices, pattern: string): Promise<ResolvedModel> {
  const resolved = resolveCliModel({ cliModel: pattern, modelRuntime: services.modelRuntime });
  if (resolved.model !== undefined) {
    return { model: resolved.model };
  }
  const available = await services.modelRuntime.getAvailable();
  const fallback: Model | undefined = available[0];
  if (fallback === undefined) {
    throw new Error(`no usable model: ${resolved.error ?? "no provider has credentials"}`);
  }
  return { model: fallback, warning: `model ${pattern} not found; using ${modelLabel(fallback)}` };
}

export interface OpenOmoSessionOptions {
  readonly services: AgentSessionServices;
  readonly cwd: string;
  readonly sessionDir: string;
  /** Resume this transcript; omit to start a new one under `sessionDir`. */
  readonly sessionFile?: string;
  readonly model: Model;
  readonly customTools?: readonly ToolDefinition[];
  readonly excludeTools?: readonly string[];
}

/** Opens one engine session against already-created services. */
export async function openOmoSession(options: OpenOmoSessionOptions): Promise<AgentSession> {
  const sessionManager = options.sessionFile === undefined
    ? SessionManager.create(options.cwd, options.sessionDir)
    : SessionManager.open(options.sessionFile);
  const { session } = await createAgentSessionFromServices({
    services: options.services,
    sessionManager,
    model: options.model,
    customTools: [...(options.customTools ?? [])],
    excludeTools: [...(options.excludeTools ?? DAEMON_EXCLUDED_TOOLS)],
  });
  // Emits session_start, which is what makes declared MCP servers attach and
  // register their tools. A session that skips this has no browser tools.
  // Extension load failures are diagnostics, not session failures: they surface
  // as the missing tool at call time rather than a dead daemon at boot.
  await session.bindExtensions({ mode: "json", onError: () => {} });
  session.setSteeringMode("all");
  session.setAutoCompactionEnabled(false);
  return session;
}

/** Canonical `provider/id` label used in logs, settings, and warnings. */
export function modelLabel(model: Model): string {
  return `${model.provider}/${model.id}`;
}
