# UX review: Live view panel resize (commit 0975e9d)

Method: built app, `ORGAI_MOCK=1`, fresh temp `ORGAI_DATA_DIR`, mock script with one question card and one permission card, driven with Playwright (mouse drags, keyboard). Sizes 2560x1392, 1800x1000, 1024x640 in dark and light. Measurements are bounding rects (`.canvas-frame` right edge against `.side-panel` left edge). Screenshots are in `e2e/shots/` (gitignored), prefix `pr-`.

## Verdict

The blank-strip fix holds. In every state measured, the canvas frame's right edge equals the panel's left edge (gap 0 px), with no horizontal scroll. The composer move keeps the draft. I found no P0 or P1 issues. The remaining findings are polish.

## What passed

| Check | Result |
| --- | --- |
| Gap between canvas and panel at 2560 (card docked in tray), 1800 (card stacked), 1024 (panel rail), sidebar full and rail | 0 px in every state. `pr-2560-dark.png`, `pr-1024-light.png`, `pr-x-1800-rail.png` |
| Gap with the tray empty (all decisions answered), 2560 | 0 px. Canvas fills to the panel, nodes recentre (`pr-x-2560-empty-tray.png`) |
| Gap during a continuous drag (samples at 580, 760, 940, 1120, 1288 px panel width at 1800) and after release | 0 px each time |
| Drag very wide and back, 2560 (to 2048) and 1800 (to 1288) | Canvas stops at exactly 280 px; Home resets to 280 panel, Enter and double-click reset to 400 |
| Keyboard: ArrowLeft/Right 16 px, Shift 64 px, Home, End, Enter, double-click | All behave as documented (`1800 default 400`, Right 384, Shift+Left 448, Home 280, Enter 400) |
| Composer move threshold | Exactly at panel width 480 (464 stays under the canvas, 480 moves into the right column). Draft text kept (`draft kept across move`). "Replying to Orchestrator" is clear and stays on the composer in both places (`pr-1800-light-wide.png`) |
| Tray at a 280 px canvas (1800, light) | Decision card stacks under the canvas and stays fully usable: options, free-text, Submit visible |
| Theme parity | Light and dark identical in layout |

## Findings

### P2-1. Composer is cramped when the panel is open at 1024 (and any canvas under about 520 px)
Flow: 1024x640, expand the side panel (`pr-x-1024-expanded.png`). The panel opens at 280 px, canvas 512 px, composer stays under the canvas. "Replying to Orchestra..." is truncated, and the hint "paste or drop ima..." is cut mid-word with no tooltip. Expected the label to win over the hint. Fix: hide the hint text below a container width (keep the help icon with a tooltip) so the "Replying to" label is never truncated.

### P2-2. Composer move makes the canvas jump (height and zoom) at 480 px
Measured at 1800x1000: at panel 464 the stage is 373 px tall, node scale 0.926. At 480 the stage is 469 px, scale 1.0, nodes shift about 17 px. During a drag the canvas visibly rescales as the 96 px composer leaves. It is not wrong (the composer then sits under the transcript where replies belong), but the jump is abrupt. I did not test the return path (dragging back across 480) for hysteresis. Fix: add a small hysteresis (move at 480, return at 450), and avoid refitting the view when only the stage height changes.

### P3-1. "End" jumps the panel to the maximum
End on the handle takes the panel to 2048 px at 2560 (canvas 280) and 1288 px at 1800. It is consistent with the no-max-width decision, but a user reading End as "wide" ends with a sliver of canvas and a transcript with 1500 px lines (`pr-x-2560-empty-end.png`). Fix: consider a soft max for End (for example half the frame), or leave End as is and note it in the handle tooltip.

### P3-2. Unbounded line length when the panel is very wide
Transcript rows, the Revise-with-the-Architect textarea and the usage rows stretch to 1500+ px (`pr-2560-dark-wide.png`, `pr-x-org-end.png`). Fix: cap the content column (about 90ch) inside the panel and let the extra space stay empty.

### P3-3. At a 280 px canvas the toolbar loses its labels
The Hide finished switch shows without its label and the run metadata (agents, cost, started, unattended) disappears entirely (`pr-1800-light-wide.png`). Acceptable at that width, but the switch is then unlabelled for sighted users. Fix: give it a tooltip and an `aria-label` (check it exists), and surface the metadata in a tooltip or the legend popover.

### P3-4. Org chart canvas at 280 px is cropped, not refitted
`pr-x-org-end.png`: the chart is cut off at both edges and the nodes render tiny. The toolbar wraps to two rows (fine). Expected a refit when the canvas width changes. Fix: call fitView on settled width changes (debounced), as the Live view appears to do.

### P3-5. The resize handle has no resting affordance
The handle is invisible until hover or focus. After keyboard use it leaves a persistent 3 px purple bar (`pr-x-2560-empty-end.png`, `pr-1800-light-wide.png`), which looks like a rendering artefact until focus moves. Fix: show a faint 1 px divider at rest, and keep the focus style only for keyboard focus.

## Not verified
- Focus stays in the textarea when the composer moves while the user is typing (the move is triggered by dragging, which moves focus to the handle, so this is unlikely to matter).
- Pasted attachments surviving the move (the same element is reused, so likely).
- Hysteresis on the return across 480 (see P2-2).
- Real window drag-resize with the OS; only `setContentSize` was used.

## Files
Only this report was written: `docs/design/ux-review-panel-resize.md`. The probe scripts live in the OS temp dir.
