import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The OmO soul is a versioned Markdown file appended to the inherited omo
 * system prompt on every omo engine session creation. It is read from disk (not
 * imported) so an edit followed by `session.reload` takes effect without a
 * daemon restart; the version comment lets the panel/status show what is live.
 */
export interface Soul {
  readonly version: string;
  readonly text: string;
}

export const SOUL_PATH = join(import.meta.dir, "OMO_SOUL.md");

export function loadSoul(path: string = SOUL_PATH, vars: { readonly ownerName?: string } = {}): Soul {
  const raw = readFileSync(path, "utf8");
  const version = /<!--\s*soul-version:\s*([^\s]+)\s*-->/.exec(raw)?.[1] ?? "unversioned";
  const owner = vars.ownerName && vars.ownerName.length > 0 ? vars.ownerName : "the owner";
  const text = raw.replace(/<!--[\s\S]*?-->\s*/, "").replace(/\{\{ownerName\}\}/g, owner).trim();
  return { version, text };
}

export const RUNTIME_PATH = join(import.meta.dir, "RUNTIME.md");

/**
 * Owner-editable runtime block appended after the soul. `{{ownerHandle}}` and
 * `{{ownerName}}` are substituted from config; `{{imessageState}}` reflects
 * whether the optional iMessage lane is connected. Nothing about a specific
 * owner lives in source.
 */
export function loadRuntimeBlock(vars: {
  readonly ownerHandle?: string;
  readonly imessage: "attached" | "detached";
  readonly ownerName: string;
  readonly chromeProfile: string;
}, path: string = RUNTIME_PATH): Soul {
  const raw = readFileSync(path, "utf8");
  const version = /<!--\s*runtime-version:\s*([^\s]+)\s*-->/.exec(raw)?.[1] ?? "unversioned";
  const ownerHandle = vars.ownerHandle ?? "(no iMessage number configured)";
  const imessageState = vars.imessage === "attached" ? "connected" : "not connected right now";
  const text = raw
    .replace(/<!--[\s\S]*?-->\s*/, "")
    .replace(/\{\{ownerHandle\}\}/g, ownerHandle)
    .replace(/\{\{ownerName\}\}/g, vars.ownerName.length === 0 ? "the owner" : vars.ownerName)
    .replace(/\{\{imessageState\}\}/g, imessageState)
    .replace(/\{\{chromeProfile\}\}/g, vars.chromeProfile)
    .trim();
  return { version, text };
}
