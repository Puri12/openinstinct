import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { MemoryClosureQueue } from "../../src/memory/adapters/intents.ts";
import { createMemoryAuditTool, createMemoryCaptureTool, createMemorySearchTool } from "../../src/memory/tools.ts";
import { openStateStore } from "../../src/store/index.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("main-session memory tools", () => {
  test("registers explicit capture, BM25 search, and read-only audit tools", async () => {
    const home = mkdtempSync(join(tmpdir(), "openinstinct-memory-tools-"));
    directories.push(home);
    const store = openStateStore(join(home, "state.db"));
    const closure = new MemoryClosureQueue({ store, home, now: () => new Date("2026-05-01T00:00:00.000Z") });
    try {
      const capture = createMemoryCaptureTool(closure);
      const search = createMemorySearchTool(closure);
      const audit = createMemoryAuditTool(closure);
      expect([capture.name, search.name, audit.name]).toEqual(["memory_capture", "memory_search", "memory_audit"]);

      const captured = await capture.execute("capture", { note: "Owner prefers concise summaries." }, undefined, undefined, {} as never);
      expect(captured.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("accepted") });
      await closure.drain();

      const found = await search.execute("search", { query: "concise summaries", limit: 10 }, undefined, undefined, {} as never);
      expect(found.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("daily/2026-05-01.md") });
      const audited = await audit.execute("audit", {}, undefined, undefined, {} as never);
      expect(audited.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("issues") });
    } finally {
      store.close();
    }
  });
});
