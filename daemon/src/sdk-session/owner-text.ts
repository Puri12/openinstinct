export const OWNER_SILENT_MARKER = "[[no-owner-message]]";

export interface OwnerTextSafetyOptions {
  readonly forbiddenFragments?: readonly (string | undefined)[];
  readonly rejectInternalTokens?: boolean;
}

/** Shared final owner-text safety gate used by MainSession and triage adapters. */
export function isSafeOwnerText(text: string, options: OwnerTextSafetyOptions = {}): boolean {
  const candidate = text.trim();
  if (!candidate || candidate.includes(OWNER_SILENT_MARKER)) {
    return false;
  }
  if (RAW_STATE_VALUE.test(candidate)
    || RAW_STATE_FIELD.test(candidate)
    || RAW_FIELD_NAME.test(candidate)
    || RAW_PATH.test(candidate)
    || /(?:^|\n)\s*at\s+\S+/.test(candidate)
    || /\b(?:Error|Traceback):/i.test(candidate)
    || ((options.rejectInternalTokens ?? true) && RAW_INTERNAL_TOKEN.test(candidate))) {
    return false;
  }
  const fragments = options.forbiddenFragments ?? [];
  return !fragments.some((fragment) => (
    typeof fragment === "string"
    && fragment.trim().length >= 2
    && (containsStandalone(candidate, fragment) || containsSubstantialFragment(candidate, fragment))
  ));
}

const RAW_STATE_VALUE = /^(?:failed|timeout|orphaned|cancelled|completed|terminated)[.!]?$/i;
const RAW_STATE_FIELD = /(?:^|[^A-Za-z0-9_])(?:state|status)\s*[:=]\s*(?:failed|timeout|orphaned|cancelled|completed|terminated)(?:$|[^A-Za-z0-9_])/i;
const RAW_FIELD_NAME = /(?:^|[^A-Za-z0-9_])(?:errorCode|errorMessage|error_code|error_message|journalPath|journal_path|sessionFile|session_file|artifactPath|artifact_path)(?:$|[^A-Za-z0-9_])/i;
const RAW_INTERNAL_TOKEN = /(?:^|[^A-Za-z0-9_])(?:[a-z][a-z0-9]*(?:_[a-z0-9]+)*_(?:error|failed|failure|timeout|missing|unprovable|cancelled|orphaned)|liveness_unprovable|session_file_missing)(?:$|[^A-Za-z0-9_])/i;
const RAW_PATH = /(?:^|[\s("'`=:])(?:~\/|\/(?:Users|private|tmp|var|opt|etc|home)\/|[A-Za-z]:[\\/])[^\s)\]}> ,"'`]+/;

function containsStandalone(candidate: string, fragment: string): boolean {
  const value = fragment.trim();
  if (candidate === value || (candidate.includes(value) && !/[A-Za-z0-9_]/.test(value))) {
    return true;
  }
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}(?:$|[^A-Za-z0-9_])`, "i").test(candidate);
}

function containsSubstantialFragment(candidate: string, fragment: string): boolean {
  const source = normalizeFragment(fragment);
  const target = normalizeFragment(candidate);
  if (source.length >= 16 && target.includes(source)) {
    return true;
  }
  const words = source.split(" ").filter(Boolean);
  for (let size = 5; size <= words.length; size += 1) {
    for (let start = 0; start + size <= words.length; start += 1) {
      const phrase = words.slice(start, start + size).join(" ");
      if (phrase.length >= 24 && target.includes(phrase)) {
        return true;
      }
    }
  }
  return false;
}

function normalizeFragment(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, " ").trim().replace(/\s+/g, " ");
}
