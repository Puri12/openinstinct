#!/usr/bin/env bun
/**
 * One-shot control-socket client for operators and tests.
 *
 *   bun scripts/control.ts status.get
 *   bun scripts/control.ts accounts.adopt '{"id":"anthropic:claude-code-keychain"}'
 *
 * `nc -U` cannot be used for this: it closes the read side before a multi-KiB
 * response frame arrives, which makes a working verb look like a hang.
 */
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const verb = process.argv[2];
if (!verb) {
  console.error("usage: bun scripts/control.ts <verb> [payload-json]");
  process.exit(2);
}
const payload: unknown = process.argv[3] === undefined ? {} : JSON.parse(process.argv[3]);
const socketPath = process.env.OI_CONTROL_SOCKET ?? join(homedir(), ".openinstinct", "run", "control.sock");
const timeoutMs = Number(process.env.OI_CONTROL_TIMEOUT_MS ?? 30_000);

const socket = connect(socketPath);
let buffer = "";
let done = false;

const finish = (code: number): never => {
  done = true;
  socket.destroy();
  process.exit(code);
};

const timer = setTimeout(() => {
  if (!done) {
    console.error(`no response for ${verb} within ${timeoutMs}ms`);
    finish(1);
  }
}, timeoutMs);

socket.on("connect", () => {
  socket.write(`${JSON.stringify({ type: "hello", v: 1, client: "oi-control" })}\n`);
});

socket.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim().length === 0) { continue; }
    const frame = JSON.parse(line) as { type: string };
    if (frame.type === "negotiated") {
      socket.write(`${JSON.stringify({ type: "request", id: "cli", verb, payload })}\n`);
      continue;
    }
    clearTimeout(timer);
    console.log(JSON.stringify(frame, null, 2));
    finish(frame.type === "error" ? 1 : 0);
  }
});

socket.on("error", (error) => {
  console.error(`control socket: ${error.message}`);
  finish(1);
});
