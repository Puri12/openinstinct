import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MonitorScheduler, nextCronRuns } from "../../src/monitors/scheduler.ts";
import { MonitorStore } from "../../src/monitors/store.ts";
import type { MonitorSpec, MonitorTriggerEvent } from "../../src/monitors/types.ts";
import { openStateStore, type StateStore } from "../../src/store/index.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore(): { readonly store: StateStore; readonly root: string } {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-monitor-scheduler-"));
  directories.push(root);
  return { root, store: openStateStore(join(root, "state.db")) };
}

describe("MonitorScheduler", () => {
  test("uses explicit DST behavior: skip spring gap, fire one fall overlap, no Seoul DST shift", () => {
    expect(nextCronRuns("30 2 * * *", "America/New_York", new Date("2026-03-08T06:00:00.000Z"), 2)
      .map((date) => date.toISOString())).toEqual([
        "2026-03-09T06:30:00.000Z",
        "2026-03-10T06:30:00.000Z",
      ]);
    expect(nextCronRuns("30 1 * * *", "America/New_York", new Date("2026-11-01T03:00:00.000Z"), 2)
      .map((date) => date.toISOString())).toEqual([
        "2026-11-01T05:30:00.000Z",
        "2026-11-02T06:30:00.000Z",
      ]);
    expect(nextCronRuns("30 8 * * *", "Asia/Seoul", new Date("2026-03-08T00:00:00.000Z"), 2)
      .map((date) => date.toISOString())).toEqual([
        "2026-03-08T23:30:00.000Z",
        "2026-03-09T23:30:00.000Z",
      ]);
  });

  test("admits one coalesced boot catch-up per overdue cron monitor with an injected clock", async () => {
    const { store } = createStore();
    const clock = new Date("2026-01-05T12:00:00.000Z");
    const monitors = new MonitorStore(store, { now: () => clock, hostTimeZone: "UTC" });
    const monitor = monitors.create({
      id: "catch-up",
      name: "Catch up",
      trigger: { kind: "cron", expression: "0 * * * *" },
      instruction: "Report missed work.",
    });
    monitors.markFired(monitor.id, new Date("2026-01-01T00:00:00.000Z"));
    const triggered: Array<{ readonly monitor: MonitorSpec; readonly event: MonitorTriggerEvent }> = [];
    const scheduler = new MonitorScheduler({
      monitors,
      now: () => clock,
      onTrigger: (spec, event) => {
        triggered.push({ monitor: spec, event });
      },
    });

    try {
      await scheduler.catchUp();
      await scheduler.catchUp();
      expect(triggered).toHaveLength(1);
      expect(triggered[0]?.event).toMatchObject({ eventType: "cron", catchUp: true });
      expect(monitors.get(monitor.id)?.lastFiredAt).toBe(clock.toISOString());
    } finally {
      scheduler.stop();
      store.close();
    }
  });

  test("does not dispatch or mark a cron occurrence while the daemon is paused", async () => {
    const { store } = createStore();
    const now = new Date("2026-01-05T00:00:00.000Z");
    const monitors = new MonitorStore(store, { now: () => now, hostTimeZone: "UTC" });
    const monitor = monitors.create({
      id: "paused-cron",
      name: "Paused cron",
      trigger: { kind: "cron", expression: "30 8 * * 1-5" },
      instruction: "Do not dispatch while paused.",
    });
    const triggered: MonitorTriggerEvent[] = [];
    const events: string[] = [];
    const scheduler = new MonitorScheduler({
      monitors,
      now: () => now,
      isPaused: () => true,
      onTrigger: (_spec, event) => { triggered.push(event); },
      onEvent: (event) => { events.push(event); },
    });

    try {
      await scheduler.fire(monitor, new Date("2026-01-05T08:30:00.000Z"));
      expect(triggered).toEqual([]);
      expect(events).toEqual(["cron_skipped_paused"]);
      expect(monitors.get(monitor.id)?.lastFiredAt).toBeUndefined();
    } finally {
      scheduler.stop();
      store.close();
    }
  });
});

describe("MonitorScheduler expiry", () => {
  test("a firing at or after expiresAt is skipped and the monitor is switched off durably", async () => {
    const { store } = createStore();
    const monitors = new MonitorStore(store, { hostTimeZone: "UTC" });
    const spec = monitors.create({ name: "24h", trigger: { kind: "cron", expression: "* * * * *" }, instruction: "x", expiresAt: "2026-01-02T00:00:00.000Z" });
    const triggered: unknown[] = [];
    const events: string[] = [];
    const scheduler = new MonitorScheduler({
      monitors,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      onTrigger: (_s, e) => { triggered.push(e); },
      onEvent: (event) => { events.push(event); },
    });
    try {
      await scheduler.fire(spec, new Date("2026-01-01T12:00:00.000Z"));
      expect(triggered).toHaveLength(1);
      await scheduler.fire(monitors.get(spec.id)!, new Date("2026-01-02T00:00:00.000Z"));
      expect(triggered).toHaveLength(1);
      expect(events).toContain("cron_expired");
      expect(monitors.get(spec.id)!.enabled).toBe(false);
    } finally {
      scheduler.stop();
      store.close();
    }
  });
});
