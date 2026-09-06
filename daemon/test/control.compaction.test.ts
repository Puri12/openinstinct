import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionCompaction } from "../src/control/compaction.ts";
import { openStateStore } from "../src/store/index.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function storePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "openinstinct-compact-"));
  directories.push(directory);
  return join(directory, "state.db");
}

describe("session.compact", () => {
  test("runs the installed compactor and settles as succeeded", async () => {
    const store = openStateStore(storePath());
    try {
      const settled: unknown[] = [];
      const compaction = new SessionCompaction(store, (status) => settled.push(status));
      let ran = 0;
      compaction.setRunner(async () => {
        ran += 1;
      });

      const accepted = compaction.accept("panel-request-1");
      expect(accepted.state).toBe("accepted");
      await compaction.drain();

      expect(ran).toBe(1);
      expect(compaction.status(accepted.operationId)).toEqual({
        operationId: accepted.operationId,
        state: "succeeded",
      });
      // The advertised session.compact.terminal fanout fires exactly once.
      expect(settled).toEqual([{ operationId: accepted.operationId, state: "succeeded" }]);
    } finally {
      store.close();
    }
  });

  test("rejects a concurrent request while one compaction is in flight", async () => {
    const store = openStateStore(storePath());
    try {
      const compaction = new SessionCompaction(store);
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      compaction.setRunner(() => gate);

      const accepted = compaction.accept("first");
      expect(compaction.accept("second")).toEqual({
        operationId: accepted.operationId,
        state: "already_running",
      });
      expect(compaction.status(accepted.operationId)?.state).toBe("running");

      release();
      await compaction.drain();
      expect(compaction.status(accepted.operationId)?.state).toBe("succeeded");

      // Once settled the single-flight latch must clear for the next request.
      const next = compaction.accept("third");
      expect(next.state).toBe("accepted");
      await compaction.drain();
    } finally {
      store.close();
    }
  });

  test("records a failing compaction instead of reporting success", async () => {
    const store = openStateStore(storePath());
    try {
      const compaction = new SessionCompaction(store);
      compaction.setRunner(async () => {
        throw Object.assign(new Error("context provider unavailable"), { code: "provider_down" });
      });

      const accepted = compaction.accept("failing");
      await compaction.drain();

      expect(compaction.status(accepted.operationId)).toEqual({
        operationId: accepted.operationId,
        state: "failed",
        errorCode: "provider_down",
      });
    } finally {
      store.close();
    }
  });

  test("fails an accepted operation when no session is available to compact", async () => {
    const store = openStateStore(storePath());
    try {
      const compaction = new SessionCompaction(store);
      const accepted = compaction.accept("no-session");
      await compaction.drain();

      expect(compaction.status(accepted.operationId)).toEqual({
        operationId: accepted.operationId,
        state: "failed",
        errorCode: "no_active_session",
      });
    } finally {
      store.close();
    }
  });

  test("recovers a compaction interrupted by daemon death as restart_interrupted", () => {
    const path = storePath();
    const store = openStateStore(path);
    const compaction = new SessionCompaction(store);
    // Never settles: models the daemon dying mid-compaction.
    compaction.setRunner(() => new Promise<void>(() => {}));
    const accepted = compaction.accept("interrupted");
    expect(compaction.status(accepted.operationId)?.state).toBe("running");
    store.close();

    const restarted = openStateStore(path);
    try {
      const afterRestart = new SessionCompaction(restarted);
      expect(afterRestart.status(accepted.operationId)).toEqual({
        operationId: accepted.operationId,
        state: "failed",
        errorCode: "restart_interrupted",
      });
      // Recovery must also release the latch so compaction is usable again.
      expect(afterRestart.accept("after-recovery").state).toBe("accepted");
    } finally {
      restarted.close();
    }
  });
});
