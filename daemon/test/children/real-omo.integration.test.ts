import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OmoExternalRunner } from "../../src/children/runners/omo-external.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const runRealOmo = process.env.OI_REAL_OMO === "1" ? test : test.skip;

runRealOmo("runs one real non-interactive omo engine child process", async () => {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-real-omo-"));
  directories.push(root);
  const runner = new OmoExternalRunner({
    root,
    modelPattern: process.env.OI_REAL_MODEL ?? "anthropic/claude-sonnet-4-5",
    agentDir: process.env.OI_REAL_AGENT_DIR,
  });
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 300_000);

  try {
    const result = await runner.run({
      childId: "real-omo-child",
      title: "Real omo engine smoke",
      prompt: "Reply with exactly OMO_EXTERNAL_OK and no other text.",
    }, controller.signal);
    expect(result).toMatchObject({ state: "completed" });
    expect(result.summary).toContain("OMO_EXTERNAL_OK");
  } finally {
    clearTimeout(deadline);
  }
}, 310_000);
