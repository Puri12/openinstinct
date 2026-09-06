import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { memoryAudit, runMemoryAudit } from "../../src/memory/adapters/audit.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function corpus(): Promise<{ readonly home: string; readonly root: string }> {
  const home = mkdtempSync(join(tmpdir(), "openinstinct-memory-audit-"));
  const root = join(home, "memory");
  directories.push(home);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "MEMORY.md"), [
    "# Memory map",
    "",
    "## daily",
    "## events",
    "## tasks",
    "## people",
    "## projects",
    "## channels",
    "## decisions",
    "## ops",
    "## reflections",
    "",
  ].join("\n"));
  return { home, root };
}

function write(root: string, path: string, body: string): void {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, body);
}

async function codes(root: string): Promise<string[]> {
  return (await memoryAudit(root)).issues.map((issue) => issue.code);
}

describe("read-only memory audit", () => {
  test("reports map_dangling", async () => {
    const { root } = await corpus();
    write(root, "MEMORY.md", "# Memory map\n\n- [missing](projects/missing.md)\n");
    expect(await codes(root)).toContain("map_dangling");
  });

  test("reports unmapped_axis_dir", async () => {
    const { root } = await corpus();
    write(root, "MEMORY.md", "# Memory map\n");
    expect(await codes(root)).toContain("unmapped_axis_dir");
  });

  test("reports long_form_map from the vendored navigation-only map rule", async () => {
    const { root } = await corpus();
    write(root, "MEMORY.md", `# Memory map\n\n${"x".repeat(201)}\n`);
    expect(await codes(root)).toContain("long_form_map");
  });

  test("reports orphan_file", async () => {
    const { root } = await corpus();
    write(root, "unregistered/fact.md", "orphan\n");
    expect(await codes(root)).toContain("orphan_file");
  });

  test("reports percent-decoded out_of_root_link", async () => {
    const { root } = await corpus();
    write(root, "projects/link.md", "[escape](%2e%2e/%2e%2e/secret.md)\n");
    expect(await codes(root)).toContain("out_of_root_link");
  });

  test("reports axis_layout_violation", async () => {
    const { root } = await corpus();
    write(root, "ops/not-routed.md", "must be in a declared partition\n");
    expect(await codes(root)).toContain("axis_layout_violation");
  });

  test("reports map_content_drift for the newest append-only file", async () => {
    const { root } = await corpus();
    write(root, "daily/2026-01-01.md", "raw capture\n");
    expect(await codes(root)).toContain("map_content_drift");
  });

  test("reports duplicate_file_hash", async () => {
    const { root } = await corpus();
    write(root, "projects/one.md", "same bytes\n");
    write(root, "people/two.md", "same bytes\n");
    const report = await memoryAudit(root);
    expect(report.exitCode).toBe(1);
    expect(report.json).toContain("duplicate_file_hash");
    expect(report.issues.map((issue) => issue.code)).toContain("duplicate_file_hash");
  });

  test("refuses repair-style arguments instead of silently ignoring --fix", async () => {
    const { root } = await corpus();
    await expect(runMemoryAudit(root, ["--fix"])).rejects.toThrow("accepts no arguments");
  });
});
