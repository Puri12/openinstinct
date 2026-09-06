import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OmoExternalRunner } from "../../src/children/runners/omo-external.ts";

const directories: string[] = [];
const fixture = join(import.meta.dir, "../fixtures/children/omo-stub.sh");

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for external runner fixture");
    }
    await Bun.sleep(5);
  }
}

describe("OmoExternalRunner", () => {
  test("uses the omo engine CLI in -p --mode json and maps the terminal JSON result", async () => {
    chmodSync(fixture, 0o700);
    const root = mkdtempSync(join(tmpdir(), "openinstinct-omo-external-"));
    directories.push(root);
    const runner = new OmoExternalRunner({ root, cliPath: fixture, env: { ...process.env, HOME: root } });
    let progressEvents = 0;

    await expect(runner.run({
      childId: "external-1",
      title: "Fixture",
      prompt: "COMPLETE",
      onProgress: () => {
        progressEvents += 1;
      },
    }, new AbortController().signal)).resolves.toEqual({
      state: "completed",
      summary: "fixture result",
    });
    expect(progressEvents).toBeGreaterThan(0);
  });

  test("reports stderr output as progress before the terminal stdout record", async () => {
    chmodSync(fixture, 0o700);
    const root = mkdtempSync(join(tmpdir(), "openinstinct-omo-external-"));
    directories.push(root);
    const runner = new OmoExternalRunner({ root, cliPath: fixture, env: { ...process.env, HOME: root } });
    let progressEvents = 0;

    await expect(runner.run({
      childId: "external-stderr-progress",
      title: "Fixture",
      prompt: "STDERR_PROGRESS",
      onProgress: () => {
        progressEvents += 1;
      },
    }, new AbortController().signal)).resolves.toEqual({
      state: "completed",
      summary: "stderr progress result",
    });
    expect(progressEvents).toBeGreaterThanOrEqual(2);
  });

  test("cancels the spawned process group when the lifecycle aborts", async () => {
    chmodSync(fixture, 0o700);
    const root = mkdtempSync(join(tmpdir(), "openinstinct-omo-external-"));
    directories.push(root);
    const nestedPidPath = join(root, "nested.pid");
    const runner = new OmoExternalRunner({
      root,
      cliPath: fixture,
      killGraceMs: 100,
      env: { ...process.env, HOME: root, OMO_STUB_CHILD_PID_FILE: nestedPidPath },
    });
    const controller = new AbortController();
    const result = runner.run({
      childId: "external-cancel",
      title: "Fixture",
      prompt: "HANG",
    }, controller.signal);

    await waitFor(() => existsSync(nestedPidPath));
    controller.abort();

    await expect(result).resolves.toMatchObject({
      state: "cancelled",
      errorCode: "cancelled",
    });
    await Bun.sleep(25);
    const nestedPid = Number(readFileSync(nestedPidPath, "utf8"));
    expect(() => process.kill(nestedPid, 0)).toThrow();
  });

  test("collects streaming JSON records as a completed terminal response", async () => {
    chmodSync(fixture, 0o700);
    const root = mkdtempSync(join(tmpdir(), "openinstinct-omo-external-"));
    directories.push(root);
    const runner = new OmoExternalRunner({ root, cliPath: fixture, env: { ...process.env, HOME: root } });

    await expect(runner.run({
      childId: "external-multi",
      title: "Fixture",
      prompt: "MULTI",
    }, new AbortController().signal)).resolves.toEqual({
      state: "completed",
      summary: "fixture result",
    });
  });

  test("extracts final assistant text from an omo engine agent_end JSON event", async () => {
    chmodSync(fixture, 0o700);
    const root = mkdtempSync(join(tmpdir(), "openinstinct-omo-external-"));
    directories.push(root);
    const runner = new OmoExternalRunner({ root, cliPath: fixture, env: { ...process.env, HOME: root } });

    await expect(runner.run({
      childId: "external-agent-end",
      title: "Fixture",
      prompt: "AGENT_END",
    }, new AbortController().signal)).resolves.toEqual({
      state: "completed",
      summary: "agent end result",
    });
  });

  test("runs a .js engine bundle under the runtime with the omo flag set and the agent dir exported", async () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-omo-external-"));
    directories.push(root);
    const bundle = join(root, "cli.js");
    writeFileSync(bundle, "const summary = JSON.stringify({ argv: process.argv.slice(2), agentDir: [process.env.SENPI_CODING_AGENT_DIR, process.env.OMO_CODING_AGENT_DIR, process.env.PI_CODING_AGENT_DIR] });\nconsole.log(JSON.stringify({ state: \"completed\", summary }));\n", { mode: 0o600 });
    const agentDir = join(root, "agent");
    const runner = new OmoExternalRunner({
      root,
      cliPath: bundle,
      agentDir,
      modelPattern: "oi-test/oi-model",
      env: { ...process.env, HOME: root },
    });

    const result = await runner.run({
      childId: "external-bundle",
      title: "Bundle",
      prompt: "BUNDLE",
    }, new AbortController().signal);

    expect(result.state).toBe("completed");
    const spawned = JSON.parse(result.summary) as { readonly argv: string[]; readonly agentDir: string[] };
    expect(spawned.argv).toEqual([
      "-p",
      "--mode", "json",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--session-dir", join(root, "sessions", "external-bundle"),
      "--model", "oi-test/oi-model",
      "BUNDLE",
    ]);
    expect(spawned.agentDir).toEqual([agentDir, agentDir, agentDir]);
  });

  test("preserves an explicit failed terminal report on nonzero omo engine exit", async () => {
    chmodSync(fixture, 0o700);
    const root = mkdtempSync(join(tmpdir(), "openinstinct-omo-external-"));
    directories.push(root);
    const runner = new OmoExternalRunner({ root, cliPath: fixture, env: { ...process.env, HOME: root } });

    await expect(runner.run({
      childId: "external-crash",
      title: "Fixture",
      prompt: "CRASH",
    }, new AbortController().signal)).resolves.toMatchObject({
      state: "failed",
      errorCode: "fixture_crash",
      errorMessage: "fixture exited intentionally",
    });
  });
});
