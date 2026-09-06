import { Cron, CronPattern } from "croner";

import { MonitorStore } from "./store.ts";
import type { MonitorSpec, MonitorTriggerEvent } from "./types.ts";

export interface MonitorSchedulerOptions {
  readonly monitors: MonitorStore;
  readonly onTrigger: (monitor: MonitorSpec, event: MonitorTriggerEvent) => void | Promise<void>;
  readonly now?: () => Date;
  readonly isPaused?: () => boolean;
  readonly onEvent?: (event: string, fields: Record<string, unknown>) => void;
}


/**
 * Croner owns calendar evaluation. Its documented timezone behavior skips
 * nonexistent local times and fires once at the first occurrence of repeated
 * local times, which is the monitor DST contract.
 */
export class MonitorScheduler {
  private readonly now: () => Date;
  private readonly jobs = new Map<string, Cron>();
  private running = false;

  public constructor(private readonly options: MonitorSchedulerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  public async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    await this.catchUp();
    this.refresh();
  }

  public stop(): void {
    this.running = false;
    for (const job of this.jobs.values()) {
      job.stop();
    }
    this.jobs.clear();
  }

  public refresh(): void {
    for (const job of this.jobs.values()) {
      job.stop();
    }
    this.jobs.clear();
    if (!this.running) {
      return;
    }

    for (const monitor of this.options.monitors.list()) {
      if (!monitor.enabled || monitor.trigger.kind !== "cron") {
        continue;
      }
      const pattern = new CronPattern(monitor.trigger.expression, monitor.tz);
      const job = new Cron(monitor.trigger.expression, {
        timezone: monitor.tz,
        protect: true,
        catch: (error) => this.event("cron_callback_failed", { monitorId: monitor.id, message: messageOf(error) }),
      }, (runningJob) => {
        const scheduledFor = runningJob.currentRun() ?? this.now();
        if (!matchesRequestedClock(pattern, scheduledFor, monitor.tz)) {
          this.event("cron_dst_gap_skipped", { monitorId: monitor.id, scheduledFor: scheduledFor.toISOString() });
          return;
        }
        void this.fire(monitor, scheduledFor).catch((error) => {
          this.event("cron_trigger_failed", { monitorId: monitor.id, message: messageOf(error) });
        });
      });
      this.jobs.set(monitor.id, job);
    }
  }

  /** At most one coalesced overdue occurrence is admitted for each cron monitor. */
  public async catchUp(): Promise<void> {
    const now = this.now();
    for (const monitor of this.options.monitors.list()) {
      if (!monitor.enabled || monitor.trigger.kind !== "cron" || !monitor.lastFiredAt) {
        continue;
      }
      const next = nextCronRun(monitor.trigger.expression, monitor.tz, new Date(monitor.lastFiredAt));
      if (!next || next.getTime() > now.getTime()) {
        continue;
      }
      if (this.options.isPaused?.()) {
        this.event("cron_catch_up_skipped_paused", { monitorId: monitor.id, scheduledFor: next.toISOString() });
        continue;
      }
      await this.fire(monitor, next, true);
      this.event("cron_catch_up_admitted", { monitorId: monitor.id, scheduledFor: next.toISOString() });
    }
  }

  public async fire(monitor: MonitorSpec, scheduledFor: Date, catchUp = false): Promise<void> {
    if (!monitor.enabled || monitor.trigger.kind !== "cron") {
      return;
    }
    if (monitor.expiresAt !== undefined && scheduledFor.getTime() >= Date.parse(monitor.expiresAt)) {
      // Past its end date: switch it off durably so the panel shows "Ended".
      try {
        const current = this.options.monitors.get(monitor.id);
        if (current?.enabled) {
          this.options.monitors.toggle(monitor.id, false, current.revision);
        }
      } catch {
        // a concurrent edit wins; next tick re-evaluates
      }
      this.event("cron_expired", { monitorId: monitor.id, expiresAt: monitor.expiresAt });
      return;
    }
    if (this.options.isPaused?.()) {
      this.event("cron_skipped_paused", { monitorId: monitor.id, scheduledFor: scheduledFor.toISOString(), catchUp });
      return;
    }
    await this.options.onTrigger(monitor, {
      eventType: "cron",
      payload: {
        scheduledFor: scheduledFor.toISOString(),
        expression: monitor.trigger.expression,
        timeZone: monitor.tz,
        catchUp,
      },
      catchUp,
      occurrenceKey: `cron:${scheduledFor.toISOString()}`,
    });
    this.options.monitors.markFired(monitor.id, catchUp ? this.now() : scheduledFor);
    this.event("cron_admitted", { monitorId: monitor.id, scheduledFor: scheduledFor.toISOString(), catchUp });
  }

  private event(event: string, fields: Record<string, unknown>): void {
    this.options.onEvent?.(event, fields);
  }
}

export function nextCronRun(expression: string, timeZone: string, after: Date): Date | undefined {
  const cron = new Cron(expression, { timezone: timeZone, paused: true });
  const pattern = new CronPattern(expression, timeZone);
  try {
    let cursor = after;
    for (let attempts = 0; attempts < 4_000; attempts += 1) {
      const candidate = cron.nextRun(cursor);
      if (!candidate) {
        return undefined;
      }
      // Croner reliably chooses the first overlap occurrence. Its next-run
      // evaluator may normalize a fixed clock inside a DST gap forward; filter
      // that shifted clock so a 02:30 rule is skipped rather than emitted 03:30.
      if (matchesRequestedClock(pattern, candidate, timeZone)) {
        return candidate;
      }
      cursor = candidate;
    }
    throw new Error("cron evaluation exceeded DST normalization guard");
  } finally {
    cron.stop();
  }
}

export function nextCronRuns(expression: string, timeZone: string, after: Date, count: number): Date[] {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("cron run count must be a positive safe integer");
  }
  const results: Date[] = [];
  let cursor = after;
  while (results.length < count) {
    const next = nextCronRun(expression, timeZone, cursor);
    if (!next) {
      return results;
    }
    results.push(next);
    cursor = next;
  }
  return results;
}

function matchesRequestedClock(pattern: CronPattern, date: Date, timeZone: string): boolean {
  const fields = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(fields
    .filter((field) => field.type !== "literal")
    .map((field) => [field.type, Number(field.value)]));
  return pattern.hour[values.hour!] === 1
    && pattern.minute[values.minute!] === 1
    && pattern.second[values.second!] === 1;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
