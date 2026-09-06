import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createOmoServices,
  ensureOmoAgentDir,
  modelLabel,
  omoAgentDir,
  omoAgentDirEnv,
  OMO_AGENT_DIR_ENV_NAMES,
  openOmoSession,
  resolveModel,
} from "../../src/omo-session/omo-runtime.ts";
import { defineTool } from "@code-yeongyu/senpi";
import { Type } from "../../src/omo-session/tool-types.ts";

const TEST_PROVIDER = {
  providers: {
    "oi-test": {
      name: "OI Test",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "test-key",
      api: "openai-completions",
      models: [{
        id: "oi-model",
        name: "OI Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8_192,
      }],
    },
  },
};

const directories: string[] = [];
const restoreEnv: Array<readonly [string, string | undefined]> = [];

afterEach(() => {
  for (const [name, value] of restoreEnv.splice(0)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Creates a seeded agent dir with the offline fake provider and pins the engine env to it. */
function createAgentRoot(): { readonly root: string; readonly agentDir: string; readonly cwd: string } {
  const root = mkdtempSync(join(tmpdir(), "openinstinct-omo-runtime-"));
  directories.push(root);
  const paths = ensureOmoAgentDir(root);
  writeFileSync(paths.modelsJson, JSON.stringify(TEST_PROVIDER), { mode: 0o600 });
  for (const name of OMO_AGENT_DIR_ENV_NAMES) {
    restoreEnv.push([name, process.env[name]]);
  }
  process.env.SENPI_CODING_AGENT_DIR = paths.dir;
  const cwd = join(root, "workspace");
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  return { root, agentDir: paths.dir, cwd };
}

function permissions(path: string): number {
  return statSync(path).mode & 0o777;
}

test("ensureOmoAgentDir seeds the engine state files private and keeps existing content", () => {
  // Given: an empty ~/.openinstinct root
  const root = mkdtempSync(join(tmpdir(), "openinstinct-omo-seed-"));
  directories.push(root);

  // When: the agent dir is ensured twice, with an edit in between
  const first = ensureOmoAgentDir(root);
  writeFileSync(first.authJson, JSON.stringify({ "oi-test": { type: "api_key", key: "kept" } }), { mode: 0o600 });
  const second = ensureOmoAgentDir(root);

  // Then: layout, permissions, and the caller's edit all survive
  expect(second).toEqual(omoAgentDir(root));
  expect(second.dir).toBe(join(root, "omo"));
  expect(permissions(second.dir)).toBe(0o700);
  expect(permissions(second.sessions)).toBe(0o700);
  expect(permissions(second.settingsJson)).toBe(0o600);
  expect(permissions(second.modelsJson)).toBe(0o600);
  expect(permissions(second.authJson)).toBe(0o600);
  expect(JSON.parse(readFileSync(second.settingsJson, "utf8"))).toEqual({
    steeringMode: "all",
    followUpMode: "all",
    compaction: { enabled: false },
    quietStartup: true,
  });
  expect(JSON.parse(readFileSync(second.modelsJson, "utf8"))).toEqual({ providers: {} });
  expect(JSON.parse(readFileSync(second.authJson, "utf8"))).toEqual({ "oi-test": { type: "api_key", key: "kept" } });
});

test("omoAgentDirEnv pins every engine agent-dir variable to one directory", () => {
  // Given / When: an overlay for a chosen engine state dir
  const env = omoAgentDirEnv("/tmp/omo-state");

  // Then: all three names carry it
  expect(env).toEqual({
    SENPI_CODING_AGENT_DIR: "/tmp/omo-state",
    OMO_CODING_AGENT_DIR: "/tmp/omo-state",
    PI_CODING_AGENT_DIR: "/tmp/omo-state",
  });
});

test("resolveModel returns the configured model, and falls back with a warning when the pattern is unknown", async () => {
  // Given: services over an agent dir whose only provider is the offline fake
  const { agentDir, cwd } = createAgentRoot();
  const services = await createOmoServices({ cwd, agentDir });

  // When: an exact pattern and an unknown pattern are resolved
  const exact = await resolveModel(services, "oi-test/oi-model");
  const fallback = await resolveModel(services, "nope/none");

  // Then: the exact match is warning-free and the unknown one degrades to the available model
  expect(modelLabel(exact.model)).toBe("oi-test/oi-model");
  expect(exact.warning).toBeUndefined();
  expect(modelLabel(fallback.model)).toBe("oi-test/oi-model");
  expect(fallback.warning).toBe("model nope/none not found; using oi-test/oi-model");
});

test("resolveModel throws when no provider can supply a model", async () => {
  // Given: services over an agent dir with no providers at all
  const root = mkdtempSync(join(tmpdir(), "openinstinct-omo-empty-"));
  directories.push(root);
  const paths = ensureOmoAgentDir(root);
  for (const name of OMO_AGENT_DIR_ENV_NAMES) {
    restoreEnv.push([name, process.env[name]]);
  }
  process.env.SENPI_CODING_AGENT_DIR = paths.dir;
  const services = await createOmoServices({ cwd: root, agentDir: paths.dir });

  // When / Then: resolution fails loudly instead of returning a broken session
  await expect(resolveModel(services, "oi-test/oi-model")).rejects.toThrow(/^no usable model: /);
});

test("openOmoSession exposes custom tools, hides the daemon-excluded ones, and carries the appended prompt", async () => {
  // Given: services carrying an appended system prompt and a custom tool
  const { root, agentDir, cwd } = createAgentRoot();
  const marker = "OI_APPENDED_PROMPT_MARKER";
  const services = await createOmoServices({ cwd, agentDir, appendSystemPrompt: [marker] });
  const { model } = await resolveModel(services, "oi-test/oi-model");
  const pingTool = defineTool({
    name: "oi_ping",
    label: "OI Ping",
    description: "Returns a fixed acknowledgement used to prove custom tool registration.",
    parameters: Type.Object({ value: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      return { content: [{ type: "text" as const, text: `pong:${params.value}` }], details: {} };
    },
  });

  // When: a session is opened over those services
  const session = await openOmoSession({
    services,
    cwd,
    sessionDir: join(root, "sessions"),
    model,
    customTools: [pingTool],
  });

  try {
    // Then: the tool surface and system prompt match what the daemon requires
    const active = session.getActiveToolNames();
    expect(active).toContain("oi_ping");
    expect(active).not.toContain("eval");
    expect(active).not.toContain("todo");
    expect(session.systemPrompt).toContain(marker);
    expect(session.model === undefined ? undefined : modelLabel(session.model)).toBe("oi-test/oi-model");
    const result = await session.executeTool("oi_ping", { value: "42" });
    expect(result.content).toEqual([{ type: "text", text: "pong:42" }]);
  } finally {
    session.dispose();
  }
});
