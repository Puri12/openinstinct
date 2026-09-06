export type MonitorTriggerKind = "cron" | "webhook" | "watcher" | "script";
export type BurstPolicy = "dedupe" | "coalesce" | "pass";

export interface CronTrigger {
  readonly kind: "cron";
  readonly expression: string;
}

export interface WebhookTrigger {
  readonly kind: "webhook";
  readonly token: string;
}

export interface WatcherTrigger {
  readonly kind: "watcher";
  /** Optional configured-root labels; an empty list observes all configured roots. */
  readonly roots: readonly string[];
}

export interface ScriptTrigger {
  readonly kind: "script";
  readonly argv: readonly string[];
  readonly intervalMs: number;
}

export type MonitorTrigger = CronTrigger | WebhookTrigger | WatcherTrigger | ScriptTrigger;

export interface CronTriggerInput {
  readonly kind: "cron";
  readonly expression: string;
}

export interface WebhookTriggerInput {
  readonly kind: "webhook";
  readonly token?: string;
}

export interface WatcherTriggerInput {
  readonly kind: "watcher";
  readonly roots?: readonly string[];
}

export interface ScriptTriggerInput {
  readonly kind: "script";
  readonly argv: readonly string[];
  readonly intervalMs: number;
}

export type MonitorTriggerInput = CronTriggerInput | WebhookTriggerInput | WatcherTriggerInput | ScriptTriggerInput;

export interface MonitorSpec {
  readonly id: string;
  readonly name: string;
  readonly trigger: MonitorTrigger;
  readonly instruction: string;
  readonly eventTypes: readonly string[];
  readonly burstPolicy: BurstPolicy;
  readonly tz: string;
  readonly timeoutSec: number;
  readonly enabled: boolean;
  /** ISO instant after which the monitor never fires again (auto-disabled). Default: none. */
  readonly expiresAt?: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastFiredAt?: string;
}

export interface MonitorCreateInput {
  readonly id?: string;
  readonly name: string;
  readonly trigger: MonitorTriggerInput;
  readonly instruction: string;
  readonly eventTypes?: readonly string[];
  readonly burstPolicy?: BurstPolicy;
  readonly tz?: string;
  readonly timeoutSec?: number;
  readonly expiresAt?: string | null;
  readonly enabled?: boolean;
}

export interface MonitorUpdateInput {
  readonly name?: string;
  readonly trigger?: MonitorTriggerInput;
  readonly instruction?: string;
  readonly eventTypes?: readonly string[];
  readonly burstPolicy?: BurstPolicy;
  readonly tz?: string;
  readonly timeoutSec?: number;
  readonly expiresAt?: string | null;
  readonly enabled?: boolean;
}

export interface MonitorTriggerEvent {
  readonly eventType: string;
  readonly payload: unknown;
  readonly catchUp?: boolean;
  /** Source-defined unique occurrence key. Dedupe and pass policies respect it. */
  readonly occurrenceKey?: string;
}

/**
 * Builds the trigger event for an on-demand run. A manual run is an explicit
 * owner command, not a subscription match, so it borrows the monitor's own
 * first subscribed event type: a literal "manual" type would be filtered out
 * by `acceptsEventType` for every monitor that subscribes to something
 * narrower. The unique occurrence key stops a dedupe-policy monitor from
 * collapsing the run into a recent scheduled occurrence.
 */
export function manualTriggerEvent(monitor: MonitorSpec, now: Date): MonitorTriggerEvent {
  const subscribed = monitor.eventTypes.find((eventType) => eventType !== "*");
  return {
    eventType: subscribed ?? "manual",
    payload: { manual: true, requestedAt: now.toISOString() },
    occurrenceKey: `manual:${now.toISOString()}`,
  };
}

/** Built-in monitors the memory lifecycle depends on; never toggled or deleted. */
export const PROTECTED_MONITOR_IDS = new Set(["memory-canonicalize", "memory-audit"]);

export class MonitorProtectedError extends Error {
  public constructor(public readonly id: string) {
    super(`monitor ${id} is built in and cannot be disabled or deleted`);
    this.name = "MonitorProtectedError";
  }
}

export class MonitorBusyError extends Error {
  public constructor(public readonly id: string) {
    super(`monitor ${id} has a firing in flight; disable it and retry once it settles`);
    this.name = "MonitorBusyError";
  }
}

export class MonitorNotFoundError extends Error {
  public constructor(id: string) {
    super(`monitor does not exist: ${id}`);
    this.name = "MonitorNotFoundError";
  }
}

export class MonitorRevisionConflictError extends Error {
  public constructor(id: string, expectedRevision: number) {
    super(`monitor revision conflict: ${id} expected ${expectedRevision}`);
    this.name = "MonitorRevisionConflictError";
  }
}
