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
- **Corrected fold order.** Facts fold first, then chips that hold a button (still reachable from the "more" menu with the same
  test id), and the permission mode shortens to its icon (it never folds) before cost folds; status never folds. Transitions
  are off on the meta row because measuring mid-transition broke the fold. See "Looked at" and `useMetaFold` in `RunMeta.tsx`.
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

## Looked at (2026-11-23, ui-engineer-run-a)

Driven on the mock adapter with a throwaway data dir, 1024x640 and 1600x1000, dark and light, screenshots opened and read
(`e2e/shots/look-*`, not committed). Runs: `[mock:exec-slow]` (running), `[mock:fatigue]` (needs you),
`[mock:provider-error]` (failed), `[mock:no-price]` (cost unknown), an ended run (stopped), `[mock:budget-stop]` with a
project cap, `[mock:staffing]` and `[mock:factory-floor]` (40 agents).

- **Project header (shell).** At 1024 with the sidebar expanded (main pane 792 px) the name, kind chip, section tabs and
  Settings button did not fit: the chip shrank to 18 px with its text spilling over the tabs, and the Settings button went
  past the window edge. Now: the name shrinks (64 to 220 px, ellipsis, full name as title), the folder pill hides under
  1100 px of pane, the chip is the icon alone under 900 px (its title is "Engagement . client" or "Code project", and the words stay
  in the accessibility tree) and clips with `overflow: hidden` otherwise. `e2e/layout.mjs` checks no overlap, nothing past the
  topbar and the strip under the topbar at both sizes and in a 792 px pane.
- **Status chip.** Running is cyan, the pulse ring is on the dot's `::after` and runs only while working; Needs you is amber
  and breathes; Failed red, Stopped and Idle grey, all dot plus word. Reduced motion: no animation (checked).
- **Cost.** Chips fold from the least useful end; cost folds after everything except status and the permission mode; the mode shortens to an icon before cost folds and never folds itself (corrected: this line said cost folds "second to last"), status never.
  The toolbar row keeps 256 px for them (the theme name and the Show filter give way first). A long status word ("Stopped at its
  budget limit") shortens to an ellipsis before cost folds. "Cost unknown" shows for an unpriced run.
- **More menu.** Enter opens it, the first item takes focus, Escape closes it and focus returns to the button.
- **Dock open at 1600.** Running, time, cost and agents show, the rest sits in the menu (1024 with the dock: status and cost).
- **Engagement run.** The `:has()` rule matches (the coral bar and the serif title are on the selected tab; the serif shows in
  the panel headings). The selected agent card kept the violet ring (the existing rule hit the React Flow wrapper, which has no
  border); `run-header.css` now draws it in `--eng`. The coral plan strip segment is only visible while a step is in progress and was
  not seen.
- **Scale.** The mock cannot start 121 agents (`[mock:factory-floor]` is 40: 3 leads, 9 sub-leads, 27 workers). At 1600 the chart,
  Show filter hidden under 1100 px of frame, Find an agent clipped to a letter when the "Hide finished agents" switch is on (now the
  theme name hides at 1000 px, which gives it room), flat Agents tab "Showing 40 of 40". Minimap did not render in either size; the
  folded finished groups were not on screen in this run.
