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
