# UX review: resizable sidebar and side panel, usage auto-refresh

Build at HEAD 79e4033, ORGAI_MOCK=1, fresh temp ORGAI_DATA_DIR, driven with Playwright over the e2e helpers. Run started so the Live panel exists. Checked at 1440x900 and 1024x640 (the window's inner size is 1424x861 and 1008x641), dark and light, mouse and keyboard.
Screenshots: `docs/design/ux-review-resize-shots/`.

Not verified visually: the usage section with real plan windows. The mock adapter shows "Runs use scripted data. No plan limits apply." (shot 10), and a non-mock project would start a real Claude probe, which this walkthrough does not do. The usage findings below come from reading `UsageMeter.tsx`.

What works: dragging is smooth (no jumps, no text selection, `data-resizing` locks the cursor, pointer capture survives leaving the window), the React Flow canvas re-centres in the Live view without flicker, the handle sits inside its own column and never overlaps the canvas, the rail removes the sidebar handle cleanly (shot 12), widths persist and are clamped, double-click resets, arrows and Shift+arrows step, Home and End jump to min and max, and the separator role, label and value attributes are present.

## Findings, ranked

### 1. High: a wide panel plus a wide sidebar leaves a tiny canvas and pushes Deny off screen
Flow: Live view, a pending permission card. Repro: at 1024x640 press Ctrl+B to expand the sidebar, drag the panel to its max, then drag the sidebar to its max.
Shot: `25-1024-both-wide.png` (also `24-1024-light-panel-max.png`).
Result: the canvas is 308 px wide and the tray is the same. The card shows only "Allow once" and "Allow for session"; "Always allow for project" and "Deny" sit below the fold in a 174 px tray. The reply label truncates to "Replying to..." and the hint to "Enter to send · Shift+Enter for a…". Dragging can put the user in a state where the primary decision controls need a scroll. The panel's saved width (416) is silently overridden to 280 once the sidebar grows, with no feedback.
Expected: the sidebar and panel maxima should leave enough room for the decision card. `CANVAS_MIN_PX` is 360, but the panel minimum (280) wins over it.
Fix: take the canvas minimum from the space left after both columns, and clamp the sidebar max by the panel's width as well as the other way round (for example sidebar max = window - panel - 360). Also keep the Deny button in a sticky footer of the card at narrow tray widths, or stack the actions.

### 2. Medium: widening the sidebar mid-drag collapses the right panel
Shot: `04-sidebar-wider.png` (1440 wide, sidebar dragged from 232 to 352).
Result: the run panel with the transcript turns into a 40 px rail while the user is dragging the left edge. The cause is `autoCollapseBelow` on a grid width, evaluated live when no saved panel choice exists. After a double-click reset it comes back. The user did not ask for it and the sidebar drag does not hint that it will happen. The Live canvas then grows to 1032 px.
Fix: apply the auto-collapse only on first layout or window resize (the code comment says "first layout"), not on a user-driven column drag. Or freeze it during `data-resizing`.

### 3. Medium: the org chart canvas does not re-fit when the panel is widened
Flow: Org chart tab, drag the panel left edge (panel 611 px). Shot: `30-orgchart-wide-dark.png`. The Researcher node is cut off at the right edge and the whole tree sits off-centre. The Live canvas re-centres (shot 08), so the two views behave differently. At 1024 the default org-chart layout is fine (shot 19), so this appears only after a resize.
Fix: re-run `fitView` (or keep the viewport centre) on container resize in `OrgChartView`, the way the Live view does.

### 4. Medium: widening the panel strips the run metadata and the Hide finished label from the toolbar
Shots: `08-panel-wide.png`, `09-panel-max.png`, `22-1024-light-hover-panel-handle.png`. At a canvas width of about 600 px or less the "2 agents, cost, Started just now" group disappears and the "Hide finished agents" switch loses its text, leaving an unlabelled toggle next to "unattended". The switch still has an aria label in `LiveRunView.tsx`, but a sighted user sees an unexplained switch. It is the container-query design meeting a user-chosen width, so the loss now happens at 1440 wide.
Fix: keep cost and agent count (they matter during a run) and drop "unattended" or the zoom controls first. Give the switch a `title`.

### 5. Medium: the handle is hard to discover
Shots: `02-hover-sidebar-handle.png`, `06`/`14`/`22`/`23` (hover), `27-focus-side-panel-resize-light.png`.
The hit target is 6 px, the visible line is 2 px and shows only on hover, in `--border-strong` (rgb 57,67,91 in dark), which is barely different from the column's existing border. The only strong cue is the col-resize cursor. There is no tooltip or title, and nothing at rest says the edge moves. Light theme is the same. Keyboard focus is clear (a 2 px focus-ring line), but it is a thin line, not a visible control.
Fix: a brighter hover colour (accent at 60 percent), a 3 px line, and a `title="Drag to resize, double-click to reset"`. Optionally a short grip mark centred on the handle that is always faintly visible.

### 6. Low: keyboard reset is missing and arrow direction needs a note
The only reset is a double-click. Enter does nothing and Home goes to the minimum, not the default (280 on the panel). Keyboard-only users cannot restore the default width. On the right panel ArrowLeft grows the pane and `aria-valuenow` goes up, so Right Arrow lowers the value, which is the reverse of what a screen reader announces for a splitter. Tab order is fine (handle after "Hide run panel" for the panel, after the settings gear for the sidebar), but Tab reaches the panel handle only after 12 stops through the canvas nodes and the decision card.
Fix: Enter or Delete resets to the default. Document the direction with `aria-keyshortcuts` or a hint through `aria-describedby`.

### 7. Low: the sidebar handle cannot be reached at 1024 without a hidden step
At 1024 the sidebar starts as a 56 px rail (below 1180) and the handle does not exist (shot `21b-1024-rail-panel-open.png`). The user must press Ctrl+B or click the toggle first (shot `21c`). That is consistent with the rail design, but the Live panel is also collapsed at 1024 by default (shot 16) and has to be opened before its handle appears. A user who reads "drag the edge to resize" will find nothing to drag.
Fix: no change to the behaviour, but the empty-handle state could show a tooltip on the toggle such as "Expand sidebar (then drag to resize)". Low priority.

### 8. Low: panel width is stored per view
`orgai.sidePanelW.run` (Live) and `orgai.sidePanelW.default` (Org chart) are separate. A user who widens the Live panel to 640 finds the Org chart panel at 360. This is probably deliberate, but it reads as the setting not sticking.
Fix: share one width, or say in the spec that it is per view.

### 9. Low: usage popover and auto-refresh (code read, not seen with real data)
- Without the footer, the popover is a short stack of labelled bars, each with a percent and "Resets in …" (`UsageMeter.tsx`). The reset time and the exact date are in a title tooltip. No "Updated" cue exists any more.
- A failed or slow refresh is silent: stale numbers stay on screen with no mark. A row whose reset time has passed reads "Reset due" until the next minute tick.
- The first open with no data shows "Usage not reported yet". The explanation that it refreshes by itself is only a title tooltip, so the empty state looks like a failure.
- The refresh runs only while the popover is open (mounted `UsageMeter`), plus whatever `usage.status` events arrive from runs. The footer bar (`UsageBar`) in the sidebar can therefore be stale until the user opens the popover.
Fix: show "Reading usage…" while the first read is in flight, add a quiet "Usage may be out of date" line when the last good read is over 3 minutes old, and refresh in the background while a run is live.

## Spec-level notes (for the Product Designer)
- Define the rule between the sidebar max, the panel max and the canvas minimum (finding 1) as one budget, not two independent clamps.
- Decide whether auto-collapse of the panel may fire from a user drag (finding 2).
- Decide what the toolbar keeps when the canvas is narrow (finding 4).

## Screenshot index
01 default Live 1440 dark. 02 sidebar handle hover. 03 mid-drag. 04 sidebar 352 (panel collapsed). 05 sidebar max. 06 panel hover. 07 mid-drag panel. 08 panel 584. 09 panel max 640. 10 account popover (mock). 11 handle focus. 12 rail. 13-15 light theme and popover. 16-18 1024. 19 org chart 1024. 20 org chart 1440. 21-30 second pass (1024 both wide, saved width clamp, focus rings, org chart wide).
