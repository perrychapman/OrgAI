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
  - Who ended it: `RunSummary.endedBy` is 'user' after End session (`RunManager.stop`, saved with the 'stopping'
    status so a quit or crash keeps it), 'app' when OrgAI quit (`stopAll({ reason: 'quit' })` through
    `quitGate.ts`, at most 3 s, then the synchronous `markQuit()` writes what is left) or crashed (RunStore boot
    normalization, `endedBy ??= 'app'`), always next to `endedWithApp: true` (only then), and absent when the run
    ended on its own; junk values are dropped on read, a legacy lone `endedWithApp` gets 'app'. With 'app',
    `endedWhile` says what it was doing: 'waiting' (idle or a card open), 'working' (starting, running, stopping),
    absent for a paused run. The terminal `run.status` event ('finished' / 'error', including the quit write-out's
    forced 'finished') carries the summary's `endedBy` / `endedWhile`, and 'stopping' carries `endedBy: 'user'` after
    End session (`withEndFacts` in runManager.ts; adapter-set values are dropped). Once quitting, start / continueRun / send / resumeNow refuse ("OrgAI is quitting") and a
    session still opening is stopped when it opens. The renderer's adoption of endedBy lands with the
    one-conversation UI change. Unit-tested; the real Electron quit path is not.
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
- Agent import (`src/main/setup/import/`, `AgentImportService` in `importer.ts`): `projects:scanAgents` (never
  rejects), `projects:previewImport`, `projects:applyImport` (returns `previousRoles` for Undo), `projects:exportOrg`
  (`.orgai/org.json`, format `orgai.org/1`), `ProjectCreateInput.importAgents` and the `ProjectPathCheck` extras
  (`agentSources`, `instructionFiles`, `existingProjectId/Name`). Sources: OrgAI export, Claude Code, opencode, Codex,
  Copilot, Gemini CLI, Kiro, Roo; AGENTS.md/CLAUDE.md-style files are listed, never roles. Models map to the project's
  connection (`model.ts`, `importTierForModel` in defaults.ts: kept, tier, or 'everyday' default). Preview and apply
  re-scan the stored project's folder (the renderer sends choices, at most 200, never roles); apply requires the
  preview's `digest` (`AgentImportApplyInput`) and refuses a missing or stale one. Items carry the whole `prompt` and
  `elevatedTools` (Bash, Edit, Write, NotebookEdit, 'canSpawn') for the UI to show. A definition with no tool list
  gets read-only Read, Glob, Grep; a 'replace' keeps the old role's MCP grants with a "Keeps MCP access" note.
  The repo is untrusted: absolute roots, realpath-confined regular files outside .git only, no process or network,
  4,000-char YAML lines and linear parser regexes (timing-tested), hard caps (see ARCHITECTURE.md
  Conventions). Every parser is verified only by fixtures written from the docs, not by files the other harnesses
  produced; Copilot, Gemini, Kiro and Roo are best-effort. No renderer code uses it yet.
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
- Skills (#11): `src/main/skills/` (`SkillService`). Project skills are specs in `Project.skills` with files in
  `<data>/project-skills/<pid>/<sid>/`; the library is `<data>/skill-library.json` + `<data>/skills/<id>/`; a project
  skill with `libraryId` is a link refreshed from its entry on every read, and a link whose entry is gone is kept but
  never run. Grants are `Role.skills`. Repo import scans `.claude/skills`, `.agents/skills`, `.github/skills`,
  `.opencode/skills` and stores a snapshot copy: `digest` covers the stored files (SKILL.md rewritten), `sourceDigest`
  the folder as found, and apply refuses a missing or stale preview digest; `skills:undoImport` restores skills, files
  and grants (one undo per project). Repo and picked folders are untrusted: SKILL.md is re-emitted with name and
  description only, shell-injection bodies (!`cmd`, ```! fences) are refused, UNC/device paths are refused, and
  `skillLibrary:addFromFolder` accepts only a path from the main-process folder picker (`wasPickedFolder`).
  - Claude: granted skills go into a run-scoped temp plugin named `orgai-<8 hex>` (`claudeSkills.ts`), passed as
    `plugins` with `options.skills` (the 0.3.312 typings, sdk.d.ts `Options.skills`, call it a context filter: only the
    listed skills are enabled, unlisted ones are hidden from the listing and rejected by the Skill tool, their files stay
    readable by Read/Bash; the earlier source read found it also adds Skill(<name>) allow rules; neither is checked live), `settings.disableBundledSkills` plus env
    `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1`, and `settings.disableSkillShellExecution` on every run; `settingSources`
    stays `['project']`. The PreToolUse Skill gate allows only `<plugin>:<name>` granted to the calling role, before
    any rule; `skill.used` is emitted from PostToolUse. `AgentDefinition.skills` is not used (it preloads content and
    grants nothing). The namespace and the options.skills behaviour were read from the bundled CLI / sdk.mjs source;
    `scripts/smoke-skills.mjs` (gate beats the allow rule, subagent use, input shape) exists, has NOT been run, and
    needs the user's consent.
  - Codex: `list_skills` / `load_skill` dynamic tools, plus a native skill lock per thread cwd (`lockNativeSkills`:
    skills/list, then skills/config/write enabled=false; config keys verified token-free on codex 0.166.0). It fails
    open with a run warning (review M2); that a disabled skill leaves the prompt is unverified.
  - `skill.used` events count into `RunUsage.skills` (at most 1000 loads per run, unknown ids dropped) and write a
    harness transcript row "Loaded skill <name>".
  - Evaluation (`skills:evaluate`): deterministic checks over the newest 20 work runs; the model step (`kind:
    'skills'`) runs only when `skillEvaluationOf(project).enabled` (an unset `enabled` follows the Team assistant
    setting, `teamReviewOf(project).auto === 'ai'`; see Self-configuration) and the estimate fits its `tokenBudget`. Evidence is
    redacted, the report persists at `<data>/skill-evaluations/<pid>.json`, suggestions apply only on the user's call.
    No A/B replay.
  - Grants are not a confidentiality boundary (review M5): skill files sit in the data dir and the temp plugin dir,
    readable by any agent with Read or Bash. Verified by unit tests and the mock adapter only.

- Team assistant (`src/main/capabilities/`, `CapabilityService`, capabilities:* IPC; see ARCHITECTURE.md "Capabilities
  (Team assistant)"): token-free discover (this project, repo, other tools' skill folders and MCP configs on this
  computer, libraries, curated connectors; MCP Registry and `anthropics/skills` only with includeOutside), a one-shot
  `complete({ kind: 'recommend' })` on the everyday tier with a deterministic keyword fallback, digest-bound apply from
  main's own snapshot (renderer sends ids only; send `candidateId` with `recommendationId`, omit `access` to keep the
  recommendation's), one undo per project, and the persisted Team review (`<data>/team-reviews/`, auto
  'ai' by default: model step bounded by everyRuns, tokenBudget and new evidence). Automatic reviews send the model
  local-machine items as kind + name + redacted target only, and library/project MCP servers with a redacted target
  (`TeamReview.modelInput: 'proactive'`); the manual Re-check sends everything ('full'). Local config files are
  untrusted: never spawned, secret names only, credential args dropped, outside candidates pinned only. A local MCP
  server with a missing secret is saved enabled: false.
  - Review fixes (2026-10-31): an MCP item's `target` is the whole command (`NAME=value command arg ...`; the command,
    args and values with whitespace or quotes JSON-quoted; preset env values shown) or `url -H "Name: value"`, never
    cut: over 400 chars (`MCP_TARGET_MAX`) or with control, zero-width, bidi or other invisible characters
    it gets a `blockedReason` ('Command too long to review') and cannot be applied (`sanitize.ts` `reviewTarget`). The
    discovery digest binds a local or registry server by `mcpSpecDigest` (transport, command, args, url, env and header
    names with registry non-secret values, secretEnv, secretHeaders), so any change to the tail or a secret slot makes
    an apply after re-discovery stale. Registry remotes must be https and not a private-IP literal; `spec.url` and
    `registry.identifier` are stored scrubbed. Registry env presets that change what runs (NODE_OPTIONS, PATH, LD_*,
    PYTHON*, NPM_CONFIG_*, UV_*, PIP_*, DOCKER_*, *_PROXY, ...) and routing headers are dropped with a note, and a
    package identifier that is not a plain name (e.g. starts with '-') blocks the item. GitHub skill folder names must start with a letter or digit ("." / ".." refused). After an apply
    the review refresh takes one snapshot slot only (`Snapshot.refresh`), so many applies from one recommend result
    never go stale. `capabilities:dismiss` takes `recommendationId` and/or `candidateId` and also works on a fresh
    recommend result (a stub review, `TeamReview.stub`, bound to that discovery holds the dismissal; the 'opened'
    throttle ignores a stub and a partial discovery is never stubbed). `capabilities:setGrant` was removed
    (no renderer caller). Team reviews at rest (`<data>/team-reviews/<pid>.json`, plain JSON) hold the discovery items
    (secret-free: names, display paths, scrubbed URLs, full MCP targets with credential args dropped) and redacted
    evidence strings (text only, no keys or tokens), never secret values. Verified by unit tests only.
  ORGAI_MOCK=1 uses `<data>/mock-home` and outside fixtures; the first finished mock work run fills the review from the
  keyword fallback without tokens. Verified by unit tests and the mock adapter (claude.ts / codex.ts `complete()`
  accept 'recommend' with no tools and an honoured signal, read and fake-tested). Unverified: real config files on a
  user's machine, the live GitHub contents API (unauthenticated, rate limit 60/h), the live registry shape, the live
  recommend call on Claude and Codex.

- Assistants (main; see ARCHITECTURE.md "Assistants (ad-hoc sessions)"): three virtual project ids (`isVirtualProjectId`):
  'quick' (Chat: `src/main/quick/`, runs:startQuick / runs:promoteQuick; RunKind 'work' with `RunSummary.quick`),
  'harness' (MCP assistant; `McpAssistInput.allowBuild === true`, library scope only, adds a per-run scratch dir
  `RunSummary.buildWorkspace`, Edit/Write/Bash and permission mode 'default') and 'skills' (Skill assistant,
  RunKind 'skill-assist', setup-like, skills:startAssist; propose_skills -> `SkillService.applyProposal`). Quick runs:
  permission mode always 'default', read-only unless allowEdits, no project MCP/plugins/skills/installs/messaging,
  grants never written to the folder, Claude `settingSources: []` with no saved-rules allowedTools, tools from
  `QUICK_TOOL_DEFS` incl. `list_projects` (secret-free ProjectPeek data block). Scratch dirs only under
  `<data>/quick` (0o700, boot sweep keeps referenced ones). Promote moves the session chain and drops `quick`.
  Mock scripts: a quick run calls `list_projects` once, says "I can see N OrgAI project(s). Tell me what you would
  like to do." and goes idle; follow-ups get "Mock reply to: <text>". A skill-assist run says "I will look at the
  skill library first, then propose a skill.", calls `list_skill_library`, then `propose_skills` (title "Mock skill",
  one create of `mock-skill`, scope 'library' on 'skills', 'project' with the first role's slug on a project), and
  after APPROVED says "The skill is set up." and goes idle. Verified by unit tests and the mock only; no live run.
  - Plan nudges (UX M5): `continuation.ts` `planNudgesApply(run)` is false for a quick run with team 'single' (a
    conversation), and RunManager folds it into `RuntimeContext.autoContinue`, so no adapter's ContinuationDriver
    sends set-plan or continue nudges there; interrupt holds and auto-resume are unchanged, team 'default' keeps nudges.
    Unit-tested (continuation.test.ts, runManagerAssistants.test.ts); the mock script needed no change. Notifier still
    reads the Chat display project (`autoContinue: false`) for every quick run, default team included.
  - Trust-restricted runs (security round, merged at 5e2384a): quick runs and MCP build sessions
    (`RunSummary.buildWorkspace`) are `isTrustRestrictedRun` (`src/main/quick/scratch.ts`). RunManager `isRestricted`
    turns a 'project' permission scope into 'session' in `decide()` for every adapter, `decideRules` keeps a
    'project' rule grant on the run, and `allowedRules` returns the run's grants only (no saved rules from the folder).
    Claude (`claude.ts`): `claudePermissionMode` ask-only (auto / acceptEdits / bypass become 'default'),
    `claudeAllowsBypass` false, `claudeSettingSources` [], `claudeSavedRules` none, `quickSafeDecision` downgrades a
    project scope, and `buildConfigWriteDenial` makes PreToolUse deny Edit / Write / MultiEdit / NotebookEdit under
    `<workspace>/.claude/` (`isWorkspaceConfigPath`: lexical plus the real path of the nearest existing ancestor; a
    missing or non-string path is denied). Codex (`codex.ts`): `onCommandApproval` / `onFileApproval` read
    `ctx.allowedRules` (saved rules only as a fallback when it is absent, never on a restricted run), a project scope
    becomes session in `ask()`, a build-session file change under `.claude/` is declined without a card (log warning
    plus a harness transcript row), and `buildLaunchConfig({ noProjectDocs })` adds `project_doc_max_bytes=0`
    (`NO_PROJECT_DOCS_CONFIG`) for restricted runs and every `complete()`, which also runs with `os.tmpdir()` as cwd;
    the key was found by grepping the bundled codex 0.166.0 binary, its effect is unverified live. `policyFor` takes
    `{ quick, setupWrites }`: a build session whose role writes gets workspace-write with untrusted approvals (bypass
    falls back to the asking default). The mock follows the same rules. Verified by unit tests and the mock only.
  - Build sessions on continue: `RunManager` option `buildProject(summary)` rebuilds the harness project for
    `projectOfRun`; index.ts passes ipc.ts `harnessProjectFor`, which accepts only an existing `<data>/quick/quick_<id>`
    dir and throws "This build session's workspace is gone" for a vanished or forged path (runs:continue is tested
    through the IPC handler in ipcAssistants.test.ts; the auto-resume path through index.ts's `buildProject` only
    with a throwing fake in runManagerAssistants.test.ts). `withBuildTools(role, summary)` keys off
    `RunSummary.buildWorkspace` (mcp/assist.ts `buildToolsFor`; `isBuildWorkspaceProject` is gone).
  - Quick-run input: `checkQuickContinue` (ipc.ts) refuses a runs:continue / runs:send text over
    `QUICK_RUN_MAX_PROMPT_CHARS` on a quick run and re-validates a non-scratch folder; `validateQuickFolder` also
    refuses a folder that contains the data dir ("That folder contains OrgAI's data…"). Promote counts a paused run
    with `autoResume` as live. `ProjectStore.save` and `saveFromRenderer` refuse virtual ids. `list_projects` and `quickChatText`
    tell the agent reading outside the folder may need the user's permission. Unit-tested.
  - Quick-path identity (merged c7d8de7, found by the v0.1.5 release build): `createScratchDir` returns the canonical
    path, and every containment or identity check compares both spellings through `scratch.ts` `isInsideEither` /
    `samePath` / `isReferencedScratch` (`canonicalDeep` resolves the nearest existing ancestor and re-appends the rest;
    `validateQuickFolder` fails closed with "OrgAI could not check that folder against its data folder." when
    resolution throws). Lexical and real paths differ on macOS (`/var` vs `/private/var`) and on the windows-latest
    runner (8.3 temp path `RUNNER~1`), which is why five quickRuns tests passed locally and failed in CI on both OSes.
    `pathKey` keeps a root's separator, so a drive root is refused by M3 (review High, pre-existing). Open Lows: case
    folding of a missing data-dir tail on macOS, a dangling link in the data dir's ancestry, and `mcp/builds.ts`
    `insideWorkspace` still compares lexically. Unit-tested with a junction (Windows) or dir symlink; macOS confirmed
    only by CI.
  - Built MCP servers (`src/main/mcp/builds.ts`, review M5): approving a library proposal from a build session copies
    a stdio server whose command or args point into the workspace to `<data>/mcp-builds/<entryId>/` (regular files
    only, symlinks and junctions skipped, realpath-confined, `.git` / `node_modules` / `.claude` skipped,
    `BUILD_MAX_FILES` 2000 / `BUILD_MAX_BYTES` 50 MB), rewrites the paths, and stores a sha256
    `McpLibraryEntry.buildDigest` over sorted relative paths and bytes; a failure rolls back the installed copies (an old build dir is restored) and discards the staged ones.
    No dependency install: a built server must vendor or bundle its deps. The dir is deleted with its library entry
    and never swept. The renderer cannot set `buildDigest` (stripped on write, malformed values dropped on read) and an
    edit that changes command or args clears it; nothing re-checks the digest at run time. `McpService` takes
    `dataDir`. Unit-tested (`serviceBuilds.test.ts`).
  - `SkillService.applyProposal` snapshots the library and project skill files and restores them on any throw.
    Unit-tested.
  - Reviewer re-check at 5e2384a: H1 and M1-M6 fixed, no Critical or High. Open LOW items (L-a to L-g, L5; listed in
    ARCHITECTURE.md Risks): buildDigest never checked at launch, partial staging of workspace paths (`--entry=`, env,
    relative args), the .claude/ guard skips Bash moves, removeEntry deletes build dirs before later commits, Codex
    empty-path / workspace-grantRoot approvals, case folding on macOS, the skills rollback can overwrite another
    project's concurrent edits. Unverified live: settingSources [] on resume, PreToolUse deny precedence,
    `project_doc_max_bytes=0`, the Codex decline text reaching the agent, workspace-write enforcement on Windows.

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

- Permissions (prompt fatigue, GitHub issue #14; ARCHITECTURE.md "Permissions and prompt fatigue"):
  - Allowed folders: `Project.allowedDirectories` (max 20, 1,024 chars each) are extra folders agents may read and
    edit like the project. ProjectStore drops on save and at boot (`cleanAllowedDirectories`, silent, logged at
    debug): relative, roots, UNC/device, the data dir either way, and through `runtime/allowedDirectories.ts`
    `allowedDirectoryRisk` the project or inside it, a folder containing it, home or above, and home config /
    credential / autorun folders (`HOME_CONFIG_DIRS` in permissionRules.ts: .ssh, .claude, .codex, .config,
    AppData/Roaming, .local/bin, Documents/PowerShell, browser profiles ...). projects:save returns the cleaned list.
    RunManager `resolveAllowedDirectories` repeats the rules at run start on real paths (both spellings of home and
    project) and warns per missing or dropped folder. Claude: `Options.additionalDirectories`; Codex:
    `sandbox_workspace_write.writable_roots`; never on trust-restricted runs.
  - Matching (ruleMatch.ts): `prefix:*` = `prefix *`; a `cd` into the project, a worktree or an allowed folder is
    free (lexical; MSYS `/c/` only for bash; win32 names ending in dot or space refused). Refused: pipes, redirects,
    `$(`, backtick, `&`, newline, unquoted `( ) { }` / `@(` / `@{`, a word-initial `@` only on PowerShell, typographic
    quotes and dashes, hidden characters in a rule or command. `programRunsProgram` (curated table in ARCHITECTURE.md)
    refuses, for every rule, options that run another program or read other config: npm-family `--script-shell` /
    `--node-options` / `--prefix` / `-C`..., go `-exec` / `-toolexec`, cargo `--config` / `-Z`, make `-f` / `SHELL=`,
    dotnet `-p:*Event=`, node `--import` / `-r` / `-e`, git global `-c` / `--git-dir`, `--config`, `--template`,
    `--output`, clone `-c`, branch `-D`, stash drop, and `PROGRAM_ENV` assignments (NODE_OPTIONS, GIT_*...); any `$`
    outside single quotes refuses the segment. Bash / PowerShell allow rules never reach the CLI (not in
    `options.allowedTools`, not in canUseTool `updatedPermissions`): the Claude PreToolUse hook is their only allow
    path, through `matchingRule` (reviewer-4 H-A, reviewer-5 H1). The one shell allow source the CLI reads itself is
    `<project>/.claude/settings.json` (`cliProjectSettings`: lstat, regular file, 256 KB, BOM, fail closed): any shell
    call the hook did not allow while that file holds a rule for the tool gets 'ask' naming the rule ("OrgAI:
    Bash(npm test:*) does not cover this command (it can run another program); asking"). Unit-tested; that a hook
    'ask' beats a settings.json allow rule is UNVERIFIED live (`scripts/smoke-permission-hook.mjs`, needs consent). Request cards flag, and project grants and Architect
    proposals never save, a prefix `isTooBroadPrefix` rejects (a quoted or `VAR=x` first word counts as too broad) (`tooBroadRuleRefusal`, the permissions:add wording). Only bare
    shells or shells in the exact `SYSTEM_SHELL_DIRS` are unwrapped.
  - Suggestions (permissionRules.ts): per segment, all or nothing, always covering the command; launchers two words
    (podman, nerdctl, kubectl, terraform, helm too), runner words and gh / aws / az / gcloud three; `isTooBroadPrefix`
    (writers, fetchers, config/eval pairs, container run / exec / compose / buildx / container, gh auth / secret,
    npm init / create, uv tool, interpreters) and blanket or destructive rules (git restore too) are never offered or
    saved, and permissions:add refuses them (`permissionAddRefusal`); folder checks fold case on darwin; a provider setMode survives only as acceptEdits. User-configured
    MCP servers get `mcp__<server>`, agent-installed ones exact tool rules. "Always allow for project" saves rules,
    the folders (ctx.allowDirectories) and acceptEdits only from 'default'. Codex file approvals in accept-edits modes
    accept only paths inside the free folders (lexical and real), never `.git` / `.codex` / `.agents` / `.claude`.
    permissions:add / remove inputs are rebuilt (`permissionRuleArgs`, rule <= 1,000 chars).
  - Mock: `[mock:fatigue]` (compound cd + npm test, a sibling-folder edit with setMode + addDirectories, a repeat
    pre-approved after the session grant); in-project edits are pre-approved in acceptEdits only.
  - Verified by unit tests, the mock and e2e/permissions.mjs. Unverified live: additionalDirectories making cds and
    edits free, session setMode / addDirectories from canUseTool, the CLI's per-segment matching agreeing with ours,
    a restarted query picking up new additionalDirectories, Codex writable_roots and its file-approval wire shape.

- Engagement phases 2-3, runtime (2026-11-04; ARCHITECTURE.md Shared contracts "Engagement kind (phases 2-3, runtime)"):
  team templates (`setup/templates.ts`, templates:* IPC, `ProjectCreateInput.templateId`, propose_org_chart
  `fromTemplate` on setup runs), single-agent work runs (`RunTeam` 'single' on StartRunInput / RunSummary,
  defaults.ts `singleRunProject`, no plan nudges, no list_projects), the engagement document and context notes in
  `<data>/projects/<id>/` (projectData.ts; `expectedUpdatedAt` refuses a stale save) with the `engagement_context`
  harness tool (audience 'all', engagement work runs and single runs), `projects:remove` / `removePreview` returning
  `ProjectRemoveResult` (removeRuns default true; engagements always forget their runs), and usage export
  (`UsageStatsQuery.range` month, `runs:usageCsv` with formula-injection quoting, leading `project` and `client` columns (names from ipc.ts, client blank for code projects), `started` / `ended` as local ISO 8601 with the UTC offset plus `started_utc`; `RunUsageRow.team: 'single'` marks Ask runs and the CSV `kind` is then `ask`). Contracts sit in one types.ts section
  with their channels in `TEMPLATE_ENGAGEMENT_IPC`. Verified by unit tests and the mock only; no renderer uses it yet.
- Engagement knowledge graph (2026-11-04; ARCHITECTURE.md Shared contracts "Engagement knowledge graph", Runtime core
  "Engagement knowledge graph in runs", Risks): `<data>/projects/<id>/knowledge.json` (`src/main/store/knowledge.ts`,
  `knowledgeStore(dataDir)` = `KnowledgeStoreApi`; pure helpers in `src/shared/knowledge.ts`: `normalizeKnowledgeKey`,
  `matchKnowledgeNodes`, `resolveKnowledgeNode`, `searchKnowledge`, `knowledgeVocabulary`). Nodes `kn_`, edges `ke_`,
  facts `kf_`; free-form `kind` / `relation` normalised to `KNOWLEDGE_KEY_RE`; identity by id, else (kind, name) /
  (kind, alias) case-insensitive; edges unique per (from, to, relation); removing a node removes its edges; every item
  carries a `KnowledgeSource` main fills. Caps KNOWLEDGE_NODES_MAX 2000, _EDGES_MAX 5000, _NODE_FACTS_MAX 50,
  _RUN_WRITES_MAX 500 (per run, notes included; checked before the store call), _SEARCH_LIMIT 50, _FILE_MAX_BYTES
  64 MB (compact JSON; a write past it is refused, and a file that exists but did not parse to a graph reads empty
  and refuses every write so it is never overwritten; review H1); hidden characters and over-long strings refused,
  never cut; an agent never replaces a user-created entity's summary (appended as a fact, `summaryKept`; review M1).
  IPC `knowledge:get / saveNode / removeNode / saveEdge / removeEdge / clear`
  (`KNOWLEDGE_IPC`, preload `window.orgai.knowledge`, inputs rebuilt by ipc.ts `knowledgeArgs`, writes on engagements
  only, every write pushes `projects:engagementChanged` `what: 'knowledge'` with `ids`). Harness tools:
  `engagement_context` gained `action: 'list' | 'read' | 'save'` (agents create notes and replace only agent-written
  ones the user has not edited; "Only the user can change that note; save a new one instead."; ENGAGEMENT_NOTES_MAX is
  200 and reported at the cap) and `engagement_knowledge` (`KNOWLEDGE_TOOL`, audience 'all', non-blocking, engagement
  work runs only, never single / quick / setup-like / trust-restricted): vocabulary, search, get, upsert_node, link,
  retire (never deletes; refused on user-written items). Results are fenced data (`<<<` `>>>`, look-alike
  substitution, `datum()`); refusals read "REFUSED: ...". RunManager (`RuntimeContext.knowledge`,
  `engagementNotes.save`) fills the source (run id, agent id, role name from the agent record), writes one harness
  transcript row on the writing agent ("Recorded <kind> <name>", "Updated ...", "Linked <a> <relation> <b>",
  "Retired <item> <label>", "Saved note <title>") and broadcasts through `RunManagerOptions.engagementChanged`.
  Context notes carry `excerpt`, `createdAt` (order by it), `source`, `recordedBy`, `updatedBy`, `retired`. Prompts:
  engagement roots and reports are told to search the graph before dependent work and record what they learn; the
  single-assistant paragraph names note saving only. Verified by unit tests with fake stores and fake adapters only;
  no live run and no renderer yet.
  - Mock marker `[mock:knowledge]` (mock.ts `knowledgeSteps`, default script, engagement work runs): before the default
    script the root calls `engagement_knowledge` vocabulary, upsert_node for Acme Corp (organisation, alias Acme, facts
    "Headquartered in Leeds" / "Fiscal year ends in March"), Jane Doe (person, alias J. Doe), the decision "Migrate
    billing to Stripe" and the risk "Legacy export format undocumented", link Jane works-at Acme and the decision
    decided-by Jane (note "Sponsor sign-off"), `engagement_context` save "Kickoff call summary", search "Acme", then
    get Acme Corp and retire its March fact (`knowledgeFactId` parses the id from the fenced result; unparsable = the
    retire is skipped with an info log, never a failure), says "I recorded what I learned about the engagement." and
    goes on with the default script; on a code project (or without `ctx.knowledge`) it says "No knowledge graph is
    available in this run." instead. Each call goes through the real harness tools, so RunManager counts the writes
    and writes the harness rows. Unit-tested with fake `knowledge` / `engagementNotes` contexts (mock.test.ts).
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

- Engagement kind (phase 1, 2026-11-03; ARCHITECTURE.md Shared contracts, Conventions, Risks): `Project.kind`
  'code' | 'engagement' (read through `projectKindOf`; missing = code), `Project.referenceDirectories` (read-only
  folders), `Project.client`. Built-in roles, prompts and copy name no industry; the Architect specialises from its
  interview (`architectPrompt(kind)`, `engagementRoles`). Engagements write nothing into the working folder: the
  engagement document and saved rules live in `<data>/projects/<id>/` (store/projectData.ts), the document reaches
  agents through their prompt, maintenance's repository tools do nothing, isolateWriters is off unless the user sets
  it (`isolateWritersOn`), run messaging is off unless set (`runMessagingOn`). Reference folders: every adapter denies
  Edit / Write / MultiEdit / NotebookEdit and Codex file changes under one before any allow path
  (runtime/referenceDirectories.ts). A Bash / PowerShell call is reference-touching when its effective cwd (Claude hook
  `input.cwd`, Codex `req.cwd`, else the project path, followed through cd / pushd / Set-Location segments) is inside a
  reference folder or any word names a path at, under or above one (quotes removed, both separators, case folded on
  win32 and darwin, `~` expanded, prefix-safe). Such a call never matches a saved or session rule, gets no suggestion,
  is answered 'ask' with "<folder> is a reference folder: agents may read it, not change it; this command names it" (or
  "runs inside it"), carries `PermissionRequest.referenceFolder`, and RunManager (every adapter) drops its suggestions
  and ruleLabels and narrows any session or project allow to once (`permission.resolved` never has `savedToProject`).
  Reads are not told apart from writes (a `type` / `cat` asks too). A Read / Glob / Grep under a reference folder gets no
  suggestion. Edit-tool denials and Codex declined file changes write one harness transcript row "Refused: <file> is in
  a reference folder (read only)" (the folder in the detail). Engagements start on permission mode 'default'
  (`newProject`) and the engagement Architect recommends it; it proposes 'auto' only on request and says OrgAI still
  refuses edits in reference folders and asks before a command that names one. The Analyst keeps Bash and its prompt
  says to write only in the working folder. Shell check hardening (review fix): a UNC or device word (`\\host\share`,
  `//host/s`, `\\?\...`, `\\.\...`) counts as touching the first folder with no file-system access (resolving it would
  open an SMB connection), as does a UNC edit path, cwd or reference folder; `-Path:X`, `FileSystem::X` and bash `\x`
  spellings are checked, `HKCU:`-style non-file-system providers are not touching and (PowerShell only) any other
  `Name:\` word is; URLs (`://`) and `Foo::bar` words never are; a cd's own words are scanned (a cd into an ancestor of a folder, `cd ..` to a
  sibling's parent, asks; `Push-Location` counts as a cd), and after `cd -`, `popd`, `Pop-Location`, a bare cd or an
  untrackable target (a variable) EVERY later segment asks until a tracked cd (fail closed); a command over 32 KB asks
  with no file-system work, one with over 2,000 words or parts asks once that count is hit. `scratch.ts` `canonicalDeep`
  (every caller) never calls the file system for a network path (`isNetworkPath`: on win32 anything starting with two
  separators, on darwin `/net/` and `/Network/`) and returns it resolved lexically only. The refusal-row cleaner also
  strips U+E0100-E01EF. A `Bash` whole-tool rule
  never allows a touching command. Honest limits: a command that reaches a reference folder through a variable
  ($HOME, %USERPROFILE%), a link created at run time, a program's own config / script file, or a provider deciding by
  itself for calls OrgAI never sees (Codex commands that run inside its sandbox without an approval request; reference
  folders go to Claude as additionalDirectories, so the CLI may treat them as working folders for its own read-only
  command approval) is not detected; the permission mode decides those, and on Claude 'auto' the classifier still
  decides for them. Codex answers 'accept' (never acceptForSession) on runs with reference folders. Mock markers: `[mock:reference-edit]` (also writes the refusal row), `[mock:reference-shell]` (a root Bash
  `del "<first ref>\brief.md"` that asks with referenceFolder set). Verified by unit tests (fake query(), fake Codex
  app-server, mock, store, RunManager, profiler, setup service, prompt and nudge wording) only; unverified live: that a
  PreToolUse 'ask' prompts under 'auto' / 'bypassPermissions', and that Claude's hook `input.cwd` follows the Bash
  tool's cd.

- Practice kit (`src/main/kit/`, `KitService`, `kit:*` IPC, `window.orgai.kit`; ARCHITECTURE.md "Practice kit"): library skills,
  library MCP servers, custom connector presets and team templates in one `*.orgai-kit.json` (`orgai.kit/1`, at most 50 MB).
  Secret values, OAuth state, tokens, `connectedAt`, `buildDigest` / built files, connector entries and ids never go in it;
  export leaves such items out with a note. Paths come only from main's save / open dialogs (`PickedPaths`; an export path
  is consumed by a successful export). Import is untrusted: items are rebuilt and validated (shell-injection skill bodies,
  hidden characters, pinned versions, preset rules, caps) and a bad item is refused alone. `kit:previewImport` gives the
  sha256 `digest` and per-item status (new / same / different / refused); `kit:applyImport` refuses a missing or stale digest
  and applies only the chosen items (add, replace, copy, skip). A replace of a server clears its stored secrets and sign-in;
  `needsSecrets` lists the slots to fill in. No undo, no renderer yet. Unit-tested only (`kit.test.ts`).
  Review fixes: export and import both refuse a server whose plain argument, env value, header value or address carries a
  credential (URL userinfo, key-shaped values, credential-like names incl. key / pat / dsn / private; pattern checks, not a
  guarantee), import adds the outside-source rules (https, no private address, `reviewTarget`, no run-changing slot names)
  to servers and preset variants (`connectorPresetsKitSave` too), templates are stored rebuilt from parsed roles and
  `KitPreviewItem.roles` shows prompts and elevated tools, skill paths use `safeKitRelPath`, skill export drops private-looking
  files, and an export target whose suffix was added here is refused when it exists (`kitExportTarget`).

- CLI & host (docs/design/cli-spec.md; Waves 0-4 landed: the socket server, `--headless-host` / `--host inproc` hosts, the
  self-control gate, the read-only `orgai` CLI, headless exec and the terminal UI; see the spec's "Implementation status"
  for deviations and what is unverified):
  - Wave 4: the Ink TUI in `src/cli/tui/` (ink 8.0.0, loaded only through `await import('../tui/index')`, the
    `out/cli/tui.mjs` chunk; lazyTui.test.ts): `orgai tui [--run]`, `attach`, bare `orgai` / `orgai [--] <prompt>`,
    `resume` without --exec. `terminal.ts` owns raw mode, paste, cursor and the alternate screen (mode chosen once;
    TERM=dumb is inline) and holds SIGINT / SIGTSTP / SIGCONT while the pager owns the terminal (`suspendForChild`);
    `session.ts` `TuiConnection` owns the one shared client and every reconnect replacement (streams `keepClient: () =>
    true`), 'configure' only on a separate per-call connection for createProject. `DecisionTray` sends the exact 5.3
    payloads (revise `feedback`, rules deny `message`) with a 750 ms swap guard; `pager.ts` spawns the absolute path,
    shell-free. Unit tests (ink-testing-library) and e2e `cli-tui.mjs` through a python3 pty on macOS (SKIP on win32);
    Merge Review, the real pager and CSI-u Ctrl+. on real terminals are not driven.
  - Wave 3: adapters call `ctx.onRootTurnEnded` on every root turn end before 'idle' and expose `settlement()`;
    `ContinuationDriver.isSettledForTurn(gen)`; RunManager `trySettleExecRun` (pure `execSettle.ts`), stall watchdog,
    idempotent `finalizeExecRun` -> one `run.finalized` with `RunSummary.execOutcome`, chain budget (an override `maxBudgetUsd` 0
    is real; a stored project cap <= 0 is no cap, `projectBudgetUsd`), headless decision policy (`decisionPolicy.ts`), `expectedRevision` / `DecisionOutcome` on every decision
    method, tombstones (`decisionIndex.ts`, socket-only `runs:findDecision`). Widening overrides need 'configure'
    (`allowWidening`, never persisted; only the timer-driven waitForReset resume keeps it, and an operate-only
    `resume --exec` drops carried allowPeerMessages / allowUnpricedBudget). `runs:stop` ends a paused run (an exec
    one in flight finalizes 'interrupted'); a waitForReset run that can no longer resume finalizes 'rate-limited', and one
    continued as a desktop run finalizes 'interrupted' first; a Claude report's hand-back (until the next root init or
    `REPORT_HANDBACK_GRACE_MS`) keeps the session unsettled; policy merge holds never count as denials; exec timer
    overrides are capped at `MAX_TIMER_DELAY_MS` (2^31 - 1 ms). CLI `orgai exec` / `-p`,
    `resume --exec`, `decide`, `runs send / interrupt / stop`; exec followers subscribe `nonInteractive` so they never
    hold `humanGraceMs`. Mock markers `[mock:exec-plan|exec-blocked|exec-question|turn-fail|rate-limit|exec-slow]`.
    Unit tests with fake adapters / query() / app-server and e2e `cli-exec.mjs` (macOS); nothing live.
  - Wave 2: `src/main/host/socketServer.ts` serves every host's socket; `AppSettings.terminalServer` ("Terminal access")
    gates host.hello and closes authenticated sockets when turned off; a headless / inproc boot turns it on only while
    `terminalServerChosen` (main-owned, set by a settings:set that changes it) is unset. A `--headless-host` launch
    stays in the background after its last window closes and leaves through its idle exit. `runtime/selfControlGate.ts`
    (before every rule and mode in claude.ts, codex.ts, mock.ts) denies the orgai CLI (file names, this install's
    `out/cli` / `src/cli` via `setOrgaiCliRoots`, ELECTRON_RUN_AS_NODE assignments) and reads, searches or shell words
    reaching `<data>/run`, `<data>/secrets.json`, `<data>/codex` (home variables and globs followed; Grep rooted at or
    above them denied). A shell command the gate cannot read to the end (over 32 KB, 2,000 words / parts / segments,
    shells or quoting nested past three levels) is denied (`SELF_CONTROL_UNCHECKED_MESSAGE`), never handed to
    bypassPermissions. The CLI is `src/cli/` (bundled `out/cli/orgai.mjs`, `npm run cli`); its help and completions
    read `commandTable.ts`; host text goes through `sanitizeTty`. The launcher hears the spawned app's 'error' and
    non-zero exit (waitForReady rejects) and filters by `hostKinds`; `orgai app` refuses (exit 6) while a `--host
    inproc` host owns the folder, and `daemon start` never spawns over a live host that refused or did not answer.
    Unit, integration (real inproc host) and e2e (`cli-host.mjs`, `cli-readonly.mjs`) on macOS only.
  - Wave 1 (`src/main/host/`, Electron-free): `bootstrap.ts` `bootOrgAIHost` builds every store and service and runs
    housekeeping; `index.ts` is the Electron shell over it (windows, menu, notifications, quit gate). `dispatcher.ts`
    `HostDispatcher` owns every request handler (`invoke` desktop path; `invokeRpc` wire path: `registry.ts`
    `gateRequest` -> `unknown_channel` / `scope_denied` / `bad_request`, mutations refused `host_draining` while
    draining, an `inFlightRpcMutations` lease each, `host.status` / `host.stop` served here, `host.stop` holds no lease
    and a second stop joins the drain); `ipc.ts` is a thin adapter (one handle per dispatcher channel plus the 11
    `DESKTOP_ONLY_CHANNELS`; arg builders moved to `host/args.ts`, re-exported, deep validators added for the decision
    and run-message channels). `HOST_CHANNEL_REGISTRY` maps every channel (registry.test.ts: dispatcher channels equal
    the socket-invokable set); `params.ts` is shallow. `events.ts` `HostEventBus` carries the 8 socket-subscribable
    pushes (the shell forwards them to windows; `app:focusRun` / `menu:action` stay window-only). `activity.ts`
    `HostActivityTracker`: `ACTIVITY_LEASE_KINDS` leases and polled sources (RunManager `activeResumeTimerCount` /
    `inFlightResumeCount`, MCP / connection OAuth flows, Team assistant and skill evaluation in-flight counts, repo
    locks), idle exit (`ORGAI_DAEMON_IDLE_MINUTES`, default 30, 0 = never) never armed on the desktop host; one shared
    drain: 'draining' at once, quiesce (CapabilityService.dispose), forced: RunManager.stopAll quit within 3 s else
    `markQuit`, then up to 10 s for writers, then `ownership.release()`. Unit-tested only (registry, params, args,
    dispatcher, activity, events, bootstrap, ipcAdapter, runManagerActivity, a booted mock host over `invokeRpc`).
    Open: desktop `invoke` ignores draining; a forced drain past 10 s releases with writers in flight (logged).
  - Repository lock: `worktrees.ts` `withRepoLock` (delegating to `runtime/repoLock.ts`) serializes ALL git operations
    per repository, keyed by the common git dir, across processes through `<commonDir>/orgai-repo.lock` (owner.json with
    pid, start time and host instance id, 2 s heartbeat, 60 s `RepoLockTimeoutError`, dead or leftover owners reclaimed
    with a read-only index.lock / MERGE_HEAD notice, carried on the lease as `repoLockRecovery()`), reentrant per async
    call chain (`RepoLockLease.released` stops detached work from reusing an ended scope) and never held across a merge
    review. A worktree and the main checkout of one repo now queue behind each other; different repos do not. The
    info/exclude line follows `git rev-parse --git-path info/exclude`, so linked worktrees and `.git`-file checkouts
    write the common dir's file. Unfinished git state (spec 3.2 (5) 4): under the lock, integrateWorktree (target and
    worktree), commitLeftovers and discardWorktree (the worktree) first look for index.lock, MERGE_HEAD,
    CHERRY_PICK_HEAD, REVERT_HEAD, rebase-merge / rebase-apply in the checkout's git dir; if any is there they run no git
    command (no merge --abort, worktree remove, branch -D, add or reset): integrate answers 'conflict' with a message
    naming the files (and the reclaimed lock), commitLeftovers an error, discardWorktree throws `UnfinishedGitStateError`
    (maintenance answers ok: false). A git-layer throw settles the worktree 'conflict', never stuck 'merging'.
    Unit-tested with real git repos (repoLock.test.ts, worktrees.test.ts, incl. the contended 2-actor test) on macOS only.
  - Host ownership (`src/main/host/ownership.ts` `acquireHostOwnership`, pure Node): index.ts calls
    `app.requestSingleInstanceLock()` after the userData override, then takes `<data>/run/` before any store is built
    (RunStore's constructor rewrites live runs): `startup.mkdir` mutex (a live holder is never robbed; a dead one is
    reclaimed by rename to `.stale-<uuid>`), `daemon.json` (`DaemonInfo`, tmp + rename, starting -> ready -> draining,
    rewritten only by its own hostInstanceId), `daemon.secret` (0600, for the later handshake) and a per-instance
    listener `d-<hostInstanceId>.sock` (runtime-dir fallback past 100 bytes; it accepts and drops connections until the
    host server lands). A live pid in daemon.json is never robbed (HostAlreadyRunningError); a failure shows a startup
    dialog and quits; released on will-quit and process exit. Liveness and start times: `host/processInfo.ts`
    (darwin `ps -o lstart=` under LC_ALL=C TZ=UTC, `isLiveProcessCached` 5 s), ids `host/identity.ts` (12 hex).
    Crash injection at every boundary (`OWNERSHIP_BOUNDARIES` / `RELEASE_BOUNDARIES`) in ownership.test.ts.
  - `log.ts` no longer imports electron (app hooks in `electronLogHooks.ts`); `host/noElectronImport.test.ts` imports log.ts,
    the host modules, the stores, RunManager, the adapters and services with electron mocked to throw.
  - Pure view-models moved to `src/shared/view/` (no renderer, DOM or React imports, `noRendererImports.test.ts`); the old
    `src/renderer/src/lib/<name>.ts` paths are thin `export * from '@shared/view/<name>'` re-exports (reexports.test.ts),
    so renderer imports are unchanged and new pure view logic the CLI also needs goes in `src/shared/view/`.
  - Contracts in types.ts: `HOST_IPC`, host wire-protocol types, `RunOverrides`, `HeadlessDecisionPolicy`,
    `DecisionOutcome`, `ExecOutcome`, `RunEndedBy` 'policy' / 'budget', `run.finalized`, bundle / CAS inputs. RunStore
    keeps 'policy' / 'budget' and a finalized exec run's endedBy on read (runs.test.ts). Nothing emits them yet.
  - `host/jsonCodec.ts`: safe reviver (`parseJsonSafe` drops `__proto__` / `constructor` / `prototype` keys) and a per-channel codec
    (`CHANNEL_JSON_FIELDS`) that carries undefined / clearable optional fields over JSON; `jsonRoundTrip.test.ts` walks
    every request and push channel. Not wired to any transport yet.
  - MCP secret env clashes (`shared/mcpSecretClash.ts` `secretEnvClashes`): `codexProtocol.ts` refuses a later stdio
    server whose secret env name another enabled server uses with a different value (a run summary line, no config
    line); MCP Settings rows show `secretClashLine`. Unit-tested; the Codex side is not run live.
  - Bundles and CAS: `SkillServiceApi.libraryAddFromBundle` / skills `readBundle` (host-validated relative paths,
    caps, shell-injection refusal), kit export / import from a bundle with an optional `targetDigest` compare-and-set
    (`kit/bundle.test.ts`); `knowledge:saveNode` takes `expectedUpdatedAt` (stale -> `stale_revision`) and
    `appendFacts`, and with `nodeId` may omit kind and name (an append-only save that never reverts a rename).
    Unit-tested only (serviceBundle.test.ts, knowledgeAppend.test.ts).
  - Unverified: Windows named pipes and their ACLs, Windows / Linux process start times, packaged builds, the startup
    dialogs by eye.

## Renderer

- Permissions UI (#14; `docs/design/permissions.md`, walk `docs/design/ux-review-permissions.md`): PermissionCard
  glance block `perm-location[data-kind]` (fails closed to "Working folder unclear"), effect sentence, rule chips with
  `data-broad`, a no-rule line, `perm-settings-link` (window event `orgai:project-settings-section`); a request with `referenceFolder` reads `perm-location[data-kind=reference]` "Touches a reference folder (read only): <folder>" plus `perm-reference-effect`, offers only Allow once and Deny and never synthesizes rules (`referenceLocation` / `REFERENCE_EFFECT` in `lib/permissionCopy.ts`; e2e/engagement.mjs drives it with `[mock:reference-shell]` and `[mock:reference-edit]`), and the reference folder hint (`REFERENCE_FOLDERS_HINT`) says OrgAI refuses edits and asks before any command naming the folder, with no "never" promise; Settings >
  Permissions Allowed folders `allowed-folder-*` (inside the `permissions-summary` disclosure) (quiet notice for folders main dropped on save); rules panel grammar
  check and kind chips. Helpers `lib/permissionCopy.ts` (`referenceEffect(toolName)`: command wording for Bash / PowerShell, "This call reads..." for Read / Glob / Grep; `permissionOffer` is the pure guard that hides scope buttons, chips and the settings link under a `referenceFolder`), `lib/decisionTitle.ts`; `Button` takes `inert` (aria-disabled, focusable, swallows clicks, styled in controls.css) and `ariaDescribedBy`; e2e `e2e/permissions.mjs` (e2e:free).
- Dashboard (spec `docs/design/dashboard.md`, walk `docs/design/ux-review-dashboard.md`): `views/DashboardView.tsx` +
  `components/dashboard/` replaced the Projects view (store View id stays 'projects'; sidebar item, rail name and topbar
  h1 read "Dashboard"). Hero `dashboard-hero` / `dashboard-figure` (`lib/dashboard.ts` `heroFigure`), the page's one polite
  region `dashboard-live`, `dashboard-app-facts`; attention column `dash-needs-you` (`dash-needs-row[data-kind]`, same
  count as the bell), `dash-running`, `dash-since` (`dash-since-row`, `dash-since-continue`, `dash-since-clear`),
  `dash-paused` (`dash-paused-resume`); grid `dash-projects` with `project-tile[data-name]` ordered by
  `projectAttentionOrder`, `project-tile-more` (Open / Open folder `project-tile-open-folder` via
  `window.orgai.app.openPath` / Delete `project-tile-delete` with `deleteProjectBody`); facts `dash-usage`, `dash-cost`
  (last 7 days, `Cost`, unknown never $0), `dash-connections`. New project is `Dialog` `new-project-dialog`
  (`NewProjectForm` lives in `components/dashboard`, `hasParkedDraft` reopens it); first launch `dash-start-choice`;
  store `openNewProject()` / `newProjectRequest` (the app menu's 'new-project' action). Last seen: localStorage
  `orgai.dashboardSeenAt`, set on first load, moved only on in-app navigation away (never quit or reload), cap 6. Pure
  helpers: `lib/dashboard.ts`, `components/dashboard/dashboardProjects.ts` (unit-tested). e2e `e2e/dashboard.mjs` (e2e:free);
  `e2e/lib.mjs` `gotoProjects` / `openProjectForm` / `createProject` / `deleteProject` use the Dashboard. Reviewer: no
  Critical or High. Open: hero may announce once after history loads, delete confirm counts open runs from live runs only,
  `weekCost` unused, no e2e for focus after a tile opens, no `nav-dashboard` testid. Not built (need new contracts):
  cross-project usage stats, run outcome/changes, cut decisions after a relaunch, per-project team suggestion counts,
  update check.
  - Fix-up after the re-walk (3507ebe, `docs/design/ux-review-dashboard-2.md`): `continueFromHistory(runId, projectId?)`
    selects the project through `focusRun` when needed, opens the chain's newest run and focuses the composer (never
    starts a run); `dash-since-row` / Running / Paused rows open the run and land focus on a real element, else the topbar
    h1; `removeProject` drops the project's `historyByProject`, `activeRunByProject`, `draftPage`, `runs` and
    `dismissedRuns` entries and the summary hooks ignore runs of unknown projects; `useLastSeen` adds `clearedAt`
    (localStorage `orgai.dashboardClearedAt`, moved only by Mark all seen) so closed-waiting rows survive trips away;
    `heroSublineParts` adds "N were waiting on you when OrgAI closed" under "All quiet"; `HeroBand` joins a delete
    message and a figure change within 1.5 s into one announcement. Verified by renderer unit tests and e2e/dashboard.mjs
    relaunch checks (Continue opens the Live view, row click focus, deleted project gone from Since and Cost). Walk-2
    status: H1, H2, M1, M2, M4 fixed; open: M3 (a paused run cut by a quit reads "Ended when OrgAI closed" with no limit
    note or Continue; needs a main-side marker), M3-old focus partly, M4-old first-launch scroll at 1024x640, L1-L8 of
    walk 2 (incl. hero cost vs Cost card unchecked, Usage dead space / Connections below the fold at 1424x855, wordmark
    "( MOCK Dev" in light theme, mock named four times on first launch).

- Engagement kind (renderer, phase 1; `docs/design/engagement.md`, walk `docs/design/ux-review-engagement.md`): the New project form opens with the `project-kind` fieldset (`project-kind-option[data-kind=code|engagement]`, native radios, none chosen on first launch, last kind in localStorage `orgai.lastProjectKind`, initial focus on the checked radio) and swaps fields per kind (engagement: `new-project-client`, "Working folder", `new-project-ref-*`, `architect-setup` "Start with the setup interview (recommended)", "Create and start interview"). Settings: `project-kind-line`, `project-client-input`, `reference-folder-*` above `allowed-folder-*` (move with `reference-folder-allow-changes` / `allowed-folder-make-readonly`), `maintenance-engagement-line` (no "Remove OrgAI files"). Cards: `perm-location[data-kind=reference]`, "Approve engagement plan", Needs-you rows say "Engagement plan" (`proposalKindLabel`, `waitingItems(run, projectKind)`; the DecisionTray chip in LiveRunView still says "Architecture"). Grouping (`lib/clientGroups.ts`): sidebar `nav-client-group[data-client]` with two or more distinct clients or whenever engagements and code projects are both listed (no client names at all: the group is "Engagements"; engagement rows carry `data-kind=engagement`, a Briefcase `nav-kind-mark` in the list and "<name> · Engagement" in the rail tooltip and name) (collapse in `orgai.sidebarClientGroups`), `nav-client-code-label`, rail `hr.nav-client-divider`, `tile-client`, `project-client`. e2e/engagement.mjs (in e2e:free) drives the form, creation, settings, reference card, Maintenance, grouping, tile and topbar at both sizes and themes; the architecture card, reference `perm-location`, the extras-save failure and `NewRunPage` copy are unit-tested or unseen only.
- Resizable columns share one width budget (`lib/panelWidth.ts` `panelBudget`): the canvas keeps 280 px (`CANVAS_MIN_PX`); when the side panel minimum (280 px) does not fit it shows as its rail (saved width and choice kept, re-applied when space returns). `SidePanel` `autoCollapseBelow` reacts to first layout and window resizes only, never to handle drags. Resize handles: Enter or double-click resets, arrows move the splitter.

The UI overhaul landed on native elements with container queries. Radix and react-resizable-panels are not installed,
and the frontend-design skill is not vendored in `.claude/skills` (only `run-desktop` is there).

- Cost and usage (#10): every cost goes through `lib/cost.ts` `costView` and `components/ui/Cost.tsx` (unknown is
  never $0, "$0.42+" is a lower bound). The run side panel has a Usage tab (`components/UsagePanel.tsx`, `SideTab`
  'usage'); History switches Runs | Trends (`components/UsageTrends.tsx`, `runs:usageStats`). App settings >
  Connections > Model prices is `components/settings/ModelPricesSection.tsx`; `lib/settingsTarget.ts`
  `requestModelPrice(model?)` deep-links to it with the model pre-filled. The account popover shows the quiet line
  `usage-no-five-hour` ("Five-hour window: not reported by your plan right now.", `UsageMeter.tsx` `missingFiveHour`)
  when a subscription report lists plan windows but no five-hour one (seen 2026-11-04 on a Max login: `five_hour:
  null` beside Seven-day and the Fable weekly window), and the sidebar footer bar shows the tightest reported window
  (`tightestWindow`); unit-tested in `components/usageMeter.test.ts`, not driven by e2e (the footer meter is hidden
  under the mock adapter).
  - LiteLLM spend by period (2026-11-04, walk + notes `docs/design/ux-review-litellm-periods.md`): the account row shows one figure from `lib/usage.ts` `spendRowLabel` ("LiteLLM · $3.20 today" with `UsageSpend.periods`, else the budget text); under about 244 px of sidebar `.sidebar-footer` (an inline-size container) hides the name to sr-only (`span.account-name`) so "$142.10 today" never clips, and the 4 px bar yields first; `title` and the rail name carry `spendSentence` ("LiteLLM spend: $3.20 today, $12.40 this week, $31.00 this month. $42.10 of $50.00 budget." / "... No budget set."). Bar and dot tone stay the budget level. The popover `SpendSection` adds a `dl` `spend-periods` (`spend-period[data-period=day|week|month][data-present]`, `spend-period-value`, `dt` title "Since <date> (UTC)" from `periodSince`; rows from `spendPeriodRows`), else `spend-periods-missing` showing the fixed `periodsNote`, then `spend-lifetime` ("Lifetime $X" from `lifetimeText`, only when `totalUsd` differs from `usd`), then the Stale line (`usage-stale`); the head figure is `spend-budget`. Dashboard Usage card: `spendRowFigure`, the bar, `dash-usage-periods` ("$12.40 this week · $31.00 this month"), empty text "No spend reported yet.". Helpers `periodText`, `spendRowLabel`, `spendRowFigure`, `spendSentence`, `periodsCaption`, `periodSince`, `lifetimeText`, `SPEND_PERIOD_LABEL`, `SPEND_PERIOD_ORDER` are unit-tested; the UI was hand-checked with a fake report through a throwaway hook (not in the repo) at both sizes and themes; never driven by e2e (the mock reports no LiteLLM spend) and never seen with a real proxy.
- Layout: `components/layout` (`CanvasFrame` with `FrameToolbar` / `FrameStage` / `FrameTray` / `FrameFooter`,
  `SidePanel`, `SaveIndicator`). Nothing floats over the canvas: decision cards sit in `FrameTray` on the
  `components/DecisionCard.tsx` shell.
- Primitives: `components/ui` (`ConfirmDialog` + `useConfirm` instead of `confirm()`, `Input`, `Textarea`, `Checkbox`,
  `Select`, `SettingRow` and the earlier ones). `IconButton` requires `label`, and `Button` takes `ariaLabel`.
- Shell: sidebar is `BrandLockup` + nav + project list + one 52 px account row (Popover with plan windows) and the gear
  "App settings"; below 1180 px or with Ctrl/Cmd+B it is a 56 px rail (`lib/useSidebarCollapsed.ts`). The topbar is 48 px:
  name, folder name only (`lib/paths.ts`), underline `Tabs` named "Project sections". e2e helpers: `projectTab`,
  `openAppSettings`, `openProject` (via `[data-testid=nav-project][data-name]`); the account row is `[data-testid=auth-pill]`,
  the folder `[data-testid=project-folder]`, run status is read from `.run-tab[aria-selected=true]`.
- Resizable columns: `components/layout/ResizeHandle` is a `role=separator` (vertical, `aria-valuenow/min/max`, focusable) inside the column it resizes, on the edge facing the neighbour, so it never overlaps the canvas. It supports captured pointer drag, Left/Right (16 px, Shift 64 px), Home/End and double-click to reset; `lib/panelWidth.ts` holds the pure clamp/drag/key helpers (tested) and `usePersistedWidth`. Sidebar: 200-420 px (default 232), localStorage `orgai.sidebarW`, App sets `--sidebar-w` on `.app` and the main area keeps at least 480 px; shown only in the full sidebar, not in the rail (the chosen width survives collapse/expand). Right `SidePanel`: 280 px up to whatever leaves the canvas 280 px (no fixed maximum), localStorage `orgai.sidePanelW.<persistKey|default>`, drives `--side-panel-w` on the parent grid (`.editor`, `.run-body`; unset means the CSS default 360 px / clamp(280px, 28cqi, 400px)) and the canvas keeps at least 280 px; hidden while the panel is collapsed. Dragging below the minimum does not snap to the rail. From a measured panel width of 480 px `SidePanel` sets `data-side-wide` on the parent; `.run-body[data-side-wide]` then moves the same `.composer` element (no remount) into the panel column under the transcript. The run frame docks its tray beside the stage only when the tray has content (`.frame-tray:not(:empty)`), else an empty tray column left a blank strip beside the canvas. The account popover's `UsageMeter` has no Refresh button or Updated text: it calls `refreshUsage()` on open when data is older than 60 s, then every 60 s while open (one call in flight, at most one attempt per minute even on failure). A non-current connection gets a section only while it is in use (`connectionInUse` via `lib/usage.ts` `connectionsInUse`) and has a report (`connectionOrder`); stale reports of unused connections neither show nor force a refresh.
- Engagement follow-ups (renderer): `lib/mcpScope.ts` and `lib/kitApi.ts` now re-export their types and limits from `@shared/types` (no mirrors, no casts); Trends "Save CSV..." says "Your browser is saving the CSV." (the renderer cannot see where a Blob download lands); `roleCapabilities.ts` `waitingLabel` splits "Needs sign in" from "Needs a value for this project" / "Needs N values for this project" (`secretScope === 'project'`). `e2e/per-project.mjs` nudges the open Catalog with a library write after its raw IPC link; its last check (focus on the copy's More actions button) still fails and is pre-existing.
- Wide panel: `SidePanel` sets `data-side-wide` on its parent grid at panel width >= `PANEL_WIDE_PX` (480) and clears it below `PANEL_NARROW_PX` (448, hysteresis via `nextWide`). The Live view's canvas refit skips a resize caused by that layout switch. The composer is a container (`composer`) and drops its hint under 560 px; transcript text/user/thinking entries cap at 90ch.
- Dev builds: a package.json version with a `dev` prerelease tag (`0.1.6-dev1`; `lib/buildChannel.ts` `isDevBuild`) shows a quiet info "Dev" Badge beside the wordmark (a "D" pip on the mark in the 56 px rail), `[data-testid=dev-build-badge]`, labelled "Dev build <version>", plus a "Dev build" badge by the version in App settings > About. e2e/layout.mjs expects it whenever package.json says `-dev`; drop the tag for a release. After a release, dev is bumped to `<next patch>-dev1` and the dev number counts up per dev build (`0.1.6-dev1`, `0.1.6-dev2`, ...) until the next release drops the tag.
- Status words come only from `lib/runStatus.ts`: Running, Needs you, Idle, Paused, Finished, Stopped, Failed. An ended run's word comes from the summary (`endedBy` 'user' = Stopped; 'app' or `endedWithApp` = Stopped shown as "Ended when OrgAI closed" through `statusText`, which every status text uses; `isStoppedRun` only for old records).
- Run chains (spec 2.5 "Finished run", `docs/design/ux-review-continue.md`): a run and its continuations are one conversation. One tab per chain (`.run-tab-wrap[data-chain]` = oldest member id, `data-run` = newest), title and tag from the first member, status from the newest; openRun always shows the newest member (sends, Interrupt, End session go there) and `loadChain` fetches earlier records lazily (newest 10 members, 4 fetches at a time, older ones behind `chain-load-earlier`; the merged feed caps at 5000 items behind a `chain-omitted` row; the composer draft is keyed by chain). The feed merges every member oldest first with a `chain-divider` row per continuation ("Continued 3 min later" / "Continued after OrgAI closed"; the adapters' "Continued from run" row is hidden); earlier members' agents fold into "Earlier: N agents" groups; the root sums tokens and cost. An ended continuable run's composer continues by default (`endedComposerCopy`: "Session ended ... Send to continue with its memory.", primary Send, `composer-cut-notice` when OrgAI closed, `go-to-latest` on an older member); New run is the "+" tab / Ctrl+T only. Under 1100 px an ended continuable work run opens in the conversation layout. History is one row per chain (`N sessions` badge, `history-sessions-toggle` member rows, summed cost). Open chain tabs are restored per project on relaunch (`lib/openTabs.ts`); focus stays in the composer after a continue and End session. e2e: `e2e/runs.mjs` (continue in the same tab, divider, relaunch "Ended when OrgAI closed"; `relaunch()` in e2e/lib.mjs). Not done: the Usage tab "Whole conversation" switch; earlier groups sit under the root, not above.
- Canvas fold: Hide finished agents (`lib/foldFinished.ts`, pure, unit-tested): an agent folds when it has a parent, is settled (done or failed, worktree settled, 6 s grace; a done agent with no `endedAt` settles at once) and nothing under it is live; a hidden agent's whole subtree joins the group of its nearest visible ancestor, so a finished subtree is one `done-group` under the agent still shown above it (never a parentless group; earlier-session groups hang under the root). Counts, failed, unmerged and cost cover the subtree; the tooltip names direct reports first. `expandedGroups` is keyed by the group's key (that visible ancestor's id, or an earlier-session key): expanding shows the direct reports, whose own finished reports fold into one group per report; turning the switch off and on again folds everything back. The side panel `FinishedList` lists the whole subtree, newest first, with an "under <name>" line for members that are not direct reports. The grace is timed by one `setTimeout` for the next settle moment (`nextSettleAt` / `settleTimerDelay`, 250 ms floor, keyed only on that moment, never on the agents array), so reports fold while the run is still Running. Agents are named by `lib/agentTree.ts` `agentLabel` (handle first, as the canvas node shows it, else the role name; a handle with hidden or control characters falls back to the role name, longer than 64 chars is cut) in the group tooltip, the expand button label, the "Showing N agents under X" announcement and `FinishedList` (role name as a caption beside the handle). A report group's expansion stores its time: reports finished by then stay shown, ones that finish later fold again. UX walk: `docs/design/ux-review-fold.md` (d6e57b6); H1 (no fold while events stream), H2 (role names instead of handles) and M1 (sticky expansion) are fixed, unit-tested only (no app or e2e run); open: M2 (unreadable fit after a large expand), M3 (Enter/Space now select a focused node, fixed with canvas themes phase B; focus ring checked only by eye), M4 (cascading folds and re-fits), L1-L5, focus is lost when a focused node folds, and a report whose worktree settles after an expansion stays shown. The node carries `data-testid=done-group` and `data-count`. e2e/runs.mjs drives it with the mock marker `[mock:deep-tree]` (work runs, default script): root -> `mock-lead` -> `mock-lead-report-1` / `-2`, all reports finish; the run goes idle and finishes on End session. Checks: one "3 done" group under the root, expand to `mock-lead` plus a "2 done" group with an edge, fold back, both themes at 1024x640 and 1600x1000.
- Canvas themes, phase A (spec `docs/design/canvas-themes.md`, walk `ux-review-canvas-themes.md`; ARCHITECTURE.md
  "Canvas"): App settings > General > Canvas (`components/settings/CanvasSection.tsx`, right after Appearance, outside
  Advanced, whose group is now "Motion"; `APP_SETTINGS_SECTIONS.canvas`, the deep link focuses the checked style) has a
  live sample (`canvas-preview`, inert, `lib/canvasSample.ts`), the style gallery (`canvas-preset[data-preset]`, a
  one-stop radiogroup, Custom only when no available preset matches) and a Customise disclosure (`canvas-customise`,
  localStorage `orgai.canvasCustomise`; `canvas-backdrop-select`, wrappers `canvas-layout` / `canvas-edges` /
  `canvas-node-style` around native radios, switches `canvas-tint` / `canvas-minimap`), announced through
  `canvas-announce`. The Live and Team toolbars have `canvas-style-button` (popover `canvas-style-popover`, picks apply
  at once through `lib/canvasSettings.ts` `saveCanvas` and speak through the frame's `tray-announce`; `canvas-style-more`
  opens the section). `lib/theme.ts` writes `data-canvas-{pattern,edges,layout,node-style,tint,minimap}` on `<html>`;
  canvases read only `lib/canvas.ts` `useCanvasOptions()`. Each canvas draws `components/canvas/CanvasBackdrop`
  (`canvas-backdrop[data-pattern]`, 9 patterns, `circle.canvas-ring` guides in radial on Live and the sample,
  `div.canvas-scanlines` on Terminal), `CanvasMinimap` (bottom-left, `minimapSize` from the stage, one shape per node
  through `useNodeDims`), `.react-flow[data-layout]`, `layoutCanvas` (dagre TB / LR or `radialLayout`; the Team editor
  uses it for Auto-layout only) and `RadialEdge`; nodes carry `data-style` (card or compact 160 x 40 pills, detail in
  the tooltip) and call `useHandleRefresh` so edges follow a layout switch. Edges are `edgeStroke` mixes; messages are
  dotted `.msg-edge` in `--edge-message`. The legend has eight entries (Working, Needs you, Finished, Failed, Selected,
  Folded finished agents, Reporting line, Message between agents). e2e `e2e/canvas.mjs` (in e2e:free; mock, 1024x640
  and 1600x1000, both themes): the section and gallery keyboard, Customise, every backdrop on Live, Terminal in light,
  the three layouts on `[mock:deep-tree]` (and edges leaving the right side in left to right), compact sizes, the
  minimap count and size and that neither popover lands on it, reduced motion, the popover's focus return and deep
  link (`windowShift`), and the Team editor following backdrop, lines, minimap, name tags and Auto-layout. Unverified:
  message-edge styling and the Starfield glow (the mock sends no agent messages), contrast ratios (computed by hand in
  the spec, not measured), custom accents and role colours, System theme, large runs, ring guides in the Team editor
  (none drawn: its positions are the user's).
  - Phase B (spec sections 4b, 4c, 11): node styles `station` (subway map: a 32 px circle in `--role-ink`, the role
    colour through the edge mix, name pill `.station-name` beside it top down and below it otherwise per
    `stationGeometry`, the root an interchange, handles on the circle; 6 px lines in the lead's colour through
    `reportingLineRole`, no arrows, never dashed, smoothstep radius 12; a folded group is a `.station-terminus` bar) and
    `hex` (120 x 104 flat-top `.hex-tile` / `.hex-fill`, radial packs a honeycomb through `honeycombSnap` with no ring
    guides, radial edges clip at the hexagon or circle through `canvasShapes.ts` `exitPoint`). Subway and Hive show in
    the gallery and popover; "Agents as" offers Cards, Name tags, Stations, Honeycomb; the legend swaps its Finished,
    Folded and Reporting line shapes per style. A "Default" gallery entry (`data-preset=default`, renderer-only,
    `shownStyle`) is checked on the DEFAULT_APPEARANCE canvas, so a fresh profile no longer reads Custom.
  - Re-walk fixes (`ux-review-canvas-themes-2.md`): non-card nodes show `agentLabel` (handle first, middle-clipped
    through `splitLabelTail`), the role name is the tooltip caption; Enter / Space on a focused Live node selects it
    (React Flow 'select' changes in onNodesChange; the group chevron stops the key); message edges use the side
    handles facing each other (`messageSides`, ids `msg-out-<side>` / `msg-in-<side>`); selection wins over state
    colours and adds a shape cue (a 4 px leading bar on cards, a 3 px border on name tags) so it never reads as focus;
    radial cards fit no lower than zoom 0.7 (`canvasFit.ts`); the settings preview is sticky in the one-column layout
    with `scroll-padding-top` on the scroller.
  - e2e/canvas.mjs adds: Subway and Hive from the gallery, station lines from mock-lead share edgeStroke of its role
    colour (6 px, no marker), a station terminus, hex tiles 120 x 104 without overlap and without rings, no page scroll
    in both styles at both sizes and themes, Team role nodes in both styles, name tags showing distinct handles, Enter
    and Space selecting, Default checked on a fresh profile and after Blueprint, the sticky preview. Unverified:
    message edges in a live run (the mock sends no agent messages; side choice is unit-tested and seen in the settings
    sample), radial messages, contrast of `--role-ink` shapes (computed from the edge mix, not measured), hex and
    station at large runs, the Team editor selection cue by eye, System theme.
- Approved changes reach mounted surfaces through `project.updated` (store `handleEvent` replaces the project): `useProjectSkills`
  reloads when a value string of the project's skill ids and role grants changes (not references, so chart drags do not refetch;
  skipping the ones its own `apply()` pushed); saved rules refresh through the store's `rulesChangedByProject` counter
  (`lib/rulesChange.ts`, bumped on project-scope `rules.resolved` grants, `project.updated` and `permission.resolved` with
  `savedToProject`, the permission card's "Always allow for project") read by `PermissionRulesPanel`, which refreshes under a
  sequence guard; the MCP list already reloaded on `project.mcpServers`. Checked by unit tests of the helper and of
  RunManager.decide only; no e2e, not seen in the app.
- Run view: one 40 px run strip (`[data-testid=run-strip]`: run tabs plus Interrupt / End session / Org retrospective), then a 32 px canvas toolbar
  (`[data-testid=run-meta]` metadata, Hide finished switch, zoom IconButtons, the legend popover). The tray stacks under the canvas and docks
  beside it only in a frame of 1500 x 560 or more; `section.frame-tray[data-compact=true]` marks a frame under 480 px high.
- Application menu (renderer; `docs/design/ux-review-menu.md` Implementation notes): `lib/menuActions.ts` holds
  `routeMenuAction` (installed once by `lib/useAppMenu.ts` through `installMenuRouter`, also fed by `window.orgai.onMenuAction`
  and by `runMenuAction` from keydown handlers; unknown names ignored, never throws), the store fallbacks, `menuStateFor` /
  `menuStateChanged` (the five `MenuState` booleans, sent once on mount and then only on change), `announceMenu`, the one
  `SHORTCUTS` table, `openRunWindow` and `closeCurrentTab` (shared by Ctrl+W and Window > Close tab). A screen-local handler
  from `lib/menuRegistry.ts` runs first; it returns the sentence to announce when the action does not apply, else the store
  fallback runs. Announcements use the run tabs' `tabNotice` when a project is in the run view, else the app-wide sr-only
  status region `menu-announce` in `components/AppMenuLayer.tsx` (which also mounts `KeyboardShortcutsDialog`,
  `keyboard-shortcuts-dialog`, styles in `styles/menu.css`). `useRunTabShortcuts` routes Ctrl+T / Ctrl+W through
  `runMenuAction('new-run' | 'close-tab')`; LiveRunView registers the canvas, Hide finished, Show conversation and Go to
  decision handlers (Ctrl+. / Alt+D call `runMenuAction('go-to-decision')`, no tray guard), RunActions registers Save chat
  as project and Org retrospective only while they apply. The `run-tabs-notice` status span is always mounted and
  `setTabNotice` clears and re-sets a repeated text (a per-call sequence, so an older timer never clears a newer notice;
  Reviewer M1). A click on a greyed native item never reaches the renderer; only key presses or stale commands announce.
  Unit-tested (menuActions.test.ts, mocked store and window) and e2e/menu.mjs (in e2e:free; mock, 1024x640 and 1600x1000,
  dark and light: items clicked through `Menu.getMenuItemById(id).click()`; Team enabled/greyed, View > Team, New run and
  Ctrl+T one draft, Show conversation, Interrupt enabled while the session is open, Org retrospective on a live run
  announced, the shortcuts dialog with Esc and focus back, New chat, About, Ctrl+T on Projects announced). Not driven:
  macOS (Cmd keys may run twice if both the menu and the keydown fire; reviewer L2), run-scoped windows, canvas zoom/fit.
- "Needs you" counts decisions (cards), never runs: the bell, the Needs-you row, the project row badge and subtitle
  ("3 decisions · 1 run") and the topbar all come from `lib/needsYou.ts` `waitingItems` / `decisionCount`. A run row's dot
  is the run's status. A Needs-you item names the kind and the ask first, then the location, and opens that card.
  A question card shows its options inline at every size (`DecisionCard` `inline`); the tray shows the first open decision.
- Proposal cards (`docs/design/proposal-cards.md`): an org chart card shows a changed role's new prompt ("Show new prompt") and an added role's prompt ("Show prompt") in an `org-diff-prompt` disclosure through `ClampText`/`showHidden` with the hidden-characters badge (review M3; e2e/proposals.mjs); card read errors speak through the frame's one `tray-announce` (`useFrameAnnounce` in `CanvasFrame`).
- Project tabs are Live, History, Team and Settings. The org chart editor is `views/TeamView.tsx`, and project
  settings are sectioned through `components/settings/*`.
- Settings pages (2026-11-03, `docs/design/config-review.md` + Implementation notes; ARCHITECTURE.md "Settings
  pages"): App panes General (Appearance, Notifications, New projects; Advanced: Motion and canvas, Assistant models,
  New projects (advanced)), Connections (cards; Advanced: Costs, Model prices), Connectors, Skill library, About; the
  Defaults pane is gone and its old ids open General. Project panes General (with the Connection section),
  Permissions (`PermissionsSection`, replaced Agents), Limits, Maintenance; stored ids agents / connection / tools map
  over, Plugins moved to Team > Catalog. Each pane has at most one closed "Advanced settings" disclosure
  (`settings-advanced[data-pane]`, open state in localStorage `orgai.settingsAdvanced.<paneKey>`; deep links open it).
  `requestAppSettingsSection` targets: `appsettings-section-connections`, `-model-prices` and `-costs` (Connections),
  `-assistant-models` and `-new-projects` (General), `-mcp-library`, `skill-library`, `-about`; the Chat start page
  (`chat-model-change`), `AssistantModelLine` and the MCP assist dialog's "Change in App settings" go to Assistant
  models. Store: `defaultConnection` from `ConnectionInfo.isDefault`, `defaultConnectionChosen` /
  `defaultConnectionStored` from settings, `setDefaultConnection(id | null)` the only writer. Testids:
  `settings-advanced[data-pane]`, `new-projects-section`, `default-mode-select`, `*-model-row-select`,
  `default-connection-badge`, `default-connection-mode` ("Chosen" only on the user's pick, "Automatic" on a fallback),
  `connection-make-default`, `connection-default-auto`, `connection-default-error`, `connections-live`,
  `community-prices-row`, `project-connection-line`, `proxy-family-notice` (only with other-family roles),
  `project-start-refusal` (`lib/remap.ts` `startRefusal` = shared `mixedFamilyRefusal`), `project-path`,
  `permission-mode-tradeoff`, `permission-mode-default`, `permissions-summary`, `permissions-summary-toggle`,
  `team-assistant-select`, `plan-guard-line`, `new-project-connection`, `new-project-connection-change`,
  `chat-model-change`, `role-model`, `role-model-advanced`, `role-exact-model`, `role-effort`,
  `role-effort-unsupported`, `plugin-add`. Removed: `role-tier-badge`, `catalog-plugin-settings`, `tools-team-pointer`,
  `open-team`, `skill-settings-section`. e2e (mock, Anthropic only): connections.mjs checks the panes, Advanced
  disclosures and deep links, the default badge, `project-connection-line` and the role Model select (`role-model`
  inside `role-model-fold`); assistants.mjs checks `chat-model-change`; permissions.mjs checks the Permissions pane,
  its summary toggle and the Limits pane (`plan-guard-line`). Not driven by e2e: `new-project-connection`,
  `role-exact-model`, make-default, Back to automatic,
  setDefault refusals, the multi-connection project cards, the LiteLLM notices and the unsupported-effort note
  (`defaultMode`, `defaultChangeAnnouncement`, `startRefusal` and `lib/roleModels.ts` are unit-tested).
  - Fix-up after the re-walk (39e0da6, `docs/design/ux-review-config-2.md` "Status after fix-up", config-review.md
    Implementation notes): deep links inside settings scroll with `lib/scrollWithin.ts` (only the nearest scroll
    container; shifted ancestors, html and body are reset), never `scrollIntoView`; e2e `lib.mjs` `windowShift(page)`
    checks the window did not move. The plan guard line is `lib/settingsCopy.ts` `planGuardLine(mode,
    maxWindowShare)`: automatic moves to the everyday tier past 80% of the weekly window, a run that reaches a plan
    limit pauses until it resets, and the five-hour share sentence appears only when a share is set.
    `PERMISSION_MODE_SHORT` (settingsCopy.ts) is the one short-name table for App General, project Permissions and the
    permission card. `perm-settings-link` targets the `rules` section (Permissions pane, disclosure open, "Saved
    permission rules" focused); `team-assistant-settings` (gear in the Team assistant tray) opens Permissions >
    Advanced with `team-assistant-select` focused (`lib/openProjectSettings.ts`, `PROJECT_ADVANCED_SECTIONS` in
    settingsTarget.ts). Role panel: `lib/roleModels.ts` `exactModelValue` (Exact model shows a pinned id only for a
    Custom role; "Not set" returns to the saved tier) and `roleChipLabel` (the org chart node chip shows the tier word,
    the model id in its tooltip). Assistant lines share `lib/assistantModels.ts` `useAssistantRunsOn` /
    `assistantModelLabel` / `runsOnText` ("Runs on Everyday tier (sonnet) via Anthropic"); `assistant-models-note`
    names the default connection. e2e (mock, Anthropic only): assistants.mjs checks the "Runs on" wording on the MCP
    and Skill lines and the dialog hint plus `windowShift` after every Assistant models link at both sizes;
    connections.mjs the App deep links' window shift, the shared mode names, the note and one "Model" in the role fold;
    permissions.mjs the plan guard line with and without a share, the card link landing on the open rules,
    `team-assistant-settings` in one click and the review switch's reason; team.mjs Exact model Not set and the
    custom round trip (skipped when the mock catalog has no id outside the tiers). Unit tests: scrollWithin,
    settingsCopy, roleModels, assistantModels, settingsTarget, permissionCopy. Non-Anthropic connections are not
    driven. Open: N7, N9, N13 and the Lows in ARCHITECTURE.md Risks.
- e2e:free is `e2e/layout.mjs`, `dashboard.mjs`, `runs.mjs`, `proposals.mjs`, `maintenance.mjs`, `connections.mjs`, `connectors.mjs`, `import.mjs`, `skills.mjs`, `usage.mjs`, `team.mjs`, `canvas.mjs`, `assistants.mjs`, `permissions.mjs`, `menu.mjs`, `engagement.mjs`, `engagement2.mjs`, `per-project.mjs`, `presets.mjs`, `knowledge.mjs`, `knowledge-graph.mjs`, `knowledge-run.mjs`, `cli-host.mjs` and `cli-readonly.mjs` (package.json). Update selectors in the same change.
- Engagement phases 2-3, renderer (2026-11-04; `docs/design/engagement-2.md` "Implementation notes"): Team tab
  Templates menu (`team-templates`, save / apply dialogs, `template-notice` with Undo through `undoImport` and
  `ImportNotice.source: 'template'`), New project "Start from a template" (`setup-choice-template`,
  `new-project-template`, `orgai.lastTemplateId`), App settings "Templates and kit" pane (`templates-section`,
  `kit-section`); New run Team / Ask switch (`new-run-mode`, `orgai.newRunMode.<pid>`, `startRun({ team: 'single' })`;
  Ask runs use the conversation layout, kind "Ask", `run-meta-ask`); Project settings > General Engagement plan
  (stale save banner `engagement-plan-stale`) and Context notes (engagements only); Maintenance "Forget this
  engagement" and the tile's "Forget engagement..." with preview counts (`forget-confirm`, Dashboard `forget-notice`);
  History > Trends months, every run kind, By kind table, Copy as CSV / Save CSV (Blob download, no main dialog);
  per-project MCP values and "Make a project-only copy" (`mcp-per-project`, `mcp-copy-*`); "Your presets"
  (`presets-section`, `preset-form`, tiles `connector-tile[data-custom]`). `lib/mcpScope.ts` and `lib/kitApi.ts`
  mirror contracts merged on dev after this branch; their surfaces hide while the API is absent. e2e:
  `e2e/engagement2.mjs` (templates, Ask, plan + stale, notes, Trends + CSV copy, forget, both sizes and themes),
  `e2e/per-project.mjs` and `e2e/presets.mjs` (SKIP until the runtime side is present; never run yet). Not driven:
  Save CSV's download, the kit dialogs (native pickers), the per-project confirm and queued saves, presets end to end;
  `needsSignIn` still also flags per-project secret gaps as "Needs sign in".
- Knowledge tab (spec `docs/design/knowledge.md`, walk `docs/design/ux-review-knowledge.md`; engagements only, between
  History and Team, `tab-knowledge`, `View` 'knowledge'; never on the assistants, no menu item yet):
  `views/KnowledgeView.tsx` + `components/knowledge/*` is a list-first page (no CanvasFrame): filter column
  (`knowledge-search`, kind chips `knowledge-kind[data-kind]` with counts, origin chips
  `knowledge-origin[data-origin=user|agent]`, `Switch` `knowledge-show-retired`, count line `knowledge-count` "12 of 300
  items"), one `ul[role=listbox]` Tab stop grouped by kind in `lib/knowledge.ts` `kindOrder` (People … Open questions,
  free-form kinds as typed, Notes last; context notes are items too), rows
  `knowledge-row[data-id][data-kind][data-origin][data-retired]` with name, kind badge, excerpt and the provenance line
  (`provenanceLine`: "You · 4 Nov 2026" / "Analyst · R1 · 4 Nov 2026"), ordered by createdAt only (agent writes never
  re-sort), roving focus with type-ahead, Enter opens the `SidePanel` detail (`persistKey` "knowledge", rail-collapsed
  under 1100 px, `revealOn` selection; `#knowledge-detail-heading` takes focus, Esc returns to the row), Shift+F10 /
  right-click a native `popover=auto` row menu `knowledge-row-more` (rows carry no buttons), windowing past 100 rows
  (`lib/knowledgeList.ts`). Detail: inline-editable name / kind / aliases / summary (`InlineField`, save on blur and
  Enter, summary Ctrl+Enter), Facts (`knowledge-fact-input`, full list sent with ids so agent facts keep their source;
  `withFactRetired` always sends the flag), Related (`relatedRows`, neighbour links select, add a relation form, retire /
  restore / remove), Notes links, History (`historyLines`: "Recorded by Analyst in R1 <run>, 4 Nov 2026 11:46" with the
  run as a link, "Edited by you, …", "Retired by …"), footer Retire / Restore and "Delete…" (`useConfirm`
  `confirmTestId: 'knowledge-delete-confirm'`); notes use the moved `NoteDialog` (`context-note-dialog` testIds kept).
  Live updates: `onEngagementChanged` refetches ('knowledge' graph, 'notes' index), never re-sorts or moves focus,
  announces "The team recorded N items" at most once per 5 s through the one `role=status` `knowledge-status`, "Show
  new" when filtered out; deep links through store `openKnowledgeItem(KnowledgeFocusRequest)` resolved by
  `resolveFocus` (id, else kind + name, else note title). A "List | Graph" switch (`knowledge-view-switch`, per project
  in localStorage) renders `components/knowledge/KnowledgeGraph.tsx`: a React Flow neighbourhood canvas on the shared
  canvas pieces (`lib/knowledgeGraph.ts` `drawnGraph` / `neighbourhood` / `foldRetired`, unit-tested), Depth 1 / 2
  (`knowledge-graph-depth`), Show all (`knowledge-graph-all`) warned past `SHOW_ALL_WARN_AT` 150, "N retired" fold
  groups (`knowledge-retired-group`, expand chevron), relation labels at zoom >= 1 else in the edge title, kind -> role
  colour slot, the four node styles and both themes through `useCanvasOptions`, legend popover
  `knowledge-graph-legend`, skip links `knowledge-skip-list` / `knowledge-skip-detail` (sr-only-style with no pointer
  hits until focused, in knowledge-graph.css; the global `.skip-link` is untouched), nodes `knowledge-node[data-id]`
  as Tab stops in list order with spoken names (`nodeSpokenName`), Space selects, Enter opens the detail, Ctrl+Arrow
  moves between neighbours, no animated layout under reduced motion. Relation edges leave and enter by the sides that
  face each other (`lib/knowledgeGraph.ts` `relationHandles`, reusing `messageSides` / `msgHandleId`; nodes carry hidden
  handles on all four sides, the original two stay for retired-group edges). Run view: `lib/knowledgeRun.ts`
  `collapseKnowledgeWrites` folds each engagement_knowledge / engagement_context write call and result into the harness
  row (`knowledge-write-row`, "Recorded organisation Acme Corp", kinds and relations with hyphens as spaces, result under "Show output",
  inner `knowledge-row-open` "Open" link; the name no longer collides with the list's `knowledge-row`; ids parsed from result text must match `KNOWLEDGE_ID_RE`), `transcriptRows.ts`
  gives reads their sentences ("Looked up the kinds and relations in use", "Searched the knowledge for Acme", "Read
  Jane Doe", "Read the note …", "Read the context notes"), RunMeta `run-meta-recorded` "Recorded N changes"
  (`recordedBreakdown` over the chain's harness rows, engagements only; the breakdown "4 items, 2 relations, 1 note, 1
  retired" is in its title and sr-only text via `recordedBreakdownText`, label `recordedLabel`) opens the tab. Settings > General > Context notes
  is one line `knowledge-summary` (`knowledgeSummaryLine`: "5 items (1 person, 4 systems), 2 notes, 6 facts", live counts only, at most 5 kinds then ", N more") + `knowledge-open`;
  Maintenance danger zone adds `knowledge-clear` "Clear everything…" (`clearCountsLine`: counts everything including retired,
  "5 items (1 retired), 7 facts, 2 relations", a parenthetical only when non-zero; `knowledge-clear-confirm`,
  notice `maintenance-notice` takes focus; notes stay) and the forget confirm / `forget-notice` count "N recorded
  items" (`knowledgeRemoved`, wording unchanged).
  - Fix-up of walk-2 M1-M5, M7 (cfa7737; `docs/design/ux-review-knowledge-2.md` "Status after fix-up"): retire / delete
    show a Banner `knowledge-notice` ("Retired <name>." with `knowledge-notice-undo`, "Deleted <name>." without Undo),
    announced through `knowledge-status`, cleared after 8 s (`NOTICE_MS`, restarted after a pause while pointer or
    focus is inside); after a retire the pane stays on the item (Restore shown), no jump to the next. RunMeta and
    Settings call `openKnowledgeItem({ projectId })`; a focus request with no target lands on the selected row, else the
    first row, else Add a note (a node in Graph view); the History run link lands on the composer, else the selected
    tab, else the topbar h1; `SidePanel` focuses the rail's Show button only after the user's Hide and only if focus is on
    body. Unit-tested and driven by e2e (knowledge.mjs, knowledge-graph.mjs, knowledge-run.mjs) only; not seen by eye, not re-walked.
    Unverified: the 8 s timer and its pause, Esc on a filtered-out selected item, retired-group edge geometry, radial
    layout with the new handles. Clicking "Show item details" still drops focus to body (open). Dates: `lib/dates.ts` `formatDate` / `formatDateTime` ("4 Nov 2026"), used by plan,
  notes, kit and template lines. `ConfirmDialog` / `useConfirm` take `confirmTestId`. e2e (in e2e:free; mock
  `[mock:knowledge]`, both sizes and themes, keyboard pass): `e2e/knowledge.mjs`, `e2e/knowledge-graph.mjs`,
  `e2e/knowledge-run.mjs`; engagement2.mjs drives the note dialog from the tab. Reviewer (two passes): no Critical or
  High after fixes. Post-landing walk: `docs/design/ux-review-knowledge-2.md`. Open: main's `knowledge:saveNode`
  now takes `expectedUpdatedAt` / `appendFacts` (cli-spec Wave 0) but the tab sends neither, so an agent's fact
  appended between the tab's fetch and the user's save is still dropped, run-scoped
  windows (Open link and RunMeta button do nothing visible there), no application-menu item, "Checked by you" and
  "Retire all agent items from R3" not built, the Lows in knowledge.md section 13.
- Agent import (renderer): the New project form shows `foundLine` ("Found 2 Claude Code agents and AGENTS.md.") and an "already a project" line from `checkPath` (debounced 300 ms), and with agents present swaps the Architect checkbox for a radio group (`[data-testid=setup-choice]`: import / architect / default; submit "Create project and review import", or "Open <name>" when the folder is already a project, with a secondary "... anyway"). Import creates the project with the default chart and sets `importRequest` in the store; `views/OrgChartView.tsx` then opens `components/import/ImportAgentsDialog.tsx` (mount-only-while-open, re-previews on every choice, always sends the preview digest, ConfirmDialog whenever replacedRoleIds is non-empty on a non-fresh chart; the apply error shows in the footer with Refresh preview and takes focus; `lib/ipcError.ts` strips the IPC wrapper). The Org chart tab has Import agents and Export to repo buttons and, in the `.frame-top` region above the canvas, a "not imported" Banner (remembered in localStorage per project, `lib/agentImport.ts`), the apply notice with Undo (`importNotices` in the store: undo saves `previousRoles` and expires on the first chart edit, comparing against `importedRoles`; the chart is fitted after an import and an Undo) and the export path notice. Project settings > General > Connection has a read-only "Role models" disclosure. Pure logic and tests are in `lib/agentImport.ts`; e2e is `e2e/import.mjs` (in e2e:free). Not built: a file/folder chooser in the dialog (the contract scans the project folder only), the Architect-setup "sees the agents" note, and a link to Connection settings from the dialog.
- Connectors (renderer): built for 40-60 services (`docs/design/ux-review-connectors-scale.md`). App settings > Connectors (pane id `mcp-library`) is the gallery (`connectors-section`, `connector-tile[data-connector][data-state][data-ease]`, `connector-action`) plus "Custom servers" below; the pane widens that settings column to 1120 px and the grid steps 1 / 2 / 3 columns (560 / 900 px container). A tile is one row (logo, name, method badge `connector-ease` from `connectorEase`: "Sign in", "No sign-in needed", "Paste a token", "Needs your own app"; one clamped line; one button): only "Sign in" and "Add" are filled, "Add token" / "Set up" are outline. Order (`lib/connectors.ts` `sortForGallery`, `gallerySections`): Connected (connectedAt desc, then name), then attention states, then by ease and name; past 24 entries the default view groups under "Easy sign-in" / "Needs a token" / "Needs your own app" and category chips appear. Filter chips (`connector-filter[data-filter]`, `aria-pressed`: All, Connected, Easy sign-in, categories), ranked search (`matchRank`: name, then aliases, vendor, category, description), a polite count (`connector-results-count`) and a no-results card with "Add a custom server". The tile grid is one tab stop (`useRovingFocus`, arrow keys). `requestConnector(id)` (`lib/settingsTarget.ts`, kebab-case ids only) deep-links to a tile: `ConnectorGallery` reads the key on mount or on `orgai:settings-section`, clears search and filters, scrolls, focuses it, sets `data-highlight` for 2 s and announces "Showing <Name>". State label "Not signed in" (was "Needs setup"). `ConnectorDialog` leads per method (`dialogTitle` / `dialogLead`: "Sign in with X" + "Opens your browser. No keys to paste."; "Add X" + "No sign-in needed."; the access choice first, then the token field (the variant fieldset renders in one stable slot before the form for every auth kind, so a radio keeps focus when the variant's auth kind changes; its legend reads "Access and sign-in" when a connector's variants mix auth kinds (GitHub), else "What agents can do"; changing the radio clears typed token / client id / client secret; while connected, `connector-locked` (the fieldset's `aria-describedby`) says Disconnect to change it, or "Remove the service and add it again" for a 'none'-auth service; the notes and honesty line still follow the form for token variants; `connect()` refuses with "This service was connected with a different access level. Close and open it again." when `connectors.add` returns an entry on another variant); own app "About 10 minutes, once." with an "I already have a client ID" shortcut that collapses the steps; `connectStep` 'none' makes no authorize call and has no Disconnect) and shows the "not yet tested" note once (`connector-dialog`, `connector-connect` in the footer). Access can be changed in the dialog until the service is connected (`connector-variant[data-variant]`); `connector-locked` shows only while connected (Disconnect to change it). Team > Catalog "Add a service" (`AddServiceDialog`, `mcp-add-service`) is a search-first listbox picker (`add-service-search`, `add-service-count`, `add-service-ready` section "Ready to use", `add-service-option`, in-project services say "Manage roles" and jump to their row, one footer row: `add-service-other` with `-assist`, a "Can't find it?" menu `add-service-more` holding `-link` and `-custom`; Easy sign-in is a toggle that combines with a category and All resets both; search also matches the ease words); The picker's first section is "Your servers" (`add-service-yours`, rows `add-service-library-option[data-id]`): the user's saved library servers that are not connectors (`lib/connectors.ts` `libraryMatchRank` / `filterLibrary`: name, then description), "Add" links them with a roles step (`add-service-library-dialog`, or at once for a role-started add or a project with no roles), a linked one says "Manage roles" and jumps to its `mcp-row`; the count includes them and an empty search offers `add-service-empty-custom`. `connected-service-row`, `connector-use`; `ConnectedServices` folds unused services past 8 behind `connected-more`. Role inspector `role-services` shows brand marks and caps at 5 with "and N more". Plain words only in this path (service, sign in, can read / can read and change). e2e: `e2e/connectors.mjs` (in e2e:free). Walks: `docs/design/ux-review-connectors-2.md`, `-connectors-scale.md`. Not done: Tools sections order / "Services, N connected" count (Team-tab files), the old `.svc-pick*` rules in styles/mcp.css are now unused.
- Skills UI (#11, `components/skills/`, `lib/skills.ts`): Team > Catalog is ordered Skills, Connections, Plugins (the project Tools pane is gone; `SkillsSection`, `skills-section`, rows `skill-row`, empty `skills-empty`, buttons `skill-add-library` (primary), `skill-new`, `skill-import`, `skill-evaluate`, notices `skill-notice`). A row whose skill no role can load shows the "No role can load this" badge (`loadableByNoRole`). Every add flow (new, from library, import, apply) uses the shared role picker `SkillRoleAccess` (`skill-role-picker`, `skill-roles`, `skill-role-hint`). Row extras sit in a "More actions for <name>" popover; Promote to library and Unlink end in notices (`promotedNotice`, `skillAddedNotice`). Also `skill-library-missing`, `skill-elevated`. `SkillLibrarySection` is the App settings "Skill library" pane (`skill-library-row`, `skill-library-used-by`, `skill-library-remove-body`); `requestSkillLibrary()` (`lib/settingsTarget.ts`) is the deep link from the project section; its remove ConfirmDialog names the roles per project (`libraryRemoveLines`).
- Skill import and evaluation (renderer): `ImportSkillsDialog` + `SkillImportControls` (`skill-import-item`, `-invalid`, `-duplicate-hint`, `-no-roles`, `-apply-error`). The import banner counts importable and refused skills (`importBannerLine`, remembered per project in localStorage, `skillBannerKey`). Dropped-keys (`skill-import-dropped-notice`) and refused (`skill-import-refused-line`) notes stay after import, duplicates are locked, closing a dirty dialog asks a discard confirm. `SkillEvaluationPanel` is a disclosure (`skill-eval-toggle`, `-heading`, `-last`, `-budget`, `-live`) that stays open while suggestions are unresolved; suggestions (`skill-suggestion`, `-dismissed`) have Apply, Dismiss and Undo; after Evaluate focus moves to the result and a live region announces it (`evaluationAnnouncement`). `RoleSkills` is the role inspector's list (`role-skills`, `role-skill`).
- Team assistant (main): dismissals filter capabilities:recommend too (never sent to the model), a manual Re-check merges with the pending list and the held recommend result instead of replacing it, and under ORGAI_MOCK the first finished run always leaves something pending; the mock recommend answer also picks the mock-home `code-review` skill. Unit-tested only.
- Skills in run views: `TranscriptPanel` + `lib/transcriptRows.ts` `collapseSkillLoads` render one "Loaded skill <name>" row (SKILL.md under "Show instructions"); the matching `load_skill` call row is hidden and `list_skills` rows ("Listed its skills") fold into it. `UsagePanel` has a "Skills loaded" table (`usage-skills`, `usage-skill`). e2e: `e2e/skills.mjs` (in e2e:free).
- Skills UI open items: Promote has no role picker; there is no `promotedFrom` origin field; "Used by" projects are not links; the New project form has no "Found N skills" line; Apply and Dismiss are not covered by e2e (the mock gives no suggestions); per-agent skill counts come from transcript rows (5000-entry trim); A/B replay evaluation is not built; `scripts/smoke-skills.mjs` is unrun and needs consent (spends tokens).
- Assistants (renderer; spec `docs/design/assistants-ui.md`): Chat, MCP assistant and Skill assistant are virtual projects (`quick`, `harness`, `skills`) in a sidebar "Assistants" group above Projects (`nav-assistant[data-id=quick|harness|skills]`, rows share the project-row renderer in `Sidebar.tsx`; rail icons MessageSquare / Plug / Sparkles, the Chat tooltip names Ctrl/Cmd+Shift+N). Store: `virtualProjects` (replaces `harnessProject`; `loadVirtualProject` uses `projects.get(id)`, else `lib/assistants.ts` `displayProject`), `openAssistant(id, { instruction?, fresh? })` (an instruction seeds `assistantSeed`), the exported `openNewChat()` (Ctrl/Cmd+Shift+N in App.tsx, `projects-new-chat`, first-launch `empty-chat-now`), `startQuick`, `startSkillAssist`, `startLibraryAssist(instruction, allowBuild)` (the run opens in place, no window), `promoteQuick` and `handleEvent` 'run.moved' (moves the run between `runs` / `historyByProject` / `activeRunByProject`); `loadAllHistory` covers the virtual ids and `startRun` returns early for them. A virtual project's topbar shows the label, Live and History only, no folder chip. Start pages in `components/assistants/` (`ChatStartPage`, `McpAssistantStartPage` and `SkillAssistantStartPage` on `InstructionStartPage`, `AssistantModelLine`; styles in `styles/assistants.css`): `assistant-start-<id>`, `assistant-instruction`, `assistant-start`, `chat-folder`, `chat-folder-browse`, `chat-folder-clear`, `chat-existing-project`, `chat-open-project`, `chat-team`, `chat-allow-edits`, `chat-summary`, `mcp-allow-build`, `assistant-model-line`. An ended virtual run offers Continue, else `assistant-ended` + `assistant-new-session`; the idle label is `ASSISTANT_IDLE_LABEL` ("Your turn. Reply, ask a follow-up, or end the session."); Needs-you locations use `locationLabel`. Save as project: `SaveAsProjectDialog` (`save-as-project-dialog`, `save-as-project-confirm`), `run-save-as-project` in RunActions (ended runs still in the Chat project only, disabled with a reason for scratch), `history-save-as-project` and `history-folder` in Chat History. Org retrospective only for real projects' work runs (`offersRetro`); kind chips through `runKindLabel` (quick = "Chat"). ProposalCard kind 'skills' (`proposal-skill-item[data-skill]`, `skillsApplyNote`); App settings > General > Advanced settings > Assistant models adds `skill-assist-model-row` / `quick-run-model-row` (`lib/assistantModels.ts` `skillAssistModel` / `quickRunModel`, `ASSISTANT_MODEL_FALLBACK`). Elsewhere: Connectors > Custom servers "Configure with AI" calls `openAssistant('harness')` (`mcp-library-assist-banner` while a run is live); Team > Catalog > Skills `skill-ask-assistant` starts a project-scope Skill assistant run. e2e: `e2e/assistants.mjs` (in e2e:free; 1024x640 and 1600x1000, dark and light, mock): the start pages, sidebar, topbar and the Assistant models rows (General > Advanced) are e2e-checked; its run-starting checks (Chat to Idle, scratch Save as project disabled, `history-folder` "Scratch", skill proposal approve) pass on dev against the merged runtime (the orchestrator ran it at 34f6370 and again after 5e2384a); the "SKIP (runtime not merged)" guard only fires when `runs:startQuick` has no handler. Pure helpers in `lib/assistants.ts` are unit-tested.
- Assistants UI after the UX walk (`docs/design/ux-review-assistants.md`, walked 34f6370; fix-up merged at 4ea724f, spec section "Changes after the UX walk"): conversation layout for single-agent runs (`lib/assistants.ts` `isSingleAgentRun`: a Chat with team 'single', 'mcp-assist', 'skill-assist'; `runLayoutFor(summary, chosen?)`, pure, unit-tested). In 'conversation' the stage (`run-conversation`) is the root agent's transcript (`TranscriptPanel variant="conversation"`, `conversation-transcript`), newest at the bottom and kept there unless the user scrolled up (then an in-flow `conversation-jump` "Jump to latest"); the column and the composer are centred at 90ch and the composer stays under the stage even with a wide side panel (`.run-body[data-layout=conversation]` beats `[data-side-wide]`); zoom, legend and Hide finished are hidden; the tray and side panel are unchanged. The toolbar `IconButton` `run-layout-toggle` ("Show agents" / "Show conversation") is on every run, `.run-body[data-layout]` carries the layout, and the pick is remembered per run in the store (`runLayoutByRun` / `setRunLayout`). Sidebar: `lib/assistantNav.ts` `assistantRunToOpen` (pure, unit-tested) opens the run that needs you, else the last viewed live run, else the newest live run, else the start page, never an ended run (ended runs stay in run tabs and History; `settleWorkspace` follows it for virtual ids); `openAssistant(id, { instruction?, fresh? })` with an instruction or `fresh` (New chat / `openNewChat`, Configure with AI `mcp-library-assist`) always shows the start page. After approving a skills or MCP proposal, RunMeta shows a dismissable link (`lib/proposalNext.ts` `proposalNextFor` / `PROPOSAL_NEXT_COPY`, store `proposalNextByRun`): `proposal-next-skills`, `proposal-next-connectors`, `proposal-next-project-skills`, `proposal-next-project-mcp`. Save as project (`run-save-as-project`, `history-save-as-project`) shows only while `offersSaveAsProject` (the run is still in the Chat project); for scratch it is a really disabled `Button` inside `span.run-act-disabled`, which carries the reason as its title. Chat start page: typed path `chat-folder-input` beside Browse (`projects.checkPath`, 300 ms debounce, `chat-folder-error`; an invalid path counts as scratch and Start re-checks); the scratch edits switch stays focusable (`aria-disabled`, separate hint). Copy (`assistantModeLabel`): "Waiting for your answer" while a card is open, else idle "Your turn. Reply, ask a follow-up, or end the session." (`ASSISTANT_IDLE_LABEL`), else "Reply to the assistant" (`speaksAsAssistant`: virtual projects, single-agent chats, project-scope Skill assistant runs); `composerPlaceholder` drops doubled punctuation. The "+" tab and draft tab of a virtual project read "New chat" (Chat) / "New session" (`newSessionLabel`). RunMeta says "unattended" only on real projects' work runs and shows the MCP assistant's `buildWorkspace` (`run-meta-workspace`, full path in the title). History kind filter chips are hidden for the three virtual projects; `.col-folder` ellipsises and narrows under 900 px; `.skill-prop-md` uses the token `--scroll-region-max`; `.new-run` is a size container that tightens under 560 px of height; the build switch reads "Let it build a server in its workspace, in OrgAI's data folder". e2e/assistants.mjs (mock, in e2e:free) checks: the conversation layout shows the mock reply and the composer at 1024x640 without page scroll (both themes), the toggle both ways, the start page from the sidebar after an ended Chat and from Configure with AI after an ended MCP run, the typed-path error and the Save as project flow from a typed folder (gone from the run strip and History afterwards), the "+" tab labels, no "unattended" on Chat / Skill / MCP assistant runs, the disabled scratch Save as project with its reason, no kind chips in Chat History, and `proposal-next-skills` after a library skills approval. `conversation-jump`, `run-meta-workspace` and the connectors / project proposal links are not driven by e2e.
- Assistants UI open items (UI Lead, after 4ea724f): in conversation mode the side panel's Transcript tab duplicates the stage (accepted; the panel is collapsed below 1100 px); `proposalNextByRun` entries are cleared only by Dismiss, and the link is untested at narrow toolbar widths; the scratch edits switch is a local `button[role=switch]` because `components/ui/Switch` cannot take `aria-disabled` (fold it into `Switch` later); the MCP start page cannot name the build folder before the run starts. Not exercised: the native folder picker, the Save as project 'existing' outcome, a default-team Chat in conversation mode, the project-scope `skill-ask-assistant` run. Not addressed from `ux-review-assistants.md`: L3 (Team disclosure wording), L4 ("Stopped" vs "Ended"), L6 (first-launch focus), L7 (brand lockup), L8 (MCP wording in the start page title), and moving focus to a decision card when it arrives.
- Proposal cards (spec `docs/design/proposal-cards.md`, merged at e655838): `components/proposals/*` (`McpProposalBody`,
  `SkillsProposalBody`, `ClampText`, `useCurrent`), `lib/skillProposal.ts`, `lib/proposalSummary.ts`,
  `lib/hiddenChars.ts` (badges hidden characters; main is the gate, see Work-run configuration changes) and
  `styles/proposals.css`. The store keeps `proposalOutcomes` from `proposal.resolved`. Selectors: `proposal-decline`,
  `proposal-decline-note`, `proposal-decline-send`, `proposal-effect`, `mcp-proposal-secret[data-secret]`,
  `mcp-proposal-server[data-change]`, `mcp-proposal-removal`, `proposal-skill-item[data-action]`,
  `proposal-next-secrets`, `tray-announce` and `article.decision-card[data-focus-details]`. At 1024x640 the compact
  frame gives the card the stage; the frame stays compact until 544 px high (`COMPACT_FRAME_HEIGHT` 480 plus
  `COMPACT_EXIT_MARGIN` 64). e2e: `e2e/proposals.mjs` (in e2e:free). Open Lows: switching tray cards drops typed
  secrets and the decline note; the mock has no secret-slot or toggle proposals; the skill link, grant and remove rows
  and the before/after view are not driven by e2e.
- Usage and skills walkthroughs on mock data: `docs/design/ux-review-usage-skills.md` (placement of the usage and skills UI, parts A and B), `ux-review-usage-2.md` (usage UI re-walk) and `ux-review-skills-2.md` (skills UI re-walk at 1024x640 and 1600x1000 in both themes plus a keyboard pass; the native Add from folder picker was not driven).
- Walkthroughs on mock data are in `docs/design/ux-review*.md`. The newest, `ux-review-runs-2.md`, predates the brief A
  run-view merge, so its N1 tray finding needs a re-walk. N2 (run windows miss pending decisions) and the focus and
  wording items are still open.
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
    carries an undocumented `unifiedWindows` map. Mapping lives in `src/main/runtime/usage.ts`. Probed again on
    2026-11-04 (`scripts/smoke-usage-probe.mjs`, token-free, same Max login): `five_hour` was null, `seven_day` and
    `model_scoped` (Fable) were present, new keys `seven_day_breakdown`, `weekly_scoped_shares`, `pace` (null) and
    `spend` appeared, and there was no `limits[]` in the control reply; `mergeUsage` therefore keeps a window only an
    event reported (e.g. five_hour from `unifiedWindows`) until its reset passes, instead of letting the next poll erase it.
    UsageMonitor observes every usage.status broadcast and merges the idle probe onto the newest Claude status the same
    way, so the row survives between runs until its reset (`usageMonitor.ts` `observe`, fed from index.ts `broadcast`;
    unit-tested only).
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
  framed by `prompts.ts` `peerMessageText` as peer information, never a user instruction. On by default per
  project (`Project.runMessaging`, both ends; an explicit false turns it off), capped per run pair, never for setup-like runs. Unverified: that the Claude
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
- MCP servers added mid-session (`scripts/smoke-mcp-midrun.mjs`, run once on 2026-11-02, haiku, Max login, about
  $0.014; results in its header):
  - In a main-thread `AgentDefinition.tools` whitelist, `mcp__<server>` and `mcp__<server>__*` admit that server's
    tools; `mcp__*` admits nothing (init tools []), and a subagent whose list is only `mcp__*` is refused at spawn
    ("would be spawned with zero tools ... unrecognized [mcp__*]").
  - `Query.setMcpServers` mid-session returns `{ added: [name], removed: [], errors: {} }`; `mcpServerStatus` right
    after shows the server 'pending' with no tools, and the next turn's init shows it 'connected'.
  - Whitelists are exact and fixed per query: with a whitelist that does not name the new server its tools never
    appear in init `tools`, the model is never offered them, and neither PreToolUse nor canUseTool fires. With `tools`
    omitted the new tool appears; the model reached it through ToolSearch, PreToolUse fired (agent_type main), then
    canUseTool (options carry `agentID` and `mcpServer`) and the call ran.
  - A subagent spawned after the add, with `tools` omitted, can call the new server even when its definition says
    `mcpServers: ['alpha']`: `AgentDefinition.mcpServers` does not restrict a subagent to the named servers.
  - Not checked: `reloadSkills()`, `Options.skills` blocking, resume honouring new `agents`, and whether a resumed
    session keeps its session id or `total_cost_usd`.
- Smoke tests cost real tokens (fractions of a cent on haiku). Do not run them in loops.

## Connections, Codex, LiteLLM, MCP and macOS

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

Each fact says how it was checked. "Unverified" means it comes from docs or typings and no live run has confirmed it.

- Connections and adapters are separate. The connections are `anthropic`, `openai` and `litellm`, and the adapters are
  `claude` and `codex`. `adapterForProject` (`src/shared/defaults.ts`) picks the adapter from the connection, or for
  LiteLLM from the root role's model family. Mixed families (owner decision 2026-11-03; one connection per project
  stays): on LiteLLM the orchestrator's model picks the adapter and reports may run any model the proxy serves;
  `adapterForProject` still lists them in `mismatched` (meant for an informational notice; the renderer still shows the old danger banner "This project cannot start as configured" in `ProjectConnection.tsx` until the UI pass decides with `mixedFamilyRefusal`) and RunManager
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
    home dir. The bundled CLI is tried first (execFile), then PATH candidates found by `execFile(<SystemRoot>\System32\where.exe,
    ['$PATH:claude'])` (PATH only, never the cwd) / `execFile('which', ['-a', 'claude'])`, both in the temp dir with
    no shell and absolute paths only, plus the well-known install
    paths, with no bare `claude` fallback (nothing found reports "Claude Code CLI not found" with the places
    looked). A shell is used only for Windows .cmd/.bat shims without metacharacters; a CLI that rejects the flag is retried without it and its detail says user
    settings could not be excluded. The disconnected detail tells the user to run claude and /login, set an API
    key, or choose another default connection. Wiring is unit-tested with an injected runner.
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
    harness's own `spawn_agent` tool. Unverified: the wire shapes come from the schema, and `scripts/smoke-codex.mjs`
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
- macOS is untested; nobody has run it on a Mac yet (`docs/macos-testing.md` is the checklist).
  - App icon: `npm run icon` (`scripts/make-icon.mjs`, pure parts in `scripts/lib/icon.mjs`, tested in `src/main/icon/makeIcon.test.ts`) writes `build/icon.png` (1024), `build/icon.ico` (16-256, Windows) and `build/icon.icns` (macOS, mark inset to ~80% with a transparent margin); commit all three together. In dev, `index.ts` sets the window icon (ico on Windows, png elsewhere) and on darwin `app.dock.setIcon` (never packaged). Verified by unit tests and file inspection; the Dock, Finder and taskbar rendering is unverified on a Mac.
  - `applyShellPath()` runs right after `installLogging()` and merges the login shell's PATH with well-known dirs.
    GUI launches otherwise miss Homebrew, nvm and similar.
  - `listClaudeBinaries` also tries `~/.claude/local/claude`, `~/.local/bin/claude`, `/opt/homebrew/bin/claude` and
    `/usr/local/bin/claude`.
  - The app menu is installed on darwin only. Closing the window keeps the app running, and `activate` re-creates
    the window.
  - These pieces are unit-tested where they are pure. Packaging (`dist:mac`, `dist:mac:unsigned`,
    `build/entitlements.mac.plist`) is unverified.
  - `ORGAI_DATA_DIR` replaces userData and puts the logs under it. e2e (a fresh temp dir per script) and CI use it to
    keep off the real profile. Since 18070b8 the e2e scripts ignore an ambient `ORGAI_DATA_DIR` (`E2E_DATA_DIR` is the
    override): CI's one shared dir let connections.mjs's leftover library entry open a different dialog in team.mjs.
    package.json `productName: "OrgAI"` names the packaged app (`app.name`, log dir).
  - The `pathKey` symlink fix (macOS `/tmp` is `/private/tmp`) and the OrgAI identity fallback for commit and merge are
    unit-tested with a junction/symlink and a git that has no identity config.
  - CI (`.github/workflows/ci.yml`) runs on windows-latest and macos-14. Release legs run on native-arch runners
    (macos-14 arm64, macos-15-intel x64). Nothing in CI spends tokens. A push that changes only `docs/**` or Markdown
    files does not trigger it (`paths-ignore`); pull requests always run.
  - Local builds: `npm run pack` (`scripts/pack-local.mjs`, `--dry-run` prints the plan) keeps only `release/win-unpacked`
    (current, `release/BUILD.txt`: version, short sha, time) and `release/previous` (the build before); never create
    other `release-*` folders, and delete old ones rather than archive them. The real pack was not run by its author;
    the dry run and the rotation on a fake build were.
  - Branches: `dev` is integration (agent runs, PRs, dependabot), `main` is stable and protected. CI runs on both;
    `release.yml` only releases `v<version>` tags whose commit is on `main`. Push as you go: after each merged
    feature passes its gate (typecheck, unit tests, build, e2e:free where UI changed, the Reviewer where required),
    dev is pushed to origin (`git push origin dev`) before the next step, never a red tree and never `main` directly
    (release PRs only); the orchestrator does the push after each gate; reports never push.
  - The first real CI run has not happened yet. Open items: winCodeSign extraction on windows-latest, macos-15-intel
    really being x64, e2e:free on mac (a possible Keychain prompt), unsigned dmg/zip with hardenedRuntime, the publish job.

<!-- orgai:architecture -->
## Architecture and conventions

Read `.orgai/ARCHITECTURE.md` before changing code. It records the agreed stack, module layout, conventions and commands for this project. Keep it current when they change.
