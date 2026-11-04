# Dashboard

Replaces the sidebar's top "Projects" item and `views/ProjectsView.tsx`. Input: `ux-review-dashboard.md` (sections A, C,
D; findings H1-H3, M1-M6, L1, L2), spec 2.1 and 2.4. This spec supersedes 2.4 for the home page; 2.4's New project
dialog rules (one form, same field order) still hold.

Constraints: renderer only. No new IPC, no new shared types. Every figure comes from the store or an existing call
(review section A). Tokens only, both themes, container queries, lucide icons through `Icon`, nothing floats over
content, one primary action per region. Status words only from `lib/runStatus.ts` (`statusOfRun`, `statusText`).

## 1. Naming and entry

- Sidebar nav item text "Dashboard", icon `LayoutDashboard`; in the 56 px rail its accessible name and tooltip are
  "Dashboard" (was "All projects"). The sidebar's "Projects" section label below it stays.
- Topbar h1 "Dashboard". `document.title` stays "OrgAI".
- The store's `View` id stays `'projects'` (no churn in App.tsx, RunTabs, Sidebar, ErrorBoundary); only labels change.
  ErrorBoundary's way back reads "Back to Dashboard".
- Topbar actions once projects exist, unchanged testids: secondary "New chat" (`projects-new-chat`) and the one primary
  "New project" (`new-project`). The topbar "Mock mode" badge is removed (L2); mock shows in the hero facts.

## 2. Layout

`.dashboard` is the scroll region under the topbar, `container-type: size` (its height comes from the shell grid), one
page scroll (no per-column scroll), padding `--space-6` (`--space-4` under 900 px wide).

| Region | Content |
| --- | --- |
| Hero band | Full width. Headline figure, one subline, quiet app facts at the right. |
| Attention column | Needs you, Running now, Since you were last here, Paused (in that order). |
| Projects | Grid of project tiles. |
| Facts | Usage, Cost (last 7 days), Connections. |

Container widths:

- 1280 px and up: three tracks, attention `minmax(340px, 4fr)`, projects `7fr`, facts `minmax(260px, 3fr)`.
- 900 to 1279 px: two tracks, attention `minmax(320px, 2fr)` and projects `3fr`; facts become a row of three cards under
  the projects grid (one per card, wrapping to one column under 600 px of their track).
- Under 900 px: one column, order hero, attention, projects, facts.
- Hero height: 120 px; 88 px when the container is under 720 px high (compact: subline stays, facts move under it).

Checked sizes:

- 1024x640, 56 px rail: main about 968 x 592, content 968 x 544 under the topbar. Two tracks. Hero 88 px, so the
  Needs you heading starts at about y 104 of the region and its first three rows (52 px each) are above the fold.
- 1600x1000, full sidebar: main about 1368 x 952. Three tracks; everything at rest fits without scrolling with up to
  6 attention rows and 6 tiles.

Projects grid: `repeat(auto-fill, minmax(260px, 1fr))`, gap `--space-4`. Attention rows and fact cards are in-flow;
nothing is positioned over another region. Popovers anchor to their trigger like everywhere else.

## 3. Hero band

- Surface `--surface-1`, radius `--radius-xl`, a 3 px top edge in `--gradient-ui`, and a faint org-chart echo: the
  `--canvas-pattern` dot grid at `--canvas-wash-opacity` behind the text (both tokens drop to nothing under the
  "no pattern" canvas setting, which is right). The mark (`--gradient-mark`, 32 px) sits left of the figure.
- Figure (`dashboard-figure`, `--text-display`, weight 600), first that applies:
  - decisions > 0: "1 needs you" / "N need you" (same wording as `projectStatus` `needsLabel`).
  - live runs > 0: "1 running" / "N running".
  - paused runs > 0: "1 paused" / "N paused".
  - else "All quiet". With no projects at all: "Welcome to OrgAI".
- Subline (`--text-secondary`), parts joined by " · ", empty parts left out: "3 projects", "2 runs open",
  "$1.24 in the last 7 days" (through `Cost`, same rules as section 5.7).
  First launch: "Start a project or just chat. Nothing runs until you say so."
- Facts at the right, caption size, `--text-tertiary`: "OrgAI 0.1.6-dev1", the "Dev" Badge when `isDevBuild`, and a
  warning Badge "Mock adapter" when `appInfo.mockAdapter` (`dashboard-app-facts`). No buttons in the hero.
- Live region: the figure line is wrapped in the page's one polite region (`dashboard-live`, `role=status`, rendered
  empty on mount). It speaks only when the figure text changes, and once after a delete ("Deleted <name>."). Elapsed
  times, costs and usage never announce.

## 4. Attention column

Each section is a `section` with an h2 (`--text-title`), a count beside it in mono when above zero, then a `ul` of rows.
A row is a full-width native `button` (or a row with one button plus at most one secondary Button). Rows: 52 px min,
`--surface-1`, `--radius-md`, gap `--space-2`. Caps keep the fold: past the cap a ghost Button "Show N more" expands
the list in place (focus stays on the button, which then reads "Show fewer").

### 4.1 Needs you (`dash-needs-you`, always shown)

- Source: every run in `runs` (real and virtual projects), `lib/needsYou.ts` `waitingItems`, in run start order then
  card order. Count = `decisionCount`.
- Row (`dash-needs-row[data-kind]`) on `--warning-soft` with a 1 px `--warning-border`: kind icon (ShieldQuestion
  permission, MessageCircleQuestion question, ListChecks rules, FileDiff proposal, GitMerge merge, Plug install,
  CircleAlert plan), line 1 the item `label` as given ("Allow: Edit example.ts"), line 2 caption
  "<location> · <runName>" with location from `lib/assistants.ts` `locationLabel`.
- Action: the whole row, `jumpToDecision(projectId, runId, key)` (no key for the 'plan' kind).
- Cap 5. Empty: one quiet line "Nothing needs you." (no icon, no card).

### 4.2 Running now (`dash-running`, always shown)

- Source: runs with `isRunLive` (starting, running, idle, stopping), every project, assistants included (covers item 13).
- Row (`dash-running-row`): status dot plus word from `statusOfRun` (so a waiting run reads "Needs you", an
  auto-continuing one "Running"), `runName`, caption "<location> · for 12 min" (from `startedAt`, re-rendered every
  30 s, never announced), and the plan step when `RunState.plan` exists:
  - "Step 3 of 7": total = steps not 'skipped'; current = 1 + index of the first step not 'done' among them.
  - plan status 'blocked': "Plan blocked"; 'done': "Plan done".
  - Assistant runs show the kind chip from `runKindLabel` ("Chat", "MCP assistant", "Skill assistant").
- Action: the row, `focusRun(projectId, runId)`. Cap 6. Empty: "Nothing is running."
- A live run gets the live dot halo `--halo-dot-live`; a Running row's left edge glows with `--glow-working` (with
  `--role` set to `--state-working`). Both are off under `prefers-reduced-motion` and `data-reduce-motion="on"`
  (static dot, no glow).

### 4.3 Since you were last here (`dash-since`, only when non-empty)

- Source: summaries from `historyByProject` merged with `runs` (runs win), one row per chain (its newest member,
  `chainGroups`), status 'finished' or 'error', kind 'work' (quick runs included), `endedAt` newer than the last-seen
  time and at most 7 days old. Newest first.
- Last seen: localStorage `orgai.dashboardSeenAt` (epoch ms).
  - Missing key (first ever load): write the current time; nothing shows.
  - Advances only when the user leaves the Dashboard through in-app navigation (the view changes away), and then to the
    time this Dashboard visit began. Never on render, never on quit, reload or window close, so runs cut by a quit
    always show after relaunch (H2).
  - "Mark all seen" (ghost Button in the section header, `dash-since-clear`) sets it to now; the section then hides and
    focus moves to the next section's heading (tabIndex -1).
- Row (`dash-since-row[data-status]`): status word through `statusText` ("Finished", "Stopped", "Failed",
  "Ended when OrgAI closed"), `runName`, caption "<location> · 12 min ago" plus `Cost` in mono. A failed run adds its
  `error` first line, cut at 100 chars. A run with `endedBy` 'app' and `endedWhile` 'waiting' adds the line
  "Was waiting on you when OrgAI closed." and a secondary Button "Continue" (`dash-since-continue`,
  `continueFromHistory(runId)`) beside the row button, shown only when `canContinue`.
- Action: the row, `focusRun(projectId, runId)`. Cap 6.

### 4.4 Paused (`dash-paused`, only when non-empty)

- Source: same merged summaries, status 'paused'.
- Row (`dash-paused-row`): word "Paused", `runName`, caption "<location> · resumes at 14:05" when `autoResume` and
  `pausedUntil`, else "<location> · waits for you to continue"; `pauseReason` as one clamped caption line.
- Actions: the row opens the run; secondary Button "Resume now" (`dash-paused-resume`, `resumeNow(runId)`).

## 5. Projects and facts

### 5.1 Project tiles (`dash-projects`)

- Section h2 "Projects" with the count. Order: decisions desc, open runs desc, newest run start desc, then name.
- Tile (`project-tile[data-name]`, `li`): `--surface-1`, `--elev-1`, `--radius-lg`; a tile with decisions uses
  `--warning-soft` / `--warning-border`; a tile with live runs has a 2 px left edge in `--state-working`.
  - Header row: name (`--text-title-sm`, one line, ellipsis, full name in the button's name) and the IconButton
    `project-tile-more` (MoreHorizontal, label "More actions for <name>"), in the tile's own grid, not over the text.
  - Status line, visible text: `projectStatus(...).subtitle` with its dot ("1 decision · 1 run", "1 open",
    "Last run 2h ago · Stopped"); with no runs "No runs yet". Setup not finished (`setupPending`): a warning Badge
    "Setup pending" beside it.
  - Folder: `folderName(path)` in mono caption, full path as the title (M1).
  - Newest run: its `runName`, one clamped line, caption style.
  - Foot: "4 roles" and the project's 7-day cost (`Cost`), both mono caption. No role initials (L1).
- Open: the whole tile is one native `button.project-tile-main` (stretched hit area over the tile body, below the
  More button in stacking), name "Open <name>, <folder>, <status line>". Runs `openProject(id)`, then focuses
  `main .topbar h1` (tabIndex -1) on the next frame (M3), as create already does.
- Grid keyboard: each tile is one Tab stop for Open plus one for More (no roving; tiles are few). Past 6 projects a
  search Input "Find a project" (`dash-project-search`) appears above the grid, filtering by name and folder.
- More popover (`Popover`, menu of buttons): "Open", "Open folder" (`project-tile-open-folder`;
  `window.orgai.app.openPath(project.path)`, which exists today; a returned error string shows as a danger caption in
  the tile, `project-tile-error`), separator, "Delete project…" (`project-tile-delete`, danger text).
- Delete confirm (`useConfirm`, danger, confirm label "Delete project"), title `Delete "<name>"?`, body built from
  `runsOfProject` (open = live or paused) and the merged summaries (all records):
  - open > 0 and runs > 0: "Ends 1 open run and deletes the history, transcripts and costs of 3 runs. Its project skills
    and saved service secrets go too. Files in its folder are untouched."
  - open = 0, runs > 0: "Deletes the history, transcripts and costs of 3 runs. Its project skills and saved service
    secrets go too. Files in its folder are untouched."
  - no runs: "Removes the project from OrgAI. Files in its folder are untouched."
  - Plurals: "1 open run" / "2 open runs", "1 run" / "3 runs".
  - After delete: focus the next tile's Open button, else the previous, else `new-project`; announce "Deleted <name>."

### 5.2 Usage (`dash-usage`)

- Source: `usageByConnection`, `connectionsInUse` (lib/usage.ts), `tightestWindow`, `UsageBar`, `SpendBar`,
  `spendText`. On mount call `refreshUsage()` when the newest report is older than 60 s (the UsageMeter rule; at most
  one call in flight). No timer while the page is open.
- One row per connection in use (`dash-usage-row[data-connection]`): `CONNECTION_LABEL` name, then the tightest window
  "5-hour window · 62%" with `UsageBar` (warning from 80%, danger when limited); LiteLLM shows `spendText` with
  `SpendBar`; an API-key connection says "Billed per token. No plan windows."; no report yet: "No usage reported yet."
- The section has no button of its own; the full window list stays in the sidebar account popover.

### 5.3 Cost, last 7 days (`dash-cost`)

- Heading "Cost, last 7 days". Source: merged summaries of every project (virtual ones too) with `startedAt` in the
  last 7 days, `sumCosts(runCostInput)` then `costView` and `Cost`: unknown is never $0, a partial sum shows "$0.42+".
- Figure in `--font-mono` at `--text-title-lg`; below, the top three projects by cost as caption rows (name, `Cost`).
- Caption: "From the runs OrgAI keeps." Empty (no runs in 7 days): "No runs in the last 7 days."

### 5.4 Connections (`dash-connections`)

- Source: `connections`, `defaultConnection` (call `loadDefaultConnection()` on mount when null).
- Row 1: "Default: Claude" with `ConnectionStatusBadge`. Then every in-use connection whose status is 'error' or
  'disconnected' (`dash-connection-problem[data-connection]`): "Codex is not connected. 2 projects use it."
- One link button "Connection settings" (`dash-connections-settings`): `requestAppSettingsSection(connections)` then
  `setView('appSettings')`.
- Loading (null list): "Checking connections…".

## 6. Start paths

### 6.1 New project with projects present (M5)

- `new-project` opens the existing `NewProjectForm` inside `Dialog` (size 'lg', title "New project",
  `testId new-project-dialog`). The form drops its own h2 and moves Cancel into its submit row as a secondary Button
  (one primary: the submit). Esc and the close button cancel. Every form testid and behaviour from review section C is
  unchanged, including `parkedDraft`: returning from App settings with a parked draft reopens the dialog.
- Close or Cancel returns focus to `new-project` (Dialog restores the opener). Create focuses the new project's h1.

### 6.2 First launch, no projects (M4)

- The hero shows "Welcome to OrgAI" (compact). Under it, no attention column, projects or facts.
- A path choice as a native radio group (`dash-start-choice`, legend "How do you want to start?"), two large option
  cards side by side (stacked under 600 px): "Start a project" ("The Architect sets up a team of agents for an idea or
  a repository.") and "Chat now" ("Ask a question or hand over a task without making a project.").
  "Start a project" is checked by default. This group is the first Tab stop in main; arrows switch.
- Below it, one panel: with "Start a project" the form inline (not a dialog), its submit the only primary; with
  "Chat now" one primary Button "Chat now" (`empty-chat-now`, `openNewChat()`).
- Topbar shows no New project / New chat buttons on first launch.

## 7. Keyboard order and focus

Topbar (h1, then New chat, New project) -> hero (no stops) -> Needs you rows -> Running rows -> Since header button,
rows and Continue buttons -> Paused rows and Resume now -> project search -> tiles (Open, More, in order) -> Usage ->
Cost -> Connections link. DOM order equals visual order at every width. Every stop has the `:focus-visible` ring;
rows and tiles keep it inside their radius. When a row disappears under focus (decision answered elsewhere, run
ended), focus moves to the next row in the section, else the section heading (tabIndex -1).

## 8. Styling notes

- Both themes, tokens only. Mono (`--font-mono`, `--text-mono`) for every number: counts, costs, percentages, times.
- Status colour always beside its word (dots use `--state-working`, `--state-waiting`, `--state-done`,
  `--state-error`, `--state-idle`).
- Section headings plain sentence case, no uppercase micro-labels. Fact cards on `--surface-1` with `--elev-1`.
- The Dashboard is the one page with the brand gradient in content (hero edge and mark); nothing else gains it.

## 9. Test ids

Kept: `new-project`, `projects-new-chat`, `empty-chat-now`, `architect-setup`, `use-mock`, `setup-choice`,
`agents-found`, `already-project`, `new-project-connection`, `new-project-connection-change`.

New: `dashboard` (region root), `dashboard-hero`, `dashboard-figure`, `dashboard-live`, `dashboard-app-facts`,
`dash-needs-you`, `dash-needs-row[data-kind]`, `dash-running`, `dash-running-row`, `dash-since`,
`dash-since-row[data-status]`, `dash-since-continue`, `dash-since-clear`, `dash-paused`, `dash-paused-row`,
`dash-paused-resume`, `dash-projects`, `dash-project-search`, `project-tile[data-name]`, `project-tile-more`,
`project-tile-open-folder`, `project-tile-delete`, `project-tile-error`, `dash-usage`,
`dash-usage-row[data-connection]`, `dash-cost`, `dash-connections`, `dash-connection-problem[data-connection]`,
`dash-connections-settings`, `new-project-dialog`, `dash-start-choice`, `nav-dashboard` (sidebar item).

Removed: `.project-card` hooks.

## 10. e2e impact

- `e2e/lib.mjs`: `gotoProjects` clicks `nav-dashboard` and waits for `[data-testid=dashboard]`; `createProject` opens
  `new-project` and fills the form inside `new-project-dialog` (first launch: the inline form); `deleteProject` opens
  `project-tile[data-name=…] project-tile-more`, clicks `project-tile-delete`, confirms "Delete project".
- `layout.mjs`, `import.mjs`, `assistants.mjs`: replace "Projects" / "All projects" text matches and `.project-card`.
- New checks (mock): with a permission card open, `dash-needs-row` count equals the bell's decision count and the row
  opens the card; the waiting project's tile is first and its status line reads "1 decision · 1 run"; after a
  relaunch `dash-since-row[data-status]` shows "Ended when OrgAI closed" and the waiting run has
  `dash-since-continue`; Enter on a tile leaves focus on `main .topbar h1`; Escape on `new-project-dialog` leaves focus
  on `new-project`; at 1024x640 `dash-needs-you` is inside the viewport; both themes at both sizes.

## 11. Decisions and open items

- No new contract. Not built here (need main changes, review section B): run outcome summaries, cut-card details,
  team suggestion counts, cross-project usage IPC, branches waiting, connectors needing sign-in.
- `app:openPath` in main takes any path unvalidated; the Dashboard passes only a stored `project.path`. Flag for the
  Reviewer; tightening it is a main-process change.
- Costs and the Since list cover only the summaries the renderer holds (`loadAllHistory`), trimmed by runs-to-keep.
