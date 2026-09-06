import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMonitorAuthorTool, executeAuthorOperation } from "../../src/monitors/author-tool.ts";
import { MonitorStore } from "../../src/monitors/store.ts";
import { manualTriggerEvent } from "../../src/monitors/types.ts";
import { openStateStore, type StateStore } from "../../src/store/index.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore(): { readonly store: StateStore; readonly monitors: MonitorStore } {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-monitor-author-"));
  directories.push(root);
  const store = openStateStore(join(root, "state.db"));
  return { store, monitors: new MonitorStore(store, { hostTimeZone: "Asia/Seoul" }) };
}

describe("monitor_author", () => {
  test("creates a validated monitor and acknowledges schedule, timezone, and timeout", async () => {
    const { store, monitors } = createStore();
    let changes = 0;
    try {
      const result = await executeAuthorOperation(monitors, {
        operation: "create",
        name: "Weekday briefing",
        trigger: { kind: "cron", expression: "30 8 * * 1-5" },
        instruction: "Summarize the day.",
        timeoutSec: 1_800,
      }, { onChanged: () => { changes += 1; } });

      expect(result.text).toContain("Schedule: cron 30 8 * * 1-5.");
      expect(result.text).toContain("Time zone: Asia/Seoul.");
      expect(result.text).toContain("Timeout: 1800s.");
      expect(changes).toBe(1);
      expect(monitors.list()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("rejects malformed cron before persistence and exposes the omo engine custom tool shape", async () => {
    const { store, monitors } = createStore();
    try {
      const tool = createMonitorAuthorTool(monitors);
      expect(tool.name).toBe("monitor_author");
      await expect(executeAuthorOperation(monitors, {
        operation: "create",
        name: "Bad cron",
        trigger: { kind: "cron", expression: "this is not cron" },
        instruction: "Never run.",
      })).rejects.toThrow();
      expect(monitors.list()).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  test("executes create through the registered custom-tool surface", async () => {
    const { store, monitors } = createStore();
    const tool = createMonitorAuthorTool(monitors);
    try {
      const result = await tool.execute("monitor-call", {
        operation: "create",
        name: "Webhook",
        trigger: { kind: "webhook" },
        instruction: "Report payload.",
      } as never, undefined, undefined, {} as never);
      expect(result.content).toEqual([expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Schedule: webhook /hook/"),
      })]);
      expect(monitors.list()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("updates, lists, disables, and enables monitors through revisioned operations", async () => {
    const { store, monitors } = createStore();
    const monitor = monitors.create({
      id: "revisioned-monitor",
      name: "Revisioned",
      trigger: { kind: "cron", expression: "0 9 * * *" },
      instruction: "Initial.",
    });
    try {
      const updated = await executeAuthorOperation(monitors, {
        operation: "update",
        id: monitor.id,
        expectedRevision: 1,
        instruction: "Updated.",
      });
      expect(updated.text).toContain("Revision: 2.");
      const disabled = await executeAuthorOperation(monitors, {
        operation: "disable",
        id: monitor.id,
        expectedRevision: 2,
      });
      expect(disabled.text).toContain("Monitor disabled");
      const listed = await executeAuthorOperation(monitors, { operation: "list" });
      expect(listed.text).toContain("disabled");
      const enabled = await executeAuthorOperation(monitors, {
        operation: "enable",
        id: monitor.id,
        expectedRevision: 3,
      });
      expect(enabled.text).toContain("Monitor enabled");
    } finally {
      store.close();
    }
  });
});

describe("monitor_author create idempotency", () => {
  test("same name and trigger returns the existing monitor instead of a twin", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-author-twin-"));
    const store = openStateStore(join(root, "state.db"));
    try {
      const monitors = new MonitorStore(store, { hostTimeZone: "UTC" });
      const args = { operation: "create" as const, name: "쓰레드 시간별 팔로업", instruction: "check threads", trigger: { kind: "cron" as const, expression: "20 * * * *" } };
      const first = await executeAuthorOperation(monitors, args);
      const second = await executeAuthorOperation(monitors, { ...args, name: "쓰레드  시간별 팔로업" });
      expect(second.details.action).toBe("exists");
      expect(second.text).toMatch(/already exists/);
      expect(monitors.list()).toHaveLength(1);
      expect(first.text).toMatch(/created/);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("monitor_author run", () => {
  test("fires any monitor on demand — cron, webhook, protected, or disabled — with a dedupe-proof occurrence key", async () => {
    const { store, monitors } = createStore();
    try {
      const cron = monitors.create({
        name: "Briefing",
        trigger: { kind: "cron", expression: "30 8 * * *" },
        instruction: "Summarize.",
      });
      const hook = monitors.create({
        name: "Inbound hook",
        trigger: { kind: "webhook", token: "T".repeat(24) },
        instruction: "Handle it.",
      });
      // Protected built-ins subscribe to a narrower event type than "cron".
      const protectedMonitor = monitors.create({
        id: "memory-canonicalize",
        name: "Memory canonicalize",
        trigger: { kind: "cron", expression: "0 */6 * * *" },
        instruction: "Canonicalize.",
        eventTypes: ["memory.canonicalize"],
      });
      const disabled = monitors.create({
        name: "Paused watch",
        trigger: { kind: "cron", expression: "0 9 * * *" },
        instruction: "Watch.",
        enabled: false,
      });

      const runs: { id: string; eventType: string; occurrenceKey?: string }[] = [];
      const onRun = async (monitor: typeof cron) => {
        const event = manualTriggerEvent(monitor, new Date("2026-09-03T05:00:00.000Z"));
        runs.push({ id: monitor.id, eventType: event.eventType, occurrenceKey: event.occurrenceKey });
        return { dispatched: true };
      };

      for (const monitor of [cron, hook, protectedMonitor, disabled]) {
        const result = await executeAuthorOperation(monitors, { operation: "run", id: monitor.id }, { onRun });
        expect(result.text).toContain(`Running monitor "${monitor.name}"`);
        expect(result.details).toMatchObject({ action: "run", id: monitor.id, dispatched: true });
      }

      // Each borrows its own subscribed type, so acceptsEventType always matches.
      expect(runs.map((run) => run.eventType)).toEqual(["cron", "webhook", "memory.canonicalize", "cron"]);
      expect(runs.every((run) => run.occurrenceKey === "manual:2026-09-03T05:00:00.000Z")).toBe(true);
    } finally {
      store.close();
    }
  });

  test("reports a refusal instead of claiming a run happened", async () => {
    const { store, monitors } = createStore();
    try {
      const monitor = monitors.create({
        name: "Briefing",
        trigger: { kind: "cron", expression: "30 8 * * *" },
        instruction: "Summarize.",
      });
      const result = await executeAuthorOperation(monitors, { operation: "run", id: monitor.id }, {
        onRun: async () => ({ dispatched: false, reason: "the daemon is paused" }),
      });
      expect(result.text).toContain("Did not run");
      expect(result.text).toContain("the daemon is paused");
      expect(result.details).toMatchObject({ dispatched: false, reason: "the daemon is paused" });
    } finally {
      store.close();
    }
  });

  test("an unknown id is an error, not a silent no-op", async () => {
    const { store, monitors } = createStore();
    try {
      await expect(executeAuthorOperation(monitors, { operation: "run", id: "nope" }, { onRun: async () => ({ dispatched: true }) }))
        .rejects.toThrow("monitor nope does not exist");
    } finally {
      store.close();
    }
  });
});
