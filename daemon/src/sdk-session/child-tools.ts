import { type CustomTool } from "@gajae-code/coding-agent";
import { Type } from "@gajae-code/coding-agent/extensibility/typebox";

import {
  DEFAULT_CHILD_STATUS_LIST_LIMIT,
  DEFAULT_CHILD_STATUS_TEXT_BYTES,
  DEFAULT_CHILD_TOOL_GUARD_MS,
} from "../runtime-config.ts";
import type { NudgeOutcome, ReleaseOutcome } from "../children/lifecycle.ts";
import {
  childStatusDetail,
  statusSummary,
  type ChildStatusReader,
} from "../children/status.ts";


export interface ChildNudgeToolOptions {
  readonly nudge: (childId: string, text: string, input: { readonly receipt: boolean }) => NudgeOutcome;
  readonly release: (childId: string) => ReleaseOutcome;
  readonly latencyAlertMs?: number;
  readonly onEvent?: (event: string, fields: Record<string, unknown>) => void;
}

export interface ChildStatusToolOptions {
  readonly reader: ChildStatusReader;
  readonly latencyAlertMs?: number;
  readonly statusListLimit?: number;
  readonly statusTextMaxBytes?: number;
  readonly onEvent?: (event: string, fields: Record<string, unknown>) => void;
}

export function createChildNudgeTool(options: ChildNudgeToolOptions): CustomTool {
  const latencyAlertMs = positiveDuration(options.latencyAlertMs ?? DEFAULT_CHILD_TOOL_GUARD_MS, "latencyAlertMs");
  return {
    name: "child_nudge",
    label: "Nudge Background Task",
    strict: true,
    concurrency: "shared",
    description: "Steer a running background task, wake an idle task, or release a finished task. This only updates lifecycle state and never waits for task work.",
    parameters: Type.Object({
      childId: Type.String({ minLength: 1, maxLength: 64 }),
      op: Type.Enum(["nudge", "release"]),
      text: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
      receipt: Type.Optional(Type.Boolean({ default: false })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      return latencyAlertTool("child_nudge", latencyAlertMs, options.onEvent, () => {
        const input = params as { readonly childId: string; readonly op: "nudge" | "release"; readonly text?: string; readonly receipt?: boolean };
        const childId = input.childId;
        const receipt = input.receipt === true;
        const outcome = input.op === "release"
          ? options.release(childId)
          : (() => {
            const text = input.text?.trim();
            if (!text) {
              throw new Error("nudge_text_required");
            }
            return options.nudge(childId, text, { receipt });
          })();
        const queued = outcome.status === "queued" || outcome.status === "cold";
        return {
          content: [{ type: "text" as const, text: nudgeText(childId, outcome.status) }],
          details: { childId, op: input.op, status: outcome.status, queued, receipt },
        };
      });
    },
  };
}

export function createChildStatusTool(options: ChildStatusToolOptions): CustomTool {
  const latencyAlertMs = positiveDuration(options.latencyAlertMs ?? DEFAULT_CHILD_TOOL_GUARD_MS, "latencyAlertMs");
  const listLimit = positiveInteger(options.statusListLimit ?? DEFAULT_CHILD_STATUS_LIST_LIMIT, "statusListLimit");
  const textBytes = positiveInteger(options.statusTextMaxBytes ?? DEFAULT_CHILD_STATUS_TEXT_BYTES, "statusTextMaxBytes");
  return {
    name: "child_status",
    label: "Background Task Status",
    strict: true,
    concurrency: "shared",
    description: "Read precomputed background-task status. This never contacts SQLite at invocation time or a child SDK session.",
    parameters: Type.Object({
      childId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      return latencyAlertTool("child_status", latencyAlertMs, options.onEvent, () => {
        const input = params as { readonly childId?: string };
        if (input.childId !== undefined) {
          const child = options.reader.getChild(input.childId);
          if (!child) {
            throw new Error(`child_not_found: ${input.childId}`);
          }
          const detail = childStatusDetail(child, textBytes, true);
          return {
            content: [{ type: "text" as const, text: statusSummary(detail) }],
            details: detail,
          };
        }
        const children = options.reader.listLiveChildren(listLimit)
          .map((child) => childStatusDetail(child, textBytes, false));
        const total = options.reader.countLiveChildren();
        return {
          content: [{
            type: "text" as const,
            text: children.length === 0 ? "No live background tasks." : children.map(statusSummary).join("\n"),
          }],
          details: { children, total, truncated: total > children.length },
        };
      });
    },
  };
}

function nudgeText(childId: string, status: NudgeOutcome["status"] | ReleaseOutcome["status"]): string {
  switch (status) {
    case "steered":
      return `Nudge delivered into the running task ${childId}.`;
    case "started":
      return `Task ${childId} woke up and is working on it.`;
    case "queued":
      return `Nudge queued for task ${childId}; it runs next.`;
    case "cold":
      return `Task ${childId} is asleep; nudge queued, it resumes in the background.`;
    case "released":
      return `Task ${childId} released.`;
    case "cancelling":
      return `Task ${childId} is being cancelled; its receipt will follow.`;
  }
}

function latencyAlertTool<T>(
  tool: string,
  latencyAlertMs: number,
  onEvent: ((event: string, fields: Record<string, unknown>) => void) | undefined,
  body: () => T,
): T {
  const startedAt = Date.now();
  try {
    return body();
  } finally {
    const ms = Date.now() - startedAt;
    const notify = (): void => {
      try {
        onEvent?.("child_tool_latency_alert", { tool, ms, exceeded: ms > latencyAlertMs });
      } catch {
        // Observability cannot alter tool completion.
      }
    };
    if (ms > latencyAlertMs) {
      queueMicrotask(notify);
    } else {
      setTimeout(notify, 0);
    }
  }
}

function positiveDuration(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be positive`);
  }
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}
