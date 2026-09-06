import type { ChatHistoryResponse } from "../control/schema.ts";
import { toPlainText } from "../delivery/plaintext.ts";
import { FOLLOW_UP_PROMPT_PREFIX } from "../children/receipts.ts";
import { TRIAGE_PROMPT_PREFIX } from "../monitors/propagation.ts";
import { ORIENTATION_HEAD, ORIENTATION_SEPARATOR } from "../persona/orientation.ts";
import { PANEL_SOURCE_MARKER, type ChatMessage } from "./hub.ts";

/** Prefix used for operator-only turns that must not appear in owner chat history. */
export const OPERATOR_NOTE_PREFIX = "[Operator note from the OpenInstinct maintainer";

const IMAGE_READ = /\.(png|jpe?g|gif|webp|heic|heif)$/i;
const MAX_HISTORY_ITEMS = 50;

type ObjectLike = { readonly [key: string]: unknown };
type HistoryMessage = Omit<ChatMessage, "at"> & { readonly at?: string };
type UserResult =
  | { readonly kind: "internal" }
  | { readonly kind: "message"; readonly message: HistoryMessage }
  | { readonly kind: "skip" };

/** Removes the daemon's orientation preamble from an owner-facing prompt. */
export function stripOrientation(text: string): string {
  if (!text.startsWith(ORIENTATION_HEAD)) {
    return text;
  }
  const separator = text.indexOf(ORIENTATION_SEPARATOR);
  return separator < 0 ? text : text.slice(separator + ORIENTATION_SEPARATOR.length);
}

/** Removes only a trailing Chat-window routing marker and reports whether it matched. */
export function stripPanelMarker(text: string): { readonly text: string; readonly matched: boolean } {
  const candidate = text.trimEnd();
  if (!candidate.endsWith(PANEL_SOURCE_MARKER)) {
    return { text, matched: false };
  }
  return {
    text: candidate.slice(0, -PANEL_SOURCE_MARKER.length).trimEnd(),
    matched: true,
  };
}

/**
 * Reads the owner-facing subset of an omo engine transcript without mutating it.
 *
 * `MainAgentSession.messages` is intentionally typed as unknown because the omo engine
 * owns the concrete transcript shape. Every field access below is therefore
 * shape-checked and malformed rows are ignored rather than allowed to break the
 * control socket.
 */
export function readOwnerFacingHistory(
  messages: unknown,
  limit: number,
  boundary: number | undefined,
  now: () => Date,
): { messages: ChatMessage[] } {
  // Kept in the shared signature for callers that already provide a clock. A
  // missing timestamp is deliberately omitted, rather than replaced by now().
  void now;

  if (!Array.isArray(messages)) {
    return { messages: [] };
  }

  const maximum = historyLimit(limit);
  if (maximum === 0) {
    return { messages: [] };
  }

  const end = transcriptEnd(messages.length, boundary);
  const visible: HistoryMessage[] = [];
  let pendingAssistant: HistoryMessage[] = [];

  for (let index = end - 1; index >= 0; index -= 1) {
    const message = asObject(messages[index]);
    if (message === undefined) {
      continue;
    }

    const role = message.role;
    if (role === "assistant") {
      const bubbles = assistantMessages(message);
      if (bubbles.length > 0) {
        // We are walking backwards, so prepend this row's bubbles to retain
        // chronological order inside the pending suffix.
        pendingAssistant = [...bubbles, ...pendingAssistant];
      }
      continue;
    }

    if (role !== "user") {
      continue;
    }

    const owner = ownerMessage(message);
    if (owner.kind === "internal") {
      // Everything buffered since this internal user row is its assistant
      // reply, including any image bubbles emitted by tool calls.
      pendingAssistant = [];
      continue;
    }
    if (owner.kind === "skip") {
      // A malformed/empty user row contributes no owner bubble, but does not
      // make otherwise valid assistant rows disappear.
      continue;
    }

    visible.unshift(owner.message, ...pendingAssistant);
    pendingAssistant = [];
  }

  // A transcript can legitimately contain assistant-only rows (or malformed
  // user rows). Keep those bubbles rather than silently losing them.
  if (pendingAssistant.length > 0) {
    visible.unshift(...pendingAssistant);
  }

  return { messages: visible.slice(-maximum) as ChatMessage[] };
}

/** Appends durable owner replies and enforces the same item limit as transcript history. */
export function mergeOwnerHistory(
  messages: readonly ChatMessage[],
  durable: readonly ChatMessage[],
  limit: number,
): ChatMessage[] {
  const maximum = historyLimit(limit);
  if (maximum === 0) {
    return [];
  }
  const combined = [...messages, ...durable].map((message, index) => ({ message, index }));
  combined.sort((left, right) => {
    const leftAt = Date.parse(left.message.at);
    const rightAt = Date.parse(right.message.at);
    if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) {
      return leftAt - rightAt;
    }
    return left.index - right.index;
  });
  return combined.slice(-maximum).map(({ message }) => message);
}

/**
 * Fits a history payload beneath the caller's byte budget. Messages and tail
 * are both chronological; the oldest messages are removed before any tail
 * event, and each kind of removal sets its corresponding truncation flag.
 */
export function applyHistoryByteBudget(response: ChatHistoryResponse, maxBytes: number): ChatHistoryResponse {
  let messages = Array.isArray(response.messages) ? [...response.messages] : [];
  let tail = Array.isArray(response.tail) ? [...response.tail] : [];
  let truncated = response.truncated === true;
  let tailTruncated = response.tailTruncated === true;
  const budget = Number.isFinite(maxBytes) ? Math.max(0, maxBytes) : 0;

  const candidate = (): ChatHistoryResponse => ({
    messages,
    seq: response.seq,
    tail,
    ...(response.inFlight === undefined ? {} : { inFlight: response.inFlight }),
    ...(truncated ? { truncated: true } : {}),
    ...(tailTruncated ? { tailTruncated: true } : {}),
  });
  const fits = (): boolean => encodedBytes(candidate()) <= budget;

  while (!fits() && messages.length > 0) {
    messages = messages.slice(1);
    truncated = true;
  }
  while (!fits() && tail.length > 0) {
    tail = tail.slice(1);
    tailTruncated = true;
  }

  return candidate();
}

function ownerMessage(message: ObjectLike): UserResult {
  const parts = userTextParts(message.content);
  if (parts.length === 0) {
    return { kind: "skip" };
  }

  const rawText = parts.join("\n");
  const oriented = stripOrientation(rawText);
  const marked = stripPanelMarker(oriented);
  const internal = marked.text.startsWith(OPERATOR_NOTE_PREFIX)
    || marked.text.startsWith(FOLLOW_UP_PROMPT_PREFIX)
    || marked.text.startsWith(TRIAGE_PROMPT_PREFIX)
    // Pre-release transcripts carried an earlier receipt-prompt wording.
    || marked.text.startsWith("Background task finished. Internal main-session turn");
  if (internal) {
    return { kind: "internal" };
  }

  const text = toPlainText(marked.text);
  if (text.length === 0) {
    return { kind: "skip" };
  }

  return {
    kind: "message",
    message: withTimestamp({ role: "owner", source: marked.matched ? "panel" : "imessage", text }, message),
  };
}

function assistantMessages(message: ObjectLike): HistoryMessage[] {
  const content = message.content;
  const blocks: unknown[] = Array.isArray(content) ? content : [];
  const result: HistoryMessage[] = [];

  for (const block of blocks) {
    const object = asObject(block);
    if (object === undefined) {
      continue;
    }
    if (object.type === "text" && typeof object.text === "string") {
      const text = toPlainText(object.text);
      if (text.length > 0) {
        result.push(withTimestamp({ role: "assistant", text }, message));
      }
      continue;
    }
    if (object.type !== "toolCall" || typeof object.name !== "string") {
      continue;
    }

    if (object.name === "read") {
      const path = imageReadPath(object);
      if (path !== undefined) {
        result.push(withTimestamp({
          role: "assistant",
          image: { path, caption: toPlainText(`(looking at ${imageName(path)})`) },
        }, message));
      }
      continue;
    }

    if (object.name === "send_image") {
      const args = toolArguments(object);
      const path = args?.filePath;
      const caption = args?.caption;
      if (typeof path === "string" && path.length > 0 && typeof caption === "string") {
        result.push(withTimestamp({
          role: "assistant",
          image: { path, caption: toPlainText(caption) },
        }, message));
      }
    }
  }

  return result;
}

function userTextParts(content: unknown): string[] {
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const parts: string[] = [];
  for (const block of content) {
    const object = asObject(block);
    if (object === undefined) {
      continue;
    }
    if (object.type === "text" && typeof object.text === "string") {
      parts.push(object.text);
    } else if (object.type === "image") {
      parts.push("(photo)");
    }
  }
  return parts;
}

/** `read` tool call whose target is an image, matching MainSession's event path. */
function imageReadPath(block: ObjectLike): string | undefined {
  const args = toolArguments(block);
  const path = args?.path;
  if (typeof path !== "string") {
    return undefined;
  }
  const imagePath = path.split(":")[0] ?? "";
  return IMAGE_READ.test(imagePath) ? imagePath : undefined;
}

function toolArguments(block: ObjectLike): ObjectLike | undefined {
  const argumentsValue = block.arguments ?? block.args;
  return asObject(argumentsValue);
}

function imageName(path: string): string {
  const name = path.split("/").pop();
  return name && name.length > 0 ? name : path;
}

function withTimestamp(base: Omit<HistoryMessage, "at">, message: ObjectLike): HistoryMessage {
  const timestamp = message.timestamp;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return base;
  }
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    return base;
  }
  return { ...base, at: date.toISOString() };
}

function transcriptEnd(length: number, boundary: number | undefined): number {
  if (typeof boundary !== "number" || !Number.isFinite(boundary) || boundary < 0) {
    return length;
  }
  return Math.min(length, Math.max(0, Math.ceil(boundary)));
}

function historyLimit(limit: number): number {
  if (typeof limit !== "number" || Number.isNaN(limit)) {
    return 0;
  }
  if (limit === Number.POSITIVE_INFINITY) {
    return MAX_HISTORY_ITEMS;
  }
  return Math.min(MAX_HISTORY_ITEMS, Math.max(0, Math.floor(limit)));
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function asObject(value: unknown): ObjectLike | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ObjectLike
    : undefined;
}
