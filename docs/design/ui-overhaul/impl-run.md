# Run view: implementation notes

What `views/LiveRunView.tsx` now mounts from the overhaul boards (Run, Scale, RunHold, Agent, Engagement), what differs
from the boards, and how it was checked.

## Built, per board

- **Run (dock).** The run panel (`SidePanel`, label "run panel", persisted open/closed and width under `run`) is the
  conversation dock: at most about 400 px by default, collapses to a rail, and the choice is remembered. With nothing
  selected it shows the root conversation (`TranscriptPanel fallback`, titled "Conversation"). The composer region
  (settings row with `LiveModelSwitch`, composer) is unchanged and stays mounted under the canvas, so
  `e2e/model-switch.mjs` still holds. Decisions stay in the tray under the stage.
- **Theme dropdown.** `CanvasThemeMenu` replaces the presentation radio group (same `saveCanvas` setting).
  `CanvasStyleButton` is mounted with `withPresentation={false}`. Live only; scenes keep their own Find and filter, so
  the org chart Show filter, "Find an agent" and "Hide finished agents" render on the org chart only.
- **Scale.** `AgentFilter` (All / Working / Waiting, with counts) dims the other nodes (`.node-dim`, 0.35 opacity, never
  hidden); "Find an agent" opens the Agents tab (`openAgentFinder`), which holds the search, sort and flat `AgentList`.
  Groups and folds are the existing finished-agent folds.
- **Plan strip and chrome.** `PlanStrip` sits in `FrameFooter` under the stage when the run has a plan. Minimap, legend and
  zoom are unchanged. Reporting edges carry `edge-done` / `edge-live`.
- **RunHold.** `RunHoldCard` replaces the pause banner, the plan-blocked banner and the run-error banner (it keeps the
  `pause-banner`, `plan-blocked-banner` classes and `run-error` test id). Add budget and Skip review now ask through a
  confirmation that names the amount or the gate being skipped (focus starts on Cancel, so a held Enter never
  confirms); every action shares one in-flight guard against double activation and key repeat; refusals from main show
  inline in the card. "Use another model" focuses the model switch in the composer.
- **Agent.** `AgentFocus` takes the stage (org chart layout) from "Open agent view" in the run panel or a double click on a
  node. Escape or "Back to chart" closes it and focus returns to the opener (found again by test id when it re-mounted).
- **Engagement.** `.run-view[data-kind='engagement']`: serif headings, coral selection and plan accents, neutral wording.
  No Context screen, no per-run source picker.
- **Toolbar fit.** The chrome (Theme, Find, Show) shares the 32 px dense toolbar row; it drops Show under 900 px of frame
  width, Find and the "Theme" word under 680, the theme name under 520, and hides under 320 (the theme is then set in
  App settings > Canvas).
- **Owed fixes.** Composer Enter guard and one-shot New run mode were already on dev. RunActions copy already used the
  current pane names. Usage kind names now read "Tools helper" and "Skills helper".

## Deviations

- The dock is the existing right-hand panel, not a floating card; the composer is still under the canvas, not inside the
  dock. Moving it into the dock whenever the panel is open (generalising the wide-panel rule) is not built.
- A "Conversation" button on the toolbar when the dock is hidden is not added: the panel's rail has "Show run panel".
- The hold card is tall in a 1024x640 window; the tray scrolls and the action row is sticky.
- The org chart is still the existing React Flow node chart, not the board's department boxes.

## Verified

`e2e/runs.mjs`, `canvas.mjs` (Theme menu guard removed), `live-changes.mjs`, `model-switch.mjs`, `run-start.mjs`,
`pocket-office.mjs`, `office.mjs`, `factory-floor.mjs` and the new `e2e/run-hold.mjs` (provider-error hold card, model
switch stays mounted, one-agent view opens and Escape returns focus, screenshots in both themes) pass on the mock adapter.
Screenshots of the hold card and the one-agent view were looked at in dark and light.

## Open

- `[mock:budget-stop]` needs a project spending cap; the add-budget confirmation is covered by code, not by an e2e run.
- Screen reader speech and a large-run (120 agents) look were not checked.
- Reviewer pass on hold actions, dock and focus handling: see the hand-back report.
