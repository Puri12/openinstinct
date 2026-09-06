import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startControlServer, type ControlServer } from "../src/control/socket.ts";
import { openStateStore, type StateStore } from "../src/store/index.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function readFrames(socket: Socket, count: number): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const frames: unknown[] = [];
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString("utf8");
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline === -1) {
          return;
        }
        frames.push(JSON.parse(buffered.slice(0, newline)));
        buffered = buffered.slice(newline + 1);
        if (frames.length === count) {
          socket.off("data", onData);
          socket.off("error", onError);
          resolve(frames);
          return;
        }
      }
    };
    const onError = (error: Error): void => {
      socket.off("data", onData);
      reject(error);
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

describe("maintenance.run control verb", () => {
  test("returns the real maintenance result through the closed control protocol", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-maintenance-control-"));
    directories.push(root);
    const store: StateStore = openStateStore(join(root, "state.db"));
    let control: ControlServer | undefined;
    let socket: Socket | undefined;
    try {
      control = await startControlServer({
        path: join(root, "run", "control.sock"),
        store,
        getStatus: () => ({ state: "running", probes: { config: { status: "passed" } } }),
        onMaintenanceRun: () => ({
          ran: true,
          deliveryLedgerPruned: 2,
          monitorEventsPruned: 3,
          receiptsPruned: 4,
          logRotated: true,
        }),
      });
      socket = createConnection({ path: join(root, "run", "control.sock") });
      await once(socket, "connect");
      const response = readFrames(socket, 2);
      socket.write(`${JSON.stringify({ type: "hello", v: 1, client: "maintenance-test" })}\n`);
      socket.write(`${JSON.stringify({ type: "request", id: "maintenance-1", verb: "maintenance.run", payload: {} })}\n`);

      const [, maintenance] = await response;
      expect(maintenance).toEqual({
        type: "response",
        id: "maintenance-1",
        ok: true,
        payload: {
          ran: true,
          deliveryLedgerPruned: 2,
          monitorEventsPruned: 3,
          receiptsPruned: 4,
          logRotated: true,
        },
      });
    } finally {
      socket?.destroy();
      await control?.close();
      store.close();
    }
  });
});
