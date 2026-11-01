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
- Run end: RunManager calls `cancelPending` (`pendingCards.ts`) when a run reaches an outcome or `paused`, and at
  teardown. Every open card then gets its `*.resolved` event with `cancelled: true`. `activity.ts` `runOutcome` /
  `settleAgent` relabel agents Finished, Stopped or Failed. Harness-written transcript entries carry
  `source: 'harness'` (Claude, Codex and mock) and render as quiet system rows. Verified by unit tests.
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
  `runtime/builtinModel.ts` (deep-tier fallback, one run warning). They are edited in App settings > Defaults >
  "Assistants"; the MCP assist dialog hint and the Org retrospective tooltip name them (`lib/assistantModels.ts`).
  The `orgai:settings-section` window event switches a mounted App settings page to the requested pane.
- Run titles: `RunSummary.title` (at most `RUN_TITLE_MAX_CHARS` = 32) and the `run.title` event come from
  `src/main/ai/runTitle.ts`. RunManager fires it for work runs with prompt text and never awaits it. It is a one-shot
  `complete({ kind: 'title', model: fast tier, connection })` with a 20 s timeout, cleaned by `cleanTitle`. A failure
  leaves the title unset, and the UI falls back to the prompt. Continuations get the earlier run's title as context.
  Auto-resume (`RESUME_TEXT`) keeps the earlier title. The mock answers `kind: 'title'` with the first 4 words of the
  `<message>` text, and `[mock:title-fail]` makes it throw. The live fast-model call is unverified (no smoke script).
- Projects: `projects:checkPath` (`ProjectPathCheck`) never rejects. `projects:create` validates the path, and
  `ProjectCreateInput.mock` is accepted only with `ORGAI_MOCK=1`.
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
    `plugins` with `options.skills` (it only adds Skill(<name>) allow rules), `settings.disableBundledSkills` plus env
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
    'skills'`) runs only when `Project.skillEvaluation.enabled` and the estimate fits its `tokenBudget`. Evidence is
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

## Renderer

- Resizable columns share one width budget (`lib/panelWidth.ts` `panelBudget`): the canvas keeps 280 px (`CANVAS_MIN_PX`); when the side panel minimum (280 px) does not fit it shows as its rail (saved width and choice kept, re-applied when space returns). `SidePanel` `autoCollapseBelow` reacts to first layout and window resizes only, never to handle drags. Resize handles: Enter or double-click resets, arrows move the splitter.

The UI overhaul landed on native elements with container queries. Radix and react-resizable-panels are not installed,
and the frontend-design skill is not vendored in `.claude/skills` (only `run-desktop` is there).

- Cost and usage (#10): every cost goes through `lib/cost.ts` `costView` and `components/ui/Cost.tsx` (unknown is
  never $0, "$0.42+" is a lower bound). The run side panel has a Usage tab (`components/UsagePanel.tsx`, `SideTab`
  'usage'); History switches Runs | Trends (`components/UsageTrends.tsx`, `runs:usageStats`). App settings >
  Connections > Model prices is `components/settings/ModelPricesSection.tsx`; `lib/settingsTarget.ts`
  `requestModelPrice(model?)` deep-links to it with the model pre-filled.
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
- Resizable columns: `components/layout/ResizeHandle` is a `role=separator` (vertical, `aria-valuenow/min/max`, focusable) inside the column it resizes, on the edge facing the neighbour, so it never overlaps the canvas. It supports captured pointer drag, Left/Right (16 px, Shift 64 px), Home/End and double-click to reset; `lib/panelWidth.ts` holds the pure clamp/drag/key helpers (tested) and `usePersistedWidth`. Sidebar: 200-420 px (default 232), localStorage `orgai.sidebarW`, App sets `--sidebar-w` on `.app` and the main area keeps at least 480 px; shown only in the full sidebar, not in the rail (the chosen width survives collapse/expand). Right `SidePanel`: 280 px up to whatever leaves the canvas 280 px (no fixed maximum), localStorage `orgai.sidePanelW.<persistKey|default>`, drives `--side-panel-w` on the parent grid (`.editor`, `.run-body`; unset means the CSS default 360 px / clamp(280px, 28cqi, 400px)) and the canvas keeps at least 280 px; hidden while the panel is collapsed. Dragging below the minimum does not snap to the rail. From a measured panel width of 480 px `SidePanel` sets `data-side-wide` on the parent; `.run-body[data-side-wide]` then moves the same `.composer` element (no remount) into the panel column under the transcript. The run frame docks its tray beside the stage only when the tray has content (`.frame-tray:not(:empty)`), else an empty tray column left a blank strip beside the canvas. The account popover's `UsageMeter` has no Refresh button or Updated text: it calls `refreshUsage()` on open when data is older than 60 s, then every 60 s while open (one call in flight, at most one attempt per minute even on failure).
- Wide panel: `SidePanel` sets `data-side-wide` on its parent grid at panel width >= `PANEL_WIDE_PX` (480) and clears it below `PANEL_NARROW_PX` (448, hysteresis via `nextWide`). The Live view's canvas refit skips a resize caused by that layout switch. The composer is a container (`composer`) and drops its hint under 560 px; transcript text/user/thinking entries cap at 90ch.
- Dev builds: a package.json version with a `dev` prerelease tag (`0.1.5-dev`; `lib/buildChannel.ts` `isDevBuild`) shows a quiet info "Dev" Badge beside the wordmark (a "D" pip on the mark in the 56 px rail), `[data-testid=dev-build-badge]`, labelled "Dev build <version>", plus a "Dev build" badge by the version in App settings > About. e2e/layout.mjs expects it whenever package.json says `-dev`; drop the tag for a release.
- Status words come only from `lib/runStatus.ts`: Running, Needs you, Idle, Paused, Finished, Stopped, Failed.
- Run view: one 40 px run strip (`[data-testid=run-strip]`: run tabs plus Interrupt / End session / Org retrospective), then a 32 px canvas toolbar
  (`[data-testid=run-meta]` metadata, Hide finished switch, zoom IconButtons, the legend popover). The tray stacks under the canvas and docks
  beside it only in a frame of 1500 x 560 or more; `section.frame-tray[data-compact=true]` marks a frame under 480 px high.
- "Needs you" counts decisions (cards), never runs: the bell, the Needs-you row, the project row badge and subtitle
  ("3 decisions · 1 run") and the topbar all come from `lib/needsYou.ts` `waitingItems` / `decisionCount`. A run row's dot
  is the run's status. A Needs-you item names the kind and the ask first, then the location, and opens that card.
  A question card shows its options inline at every size (`DecisionCard` `inline`); the tray shows the first open decision.
- Project tabs are Live, History, Org chart and Settings. The org chart editor is `views/OrgChartView.tsx`, and project
  settings are sectioned through `components/settings/*`.
- e2e:free is `e2e/layout.mjs`, `runs.mjs`, `maintenance.mjs` and `connections.mjs`. Update selectors in the same change.
- Agent import (renderer): the New project form shows `foundLine` ("Found 2 Claude Code agents and AGENTS.md.") and an "already a project" line from `checkPath` (debounced 300 ms), and with agents present swaps the Architect checkbox for a radio group (`[data-testid=setup-choice]`: import / architect / default; submit "Create project and review import", or "Open <name>" when the folder is already a project, with a secondary "... anyway"). Import creates the project with the default chart and sets `importRequest` in the store; `views/OrgChartView.tsx` then opens `components/import/ImportAgentsDialog.tsx` (mount-only-while-open, re-previews on every choice, always sends the preview digest, ConfirmDialog whenever replacedRoleIds is non-empty on a non-fresh chart; the apply error shows in the footer with Refresh preview and takes focus; `lib/ipcError.ts` strips the IPC wrapper). The Org chart tab has Import agents and Export to repo buttons and, in the `.frame-top` region above the canvas, a "not imported" Banner (remembered in localStorage per project, `lib/agentImport.ts`), the apply notice with Undo (`importNotices` in the store: undo saves `previousRoles` and expires on the first chart edit, comparing against `importedRoles`; the chart is fitted after an import and an Undo) and the export path notice. Project settings > Connection has a read-only "Role models" disclosure. Pure logic and tests are in `lib/agentImport.ts`; e2e is `e2e/import.mjs` (in e2e:free). Not built: a file/folder chooser in the dialog (the contract scans the project folder only), the Architect-setup "sees the agents" note, and a link to Connection settings from the dialog.
- Connectors (renderer): built for 40-60 services (`docs/design/ux-review-connectors-scale.md`). App settings > Connectors (pane id `mcp-library`) is the gallery (`connectors-section`, `connector-tile[data-connector][data-state][data-ease]`, `connector-action`) plus "Custom servers" below; the pane widens that settings column to 1120 px and the grid steps 1 / 2 / 3 columns (560 / 900 px container). A tile is one row (logo, name, method badge `connector-ease` from `connectorEase`: "Sign in", "No sign-in needed", "Paste a token", "Needs your own app"; one clamped line; one button): only "Sign in" and "Add" are filled, "Add token" / "Set up" are outline. Order (`lib/connectors.ts` `sortForGallery`, `gallerySections`): Connected (connectedAt desc, then name), then attention states, then by ease and name; past 24 entries the default view groups under "Easy sign-in" / "Needs a token" / "Needs your own app" and category chips appear. Filter chips (`connector-filter[data-filter]`, `aria-pressed`: All, Connected, Easy sign-in, categories), ranked search (`matchRank`: name, then aliases, vendor, category, description), a polite count (`connector-results-count`) and a no-results card with "Add a custom server". The tile grid is one tab stop (`useRovingFocus`, arrow keys). State label "Not signed in" (was "Needs setup"). `ConnectorDialog` leads per method (`dialogTitle` / `dialogLead`: "Sign in with X" + "Opens your browser. No keys to paste."; "Add X" + "No sign-in needed."; token field first; own app "About 10 minutes, once." with an "I already have a client ID" shortcut that collapses the steps; `connectStep` 'none' makes no authorize call and has no Disconnect) and shows the "not yet tested" note once (`connector-dialog`, `connector-connect` in the footer). Team > Catalog "Add a service" (`AddServiceDialog`, `mcp-add-service`) is a search-first listbox picker (`add-service-search`, `add-service-count`, `add-service-ready` section "Ready to use", `add-service-option`, in-project services say "Manage roles" and jump to their row, one footer row: `add-service-other` with `-assist`, a "Can't find it?" menu `add-service-more` holding `-link` and `-custom`; Easy sign-in is a toggle that combines with a category and All resets both; search also matches the ease words); `connected-service-row`, `connector-use`; `ConnectedServices` folds unused services past 8 behind `connected-more`. Role inspector `role-services` shows brand marks and caps at 5 with "and N more". Plain words only in this path (service, sign in, can read / can read and change). e2e: `e2e/connectors.mjs` (in e2e:free). Walks: `docs/design/ux-review-connectors-2.md`, `-connectors-scale.md`. Not done: Tools sections order / "Services, N connected" count (Team-tab files), the old `.svc-pick*` rules in styles/mcp.css are now unused.
- Skills UI (#11, `components/skills/`, `lib/skills.ts`): Project Settings > Tools is ordered Skills, MCP servers, Plugins (`SkillsSection`, `skills-section`, rows `skill-row`, empty `skills-empty`, buttons `skill-add-library` (primary), `skill-new`, `skill-import`, `skill-evaluate`, notices `skill-notice`). A row whose skill no role can load shows the "No role can load this" badge (`loadableByNoRole`). Every add flow (new, from library, import, apply) uses the shared role picker `SkillRoleAccess` (`skill-role-picker`, `skill-roles`, `skill-role-hint`). Row extras sit in a "More actions for <name>" popover; Promote to library and Unlink end in notices (`promotedNotice`, `skillAddedNotice`). Also `skill-library-missing`, `skill-elevated`. `SkillLibrarySection` is the App settings "Skill library" pane (`skill-library-row`, `skill-library-used-by`, `skill-library-remove-body`); `requestSkillLibrary()` (`lib/settingsTarget.ts`) is the deep link from the project section; its remove ConfirmDialog names the roles per project (`libraryRemoveLines`).
- Skill import and evaluation (renderer): `ImportSkillsDialog` + `SkillImportControls` (`skill-import-item`, `-invalid`, `-duplicate-hint`, `-no-roles`, `-apply-error`). The import banner counts importable and refused skills (`importBannerLine`, remembered per project in localStorage, `skillBannerKey`). Dropped-keys (`skill-import-dropped-notice`) and refused (`skill-import-refused-line`) notes stay after import, duplicates are locked, closing a dirty dialog asks a discard confirm. `SkillEvaluationPanel` is a disclosure (`skill-eval-toggle`, `-heading`, `-last`, `-budget`, `-live`) that stays open while suggestions are unresolved; suggestions (`skill-suggestion`, `-dismissed`) have Apply, Dismiss and Undo; after Evaluate focus moves to the result and a live region announces it (`evaluationAnnouncement`). `RoleSkills` is the role inspector's list (`role-skills`, `role-skill`).
- Skills in run views: `TranscriptPanel` + `lib/transcriptRows.ts` `collapseSkillLoads` render one "Loaded skill <name>" row (SKILL.md under "Show instructions"); the matching `load_skill` call row is hidden and `list_skills` rows ("Listed its skills") fold into it. `UsagePanel` has a "Skills loaded" table (`usage-skills`, `usage-skill`). e2e: `e2e/skills.mjs` (in e2e:free).
- Skills UI open items: Promote has no role picker; there is no `promotedFrom` origin field; "Used by" projects are not links; the New project form has no "Found N skills" line; Apply and Dismiss are not covered by e2e (the mock gives no suggestions); per-agent skill counts come from transcript rows (5000-entry trim); A/B replay evaluation is not built; `scripts/smoke-skills.mjs` is unrun and needs consent (spends tokens).
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
- Smoke tests cost real tokens (fractions of a cent on haiku). Do not run them in loops.

## Connections, Codex, LiteLLM, MCP and macOS

- Model-agnostic defaults: every default is a tier ('top' | 'deep' | 'everyday' | 'fast', `ModelSetting`) resolved
  through the connection's `tierModels` (`defaults.ts` `modelForTier` / `resolveModelSetting`), never a vendor alias.
  The default chart, `newProject`, built-in roles (fallback 'inherit'), run titles, org chart proposals and the drafter
  (`draft.ts` `toRoles` maps tier names per connection) follow it. Near the plan limit, deep/top spawns move to the
  everyday tier (`Project.preferEverydayNearLimit`; the legacy `preferSonnetNearLimit` is mirrored on renderer saves).
  Verified by unit tests.
- Model discovery: Anthropic via `ClaudeAdapter.listModels` (SDK `supportedModels()`, typings 0.3.312 sdk.d.ts:3096,
  no prompt, `strictMcpConfig`, 10 s timeout). The live list (whether it has 'default', which ids, descriptions that
  feed `catalog.ts` `tierFromDescription`) is UNVERIFIED: `scripts/smoke-models.mjs` (token-free, spawns the CLI)
  has not been run. Anthropic `/v1/models` is not used. The scheduled refresh and autoTiers are unit-tested only.
- Community prices (LiteLLM's public JSON) are unit-tested with a fake fetch; the live JSON shape is unverified.

Each fact says how it was checked. "Unverified" means it comes from docs or typings and no live run has confirmed it.

- Connections and adapters are separate. The connections are `anthropic`, `openai` and `litellm`, and the adapters are
  `claude` and `codex`. `adapterForProject` (`src/shared/defaults.ts`) picks the adapter from the connection, or for
  LiteLLM from the root role's model family. A work run whose roles mix families is refused before the run exists.
  `ConnectionService.runConnection` builds the per-run `RunConnection` (env, API key, Codex home). Verified by unit tests.
- Default connection: `projects:create` passes `ConnectionService.prepareNewProject` to `ProjectStore.create`. A new
  project takes `AppSettings.defaultConnection` when `creationConnection` (`defaults.ts`) finds it usable (anthropic
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
- LiteLLM: `/v1/models` and `/model/info` discovery is unverified against a live proxy. The Claude adapter reaches
  LiteLLM through `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` and maps tiers through
  `ANTHROPIC_DEFAULT_{FABLE,OPUS,SONNET,HAIKU}_MODEL`. The Codex adapter reaches it with an `orgai` model provider at
  `<base>/v1`. Both routes are unverified at runtime: `scripts/smoke-litellm.mjs` is free without `--yes` and spends
  tokens with it.
  - Key spend: `ConnectionService.probeLiteLLMUsage` reads `GET {base}/key/info` (the key only as Bearer/x-api-key,
    no `key` param, `redirect: 'error'`, 10 s) through `litellm.ts` `parseKeyInfo` into `UsageStatus.spend`
    (`connection: 'litellm'`, `authMode: 'apiKey'`, no provider). Gated on enabled + base URL + stored key; any failure
    (500 without the proxy DB, 403, junk) is null. It is a keyed `UsageMonitor` extra probe ('litellm', boot / idle /
    usage:refresh), and index.ts re-reads it 15 s after a LiteLLM run ends (`RunSummary.connection`). Only the key's own
    budget is read, never a team budget. The renderer must keep the latest usage report per `connection`.
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
  - A server with any unset `secretEnv` / `secretHeaders` slot never starts: `McpService.enabledServers` skips it and
    `skippedServers` feeds one run warning per server naming the empty slots (RunManager `prepareServers`). Unit-tested.
- MCP library and OAuth:
  - The app-wide library lives in `<data>/mcp-library.json` (`McpLibraryStore`). A project server with `libraryId` is a
    link: McpService refreshes its snapshot from the entry on every read (`withLibrary`, `list`, `enabledServers`,
    `resolve`), its secrets and tokens are the entry's, and a link whose entry is gone is kept but never passed to runs.
    Secret keys: project `mcp:<projectId>:<serverId>:{env|header|oauth}:<name>`, library `mcplib:<entryId>:...`.
    Verified by unit tests.
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
    endpoints when the discovered issuer is off its domain; 'replace' (Google) skips discovery. "Domain" is the last
    two DNS labels (`registrableHost`, no public-suffix list), so preset issuers must be simple vendor hosts, never
    under a multi-label suffix such as co.uk. All of this is unit-tested only; no live sign-in has checked it.
- Connectors (`src/shared/connectors.ts` catalog, `src/main/mcp/connectors.ts`, `McpService.connectors*`): curated
  presets for official remote MCP servers that become library entries (`McpLibraryEntry.connectorId`, written only by
  `connectors:add`, which is idempotent and takes only `{ connectorId, variant? }`; because it is idempotent, switching
  a keyless entry such as Exa or Context7 to its key variant means removing the entry first). IPC `connectors:list`
  (`ConnectorInfo`), `connectors:add`, `connectors:setToken` (token connectors; prefix added in main); ipc.ts
  `connectorArgs` rebuilds both inputs (kebab-case ids at most 64 chars, a token string of at most 4,000 chars or null,
  every other shape refused, extra fields dropped; `ipc.test.ts`); everything else
  reuses mcp:* / mcpLibrary:*. `oauthClient` connectors (Google, Slack) use the user's own client and the fixed
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
