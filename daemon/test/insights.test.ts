import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { COMPUTER_USAGE_MONITOR_ID, seedComputerUsageInsight } from "../src/insights/computer-usage.ts";
import { MonitorStore } from "../src/monitors/store.ts";
import { openStateStore } from "../src/store/index.ts";

const directories: string[] = [];
afterEach(() => {
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("computer usage insight", () => {
  test("seeds one daily cron monitor exactly once", () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-insight-"));
    directories.push(root);
    const store = openStateStore(join(root, "state.db"));
    try {
      const monitors = new MonitorStore(store);
      expect(seedComputerUsageInsight(store, monitors)).toBe(true);
      const spec = monitors.get(COMPUTER_USAGE_MONITOR_ID)!;
      expect(spec.trigger).toEqual({ kind: "cron", expression: "0 9 * * *" });
      expect(spec.enabled).toBe(true);
      expect(spec.instruction).toMatch(/propose only/);
      expect(seedComputerUsageInsight(store, monitors)).toBe(false);
      expect(monitors.list().filter((m) => m.id === COMPUTER_USAGE_MONITOR_ID)).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});

import { HEARTBEAT_MONITOR_ID, heartbeatExpression, seedHeartbeat } from "../src/insights/heartbeat.ts";
describe("heartbeat check-in", () => {
  test("seeds once at the configured interval, follows interval changes, respects owner deletion", () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-hb-"));
    directories.push(root);
    const store = openStateStore(join(root, "state.db"));
    try {
      const monitors = new MonitorStore(store);
      expect(seedHeartbeat(store, monitors, 10)).toBe(true);
      expect(monitors.get(HEARTBEAT_MONITOR_ID)!.trigger).toEqual({ kind: "cron", expression: "*/10 * * * *" });
      expect(seedHeartbeat(store, monitors, 10)).toBe(false);
      expect(seedHeartbeat(store, monitors, 30)).toBe(true);
      expect(monitors.get(HEARTBEAT_MONITOR_ID)!.trigger).toEqual({ kind: "cron", expression: "*/30 * * * *" });
      expect(heartbeatExpression(120)).toBe("0 */2 * * *");
      const m = monitors.get(HEARTBEAT_MONITOR_ID)!;
      monitors.toggle(m.id, false, m.revision);
      monitors.delete(m.id, monitors.get(m.id)!.revision);
      expect(seedHeartbeat(store, monitors, 10)).toBe(false);
      expect(monitors.get(HEARTBEAT_MONITOR_ID)).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
