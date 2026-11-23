# UI overhaul: data views implementation notes

Lead: ov-data. Boards: Files, Knowledge, Usage, History, Schedules; To-dos (no board) in the same look.
Status: built; corrected against the code on dev 2026-11-23 (the corrections are marked "Corrected"). Unverified: screen
reader speech, macOS and Linux, real data volumes, both themes and both sizes by eye for every screen.

## Files (`Files.dc.html` -> `views/OutputsView.tsx`, `components/outputs/`)

Built:
- Glass panels over the ambient ground. The heading reads "Files" in `--font-display`.
- Filter row: glass search, then the run select and the count, then the kind chips. Pressed chips are violet, and several can be pressed.
- Rows and cards are glass tiles (`--radius-xl`). The shown item gets `--accent-soft` and an `--accent` edge.
- Preview pane: one glass panel; the preview "paper" is `--glass-strong`.
- Version rows are tiles; the current version is violet.
- The revision line is cyan (`--working-soft`) while pending and green once answered.
- The run side tab body (`RunOutputs`) uses the same tiles.
- Listbox names read "Files". The empty, no-match and pick copy say "files".
- The project tab label "Files" is ov-shell's change (testId `tab-outputs` kept). The run side tab is ov-run's (testId `side-tab-outputs` kept).
- Sort ("Newest first" on the board): a native select named "Sort files" (`outputs-sort`).
  - Options: Newest first, Oldest first, Name A to Z, By kind.
  - Kept per project in `localStorage['orgai.outputsSort.<projectId>']`.
  - List headings follow the order: days, kinds, or one "A to Z" group.
  - Pure helpers `sortOutputs`, `outputGroups` and `readSortMode` in `lib/outputsList.ts`, unit tested.

Deviations:
- No rise-in on first paint and no hover lift. App rules: first paint never animates, and hover changes colour only. The only motion is a 100 ms colour/border transition, which reduced motion and Pause motion stop.
- The default view stays List. The board draws Grid, but the saved per-project choice and e2e/outputs.mjs (which waits for `outputs-list` after opening the tab in many places) assume List. Grid is one click away and is remembered per project.
- The board's Open / Ask the team to revise / Add a note button row maps to the existing detail toolbar. Its lead action and More menu (docs/design/outputs-2.md section 7) already offer all three. A second set would duplicate test ids and keyboard stops.
- The "Show" heading is visually hidden but the search landmark keeps its name. The "Kind" and "Run" labels are visually hidden but still name their controls.
- Rows have no backdrop blur, only the translucent fill, so long lists stay cheap.
- Counts and notices say "files" (`outputsCountLabel`: "5 files"). This also reaches the RunMeta chip, the run side tab count and the History row chip. Internal names, test ids and the `outputs` view id are unchanged.

## Usage (`Usage.dc.html` -> `views/UsageView.tsx`, `components/usage/`, `UsagePanel`, `UsageMeter`)

Built:
- Every usage panel is a glass card (`--radius-xl`). The Pacing hero keeps its aura. The KPI band is one glass card with display-font figures.
- The sticky filter bar is open at the top and turns glass once the page scrolls.
- Daily spend is stacked bars, one per day, with rounded tops and a 2 px minimum.
  - The hovered or focused day gets a cyan wash, and a readout beside the legend gives day, cost and runs.
  - Kept: the Tab stop, `aria-valuetext`, Home/End/Enter/Escape, day narrowing, not-priced hatching and the lower-bound lane, legend toggles, the Compare overlay and Table.
- "Where it went" (Project | Model | Role | Connection) is a segmented switch with the same tablist semantics. Ranked bars sit on a sunk track.
- Run results use a new `RunStatusMark`, a dot plus a word:
  - cyan: running;
  - green: finished;
  - amber: stopped at budget or by policy, or needs you;
  - red: failed.
  - The dot pulses only under motion.
  - All runs gains a "Result" column.
- The run Usage tab (`UsagePanel`) and the sidebar meter (`UsageMeter`) get sunk stat wells and an accent meter fill. Neither has prop changes.

Deviations:
- No plan-limit donuts; the existing Pacing and plan gauges cover them.
- Pacing and KPIs stay as separate bands above the spend panel, because the KPI band selects the chart's metric.
- The day readout is plain text, not a live region: the page keeps one polite region.
- The Compare line still draws at bar centres.
- Board-only figures with no data behind them (plan "resets in" wording on the page) are not drawn.

## Schedules (`Schedules.dc.html` -> `views/SchedulesView.tsx`, `components/schedules/`)

Built:
- Header: "N on · next run <day time>", including the "all paused" and "nothing due" cases.
- Week strip, Monday to Sunday:
  - today is highlighted;
  - time chips are computed from each schedule's own rule, at most 3 a day, then "+n more";
  - turned-off schedules are faded;
  - the strip scrolls sideways under 720 px.
  - Pure logic is in `lib/schedulesBoard.ts`, unit tested.
- Rows:
  - glass, with a colour stripe from the chart tokens;
  - when and who, next run or "Turned off", and the last outcome dot;
  - the shared `Switch`, named "<name>, on/off" (testid `schedule-toggle` kept), replaces Pause/Resume. The context menu still has Pause/Resume.
- Detail panel (read-only): task text and facts When / Who / If it needs you / May change files / Spending limit, from real `Schedule` fields, plus a last-result note.

- Corrected: the weekly cost and the last-runs bars are built. `ScheduleDetail.tsx` shows a "Weekly cost" fact and the last
  runs from `runInsights.scheduleCosts` and `runInsights.scheduleHistory` (the peek channel, which does not clear
  `unread`); the page header shows a weekly total. Loading and failed read "Weekly cost…" / "Weekly cost unavailable";
  unknown stays unknown, never $0 (`useScheduleInsights`).

Deviations:
- Run now, Edit, Delete and History stay on the row, not in the detail panel: e2e and the context menu expect them there.
- "Let schedules run when I am near the limit" is not drawn: `Project.schedulesNearPlanLimit` is stored but main does not
  skip scheduled runs near the plan limit (owner decision, STATUS.md).

## Run history (`History.dc.html` -> `components/RunHistory.tsx`, `components/history/`, `lib/runHistory.ts`, `styles/history.css`)

Built, by what the data says:
- Row agent strip (agents column, newest session of the conversation): one mark per agent from its final state, at most 16, plus "N failed" in words when any failed. The record comes from the store when it holds the agents, else from `runs.get`, fetched only once the row has been on screen (IntersectionObserver), three at a time, cached per run, status and end time (`useAgentStrip.ts`). Present: strip. Loading: "Checking agents…". Fetch failed: "Agents not loaded". No agents recorded: nothing drawn. The count above it stays "–" (unknown) when `usage` is missing.
- "Scheduled" badge on a row when any session carries `scheduleId` (its name in the tooltip); "Open the schedule" in the detail is unchanged.
- Row result line gains the merge words from the recorded worktrees ("Merged · 3 files changed", "Kept, not merged", "Merge needs you") for ended runs only.
- "What it left": merge lines from `agents[].worktree` status and `changedFiles` (copies merged, kept, could not merge by itself, still being worked on, then up to 5 file paths). Loading: "Checking what was merged…"; failed: "What was merged could not be loaded."; nothing recorded: "No merge was recorded for this run." Registered files (outputs) stay below as before.
- "Try again" on a failed conversation (newest session `error`, project on screen): the first press only opens an inline confirmation naming the project and the request; its own "Yes, try again" calls `runActions.retry({ runId })`. Enter acts on key-up (repeat ignored), a ref guard stops a double activation, Cancel takes the first focus, and a refusal is shown inline (`role="alert"`). On success the new run is opened.

Deviations and unknowns:
- Per-file added/removed counts and step durations are not recorded: none are shown, never "0".
- "Undo the merge" is not built (owner decision) and not drawn. Corrected: "Delete the branch" now exists in main
  (`maintenanceExtra.deleteBranch`) and in Settings > Branches (`MaintenanceSection.tsx`); History still does not draw it.
- Corrected: `runs.retryRun` in main was a stub when this was built; it is real now (`RunManager.retryRun`, desktop only,
  `continueRun` with the harness's resume message and every check of it, behind `runActions.retry`). It has unit tests with
  fake adapters; a retry on a live provider is unverified, and the inline confirmation has not been re-driven end to end
  since.

## Knowledge (`Knowledge.dc.html` -> `components/knowledge/`, `lib/knowledgeLimit.ts`)

Built:
- Glass panels for the list, detail and graph note; `KindMark` draws each item's kind.
- Graph limit: above 75 drawn items (`CONNECTED_LIMIT_ABOVE`) the graph draws the 60 most connected (`CONNECTED_LIMIT`) and says "Showing the 60 most connected of N" (plus "and M you opened"); "Show all" draws everything and is kept as a per-project view preference. The list, search, filters and detail always keep every item. A graph at or under 75 says "Showing all N items" only when eligible, else nothing.
- Pure logic (`connectionDegrees`, `mostConnected`, `restrictGraph`, `limitNote`) is unit tested.
- Corrected: the board's "working line" is built. `KnowledgeView.tsx` renders `recording` (class `knowledge-live-text`) in its
  toolbar, from `lib/knowledgeRecording.ts` (`recordingNow(items, summaries)` and `recordingText`): "The team is working"
  while a run of this project is working, with " · N recorded in the current run" (or "the current runs") counting the
  agent-written items of working runs; nothing is shown with no working run. The earlier "not found" came from searching
  `components/knowledge` only; the line lives in the view and the lib. Unit tests: `knowledgeRecording.test.ts`.

Deviations:
- A local `KnowledgeChip` is used instead of the shared `Chip`.
- The List view keeps its filter column.
- "Recorded by" stays chips.
- No "Used N times" line (no usage count is recorded).

## To-dos (no board)

- Glass add panel and rows, a display-font title, and open/done count badges.
- Done rows get a green edge and tick.
- Markup and test ids are unchanged.

## Since the first pass (read on dev 2026-11-23)

- Files opens in Grid when no choice is saved (`readViewMode(null)` is `'grid'`); the saved per-project choice wins. The
  "default stays List" line above is out of date.
- Knowledge "Recorded by" is one exclusive choice, Everyone / You / Team (`KnowledgeFilters.tsx`; `knowledge-origin` and
  `data-origin` kept). The "stays chips" line above is out of date.
- History has "Run it again" (opens New run with the request) and "Try again" (continues a failed run, asks first), each with
  a line under it saying what it does.
- Home "Your week" reads "No prior data" when the week before holds no run, instead of growth from zero.
- The Inbox focuses its first row on arrival (J / K work) and its empty state names how many teams have a run going.
- Settings galleries scroll a detail panel that sits below the grid into view after a tile is picked (`revealAside`).
- Not re-walked after these fixes; screen reader, macOS and live providers unverified.
