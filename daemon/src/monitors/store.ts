import { createHash, randomBytes, randomUUID } from "node:crypto";

import { Cron } from "croner";

import type {
  MonitorEventRecord,
  MonitorStoredRecord,
  StateStore,
} from "../store/index.ts";
import {
  type BurstPolicy,
  type MonitorCreateInput,
  type MonitorSpec,
  type MonitorTrigger,
  type MonitorTriggerEvent,
  type MonitorTriggerInput,
  type MonitorUpdateInput,
  MonitorBusyError,
  MonitorProtectedError,
  PROTECTED_MONITOR_IDS,
  MonitorNotFoundError,
  MonitorRevisionConflictError,
} from "./types.ts";

export const DEFAULT_MONITOR_TIMEOUT_SEC = 2_700;
export const DEFAULT_MONITOR_BURST_POLICY: BurstPolicy = "coalesce";
const WEBHOOK_TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

export interface MonitorStoreOptions {
  readonly now?: () => Date;
  readonly hostTimeZone?: string;
}

/**
 * Typed monitor facade over StateStore. It owns spec validation and JSON shape;
 * SQLite access remains entirely in StateStore.
 */
export class MonitorStore {
  private readonly now: () => Date;
  private readonly hostTimeZone: string;

  public constructor(private readonly store: StateStore, options: MonitorStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.hostTimeZone = normalizeTimeZone(options.hostTimeZone ?? hostTimeZone());
  }

  public create(input: MonitorCreateInput): MonitorSpec {
    const now = this.timestamp();
    const spec = normalizeCreate(input, now, this.hostTimeZone);
    const stored = this.store.createMonitor({
      id: spec.id,
      enabled: spec.enabled,
      specJson: serializeSpec(spec),
    }, now);
    return toSpec(stored);
  }

  public get(id: string): MonitorSpec | undefined {
    const stored = this.store.getMonitor(id);
    return stored === undefined ? undefined : toSpec(stored);
  }

  public list(): MonitorSpec[] {
    return this.store.listMonitors().map(toSpec);
  }

  public update(id: string, expectedRevision: number, patch: MonitorUpdateInput): MonitorSpec {
    const current = this.get(id);
    if (!current) {
      throw new MonitorNotFoundError(id);
    }
    const next = normalizeCreate({
      id: current.id,
      name: patch.name ?? current.name,
      trigger: patch.trigger ?? current.trigger,
      instruction: patch.instruction ?? current.instruction,
      eventTypes: patch.eventTypes ?? current.eventTypes,
      burstPolicy: patch.burstPolicy ?? current.burstPolicy,
      tz: patch.tz ?? current.tz,
      timeoutSec: patch.timeoutSec ?? current.timeoutSec,
      expiresAt: patch.expiresAt === undefined ? current.expiresAt : (patch.expiresAt === null ? undefined : normalizeExpiry(patch.expiresAt)),
      enabled: patch.enabled ?? current.enabled,
    }, current.createdAt, this.hostTimeZone);
    const stored = this.store.updateMonitor(id, expectedRevision, {
      id,
      enabled: next.enabled,
      specJson: serializeSpec(next),
    }, this.timestamp());
    if (stored) {
      return toSpec(stored);
    }
    throw this.conflictOrMissing(id, expectedRevision);
  }

  public toggle(id: string, enabled: boolean, expectedRevision: number): MonitorSpec {
    if (!enabled && PROTECTED_MONITOR_IDS.has(id)) {
      throw new MonitorProtectedError(id);
    }
    const stored = this.store.toggleMonitor(id, enabled, expectedRevision, this.timestamp());
    if (stored) {
      return toSpec(stored);
    }
    throw this.conflictOrMissing(id, expectedRevision);
  }

  public delete(id: string, expectedRevision: number): void {
    if (PROTECTED_MONITOR_IDS.has(id)) {
      throw new MonitorProtectedError(id);
    }
    const outcome = this.store.deleteMonitor(id, expectedRevision);
    if (outcome === "deleted") {
      return;
    }
    if (outcome === "busy") {
      throw new MonitorBusyError(id);
    }
    throw this.conflictOrMissing(id, expectedRevision);
  }

  public markFired(id: string, firedAt: Date): void {
    const now = this.timestamp();
    this.store.markMonitorFired(id, firedAt.toISOString(), now);
  }

  public admitEvent(monitor: MonitorSpec, event: MonitorTriggerEvent): MonitorEventRecord {
    if (!monitor.enabled) {
      throw new Error(`monitor is disabled: ${monitor.id}`);
    }
    const eventType = normalizedText(event.eventType, "monitor event type", 160);
    if (!acceptsEventType(monitor, eventType)) {
      throw new Error(`monitor does not accept event type: ${eventType}`);
    }
    const payloadJson = canonicalJson(event.payload);
    const occurrence = normalizedOccurrence(event.occurrenceKey, eventType, payloadJson);
    const id = randomUUID();
    const now = this.timestamp();
    const input = {
      id,
      monitorId: monitor.id,
      eventType,
      payloadJson,
      catchUp: event.catchUp === true,
      burstKey: burstKey(monitor, eventType),
      idempotencyKey: idempotencyKey(monitor, eventType, occurrence, id),
    };
    if (monitor.burstPolicy === "coalesce") {
      return this.store.coalesceMonitorEvent(input, now);
    }
    return this.store.admitMonitorEvent(input, now);
  }

  private conflictOrMissing(id: string, expectedRevision: number): Error {
    return this.store.getMonitor(id) === undefined
      ? new MonitorNotFoundError(id)
      : new MonitorRevisionConflictError(id, expectedRevision);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

export function validateCron(expression: string, timeZone: string): void {
  const pattern = normalizedText(expression, "cron expression", 240);
  const cron = new Cron(pattern, { timezone: normalizeTimeZone(timeZone), paused: true });
  try {
    // Reject sub-minute schedules at authoring: an every-second cron floods the
    // event store and the child queue faster than firings can complete.
    const runs = cron.nextRuns(2);
    if (runs.length === 2 && runs[1]!.getTime() - runs[0]!.getTime() < 60_000) {
      throw new Error("cron schedule must not fire more often than once per minute");
    }
  } finally {
    cron.stop();
  }
}

export function formatMonitorSchedule(spec: MonitorSpec): string {
  switch (spec.trigger.kind) {
    case "cron":
      return `cron ${spec.trigger.expression}`;
    case "webhook":
      return `webhook /hook/${spec.trigger.token}`;
    case "watcher":
      return "watcher";
    case "script":
      return `script every ${spec.trigger.intervalMs}ms`;
  }
}

function normalizeCreate(input: MonitorCreateInput, createdAt: string, defaultTimeZone: string): MonitorSpec {
  const tz = normalizeTimeZone(input.tz ?? defaultTimeZone);
  const trigger = normalizeTrigger(input.trigger, tz);
  const eventTypes = normalizeEventTypes(input.eventTypes ?? (trigger.kind === "watcher" ? ["*"] : [trigger.kind]));
  const timeoutSec = normalizeTimeout(input.timeoutSec ?? DEFAULT_MONITOR_TIMEOUT_SEC);
  const expiresAt = input.expiresAt ? normalizeExpiry(input.expiresAt) : undefined;
  const burstPolicy = normalizeBurstPolicy(input.burstPolicy ?? DEFAULT_MONITOR_BURST_POLICY);
  const id = input.id === undefined ? randomUUID() : normalizedText(input.id, "monitor id", 160);
  const enabled = input.enabled ?? true;
  if (typeof enabled !== "boolean") {
    throw new Error("monitor enabled must be boolean");
  }
  return {
    id,
    name: normalizedText(input.name, "monitor name", 160),
    trigger,
    instruction: normalizedText(input.instruction, "monitor instruction", 12_000),
    eventTypes,
    burstPolicy,
    tz,
    timeoutSec,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    enabled,
    revision: 1,
    createdAt: normalizeTimestamp(createdAt, "monitor createdAt"),
    updatedAt: normalizeTimestamp(createdAt, "monitor updatedAt"),
  };
}

function toSpec(stored: MonitorStoredRecord): MonitorSpec {
  const parsed = parseSpecJson(stored.specJson);
  const spec = normalizeCreate({
    id: stored.id,
    name: parsed.name,
    trigger: parsed.trigger,
    instruction: parsed.instruction,
    eventTypes: parsed.eventTypes,
    burstPolicy: parsed.burstPolicy,
    tz: parsed.tz,
    timeoutSec: parsed.timeoutSec,
    ...(parsed.expiresAt === undefined ? {} : { expiresAt: parsed.expiresAt }),
    enabled: stored.enabled,
  }, stored.createdAt, hostTimeZone());
  return {
    ...spec,
    revision: stored.revision,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    ...(stored.lastFiredAt === undefined ? {} : { lastFiredAt: stored.lastFiredAt }),
  };
}

function serializeSpec(spec: MonitorSpec): string {
  return JSON.stringify({
    name: spec.name,
    trigger: spec.trigger,
    instruction: spec.instruction,
    eventTypes: spec.eventTypes,
    burstPolicy: spec.burstPolicy,
    tz: spec.tz,
    timeoutSec: spec.timeoutSec,
    ...(spec.expiresAt === undefined ? {} : { expiresAt: spec.expiresAt }),
  });
}

function parseSpecJson(value: string): {
  readonly name: string;
  readonly trigger: MonitorTriggerInput;
  readonly instruction: string;
  readonly eventTypes: readonly string[];
  readonly burstPolicy: BurstPolicy;
  readonly tz: string;
  readonly timeoutSec: number;
  readonly expiresAt?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("stored monitor spec is invalid JSON");
  }
  if (!isRecord(parsed)
    || typeof parsed.name !== "string"
    || typeof parsed.instruction !== "string"
    || !Array.isArray(parsed.eventTypes)
    || typeof parsed.burstPolicy !== "string"
    || typeof parsed.tz !== "string"
    || typeof parsed.timeoutSec !== "number") {
    throw new Error("stored monitor spec has an invalid shape");
  }
  return {
    name: parsed.name,
    trigger: parseTrigger(parsed.trigger),
    instruction: parsed.instruction,
    eventTypes: parsed.eventTypes.map((value) => {
      if (typeof value !== "string") {
        throw new Error("stored monitor eventTypes contains a non-string");
      }
      return value;
    }),
    burstPolicy: parsed.burstPolicy as BurstPolicy,
    tz: parsed.tz,
    timeoutSec: parsed.timeoutSec,
    ...(typeof parsed.expiresAt === "string" ? { expiresAt: parsed.expiresAt } : {}),
  };
}

function normalizeExpiry(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error("monitor expiresAt must be an ISO-8601 instant");
  }
  return new Date(ms).toISOString();
}

function normalizeTrigger(input: MonitorTriggerInput, timeZone: string): MonitorTrigger {
  if (!isRecord(input) || typeof input.kind !== "string") {
    throw new Error("monitor trigger is invalid");
  }
  switch (input.kind) {
    case "cron": {
      const expression = normalizedText(input.expression, "cron expression", 240);
      validateCron(expression, timeZone);
      return { kind: "cron", expression };
    }
    case "webhook": {
      const token = input.token === undefined ? randomBytes(24).toString("base64url") : input.token;
      if (typeof token !== "string" || !WEBHOOK_TOKEN.test(token)) {
        throw new Error("webhook token must be URL-safe and at least 16 characters");
      }
      return { kind: "webhook", token };
    }
    case "watcher": {
      const roots = input.roots ?? [];
      if (!Array.isArray(roots) || roots.length > 32) {
        throw new Error("watcher roots must contain at most 32 entries");
      }
      return { kind: "watcher", roots: roots.map((root) => normalizedText(root, "watcher root", 512)) };
    }
    case "script": {
      if (!Array.isArray(input.argv) || input.argv.length === 0 || input.argv.length > 32) {
        throw new Error("script argv must contain between 1 and 32 entries");
      }
      const executable = input.argv[0];
      // Runtime confines execution to scriptRoot; surface the two statically
      // knowable rejections at authoring time so the owner learns immediately.
      if (typeof executable === "string" && executable.startsWith("/")) {
        throw new Error("script executable must be a path relative to the configured scriptRoot");
      }
      if (typeof executable === "string" && executable.split("/").includes("..")) {
        throw new Error("script executable must not traverse outside the configured scriptRoot");
      }
      if (!Number.isSafeInteger(input.intervalMs) || input.intervalMs < 1_000 || input.intervalMs > 86_400_000) {
        throw new Error("script intervalMs must be between 1000 and 86400000");
      }
      return {
        kind: "script",
        argv: input.argv.map((argument) => normalizedText(argument, "script argv entry", 4_096)),
        intervalMs: input.intervalMs,
      };
    }
    default:
      throw new Error(`unsupported monitor trigger: ${String((input as { kind?: unknown }).kind)}`);
  }
}

function parseTrigger(value: unknown): MonitorTriggerInput {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error("stored monitor trigger is invalid");
  }
  switch (value.kind) {
    case "cron":
      if (typeof value.expression !== "string") {
        throw new Error("stored cron trigger is invalid");
      }
      return { kind: "cron", expression: value.expression };
    case "webhook":
      if (typeof value.token !== "string") {
        throw new Error("stored webhook trigger is invalid");
      }
      return { kind: "webhook", token: value.token };
    case "watcher":
      if (value.roots !== undefined && !Array.isArray(value.roots)) {
        throw new Error("stored watcher trigger is invalid");
      }
      return { kind: "watcher", roots: value.roots as readonly string[] | undefined };
    case "script":
      if (!Array.isArray(value.argv) || typeof value.intervalMs !== "number") {
        throw new Error("stored script trigger is invalid");
      }
      return { kind: "script", argv: value.argv as readonly string[], intervalMs: value.intervalMs };
    default:
      throw new Error(`stored monitor trigger kind is invalid: ${value.kind}`);
  }
}

function normalizeEventTypes(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > 32) {
    throw new Error("monitor eventTypes must contain between 1 and 32 entries");
  }
  return [...new Set(values.map((value) => normalizedText(value, "monitor event type", 160)))];
}

function normalizeBurstPolicy(value: BurstPolicy): BurstPolicy {
  if (value !== "dedupe" && value !== "coalesce" && value !== "pass") {
    throw new Error("monitor burstPolicy is invalid");
  }
  return value;
}

function normalizeTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("monitor timeoutSec must be a positive safe integer");
  }
  return value;
}

function normalizeTimeZone(value: string): string {
  const timeZone = normalizedText(value, "monitor tz", 128);
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
  } catch {
    throw new Error(`monitor tz is not an IANA time zone: ${timeZone}`);
  }
}

function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function normalizedText(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw new Error(`${label} must be between 1 and ${maximumLength} characters`);
  }
  return normalized;
}

function normalizeTimestamp(value: string, label: string): string {
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  const encoded = encodeCanonical(value);
  if (encoded === undefined) {
    throw new Error("monitor event payload must be JSON-serializable");
  }
  return encoded;
}

function encodeCanonical(value: unknown): string | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  }
  if (Array.isArray(value)) {
    const entries = value.map(encodeCanonical);
    return entries.some((entry) => entry === undefined) ? undefined : `[${entries.join(",")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value).sort().map((key) => {
      const encoded = encodeCanonical(value[key]);
      return encoded === undefined ? undefined : `${JSON.stringify(key)}:${encoded}`;
    });
    return entries.some((entry) => entry === undefined) ? undefined : `{${entries.join(",")}}`;
  }
  return undefined;
}

function normalizedOccurrence(value: string | undefined, eventType: string, payloadJson: string): string {
  return value === undefined
    ? createHash("sha256").update(`${eventType}\n${payloadJson}`).digest("hex")
    : normalizedText(value, "monitor event occurrenceKey", 512);
}

function burstKey(monitor: MonitorSpec, eventType: string): string {
  return monitor.burstPolicy === "coalesce" ? eventType : `${eventType}:${monitor.id}`;
}

function idempotencyKey(monitor: MonitorSpec, eventType: string, occurrence: string, generatedId: string): string {
  if (monitor.burstPolicy === "dedupe") {
    return `monitor:${monitor.id}:dedupe:${eventType}:${occurrence}`;
  }
  return `monitor:${monitor.id}:${monitor.burstPolicy}:${generatedId}`;
}

function acceptsEventType(monitor: MonitorSpec, eventType: string): boolean {
  if (monitor.eventTypes.includes("*") || monitor.eventTypes.includes(eventType)) {
    return true;
  }
  const separator = eventType.indexOf(".");
  return separator !== -1 && monitor.eventTypes.includes(eventType.slice(0, separator));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}
