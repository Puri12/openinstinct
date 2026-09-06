import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dataPaths } from "../src/paths.ts";
import { SettingsService, type AccountRow, type SettingsPatch } from "../src/settings/service.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function make(): { service: SettingsService; paths: ReturnType<typeof dataPaths>; soul: string } {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-settings-")); dirs.push(root);
  const paths = dataPaths(join(root, "home")); mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.config, JSON.stringify({ allowlistHandle: "+821012345678", ownerName: "b" }));
  const soul = join(root, "SOUL.md"); writeFileSync(soul, "<!-- soul-version: 3 -->\nYou are OmO, a gremlin with opinions and a keyboard.");
  return { service: new SettingsService({ paths, soulPath: soul }), paths, soul };
}

/** The fake provider from the engine port notes: usable offline, big enough context for a session. */
const FAKE_PROVIDER = {
  providers: {
    "oi-test": {
      name: "OI Test",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "test-key",
      api: "openai-completions",
      models: [{
        id: "oi-model",
        name: "OI Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8_192,
      }],
    },
  },
} as const;

/** Pins the engine to the test's own agent dir so it never reads the developer's ~/.omo. */
async function withAgentDir(dir: string, body: () => Promise<void>): Promise<void> {
  const previous = process.env.SENPI_CODING_AGENT_DIR;
  process.env.SENPI_CODING_AGENT_DIR = dir;
  try {
    await body();
  } finally {
    if (previous === undefined) {
      delete process.env.SENPI_CODING_AGENT_DIR;
    } else {
      process.env.SENPI_CODING_AGENT_DIR = previous;
    }
  }
}

describe("settings service", () => {
  test("snapshot reflects config, env presence (never values), and soul", async () => {
    const { service, paths } = make();
    writeFileSync(paths.envFile, "OPENAI_API_KEY=sk-secret\n", { mode: 0o600 });
    const snap = await service.snapshot();
    expect(snap.ownerHandle).toBe("+821012345678");
    expect(snap.soulVersion).toBe("3");
    expect(snap.env.find((e) => e.key === "OPENAI_API_KEY")?.set).toBe(true);
    expect(JSON.stringify(snap)).not.toContain("sk-secret");
    expect(snap).toMatchObject({
      childWarmTtlSec: 600,
      childIdleTimeoutSec: 86_400,
      childMaxLive: 16,
      childInterimBatchSec: 3,
      childInterimRatePerMinute: 6,
      childInterimMaxBytes: 1_024,
      childStatusListLimit: 20,
      childStatusTextBytes: 512,
      childToolGuardMs: 50,
    });
  });

  test("apply validates through the boot parser and reports restart/reload scope", async () => {
    const { service, paths, soul } = make();
    await expect(service.apply({ ownerHandle: "garbage" })).rejects.toThrow(/country code/);
    await expect(service.apply({ mainSessionModel: "nope" })).rejects.toThrow(/provider\/model/);
    await expect(service.apply({ mainSessionModel: "opengateway/anthropic/claude-sonnet-4-5" })).resolves.toMatchObject({ needsRestart: true });
    const r1 = await service.apply({ ownerName: "Bellman", mainSessionModel: "anthropic/claude-sonnet-4-5" });
    expect(r1).toEqual({ needsRestart: true, needsReload: true, ownerHandleChanged: false });
    const r2 = await service.apply({ childMaxConcurrent: 2, env: { ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "" } });
    expect(r2.needsRestart).toBe(true);
    expect(JSON.parse(readFileSync(paths.config, "utf8"))).toMatchObject({ ownerName: "Bellman", mainSessionModel: "anthropic/claude-sonnet-4-5", children: { maxConcurrent: 2 } });
    expect(readFileSync(paths.envFile, "utf8")).toBe("ANTHROPIC_API_KEY=k\n");
    expect(statSync(paths.envFile).mode & 0o777).toBe(0o600);
    const r3 = await service.apply({ soulText: "You are OmO v4, still a gremlin, still funnier than the CI logs." });
    expect(r3.needsReload).toBe(true);
    expect(readFileSync(soul, "utf8")).toMatch(/soul-version: 4/);
  });

  test("owner handle changes reload settings without requesting a restart", async () => {
    const { service, paths } = make();

    await expect(service.apply({ ownerHandle: "+82 10-5555-1212" })).resolves.toEqual({
      needsRestart: false,
      needsReload: true,
      ownerHandleChanged: true,
    });
    expect(JSON.parse(readFileSync(paths.config, "utf8"))).toMatchObject({ allowlistHandle: "+821055551212" });
  });

  test("clearing the owner handle removes it from config", async () => {
    const { service, paths } = make();

    await expect(service.apply({ ownerHandle: "" })).resolves.toEqual({
      needsRestart: false,
      needsReload: true,
      ownerHandleChanged: true,
    });
    expect("allowlistHandle" in JSON.parse(readFileSync(paths.config, "utf8"))).toBe(false);
  });

  test("concurrent first account loads share the in-flight result", async () => {
    const { service } = make();
    const account: AccountRow = {
      id: "account-1",
      provider: "anthropic",
      kind: "oauth",
      identity: "Ada",
      health: "ok",
    };
    let calls = 0;
    const uncached = service as unknown as {
      listAccountsUncached: () => Promise<AccountRow[]>;
    };
    uncached.listAccountsUncached = async () => {
      calls += 1;
      await Bun.sleep(20);
      return [account];
    };

    const [first, second] = await Promise.all([service.listAccounts(), service.listAccounts()]);
    expect(first).toEqual([account]);
    expect(second).toEqual([account]);
    expect(calls).toBe(1);
  });

  test("invalidate forces the next account lookup to reload", async () => {
    const { service } = make();
    let calls = 0;
    const uncached = service as unknown as {
      listAccountsUncached: () => Promise<AccountRow[]>;
    };
    uncached.listAccountsUncached = async () => {
      calls += 1;
      return [];
    };

    await service.listAccounts();
    service.invalidate("accounts");
    await service.listAccounts();
    expect(calls).toBe(2);
  });

  test("round-trips child lifetime, interim, status, and tool limits as restart-scoped config", async () => {
    const { service, paths } = make();
    const patches: readonly SettingsPatch[] = [
      { childWarmTtlSec: 120 },
      { childIdleTimeoutSec: 900 },
      { childMaxLive: 12 },
      { childInterimBatchSec: 7 },
      { childInterimRatePerMinute: 9 },
      { childInterimMaxBytes: 2_048 },
      { childStatusListLimit: 25 },
      { childStatusTextBytes: 1_024 },
      { childToolGuardMs: 75 },
    ];
    for (const patch of patches) {
      await expect(service.apply(patch)).resolves.toEqual({ needsRestart: true, needsReload: false, ownerHandleChanged: false });
    }
    expect(JSON.parse(readFileSync(paths.config, "utf8"))).toMatchObject({
      children: {
        warmTtlMs: 120_000,
        idleTimeoutMs: 900_000,
        maxLive: 12,
        interimBatchMs: 7_000,
        interimRatePerMinute: 9,
        interimMaxBytes: 2_048,
        statusListLimit: 25,
        statusTextMaxBytes: 1_024,
        toolLatencyGuardMs: 75,
      },
    });
    await expect(service.snapshot()).resolves.toMatchObject({
      childWarmTtlSec: 120,
      childIdleTimeoutSec: 900,
      childMaxLive: 12,
      childInterimBatchSec: 7,
      childInterimRatePerMinute: 9,
      childInterimMaxBytes: 2_048,
      childStatusListLimit: 25,
      childStatusTextBytes: 1_024,
      childToolGuardMs: 75,
    });
  });

  test("fast mode writes the engine service tier and keeps the other engine settings", async () => {
    const { service, paths } = make();
    mkdirSync(paths.omoHome, { recursive: true });
    writeFileSync(join(paths.omoHome, "settings.json"), JSON.stringify({ steeringMode: "all" }));

    await withAgentDir(paths.omoHome, async () => {
      await service.apply({ fastMode: true });
      expect(JSON.parse(readFileSync(join(paths.omoHome, "settings.json"), "utf8"))).toEqual({
        steeringMode: "all",
        openai: { serviceTier: "priority" },
      });
      await expect(service.snapshot()).resolves.toMatchObject({ fastMode: true });

      await service.apply({ fastMode: false });
      expect(JSON.parse(readFileSync(join(paths.omoHome, "settings.json"), "utf8"))).toMatchObject({
        steeringMode: "all",
        openai: { serviceTier: "auto" },
      });
      await expect(service.snapshot()).resolves.toMatchObject({ fastMode: false });
    });
  });

  test("adding a custom provider registers it in the engine catalog and selects its model", async () => {
    const { service, paths } = make();

    await withAgentDir(paths.omoHome, async () => {
      await expect(service.addCustomProvider({
        id: "my-gateway",
        baseUrl: "https://gateway.example.com/v1/",
        api: "openai-completions",
        apiKey: "sk-gateway",
        model: "gpt-5",
      })).resolves.toEqual({ modelId: "my-gateway/gpt-5" });

      const catalog = JSON.parse(readFileSync(join(paths.omoHome, "models.json"), "utf8")) as {
        readonly providers: Record<string, Record<string, unknown>>;
      };
      expect(catalog.providers["my-gateway"]).toMatchObject({
        name: "my-gateway",
        baseUrl: "https://gateway.example.com/v1",
        api: "openai-completions",
        apiKey: "sk-gateway",
        models: [{ id: "gpt-5", name: "gpt-5", contextWindow: 200_000, maxTokens: 8_192 }],
      });
      expect(JSON.parse(readFileSync(paths.config, "utf8"))).toMatchObject({ mainSessionModel: "my-gateway/gpt-5" });
      expect(readFileSync(paths.envFile, "utf8")).toContain("OI_MY_GATEWAY_API_KEY=sk-gateway");
    });
  });

  test("lists a provider from the engine model catalog as a provider-qualified choice", async () => {
    const { service, paths } = make();
    mkdirSync(paths.omoHome, { recursive: true });
    writeFileSync(join(paths.omoHome, "models.json"), JSON.stringify(FAKE_PROVIDER));

    await withAgentDir(paths.omoHome, async () => {
      await expect(service.listModels()).resolves.toContainEqual({
        id: "oi-test/oi-model",
        provider: "oi-test",
        canonical: "oi-model",
      });
    });
  });

  test("lists a stored engine credential as one account row per provider", async () => {
    const { service, paths } = make();
    mkdirSync(paths.omoHome, { recursive: true });
    writeFileSync(join(paths.omoHome, "auth.json"), JSON.stringify({
      anthropic: {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 3_600_000,
        identity: { email: "owner@example.com" },
      },
    }));

    await withAgentDir(paths.omoHome, async () => {
      await expect(service.listAccounts()).resolves.toEqual([{
        id: "anthropic:stored",
        provider: "anthropic",
        kind: "oauth",
        identity: "owner@example.com",
        health: "unknown",
      }]);
    });
  });

  test("rejects every child limit outside its supported range", async () => {
    const { service } = make();
    const cases: readonly [SettingsPatch, string][] = [
      [{ childWarmTtlSec: 59 }, "Keep finished tasks warm must be between 60 seconds and 24 hours"],
      [{ childWarmTtlSec: 86_401 }, "Keep finished tasks warm must be between 60 seconds and 24 hours"],
      [{ childIdleTimeoutSec: 299 }, "Forget idle tasks must be between 300 seconds and 24 hours"],
      [{ childIdleTimeoutSec: 86_401 }, "Forget idle tasks must be between 300 seconds and 24 hours"],
      [{ childMaxLive: 0 }, "Live background tasks must be 1–64"],
      [{ childMaxLive: 65 }, "Live background tasks must be 1–64"],
      [{ childInterimBatchSec: 0 }, "Bundle task updates must be 1–60 seconds"],
      [{ childInterimBatchSec: 61 }, "Bundle task updates must be 1–60 seconds"],
      [{ childInterimRatePerMinute: 0 }, "Updates per task per minute must be 1–60"],
      [{ childInterimRatePerMinute: 61 }, "Updates per task per minute must be 1–60"],
      [{ childInterimMaxBytes: 127 }, "Progress update size must be 128–8192 bytes"],
      [{ childInterimMaxBytes: 8_193 }, "Progress update size must be 128–8192 bytes"],
      [{ childStatusListLimit: 0 }, "Background task status list limit must be 1–100"],
      [{ childStatusListLimit: 101 }, "Background task status list limit must be 1–100"],
      [{ childStatusTextBytes: 127 }, "Background task status text must be 128–8192 bytes"],
      [{ childStatusTextBytes: 8_193 }, "Background task status text must be 128–8192 bytes"],
      [{ childToolGuardMs: 4 }, "Background task latency alert threshold must be 5–1000 ms"],
      [{ childToolGuardMs: 1_001 }, "Background task latency alert threshold must be 5–1000 ms"],
    ];
    for (const [patch, message] of cases) {
      await expect(service.apply(patch)).rejects.toThrow(message);
    }
    await expect(service.apply({ childMaxConcurrent: 8, childMaxLive: 7 })).rejects
      .toThrow("Live background tasks must be greater than or equal to background tasks at once");
  });
});
