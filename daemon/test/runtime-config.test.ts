import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChildLifecycle } from "../src/children/lifecycle.ts";
import { ChildRegistry } from "../src/children/registry.ts";
import type { ChildRunner } from "../src/children/runner.ts";
import { FakeConversationRunner } from "./children/fakes.ts";
import { TerminalJournal } from "../src/children/terminal-journal.ts";
import { DeliveryService } from "../src/delivery/service.ts";
import type { DeliveryPort, DeliveryReceipt } from "../src/delivery/port.ts";
import { defaultRuntimeConfig, readRuntimeConfig } from "../src/runtime-config.ts";
import { openStateStore, type StateStore } from "../src/store/index.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class FailingPort implements DeliveryPort {
  public async sendText(): Promise<DeliveryReceipt> {
    throw Object.assign(new Error("retry"), { code: "cli_error", ambiguous: false });
  }

  public async sendReply(): Promise<DeliveryReceipt> {
    throw Object.assign(new Error("retry"), { code: "cli_error", ambiguous: false });
  }

  public async sendFile(): Promise<DeliveryReceipt> {
    throw Object.assign(new Error("retry"), { code: "cli_error", ambiguous: false });
  }
}

function createStore(): { readonly root: string; readonly store: StateStore } {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-runtime-config-"));
  directories.push(root);
  return { root, store: openStateStore(join(root, "state.db")) };
}

describe("runtime config", () => {
  test("uses product defaults when the owner handle is absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-runtime-config-defaults-"));
    directories.push(root);
    const configPath = join(root, "config.json");
    writeFileSync(configPath, "{}");

    const config = await readRuntimeConfig(configPath);
    expect(config).toEqual(defaultRuntimeConfig());
    expect(config.allowlistHandle).toBeUndefined();
  });

  test("uses product defaults when config.json is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-runtime-config-missing-"));
    directories.push(root);

    await expect(readRuntimeConfig(join(root, "config.json"))).resolves.toEqual(defaultRuntimeConfig());
  });

  test("rejects a present but invalid owner handle", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-runtime-config-invalid-handle-"));
    directories.push(root);
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ allowlistHandle: "garbage" }));

    await expect(readRuntimeConfig(configPath)).rejects.toThrow("config.json must contain a valid allowlistHandle");
  });

  test("reads explicit delivery, child-cap, and timeout overrides", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-runtime-config-file-"));
    directories.push(root);
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({
      allowlistHandle: "+82 10-1234-5678",
      delivery: { maxAttempts: 2, retryBackoffMs: [17, 31], timeoutMs: 41 },
      children: { maxConcurrent: 2, conversationalTimeoutMs: 53, daemonTimeoutMs: 67 },
      mainTurnWatchdogMs: 71,
      mainSessionModel: "anthropic/claude-opus-4-6",
    }));

    await expect(readRuntimeConfig(configPath)).resolves.toEqual({
      allowlistHandle: "+821012345678",
      ownerName: "",
      heartbeatMinutes: 10,
      presence: { enabled: true, idleSec: 3 },
      delivery: { maxAttempts: 2, retryBackoffMs: [17, 31], timeoutMs: 41 },
      children: {
        maxConcurrent: 2,
        conversationalTimeoutMs: 53,
        daemonTimeoutMs: 67,
        warmTtlMs: 600_000,
        idleTimeoutMs: 86_400_000,
        maxLive: 16,
        interimBatchMs: 3_000,
        interimRatePerMinute: 6,
        interimMaxBytes: 1_024,
        statusListLimit: 20,
        statusTextMaxBytes: 512,
        toolLatencyGuardMs: 50,
      },
      mainTurnWatchdogMs: 71,
      mainSessionModel: "anthropic/claude-opus-4-6",
    });
  });

  test("applies configured delivery ladder and child defaults to runtime collaborators", async () => {
    const { root, store } = createStore();
    let now = new Date("2026-01-01T00:00:00.000Z");
    const delivery = new DeliveryService({
      store,
      port: new FailingPort(),
      now: () => now,
      maxAttempts: 2,
      retryBackoffMs: [17],
    });
    const runner: ChildRunner = {
      name: "configured",
      run: async () => ({ state: "completed", summary: "done" }),
    };
    const lifecycle = new ChildLifecycle({
      registry: new ChildRegistry(store),
      journal: new TerminalJournal(join(root, "journal")),
      runner,
      conversation: new FakeConversationRunner(),
      maxConcurrent: 2,
      defaultConversationalTimeoutMs: 53,
      defaultDaemonTimeoutMs: 67,
    });

    try {
      const queued = delivery.admit({ idempotencyKey: "configured-retry", handle: "+821012345678", text: "retry" });
      await delivery.flush();
      expect(store.getDelivery(queued.id)).toMatchObject({
        state: "pending",
        attempts: 1,
        nextAttemptAt: "2026-01-01T00:00:00.017Z",
      });
      now = new Date("2026-01-01T00:00:00.017Z");
      await delivery.flush();
      expect(store.getDelivery(queued.id)).toMatchObject({ state: "expired", attempts: 2 });

      expect(lifecycle.delegate({ title: "conversation", prompt: "one" }).timeoutMs).toBe(53);
      expect(lifecycle.spawnDaemon({ title: "daemon", prompt: "two", origin: "monitor" }).timeoutMs).toBe(67);
    } finally {
      await lifecycle.stop();
      store.close();
    }
  });
});
