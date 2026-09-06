import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { ChildLifecycle } from "../../src/children/lifecycle.ts";
import { ChildRegistry } from "../../src/children/registry.ts";
import { SdkInProcessRunner, type ChildSessionFactory } from "../../src/children/runners/sdk-inprocess.ts";
import { TerminalJournal } from "../../src/children/terminal-journal.ts";
import { MEMORY_BACKFILL_CHILD_TITLE, MEMORY_CANONICALIZATION_PENDING_META_PREFIX, MemoryCanonicalizer } from "../../src/memory/adapters/canonicalize.ts";
import { MemoryClosureQueue } from "../../src/memory/adapters/intents.ts";
import { openStateStore, type StateStore } from "../../src/store/index.ts";
import { FakeConversationRunner } from "../children/fakes.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for canonicalization closure");
    }
    await Bun.sleep(10);
  }
}

describe("memory canonicalization child flow", () => {
  test("promotes a fact through a stubbed SDK child, regenerates the map, and preserves raw capture bytes", async () => {
    const home = mkdtempSync(join(tmpdir(), "openinstinct-memory-canonicalize-"));
    directories.push(home);
    const store: StateStore = openStateStore(join(home, "state.db"));
    const now = new Date("2026-04-05T06:07:08.000Z");
    const closure = new MemoryClosureQueue({ store, home, now: () => now });
    let canonicalizer: MemoryCanonicalizer;
    const prompts: string[] = [];
    const events: [string, string][] = [];
    const factory: ChildSessionFactory = {
      create: async () => {
        const listeners = new Set<(event: unknown) => void>();
        return {
          sessionFile: "/tmp/canonicalizer.jsonl",
          async prompt(prompt: string): Promise<void> {
            prompts.push(prompt);
            mkdirSync(join(home, "memory", "projects"), { recursive: true });
            mkdirSync(join(home, "memory", "people"), { recursive: true });
            // An aliased canonical note the promoted file mentions by name:
            // the close step's autolink pass must turn that mention into a link.
            writeFileSync(join(home, "memory", "people", "haerin.md"), "---\naliases:\n  - Haerin\n  - 해린\n---\n\n# Haerin\n\nOwns the launch.\n");
            writeFileSync(join(home, "memory", "projects", "launch.md"), "# Launch\n\nThe launch target is 2026-04-20. Haerin owns it.\n");
            for (const listener of listeners) {
              listener({
                type: "message_update",
                assistantMessageEvent: { type: "text_delta", delta: "Promoted launch target." },
              });
            }
          },
          subscribe(listener: (event: unknown) => void): () => void {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          async dispose(): Promise<void> {},
        };
      },
    };
    const runner = new SdkInProcessRunner({ root: join(home, "children"), factory });
    const lifecycle = new ChildLifecycle({
      registry: new ChildRegistry(store, { now: () => now }),
      journal: new TerminalJournal(join(home, "children", "journal")),
      runner,
      conversation: new FakeConversationRunner(),
      daemonRunner: runner,
      onReceipt: async (receipt) => {
        await canonicalizer.onChildReceipt(receipt);
      },
    });
    canonicalizer = new MemoryCanonicalizer({ store, lifecycle, closure, onEvent: (event, fields) => events.push([event, JSON.stringify(fields).slice(0, 200)]) });

    try {
      closure.enqueueCapture({
        origin: { kind: "owner-chat", reference: "canonicalize-fixture" },
        userText: "Remember that the launch target is April twentieth.",
        replyText: "I will retain the launch target.",
        idempotencyKey: "canonicalize-fixture",
      });
      await closure.drain();
      const rawPath = join(home, "memory", "daily", "2026-04-05.md");
      const rawBefore = readFileSync(rawPath);

      const result = await canonicalizer.canonicalize();
      expect(result).toMatchObject({ kind: "scheduled", files: ["daily/2026-04-05.md"] });
      expect(prompts).toHaveLength(0);
      await waitFor(() => store.getChild(result.childId!)?.state === "completed"
        && store.listMemoryIntents().some((intent) => intent.kind === "maintenance" && intent.state === "receipted")
        && store.listReceipts().some((receipt) => receipt.childId === result.childId && receipt.state === "delivered"));
      expect(store.listReceipts().find((receipt) => receipt.childId === result.childId)?.state).toBe("delivered");
      await waitFor(() => events.some(([event]) => event === "canonicalization_autolinked"));

      expect(prompts[0]).toContain("daily/2026-04-05.md");
      expect(prompts[0]).toContain("Never edit, rename, move, delete, or rewrite any file beneath the raw daily capture axis");
      // The gajae-way routing doctrine is what keeps the corpus navigable.
      expect(prompts[0]).toContain("ops/rules/, ops/distillations/ or ops/handoffs/ and never one growing file");
      expect(prompts[0]).toContain("reflections/YYYY-MM-DD.md");
      expect(prompts[0]).toContain("`aliases:`");
      const launch = readFileSync(join(home, "memory", "projects", "launch.md"), "utf8");
      expect(launch).toContain("2026-04-20");
      // Deterministic crosslinking ran in the close step.
      expect(launch).toContain("[Haerin](../people/haerin.md)");
      expect(readFileSync(join(home, "memory", "MEMORY.md"), "utf8")).toContain("projects/launch.md");
      expect(readFileSync(rawPath)).toEqual(rawBefore);
    } finally {
      await lifecycle.stop();
      store.close();
    }
  });

  test("with no new captures, backfills alias frontmatter on canonical files that predate the doctrine", async () => {
    const home = mkdtempSync(join(tmpdir(), "openinstinct-memory-backfill-"));
    directories.push(home);
    const store: StateStore = openStateStore(join(home, "state.db"));
    const now = new Date("2026-04-05T06:07:08.000Z");
    const closure = new MemoryClosureQueue({ store, home, now: () => now });
    await closure.initialize();
    // A canonical note written before the metadata doctrine: no frontmatter.
    mkdirSync(join(home, "memory", "people"), { recursive: true });
    writeFileSync(join(home, "memory", "people", "haerin.md"), "# Haerin\n\nOwns the launch.\n");

    let canonicalizer: MemoryCanonicalizer;
    const prompts: string[] = [];
    const titles: string[] = [];
    const factory: ChildSessionFactory = {
      create: async (input) => {
        titles.push(input.title);
        const listeners = new Set<(event: unknown) => void>();
        return {
          sessionFile: "/tmp/backfill.jsonl",
          async prompt(prompt: string): Promise<void> {
            prompts.push(prompt);
            writeFileSync(join(home, "memory", "people", "haerin.md"), "---\naliases:\n  - Haerin\n  - 해린\ntags:\n  - people\n---\n\n# Haerin\n\nOwns the launch.\n");
            for (const listener of listeners) {
              listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Backfilled." } });
            }
          },
          subscribe(listener: (event: unknown) => void): () => void {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          async dispose(): Promise<void> {},
        };
      },
    };
    const runner = new SdkInProcessRunner({ root: join(home, "children"), factory });
    const lifecycle = new ChildLifecycle({
      registry: new ChildRegistry(store, { now: () => now }),
      journal: new TerminalJournal(join(home, "children", "journal")),
      runner,
      conversation: new FakeConversationRunner(),
      daemonRunner: runner,
      onReceipt: async (receipt) => {
        await canonicalizer.onChildReceipt(receipt);
      },
    });
    canonicalizer = new MemoryCanonicalizer({ store, lifecycle, closure });

    try {
      const result = await canonicalizer.canonicalize();
      expect(result).toMatchObject({ kind: "scheduled", files: ["people/haerin.md"] });
      await waitFor(() => store.getChild(result.childId!)?.state === "completed");
      expect(titles).toEqual([MEMORY_BACKFILL_CHILD_TITLE]);
      expect(prompts[0]).toContain("`aliases:`");
      expect(prompts[0]).toContain("- people/haerin.md");
      await waitFor(() => readFileSync(join(home, "memory", "people", "haerin.md"), "utf8").includes("aliases:"));

      // Converges: once every file carries aliases there is nothing to do.
      expect(await canonicalizer.canonicalize()).toMatchObject({ kind: "idle" });
    } finally {
      await lifecycle.stop();
      store.close();
    }
  });

  test("leaves a pending failure receipt for parent triage instead of marking it delivered", async () => {
    const home = mkdtempSync(join(tmpdir(), "openinstinct-memory-failure-triage-"));
    directories.push(home);
    const store = openStateStore(join(home, "state.db"));
    const registry = new ChildRegistry(store);
    const child = registry.register({
      kind: "daemon",
      priority: "monitor",
      origin: "memory",
      title: "Memory canonicalization",
      prompt: "work",
      timeoutMs: 1_000,
    });
    registry.markAdmitted(child.id);
    registry.markRunning(child.id);
    store.setMeta(`${MEMORY_CANONICALIZATION_PENDING_META_PREFIX}${child.id}`, JSON.stringify({ files: [], maxMtimeMs: 0, rawHashes: {} }));
    const receipt = registry.admitOrphanReceipt(child, "liveness_unprovable").receipt;
    const closure = new MemoryClosureQueue({ store, home });
    const canonicalizer = new MemoryCanonicalizer({
      store,
      lifecycle: { spawnDaemon: () => { throw new Error("not expected"); } },
      closure,
    });
    try {
      expect(await canonicalizer.onChildReceipt(receipt)).toBe(false);
      expect(store.getReceipt(receipt.id)?.state).toBe("persisted");
      expect(store.getMeta(`${MEMORY_CANONICALIZATION_PENDING_META_PREFIX}${child.id}`)).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
