import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  drainSuppressedWhilePaused,
  recordSuppressedWhilePaused,
  suppressedNotice,
  suppressedWhilePaused,
} from "../src/control/pause.ts";
import { openStateStore } from "../src/store/index.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function freshStore(): ReturnType<typeof openStateStore> {
  const directory = mkdtempSync(join(tmpdir(), "openinstinct-pause-contract-"));
  directories.push(directory);
  return openStateStore(join(directory, "state.db"));
}

describe("paused suppression backlog", () => {
  test("accumulates across batches and survives a reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "openinstinct-pause-durable-"));
    directories.push(directory);
    const path = join(directory, "state.db");
    const store = openStateStore(path);
    recordSuppressedWhilePaused(store, 2);
    recordSuppressedWhilePaused(store, 3);
    expect(suppressedWhilePaused(store)).toBe(5);
    store.close();

    const restarted = openStateStore(path);
    try {
      // A crash while paused must not lose the fact that the owner was ignored.
      expect(suppressedWhilePaused(restarted)).toBe(5);
    } finally {
      restarted.close();
    }
  });

  test("drains exactly once so a second resume does not re-report", () => {
    const store = freshStore();
    try {
      recordSuppressedWhilePaused(store, 4);
      expect(drainSuppressedWhilePaused(store)).toBe(4);
      expect(drainSuppressedWhilePaused(store)).toBe(0);
      expect(suppressedWhilePaused(store)).toBe(0);
    } finally {
      store.close();
    }
  });

  test("ignores non-positive counts", () => {
    const store = freshStore();
    try {
      recordSuppressedWhilePaused(store, 0);
      recordSuppressedWhilePaused(store, -3);
      expect(suppressedWhilePaused(store)).toBe(0);
    } finally {
      store.close();
    }
  });

  test("states the missed count in the owner notice", () => {
    expect(suppressedNotice(1)).toContain("1 owner message");
    expect(suppressedNotice(7)).toContain("7 owner messages");
  });
});
