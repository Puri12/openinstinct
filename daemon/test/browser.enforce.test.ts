import { describe, expect, test } from "bun:test";
import { browserProfileEnforcer, checkMainBashInput, forbiddenBashReason, forbiddenPathReason } from "../src/browser/enforce.ts";

const P = "/Users/x/.openinstinct/chrome-profile";

type Handler = (event: unknown) => unknown;

function mountEnforcer(...args: Parameters<typeof browserProfileEnforcer>): { readonly toolCall: Handler; readonly turnStart: Handler; readonly servers: Map<string, { args: string[] }> } {
  const handlers = new Map<string, Handler>();
  const servers = new Map<string, { args: string[] }>();
  browserProfileEnforcer(...args)({
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerMcpServer: (name: string, config: { args: string[] }) => servers.set(name, config),
  } as never);
  return { toolCall: handlers.get("tool_call")!, turnStart: handlers.get("turn_start")!, servers };
}

describe("browser surface pinning", () => {
  test("the enforcer registers the daemon-owned Chrome as the only browser surface", () => {
    const { servers } = mountEnforcer(P, { cdpPort: 9333 });
    expect([...servers.keys()]).toEqual(["browser"]);
    expect(servers.get("browser")!.args).toContain("http://127.0.0.1:9333");
  });

  test("browser tool calls are not second-guessed; the MCP pin is the enforcement", () => {
    const { toolCall } = mountEnforcer(P);
    expect(toolCall({ type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "ls" } })).toBeUndefined();
    expect(toolCall({ type: "tool_call", toolCallId: "2", toolName: "mcp_browser_navigate_page", input: { url: "https://x" } })).toBeUndefined();
  });

  test("engine spawners are blocked so background work stays in the child lifecycle", () => {
    const { toolCall } = mountEnforcer(P);
    for (const toolName of ["task", "subagent", "job", "eval", "workflow", "team_create", "schedule_wakeup"]) {
      const blocked = toolCall({ type: "tool_call", toolCallId: "s", toolName, input: {} }) as { block: boolean; reason: string };
      expect(blocked.block).toBe(true);
      expect(blocked.reason).toContain("delegate_background");
    }
  });
});

describe("main-session bash guard", () => {
  test("quick or backgrounded bash passes; long/blocking bash is redirected to delegate_background", () => {
    expect(checkMainBashInput({ command: "ls", timeout: 5 })).toBeUndefined();
    expect(checkMainBashInput({ command: "sleep 100", run_in_background: true })).toBeUndefined();
    expect(checkMainBashInput({ command: "ls" })).toMatch(/delegate_background/);
    expect(checkMainBashInput({ command: "make", timeout: 120 })).toMatch(/run_in_background: true/);
    const main = mountEnforcer("/x", { guardBash: true });
    expect((main.toolCall({ type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "ls" } }) as { block: boolean }).block).toBe(true);
    expect(main.toolCall({ type: "tool_call", toolCallId: "2", toolName: "bash", input: { command: "sleep 100", run_in_background: true } })).toBeUndefined();
    const child = mountEnforcer("/x");
    expect(child.toolCall({ type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "ls" } })).toBeUndefined();
  });
});

describe("per-turn tool budget", () => {
  test("blocks the 7th call in a turn and resets on turn_start", () => {
    const { toolCall, turnStart } = mountEnforcer("/x", { maxToolCallsPerTurn: 6 });
    const call = () => toolCall({ type: "tool_call", toolCallId: "c", toolName: "read", input: { path: "/a.txt" } }) as { block?: boolean } | undefined;
    for (let i = 0; i < 6; i += 1) expect(call()).toBeUndefined();
    expect(call()?.block).toBe(true);
    turnStart({ type: "turn_start" });
    expect(call()).toBeUndefined();
  });
});

describe("forbidden path guard", () => {
  test("blocks read/bash on children, logs, engine state, secrets, transcripts; allows memory", () => {
    const root = "/Users/x/.openinstinct";
    expect(forbiddenPathReason(`${root}/children/sessions/abc/2026.jsonl`, root)).toMatch(/off-limits/);
    expect(forbiddenPathReason(`${root}/logs/daemon.ndjson`, root)).toMatch(/daemon logs/);
    expect(forbiddenPathReason(`${root}/omo/sessions/x.jsonl`, root)).toMatch(/sessions, auth/);
    expect(forbiddenPathReason(`${root}/secrets/kakao`, root)).toMatch(/credentials/);
    expect(forbiddenPathReason(`${root}/memory/daily/2026-09-02.md`, root)).toBeUndefined();
    expect(forbiddenPathReason("/tmp/shot.png", root)).toBeUndefined();
    const { toolCall } = mountEnforcer("/x", { forbiddenRoot: root });
    expect((toolCall({ type: "tool_call", toolCallId: "1", toolName: "read", input: { path: `${root}/children/journal/a.json:1-50` } }) as { block: boolean }).block).toBe(true);
    expect((toolCall({ type: "tool_call", toolCallId: "2", toolName: "bash", input: { command: `tail -c 5000 ${root}/logs/daemon.ndjson`, timeout: 5 } }) as { block: boolean }).block).toBe(true);
    expect(toolCall({ type: "tool_call", toolCallId: "3", toolName: "bash", input: { command: `cat ${root}/memory/MEMORY.md`, timeout: 5 } })).toBeUndefined();
  });
});

describe("other agents' homes and bot tokens", () => {
  const home = process.env.HOME ?? "";
  test("other agents' home directories on this Mac are off-limits", () => {
    expect(forbiddenPathReason(`${home}/.pi/agent/auth.json`, `${home}/.openinstinct`)).toContain("another agent");
    expect(forbiddenPathReason(`${home}/.codex/auth.json`, `${home}/.openinstinct`)).toContain("another agent");
    expect(forbiddenPathReason(`${home}/.claude/.credentials.json`, `${home}/.openinstinct`)).toContain("another agent");
    expect(forbiddenPathReason(`${home}/.somebrand/agent/auth.json`, `${home}/.openinstinct`)).toContain("another agent");
    expect(forbiddenPathReason(`${home}/.somebrand/notes.md`, `${home}/.openinstinct`)).toBeUndefined();
    expect(forbiddenPathReason(`${home}/.omo/agent/auth.json`, `${home}/.openinstinct`)).toContain("another agent");
    expect(forbiddenPathReason(`${home}/.senpi/agent/auth.json`, `${home}/.openinstinct`)).toContain("another agent");
    expect(forbiddenPathReason(`${home}/.openinstinct/memory/MEMORY.md`, `${home}/.openinstinct`)).toBeUndefined();
  });
  test("bash calling the Discord API with a bot token is blocked", () => {
    expect(forbiddenBashReason('curl -H "Authorization: Bot $TOKEN" https://discord.com/api/v10/users/@me')).toContain("Discord API");
    expect(forbiddenBashReason("TOKEN=$(cat ~/.omo/agent/discord-token)")).toContain("Discord API");
    expect(forbiddenBashReason("curl https://discord.com/channels/@me")).toBeUndefined();
  });
});
