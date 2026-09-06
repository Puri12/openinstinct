import type { StateStore } from "../store/index.ts";
import { MonitorStore } from "../monitors/store.ts";

export const MEMORY_MONITOR_SEED_META = "memory.maintenance_monitors.seeded.v1";
export const MEMORY_CANONICALIZE_MONITOR_ID = "memory-canonicalize";
export const MEMORY_AUDIT_MONITOR_ID = "memory-audit";

/**
 * Seeds maintenance exactly once per state database. Existing rows are retained
 * during an interrupted first seed; after the guard is written, removals are
 * deliberate and never resurrected.
 */
export function seedMemoryMaintenanceMonitors(store: StateStore, monitors: MonitorStore): boolean {
  if (store.getMeta(MEMORY_MONITOR_SEED_META) !== undefined) {
    return false;
  }
  if (!monitors.get(MEMORY_CANONICALIZE_MONITOR_ID)) {
    monitors.create({
      id: MEMORY_CANONICALIZE_MONITOR_ID,
      name: "Memory canonicalize",
      trigger: { kind: "cron", expression: "0 */6 * * *" },
      instruction: "Run the bounded OpenInstinct memory canonicalization pass over uncatalogued UTC daily captures.",
      eventTypes: ["cron"],
      burstPolicy: "dedupe",
    });
  }
  if (!monitors.get(MEMORY_AUDIT_MONITOR_ID)) {
    monitors.create({
      id: MEMORY_AUDIT_MONITOR_ID,
      name: "Memory audit",
      trigger: { kind: "cron", expression: "0 6 * * *" },
      instruction: "Run the read-only OpenInstinct memory structural audit and report its JSON issues.",
      eventTypes: ["cron"],
      burstPolicy: "dedupe",
    });
  }
  store.setMeta(MEMORY_MONITOR_SEED_META, "1");
  return true;
}
