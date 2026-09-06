import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryClosureQueue } from "../../src/memory/adapters/intents.ts";
import { backfillCapturesFromTranscript } from "../../src/memory/adapters/session-backfill.ts";
import { openStateStore, type StateStore } from "../../src/store/index.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function transcript(lines: readonly object[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

describe("session transcript capture backfill", () => {
  test("replays owner exchanges into the daily file for the day they happened, skipping injected prompts", async () => {
    const home = mkdtempSync(join(tmpdir(), "openinstinct-session-backfill-"));
    directories.push(home);
    const store: StateStore = openStateStore(join(home, "state.db"));
    const closure = new MemoryClosureQueue({ store, home, now: () => new Date("2026-09-05T00:00:00.000Z") });
    const path = join(home, "session.jsonl");
    writeFileSync(path, transcript([
      { timestamp: "2026-09-03T01:02:03.000Z", message: { role: "user", content: "정본화 잘 돌았어?" } },
      { timestamp: "2026-09-03T01:02:09.000Z", message: { role: "assistant", content: [{ type: "text", text: "돌았음." }, { type: "toolCall", name: "read" }] } },
      { timestamp: "2026-09-03T01:02:11.000Z", message: { role: "assistant", content: [{ type: "text", text: "링크도 붙었고." }] } },
      // Machine-injected prompts are not the owner talking.
      { timestamp: "2026-09-03T02:00:00.000Z", message: { role: "user", content: "Monitor \"Check-in\" (id heartbeat) produced a result." } },
      { timestamp: "2026-09-03T02:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "[[no-owner-message]]" }] } },
      { timestamp: "2026-09-04T09:00:00.000Z", message: { role: "user", content: "어제 뭐했지" } },
      { timestamp: "2026-09-04T09:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "정본화 고쳤음." }] } },
    ]));

    try {
      const result = await backfillCapturesFromTranscript(path, closure);
      expect(result).toMatchObject({ captured: 2, skippedInjected: 1, skippedAlreadyPresent: 0 });

      // Dated by when it happened, not by the queue clock (2026-09-05).
      const third = readFileSync(join(home, "memory", "daily", "2026-09-03.md"), "utf8");
      expect(third).toContain("정본화 잘 돌았어?");
      expect(third).toContain("돌았음.");
      // Assistant text across several messages is joined; tool calls are not text.
      expect(third).toContain("링크도 붙었고.");
      expect(third).not.toContain("Monitor \\\"Check-in\\\"");
      expect(third).toContain("## 2026-09-03T01:02:03.000Z");
      expect(readFileSync(join(home, "memory", "daily", "2026-09-04.md"), "utf8")).toContain("어제 뭐했지");
      expect(() => readFileSync(join(home, "memory", "daily", "2026-09-05.md"), "utf8")).toThrow();

      // Re-running is safe: already-recorded exchanges are recognized.
      const again = await backfillCapturesFromTranscript(path, closure);
      expect(again).toMatchObject({ captured: 0, skippedAlreadyPresent: 2 });
      expect(readFileSync(join(home, "memory", "daily", "2026-09-03.md"), "utf8").match(/## 2026-09-03T01:02:03/g)).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
