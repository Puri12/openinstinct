import type { CustomTool } from "@gajae-code/coding-agent";
import { Type } from "@gajae-code/coding-agent/extensibility/typebox";

import { memoryAudit } from "./adapters/audit.ts";
import { MemoryClosureQueue } from "./adapters/intents.ts";
import { searchMemory } from "./vendor/retrieve.ts";

export function createMemorySearchTool(closure: MemoryClosureQueue): CustomTool {
  return {
    name: "memory_search",
    label: "Memory Search",
    strict: true,
    concurrency: "shared",
    description: "Search canonical OpenInstinct memory with BM25 ranking. Returns bounded excerpts, paths, and scores.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 1_000 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      const input = params as { readonly query: string; readonly limit?: number };
      await closure.initialize();
      const hits = await searchMemory(closure.corpusRoot, input.query.trim(), input.limit ?? 10);
      return {
        content: [{
          type: "text",
          text: hits.length === 0 ? "No matching memory was found." : JSON.stringify({ hits }),
        }],
        details: { hits },
      };
    },
  };
}

export function createMemoryCaptureTool(closure: MemoryClosureQueue): CustomTool {
  return {
    name: "memory_capture",
    label: "Memory Capture",
    strict: true,
    concurrency: "shared",
    description: "Durably queue an explicit owner note for the UTC daily memory capture. Returns after StateStore intent admission, not after Git closure.",
    parameters: Type.Object({
      note: Type.String({ minLength: 1, maxLength: 12_000 }),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      const input = params as { readonly note: string };
      const id = closure.enqueueCapture({
        origin: { kind: "owner-chat", reference: "explicit-owner-note" },
        userText: input.note,
        replyText: "Explicit owner note captured.",
      });
      return {
        content: [{ type: "text", text: `Memory capture ${id} was accepted and queued for closure.` }],
        details: { intentId: id },
      };
    },
  };
}

/** Main-session read-only audit tool. It has no repair parameters by design. */
export function createMemoryAuditTool(closure: MemoryClosureQueue): CustomTool {
  return {
    name: "memory_audit",
    label: "Memory Audit",
    strict: true,
    concurrency: "shared",
    description: "Run the read-only structural memory audit. It never repairs or initializes the corpus.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      const report = await memoryAudit(closure.corpusRoot);
      return {
        content: [{ type: "text", text: report.json }],
        details: { ok: report.ok, exitCode: report.exitCode, issues: report.issues },
      };
    },
  };
}
