import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GjcExternalRunner } from "../../src/children/runners/gjc-external.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const runRealGjc = process.env.OI_REAL_GJC === "1" ? test : test.skip;

runRealGjc("runs one real non-interactive gjc child process", async () => {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-real-gjc-"));
  directories.push(root);
  const runner = new GjcExternalRunner({ root });
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 300_000);

  try {
    const result = await runner.run({
      childId: "real-gjc-child",
      title: "Real GJC smoke",
      prompt: "Reply with exactly GJC_EXTERNAL_OK and no other text.",
    }, controller.signal);
    expect(result).toMatchObject({ state: "completed" });
    expect(result.summary).toContain("GJC_EXTERNAL_OK");
  } finally {
    clearTimeout(deadline);
  }
}, 310_000);
