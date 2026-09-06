import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openChatDbReadonly,
  probeConfig,
  probeCredentials,
} from "../src/bootstrap/probes.ts";
import type { AccountRow } from "../src/settings/service.ts";

const directories: string[] = [];

const MISSING_CREDENTIAL_REASON = "No AI account yet. Open Settings → AI account to sign in or paste an API key.";

function createRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  directories.push(root);
  return root;
}

function accountRow(): AccountRow {
  return {
    id: "account-1",
    provider: "anthropic",
    kind: "oauth",
    identity: "owner@example.com",
    health: "ok",
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("probeCredentials", () => {
  test("uses a managed env credential without invoking account lookup", async () => {
    const root = createRoot("openinstinct-bootstrap-credentials-env-");
    const envFile = join(root, "env");
    writeFileSync(envFile, "ANTHROPIC_API_KEY=secret\n");
    let accountCalls = 0;

    await expect(probeCredentials({
      envFile,
      accounts: async () => {
        accountCalls += 1;
        return [accountRow()];
      },
    })).resolves.toEqual({ status: "passed" });
    expect(accountCalls).toBe(0);
  });

  test("recognizes an OI provider API key", async () => {
    const root = createRoot("openinstinct-bootstrap-credentials-oi-");
    const envFile = join(root, "env");
    writeFileSync(envFile, "OI_FOO_API_KEY=secret\n");
    let accountCalls = 0;

    await expect(probeCredentials({
      envFile,
      accounts: async () => {
        accountCalls += 1;
        return [];
      },
    })).resolves.toEqual({ status: "passed" });
    expect(accountCalls).toBe(0);
  });

  test("falls back to one stored account when no env credential exists", async () => {
    const root = createRoot("openinstinct-bootstrap-credentials-account-");
    const envFile = join(root, "env");
    let accountCalls = 0;

    await expect(probeCredentials({
      envFile,
      accounts: async () => {
        accountCalls += 1;
        return [accountRow()];
      },
    })).resolves.toEqual({ status: "passed" });
    expect(accountCalls).toBe(1);
  });

  test("reports the exact remediation when no env credential or account exists", async () => {
    const root = createRoot("openinstinct-bootstrap-credentials-missing-");
    const envFile = join(root, "env");

    await expect(probeCredentials({
      envFile,
      accounts: async () => [],
    })).resolves.toEqual({ status: "missing", reason: MISSING_CREDENTIAL_REASON });
  });

  test("optimistically continues when account lookup throws", async () => {
    const root = createRoot("openinstinct-bootstrap-credentials-unknown-");
    const envFile = join(root, "env");

    await expect(probeCredentials({
      envFile,
      accounts: async () => {
        throw new Error("account store unavailable");
      },
    })).resolves.toEqual({ status: "unknown" });
  });
});

describe("openChatDbReadonly", () => {
  test("throws when the chat database path is a directory", () => {
    const root = createRoot("openinstinct-bootstrap-chat-db-directory-");
    expect(() => openChatDbReadonly(root)).toThrow();
  });

  test("opens a seeded chat database containing a message table", () => {
    const root = createRoot("openinstinct-bootstrap-chat-db-");
    const messages = join(root, "Library", "Messages");
    mkdirSync(messages, { recursive: true });
    const path = join(messages, "chat.db");
    const db = new Database(path);
    try {
      db.exec("CREATE TABLE message (text TEXT NOT NULL); INSERT INTO message (text) VALUES ('hello');");
    } finally {
      db.close();
    }

    expect(() => openChatDbReadonly(path)).not.toThrow();
  });
});

describe("probeConfig", () => {
  test("treats a missing config as passed defaults without a handle", async () => {
    const root = createRoot("openinstinct-bootstrap-config-missing-");
    const result = await probeConfig(join(root, "config.json"));

    expect(result).toEqual({ status: "passed", reason: "config.json is missing; defaults apply" });
    expect(result.allowlistHandle).toBeUndefined();
  });

  test("reports malformed JSON as invalid", async () => {
    const root = createRoot("openinstinct-bootstrap-config-json-");
    const path = join(root, "config.json");
    writeFileSync(path, "{");

    await expect(probeConfig(path)).resolves.toMatchObject({ status: "invalid" });
  });

  test("rejects an invalid configured handle without returning one", async () => {
    const root = createRoot("openinstinct-bootstrap-config-handle-invalid-");
    const path = join(root, "config.json");
    writeFileSync(path, JSON.stringify({ allowlistHandle: "nope" }));

    const result = await probeConfig(path);
    expect(result).toMatchObject({ status: "invalid" });
    expect(result.allowlistHandle).toBeUndefined();
  });

  test("returns a normalized valid configured handle", async () => {
    const root = createRoot("openinstinct-bootstrap-config-handle-valid-");
    const path = join(root, "config.json");
    writeFileSync(path, JSON.stringify({ allowlistHandle: " +82 10-1234-5678 " }));

    await expect(probeConfig(path)).resolves.toEqual({
      status: "passed",
      allowlistHandle: "+821012345678",
    });
  });
});
