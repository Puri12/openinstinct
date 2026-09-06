// Real-surface harness for openinstinct on omo: boots the daemon under a temp HOME whose
// ~/.openinstinct/omo holds a copy of the host omo credentials, then drives the control socket.
// Usage: OI_SMOKE_MODEL=anthropic/claude-sonnet-4-5 bun scripts/smoke/omo-chat-roundtrip.ts
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const model = process.env.OI_SMOKE_MODEL ?? "anthropic/claude-sonnet-4-5";
const token = process.env.OI_SMOKE_TOKEN ?? "OI_OMO_OK";
const home = mkdtempSync(join(tmpdir(), "oi-omo-smoke-home-"));
const root = join(home, ".openinstinct");
const omo = join(root, "omo");
mkdirSync(omo, { recursive: true, mode: 0o700 });
const hostAgent = process.env.OI_SMOKE_SOURCE_AGENT_DIR ?? join(homedir(), ".omo", "agent");
for (const f of ["auth.json", "models.json"]) {
  const src = join(hostAgent, f);
  if (existsSync(src)) copyFileSync(src, join(omo, f));
}
writeFileSync(join(root, "config.json"), JSON.stringify({ ownerName: "smoke", mainSessionModel: model, heartbeatMinutes: 0 }, null, 2));
const evidenceDir = process.env.OI_SMOKE_EVIDENCE ?? join(home, "evidence");
mkdirSync(evidenceDir, { recursive: true });
const frames: string[] = [];
const record = (line: string) => { frames.push(line); };

const daemon = spawn(process.execPath, ["daemon/src/main.ts"], {
  cwd: process.cwd(),
  env: { ...process.env, HOME: home, SENPI_CODING_AGENT_DIR: omo, OMO_CODING_AGENT_DIR: omo, PI_CODING_AGENT_DIR: omo, OI_SMOKE: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let daemonOut = "";
daemon.stdout.on("data", (d) => { daemonOut += d.toString(); });
daemon.stderr.on("data", (d) => { daemonOut += d.toString(); });

const socketPath = join(root, "run", "control.sock");
const deadline = Date.now() + 90_000;
while (!existsSync(socketPath) && Date.now() < deadline) await Bun.sleep(500);
if (!existsSync(socketPath)) { finish(1, "control socket never appeared"); }

function request(verb: string, payload: Record<string, unknown>, opts: { subscribe?: boolean; waitFor?: (frame: any) => boolean; timeoutMs?: number } = {}): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ path: socketPath });
    const seen: any[] = [];
    let buf = "";
    const timer = setTimeout(() => { sock.destroy(); resolve(seen); }, opts.timeoutMs ?? 10_000);
    sock.on("connect", () => {
      sock.write(JSON.stringify({ type: "hello", v: 1, client: "oi-omo-smoke" }) + "\n");
      if (opts.subscribe) sock.write(JSON.stringify({ type: "request", id: "sub", verb: "chat.subscribe", payload: {} }) + "\n");
      sock.write(JSON.stringify({ type: "request", id: verb, verb, payload }) + "\n");
    });
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        record(line);
        try { const f = JSON.parse(line); seen.push(f); if (opts.waitFor && opts.waitFor(f)) { clearTimeout(timer); sock.destroy(); resolve(seen); } } catch {}
      }
    });
    sock.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

let bootstrap: any = null;
for (let i = 0; i < 60; i++) {
  const frames = await request("status.get", {}, { waitFor: (f) => f.type === "response" && f.id === "status.get" });
  const resp = frames.find((f) => f.type === "response" && f.id === "status.get");
  bootstrap = resp?.payload;
  // The core lane (main session) starts after the credentials probe passes; a chat.send
  // before that is dropped with owner_turn_skipped_no_active_lane, so wait for both.
  if (bootstrap?.bootstrap?.state === "running" && bootstrap?.session?.state === "active") break;
  await Bun.sleep(2_000);
}
const prompt = "Reply with exactly " + token + " and no other text.";
const chat = await request("chat.send", { text: prompt }, {
  subscribe: true,
  timeoutMs: 180_000,
  waitFor: (f) => f.type === "event" && f.topic === "chat.message" && f.payload?.role === "assistant" && String(f.payload?.text ?? "").includes(token) && (f.payload?.final === true || true),
});
const assistant = chat.filter((f) => f.type === "event" && f.topic === "chat.message" && f.payload?.role === "assistant").map((f) => f.payload?.text);
const ok = assistant.some((t) => String(t ?? "").includes(token));
const history = await request("chat.history", { limit: 10 }, { waitFor: (f) => f.type === "response" && f.id === "chat.history" });
writeFileSync(join(evidenceDir, "frames.ndjson"), frames.join("\n") + "\n");
writeFileSync(join(evidenceDir, "summary.json"), JSON.stringify({ ok, model, token, home, bootstrap: bootstrap?.bootstrap, assistant, socketPath, daemonLog: join(root, "logs", "daemon.ndjson") }, null, 2));
finish(ok ? 0 : 2, ok ? "PASS: assistant replied with " + token : "FAIL: no assistant reply containing " + token + "; replies=" + JSON.stringify(assistant));

function finish(code: number, message: string): never {
  console.log(message);
  console.log("evidence: " + evidenceDir + "  home: " + home);
  try { daemon.kill("SIGTERM"); } catch {}
  setTimeout(() => { try { daemon.kill("SIGKILL"); } catch {} ; process.exit(code); }, 3_000);
  throw new Error("exiting");
}
