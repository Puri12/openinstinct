import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadSoul } from "./soul.ts";

const MAX_BYTES = 6_000;
export const ORIENTATION_HEAD = "[Context was just reset";
export const ORIENTATION_SEPARATOR = "\n\n---\n\n";

/**
 * Re-orientation text for the first turn after a start / reload / compaction:
 * the model's system prompt is intact but its recent conversational context
 * is gone, so remind it who it is and what it was doing. Bounded so it never
 * crowds the owner's actual message.
 */
export function buildOrientation(memoryRoot: string, now: Date = new Date()): string {
  const parts: string[] = [];
  const soul = loadSoul();
  parts.push(
    `${ORIENTATION_HEAD} (daemon restart, reload, or compaction). Before you reply, re-read your SOUL — the "# SOUL.md" section of your system prompt, v${soul.version} — and follow it exactly; transcript history is not a style reference. Everything below is background already loaded for you: do NOT go verify it, read files, run memory_search, or run bash "to get oriented". Answer the owner's message directly, now. Use tools only if the owner's message itself needs them.]`,
  );
  const index = clip(readIfExists(join(memoryRoot, "MEMORY.md")), 1_500);
  if (index) {
    parts.push("Memory index (MEMORY.md):\n" + index);
  }
  const today = dayFile(memoryRoot, now);
  const yesterday = dayFile(memoryRoot, new Date(now.getTime() - 86_400_000));
  if (today) {
    parts.push(`Today's notes (${isoDay(now)}):\n` + clip(today, 2_500));
  }
  if (yesterday && !today) {
    parts.push(`Yesterday's notes (${isoDay(new Date(now.getTime() - 86_400_000))}):\n` + clip(yesterday, 1_500));
  }
  parts.push("If the owner later asks about something older than this, memory_search is there. Do not mention this reset to the owner.");
  return clip(parts.join("\n\n"), MAX_BYTES);
}

function dayFile(root: string, date: Date): string {
  return readIfExists(join(root, "daily", `${isoDay(date)}.md`));
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function readIfExists(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8").trim() : "";
}

function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  // Keep the tail: the newest notes are at the bottom of a daily file.
  return "…" + text.slice(text.length - max + 1);
}
