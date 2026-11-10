# Connections, Codex, LiteLLM and MCP

Tiers and model discovery, connections vs adapters, multi-provider, proxies, child env isolation, Anthropic status and auth failures, Codex, LiteLLM, MCP, MCP library and OAuth, connectors (catalog and gallery UI). Moved out of CLAUDE.md on 2026-11-07; see CLAUDE.md for the index.

## Main

- Model-agnostic defaults: every default is a tier ('top' | 'deep' | 'everyday' | 'fast', `ModelSetting`) resolved
  through the connection's `tierModels` (`defaults.ts` `modelForTier` / `resolveModelSetting`), never a vendor alias.
  The default chart, `newProject`, built-in roles (fallback 'inherit'), run titles, org chart proposals and the drafter
  (`draft.ts` `toRoles` maps tier names per connection) follow it. Near the plan limit, deep/top spawns move to the
  everyday tier (`Project.preferEverydayNearLimit`, unset = automatic, see Self-configuration; the legacy
  `preferSonnetNearLimit` is mirrored on renderer saves).
  Verified by unit tests.
- Model discovery: Anthropic via `ClaudeAdapter.listModels` (SDK `supportedModels()`, typings 0.3.312 sdk.d.ts:3096,
  no prompt, `strictMcpConfig`, 10 s timeout). The live list (whether it has 'default', which ids, descriptions that
  feed `catalog.ts` `tierFromDescription`) is UNVERIFIED: `scripts/smoke-models.mjs` (token-free, spawns the CLI)
  has not been run. Anthropic `/v1/models` is not used. The scheduled refresh and autoTiers are unit-tested only.
- Community prices (LiteLLM's public JSON) are unit-tested with a fake fetch; the live JSON shape is unverified.
- Connections and adapters are separate. The connections are `anthropic`, `openai` and `litellm`, and the adapters are
  `claude` and `codex`. `adapterForProject` (`src/shared/defaults.ts`) picks the adapter from the connection, or for
  LiteLLM from the root role's model family. Mixed families (owner decision 2026-11-03; one connection per project
  stays): on LiteLLM the orchestrator's model picks the adapter and reports may run any model the proxy serves;
  `adapterForProject` still lists them in `mismatched` (meant for an informational notice; the renderer's `project-start-refusal` now follows `lib/remap.ts` `projectStartRefusal`, see Renderer "Multi-provider org charts") and RunManager
  `choose` logs one info line naming them and starts. `defaults.ts` `mixedFamilyRefusal` refuses a work run before
  it exists only when a LiteLLM root has no family ('inherit' or no roles) while reports need the other adapter
  ("...has no model of its own... Give the orchestrator a model."), or on anthropic / openai with a role of another
  family (their catalogs are single-family, so this cannot come from a picker; unit-tested invariant). Setup-like
  runs never check. The Claude adapter passes a report's model id unchanged to `AgentDefinition.model` (no alias
  table; `ANTHROPIC_DEFAULT_*_MODEL` still maps tier aliases) and the Codex adapter starts a report thread on its
  role's id through the `orgai` provider (`codexModelFor` still drops tier names and bare Claude aliases such as
  'sonnet', so such a report inherits its parent's model). Agent import warns only for the no-root-family case.
  Verified by unit tests (types.test.ts, runManager.test.ts, codex.test.ts, claude.test.ts). Unverified live: Claude
  CLI tool calling against a non-Claude model behind the proxy, and LiteLLM serving `/v1/responses` for non-OpenAI
  models on the Codex side (`scripts/smoke-litellm.mjs` can check later, with consent).
  `ConnectionService.runConnection` builds the per-run `RunConnection` (env, API key, Codex home). Verified by unit tests.
- Multi-provider org charts (2026-11-07; docs/design/multi-provider.md, ARCHITECTURE.md "Multi-provider org charts (bridged reports)"):
  - `Role.connection` is read only through `roleConnection`; the root always uses the project's connection.
    `AdapterChoice.bridged` lists roles that run in a child session (runtime/bridge.ts `BridgedSessions`) on their own
    adapter and RunConnection (`ConnectionService.runConnectionFor`).
  - Claude and mock start a bridged role with `delegate_agent`. Codex starts it through `spawn_report`, which calls
    `ctx.bridge.spawn`.
  - A child ctx has `bridgedChild` set: no root-audience tools, a report prompt (`PromptFlags.bridged`) and no
    worktree. Adapters pass `bridgedRoles`, `bridgeVia` and `bridged` to buildRolePrompt and never give a bridged role
    a native AgentDefinition or spawn.
  - Mock marker: `[mock:bridged]`.
  - `delegate_agent` `background: true` (orchestration-efficiency 4.2, 2026-11-10): the tool answers with the handle once
    the child exists and hands the result (`bridgedResultText`) to `HarnessToolHooks.backgroundDelegation.ended`; the
    adapter (Claude, mock) counts it as a live report (`liveReports`, `lastReportEndedAt`, `settlement().quiescent`)
    and delivers it as a harness message (Claude `notifyOrchestrator`). It runs in the foreground, with "Ran in the
    foreground (<reason>)." first, for a non-root or unconfirmed caller, a required delegation (`receiptBearingSpawn`)
    or no hook. A child the harness stopped (`BridgeSpawnResult.stopped`: interrupt or run end) or a result while held
    waits for the user's next message (heldNotices); nothing is delivered once the session is ending. Mock marker
    `[mock:bridged-bg]`.
  - Verified by unit tests, fakes and the mock only; nothing live.
- Proxy connections (2026-11-06; ARCHITECTURE.md "Proxy connections"): the single LiteLLM connection became `AppSettings.proxies` (`ProxyConnection`, kind 'litellm' | 'openai-compatible', at most 20); older text in this file that says `connections.litellm` / `'litellm'` means "a proxy" now (the migrated original keeps id 'litellm' and its key). Use `connectionIds(settings)`, `connectionRecord` / `proxyOf`, `connectionName`, `isBuiltinConnectionId` (never `=== 'litellm'`); `CONNECTION_IDS` is built-ins only. IPC `connections:createProxy` / `removeProxy`, CLI `orgai connections proxy ...`, event `connections.changed`, mock host `mock-proxy.example.com` (key `mock-bad-key` is refused). Never put a real proxy host or key in code, tests or docs. Unit-tested only; the renderer still shows each proxy with the old LiteLLM card (compile fixes only) until the UI pass.
- Default connection: `projects:create` passes `ConnectionService.prepareNewProject` to `ProjectStore.create`. A new
  project takes the effective default connection (`effectiveDefault()`, see Self-configuration) when `creationConnection` (`defaults.ts`) finds it usable (anthropic
  always, openai when enabled, litellm when enabled with a base URL and a stored key) and the connection maps every
  tier the roles use; otherwise it stays on anthropic. It gets that connection's provider label, tier models (the
  'switched' remap) and adapter. Mock projects and existing projects are untouched. Verified by unit tests.
- Child env isolation (`src/main/runtime/childEnv.ts` `isolateClaudeEnv`, used by claude.ts `buildEnv`,
  `completionEnv` and `probeUsage`, and by `claude auth status`): the inherited env loses every routing, model,
  gateway and cloud-provider variable (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`,
  `ANTHROPIC_SMALL_FAST_MODEL`, `ANTHROPIC_DEFAULT_*`, `CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_CODE_USE_*`,
  `ANTHROPIC_{BEDROCK,VERTEX,FOUNDRY,AWS}_*`, `ANTHROPIC_CUSTOM_HEADERS`, `ANTHROPIC_BETAS`, `ANTHROPIC_PROFILE`,
  the workload-identity family `ANTHROPIC_{IDENTITY,SERVICE_ACCOUNT,WORKSPACE,FEDERATION}_*`,
  `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_UNIX_SOCKET`, `AWS_BEARER_TOKEN_BEDROCK`, `CLOUD_ML_REGION`,
  `VERTEX_REGION_*`, `CLAUDE_CODE_SKIP_*_AUTH` and every `CLAUDE_CODE_{DISABLE,ENABLE}_*` behaviour switch). Only the
  connection's env (or OrgAI's own settings, merged after isolation) sets them. The bundled CLI of SDK 0.3.312 names
  about 80 `CLAUDE_CODE_DISABLE_*` and 30 `CLAUDE_CODE_ENABLE_*` switches (grep of the SDK package): gateway and
  API-surface ones (`DISABLE_EXPERIMENTAL_BETAS`, `DISABLE_ADAPTIVE_THINKING`, `ENABLE_GATEWAY_MODEL_DISCOVERY`, `ENABLE_FINE_GRAINED_TOOL_STREAMING`, `ENABLE_PROXY_AUTH_HELPER`,
  `DISABLE_AUTH_REFRESH_LOCK`, `ENABLE_XAA`, `DISABLE_LEGACY_MODEL_REMAP`...), feature toggles and terminal UI ones
  (`DISABLE_MOUSE`, `DISABLE_TERMINAL_TITLE`...) that a headless SDK run does not need. OrgAI sets none of them
  (it sets only `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` / `_MAX_CONCURRENT_SUBAGENTS`, and on work runs
  `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1`, added after isolation). The explicit allows
  (`CLAUDE_CODE_ALLOWED_SWITCHES`) are `CLAUDE_CODE_ENABLE_TELEMETRY` (an organisation's OpenTelemetry opt-in;
  `OTEL_*` passes through) and the privacy opt-outs `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and
  `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY`. Kept as
  legitimate Anthropic auth sources: `CLAUDE_CODE_OAUTH_TOKEN` (and its refresh token) and `CLAUDE_CONFIG_DIR`.
  `ANTHROPIC_API_KEY` reaches a run only on the anthropic connection for an API-key project, through
  `RunConnection.env` (copied from the project's `auth.envVar`), so run titles get it too; `buildEnv` also copies
  the inherited `auth.envVar` value for a non-proxy API-key project. On LiteLLM the inherited
  API key, OAuth token (and refresh token) and `CLAUDE_CONFIG_DIR` (it holds the claude.ai login) are dropped, so
  only the connection's `ANTHROPIC_AUTH_TOKEN` authenticates. Drafts (no connection) keep an inherited `ANTHROPIC_API_KEY`. Verified by unit tests only; the
  bundled CLI's actual auth choice with this env has not been checked in a live run.
- Anthropic status (`anthropicAuth.ts`), checked token-free on the bundled CLI 2.1.312 (SDK 0.3.312) with a temp
  `CLAUDE_CONFIG_DIR`:
  - `claude auth status --setting-sources project` is rejected (unknown option); the global form
    `claude --setting-sources project auth status` is accepted. Verified.
  - With an `env.ANTHROPIC_AUTH_TOKEN` in the config dir's `settings.json`, plain `auth status` reports
    `loggedIn: true, authMethod: 'oauth_token'`; with `--setting-sources project` it reports `loggedIn: false,
    authMethod: 'none'` and exits 1 with the JSON still on stdout. Verified.
  - `authMethod` values seen: `claude.ai` (a /login), `oauth_token` (`CLAUDE_CODE_OAUTH_TOKEN` or an
    `ANTHROPIC_AUTH_TOKEN` env, indistinguishable), `api_key` with `apiKeySource`, `none`. Verified.
  - The project settings source reads `<cwd>/.claude/settings.json`, so the status runs in `os.tmpdir()`, never the
    home dir. The binary is the one resolver `runtime/claudeBinary.ts` `claudeExecutable(env)` (see Wave 7, Agent runtimes),
    run with `execFile` only, no shell, absolute path, no bare `claude` fallback; nothing resolved reports
    `claudeRuntimeMissingMessage`, and a `claude` found on PATH or in a well-known folder (`claudeWellKnownPaths`) is only
    named in the error (a .cmd / .ps1 one with "set ORGAI_CLAUDE_PATH to the claude executable it starts"). A CLI that rejects
    the flag is retried without it and its detail says user settings could not be excluded. The disconnected detail tells the
    user to run claude and /login, set an API key, or choose another default connection. Wiring is unit-tested with fake file
    systems and an injected runner.
- Auth failures in a run: `activity.ts` `isAuthFailure` and `authFailureMessage(connection)`. A failure is the SDK
  assistant `error: 'authentication_failed'`; the exact bare CLI reply "Invalid API key · Please run /login"
  (separator `·`, `-` or `.`, nothing else in the text), the only text match without an error flag; short text that
  starts with the CLI's wording ("API Error: 401", "OAuth token has expired"...) when the adapter reports an
  auth-related error (`isError`; a non-auth `errorCode` alone never counts); or auth words / 401 / unauthorized anywhere only with `isError`. The Claude
  adapter sets `isError` on an assistant message only for the codes in claude.ts `AUTH_ERROR_CODES`
  (`authentication_failed`, `oauth_org_not_allowed`, `cloud_credential_error`), never for rate_limit or
  billing_error, and on a result from `is_error`. The Claude adapter then ends the run
  `error` with that one-line message, writes a harness system row whose detail is the scrubbed raw text, and
  `complete()` throws it. `[mock:auth-fail]` drives the mock the same way. The live failure shape is unverified
  (from the 0.3.312 typings and the user's report).
- Codex (`@openai/codex` 0.166.0):
  - `codex app-server` speaks JSON-RPC over stdio, one object per line. The `jsonrpc` field is not needed. The
    client sends `initialize` and then `initialized`. Verified offline against `generate-json-schema` /
    `generate-ts --experimental` (token-free).
  - OrgAI uses its own `CODEX_HOME` at `<data>/codex`, so the user's `~/.codex` config and MCP servers never load.
    Config goes in as `-c key=value` TOML overrides. An API key travels only in the environment
    (`model_providers.orgai.env_key`), never in argv. Verified by unit tests (`codexProtocol.test.ts`).
  - Concurrent Codex runs share that one `CODEX_HOME` at `<data>/codex` (`src/main/connections/service.ts`), each
    with its own app-server. Whether they race on auth refresh or the session database is unverified.
  - `CodexAppServer.start` creates `CODEX_HOME` (mode 0o700) before spawning (issue #8). Verified token-free by
    fake-server unit tests; that codex 0.166.0 exits 1 on a missing dir was verified by the user. Exit errors
    (`codexExitMessage`) carry a redacted stderr tail (last 10 lines, 2,000 chars; exact env values redacted plus
    `maskKeyLike`). Still unverified: whether a LiteLLM proxy serves `/v1/responses` for GPT models.
  - Harness tools are `dynamicTools` on `thread/start`, answered through `item/tool/call`. `update_plan` collides
    with a built-in Codex tool, so it is exposed as `orgai_update_plan`. Subagents are threads started by the
    harness's own `spawn_report` tool (renamed from `spawn_agent` on 2026-11-08, with `message_agent` / `list_team`; the old
    names stay accepted through `canonicalNetworkTool` for threads saved before). **Codex's built-in multi-agent tools:** with
    the old names, `gpt-6-luna` managers called Codex's native `subAgentActivity` tools instead of the harness spawn even with
    `features.multi_agent(_v2)=false` (lab hierarchy trials: 7 of 8; `scripts/probe-codex-native-agents.mjs`, 2026-11-08,
    manager layer only, features off: old names 8/10 runs native, 2/10 harness spawns; new names 0/10 native, 10/10 spawned both
    reports). OrgAI now launches with those features off, interrupts and corrects any native item (one strike per turn, third
    strike fails the agent; `--strict-delegation` fails the run) and refuses tool calls and approvals from threads it did not start. Unverified: the wire shapes come from the schema, and `scripts/smoke-codex.mjs`
    (spends tokens, consent required) has not been run.
  - It is unverified that dynamic tools survive `thread/resume`. The adapter's MCP restart and run continuation
    assume they do.
  - The ChatGPT login (`account/login/start` with `chatgpt` / `chatgptDeviceCode`), `model/list` and
    `account/rateLimits/read` are unverified (schema-derived). The device-code `expiresAt` field is a guess and
    is optional.
  - The idle Codex plan-usage probe (`probeCodexUsage`: boot, idle, usage:refresh) runs only while the openai
    connection is in use (`connectionInUse` in `src/shared/defaults.ts`: the default connection or a project on it),
    and never spawns the app-server otherwise; live Codex runs still report their own usage. Unit-tested.
- LiteLLM: `/v1/models` and `/model/info` discovery is unverified against a live proxy. The Claude adapter reaches
  LiteLLM through `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` and maps tiers through
  `ANTHROPIC_DEFAULT_{FABLE,OPUS,SONNET,HAIKU}_MODEL`. The Codex adapter reaches it with an `orgai` model provider at
  `<base>/v1`. Both routes are unverified at runtime: `scripts/smoke-litellm.mjs` is free without `--yes` and spends
  tokens with it.
  - Key spend: `ConnectionService.probeLiteLLMUsage` reads `GET {base}/key/info` (the key only as Bearer/x-api-key,
    no `key` param, `redirect: 'error'`, 10 s) through `litellm.ts` `parseKeyInfo` into `UsageStatus.spend`
    (`connection: 'litellm'`, `authMode: 'apiKey'`, no provider). Gated on enabled + base URL + stored key + in use
    (`connectionInUse`: the default connection or a project on litellm); any failure
    (500 without the proxy DB, 403, junk) is null. It is a keyed `UsageMonitor` extra probe ('litellm', boot / idle /
    usage:refresh), and index.ts re-reads it 15 s after a LiteLLM run ends (`RunSummary.connection`). Only the key's own
    budget is read, never a team budget. The renderer must keep the latest usage report per `connection`.
    - Spend by period (2026-11-04): `fetchLiteLLMSpend` (litellm.ts) reads /key/info (now also `info.total_spend` ->
      `UsageSpend.totalUsd`), then `GET /user/daily/activity/aggregated?start_date&end_date&api_key=<sha256 hex of the
      raw key>` (404 / 405: the paginated `/user/daily/activity`, one page only) and sums UTC calendar periods
      (`periodBounds` / `spendPeriods`: day of `updatedAt`, ISO week from Monday 00:00 UTC, calendar month; never
      rolling) into `UsageSpend.periods`; `parseDailyActivity` prefers `breakdown.api_keys[<hash>]`, counts 0 when
      only other hashes are listed, falls back to `metrics.spend`, keeps the first row per date and at most 400. A
      daily failure never nulls the probe: it sets one of `SPEND_PERIOD_NOTES` (types.ts; `noUser` 403, `unsupported`
      404 / 405 on both or `has_more`, `failed` anything else, a non-finite sum included). The hash is the proxy's
      stored key id and LiteLLM's user_api_key_auth accepts it as a credential (reviewer, read from source): it goes
      only to the proxy that gets the raw key in the same request's headers, is never logged and never enters the
      UsageStatus (tested). Routes, shapes and the hash filter come from LiteLLM v1.108.0 source; unit-tested with
      fixtures only, nothing verified live. Worst case the probe takes 3 x 10 s (three sequential calls).
  - Run cost: `/model/info` `model_info.{input,output}_cost_per_token`, `cache_read_input_token_cost` and
    `cache_creation_input_token_cost` become `ProviderModel.price` (+ `upstream` = litellm_params.model) in models.json;
    `runConnection` passes them as `RunConnection.pricing` (`pricing.ts` `pricingFromCatalog`, `priceFor` matches
    exact, normalized, then version-suffix-only). Claude prices each message from it (falls back to the CLI's rates for
    an unpriced model; `run.cost` = sum of agent costs) and Codex prices thread totals (`openAiMix`: input includes
    cached). These adapter estimates now only feed the legacy `AgentInstance.costUsd` / `run.cost`: RunManager
    re-prices every agent (see Usage and pricing above), and an unpriced model is unknown, not 0. The `/key/info` shape and the price fields are unverified against a live proxy
    (source-read only), as is which model name the proxy reports on messages and whether a resumed Codex thread's
    token totals include the earlier run. Prices appear only after the next discovery (connect or models refresh).
- MCP:
  - Claude runs set `strictMcpConfig`, so only the project's enabled servers plus run-scoped installs load (this
    also stops plugin-declared MCP servers).
  - Mid-run installs (2026-11-02): `request_mcp_install`'s result follows the adapter hook's `McpAttachResult`
    (`harnessTools.ts`: `{ prefix, availability: 'now' | 'after-idle', tools? }`). 'now' (mock) says "Its tools are
    available now as mcp__<name>__<tool>..." (tool names `datum`-quoted, at most 20); 'after-idle' (Claude, Codex) says
    they become callable only after the current turn ends and the harness will message the orchestrator once they are
    attached. Both add that calls may still ask the user for permission under the project's permission mode (nothing is
    auto-allowed on approval) and name the roles when the card restricts `roles`. Claude: `addMcpServer` calls
    `Query.setMcpServers` at once (errors surface immediately), reads tool names from `mcpServerStatus` (up to 5 s),
    and because whitelists are fixed per query (smoke facts below) re-creates the query with `resume` and agent
    definitions rebuilt from the live `ctx.mcpServers()` once the root is idle and no report, background task or card
    is open (`mcpRestartBlocker`), then sends `mcpAttachedNotice` through `notifyOrchestrator`. Codex restarts its
    app-server at idle (unchanged, now reported 'after-idle'). Verified by unit tests (fake `query()`) and the mock
    (`[mock:mcp-midrun]`, `mcpMidrun.test.ts`); the resume restart itself has never run live.
  - Claude restart details after the review fixes (7cc7e3b, 5ee83e5; each unit-tested in claude.test.ts with a fake
    `query()`, none run live):
    - Turn end (H1): a successful turn end with a restart pending and no blocker is withheld from the
      ContinuationDriver (`onTurnEnded`), so no plan nudge starves the restart; the attach notice wakes the
      orchestrator. If the restart is blocked, has no budget, fails while building options or throws, `releaseTurnEnd`
      hands the held turn end to the driver, so the run never stalls.
    - Notice (M1): server tool names are untrusted; only `^[A-Za-z0-9_-]{1,64}$` names are kept (`safeMcpToolNames`),
      at most `MCP_NOTICE_TOOL_CAP` 20 per server plus ", and N more", and server, tool and role names go through
      `datum()`. The could-not-attach notice quotes names and reason through `datum()` too.
    - Budget (M2): a restarted query gets `maxBudgetUsd` minus the run's cost so far; with less than
      `MCP_RESTART_MIN_BUDGET_USD` 0.01 left there is no restart (N7), a run warning, and the orchestrator is
      told the server comes with the next run. Whether the SDK counts the earlier cost against `maxBudgetUsd` on a
      resumed query is unverified.
    - Background tasks (M5): non-subagent tasks from `task_started` (ambient and `skip_transcript` ones excluded) are
      tracked until `task_notification` or `task_updated` completed / failed / killed; they block the restart
      (`McpRestartState.backgroundTasks`, blocker 'background tasks are still running') and the last one to end
      re-schedules it. Field shapes from the 0.3.312 typings only.
    - Failed starts (M4): the failure count resets at a restarted query's init. Failures before init: the 1st resumes
      again with the same servers, the 2nd resumes without the new servers (`droppedMcp`, the orchestrator is told), the
      3rd or no budget ends the run `paused` (never error; a throw from `buildOptions` inside `recoverRestart` counts as
      one more failed start, M2) with `pausedUntil` `MCP_RESTART_PAUSE_MS` (5 min) ahead, a
      `pauseReason`, `autoResume: !(held || capTripped)` (N1: an interrupted run waits for the user; RunManager schedules no resume for `autoResume: false`, runManager.test.ts; it gets no
      `pausedUntil`), an error log line and a harness transcript row. A user message that never reached a query that
      sent init (`undeliveredUserMessages`: in `preInit` or unread, harness messages excluded) also makes it
      `autoResume: false`, and the pauseReason adds "Your last message was not delivered; send it again to continue."
      (M1: never replayed, so it cannot arrive twice and RESUME_TEXT never replaces it; a peer message in `preInit` is
      dropped silently). The attach-notice fallback's error log line goes through `redactSecrets` (L3). Each new query gets a fresh input stream; after a
      failed start `replayInput` fills it with every message pushed before the dead query's init (`preInit`, cleared at
      init) plus any unread ones, each once, leaving out notices flagged `restart` because the next query sends them
      again (N2).
    - Pending list (L1): servers leave `pendingMcp` synchronously when the restart starts; their tool names travel with
      it as the notice's fallback.
    - Held runs (L7): before a restarted query starts, a run held by an interrupt or the window cap drops its queued
      plan nudges; other queued harness notices, and an attach or could-not-attach notice arriving while held, are
      delivered with the user's next message.
    - Second review (2026-11-02; N1 and N2 above, all unit-tested only, none run live): a rejected `announceAttached`
      logs a warning, sends a fallback notice with the known tool names (`mcpAttachedNotice` with `roles` undefined
      reads "Only roles the org chart grants it may call it.") and always calls `releaseTurnEnd` (N4). `restartBudget`
      returns null (no restart, the no-budget path) when less than `MCP_RESTART_MIN_BUDGET_USD` is left, so a
      restarted query never gets more than what is left (N7). The request_mcp_install result lists tool names through
      harnessTools.ts `safeMcpToolNames` (twin of claude.ts's, same `^[A-Za-z0-9_-]{1,64}$` rule, keep them in sync)
      with `datum(t, 64)` (N5, harnessTools.test.ts). Third check fixes M1, M2, L3 (6327506, unit-tested
      only, none run live). Open: N3, N6, N8 and the third check's L1, L2, L4 (ARCHITECTURE.md Risks).
  - Per-role MCP grants (`mcpGrants.ts` `mcpCallDenial`): the Claude PreToolUse hook (and the mock) checks every
    `mcp__<server>__<tool>` call against `mcpServersForRole` over the live server list (run-scoped installs and the
    card's `roles` included), root included, before any allow path; unknown callers and unknown or disabled servers
    are denied with a reason naming the role and server. It also enforces `mcp__orgai__*` audiences. The caller's role
    comes from one `callerRole` helper shared with the Skill gate: the hook's `agent_type` first, then the role
    recorded for the agent id (L5; this changed the Skill gate's order). The live list is read only for `mcp__` and
    the resource tools, in try/catch, and an unreadable list denies the call (L2). Resource tools (L3,
    `MCP_RESOURCE_TOOLS`: ListMcpResourcesTool, ReadMcpResourceTool, ReadMcpResourceDirTool; names from the 0.3.312
    typings, unverified live): a named `server` goes through the same per-role check (`orgai` allowed), a read without
    a server is denied, and a list without a server is allowed only when the role is granted every enabled server.
    This is the only grant boundary on Claude: `AgentDefinition.mcpServers` does not restrict a subagent (smoke,
    below). Codex does NOT enforce per-role MCP grants (every thread shares the app-server's servers; review M6,
    open). Unit-tested (claude.test.ts, mcpGrants.test.ts); the mock has the resource-tool gate too (mock.test.ts).
  - Agent-installed servers and server-level rules (M3): "installed this run" is every server an agent asked for
    through `addMcpServer` plus every live server with source 'agent' absent at run start (`agentInstalledServers`).
    For those, server-level rules are skipped in the hook's rule-allow path and dropped from `options.allowedTools` on
    every options build (`withoutServerRules`); exact single-tool rules still apply. The mock does the same (its only
    other parity with these fixes is L3; it attaches at once, so it has no restart). NOT covered: `mcp__<server>` allow
    rules the CLI loads itself from `<project>/.claude/settings.json`, and server-level session rules the CLI adds
    from an "always allow" suggestion. The mock filters its own session rules too (`sessionRules` in its ask path), so
    mock tests are stricter than Claude here. Unit-tested (claude.test.ts, mcpGrants.test.ts, mock.test.ts).
  - Server-level permission rules (`ruleMatch.ts` `mcpServerOfRule`, `matchingRule`): `mcp__<server>` and
    `mcp__<server>__*` match every tool with the exact prefix `mcp__<server>__` (a server name with `__` inside is not
    a server rule); `mcp__*`, other wildcards, `mcp__orgai` and `mcp__orgai__*` are refused by `isValidRule` and
    `isUnsafeAllowRule`. `permissionRules.ts` `ruleLabel` reads both forms as "All tools of <server>" (the rules card
    still shows raw strings). Unit-tested.
  - Skills have no mid-run path: `active.skills` is read once at run start and the Claude skill plugin is built once
    in `prepare()`, before the first query (a restart reuses it), so a skill added or granted during a live run reaches only the next run.
    `Query.reloadSkills()` / `reloadPlugins` exist in the 0.3.312 typings and are untested.
  - `request_mcp_install` needs exact pinned versions and the user's approval. A denial tells the agent to find
    another route. The calling agent's id reaches `McpInstallRequest.agentId`: Codex derives it from the thread, and
    Claude reads it from the PreToolUse `agent_id`. Claude matches the MCP call by a tool_use id in `extra._meta` if
    present (the key is unverified), otherwise first-in-first-out per tool name. Verified by unit and mock tests.
  - Registry search hits `https://registry.modelcontextprotocol.io/v0.1/servers`. The shape is unverified live,
    the tests use a fixture, and registry content is untrusted data.
  - `mcp:test` (`src/main/mcp/probe.ts`) runs initialize + tools/list without a run. It covers stdio and streamable
    HTTP but not legacy SSE. Verified by a stdio fixture server and fake-fetch tests. Network failures name their
    cause (`describeFetchFailure` reads undici's `error.cause`, at most 3 levels, a string cause counting as the last
    link: DNS "Could not look up <host>...", connection "Could not connect to <host> (<code>)...", certificate,
    redirect, closed socket "<host> closed the connection before answering." (UND_ERR_SOCKET, ECONNRESET, "other
    side closed"), answer timeout, else "fetch failed: <code or message>" with the detail cut at 300 chars; a
    sentence not starting with "Could not" gets the prefix "Could not reach the server: " (`reachabilityMessage`),
    never two; only the URL's host is named), initialize and tools/list are retried once on a fresh request with the
    same Mcp-Session-Id after a closed or reset socket (never a notification, never once the request signal is
    aborted), a non-Error throw (null, a string) still answers `{ ok: false }`, and the probe scrubs every declared
    secret slot plus any Authorization header value (the OAuth bearer `resolve()` injects is not in
    `secretHeaders`) from the error. A failed library or project test (not a needsAuthorization one) is logged at
    warn in main.log (`McpService.noteTestResult`): the line never carries headers or env values and names only the
    URL's host; a stdio test's `error` carries the redacted stderr tail after its first line and only that first
    line is logged. Verified by unit tests with a fake fetch only (the GitHub "fetch failed" report of 2026-11-04
    could not be reproduced: the user's stored token tested ok through the app); the log line itself has no unit
    test.
  - Secret values live only in `SecretStore` (Electron `safeStorage`, `<data>/secrets.json`). They never cross IPC
    and are redacted from probe errors. `projects:save` (`saveFromRenderer`) keeps the stored `mcpServers`/`plugins`.
  - A server with any unset `secretEnv` / `secretHeaders` slot never starts: `McpService.enabledServers` skips it and
    `skippedServers` feeds one run warning per server naming the empty slots (RunManager `prepareServers`). Unit-tested.
- MCP library and OAuth:
  - The app-wide library lives in `<data>/mcp-library.json` (`McpLibraryStore`). A project server with `libraryId` is a
    link: McpService refreshes its snapshot from the entry on every read (`withLibrary`, `list`, `enabledServers`,
    `resolve`), its secrets and tokens are the entry's, and a link whose entry is gone is kept but never passed to runs.
    Secret keys: project `mcp:<projectId>:<serverId>:{env|header|oauth}:<name>`, library `mcplib:<entryId>:...`.
    Verified by unit tests.
  - Per-project values (engagement phase 2; types.ts section "MCP per-project secrets and custom connector presets"):
    `McpLibraryEntry.perProjectSecrets: true` = each link reads its env / header secrets only from its project key
    (`secretOwnerOf` in mcp/service.ts; never the entry's values; OAuth stays the entry's), written through
    `mcp:setSecret` on the link; `McpServerInfo.secretScope`, `McpLibraryInfo.projectSecrets` and a "needs X for this
    project" run warning show empty slots. `perProjectEnv` lists non-secret env / header names a link may override
    (`envOverrides` / `headerOverrides` via `mcp:setProjectOverrides` or mcp:upsert on the link; validate.ts
    `cleanOverrides` / `perProjectEnvProblems`: unlisted names dropped, hidden characters and long values refused,
    credential-like and launch-changing names refused), merged at resolve (secrets win). User-only fields: proposals
    and installs never set or clear them; refused on connector entries. On mcpLibrary:upsert an absent field keeps
    the stored value (`perProjectSecrets: false` / `perProjectEnv: []` clear); while the flag is set the entry holds
    no env / header values of its own (turning it on deletes them, mcpLibrary:setSecret and library-session proposal
    secrets refuse them, its missingSecrets is empty). A new server id never inherits keys left under that id (the
    prefix is cleared on every removal and before every add). mcp:setSecret / mcpLibrary:setSecret inputs are rebuilt
    (`mcpSecretArgs`). Preset env / headers refuse credential-like and launch-changing names. Retarget (`sameLaunch`) clears the links'
    project values too; removing a link or its entry deletes them. `mcp:copyFromLibrary({ projectId, serverId,
    copySecrets })` replaces a link with a project-only copy (overrides baked in, grants moved, OAuth never copied,
    built servers refused). Renderer API: `window.orgai.mcpProject`; no renderer uses it yet. Not covered: a
    per-project URL or OAuth token. Unit-tested only (serviceProjectScope.test.ts, servicePresets.test.ts,
    validate.test.ts, ipc.test.ts).
  - OAuth (`src/main/mcp/oauth.ts`): RFC 9728 discovery from the 401 `WWW-Authenticate`, RFC 8414 / OIDC metadata,
    a user-entered client id first, then DCR, else `needsClientId`; PKCE S256, RFC 8707 `resource`, a one-shot
    loopback redirect on 127.0.0.1, refresh with rotation (a missing refresh_token is tolerated). DCR sends
    `application_type: 'native'`. RFC 9207: the callback's `iss` is compared exactly with the metadata `issuer` (else
    the AS URL) before the code exchange; missing `iss` is refused only when the metadata advertises
    `authorization_response_iss_parameter_supported` (`OAuthDiscovery.issuer` / `issParameterSupported`,
    `waitForCode` returns `{ code, iss? }`). No CIMD yet. Verified only with fake fetch and the real loopback in
    unit tests; no live authorization server has been used.
  - The host injects `Authorization: Bearer <access token>` into resolved headers. Unverified: that the bundled
    CLI's undocumented `oauth` block in mcpServers passes through from SDK options (not used); that GitHub's hosted
    server (`https://api.githubcopilot.com/mcp/`) accepts a token from a user's own GitHub OAuth app; how Codex's
    own MCP OAuth behaves when `bearer_token_env_var` is set.
  - Runs refresh tokens that expire within 5 minutes before they start (`prepareForRun`). A server that is still not
    authorized starts without credentials and the run logs a warning. Mid-run re-authorization is out of scope: the
    user authorizes in Settings and the next run picks it up.
  - Harness-level runs (the library MCP assistant) use the virtual project `HARNESS_PROJECT_ID` ('harness', built by
    `harnessProject()` in `mcp/assist.ts`, never stored). Only `mcp-assist` runs may use it.
  - Hardening: install-card edits are allowlisted onto the agent's spec and cannot reuse an existing id; a run-scoped
    server never reads stored secrets. OAuth bearers are injected only when `oauth.resource` matches the server URL.
    The loopback callback ignores (400) any request whose state does not match exactly. OAuth fetches never follow
    redirects and refuse private-IP literals (no DNS check). A connector preset's issuer is enforced
    (`oauth.ts` `presetIssuerFailure`): an issuer-only preset (Asana, HubSpot, Box, Zoom) refuses a sign-in whose
    discovered issuer differs (trailing slash aside) or whose authorization, token or registration endpoint is off the
    issuer's domain, before any secret is sent; a preset with endpoints (Slack 'fallback') falls back to its own
    endpoints when the discovered issuer is off its domain; 'replace' (Google, GitHub) skips discovery. "Domain" is the last
    two DNS labels (`registrableHost`, no public-suffix list), so preset issuers must be simple vendor hosts, never
    under a multi-label suffix such as co.uk. All of this is unit-tested only; no live sign-in has checked it.
- Connectors (`src/shared/connectors.ts` catalog, `src/main/mcp/connectors.ts`, `McpService.connectors*`): curated
  presets for official remote MCP servers that become library entries (`McpLibraryEntry.connectorId`, written only by
  `connectors:add`, which takes only `{ connectorId, variant? }` and is idempotent except that a different variant
  rewrites a not-yet-connected entry in place: secrets, OAuth state and connectedAt dropped, an in-flight
  authorization aborted; a connected or 'none'-auth entry keeps its variant until disconnected (or removed, for a service with no sign-in, which has no Disconnect). Checked by unit tests
  and e2e/connectors.mjs (Disconnect, pick the other access, Connect again)). GitHub has own-app sign-in variants `app-readonly` / `app-full` (oauthClient, issuer
  `https://github.com/login/oauth`, endpoints replaced so the RFC 9207 iss check expects exactly that issuer, no
  `resource`, scopes repo, read:org, read:user, read-only through the X-MCP-Readonly header, client secret required).
  Checked by reading docs.github.com and GitHub's live authorization server metadata plus unit tests; no sign-in was
  attempted, and the scope list, GitHub accepting a 127.0.0.1 callback URL and its MCP server accepting a user-registered
  app's token are unverified. IPC `connectors:list`
  (`ConnectorInfo`), `connectors:add`, `connectors:setToken` (token connectors; prefix added in main); ipc.ts
  `connectorArgs` rebuilds both inputs (kebab-case ids at most 64 chars, a token string of at most 4,000 chars or null,
  every other shape refused, extra fields dropped; `ipc.test.ts`); everything else
  reuses mcp:* / mcpLibrary:*. `oauthClient` connectors (Google, Slack, GitHub) use the user's own client and the fixed
  redirect `http://127.0.0.1:38917/callback` (`CONNECTOR_REDIRECT_URI`, strict listen, no ephemeral fallback).
  ORGAI_MOCK=1 makes connector authorize/test network-free (mock@example.com, fake tools); the stand-in token is
  ignored outside mock mode. Unverified, every preset (`verified: false`): Google accepting a 127.0.0.1 redirect on a
  Web application client and ignoring a missing `resource`; Slack accepting an http loopback redirect at all (its docs
  say HTTPS), the `oauth.v2.user.access` response shape and the scopes it needs; DCR plus loopback on Notion, Linear,
  Sentry, Stripe, Figma and Atlassian (admin allowlist); GitHub's `X-MCP-Readonly` header. Unit-tested only.
  - Contract (2026-10-31): `ConnectorDef.aliases` (lowercase search words; `connectorMatches(def, query)`), 17
    categories (`CONNECTOR_CATEGORIES`; added crm, data, cloud, knowledge, automation, commerce, meetings), auth kind
    `{ kind: 'none' }` (no secret slot, no OAuth; connected once added; mcp:authorize answers `notRequired` without a
    flow, connectors:setToken refuses), `connectorEase(def, variantId?)` -> `ConnectorEase` 'none' | 'signIn' (oauth)
    | 'token' | 'ownApp' (oauthClient) with `EASE_ORDER` / `easeRank` (none first), every `defaultVariant` is its
    easiest variant (test), and `McpLibraryEntry.connectedAt` (epoch ms; main-only: set on authorize success, token
    set, or add of a 'none' preset; cleared by revokeAuth, token null, or losing the connector; stripped from renderer
    writes and linked specs; malformed values dropped on read) surfaced as `ConnectorInfo.connectedAt` only while the
    card is 'connected'.
  - Custom presets (engagement phase 2, `src/main/mcp/presets.ts`): `UserConnectorDef` in `<data>/connector-presets.json`
    (at most 100; `connectorPresets:list / upsert / remove`, `window.orgai.connectorPresets`), validated on write and
    read (`validateUserPreset`: kebab id not a curated id, hidden characters, caps, https urls, pinned stdio, auth
    none / oauth scopes only / token, publisher 'user', verified false, `origin` kept only as 'kit'). connectors:list
    appends them after the catalog with `custom: true`, `preset` and a ConnectorDef projection (`presetConnectorDef`;
    publisher widened to 'official' | 'user', variant transport to McpTransport with url '' for stdio);
    connectors:add / setToken work the same (`buildPresetEntry`, main-written `McpLibraryEntry.connectorCustom` so
    connectorOf looks only among custom presets; a stdio token fills secretEnv). Editing a preset never rewrites an
    entry made from it; an entry whose variant left the preset is judged from the entry alone; removing a preset with
    an entry refuses. The Team assistant catalog lists curated presets only. Unit-tested only (presets.test.ts,
    servicePresets.test.ts, connectors.test.ts).
  - Catalog (41 entries): added Google Docs, Sheets, Slides, Chat (People omitted), Intercom (US/EU), Supabase
    (read-only `?read_only=true` default), DeepWiki and Exa (keyless 'none' default; Exa also an `x-api-key` token
    variant), Cloudflare (oauth + token), Datadog (US1, EU1, US3, US5, AP1), Vercel (reviewed clients only), Asana,
    HubSpot, Box (oauthClient), PayPal (live/sandbox, oauth best effort). Second wave (2026-10-31): Microsoft Learn,
    AWS Knowledge (none), Context7 (keyless 'none' default plus a Bearer key variant), Granola, Neon (read-only
    `?readonly=true` default, full, API key), Amplitude (US/EU), PostHog, Webflow, Miro, GitLab (gitlab.com only)
    (oauth), Zoom (oauthClient, issuer `https://zoom.us`), Zapier (Bearer connection token). A "Not yet" comment at
    the end of the catalog lists vendors left out and why. Every oauthClient preset sets `overrides.issuer` (Asana
    `https://app.asana.com`, HubSpot `https://mcp.hubspot.com`, Box `https://api.box.com`, Zoom; Google and Slack
    carry endpoints); these issuers come from the probe, unverified in a live sign-in. Stripe's key variant is an
    "Agent API key" (Dec 2026 rule); Google setup names the Developer Preview Program and the "Use this client for an
    AI-powered agent" box; Slack notes say no DCR and Marketplace/internal apps only. `status` labels of the new
    entries are unverified. New ids are in renderer `BRAND_GAPS` until their marks are sourced.
  - Probe (`scripts/probe-connectors.mjs`, `npm run probe:connectors`; `--list` parses the catalog without network,
    `--only a,b`, `--out file`): token-free but network-using, so it needs the user's consent each time it runs. It
    POSTs an unauthenticated JSON-RPC initialize to every http variant, follows a 401's `resource_metadata` to the
    RFC 9728 and RFC 8414 / OIDC metadata and reports DCR, CIMD, PKCE methods, the RFC 9207 iss flag, scopes and, for
    'none' variants, whether initialize answered 200 (no credentials, no redirects, 10 s, 64 KB, JSON only, public
    https hosts only after DNS, 6 in flight). Run once on 2026-10-31 (`docs/connector-probe-2026-10-31.json`):
    every oauth entry advertises DCR; CIMD: Notion, Linear, Sentry, Cloudflare, Atlassian, Vercel, Granola, Neon,
    Amplitude, PostHog; iss: Notion, Linear, Sentry, Figma, Supabase, Cloudflare, Neon, Google; DeepWiki, Exa,
    Microsoft Learn, AWS Knowledge and Context7 answer initialize 200 without a key; Datadog US3/US5/AP1 and the
    Google Docs/Sheets/Slides/Chat hosts answer; Slack's metadata issuer is `https://mcp.slack.com` (the preset's
    slack.com endpoints are the fallback only); Zoom's resource metadata names `https://mcp.zoom.us/...`, not the
    documented URL; PayPal's POST /http answers 404, not 401, though resource metadata exists. Advertised metadata
    only: no sign-in was attempted, so DCR plus loopback acceptance is still unverified everywhere.

## Renderer

- Connectors (renderer): built for 40-60 services (`docs/design/ux-review-connectors-scale.md`). App settings > Connectors (pane id `mcp-library`) is the gallery (`connectors-section`, `connector-tile[data-connector][data-state][data-ease]`, `connector-action`) plus "Custom servers" below; the pane widens that settings column to 1120 px and the grid steps 1 / 2 / 3 columns (560 / 900 px container). A tile is one row (logo, name, method badge `connector-ease` from `connectorEase`: "Sign in", "No sign-in needed", "Paste a token", "Needs your own app"; one clamped line; one button): only "Sign in" and "Add" are filled, "Add token" / "Set up" are outline. Order (`lib/connectors.ts` `sortForGallery`, `gallerySections`): Connected (connectedAt desc, then name), then attention states, then by ease and name; past 24 entries the default view groups under "Easy sign-in" / "Needs a token" / "Needs your own app" and category chips appear. Filter chips (`connector-filter[data-filter]`, `aria-pressed`: All, Connected, Easy sign-in, categories), ranked search (`matchRank`: name, then aliases, vendor, category, description), a polite count (`connector-results-count`) and a no-results card with "Add a custom server". The tile grid is one tab stop (`useRovingFocus`, arrow keys). `requestConnector(id)` (`lib/settingsTarget.ts`, kebab-case ids only) deep-links to a tile: `ConnectorGallery` reads the key on mount or on `orgai:settings-section`, clears search and filters, scrolls, focuses it, sets `data-highlight` for 2 s and announces "Showing <Name>". State label "Not signed in" (was "Needs setup"). `ConnectorDialog` leads per method (`dialogTitle` / `dialogLead`: "Sign in with X" + "Opens your browser. No keys to paste."; "Add X" + "No sign-in needed."; the access choice first, then the token field (the variant fieldset renders in one stable slot before the form for every auth kind, so a radio keeps focus when the variant's auth kind changes; its legend reads "Access and sign-in" when a connector's variants mix auth kinds (GitHub), else "What agents can do"; changing the radio clears typed token / client id / client secret; while connected, `connector-locked` (the fieldset's `aria-describedby`) says Disconnect to change it, or "Remove the service and add it again" for a 'none'-auth service; the notes and honesty line still follow the form for token variants; `connect()` refuses with "This service was connected with a different access level. Close and open it again." when `connectors.add` returns an entry on another variant); own app "About 10 minutes, once." with an "I already have a client ID" shortcut that collapses the steps; `connectStep` 'none' makes no authorize call and has no Disconnect) and shows the "not yet tested" note once (`connector-dialog`, `connector-connect` in the footer). Access can be changed in the dialog until the service is connected (`connector-variant[data-variant]`); `connector-locked` shows only while connected (Disconnect to change it). Team > Catalog "Add a service" (`AddServiceDialog`, `mcp-add-service`) is a search-first listbox picker (`add-service-search`, `add-service-count`, `add-service-ready` section "Ready to use", `add-service-option`, in-project services say "Manage roles" and jump to their row, one footer row: `add-service-other` with `-assist`, a "Can't find it?" menu `add-service-more` holding `-link` and `-custom`; Easy sign-in is a toggle that combines with a category and All resets both; search also matches the ease words); The picker's first section is "Your servers" (`add-service-yours`, rows `add-service-library-option[data-id]`): the user's saved library servers that are not connectors (`lib/connectors.ts` `libraryMatchRank` / `filterLibrary`: name, then description), "Add" links them with a roles step (`add-service-library-dialog`, or at once for a role-started add or a project with no roles), a linked one says "Manage roles" and jumps to its `mcp-row`; the count includes them and an empty search offers `add-service-empty-custom`. `connected-service-row`, `connector-use`; `ConnectedServices` folds unused services past 8 behind `connected-more`. Role inspector `role-services` shows brand marks and caps at 5 with "and N more". Plain words only in this path (service, sign in, can read / can read and change). e2e: `e2e/connectors.mjs` (in e2e:free). Walks: `docs/design/ux-review-connectors-2.md`, `-connectors-scale.md`. Not done: Tools sections order / "Services, N connected" count (Team-tab files), the old `.svc-pick*` rules in styles/mcp.css are now unused.
