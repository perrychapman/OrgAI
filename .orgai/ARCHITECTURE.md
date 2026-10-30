# OrgAI architecture

OrgAI is an Electron app built with electron-vite and three processes. The main process (src/main) holds the runtime adapters, run manager, connections and model catalog, MCP servers and secrets, usage tracking, setup service, worktrees and JSON stores. The preload (src/preload) exposes window.orgai. The renderer (src/renderer) uses React 19 with React Flow and zustand. IPC types live in src/shared/types.ts. Two provider adapters exist: Claude (Claude Agent SDK) and Codex (`codex app-server`). They are reached through three connections: Anthropic, OpenAI and LiteLLM.

The UI overhaul's shell pass and its parallel restyles have landed (docs/design/plan.md, spec.md). The shell is built on native elements with container queries: components/layout, components/ui primitives, top-level project tabs, and a theme layer driven by AppSettings.appearance. Radix Primitives, react-resizable-panels and Role.skills were not adopted. plan.md still lists them, so they remain a possible later step. Items below marked PLANNED do not exist in the code.

## Stack

- TypeScript (tsc 7, separate node and web tsconfigs, no baseUrl)
- Electron 45 + electron-vite 6 + Vite 8
- React 19, @xyflow/react 12 (React Flow), @dagrejs/dagre, zustand 5, react-markdown + remark-gfm
- lucide-react 1.64 (SVG icons that take their color from currentColor)
- Plain CSS with custom-property design tokens (no CSS framework)
- @anthropic-ai/claude-agent-sdk 0.3.312 (Claude adapter), zod 4 for harness tool schemas
- @openai/codex 0.166.0 (Codex adapter and the OpenAI connection: `codex app-server`, JSON-RPC over stdio)
- vitest 3 (node env) for unit tests; playwright-core Electron driver for e2e
- electron-builder (Windows nsis + portable tested; mac dmg and linux AppImage configured, untested)
- Node >= 22, git (worktree isolation)
- Not installed (plan.md keeps them as a possible later step): radix-ui, react-resizable-panels. The frontend-design skill is not vendored in .claude/skills.

## Modules

### Shared contracts

IPC-safe types (Project, Role, RunEvent, UsageStatus, connections, models, remaps, MCP servers, plugins, install requests, IPC names), defaults (adapterForProject, builtin models, tier helpers, MCP secret names), the built-in Architect and MCP assistant roles and setup tool names. RunSummary.endedWithApp is set by RunStore at startup for runs cut by the app quitting. Role.skills is PLANNED and not in the contract yet.

- Appearance: AppSettings.appearance (AppearanceSettings: theme 'dark' | 'light' | 'system', accent '#rrggbb', canvas { pattern dots/grid/none, tint, edges curved/orthogonal/straight, minimap }, reduceMotion 'system' | 'on'). defaults.ts holds DEFAULT_APPEARANCE (theme stays 'dark' until the light theme is signed off) and THEME_BACKGROUND (window background per resolved theme, matching --surface-0). Main applies the theme to nativeTheme.themeSource at startup and on every settings:set, then broadcasts settings:changed (IPC.settingsChanged, preload window.orgai.onSettingsChanged).
- Notifications: AppSettings.notifications is the single source of truth, and main reads it at every decision (notifications.ts). window.orgai.notifications.setEnabled (app:setNotifications) remains only as a deprecated mirror into it. The renderer no longer calls it.
- Projects: projects:checkPath returns ProjectPathCheck (exists, isDirectory, isGitRepo, suggestedName, empty) and never rejects. projects:create validates the path (ProjectStore createPathError) and throws a readable message. ProjectCreateInput.mock creates a project on the mock adapter (provider.id 'mock'). It is accepted only when the mock adapter is registered (ORGAI_MOCK=1).
- Cards: every *.resolved RunEvent (permission, proposal, question, rules, merge, mcpInstall) may carry `cancelled?: true`. src/main/runtime/pendingCards.ts cancelPending resolves every open card of a run as cancelled. RunManager calls it from emit when a run reaches an outcome or a paused status, and at teardown.
- Transcript: TranscriptEntry.source 'harness' marks entries the harness wrote (nudges, hand-offs, notices, limit notices). Claude, Codex and mock write them as system blocks with a one-line summary and a detail.
- Run titles: RunSummary.title (optional, at most RUN_TITLE_MAX_CHARS = 32 characters) is a short AI summary of a work run's first message, and RunEvent `{ type: 'run.title', runId, title }` announces it, at most once per run and possibly after the run ended. Both ride the existing runs:list / runs:get / runs:listLive and run-event paths, so no IPC or preload change was needed. It is absent until generated and stays absent when generation fails or is skipped. The UI falls back to the prompt.
- Agent import: projects:scanAgents(path) -> AgentImportScan (never rejects), projects:previewImport(AgentImportInput) -> AgentImportPreview (saves nothing), projects:applyImport(AgentImportInput) -> AgentImportApplyResult ({ project, previousRoles }; Undo = save previousRoles through projects:save), projects:exportOrg(projectId) -> OrgExportResult ({ path }). AgentImportInput is { projectId, sources?: AgentImportSource[], mode: 'replace' | 'merge', choices?: AgentImportChoice[], digest? }; a choice is { key, include, reportsTo? (slug or id), model? ('inherit', a catalog model or a tier name), action? 'add' | 'replace' | 'skip' } keyed by AgentImportItem.key (`<source>:<file>#<name>`, `~2` for repeats). Items carry model, originalModel, tier, modelReason (kept | tier | default | inherit | chosen), tools, toolsDropped, promptExcerpt (600 chars) and promptLength, action, replacesRoleId, slugConflict and notes. AgentImportPreview.digest (sha256 of the scanned definitions) passed back on apply makes apply refuse a folder that changed since the preview. ProjectCreateInput.importAgents starts a project with the imported roles ('replace'). ProjectPathCheck gains agentSources, instructionFiles and existingProjectId/existingProjectName (a project whose folder is the same by pathKey). ProjectProfile.agentDefinitions lists the agent locations present. AGENT_IMPORT_SOURCES / AGENT_IMPORT_SOURCE_LABELS: orgai, claude, opencode, codex, copilot, gemini, kiro, roo. defaults.ts importTierForModel classifies foreign model ids into tiers (tierForModel is unchanged except that it now ignores a `[1m]` suffix).
- Live runs and run windows: runs:listLive (every live run across projects), runs:pendingCards (PendingCards: a live run's open cards per kind, built by pendingCards.ts listPending over RunManager's PendingCardMaps) and window:openRun (FocusRunTarget, opens or focuses a run-scoped window; ids are checked with windowScope.ts isValidId plus store lookups).

- `src/shared/types.ts`
- `src/shared/defaults.ts`
- `src/shared/setup.ts`

### Runtime core (provider-neutral)

- Adapter interfaces and the run manager. RunManager picks the adapter, resolves the connection and MCP servers per run, and handles approvals, proposals, questions, merges and MCP install cards.
- Harness tools, each with an audience: 'root', or 'spawners' for the MCP tools. Callers pass a HarnessToolCaller when they know the calling agent.
- Role prompts, activity strings, permission scopes, agent handles and messages, the continuation driver, WorktreeIntegrator and git worktree commit/merge.
- Vendor-neutral usage mapping.
- Image attachments. attachments.ts sanitizes untrusted pasted images: count and size limits, base64 checks, and magic-byte sniffing.
- Run end. activity.ts runOutcome maps how a run ended to finished, stopped or failed, and settleAgent relabels agents Finished, Stopped or Failed (TERMINAL_ACTIVITY). pendingCards.ts cancels the run's open cards at the same point.
- Agent tree rules. agentTree.ts resolves a reported agent's parent without creating cycles and repairs cyclic stored records.
- Concurrency. Any number of runs may be live at once, in one project and across projects, on every adapter: RunManager keys runs by id, ContinuationDriver and adapter sessions keep per-instance state, and each Codex session starts its own app-server. The only refusal is continueRun's "Session already open" for one provider session chain. RunManager.liveRuns() backs runs:listLive.
- Cross-run messaging. Work-run roots get list_runs and message_run (RUN_HARNESS_TOOLS). RunManager implements RuntimeContext.listRuns / messageRun and delivers through the target's RuntimeSession.receive(), which every adapter routes through its harness-message path (peerMessageText in prompts.ts frames the text as peer data). Delivery goes through the target's inbox: RunManager holds peer messages while the run waits on its user (see Conventions) and flushes them oldest first, one chained flush at a time. Both runs get a run.message event (direction out/in) and a root transcript system block ("Sent to run …" / "Queued for run …" / "Note from run …", marked TranscriptEntry.source 'harness').
- Run titles. RunManager.start fires src/main/ai/runTitle.ts generateRunTitle after the 'starting' status for every work run with prompt text. Setup-like runs, image-only prompts and the harness's auto-resume message (RESUME_TEXT, which carries the continued run's title) are skipped. The call is a one-shot RuntimeAdapter.complete with `kind: 'title'`, the run's RunConnection and the fast model from RunManagerOptions.fastModel (index.ts: ConnectionService.fastModel). It has a 20 s timeout and cleanTitle cleans the answer. The result is stored on the summary (index and record) and broadcast as run.title. A continuation passes the continued run's title, or a prompt excerpt, as context (`continues`). CompletionInput carries `kind` ('draft' | 'title') and `connection`: Claude merges `connection.env` (claude.ts completionEnv), Codex uses the connection instead of its completionConnection, and the mock answers 'title' with the first four words of the `<message>` text. Run titles are cancelled on user stop, project removal and app quit (`stopAll`); a run that ends on its own may still receive its title afterwards.
- Worktrees. worktrees.ts pathKey resolves the nearest existing ancestor's realpath (macOS /tmp is /private/tmp). withRepoLock serializes git work per checkout. Both commit-producing git calls (commit, merge) fall back to an OrgAI identity when git has none.

- `src/main/runtime/types.ts`
- `src/main/runtime/harnessTools.ts`
- `src/main/runtime/prompts.ts`
- `src/main/runtime/activity.ts`
- `src/main/runtime/continuation.ts`
- `src/main/runtime/integration.ts`
- `src/main/runtime/permissionRules.ts`
- `src/main/runtime/ruleMatch.ts`
- `src/main/runtime/network.ts`
- `src/main/runtime/attachments.ts`
- `src/main/runtime/agentTree.ts`
- `src/main/runtime/pendingCards.ts`
- `src/main/runtime/runManager.ts`
- `src/main/runtime/worktrees.ts`
- `src/main/runtime/usage.ts`
- `src/main/runtime/childEnv.ts` (isolateClaudeEnv: the routing-variable denylist for Claude Code children)
- `src/main/runtime/testHelpers.ts`

### Provider adapters

SDK event mapping and hook mechanics only. Only the Adapter Engineer edits claude.ts and mock.ts.

- Claude: the files below. Harness tools run in an in-process MCP server named "orgai". PreToolUse records which agent called them.
- Codex: codexAppServer.ts is the JSON-RPC client and binary lookup, codexProtocol.ts holds policies, launch config, dynamic tool specs and parsers, codexEvents.ts maps events, codexAgents.ts runs harness-side subagents as threads, and codex.ts is the adapter.
- mock.ts is the reference adapter. Its scripted MCP proposal uses a pinned package (mock-fs-server@1.0.0), so it passes validate.ts.

- `src/main/runtime/claude.ts`
- `src/main/runtime/claudeCost.ts`
- `src/main/runtime/claudePartial.ts`
- `src/main/runtime/codex.ts`
- `src/main/runtime/codexAppServer.ts`
- `src/main/runtime/codexProtocol.ts`
- `src/main/runtime/codexEvents.ts`
- `src/main/runtime/codexAgents.ts`
- `src/main/runtime/mock.ts`

### Connections and model catalog

ConnectionService covers:

- probes and status, the OpenAI ChatGPT login (browser or device code) through Codex, and the LiteLLM key
- model discovery (LiteLLM /v1/models and /model/info, Codex model/list), with the catalog persisted to models.json
- tier mapping and project remaps, including the projects:previewRemap dry run
- the per-run RunConnection, and Codex plan usage

- default connection at creation: prepareNewProject puts a new project on AppSettings.defaultConnection when creationConnection (defaults.ts) finds it usable and it maps every tier the roles use, else on anthropic (projects:create passes it to ProjectStore.create; mock and existing projects are untouched)

anthropicAuth.ts runs `claude --setting-sources project auth status` (the bundled CLI first, then PATH candidates) with the isolated child env in os.tmpdir(), so the status reflects what OrgAI's runs can use, and lists candidate claude binaries.

- `src/main/connections/`

### MCP servers and plugins

McpService covers:

- persisting Project.mcpServers / Project.plugins, with secret values only in SecretStore
- the app-wide MCP library (store/mcpLibrary.ts, <data>/mcp-library.json): entries defined once, linked by projects (McpServerSpec.libraryId), snapshots refreshed on read, link / unlink / promote, library removal unlinks every project and drops Role.mcpServers grants
- OAuth for remote servers (oauth.ts: discovery, client registration, PKCE, loopback redirect, token exchange and refresh); McpService.authorize / cancelAuthorize / revokeAuth / prepareForRun; resolve() injects the bearer
- resolving servers for runs and saving installs that the user approved with scope 'project'
- registry search (registry.ts, the official MCP Registry)
- the token-free server test (probe.ts: initialize + tools/list for stdio and streamable HTTP)
- spec validation (validate.ts: pinned versions, names, library entries) and the MCP assistant context and the virtual harness project (assist.ts)

- `src/main/mcp/`

### Setup and drafting

- A token-free repo profiler.
- Applying approved proposals, including MCP server proposals. Removed servers lose their secrets.
- Writing .orgai/ARCHITECTURE.md.
- A quick org chart drafter.
- Run titles (ai/runTitle.ts: the system prompt, generateRunTitle and the pure cleanTitle).
- The agent importer (setup/import/), token-free and read-only on the repo except the export:
  - scan.ts scanAgentSources reads only the known locations: `.orgai/org.json` (OrgAI's own export), `.claude/agents/**/*.md` (depth 4), `.opencode/agents|agent/*.md`, `opencode.json(c)` and `.opencode/opencode.json(c)` (`agent` map; `{file:...}` prompts), `.codex/agents/*.toml`, `.github/agents/*.agent.md`, `.gemini/agents/*.md`, `.kiro/agents/*.json|*.md` (`file://` prompts), `.roomodes` (YAML or JSON customModes). Instruction files (AGENTS.md, CLAUDE.md, .claude/CLAUDE.md, GEMINI.md, .cursor/rules/*.mdc) are listed, never read or turned into roles. agentDefinitionLocations feeds the repo profiler.
  - Parsers (parsers.ts) on hand-written subsets: frontmatter.ts (YAML frontmatter and simple documents), toml.ts, jsonc.ts. No YAML or TOML dependency. A bad file becomes a warning, never an exception.
  - tools.ts maps foreign tool names into TOOL_CATALOG (lossy; unknown and mcp__ names are reported as dropped; Agent/Task names set canSpawn; denied tools remove). No tool list gives Read, Glob, Grep, Edit, Write, Bash.
  - model.ts maps each model to the project's connection: 'inherit' stays; a catalog model of the connection is kept; otherwise the tier (the export's tier, else importTierForModel) picks the connection's tierModels entry (anthropic: the alias; a missing tier falls to the nearest mapped one); a missing or unknown model gets 'everyday' with a note.
  - convert.ts builds the resulting chart: 'replace' drops the chart, 'merge' keeps it and adds under its root. OrgAI exports keep reportsTo and spawnable (slugs). Flat sources get a root: the export root, else the single opencode primary agent, else the role that looks most like an orchestrator, else the existing root (kept). Slug clashes rename ('add') or take the existing role's place keeping its id, reportsTo and spawnable ('replace'). Choices are validated: an unknown manager, a cycle or a model the connection lacks throws a readable error. A LiteLLM import whose roles need two adapters gets a warning.
  - export.ts writes `.orgai/org.json` (format 'orgai.org/1': project name and roles with slug references; no ids, positions, secrets or MCP grants) through an exclusive random temp file and refuses a symlinked `.orgai` or `org.json`.
  - importer.ts AgentImportService backs the four IPC channels, the checkPath extras and ProjectCreateInput.importAgents (applied after prepareNewProject, then ConnectionService.withAdapter). Preview and apply always re-scan the stored project's folder; the renderer supplies choices, never roles. A saved import broadcasts project.updated.
  - SetupService.hiddenContext adds a "Detected agent definitions" block (detectedAgentsBlock: source, file, name, model, tools, description, a 600-char prompt excerpt, each through promptDatum inside <<< >>>, 16,000 chars at most) and the Architect prompt says to base the chart on them.

- `src/main/setup/`
- `src/main/setup/import/`
- `src/main/ai/`

### Main shell, stores and maintenance

- One window factory, createWindow(scope?) in index.ts. The main window is unscoped. window:openRun opens (or focuses) a window scoped to one run, loading the renderer at the hash #/run/<projectId>/<runId> (runWindowHash / parseRunWindowHash in src/shared/types.ts). index.ts keeps a Map<BrowserWindow, FocusRunTarget | undefined> of scopes. windowScope.ts holds the pure checkRunTarget (id pattern plus store lookups) and pickFocusWindow: a notification click focuses the run's window, else the main window, else any. Every window gets the same preload and security settings and every broadcast. Closing a secondary window never quits the app.
- The app entry. Startup order: ORGAI_DATA_DIR override (app.setPath('userData') + app.setAppLogsPath(<dir>/logs)), app.setName('OrgAI') when unpackaged, installLogging, applyShellPath, stores, SecretStore(safeStorage), ConnectionService, McpService, SetupService, adapters, RunManager, IPC, connections.init(). Then installAppMenu, and createWindow last.
- ORGAI_DATA_DIR is how e2e and CI keep off the real profile. package.json productName ("OrgAI") names the packaged app.
- IPC handlers, logging and notifications. notifications.ts reads AppSettings.notifications through a getter that index.ts passes in. log.ts pickLogsDir falls back from the app logs dir to <userData>/logs, then to temp.
- app:info (IPC.appInfo) returns AppInfo: version, platform, dataDir, logsDir, packaged, and mockAdapter, derived from the adapters map RunManager received (registerIpc gets its keys as adapterIds). The pure builder is appInfo.ts. ORGAI_MOCK=1 registers the mock adapter, and the new-project form then offers "Use the mock adapter" (ProjectCreateInput.mock).
- The idle usage monitor (the Claude plan, plus Codex through extraProbes).
- JSON stores.
- shellEnv.ts gives macOS and Linux GUI launches the login shell's PATH, per shell: POSIX shells print $PATH, fish uses `string join`, and csh/tcsh/nushell/unknown shells fall back to /bin/zsh on macOS or /bin/bash on Linux. appMenu.ts is the macOS application menu.
- Leftover-branch maintenance.
- Run store layout under the data dir: runs.json (index), runs/<runId>.json (record), runs/<runId>/images/<sha256>.<ext>.
- Secrets live in secrets.json (safeStorage ciphertext) and the model catalog in models.json. OrgAI's own Codex home is <data>/codex.

- `src/main/index.ts`
- `src/main/ipc.ts`
- `src/main/log.ts`
- `src/main/appInfo.ts`
- `src/main/notifications.ts`
- `src/main/windowScope.ts`
- `src/main/usageMonitor.ts`
- `src/main/maintenance.ts`
- `src/main/shellEnv.ts`
- `src/main/appMenu.ts`
- `src/main/store/` (projects, runs, settings, secrets.ts)

### Preload bridge

The contextBridge API window.orgai and its typings (index.d.ts types window.orgai as OrgAIApi). window.orgai.app.info() returns AppInfo. window.orgai.onSettingsChanged subscribes to the settings:changed push. window.orgai.projects.checkPath(path) returns ProjectPathCheck. window.orgai.notifications.setEnabled is deprecated (see Shared contracts). `runs:pendingCards` (`window.orgai.runs.pendingCards(runId)`) returns a live run's open decision cards as `PendingCards` (the same secret-free objects its `*.request` events carried), or empty arrays for an unknown or ended run. window.orgai.runs.listLive() returns every live run across projects; window.orgai.window.openRun({ projectId, runId }) opens a run-scoped window. window.orgai.projects.scanAgents / previewImport / applyImport / exportOrg are the agent importer (see Shared contracts).

- `src/preload/`

### Agent skills

- `.claude/skills/run-desktop/` (drives the built app for walkthroughs)
- The frontend-design skill that the design docs (spec.md, providers-and-mcp.md) refer to is not vendored: `.claude/skills/` holds only run-desktop.

### Brand assets

- `src/renderer/src/assets/brand/`
- `build/icon.png`
- `scripts/make-icon.mjs`

### Theme layer

lib/theme.ts applies AppSettings.appearance to <html>. initTheme() runs in main.tsx before React renders and follows settings:changed and prefers-color-scheme. It sets data-theme (the resolved dark or light), data-reduce-motion="on", data-canvas-pattern, data-canvas-tint, data-canvas-edges and data-canvas-minimap, the accent vars, and --canvas-pattern-kind, --canvas-edge-style and --canvas-minimap. CSS reads the attributes. Code that needs a resolved color value (React Flow props) reads a CSS var through lib/useCssVar.ts. tokens.css defines every token for both themes, and styles/tokens.test.ts checks it.

- `src/renderer/src/styles/tokens.css`
- `src/renderer/src/styles/global.css`
- `src/renderer/src/lib/theme.ts`
- `src/renderer/src/lib/useCssVar.ts`

### UI primitives

components/ui is built on native elements: Badge, Banner, Button, IconButton, Dialog, ConfirmDialog with useConfirm (promise-style, replaces window.confirm), Input, Textarea, Checkbox, Select, SettingRow, Switch, SegmentedControl (native radio group), CopyButton, ModelSelect, SecretField, ConnectionStatusBadge, RemapNotice, Icon and ErrorBoundary (class component wrapping the main region; a render error shows a message and a way back to Projects instead of a blank window). IconButton requires `label`, which becomes the accessible name and the tooltip. Button takes optional `ariaLabel` and `className` (test hooks).

components/layout:
- CanvasFrame with its slots FrameToolbar, FrameStage (the React Flow canvas), FrameTray (decision cards, labelled "Decisions") and FrameFooter (the org chart hint row). Empty slots render nothing. The tray sits under the stage and docks beside it (420 to 480 px wide) only in a frame of at least 1500 x 560 px (never because the frame is short, and collapsing the side panel at 1424 does not move it); the stage keeps 55 percent of the frame and the tray scrolls inside the rest, except while a question is open (`.decision-card[data-inline]`: its options are the action, shown inline in compact mode too), when the stage may shrink to 36 percent. The tray is a container (`tray`): below 700 px its decision chips collapse to numbered chips (one roving Tab stop; label in the tooltip and aria-label) and never scroll horizontally. Fit-to-view in LiveRunView keeps zoom at 0.8 or more when the stage is under 300 px tall (the chart pans). The composer is 96 px. CanvasFrame sets `data-compact="true"` on `section.frame-tray` while the frame is under 480 px high, which the cards read. `FrameToolbar dense` is the run view's 32 px toolbar.
- SidePanel (a labelled region that keeps its content mounted) and SaveIndicator (project autosave status in the topbar).

- `src/renderer/src/components/ui/`
- `src/renderer/src/components/layout/`

### Renderer UI

- The app shell, projects view, org chart editor, live run view, app and project settings, transcript, usage meter, zustand store and dagre layout.
- Shell (brief 1B, docs/design/ui-review-2.md B.3 and B.4): the sidebar starts with `layout/BrandLockup` (48 px row; the neutral MOCK `Badge`, testid `mock-mode-badge`, is its tag; the collapse IconButton is its trailing slot). Below 1180 px window width, or by Ctrl/Cmd+B, it becomes a 56 px rail (`lib/useSidebarCollapsed.ts`: module store behind useSyncExternalStore, explicit choice persisted in localStorage key `orgai.sidebar`, else auto by width; `.app[data-sidebar]` drives the grid column). The rail shows the mark (an Expand button), nav icons with tooltips, and project initials chips (`nav-project` testid, `data-name`, accessible name "Notes API, 2 need you"). One compact "Needs you · n" row opens a `Popover` list (click calls `jumpToDecision`); project rows keep the dot and gain a needs-you count `Badge`, with state from `lib/projectStatus.ts`. The footer is one 52 px account row (testid `auth-pill`, a `Popover` trigger: dot, label, percent and a 4 px `UsageBar` of the tightest plan window, `--warning` from 80 percent, `--danger` at the limit; mock mode reads "Mock adapter" with no bar) plus the gear IconButton "App settings", the one route to App settings. The popover holds every plan window (auto-refreshing, no Refresh button) and a link to App settings > Connections. Two skip links precede the sidebar ("Skip to content", "Skip to sidebar"). Status carriers: sidebar dot and count per project, a topbar `Badge` ("Needs you · n") only on non-Live tabs when something waits, the active run tab on the run level, the tray for decisions; the Live topbar has no status pill. The window title is `<project> · R1: <run name> · OrgAI` (never OrgAI first). New primitives from brief 1A: `ui/Popover` (native popover attribute, renders its own trigger), `ui/Tabs` + `TabPanel` (underline tablist), `ui/EmptyState`, `ui/Badge` tones (neutral, accent, success, attention, info, danger; warning is an alias).
- Project tabs: Live, History, Org chart and Settings in the topbar (App.tsx), a 48 px bar: project name, then `lib/paths.ts` `folderName` only (mono 12 px, full path in the tooltip, testid `project-folder`, hidden when equal to the project name or below 900 px of main), the underline `Tabs` (`role=tablist` named "Project sections", tabs are `role=tab`), then at most SaveIndicator and the needs-you badge on the right. views/OrgChartView.tsx is the org chart editor (keyboard model, add and remove roles with undo, inspector sections). It was split from views/SettingsView.tsx, which is now the sectioned project settings page.
- Resizable columns: `components/layout/ResizeHandle` is a `role=separator` (vertical, `aria-valuenow/min/max`, focusable) inside the column it resizes, on the edge facing the neighbour, so it never overlaps the canvas. It supports captured pointer drag, Left/Right (16 px, Shift 64 px), Home/End and double-click to reset; `lib/panelWidth.ts` holds the pure clamp/drag/key helpers (tested) and `usePersistedWidth`. Sidebar: 200-420 px (default 232), localStorage `orgai.sidebarW`, App sets `--sidebar-w` on `.app` and the main area keeps at least 480 px; shown only in the full sidebar, not in the rail (the chosen width survives collapse/expand). Right `SidePanel`: 280-640 px, localStorage `orgai.sidePanelW.<persistKey|default>`, drives `--side-panel-w` on the parent grid (`.editor`, `.run-body`; unset means the CSS default 360 px / clamp(280px, 28cqi, 400px)) and the canvas keeps at least 360 px; hidden while the panel is collapsed. Dragging below the minimum does not snap to the rail. One width budget (`panelBudget`): the canvas keeps 360 px; when the panel minimum does not fit, the panel shows as its rail (saved width and open choice kept and re-applied when space returns). `autoCollapseBelow` reacts to first layout and window resizes only, never to handle drags. Enter or double-click resets a handle; arrows move the splitter (WAI-ARIA window splitter, `aria-valuetext` "N px wide"). OrgChartView re-fits on frame resize like LiveRunView. The account popover's `UsageMeter` has no Refresh button or Updated text: it calls `refreshUsage()` on open when data is older than 60 s, then every 60 s while open (one call in flight, at most one attempt per minute even on failure), shows "Reading usage…" during the first read and "Out of date" once a reading is over 15 minutes old.
- Settings pages: both pages (views/AppSettingsView.tsx, views/SettingsView.tsx) use the same frame, `components/settings/SettingsPage` (page title, `SettingsNav` pane selector, one `role=tabpanel` that starts with an h2 reading the tab label, `tabIndex -1`, id `<idBase>-pane-title`; sections inside are h3 and groups h4, and a section titled like its pane hides its title visually through `PaneTitleContext`). The nav is a native tablist (roving tabindex, arrow keys, `aria-selected`), a left rail from 640px of container width and a tab strip above that. Only the selected pane is rendered (no scroll-spy). App panes: general, connections, mcp-library, defaults, about. Project panes: general, agents (`AgentsSection`: Permissions, Saved permission rules via `PermissionRulesPanel`, Behaviour with the unattended, worktree and run-messaging switches), limits (one card of number rows plus the Sonnet fallback, which links to App settings > Usage), connection, tools, maintenance (one quiet line when no report branch waits). `lib/settingsTarget.ts` maps App section ids to panes (`appPaneForSection`); `requestAppSettingsSection` and `openMcpLibrary` open the App page on the right pane, `openProjectMcp` selects Tools, and every deep link then calls `focusPaneHeading()` (a link to a library row or server row focuses that row instead; the Limits link also scrolls to the Usage row and sets a brief `data-highlight` on it), and the project pane is remembered per project in `useAppStore.projectSettingsPane`. Inside a pane, `SettingsSection` (h3 title, optional `titleId`, lead, actions slot; `ConnectionsPanel` uses it with `titleId="connections-title"`), `SettingsGroup` (caption heading), `SettingsCard` (rows with hairlines) and `ui/SettingRow` (`width` number|select|full, `hint`, `more` as a Learn-more disclosure, description id from `settingDescId(id)` for aria-describedby) are the only layout primitives; whole-number fields use `settings/ClampedNumber`. Provider cards in Connections start collapsed and show a Connect button when not connected. Visible copy is one line (about 15 words); shared wording for settings that exist at both scopes lives in `lib/settingsCopy.ts`. All settings-page CSS lives in `styles/settings.css`. Section ids (`settings-section-*`, `appsettings-section-*`) stay stable for e2e and deep links; e2e selects the pane with `getByRole('tab', { name })` first.
- Decision cards: components/DecisionCard.tsx is the shared shell (run label, title, body, actions). PermissionCard, QuestionCard, RuleRequestCard, MergeReviewCard, McpInstallCard and ProposalCard (with an org-chart diff from lib/orgDiff.ts) are built on it. They sit in CanvasFrame's tray through `components/DecisionTray.tsx`, which lists every open decision as a chip (count, previous/next) and mounts one card at a time.
- Projects view: a live path check through projects:checkPath, inline errors, Architect and mock toggles, a collapsible new-project form, and ConfirmDialog for delete. lib/projectsForm.ts holds the pure path and form rules.
- Connections settings (components/connections/).
- MCP servers, plugins, registry dialog and install cards (components/mcp/). McpLibrarySection is the App settings "MCP library" (nav id appsettings-section-mcp-library); McpSection splits project servers into "From your library" (libraryId) and "Only in this project"; McpLinkDialog links an entry (no roles preselected); McpAuth holds AuthChip and AuthorizeControl (OAuth states, client id/secret inputs, pending + cancel); mcpWriter.ts lets McpServerForm and RegistryDialog write to a project (mcp.*) or the library (mcpLibrary.*); McpAuthNotice warns on the New run page. The virtual harness project (HARNESS_PROJECT_ID) is held in the store as harnessProject (never in projects), so library assistant runs open in a run window; the topbar shows "MCP library assistant" and no Org chart or Settings tabs.
- Run workspace: components/RunTabs.tsx (browser-style tablist, roving tabindex, +n overflow menu, tab context menu with Open in new window, Ctrl+T / Ctrl+W), the run strip (`[data-testid=run-strip]`, 40 px: RunTabs at the start, RunActions.tsx at the end with Interrupt turn, End session and Org retrospective; the active tab carries index, status dot with an sr-only status word, title, and the full prompt in its tooltip), RunMeta.tsx (the 12 px metadata line at the start of the canvas toolbar, `[data-testid=run-meta]`: continues, agents, steps, cost, started, unattended; the toolbar end holds the Hide finished agents switch, zoom out / in / fit IconButtons and the "Canvas legend" Popover, so React Flow's Controls are gone), DecisionTray.tsx, NewRunPage.tsx (an EmptyState behind +), Composer.tsx (shared message box; drafts live in the store per run id or `new:<projectId>`), RunLabel.tsx (names a run on decision cards), Sidebar.tsx (project rows expand to open runs, global Needs you list), RunHistory.tsx (the History tab). LiveRunView composes them on layout/CanvasFrame (toolbar, stage, tray) and layout/SidePanel (`autoCollapseBelow` 1100 px of grid width, choice saved in localStorage `orgai.sidePanel.run`, opens when a node is selected); a failed run shows a danger Banner above the canvas. Nothing floats over the canvas.
- Run state in useAppStore: `draftPage` per project (New run page), `composerDrafts`, `sideTabByRun`, `unreadByRun` (notes from other runs), `historyByProject`; runs.listLive() fills `runs` at init so a second window or a reload shows every live run. Run index (R1, R2) is per project by start order (lib/runLabels.ts); status words come from lib/runStatus.ts. Run names: `runName(summary)` in lib/runLabels.ts is the one rule (the AI `RunSummary.title`, else a 40-char prompt excerpt, "Image prompt" for image-only) and `runTitle(index, summary)` adds the R-index. Tabs, the "+n" menu, sidebar rows, document.title, the run header, History rows and links, New run links and decision-card RunLabels all use it; the full prompt stays in tooltips (the active run tab's included) and the History second line. `handleEvent` sets `summary.title` on `run.title` (also in `history` / `historyByProject`, since it can land after the run ended) and `fillSummary` keeps it. CSS cuts the text, never JS.
- Multi-window: window.orgai.window.openRun opens a window whose location hash is `#/run/<projectId>/<runId>` (RUN_WINDOW_HASH_PREFIX, parseRunWindowHash in shared/types.ts); init selects that run. The window title reads `OrgAI · R2 · <prompt>`.
- Cross-run messages: RunEvent run.message only marks the receiving tab unread. The transcript shows the persisted system rows on the root ("Sent to run ...", "Note from run ...") through lib/peerNotes.ts as a sender row and a tinted receiver row, as plain text, never Markdown. Harness-written entries (source "harness") render as system rows with `detail` behind a disclosure. Project.runMessaging (default off) is the Switch in project Settings.
- lib/platform.ts: navigator-based isMacPlatform, modKeyLabel and examplePath, no IPC.
- lib/runChains.ts: session chains. Continue is offered only on the chain's newest member.
- lib/runStatus.ts is the one status vocabulary: Running, Needs you, Idle, Paused, Finished, Stopped, Failed. The run tabs, sidebar, topbar badge and History use its words and tones.
- Pure, unit-tested helpers in lib/: needsYou.ts (pending decisions across runs), runLabels.ts (R1, R2 per project), runStatus.ts, peerNotes.ts (cross-run notes), transcriptRows.ts (tool calls as sentences, raw input as an optional detail), orgDiff.ts (the proposal diff), roleOps.ts (role names, add and remove), projectsForm.ts, layout.ts (dagre layout; acyclicParents detaches a role whose reportsTo chain loops), theme.ts.
- Styles: one CSS file per area in styles/, including layout.css (the CanvasFrame and SidePanel grid) and run-tabs.css. RunStrip.tsx, NotificationsToggle.tsx and LogsLink.tsx were removed: run tabs replace the strip, and notifications and logs live in App Settings.

- `src/renderer/src/`
- `src/renderer/src/components/connections/`
- `src/renderer/src/components/mcp/`
- `src/renderer/src/components/settings/`
- `src/renderer/src/components/DecisionCard.tsx`
- `src/renderer/src/components/RunTabs.tsx`
- `src/renderer/src/views/`
- `src/renderer/src/lib/`
- `src/renderer/src/styles/`

### Scripts, e2e and packaging

- SDK and provider smoke tests. They spend tokens, except smoke-litellm without --yes.
- Icon generation.
- Electron e2e flows run against out/.
- electron-builder config, macOS entitlements, and the macOS first-test checklist.
- electron-builder.yml mac targets carry no arch list (in electron-builder 26 an arch list overrides the --arm64/--x64 CLI flags). Mac artifacts are ${productName}-${version}-${arch}.${ext}.
- CI and packaging:
  - .github/workflows/ci.yml: on push to main or dev and on pull requests into main or dev. check job (npm ci, typecheck, test, build, e2e:free) and pack job (electron-builder --dir), both on windows-latest and macos-14.
  - .github/workflows/release.yml: a v<version> tag, or workflow_dispatch (dry run by default). The meta job refuses a tag or publishing dispatch whose commit is not reachable from origin/main (a dry run of another ref only builds, with a notice). windows on windows-latest, mac-arm64 on macos-14, mac-x64 on macos-15-intel. Each leg runs on its native runner so npm ci installs the matching darwin-<arch> optional deps. Unsigned unless the CSC_LINK/APPLE_* secrets are set. The publish job drafts a GitHub release.
  - .github/dependabot.yml: weekly grouped npm and actions updates, targeting dev.
  - scripts/ci-check-version.mjs: the release tag must equal package.json's version.

- `scripts/`
- `e2e/`
- `electron-builder.yml`
- `build/entitlements.mac.plist`
- `docs/macos-testing.md`
- `docs/testing.md` (local, token-free testing guide)
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `.github/dependabot.yml`

## Conventions

- Keep `npm run typecheck` clean for both tsconfigs. Paths are ./-relative with aliases @shared and @renderer. Never add baseUrl.
- Every type that crosses IPC is defined in src/shared/types.ts and must be structured-clone safe. Wire new IPC in this order: shared types, main/ipc.ts, preload/index.ts and index.d.ts, then the renderer.
- The renderer only consumes normalized RunEvents and ConnectionEvents. Vendor SDK details never leave runtime/<provider>*.ts.
- Adapters contain only event mapping and hook mechanics. Shared behaviour goes in harnessTools.ts, prompts.ts, activity.ts, integration.ts, permissionRules.ts, ruleMatch.ts, network.ts, continuation.ts or usage.ts, and mock.ts is updated to match.
- Connections and adapters are separate. The connections are anthropic, openai and litellm, and the adapters are claude and codex.
  - Anthropic always runs on Claude and OpenAI always on Codex.
  - On LiteLLM the root role's model family picks the adapter (adapterForProject).
  - A work run whose roles mix families is refused before the run exists.
- Remaps:
  - Role.tier plus each connection's tierModels drive remaps. A remap never clobbers an explicit pick of a valid catalog model, except when the project switches connection.
  - Remaps are reported as projects.remapped with Undo in the UI.
  - projects:previewRemap is the main-process dry run.
- Secrets live only in SecretStore (Electron safeStorage). Covered secrets: the LiteLLM key, MCP env and header values, and MCP OAuth client secrets and tokens.
  - Key scheme: project servers `mcp:<projectId>:<serverId>:{env|header|oauth}:<name>`, library entries `mcplib:<entryId>:...` (helpers in store/secrets.ts). A linked project server uses its entry's secrets.
  - McpOAuthConfig (endpoints, client id, expiry) is written by the main process only; mcp:upsert and mcpLibrary:upsert keep the stored value, and a url change drops it and its tokens.
  - They never cross IPC. Write-only inputs are allowed, and responses carry has-flags only.
  - They are never logged and are redacted from probe output. An API key reaches Codex only through the environment.
- projects:save (ProjectStore.saveFromRenderer) keeps the stored mcpServers and plugins. Those change only through mcp:* and plugins:*, approved setup or MCP proposals, and installs approved with scope 'project'. Deleting a project deletes its MCP secrets.
- OrgAI's Codex home is <data>/codex, so it never loads the user's ~/.codex config.
- The Claude child env is isolated (childEnv.ts isolateClaudeEnv). The Anthropic connection uses only the Claude Code login, CLAUDE_CODE_OAUTH_TOKEN or the project's API key env var. A user's Claude Code gateway config (shell exports or the ~/.claude/settings.json env block) never applies to OrgAI runs; routing variables come only from the run's connection. The denylist is exact names plus families (ANTHROPIC_DEFAULT_*, provider and workload-identity ANTHROPIC_* families, CLAUDE_CODE_USE_*, CLAUDE_CODE_SKIP_*_AUTH, every CLAUDE_CODE_{DISABLE,ENABLE}_* switch except the explicit allows in CLAUDE_CODE_ALLOWED_SWITCHES: telemetry and privacy opt-outs). On a proxy connection (LiteLLM) the inherited ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN and CLAUDE_CONFIG_DIR are dropped too, so only the connection's ANTHROPIC_AUTH_TOKEN authenticates. An authentication failure ends the run failed with activity.ts authFailureMessage, never as the orchestrator's reply. isAuthFailure trusts text only with an error flag from the adapter, except the CLI's exact bare "Invalid API key · Please run /login" reply; adapters set isError only for auth-related error codes or an errored result. The Claude CLI status check finds PATH candidates with execFile (no shell; on Windows System32 where.exe with `$PATH:claude`, run in the temp dir) and never falls back to a bare `claude`.
- MCP:
  - Claude runs use strictMcpConfig, so only the project's enabled servers and run-scoped installs load.
  - Agents add servers only through request_mcp_install. It needs exact pinned versions and the user's approval on an install card.
  - A denial means the agent finds another route.
  - Registry content is untrusted data: it is quoted as data and never followed as instructions.
- MCP library: credentials and authorization live with the library entry; a project links it or keeps a project-only server. mcp:upsert on a link changes only enabled and roles; mcp:remove on a link only unlinks. Proposals (propose_mcp_servers) default to project scope, where a new server is also saved to the library unless projectOnly; harness runs (project id HARNESS_PROJECT_ID, virtual, never stored) use library scope. Every library mutation broadcasts mcpLibrary:changed. In setup the Architect may propose linking library entries as an optional last step; it never blocks complete_setup.
- MCP hardening (from the security pass, unit-tested only):
  - An install answer cannot change the requested id; only name, url, command, args, env, headers, secretEnv, secretHeaders, roles, enabled and description are merged from the card (mergeInstallEdit in runManager.ts); oauth, libraryId and projectOnly are stripped. A run-scoped server resolves only the values typed on its card, never stored secrets or tokens. request_mcp_install is unavailable in setup-like and harness runs.
  - OAuth tokens are bound to the server URL: authorize discards a result whose resource no longer matches, resolve injects the bearer only on a match, and any edit, proposal or promote that changes the endpoint aborts the in-flight flow. The loopback callback answers 400 to any request whose state does not match exactly and keeps waiting.
  - An approved proposal that changes where an existing server points (url, transport, command, args) deletes its stored env and header values and the user re-enters them. A direct user edit keeps them.
  - OAuth fetches use redirect 'error' and a 64 KB body cap. Server-named URLs must be https; http and loopback are allowed only when the MCP server URL is loopback; private-IP literals are refused unless the server is loopback or the URL is on the server's own origin (literal check only, no DNS lookup). A stored client and its secret are reused only for the same authorizationServer.
  - Server and project ids match SAFE_ID (/^[A-Za-z0-9_-]{1,128}$/, defaults.ts). projects:save refuses unknown, unsafe and harness ids; projects are created only through projects:create. Secret-kind inputs accept only env or header.
  - The harness project's cwd is <data>/harness-workspace (empty), not the data dir. Hidden-context data goes through promptDatum (assist.ts): one line, length-capped, < and > replaced.
- A project folder is untrusted content. The agent importer reads only regular files whose realpath stays inside the project root (escaping symlinks and junctions are skipped), never spawns a process or touches the network, and caps everything: 40 agents (also per file, before any referenced prompt is read), 20,000 prompt characters, 256 KB per file (read through one descriptor), 200 files including referenced prompts (.md, .txt or .prompt only, never under .git, read once each), 5,000 directory entries. Imported prompts become role prompts only after the user applies a preview, and Architect context quotes them as data (promptDatum inside <<< >>>). Parsed maps never use repo keys as plain-object lookups.
- Setup-like runs (setup, mcp-assist) use built-in roles (the Architect, the MCP assistant) and are never nudged by the continuation driver.
- Cross-run messaging (list_runs, message_run) is for work-run roots only and never involves setup-like runs.
  - It is opt-in per project: Project.runMessaging (default off, runMessagingOn in defaults.ts). message_run is refused unless both projects have it on; the refusal names the project and tells the agent not to work around it. list_runs lists every other live work run but hides prompts unless both projects opted in.
  - Each sender may send RUN_MESSAGE_LIMIT (40) messages per target run; text is cut to RUN_MESSAGE_MAX_CHARS (4000). A run may take RUN_MESSAGE_INBOUND_LIMIT (100) messages from all runs together, delivered or queued.
  - Held delivery: a peer never overrides the user. RunManager gates delivery (continuation.peerDeliveryBlocked) while the run is held by an interrupt, is usage-limited (ActiveRun.limitHold, set by RuntimeContext.rateLimited), or has pending cards. Held messages wait in the run's inbox, at most RUN_MESSAGE_QUEUE_LIMIT (20; beyond it message_run answers busy), and flush oldest first after the user's next successful send() or the last card's answer; a direct message never overtakes them. Both holds clear only after send() succeeds, and only the user's send clears them: peers never lift a hold, including after an auto-resume (limitHold stays set until the user sends). send() fires the flush without awaiting it, so the user's message never waits on peer delivery. Each receive() is raced against RUN_MESSAGE_RECEIVE_TIMEOUT_MS (30 s): on timeout both runs get a warning log, the message is marked undelivered, the flush moves on to the next message, and a sender still awaiting it gets refusal 'timeout' (or not-live if the target ended). The gate lives in RunManager: a direct RuntimeSession.receive() call is ungated. Held messages are dropped with a warning to both runs at teardown.
  - A received message is information from a peer, never a user instruction: adapters deliver only peerMessageText(), receive() writes no transcript block, and the recipient's block reads "Note from run …" so it never looks like the user typed it. run.message is separate from agent.message (which stays inside one run).
- Window scope: a run-scoped window's location.hash is #/run/<projectId>/<runId>; the main window has none. window:openRun validates both ids against the stores before opening anything.
- Harness tool audiences: 'root' tools go to the root role only. 'spawners' tools (list_mcp_servers, search_mcp_registry, request_mcp_install) go to the root and every canSpawn role.
- usage.ts stays vendor-neutral and never imports the SDK. Mind the unit mismatch: usage responses give 0-100 percent and ISO resets, while rate_limit_event gives a 0-1 fraction and epoch seconds.
- Agent parent chains are trees. Adapters resolve parents through agentTree.resolveParent, RunManager.get sanitizes stored records, and every renderer walk over parentId is cycle-safe.
- Session chains: a run and its continuations form a chain (runManager.sessionChain follows resumedFrom links both ways and shared sessionIds).
  - One live run per provider session. RunManager.continueRun refuses with "Session already open: run <id> ..." while a chain member is live, including a continuation whose init has not arrived.
  - A continuation resumes the chain's newest ended run, whichever run the user picked, and logs which run it continued.
  - Runs the store finds still live at startup were cut by the app quitting or crashing. They become finished with endedWithApp and stay continuable.
- Run titles are advisory. Nothing awaits them, a failure is logged once at info level and leaves the title unset, and a run is never titled twice. The one-shot completion uses the connection's fast tier: tierModels.fast, else 'haiku' on the Claude adapter, else the adapter's default. The user's message is sent as `<message>` data and never as instructions.
- Git operations on one checkout are serialized through worktrees.withRepoLock (keyed by pathKey of the merge target). integrateWorktree, commitLeftovers, discardWorktree and prepareRepo take it; a merge review waits outside the lock, and different checkouts never block each other.
- SDK spawns go through the adapter's EXECUTABLE_OPTION, and the native CLIs stay in asarUnpack.
- Renderer layout goes through components/layout and components/ui. Responsive behaviour comes from container queries (container-type on layout regions).
- PLANNED, not in force: Role.skills passed as AgentDefinition.skills.
- Styling uses design tokens only. Never hardcode hex colors, shadows, radii, font sizes or z-indexes. Every token is defined for both dark and light themes.
- Hierarchy comes from the type scale, weight and spacing, not from uppercase micro-labels. Labels use sentence case, with at most one primary action per region.
- Nothing floats over the React Flow canvas except React Flow's own controls. Decision cards live in CanvasFrame's FrameTray. Banners and notices sit in layout regions.
- No div or span with onClick and no native confirm(): ask through ConfirmDialog / useConfirm. Every control is reachable by keyboard with a visible :focus-visible ring, and every IconButton gets a label.
- One status vocabulary: run status words come from lib/runStatus.ts, and agent end labels from activity.ts TERMINAL_ACTIVITY. Views do not invent synonyms.
- A fresh renderer (a second window or a reload) seeds a live run's decision cards from `runs:pendingCards` and then follows the `*.request`/`*.resolved` events. As of 3cde179 the main side and preload exist but no renderer code calls it yet (UX N2 stays open until it does).
- Harness-written transcript entries (source 'harness') render as quiet system rows with the detail behind a disclosure, never as user or model messages.
- Appearance is consumed through the <html> attributes and CSS vars that lib/theme.ts sets. Views never read AppSettings.appearance to style themselves.
- Icons are lucide-react via the Icon wrapper. No Unicode glyphs as icons.
- Motion respects prefers-reduced-motion.
- Unit tests are *.test.ts files beside the module they test. They run with vitest in the node environment and never spend tokens.
- Smoke scripts and the e2e scripts setup, history and worktree spend real tokens. Run them only with explicit approval. e2e:free (layout, runs, maintenance, connections) is safe and must pass after UI changes, with selectors updated in the same change. e2e/runs.mjs also covers run titles on the mock adapter: a 6+ word prompt gives a 4-word tab, sidebar and run-window title with the full prompt in the tab tooltip, and `[mock:title-fail]` falls back to the prompt excerpt.
- e2e scripts and CI never touch the real user data directory: they set ORGAI_DATA_DIR.
- Release builds for each mac arch run on a native runner. Never cross-arch install the native CLIs.
- New dependencies are pinned to exact versions like the rest of package.json.
- SDK and provider behaviour claims are verified with a smoke script and recorded in CLAUDE.md with the version, or marked unverified there.
- Worktree commit and merge belong to the harness. Never register WorktreeCreate or WorktreeRemove hooks just to observe.
- Each feature lands as one descriptive commit plus a merge commit ('Merge <feature>').
- Branches: dev is the integration branch, main is stable and protected; releases are v<version> tags on main (release.yml refuses other refs). Agent runs happen on dev.
- Build output (out/, release/, release-*/, *.tsbuildinfo) is gitignored. Never commit it.
- Permission cards never clip a command silently: a Bash command is shown in full in a scrollable block, the title carries a "(+N lines)" or "(long command)" marker, and the header shows a "Command" badge (or "N lines" / "Long command" for multi-line or long ones) for every Bash call. In compact mode (body collapsed) every Bash card with a command focuses the Details toggle instead of the primary action (`DecisionCard` `focusDetails`, a no-op outside compact; also set for broad rule requests). Bidi and control characters in a command are shown as visible `\uXXXX` escapes with a "Hidden characters" badge.

## Commands

- Install: `npm install`
- Dev (hot reload): `npm run dev`
- Dev without tokens: `ORGAI_MOCK=1 npm run dev`
- Free local gate (typecheck, unit tests, build, e2e:free): `npm run check`
- Typecheck: `npm run typecheck`
- Unit tests: `npm test`
- Build: `npm run build`
- E2E (free, needs build): `npm run build && npm run e2e:free`. Each script uses a fresh temp data dir, or ORGAI_DATA_DIR if set.
- E2E (spends tokens): `node e2e/setup.mjs --yes | node e2e/history.mjs --yes | node e2e/worktree.mjs --yes`
- Smoke, spend tokens, consent required: `node scripts/smoke-codex.mjs --yes`, `node scripts/smoke-litellm.mjs --yes`. Without --yes, smoke-litellm only lists models and is free.
- Package Windows: `npm run dist` or `npm run dist:win`
- Package unpacked dir, no publish: `npm run pack` (not `npm pack`, which is npm's own tarball command). `npm run dist:dir` also builds an unpacked dir.
- Package macOS: `npm run dist:mac` (signed when an identity is available) or `npm run dist:mac:unsigned`. Per arch, on a machine of that arch: `npm run dist:mac:arm64`, `npm run dist:mac:x64`
- Regenerate icon: `npm run icon`
- Release: bump version on dev, merge dev → main by PR, `git tag v<version> && git push origin v<version>`

## Risks and gaps

- Codex:
  - It is unverified that dynamic tools (the harness tools) survive thread/resume. The adapter's MCP restart and run continuation assume they do.
  - All Codex, LiteLLM and MCP-registry wire shapes come from docs and schemas until smoke-codex and smoke-litellm run with your consent.
  - The device-code expiry field is a guess.
- Claude:
  - Env isolation and the truthful Anthropic status are unit-tested; no live run has confirmed which credential the bundled CLI picks with the isolated env, nor the live shape of an auth failure (assistant `error: 'authentication_failed'` comes from the 0.3.312 typings). `--setting-sources project` on `auth status` was checked token-free against a temp CLAUDE_CONFIG_DIR only.
  - settingSources ['project'] still loads the project repo's .claude/settings.json, whose env block (ANTHROPIC_BASE_URL and the like) or apiKeyHelper is applied by the CLI after OrgAI builds the child env. A hostile repo could reroute a run and capture its credential. Pre-existing; needs flag-level overrides or dropping 'project'.
  - Possible next step: a dedicated CLAUDE_CONFIG_DIR under the data dir for full isolation (it would also move the login and Keychain entry, so the user would log in inside OrgAI).
  - Other secrets in OrgAI's own environment (OPENAI_API_KEY, GITHUB_TOKEN and the like) still reach the Claude child and agent Bash; the denylist only covers routing.
  - Calling agents are attributed by tool_use id from extra._meta (the key is unverified), else first-in-first-out per tool name. FIFO can misattribute concurrent calls.
  - Query.setMcpServers for mid-run installs is unverified at runtime.
- macOS is untested by hand. The user tests on a MacBook with docs/macos-testing.md. Packaging and entitlements are unverified.
- The CI and release workflows have not had a first real run yet. Open:
  - winCodeSign extraction with signAndEditExecutable true on windows-latest.
  - Whether macos-15-intel is really x64 (the release job checks process.arch).
  - e2e:free on the mac runners, including a possible Keychain prompt for safeStorage.
  - Unsigned mac dmg/zip output, and whether hardenedRuntime without an identity causes trouble.
  - The publish job end to end.
  - Signed and notarized builds have never been exercised.
- Electron deprecates sync safeStorage (removed in Electron 46). SecretStore must move to the async API before upgrading.
- Run titles (docs/design/ux-review-run-titles.md): the renderer uses the title everywhere a run is named. Addressed: T1 (sidebar rows drop "Run "), T3 (full prompt readable via the header disclosure), T6 (one formatter), T7 (cards and links show the title, prompt in tooltips), T8 (History title plus muted prompt line), T10 only for the missing "+n" menu tooltip. Open: T10's unstable visible-tab count, T5's time suffix for image-only prompts, and any text fade on the swap (it is instant).
- The UX Researcher walked the UI on mock data (ORGAI_MOCK=1, a temp ORGAI_DATA_DIR): docs/design/ux-review.md, ux-review-runs.md and ux-review-runs-2.md (at dc86f31, before the brief A run-view merge). ux-review-mcp.md is a code walkthrough of the MCP screens. The connection and MCP screens have not been run against live services. Open items in ux-review-runs-2.md, not re-walked since:
  - N1, the tray outside the canvas frame: the code now renders FrameTray inside CanvasFrame. It needs a re-walk.
  - N2: a window opened with "Open in new window" does not show the run's pending decision. runs:pendingCards now provides the cards from main, but the renderer does not seed from it yet.
  - N3, N4, N2b: idle nodes read "Waiting for you". Reaching a decision by keyboard takes many Tab presses and focus is lost after answering. A stale tab notice never clears.
  - N5 to N13: tab overflow at 1024, Needs-you density, topbar crowding, runs cut by quitting read Finished, raw message_run JSON in the transcript, and smaller polish.
- Settings pages were re-walked after the pane restructure (docs/design/ux-review-settings.md, ux-review-settings-2.md). Still open: per-row 'Default: X' affordances on project rows that shadow an App default, a settings search (Ctrl+F only covers the open pane), and the equal weight of the four Tools-pane buttons.
- Radix, react-resizable-panels, Role.skills and the frontend-design skill are not in the tree. The light theme is not signed off, so the default theme stays dark.
- MCP OAuth is tested only against fakes; no live authorization server, GitHub included, has been used. Mid-run re-authorization is not supported. The private-host check is literal-only (a hostname resolving to a private address, or DNS rebinding, is not caught). codexProtocol.ts still puts a secret inline in argv when two stdio servers need the same secret name with different values (summary warning only). Agent-supplied env names such as NODE_OPTIONS or PATH are not blocked; the install card is the only gate. The UI for the library, link rows and Authorize controls has landed; still missing: a structured run event for "server needs authorization" (the New run page warns from server state only, nothing links from inside a run) and a "make project-specific copy" action for linked rows.
- Renderer remap previews (lib/remap.ts) are computed in the renderer. projects:previewRemap exists but is not wired into the UI yet.
- No lint or format tooling, and the renderer has no component tests (only the pure lib/*.test.ts helpers and styles/tokens.test.ts).
- The Claude SDK is pinned to 0.3.312. Plan usage relies on an experimental API and can break on upgrade.
- claude.ts and codex.ts are large hotspots for merge conflicts.
- Cross-run messaging: delivery of a peer message to a Claude orchestrator mid-turn is assumed from the existing notifyOrchestrator path and not smoke-tested; Codex delivery is tested only against a fake app-server. RunManager holds peer messages for an interrupted, usage-limited or card-blocked run, but RuntimeSession.receive() itself is ungated, so any new caller must go through RunManager. The per-pair and inbound caps bound but do not prevent token spend between many runs.
- Run titles: the live fast-model call (haiku on Anthropic, a LiteLLM fast model through completionEnv, Codex with a run connection) has no smoke test. Only unit tests on the mock and fakes cover it. Every work run spends one small fast-model completion. On the Anthropic connection with a project API key whose env var is not literally ANTHROPIC_API_KEY, the title call does not get the key (completionEnv has no project, unlike buildEnv), so that project's runs go untitled. A Codex connection without a fast tier titles with the Codex default model.
- Concurrent Codex runs share one CODEX_HOME at <data>/codex (src/main/connections/service.ts). Whether two app-servers race on auth refresh or the session database is unverified.
- The windows run with `sandbox: false` because the preload is ESM (out/preload/index.mjs) and Electron cannot sandbox an ESM preload. The fix is building the preload as CommonJS and enabling the sandbox.
- No e2e test covers the packaged app.
- Agent import: every format parser is verified only against hand-written fixtures built from the docs (late 2026), not against files the other harnesses wrote; Copilot, Gemini, Kiro and Roo are best-effort. The heuristic tiers for OpenAI and Gemini ids follow naming, not a published contract. Scans run synchronously in the main process (projects:checkPath runs one on every path check), bounded by the caps; the renderer should debounce checkPath. A preview shows a 600-character excerpt plus promptLength; the UI must let the user read the whole prompt before applying. ProjectCreateInput.importAgents applies without a preview, so the New project form must make the choice explicit. The renderer calls it from the New project form, `components/import/ImportAgentsDialog.tsx`, `views/OrgChartView.tsx` (Import agents, Export to repo, notices) and the store (`importRequest`, `importNotices`, `undoImport`); pure logic is `lib/agentImport.ts`.

_Maintained by OrgAI. Approved by the project owner during setup._
