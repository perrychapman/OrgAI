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
- **Toolbar fit.** The chrome (Theme, Find, Show) shares the 32 px dense toolbar row; it drops Show under 1100 px of frame
  width, Find and the "Theme" word under 900, the theme name under 700, and hides under 320 (the theme is then set in
  App settings > Canvas).
- **Owed fixes.** Composer Enter guard and one-shot New run mode were already on dev. RunActions copy already used the
  current pane names. Usage kind names now read "Tools helper" and "Skills helper".

## Deviations

- The dock is a right-hand column docked to the window edge (glass, rounded top-left), not the board's floating card with
  a gap all round: a margin would break the resize handle's width arithmetic. It holds the tabs, feed, settings row and composer.
- The hold card is tall in a 1024x640 window; the tray scrolls and the action row is sticky.
- The org chart is still the existing React Flow node chart, not the board's department boxes.

## Verified

`e2e/runs.mjs`, `canvas.mjs` (Theme menu guard removed), `live-changes.mjs`, `model-switch.mjs`, `run-start.mjs`,
`pocket-office.mjs`, `office.mjs`, `factory-floor.mjs` and the new `e2e/run-hold.mjs` (provider-error hold card, model
switch stays mounted, one-agent view opens and Escape returns focus, screenshots in both themes) pass on the mock adapter.
Screenshots of the hold card and the one-agent view were looked at in dark and light.

## Open

- Reduced motion for the dock is checked as end states only (hidden and shown at once); the column glide was not measured.
- Screen reader speech and a large-run (120 agents) look were not checked.
- Reviewer pass on hold actions, dock and focus handling: see the hand-back report.

## Dock rework (conversation dock)

- **Layout.** On canvas-layout runs `.run-body[data-dock]` is open, hidden or rail. Open: the composer region sits under the
  run panel in the right column and the canvas frame spans both rows. Chat, setup, Tools helper and Skills helper sessions
  keep their conversation-first layout (no panel). Engagement runs get the same dock in the coral look.
- **Hide and show.** The panel's Hide button hides it; focus goes to the toolbar's Conversation button (`dock-show`). That
  button shows the dock again: a keyboard activation moves focus to the composer, a mouse click does not. Anything that
  needs the composer or a tab (a decision answer, History's Continue, the plan strip, Find an agent) shows a hidden dock
  first. Everything stays mounted while hidden, so the draft, the model switch element, its pending state and the scroll
  position survive. The dock starts hidden under 900 px of run view width (was 1100); the saved choice
  (`orgai.sidePanel.run`) still wins. With no room at all (about 560 px) the old rail and the composer under the canvas return.
- **Unread.** An amber dot and "(new)" on the button for a root reply or a decision that arrived while hidden (run events).
- **Decisions.** The tray and hold card stay on the stage under the canvas, dock shown or not (the board draws the card in
  the dock; the tray is kept so a hidden dock never hides a decision). Compact tray threshold is now 570 px, since the
  composer no longer sits under the canvas.
- **Hold card.** One polite announcement through the frame announcer (once per hold, quiet on remount). "Try again" and
  "Continue" (a new provider turn, can spend) ask first, focus on Cancel, with the in-flight guard; "Resume now" is
  unchanged. The agent filter says "N of M agents shown".
- **Settings row** is one scrolling line in the dock so the feed keeps its height at 1024x640; the composer is cramped
  there (placeholder clipped).
- **Checks.** `e2e/run-hold.mjs` covers the dock (1024x640 and 1600x1000, focus, draft, reduced motion, newest message) and
  `[mock:budget-stop]` (cap set in Settings, Cancel, held Enter, inline refusal, confirmed amount). `e2e/runs.mjs` geometry
  now expects the composer in the dock at every width.
- **Not done.** No dock shortcut (`src/shared/view/shortcuts.ts` is not ours). Not checked: screen reader speech, 120 agents.
