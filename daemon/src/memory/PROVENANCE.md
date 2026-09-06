# Memory vendor provenance

- Source repository: `/Users/you/Documents/Workspace/gajae-way`
- Pinned source commit: `8eafbefd9b71fa8f101ef3122f87265456ca7709`
- Source inspected read-only on 2026-09-02.
- The source repository is private and has no top-level `LICENSE*` file at the pinned commit.

## File map

| Vendored file | Pinned source file | SHA-256 | Local divergence |
| --- | --- | --- | --- |
| `vendor/registry.ts` | `packages/gateway/src/memory/registry.ts` | `ff9aae71c1c6ebb5a0f629965324ab0b8c2b0c4f901d2a11489626d1f633a66d` | None; byte-for-byte copy. |
| `vendor/doctrine.ts` | `packages/gateway/src/memory/doctrine.ts` | `f882d1ca10060adde052799a536c7e0f026fd90843cb28e28e1c241124ef1e3f` | None; byte-for-byte copy. Its clock-bound `appendDaily` is not called by OpenInstinct adapters; `adapters/capture.ts` supplies injected-clock capture writing and mutation evidence. |
| `vendor/validator.ts` | `packages/gateway/src/memory/validator.ts` | `cccb51753faa6c340c1ef5a0fde32d110512990deed4eeb6e5908ec877483e4b` | None; byte-for-byte copy. |
| `vendor/retrieve.ts` | `packages/gateway/src/memory/retrieve.ts` | `750e78e99ad252117dfe348ac29877aafdd1195b62b277a3431600d1a1bb33bb` | None; byte-for-byte copy. |
| `vendor/autolink.ts` | `packages/gateway/src/memory/autolink.ts` | `163873ec891e48d97308446ff910df0360de64dd1f2f99e855f1aa92faf3909a` | None; byte-for-byte copy. |


## Source-derived adapter

| OpenInstinct adapter | Pinned source file | SHA-256 | Local divergence |
| --- | --- | --- | --- |
| `adapters/intents.ts` | `packages/gateway/src/memory/closure.ts` | `ff79ce6cc887f114d8774aaebc5c5f703d8ecb940e59234bfda36690900330a9` | Reimplemented against `StateStore` rather than gajae-way `GatewayDatabase`; adds idempotency keys, injected-clock capture evidence, non-destructive quarantine classification, and `Openinstinct-Mutation-Id` trailers. |
## Source-derived prompt doctrine

| OpenInstinct site | Pinned source file | SHA-256 | Local divergence |
| --- | --- | --- | --- |
| `adapters/canonicalize.ts` `CANONICALIZATION_DOCTRINE` | `packages/gateway/src/monitors/propagate.ts` (`MAINTENANCE_GUIDANCE["memory.canonicalize"]`) | `a99b3920052afb69a1965a618fcc7217f558413828634984839990c735d2e580` | Axis-routing text copied word-for-word except three runtime-specific deltas (96.5% word-level identity, verified by diff): the `For memory.canonicalize events: read` event-dispatch preamble becomes `Read` because the surrounding prompt supplies its own header; `run \`gajaeway memory autolink\`` becomes `the daemon runs the autolink sweep` because that CLI does not exist here and the daemon calls the vendored `autolinkCorpus` in its close step; and `The gateway commits; you only write files.` is dropped because the surrounding prompt states `the daemon regenerates MEMORY.md, runs autolink, and commits after this child completes. You only write files.` A paraphrase of this text produced flat, unlinked notes, so it is treated as vendored content: re-diff it against the source when the pin moves.

## OpenInstinct adapters

`adapters/` owns only environment-specific behavior: StateStore-backed intent closure, receipt paths and Openinstinct trailer names, injected-clock/provenance-aware capture writing, engine-child canonicalization, read-only audit presentation, and main-session tools. The vendored files retain the shared registry/traversal/map/audit/BM25 behavior unchanged.
