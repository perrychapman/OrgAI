# UX review: Canvas appearance (before canvas themes)

- Reviewer: UX Researcher (mock-data walkthrough, no code changes). Recorded by the UI Lead from the researcher's
  findings; the researcher's worktree was lost before it could write this file.
- Build: e788777 (dev), mock adapter (`ORGAI_MOCK=1`), fresh temp `ORGAI_DATA_DIR`.
- How it ran: built Electron app, sizes 1024x640 and 1600x1000, dark and light, one keyboard pass. No tokens, no smoke
  scripts.
- Compared with: `docs/design/spec.md` 6.1 (canvas settings apply to both canvases).
- Screenshots: not kept.

## Verdict

PARTLY WORKS. Fix H1 and H2 first.

## Findings, ranked

### H1. The minimap draws no nodes

- On a live run the minimap's SVG holds only the mask: 0 node shapes against 4 nodes on the canvas, switched on before
  or during a run, with Hide finished on or off.
- Owner: `LiveRunView.tsx:976`.
- Likely cause, not verified: the controlled `nodes` have no `onNodesChange`, so they never get a measured size.
- Check: one minimap node per canvas node.

### H2. The Team editor ignores Grid, Connection lines and Minimap

- Its background is always dots (`TeamView.tsx:578`), its edges are always curved, and it has no minimap. Spec 6.1
  says both canvases follow these settings.
- Fix: one shared `useCanvasOptions()` in `lib/canvas.ts`.

### M1. The settings are hard to find and have no preview

- They sit under Advanced at the bottom of General. At 1024x640 the closed disclosure is below the fold (top at 625 px
  in a 592 px scroller). No canvas is visible from settings, and four of the five rows have no description. One try
  costs about 4-5 clicks plus scrolling.

### M2. The dots barely show

- Contrast 1.26:1 dark and 1.31:1 light. In light, Dots looks the same as None. The code draws dots at size 1; the spec
  says 1.2.

### M3. Light-theme edges are below 3:1

- In light, role-coloured edges are 1.87-2.2:1 against the canvas (below 3:1). Done edges sit at 0.45 opacity on top of
  that. The done-group edge is 1.61:1 light and 1.97:1 dark.

### M4. Message edges look like delegation edges

- Message edges are drawn over node bodies, and they share the dashed style with live delegation edges. The legend does
  not tell them apart.

### M5. The minimap crowds the stage at 1024x640

- At 1024x640 the 202x152 minimap covers 55% of the stage height (279 px), and the legend popover lands on top of it.

### Lows

- The tint is nearly invisible (6% / 5% wash).
- The grid shows through the done-group fill.
- The legend has no Selected, done-group or edge-type entries.
- The dashboard background always draws dots (code read only).
- At fit zoom 0.68 the node name is about 8.8 px on screen.
- Live node focus and selection look alike.

## Keyboard pass

Keyboard and motion work: 14 Tabs from the gear to Pattern, a visible 2 px ring, arrow keys apply and save. "Always
reduce" dropped animated edges from 5 to 0.

## Suggested order of work

Fix H1 and H2 first; give the canvas its own "Canvas" section, out of Advanced; make presets a thumbnail radio gallery
with a Customise disclosure (Backdrop as a select of 9, Layout and Lines segmented, Node style segmented or select); put
a sample canvas showing every state beside the controls, plus a "Canvas style" popover in the Team and Live canvas
toolbars; every theme in both modes keeps the pattern at about 1.4-2:1, edges and the focus ring at 3:1 or more, opaque
nodes, and the ring, badge and dashed cues; under reduced motion backdrops stay static; each layout needs its own
message handles and fit.

## Not driven

The error state (the mock has no failing agent), System theme, other accents, large runs.
