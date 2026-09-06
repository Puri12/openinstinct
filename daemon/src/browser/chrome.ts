import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The daemon owns one Chrome: a persistent profile launched with a fixed
 * DevTools port. The agent never spawns its own browser, it only talks to this
 * one through `chrome-devtools-mcp`, so the profile pin is structural rather
 * than a rule the model has to obey.
 */
export const CHROME_CDP_PORT = 9223;
export const BROWSER_MCP_SERVER = "browser";

const CHROME_APP = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CDP_PROBE_TIMEOUT_MS = 1_500;
const LAUNCH_POLL_MS = 250;
const LAUNCH_TIMEOUT_MS = 15_000;

const MCP_BIN = fileURLToPath(new URL("../../node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js", import.meta.url));

/** Page/DOM/network surface the owner-facing agent needs; everything else (tracing, emulation, performance) stays off the tool list. */
const BROWSER_TOOLS = [
  "list_pages",
  "new_page",
  "select_page",
  "close_page",
  "navigate_page",
  "take_snapshot",
  "take_screenshot",
  "click",
  "fill",
  "fill_form",
  "hover",
  "press_key",
  "type_text",
  "wait_for",
  "evaluate_script",
  "handle_dialog",
  "list_console_messages",
  "list_network_requests",
  "upload_file",
] as const;

export function chromeExecutable(env: typeof process.env = process.env): string {
  const chrome = env.PUPPETEER_EXECUTABLE_PATH ?? CHROME_APP;
  if (!existsSync(chrome)) {
    throw new Error("Google Chrome is not installed at /Applications; install it or set PUPPETEER_EXECUTABLE_PATH in ~/.openinstinct/env");
  }
  return chrome;
}

export function cdpUrl(port: number = CHROME_CDP_PORT): string {
  return `http://127.0.0.1:${port}`;
}

/** A second Chrome on the same profile aborts with ProcessSingleton, so every launch path probes first. */
export async function isCdpAlive(port: number = CHROME_CDP_PORT): Promise<boolean> {
  try {
    const response = await fetch(`${cdpUrl(port)}/json/version`, { signal: AbortSignal.timeout(CDP_PROBE_TIMEOUT_MS) });
    return response.ok;
  } catch (error) {
    // Connection refused and probe timeout both mean "no browser there yet".
    if (error instanceof Error) {
      return false;
    }
    throw error;
  }
}

export interface EnsureChromeOptions {
  readonly profile: string;
  readonly port?: number;
  readonly headless?: boolean;
  readonly spawn?: (argv: string[]) => void;
  readonly alive?: (port: number) => Promise<boolean>;
}

export async function ensureChrome(options: EnsureChromeOptions): Promise<{ readonly launched: boolean; readonly url: string }> {
  const port = options.port ?? CHROME_CDP_PORT;
  const alive = options.alive ?? isCdpAlive;
  const url = cdpUrl(port);
  if (await alive(port)) {
    return { launched: false, url };
  }
  mkdirSync(options.profile, { recursive: true });
  const argv = [
    chromeExecutable(),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${options.profile}`,
    "--profile-directory=Default",
    "--no-first-run",
    "--no-default-browser-check",
    ...(options.headless === true ? ["--headless=new"] : []),
    "about:blank",
  ];
  (options.spawn ?? spawnDetached)(argv);
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await alive(port)) {
      return { launched: true, url };
    }
    await Bun.sleep(LAUNCH_POLL_MS);
  }
  throw new Error(`Chrome did not expose its DevTools endpoint at ${url} within ${LAUNCH_TIMEOUT_MS / 1_000}s`);
}

/** Chrome must outlive daemon restarts, so it is never a child in this process' job. */
function spawnDetached(argv: string[]): void {
  spawn(argv[0], argv.slice(1), { detached: true, stdio: "ignore" }).unref();
}

export function browserMcpDeclaration(options: { readonly port?: number; readonly mcpBin?: string }): {
  command: string;
  args: string[];
  type: "stdio";
  lifecycle: "eager";
  exposure: "direct";
  startupTimeoutMs: number;
  includeTools: string[];
} {
  return {
    command: process.execPath,
    args: [options.mcpBin ?? MCP_BIN, "--browserUrl", cdpUrl(options.port)],
    type: "stdio",
    lifecycle: "eager",
    exposure: "direct",
    startupTimeoutMs: LAUNCH_TIMEOUT_MS,
    includeTools: [...BROWSER_TOOLS],
  };
}
