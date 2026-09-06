import { type CustomTool, Type } from "../omo-session/tool-types.ts";

import {
  DEFAULT_CHILD_INTERIM_MAX_BYTES,
  DEFAULT_CHILD_INTERIM_RATE_PER_MINUTE,
} from "../runtime-config.ts";
import { truncateUtf8, utf8Bytes } from "./utf8.ts";
import type { InterimAdmission } from "./interim.ts";

export const CHILD_REPORTING_INSTRUCTION = "Use report_progress only when something material changes — a finding, a blocker, a scope change, or the task taking much longer than expected; otherwise stay silent. If the delegating session asked for a reporting cadence, follow it.";

export interface ReportProgressToolOptions {
  readonly childId: string;
  readonly title: string;
  readonly admit: (input: {
    readonly childId: string;
    readonly title: string;
    readonly text: string;
    readonly toolCallId: string;
    readonly truncated?: boolean;
  }) => InterimAdmission;
  readonly maxBytes?: number;
  readonly ratePerMinute?: number;
}

/** Child-only durable progress reporter. It never waits for a main-session turn. */
export function createReportProgressTool(options: ReportProgressToolOptions): CustomTool {
  const maxBytes = positiveInteger(options.maxBytes ?? DEFAULT_CHILD_INTERIM_MAX_BYTES, "report_progress maxBytes");
  const ratePerMinute = positiveInteger(
    options.ratePerMinute ?? DEFAULT_CHILD_INTERIM_RATE_PER_MINUTE,
    "report_progress ratePerMinute",
  );
  return {
    name: "report_progress",
    label: "Report Progress",
    description: "Durably report a material change in this background task. Report sparingly; routine progress should stay silent.",
    parameters: Type.Object({
      text: Type.String({ minLength: 1, maxLength: 4_000 }),
    }, { additionalProperties: false }),
    async execute(toolCallId, params) {
      const input = params as { readonly text: string };
      const persisted = truncateUtf8(input.text, maxBytes);
      const truncated = persisted !== input.text;
      const outcome = options.admit({
        childId: options.childId,
        title: options.title,
        text: persisted,
        toolCallId,
        ...(truncated ? { truncated: true } : {}),
      });
      if (!outcome.accepted) {
        const retryAfterSec = Math.max(1, outcome.retryAfterSec ?? 60);
        return {
          content: [{
            type: "text" as const,
            text: `Dropped: over the reporting rate limit (${ratePerMinute} per minute); keep working and report again after ${retryAfterSec}s.`,
          }],
          details: { accepted: false, reason: "rate_limited" as const, retryAfterSec },
        };
      }
      const persistedTruncated = outcome.truncated ?? truncated;
      const bytes = outcome.bytes ?? utf8Bytes(persisted);
      return {
        content: [{
          type: "text" as const,
          text: persistedTruncated ? `Reported (truncated to ${maxBytes} bytes).` : "Reported.",
        }],
        details: { accepted: true, truncated: persistedTruncated, bytes },
      };
    },
  };
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}
