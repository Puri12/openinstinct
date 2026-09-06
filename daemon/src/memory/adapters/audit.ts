import { validateMemory, type MemoryIssue } from "../vendor/validator.ts";

export interface MemoryAuditResult {
  readonly ok: boolean;
  readonly exitCode: 0 | 1;
  readonly issues: readonly MemoryIssue[];
  readonly json: string;
}

/** Read-only structural audit. It intentionally never initializes or repairs a corpus. */
export async function memoryAudit(root: string): Promise<MemoryAuditResult> {
  const issues = await validateMemory(root);
  return {
    ok: issues.length === 0,
    exitCode: issues.length === 0 ? 0 : 1,
    issues,
    json: JSON.stringify({ issues }),
  };
}

/** Stable internal function name matching the daemon tool and maintenance verb. */
export async function memory_audit(root: string): Promise<MemoryAuditResult> {
  return memoryAudit(root);
}

/** CLI-shaped seam for callers that must reject accidental repair arguments. */
export async function runMemoryAudit(root: string, args: readonly string[] = []): Promise<MemoryAuditResult> {
  if (args.length > 0) {
    throw new Error("memory audit accepts no arguments; repair the corpus manually and re-run the read-only audit");
  }
  return memoryAudit(root);
}
