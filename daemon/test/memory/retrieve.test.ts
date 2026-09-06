import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { regenerateMap } from "../../src/memory/vendor/doctrine.ts";
import { searchMemory } from "../../src/memory/vendor/retrieve.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("memory BM25 retrieval", () => {
  test("ranks a higher-priority canonical axis first when lexical scores tie", async () => {
    const home = mkdtempSync(join(tmpdir(), "openinstinct-memory-search-"));
    directories.push(home);
    const root = join(home, "memory");
    mkdirSync(root, { recursive: true });
    mkdirSync(join(root, "daily"), { recursive: true });
    mkdirSync(join(root, "ops", "rules"), { recursive: true });
    writeFileSync(join(root, "daily", "2026-01-01.md"), "needle evidence\n");
    writeFileSync(join(root, "ops", "rules", "needle.md"), "needle evidence\n");
    await regenerateMap(root);

    const hits = await searchMemory(root, "needle", 10);
    expect(hits.map((hit) => hit.path)).toEqual([
      "ops/rules/needle.md",
      "daily/2026-01-01.md",
    ]);
    expect(hits[0]!.excerpt).toContain("needle evidence");
  });
});
