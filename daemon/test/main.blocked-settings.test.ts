import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BootstrapProbes } from "../src/bootstrap/states.ts";
import { startDaemon } from "../src/main.ts";
import { dataPaths } from "../src/paths.ts";
import type { MainSessionFactory } from "../src/sdk-session/main-session.ts";
import { requestControl } from "../../scripts/lib/control-client.ts";

const directories: string[] = [];

const mainSessionFactory: MainSessionFactory = {
  create: async () => ({
    sessionFile: "/tmp/blocked-settings-main.jsonl",
    sessionId: "blocked-settings-main",
    prompt: async () => {},
  }),
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function blockedPaths(prefix: string): ReturnType<typeof dataPaths> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  directories.push(root);
  const paths = dataPaths(join(root, "home"));
  mkdirSync(paths.root, { recursive: true });
  return paths;
}

const fdaDenied: BootstrapProbes = {
  config: async () => ({ status: "passed", allowlistHandle: "+821012345678" }),
  credentials: async () => ({ status: "passed" }),
  fda: async () => ({ status: "denied", reason: "Full Disk Access is not granted." }),
  accessibility: async () => ({ status: "passed" }),
  messages: async () => ({ status: "passed" }),

};

describe("status projection for the optional iMessage lane", () => {
  test("reports FDA denial while the core runs and preserves the normalized owner handle", async () => {
    const paths = blockedPaths("openinstinct-blocked-settings-");
    writeFileSync(paths.config, JSON.stringify({ allowlistHandle: "+8210 1234 5678" }));

    const runtime = await startDaemon({
      paths,
      probes: fdaDenied,
      mainSessionFactory,
      reprobeIntervalMs: 60_000,
      maintenanceIntervalMs: 60_000,
    });
    try {
      const response = await requestControl(paths.controlSocket, "status.get");
      const payload = response.payload as {
        bootstrap: {
          state: string;
          probes: {
            config: { status: string };
            credentials: { status: string };
            fda?: { status: string };
          };
        };
        settings: { allowlistHandle?: string };
        imessage: { reason?: string };
      };
      expect(payload.bootstrap.state).toBe("running");
      expect(payload.bootstrap.probes.config.status).toBe("passed");
      expect(payload.bootstrap.probes.credentials.status).toBe("passed");
      expect(payload.bootstrap.probes.fda).toMatchObject({ status: "denied" });
      expect(payload.imessage.reason).toBe("fda_denied");
      // Normalized, not the raw spaced config spelling: the panel must render the
      // same identity the allowlist actually enforces.
      expect(payload.settings.allowlistHandle).toBe("+821012345678");
    } finally {
      await runtime.stop();
    }
  });

  test("keeps the core running and omits the owner handle when config.json is unusable", async () => {
    const paths = blockedPaths("openinstinct-blocked-noconfig-");
    writeFileSync(paths.config, JSON.stringify({ allowlistHandle: "not-a-handle" }));

    const runtime = await startDaemon({
      paths,
      probes: {
        config: async () => ({ status: "invalid", reason: "config.json must contain a valid allowlistHandle" }),
        credentials: async () => ({ status: "passed" }),
        fda: async () => ({ status: "passed" }),
        accessibility: async () => ({ status: "passed" }),
        messages: async () => ({ status: "passed" }),
      },
      mainSessionFactory,
      reprobeIntervalMs: 60_000,
      maintenanceIntervalMs: 60_000,
    });
    try {
      const response = await requestControl(paths.controlSocket, "status.get");
      const payload = response.payload as {
        bootstrap: {
          state: string;
          probes: { config: { status: string } };
        };
        settings: { allowlistHandle?: string };
      };
      expect(payload.bootstrap.state).toBe("running");
      expect(payload.bootstrap.probes.config.status).toBe("invalid");
      expect(payload.settings.allowlistHandle).toBeUndefined();
    } finally {
      await runtime.stop();
    }
  });
});