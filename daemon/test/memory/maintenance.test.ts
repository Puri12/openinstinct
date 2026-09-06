import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  MEMORY_AUDIT_MONITOR_ID,
  MEMORY_CANONICALIZE_MONITOR_ID,
  MEMORY_MONITOR_SEED_META,
  seedMemoryMaintenanceMonitors,
} from "../../src/memory/maintenance.ts";
import { MonitorStore } from "../../src/monitors/store.ts";
import { openStateStore } from "../../src/store/index.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("memory maintenance monitor seeding", () => {
  test("seeds both deduped cron monitors exactly once and never resets operator changes", () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-memory-seed-"));
    directories.push(root);
    const store = openStateStore(join(root, "state.db"));
    const monitors = new MonitorStore(store, { hostTimeZone: "UTC" });
    try {
      expect(seedMemoryMaintenanceMonitors(store, monitors)).toBe(true);
      expect(store.getMeta(MEMORY_MONITOR_SEED_META)).toBe("1");
      expect(monitors.get(MEMORY_CANONICALIZE_MONITOR_ID)).toMatchObject({
        trigger: { kind: "cron", expression: "0 */6 * * *" },
        burstPolicy: "dedupe",
      });
      expect(monitors.get(MEMORY_AUDIT_MONITOR_ID)).toMatchObject({
        trigger: { kind: "cron", expression: "0 6 * * *" },
        burstPolicy: "dedupe",
      });

      // Built-in memory monitors are protected: neither disable nor delete.
      expect(() => monitors.toggle(MEMORY_AUDIT_MONITOR_ID, false, 1)).toThrow(/built in/);
      expect(() => monitors.delete(MEMORY_AUDIT_MONITOR_ID, 1)).toThrow(/built in/);
      expect(seedMemoryMaintenanceMonitors(store, monitors)).toBe(false);
      expect(monitors.get(MEMORY_AUDIT_MONITOR_ID)).toMatchObject({ enabled: true, revision: 1 });
      expect(monitors.list()).toHaveLength(2);
    } finally {
      store.close();
    }
  });
});
