import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type TerminalState = "completed" | "failed" | "timeout" | "cancelled";

export interface TerminalReportInput {
  readonly childId: string;
  readonly title: string;
  readonly state: TerminalState;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly summary: string;
  readonly sessionFile?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

/**
 * Terminal evidence is self-authenticating so a later receipt admission can
 * prove which completed child produced the recovered report.
 */
export interface TerminalReport extends TerminalReportInput {
  readonly version: 1;
  readonly checksum: string;
}

export function createTerminalReport(input: TerminalReportInput): TerminalReport {
  const normalized = normalizeReportInput(input);
  const reportWithoutChecksum = {
    version: 1 as const,
    ...normalized,
  };
  return {
    ...reportWithoutChecksum,
    checksum: checksumReport(reportWithoutChecksum),
  };
}

export function verifyTerminalReport(report: TerminalReport): void {
  const normalized = normalizeReportInput(report);
  if (report.version !== 1) {
    throw new Error(`unsupported terminal report version: ${String(report.version)}`);
  }
  if (!isChecksum(report.checksum)) {
    throw new Error("terminal report checksum is invalid");
  }

  const expected = checksumReport({ version: 1, ...normalized });
  if (report.checksum !== expected) {
    throw new Error("terminal report checksum does not match its contents");
  }
}

export class TerminalJournal {
  public constructor(public readonly directory: string) {}

  public pathFor(childId: string): string {
    assertChildId(childId);
    return join(this.directory, `${childId}.json`);
  }

  /**
   * Writes and fsyncs a private temporary file before atomically publishing it
   * at the terminal path. A matching existing report makes retries idempotent.
   */
  public writeTerminal(report: TerminalReport): string {
    verifyTerminalReport(report);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });

    const path = this.pathFor(report.childId);
    if (existsSync(path)) {
      const existing = this.recoverTerminal(report.childId);
      if (existing?.checksum === report.checksum) {
        return path;
      }
      throw new Error(`terminal journal already contains different evidence for child ${report.childId}`);
    }

    const temporary = `${path}.${randomUUID()}.tmp`;
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, JSON.stringify(report));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
    fsyncDirectory(this.directory);
    return path;
  }

  /**
   * Ignores incomplete temporary files and only returns a checksum-verified
   * report that was atomically exposed at the final journal path.
   */
  public recoverTerminal(childId: string): TerminalReport | undefined {
    const path = this.pathFor(childId);
    if (!existsSync(path)) {
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new Error(`terminal journal is unreadable for child ${childId}: ${messageOf(error)}`);
    }

    const report = parseTerminalReport(parsed);
    if (report.childId !== childId) {
      throw new Error(`terminal journal child id mismatch: expected ${childId}`);
    }
    verifyTerminalReport(report);
    return report;
  }
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch {
    // Some filesystems do not support directory fsync. File fsync plus rename
    // remains the portable atomic-publication boundary.
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function checksumReport(report: { readonly version: 1 } & TerminalReportInput): string {
  return createHash("sha256").update(JSON.stringify(report)).digest("hex");
}

function normalizeReportInput(input: TerminalReportInput): TerminalReportInput {
  assertChildId(input.childId);
  const title = nonEmpty(input.title, "terminal report title");
  const summary = nonEmpty(input.summary, "terminal report summary");
  if (!isTerminalState(input.state)) {
    throw new Error(`terminal report state is invalid: ${String(input.state)}`);
  }
  assertTimestamp(input.startedAt, "terminal report startedAt");
  assertTimestamp(input.completedAt, "terminal report completedAt");

  return {
    childId: input.childId,
    title,
    state: input.state,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    summary,
    ...(input.sessionFile === undefined ? {} : { sessionFile: nonEmpty(input.sessionFile, "terminal report sessionFile") }),
    ...(input.errorCode === undefined ? {} : { errorCode: nonEmpty(input.errorCode, "terminal report errorCode") }),
    ...(input.errorMessage === undefined
      ? {}
      : { errorMessage: nonEmpty(input.errorMessage, "terminal report errorMessage") }),
  };
}

function parseTerminalReport(value: unknown): TerminalReport {
  if (!isRecord(value)
    || value.version !== 1
    || typeof value.childId !== "string"
    || typeof value.title !== "string"
    || !isTerminalState(value.state)
    || typeof value.startedAt !== "string"
    || typeof value.completedAt !== "string"
    || typeof value.summary !== "string"
    || typeof value.checksum !== "string"
    || (value.sessionFile !== undefined && typeof value.sessionFile !== "string")
    || (value.errorCode !== undefined && typeof value.errorCode !== "string")
    || (value.errorMessage !== undefined && typeof value.errorMessage !== "string")) {
    throw new Error("terminal journal has an invalid report shape");
  }

  return {
    version: 1,
    childId: value.childId,
    title: value.title,
    state: value.state,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    summary: value.summary,
    ...(value.sessionFile === undefined ? {} : { sessionFile: value.sessionFile }),
    ...(value.errorCode === undefined ? {} : { errorCode: value.errorCode }),
    ...(value.errorMessage === undefined ? {} : { errorMessage: value.errorMessage }),
    checksum: value.checksum,
  };
}

function assertChildId(value: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("/") || value.includes("\\")) {
    throw new Error("child id must be a non-empty path-safe string");
  }
}

function nonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function assertTimestamp(value: string, label: string): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
}

function isTerminalState(value: unknown): value is TerminalState {
  return value === "completed" || value === "failed" || value === "timeout" || value === "cancelled";
}

function isChecksum(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
