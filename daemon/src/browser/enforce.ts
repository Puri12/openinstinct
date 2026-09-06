import type { ExtensionFactory } from "@code-yeongyu/senpi";

import { BROWSER_MCP_SERVER, browserMcpDeclaration } from "./chrome.ts";

/**
 * Hard rules, not prompts. The browser surface is pinned structurally: the
 * agent has no browser tool of its own, only `chrome-devtools-mcp` attached to
 * the daemon-owned Chrome on our profile, registered here. What is left to
 * enforce at call time is everything the engine would otherwise allow: its own
 * spawners, an unbounded tool budget, and reads of our state and other agents'
 * homes.
 */
/** Main session only: bash must not block the owner's chat. */
const MAIN_BASH_MAX_TIMEOUT_S = 20;

/** Engine spawners that bypass OpenInstinct's child lifecycle (concurrency cap, receipts, journal, panel visibility, model pin, this very enforcer). */
const BLOCKED_SPAWNERS = ["task", "subagent", "job", "eval", "workflow", "team_create", "schedule_wakeup"];

export function checkMainBashInput(input: Record<string, unknown>): string | undefined {
  if (input.run_in_background === true) {
    return undefined;
  }
  const timeout = typeof input.timeout === "number" ? input.timeout : undefined;
  if (timeout !== undefined && timeout <= MAIN_BASH_MAX_TIMEOUT_S) {
    return undefined;
  }
  return `In the owner chat, bash must either be quick (timeout ≤ ${MAIN_BASH_MAX_TIMEOUT_S}s, set explicitly) or run with run_in_background: true. For anything longer or multi-step, use delegate_background and tell the owner it is underway`;
}

/**
 * Paths no session may read with `read`/`bash`: our own transcripts, journals
 * and logs. They are huge, self-referential, and reading them once blew a
 * monitor child past the 1 MiB output cap. Memory lives elsewhere and is fine.
 */
export function forbiddenPathReason(target: string, root: string): string | undefined {
  const norm = target.replace(/\/+$/, "");
  const banned = [
    [`${root}/children`, "child work/session/journal directories"],
    [`${root}/logs`, "daemon logs"],
    [`${root}/omo`, "the engine state directory (sessions, auth)"],
    [`${root}/state.db`, "the daemon state database"],
    [`${root}/env`, "the credentials file"],
    [`${root}/secrets`, "stored credentials (use them via the service, never read them back)"],
  ] as const;
  for (const [prefix, what] of banned) {
    if (norm === prefix || norm.startsWith(`${prefix}/`)) {
      return `Reading ${what} is off-limits: it is enormous and not information for the owner. Use memory_search / the memory directory instead.`;
    }
  }
  // Other agents' homes on this Mac: the host omo / senpi / pi installs and the
  // coding-tool sign-ins the daemon may only adopt through Settings, never
  // read directly. A child once read another agent's Discord bot token from a
  // sibling home and started calling the Discord API as that bot.
  const home = process.env.HOME ?? "";
  const otherAgent = "That directory belongs to another agent running on this Mac (its credentials, gateway and memory). Never read or use it; Discord is only reachable through the browser as the owner.";
  for (const other of [`${home}/.omo`, `${home}/.senpi`, `${home}/.pi`, `${home}/.codex`, `${home}/.claude`, `${home}/.cursor`]) {
    if (norm === other || norm.startsWith(`${other}/`)) {
      return otherAgent;
    }
  }
  // Every omo-family install keeps its engine state at ~/.<brand>/agent (auth.json,
  // sessions, models.json), whatever the brand is called; the daemon's own copy is
  // ~/.openinstinct/omo, which the list above already covers.
  if (home.length > 0 && new RegExp(`^${escapeRegExp(home)}/\\.[^/]+/agent(/|$)`).test(norm)) {
    return otherAgent;
  }
  if (/\.jsonl$/.test(norm) && norm.includes("/sessions/")) {
    return "Session transcripts are off-limits (they are your own history, and huge). Use memory_search instead.";
  }
  return undefined;
}

/** Bot-token API calls are never ours: Discord is a browser-only surface for this agent. */
export function forbiddenBashReason(command: string): string | undefined {
  if (/discord(app)?\.com\/api\b/i.test(command) || /Authorization:\s*Bot\b/i.test(command) || /discord[-_]token/i.test(command)) {
    return "Calling the Discord API with a bot token is off-limits: that bot belongs to another agent. Read Discord through the browser as the owner, and never post there.";
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pathsInBash(command: string): string[] {
  return [...command.matchAll(/(?:^|[\s"'=])(\/[^\s"'|;&<>]+|~\/[^\s"'|;&<>]+)/g)].map((m) => m[1]!.replace(/^~/, process.env.HOME ?? "~"));
}

/**
 * `chromeProfile` is the profile the daemon-owned Chrome already runs on; it is
 * kept in the signature because callers name the browser this session may drive,
 * but the pin itself is the MCP server's `--browserUrl`, which no tool call can
 * redirect.
 */
export function browserProfileEnforcer(chromeProfile: string, options: { readonly guardBash?: boolean; readonly maxToolCallsPerTurn?: number; readonly forbiddenRoot?: string; readonly tabPrefix?: string; readonly cdpPort?: number } = {}): ExtensionFactory {
  let turnCalls = 0;
  return (pi) => {
    pi.registerMcpServer(BROWSER_MCP_SERVER, browserMcpDeclaration({ port: options.cdpPort }));
    pi.on("turn_start", () => { turnCalls = 0; });
    pi.on("tool_call", (event) => {
      if (BLOCKED_SPAWNERS.includes(event.toolName)) {
        return { block: true, reason: "That tool is not available here. Background work goes through delegate_background; answer the owner with what you have." };
      }
      if (options.maxToolCallsPerTurn !== undefined) {
        turnCalls += 1;
        if (turnCalls > options.maxToolCallsPerTurn) {
          return { block: true, reason: `Tool budget for this reply is spent (${options.maxToolCallsPerTurn} calls). Reply to the owner now with what you have; if more work is needed, hand it to delegate_background.` };
        }
      }
      const input: Record<string, unknown> = event.input;
      if (options.forbiddenRoot !== undefined) {
        const targets: string[] = event.toolName === "read" && typeof input.path === "string"
          ? [input.path.split(":")[0]!]
          : event.toolName === "bash" && typeof input.command === "string"
            ? pathsInBash(input.command)
            : [];
        for (const t of targets) {
          const why = forbiddenPathReason(t, options.forbiddenRoot);
          if (why) return { block: true, reason: why };
        }
      }
      if (event.toolName !== "bash") {
        return undefined;
      }
      const why = typeof input.command === "string" ? forbiddenBashReason(input.command) : undefined;
      if (why) return { block: true, reason: why };
      if (options.guardBash !== true) {
        return undefined;
      }
      const problem = checkMainBashInput(input);
      return problem === undefined ? undefined : { block: true, reason: problem };
    });
  };
}
