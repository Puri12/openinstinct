import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";

export type ControlPayload = Record<string, unknown>;

export interface ControlResponse {
  readonly id: string;
  readonly payload: ControlPayload;
}

/** Sends one protocol-v1 request through the private Unix control socket. */
export async function requestControl(
  socketPath: string,
  verb: string,
  payload: ControlPayload = {},
  timeoutMs = 5_000,
): Promise<ControlResponse> {
  const socket = createConnection({ path: socketPath });
  const requestId = randomUUID();
  try {
    await waitForConnect(socket, timeoutMs);
    const response = waitForResponse(socket, requestId, timeoutMs);
    socket.write(`${JSON.stringify({ type: "hello", v: 1, client: "openinstinct-operator-harness" })}\n`);
    socket.write(`${JSON.stringify({ type: "request", id: requestId, verb, payload })}\n`);
    return await response;
  } finally {
    socket.destroy();
  }
}

function waitForConnect(socket: Socket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`control socket connect timed out after ${timeoutMs}ms`)), timeoutMs);
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      socket.off("connect", connected);
      socket.off("error", failed);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const connected = (): void => finish();
    const failed = (error: Error): void => finish(error);
    socket.once("connect", connected);
    socket.once("error", failed);
  });
}

function waitForResponse(socket: Socket, requestId: string, timeoutMs: number): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => finish(new Error(`control request ${requestId} timed out after ${timeoutMs}ms`)), timeoutMs);
    const finish = (error?: Error, response?: ControlResponse): void => {
      clearTimeout(timer);
      socket.off("data", received);
      socket.off("error", failed);
      socket.off("close", closed);
      if (error) {
        reject(error);
      } else if (response) {
        resolve(response);
      }
    };
    const failed = (error: Error): void => finish(error);
    const closed = (): void => finish(new Error("control socket closed before response"));
    const received = (chunk: Buffer): void => {
      buffered += chunk.toString("utf8");
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline === -1) {
          return;
        }
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        let frame: unknown;
        try {
          frame = JSON.parse(line);
        } catch {
          finish(new Error("control socket returned malformed JSON"));
          return;
        }
        if (!isRecord(frame)) {
          finish(new Error("control socket returned a non-object frame"));
          return;
        }
        if (frame.type === "error" && (frame.id === requestId || frame.id === undefined)) {
          finish(new Error(`control ${String(frame.code)}: ${String(frame.message)}`));
          return;
        }
        if (frame.type === "response" && frame.id === requestId && frame.ok === true && isRecord(frame.payload)) {
          finish(undefined, { id: requestId, payload: frame.payload });
          return;
        }
      }
    };
    socket.on("data", received);
    socket.once("error", failed);
    socket.once("close", closed);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}
