import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { loadRegistry } from "../vendor/registry.ts";
import { captureRoot } from "../vendor/doctrine.ts";
import type { MemoryClosureQueue } from "./intents.ts";

/**
 * Owner prompts the daemon injects itself. They are machine text, not the
 * owner talking, and canonicalizing them teaches the corpus nothing.
 */
const INJECTED_PREFIXES = [
  "Monitor \"",
  "A background task has completed",
  "[Operator note",
  "[Context was just reset",
  "[Compacted history content evicted",
  "[the owner sent an image",
] as const;

const MAX_TURNS_PER_RUN = 400;

export interface SessionBackfillResult {
  readonly scanned: number;
  readonly captured: number;
  readonly skippedInjected: number;
  readonly skippedAlreadyPresent: number;
}

interface TranscriptTurn {
  readonly at: string;
  readonly userText: string;
  readonly replyText: string;
}

/**
 * Replays owner exchanges out of a session transcript into the daily capture
 * axis, dated when they actually happened.
 *
 * This lives in the daemon rather than in a child prompt on purpose: session
 * transcripts are megabytes of self-referential JSONL, they are blocked for
 * agent sessions by the tool-call path guard, and one child that read its own
 * transcript already blew the output cap. The daemon parses them cheaply and
 * hands the model only canonicalization-sized capture entries.
 */
export async function backfillCapturesFromTranscript(
  transcriptPath: string,
  closure: MemoryClosureQueue,
): Promise<SessionBackfillResult> {
  await closure.initialize();
  const root = closure.corpusRoot;
  const turns = parseTranscript(await readFile(transcriptPath, "utf8"));
  const existing = await existingCaptureText(root, turns);

  let captured = 0;
  let skippedInjected = 0;
  let skippedAlreadyPresent = 0;
  for (const turn of turns) {
    if (INJECTED_PREFIXES.some((prefix) => turn.userText.startsWith(prefix))) {
      skippedInjected += 1;
      continue;
    }
    // The live capture path keys on the iMessage GUID, which the transcript
    // does not carry, so a replay cannot reuse that key. Match on the recorded
    // text of the day instead: that is what makes re-running this safe.
    const day = turn.at.slice(0, 10);
    if (existing.get(day)?.includes(digestForMatch(turn.userText)) === true) {
      skippedAlreadyPresent += 1;
      continue;
    }
    if (captured >= MAX_TURNS_PER_RUN) {
      break;
    }
    closure.enqueueCapture({
      origin: { kind: "owner-chat", reference: `session-backfill:${turn.at}` },
      userText: turn.userText,
      replyText: turn.replyText,
      occurredAt: turn.at,
      idempotencyKey: `memory:session-backfill:${createHash("sha256").update(`${turn.at}\u0000${turn.userText}`).digest("hex").slice(0, 32)}`,
    });
    captured += 1;
  }
  await closure.drain();
  return { scanned: turns.length, captured, skippedInjected, skippedAlreadyPresent };
}

/** Pairs each owner message with the assistant text that followed it. */
function parseTranscript(raw: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let pending: { at: string; userText: string; replies: string[] } | undefined;
  const flush = (): void => {
    if (pending && pending.userText.length > 0) {
      turns.push({ at: pending.at, userText: pending.userText, replyText: pending.replies.join("\n\n") });
    }
    pending = undefined;
  };
  for (const line of raw.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    let entry: { readonly timestamp?: unknown; readonly message?: unknown };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    const message = entry.message;
    if (message === null || typeof message !== "object") {
      continue;
    }
    const role = (message as { readonly role?: unknown }).role;
    const text = textOf((message as { readonly content?: unknown }).content);
    const at = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
    if (role === "user" && at !== undefined) {
      flush();
      pending = { at, userText: text.trim(), replies: [] };
      continue;
    }
    if (role === "assistant" && pending && text.trim().length > 0) {
      pending.replies.push(text.trim());
    }
  }
  flush();
  return turns;
}

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((part): part is { readonly type: string; readonly text: string } =>
      part !== null && typeof part === "object"
      && (part as { readonly type?: unknown }).type === "text"
      && typeof (part as { readonly text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("\n");
}

/** Daily capture files for the days the transcript touches, read once. */
async function existingCaptureText(root: string, turns: readonly TranscriptTurn[]): Promise<Map<string, string>> {
  const registry = await loadRegistry(root);
  const axis = await captureRoot(root, registry);
  const days = new Set(turns.map((turn) => turn.at.slice(0, 10)));
  const contents = new Map<string, string>();
  for (const day of days) {
    try {
      contents.set(day, await readFile(join(root, axis, `${day}.md`), "utf8"));
    } catch {
      contents.set(day, "");
    }
  }
  return contents;
}

/**
 * Capture entries store a 500-character single-line excerpt, so a replay has
 * to compare against the same shape to recognize its own earlier writes.
 */
function digestForMatch(text: string): string {
  return text.slice(0, 500).replaceAll("\u0000", "").replaceAll(/\r\n|\r|\n/g, "\\n").slice(0, 120);
}
