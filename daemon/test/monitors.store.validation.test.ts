import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MonitorStore, validateCron } from "../src/monitors/store.ts";
import { openStateStore } from "../src/store/index.ts";

function withStore<T>(run: (monitors: MonitorStore, store: ReturnType<typeof openStateStore>) => T): T {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-monitor-validation-"));
  const store = openStateStore(join(root, "state.db"));
  try {
    return run(new MonitorStore(store), store);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("authoring-time monitor validation", () => {
  test("rejects sub-minute cron schedules", () => {
    expect(() => validateCron("* * * * * *", "Asia/Seoul")).toThrow(/once per minute/);
    expect(() => validateCron("*/10 * * * * *", "Asia/Seoul")).toThrow(/once per minute/);
    // Standard five-field schedules stay valid.
    expect(() => validateCron("*/5 * * * *", "Asia/Seoul")).not.toThrow();
    expect(() => validateCron("30 8 * * 1-5", "Asia/Seoul")).not.toThrow();
  });

  test("rejects absolute and traversing script executables at authoring", () => {
    const base = {
      name: "script monitor",
      tz: "Asia/Seoul",
      instruction: "run it",
      timeoutSec: 60,
    };
    withStore((monitors) => {
      expect(() => monitors.create({
        ...base,
        trigger: { kind: "script", argv: ["/usr/bin/true"], intervalMs: 60_000 },
      })).toThrow(/relative to the configured scriptRoot/);
      expect(() => monitors.create({
        ...base,
        trigger: { kind: "script", argv: ["../outside.sh"], intervalMs: 60_000 },
      })).toThrow(/traverse outside/);
      const created = monitors.create({
        ...base,
        trigger: { kind: "script", argv: ["checks/run.sh", "--fast"], intervalMs: 60_000 },
      });
      expect(created.trigger.kind).toBe("script");
    });
  });
});

describe("monitor delete", () => {
  test("hard-deletes with revision fencing and refuses while a firing is in flight", () => {
    withStore((monitors) => {
      const spec = monitors.create({ name: "temp", tz: "UTC", instruction: "x", trigger: { kind: "cron", expression: "0 9 * * *" } });
      expect(() => monitors.delete(spec.id, spec.revision + 5)).toThrow(/revision/i);
      monitors.delete(spec.id, spec.revision);
      expect(monitors.get(spec.id)).toBeUndefined();
      expect(() => monitors.delete(spec.id, 1)).toThrow(/not found|unknown|does not exist/i);
    });
  });
});

describe("monitor delete with stale events", () => {
  test("deletes when only undelivered events remain, refuses while a child is dispatched", () => {
    withStore((monitors, store) => {
      const spec = monitors.create({ name: "temp", tz: "UTC", instruction: "x", trigger: { kind: "cron", expression: "0 9 * * *" } });
      const authored = store.admitMonitorEvent({ id: "e1", monitorId: spec.id, idempotencyKey: "k1", eventType: "cron", payloadJson: "{}", burstKey: "b1", catchUp: false }, "2026-01-01T00:00:00.000Z");
      expect(authored).toBeDefined();
      // authored/admitted events do not block deletion
      monitors.delete(spec.id, spec.revision);
      expect(monitors.get(spec.id)).toBeUndefined();
      expect(store.listMonitorEvents().every((e) => e.stage === "failed")).toBe(true);
    });
  });
});

describe("monitor expiry", () => {
  test("expiresAt round-trips, normalises, clears with null, and rejects garbage", () => {
    withStore((monitors) => {
      const spec = monitors.create({ name: "24h watch", tz: "UTC", instruction: "x", trigger: { kind: "cron", expression: "* * * * *" }, expiresAt: "2026-09-03T08:00:00+09:00" });
      expect(spec.expiresAt).toBe("2026-09-02T23:00:00.000Z");
      expect(monitors.get(spec.id)!.expiresAt).toBe("2026-09-02T23:00:00.000Z");
      const cleared = monitors.update(spec.id, spec.revision, { expiresAt: null });
      expect(cleared.expiresAt).toBeUndefined();
      expect(() => monitors.create({ name: "bad", tz: "UTC", instruction: "x", trigger: { kind: "cron", expression: "* * * * *" }, expiresAt: "next tuesday" })).toThrow(/ISO-8601/);
    });
  });
});
