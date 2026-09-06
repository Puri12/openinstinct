import { readFile } from "node:fs/promises";

import { normalizeHandle } from "./imessage/allowlist.ts";

export const DEFAULT_DELIVERY_MAX_ATTEMPTS = 3;
export const DEFAULT_DELIVERY_BACKOFF_MS = [5_000, 25_000, 125_000] as const;
export const DEFAULT_IMESSAGE_CLI_TIMEOUT_MS = 90_000;
export const DEFAULT_MAX_CONCURRENT_CHILDREN = 4;
export const DEFAULT_CONVERSATIONAL_CHILD_TIMEOUT_MS = 1_800_000;
export const DEFAULT_CHILD_WARM_TTL_MS = 600_000;
export const DEFAULT_CHILD_IDLE_TIMEOUT_MS = 86_400_000;
export const DEFAULT_MAX_LIVE_CHILDREN = 16;
export const DEFAULT_CHILD_STATUS_LIST_LIMIT = 20;
export const DEFAULT_CHILD_STATUS_TEXT_BYTES = 512;
export const DEFAULT_CHILD_TOOL_GUARD_MS = 50;
export const DEFAULT_CHILD_INTERIM_BATCH_MS = 3_000;
export const DEFAULT_CHILD_INTERIM_RATE_PER_MINUTE = 6;
export const DEFAULT_CHILD_INTERIM_MAX_BYTES = 1_024;
export const DEFAULT_DAEMON_CHILD_TIMEOUT_MS = 1_800_000;
export const DEFAULT_MAIN_SESSION_MODEL = "anthropic/claude-sonnet-4-5";
export const DEFAULT_MAIN_TURN_WATCHDOG_MS = 300_000;

export interface RuntimeConfig {
  readonly allowlistHandle?: string;
  readonly ownerName: string;
  /** Typing indicator / read receipts (briefly brings Messages forward). */
  readonly presence: { readonly enabled: boolean; readonly idleSec: number };
  /** Proactive check-in monitor interval in minutes (0 disables seeding). */
  readonly heartbeatMinutes: number;
  readonly delivery: {
    readonly maxAttempts: number;
    readonly retryBackoffMs: readonly number[];
    readonly timeoutMs: number;
  };
  readonly children: {
    readonly maxConcurrent: number;
    readonly conversationalTimeoutMs: number;
    readonly daemonTimeoutMs: number;
    readonly warmTtlMs: number;
    readonly idleTimeoutMs: number;
    readonly maxLive: number;
    readonly interimBatchMs: number;
    readonly interimRatePerMinute: number;
    readonly interimMaxBytes: number;
    readonly statusListLimit: number;
    readonly statusTextMaxBytes: number;
    readonly toolLatencyGuardMs: number;
  };
  readonly mainTurnWatchdogMs: number;
  /** omo engine model pattern for the main session, e.g. "anthropic/claude-sonnet-4-5". */
  readonly mainSessionModel: string;
}

/**
 * Product defaults for daemon-owned operational limits. iMessage delivery is
 * optional, so no owner handle is configured by default.
 */
export function defaultRuntimeConfig(): RuntimeConfig {
  return {
    ownerName: "",
    heartbeatMinutes: 10,
    presence: { enabled: true, idleSec: 3 },
    delivery: {
      maxAttempts: DEFAULT_DELIVERY_MAX_ATTEMPTS,
      retryBackoffMs: DEFAULT_DELIVERY_BACKOFF_MS,
      timeoutMs: DEFAULT_IMESSAGE_CLI_TIMEOUT_MS,
    },
    children: {
      maxConcurrent: DEFAULT_MAX_CONCURRENT_CHILDREN,
      conversationalTimeoutMs: DEFAULT_CONVERSATIONAL_CHILD_TIMEOUT_MS,
      daemonTimeoutMs: DEFAULT_DAEMON_CHILD_TIMEOUT_MS,
      warmTtlMs: DEFAULT_CHILD_WARM_TTL_MS,
      idleTimeoutMs: DEFAULT_CHILD_IDLE_TIMEOUT_MS,
      maxLive: DEFAULT_MAX_LIVE_CHILDREN,
      interimBatchMs: DEFAULT_CHILD_INTERIM_BATCH_MS,
      interimRatePerMinute: DEFAULT_CHILD_INTERIM_RATE_PER_MINUTE,
      interimMaxBytes: DEFAULT_CHILD_INTERIM_MAX_BYTES,
      statusListLimit: DEFAULT_CHILD_STATUS_LIST_LIMIT,
      statusTextMaxBytes: DEFAULT_CHILD_STATUS_TEXT_BYTES,
      toolLatencyGuardMs: DEFAULT_CHILD_TOOL_GUARD_MS,
    },
    mainTurnWatchdogMs: DEFAULT_MAIN_TURN_WATCHDOG_MS,
    mainSessionModel: DEFAULT_MAIN_SESSION_MODEL,
  };
}

/**
 * Reads the daemon-owned operational limits from config.json. Optional fields
 * always resolve to product defaults, so a missing config stays valid while
 * invalid explicit limits block startup rather than being ignored.
 */
export async function readRuntimeConfig(path: string): Promise<RuntimeConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      parsed = {};
    } else {
      throw new Error(`config.json cannot be read: ${messageOf(error)}`);
    }
  }
  if (!isRecord(parsed)) {
    throw new Error("config.json must contain an object");
  }

  const hasHandle = Object.prototype.hasOwnProperty.call(parsed, "allowlistHandle");
  const configuredHandle = typeof parsed.allowlistHandle === "string"
    ? normalizeHandle(parsed.allowlistHandle)
    : undefined;
  if (hasHandle && !configuredHandle) {
    throw new Error("config.json must contain a valid allowlistHandle");
  }

  const defaults = defaultRuntimeConfig();
  const delivery = optionalRecord(parsed.delivery, "delivery");
  const children = optionalRecord(parsed.children, "children");
  const config = {
    ...defaults,
    ownerName: typeof parsed.ownerName === "string" ? parsed.ownerName.trim() : defaults.ownerName,
    heartbeatMinutes: optionalNonNegativeInteger(parsed.heartbeatMinutes, "heartbeatMinutes", defaults.heartbeatMinutes),
    presence: {
      enabled: optionalRecord(parsed.presence, "presence").enabled !== false,
      idleSec: optionalPositiveInteger(optionalRecord(parsed.presence, "presence").idleSec, "presence.idleSec", defaults.presence.idleSec),
    },
    delivery: {
      maxAttempts: optionalPositiveInteger(delivery.maxAttempts, "delivery.maxAttempts", defaults.delivery.maxAttempts),
      retryBackoffMs: optionalBackoffLadder(delivery.retryBackoffMs),
      timeoutMs: optionalPositiveInteger(delivery.timeoutMs, "delivery.timeoutMs", defaults.delivery.timeoutMs),
    },
    children: {
      maxConcurrent: optionalPositiveInteger(children.maxConcurrent, "children.maxConcurrent", defaults.children.maxConcurrent),
      conversationalTimeoutMs: optionalPositiveInteger(
        children.conversationalTimeoutMs,
        "children.conversationalTimeoutMs",
        defaults.children.conversationalTimeoutMs,
      ),
      daemonTimeoutMs: optionalPositiveInteger(
        children.daemonTimeoutMs,
        "children.daemonTimeoutMs",
        defaults.children.daemonTimeoutMs,
      ),
      warmTtlMs: optionalPositiveInteger(children.warmTtlMs, "children.warmTtlMs", defaults.children.warmTtlMs),
      idleTimeoutMs: optionalPositiveInteger(children.idleTimeoutMs, "children.idleTimeoutMs", defaults.children.idleTimeoutMs),
      maxLive: optionalPositiveInteger(children.maxLive, "children.maxLive", defaults.children.maxLive),
      interimBatchMs: optionalPositiveInteger(children.interimBatchMs, "children.interimBatchMs", defaults.children.interimBatchMs),
      interimRatePerMinute: optionalPositiveInteger(
        children.interimRatePerMinute,
        "children.interimRatePerMinute",
        defaults.children.interimRatePerMinute,
      ),
      interimMaxBytes: optionalPositiveInteger(children.interimMaxBytes, "children.interimMaxBytes", defaults.children.interimMaxBytes),
      statusListLimit: optionalPositiveInteger(children.statusListLimit, "children.statusListLimit", defaults.children.statusListLimit),
      statusTextMaxBytes: optionalPositiveInteger(children.statusTextMaxBytes, "children.statusTextMaxBytes", defaults.children.statusTextMaxBytes),
      toolLatencyGuardMs: optionalPositiveInteger(children.toolLatencyGuardMs, "children.toolLatencyGuardMs", defaults.children.toolLatencyGuardMs),
    },
    mainSessionModel: typeof parsed.mainSessionModel === "string" && parsed.mainSessionModel.trim().length > 0
      ? parsed.mainSessionModel.trim()
      : defaults.mainSessionModel,
    mainTurnWatchdogMs: optionalPositiveInteger(
      parsed.mainTurnWatchdogMs,
      "mainTurnWatchdogMs",
      defaults.mainTurnWatchdogMs,
    ),
  };
  if (config.children.maxLive < config.children.maxConcurrent) {
    throw new Error("children.maxLive must be greater than or equal to children.maxConcurrent");
  }
  return configuredHandle === undefined ? config : { ...config, allowlistHandle: configuredHandle };
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { readonly code?: unknown }).code === code;
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function optionalPositiveInteger(value: unknown, label: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function optionalBackoffLadder(value: unknown): readonly number[] {
  if (value === undefined) {
    return DEFAULT_DELIVERY_BACKOFF_MS;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("delivery.retryBackoffMs must be a non-empty array");
  }
  return value.map((entry, index) => {
    if (!Number.isSafeInteger(entry) || entry <= 0) {
      throw new Error(`delivery.retryBackoffMs[${index}] must be a positive safe integer`);
    }
    return entry;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function optionalNonNegativeInteger(value: unknown, name: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}
