import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { MemoryClosureQueue, type MemoryClosureFaultPoint } from "../../src/memory/adapters/intents.ts";
import { memoryGit } from "../../src/memory/vendor/doctrine.ts";
import { openStateStore, type StateStore } from "../../src/store/index.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup(): { readonly home: string; readonly store: StateStore; readonly clock: { value: Date } } {
  const home = mkdtempSync(join(tmpdir(), "openinstinct-memory-closure-"));
  directories.push(home);
  return {
    home,
    store: openStateStore(join(home, "state.db")),
    clock: { value: new Date("2026-01-01T23:59:59.900Z") },
  };
}

function captureInput(key: string) {
  return {
    origin: { kind: "owner-chat" as const, reference: key },
    userText: `owner ${key}`,
    replyText: `reply ${key}`,
    idempotencyKey: `capture:${key}`,
  };
}

describe("memory closure ladder", () => {
  for (const [point, expected] of [
    ["after-intent", "queued"],
    ["after-write", "written"],
    ["after-commit", "committed"],
  ] as const satisfies readonly [MemoryClosureFaultPoint, string][]) {
    test(`resumes a durable ${expected} intent after simulated ${point} interruption`, async () => {
      const { home, store, clock } = setup();
      const interrupted = new MemoryClosureQueue({
        store,
        home,
        now: () => clock.value,
        onFault: (seen) => {
          if (seen === point) {
            throw new Error(`simulated interruption at ${point}`);
          }
        },
      });
      try {
        if (point === "after-intent") {
          expect(() => interrupted.enqueueCapture(captureInput(point))).toThrow("simulated interruption");
        } else {
          interrupted.enqueueCapture(captureInput(point));
          await interrupted.drain();
        }
        const interruptedIntent = store.listMemoryIntents()[0];
        expect(interruptedIntent).toMatchObject({ state: expected });

        const resumed = new MemoryClosureQueue({ store, home, now: () => clock.value });
        await resumed.initialize();
        await resumed.drain();

        const completed = store.getMemoryIntent(interruptedIntent!.id);
        expect(completed).toMatchObject({ state: "receipted" });
        expect(existsSync(join(home, "memory-receipts.jsonl"))).toBe(true);
        expect(readFileSync(join(home, "memory-receipts.jsonl"), "utf8")).toContain(interruptedIntent!.id);
        expect(await memoryGit(join(home, "memory"), ["log", "--format=%B", "-1"])).toContain(
          `Openinstinct-Mutation-Id: ${interruptedIntent!.id}`,
        );
      } finally {
        store.close();
      }
    });
  }

  test("quarantines an unrecoverable intent without erasing its row or payload", async () => {
    const { home, store, clock } = setup();
    try {
      store.admitMemoryIntent({
        id: "broken-intent",
        idempotencyKey: "broken-intent-key",
        kind: "capture",
        payloadJson: "{}",
      }, clock.value.toISOString());
      const queue = new MemoryClosureQueue({ store, home, now: () => clock.value });
      await queue.initialize();

      expect(store.getMemoryIntent("broken-intent")).toMatchObject({
        state: "quarantined",
        payloadJson: "{}",
        quarantineReason: expect.stringContaining("invalid"),
      });
    } finally {
      store.close();
    }
  });

  test("uses UTC calendar boundaries for daily capture filenames", async () => {
    const { home, store, clock } = setup();
    const queue = new MemoryClosureQueue({ store, home, now: () => clock.value });
    try {
      queue.enqueueCapture(captureInput("before-midnight"));
      await queue.drain();
      clock.value = new Date("2026-01-02T00:00:00.000Z");
      queue.enqueueCapture(captureInput("after-midnight"));
      await queue.drain();

      expect(readFileSync(join(home, "memory", "daily", "2026-01-01.md"), "utf8")).toContain("before-midnight");
      expect(readFileSync(join(home, "memory", "daily", "2026-01-02.md"), "utf8")).toContain("after-midnight");
    } finally {
      store.close();
    }
  });
});
