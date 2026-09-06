import { type CustomTool, Type } from "../omo-session/tool-types.ts";

import { MonitorStore, formatMonitorSchedule } from "./store.ts";
import type {
  MonitorCreateInput,
  MonitorSpec,
  MonitorTriggerInput,
  MonitorUpdateInput,
} from "./types.ts";

export interface MonitorAuthorToolOptions {
  readonly onChanged?: () => void | Promise<void>;
  /** Dispatches an on-demand run; resolves once the trigger is admitted. */
  readonly onRun?: (monitor: MonitorSpec) => Promise<{ readonly dispatched: boolean; readonly reason?: string }>;
}

interface AuthorParams {
  readonly operation: "create" | "update" | "list" | "enable" | "disable" | "delete" | "run";
  readonly id?: string;
  readonly expectedRevision?: number;
  readonly name?: string;
  readonly trigger?: unknown;
  readonly instruction?: string;
  readonly eventTypes?: unknown;
  readonly burstPolicy?: unknown;
  readonly tz?: string;
  readonly timeoutSec?: number;
  readonly expiresAt?: string | null;
  readonly enabled?: boolean;
}

/**
 * Main-session tool for monitor authoring. The model gets a concise durable ack
 * rather than an implicit in-memory schedule mutation.
 */
export function createMonitorAuthorTool(store: MonitorStore, options: MonitorAuthorToolOptions = {}): CustomTool {
  return {
    name: "monitor_author",
    label: "Monitor Author",
    description: "Create, update, list, enable, disable, delete, or run durable monitors. The 'run' operation fires a monitor immediately whatever its schedule, including the built-in memory monitors. Cron expressions, IANA time zones, and script/webhook trigger shapes are validated before persistence.",
    parameters: Type.Object({
      operation: Type.Enum(["create", "update", "list", "enable", "disable", "delete", "run"]),
      id: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
      expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
      trigger: Type.Optional(Type.Object({
        kind: Type.String({ minLength: 1, maxLength: 16 }),
        expression: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
        token: Type.Optional(Type.String({ minLength: 16, maxLength: 128 })),
        roots: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 32 })),
        argv: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), { maxItems: 32 })),
        intervalMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 86_400_000 })),
      }, { additionalProperties: false })),
      instruction: Type.Optional(Type.String({ minLength: 1, maxLength: 12_000 })),
      eventTypes: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { minItems: 1, maxItems: 32 })),
      burstPolicy: Type.Optional(Type.Enum(["dedupe", "coalesce", "pass"])),
      tz: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      timeoutSec: Type.Optional(Type.Integer({ minimum: 1 })),
      expiresAt: Type.Optional(Type.Union([Type.String({ description: "ISO-8601 instant after which the monitor stops firing (e.g. 24h-only watches). Omit for no expiry; pass empty string on update to clear." }), Type.Null()])),
      enabled: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      const input = params as unknown as AuthorParams;
      const response = await executeAuthorOperation(store, input, options);
      return {
        content: [{ type: "text", text: response.text }],
        details: response.details,
      };
    },
  };
}

export async function executeAuthorOperation(
  store: MonitorStore,
  input: AuthorParams,
  options: MonitorAuthorToolOptions = {},
): Promise<{ readonly text: string; readonly details: Record<string, unknown> }> {
  switch (input.operation) {
    case "create": {
      const draft = createInput(input);
      // A child session and the main session (or a steered retry) sometimes
      // both author the same watch. Same name + same trigger is the same
      // monitor: return it instead of creating a twin that fires twice.
      const twin = store.list().find((m) => sameName(m.name, draft.name) && sameTrigger(m.trigger, draft.trigger));
      if (twin) {
        return {
          text: `A monitor named "${twin.name}" with that schedule already exists (${twin.id}); not creating a second one. Update it if the instruction should change.`,
          details: { action: "exists", id: twin.id, revision: twin.revision },
        };
      }
      const monitor = store.create(draft);
      await options.onChanged?.();
      return acknowledgement("created", monitor);
    }
    case "update": {
      const id = requiredString(input.id, "monitor id");
      const monitor = store.update(id, requiredRevision(input.expectedRevision), updateInput(input));
      await options.onChanged?.();
      return acknowledgement("updated", monitor);
    }
    case "enable":
    case "disable": {
      const id = requiredString(input.id, "monitor id");
      const enabled = input.operation === "enable";
      const monitor = store.toggle(id, enabled, requiredRevision(input.expectedRevision));
      await options.onChanged?.();
      return acknowledgement(enabled ? "enabled" : "disabled", monitor);
    }
    case "delete": {
      const id = requiredString(input.id, "monitor id");
      const existing = store.get(id);
      if (!existing) {
        throw new Error(`monitor ${id} does not exist`);
      }
      store.delete(id, requiredRevision(input.expectedRevision));
      await options.onChanged?.();
      return {
        text: `Deleted monitor "${existing.name}" (${id}). It will not fire again and is gone from the panel.`,
        details: { action: "deleted", id },
      };
    }
    case "run": {
      const id = requiredString(input.id, "monitor id");
      const monitor = store.get(id);
      if (!monitor) {
        throw new Error(`monitor ${id} does not exist`);
      }
      if (!options.onRun) {
        throw new Error("monitor runs are unavailable in this session");
      }
      const outcome = await options.onRun(monitor);
      return {
        text: outcome.dispatched
          ? `Running monitor "${monitor.name}" (${id}) now; its result arrives the same way a scheduled run would.`
          : `Did not run "${monitor.name}" (${id}): ${outcome.reason ?? "the daemon refused the trigger"}.`,
        details: { action: "run", id, dispatched: outcome.dispatched, ...(outcome.reason === undefined ? {} : { reason: outcome.reason }) },
      };
    }
    case "list": {
      const monitors = store.list();
      return {
        text: monitors.length === 0
          ? "No monitors are configured."
          : monitors.map((monitor) => `${monitor.id}: ${monitor.name} (${monitor.enabled ? "enabled" : "disabled"}; ${formatMonitorSchedule(monitor)}; tz ${monitor.tz}; timeout ${monitor.timeoutSec}s; revision ${monitor.revision})`).join("\n"),
        details: { monitors: monitors.map(toDetail) },
      };
    }
    default:
      throw new Error(`unsupported monitor operation: ${String(input.operation)}`);
  }
}

function createInput(input: AuthorParams): MonitorCreateInput {
  return {
    ...(input.id === undefined ? {} : { id: requiredString(input.id, "monitor id") }),
    name: requiredString(input.name, "monitor name"),
    trigger: readTrigger(input.trigger),
    instruction: requiredString(input.instruction, "monitor instruction"),
    ...(input.eventTypes === undefined ? {} : { eventTypes: readStringArray(input.eventTypes, "monitor eventTypes") }),
    ...(input.burstPolicy === undefined ? {} : { burstPolicy: readBurstPolicy(input.burstPolicy) }),
    ...(input.tz === undefined ? {} : { tz: requiredString(input.tz, "monitor tz") }),
    ...(input.timeoutSec === undefined ? {} : { timeoutSec: input.timeoutSec }),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt === "" ? null : input.expiresAt }),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
  };
}

function updateInput(input: AuthorParams): MonitorUpdateInput {
  const patch: MonitorUpdateInput = {
    ...(input.name === undefined ? {} : { name: requiredString(input.name, "monitor name") }),
    ...(input.trigger === undefined ? {} : { trigger: readTrigger(input.trigger) }),
    ...(input.instruction === undefined ? {} : { instruction: requiredString(input.instruction, "monitor instruction") }),
    ...(input.eventTypes === undefined ? {} : { eventTypes: readStringArray(input.eventTypes, "monitor eventTypes") }),
    ...(input.burstPolicy === undefined ? {} : { burstPolicy: readBurstPolicy(input.burstPolicy) }),
    ...(input.tz === undefined ? {} : { tz: requiredString(input.tz, "monitor tz") }),
    ...(input.timeoutSec === undefined ? {} : { timeoutSec: input.timeoutSec }),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt === "" ? null : input.expiresAt }),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
  };
  if (Object.keys(patch).length === 0) {
    throw new Error("monitor update requires at least one field");
  }
  return patch;
}

function acknowledgement(action: string, monitor: MonitorSpec): { readonly text: string; readonly details: Record<string, unknown> } {
  return {
    text: `Monitor ${action}: ${monitor.name}. Schedule: ${formatMonitorSchedule(monitor)}. Time zone: ${monitor.tz}. Timeout: ${monitor.timeoutSec}s. Revision: ${monitor.revision}.`,
    details: { monitor: toDetail(monitor) },
  };
}

function toDetail(monitor: MonitorSpec): Record<string, unknown> {
  return {
    id: monitor.id,
    name: monitor.name,
    trigger: monitor.trigger,
    instruction: monitor.instruction,
    eventTypes: monitor.eventTypes,
    burstPolicy: monitor.burstPolicy,
    tz: monitor.tz,
    timeoutSec: monitor.timeoutSec,
    ...(monitor.expiresAt === undefined ? {} : { expiresAt: monitor.expiresAt }),
    enabled: monitor.enabled,
    revision: monitor.revision,
    createdAt: monitor.createdAt,
    updatedAt: monitor.updatedAt,
    ...(monitor.lastFiredAt === undefined ? {} : { lastFiredAt: monitor.lastFiredAt }),
  };
}

function readTrigger(value: unknown): MonitorTriggerInput {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error("monitor trigger is required");
  }
  switch (value.kind) {
    case "cron":
      return { kind: "cron", expression: requiredString(value.expression, "cron expression") };
    case "webhook":
      return {
        kind: "webhook",
        ...(value.token === undefined ? {} : { token: requiredString(value.token, "webhook token") }),
      };
    case "watcher":
      return {
        kind: "watcher",
        ...(value.roots === undefined ? {} : { roots: readStringArray(value.roots, "watcher roots") }),
      };
    case "script":
      if (typeof value.intervalMs !== "number") {
        throw new Error("script intervalMs is required");
      }
      return {
        kind: "script",
        argv: readStringArray(value.argv, "script argv"),
        intervalMs: value.intervalMs,
      };
    default:
      throw new Error(`unsupported monitor trigger: ${value.kind}`);
  }
}

function readStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value as readonly string[];
}

function readBurstPolicy(value: unknown): "dedupe" | "coalesce" | "pass" {
  if (value !== "dedupe" && value !== "coalesce" && value !== "pass") {
    throw new Error("monitor burstPolicy is invalid");
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function requiredRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error("expectedRevision is required");
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function sameName(a: string, b: string): boolean {
  return a.replace(/\s+/g, "").toLowerCase() === b.replace(/\s+/g, "").toLowerCase();
}

function sameTrigger(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
