# OpenInstinct on the omo engine

How the daemon uses the omo engine — the npm package `@code-yeongyu/senpi` that
the `omo-ai` launcher runs — and the facts about it that the code relies on.
Verified against `@code-yeongyu/senpi` 2026.9.4-3; re-check this file when the
engine is bumped.

## What the engine provides

- `@code-yeongyu/senpi` is a normal dependency in `daemon/package.json`, next to
  `typebox` (tool schemas) and `chrome-devtools-mcp` (the browser). Nothing is
  downloaded at install time; the release archive carries the engine inside
  `node_modules`.
- One seam: `daemon/src/omo-session/omo-runtime.ts`. It builds engine services
  (`createOmoServices`), resolves the model pattern from `config.json`
  (`resolveModel`, falling back to the first available model with a warning),
  and opens a session (`openOmoSession`). `main-session.ts` and
  `children/runners/omo-inprocess.ts` never call the engine directly.
- Engine state: `~/.openinstinct/omo` (`auth.json`, `models.json`,
  `settings.json`, `sessions/`). `env-bootstrap.ts` pins
  `SENPI_CODING_AGENT_DIR`, `OMO_CODING_AGENT_DIR` and `PI_CODING_AGENT_DIR` to
  it before the engine loads and seeds the three files when missing; the launchd
  plist carries the same three keys. The host's `~/.omo/agent` is read once by
  `scripts/install-omo-state.sh` (credentials + models) and never again.

## Session shape

```ts
const services = await createOmoServices({ cwd, agentDir, appendSystemPrompt: [soul, runtime], extensions: [enforcer] });
const { model } = await resolveModel(services, "anthropic/claude-sonnet-4-5");
const session = await openOmoSession({ services, cwd, sessionDir, sessionFile, model, customTools });
```

- Services are created with an in-memory `SettingsManager` (`steeringMode: all`,
  `followUpMode: all`, `compaction.enabled: false`, `quietStartup: true`) and a
  resource loader that loads no user extensions, skills, prompt templates,
  themes or context files; the daemon's own extension is passed inline.
- The system prompt is the engine's default plus `persona/OMO_SOUL.md` and
  `persona/RUNTIME.md` through `appendSystemPrompt`.
- `openOmoSession` opens or creates the transcript (`SessionManager.open` /
  `SessionManager.create(cwd, sessionDir)`), excludes the engine tools the
  daemon does not want the model to have (`eval`, `schedule_wakeup`, goal and
  todo tools, `apply_patch`, `generate_image`, `read_video`, `monitor`,
  `powershell`), calls `session.bindExtensions({ mode: "json" })` — the step
  that emits `session_start` and attaches MCP servers — and then sets steering
  mode `all` and turns engine auto-compaction off (the daemon compacts at 50 %).
- `AgentSession` surface used by the daemon: `prompt(text, { images })`,
  `steer(text)`, `abort()`, `dispose()` (synchronous), `subscribe(listener)`,
  `compact()`, `getContextUsage()`, `setSessionFastMode()`,
  `isFastModeActive()`, `model`, `sessionFile`, `sessionId`, `messages`,
  `getActiveToolNames()`. There is no interrupt mode to set: `steer()` already
  waits for the in-flight tool call.
- Events the daemon matches: `message_update` with
  `assistantMessageEvent.type === "text_delta"`, `message_end`,
  `tool_execution_start`, `agent_end`.

## Custom tools

Tools are engine `ToolDefinition`s built through `omo-session/tool-types.ts`
(`CustomTool` alias, `Type` from `typebox`, `Compile` from `typebox/compile` for
validation): `delegate_background`, `send_image`, `monitor_author`,
`memory_search`, `memory_capture`, `memory_audit`, `report_progress`,
`child_status`, `child_nudge`. `execute(toolCallId, params, signal, onUpdate,
ctx)` returns `{ content: [{ type: "text", text }], details }`.

## Browser

`browser/chrome.ts` launches (or reuses) a daemon-owned Chrome on
`~/.openinstinct/chrome-profile` with `--remote-debugging-port=9223`, probing
`http://127.0.0.1:9223/json/version` first because a second Chrome on the same
profile refuses to start. `browser/enforce.ts` registers `chrome-devtools-mcp`
as MCP server `browser` attached to that URL (`lifecycle: eager`,
`startupTimeoutMs: 15000` — the engine's default startup race is 250 ms, too
short for the server's boot), so the model sees `mcp_browser_navigate_page`,
`mcp_browser_take_snapshot`, `mcp_browser_take_screenshot`, `mcp_browser_click`,
`mcp_browser_fill`, `mcp_browser_evaluate_script`, `mcp_browser_wait_for`,
`mcp_browser_list_pages` / `new_page` / `select_page` / `close_page` and the
other tools in `includeTools`. The same extension blocks the engine's spawner
tools (`task`, `subagent`, `job`, `eval`, `workflow`, `team_create`,
`schedule_wakeup`), enforces the per-turn tool budget, the forbidden-path rules
and the main-session bash rule (`timeout <= 20` or `run_in_background: true`).

## Accounts and models

`settings/service.ts` uses the engine in-process: `modelRuntime.getAvailable()`
for `models.list`, `listCredentials()` for `accounts.list`,
`authStorage.getOAuthProviders()` for `accounts.providers`,
`authStorage.login(provider, callbacks)` for `accounts.login` (the auth URL goes
to the panel; a pasted code answers the engine's prompt through
`accounts.login.finish`), `authStorage.logout()` for `accounts.logout`, a
provider block in `models.json` for `providers.custom`, and
`openai.serviceTier` in `settings.json` for fast mode.
`settings/credential-adopt.ts` discovers credentials in `~/.omo/agent/auth.json`,
`~/.codex/auth.json` and `~/.claude/.credentials.json` and copies one into
`~/.openinstinct/omo/auth.json` only after the owner clicks **Adopt**.

## External children

`children/runners/omo-external.ts` runs the vendored engine CLI
(`node_modules/@code-yeongyu/senpi/dist/cli.js`, `dataPaths().omoCli` in the
installed layout) as `bun <cli> -p --mode json --no-extensions --no-skills
--no-prompt-templates --no-themes --no-context-files --session-dir <dir> --model
<provider/id> "<prompt>"` with the agent-dir variables set, and maps the JSON
event stream (`message_update`, `agent_end`) onto the child result. It is an
explicit adapter; production children run in-process.

## Engine facts worth remembering

- Runtime imports come from the package root only (`createAgentSessionServices`,
  `createAgentSessionFromServices`, `SessionManager`, `SettingsManager`,
  `resolveCliModel`, …); deep `dist/` imports do not resolve, and `AuthStorage`
  is reached through `services.authStorage`.
- `typebox` has no `safeParse`; validate with `Compile(schema).Check(value)`.
- The engine refuses a model whose context window is below roughly 17k tokens
  with the default tools; the offline test provider (`oi-test/oi-model` in the
  test files) declares 200 000.
- Without `noExtensions: true` the engine seeds its default user extensions
  into `<agentDir>/extensions`; the daemon always passes it.
- `auth.json` maps provider id → `{ type: "oauth", access, refresh, expires }`
  or `{ type: "api_key", key }`; `models.json` custom providers use
  `{ name, baseUrl, apiKey, api, models: [{ id, name, reasoning, input, cost,
  contextWindow, maxTokens }] }` with `api` one of `openai-completions`,
  `openai-responses`, `anthropic-messages`.
- Non-interactive permission preset defaults to `full-access`.

## Verifying a change

```sh
bunx tsc --noEmit -p tsconfig.json
bun test daemon/test
bun scripts/smoke/omo-chat-roundtrip.ts                       # temp HOME, real credentials, chat.send round trip
OI_REAL_OMO=1 bun test daemon/test/children/real-omo.integration.test.ts
OI_REAL_SESSION=1 bun test daemon/test/omo-session/real-session.integration.test.ts
```
