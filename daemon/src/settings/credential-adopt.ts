import {
  discoverExternalCredentials,
  EXTERNAL_PROVIDER_LABELS,
  importCredentials,
  isAutoImportOAuthCredential,
  type CredentialDiscoveryResult,
  type ImportableCredential,
} from "@gajae-code/coding-agent/setup/credential-import";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { getAgentDbPath } from "@gajae-code/utils";

const EXPIRED_OAUTH_REASON = "This login has expired. Sign in to Claude Code again, or sign in here separately.";

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

export type CredentialDiscoverer = () => Promise<CredentialDiscoveryResult>;

function credentialId(credential: ImportableCredential): string {
  return `${credential.provider}:${credential.origin}`;
}

export function toDiscovered(credential: ImportableCredential): DiscoveredCredential {
  const adoptable = credential.kind === "oauth" ? isAutoImportOAuthCredential(credential) : true;
  const identity = credential.identity?.email ?? credential.identity?.accountId;
  return {
    id: credentialId(credential),
    provider: credential.provider,
    label: EXTERNAL_PROVIDER_LABELS[credential.provider],
    source: credential.source,
    kind: credential.kind,
    redactedToken: credential.redactedToken,
    ...(identity === undefined ? {} : { identity }),
    ...(credential.expiresAt === undefined ? {} : { expiresAt: new Date(credential.expiresAt).toISOString() }),
    adoptable,
    ...(adoptable ? {} : { reason: EXPIRED_OAUTH_REASON }),
  };
}

export async function discoverCredentials(
  discover: CredentialDiscoverer = discoverExternalCredentials,
): Promise<readonly DiscoveredCredential[]> {
  const result = await discover();
  const activeProviders = new Set(result.environment.map((hint) => hint.provider));
  return result.importable
    .filter((credential) => !activeProviders.has(credential.provider))
    .map(toDiscovered)
    .sort((left, right) => Number(right.adoptable) - Number(left.adoptable) || left.label.localeCompare(right.label));
}

export async function adoptCredential(
  id: string,
  opts: { readonly discover?: CredentialDiscoverer; readonly dbPath?: string } = {},
): Promise<{ readonly provider: string }> {
  const result = await (opts.discover ?? discoverExternalCredentials)();
  const credential = result.importable.find((candidate) => credentialId(candidate) === id);
  if (!credential) {
    throw new Error(`no such credential: ${id}`);
  }
  const discovered = toDiscovered(credential);
  if (!discovered.adoptable) {
    throw new Error(`credential cannot be used: ${discovered.reason ?? "not adoptable"}`);
  }

  const storage = await AuthStorage.create(opts.dbPath ?? getAgentDbPath());
  try {
    const summary = await importCredentials([credential], (provider, value) => storage.upsertCredential(provider, value));
    if (summary.failed.length > 0) {
      throw new Error(`failed to adopt credential: ${id}`);
    }
  } finally {
    storage.close();
  }
  return { provider: credential.provider };
}
