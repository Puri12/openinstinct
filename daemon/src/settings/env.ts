import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

export function parseEnvFile(path: string): Map<string, string> {
  const env = new Map<string, string>();
  if (!existsSync(path)) {
    return env;
  }
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw.trim());
    if (match) {
      let value = match[2]!;
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      env.set(match[1]!, value);
    }
  }
  return env;
}

export function writeEnvFile(path: string, env: Map<string, string>): void {
  const lines = [...env.entries()].map(([k, v]) => `${k}=${v}`);
  writeFileSync(path, lines.length === 0 ? "" : `${lines.join("\n")}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
