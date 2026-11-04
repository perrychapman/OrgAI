# UX review: Canvas themes phase A (re-walk)

- Reviewer: UX Researcher (mock-data walkthrough, no code changes).
- Build: 41ed085 (dev, "Finish canvas themes phase A gate"), `npm run build`, mock adapter (`ORGAI_MOCK=1`), a fresh
  temp `ORGAI_DATA_DIR` per script.
- How it ran: the built Electron app driven by four scratch scripts on `e2e/lib.mjs` (`walk1.mjs` .. `walk4.mjs` beside
  the shots), content size 1024x640 and 1600x1000, dark and light, one keyboard pass at 1024x640 dark (settings,
  popover, canvas nodes). Runs: `[mock:deep-tree] build` (root -> mock-lead -> two reports, Hide finished on and off)
  and a custom mock script with two working reports and two agent messages (`worker-a` -> `worker-b`, `worker-b` ->
  main). No tokens, no smoke scripts.
- Compared with: `docs/design/canvas-themes.md` (phase A spec) and `docs/design/ux-review-canvas-themes.md` (walk at
  e788777).
- Screenshots: `e2e/shots/ux/canvas-themes-2/` (gitignored), numbered `01`-`126`; raw measurements in `walk1.json` ..
  `walk4.json`; stage-only crops `stage-<backdrop>-<theme>.png` and preview crops `preview-<backdrop>-<theme>.png`.
- Contrast numbers below were measured in the app: colours resolved with `getComputedStyle` inside each stage, edge
  opacity blended over `--canvas-bg`, WCAG 2 ratio.

## Verdict

MOSTLY FIXED. Both earlier Highs are fixed and every contrast target in the spec holds in the running app, in both
themes, on all nine backdrops. The canvas settings are now easy to find (2 clicks from anywhere with a canvas, 2 clicks
from the gear) and the keyboard model of the gallery and the popover is right. What matters most now is new: name tags
(Constellation's default) show only the role name, so three "Implementer" pills look identical and a keyboard user
cannot get to which agent is which (H1); and message edges, now drawn under the nodes, run behind the cards they join,
so a message between two reports shows as two stubs pointing away from each other (H2). Fix those two before phase B,
which adds two more compact node styles that inherit both problems.

## Status of earlier findings (ux-review-canvas-themes.md)

| Item | Status | Evidence |
| --- | --- | --- |
| H1 minimap draws no nodes | Fixed | Live: 4 shapes for 4 nodes, 2 for 2 with Hide finished on, both themes (53, 55, 56, 58); 1600: 4/4 (59). Team at 1600: 4 shapes for 4 roles (124). |
| H2 Team editor ignores settings | Fixed | Team follows backdrop, lines, name tags, minimap and Auto-layout per layout (88-107, 125). Ring guides are not drawn in Team radial (documented in the spec, section 10). |
| M1 settings hard to find, no preview | Fixed, with new issues (M2, M3) | "Canvas" is its own section right after Appearance; at 1024x640 its heading (y 302) and preview are visible on first open without scrolling (01). Live preview, gallery, Customise and a toolbar popover exist. Clicks: 2 (gear, pick) or 2 (palette, pick); was 4-5 plus scrolling. |
| M2 dots barely show | Fixed | Dots 1.71:1 dark, 1.59:1 light (spec 1.71 / 1.59). Every backdrop pattern is 1.43-2.02:1 (table below). |
| M3 light edges below 3:1 | Fixed | Lowest reporting line on the deep tree (finished, at done opacity): 4.64:1 light (Blueprint), 5.55:1 dark. Group edge 3.34-3.48:1 light, 3.56-4.08:1 dark. |
| M4 messages look like delegation | Partly fixed | Messages are dotted (`2px, 5px`, round caps) in `--edge-message` vs long dashes (`6px, 4px`) in the role colour, and the legend names both (54). But the line is mostly hidden behind the cards (H2), and the message blue `rgb(93,139,214)` sits close to the sky-blue role edge `rgb(71,185,253)` (L5). |
| M5 minimap crowds the stage at 1024x640 | Fixed | 167x125 in a 928x424 stage = 29% of its height (spec target <= 34%); legend and style popover land top-right, never on it (54, 79). 1600: 177x133. |
| L tint nearly invisible | Fixed | A visible wash at the top centre in both themes (`stage-tint-on-dark.png`, `-light.png`). |
| L grid shows through the done group | Fixed | The "3 done" pill is opaque on Starfield (75) and Dots (32). |
| L legend lacks Selected, group, edge types | Fixed | Eight entries: Working, Needs you, Finished, Failed, Selected, Folded finished agents, Reporting line, Message between agents (54, 57). The brief said nine; the spec and the app have eight. |
| L dashboard draws dots | Not re-checked | No dashboard canvas was walked. |
| L fit zoom 0.68 makes names 8.8 px | Open, slightly worse | At 1024x640 the deep tree fits at 0.64: names 8.3 px (33). Radial with cards and the side panel open: 0.43, names 5.6 px (72, see M4). |
| L focus and selection look alike | Partly fixed | Focus is now a 2 px accent outline at 3 px offset, selection a role-colour border, so they differ in shape. But a finished agent's selection is only a 1 px inset line, and the root's role colour equals the default accent (M1). |

Measured contrast in the app (1600x1000, deep tree, tint off):

| Backdrop | Pattern d / l | Strong d / l | Ring d / l | Min edge d / l | Group edge d / l | Message d / l | Focus d / l | Node text d / l |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Dots, Grid | 1.71 / 1.59 | 2.53 / 2.11 | 2.53 / 2.11 | 6.00 / 4.82 | 3.98 / 3.48 | 5.67 / 5.18 | 7.55 / 6.94 | 14.3 / 18.2 |
| None | - | - | 2.53 / 2.11 | as Dots | as Dots | as Dots | as Dots | as Dots |
| Blueprint | 1.67 / 1.59 | 2.68 / 2.39 | 2.68 / 2.39 | 5.55 / 4.64 | 3.56 / 3.34 | 5.07 / 4.97 | 6.74 / 6.65 | 13.3 / 18.2 |
| Paper | 1.51 / 1.43 | 2.39 / 2.17 | 2.39 / 2.17 | 5.76 / 4.76 | 3.77 / 3.43 | 5.37 / 5.10 | 7.15 / 6.83 | 14.1 / 17.9 |
| Isometric | 1.57 / 1.45 | 2.53 / 2.11 | 2.53 / 2.11 | as Dots | as Dots | as Dots | as Dots | as Dots |
| Circuit | 1.66 / 1.53 | 2.34 / 2.32 | 2.34 / 2.32 | 5.86 / 4.70 | 3.84 / 3.38 | 5.47 / 5.03 | 7.28 / 6.73 | 14.1 / 18.2 |
| Terminal | 1.47 / 1.47 | 2.50 / 2.50 | 2.50 / 2.50 | 6.08 / 6.08 | 4.08 / 4.08 | 5.81 / 5.81 | 7.73 / 8.83 | 14.7 / 14.7 |
| Starfield | 2.02 / 1.86 | 9.41 / 3.83 | 1.56 / 1.50 | 6.08 / 4.78 | 4.07 / 3.45 | 5.80 / 5.14 | 7.72 / 6.88 | 14.3 / 18.2 |

All match the spec's section 9 within 0.02. Terminal in light keeps phosphor text `rgb(182,242,198)` and a light toolbar
(41). Minimap node on its background: 4.57-6.29:1, Terminal 8.99:1.

## New findings, ranked

### H1. Name tags show only the role name, and keyboard users cannot reach the rest

- Screen: Live run, Agents as "Name tags" (Constellation's default). Shots 35, 60, 111, 113, 122.
- Steps: start `Canvas walk [mock:deep-tree] build`, turn Hide finished off, pick Constellation in the Canvas style
  popover.
- What the user sees: four pills, three reading "IM Implementer" (35, 122). Which one is `mock-lead` and which are its
  reports is only in a mouse `title` tooltip ("Implementer / mock-lead-report-1 . sonnet-4-5 / Reported back / 820 tok .
  $0.001425"). In the message run the two workers are two identical "Implementer" pills (111).
- Keyboard and screen reader: the focused pill is `role="group"` with no name of its own; it reads "IM Implementer" plus
  the sr-only activity ("Reported back"), never the handle, tokens or cost. Enter and Space on a focused report do not
  select it (walk4 `kb-select-report`: selection stays on `root`, the side panel keeps showing the Orchestrator), so the
  side panel, where the spec says the detail lives, is unreachable by keyboard. Selecting by keyboard was already open
  as fold M3; name tags make it block the only other route to the detail.
- Likely owner: `src/renderer/src/components/AgentNode.tsx` (line 104 renders `agent.name` in the pill; `compactTip` at
  line 74), the node keyboard handler in `src/renderer/src/views/LiveRunView.tsx`.
- Fix: in the compact pill show `lib/agentTree.ts` `agentLabel(agent)` (handle first, as the folded-group tooltip and
  FinishedList already do) with the role in the tooltip; give the node an accessible name that includes the handle,
  role and activity; make Enter (and Space) on a focused agent node select it and open the side panel.
- Check: in name tags on the deep tree no two pills have the same visible text; Tab to `mock-lead-report-1`, press
  Enter: `.react-flow__node.selected` is that node and the side panel heading names it.

### H2. Message edges run behind the cards they connect

- Screen: Live run, any layout, any node style. Shots 80, 84, 87, 111, 112, 113.
- Steps: a mock script with two spawned reports and `{ type: 'message', from: 'msg-a', to: 'worker-b' }`.
- What the user sees: worker-a sits right of worker-b. The message line leaves worker-a's right handle (pointing away
  from worker-b) and enters worker-b's left handle (an arrow arriving from empty space), and the middle runs behind both
  cards (80, 87). Measured share of the path inside a node box (walk3 `msg-geo-*`): top down cards 82%, compact 72%;
  left to right cards 66%; radial cards 64%. The edge from worker-b to the Orchestrator is 0-26% hidden. A user reading
  the canvas would not say worker-a messaged worker-b.
- Likely owner: message edge building in `src/renderer/src/views/LiveRunView.tsx` with `handlesFor` in
  `src/renderer/src/lib/canvas.ts` (fixed `msgOut` / `msgIn` sides per layout).
- Fix: pick the message handles by the two nodes' relative position (source's side facing the target, target's side
  facing the source; in top down, left/right by x), or route the line around node boxes; keep it under nodes only once
  it no longer crosses them. In radial, use the counter-clockwise bow between centres for siblings too.
- Check: for the two-worker script, under 10% of `msg-msg-a-msg-b`'s length lies inside any `.react-flow__node` box in
  all three layouts and both node styles.

### M1. Selection is a 1 px line on finished agents, and on the root it looks like focus

- Screen: Live run, cards, both themes. Shots 64, 66, 122; walk2 `card-selected-mouse`.
- Steps: on the finished deep tree, click `mock-lead-report-1`.
- What the user sees: its border stays `1px rgb(29,35,50)`; only the 1 px inset role line shows (64). `run.css` has
  `.agent-node.selected` (line 17) before `.agent-node.state-done` (line 26) at the same specificity, so the done
  border wins. The root's role colour `#7c5cff` is the default accent, so the selected root and a focused node (2 px
  accent outline) look nearly the same (122).
- Likely owner: `src/renderer/src/styles/run.css` (and the role and group node rules alongside).
- Fix: make selection win over state borders (`.agent-node.selected` after the state rules, or higher specificity) and
  keep the 2 px role border the spec asks for; give focus a shape selection never has (the offset outline already does
  this; consider a double ring or a contrasting outline colour when the role colour is within a small distance of the
  accent).
- Check: a selected finished card has `border-color` equal to its `--role`; with the root selected and a report focused,
  a screenshot shows two clearly different treatments.

### M2. The default look is "Custom", and there is no way back to it

- Screen: App settings > General > Canvas and the popover. Shots 02, 79, 115.
- What the user sees: on a fresh install the checked style is "Custom: Your own mix. Change it under Customise." though
  they chose nothing. After trying Blueprint the Custom option disappears (`after-pick-options`: only the four presets),
  arrow keys cycle the four presets only, and there is no reset (`any-reset` 0). Getting back to the original look means
  setting five controls by hand (Dots, Curved, Top down, Cards, tint on).
- Likely owner: `CANVAS_PRESETS` in `src/shared/defaults.ts`, `components/canvas/CanvasPresetGroup.tsx`.
- Fix: add a "Classic" (or "Default") preset equal to `DEFAULT_APPEARANCE.canvas` as the first option, so the default
  shows as a named style and is one arrow or click away; keep Custom for real mixes.
- Check: on a fresh data dir `canvas-preset[data-preset=<default id>][aria-checked=true]` and no Custom option; after
  picking Blueprint, one click on the default restores `data-canvas-pattern=dots`, `-edges=curved`, `-tint=on`.

### M3. At 1024x640 Customise changes happen out of sight of the preview

- Screen: App settings > General > Canvas, one-column layout. Shots 04, 08, 25.
- What the user sees: the preview sits above the gallery and is not sticky in one column. With the Customise rows on
  screen the preview is scrolled away (preview bottom 309 px when the section top is at 56; Customise rows start
  around 600 px), so a Background, Lines or Agents as change shows nothing on screen except the control itself.
- Likely owner: `src/renderer/src/styles/canvas-settings.css`, `components/settings/CanvasSection.tsx`.
- Fix: in one column make the preview sticky at the top of the scroller (it is only 160 px), or place a second compact
  preview beside the Customise rows.
- Check: at 1024x640, with `canvas-backdrop-select` focused and in view, `canvas-preview` intersects the scroller's
  visible box.

### M4. Radial with cards is unreadable at 1024x640

- Screen: Live run, Layout Radial, Agents as Cards, side panel open (stage 688x424). Shot 72.
- What the user sees: the fit zoom is 0.43, so names are 5.6 px and the rest of the card is a smudge. Compact pills at
  the same size fit at 0.64 (8.3 px). With one lead, the two reports land on ring 2 at 3 and 9 o'clock, level with the
  root, so they read as the root's peers (35, 72).
- Likely owner: `radialLayout` in `src/renderer/src/lib/layout.ts`, the fit in `LiveRunView.tsx`.
- Fix: in radial, fit with a minimum zoom (like the 0.8 floor under 300 px of stage height) and let the user pan, or
  switch cards to name tags in radial below a stage width; for a lone child at depth 1, start ring 2's sector at the
  child's angle so reports fan out beyond their lead.
- Check: on the deep tree at 1024x640 with the side panel open, radial cards render names at 9 px or more; each report
  is farther from the root than its lead in the screen's vertical or horizontal direction it fans to.

### Lows

- L1. The settings preview draws at 0.22-0.31 zoom: the sample cards' text is unreadable at both sizes (03, 12, 20), so
  "Cards" vs "Name tags" and line styles are hard to judge there. Thumbnails share one root-and-two-reports shape; the
  Constellation thumbnail shows no ring or stars (02). Owner `CanvasPreview.tsx`, `CanvasThumb.tsx`. Check: the
  preview's root name renders at 9 px or more.
- L2. At 1024x640 the three-column gallery clamps each description to two lines with an ellipsis ("A drafting-table
  look: fine blue...", 02), and on first open the first gallery row is cut by the window bottom (row 571-657 px in a
  640 px window, 01). Owner `canvas-settings.css`.
- L3. Team editor at 1024x640: the stage is 237 px high, under the 240 px floor, so turning Minimap on shows nothing
  there (walk2 `team-default-1024-*`, `mini` null). The switch's description covers it, but no hint appears on the Team
  canvas. The Team editor also has no legend (`legend` 0) and keeps React Flow's zoom Controls floating over the canvas
  bottom-right (124), unlike the Live toolbar. Owner `TeamView.tsx`.
- L4. The legend's "Selected" swatch is accent violet, not a role colour, and "Reporting line" does not show the dashed
  working state the spec lists (54). Owner `LiveRunView.tsx` legend, `styles/canvas.css`.
- L5. The message colour `rgb(93,139,214)` is close in hue to the sky-blue Implementer edge `rgb(71,185,253)`; dash is
  the only reliable cue. In radial the message bow and the reporting line between the root and a report lie a few px
  apart (82). Owner `tokens.css` `--edge-message`.
- L6. Starfield ring guides are 1.56:1 dark and 1.50:1 light (as the spec computes), so Constellation's signature rings
  are faint (35, 50). Consider `--canvas-ring` about 2:1 on Starfield.
- L7. The frame announcer accumulates picks ("Canvas style: Blueprint. Canvas style: Constellation.") in
  `tray-announce` (walk2 `popover-kb`). Screen readers should only read the addition; replace the text instead.
- L8. Out of scope, seen on the way: in the conversation layout of the message run, a report's message to main shows
  as a "You" bubble ("Status update.", 116).

## Keyboard pass (1024x640, dark)

- 5 Tabs from the window to the gear; Enter opens App settings; 10 Tabs from there to the gallery (General tab, Theme,
  7 accent swatches). The gallery is one stop; the ring is a visible 2 px accent outline (23).
- Arrows, Home and End move and apply at once, announced in `canvas-announce` ("Canvas style: Mission control.").
  Tab order after the gallery matches the spec: Customise, Background, Layout, Lines, Agents as, Accent tint, Minimap.
  Shift+Tab returns to the gallery in one stop.
- Live toolbar: from Fit to view, Tab reaches Canvas style, Canvas legend, Show conversation, then the nodes. Enter on
  Canvas style focuses the checked option; arrows apply and keep the popover open; Tab reaches "More canvas settings";
  Escape returns focus to the button on Live and Team. "More canvas settings" lands on the section with the checked
  option focused and no window shift (`deep-link`, 123).
- Nodes: the focus ring shows on cards and pills (65, 122); Enter and Space do not select (H1).
- Reduced motion ("Always reduce"): edge dash and message dot animations stop (`dashdraw`, `msg-dots` gone); the
  working ring and pop-in collapse to 0.01 ms single runs. Starfield adds no animation under reduce.

## Click counts

| Task | Clicks |
| --- | --- |
| Try a preset from App settings (first visit) | 2: gear, preset (the first row is partly visible at 1024x640) |
| Try a preset while looking at a run or the team | 2: palette, preset; arrows then apply further picks |
| Change one Customise axis | 2-3 plus a scroll at 1024x640 (Customise is open by default while Custom is checked) |
| Get back to the default look after a preset | 5 controls in Customise (M2) |

## Recommendations for phase B (Station and Hex)

- Fix H1 first: stations (a 20 px circle with the name beside it) and hexes have even less room than pills. Use
  `agentLabel` for the visible name and give every node an accessible name with handle, role and state; make keyboard
  Enter select.
- Fix H2 before Subway: a transit map is all lines, and messages crossing station dots will read as track. Route
  messages by relative position and test the hidden share on the two-worker script.
- Focus on non-rectangular shapes: a CSS outline follows the box, not a hex `clip-path` or a circle; draw focus and
  selection as an SVG stroke or `drop-shadow`, and keep the two visibly different (M1).
- Readability at fit: check name size at 1024x640 for Subway (left to right) and Hive (radial); add a minimum zoom or
  a label threshold (M4). Hive's Isometric backdrop is the busiest (three line families, 1.45:1 light, `stage-isometric-
  light.png`); check hex text over it.
- Subway colours lines per lead: in light the lime role colour is the weakest; keep the `edgeStroke` mix and the 3:1
  check for station rings and line segments, and give the legend a station and a hex entry.
- Minimap: give stations and hexes their own `useNodeDims` sizes so the minimap stays one shape per node.
- Thumbnails: make each preset's thumbnail show its own layout (rings for Constellation and Hive, a coloured line for
  Subway) so the gallery tells styles apart at 72x48 (L1).
- Test with more than four agents: the mock deep tree is four nodes; a 10-15 agent script would show ring overlap,
  pill crowding and fit zoom honestly.

## Not driven

- Custom accents and custom role colours, the System theme, a failed agent and a waiting card on the canvas (the scripts
  used here produce none), a large run, the dashboard canvas, the Starfield message glow under no reduced motion (the
  class `msg-fresh` was present on a new message; the 1.5 s glow itself was not captured), relaunch persistence of the
  Customise disclosure (`orgai.canvasCustomise` was null after the walk), and screen-reader output (names were read from
  the DOM, not spoken).
