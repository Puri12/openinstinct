import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createTerminalReport,
  TerminalJournal,
} from "../../src/children/terminal-journal.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("TerminalJournal", () => {
  test("atomically publishes checksum-bound evidence that recovery verifies", () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-terminal-journal-"));
    directories.push(root);
    const journal = new TerminalJournal(join(root, "journal"));
    const report = createTerminalReport({
      childId: "child-1",
      title: "Research availability",
      state: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
      summary: "Availability is confirmed.",
      sessionFile: "/tmp/child-1.jsonl",
    });

    const path = journal.writeTerminal(report);
    writeFileSync(`${path}.interrupted.tmp`, "incomplete");

    expect(existsSync(path)).toBe(true);
    expect(journal.recoverTerminal("child-1")).toEqual(report);
    expect(journal.writeTerminal(report)).toBe(path);
  });

  test("rejects terminal evidence whose checksum no longer matches", () => {
    const root = mkdtempSync(join(tmpdir(), "openinstinct-terminal-journal-invalid-"));
    directories.push(root);
    const journal = new TerminalJournal(join(root, "journal"));
    const report = createTerminalReport({
      childId: "child-2",
      title: "Validate result",
      state: "failed",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
      summary: "The worker failed.",
      errorCode: "child_run_failed",
      errorMessage: "provider unavailable",
    });

    expect(() => journal.writeTerminal({ ...report, summary: "tampered" })).toThrow("checksum");
  });
});
