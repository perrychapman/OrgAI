# OrgAI – notes for agents working in this repo

Electron + electron-vite + React 19 + TypeScript. React Flow (`@xyflow/react`) for both the org chart editor and
the live view; `@dagrejs/dagre` for tree layout; zustand for renderer state.

- `npm run typecheck` runs both tsconfigs (node + web). Keep it clean. TypeScript 7: no `baseUrl`, paths are `./`-relative.
- Shared types live in `src/shared/types.ts`. Anything crossing IPC must be defined there and be structured-clone safe.
- The renderer only sees normalized `RunEvent`s. Vendor specifics stay inside `src/main/runtime/<provider>.ts`.
- Adding a provider: the adapter is SDK event mapping plus hook mechanics only (spawn enforcement, deciding isolation
  at spawn time, reporting an agent's real cwd, exposing tools). Harness tools live in `harnessTools.ts`, role
  prompts in `prompts.ts`, activity strings in `activity.ts`, the worktree state machine in `integration.ts`
  (`WorktreeIntegrator`, adapter supplies `notify`), permission scopes in `permissionRules.ts`. `mock.ts` is the
  reference adapter; `npm test` runs vitest (`*.test.ts` beside the modules) and never spends tokens.
- Unattended execution: the work-run plan (`RunPlan` on `RunRecord`, `plan.updated` events) is written by the plan
  tools in `harnessTools.ts` through `RuntimeContext.updatePlan` (RunManager stores, persists and broadcasts it).
  `continuation.ts` holds the pure `nextNudge` decision and the `ContinuationDriver` every adapter calls at turn end
  (`turnEnded`), on user messages, on interrupt (`hold`) and at session end; the adapter only delivers the nudge
  through its harness-message path (Claude: `notifyOrchestrator`). Never nudge setup runs.
- Cross-run messages (`message_run`) never override the user: RunManager gates delivery (`peerDeliveryBlocked`) while
  a run is held by an interrupt, usage-limited (`ActiveRun.limitHold`) or has pending cards, holds them in the run's
  inbox (at most `RUN_MESSAGE_QUEUE_LIMIT` 20) and flushes them oldest first, one chained flush at a time, after the
  user's next successful `send()` or the last card's answer. Only the user's send lifts a hold; peers never do, not
  even after an auto-resume. `send()` never waits on that flush. Each `receive()` is raced against
  `RUN_MESSAGE_RECEIVE_TIMEOUT_MS` (30 s): on timeout both runs get a warning, the chain moves on and a direct sender
  gets refusal `timeout`. Caps: 40 per sender per target, 100 inbound per run. A direct `RuntimeSession.receive()`
  call is ungated, so always deliver through RunManager.
- Windows run with `sandbox: false` because the preload is ESM (`index.mjs`) and Electron cannot sandbox an ESM
  preload. The fix is building the preload as CommonJS and enabling the sandbox. Navigation guards
  (`shouldBlockNavigation` in `windowScope.ts`) cover will-navigate, will-redirect and will-frame-navigate and fail closed.
- Claude Agent SDK facts verified against v0.3.312 (see `scripts/smoke-*.mjs`):
  - `task_started` (system message) arrives before the `SubagentStart` hook and carries `task_id` (= `agent_id`),
    `tool_use_id` of the spawning Agent call, `subagent_type`, `description`, optional `parent_task_id`.
  - The `toolUseID` argument of `SubagentStart`/`SubagentStop` hooks is a hook invocation id, not the Agent tool_use id.
  - Subagent assistant/user messages carry `agent_id` and `parent_tool_use_id`.
  - Subagents run in the background by default; the orchestrator's turn may end (`result`) and auto-resume when a report lands.
  - `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1` removes Explore/Plan/general-purpose so only org-chart roles exist.
  - Plan usage (`scripts/smoke-usage.mjs`, Max login): `q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })`
    answers right after init. `rate_limits.five_hour` / `.seven_day` are `{ utilization: 0-100, resets_at: ISO string }`;
    `seven_day_opus` / `seven_day_sonnet` were null and the per-model weekly window came as
    `rate_limits.model_scoped: [{ display_name: 'Fable', utilization, resets_at }]`. A `rate_limit_event` arrives on every
    normal request (status `allowed`); its `resetsAt` is epoch **seconds** and `utilization` a 0-1 **fraction**, and it
    carries an undocumented `unifiedWindows` map. Mapping lives in `src/main/runtime/usage.ts`.
  - In-process MCP tools (`createSdkMcpServer` + `tool` with zod shapes) surface as `mcp__<server>__<tool>` in
    `PreToolUse`, `canUseTool` and `tools` lists. Under `acceptEdits` they still hit `canUseTool`, so the Claude
    adapter auto-allows `mcp__orgai__*`. A handler may block indefinitely; the model receives its returned text.
  - `PermissionMode` includes `'auto'` (a model classifier approves or denies each call and prompts through
    `canUseTool` only when it cannot decide) and `'dontAsk'` (deny anything not pre-approved). Bare `allowedTools`
    entries (e.g. `"WebSearch"`) approve the whole tool before `canUseTool` is consulted (warning
    `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`). Verified in `scripts/smoke-network.mjs` on haiku with a Max login: a whole
    spawn + ListAgents + SendMessage exchange ran under `auto` with zero `canUseTool` calls.
  - `AgentInput.name` injected from `PreToolUse` (`updatedInput`) makes a spawned agent addressable: `ListAgents` lists
    it as `worker-1 [ref] · worker · running`. The SendMessage input seen by hooks is
    `{ to, message, summary, type: 'message', recipient, recipient_kind: 'name' | 'main', content }`. A subagent
    cannot address the root by its role name: the main conversation's address is `"main"` ("No agent named
    'orchestrator' is reachable"). Messages to a report are queued for its next tool round; if it already finished it
    is resumed with the message. `network.ts` maps `main`/`orchestrator` to the root for the canvas.
  - Images (`scripts/smoke-images.mjs`, haiku, Max login): a streaming-input session that starts with a text prompt
    accepts a later user message whose `content` is `[{ type: 'image', source: { type: 'base64', media_type:
    'image/png', data } }, { type: 'text', text }]`, exactly what `claude.ts` `send()` pushes via `userContent()`.
    A 16x16 solid red PNG sent mid-session was answered "Red". Each turn emits its own `init` and `result`.
  - A SendMessage to a finished subagent resumes it, and the SDK emits `task_started` with `task_id` = that agent and
    `parent_task_id` = the messaging agent. A `task_started` for a known agent is therefore a resume, never a re-parent
    (`agentTree.resolveParent`). Observed in a persisted run record on 0.3.312; not yet reproduced by a smoke script.
  - Continuing a run resumes the chain's newest run; RunManager refuses while another live run holds the session.
    Unverified: whether a resumed session reports the same session_id (`forkSession: true` gives a new one); the chain
    therefore follows resumedFrom links and sessionId both (`runManager.sessionChain`). Verified by unit tests only.
- Concurrent runs and cross-run messaging: any number of runs may be live at once (verified by RunManager unit tests on the
  mock adapter). Work-run roots get `list_runs` / `message_run`; RunManager delivers through `RuntimeSession.receive()`,
  framed by `prompts.ts` `peerMessageText` as peer information, never a user instruction. Opt-in per project
  (`Project.runMessaging`, both ends), capped per run pair, never for setup-like runs. Unverified: that the Claude
  adapter's notifyOrchestrator delivers a peer message mid-turn (no smoke script). `window:openRun` opens a run-scoped
  window at `#/run/<projectId>/<runId>`; `runs:listLive` lists live runs across projects.
- Setup sessions (`RunSummary.kind === 'setup'`) run the built-in Architect from `src/shared/setup.ts`, never the
  project's roles. Proposals go through `RuntimeContext.requestProposal`; applying them is `src/main/setup/service.ts`.
  - A `PreToolUse` hook answering `permissionDecision: 'allow'` bypasses the permission system in every mode
    (verified in `scripts/smoke-permission-hook.mjs` on haiku under `dontAsk`: the first Bash call was denied, the
    in-process MCP tool got through on the hook alone, and the retried Bash call ran with zero `canUseTool` calls).
    `dontAsk` still runs trivially safe commands such as `echo` without any rule. This is how live permission grants
    work: `request_permission_rules` (every agent) blocks on a card; a grant lands in `RuntimeContext.allowedRules()`
    (saved file rules re-read plus run grants) and the Claude hook allows matching calls through `ruleMatch.ts`,
    so no session restart is needed. `updatedPermissions` can only be returned from `canUseTool`, which the
    classifier never reaches for a call it denies outright.
- Worktree isolation (verified with `scripts/smoke-worktree.mjs`): `isolation: "worktree"` on an Agent call can be
  injected from `PreToolUse` via `updatedInput`. The CLI creates `<repo>/.claude/worktrees/agent-<id>` on branch
  `worktree-agent-<id>` from HEAD, confines Edit/Write to it, and leaves it behind uncommitted when the subagent
  stops. Registering `WorktreeCreate`/`WorktreeRemove` hooks makes the host responsible for creating/removing the
  worktree (the hook must return `worktreePath`), so do not register them just to observe. Commit and merge are
  the harness's job: `src/main/runtime/worktrees.ts`.
- Smoke tests cost real tokens (fractions of a cent on haiku). Do not run them in loops.

## Connections, Codex, LiteLLM, MCP and macOS

Each fact says how it was checked. "Unverified" means it comes from docs or typings and no live run has confirmed it.

- Connections and adapters are separate. The connections are `anthropic`, `openai` and `litellm`, and the adapters are
  `claude` and `codex`. `adapterForProject` (`src/shared/defaults.ts`) picks the adapter from the connection, or for
  LiteLLM from the root role's model family. A work run whose roles mix families is refused before the run exists.
  `ConnectionService.runConnection` builds the per-run `RunConnection` (env, API key, Codex home). Verified by unit tests.
- Codex (`@openai/codex` 0.166.0):
  - `codex app-server` speaks JSON-RPC over stdio, one object per line. The `jsonrpc` field is not needed. The
    client sends `initialize` and then `initialized`. Verified offline against `generate-json-schema` /
    `generate-ts --experimental` (token-free).
  - OrgAI uses its own `CODEX_HOME` at `<data>/codex`, so the user's `~/.codex` config and MCP servers never load.
    Config goes in as `-c key=value` TOML overrides. An API key travels only in the environment
    (`model_providers.orgai.env_key`), never in argv. Verified by unit tests (`codexProtocol.test.ts`).
  - Concurrent Codex runs share that one `CODEX_HOME` at `<data>/codex` (`src/main/connections/service.ts`), each
    with its own app-server. Whether they race on auth refresh or the session database is unverified.
  - Harness tools are `dynamicTools` on `thread/start`, answered through `item/tool/call`. `update_plan` collides
    with a built-in Codex tool, so it is exposed as `orgai_update_plan`. Subagents are threads started by the
    harness's own `spawn_agent` tool. Unverified: the wire shapes come from the schema, and `scripts/smoke-codex.mjs`
    (spends tokens, consent required) has not been run.
  - It is unverified that dynamic tools survive `thread/resume`. The adapter's MCP restart and run continuation
    assume they do.
  - The ChatGPT login (`account/login/start` with `chatgpt` / `chatgptDeviceCode`), `model/list` and
    `account/rateLimits/read` are unverified (schema-derived). The device-code `expiresAt` field is a guess and
    is optional.
- LiteLLM: `/v1/models` and `/model/info` discovery is unverified against a live proxy. The Claude adapter reaches
  LiteLLM through `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` and maps tiers through
  `ANTHROPIC_DEFAULT_{FABLE,OPUS,SONNET,HAIKU}_MODEL`. The Codex adapter reaches it with an `orgai` model provider at
  `<base>/v1`. Both routes are unverified at runtime: `scripts/smoke-litellm.mjs` is free without `--yes` and spends
  tokens with it.
- MCP:
  - Claude runs set `strictMcpConfig`, so only the project's enabled servers plus run-scoped installs load (this
    also stops plugin-declared MCP servers). An approved mid-run install is attached with `Query.setMcpServers`.
    Covered by unit tests only; `setMcpServers` at runtime is unverified.
  - `request_mcp_install` needs exact pinned versions and the user's approval. A denial tells the agent to find
    another route. The calling agent's id reaches `McpInstallRequest.agentId`: Codex derives it from the thread, and
    Claude reads it from the PreToolUse `agent_id`. Claude matches the MCP call by a tool_use id in `extra._meta` if
    present (the key is unverified), otherwise first-in-first-out per tool name. Verified by unit and mock tests.
  - Registry search hits `https://registry.modelcontextprotocol.io/v0.1/servers`. The shape is unverified live,
    the tests use a fixture, and registry content is untrusted data.
  - `mcp:test` (`src/main/mcp/probe.ts`) runs initialize + tools/list without a run. It covers stdio and streamable
    HTTP but not legacy SSE. Verified by a stdio fixture server and fake-fetch tests.
  - Secret values live only in `SecretStore` (Electron `safeStorage`, `<data>/secrets.json`). They never cross IPC
    and are redacted from probe errors. `projects:save` (`saveFromRenderer`) keeps the stored `mcpServers`/`plugins`.
- macOS is untested; nobody has run it on a Mac yet (`docs/macos-testing.md` is the checklist).
  - `applyShellPath()` runs right after `installLogging()` and merges the login shell's PATH with well-known dirs.
    GUI launches otherwise miss Homebrew, nvm and similar.
  - `listClaudeBinaries` also tries `~/.claude/local/claude`, `~/.local/bin/claude`, `/opt/homebrew/bin/claude` and
    `/usr/local/bin/claude`.
  - The app menu is installed on darwin only. Closing the window keeps the app running, and `activate` re-creates
    the window.
  - These pieces are unit-tested where they are pure. Packaging (`dist:mac`, `dist:mac:unsigned`,
    `build/entitlements.mac.plist`) is unverified.
  - `ORGAI_DATA_DIR` replaces userData and puts the logs under it. e2e (a fresh temp dir per script) and CI use it to
    keep off the real profile. package.json `productName: "OrgAI"` names the packaged app (`app.name`, log dir).
  - The `pathKey` symlink fix (macOS `/tmp` is `/private/tmp`) and the OrgAI identity fallback for commit and merge are
    unit-tested with a junction/symlink and a git that has no identity config.
  - CI (`.github/workflows/ci.yml`) runs on windows-latest and macos-14. Release legs run on native-arch runners
    (macos-14 arm64, macos-15-intel x64). Nothing in CI spends tokens.
  - Branches: `dev` is integration (agent runs, PRs, dependabot), `main` is stable and protected. CI runs on both;
    `release.yml` only releases `v<version>` tags whose commit is on `main`.
  - The first real CI run has not happened yet. Open items: winCodeSign extraction on windows-latest, macos-15-intel
    really being x64, e2e:free on mac (a possible Keychain prompt), unsigned dmg/zip with hardenedRuntime, the publish job.

<!-- orgai:architecture -->
## Architecture and conventions

Read `.orgai/ARCHITECTURE.md` before changing code. It records the agreed stack, module layout, conventions and commands for this project. Keep it current when they change.
