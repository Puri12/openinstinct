import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import type { CredentialDiscoveryResult, ImportableCredential } from "@gajae-code/coding-agent/setup/credential-import";
import { adoptCredential, discoverCredentials, toDiscovered } from "../src/settings/credential-adopt.ts";

const directories: string[] = [];

function oauthCredential(overrides: Partial<ImportableCredential> = {}): ImportableCredential {
  const expiresAt = Date.now() + 60_000;
  return {
    provider: "anthropic",
    origin: "claude-code-file",
    source: "Claude Code (~/.claude/.credentials.json)",
    kind: "oauth",
    expiresAt,
    redactedToken: "sk-ant-…1234",
    credential: { type: "oauth", access: "access-secret", refresh: "refresh-secret", expires: expiresAt },
    ...overrides,
  };
}

function result(importable: ImportableCredential[], environment: CredentialDiscoveryResult["environment"] = []): CredentialDiscoveryResult {
  return { importable, environment, skipped: [] };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("credential adoption", () => {
  test("maps a live OAuth credential to an adoptable redacted record", () => {
    const discovered = toDiscovered(oauthCredential({ identity: { email: "owner@example.com" } }));
    expect(discovered).toEqual({
      id: "anthropic:claude-code-file",
      provider: "anthropic",
      label: "Claude (Anthropic)",
      source: "Claude Code (~/.claude/.credentials.json)",
      kind: "oauth",
      redactedToken: "sk-ant-…1234",
      identity: "owner@example.com",
      expiresAt: expect.any(String),
      adoptable: true,
    });
    expect(discovered.reason).toBeUndefined();
  });

  test("maps an expired OAuth credential to a non-adoptable record with the contract reason", () => {
    const discovered = toDiscovered(oauthCredential({ expiresAt: Date.now() - 1_000 }));
    expect(discovered.adoptable).toBe(false);
    expect(discovered.reason).toBe("This login has expired. Sign in to Claude Code again, or sign in here separately.");
  });

  test("maps an API-key credential to an adoptable record", () => {
    const discovered = toDiscovered({
      provider: "openai-codex",
      origin: "codex-file",
      source: "Codex CLI (~/.codex/auth.json)",
      kind: "api_key",
      redactedToken: "sk-…abcd",
      credential: { type: "api_key", key: "api-key-secret" },
    });
    expect(discovered).toEqual({
      id: "openai-codex:codex-file",
      provider: "openai-codex",
      label: "Codex (ChatGPT)",
      source: "Codex CLI (~/.codex/auth.json)",
      kind: "api_key",
      redactedToken: "sk-…abcd",
      adoptable: true,
    });
    expect(discovered.reason).toBeUndefined();
  });

  test("drops importable credentials whose provider is already active in the environment", async () => {
    const candidates = await discoverCredentials(async () => result([
      oauthCredential(),
      {
        provider: "openai-codex",
        origin: "codex-file",
        source: "Codex CLI (~/.codex/auth.json)",
        kind: "api_key",
        redactedToken: "sk-…abcd",
        credential: { type: "api_key", key: "api-key-secret" },
      },
    ], [{ provider: "openai-codex", variable: "OPENAI_API_KEY", redactedValue: "sk-…efgh" }]));
    expect(candidates.map(({ id }) => id)).toEqual(["anthropic:claude-code-file"]);
  });

  test("adopts a discovered credential into the requested auth database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openinstinct-credential-adopt-"));
    directories.push(directory);
    const dbPath = join(directory, "agent.db");
    const credential: ImportableCredential = {
      provider: "openai-codex",
      origin: "codex-file",
      source: "Codex CLI (~/.codex/auth.json)",
      kind: "api_key",
      redactedToken: "sk-…abcd",
      credential: { type: "api_key", key: "api-key-secret" },
    };

    await expect(adoptCredential("openai-codex:codex-file", {
      discover: async () => result([credential]),
      dbPath,
    })).resolves.toEqual({ provider: "openai-codex" });

    const storage = await AuthStorage.create(dbPath);
    try {
      expect(storage.has("openai-codex")).toBe(true);
      expect(storage.getAll()["openai-codex"]).toEqual({ type: "api_key", key: "api-key-secret" });
    } finally {
      storage.close();
    }
  });

  test("rejects an unknown credential id", async () => {
    await expect(adoptCredential("anthropic:claude-code-keychain", {
      discover: async () => result([]),
    })).rejects.toThrow("no such credential: anthropic:claude-code-keychain");
  });

  test("refuses a discovered but expired credential distinctly from an unknown id", async () => {
    const expired: ImportableCredential = {
      provider: "anthropic",
      origin: "claude-code-keychain",
      source: "Claude Code (macOS Keychain)",
      kind: "oauth",
      expiresAt: Date.now() - 60_000,
      redactedToken: "sk-a…5gAA",
      credential: { type: "oauth", access: "expired-secret", refresh: "r", expires: Date.now() - 60_000 } as ImportableCredential["credential"],
    };
    await expect(adoptCredential("anthropic:claude-code-keychain", {
      discover: async () => result([expired]),
    })).rejects.toThrow(/^credential cannot be used: /);
  });
});
