import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MonitorStore } from "../../src/monitors/store.ts";
import { MonitorRevisionConflictError } from "../../src/monitors/types.ts";
import { openStateStore, type StateStore } from "../../src/store/index.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore(): { readonly root: string; readonly store: StateStore } {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-monitor-store-"));
  directories.push(root);
  return { root, store: openStateStore(join(root, "state.db")) };
}

describe("MonitorStore", () => {
  test("persists typed specs with host timezone and revisioned CAS toggles", () => {
    const { store } = createStore();
    const monitors = new MonitorStore(store, {
      hostTimeZone: "Asia/Seoul",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    try {
      const created = monitors.create({
        id: "daily-briefing",
        name: "Daily briefing",
        trigger: { kind: "cron", expression: "30 8 * * 1-5" },
        instruction: "Summarize priorities.",
      });
      expect(created).toMatchObject({
        id: "daily-briefing",
        tz: "Asia/Seoul",
        timeoutSec: 2_700,
        enabled: true,
        revision: 1,
        burstPolicy: "coalesce",
      });

      const disabled = monitors.toggle(created.id, false, 1);
      expect(disabled).toMatchObject({ enabled: false, revision: 2 });
      expect(() => monitors.toggle(created.id, true, 1)).toThrow(MonitorRevisionConflictError);
      expect(monitors.get(created.id)).toMatchObject({ enabled: false, revision: 2 });
    } finally {
      store.close();
    }
  });

  test("rejects malformed cron and dedupes equivalent event payloads deterministically", () => {
    const { store } = createStore();
    const monitors = new MonitorStore(store, { hostTimeZone: "America/New_York" });

    try {
      expect(() => monitors.create({
        name: "Broken",
        trigger: { kind: "cron", expression: "not a cron" },
        instruction: "Nope",
      })).toThrow();

      const monitor = monitors.create({
        id: "dedupe-monitor",
        name: "Dedupe",
        trigger: { kind: "webhook", token: "A".repeat(24) },
        instruction: "Report payload",
        burstPolicy: "dedupe",
      });
      const first = monitors.admitEvent(monitor, {
        eventType: "webhook",
        payload: { b: 2, a: 1 },
      });
      const duplicate = monitors.admitEvent(monitor, {
        eventType: "webhook",
        payload: { a: 1, b: 2 },
      });

      expect(duplicate.id).toBe(first.id);
      expect(store.listMonitorEvents()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("coalesces an admitted burst into one durable event", () => {
    const { store } = createStore();
    const monitors = new MonitorStore(store, { hostTimeZone: "UTC" });
    const monitor = monitors.create({
      id: "coalesce-monitor",
      name: "Coalesce",
      trigger: { kind: "webhook", token: "B".repeat(24) },
      instruction: "Report burst.",
      burstPolicy: "coalesce",
    });

    try {
      const first = monitors.admitEvent(monitor, { eventType: "webhook", payload: { sequence: 1 } });
      const second = monitors.admitEvent(monitor, { eventType: "webhook", payload: { sequence: 2 } });
      expect(second.id).toBe(first.id);
      expect(store.listMonitorEvents()).toEqual([expect.objectContaining({
        id: first.id,
        payloadJson: '{"sequence":2}',
      })]);
    } finally {
      store.close();
    }
  });
});
