# UX review: the Projects view, as input for a Dashboard

- Reviewer: UX Researcher (mock-data walkthrough, no code changes)
- Build: 8a20167 (`npm run build`, version 0.1.6-dev1)
- How it ran: built Electron app driven by playwright-core through `e2e/lib.mjs` `launch()`, `ORGAI_MOCK=1`, a fresh
  temp `ORGAI_DATA_DIR`, three fixture git repos under the OS temp dir. Window sizes 1600x1000 (full sidebar) and
  1024x640 (56 px rail), `data-theme` dark and light, one keyboard-only Tab pass on the empty view (1024x640) and
  one on the populated view (1024x640), then a relaunch on the same data dir. No tokens spent; no smoke scripts.
- Compared with: `docs/design/spec.md` section 2.1 (shell) and 2.4 (Projects page), `.orgai/ARCHITECTURE.md`
  "Renderer UI", `src/renderer/src/views/ProjectsView.tsx`, `components/Sidebar.tsx`, `styles/projects.css`.
- Earlier walks of this view: none dedicated to it (it appears in passing in `ux-review.md` and `ui-review-2.md`),
  so there is no status table of earlier findings.
- Screenshots: `docs/design/ux-review-dashboard-shots/NN-*.png` (numbers below). Walk script and raw measurements:
  `e2e/shots/ux/dashboard/` (gitignored).
- ASCII note: the app writes a middle dot in "Needs you . 1" and "1 decision . 1 run"; it is shown here as " . ".

## Mock state used

| Project | What was done | State when the Projects view was re-opened |
| --- | --- | --- |
| Docs site | `[mock:deep-tree] Write the getting started guide`, then End session | Stopped (endedBy 'user'), $0.0100 |
| Billing service | `[mock:deep-tree] Refactor invoice rounding`, left open | Idle (live), $0.0100 |
| Notes API | default script `Add a search endpoint for notes` | Running with one permission card ("Allow: Edit example.ts"), $0.0057 |

After a relaunch the two live runs came back as `finished / endedBy app / endedWithApp` ("Ended when OrgAI closed").

## Verdict

NOT READY AS A HOME. The Projects view is a good *first-launch* page (form, live path check, Chat now) and a poor
*returning* page: once projects exist it shows three identical cards (name, a cut temp path, four role initials,
"4 roles", Delete) and nothing about runs, decisions, cost, usage or what happened while the user was away (shots 08
to 11, 22). Every one of those facts is already in the renderer store or one IPC call away (section C); only a few
need a new contract (section D). The most important things for the Dashboard: lead with what needs the user and what
is running, tell a returning user what ended while they were away, and give Delete an honest confirm.

## Findings, ranked

### H1. A returning user sees no run, decision or outcome state on the Projects view

- Screen: Projects view with projects. Shots 08, 09, 10, 11 (both themes, both sizes), 21, 22 (after relaunch).
- Steps: create three projects, leave one run needing a permission, one idle, one stopped; click Projects.
- What the user sees: three cards whose text is identical apart from the name:
  `Docs site C:\Users\...\Temp\orgai... OR IM RE RE 4 roles Delete` (raw card text, `raw.json` pop1600). The
  "Needs you" project (Notes API) is the last card and looks exactly like the stopped one. Spec 2.4 promised a status
  row on every card ("Working", "Needs you", "Setup pending" or "Last run 2h ago"); only "Setup pending" exists.
- Where they go instead: the sidebar. The project row dot plus badge ("1") and the expanded open-run rows carry the
  state (shot 08), the "Needs you . 1" popover lists the decision (shot 12), and the "Last run just now . Stopped"
  subtitle exists only as the row's tooltip or on the *active* row (`Sidebar.tsx` line 212, `raw.navTitles`).
  At 1024x640 the sidebar is a rail, so all of that is a coloured pip on "NA" / "BS" / "DS" plus a bell with "1"
  (shot 10).
- Fix (Dashboard): an attention-first layout. A "Needs you" block first (every `waitingItems` item, one click to
  `jumpToDecision`), then "Running now" (live runs with status word, elapsed time, plan step if any), then projects
  ordered by attention (decisions, then open runs, then newest run). Each project tile shows the
  `lib/projectStatus.ts` subtitle as visible text, never only a tooltip.
- Checkable: with the mock state above, the Notes API tile shows "1 decision . 1 run" in visible text and is first;
  Billing shows "1 open"; Docs site shows "Last run ... Stopped".

### H2. After a relaunch nothing says that runs were cut when OrgAI closed

- Screen: relaunch landing page. Shot 22.
- Steps: with Billing idle and Notes API waiting on a card, quit and relaunch.
- What the user sees: the Projects view, three identical cards, sidebar rows without dots or badges. Two runs are
  now "Ended when OrgAI closed" (one of them was waiting on a permission), but that wording appears only after
  opening each project (or hovering each sidebar row for its tooltip). The decision the user had not answered is
  gone from Needs you with no trace.
- Fix: a "Since you were last here" strip on the Dashboard built from `historyByProject` summaries with
  `endedBy`, `endedWithApp`, `endedWhile`, `error`, `pausedUntil`, newer than a renderer-held "last seen" time
  (localStorage, no IPC). A run cut while `endedWhile === 'waiting'` gets its own line ("Was waiting on you when OrgAI
  closed. Send to continue.") with a one-click Continue (`continueFromHistory`).
- Checkable: relaunch the mock state; the Dashboard lists two runs "Ended when OrgAI closed", Notes API marked as
  having been waiting on you, each opening the run in one click.

### H3. Delete project silently removes all run history and stops live runs (read in code; confirm seen)

- Screen: Delete confirm. Shot 16.
- The dialog says: "This only removes the project from OrgAI. Files in its folder are untouched." In code,
  `projects:remove` calls `RunManager.removeProject` (stops every live run of the project, `runManager.ts` 644) and
  `RunStore.removeProject` deletes every run record of the project (`store/runs.ts` 237), plus MCP secrets, project
  skills files and Team reviews (`ipc.ts` 289). The delete itself was not driven in this walk.
- What the user experiences: they lose transcripts, cost history and any open run without being told; "only" reads
  as reassurance. Delete is also a plain-sight button on every card with the same weight as the card's other text.
- Fix: the confirm names what goes ("Ends 1 open run and deletes 1 run's history, transcripts and costs. Files in its
  folder are untouched."), counts from `runs` + `historyByProject`. On the Dashboard move Delete into a per-tile "More
  actions" popover (spec 2.4 already asked for an overflow menu with Open, Open folder, Delete).
- Checkable: on Billing service (1 idle run) the confirm body mentions the open run and the history; Delete is not a
  visible button on the tile.

### M1. Paths are cut at the end, so every card shows the same text

- Shots 08, 10, 17. The `.path` line uses `text-overflow: ellipsis` (end truncation), so all three read
  `C:\Users\chapp\AppData\Local\Temp\orgai...`; the folder name, the only part that differs, is cut. Spec 2.4 asked
  for middle truncation. Real paths under `C:\Users\<name>\Projects\` have the same problem.
- Fix: show `lib/paths.ts` `folderName` (as the topbar does) with the full path in the tooltip, or middle-truncate.
- Checkable: at 1024x640 each tile shows `docs-site`, `billing-service`, `notes-api`.

### M2. Project order ignores attention and recency

- Shots 08, 10. Cards are in store order (newest created first: Docs site, Billing, Notes API). The project that needs
  the user is last. `Project` has `createdAt` / `updatedAt` only (save time; chart edits move it), no "last opened".
- Fix: order by attention (decisions, open runs), then newest run start from `historyByProject` / `runs`. A
  "recently opened" order needs a last-opened time: renderer localStorage is enough (no contract).

### M3. Focus is lost after opening a project from a card and after cancelling the form

- Keyboard pass, `raw.json` `cardEnterLands` and `afterCancelFocus`: Enter on a card opens the project's Live tab
  (shot 18) with focus on BODY; Cancel in the New project form leaves focus on BODY. Create already moves focus to the
  project h1 (`ProjectsView.tsx` 146); the card path does not.
- Fix: card open focuses `main .topbar h1` like create; Cancel returns focus to the `new-project` button.
- Checkable: after Enter on a tile, `document.activeElement` is the topbar h1; after Cancel it is `new-project`.

### M4. First launch at 1024x640: the submit button and the mock toggle are below the fold; Chat now is last in tab order

- Shots 03, 04, 05. `.projects` scrolls 738 px in a 593 px region (`raw.firstLaunch1024`); the submit row sits at
  y about 730. Chat now sits top right visually but comes after every form field in the Tab order (keyboard pass:
  Name, brief, path, Browse, architect-setup, use-mock, then `empty-chat-now`). Two filled primary buttons compete
  (disabled "Create and start setup" and "Chat now").
- Fix: keep the two-path first-launch layout but make the paths peers at the top ("Start a project" / "Chat now"),
  then the form; one primary per view. At 1024x640 the form's submit row should be reachable without scrolling or
  the intro shortened.
- Checkable: at 1024x640 the first Tab stop in main is either path choice; `.projects` scrollHeight minus clientHeight
  is under 60 px with the form collapsed to its first step.

### M5. Opening the form on a populated view pushes every project off screen at 1024x640

- Shots 14, 15. The form renders above the list; the list starts at y 686 in a 641 px window (`raw.formPop1024`).
  The user loses sight of their projects while creating one, and the "already a project" line (shot 15, works well:
  "This folder is already a project: Notes API." with "Open Notes API" as primary and "... anyway" secondary) is the
  only link back.
- Fix: on the Dashboard open New project in a Dialog (spec 2.4 asked for one, 560 px) or a side sheet, keeping the
  same component, form state parking (`parkedDraft`) and selectors.

### M6. Nothing cross-project about money or limits is on this page

- Shots 13, 19, 20. Cost lives per run (History rows) and per project (History > Trends, 3 clicks per project, shot
  20). Plan windows live in the account popover (1 click; in mock it says "No plan limits apply"). There is no
  "this week across all projects" figure anywhere; adding three projects' Trends is manual.
- Fix: a usage block on the Dashboard: tightest plan window per connection in use (`usageByConnection`,
  `tightestWindow`), LiteLLM spend (`spend`), and cost this week across projects (sum of `summary.usage.costUsd`
  through `lib/cost.ts` `costView`, unknown never $0).

### L1. Role initials collide and say little

- Shot 08: "OR IM RE RE" on every card; two roles share "RE". The sidebar disambiguates initials
  (`initials(name, names)`), the card does not. A row of initials does not distinguish projects that share the default
  chart. Fix: drop the avatar stack from the tile or show role count plus "N agents ran this week".

### L2. Mock mode is announced four times on first launch

- Shot 01: MOCK badge in the brand lockup, "Mock mode" badge in the topbar, the `use-mock` checkbox and the
  "Runs on the mock adapter (no tokens)." line. Keep the brand badge and the checkbox; the Dashboard does not need a
  topbar badge too.

### L3. The brand wordmark is squeezed to one glyph by the MOCK and Dev badges

- Shots 01, 08 (1600, full sidebar): the lockup reads "( MOCK Dev". Known as L7 in `ux-review-assistants.md`; listed
  here because the Dashboard is the page where a brand moment belongs.

### L4. 85 percent of the page is empty at 1600x1000

- Shot 08: three 321 px cards in the top 225 px; the rest of a 1368 x 1000 main area is blank. Room for the items in
  section B without scrolling.

## Click counts today (from the Projects view)

| Task | Today | Note |
| --- | --- | --- |
| Answer the waiting permission | 2 (Needs you row, item) | sidebar only; at 1024 a bell "1" in the rail |
| See which projects are running / waiting | 0 clicks, read sidebar dots; full sidebar only | not on the page itself |
| Learn a project's last outcome | hover each sidebar row (tooltip) or 1 click per project | H1 |
| Learn what ended while away (after relaunch) | 1 click per project, then read the run tab | H2 |
| Cost this week, all projects | 3 clicks per project (row, History, Trends), then add by hand | M6 |
| Plan window usage | 1 click (account popover) | |
| Resume an open run | 1 (sidebar run row) | ended runs: open project, it shows the newest |
| Start a chat / project | 1 (`projects-new-chat` / `new-project`) | |

## A. What first-time and returning users want, with today's data source

Ordered by priority. "Store" means already in `useAppStore`; "IPC" means one existing call per project.

| # | Item | First / returning | Source today |
| --- | --- | --- | --- |
| 1 | Needs you: every open decision, kind and ask first, project and run after, one click to the card | returning | store: `waitingRuns` + `lib/needsYou.ts` `waitingItems`; action `jumpToDecision` |
| 2 | Running now: live runs with status word, project, run name, elapsed time, current plan step ("step 3 of 7") | returning | store: `runs` (filled by `runs.listLive` at init), `lib/runStatus.ts` `statusOfRun`, `runName`; `RunState.plan` (plan.updated) |
| 3 | Since you were last here: runs that finished, failed, were stopped, paused (with resume time) or ended when OrgAI closed | returning | store: `historyByProject` (`loadAllHistory` at init) with `status`, `endedBy`, `endedWithApp`, `endedWhile`, `error`, `pausedUntil`, `autoResume`; "last seen" time in localStorage |
| 4 | Projects ordered by attention, each with visible status line, folder name, newest run and Open | both | store: `projects`, `lib/projectStatus.ts`, `historyByProject`, `lib/paths.ts` `folderName`, `setupPending` |
| 5 | Start: New project (form with live path check) and Chat now, as two peer entry points | first (empty) and both | existing `NewProjectForm`, `openNewChat` |
| 6 | Usage: tightest plan window per connection in use, LiteLLM key spend, reset time | returning | store: `usageByConnection`, `UsageMeter` `tightestWindow`, `lib/usage.ts` `connectionsInUse`; `refreshUsage()` |
| 7 | Cost this week across projects, with unknown never shown as $0 | returning | store: `summary.usage.costUsd` / `costPartial` in `runs` + `historyByProject`, `lib/cost.ts` `costView`; or IPC `runs:usageStats({ projectId, since })` once per project (includes live runs) |
| 8 | Connection health: default connection, any connection in error or disconnected that a project uses | both | store: `connections` (`ConnectionInfo.status`, `isDefault`), `defaultConnection` |
| 9 | Paused runs: why and when they resume, "Resume now" | returning | store: summary `pausedUntil`, `pauseReason`, `autoResume`; actions `resumeNow`, `cancelAutoResume` |
| 10 | Team suggestions waiting per project ("3 suggestions") | returning | IPC `capabilities.lastReview(projectId).pendingCount` (one call per project); `onTeamReviewUpdated` |
| 11 | Setup not finished ("Setup pending, continue with the Architect") | first | store: `setupPending(project)` |
| 12 | Branches waiting to merge per project | returning | IPC `maintenance.listWorktrees(projectId)` (runs git per project; load lazily) |
| 13 | Assistants: open Chat / MCP / Skill assistant sessions | returning | store: `runs` with projectId `quick` / `harness` / `skills`, `virtualProjects` |
| 14 | Connectors that need sign-in | returning | IPC `connectors.list()` state per entry |
| 15 | App facts: version, dev build, mock mode | both | store: `appInfo` (`version`, `mockAdapter`), `lib/buildChannel.ts` |

## B. What needs new data (concrete)

| Want | Missing | Suggested home |
| --- | --- | --- |
| One cross-project usage query | `UsageStatsQuery.projectId` is required and ipc.ts refuses a missing one ("Project not found", observed); N projects need N calls, each re-reading run summaries | optional `projectId` (all projects, virtual ones included) or `runs:usageOverview` returning per-project totals for a `since` |
| What a finished run produced | the plan's closing `summary` (`RunPlan.summary`) and `blockedReason` live only in `RunRecord.plan`, not in `RunSummary`; a feed would need `runs.get` per run | `RunSummary.outcome?: { summary?: string; blockedReason?: string; stepsDone: number; stepsTotal: number }` written at run end |
| Files changed / branches merged by a run | not recorded on `RunSummary` | `RunSummary.changes?: { merged: number; discarded: number; files?: number }` from `integration.ts` |
| Last opened per project | `Project` has `createdAt` / `updatedAt` only (save time) | renderer localStorage `orgai.projectOpenedAt.<id>` (no contract) |
| Last seen time for "since you were here" | nothing | renderer localStorage (no contract) |
| Cut decisions | after a relaunch the unanswered card is gone; only `endedWhile: 'waiting'` survives, not which decision | optional `RunSummary.cutCards?: { kind: string; label: string }[]` written by the quit write-out |
| Team suggestions without N calls | `pendingCount` is per project | a `capabilities:pendingCounts` map, or ride on `project.updated` |
| Update available | `AppInfo` has `version` only, no update check | out of scope unless an updater lands |

## C. What must survive from the current view

- `NewProjectForm` as is: kind segmented control, Name / brief / path fields, Browse (`projects.pickDirectory`),
  the debounced (300 ms) live path check through `projects.checkPath` with `pathStatus` messages, the found-agents
  line (`agents-found`), the "already a project" line (`already-project`) with the "Open <name>" primary and the
  "... anyway" secondary, the import / architect / default radio group (`setup-choice`) when agents are found, the
  Architect checkbox (`architect-setup`), the mock checkbox (`use-mock`, only with `appInfo.mockAdapter`), the
  connection line (`new-project-connection`) and its Change / Connect link (`new-project-connection-change`) with
  the `parkedDraft` round trip through App settings, the submit blocker text, focus to the new project's h1 after
  create.
- The empty state's two paths: "Start with a project" intro plus form, and the "Chat now" card (`empty-chat-now`).
- Topbar actions once projects exist: `projects-new-chat` and `new-project` (or equivalents with the same testids).
- Delete with a `useConfirm` dialog (with the H3 copy fix), and the `.project-card` / `form.card` hooks that
  `e2e/lib.mjs` `gotoProjects`, `createProject` and `deleteProject` rely on: `gotoProjects` waits for
  `form.card, [data-testid=new-project], .project-card`, `deleteProject` finds `.project-card` by name and clicks a
  button named exactly "Delete". If Delete moves into a popover, update `deleteProject` in the same change.
- The sidebar item still opens this view (`setView('projects')`); in the rail its accessible name is "All projects"
  (rename both together if the view becomes "Dashboard", and update `gotoProjects`, which matches the text
  "Projects" or the label "All projects").
- `ErrorBoundary`'s "way back to Projects" target.

## D. Notes on a "uniquely styled" view inside the tokens

- Settings pages are a 720 px column of hairline rows; run views are a canvas with toolbars and trays. The Dashboard
  can differ by being a wide, two-zone page: an attention column (Needs you, Running now, Since you were here) and a
  projects grid, using the full 1368 px at 1600 and collapsing to one column under about 900 px of container width
  (container queries, as the rest of the app does).
- A hero band is the place for the brand: `--gradient-mark` / `--gradient-ui` (`--brand-from` to `--brand-to`) as a
  thin band or the tile accent edge, `--text-display` for one headline figure ("2 need you" / "All quiet"), with
  `--canvas-pattern` and `--canvas-wash-opacity` as a faint background echo of the org chart canvas. All are defined
  for both themes in `tokens.css`; no literals.
- State uses the run vocabulary and its tokens only: `--state-working`, `--state-waiting`, `--state-done`,
  `--state-error`, `--state-idle`, `--halo-dot-live` / `--glow-working` for live tiles (off under
  `data-reduce-motion`), and the status word beside every colour (spec principle 4).
- Tiles on `--surface-1` with `--elev-1`, attention tiles on `--warning-soft` with `--warning-border`; numbers in
  `--font-mono` / `--text-mono` for costs and times. Check both themes at 1024x640 and 1600x1000; at 1024 the
  attention column must stay above the fold.
- Keep one primary button per view and the same Badge, Button, Popover, EmptyState and `Cost` primitives, so the
  Dashboard reads as OrgAI with a different layout rather than a different app.

## Suggested order of work

1. H1 + M2: attention-first layout with visible status lines and attention ordering (store data only).
2. H3: honest Delete confirm and Delete in a More menu (renderer only; update `e2e/lib.mjs` `deleteProject`).
3. H2: "Since you were here" from `historyByProject` plus a localStorage last-seen time.
4. M1, M3, M4, M5: folder names, focus after open and cancel, first-launch layout, New project in a dialog.
5. M6: usage and cost block (store data; one `runs:usageStats` per project if trends are wanted).
6. Section B contracts (`RunSummary.outcome`, cross-project usage) as a separate main-process step.

## Not driven

- The Delete action itself (H3 is from the confirm text plus code reading).
- Paused runs (`pausedUntil`), failed runs, setup-pending projects, a project with agents to import, LiteLLM spend and
  real plan windows: the walk used the default and `[mock:deep-tree]` scripts and the mock adapter, which reports no
  plan windows ("No plan limits apply", shot 13).
- Many projects (search past 6, grid with 20+ tiles) and long names.
- Team review pending counts and branches waiting were read through IPC shape only (`capabilities.lastReview`
  returns `pendingCount`), not shown in the app.
- The native folder picker (Browse).
- Mock run titles read "Mockdeep-tree Refactor invoice..." because the mock titles the first words including the
  marker; this is a mock artefact, not a finding.
