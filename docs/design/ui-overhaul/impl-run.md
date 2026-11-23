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
  width, Find under 900, the "Theme" word under 680, the theme name under 520, and hides under 320 (the theme is then set in
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
  position survive. Only the user's own Hide hides the dock (saved as `orgai.sidePanel.run` = closed, kept across runs,
  windows and restarts); hiding also hides the composer and the settings row until the toolbar button brings them back.
- **Narrow fallback (layout rule as built).** `data-dock` is `open`, `hidden` (explicit Hide only) or `rail`. A run view under
  900 px with no saved choice (the SidePanel `autoAsRail` mode, reported as `auto`), or with no room at all (about 560 px),
  is `rail`: the 40 px rail with the panel's Show button, the composer with its settings row and `LiveModelSwitch` under the
  canvas, and the toolbar "Conversation" button, which opens the dock (and saves "open", an explicit choice). Nothing is
  saved by the width alone; the panel folds on window resizes only (measured 120 ms after the last resize, because the
  sidebar flips to its rail from the same resize event and a measure inside it saw the old width) and unfolds by itself
  when its grid grows past 900 px again. The composer region is the same mounted element in all three layouts (CSS only
  moves it), so the draft, focus and the model switch survive every transition. Measured on the mock: main window and run
  window at 1024x640 have a 968 px run view with the sidebar as a rail (dock open, canvas 688x552); with the sidebar
  expanded the run view is 793 px (rail layout, canvas 753x388 with a hold card, 752x422 without); at 1600x1000 the run
  view is 1368 px (dock open, canvas 985x912). No horizontal overflow in any of them; the hold card scrolls inside the
  tray above the composer.
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
- **Focus and decision cards.** A card that mounts while focus is in a text field outside it (input, textarea,
  contenteditable, the composer included, empty or not) no longer takes focus: the old rule only protected a non-empty
  field, and a Send empties the composer just before a permission card can arrive, so "Allow once" took focus under the
  Enter key. A card that mounts while a key is still held waits for the key-up and then takes focus only if focus is
  nowhere. The tray's announcement still says a decision is waiting; Tab, a click or the Needs-you jump reach it.
  `e2e/runs.mjs` ends with the check (type, Enter, `[mock:fatigue]` card: focus stays in the composer, nothing answered,
  Shift+Tab reaches the card; it fails on the old rule). The rule lives in `DecisionCard.tsx` (`typingElsewhere`).
- **The rule: no decision is ever answered by a key press that began before the card's action had focus.** Enter clicks a
  button on keydown and again on every key repeat, so any path that moves focus onto an answering button while a key is
  still down lets that key answer. Two paths exist and both go through one helper, `whenKeysReleased` (exported from
  `DecisionCard.tsx`, built on the key tracker in `lib/keysHeld.ts`): a card mounting (its own mount focus) and the
  Needs-you jump (`focusDecision` in `LiveRunView.tsx`: the sidebar and top bar buttons, Home's Waiting on you row, the
  engagement pill, the Inbox, Ctrl+. and Alt+D, the application menu). Under a held key focus rests on the tray region
  (named "Decisions", not a button, so the user sees where they landed); after the last key-up the primary button takes
  focus only if focus is nowhere or still on the opener or the tray (`focusIsFree`) and the user is not typing in a field
  outside the card (`typingElsewhere`). The Inbox `KeyGuard` covers keys inside the Inbox and is unchanged. Checks:
  `lib/keysHeld.test.ts`; `e2e/runs.mjs` (held Enter on the top bar's Needs you button: nothing answered, focus on the
  tray, the primary has focus only after key-up, a fresh Enter answers exactly that decision) and `e2e/dashboard.mjs` A12
  (the same from Home's Waiting on you row).
- **Review fixes (run view).** The header fold (`useMetaFold`) now settles once when its change guard trips, and the "more"
  menu lists the chips that are hidden by reading the line when it opens (`lib/runMetaFold.ts`), so a hidden chip is never
  missing from it; a compact permission chip (icon only) keeps the "more" button and the menu's first row says the mode in
  words. The agent message box sends Ctrl+Enter once (key repeats are swallowed, one send in flight). The command palette
  ignores Enter key repeats. "Resume now" asks first like "Try again" (focus on Cancel; `holdActionAsks` lists the actions
  that ask) and the hold card's buttons stay enabled while an action runs (`aria-disabled` and the in-flight ref, `aria-busy`
  on the row). The note under the header announces every kind once through the frame announcer (RunMeta), and Dismiss moves
  focus to the composer when it shows, else the stage. Retry agent (`runActions.retryAgent`) is not offered anywhere in the
  renderer: only the IPC channel, the preload and main exist, so it has no button to guard. `run-hold.css` and `run-header.css`
  keep a solid mark for the state dots in forced colours.
- **More checks.** `e2e/run-start.mjs` section 11 (fresh profile at 1024x640 shows the composer and settings row, the rail
  layout under 900 px, explicit Hide, the Conversation button, survival of a reload); `e2e/run-hold.mjs` (narrow fallback
  geometry, keyboard show from the rail, fold on resize, unfold when the sidebar collapses).
- **Not done.** `e2e/layout.mjs` still expects the run panel collapsed below 1100 px (stale since the dock rework; not ours).
  No dock shortcut (`src/shared/view/shortcuts.ts` is not ours). Not checked: screen reader speech, 120 agents.
