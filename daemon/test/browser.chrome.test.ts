import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { browserMcpDeclaration, CHROME_CDP_PORT, cdpUrl, ensureChrome } from "../src/browser/chrome.ts";

const originalChromePath = process.env.PUPPETEER_EXECUTABLE_PATH;
const temporaryRoots: string[] = [];

/** The launch path resolves a real Chrome binary; point it at a file that always exists so the test does not depend on /Applications. */
function fakeChromeEnv(): void {
  process.env.PUPPETEER_EXECUTABLE_PATH = process.execPath;
}

function temporaryProfile(): string {
  const root = mkdtempSync(join(tmpdir(), "oi-chrome-"));
  temporaryRoots.push(root);
  return join(root, "chrome-profile");
}

afterEach(() => {
  if (originalChromePath === undefined) {
    delete process.env.PUPPETEER_EXECUTABLE_PATH;
  } else {
    process.env.PUPPETEER_EXECUTABLE_PATH = originalChromePath;
  }
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("browser MCP declaration", () => {
  test("declares chrome-devtools-mcp on the daemon's bun, pinned to the daemon's CDP endpoint", () => {
    const declaration = browserMcpDeclaration({});
    expect(declaration.command).toBe(process.execPath);
    expect(declaration.args[0]).toEndWith("chrome-devtools-mcp.js");
    expect(existsSync(declaration.args[0])).toBe(true);
    expect(declaration.args.slice(1)).toEqual(["--browserUrl", `http://127.0.0.1:${CHROME_CDP_PORT}`]);
    expect(cdpUrl()).toBe("http://127.0.0.1:9223");
    expect(declaration.type).toBe("stdio");
    expect(declaration.lifecycle).toBe("eager");
    expect(declaration.exposure).toBe("direct");
    expect(declaration.startupTimeoutMs).toBe(15000);
    expect(declaration.includeTools).toContain("navigate_page");
    expect(declaration.includeTools).toContain("take_screenshot");
  });

  test("an explicit port and bin override the defaults", () => {
    const declaration = browserMcpDeclaration({ port: 9444, mcpBin: "/tmp/mcp.js" });
    expect(declaration.args).toEqual(["/tmp/mcp.js", "--browserUrl", "http://127.0.0.1:9444"]);
  });
});

describe("ensureChrome", () => {
  test("reuses a live Chrome instead of launching a second one on the same profile", async () => {
    fakeChromeEnv();
    const profile = temporaryProfile();
    const argvs: string[][] = [];

    const result = await ensureChrome({ profile, alive: async () => true, spawn: (argv) => { argvs.push(argv); } });

    expect(result).toEqual({ launched: false, url: `http://127.0.0.1:${CHROME_CDP_PORT}` });
    expect(argvs).toEqual([]);
    expect(existsSync(profile)).toBe(false);
  });

  test("launches Chrome on the daemon profile with the debugging port when nothing answers", async () => {
    fakeChromeEnv();
    const profile = temporaryProfile();
    const argvs: string[][] = [];
    let probes = 0;

    const result = await ensureChrome({ profile, spawn: (argv) => { argvs.push(argv); }, alive: async () => { probes += 1; return probes > 1; } });

    expect(result).toEqual({ launched: true, url: `http://127.0.0.1:${CHROME_CDP_PORT}` });
    expect(argvs).toHaveLength(1);
    expect(argvs[0]).toContain(`--remote-debugging-port=${CHROME_CDP_PORT}`);
    expect(argvs[0]).toContain(`--user-data-dir=${profile}`);
    expect(argvs[0]).not.toContain("--headless=new");
    expect(existsSync(profile)).toBe(true);
  });

  test("headless adds the flag and the port override reaches both argv and the returned url", async () => {
    fakeChromeEnv();
    const profile = temporaryProfile();
    const argvs: string[][] = [];
    let probes = 0;

    const result = await ensureChrome({ profile, port: 9555, headless: true, spawn: (argv) => { argvs.push(argv); }, alive: async () => { probes += 1; return probes > 1; } });

    expect(result.url).toBe("http://127.0.0.1:9555");
    expect(argvs[0]).toContain("--remote-debugging-port=9555");
    expect(argvs[0]).toContain("--headless=new");
  });
});
