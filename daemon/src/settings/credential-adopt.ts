/**
 * Discovery and adoption of credentials the owner already has on this machine.
 *
 * Sources are read best-effort from the host home directory (omo's own agent
 * auth file, the Codex CLI, Claude Code). Nothing here ever returns a raw
 * secret to a caller that renders it: summaries carry a redacted token only.
 * Adoption merges the opaque credential payload into the daemon's own
 * `auth.json` (the engine's AuthStorage file format, mode 0600).
 */
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const EXPIRED_OAUTH_REASON = "This login has expired. Sign in to that tool again, or sign in here separately.";
/** Codex stores no expiry for some tokens; assume the usual one-hour access-token life. */
const OAUTH_FALLBACK_LIFETIME_MS = 3_600_000;

/** Human labels for provider ids; unknown providers fall back to the id itself. */
export const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Claude (Anthropic)",
  "claude-sdk-oauth": "Claude Code (Anthropic)",
  "openai-codex": "Codex (ChatGPT)",
  openai: "OpenAI",
  xai: "xAI",
  cursor: "Cursor",
  "cursor-cli-oauth": "Cursor CLI",
  "github-copilot": "GitHub Copilot",
  openrouter: "OpenRouter",
  "kimi-coding": "Kimi",
};

/** A credential found on this machine, with the opaque payload ready to store. */
export interface ImportableCredential {
  readonly provider: string;
  readonly origin: string;
  /** Redacted, human-readable description of where this came from. */
  readonly source: string;
  readonly kind: "oauth" | "api_key";
  /** Opaque payload. Never include this in any summary sent to a client. */
  readonly credential:
    | { readonly type: "oauth"; readonly access: string; readonly refresh: string; readonly expires: number; readonly [key: string]: unknown }
    | { readonly type: "api_key"; readonly key: string };
  readonly identity?: { readonly email?: string; readonly accountId?: string };
  /** Epoch-ms expiry for OAuth credentials, when known. */
  readonly expiresAt?: number;
}

export interface DiscoveredCredential {
  readonly id: string;
  readonly provider: string;
  readonly label: string;
  readonly source: string;
  readonly kind: string;
  readonly redactedToken: string;
  readonly identity?: string;
  readonly expiresAt?: string;
  readonly adoptable: boolean;
  readonly reason?: string;
}

export type CredentialDiscoverer = () => Promise<readonly ImportableCredential[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Epoch-ms expiry field; every source writes it as a number. */
function expiryField(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === "number" ? value : undefined;
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    // Discovery is best-effort: an absent, unreadable, or malformed source is simply not offered.
    return undefined;
  }
}

/** Parse one entry of an engine `auth.json` map into a storable payload. */
function parseAuthEntry(value: unknown): ImportableCredential["credential"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  switch (value["type"]) {
    case "oauth": {
      const access = stringField(value, "access");
      const refresh = stringField(value, "refresh");
      const expires = expiryField(value, "expires");
      if (access === undefined || refresh === undefined || expires === undefined) {
        return undefined;
      }
      return { ...value, type: "oauth", access, refresh, expires };
    }
    case "api_key": {
      const key = stringField(value, "key");
      return key === undefined ? undefined : { type: "api_key", key };
    }
    default:
      return undefined;
  }
}

function readOmoCredentials(home: string): readonly ImportableCredential[] {
  const file = readJsonObject(join(home, ".omo", "agent", "auth.json"));
  if (file === undefined) {
    return [];
  }
  const found: ImportableCredential[] = [];
  for (const [provider, value] of Object.entries(file)) {
    const credential = parseAuthEntry(value);
    if (credential === undefined) {
      continue;
    }
    found.push({
      provider,
      origin: "omo-auth-json",
      source: "omo (~/.omo/agent/auth.json)",
      kind: credential.type,
      credential,
      ...(credential.type === "oauth" ? { expiresAt: credential.expires } : {}),
    });
  }
  return found;
}

function readCodexCredential(home: string): ImportableCredential | undefined {
  const file = readJsonObject(join(home, ".codex", "auth.json"));
  if (file === undefined) {
    return undefined;
  }
  const source = "Codex CLI (~/.codex/auth.json)";
  const tokens = isRecord(file["tokens"]) ? file["tokens"] : undefined;
  const access = tokens === undefined ? undefined : stringField(tokens, "access_token");
  const refresh = tokens === undefined ? undefined : stringField(tokens, "refresh_token");
  if (tokens !== undefined && access !== undefined && refresh !== undefined) {
    const accountId = stringField(tokens, "account_id");
    const expires = expiryField(tokens, "expires_at") ?? Date.now() + OAUTH_FALLBACK_LIFETIME_MS;
    return {
      provider: "openai-codex",
      origin: "codex-file",
      source,
      kind: "oauth",
      credential: { type: "oauth", access, refresh, expires, ...(accountId === undefined ? {} : { accountId }) },
      ...(accountId === undefined ? {} : { identity: { accountId } }),
      expiresAt: expires,
    };
  }
  const key = stringField(file, "OPENAI_API_KEY");
  if (key === undefined) {
    return undefined;
  }
  return { provider: "openai", origin: "codex-file", source, kind: "api_key", credential: { type: "api_key", key } };
}

function readClaudeCredential(home: string): ImportableCredential | undefined {
  const file = readJsonObject(join(home, ".claude", ".credentials.json"));
  const oauth = file !== undefined && isRecord(file["claudeAiOauth"]) ? file["claudeAiOauth"] : undefined;
  if (oauth === undefined) {
    return undefined;
  }
  const access = stringField(oauth, "accessToken");
  const refresh = stringField(oauth, "refreshToken");
  const expires = expiryField(oauth, "expiresAt");
  if (access === undefined || refresh === undefined || expires === undefined) {
    return undefined;
  }
  return {
    provider: "anthropic",
    origin: "claude-code-file",
    source: "Claude Code (~/.claude/.credentials.json)",
    kind: "oauth",
    credential: { type: "oauth", access, refresh, expires },
    expiresAt: expires,
  };
}

/** Read every credential source in the given home directory, skipping what cannot be parsed. */
export async function discoverLocalCredentials(home = process.env.HOME ?? homedir()): Promise<readonly ImportableCredential[]> {
  const single = [readCodexCredential(home), readClaudeCredential(home)];
  return [...readOmoCredentials(home), ...single.filter((candidate): candidate is ImportableCredential => candidate !== undefined)];
}

function credentialId(credential: ImportableCredential): string {
  return `${credential.provider}:${credential.origin}`;
}

function secretOf(credential: ImportableCredential["credential"]): string {
  switch (credential.type) {
    case "oauth":
      return credential.access;
    case "api_key":
      return credential.key;
  }
}

function redactSecret(secret: string): string {
  return secret.length <= 10 ? "…" : `${secret.slice(0, 6)}…${secret.slice(-4)}`;
}

export function toDiscovered(credential: ImportableCredential): DiscoveredCredential {
  const adoptable = credential.kind === "api_key" || credential.expiresAt === undefined || credential.expiresAt > Date.now();
  const identity = credential.identity?.email ?? credential.identity?.accountId;
  return {
    id: credentialId(credential),
    provider: credential.provider,
    label: PROVIDER_LABELS[credential.provider] ?? credential.provider,
    source: credential.source,
    kind: credential.kind,
    redactedToken: redactSecret(secretOf(credential.credential)),
    ...(identity === undefined ? {} : { identity }),
    ...(credential.expiresAt === undefined ? {} : { expiresAt: new Date(credential.expiresAt).toISOString() }),
    adoptable,
    ...(adoptable ? {} : { reason: EXPIRED_OAUTH_REASON }),
  };
}

export async function discoverCredentials(
  discover: CredentialDiscoverer = discoverLocalCredentials,
): Promise<readonly DiscoveredCredential[]> {
  const credentials = await discover();
  return credentials
    .map(toDiscovered)
    .sort((left, right) => Number(right.adoptable) - Number(left.adoptable) || left.label.localeCompare(right.label));
}

/** Merge one credential into the engine auth map, publishing it atomically at mode 0600. */
function writeAuthEntry(authPath: string, provider: string, credential: ImportableCredential["credential"]): void {
  mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
  const merged = { ...(readJsonObject(authPath) ?? {}), [provider]: credential };
  const temporary = `${authPath}.${randomUUID()}.tmp`;
  // The `mode` option is masked by umask; chmod pins 0600 the way writeEnvFile does.
  writeFileSync(temporary, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, authPath);
}

export async function adoptCredential(
  id: string,
  opts: { readonly discover?: CredentialDiscoverer; readonly authPath: string },
): Promise<{ readonly provider: string }> {
  const credentials = await (opts.discover ?? discoverLocalCredentials)();
  const credential = credentials.find((candidate) => credentialId(candidate) === id);
  if (!credential) {
    throw new Error(`no such credential: ${id}`);
  }
  const discovered = toDiscovered(credential);
  if (!discovered.adoptable) {
    throw new Error(`credential cannot be used: ${discovered.reason ?? "not adoptable"}`);
  }
  writeAuthEntry(opts.authPath, credential.provider, credential.credential);
  return { provider: credential.provider };
}
