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
- Native text context menu (`src/main/textContextMenu.ts` pure `buildTextContextMenu`, wired in `createWindow` in `index.ts`, so main and run windows all get it): editable field gives Cut / Copy / Paste / Select all (enabled from `editFlags`, Electron roles, no clipboard code); a non-blank selection outside a field gives Copy; an http(s) `linkURL` gives "Copy link address" (`clipboard.writeText`); every other scheme and everything else returns null (no menu, nothing else: no Inspect, no Open link, since navigation stays under `shouldBlockNavigation`). Spellcheck is not enabled, so no suggestions. The popup is skipped when the window is destroyed and wrapped in try/catch. Checked by `textContextMenu.test.ts` (every branch) and typecheck/build. UNVERIFIED: that a renderer `preventDefault()` on the DOM `contextmenu` event suppresses `context-menu` (this is how Electron documents the event, not confirmed here), and the native popup itself (the e2e harness cannot drive a native menu; never seen on screen).
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
    `endedWhile` says what it was doing: 'waiting' (a decision card was open or the plan was blocked, whatever the status), 'idle' (status idle, no open decision: the turn ended and it only awaits a reply; never "waiting on you"), 'working' (starting, running, stopping),
    absent for a paused run (`quitEndedWhile` in runManager.ts; boot normalization keeps a stored 'waiting' or 'idle'
    and maps a crashed 'idle' row to 'idle'). Checked by fake-adapter unit tests in `runManager.test.ts`, `runs.test.ts`
    and `bootstrap.test.ts`; no live app run. The terminal `run.status` event ('finished' / 'error', including the quit write-out's
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
  adds the files clause: `true` "pass the files you read as files" from codex.ts and mock `rolePromptFor`, `'brief'`
  "end it with a line "Files: <path>, <path>" naming files you read" from claude.ts `buildAgents`, +32 characters; each
  only when `contextPackRefusal` is undefined); "keep a piece yourself" only with `workBesideReports` (default
  `!spawnCallFields`; Claude's `buildAgents` passes true since 2026-11-10, and with it the root's `spawnCallText` adds
  "run_in_background: true while you keep a piece" (+48, or "..., else true while you keep a piece" beside the
  foreground field, +34) when a listed report is not marked foreground; never for a mid-level lead, a bridged child
  root, quick or single runs); the integrated result is checked once; writing leaf reports of team work runs get
  `REPORT_CHECKS_TEXT`. The Claude root grew 233 characters (`scripts/measure-prompt-size.mjs`, iso+arch 10,857 to
  11,090), the Codex root 35.
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
  Cost line (2026-11-10, split-execution 3.5): `rootStaffingBrief` appends `staffingCostLine(profile)` (what a report
  costs here and the piece size worth handing out; medians from `profileTiming` once 3 runs carry them, else 30 s / 20 s)
  when the root has reports (a role with `reportsTo` set). It now goes out with an empty or missing profile (the history
  line still needs one) and never on a `bridgedChild`. Unit tests only (staffingProfile, codex); no lab run.
- Context pack on spawn (2026-11-10, split-execution 3.2; `runtime/contextPack.ts`): Codex `spawn_report` and the mock
  spawn step take `files` (files inside the folders this run may read; the harness does not check that the lead read
  them). At spawn time the host reads them and appends them to the report's first message under
  `CONTEXT_PACK_HEADING`, one fence per file with its path (the transcript keeps the brief only). Limits: the first 8
  entries (the Codex schema says `maxItems: 8`; extra entries from other callers collapse into one "and N more" line),
  24,000 characters per file, 60,000 in total, UTF-8 text with no NUL byte. Checks per file: not a network path
  (`isNetworkPath`); the path as written (absolute, lexically normalized) inside a folder before any file system call,
  so an outside path reads "outside" whether it exists or not (a missing file behind a linked folder that leads outside
  too: no existence oracle); `checkSelfControlDenial('Read', ...)` on the path as written and on its real path
  (unavailable protected paths refuse every file); the real path (`realpathSync.native`) inside the project folder, the
  lead's or the report's working folder, or the run's allowed or reference folders (`contextPackRoots`,
  `isInsideEither`). Then one open (`O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY`, each flag where defined, so a FIFO
  never blocks the main process; on macOS `O_NOFOLLOW_ANY` 0x20000000 in place of `O_NOFOLLOW`, defined in
  `contextPackOpenFlags` since Node lacks it: a link in any component of the checked real path refuses the open; the
  two together give EINVAL and `O_NOFOLLOW_ANY` alone refuses a final link with ELOOP, both checked with node on
  darwin 25), on Linux `/proc/self/fd/<fd>` read back equal to the real path (`handlePointsAt`, an unreadable /proc
  fails closed; unit-tested with a mocked readlink only, no Linux run), `fstat` of the handle a regular file within the
  cap, `realpath` again equal to the checked real path, `stat` of that path the same dev and ino as the handle (bigint
  stats), the handle's dev and ino not a protected file (`protectedFileKeys`), and only then a bounded read from the
  handle, always closed. Protected set (third pass, 2026-11-10): the SHALLOW set (each protected path, the data
  folder's entries the gate protects by name prefix, `vault.json*` / `secrets.json*` from `vaultPrefixProtections`, so
  `.reset-*`, `.corrupt-*`, `.tmp` hard links count, and the TOP LEVEL of each protected folder, e.g. `codex/auth.json`;
  each folder listed once whatever its spellings; bound 20,000 entries) is collected once per pack build before the
  first file and checked for every file. With the handle's path pinned (macOS `O_NOFOLLOW_ANY`, Linux /proc) the gate on
  the real path covers every path into a protected folder, so the DEEP walk (every file below them, bound 200,000) runs
  only when the handle has more than one link, once per build. Without pinning (Windows) the deep set is checked for
  every file and walked once per run (`deepCache`, kept by the Codex and mock sessions). Past a bound every file gets the
  neutral "OrgAI could not check it against its control files". The second pass walked everything for every pack with
  a 5,000 bound: `<data>/codex` (a session file per Codex thread, 8,802 entries on the reviewer's machine) turned the
  pack off on both adapters; a unit test now has 6,000 entries below `codex/` and an ordinary file still inlined. A swap between the checks and the open (a link to an outside or control
  file, a linked parent folder, a parent that is a link at the open, a folder at the re-resolve and a link at the stat,
  a control file renamed in, a FIFO) is skipped as "unreadable", "not a file" or as a control file (2026-11-10 second
  security pass; the three-moment parent swap is a unit test that inlines `<data>/codex/auth.json` with neither fix
  and is refused with either one alone, checked on macOS; Windows has only the dev/ino checks, not run there). The
  `File:` line drops control, U+0085, U+2028, U+2029 and bidi characters, and inlined text gets a zero-width space after
  each `</` before a letter, white space between allowed (the heading says so), so no file line can close a wrapper tag
  of the hook context.
  Trust-restricted and setup-like runs get none (`contextPackRefusal`). Every
  file left out is named with its reason in the tool result (`contextPackResultLine`). A bridged report gets no pack
  (the result says so); `delegate_agent` takes no `files`. Without `files` nothing changes. spawn_report's definition
  grew 126 chars, then the security pass's `maxItems` and wording (Codex team-root budget 20,050 unchanged,
  `toolDefinitionSize.test.ts`). Claude (2026-11-10): the Agent tool is
  the SDK's own and a rewrite of a well-formed spawn costs a classifier request, so the lead ends the brief with a
  `Files: a, b` line (`briefFiles`: the last non-empty line, label in any case, comma separated, quotes and backticks
  dropped; a path cannot hold a comma; since the second pass the line must be the very last one, not inside a code
  fence left open above it (``` and ~~~ are separate fences, CommonMark closing rules) and not continuing a block
  quote; no prompt change). The spawn hook reads it at PreToolUse
  after every denial (call unchanged; the line stays in the brief), relative paths resolved lexically from the hook's
  cwd, which is never a root: roots = project, the caller's checkout as the harness tracks it (`agentCwd`: the report's
  worktree is cut from it), allowed and reference folders. Since the third pass Claude reads NO file at spawn: the pack
  is built from the TEXT the spawning agent's own complete Reads returned (`buildContextPackFromTexts`,
  `ReadTextStore`). At each `Read` PostToolUse the session keeps `tool_response.file.content` when the response shows
  the whole file (`completeReadText`: `type: 'text'`, `startLine` 1, `numLines` equal to `totalLines`, no
  `truncatedByTokenCap`), keyed by the path as written resolved lexically against the hook's cwd and by its real path
  at that moment; only texts within 24,000 characters, at most 100 entries and 1,500,000 characters per agent and 200
  agents, oldest dropped; an agent's store is dropped when it ends (SubagentStop, its notification, a harness stop).
  Checks per named file: a path, not a network path, protected paths available, the path as written and the recorded
  real path lexically inside the roots, `checkSelfControlDenial` on both, a kept complete Read (else "not read in full by
  you in this run"), not listed twice; then the same caps, block cap, shown path and `</` neutralisation. So a link
  flipped after the CLI's own Read deny/ask check, a file changed after the Read and Windows (no handle pinning) cannot
  put in text the lead's Read did not return; the CLI enforces `.claude/settings.json` and managed-policy Read deny/ask
  rules the harness does not see, and a Read they stopped never reaches PostToolUse (from the hooks docs and sdk.d.ts,
  where failures and denials have their own events, not checked live). Response shape: from `sdk-tools.d.ts`
  `FileReadOutput` and the SDK 0.3.318 CLI bundle (`strings` on the darwin-arm64 binary): `content` is the file's raw
  text (CRLF read as LF, a BOM dropped); the `cat -n` style line numbers are added only when the result is rendered for
  the model (`U6e`), so the hook sees raw text; the PostToolUse `tool_response` is the tool's output object (as the Agent
  call's `async_launched` object in check 12). Not checked live for Read. A target role without the Read tool gets no
  pack. Plus `blockMaxChars` =
  `CLAUDE_HOOK_CONTEXT_INLINE_MAX` (10,000: the CLI keeps hook context inline only up to that, above it the model gets a
  2,000-character preview and a file path; read from the SDK 0.3.318 CLI bundle, `bve`/`kHe=1e4`, not checked live).
  The block goes out as the report's `SubagentStart` `additionalContext` (sdk-facts check 13). The start is linked to
  its spawn by task_started (agent id -> Agent `tool_use_id`, exact for parallel spawns of one role); stream messages
  and hooks reach the session unordered, so the hook waits up to `SPAWN_LINK_WAIT_MS` (2 s) for the link, only while a
  pack for that role is pending. The lead reads `contextPackResultLine` in the Agent call's `PostToolUse` additional
  context (beside a receipt or staffing note): at launch for a background spawn, with the report for a foreground one
  (late, but it still says which files the report had to read itself); a pack that never reached a start is listed as
  not inlined. A refused spawn (`is_error` result) drops its pack. Unit tests only (contextPack with swap tests through
  wrapped `openSync`, `realpathSync.native`, `statSync` and `readlinkSync`, POSIX only for links and FIFOs;
  codexContextPack, mockContextPack, claudeSplit); no live run, `reportStartMs` not measured yet.
- One report and a waiting lead (2026-11-10, split-execution 3.6; `runtime/waitingNote.ts`, pure `waitingNote`): after
  a successful spawn by the run's root (not a bridged child's root) that leaves exactly one of the root's reports
  running, for a role that is not one of the root's required reports (`obligationsFor`), with an active plan that has a
  ready step (`readySteps`) and no `in_progress` step without a running report bound to it (staffing rows), the spawn
  result gets `WAITING_NOTE`. Never a refusal, at most once per run, never on setup-like, Chat (quick) or single runs.
  The ready-step condition is an addition to the spec: with nothing ready, waiting is all the lead can do. Codex
  (`afterSpawn` on the NetworkHost, also on a bridged spawn_report) and the mock (a harness system row on the parent and
  `spawnNotes`). Claude (2026-11-10, `claude.ts` `waitingNoteFor`): the Agent call's `PostToolUse` additional context,
  only on a background launch (`async_launched`, sdk-facts check 14): a foreground spawn's PostToolUse fires when the
  report is back, when the note is pointless. The new report counts as running and bound to its plan step even before
  its task_started or staffing row is handled. Unit tests only (waitingNote, codexContextPack, mockContextPack,
  claudeSplit).
- Background reports on Claude (2026-11-10, split-execution 3.3; `claude.ts`, unit tests `claudeSplit.test.ts`): on SDK
  0.3.318 the Agent tool's `run_in_background` defaults to true (sdk.d.ts; sdk-facts "Subagents run in the background by
  default"), and the spawn hook forces `false` only on a receipt-bearing spawn (`receiptBearingSpawn`: one of the
  caller's required reports, or a role with required reports of its own), because its receipt rides the completed
  Agent call's PostToolUse. Those are the reports `spawnCallParts` marks "foreground". Any other spawn keeps what the
  model wrote. The session tracks a background report from its `async_launched` PostToolUse (agent id from task_started,
  else the result's `agentId`) in `backgroundReports`: its row, step binding, worktree tracking and integration
  (`SubagentStop`), report text (the SubagentHandback PostToolUse, else `handback_report.text` of its notification) work
  as for a foreground report. A `task_notification` ends a report only under its own Agent `tool_use_id` (a worker's
  own Bash notifies under its Bash call); it marks the ledger receipt delivered (`DelegationGate.delivered`). While a
  background report is live the root is idle ("Waiting on reports…"), `liveReports` counts it (no continue nudge; the
  ready nudge may fire, D7; no MCP restart), and `settlement().quiescent` is false (a bridged child or an exec run
  cannot end); after it ends with the root idle, quiescent stays false until the CLI resumes the root (its next init),
  at most `BACKGROUND_HANDBACK_WAIT_MS` (30 s). `complete_plan` is not refused while a background report runs (as on
  Codex); the exec outcome still waits for working reports. Interrupt: like an interrupted Codex thread, each live
  background report is settled at once (done, "Interrupted", ledger `ended`, staffing row closed, not integrated) and
  `stopTask` is sent; OrgAI does not declare `perTaskStopAffordance`, so per sdk.d.ts the CLI's interrupt kills
  background tasks anyway (not checked live). A later SubagentStop, handback or notification of a stopped report
  changes nothing, and PreToolUse denies every tool call of a stopped report (`STOPPED_REPORT_DENIAL`, its hand-back
  included) so it cannot keep acting while shown as stopped; a SendMessage resume (task_started for a known agent) makes
  it live again. A report stopped before its first task_started was handled (named by the launch result, or drawn by
  SubagentStart) is kept in `stoppedBeforeStart`: the late task_started records it settled (ledger noteSpawn then
  `ended`, staffing book ended), never live. A task_notification also ends an activation under any id the agent was
  spawned or resumed under (its Agent call, a resume's task_started id, a SendMessage addressed to it,
  `reportEndIds`), so a resumed report that notifies under the SendMessage call keeps its text (that shape is not seen
  live; handled in case). `toolUseByTask` keeps the newest 1,000 links. Session end settles them ("Stopped: the session ended").
  Not checked live: an interrupt or a killed task after which the CLI still resumes the root by itself; the stop
  reaching a report that is mid-tool; a lab run. The second-pass items are unit tests in `claudeSplit.test.ts` only.
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
- Sidebar plan meter stability (2026-11-12): every Claude `usage.status` goes through `UsageMonitor.gate()` in
  `bootstrap.ts` `emitRun` (late-bound `usageGate`), which runs `reconcileUsage(prev, next)` (`runtime/usage.ts`, pure):
  inside one window period (reset times within 2 min) utilization never drops, a later reset is a new period (may drop),
  an earlier one is stale, prev-only windows live until their reset, request state follows the newer `updatedAt`, a limit
  clears after `limitedUntil`, apiKey reports pass through, idempotent. An unchanged status is not rebroadcast within 60 s.
  While a run is live `start()` also ticks a 60 s timer that runs only the keyed `'proxies'` probe (gate: `liveRuns() > 0`,
  not per proxy connection; shares `runExtra`'s one-in-flight; CLI host has `usageMonitor: false`, so no timer there).
  Checked by `usageReconcile.test.ts` and `usageMonitor.test.ts` (fake timers, fake adapters). Live Claude/proxy
  behaviour is unverified; the renderer's `putUsage` still replaces wholesale but now only sees reconciled values.
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
  gate, role lookup and restart sees it; review M1).
  - Org changes in the same run (owner request 2026-11-18; ARCHITECTURE.md "Org changes in the same run"): on a team
    work run whose session sets `RuntimeSession.liveRoster` (`runRoster.ts` `liveRosterApplies`), an approved
    propose_org_change also changes `ctx.roles` in place, on the DESKTOP host only (fourth review, owner decision:
    `RunManagerOptions.liveRosterCards`, set by bootstrap.ts with `desktop`, checked inside `liveRosterApplies`; the CLI
    / TUI / exec host keeps the pre-feature behaviour, runManagerRoster.test.ts "fourth review"), under one invariant
    (third review): RunManager sets
    `OrgChartProposalPayload.runBaseline` (the run's roles plus waiting ones, `runBaselineOf`; an incoming value is
    dropped, never saved), the card diffs against it, and a field moves only if the card differs from the baseline
    for that role (model / tier where changed: the save's resolved value). A running role whose baseline differs from
    it is deferred `stale`; a new role keeps the card's id and slug or is deferred `identity` (M1); a card role the save
    holds under another identity is deferred `unmatched` (L3); a partial application that cuts a role off from the
    root defers it `reporting` (L1); a waiting role joins with only the view's grants (L2). Parallel cards (fourth
    review): a running role absent from a card's baseline is never removed by it (`stale`, M2); a waiting role whose
    baseline entry differs from its current view entry is deferred `stale` and keeps the current entry (M3,
    `currentView`); a card never changes a running role's slug (`identity`, L4). Pure tests in runRoster.test.ts. Checked by
    runRoster.test.ts and runManagerRoster.test.ts "third review" (both regression tests fail without runBaseline).
    Changed roles keep object, id and grants; removed roles go to
    `ctx.retiredRoles()`; the root keeps model / tier / effort / connection / canSpawn). Roles on another placement,
    with an unpriced model under a budget, under a required-delegation obligation, under a different root, or new
    with the slug of a role removed earlier in the run or in the same change are deferred (`RunRosterChange.deferred`;
    a root canSpawn change is deferred alone). Security review fixes (2026-11-18): H1 `ctx.project.roles` is rebuilt
    from `ctx.roles` after every applied chart so a same-save team-file pull never rides on a later card, and a
    deferred new role is shown there as its card made it (`applied.pending`); second route (a deferred role's file
    rewritten and ingested before a later card clears the deferral) closed by `joiningRole`, checked by
    runManagerRoster.test.ts for a price and a placement deferral (both fail with the old code); bridge.ts resolves a
    caller through `retiredRoles()` and refuses an unresolvable named caller instead of using the root's rights; M1
    `RuntimeSession.rosterApplied` is called synchronously right after the move (throw caught and logged); M2 slug
    reuse deferred; L1 `RunStore.getRecord` cleans `roster` (`cleanRunRoster`, runsRoster.test.ts). RunManager
    records `RunRecord.roster`, emits host-only `run.roster`, returns
    `ProposalOutcome.roster`; the tool calls `configChanged({ roles })` and says now / after idle / next run. Without
    `liveRoster` nothing changes: the chart applies from the next run (Claude, Codex and the mock all set it on team
    work runs, see below). Unit-tested only (runRoster.test.ts, runManagerRoster.test.ts,
    harnessToolsOrgChange.test.ts); the renderer side is in renderer.md "Mid-run roster".
    - Claude (2026-11-18): `ClaudeSession.liveRoster` is true on team work runs (not setup-like, quick, single or a
      bridged child; `configChanged({ roles })` throws there). Agent definitions are fixed per query, so a roles change
      joins the existing config restart at idle (`pendingConfig.roles`, coalesced with pending MCP / skill changes, the
      configGen guard keeps a change approved while the restart is built pending for the next one): definitions are
      rebuilt from the live `ctx.roles` (none for removed roles, the root's prompt and tools and `Options.agent` from the
      live root), then the config notice says "The approved org chart is in place..." naming the added / changed
      reports, a changed root and the removed roles. Answer: 'after-idle' when a role was added or changed (the root
      included), 'now' for a pure removal (the restart still follows to drop the definitions and refresh the root's
      prompt). Spawn gate, before any allow path: a removed role is refused at once with its own reason; an added or
      changed role whose definition the running query lacks (`rosterStale`, cleared when a query built at or after its
      generation starts) is refused with "once the agents are idle and the session restarts"; unknown roles get the
      chart refusal as before. A root call to a tool the change took off the root is refused until the restart. Role
      lookups read `ctx.roles` live (no start-time slug map; renamed / removed roles of running agents resolve through a
      slug history and `ctx.retiredRoles()`); obligations and the automatic subagent depth stay as the session started;
      staffing still goes only through `resolveStaffing`; new roles have no grants and the MCP / Skill gates read
      grants live. Checked by `claudeRoster.test.ts` (fake query, real `applyRosterChange`: add, change, rename, root,
      pure and tidy removal, running report of a removed role, MCP coalescing, change during the build, depth, notice
      text). Live Claude behaviour is unverified, notably whether a resumed session accepts a renamed root agent
      (`Options.agent` with a new slug) and how the CLI treats a spawn of an agent type it has no definition for (the
      gate refuses those before the CLI sees them). Review fixes (same day): `rosterApplied` (called by RunManager in
      the tick `ctx.roles` moves) does the stale marking, so the gate refuses added / changed roles even when
      `configChanged` never runs or throws; `callerRole` (and the spawn gate's parent) prefers the recorded agent's
      retired role, so an agent of a removed role is never judged on a new role that reuses its slug (claudeRoster.test.ts).
    - Mock (2026-11-18): `MockSession.liveRoster` is true and `configChanged({ roles })` answers 'now' (recorded in
      `configChanges`, harness tools re-bound). Every role lookup reads `ctx.roles` at call time (the start-time
      `rolesBySlug` map is gone); a spawn of a role not in `ctx.roles` is refused with a tool error (removed: names the
      role from `ctx.retiredRoles()`; unknown: "There is no role ..."), and an agent already running on a removed role
      finishes under its old name. Marker `[mock:org-change]` (`ORG_CHANGE_TOKEN`, team work runs, default script):
      propose_org_change (the mock still sends the whole chart by slug; the tool itself now takes only changed or added
      roles, keeps the rest and drops a role only through `remove`, 2026-11-18 fix, checked by
      `harnessToolsOrgChange.test.ts`; live model behavior unverified) plus "Roster Tester" (slug roster-tester, under the root, Read and
      Grep) and the root's spawnable extended, title "Add a Roster Tester"; approved, `MOCK_ROSTER_REPORT` runs on the new
      role and finishes, then the root says "Org change approved. <tool result>"; declined or revise says "The org chart
      stays as it is."; without the tool a warning and "Org change is not available in this run.". Unit-tested
      (mockOrgChange.test.ts, including one run through the real RunManager with the mock adapter).
    - Codex (2026-11-18): `CodexSession.liveRoster` is true. spawn_report already reads the live roster
      (`CodexAgentNetwork` holds `ctx.roles` itself and the root's object), so the next spawn uses it and a removed or
      unknown role is refused at once. The root thread's developer instructions (prompt, reports list, tool notes) are
      compared with what Codex last received (`sentInstructions`): equal answers 'now'; different answers 'after-idle'
      and sets `rosterRestartPending`, which shares the MCP restart at idle (`maybeRestartForMcp`, one restart and one
      harness message for both; a change landing during a restart restarts again or is told at once if the resumed
      root already has it). Threads that existed when their role was changed or removed are pinned: a restart resumes
      them with their start-time role snapshot and the exact instructions they were given; the snapshot's grants
      (`mcpServers` / `skills`) always come from the live role, absent included, so a pin never undoes an ungrant. A
      change of the root's own tool list (canSpawn flipped) throws (Codex fixes a thread's dynamic tools at
      thread/start); RunManager never moves the root's canSpawn mid-run, so this path is defensive only. Fake app-server tests (codexRoster.test.ts). Live Codex is
      unverified: that thread/resume applies new developerInstructions (the MCP restart assumes the same), and that a
      new role's own model gets the native-agents catalog override before the next app-server restart.
  - Host changes in a live run (owner request 2026-11-19; ARCHITECTURE.md Conventions "Host changes in a live run";
    desktop only): desktop saves (projects:save roles and role grants, mcp:upsert / remove / linkLibrary /
    setProjectOverrides, skills:create / update / remove / linkLibrary) and approved MCP / skill / org chart cards of
    another session of the same project reach every other live team work run through
    `RunManager.applyProjectChange` (`runtime/hostChange.ts`; handlers in `host/dispatcher.ts`, `liveRunsOf`, only for
    `ctx.surface === 'desktop'`; `RunManagerOptions.liveHostChanges` set by bootstrap.ts with `desktop`). Each run's
    `ActiveRun.hostApply` reuses `setLive` (new settle 'grants') and `applyRosterChange` with the run's own baseline;
    the handler reads the stored project before the save (a structuredClone copy, every handler), so a team-file ingest
    of the same save does not ride along on roles and grants (`runManagerHostChange.test.ts` "INVARIANT", which fails if
    the diff reads the saved roles). For a named server / skill without a `fields` limit (mcp:upsert, skills:update with
    a draft, card fan-out) a same-save ingest change of that item can come along; the team-files gate applies only
    narrowings (removal, turn-off, fewer roles) automatically, so that can only take away (re-review L-c, accepted).
    Review fixes (2026-11-19):
    - M1: MCP and skill changes no longer overlay the whole stored item and its stored grants (`overlayOwnItems` is the
      card route only). `hostChange.ts` `itemEditOf` moves only fields of the named items that differ between `before`
      and saved, limited to `HostItemChange.fields`; `itemGrantEditsOf` moves only grant pairs the input carried (skills
      `roleIds`; mcp:* name none, so the run's grants stay; a removed item's grants leave). Tests "M1: mcp:upsert ...",
      "M1: mcp:setProjectOverrides ...", "M1: skills:update ..." (each fails on the old overlay).
    - M2 / L5 / L6: narrowing (removed, turned off, smaller MCP `roles`, ungrants) moves first whatever the session can
      do; widening only with `hostConfigChanged`, and a rejection puts it back (narrowing kept; org chart roster moves
      stay). Without the method: "This run's session cannot take changes while it is live."; session not open yet: "The
      run is still starting."; both say what applies now. Tests "M2: a rejection puts back ...", "M2: a rejection of a
      change that only takes away ...", "L5: ...", "L6: ...".
    - L7: `LIVE_RUN_CHANGE_WAIT_MS` is 2 s (was 10 s): the mcp:* / skills:* / projects:save IPC reply waits at most that
      long (runs are asked in parallel), then the run answers 'pending', nothing is put back, and the run log says "OrgAI
      is still applying it to this run" and later when it is in place. `RunManagerOptions.liveHostChangeWaitMs` lets
      tests shorten it, so the 'pending' test ("M2 / L7: ...") is real, not skipped.
    - L1: skills:create names the skill by draft name and linkLibrary by library id, both new since `before`. L2: the
      label is stripped of control / format characters before the log. L3: `ConfigChange.mcp.upserted` names only
      servers redefined, turned off, added or granted; an ungrant-only change sends empty lists (Claude re-reads
      `ctx.roles` with no restart; Codex restarts at idle). L4: `storedProjectFor` returns a copy.
    - Re-review (reviewer recheck, pass with fixes, no Critical / High): L-a the undo is field by field (an added item
      leaves by id; a redefined field goes back only while it still holds the value put in), test "re-review L-a"; L-b
      only grants that can apply count as widening, skipped ones say "from the next run", test "re-review L-b"; L-d a
      rejection answers 'next-run' only when something was put back; L-e the copy says "already out of this run's
      configuration" (Codex has no live MCP gate; an attached server may run until its restart). L-f and the grant
      undo Low were fixed in the follow-up below.
    - Follow-up (2026-11-19, UX review H3 / M1 and the open Lows):
      - `run.liveChange` (src/shared/types.ts RunEvent, `LiveChangeWhat`): RunManager broadcasts `{ runId, projectId,
        source, what, change }` once per run per answer, with the log line (`publish` in hostApply; `publishLiveChange`
        for the still-starting and could-not-apply answers); 'pending' is followed by a second event with the final
        availability. Not recorded in the run record (the renderer needs it live only), never sent to adapters (an
        adapter's is dropped in `emit`), CLI host emits nothing (applyProjectChange returns first). Lists capped at 50,
        names cut by logText. `LiveRunChange.notes` (rename notes) and `LiveRunChange.grants` (role and item display names,
        `granted` false = "no longer uses") are new optional fields. `what` per route (the renderer reads exactly
        `what.includes('orgChart')` as the org chart surface): projects:save always ['orgChart'] plus 'grants' when it named
        grants (a role-inspector ungrant is ['orgChart', 'grants']; the could-not-apply / still-starting answers use
        ['orgChart', 'grants']); another session's org chart card ['orgChart']; mcp:* and MCP cards 'mcpServers' and / or
        'grants', skills:* and skill cards 'skills' and / or 'grants', never 'orgChart'. Tests "follow-up item 1".
      - Rename: `hostChange.ts` `keepRunSlugs` takes every slug change of a role in `ctx.roles` out of a host edit (the
        save still stores the new slug; save path unchanged). Name and the other fields apply; the answer has a note
        "Renamed to <new>. This run keeps calling it <old slug> until the next run." (slug-only: 'next-run' with "This run
        keeps calling it <old slug> until the next run."). Later saves diff against `before` (the stored new slug on both
        sides) and the run's baseline (old slug), so no phantom slug edit; a new role with the kept slug is deferred
        `slugTaken`. The run's own propose_org_change still defers a running role's slug change (`slugChange`). Slug-keyed
        MCP grants (`McpServerSpec.roles`) are read through `mcpRolesForRun` against the run's RUNNING roles (`ctx.roles`)
        on the mcp:* / MCP card route and on the run's own MCP card and install (see the review fixes below), mapping by
        role id, so a remap to the new slug changes nothing for the run. ROSTER_REASONS were rewritten for users (they are on screen).
        Tests "follow-up item 2" (incl. the team-file pull INVARIANT and the MCP slug case with mcpServersForRole /
        mcpCallDenial) and hostChange.test.ts.
      - 3a: hostApply calls `hostConfigChanged` synchronously inside a try that puts the widening part back on any throw
        before the answer starts, then rethrows (applyProjectChange: 'next-run', "OrgAI could not apply it to this run.",
        and now a run log line). 3b (L-f): `itemEditOf` `linkOwn` skips library-sourced fields of an item linked to the
        same entry before and after unless the input named them. 3c: setLive records which calls hold each grant pair
        (`grantOwners`, a set per pair since review L2 below); a rejected host change's undo puts back only pairs no other
        change holds. Tests "follow-up item 3".
      - Review fixes (2026-11-19, reviewer on the rename / run.liveChange follow-up), tests in `runManagerHostChange.test.ts`
        describe "rename follow-up review" unless named; each failed on the code before the fix (checked by running the new
        test file against the parent commit 101edf22):
        - H1: `mcpRolesForRun(items, stored, running)` takes the run's running roles only (hostApply passed the view's
          waiting roles too, so a waiting role under a slug a running role kept mapped to that slug text and the running
          role gained its grant). Rule: a slug naming a stored role that is running maps to that role's run slug (by id); a
          slug naming a stored role that is not running is dropped when a running role holds that slug text, else kept; a
          slug no stored role has was kept (third review N1 changed that: kept only while no running role holds the text). A waiting role's slug grant therefore reaches no running role; it is remembered under its slug only when
          no running role holds that slug, and applies if the role joins under it (a role whose slug a running role holds
          cannot join this run: slugTaken, retired slugs). Tests "H1: mcp:upsert ..." and "H1: ... (fan-out)", plus
          hostChange.test.ts "H1: a waiting role's slug grant ...".
        - M1: the run's own approved MCP card and request_mcp_install (setLive 'mcpServers' with own items) read
          `saved.mcpServers` through `mcpRolesForRun(saved.mcpServers, saved.roles, ctx.roles)` before `overlayOwnItems`
          (work runs of a stored project only; setup-like and assistant runs' roles are not the project's). Slug-keyed
          roles are read from the saved project into a live run only there and on the host route; skills grants are
          Role.skills by id, org chart cards never move grants. Tests "M1 / a: ..." (both directions, and the install).
        - a: role slugs the run's agents wrote are mapped through the run's role id to the stored role (`hostChange.ts`
          `slugsForStore`). Superseded for MCP and skill cards by the third review's N2 (below): they are mapped when the
          card is CREATED, so the card the user sees already carries the stored slugs. An install's `spec.roles` saved to the
          project is still mapped at approval (`settleInstall`; a run-scope install keeps the run's slugs; the install card
          shows no roles). A slug both a running and a waiting role hold means the running role. Tests "M1 / a: ...", "a:
          the run's own skill card ...".
        - b: the run's own org chart card goes to SetupService through `cardRolesForStore`: a card role that is a running
          role still under the slug the run has (matched by id when the card kept ids, else by slug) takes the stored slug,
          and the stored name when the card left the name as its runBaseline (else the run's roles) had it. Without it
          orgMerge (match by slug, then name) matched the card's role to the stored role now holding the old slug (r-new),
          or, on a host without live changes, added it as a new role and removed the renamed one. A slug or name the card
          itself changed is kept; only slug and name are merged this way (other fields the run deferred are still the
          card's). The run applies the card as shown; the fan-out to other runs uses the card as shown (it is diffed
          against its runBaseline). Tests "b: ..." (live host and CLI host) and hostChange.test.ts cardRolesForStore.
        - L1: hostApply's `publish` broadcasts nothing once the run ended or is ending (`this.runs.get(id) !== active`,
          outcome, finalizing, userStopped); the answer is still returned and logged. Test "L1: ...".
        - L2: `grantOwners` holds a set of claims per pair; a change claims every granted pair it names, also one already
          held (`claimHeld`; a pair held with no claim on record counts as held from the run's start), and its undo
          releases its claim and puts back only pairs nobody else holds. Test "L2: ...", and "3c" still passes.
        - L3: a rejection's `LiveRunChange.reason` (broadcast) is the fixed "The session could not take it." plus the fixed
          rest; the adapter's error text is only in the run log line. Tests "M2: a rejection ..." and "a rejection reports
          next run ...".
        - L4: mcp:upsert `fields` (`hostChange.ts` `upsertFieldsOf`, dispatcher.ts): for a server linked to a library entry
          before and after, library-sourced keys (not MCP_LINK_OWN) the input left out or set to the entry's value are not
          in `fields`, so itemEditOf does not compare them. Tests dispatcherLiveChanges.test.ts "review L4: ..." and
          hostChange.test.ts upsertFieldsOf.
        - Role inspector rename (renderer `lib/roleOps.ts` `renamePatch`, Team tab phase 1): one patch sets name and slug
          and grants by id (Role.mcpServers) every server the role held by its old slug; McpServerSpec.roles keeps the old
          slug. On the host route that is a rename (slug kept, note) plus a widening id grant of a server the role already
          uses. Changed by the third review (below): the run's copy drops the old slug text at the rename (the role keeps the
          server by id), and a desktop projects:save no longer leaves the old slug in the stored list. Test "the role
          inspector's rename shape ...".
        Unverified: the renderer side, live providers.
      - Third review (2026-11-19, two Highs from one root: a run keeps an old slug while the store uses a new one, and
        `McpServerSpec.roles` grants by slug TEXT, `mcpServersForRole` in `src/shared/defaults.ts`). THE SLUG INVARIANT:
        inside a live run a slug text in the run's server list means exactly one running role, the one it named BY ID when
        the text entered the run; no slug text the run did not map by id grants anything to a running role; what an MCP or
        skill card shows the user is what the save grants; a reported "no longer uses" is true at the gates. Enforced by:
        - `mcpRolesForRun` (every saved list entering the run: the mcp:* / MCP card host route on both sides of the diff, the
          run's own MCP card and project-scope install): a stored slug maps by id to the run slug of EVERY running role
          holding it in the store (duplicates included: projects:save does not refuse duplicate slugs); any other text (a
          stored role that is not running, or no stored role, e.g. an old slug a rename left) is carried only while no
          running role holds that text. So a kept old slug, a stale write of it (a renderer copy from before the rename) or
          another session's card saving it never reaches the renamed running role.
        - `staleSlugTexts` via hostApply `reconcileSlugTexts`: when a projects:save or org chart card renames a running
          role (`keepRunSlugs` kept), and whenever an ungrant of a (role, server) pair applies (projects:save role grants or
          an item route), a run slug text the saved server no longer backs for that role (its `roles` neither undefined nor
          listing the role's SAVED slug) leaves the run's copy: as an id grant when the saved role holds the server by id
          (the role inspector's renamePatch shape, and every desktop save now: below), else the role loses it and the
          answer reports it (`granted: false`). Never widens, so it applies whatever the session can take and is never
          undone by a rejection. Decision: a rename whose saved project drops the role's access (a save through
          `store.save` or data stored before `renamedSlugGrants` that leaves the old slug and grants no id; orgMerge never
          changes a stored slug, so an org chart card cannot rename) takes it away in the run too, like the next run;
          before, the run kept it by the old text. Two running roles sharing the dropped text (duplicates stored before the
          run) are each converted or reported lost, never silently (review Low 1).
        - Review M-2: a rename patch's copied id grants (renamePatch copies every server that listed the old stored slug)
          for a server the run does not give that role are not applied in the run ("A rename carried over a connection
          this run had not taken; it applies from the next run."): the run never took that slug grant (a pull, a change
          answered next-run, an in-between slug typed through another role's slug).
        - Review M-1: roles the USER set on an install card (`settleInstall`, `raw.spec.roles` through mergeInstallEdit)
          are stored slugs: saved as given for project / library scope, and for run scope mapped by id into the run's list
          (`mcpRolesForRun`); only roles the agent's request carried are run slugs mapped with `slugsForStore`.
        - A role JOINING the run (setLive 'orgChart', both host and card routes) keeps a slug text of the run's list only
          where the saved server lists its slug (`staleSlugTexts`, the drop only: a joining role's grants come only through
          pendingGrants).
        - hostApply's `LiveRunChange.grants` drops a `granted: false` entry while the run's gates still give the role that
          server (`mcpServersForRole` on the run's list, e.g. through "every role" or a slug the save still lists).
        - N2: `RunManager.cardRolesForStoreAtCreation` rewrites a work run's MCP (project scope) and skill card role slugs
          IN PLACE before the card is broadcast: a slug a running role holds becomes that role's stored slug (by id), a slug
          no stored role holds is dropped (the tools already refuse unknown slugs; `ctx.requestProposal` callers such as the
          mock do not), each change is logged on the run ("The card's roles were matched to the project's current role
          names ..."). The renderer resolves card slugs against the STORED roles (LiveRunView passes project.roles to
          `whoCanUse` / `roleNames`, SkillsProposalBody to its names), so it names the role the save grants; the save is the
          identity (`proposalForStore` maps only org chart cards now). The stored role ids each slug named are kept in the
          request's closure; at approval `cardSlugsStillMean` checks them against the store and, on any difference, nothing
          is saved: the tool gets `revise` ("Roles were renamed while this card was open, so nothing was saved. Read the
          current roles and propose it again.") and the run log says "Roles were renamed while this card was open, so
          nothing was saved. Ask the agent to propose it again." The run still takes the change through `mcpRolesForRun` /
          the saved Role.skills by id. `roleNames` (src/shared/view/mcpProposal.ts) names every role sharing a slug.
        - L-1: `diffOrgChart` (src/shared/view/orgDiff.ts) matches a role by id when both sides have it under the same
          slug, else by slug but never with a current role whose id another proposed role carries, so a kept slug and a
          waiting role sharing it pair with their own rows.
        - Saved-shape change (owner-approved through the orchestrator, renderer run told): `ProjectStore.saveFromRenderer`
          (projects:save only; `save()` / `saveInternal()`, i.e. team-file ingest and the services' own saves, never) runs
          `renamedSlugGrants`: for each role id whose slug the save changes, when no OTHER stored role held the old slug,
          every stored server listing the old slug drops it and the role gets the server by id (Role.mcpServers), also when
          another incoming role takes the old slug (a swap or a new role: nobody inherits); when another stored role held
          it (a duplicate, e.g. a slug typed key by key through another role's slug) nothing changes. Only the renamed
          role's own old slug is removed; other slugs no role holds stay (a role removed with Undo still available, team
          files awaiting approval), so a role removed in the same save keeps its slug in server lists (store-level, open:
          review Low 4). Carry (memory only, `RENAME_CARRY_MS` 120 s from the role's latest rename save): ids main moved
          are put back into later renderer saves of that role that omit them (typed and debounced, back to the starting
          slug whose patch carries the starting grants) until the user acts on that server (mcp:upsert / mcp:remove call
          `forgetRenamedServer`; revokePlan always upserts first, so a real revoke still removes the id grant). The old
          slugs moved are kept as `renamedAwaySlugs` until a role holds them again; mcp:upsert (dispatcher.ts) drops
          exactly those from an incoming `roles` list (a stale renderer copy writing the old slug back), nothing else.
          projects:save returns that saved project (the dispatcher passes saveFromRenderer's result through). Checked by
          `src/main/store/projects.test.ts` "renames move slug-keyed server grants to id grants" (rename, per-keystroke
          saves through another role's slug, the renderer's start-snapshot patch typed through a duplicate and back to the
          start slug, a real revoke and the carry window, renamedAwaySlugs, swap, a new role on the old slug, save() /
          saveInternal() untouched) and `host/dispatcherLiveChanges.test.ts` "third review: projects:save returns the saved
          project ..." and "... a stale whole-spec mcp:upsert drops exactly the renamed role's old slug ...". Open: the
          desktop lets a role take another role's slug (the CLI refuses, teamRoleEdit.ts); no refusal was added to
          saveFromRenderer this round because typed in-between saves from older renderers may carry duplicates.
        Answers: projects:save does NOT refuse duplicate slugs (no check in `saveFromRenderer` or `save`; not added because
        per-keystroke saves pass through other roles' slugs); readers handle duplicates instead (mcpRolesForRun, roleNames,
        cardSlugsStillMean, renamedSlugGrants). MCP and skill proposals refuse unknown role slugs in the TOOLS
        (`harnessTools.ts` propose_mcp_servers "there is no role ... in this project" against the run's view; skills through
        `skills/assist.ts` with `roleSlugs` from the run's view), not in RunManager; card creation now drops them for direct
        `ctx.requestProposal` callers. Store-level: an mcp:upsert whose `roles` carries a renamed role's old slug that main
        moved (renamedAwaySlugs) drops exactly that slug; any other slug no stored role holds is stored as given and grants
        nobody now (a role created later under it gains it in the store, and a run then gives it to that joining role only
        because the saved list names its slug). Dropping unheld slugs in general was not done: a grant to a role whose
        debounced projects:save has not landed yet, a role removed with Undo available, or team files awaiting approval
        would lose it. The renderer's debounced projects:save discards the
        returned project (useAppStore `debouncedSave`), so its copy of the servers stays stale until the next refresh: the
        Team tab run's to fix. Tests: `runManagerHostChange.test.ts` "third review: slug texts, renames and cards" (N1
        revoke in both stored shapes, the Team tab shape in both orders, a stale whole-spec write, another session's card
        with the old slug, a property test over 27 orders in both shapes checking the run and the store, a joining role, the
        Reviewer's N2 example, the swap, a rename while the card is open, the skill card), `hostChange.test.ts`
        staleSlugTexts / mcpRolesForRun N1, `orgDiff.test.ts` L-1, `mcpProposal.test.ts` duplicate slugs. All but the Team
        tab shape test (a coverage test that also passed before) failed on the parent commit. Unverified: the renderer's
        display of the mapped cards (read, not run), live providers.
    - End to end: "a desktop save of a grant and of an org chart role reaches an idle mock run" drives the real
      RunManager and MockAdapter: `MockSession.configChanges` gets one `host: true` entry, `hostNotices` one
      'next-message' notice, RunManager sends nothing, one "You changed ..." log line.
    Held, usage-limited and card-waiting runs take the state now and are never woken (the session keeps its notice for
    the user's next message). One log line per run; the result is `McpMutationResult.liveRuns` /
    `SkillMutationResult.liveRuns` (`LiveRunChange`), projects:save keeps returning the Project. Fan-out of a card skips
    the card's own run; MCP / skill card fan-out needs `RunManagerOptions.resolveProject` (bootstrap sets it) to read
    `before`. Not covered: request_mcp_install approvals, projects:save fields other than roles and grants, org chart
    role removals on a session without `hostConfigChanged` (they wait with the rest). Unit-tested only
    (`hostChange.test.ts`, `runManagerHostChange.test.ts`, `host/dispatcherLiveChanges.test.ts`); live providers,
    whether Codex refuses an ungranted MCP tool before its idle restart, and any renderer display are unverified.
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

## Compaction and the models a run lands on (2026-11-10)

Investigation of "auto compaction is going nuts" (owner report, Anthropic connection, agents seen on old Opus/Sonnet).
Lab material: `orgai-performance-lab/.tmp/phase7/` (relays that classify every request by source, the campaign,
summaries) and `scripts/smoke-compaction.mjs` here.

- Context windows decide when compaction starts. Read from the CLI (`Query.getContextUsage()`, token-free, SDK 0.3.318,
  API-key login through the lab endpoint): `opus`, `sonnet`, `haiku`, `fable` and `claude-fable-5-1[1m]` resolve to
  claude-opus-5-5 / claude-sonnet-5-5 / claude-haiku-5-5 / claude-fable-5-1 with an auto-compact threshold of 967,000
  tokens (1M window); `claude-opus-4-5`, `claude-sonnet-4-5`, `claude-sonnet-4-6` (and `claude-fable-5-2`) have 167,000
  (200k window). `claude-opus-4-1` is remapped by the CLI to claude-opus-5-5. So an older id compacts after a sixth of
  the context.
- The regression path: run staffing sets `ANTHROPIC_DEFAULT_{FABLE,OPUS,SONNET,HAIKU}_MODEL` from the Anthropic
  connection's `tierModels` for every tier that holds a concrete id (`ConnectionService.anthropicTierEnv`). Before
  staffing the Anthropic connection set none, so the aliases always resolved natively. With
  `ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-5` the CLI moves the `opus` alias AND the session's default model there
  (supportedModels then reports "Opus 4.5 ... Custom Opus model", `default` -> claude-opus-4-5), and a live session
  with root `opus` and a `sonnet` report sent every request as claude-opus-4-5 (lab relay; the lab endpoint does not
  serve it, so they failed there). A default install or a discovery leaves `tierModels` on aliases (suggestTierModels
  prefers the alias), which sets no variable; only a concrete id stored in a tier (a user pick, an earlier install) does.
  The owner's own `tierModels` were not available, so that this is what happened on their machine is UNVERIFIED.
- Fix (unit tests: `serviceDiscovery.test.ts`, `catalog.test.ts`, `claudeCompaction.test.ts`; live: the same
  stored mapping gives `{ ANTHROPIC_DEFAULT_OPUS_MODEL: claude-opus-4-5, ..._SONNET_MODEL: claude-sonnet-4-5 }` on the
  previous build and `{}` on this one after a live discovery, and the session then ran claude-opus-5-5 and its report
  claude-sonnet-5-5): discovery keeps the model each alias resolves to (`ProviderModel.upstream`, from
  supportedModels' `resolvedModel`); `anthropicTierEnv` skips a tier id that is an older model of its family than
  anything the catalog knows (`newerClaudeModel`, `claudeModelVersion` in catalog.ts; a `[1m]` suffix and dates are
  ignored for the comparison and kept in the value) and logs it once. Without a discovery nothing is known to be newer
  and the id is passed as before. At its first init the Claude session logs one line naming the concrete model of
  each alias (`Query.supportedModels()`, token-free, `modelTierReport`) and warns for an alias a variable moved onto an
  older model and for a role pinned to one.
- Compaction itself on Claude (`scripts/smoke-compaction.mjs`, haiku, lowered window, two runs): see sdk-facts
  "Compaction". The adapter now logs each compaction of the orchestrator ("Compaction N of the orchestrator's
  conversation (auto): 168k to 12k tokens.") with a harness transcript row, shows "Compacting the conversation…" while
  it runs, and no longer puts the CLI's summarizer fork on the chart as a nameless report (its SubagentStop has
  agent_type '' and no task_started). Unit tests only for the adapter side.
- Lab, same task (OrgAI's own source, add `toolErrors` beside `retries` end to end; `phase7-20261110T201740Z`):
  Claude adapter, lead on claude-opus-5-5, lead alone, 79 requests, 722 s, $4.23, 7/7 checks, peak 186k input tokens,
  no compaction (threshold 967k). At the peak the lead's own Bash output was 90k tokens, its own edits 35k, tool
  definitions 20k; harness text (plan tool results) under 1k, no nudges, no hook context. A run on the same build with
  a 200k model would therefore have compacted at about request 70. The Fable and Codex runs were stopped early when the
  investigation was redirected.
- Compaction awareness (2026-11-10, second commit; unit tests in `continuationCompaction.test.ts`,
  `claudeCompaction.test.ts`, `codex.test.ts`, `codexEvents.test.ts`, `runManager.test.ts`, `mockExec`-style mock marker,
  `exec.test.ts`, `tui/state.test.ts`, `render.test.ts`; NOT checked in a live run that compacts):
  - `RunEvent` `agent.compacted { runId, agentId, at, trigger?, tokensBefore?, tokensAfter? }` and
    `AgentInstance.compactions`. RunManager owns the count: it counts the events, records and broadcasts them, re-sends
    the agent, and sets `compactions` on every `agent.upsert` (an adapter's value is replaced). The bridge forwards a
    child's event under the mapped agent id. Claude emits it at `compact_boundary` (the orchestrator only: a subagent's
    compaction carries no agent id, sdk-facts "Compaction"); Codex maps a completed `contextCompaction` item on any
    agent's thread (seen with codex 0.167 at a zero-spend stub: `item/started` + `item/completed` type
    `contextCompaction`, mid-turn, when the reported usage passed about 245k of the 258,400-token window Codex measures
    gpt-6.1-sol against, the same for an unknown proxied id); the mock scripts it with `[mock:compact]` (a two-step plan,
    three root compactions, no step finished).
  - Surfaces: `orgai exec` text prints "Lead compacted its context (3rd time)."; `runs show` and the TUI agent rows add
    "compacted Nx"; the TUI adds a notice per event; the root's transcript row says "(Nth time, ...)". Wording in
    `src/shared/view/compactionText.ts`.
  - Thrash guard (`continuation.ts`, pure `noteCompaction` / `compactionThrash`, `COMPACTION_THRASH_LIMIT` 2): a
    compaction never nudges and is never a turn; when one agent compacts more than twice with no plan step finished in
    between (a finished step resets its count), the ContinuationDriver logs one warning naming the agent, its model and
    window (Claude: `getContextUsage().rawMaxTokens`, token-free; Codex: `modelContextWindow`) and the remedy, tells the
    user, and sends no nudge (continue or ready) until the user's next message. Off when automatic continues are off.
  - Re-attach (Claude): a `SessionStart` hook answers source 'compact' only while the stream said the ORCHESTRATOR is
    compacting (status 'compacting'), once per compaction, with `compactionStateText`: the plan with each step's
    state, the reports working now and the required reports not delivered yet, at most 4,000 characters. Nothing is
    re-attached on Codex: whether its compaction keeps the thread's recent user messages (harness messages included)
    was not checked.
## Per-run root model, effort and permission mode (start and mid-run)

- Contract: `StartRunInput.modelSelection` / `effort` / `permissionMode`, `RunSummary.rootEffort` / `permissionMode` /
  `permissionModeChosen`, `runs:setPermissionMode` (`SetRunPermissionModeInput` / `Result`), `runPermissionModeChoices`
  (shared/types.ts). Valid efforts per adapter come from `effortOptionsFor` (shared/defaults.ts: Codex low/medium/high, else
  all five); there is no per-model effort data, so the renderer offers `effortOptionsFor(catalogEntry.adapter)`.
- Surfaces: `runs:start` passes the three fields as `StartInput.userChoice` on the desktop only; a socket / inproc client
  sending any of them gets bad_request (fail closed; their `overrides.permissionMode` rules are unchanged).
  `runs:setPermissionMode` is in the 'configure' scope (the registry needs a scope) and its handler refuses every
  non-desktop surface with scope_denied before parsing. Desktop `runs:continue` / `runs:resumeNow` pass `desktop: true`.
- Start (RunManager.start, one commented block; pure `checkStartChoice` / `checkStartEffort`): all checks run before the
  summary exists, so a refusal leaves no run. The model must be in the catalog on exactly that connection; an explicit
  model wins over the single assistant's quick-run model; it then takes the existing `modelSelection` path (root role only).
  Effort must be in `effortOptionsFor(adapter)`; it is set on the root of `ctx.roles` (claude.ts `sessionEffort`, codex.ts
  `this.root.effort` read it), never on reports (checked by reading staffing.ts, claude.ts `reportEffort` and codex.ts,
  not by a live run). The chosen model is not root-only in effect: roles whose model is 'inherit' follow the root's
  model, and `staffing.ts` uses the root's live tier (`parentTier`) as the tier ceiling of an 'inherit' role with no tier
  of its own (checked by reading staffing.ts). An explicit model under a project cap needs a known price (same
  resolution as the exec budget's `modelPriced`). The mode must be in `runPermissionModeChoices` (setup-like runs: none;
  Chat runs: default, dontAsk, plan; exec runs refused; its build-session branch is defensive only, since a build
  session is an mcp-assist run and `start` refuses a build workspace on any other kind); it is laid over
  `effectiveRunProject` by `runProjectFor`, which `setLive` also uses, so an approved project change cannot undo it.
  `RunSummary.permissionMode` (`recordedRunPermissionMode`, review L1) is recorded only on runs that take a per-run mode:
  absent on setup-like runs (they pin their own), 'default' on a Chat run whose project mode its adapter downgrades to
  asking, otherwise the mode in force (setLive keeps it current). bypassPermissions stays gated where it was: the adapters
  honour it only off setup-like and trust-restricted runs (`claudeAllowsBypass`, codex mapping); proposals and agents
  still cannot set it.
- Continuations: `rootEffort` carries (dropped with a warn line where the new adapter does not take it). A chosen mode
  carries when it narrows the project's current mode, or the continuation is desktop, the resume timer or a 'configure'
  caller; otherwise an info line says the project's mode applies. Exception (review L5): an output revision
  (`outputs/revise.ts`, `outputs:revise`) continues without the desktop flag because that channel is in the 'operate'
  scope and socket clients reach it too, so a chosen mode that widens the project is not carried there (fail-safe).
- Mid-run (`RunManager.setPermissionMode`): ended / paused runs save the mode for the continuation (`applied: false`).
  A live run needs the optional `RuntimeSession.setPermissionMode` (runtime/types.ts), which derives its mapping from the
  `mode` argument. Calls are serialized per run (`ActiveRun.permissionModeChanging`; a second call is refused with a plain
  reason). A narrowing is put on `ctx.project` before the session call, a widening only after it applied (review L3). The
  session answers true, `{ applied: true, reportsUnchanged: n }` (n reports may still run wider: Claude counts finished, resumable reports too, Codex threads only until their turn ends;
  the result carries `reportsUnchanged` and the info line and `reason` say so; it must not answer plain true then), or
  false / throw. On a refusal chosenMode goes back and `ctx.project` is re-derived from the live project
  (`ActiveRun.liveProject`, so an approval that landed during the await is kept) and the summary follows; a thrown message
  is only logged (`reason` is fixed), except a thrown `PermissionModeRefusal` (`runtime/permissionModeRefusal.ts`,
  `instanceof` only; plain OrgAI-written text, never provider text): its message becomes `reason`, control characters
  stripped, at most 300 characters. Nothing changes when the method is missing. Open cards stay open; session rules,
  session folders and staffing are untouched; a session acceptEdits grant is dropped (below). Only the desktop IPC reaches it (no RuntimeContext hook or tool).
- "Accept edits" grants (review M1, re-check M-a / M-b / M-c / H1): RunManager follows what the adapter applied, not
  the card. The adapter calls `RuntimeContext.acceptEditsGranted()` where it applies a session / project allow's setMode
  acceptEdits to its own session (bound only on non-restricted work runs; a bridged child gets a local hook from
  bridge.ts that only marks that child, since its grant moves only the child). `followAcceptEditsGrant` sets `ActiveRun.acceptEditsGrant`, an overlay that
  `runProjectFor` lays over default / dontAsk / plan, so `ctx.project` reads acceptEdits and setLive cannot undo it.
  `RunSummary.sessionPermissionMode` says 'acceptEdits' meanwhile; `permissionMode` / `permissionModeChosen` keep the
  run's own mode, so a continuation never carries a session grant. The overlay ends at a finished / error / paused
  status and at teardown, and is dropped from stored runs on load. An applied `setPermissionMode` clears it, and the
  contract makes the adapter drop its own session acceptEdits grant whenever `mode` is not acceptEdits, auto or
  bypassPermissions (H1). A grant that lands while a change to a mode below acceptEdits awaits (`ActiveRun.modeGen`,
  bumped on every grant) makes RunManager send the change once more; if a grant lands again, the answer is
  applied: false ("An "accept edits" permission was granted during the change"), with the session's mode recorded as
  the new choice under the overlay, never the earlier choice (the one exception to "a refusal changes nothing": the
  session really runs `mode`; RunManager re-derives first, broadcasts one snapshot, and the result carries the adapter's
  and the bridged `reportsUnchanged`, also in `reason`). Every change to the three fields on a live run is broadcast
  as `run.permissionMode` (a RunManager-only snapshot event; an adapter's is dropped). The renderer does not consume it
  yet.
- Bridged children keep their native session's start mode (their project is a snapshot; they never take a live change).
  On every applied change (not only a matrix narrowing: modes the matrix cannot compare, such as Don't ask to Default,
  still leave an Auto child wider), RunManager adds `BridgedSessions.liveWiderThan(mode)` (live children whose start mode
  is wider, an unknown one included, or whose own "accept edits" grant is wider than `mode`; 0 when none) to
  `reportsUnchanged`, so a change never answers a plain applied while a wider bridged child runs. A child's
  `ctx.project.permissionMode` is a getter that follows the parent's current mode when that is Plan or Don't ask and
  narrows the child's start mode (so the adapters' plan / dontAsk accept-edits drop check sees the parent's mode); it is
  never wider than the start mode, and the native child session itself is unchanged. If a child's `acceptEditsGranted`
  hook fires while the parent is in Plan / Don't ask, a warning line is logged on the parent run.
- An approved project change (`setLive`, e.g. a project "accept edits" save returning a narrower mode) that narrows the
  run's own mode to Plan / Don't ask drops the "accept edits" overlay (`acceptEditsGrant`), so `ctx.project` and the
  summary say Plan and new Codex threads / a restarted Claude query start there. A mode the user chose for the run
  (`chosenMode`) is not moved by the project, so its overlay stays. Remaining gap: the live native session is not told
  (`session.setPermissionMode` is not called from setLive, which runs inside the adapter's own hook calls); its grant
  ends at the next restart or when the user chooses the mode again, and a warning line says so.
- Checked by unit tests only: `runtime/runManager.startChoice.test.ts` (fake recording adapter: cases are named by
  finding), `runtime/bridge.test.ts` (liveWiderThan, a child's grant counted and never forwarded, the child's project
  following the parent down), `host/argsRunChoice.test.ts`, `host/dispatcherRunChoice.test.ts`, `store/runs.test.ts`.
  The adapters call `acceptEditsGranted` and drop their session grant on an applied mode below acceptEdits; their live
  mode change is checked with fake SDK / app-server events (`claude.test.ts`, `codex.test.ts`) and is typings-only for
  the real Claude SDK (`sdk-facts.md`, "Live permission mode change"): live behaviour is unverified.

## Factory Floor mock (`[mock:factory-floor]`)

Token-free fixture for `e2e/factory-floor.mjs` (docs/design/factory-floor.md slice 3). Work runs of a stored project, default
script (set `ORGAI_MOCK_SCRIPT` to `{"delayMs": 50}` only; a custom `work` array turns the marker off). Checked by
`runtime/mockFactoryFloor.test.ts` (fake context); the live app path is unverified.

- Markers: `[mock:factory-floor]` plays `factoryFloorSteps`; `[mock:factory-floor-pause]` is the same and ends with a usage
  limit (turn 1 hour; set autoResume off so the run stays `paused`). Run status `finished` comes from End session.
- 39 spawns: root -> `ff-l1..3` -> `ff-s11..33` -> `ff-w111..333` (depth 3). Ids equal handles. The mock never enforces
  subagent limits, spawnable lists or a plan guard (`maxConcurrentSubagents` / depth only reach the Claude SDK settings);
  scripted spawns are not checked against the parent's spawnable list, and the default project has no required reports. Roles
  used are the first spawnable role of the root and of that role (`implementer` on the default chart). `ff-w333` is then
  removed (`agent.remove`), so 39 agents stand (38 plus the root).
- Standing at `MOCK_FACTORY_FLOOR_READY` (a root text): `ff-w121` starting, `ff-w122` idle, `ff-w123` error, `ff-w131/2/3` and
  `ff-s13` done, `ff-w211` waiting (a background Bash card the e2e answers; it then goes thinking), leads and sub-leads
  delegating, the root thinking. `ff-w111` is in state `tool` for `FACTORY_FLOOR_TOOL_HOLD_MS` (5 s) after READY, then
  `MOCK_FACTORY_FLOOR_DONE`; the run goes idle. `usage.toolCalls` of `ff-w111` goes 1, 2, 3, 4 (counted when a tool step
  starts, in the same upsert that sets `tool`).
- Worktree records are synthetic (no git, `agent.upsert` only): `ff-w111` active, `ff-w112` merging, `ff-w113` merged
  (main), `ff-w131` merged (parent `ff-s13`), `ff-w132` review, `ff-w133` held, `ff-w211` empty, `ff-w212` conflict, `ff-w213`
  removed, `ff-s13` waiting-children. A real fixture repo is not needed.
- Messages: `ff-l1` -> `ff-s11`, `ff-w111` -> `user` (to null), `ff-w112` -> `nobody-here` (to null). Plan: p1 owner
  `ff-l1` in_progress, p2 owner `ff-w111` blocked, p3 pending (plan status stays active; `[mock:exec-blocked]` gives a blocked plan).
- New generic steps, usable in any custom script: tool `holdMs` (stay in `tool`), `agentState`, `worktree`, `remove`.
