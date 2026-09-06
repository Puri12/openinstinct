import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { OmoChildSessionFactory } from "../../src/children/runners/omo-inprocess.ts";
import { loadSoul } from "../../src/persona/soul.ts";
import { OmoMainSessionFactory } from "../../src/omo-session/main-session.ts";
import { ensureOmoAgentDir } from "../../src/omo-session/omo-runtime.ts";

// An unreachable provider whose catalog is large enough for the engine's
// context guard: session creation and tool wiring never call the network.
const OFFLINE_PROVIDER = {
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

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function offlineRoot(prefix: string): { root: string; sessions: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  directories.push(root);
  const agent = ensureOmoAgentDir(root);
  writeFileSync(agent.modelsJson, JSON.stringify(OFFLINE_PROVIDER), { mode: 0o600 });
  return { root, sessions: agent.sessions };
}

type EngineView = { sessionId: string; getActiveToolNames(): readonly string[]; systemPrompt: string };

// The child adapter exposes its transcript path but not the engine's session id,
// so identity is compared on the transcript files themselves.
function transcriptName(sessionFile: string | undefined): string {
  expect(typeof sessionFile).toBe("string");
  return sessionFile!.slice(sessionFile!.lastIndexOf("/") + 1);
}

describe("omo session isolation", () => {
  test("child and main sessions live in their own transcripts with their own tool surfaces", async () => {
    const { root, sessions } = offlineRoot("openinstinct-omo-isolation-");
    const childSessions = join(root, "child-sessions");
    const childWork = join(root, "work");
    const mainWork = join(root, "main-work");
    mkdirSync(childWork, { recursive: true, mode: 0o700 });
    mkdirSync(mainWork, { recursive: true, mode: 0o700 });

    const child = await new OmoChildSessionFactory("oi-test/oi-model", root).create({
      childId: "isolation-child",
      title: "Isolation child",
      workingDirectory: childWork,
      sessionDirectory: childSessions,
      conversational: true,
      customTools: [],
    });
    const main = await new OmoMainSessionFactory({
      persona: () => ({ imessage: "detached" }),
      ownerName: "Owner",
      chromeProfile: join(root, "chrome-profile"),
      delegateBackground: () => ({ id: "unused" }),
      sendImage: () => ({ kind: "chat_only" }),
      modelPattern: "oi-test/oi-model",
      omoRoot: root,
    }).create({ workingDirectory: mainWork });

    try {
      expect(typeof main.sessionId).toBe("string");
      expect(transcriptName(child.sessionFile)).not.toBe(transcriptName(main.sessionFile));
      expect(child.sessionFile?.startsWith(childSessions)).toBe(true);
      expect(main.sessionFile?.startsWith(sessions)).toBe(true);

      const childTools = (child as unknown as EngineView).getActiveToolNames();
      for (const blocked of ["eval", "task", "todo", "create_goal"]) {
        expect(childTools).not.toContain(blocked);
      }

      const mainEngine = main as unknown as EngineView;
      const mainTools = mainEngine.getActiveToolNames();
      expect(mainTools).toContain("delegate_background");
      expect(mainTools).toContain("send_image");
      expect(mainTools).not.toContain("eval");
      expect(mainEngine.systemPrompt).toContain(loadSoul().text.slice(0, 40));
    } finally {
      await Promise.resolve(child.dispose?.());
      await Promise.resolve(main.dispose?.());
    }
  }, 30_000);
});
