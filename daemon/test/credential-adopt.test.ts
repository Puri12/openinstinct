import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  adoptCredential,
  discoverCredentials,
  discoverLocalCredentials,
  toDiscovered,
} from "../src/settings/credential-adopt.ts";

const EXPIRED_AT = Date.now() - 60_000;
const VALID_AT = Date.now() + 3_600_000;
const XAI_KEY = "xai-key-0123456789abcdef";
const CODEX_ACCESS = "codex-access-0123456789";
const CLAUDE_ACCESS = "claude-access-0123456789";

const directories: string[] = [];

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

/** A temp HOME holding all three credential sources: an api key, a live OAuth, an expired OAuth. */
function seedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "openinstinct-credential-adopt-"));
  directories.push(home);
  writeJson(join(home, ".omo", "agent", "auth.json"), { xai: { type: "api_key", key: XAI_KEY } });
  writeJson(join(home, ".codex", "auth.json"), {
    tokens: { access_token: CODEX_ACCESS, refresh_token: "codex-refresh", account_id: "acct_123", expires_at: VALID_AT },
  });
  writeJson(join(home, ".claude", ".credentials.json"), {
    claudeAiOauth: { accessToken: CLAUDE_ACCESS, refreshToken: "claude-refresh", expiresAt: EXPIRED_AT },
  });
  return home;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("credential discovery", () => {
  test("lists every local source, adoptable first then by label", async () => {
    const home = seedHome();

    const credentials = await discoverCredentials(() => discoverLocalCredentials(home));

    expect(credentials.map(({ id, label, adoptable }) => ({ id, label, adoptable }))).toEqual([
      { id: "openai-codex:codex-file", label: "Codex (ChatGPT)", adoptable: true },
      { id: "xai:omo-auth-json", label: "xAI", adoptable: true },
      { id: "anthropic:claude-code-file", label: "Claude (Anthropic)", adoptable: false },
    ]);
  });

  test("marks the expired Claude Code login non-adoptable with the contract reason", async () => {
    const home = seedHome();

    const credentials = await discoverCredentials(() => discoverLocalCredentials(home));

    expect(credentials.find(({ id }) => id === "anthropic:claude-code-file")).toEqual({
      id: "anthropic:claude-code-file",
      provider: "anthropic",
      label: "Claude (Anthropic)",
      source: "Claude Code (~/.claude/.credentials.json)",
      kind: "oauth",
      redactedToken: "claude…6789",
      expiresAt: new Date(EXPIRED_AT).toISOString(),
      adoptable: false,
      reason: "This login has expired. Sign in to that tool again, or sign in here separately.",
    });
  });

  test("carries the Codex account id as the identity of a live OAuth login", async () => {
    const home = seedHome();

    const credentials = await discoverCredentials(() => discoverLocalCredentials(home));

    expect(credentials.find(({ id }) => id === "openai-codex:codex-file")).toEqual({
      id: "openai-codex:codex-file",
      provider: "openai-codex",
      label: "Codex (ChatGPT)",
      source: "Codex CLI (~/.codex/auth.json)",
      kind: "oauth",
      redactedToken: "codex-…6789",
      identity: "acct_123",
      expiresAt: new Date(VALID_AT).toISOString(),
      adoptable: true,
    });
  });

  test("never exposes a raw secret in a discovery summary", async () => {
    const home = seedHome();

    const credentials = await discoverCredentials(() => discoverLocalCredentials(home));

    const serialized = JSON.stringify(credentials);
    for (const secret of [XAI_KEY, CODEX_ACCESS, CLAUDE_ACCESS, "codex-refresh", "claude-refresh"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  test("maps a Codex file holding only an API key to the openai provider", async () => {
    const home = mkdtempSync(join(tmpdir(), "openinstinct-credential-adopt-"));
    directories.push(home);
    writeJson(join(home, ".codex", "auth.json"), { OPENAI_API_KEY: "sk-openai-0123456789" });

    const credentials = await discoverCredentials(() => discoverLocalCredentials(home));

    expect(credentials).toEqual([{
      id: "openai:codex-file",
      provider: "openai",
      label: "OpenAI",
      source: "Codex CLI (~/.codex/auth.json)",
      kind: "api_key",
      redactedToken: "sk-ope…6789",
      adoptable: true,
    }]);
  });

  test("skips unreadable and malformed sources instead of failing discovery", async () => {
    const home = mkdtempSync(join(tmpdir(), "openinstinct-credential-adopt-"));
    directories.push(home);
    mkdirSync(join(home, ".codex", "auth.json"), { recursive: true });
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", ".credentials.json"), "{ not json");
    writeJson(join(home, ".omo", "agent", "auth.json"), { broken: { type: "oauth", access: "a" } });

    await expect(discoverCredentials(() => discoverLocalCredentials(home))).resolves.toEqual([]);
  });

  test("falls back to the provider id when no label is known", () => {
    const discovered = toDiscovered({
      provider: "some-new-provider",
      origin: "omo-auth-json",
      source: "omo (~/.omo/agent/auth.json)",
      kind: "api_key",
      credential: { type: "api_key", key: "key-0123456789" },
    });

    expect(discovered.label).toBe("some-new-provider");
  });
});

describe("credential adoption", () => {
  test("writes the exact credential into a private auth.json", async () => {
    const home = seedHome();
    const authPath = join(home, "state", "auth.json");

    await expect(adoptCredential("xai:omo-auth-json", {
      discover: () => discoverLocalCredentials(home),
      authPath,
    })).resolves.toEqual({ provider: "xai" });

    expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({ xai: { type: "api_key", key: XAI_KEY } });
    expect(statSync(authPath).mode & 0o777).toBe(0o600);
  });

  test("merges into an existing auth map without dropping other providers", async () => {
    const home = seedHome();
    const authPath = join(home, "state", "auth.json");
    writeJson(authPath, { openrouter: { type: "api_key", key: "existing-key" } });

    await expect(adoptCredential("openai-codex:codex-file", {
      discover: () => discoverLocalCredentials(home),
      authPath,
    })).resolves.toEqual({ provider: "openai-codex" });

    expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({
      openrouter: { type: "api_key", key: "existing-key" },
      "openai-codex": { type: "oauth", access: CODEX_ACCESS, refresh: "codex-refresh", expires: VALID_AT, accountId: "acct_123" },
    });
  });

  test("refuses an expired login and stores nothing", async () => {
    const home = seedHome();
    const authPath = join(home, "state", "auth.json");

    await expect(adoptCredential("anthropic:claude-code-file", {
      discover: () => discoverLocalCredentials(home),
      authPath,
    })).rejects.toThrow("credential cannot be used: This login has expired. Sign in to that tool again, or sign in here separately.");

    expect(existsSync(authPath)).toBe(false);
  });

  test("rejects an unknown credential id", async () => {
    const home = seedHome();

    await expect(adoptCredential("anthropic:claude-code-keychain", {
      discover: () => discoverLocalCredentials(home),
      authPath: join(home, "state", "auth.json"),
    })).rejects.toThrow("no such credential: anthropic:claude-code-keychain");
  });
});
