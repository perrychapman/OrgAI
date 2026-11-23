# UI overhaul: data views implementation notes

Lead: ov-data. Boards: Files, Knowledge, Usage, History, Schedules; To-dos (no board) in the same look.
Status: in progress (this file is updated as each piece lands).

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

Deviations:
- Run now, Edit, Delete and History stay on the row, not in the detail panel: e2e and the context menu expect them there.
- The weekly cost and the last-runs bars wait for the runtime contract (below).

## To-dos (no board)

- Glass add panel and rows, a display-font title, and open/done count badges.
- Done rows get a green edge and tick.
- Markup and test ids are unchanged.
