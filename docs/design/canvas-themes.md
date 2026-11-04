# Canvas themes (phase A)

- Owner: Product Designer. Status: ready to build. Supersedes the canvas rows of `spec.md` 6.1 and 6.3.
- Fixes: `ux-review-canvas-themes.md` H1, H2, M1-M5 and its Lows.
- Contract (already merged): `CanvasPattern`, `CanvasLayout`, `CanvasNodeStyle`, `CanvasEdgeStyle` in
  `src/shared/types.ts`; `CANVAS_PRESETS`, `activeCanvasPreset`, `applyCanvasPreset` in `src/shared/defaults.ts`;
  `useCanvasOptions`, `AVAILABLE_NODE_STYLES`, `AVAILABLE_PRESETS`, `shownPreset`, `handlesFor`, `AGENT_NODE_SIZE`,
  `GROUP_NODE_SIZE` in `src/renderer/src/lib/canvas.ts`; the `<html>` attributes `data-canvas-pattern`, `-edges`,
  `-layout`, `-node-style`, `-tint`, `-minimap` written by `lib/theme.ts`.
- Tokens: `src/renderer/src/styles/tokens.css` sections 1-3 (defaults) and 7 (per backdrop). Token values are not
  repeated here except where a rule needs them; section 9 lists every measured ratio.
- Phase A builds node styles `card` and `compact`. `station` and `hex` (and the Subway and Hive presets) are phase B.
- Assets: none needed from the Visual Director. Thumbnails and backdrops are drawn in code from tokens.

## 1. One rule set for every canvas

Three canvases follow the settings: the Live run, the Team editor and the settings sample (`canvas-preview`). Each
reads `useCanvasOptions()` and nothing else. Both themes and all three canvases use the same components:
`CanvasBackdrop`, the agent and role node components, the edge helpers and the minimap rule below.

- The stage paints the backdrop. `.frame-stage` (and `.canvas-preview`) paints `--canvas-bg` plus the accent wash
  (`--canvas-wash-opacity`, today's radial gradient in `editor.css` `.canvas`, moved to the stage). `.canvas-frame`
  itself paints `--surface-0`, so the toolbar, tray and footer never take a backdrop colour. Default `--canvas-bg` is
  `--surface-0`, so nothing changes for Dots.
- `CanvasBackdrop` is a child of `<ReactFlow>` that replaces React Flow's `Background`. It renders one
  `svg.canvas-backdrop` (`data-testid="canvas-backdrop"`, `data-pattern=<pattern>`, `aria-hidden="true"`,
  `pointer-events: none`) in the background layer, under edges and nodes. Its `<pattern>` uses
  `patternUnits="userSpaceOnUse"` and `patternTransform="translate(x y) scale(zoom)"` from the viewport (React Flow
  store `transform`), so it pans and zooms with the canvas. Sizes below are flow units at zoom 1.
- Lines use `vector-effect: non-scaling-stroke`: a 1 px line stays 1 screen px at every zoom. Dots, pads and stars
  scale with zoom.
- Nothing floats over the canvas. The backdrop sits under everything; the minimap is React Flow's own control.
- Under reduced motion (`prefers-reduced-motion` or `data-reduce-motion="on"`) every backdrop is static. Backdrops are
  static anyway in phase A; the only motion is edge dashes and the Starfield message glow (section 5).

## 2. Backdrops

Targets in both themes on every backdrop: pattern 1.4-2:1 against `--canvas-bg` (Starfield's bright stars are points
and may exceed it), `--canvas-pattern-strong` and `--canvas-ring` about 2-2.7:1 (always under 3:1 so they never read
as edges), every edge and the focus ring 3:1 or more, nodes opaque, node text 4.5:1 or more. Role colours are never
changed; edges mix them toward an ink (section 5) and nodes change their surface, not the role colour. The working
ring, the done and failed badges and the dashed no-result border stay on every backdrop.

| Backdrop | Tile | Drawing | Dark | Light |
| --- | --- | --- | --- | --- |
| Dots (default) | 22 x 22 | one dot, r 1.2, `--canvas-pattern`, at the tile origin | neutral near-black | neutral off-white |
| Grid | 22 x 22 | 1 px lines on the tile's top and left edges, `--canvas-pattern` | as Dots | as Dots |
| None | none | nothing; ring guides still draw in radial | as Dots | as Dots |
| Blueprint | 100 x 100 | minor 1 px lines every 20 in `--canvas-pattern`; a 1.5 px major line every 100 (5 cells) in `--canvas-pattern-strong` | deep blue `#0b1a33`, blue-tinted cards `#12223f` with a blue border | pale whiteprint `#eaf1fb`, white cards, blue lines |
| Paper | 28 x 28 | one 1 px horizontal rule at y 27.5, `--canvas-pattern` | warm dark sheet `#16140f`, warm cards `#201d17` | warm paper `#f7f3ea`, warm white cards `#fffdf8` |
| Isometric | 41.5692 x 24 | triangle grid, side 24: path `M0 0V24 M20.7846 0V24 M0 24L41.5692 0 M0 0L41.5692 24`, 1 px, `--canvas-pattern` (fainter than Dots: three line families) | as Dots | as Dots |
| Circuit | 120 x 120 | traces (1.25 px, `--canvas-pattern`, `stroke-linejoin: round`): `M0 30H40L55 45H85L100 30H120`, `M30 0V55L45 70V90L30 105V120`, `M75 60H105`, `M60 0V12`, `M60 108V120`. Pads at (75,60), (105,60), (60,12), (60,108): r 3, 1.5 px stroke `--canvas-pattern-strong`, fill `--canvas-bg`. Via at (30,30): r 2, filled `--canvas-pattern-strong` | dark board `#0a1410`, green-tinted cards `#15201a` | pale board `#eef3ef`, white cards |
| Terminal | 22 x 22 | a dot, r 1, `--canvas-pattern`; plus screen-fixed scanlines (below) | phosphor on `#060a08`, cards `#0c140f`, text `#b6f2c6` / `#6fbf88`, monospace | stays dark (below) |
| Starfield | 240 x 240 | static stars, no twinkle. Small, `--canvas-pattern`: (18,32) r 1, (72,140) r 0.8, (196,18) r 0.8, (222,170) r 1, (40,210) r 1.2, (110,196) r 0.8, (160,112) r 1, (90,92) r 0.8. Bright, `--canvas-pattern-strong`: (130,60) r 1.2, (204,226) r 1.2 | deep night `#070912`, default cards | pale dawn sky `#f2f4fb`, default cards, no glow |

Terminal:

- Scanlines are texture, not pattern: a `div.canvas-scanlines` inside the React Flow wrapper, outside the viewport
  transform (screen-fixed), under edges and nodes, `pointer-events: none`, `aria-hidden`, background
  `repeating-linear-gradient(to bottom, color-mix(in srgb, var(--canvas-pattern) 40%, transparent) 0 1px, transparent 1px 3px)`.
  They are about 1.2:1 by design and carry no meaning.
- Node text uses `--canvas-node-font` (`--font-mono`) and the phosphor `--canvas-node-text` / `-muted`.
- It stays dark in the light theme: a console is dark. The light rules in tokens.css 7b give it the same values, and
  7c (the "terminal island") gives `.frame-stage`, `.canvas-preview` and the Terminal thumbnail the dark app tokens
  (`--text-*`, `--surface-*`, `--border-*`, status, soft fills, `--edge`, legacy aliases), so badges, worktree lines,
  avatars and inline TSX colours inside nodes stay readable. The toolbar, tray and side panel stay light. The focus ring
  becomes `color-mix(in srgb, var(--accent-text) 45%, #ffffff)` so a custom accent still shows.

Radial ring guides (any backdrop, layout radial only): one circle per depth, centred on the root, radius as in
section 3, 1 px non-scaling, `--canvas-ring`, `stroke-dasharray: 2 6`, drawn by `CanvasBackdrop` in flow coordinates
(they pan and zoom). Each ring is `circle.canvas-ring`.

The tint (`data-canvas-tint`) is a radial wash of `--accent` at the top centre: dark 10%, light 7% (was 6% / 5%). All
ratios in section 9 are on the plain backdrop; at the wash peak they drop by at most about 10% and stay at 3:1 or more.

## 3. Layouts

`.react-flow` carries `data-layout="top-down" | "left-right" | "radial"` (pass it as a prop to `<ReactFlow>`) on all
three canvases. Handles come from `handlesFor(layout)`: reporting lines enter at `target` and leave at `source`;
messages use `msgIn` / `msgOut`, never a reporting line's handle.

| Layout | Placement | Handles | Done groups | Earlier-session groups | Fit |
| --- | --- | --- | --- | --- | --- |
| Top down | dagre `TB`, today's spacing | target top, source bottom; messages left / right | a child of the agent they hang under, after its visible reports | the first children of the root (leftmost) | `fitView` padding 0.2, maxZoom 1 (Team editor keeps 0.3) |
| Left to right | dagre `LR`, rank gap 96 | target left, source right; messages top / bottom | right of the agent they hang under, after its reports | the first children of the root (topmost) | as top down |
| Radial | `radialLayout()` in `lib/layout.ts` (pure, unit-tested) | handles hidden (`opacity: 0`, top / bottom for React Flow only); edges are centre to centre | a leaf on the next ring inside its parent's sector | the first slot of ring 1 | padding 0.12, maxZoom 1 |

Radial rules:

- The root's centre is (0, 0). Depth d sits on ring d. Ring step `R` = 300 for cards, 200 for compact. Ring radius
  `r_d = max(r_(d-1) + R, n_d * (nodeWidth + 24) / (2 * PI))`, where `n_d` is the node count at depth d, so a full
  ring never overlaps.
- Sectors: the root owns 360 degrees, starting at 12 o'clock and running clockwise. Each child gets a share of its
  parent's sector proportional to its leaf count (a leaf or a group counts 1) and sits at the share's midpoint. Order
  is the same as the dagre input order. A node's position is its centre on the ring minus half its size.
- Edges use one custom edge type `radial` (`components/canvas/RadialEdge.tsx`): from source centre to target centre,
  clipped where the line leaves each node's box (a pill clips as its box). Connection lines "Curved" bows the line
  clockwise by 12% of its length (a quadratic control point at the midpoint); "Right angle" and "Straight" draw it
  straight. Message edges use the same type bowed counter-clockwise by 20%, so they never lie on a reporting line.

Refit when the topology, the layout or the node style changes: duration 0 under reduced motion, else 300 ms. The Team
editor uses the same layout functions for its automatic layout.

## 4. Node styles

`.agent-node`, `.role-node` and `.done-group` carry `data-style="card" | "compact"`. A stored unavailable style draws
as `card` (`effectiveNodeStyle`). Every node style reads the canvas node tokens: background `--canvas-node-bg`,
border `--canvas-node-border`, text `--canvas-node-text`, secondary and tertiary text `--canvas-node-text-muted`,
font `--canvas-node-font`. The avatar tint mixes into `--canvas-node-bg` (not `--surface-2`), and the badge's 2 px
ring is `--canvas-node-bg`.

Selected and focused look different on both styles (fixes the Low "focus and selection look alike"):

- Selected: border 2 px in the role colour (`border-color: var(--role)` plus `box-shadow: inset 0 0 0 1px var(--role)`,
  no layout shift) and `--elev-2`. No outline.
- Keyboard focus (`.react-flow__node:focus-visible` > node): `outline: 2px solid var(--canvas-focus-ring)`,
  offset 3 px. Both show when both apply.

Card (today's 240 x 112): unchanged layout. Only the tokens above and the selection / focus split change.

Compact, a pill of 160 x 40 (`AGENT_NODE_SIZE.compact`):

- Radius `--radius-full`, padding `0 12px 0 6px`, gap 8, `--elev-1`.
- Avatar 28 px with initials; the state ring sits 3 px outside it (same state classes and animations as the card).
- Name: `--text-body`, 600, one line, ellipsis. Nothing else is visible.
- Badge 14 px at the avatar's bottom right: check for Finished, `!` for Failed. Waiting keeps the warning border and
  halo plus the blinking ring. Failed keeps the danger border. No result keeps the dashed border and `--dim-opacity`.
- Role and model, the activity line, the worktree line, tokens, time and cost move to the node's tooltip (the same
  text the card shows, in that order) and stay in the side panel. The accessible name is the card's.

Done group:

- Card: today's 240 x 56 pill. Compact: 160 x 40 pill (`GROUP_NODE_SIZE.compact`): success dot plus "3 done", then
  " · 1 failed" in `--danger-text` when any failed, then the chevron `IconButton` (24 px, "Show reports"). The
  unmerged count moves to the tooltip.
- Both: dashed 1 px border in `--canvas-edge-group` (3:1), opaque background `--canvas-node-bg` (fixes "the grid shows
  through"); an earlier-session group is opaque `--canvas-bg`.

Role node (Team editor) follows the setting: compact is the same 160 x 40 pill with avatar initials and the role name;
slug, model chip and tools go to the tooltip and stay in the role inspector. Node box sizes for layout and fit: card
220 x the measured height, compact 160 x 40.

Phase B adds `station` (a 20 px circle on its lead's coloured line, name beside it) and `hex` (a honeycomb tile about
120 x 104). Each one lands by adding it to `AVAILABLE_NODE_STYLES`, `AGENT_NODE_SIZE` and `GROUP_NODE_SIZE` in
`lib/canvas.ts`; `AVAILABLE_PRESETS` then shows Subway and Hive, and the "Agents as" control gains the option. No other
setting or selector changes.

## 5. Edges

One pure helper in `lib/canvas.ts`, `edgeStroke(role, mix, ink)`, returns the sRGB mix
`color-mix(in srgb, role mix%, ink)` as hex. Inputs are `--canvas-edge-role-mix` and `--canvas-edge-ink` read with
`useCssVar`. Use it for both the stroke and the arrow marker so they match (markers need a literal colour).

| Edge | Stroke | Width | Dash | Marker | Layer |
| --- | --- | --- | --- | --- | --- |
| Reporting line, idle | `edgeStroke(role)` | 1.6 | solid | arrow, same colour | default |
| Reporting line, working | `edgeStroke(role)` | 2.2 | `--canvas-edge-live-dash` (6 4), dash offset animates; static dashes under reduced motion | arrow | default |
| Reporting line, finished | `edgeStroke(role)` at `--canvas-edge-done-opacity` (dark 0.8, light 0.9; was 0.45) | 1.4 | solid | arrow | default |
| Folded group | `--canvas-edge-group` | 1.4 | 4 4 | none | default |
| Message between agents | `--edge-message` | 1.8 | `--canvas-edge-message-dash` (2 5) with `stroke-linecap: round` (a dotted line), dots flow slowly; static under reduced motion | arrow | under nodes (drop today's `zIndex: 10`); no "msg" label |
| Team editor, cannot delegate | `--canvas-edge-group` | 1.4 | 4 4 | none | default, plus today's label chip |

- Delegation and message edges now differ in colour (role colour vs one fixed message colour) and in dash (long dashes
  only while working vs round dots), which fixes M4. Message edges keep using `msgIn` / `msgOut` handles.
- Starfield only: a message edge gets `filter: drop-shadow(0 0 3px var(--canvas-glow))` for its first 1.5 s
  (`.msg-edge[data-fresh]`), fading over `--dur-slow`. No glow under reduced motion. `--canvas-glow` is transparent on
  every other backdrop and in light.
- The mix guarantees 3:1 for every colour in `ROLE_COLORS` (section 9). A custom role colour gets the same mix but no
  guarantee.

Legend popover (`canvas-legend`), in this order, one shape plus one word each: Working (ring), Needs you (bell),
Finished (check), Failed (alert), Selected (role-coloured border), Folded finished agents (a dashed "3 done" pill),
Reporting line (solid line, dashed while working), Message between agents (dotted line in the message colour). The
words follow `lib/runStatus.ts` and `activity.ts`: "Needs approval", "Done" and "Error" are retired here.

## 6. Minimap

- Both canvases (Live and Team) mount React Flow `MiniMap` when `minimap` is on; the settings preview shows it too.
  `position="bottom-left"`, `pannable`, `zoomable`, `ariaLabel` "Run minimap" / "Org chart minimap".
- One shape per node (fixes H1): every node gets `width` and `height` from `lib/canvas.ts` (agent and group sizes, the
  role node's size), and controlled nodes apply React Flow's dimension changes through `onNodesChange`. Shapes:
  `nodeColor` `--canvas-minimap-node`, the selected node `--canvas-focus-ring`, `nodeStrokeColor` transparent,
  `nodeBorderRadius` 4, `maskColor` `--canvas-minimap-mask`, `bgColor` `--canvas-minimap-bg`, all resolved through
  `useCssVar`.
- Size (fixes M5): pure `minimapSize(stageWidth, stageHeight)` in `lib/canvas.ts`: width
  `clamp(120, round(0.18 * stageWidth), 200)`, height `min(round(0.3 * stageHeight), round(0.75 * width))`; it returns
  null (no minimap) when the stage is under 240 px high or 480 px wide. The stage size comes from a `ResizeObserver` on
  `.frame-stage`. At 1024 x 640 (stage about 600 x 279) that is 120 x 84, 30% of the stage height.
- Popovers anchor at the toolbar's end (right), the minimap sits bottom-left, so the legend and the canvas style
  popover never land on it.

## 7. Settings

### 7.1 App settings > General > Canvas

A new `SettingsSection` "Canvas" (`id` `appsettings-section-canvas`, `APP_SETTINGS_SECTIONS.canvas`,
`data-testid="canvas-section"`), right after Appearance and outside the Advanced disclosure. Lead: "How the org chart
and run canvases look. Both follow these settings." The old "Motion and canvas" group under Advanced becomes "Motion"
and keeps only the Motion row. `requestAppSettingsSection('appsettings-section-canvas')` opens General, scrolls with
`lib/scrollWithin.ts` and focuses the checked style option.

Regions (the section is an inline-size container, `container: canvas-section / inline-size`):

- 720 px or wider (1600 x 1000): two columns, `minmax(0, 1fr) 300px`. Left: the style gallery, then Customise. Right:
  the preview, 300 x 200, `position: sticky` at `--space-4` inside the settings scroller.
- Under 720 px (1024 x 640): one column: the preview first at full width and 160 px high, then the gallery, then
  Customise. The gallery's first row is visible without scrolling once the section is in view.

Style gallery: `role="radiogroup"`, `aria-label="Canvas style"`, one tab stop (`useRovingFocus`); arrow keys move and
select, Home / End jump. Grid `repeat(auto-fill, minmax(220px, 1fr))`. Each option is a `button` with `role="radio"`,
`aria-checked`, `data-testid="canvas-preset"`, `data-preset=<id>`:

- A 72 x 48 inline SVG thumbnail (`aria-hidden`, `data-canvas-thumb=<pattern>`, which makes tokens.css give it that
  backdrop's tokens whatever is active): the backdrop pattern at a quarter scale, a root and two reports in the preset's
  layout and node style, joined in its line style with the first three `ROLE_COLORS` through `edgeStroke`.
- Label (`--text-title-sm`, 600) and the preset's `description` (`--text-small`, `--text-secondary`, two lines max).
- Checked: 2 px `--accent-text` border and a check icon at the top right. Focus: the standard `:focus-visible` ring.
- Options are `AVAILABLE_PRESETS` in contract order (phase A: Blueprint, Constellation, Mission control, Paper).
  Picking one calls `applyCanvasPreset` (the minimap is kept), applies at once through `setAppearance` and saves.
- "Custom" (`data-preset="custom"`) is rendered, checked, only when `shownPreset()` is undefined. Its thumbnail has no
  `data-canvas-thumb` (it shows the current settings). Description: "Your own mix. Change it under Customise."

Customise: a disclosure button "Customise" (`data-testid="canvas-customise"`, `aria-expanded`, `aria-controls`),
closed by default and open on load when Custom is checked. Its open state is kept in localStorage
`orgai.canvasCustomise`. Rows are `SettingRow`s, each with a one-line description:

| Row | Control | Options (sentence case) | Description | Test id |
| --- | --- | --- | --- | --- |
| Background | native `Select` | Dots, Grid, None, Blueprint, Paper, Isometric, Circuit, Terminal, Starfield | The pattern behind your agents. It moves and zooms with the canvas. | `canvas-backdrop-select` |
| Layout | `SegmentedControl` | Top down, Left to right, Radial | Where each agent sits around the one it reports to. | `canvas-layout` |
| Lines | `SegmentedControl` | Curved, Right angle, Straight | How reporting lines are drawn. In the radial layout, right angles draw straight. | `canvas-edges` |
| Agents as | `SegmentedControl` (only `AVAILABLE_NODE_STYLES`; the row hides when only one is built) | Cards, Name tags | Name tags fit more agents. Activity and tokens move to the tooltip and side panel. | `canvas-node-style` |
| Accent tint | `Switch` | | A soft wash of your accent colour at the top of the canvas. | `canvas-tint` |
| Minimap | `Switch` | | A small map of the whole chart in a corner. Hidden when the canvas is short. | `canvas-minimap` |

Preview (`data-testid="canvas-preview"`, class `canvas-preview`): `role="img"`, `aria-label="Sample canvas in the
current style"`, the wrapper is `inert`. Its own `ReactFlowProvider` with the real node and edge components and
`CanvasBackdrop`, fed by a pure sample in `lib/canvasSample.ts`: a root (working), a working report, a waiting report,
a finished report, a failed report and a "2 done" group, roles in the first five `ROLE_COLORS`, plus one message edge
from the waiting report to the root. Static: not draggable, selectable, focusable or zoomable; it lays out with the real
layout functions and refits (duration 0) on every option change, so it updates at once. Animations follow reduced
motion like the real canvases.

Keyboard order in the section: style gallery (one stop) > Customise > Background > Layout > Lines > Agents as >
Accent tint > Minimap. The preview takes no focus.

Live region: one sr-only `p[role=status][aria-live=polite]` (`data-testid="canvas-announce"`) in the section says
"Canvas style: Blueprint." when a style is picked, and "Canvas style: Custom." when a Customise change leaves every
preset (or "Canvas style: Paper." when it lands on one). Selects, segments and switches announce themselves.

### 7.2 "Canvas style" in the canvas toolbars

- Live run: an `IconButton` (icon `Palette`, label "Canvas style", `data-testid="canvas-style-button"`) in
  `CanvasTools` between the zoom group and the legend. Team editor: the same button at its toolbar's end. It is hidden
  with the other canvas tools while the stage is collapsed.
- It opens a `Popover` (`data-testid="canvas-style-popover"`, `placement="bottom-end"`, heading "Canvas style") with
  the same radio group in compact rows (48 x 32 thumbnail plus label; the description is the option's
  `aria-describedby`), the Custom row when it applies, and a footer `Button` variant link "More canvas settings"
  (`data-testid="canvas-style-more"`) that closes the popover and calls
  `requestAppSettingsSection('appsettings-section-canvas')`.
- Keyboard: opening focuses the checked option; arrows pick and apply at once (the popover stays open); Tab reaches
  "More canvas settings"; Escape closes and returns focus to the button. A pick is announced through the frame's
  `useFrameAnnounce` ("Canvas style: Paper."), never a second live region.

## 8. Selectors and e2e impact

Fixed names: `canvas-section`, `canvas-preset[data-preset]` (`role=radio`, `aria-checked`; `custom` for Custom),
`canvas-customise`, `canvas-backdrop-select`, `canvas-layout`, `canvas-edges`, `canvas-node-style`, `canvas-tint`,
`canvas-minimap`, `canvas-preview`, `canvas-style-button`, `canvas-style-popover`, `canvas-style-more`,
`canvas-announce`, `canvas-backdrop[data-pattern]` (the backdrop svg), `circle.canvas-ring`, `div.canvas-scanlines`,
`[data-canvas-thumb]` (thumbnails), `.react-flow[data-layout]`, `.agent-node[data-style]`, `.role-node[data-style]`,
`[data-testid=done-group][data-style]`, `.msg-edge`.

e2e:

- New `e2e/canvas.mjs`, added to `e2e:free` (mock, 1024 x 640 and 1600 x 1000, dark and light):
  1. General shows `canvas-section` before the Advanced disclosure; at 1024 x 640 the gallery's first option is in
     the settings scroller's view after `requestAppSettingsSection` (and `windowShift` stays 0).
  2. Arrow keys in the gallery check Blueprint: `<html data-canvas-pattern=blueprint>`, the preview's
     `canvas-backdrop[data-pattern=blueprint]`, `canvas-announce` text, one tab stop.
  3. Customise > Background "Grid": `canvas-preset[data-preset=custom]` appears checked.
  4. Layout Radial: `.react-flow[data-layout=radial]` on the preview and a Live run, `circle.canvas-ring` count equals
     the tree depth. Left to right: a report's box is right of its parent's.
  5. Agents as Name tags: `.agent-node[data-style=compact]` boxes are 160 x 40 (± 1); the Team editor's
     `.role-node[data-style=compact]` too.
  6. Minimap on, a mock run: `.react-flow__minimap-node` count equals `.react-flow__node` count on Live and Team (H1,
     H2); at 1024 x 640 the minimap height is at most 34% of `.frame-stage`; the open legend's and style popover's
     boxes do not intersect it.
  7. Team editor follows the backdrop and lines (H2): `canvas-backdrop[data-pattern]` matches the setting and its edge
     paths change type.
  8. A message edge's `stroke-dasharray` differs from a working reporting line's and it renders before the nodes layer.
  9. `canvas-style-button` opens `canvas-style-popover`, a pick changes `data-canvas-pattern`, Escape returns focus,
     `canvas-style-more` lands on `canvas-section`.
  10. Terminal in light: a node's computed `color` is the phosphor value and the toolbar keeps its light surface.
- `e2e/layout.mjs` line 230: the legend words become `working`, `needs you`, `finished`, `failed`, `selected`,
  `folded`, `reporting line`, `message`.
- Unit tests: `radialLayout`, `minimapSize`, `edgeStroke` (hex in, hex out, 0% / 100% ends) in `lib/*.test.ts`.

## 9. Measured contrast (WCAG 2 relative luminance)

Computed by hand from the tokens.css values (sRGB, edge mixes blended in sRGB, opacity blended over the backdrop).
Worst role colour per theme: dark `#7c5cff` (darkest), light `#a3e635` (lightest). Node text is primary / muted on
`--canvas-node-bg`.

| Backdrop, theme | Pattern | Strong / ring | Edge, worst role | Finished edge, worst | Group edge | Message edge | Focus ring (default accent) | Node text |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Dots / Grid, dark | 1.71 | 2.53 | 5.46 | 3.86 | 3.99 | 5.67 | 7.55 | 14.3 / 7.55 |
| Dots / Grid, light | 1.59 | 2.11 | 4.32 | 3.66 | 3.48 | 5.18 | 6.94 | 18.2 / 7.70 |
| Isometric, dark / light | 1.57 / 1.45 | 2.53 / 2.11 | as Dots | as Dots | as Dots | as Dots | as Dots | as Dots |
| None, dark / light | none | ring 2.53 / 2.11 | as Dots | as Dots | as Dots | as Dots | as Dots | as Dots |
| Blueprint, dark | 1.67 | 2.68 | 4.87 | 3.60 | 3.56 | 5.07 | 6.74 | 13.3 / 7.02 |
| Blueprint, light | 1.59 | 2.39 | 4.14 | 3.52 | 3.34 | 4.97 | 6.65 | 18.2 / 7.70 |
| Paper, dark | 1.51 | 2.39 | 5.17 | 3.70 | 3.77 | 5.37 | 7.15 | 14.1 / 7.45 |
| Paper, light | 1.43 | 2.17 | 4.25 | 3.61 | 3.43 | 5.10 | 6.83 | 17.9 / 7.57 |
| Circuit, dark | 1.66 | 2.34 | 5.26 | 3.76 | 3.84 | 5.47 | 7.28 | 14.0 / 7.43 |
| Circuit, light | 1.53 | 2.32 | 4.19 | 3.56 | 3.38 | 5.03 | 6.73 | 18.2 / 7.70 |
| Terminal, dark and light | 1.47 | 2.50 | 5.59 | 3.89 | 4.08 | 5.81 | 7.73 dark, 8.83 light | 14.7 / 8.45 |
| Starfield, dark | 2.02 (small stars) | bright stars 9.41, ring 1.57 | 5.58 | 3.90 | 4.07 | 5.80 | 7.72 | 14.3 / 7.55 |
| Starfield, light | 1.86 | bright stars 3.83, ring 1.51 | 4.28 | 3.63 | 3.45 | 5.14 | 6.88 | 18.2 / 7.70 |

Minimap nodes on `--canvas-minimap-bg`: dark 5.73, light 5.02, Terminal 8.45. At the tint's wash peak (top centre,
tint on) the lowest value is the finished lime edge in light at about 3.2:1.

Not checked: custom accents other than the default (the focus ring follows `--accent-text`, which `lib/theme.ts`
derives per theme), custom role colours, and oklab vs sRGB rounding in the browser (the edge mix is specified in sRGB
so the numbers above are what renders).
