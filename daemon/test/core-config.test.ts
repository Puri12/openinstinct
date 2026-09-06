import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readCoreConfig } from "../src/core-config.ts";
import { NdjsonLogger } from "../src/log.ts";
import { defaultMonitorRuntimeConfig } from "../src/monitors/triggers.ts";
import { defaultRuntimeConfig } from "../src/runtime-config.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function readEntries(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) {
    return [];
  }
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function setup(): { readonly root: string; readonly config: string; readonly log: string; readonly logger: NdjsonLogger } {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-core-config-"));
  directories.push(root);
  const config = join(root, "config.json");
  const log = join(root, "daemon.ndjson");
  return { root, config, log, logger: new NdjsonLogger(log) };
}

describe("core config", () => {
  test("missing config applies both defaults without reader warnings", async () => {
    const { config, log, logger } = setup();

    await expect(readCoreConfig(config, logger)).resolves.toEqual({
      runtime: defaultRuntimeConfig(),
      monitors: defaultMonitorRuntimeConfig(),
    });

    const entries = readEntries(log);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: "info",
      module: "main",
      event: "config_missing_defaults_applied",
      path: config,
    });
    expect(entries.filter((entry) => entry.level === "warn")).toHaveLength(0);
  });

  test("malformed config applies each scope default and warns twice", async () => {
    const { config, log, logger } = setup();
    writeFileSync(config, "{");

    await expect(readCoreConfig(config, logger)).resolves.toEqual({
      runtime: defaultRuntimeConfig(),
      monitors: defaultMonitorRuntimeConfig(),
    });

    const entries = readEntries(log);
    expect(entries).toHaveLength(2);
    expect(entries.filter((entry) => entry.level === "info")).toHaveLength(0);
    expect(entries.filter((entry) => entry.level === "warn").map((entry) => entry.scope).sort()).toEqual([
      "monitors",
      "runtime",
    ]);
    for (const entry of entries) {
      expect(entry).toMatchObject({ level: "warn", module: "main", event: "config_invalid_defaults_applied" });
      expect(typeof entry.reason).toBe("string");
    }
  });

  test("keeps valid runtime settings when monitor settings are invalid", async () => {
    const { config, log, logger } = setup();
    writeFileSync(config, JSON.stringify({ allowlistHandle: "+821012345678", ownerName: "Ada", webhookPort: -1 }));

    const result = await readCoreConfig(config, logger);
    expect(result.runtime).toMatchObject({ allowlistHandle: "+821012345678", ownerName: "Ada" });
    expect(result.monitors).toEqual(defaultMonitorRuntimeConfig());

    const entries = readEntries(log);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: "warn",
      module: "main",
      event: "config_invalid_defaults_applied",
      scope: "monitors",
    });
  });
});
