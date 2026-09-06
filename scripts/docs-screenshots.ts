#!/usr/bin/env bun
/**
 * Renders the real menu-bar panel against a scripted mock daemon and captures
 * one PNG per onboarding state into docs/assets/. No daemon, no Messages, no
 * TCC involved: the panel is pointed at the mock through OI_CONTROL_SOCKET.
 *
 *   bun scripts/docs-screenshots.ts            # all states
 *   bun scripts/docs-screenshots.ts setup-2    # one state
 *
 * Needs the panel built (scripts/build-panel.sh) and Screen Recording for the
 * terminal that runs this (screencapture -l). Dark or light follows the Mac.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const repoRoot = join(import.meta.dir, "..");
const outDir = join(repoRoot, "docs", "assets");
const panelApp = join(repoRoot, "panel", ".build", "OpenInstinctPanel.app");
const panelBin = join(panelApp, "Contents", "MacOS", "OpenInstinctPanel");
const socketPath = join(tmpdir(), `oi-docs-${process.pid}.sock`);

type Probe = { status: string; reason?: string; aliases?: string[] };
type Scene = {
  readonly name: string;
  readonly view: "status" | "setup";
  readonly bootstrap: { state: string; remediation: string; probes: Record<string, Probe> };
  readonly accounts: number;
  readonly hasReplied: boolean;
  readonly ownerHandle?: string;
  readonly ownerName?: string;
  readonly activeChildren?: { id: string; title: string; kind: string; state: string; createdAt: string; startedAt: string; toolCalls: number; tokens: number }[];
  readonly recentChildren?: { id: string; title: string; kind: string; state: string; createdAt: string; updatedAt: string; toolCalls: number; tokens: number }[];
};

const ALIAS = "gajae.lee@icloud.com";
const OWNER = "+821012345678";
const passed: Probe = { status: "passed" };
const now = new Date();
const iso = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();

const SCENES: Scene[] = [
  {
    name: "setup-1-who-you-are",
    view: "setup",
    bootstrap: { state: "config_blocked", remediation: "Enter your phone number and name.", probes: { config: { status: "missing", reason: "Enter your phone number and name." } } },
    accounts: 0, hasReplied: false,
  },
  {
    name: "setup-2-own-account",
    view: "setup",
    bootstrap: {
      state: "identity_blocked",
      remediation: "Messages on this Mac is signed in as you (+82 10-1234-5678). Gajae would reply inside your own conversations. Sign Messages out and back in with a separate Apple ID made for Gajae.",
      probes: {
        config: passed,
        messages: { status: "invalid", aliases: ["+821012345678"], reason: "Messages on this Mac is signed in as you (+82 10-1234-5678). Gajae would reply inside your own conversations. Sign Messages out and back in with a separate Apple ID made for Gajae." },
      },
    },
    accounts: 0, hasReplied: false, ownerHandle: OWNER, ownerName: "Yeachan",
  },
  {
    name: "setup-3-full-disk-access",
    view: "setup",
    bootstrap: {
      state: "permission_blocked",
      remediation: "Gajae can't read your texts yet: turn on Full Disk Access for openinstinctd.",
      probes: { config: passed, messages: { status: "passed", aliases: [ALIAS] }, fda: { status: "denied", reason: "Gajae can't read your texts yet: turn on Full Disk Access for openinstinctd." }, accessibility: { status: "denied", reason: "Gajae can't send texts yet: allow openinstinctd to control Messages under Automation." } },
    },
    accounts: 0, hasReplied: false, ownerHandle: OWNER, ownerName: "Yeachan",
  },
  {
    name: "setup-5-ai-account",
    view: "setup",
    bootstrap: { state: "running", remediation: "Daemon is ready.", probes: { config: passed, messages: { status: "passed", aliases: [ALIAS] }, fda: passed, accessibility: passed } },
    accounts: 0, hasReplied: false, ownerHandle: OWNER, ownerName: "Yeachan",
  },
  {
    name: "setup-6-text-gajae",
    view: "setup",
    bootstrap: { state: "running", remediation: "Daemon is ready.", probes: { config: passed, messages: { status: "passed", aliases: [ALIAS] }, fda: passed, accessibility: passed } },
    accounts: 1, hasReplied: false, ownerHandle: OWNER, ownerName: "Yeachan",
  },
  {
    name: "setup-done",
    view: "setup",
    bootstrap: { state: "running", remediation: "Daemon is ready.", probes: { config: passed, messages: { status: "passed", aliases: [ALIAS] }, fda: passed, accessibility: passed } },
    accounts: 1, hasReplied: true, ownerHandle: OWNER, ownerName: "Yeachan",
  },
  {
    name: "panel-status",
    view: "status",
    bootstrap: { state: "running", remediation: "Daemon is ready.", probes: { config: passed, messages: { status: "passed", aliases: [ALIAS] }, fda: passed, accessibility: passed } },
    accounts: 1, hasReplied: true, ownerHandle: OWNER, ownerName: "Yeachan",
    activeChildren: [{ id: "c1", title: "Compare flight prices to Tokyo for next weekend", kind: "task_tool", state: "running", createdAt: iso(3), startedAt: iso(3), toolCalls: 7, tokens: 18_400 }],
    recentChildren: [
      { id: "r1", title: "Monitor: Morning briefing", kind: "daemon", state: "completed", createdAt: iso(240), updatedAt: iso(238), toolCalls: 4, tokens: 9_100 },
      { id: "r2", title: "Summarize the article you sent", kind: "task_tool", state: "completed", createdAt: iso(410), updatedAt: iso(409), toolCalls: 2, tokens: 3_300 },
    ],
  },
];

function statusPayload(s: Scene) {
  return {
    bootstrap: s.bootstrap,
    session: { state: s.bootstrap.state === "running" ? "active" : "inactive", ...(s.bootstrap.state === "running" ? { mainSessionId: "main-session-001" } : {}), mainSessionFilePresent: s.bootstrap.state === "running", paused: false, hasReplied: s.hasReplied },
    activeChildren: s.activeChildren ?? [],
    recentChildren: s.recentChildren ?? [],
    monitors: s.view === "status" ? [{ id: "m1", name: "Morning briefing", enabled: true, revision: 1, nextFire: iso(-540) }] : [],
    settings: s.ownerHandle ? { allowlistHandle: s.ownerHandle } : {},
    attention: null,
  };
}

function reply(scene: Scene, verb: string, id: string): unknown {
  const ok = (payload: unknown) => ({ type: "response", id, ok: true, payload });
  switch (verb) {
    case "status.get": return ok(statusPayload(scene));
    case "monitors.list": return ok({ monitors: scene.view === "status" ? [
      { id: "m1", name: "Morning briefing", trigger: { kind: "cron", expression: "0 9 * * *" }, instruction: "Brief me on today's calendar and unread mail.", eventTypes: ["cron.fire"], burstPolicy: "coalesce", tz: "Asia/Seoul", timeoutSec: 600, enabled: true, revision: 1, createdAt: iso(3000), updatedAt: iso(3000), lastFiredAt: iso(240) },
      { id: "m2", name: "Price watch: Tokyo flights", trigger: { kind: "cron", expression: "0 */6 * * *" }, instruction: "Tell me if the ICN→NRT fare for Oct 10 drops under 250k KRW.", eventTypes: ["cron.fire"], burstPolicy: "coalesce", tz: "Asia/Seoul", timeoutSec: 600, enabled: true, revision: 2, createdAt: iso(900), updatedAt: iso(900), lastFiredAt: iso(30), expiresAt: iso(-10080) },
    ] : [] });
    case "settings.get": return ok({
      ownerHandle: scene.ownerHandle ?? "", ownerName: scene.ownerName ?? "", mainSessionModel: "anthropic/claude-sonnet-4-5",
      mainTurnWatchdogSec: 300, childMaxConcurrent: 4, childConversationalTimeoutSec: 1800, childDaemonTimeoutSec: 2700,
      env: [{ key: "ANTHROPIC_API_KEY", set: scene.accounts > 0 }], soulVersion: "1", soulText: "You are Gajae.", configPath: "/Users/you/.openinstinct/config.json",
    });
    case "accounts.list": return ok({ accounts: scene.accounts > 0 ? [{ id: "anthropic:you", provider: "anthropic", kind: "oauth", identity: "you@example.com", health: "ok" }] : [] });
    case "models.list": return ok({ models: [{ id: "anthropic/claude-sonnet-4-5", provider: "anthropic", canonical: "claude-sonnet-4-5" }] });
    case "accounts.providers": return ok({ providers: [{ id: "anthropic", label: "Claude", popular: true }] });
    default: return { type: "error", id, ok: false, code: "verb_unknown", message: `mock does not implement ${verb}` };
  }
}

let current: Scene = SCENES[0]!;
const server = createServer((socket: Socket) => {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const frame = JSON.parse(line) as { type: string; id?: string; verb?: string };
      if (frame.type === "hello") { socket.write(`${JSON.stringify({ type: "negotiated", v: 1, capabilities: ["status.get", "monitors.list", "settings.get", "settings.set", "models.list", "accounts.list", "accounts.providers"] })}\n`); continue; }
      socket.write(`${JSON.stringify(reply(current, frame.verb ?? "", frame.id ?? ""))}\n`);
    }
  });
  socket.on("error", () => {});
});

function sh(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; let err = "";
    p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err || `${cmd} exited ${code}`))));
  });
}

/** Window id + bounds of the panel popover: the only OpenInstinctPanel window wider than 100pt. Layer-25 popovers are missing from optionOnScreenOnly, so list everything. */
async function popoverWindow(pid: number): Promise<{ id: number; x: number; y: number; w: number; h: number } | undefined> {
  const out = await sh("/usr/bin/swift", ["-e", `
import AppKit
let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
for w in list where (w[kCGWindowOwnerPID as String] as? Int) == ${pid} {
  if let b = w[kCGWindowBounds as String] as? [String: CGFloat], b["Width"]! > 100, (w[kCGWindowIsOnscreen as String] as? Bool) == true {
    print(w[kCGWindowNumber as String]!, b["X"]!, b["Y"]!, b["Width"]!, b["Height"]!)
  }
}`]);
  const line = out.trim().split("\n").find((l) => l.length > 0);
  if (!line) return undefined;
  const [id, x, y, w, h] = line.split(" ").map(Number);
  return { id: id!, x: x!, y: y!, w: w!, h: h! };
}

/** Toggles the popover by pressing the status item through accessibility (the item has no CGWindow of its own). */
async function pressStatusItem(pid: number): Promise<void> {
  await sh("/usr/bin/swift", ["-e", `
import AppKit
import ApplicationServices
let app = AXUIElementCreateApplication(pid_t(${pid}))
var extras: AnyObject?
AXUIElementCopyAttributeValue(app, "AXExtrasMenuBar" as CFString, &extras)
guard let bar = extras else { exit(1) }
var kids: AnyObject?
AXUIElementCopyAttributeValue(bar as! AXUIElement, kAXChildrenAttribute as CFString, &kids)
guard let item = (kids as? [AXUIElement])?.first else { exit(1) }
exit(AXUIElementPerformAction(item, kAXPressAction as CFString) == .success ? 0 : 1)`]);
}


const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const only = process.argv[2];
  if (!existsSync(panelBin)) throw new Error(`panel not built: ${panelBin} (run scripts/build-panel.sh)`);
  rmSync(socketPath, { force: true });
  await new Promise<void>((r) => server.listen(socketPath, r));
  mkdirSync(outDir, { recursive: true });

  const panel = spawn(panelBin, [], { env: { ...process.env, OI_CONTROL_SOCKET: socketPath }, stdio: "ignore" });
  try {
    await sleep(1500);
    for (const scene of SCENES) {
      if (only && scene.name !== only) continue;
      current = scene;
      // Fresh popover per scene: SetupView's @StateObject is created on show.
      let win = await popoverWindow(panel.pid!);
      if (win) { await pressStatusItem(panel.pid!); await sleep(400); }
      await pressStatusItem(panel.pid!);
      await sleep(1800);
      win = await popoverWindow(panel.pid!);
      if (!win) throw new Error(`popover did not open for ${scene.name}`);
      const out = join(outDir, `${scene.name}.png`);
      await sh("/usr/sbin/screencapture", ["-l", String(win.id), "-x", "-o", out]);
      console.log(out);
    }
  } finally {
    panel.kill();
    server.close();
    rmSync(socketPath, { force: true });
  }
}

await main();
