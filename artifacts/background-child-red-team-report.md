# Background-child red-team remediation report (G007)

Snapshot: `sha256:5335ad16355de6dac1d5d534f86c8be3bcacfc798f04fa90b18da5853d663362`.

## Resolutions

- A/B: main and child SDK factories use distinct scope-local `AgentRegistry` instances, unique ids/display names, isolated IRC-disabled settings, and no active IRC tool. Child turns bind only a current unseen SDK token; settled/seen tokens cannot poison later generations, and tokenless frames remain on the prompt/waitForIdle fallback. Sync abort/steer throws are contained.
- C: throwing admission fencing callbacks publish cancelled durable evidence and never enqueue; fallback termination prevents live-cap leaks.
- D: unsafe external liveness claims were removed; unprovable recovered running children are intentionally orphaned.
- E/F: status is an in-memory snapshot refreshed by lifecycle mutation callbacks; child tools emit only asynchronous latency alerts. Parent `MainSession` is the sole owner-facing author/communication authority. Shared owner-text safety rejects raw terminal states, fields, error-ish tokens, paths, stacks, sentinel text, and receipt-specific fragments. Receipt, monitor, memory, and interim layers never call delivery directly; they only triage through `MainSession.admitOwnerReply`. No-session/failed/unsafe triage remains retryable; exact sentinel is silent.
- G/H: interim replay/flush are single-flight, thrown turn failures retry in process, omission-only batches are durable, and owner-turn completion notifications are centralized/deduped. Correlated monitor receipts are marked delivered only after event delivery succeeds.
- I/J/K: ownerTurnId telemetry, childId event context, promptHash/cadence acceptance predicates, real lifecycle-held drill, bounded dispose finalization, cleanup, and EN/KO docs are updated.

## Verification

- `cd daemon && bunx tsc --noEmit --pretty false`: PASS.
- Focused G007 suite (`cd daemon && bun test test/omo-session/main-session.test.ts test/omo-session/child-tools.test.ts test/children/omo-conversation.test.ts test/children/interim.test.ts test/children/receipts.test.ts test/monitors/propagation.test.ts test/children/lifecycle.test.ts test/children/lifecycle-conversational.test.ts test/children/lifecycle-hardening.test.ts test/e2e/conversational-child.slice.test.ts test/e2e/drills/mid-interim-batch.test.ts test/adversarial/background-child-red-team.test.ts`): PASS, 92 pass / 0 fail, 483 assertions.
- `cd daemon && bun test`: 344 pass / 2 skip / 8 fail, 1,319 assertions. All eight failures are the post-rebase `test/store.test.ts` abandoned-v8 helper creating interim tables on an already-v8 database; no G007 focused test fails. SDK-isolation can time out when the repo dependency is not installed; do not mask that in source.
- `bash scripts/drills/failure-drills.sh`: PASS; all seven restart drills plus live `child-tools-while-held` pass.
- `git diff --check`: PASS.
- Exact repro scripts all report `violated:false`: stale/generation+cap, authority-only correlated receipt, authority-only concurrent interim replay, and async tool guard.

## Audit

`daemon/src` has no direct `delivery.admit` in ReceiptInbox, InterimInbox, MonitorPropagation, or MemoryCanonicalizer. Remaining delivery admissions are MainSession ordinary owner-turn paths (owner replies, segments, images, heartbeat/backlog) or MainSession's attributed owner-reply authority. New tests cover safe/rephrased/silent owner triage, cached status no-I/O, progress snapshot updates, registry isolation, admission cleanup, and real lifecycle child-tool holding.
