# Core runtime (main process)

Application menu, run end and decision cards, settings, run titles, projects, usage and pricing, work-run config changes, self-configuration, concurrent runs, setup sessions. Moved out of CLAUDE.md on 2026-11-07; see CLAUDE.md for the index.

## Main

- Application menu (`src/main/appMenu.ts`, all platforms; the window menu bar is always shown, `autoHideMenuBar: false`):
  File, Edit, View, Run, Window, Help (plus an app menu first on macOS, where App settings lives as "Settings…"). Contract:
  `MENU_ACTIONS` / `MenuAction` / `isMenuAction` and `IPC.menuAction` ('menu:action', payload `{ action }`) in types.ts,
  received through preload `onMenuAction(cb)`. `buildMenuTemplate` is pure; every renderer item goes through one helper
  so `id === action`. Routing is `menuActionTarget(action)`: navigation actions (new-project, new-chat, assistants,
  settings/connections/connectors/skill library/about, show-live/history/team/project-settings, toggle-sidebar,
  keyboard-shortcuts) are 'main' and go to the live unscoped main window (restored, focused; created through the
  injected `createMain` when it was closed); show-needs-you is 'main' too; run actions (new-run, close-tab,
  interrupt-run, end-session, go-to-decision, org-retrospective, save-chat-as-project,
  open-run-window, toggle-conversation, toggle-hide-finished, canvas-fit, canvas-zoom-in/out) are 'focused' and go to
  the focused live window, else main, else the first live window. The action is re-checked, destroyed windows are
  skipped. Enablement: the renderer reports `MenuState { hasProject, hasRun, runLive, chatRun, hasDecision }` through
  `menu.setState` (`IPC.menuSetState`, ipc.ts rebuilds it with `cleanMenuState`: booleans only); main keeps one per
  window; the focused window's drives the 'focused' items and the main window's the 'main' items. The menu is
  rebuilt on `setMenuState` for the focused or main window, on `browser-window-focus` and when a window closes (empty
  when none is focused); a window with no state counts as empty and an equal state is a no-op. The renderer must call
  `menu.setState` once on mount and on every change: the first call marks the window ready. Actions for a window
  that is not ready queue (at most 8, newest of each action, oldest dropped) and flush in order on that call. Accelerators: new-project CmdOrCtrl+N, open-app-settings CmdOrCtrl+,
  and Live/History/Team/Project settings CmdOrCtrl+1..4 register normally, and linux Quit has Ctrl+Q; the keys the
  renderer already handles (CmdOrCtrl+B toggle-sidebar, Shift+N new-chat, T new-run, W close-tab, `.` go-to-decision)
  set `registerAccelerator: false` on win32 / linux (hint shown, key not consumed, Playwright `keyboard.press` keeps
  working) while darwin consumes key equivalents natively, so there they arrive only as menu actions and the renderer
  router (not built yet; it lands with the UI Lead, and until then menu items and the registered Ctrl+N / Ctrl+, keys
  do nothing and on darwin Cmd+B/Shift+N/T/W/. reach only the menu) must handle them on every platform (that the keydown handler does not also fire on darwin is UNVERIFIED, see
  docs/macos-testing.md). Cmd/Ctrl+W is close-tab's only (never a window close); Window > Close window is a plain item
  with no accelerator, not the `close` role. Help opens only the fixed `DOCS_URL` / `ISSUES_URL` (guarded by
  `openHelpUrl`) and "Open data folder" opens `app.getPath('userData')` (ORGAI_DATA_DIR replaces it). Window
  `minHeight` stays 680 (an outer size: at the minimum window the content area on Windows is 615 px measured in the re-walk, ux-review-menu-2.md M4, with the
  26 px menu bar; accepted, see ux-review-menu.md M1).
  Unit-tested, and walked on Windows on mock data at both sizes and themes (ux-review-menu-2.md): the bar follows the theme, every renderer item works, real Ctrl+T / Ctrl+B fire once, run-window actions land in the main window. Open Mediums: M1 (Go to decision only looks at the current project), M2 (Team / Project settings on assistants, Org retrospective on live runs and Save chat as project on scratch chats announce instead of greying), M3 (Ctrl+. works only on Live), M5 (App settings counts as "no project": sections greyed, Ctrl+T announces "Open a project first."), plus Lows. macOS, Linux and packaged builds not driven.
- Run end: RunManager calls `cancelPending` (`pendingCards.ts`) when a run reaches an outcome or `paused`, and at
  teardown. Every open card then gets its `*.resolved` event with `cancelled: true`. `activity.ts` `runOutcome` /
  `settleAgent` relabel agents Finished, Stopped or Failed. Harness-written transcript entries carry
  `source: 'harness'` (Claude, Codex and mock) and render as quiet system rows. Verified by unit tests.
- Continuation wait: `ContinuationDriver.turnEnded` waits `continuationWaitMs` (`continuation.ts`), not always the 1500 ms
  default. A host that supplies `lastReportEndedAt()` (Claude, Codex, mock: newest non-root `endedAt`, plus bridged
  finishes on Codex) waits 0 when no report is live and none ended within the window, else only the rest of the window;
  live reports or a future timestamp keep the full delay; a host without it, or `delayMs` 0, is unchanged. The timer is
  still a `setTimeout`, so cancel and settlement behave as before. Checked by unit tests only; the 1,579 ms figure came
  from one lab run on the Codex adapter and the fix has NOT been measured in a live run.
  - Who ended it: `RunSummary.endedBy` is 'user' after End session (`RunManager.stop`, saved with the 'stopping'
    status so a quit or crash keeps it), 'app' when OrgAI quit (`stopAll({ reason: 'quit' })` through
    the `ShutdownCoordinator` in `host/shutdown.ts`, at most 3 s, then the synchronous `markQuit()` writes what is left) or crashed (RunStore boot
    normalization, `endedBy ??= 'app'`), always next to `endedWithApp: true` (only then), and absent when the run
    ended on its own; junk values are dropped on read, a legacy lone `endedWithApp` gets 'app'. With 'app',
    `endedWhile` says what it was doing: 'waiting' (idle or a card open), 'working' (starting, running, stopping),
    absent for a paused run. The terminal `run.status` event ('finished' / 'error', including the quit write-out's
    forced 'finished') carries the summary's `endedBy` / `endedWhile`, and 'stopping' carries `endedBy: 'user'` after
    End session (`withEndFacts` in runManager.ts; adapter-set values are dropped). Once quitting, start / continueRun / send / resumeNow refuse ("OrgAI is quitting") and a
    session still opening is stopped when it opens. The renderer's adoption of endedBy lands with the
    one-conversation UI change. Unit-tested; the real Electron quit path is not.
- Run staffing contract (2026-11-10, docs/design/orchestration-efficiency.md section 5; types.ts "Run staffing"):
  `RunRecord.staffing` (`RunStaffing { goal, assignments }`) mirrors the work-run plan: `RuntimeContext.updateStaffing`
  (RunManager cleans it with defaults.ts `cleanRunStaffing`, stores it on the record through `recordEvent`, flushes it
  with the record and broadcasts `staffing.updated`), `getStaffing`, and `staffingGoal` (`staffingGoalOf(project,
  RunOverrides.goal)`, fixed at run start). Unlike the plan it is not carried to a continuation; `RunOverrides.goal` is
  (NARROWING_KEYS). A bridged child gets stub get/update (nothing reaches the parent) and the parent's goal. Graph
  fields `PlanStep.after / paths / staff`, `Role.staffing`, `Project.staffing / staffingGoal / reviewPolicy` and
  `RunEfficiency.readyIdleMs` exist; stored values are cleaned on read (ProjectStore `sanitizeRoleModels` /
  `withCleanAllowedDirectories`; `normalizeRunRecord` runs `cleanPlanStepGraph` and `cleanRunStaffing` on stored
  records, also on `get()` of a live run). Rows are written by the adapters at spawn time through `recordStaffing(ctx,
  row)` in `runtime/staffing.ts` (Claude's spawn hook, Codex `spawn_report`, the mock), which also marks the row's plan
  step `in_progress` when it is still `pending`; `set_plan` / `update_plan` run `cleanPlanStepGraph` and keep such a
  step `in_progress` while its report works (`boundStepIds`, "kept in_progress (a report is working on it)"). Nothing
  computes `readyIdleMs` yet. The renderer store and TUI keep the latest `staffing` on the run; exec, logs and
  notifications ignore the event. Unit tests (`src/shared/staffing.test.ts`, `runManagerStaffing.test.ts`,
  `staffingGoalOverride.test.ts`, projects, runUsage, bridge, TUI state and renderer store tests) and the lab runs of
  2026-11-10 (spec 1.1c: rows on both adapters, source `orchestrator` and, on Codex, `clamped`).
- When the lead hands work out (2026-11-10, spec 4.1, 4.4, 1.1c; `prompts.ts` `teamSizingText`, `reviewPolicyText`,
  `reportsText`): the root's sizing paragraph is in decision order and its wording was changed twice on lab evidence,
  so read 1.1c before touching it. The sizing sentence decides first; the split test applies to "what the brief asks
  for"; "Tests and checks of your own work are part of it, never pieces to hand out"; the parallel, contract and
  review sentences speak only of handed-out work, except review by risk, which covers any change again (owner
  decision 2026-11-10, no lab run on that wording). The team listing says how ("To hand work out, use the Agent tool"), not that the lead must;
  required reports keep "You must delegate to ...". Sizes are pinned in `prompts.test.ts`. Lab-checked on the root of
  the default chart only; a mid-level lead and a setup root get the new listing line with no live run behind it.
  Split execution (split-execution 3.2-3.4, unit tests only, no lab run): criteria go "in each brief" (`spawnFiles`
  adds the files clause, unwired until codex.ts/mock `spawn_report` take `files`); "keep a piece yourself" only with
  `workBesideReports` (default `!spawnCallFields`: not Claude today); the integrated result is checked once; writing
  leaf reports of team work runs get `REPORT_CHECKS_TEXT`.
- Staffing profile wiring (2026-11-10, spec 4.5, D8): `store/staffingProfile.ts` holds the lifecycle helpers.
  `staffingProfileApplies(summary, project)` = kind 'work', not quick, not Ask (`team: 'single'`), no buildWorkspace,
  not a virtual project, `staffingModeOf` 'auto'. Read: RunManager reads `<data>/staffing/<projectId>.json` once at
  context build (only with `dataDir` and when it applies) and sets `RuntimeContext.staffingProfile()` (a snapshot);
  the bridge does not pass it on, so bridged children never see it. Each adapter spreads `staffingProfileDep(ctx)` into
  its StaffingBook (none on a fixed project) and wraps the first message's context in `withRootStaffingBrief(ctx)`
  before `firstMessageHiddenContext`: the brief joins the hidden harness context, not the transcript entry, the system /
  developer prompt, later messages or spawn briefs, and is skipped when `resumeSessionId` is set. Write: `teardown`
  (once per ActiveRun via `tornDown`) calls `recordRunInStaffingProfile` after the flush with the live `ctx.project`;
  entries carry `runId` and `mergeProfile` replaces a run's earlier entries, so a second merge cannot double count.
  A failed write logs one warning (step and errno code, no path) and never fails the end. Unit tests only
  (staffingProfile, runManagerStaffing, mock, claude, claudeKnowledge, codexStaffing); no live run.
- Decision cards are kept in RunManager's pending maps (`PendingCardMaps` in `pendingCards.ts`) with their request
  objects. `RunManager.pendingCards` (IPC `runs:pendingCards`) hands them to a fresh renderer, which otherwise only
  learns of cards from `*.request` events broadcast at request time. Verified by unit tests. No renderer code calls
  it yet.
- Settings: `AppSettings.appearance` (theme, accent, canvas, reduceMotion; `DEFAULT_APPEARANCE`) and
  `AppSettings.notifications` (the single source of truth; `notifications.setEnabled` in the preload is a deprecated
  mirror) are saved through `settings:set`, which broadcasts `settings:changed`. The renderer applies appearance only
  in `lib/theme.ts` (`initTheme` in `main.tsx`) as `data-theme`, `data-canvas-*`, `data-reduce-motion` and `--canvas-*`
  on `<html>`. Views never read appearance settings themselves. `AppSettings.setupModel` / `mcpAssistModel` (default
  'deep', normalized in `store/settings.ts`; values are tier names or concrete ids, an old saved default 'opus' loads as 'deep') pick the built-in Architect and MCP assistant models, resolved per run by
  `runtime/builtinModel.ts` (deep-tier fallback, one run warning). They are edited in App settings > General > Advanced
  settings > "Assistant models"; the MCP assist dialog hint and the Org retrospective tooltip name them (`lib/assistantModels.ts`).
  The `orgai:settings-section` window event switches a mounted App settings page to the requested pane.
- Run titles: `RunSummary.title` (at most `RUN_TITLE_MAX_CHARS` = 32) and the `run.title` event come from
  `src/main/ai/runTitle.ts`. RunManager fires it for work runs with prompt text and never awaits it. It is a one-shot
  `complete({ kind: 'title', model: fast tier, connection })` with a 20 s timeout, cleaned by `cleanTitle`. A failure
  leaves the title unset, and the UI falls back to the prompt. Continuations get the earlier run's title as context.
  Auto-resume (`RESUME_TEXT`) keeps the earlier title. The mock answers `kind: 'title'` with the first 4 words of the
  `<message>` text, and `[mock:title-fail]` makes it throw. The live fast-model call is unverified (no smoke script).
- Projects: `projects:checkPath` (`ProjectPathCheck`) never rejects. `projects:create` validates the path, and
  `ProjectCreateInput.mock` is accepted only with `ORGAI_MOCK=1`. `app:openPath` (`openPathRefusal` in ipc.ts) opens
  only an existing real directory (lstat) that is a project folder, a project's allowed directory or inside the data
  dir (lexical and real spellings), at most 1,024 chars, no hidden characters, absolute, no UNC/device; refusals come
  back as the message string, never a throw. Unit-tested; symlink/junction refusal and macOS spellings not live.
- Usage and pricing (#10): `src/main/runtime/pricing.ts` (pure) prices per token (`ModelPrice`, each price finite,
  >= 0 and at most `MODEL_PRICE_MAX_PER_TOKEN` 0.01). Per model: override (`AppSettings.modelPrices`, at most 200,
  connection-scoped beats global) > provider-reported cost > 0 > proxy (LiteLLM `RunConnection.pricing` /
  catalog `ProviderModel.price`) > builtin (`BUILTIN_PRICES`, vendor pages read 2026-10-30; 5.x ids are guesses) >
  community (`communityPrices.ts`, off with `AppSettings.communityPrices: false`) > unknown (`costUsd: null`, never
  $0; a partly priced sum sets `costPartial`). `priceFor` is memoized per pricing record (index + 500-entry cache).
  `runUsage.ts` holds `AgentUsage` (adapters only tally tokens per model, turns, tool calls, retries and provider cost
  through `setModelTokens` / `countUsage`) and `RunUsage` (cost, models, roles, wall / waiting / limit-hold / idle
  time, nudges, agents without a result, `skills`). The root agent is never counted as producing nothing. RunManager
  prices every `agent.upsert`, drops an adapter's `run.usage`, and publishes its own at most once per 1 s
  (`USAGE_THROTTLE_MS`, trailing; at once on a terminal status). The adapter's `run.cost` is ignored as a provider
  total when `RunConnection.pricing` is set. Records saved before usage tracking are normalized on read with
  `legacy: true`. `runs:usageStats` (default 500 rows, max 2000; roles, trend and totals cover only the returned rows)
  and `models:prices` (override, proxy and builtin rows) are the IPC. LiteLLM discovery caps: 2,000 models, 200-char
  ids (`validModelId`), 5 MB body. Mock: `[mock:no-price]` makes every agent unpriced, `[mock:computed-cost]` prices
  from the builtin table with no provider cost, and the default script's `mock-report-2` is unpriced and returns
  nothing. Verified by unit tests and the mock only; no live run has checked the builtin ids or which model id the CLI
  or a proxy reports.
  - `RunUsage.efficiency` (2026-11-09, `RunEfficiency` in types.ts; orchestration-efficiency.md 4.2): derived by
    `computeRunEfficiency` (runUsage.ts) from the root's direct reports' `startedAt` / `endedAt`, nothing tracked at
    runtime: reports, firstSpawnMs, reportSumMs, reportBusyMs (union), maxParallel, tailMs (after the first wave), afterLastReportMs (run end minus the last report's end) and reportStartMs
    (median over reports of first Edit/Write/MultiEdit/NotebookEdit `tool_use` in the transcript minus the report's start; Codex
    fileChange is already normalized to Edit/Write; `RunUsageInputs.transcript`, passed by RunManager.currentUsage; reports that
    never wrote are left out; absent without a transcript). Both optional, cleaned like readyIdleMs. The staffing profile
    entries carry both (`profileTiming` gives per-project `medianReportStartMs` / `medianAfterLastReportMs`; not in the brief
    text) and the Usage Efficiency panel shows "After the last report" beside Tail. Absent
    without a direct report; `cleanRunEfficiency` drops a malformed stored value whole (`normalizeRunRecord`,
    `cleanStoredUsage`); `sumRunUsage` never sums it. Verified by unit tests only (runUsage.test.ts, incl. the
    dashboard run of spec 1.3); no live run has checked it.
  - App-wide overview (2026-11-07, main only; ARCHITECTURE.md Shared contracts "App-wide usage overview"):
    `runs:usageOverview` / `runs:usageOverviewCsv` (read scope; preload `runs.usageOverview / usageOverviewCsv`, query
    optional) cover every project, the virtual assistant ones and a removed project's leftover runs
    (`USAGE_REMOVED_PROJECT_NAME`, `removed: true`). kinds default to every RunKind, bucket day | week | month,
    projectIds at most 200 valid ids (else refused). Rollups (projects, models, roles per project, connections, trend
    with `byProject`, totals) cover every matched run; only `runs` stops at the limit. Builder `runUsage.ts`
    `buildUsageOverview` (pure), names from dispatcher.ts `usageNames`. Not built yet: the renderer page, its View
    menu action and its atlas surface; the UI Lead adds all three together, so nothing names a page that does not exist.
    Stored usage is rebuilt by `cleanStoredUsage` first (one malformed record never breaks the view); a connection's
    partial cost stays a lower bound (`RunUsage.connections[id].costPartial`); `cleanCost` never reads junk or spend
    under 'none' as $0. Every rollup carries `costKnownRuns` / `costUnknownRuns`; rows carry `live`, `endedBy`,
    `quick`, `legacy`, `projectRemoved`; RunUsage gains `noResultCostUsd` / `noResultAgents` (at most 20, new runs
    only); the CSV has its own `USAGE_OVERVIEW_CSV_COLUMNS`. Cache "not reported" cannot be told from 0 (adapters
    write 0; Codex never reports cacheWrite). Responses are not size-capped (review
    L4, open): send a range or a month bucket. Unit-tested (runUsageOverview.test.ts, runManager.test.ts,
    bootstrap.test.ts through invokeRpc); 2,000 runs in about 23 to 49 ms on Windows.
- Work-run configuration changes (2026-11-02; see ARCHITECTURE.md Conventions): the work-run root has propose_mcp_servers
  (project-only, enforced in main), list_skill_library, read_library_skill and propose_skills (create / update / link /
  grant / remove, project scope). Approved changes reach the live run through RunManager `setLive` and
  `HarnessToolHooks.configChanged` (Claude: setMcpServers now, restart at idle for new whitelists or a stale skill
  plugin, live gates deny ungrants at once; Codex: app-server restart at idle for MCP, skills 'now'; mock 'now',
  `[mock:config-change]`). Org changes never grant (no grant fields on drafts) and keep ids and grants through
  `setup/orgMerge.ts` mergeOrgChart. Proposal decisions add 'decline' and card-typed MCP `secrets`
  (`proposalSecretKey`), stored in main and never in events (`ProposalOutcome`), and `Proposal.effect`.
  Verified by unit tests, fake query() / fake Codex server tests and the mock (runManagerConfig.test.ts end to end);
  nothing live. The renderer side is the proposal-cards pass (see Renderer below). A grant change also reaches the run's
  own role copies (`runManager.ts` `refreshRoleGrants`: `Role.mcpServers` / `skills` by id, in place, so every adapter
  gate, role lookup and restart sees it; ids and other fields stay, an org change applies from the next run; review M1).
  - Proposal gates (2026-11-02, renderer review): main refuses control, zero-width, bidi and other invisible
    characters (`capabilities/sanitize.ts` `hiddenCharIn` / `hiddenCharProblem`; descriptions are `prose`: tab, line
    breaks, emoji ZWJ, ZWNJ and soft hyphens pass, bidi and zero-width space do not) in every MCP spec string field (`validate.ts` `hiddenCharProblems`, inside
    `validateSpec`, so proposals, library entries and Settings edits alike), in skill proposal name, libraryId,
    draft name and description and role slugs (`skillProposalProblem`), and in allow rules (propose_settings REVISE,
    request_permission_rules "Invalid request", `cleanAllowRules` drops them). `storeProposalSecrets` stores a value
    only for a slot whose serverId the proposal upserts (others dropped with a log warning). Final review fixes: an
    approved redefinition that changes plain env or header names or values clears the stored secrets like a new
    command or URL (`sameLaunch` in mcp/service.ts, `sameTarget` in harnessTools.ts; the tool names the secrets to set
    again) (M2); a name-only toggle or re-grant carries `McpProposalServer.configOnly` (the fields it sets) and approval
    applies only those onto the server as stored then, so a Settings edit made while the card was open survives (L1);
    `SkillService.applyProposal(..., { projectOnly })` refuses scope 'library' on work runs (L3); after
    `DECLINED_PER_KIND_MAX` (3) declined proposals of one kind in a run, further ones of that kind answer DECLINED
    without a card (L6). The SKILL.md body is not checked for hidden characters. Verified by unit tests only.
- Self-configuration (2026-11-03; ARCHITECTURE.md Shared contracts, Connections, Conventions): derivable settings are
  automatic with an override; never fill them with defaults in a store, `newProject` or a renderer save.
  - Effective default connection: `ConnectionService.effectiveDefault()` (defaults.ts `effectiveDefaultConnection`)
    is what new projects, Chat, the MCP and Skill assistants and the idle usage probes use (`effectiveSettings()`);
    `ConnectionInfo.isDefault` marks it. Chosen (`AppSettings.defaultConnectionChosen` true): always the stored value,
    whatever its state (a run then fails with that connection's own auth error), unless the connection is no longer
    configured. Automatic: the connection the first rewrite replaced (`defaultConnectionReplaced`, main-owned) once it
    is 'connected' again (the field is then cleared); else the stored value unless it is definitely 'disconnected' or
    not configured; else the first connected in CONNECTION_IDS order, LiteLLM only when it is the only connected one.
    Rewrites (`rewriteDefault`, from `setStatus` and an `enabled` change in `update`) therefore happen only on a
    definite disconnect (CLI loggedIn false, logout, a removed key, a connection turned off) and never on
    'error', 'connecting', 'unknown', a probe throw, a CLI timeout or missing CLI (anthropicAuth.ts `unavailable` ->
    'error'), or a failed discovery; they write `defaultConnectionChosen: false` explicitly and log once per change.
    A LiteLLM base-URL change and a saved key ("Changed / Key saved. Test and connect to apply.") are tentative
    (`setStatus(..., { definite: false })`, service `tentative` set): they never rewrite and `effectiveDefault` reads
    them as 'unknown' until the next definite status. A stored LiteLLM key that cannot be decrypted (`hasApiKey` true,
    `secrets.get` undefined) probes as 'error' ("The stored key could not be read..."), never 'disconnected'.
    `rewriteDefault` drops `defaultConnectionReplaced` once that connection is no longer configured, and `update` rewrites when `enabled` or `connectionConfigured` changes (e.g. a cleared LiteLLM base URL).
  - Review hardening (2026-11-03): `connections:test` / `logout` / `models:list` / `models:refresh` rebuild their input
    (ipc.ts `connectionIdArg`, `modelsQueryArg`; connections:connect and connections:update use `connectionIdArg` too, and connections:setSecret `connectionSecretArgs`: id litellm, apiKey a string of at most 4,000 chars without control or hidden characters, or null) and `ConnectionService.test` / `logout` / `connect` / `refresh` /
    `models` / `setStatus` throw "Unknown connection" for anything not in CONNECTION_IDS (prototype keys included).
    settings:get / settings:set results and the settings:changed payload carry `defaultConnection` =
    `effectiveDefault()` (ipc.ts `withEffectiveDefault`; the stored value stays main-only and settings:set still keeps
    it); `ConnectionService` calls `onDefaultChanged` when the effective default moves in setStatus, update, setSecret
    or logout (chosen mode included) and index.ts re-broadcasts settings:changed when it differs from the last one sent.
    `ConnectionInfo.isDefault` stays the renderer's primary source. `settingsSetArgs` drops an incoming field whose
    kind (null, array, typeof) differs from the stored one's (a non-array `modelPrices` never wipes overrides;
    undefined still clears an optional field). `setDefault(id)` re-choosing the stored default still requires
    `connectionConfigured`. `defaultRootModel` / `defaultReportModel` normalize through `modelRef` (printable, no
    spaces, at most 200, not 'inherit').
    `connectionConfigured('anthropic')` is false when Anthropic's `enabled` is false. settings.ts migration: an explicit
    boolean is kept; a file without the field loads as `defaultConnection !== 'anthropic'`. The only way to change the
    default is `connections:setDefault(id | null)` (refuses one that is not `connectionUsable`: "OpenAI is not
    connected. Connect it first, then make it the default."; both clear `defaultConnectionReplaced`); ipc.ts
    `settingsSetArgs` makes settings:set refuse a non-plain object, merge onto the stored settings and always keep the
    stored `defaultConnection`, `defaultConnectionChosen`, `defaultConnectionReplaced`, `connections` and
    `providerAuth`. Renderer: `useAppStore.setDefaultConnection(id | null)` is the only caller: ConnectionCard "Use for new
    projects" (`connection-make-default`) and "Back to automatic" (`connection-default-auto`), refusal as plain text in
    the card (`connection-default-error`). The App settings Defaults pane and its select are gone (see Renderer,
    Settings pages).
  - Plan guard: `Project.preferEverydayNearLimit` unset = 'auto' (`planGuardOf`). Claude (`planGuardArmed` in claude.ts)
    arms 'auto' when `planGuardEngaged`: the usage report has a weekly window or status 'allowed_warning' (never on an
    API key, proxy or setup run), then steers at `opusGuardThreshold` as before, with one info line per run ("Plan guard
    is automatic and now active: ..."). Codex has no plan guard. `maxWindowShare` stays an explicit opt-in.
  - Subagent limits: `Project.maxSubagentDepth` / `maxConcurrentSubagents` are optional; `effectiveSubagentLimits`
    (explicit wins, else org chart depth in edges + 1 within 1..5, concurrency 8) feeds claude.ts `buildEnv` and the
    Codex network with the run's own roles. propose_settings deletes a stored value when the approved one equals the
    automatic value and ignores non-finite values. ProjectStore migrates a projects.json older than version 2 once
    (`dropLegacyLimitDefaults`): a stored depth 3 or concurrency 8 (the old always-filled defaults) is dropped, any
    other value stays explicit; the file is then written as version 2. The automatic value is computed from the
    project's roles at apply time, so an org chart approved later in the same setup run changes what "equal to
    automatic" meant: a limit dropped as automatic then follows the new chart, and one kept as explicit may now equal
    the new automatic value (accepted; not re-checked after the org change).
  - Plan guard UI: Project settings > Limits > Advanced settings is a Select Automatic / On / Off over `planGuardOf`
    (Automatic clears `preferEverydayNearLimit` and its legacy mirror); a subscription project shows the one-line
    `plan-guard-line` at rest. Depth and concurrency are Selects whose first option is "Automatic (N from the chart)" /
    "Automatic (8)", which clears the stored value.
  - Team assistant: an unset `skillEvaluation.enabled` follows `teamReviewOf(project).auto === 'ai'`, so one switch
    drives both model steps (existing projects with the default Team review now get the skill evaluation model step,
    within its token budget); an explicit false still wins. The Catalog's Evaluate button shows "Evaluate may use up
    to N tokens to suggest skills." while the model step is on.
  - `effortOptionsFor(adapterId)`: claude / mock low..max, codex low, medium, high (Codex passes effort only for those).
    `PERMISSION_MODE_OPTIONS` labels name no vendor.
  - `maxBudgetUsd` does not count restored session spend (Claude docs, researcher 2026-11-03). claude.ts
    `restartBudget` passes the budget minus the run's cost so far, which agrees, but `runCost`'s baseline subtraction
    assumes a resumed query's total includes the earlier spend and can undercount if it starts at zero. Not fixed.
  - How each claim was checked: the effective default, rewrites, move-back, migration and settings:set rules by unit
    tests only (src/shared/selfConfig.test.ts, connections/defaultConnection.test.ts, anthropicAuth.test.ts,
    store/settings.test.ts, ipc.test.ts `settingsSetArgs`); subagent limits and the limits migration by unit tests
    (projects.test.ts, setup/service.test.ts); the automatic plan guard by claude.test.ts "plan guard steering" with
    fake usage reports, never against real plan windows; the Team-assistant-driven skill evaluation by evaluation
    unit tests. Not run in the app: boot-time probe timing (statuses 'unknown' until each probe answers, so the
    default never moves at boot before a definite answer) is not covered live, and the renderer pickers and the plan
    guard Select have no e2e. Open: the LiteLLM probe lists `/v1/models` without checking the key, so a wrong key can
    read as connected (ARCHITECTURE.md Risks). The review hardening above is verified by unit tests only
    (defaultConnection.test.ts "review hardening", ipc.test.ts, settings.test.ts); boot-time probe timing and the live
    CLI timeout path are not covered.
- PR #18 merged with dev: see ARCHITECTURE.md Risks "Merge of PR #18 with dev" (team files, folder config trust and permissions:ignored are host-layer channels; `projects:create` rebuilds `teamFiles` and never imports `.orgai` agents through `importAgents` on any surface; `<data>/settings.json` is a control-protected path; shared view-models for the renderer live in `src/shared/view/` with one-line stubs in `renderer/src/lib/`, pinned by `reexports.test.ts`).
- Concurrent runs and cross-run messaging: any number of runs may be live at once (verified by RunManager unit tests on the
  mock adapter). Work-run roots get `list_runs` / `message_run`; RunManager delivers through `RuntimeSession.receive()`,
  framed by `prompts.ts` `peerMessageText` as peer information, never a user instruction. On by default per
  project (`Project.runMessaging`, both ends; an explicit false turns it off), capped per run pair, never for setup-like runs. Unverified: that the Claude
  adapter's notifyOrchestrator delivers a peer message mid-turn (no smoke script). `window:openRun` opens a run-scoped
  window at `#/run/<projectId>/<runId>`; `runs:listLive` lists live runs across projects.
- Setup sessions (`RunSummary.kind === 'setup'`) run the built-in Architect from `src/shared/setup.ts`, never the
  project's roles. Proposals go through `RuntimeContext.requestProposal`; applying them is `src/main/setup/service.ts`.
  - Revisions and retrospectives (2026-11-07, ARCHITECTURE.md "Architect revisions"): roles a revision does not
    mention are kept (removal only through propose_org_chart `remove`), and an edited role keeps its model and tier
    unless the draft names a different resolving tier or listed id; a new role's unmapped tier never silently becomes
    'inherit' while a listed model or the root's model exists. Unit-tested only; no live Architect run.
  - A `PreToolUse` hook answering `permissionDecision: 'allow'` bypasses the permission system in every mode
    (verified in `scripts/smoke-permission-hook.mjs` on haiku under `dontAsk`: the first Bash call was denied, the
    in-process MCP tool got through on the hook alone, and the retried Bash call ran with zero `canUseTool` calls).
    `dontAsk` still runs trivially safe commands such as `echo` without any rule. This is how live permission grants
    work: `request_permission_rules` (every agent) blocks on a card; a grant lands in `RuntimeContext.allowedRules()`
    (saved file rules re-read plus run grants) and the Claude hook allows matching calls through `ruleMatch.ts`,
    so no session restart is needed. `updatedPermissions` can only be returned from `canUseTool`, which the
    classifier never reaches for a call it denies outright.

- Required delegation (2026-11-08, docs/design/delegation-enforcement.md v1). `Role.requiredReports` (subset of spawnable,
  `cleanRequiredReports`) and `RunOverrides.strictDelegation` (`orgai exec --strict-delegation`: every spawning role requires
  its whole spawnable list). RunManager owns a `DelegationLedger` (runtime/delegationLedger.ts over the pure decisions in
  runtime/delegation.ts) per work run, behind `RuntimeContext.delegation`: adapters report spawns, completion attempts,
  deliveries and ends; the gate answers allow / wait / correct (once per agent) / fail. Preflight refuses exec runs whose
  obligations cannot be met (depth, concurrency, bridged edges). `finalizeDelegation` judges the root on every terminal path;
  exec outcome `delegation-incomplete` (exit 3). Reports from spawning roles carry a harness receipt line; a failed agent's
  worktree is held (`heldBy: 'delegation'`). Claude forces required spawns to the foreground and blocks the stop once; Codex
  holds a manager's report while its reports run (parked, outside the concurrency count). Mock markers
  `[mock:delegation-ok|fix|skip|claim]`. Known limits in the spec's section 10 (bridged sessions, continued runs, held-branch
  persistence across sessions). Unit-tested; live: Claude SDK facts (sdk-facts.md) and the Codex native-agent probe
  (connections-mcp.md).

## Desktop per-run goal

`HostDispatcher.checkRunOverrides` (`src/main/host/dispatcher.ts`) used to drop every override on the desktop surface. It now keeps only a valid `overrides.goal` for `runs:start` (a bad value is refused as bad_request by `startRunArgs`) and passes it with `allowWidening: false`; permission mode, budget, strict delegation and the rest are still dropped. `runs:continue` and `runs:startQuick` still drop all overrides from the desktop (a continuation keeps the run's goal through `continuedOverrides`). Checked by unit tests only (`dispatcherExec.test.ts`).
