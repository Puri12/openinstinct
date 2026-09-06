import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isDaemonPaused, setDaemonPaused } from "../src/control/pause.ts";
import { openStateStore } from "../src/store/index.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("daemon pause state", () => {
  test("survives a StateStore reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "openinstinct-pause-"));
    directories.push(directory);
    const path = join(directory, "state.db");
    const store = openStateStore(path);
    setDaemonPaused(store, true);
    expect(isDaemonPaused(store)).toBe(true);
    store.close();

    const restarted = openStateStore(path);
    try {
      expect(isDaemonPaused(restarted)).toBe(true);
      setDaemonPaused(restarted, false);
      expect(isDaemonPaused(restarted)).toBe(false);
    } finally {
      restarted.close();
    }
  });
});
