import type { MonitorStore } from "../monitors/store.ts";
import type { StateStore } from "../store/index.ts";

export const HEARTBEAT_MONITOR_ID = "heartbeat";
const SEED_META = "insights.heartbeat.seeded";

/**
 * Default proactive check-in. Every N minutes (config `heartbeat.minutes`,
 * default 10) a child looks at what changed since last time — unread inbound
 * across the sites signed into OmO's Chrome, overdue tasks in memory,
 * failed monitors, anything time-sensitive in today's notes — and reports
 * only if there is something the owner would want to know now. The triage
 * turn stays silent otherwise, so a healthy quiet system sends nothing.
 */
export const HEARTBEAT_INSTRUCTION = [
  "Proactive check-in. Look for anything NEW since the previous heartbeat that the owner would want to hear about right now, and nothing else.",
  "Sources, in this order, read-only: today's daily memory notes for open tasks or reminders with a time; the memory `tasks/` axis for anything due; the monitor list for monitors that failed on their last run; unread messages on services the owner has signed OmO's Chrome profile into (only if the profile has a live login — never attempt to log in).",
  "Compare against the last heartbeat's report in memory so nothing is repeated.",
  "If there is something: one or two plain sentences, most urgent first. If there is nothing new, reply with exactly [[no-owner-message]] so the owner is not texted.",
  "Never modify anything, never author monitors, never send messages yourself.",
].join(" ");

export function heartbeatExpression(minutes: number): string {
  return minutes >= 60 ? `0 */${Math.max(1, Math.round(minutes / 60))} * * *` : `*/${minutes} * * * *`;
}

export function seedHeartbeat(store: StateStore, monitors: MonitorStore, minutes: number): boolean {
  const expression = heartbeatExpression(minutes);
  const existing = monitors.get(HEARTBEAT_MONITOR_ID);
  if (existing) {
    // Config changed the interval: follow it without touching enabled/other edits.
    if (existing.trigger.kind === "cron" && existing.trigger.expression !== expression) {
      monitors.update(HEARTBEAT_MONITOR_ID, existing.revision, { trigger: { kind: "cron", expression } });
      return true;
    }
    return false;
  }
  if (store.getMeta(SEED_META) !== undefined) {
    return false; // owner deleted it on purpose
  }
  monitors.create({
    id: HEARTBEAT_MONITOR_ID,
    name: "Check-in",
    trigger: { kind: "cron", expression },
    instruction: HEARTBEAT_INSTRUCTION,
    eventTypes: ["cron"],
    burstPolicy: "dedupe",
    timeoutSec: 300,
  });
  store.setMeta(SEED_META, "1");
  return true;
}
