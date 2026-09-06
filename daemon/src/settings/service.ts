import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { AgentSessionServices } from "@code-yeongyu/senpi";

import { normalizeHandle } from "../imessage/allowlist.ts";
import { loadSoul } from "../persona/soul.ts";
import type { DataPaths } from "../paths.ts";
import { createOmoServices, ensureOmoAgentDir, omoAgentDir } from "../omo-session/omo-runtime.ts";
import {
  DEFAULT_CHILD_IDLE_TIMEOUT_MS,
  DEFAULT_CHILD_INTERIM_BATCH_MS,
  DEFAULT_CHILD_INTERIM_MAX_BYTES,
  DEFAULT_CHILD_INTERIM_RATE_PER_MINUTE,
  DEFAULT_CHILD_STATUS_LIST_LIMIT,
  DEFAULT_CHILD_STATUS_TEXT_BYTES,
  DEFAULT_CHILD_TOOL_GUARD_MS,
  DEFAULT_CHILD_WARM_TTL_MS,
  DEFAULT_CONVERSATIONAL_CHILD_TIMEOUT_MS,
  DEFAULT_DAEMON_CHILD_TIMEOUT_MS,
  DEFAULT_MAIN_SESSION_MODEL,
  DEFAULT_MAIN_TURN_WATCHDOG_MS,
  DEFAULT_MAX_CONCURRENT_CHILDREN,
  DEFAULT_MAX_LIVE_CHILDREN,
  readRuntimeConfig,
} from "../runtime-config.ts";
import { validateCron } from "../monitors/store.ts";
import { adoptCredential as adoptExternalCredential, discoverCredentials as discoverExternalCredentials, PROVIDER_LABELS } from "./credential-adopt.ts";
import type { DiscoveredCredential } from "./credential-adopt.ts";
import { parseEnvFile, writeEnvFile } from "./env.ts";

/** Which keys the panel may read (as set/unset) and write in ~/.openinstinct/env. */
export const MANAGED_ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENGATEWAY_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "PUPPETEER_EXECUTABLE_PATH",
] as const;

export const MANAGED_CREDENTIAL_ENV_KEYS: readonly string[] = MANAGED_ENV_KEYS.filter(
  (key) => key.endsWith("_API_KEY") || key === "ANTHROPIC_OAUTH_TOKEN",
);
export const OI_API_KEY_PATTERN = /^OI_[A-Z0-9_]+_API_KEY$/;
export const MANAGED_OI_API_KEY_PATTERN = OI_API_KEY_PATTERN;

/** Sign-in options the panel surfaces first; everything else the engine knows follows alphabetically. */
const POPULAR_OAUTH_PROVIDERS: readonly string[] = ["anthropic", "openai-codex", "github-copilot"];

export interface SettingsSnapshot {
  readonly ownerHandle: string;
  readonly ownerName: string;
  readonly mainSessionModel: string;
  readonly fastMode: boolean;
  readonly mainTurnWatchdogSec: number;
  readonly childMaxConcurrent: number;
  readonly childConversationalTimeoutSec: number;
  readonly childDaemonTimeoutSec: number;
  readonly childWarmTtlSec: number;
  readonly childIdleTimeoutSec: number;
  readonly childMaxLive: number;
  readonly childInterimBatchSec: number;
  readonly childInterimRatePerMinute: number;
  readonly childInterimMaxBytes: number;
  readonly childStatusListLimit: number;
  readonly childStatusTextBytes: number;
  readonly childToolGuardMs: number;
  readonly env: readonly { readonly key: string; readonly set: boolean }[];
  readonly soulVersion: string;
  readonly soulText: string;
  readonly configPath: string;
}

export interface SettingsPatch {
  readonly ownerHandle?: string;
  readonly ownerName?: string;
  readonly mainSessionModel?: string;
  readonly fastMode?: boolean;
  readonly mainTurnWatchdogSec?: number;
  readonly childMaxConcurrent?: number;
  readonly childConversationalTimeoutSec?: number;
  readonly childDaemonTimeoutSec?: number;
  readonly childWarmTtlSec?: number;
  readonly childIdleTimeoutSec?: number;
  readonly childMaxLive?: number;
  readonly childInterimBatchSec?: number;
  readonly childInterimRatePerMinute?: number;
  readonly childInterimMaxBytes?: number;
  readonly childStatusListLimit?: number;
  readonly childStatusTextBytes?: number;
  readonly childToolGuardMs?: number;
  /** Empty string unsets. */
  readonly env?: Readonly<Record<string, string>>;
  readonly soulText?: string;
}

export interface ModelChoice {
  readonly id: string;
  readonly provider: string;
  readonly canonical: string;
}

export interface AccountRow {
  readonly id: string;
  readonly provider: string;
  readonly kind: string;
  readonly identity: string | null;
  readonly health: string;
}

export interface SettingsServiceOptions {
  readonly paths: DataPaths;
  readonly soulPath: string;
}

/** One in-flight OAuth attempt: the engine drives it, the panel supplies the code. */
interface PendingLogin {
  readonly provider: string;
  /** Resolves once the engine has stored the credential. */
  readonly completion: Promise<void>;
  readonly abort: AbortController;
  /** Hands the pasted code to the engine's waiting prompt. */
  readonly submitCode: (code: string) => void;
}

/**
 * Every owner-tunable surface behind one door so the panel can edit it. Writes
 * are validated with the same parsers the daemon boots with, so a bad value is
 * rejected here instead of taking the daemon down on the next restart.
 */
export class SettingsService {
  private pendingLogin: PendingLogin | undefined;
  private engineServices: Promise<AgentSessionServices> | undefined;

  public constructor(private readonly options: SettingsServiceOptions) {}

  /**
   * The engine services this daemon owns, bound to its isolated agent dir. The
   * instance caches auth and model state at creation, so every write to
   * `auth.json` / `models.json` must drop it via {@link invalidateEngine}.
   */
  private engine(): Promise<AgentSessionServices> {
    this.engineServices ??= (async (): Promise<AgentSessionServices> => {
      const agent = ensureOmoAgentDir(this.options.paths.root);
      return await createOmoServices({ cwd: this.options.paths.session, agentDir: agent.dir });
    })();
    return this.engineServices;
  }

  /** Drops the cached engine so the next call re-reads auth.json and models.json. */
  public invalidateEngine(): void {
    this.engineServices = undefined;
  }

  public async snapshot(): Promise<SettingsSnapshot> {
    const raw = this.readConfigRaw();
    const config = await readRuntimeConfig(this.options.paths.config).catch(() => undefined);
    const soul = loadSoul(this.options.soulPath);
    const env = parseEnvFile(this.options.paths.envFile);
    return {
      ownerHandle: config?.allowlistHandle ?? (typeof raw.allowlistHandle === "string" ? raw.allowlistHandle : ""),
      ownerName: typeof raw.ownerName === "string" ? raw.ownerName : "",
      mainSessionModel: config?.mainSessionModel ?? DEFAULT_MAIN_SESSION_MODEL,
      fastMode: this.fastModeEnabled(),
      mainTurnWatchdogSec: Math.round((config?.mainTurnWatchdogMs ?? DEFAULT_MAIN_TURN_WATCHDOG_MS) / 1_000),
      childMaxConcurrent: config?.children.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_CHILDREN,
      childConversationalTimeoutSec: Math.round((config?.children.conversationalTimeoutMs ?? DEFAULT_CONVERSATIONAL_CHILD_TIMEOUT_MS) / 1_000),
      childDaemonTimeoutSec: Math.round((config?.children.daemonTimeoutMs ?? DEFAULT_DAEMON_CHILD_TIMEOUT_MS) / 1_000),
      childWarmTtlSec: Math.round((config?.children.warmTtlMs ?? DEFAULT_CHILD_WARM_TTL_MS) / 1_000),
      childIdleTimeoutSec: Math.round((config?.children.idleTimeoutMs ?? DEFAULT_CHILD_IDLE_TIMEOUT_MS) / 1_000),
      childMaxLive: config?.children.maxLive ?? DEFAULT_MAX_LIVE_CHILDREN,
      childInterimBatchSec: Math.round((config?.children.interimBatchMs ?? DEFAULT_CHILD_INTERIM_BATCH_MS) / 1_000),
      childInterimRatePerMinute: config?.children.interimRatePerMinute ?? DEFAULT_CHILD_INTERIM_RATE_PER_MINUTE,
      childInterimMaxBytes: config?.children.interimMaxBytes ?? DEFAULT_CHILD_INTERIM_MAX_BYTES,
      childStatusListLimit: config?.children.statusListLimit ?? DEFAULT_CHILD_STATUS_LIST_LIMIT,
      childStatusTextBytes: config?.children.statusTextMaxBytes ?? DEFAULT_CHILD_STATUS_TEXT_BYTES,
      childToolGuardMs: config?.children.toolLatencyGuardMs ?? DEFAULT_CHILD_TOOL_GUARD_MS,
      env: MANAGED_ENV_KEYS.map((key) => ({ key, set: env.has(key) && (env.get(key) ?? "").length > 0 })),
      soulVersion: soul.version,
      soulText: soul.text,
      configPath: this.options.paths.config,
    };
  }

  /** Returns which restart-scoped things changed so the caller can reload/restart. */
  public async apply(patch: SettingsPatch): Promise<{
    readonly needsRestart: boolean;
    readonly needsReload: boolean;
    readonly ownerHandleChanged: boolean;
  }> {
    let needsRestart = false;
    let needsReload = false;
    let fastModeChange: boolean | undefined;
    let ownerHandleChanged = false;
    const raw = this.readConfigRaw();

    if (patch.ownerHandle !== undefined) {
      if (patch.ownerHandle.length === 0) {
        delete raw.allowlistHandle;
      } else {
        const normalized = normalizeHandle(patch.ownerHandle);
        if (!normalized) {
          throw new Error("Owner handle must be a phone number with country code or an email");
        }
        raw.allowlistHandle = normalized;
      }
      needsReload = true;
      ownerHandleChanged = true;
    }
    if (patch.ownerName !== undefined) {
      raw.ownerName = patch.ownerName.trim();
      needsReload = true;
    }
    if (patch.mainSessionModel !== undefined) {
      const model = patch.mainSessionModel.trim();
      if (!/^[a-z0-9-]+\/[A-Za-z0-9._:/-]+$/.test(model)) {
        throw new Error("Model must look like provider/model-id");
      }
      raw.mainSessionModel = model;
      // Children runners capture the model at boot; a restart applies it everywhere.
      needsRestart = true;
    }
    if (patch.fastMode !== undefined) {
      fastModeChange = patch.fastMode;
      needsReload = true;
    }
    if (patch.mainTurnWatchdogSec !== undefined) {
      raw.mainTurnWatchdogMs = positiveSeconds(patch.mainTurnWatchdogSec, "Reply time limit") * 1_000;
      needsRestart = true;
    }
    const children = isRecord(raw.children) ? { ...raw.children } : {};
    if (patch.childMaxConcurrent !== undefined) {
      const n = patch.childMaxConcurrent;
      if (!Number.isSafeInteger(n) || n < 1 || n > 16) {
        throw new Error("Background tasks at once must be 1–16");
      }
      children.maxConcurrent = n;
      needsRestart = true;
    }
    if (patch.childConversationalTimeoutSec !== undefined) {
      children.conversationalTimeoutMs = positiveSeconds(patch.childConversationalTimeoutSec, "Background task time limit") * 1_000;
      needsRestart = true;
    }
    if (patch.childDaemonTimeoutSec !== undefined) {
      children.daemonTimeoutMs = positiveSeconds(patch.childDaemonTimeoutSec, "Scheduled task time limit") * 1_000;
      needsRestart = true;
    }
    if (patch.childWarmTtlSec !== undefined) {
      children.warmTtlMs = boundedInteger(
        patch.childWarmTtlSec,
        "Keep finished tasks warm",
        60,
        86_400,
        "between 60 seconds and 24 hours",
      ) * 1_000;
      needsRestart = true;
    }
    if (patch.childIdleTimeoutSec !== undefined) {
      children.idleTimeoutMs = boundedInteger(
        patch.childIdleTimeoutSec,
        "Forget idle tasks",
        300,
        86_400,
        "between 300 seconds and 24 hours",
      ) * 1_000;
      needsRestart = true;
    }
    if (patch.childMaxLive !== undefined) {
      children.maxLive = boundedInteger(patch.childMaxLive, "Live background tasks", 1, 64, "1–64");
      needsRestart = true;
    }
    if (patch.childInterimBatchSec !== undefined) {
      children.interimBatchMs = boundedInteger(
        patch.childInterimBatchSec,
        "Bundle task updates",
        1,
        60,
        "1–60 seconds",
      ) * 1_000;
      needsRestart = true;
    }
    if (patch.childInterimRatePerMinute !== undefined) {
      children.interimRatePerMinute = boundedInteger(
        patch.childInterimRatePerMinute,
        "Updates per task per minute",
        1,
        60,
        "1–60",
      );
      needsRestart = true;
    }
    if (patch.childInterimMaxBytes !== undefined) {
      children.interimMaxBytes = boundedInteger(
        patch.childInterimMaxBytes,
        "Progress update size",
        128,
        8_192,
        "128–8192 bytes",
      );
      needsRestart = true;
    }
    if (patch.childStatusListLimit !== undefined) {
      children.statusListLimit = boundedInteger(
        patch.childStatusListLimit,
        "Background task status list limit",
        1,
        100,
        "1–100",
      );
      needsRestart = true;
    }
    if (patch.childStatusTextBytes !== undefined) {
      children.statusTextMaxBytes = boundedInteger(
        patch.childStatusTextBytes,
        "Background task status text",
        128,
        8_192,
        "128–8192 bytes",
      );
      needsRestart = true;
    }
    if (patch.childToolGuardMs !== undefined) {
      children.toolLatencyGuardMs = boundedInteger(
        patch.childToolGuardMs,
        "Background task latency alert threshold",
        5,
        1_000,
        "5–1000 ms",
      );
      needsRestart = true;
    }
    const maxConcurrent = childIntegerOrDefault(children.maxConcurrent, DEFAULT_MAX_CONCURRENT_CHILDREN);
    const maxLive = childIntegerOrDefault(children.maxLive, DEFAULT_MAX_LIVE_CHILDREN);
    if (maxLive < maxConcurrent) {
      throw new Error("Live background tasks must be greater than or equal to background tasks at once");
    }
    if (Object.keys(children).length > 0) {
      raw.children = children;
    }

    if (patch.env !== undefined) {
      const env = parseEnvFile(this.options.paths.envFile);
      let credentialEnvTouched = false;
      for (const [key, value] of Object.entries(patch.env)) {
        if (!(MANAGED_ENV_KEYS as readonly string[]).includes(key) && !OI_API_KEY_PATTERN.test(key)) {
          throw new Error(`${key} is not a managed setting`);
        }
        if (MANAGED_CREDENTIAL_ENV_KEYS.includes(key) || OI_API_KEY_PATTERN.test(key)) {
          credentialEnvTouched = true;
        }
        if (value.length === 0) {
          env.delete(key);
        } else if (/[\r\n]/.test(value)) {
          throw new Error(`${key} must be a single line`);
        } else {
          env.set(key, value);
        }
      }
      writeEnvFile(this.options.paths.envFile, env);
      if (credentialEnvTouched) {
        this.invalidate("accounts");
      }
      needsRestart = true;
    }

    if (patch.soulText !== undefined) {
      const text = patch.soulText.trim();
      if (text.length < 40) {
        throw new Error("Personality text is too short to be a personality");
      }
      const current = loadSoul(this.options.soulPath);
      const next = Number.isSafeInteger(Number(current.version)) ? String(Number(current.version) + 1) : "1";
      writeFileSync(this.options.soulPath, `<!-- soul-version: ${next} -->\n${text}\n`);
      needsReload = true;
    }

    // Validate the whole file with the boot parser before committing it.
    const draft = `${this.options.paths.config}.draft`;
    writeFileSync(draft, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    try {
      await readRuntimeConfig(draft);
    } catch (error) {
      throw new Error(`Settings rejected: ${error instanceof Error ? error.message : String(error)}`);
    }
    writeFileSync(this.options.paths.config, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    if (fastModeChange !== undefined) {
      this.setFastMode(fastModeChange);
    }
    return { needsRestart, needsReload, ownerHandleChanged };
  }


  /** Persists provider priority off after the omo engine reports a fast-mode rejection. */
  public async disableFastMode(): Promise<void> {
    this.setFastMode(false);
  }

  private fastModeEnabled(): boolean {
    const openai = readJsonObject(omoAgentDir(this.options.paths.root).settingsJson).openai;
    return isRecord(openai) && openai.serviceTier === "priority";
  }

  /** Engine settings are shared with the child runners, so only the tier key is rewritten. */
  private setFastMode(enabled: boolean): void {
    const settingsJson = ensureOmoAgentDir(this.options.paths.root).settingsJson;
    const settings = { ...readJsonObject(settingsJson), openai: { serviceTier: enabled ? "priority" : "auto" } };
    writeFileSync(settingsJson, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  }
  /**
   * After a sign-in, pick a sensible main model for that provider unless the
   * owner already chose one explicitly. Public model ids only.
   */
  public async defaultModelFor(provider: string): Promise<string | undefined> {
    const raw = this.readConfigRaw();
    if (typeof raw.mainSessionModel === "string") {
      return undefined;
    }
    const preferred: Record<string, string> = {
      "anthropic": "anthropic/claude-sonnet-4-5",
      "openai-codex": "openai-codex/gpt-5",
      "openai": "openai/gpt-5",
    };
    const wanted = preferred[provider];
    if (!wanted) {
      return undefined;
    }
    const available = await this.listModels().catch(() => []);
    const hit = available.find((m) => m.id === wanted) ?? available.find((m) => m.provider === provider);
    if (!hit) {
      return undefined;
    }
    raw.mainSessionModel = hit.id;
    writeFileSync(this.options.paths.config, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    return hit.id;
  }

  /** OAuth providers the engine knows, popular ones first, so new ones appear without a daemon change. */
  private async listOAuthProvidersUncached(): Promise<{ readonly id: string; readonly label: string; readonly popular: boolean }[]> {
    const services = await this.engine();
    return services.authStorage.getOAuthProviders()
      .map(({ id }) => ({ id, label: PROVIDER_LABELS[id] ?? id, popular: POPULAR_OAUTH_PROVIDERS.includes(id) }))
      .sort((left, right) => Number(right.popular) - Number(left.popular) || left.label.localeCompare(right.label));
  }

  /**
   * Registers a custom OpenAI/Anthropic-compatible endpoint as an engine
   * provider in the daemon's `models.json`, stores its key in the env file, and
   * selects `<id>/<model>` as the main model.
   */
  public async addCustomProvider(input: { readonly id: string; readonly baseUrl: string; readonly api: "openai-responses" | "openai-completions" | "anthropic-messages"; readonly apiKey: string; readonly model: string }): Promise<{ readonly modelId: string }> {
    const id = input.id.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{1,30}$/.test(id)) throw new Error("Provider name: letters, digits, dashes (e.g. my-gateway)");
    if (!/^https?:\/\/\S+$/.test(input.baseUrl.trim())) throw new Error("Base URL must start with http:// or https://");
    if (!/^[A-Za-z0-9._:-]+$/.test(input.model.trim())) throw new Error("Model id looks wrong");
    if (input.apiKey.trim().length === 0) throw new Error("API key is required");
    const envKey = `OI_${id.toUpperCase().replace(/-/g, "_")}_API_KEY`;
    const env = parseEnvFile(this.options.paths.envFile);
    env.set(envKey, input.apiKey.trim());
    writeEnvFile(this.options.paths.envFile, env);
    const modelsJson = ensureOmoAgentDir(this.options.paths.root).modelsJson;
    const catalog = readJsonObject(modelsJson);
    const model = input.model.trim();
    const providers = { ...(isRecord(catalog.providers) ? catalog.providers : {}) };
    providers[id] = {
      name: id,
      baseUrl: input.baseUrl.trim().replace(/\/+$/, ""),
      api: input.api,
      apiKey: input.apiKey.trim(),
      models: [{
        id: model,
        name: model,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8_192,
      }],
    };
    writeFileSync(modelsJson, `${JSON.stringify({ ...catalog, providers }, null, 2)}\n`, { mode: 0o600 });
    this.invalidateEngine();
    this.invalidate("models");
    this.invalidate("accounts");

    const modelId = `${id}/${model}`;
    const raw = this.readConfigRaw();
    raw.mainSessionModel = modelId;
    writeFileSync(this.options.paths.config, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    return { modelId };
  }

  private cache = new Map<string, { at: number; value: unknown; inflight?: Promise<unknown> }>();

  /** Serve the last result instantly and refresh in the background when stale. */
  private cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const entry = this.cache.get(key);
    if (entry?.at === 0 && entry.inflight) {
      return entry.inflight as Promise<T>;
    }
    const fresh = entry !== undefined && Date.now() - entry.at < ttlMs;
    if (entry && !entry.inflight && !fresh) {
      entry.inflight = load().then((value) => { this.cache.set(key, { at: Date.now(), value }); return value; }).catch(() => entry.value);
    }
    if (entry) {
      return Promise.resolve(entry.value as T);
    }
    const inflight = load().then((value) => { this.cache.set(key, { at: Date.now(), value }); return value; });
    this.cache.set(key, { at: 0, value: undefined, inflight });
    return inflight;
  }

  /** Warm the slow engine-backed lists so the panel opens instantly. */
  public warm(): void {
    void this.listModels().catch(() => undefined);
    void this.listOAuthProviders().catch(() => undefined);
    void this.listAccounts().catch(() => undefined);
  }

  public listModels(): Promise<ModelChoice[]> {
    return this.cached("models", 10 * 60_000, () => this.listModelsUncached());
  }

  public listAccounts(): Promise<AccountRow[]> {
    return this.cached("accounts", 60_000, () => this.listAccountsUncached());
  }

  public discoverCredentials(): Promise<{ readonly credentials: readonly DiscoveredCredential[] }> {
    return discoverExternalCredentials().then((credentials) => ({ credentials }));
  }

  public async adoptCredential(id: string): Promise<{ readonly adopted: boolean; readonly provider: string; readonly restarting: boolean }> {
    const { provider } = await adoptExternalCredential(id, { authPath: ensureOmoAgentDir(this.options.paths.root).authJson });
    this.invalidateEngine();
    return { adopted: true, provider, restarting: true };
  }

  public listOAuthProviders(): Promise<{ readonly id: string; readonly label: string; readonly popular: boolean }[]> {
    return this.cached("providers", 60 * 60_000, () => this.listOAuthProvidersUncached());
  }

  public invalidate(key?: string): void {
    if (key === undefined) {
      this.cache.clear();
      return;
    }
    this.cache.delete(key);
  }

  private async listModelsUncached(): Promise<ModelChoice[]> {
    const services = await this.engine();
    const models = await services.modelRuntime.getAvailable();
    return models
      .map((model) => ({ id: `${model.provider}/${model.id}`, provider: model.provider, canonical: model.id }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }


  /** The engine keys credentials by provider, so a provider has at most one account row. */
  private async listAccountsUncached(): Promise<AccountRow[]> {
    const services = await this.engine();
    const credentials = await services.modelRuntime.listCredentials();
    return credentials.map(({ providerId, type }) => ({
      id: `${providerId}:stored`,
      provider: providerId,
      kind: type,
      identity: credentialIdentity(services.authStorage.get(providerId)),
      health: "unknown",
    }));
  }

  /**
   * Runs the engine's OAuth flow in this process. The engine publishes the
   * authorization URL and then waits for either its localhost callback or a
   * pasted code; we hand the URL to the panel (which opens it) and leave the
   * flow running until {@link finishLogin}. Tokens go straight to the daemon's
   * own `auth.json` — nothing is returned to the caller.
   */
  public async startLogin(provider: string): Promise<{ readonly url: string; readonly manual: boolean }> {
    if (!/^[a-z0-9-]+$/.test(provider)) {
      throw new Error("bad provider id");
    }
    if (this.pendingLogin) {
      this.abortPendingLogin(this.pendingLogin);
    }
    const services = await this.engine();
    const abort = new AbortController();
    const authorization = Promise.withResolvers<string>();
    const code = Promise.withResolvers<string>();
    const completion = services.authStorage.login(provider, {
      onAuth: ({ url }) => { authorization.resolve(url); },
      onDeviceCode: ({ verificationUri }) => { authorization.resolve(verificationUri); },
      onPrompt: () => code.promise,
      onManualCodeInput: () => code.promise,
      onSelect: async (prompt) => prompt.options[0]?.id,
      signal: abort.signal,
    });
    const pending: PendingLogin = { provider, completion, abort, submitCode: code.resolve };
    this.pendingLogin = pending;
    // Nothing awaits the flow until finishLogin, so an abandoned attempt would
    // surface as an unhandled rejection; finishLogin re-awaits and rethrows.
    void completion.catch(() => undefined);
    const url = await Promise.race([
      authorization.promise,
      // A flow that ends before publishing a URL has failed: its rejection is
      // the useful error, and a success leaves nothing for the panel to open.
      completion.then(() => undefined),
      afterMs(30_000),
    ]).catch((error: unknown) => {
      this.abortPendingLogin(pending);
      throw error;
    });
    if (url === undefined) {
      this.abortPendingLogin(pending);
      throw new Error(`omo engine did not produce a login URL for ${provider}`);
    }
    return { url, manual: true };
  }

  /**
   * Completes a login with the redirect URL / code the owner pasted. A flow
   * that already finished through its localhost callback never asked for one,
   * and simply reports the credential it stored.
   */
  public async finishLogin(codeOrUrl: string): Promise<void> {
    const pending = this.pendingLogin;
    if (!pending) {
      throw new Error("no login in progress");
    }
    this.pendingLogin = undefined;
    pending.submitCode(codeOrUrl.trim());
    // The tag distinguishes a flow that resolved void from the expired deadline.
    const finished = await Promise.race([pending.completion.then(() => "stored" as const), afterMs(60_000)]).catch((error: unknown) => {
      pending.abort.abort();
      throw error;
    });
    if (finished === undefined) {
      pending.abort.abort();
      throw new Error("login did not complete in time");
    }
    this.invalidateEngine();
    this.invalidate("accounts");
    await this.defaultModelFor(pending.provider);
  }

  /** Ends an attempt: the engine's callback server and its pending prompt stop with it. */
  private abortPendingLogin(pending: PendingLogin): void {
    pending.abort.abort();
    if (this.pendingLogin === pending) {
      this.pendingLogin = undefined;
    }
  }

  /** The engine stores one credential per provider, so the account id names the only row there is. */
  public async logout(provider: string, _account: string): Promise<void> {
    const services = await this.engine();
    services.authStorage.logout(provider);
    this.invalidateEngine();
    this.invalidate("accounts");
  }

  private readConfigRaw(): Record<string, unknown> {
    if (!existsSync(this.options.paths.config)) {
      return {};
    }
    const parsed: unknown = JSON.parse(readFileSync(this.options.paths.config, "utf8"));
    return isRecord(parsed) ? { ...parsed } : {};
  }
}

/** Resolves `undefined` after `ms`; unref'd so a pending deadline never holds the process open. */
function afterMs(ms: number): Promise<undefined> {
  return new Promise((resolve) => { setTimeout(() => { resolve(undefined); }, ms).unref(); });
}

/** Account label for a stored credential; providers carry it as their own extra field. */
function credentialIdentity(credential: unknown): string | null {
  if (!isRecord(credential)) {
    return null;
  }
  const identity = credential.identity;
  if (isRecord(identity) && typeof identity.email === "string") {
    return identity.email;
  }
  return typeof credential.accountId === "string" ? credential.accountId : null;
}

/** A JSON object file the daemon merges into; anything unreadable starts empty. */
function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {};
  }
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return isRecord(parsed) ? parsed : {};
}


function positiveSeconds(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 5 || value > 86_400) {
    throw new Error(`${label} must be between 5 seconds and 24 hours`);
  }
  return Math.round(value);
}

function boundedInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
  range: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be ${range}`);
  }
  return value;
}

function childIntegerOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Re-exported so the panel's cron helper can validate before authoring.
export { validateCron };
