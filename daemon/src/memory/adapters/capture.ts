import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { captureRoot, regenerateMap } from "../vendor/doctrine.ts";
import { loadRegistry } from "../vendor/registry.ts";

export interface DailyCaptureWrite {
  readonly originRefJson: string;
  readonly userText: string;
  readonly replyText: string;
  readonly now: Date;
}

/**
 * Clock-injected equivalent of the vendored appendDaily path. The adapter owns
 * the clock because UTC capture boundaries are part of the daemon contract;
 * the vendored doctrine remains an untouched pure port.
 */
export async function writeDailyCapture(root: string, input: DailyCaptureWrite): Promise<string> {
  if (Number.isNaN(input.now.getTime())) {
    throw new Error("daily capture clock is invalid");
  }
  const registry = await loadRegistry(root);
  const date = input.now.toISOString().slice(0, 10);
  const path = join(root, await captureRoot(root, registry), `${date}.md`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const bounded = (text: string): string => text
    .slice(0, 500)
    .replaceAll("\u0000", "")
    .replaceAll(/\r\n|\r|\n/g, "\\n");
  const entry = `\n## ${input.now.toISOString()}\n\n- origin: ${bounded(input.originRefJson)}\n- user: ${bounded(input.userText)}\n- reply: ${bounded(input.replyText)}\n`;
  await appendFile(path, entry, "utf8");
  await regenerateMap(root, registry);
  return relative(root, path).replaceAll("\\", "/");
}
