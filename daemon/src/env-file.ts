import { existsSync, readFileSync, statSync } from "node:fs";

export interface EnvFileResult {
  readonly loaded: readonly string[];
  /** Keys that were already set in the process and were replaced by the file. */
  readonly overridden: readonly string[];
}

/**
 * Loads `KEY=value` lines from a private env file into `process.env`. The daemon
 * runs under launchd with no login shell, so provider API keys the owner keeps
 * in `.zshrc` never reach it; this file is the durable, mode-0600 equivalent.
 * The file is authoritative: the owner wrote it deliberately, whereas anything
 * already in process.env came from launchd defaults or an omo engine auto-import.
 */
export function loadEnvFile(path: string): EnvFileResult {
  if (!existsSync(path)) {
    return { loaded: [], overridden: [] };
  }
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`${path} must not be group/world accessible (mode ${mode.toString(8)}); chmod 600 it`);
  }
  const loaded: string[] = [];
  const overridden: string[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) {
      throw new Error(`${path}: unparseable line: ${line.slice(0, 40)}`);
    }
    const key = match[1]!;
    let value = match[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] !== undefined) {
      overridden.push(key);
    } else {
      loaded.push(key);
    }
    process.env[key] = value;
  }
  return { loaded, overridden };
}
