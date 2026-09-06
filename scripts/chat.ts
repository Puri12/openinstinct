// Talk to the running daemon from a terminal: one message per invocation, or a
// REPL when no argument is given. Uses the same control socket as the panel.
//   bun scripts/chat.ts "안녕"          # one turn, prints the streamed reply
//   bun scripts/chat.ts                 # REPL; empty line or Ctrl-D exits
//   bun scripts/chat.ts --status        # status.get payload
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const socketPath = process.env.OI_CONTROL_SOCKET ?? join(homedir(), ".openinstinct", "run", "control.sock");

interface Frame { readonly type: string; readonly id?: string; readonly topic?: string; readonly ok?: boolean; readonly payload?: Record<string, unknown>; readonly error?: unknown }

function open(): Promise<{ send: (frame: unknown) => void; frames: AsyncIterable<Frame>; close: () => void }> {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ path: socketPath });
    let buffer = "";
    const queue: Frame[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    sock.on("data", (chunk) => {
      buffer += chunk.toString();
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        try { queue.push(JSON.parse(line) as Frame); } catch { /* not a frame */ }
      }
      wake?.();
    });
    sock.on("close", () => { closed = true; wake?.(); });
    sock.on("error", (error) => { if (!closed) reject(error); closed = true; wake?.(); });
    sock.on("connect", () => {
      sock.write(JSON.stringify({ type: "hello", v: 1, client: "openinstinct-chat-cli" }) + "\n");
      resolve({
        send: (frame) => { sock.write(JSON.stringify(frame) + "\n"); },
        close: () => { sock.destroy(); },
        frames: (async function* () {
          while (true) {
            if (queue.length > 0) { yield queue.shift()!; continue; }
            if (closed) return;
            await new Promise<void>((r) => { wake = r; });
            wake = undefined;
          }
        })(),
      });
    });
  });
}

async function status(): Promise<void> {
  const conn = await open();
  conn.send({ type: "request", id: "status", verb: "status.get", payload: {} });
  for await (const frame of conn.frames) {
    if (frame.type === "response" && frame.id === "status") {
      console.log(JSON.stringify(frame.payload, null, 2));
      break;
    }
  }
  conn.close();
}

async function turn(text: string): Promise<void> {
  const conn = await open();
  conn.send({ type: "request", id: "sub", verb: "chat.subscribe", payload: {} });
  conn.send({ type: "request", id: "send", verb: "chat.send", payload: { text } });
  let turnId: string | undefined;
  let segments = 0;
  const timer = setTimeout(() => { console.error("\n[timed out waiting for the reply]"); conn.close(); process.exit(2); }, 300_000);
  for await (const frame of conn.frames) {
    if (frame.type === "response" && frame.id === "send") {
      if (frame.ok === false) { console.error("chat.send failed:", JSON.stringify(frame.error ?? frame.payload)); break; }
      turnId = String(frame.payload?.turnId ?? "");
      continue;
    }
    if (frame.type !== "event") continue;
    const payload = frame.payload as { role?: string; text?: string; turnId?: string; typing?: boolean; image?: { path: string; caption?: string } } | undefined;
    if (!payload || (turnId && payload.turnId && payload.turnId !== turnId)) continue;
    if (frame.topic === "chat.message" && payload.role === "assistant") {
      // Each event is one streamed segment (a sentence or a paragraph); the
      // turn is over when the daemon clears the typing indicator.
      if (payload.image) process.stdout.write(`${segments > 0 ? "\n" : ""}[image] ${payload.image.path} ${payload.image.caption ?? ""}`);
      else process.stdout.write(`${segments > 0 ? "\n" : ""}${payload.text ?? ""}`);
      segments += 1;
      continue;
    }
    if (frame.topic === "chat.presence" && payload.typing === false) {
      process.stdout.write("\n");
      break;
    }
  }
  clearTimeout(timer);
  conn.close();
}

const args = process.argv.slice(2);
if (args[0] === "--status") {
  await status();
} else if (args.length > 0) {
  await turn(args.join(" "));
} else {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (): void => {
    rl.question("you> ", async (line) => {
      const text = line.trim();
      if (text.length === 0) { rl.close(); return; }
      process.stdout.write("omo> ");
      await turn(text);
      ask();
    });
  };
  ask();
}
