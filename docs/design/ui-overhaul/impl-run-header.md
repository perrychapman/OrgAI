# Run header: implementation notes

Boards: Run, RunLight, Scale, Engagement. Code: `RunTabs`, `RunMeta`, `RunActions`, `FinishedList`, `DoneGroupNode`,
`styles/run-tabs.css` (strip, tabs, actions) and `styles/run-header.css` (chips, fold menu, finished list).

## Built

- **Strip.** Glass (`--glass`, blur, `--glass-line`). The selected tab is `--glass-strong`; its title is the run title in
  the display font (serif and a coral accent bar on engagement runs, found with `.run-workspace:has(.run-view[data-kind='engagement'])`
  because the strip sits above the view root). The strip is a stacking context now, so it takes `z-index: var(--z-popover)`
  to keep the "+n" menu above the panel. Tab dots: working is cyan (`--working`, pulse stops under reduced motion and
  Pause motion), done green, waiting amber, failed red; the word stays in each tab's accessible name. Keyboard behaviour is untouched.
- **Chips (RunMeta).** Status chip first (dot and word, `data-testid=run-meta-status`, pulse `motion-pulse`, waiting
  `motion-breathe`), then agents, cost (unknown reads "Cost unknown", never `$0`), time, files ("N files"), permission,
  model (friendly label, exact id in the title and for screen readers), plan steps and the rest.
- **Fold.** Chips that do not fit fold into a "more" menu (`data-testid=run-meta-more`) instead of being cut. `data-prio`
  says what goes first (highest number); status never folds. Folded chips stay in the DOM, and the menu buttons call the
  original button, so every control is still reachable. This replaces the container-query drops in layout.css, outputs.css
  and run.css, which `run-header.css` switches off with higher specificity.
- **Actions.** Interrupt turn (secondary), End session (quiet: ghost, danger text, a hairline before it, still words
  in a narrow strip), Save as project and Org retrospective (the first of them is primary once the session ended).
  All four remain, names and test ids unchanged.
- **FinishedList / DoneGroupNode.** Glass rows; the done and failed badges carry an icon as well as colour.

## Deviations

- The title is the selected tab's name (14 px display), not a separate 17 px heading: the board's heading row does not exist
  in the app (tabs hold run names). Project name, kind chip and section nav are the app shell's.
- The model chip repeats `LiveModelSwitch`; the chip is read-only.
- At 1600 px with the dock open the toolbar shares its row with the canvas chrome, so the chips get about 340 px and
  model, time and permission fold; they are all in the "more" menu.
- The board's "Pause" and "End run" map to Interrupt turn and End session.

## Not verified

Screen reader speech, a run with many chips folded (staffing, recorded, revision, schedule together), forced colors.
