# Canvas toolbar declutter (live run view)

Owner, 2026-11-24: "top toolbar on a run in the canvas is also very cluttered. need to find some ways to remove that clutter".
This is the design that came out of looking at it, what was built, and what is left for the owner. Renderer only: no
shared contract, main-process, adapter or dependency change.

## What was looked at

Built app on the mock adapter (token-free, throwaway data dir), org chart scene unless noted:

- Runs of 1 agent, 9 agents (root and 8, with a four-step plan) and 41 agents (root and 40, the mock's maximum).
- Pocket Office and Factory floor with the 9-agent run.
- Dock open, hidden (the user's Hide), and the widest and narrowest dock the handle allows (frame 280 px to 688 px at a
  1024 window); the rail state is covered by `e2e/run-hold.mjs`.
- 1600x1000 and 1024x640, dark and light (light on the 9-agent run).
- A sweep of nine window sizes from 760 to 1450 px wide (the window's own minimum clamps the narrowest), each with the dock
  open and hidden: no clipped control, status chip always shown.

Screenshots (in `e2e/shots/`, gitignored; written by a throwaway script, not kept): `toolbar-before-a8-<w>-<dock>-<theme>-graph.png`,
`toolbar-after-a8-<w>-<dock>-<theme>-graph.png`, `toolbar-after-a8-<w>-<dock>-<theme>-menu-top.png` (View menu closed to its
rows) and `-menu.png` (with the legend open), the same for `a1` (one agent), `a40` and the two scenes (`-pocket-office`,
`-factory-floor`).

## The clutter, measured

The row (32 px, `.frame-toolbar-dense`) held the run header's chips and then, at 1600x1000 with the dock open (frame 985 px):
Theme (115 px, a word, a swatch, a name and a chevron), Find an agent (115 px, text), Hide finished agents (a 32 px switch and
a 130 px label), Zoom out, Zoom in, Fit, Canvas style (109 px, text), the legend "?" and the layout speech bubble. With the dock
hidden it gained the filter (205 px) and a "Conversation" button, which sat beside the layout toggle: **two buttons with the same
speech-bubble icon** (polish finding F12). Different kinds sat side by side with no order: scene, filter, switch, zoom, style
picker, help. At a 688 px frame the Theme button was cut at the right edge. Width was handled with six container queries that
hid things one by one with nothing to say where they went.

## Inventory: before and after

"Row" is the 32 px toolbar; "View" is the new menu. Every control keeps its function, its keyboard path and its test id.

| Control | Test id / name | Before | After |
| --- | --- | --- | --- |
| Run chips (status, cost, permission, more) | `run-meta`, `run-meta-more` | row, start, folds by priority | unchanged (`RunMeta`, `lib/runMetaFold.ts`; status never folds) |
| Scene switch | `canvas-theme-trigger` | row: "Theme", swatch, name, chevron, 115 to 179 px | row: swatch, name, chevron, 128 px (swatch only in a narrow row); named "Canvas theme: Org chart" |
| Find an agent | `find-agent` | row, text button 115 px, from 900 px of frame | row, icon button 28 px, only with more than 5 agents; in View when the row is very narrow |
| Show filter (All / Working / Waiting) | `agent-filter` | row, from 1100 px of frame, whenever there were 2 agents | row only from a 1100 px frame and with more than 5 agents; otherwise a row of View |
| Zoom out, Zoom in | `Zoom out`, `Zoom in` | row | row from a 1100 px frame; otherwise rows of View (wheel, pinch and the application menu zoom too) |
| Fit to view | `Fit to view` | row | row (always, org chart only) |
| Hide finished agents | switch "Hide finished agents" | row, switch and a 130 px label | row of View, same switch; `view-fold-row` / `view-fold-label` carry the label and the count |
| Canvas style (graph presets) | `canvas-style-button`, `canvas-style-popover`, `data-preset` | row, text button 109 px, its own popover | the View button's menu keeps both test ids; presets fold behind one "Canvas style" row (`canvas-style-disclosure`) |
| Legend | `canvas-legend-trigger`, `canvas-legend` | row, "?" icon, its own popover | a disclosure row of View, same two test ids |
| Scene palette (Pocket Office) | `canvas-scene-palette` | in the Canvas style popover | in the View menu, same place |
| Load earlier sessions (scenes) | button | row, scenes | unchanged |
| Conversation (show the hidden dock) | `dock-show` | row, text, dock hidden or rail | row, text; icon only (name kept, unread dot kept) when the row is narrow |
| Layout toggle ("Show conversation" / "Show agents") | `run-layout-toggle` | row, always | row, except while the dock is hidden or the rail shows: then a row of View with the same test id (the Conversation button is the one speech bubble) |
| Plan strip | `plan-strip` | frame footer, only with a plan | unchanged: not in the toolbar |
| Agents list | "Agents" tab of the dock | not in the toolbar | unchanged |
| Pause motion | `office-pause`, `factory-pause-motion` | inside the scene (Pocket Office message log head, Factory floor control row) | unchanged: scene-owned, not in the toolbar |

## Controls visible at rest (org chart, row only, run chips not counted)

Counted as individual buttons and switches; the Show filter is one group. Measured with the 9-agent run (plan on) in the
built app, before and after the change.

| Case | Before | After |
| --- | --- | --- |
| 9 agents, dock open, 1600x1000 (frame 985) | 9: scene, Find, Hide finished, Zoom out, Zoom in, Fit, Canvas style, legend, layout toggle | **5**: scene, Find, Fit, View, layout toggle |
| 9 agents, dock open, 1024x640 (frame 688) | 8: scene, Hide finished, Zoom x3, Canvas style, legend, layout toggle | **5**: same five |
| 9 agents, dock hidden, 1600x1000 (frame 1368) | 12: scene, Find, Show filter, Hide finished, Zoom x3, Canvas style, legend, Conversation, layout toggle | **8**: scene, Find, Show filter, Zoom x3, View, Conversation |
| 9 agents, dock hidden, 1024x640 (frame 968) | 9: scene, Hide finished, Zoom x3, Canvas style, legend, Conversation, layout toggle | **5**: scene, Find, Fit, View, Conversation |
| 1 agent, dock open, 1600x1000 | 8 | **4**: scene, Fit, View, layout toggle |
| 1 agent, dock open, 1024x640 | 7 | **4** |
| Pocket Office or Factory floor, dock hidden | 4: scene, Canvas style, Conversation, layout toggle | **3**: scene, View, Conversation |
| 41 agents, dock open, both sizes | (not measured before) | **5** |

Width of the controls the row itself draws at 1600x1000 with the dock open: about 640 px of text and icons before (the label of
Hide finished included) against about 280 px after.

No clipped or wrapped row in any state measured: `scrollWidth` equals `clientWidth` on the row, no control crosses the row's
edge, and the status chip is whole at every width of the sweep (1024x640 open, hidden and with the dock dragged to its widest;
the two window sizes in dark and light; the sweep above).

## The rules (in the order they were applied)

1. **Remove duplicates.** One speech bubble at a time: while the dock is hidden the Conversation button is the way to the
   feed and the full-width layout toggle moves into View (the polish finding F12). Find an agent duplicated the Agents tab for a
   run you can read at a glance, so it is drawn only with more than a handful (5) of agents.
2. **Draw a control only when it applies.** Find and the Show filter: more than 5 agents (the whole run, earlier sessions
   included). Hide finished agents: only when there is more than one agent or an earlier session (unchanged), and then in the
   menu. Zoom, Fit, legend, Hide finished: the org chart only (unchanged). Nothing canvas-related in the one-agent view
   (AgentFocus) or the conversation layout; they did nothing there. The plan strip only with a plan (unchanged).
3. **Group the rare options in one View menu.** Hide finished agents, the legend, the graph styles, and what the row cannot
   hold at its width (filter, zoom steps, Find, the layout toggle) are rows of one popover. The View button is one control: a
   sliders icon and the word "View" (the word goes in a narrow row; the name "View options" stays).
4. **A small set of primary controls, in a fixed order.** Left, after the run chips, is what is on the stage: the scene switch,
   Find, the Show filter. Right is how it is looked at: zoom and Fit, View, then (after one separator) the conversation button.
5. **Icons with tooltips where the icon is plain** (Find, zoom, Fit, layout toggle; the scene button and View keep a word while
   there is room). Every icon button has its name and `title`.
6. **One height and one separator.** Every control is 28 px (`--control-sm`; 24 px in compact density) and one separator style
   (`.toolbar-sep`, 1 px, between the view group and the conversation group). The Theme button was 36 px tall and the Show
   filter 40 px in a 32 px row; both are 28 now.
7. **The row never clips a control.** `lib/canvasToolbar.ts` picks, from the frame's width and the controls that apply, the
   richest form that leaves the run chips their floor (256 px from 800 px of frame, 150 below). A control loses its word first,
   then moves into View; the order is in `planToolbar`. This replaced six container queries that hid things with no home.
8. **Nothing becomes unreachable.** Every control is in the row or in View (a unit test checks the two sets are disjoint and
   cover every control that applies, at ten frame widths, three run sizes and both dock states). The one exception was already there: under 320 px of frame the scene
   switch and View hide and the scene is set in App settings > Canvas.

How it behaves, so it can be checked: the View button opens a popover on the native `popover` attribute (the shared `Popover`);
Escape closes it and focus returns to the button; focus enters on its first row, never on a preset that would scroll the rows
out of sight; it does not take focus from anything on its own. Reduced motion and Pause motion are untouched (no new motion;
the popover keeps its existing enter and exit).

## What was not done

- **Pause motion** stays in the scenes (Pocket Office log head, Factory floor control row). It is not in the top toolbar, and
  both scenes' scripts and units test it where it is. Moving it into View would touch two scene owners' work; see the owner
  decisions.
- **The run chips** (`RunMeta`) and their fold rules are untouched; the row beside them was changed to leave their floor.
- **The sidebar, run header "more" menu, plan strip, tray and dock** are untouched.
- **The Team toolbar** keeps its own Canvas style button (`CanvasStyleButton` is unchanged for it; it shares `StylePanel`).
- **Scene-internal controls** (Pocket Office Find, Show and zoom; Factory floor Find, zoom and Pause motion) were not moved.
- **Forced colours** was not looked at. The large text size with compact density was measured at 1024x640 (9 agents, dock
  open and hidden): the row does not clip (controls 24 px tall in compact density, scene button 133 px).
- **No new dependency, no shared type, no IPC, no main change.**

## Owner decisions

1. **Zoom out / Zoom in only from a 1100 px frame.** Below that, Fit is in the row and the two steps are in View (and on the
   wheel, a pinch and the application menu, which the row never replaced). *Recommend keep.* The alternative is the three
   buttons everywhere, which costs 56 px and one control at every dock-open window size.
2. **Find and the Show filter only with more than 5 agents.** A run you can read at a glance has nothing to find. *Recommend
   keep*; 8 is the other sensible number (the constant is `AGENT_HANDFUL`).
3. **Hide finished agents lives in the View menu.** The folded group node ("3 done") already says something is hidden, and
   the count is in the menu row. *Recommend keep.* Option: a count dot on the View button while something is hidden (not built:
   it would make the View button a status control).
4. **One speech bubble while the dock is hidden.** The full-width layout toggle moves into View ("Show conversation in the
   stage"). *Recommend keep.* Option: drop the layout toggle's separate role and fold it into a split Conversation button.
5. **The "Theme" word is gone from the scene button** (it showed "Theme Org chart"). The button reads as the scene; its
   accessible name is "Canvas theme: Org chart". *Recommend keep.* Option: rename the menu "Scene" throughout (settings
   section, test ids stay).
6. **The seven graph styles fold behind a "Canvas style" row** (one extra click) so the menu is 310 px tall instead of 450 and
   does not cover the minimap at 1024x640. *Recommend keep.* Option: always open, scrolling at 640 px.
7. **Pause motion in scenes.** Option: a "Pause motion" row in View for the scenes, with the buttons in the scenes removed.
   *Recommend leave*: a scene's own control row is where its motion is seen.
8. **The legend is a disclosure row inside View**, not its own "?" button. *Recommend keep*; a "?" that nobody opens twice does
   not earn 28 px of the row.
9. **Under 320 px of frame the scene switch and View hide** (as the theme group did). Option: keep View and drop the scene
   switch only. Not a real width at the supported window sizes (the narrowest measured frame was 280 px with the dock dragged to
   its widest).

## Where it is

- `src/renderer/src/lib/canvasToolbar.ts` (+ `.test.ts`): the plan, pure.
- `src/renderer/src/components/canvas/CanvasViewMenu.tsx` (new), `CanvasLegend.tsx` (new), `CanvasStyleButton.tsx`
  (`StylePanel` exported with `lead`, `tail`, `foldStyles`), `CanvasThemeMenu.tsx` (`compact`, a name that says the scene).
- `src/renderer/src/views/LiveRunView.tsx`: renders the plan; `CanvasTools` became `CanvasZoom`.
- `src/renderer/src/styles/canvas-chrome.css`, `layout.css`, `run-header.css` (comment).
- e2e: `e2e/lib.mjs` (`openViewMenu`; `showFinishedAgents` goes through it), `canvas.mjs`, `layout.mjs`, `runs.mjs`,
  `proposals.mjs`, `run-hold.mjs` (a seven-agent run for Find), `pocket-office.mjs`.
