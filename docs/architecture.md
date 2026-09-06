# OpenInstinct architecture

One macOS launchd daemon (`openinstinctd`, a Bun runtime running
`daemon/src/main.ts`), one menu-bar app, one tiny Accessibility helper. All state
under `~/.openinstinct`. No root, SIP on, no third-party binaries: the agent engine
is the npm package `@code-yeongyu/senpi` (the one the `omo-ai` launcher ships), a
normal dependency in `daemon/package.json` alongside `typebox` and
`chrome-devtools-mcp`.

```
~/.openinstinct/
  bin/openinstinctd      bun runtime (copied, keeps its TCC identity across installs)
  bin/oi-presence        typing / read-receipt helper (Swift, AX)
  bin/bun → openinstinctd  the daemon's bun runtime, exposed as "bun" for tools that spawn it
  lib/                   daemon source + node_modules, copied by install.sh
  config.json            optional owner handle, name, model, limits

  env                    provider keys (0600), loaded before any engine import
  omo/                   engine state: auth.json (credentials), models.json
                         (providers/models), settings.json, sessions/
  state.db               SQLite: cursor, deliveries, children, monitors, receipts
  session/               cwd of the main engine session (never the repo)
  children/{work,sessions,journal}/
  memory/                git repo, gajae-way layout
  chrome-profile/        the agent's own Chrome user-data-dir
  secrets/               credentials the owner texted (0600 per service)
  logs/daemon.ndjson     structured log, rotated by retention
  run/control.sock       NDJSON control socket (0600)
```

## Boot and lanes

`env-bootstrap.ts` is the first import: it loads `~/.openinstinct/env` into
`process.env` *before* the engine is evaluated, because the engine injects its own
auto-imported credentials at module load and the owner's file must win. The same
bootstrap pins the engine state directory: `SENPI_CODING_AGENT_DIR`,
`OMO_CODING_AGENT_DIR`, and `PI_CODING_AGENT_DIR` all point at
`~/.openinstinct/omo` (the launchd plist rendered by `install/plist.ts` sets them
too), and the daemon seeds its settings there. The host's `~/.omo/agent` is never
touched; `scripts/install-omo-state.sh` copies `auth.json` and `models.json` out
of it once, on first install, and never overwrites. Then `startDaemon()`:

1. **Bootstrap machine** probes `config` and AI credentials. Credentials are the
   only core-lane gate. A missing or malformed `config.json` does not block
   startup: `core-config.ts` applies per-scope product defaults and logs the
   fallback. When an owner handle is configured, it also probes Full Disk Access
   (`chat.db`) and Automation (an `osascript` query to Messages); those probes
   are skipped for a chat-only install. It re-probes every 5 s and publishes
   status on the socket.
2. **Store** opens `state.db` (migrations in `store/migrations.ts`).
3. **Control server** listens on the socket immediately, including while the
   core is waiting for credentials, so the panel can show why.
4. When the credentials probe passes (or is unknown), the **core lane** starts:
   the main session, child lifecycle, monitor scheduler/triggers/propagation,
   memory closure, and retention. The Chat hub is available in every bootstrap
   state that the control server can serve.

Bootstrap states are `starting`, `credentials_blocked`, `running`, and
`degraded`. `credentials_blocked` means the core is stopped until an AI account
or managed API key is available. `running` means the core is eligible; it does
not require an iMessage handle. `degraded` means a probe or core start threw;
the existing lanes are left untouched and the next 5-second evaluation retries
the core start.

The core and iMessage lanes have separate lifetimes:

- The **core lane** owns the shared engine session, children, monitors, memory, and
  chat surface. It gates only on AI credentials and can run with no iMessage
  configuration.
- The **optional iMessage lane** owns the chat.db watcher, delivery service,
  Messages sender, and presence path. It attaches when the core is running, an
  owner handle is configured, and the Full Disk Access probe passes. Automation
  is probed only in this configured path and is surfaced in `status.get`; it is
  needed for Messages sending, while Accessibility controls typing/read
  presence. The lane detaches when the handle is absent, FDA is denied or has a
  probe error, attach fails, the core stops, or the daemon shuts down.

Lane convergence runs at boot, on each 5-second re-probe (for example, after a
permission grant), and immediately after an owner-handle or credential setting
change. No daemon restart is needed to attach, detach, or switch numbers. Every
handle replacement or removal retires the old handle first: the lane is detached,
the session is reloaded, and pending/in-flight ledger rows for that old handle
are expired before a new lane can attach. A same-handle permission detach keeps
those rows for replay; a turn that started detached remains chat-only for its
whole life.

### Log events for lane and routing diagnosis

The primary NDJSON log records these lifecycle and routing events:

- `core_lane_started` and `core_lane_stopped` mark the shared core lifetime.
- `imessage_lane_attached`, `imessage_lane_detached`, and
  `imessage_lane_attach_failed` describe optional iMessage convergence.
- `delivery_skipped_no_imessage_lane` records an owner-bound effect dropped
  because the lane was detached or its generation changed.
- `deliveries_expired_for_handle` records pending/in-flight rows retired with an
  old owner handle.
- `config_missing_defaults_applied` and `config_invalid_defaults_applied` record
  configuration fallback while keeping the core eligible.
- `session_reloaded` records a session reload (including lane/persona changes).
- `router_initial_user_skipped` records the engine router ignoring a run's own
  initial user message when attributing queued steering.

## Inbound: iMessage and Chat → shared owner turn

The iMessage adapter still polls `chat.db` through `imessage/reader.ts` (read-only,
WAL) from a ROWID cursor. The cursor is bound to a fingerprint of the database
(path + earliest guid); on first contact or identity change it anchors at
`max(ROWID)` and replays nothing — the one-time incident that texted 21 failures
into the owner's own inbox is why. Bodies come from `text` or, on modern
Messages, from the `attributedBody` typedstream (`decodeAttributedBody`). Only
the configured handle is accepted; everything else is dropped silently. Empty /
tapback / U+FFFC-only rows never become turns. This adapter also reads inbound
attachments (≤ 8 MiB) and supplies `PromptImage[]`.

The panel's `chat.send` control verb is the other thin adapter. It accepts text
from the separate Chat window, tags the prompt with `[sent from the Chat window]`
for transcript source recovery, and does not touch `chat.db`, the allowlist, or
Messages presence.

Both adapters call the source-agnostic `OwnerTurnIngress`. It emits the owner
echo, then applies the same pause suppression, steer-when-busy admission, failure
breaker, memory capture, segment flushing, and final handling for either source.
The source only changes routing: iMessage can mark read and use live Messages
presence; panel turns use Chat hub presence. Typing is per-turn presence, not a
periodic status message.

## The main session

`omo-session/main-session.ts` wraps one engine session built through
`omo-session/omo-runtime.ts` (`createOmoServices` → `resolveModel` →
`openOmoSession`), reopened over the same transcript file on every daemon start
(`SessionManager`). It is never respawned per message.

- **Serial queue**: turns, reloads, and compactions run one at a time.
- **Steering**: `steeringMode=all`. The omo engine's `steer()` waits for the
  in-flight tool call before injecting, so there is no separate interrupt
  setting; all queued owner texts then enter together.
- **Segments**: assistant text is flushed to the owner at every tool-call start
  and every assistant `message_end`, so a turn that thinks–acts–thinks sends
  several short texts instead of one wall at the end. Only owner turns stream;
  internal turns (receipt follow-ups, monitor triage) are silent.
- **Image forwarding**: a `read` of an image path by the agent admits that file
  as an attachment to the owner.
- **Watchdog**: inactivity-based (default 300 s of *no* engine events), reset by
  streaming, tool calls, and steers. On timeout: abort, or dispose + recreate over
  the same transcript.
- **Compaction**: engine auto-compaction is off; the daemon compacts at ≥ 50 %
  context after a turn settles.
- **Reload** (`session.reload`): dispose + recreate over the same transcript so
  a changed system prompt takes effect without losing history.
- **System prompt** = the engine's own defaults, untouched, with the persona
  appended through the engine's `appendSystemPrompt`: `persona/OMO_SOUL.md` (the
  character, versioned) → `persona/RUNTIME.md` (where it is: iMessage, plain
  text, delegation rules, monitor rules, Chrome profile; `{{ownerHandle}}` etc.
  substituted from config).
- **Custom tools**: engine `ToolDefinition`s with typebox schemas
  (`omo-session/tool-types.ts`): `delegate_background`, `send_image`,
  `monitor_author`, `memory_search`, `memory_capture`, `memory_audit`,
  `report_progress`, `child_status`, `child_nudge`.
- **Browser tools**: `browser/chrome.ts` launches or reuses a daemon-owned Chrome
  on `~/.openinstinct/chrome-profile` with `--remote-debugging-port=9223`
  (`ensureChrome` probes `http://127.0.0.1:9223/json/version` first), and
  `browser/enforce.ts` registers `chrome-devtools-mcp` as the MCP server
  `browser` attached to that CDP URL. That gives the model 19 tools
  (`includeTools`): `mcp_browser_navigate_page`, `mcp_browser_take_snapshot`,
  `mcp_browser_take_screenshot`, `mcp_browser_click`, `mcp_browser_fill`,
  `mcp_browser_evaluate_script`, `mcp_browser_wait_for`, and the
  `mcp_browser_list_pages` / `new_page` / `select_page` / `close_page` family.
  The profile pin lives in the MCP declaration, not in a prompt.
- **Enforcement**: the enforcer blocks `task`, `subagent`, `job`, `eval`,
  `workflow`, `team_create`, and `schedule_wakeup` calls, keeps the per-turn tool
  budget (6 main, 40 children), the forbidden-path rules
  (`~/.openinstinct/{children,logs,omo,state.db,env,secrets}`, other agents'
  homes, session `.jsonl` files), the Discord bot-token rule, and the
  main-session bash rule (timeout ≤ 20 s or `run_in_background: true`).

## Outbound: ChatHub and optional iMessage delivery

`ChatHub` fans out owner echoes, assistant segments, final assistant messages,
images, and presence to control-socket subscribers. Every event has a monotonic
`seq` for the life of the daemon. `chat.history` reads the last 50 owner-facing
rows from the shared transcript, filters operator notes, receipt follow-ups, and
monitor triage, strips orientation text, and recovers the source from the
trailing `[sent from the Chat window]` marker. History returns a sequence
watermark and message-only tail so a subscriber can merge the snapshot with
live events without losing or duplicating rows.

`OwnerOutbox` is the single owner-bound delivery boundary. With the optional
iMessage lane attached it pins the current handle and delegates text and images to
the durable `DeliveryService` ledger, while read receipts and typing use the
attached Messages presence path. When detached, owner-turn output still reaches
ChatHub, while iMessage admission and presence are skipped and proactive notices
are dropped with a log entry. A per-turn binding captures the lane generation: a
turn that started detached never starts mirroring if the lane attaches mid-turn,
and a turn invalidated by detach drops its remaining iMessage effects. Receipt,
monitor, memory-audit, and operator-note output normally bypasses ChatHub; if an
owner message promotes an internal run, only output from that promotion onward is
owner-visible.

`delivery/service.ts` is the durable outbox in `state.db`: `admit()` writes a row
with an idempotency key; a flush loop sends with a bounded retry ladder and
records `confirmed` / `expired` / `failed_ambiguous`. Every text and caption is
passed through `toPlainText()` (Markdown stripped) — the prompt asks for plain
text, the sanitizer guarantees it.

`imessage/sender.ts` sends through Messages' own AppleScript bridge
(`send <text|file> to participant`). That bridge exposes nothing else, so replies
are flat (no reply-to), and typing / read are delegated to `oi-presence` when the
binary exists. Attachments are staged into `~/Pictures/OpenInstinct/` and
`mdimport`-ed first because `imagent` refuses files without Spotlight metadata.
The confirmer watches `chat.db` for the sent row.

`oi-presence` needs Messages frontmost for ~300 ms, so it only runs when you have
been idle for `presence.idleSec` (default 8 s) and hands focus back.

## Children

`children/lifecycle.ts` admits conversational and monitor-priority work under a
concurrency cap (default 4) and a live-child cap (default 16). The live cap
counts every non-terminal child; it evicts the oldest idle or cold child before
rejecting a new admission when no evictable child remains. Production work uses
`runners/omo-inprocess.ts`, a separate engine session with the same soul, browser guard,
and model pin (`OmoChildSessionFactory` on the same helper, one session dir per
child under `~/.openinstinct/children`). `runners/omo-external.ts` remains an
explicit adapter rather than the production default: it spawns the vendored
engine CLI (`daemon/node_modules/@code-yeongyu/senpi/dist/cli.js`, or
`dataPaths().omoCli` in the installed layout) with `-p --mode json
--no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files
--session-dir <dir> --model <m>`. Terminal reports are
written to a journal and become **receipts**; receipts are folded into the main
session as follow-up turns (`children/receipts.ts`), projected to ≤ 1024 B.

`delegate_background` children (`kind: task_tool`) are conversational. Their
public durable lifecycle is `running → idle → cold → terminated`: idle children
keep a warm engine session for the warm TTL, then dispose the object while retaining
the session-file transcript; a cold nudge reopens that transcript, while the
idle timeout terminates the child. Main-session `child_status` reads a precomputed
in-memory status snapshot, and `child_nudge` only updates an in-memory lifecycle
queue before scheduling the pump; neither tool enters SQLite or a child engine
session at invocation time. Their latency alert threshold is detection telemetry,
not a preemption promise. Conversational children alone receive `report_progress`;
updates are durably stored, UTF-8 bounded, batched for 3 seconds by default,
rate-limited per child, and injected through an owner-turn steer or one internal
main turn.

Failures and restart orphans for every child kind bypass interim batching and
become durable receipts. Every receipt is fed to the shared internal
Chat/MainSession for an internal triage turn first. That path is the only
owner-facing author and communication authority: background components submit
internal events and triage reports, never send iMessage directly. The main agent
may retry, resume, redelegate, repair, clean state, or silently ignore;
only a judgment-needed result becomes one concise natural-language owner message.
Raw state tokens, provider error codes, stacks, paths, and receipt projections
remain internal evidence and never become owner text.

## Monitors

`monitors/store.ts` keeps specs in `state.db` with revision fencing. Triggers:
`cron` (with IANA tz and explicit DST rules), `watcher` (file roots), `webhook`
(token), `script` (interval, script root only). Optional `expiresAt` disables a
monitor at its end. `memory-canonicalize`, `memory-audit`, and
`computer-usage-insight` are seeded once; the first two are protected.

Firing → `propagation.ts` state machine: `admitted → batched → dispatched
(child) → authored → delivered`, lease-fenced, replay-safe across restarts.
"Authored" hands the child's terminal report to the **main session as a triage
turn**: OmO diagnoses, may repair the monitor with `monitor_author`, and
writes the owner one plain line — or stays silent for a self-healed blip. Raw
error codes never reach the owner.

A manual `monitors.run` request follows the same propagation path immediately,
including for disabled and protected monitors; it uses a unique occurrence key so
on-demand checks cannot be swallowed by scheduled-run deduplication.

## Memory

`memory/vendor/` is gajae-way's memory engine byte-for-byte (registry, doctrine,
autolink, validator, BM25 retrieval), pinned in `PROVENANCE.md`. `adapters/`
supply the environment: every owner turn is queued as a capture intent, written
under `daily/`, and committed; canonicalization (6-hourly) promotes into
people/projects/decisions; the daily audit reports structural issues. Tools are
thin wrappers over the vendored functions.

Existing transcripts can be reconciled with the capture axis through the
`memory.backfillCaptures` control verb. The daemon pairs owner messages with the
assistant replies that follow, preserves their original timestamps, skips
injected prompts, and uses deterministic matching so a repeated backfill is safe.

## Control protocol

`control/schema.ts` defines the NDJSON frames (hello/negotiate, request,
response, error, event) and the verb list. Fixtures in
`daemon/test/fixtures/control/` are the golden source; `scripts/sync-control-fixtures.sh`
copies them into the Swift test target so the panel codec is byte-checked
against them. Notable verbs: `status.get` (bootstrap, session, children,
monitors, `attention`), `monitors.*` including `monitors.run`,
`daemon.pause/resume/restart`, `session.compact/reload`, `settings.get/set`,
`models.list`, `accounts.*`, `providers.custom` (writes a provider block into
`~/.openinstinct/omo/models.json`, one of `openai-completions`,
`openai-responses`, `anthropic-messages`), `browser.open`, and
`memory.backfillCaptures`. `settings/service.ts` serves all of this in process on
the engine: `models.list` comes from the engine's model runtime (ids are
`provider/model`), `accounts.list` from stored credentials, and
`accounts.providers` from the engine's OAuth providers (anthropic, openai-codex,
github-copilot, openrouter, kimi-coding, xai, cursor, claude-sdk-oauth,
cursor-cli-oauth, radius). `accounts.login` runs the engine's OAuth flow and hands
the URL to the panel, with `accounts.login.finish` as the paste-code fallback;
`accounts.logout` removes the credential. Fast mode sets `openai.serviceTier` to
`priority` in `~/.openinstinct/omo/settings.json`.

`accounts.discover` (`settings/credential-adopt.ts`) looks in
`~/.omo/agent/auth.json`, `~/.codex/auth.json`, and `~/.claude/.credentials.json`
and lists what can be adopted; `accounts.adopt` copies one into
`~/.openinstinct/omo/auth.json` only after the owner clicks **Adopt**. Adoption is never automatic because it may start
billing an existing subscription. `monitors.run` dispatches one immediate run
without changing the monitor's schedule or enabled state.

The Chat surface uses `chat.send` (`{text}`), `chat.history` (`{limit}`), and
`chat.subscribe` (`{}`). Subscriptions receive the opt-in `chat.message` and
`chat.presence` event topics. Every chat event payload carries a numeric,
monotonic `seq`; the final assistant `chat.message` for a turn carries
`final: true`. A `chat.history` response is `{messages, seq, tail, inFlight?,
truncated?, tailTruncated?}`, with `tail` containing message events only so a
client can merge history and live events without loss or duplication.

`status.get` also reports the top-level iMessage lane (`attached` or `detached`
with a reason, detail, and optional handle) and the credentials probe. FDA and
Automation probe entries are omitted entirely when no handle is configured.

## Panel

`panel/` is SwiftUI hosted in an explicit `NSStatusItem` + `NSPopover`
(`MenuBarExtra` does not materialise under launchd on macOS 26). It polls
`status.get`, renders health in plain words, and raises a one-time `NSAlert` for
`attention` items. The popover always exposes **Chat…**; it opens a separate
`ChatWindowController` `NSWindow` with iMessage-like bubbles and plain text only.
The composer is blocked only when the daemon is unreachable, credentials are
missing, or the session is paused — never because the optional iMessage lane is
detached. `SettingsWindow.swift` is a normal window with tabs, including an
iMessage tab for connect/disconnect and permission status; changing the handle
does not restart the daemon.

The Account tab also lists OAuth/API-key accounts, offers explicit discovery and
**Adopt** for existing CLI credentials, and never adopts one without owner action.
The iMessage tab is an optional branch; its identity and TCC probes are shown only
when a handle is configured.

Launched at login via `co.openinstinct.panel` using `open -W` so it gets a proper
Aqua session.

## Install and packaging

`scripts/install.sh` copies the repo into `~/.openinstinct/lib`, installs prod
deps, keeps the daemon binary's inode unless bun changed (so TCC grants
survive), renders the launchd plist with a PATH that includes `~/.local/bin`,
and installs/launches the panel and presence helper. It installs the whole
workspace, engine included, and then runs `scripts/install-omo-state.sh` to seed
`~/.openinstinct/omo` on a first install.

`scripts/build-release.sh` compiles the panel and the presence helper, assembles
that payload with a bun runtime and the repository itself. The engine arrives as
an ordinary npm dependency, so no agent binary is bundled. The script emits `dist/openinstinct-<version>-darwin-<arch>.tar.gz` plus a `.sha256`.

`scripts/install-remote.sh` is the curl entry point: it resolves the release
asset, verifies the checksum, extracts the archive, and hands the directory to
`bootstrap-from-payload.sh`, which stages the source at `~/.openinstinct/src`
and calls `install.sh`. There is no installer app and no notarization step:
Gatekeeper only assesses files carrying `com.apple.quarantine`, which browsers
attach and curl does not, so an unsigned build installs and launches without an
approval prompt.

## Safety properties worth knowing

- Never replays history; never answers anyone but the owner; never sends from
  a personal Messages account by design of the setup instructions.
- Two consecutive turn failures → further failure notices go to the log, not
  the inbox.
- Secrets: env file 0600 and refused if looser; settings snapshot reports keys
  as set/unset only; credentials the owner texts are stored per-service and
  never echoed.
- The browser can only run on the agent's own Chrome profile: the MCP server
  declaration pins the CDP endpoint, so it is enforced rather than advised.
- iMessage-bound effects use durable, idempotent delivery rows; Chat hub events are
  fire-and-forget and sequenced.
