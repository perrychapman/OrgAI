# OrgAI UX review 3: N1 re-check (decision tray in the Live view)

Reviewer: UX Researcher. Build: dev HEAD `3cde179`, `npm run build`, `ORGAI_MOCK=1`, fresh temp `ORGAI_DATA_DIR`, two fixture repos (Alpha: Architect off, mock adapter on, default mock work script with the permission-gated Edit; Beta: Architect on, default mock setup script, which asks for Bash and then proposes an architecture). No tokens spent. Window `setSize` 1024x640 and 1600x1000 (renderer viewport 1008x641 and 1584x961), dark and light via `data-theme`. Shots: `e2e/shots/ux/runs3/` (`perm-*`, `prop-*`, `plain-*`; raw numbers in `results.json`). Driver: `e2e/shots/ux/_t/runs3.mjs`.

## N1 status: PARTLY FIXED

The structural bug is fixed. `section.frame-tray` now sits inside `.canvas-frame > .frame-grid` in every case, the canvas is no longer squeezed by a stray grid column, and the composer matches the canvas width. At 1600x1000 the card is good. At 1024x640 the tray still overlaps the canvas and the proposal's buttons are out of reach.

| Case | Canvas stage | Composer | Tray (in frame?) | Action buttons visible without inner scroll | Overlap |
| --- | --- | --- | --- | --- | --- |
| Permission, 1024x640 (dark = light) | 496 x 160 | 496 | 496 x 256, yes | yes, all 4 (tray scrolls 278 vs 255 px, bottom edge of "Deny" touches the legend) | tray over stage: tray starts 81 px into the 160 px stage and covers the Implementer node and the zoom controls (`perm-1024-dark`) |
| Proposal, 1024x640 (dark = light) | 496 x 160 | 496 | 496 x 256, yes | **no**: Approve and Request changes are below the fold; tray content 409 vs 255 px | same overlap; the Architect node is half-hidden behind the card (`prop-1024-light`) |
| Permission, 1600x1000 | 592 x 657 | 952 | 360 x 686 docked right, yes | yes | none |
| Proposal, 1600x1000 | 592 x 657 | 952 | 360 x 686, yes | yes | none |
| Plain run, no card | 496 x 309 at 1024; 952 x 657 at 1600 | 496 / 952 | none | n/a | none (unchanged, `plain-*`) |

Was (N1): canvas 47 px / 0 px at 1024, 503 px at 1600. Now 496 px at 1024 and 592 px at 1600 (docked tray beside it, as designed). Dark and light measure identically. Composer width is now the frame width, not 47 px.

Remaining defect at 1024x640 (Medium, High while a proposal is pending): `.frame-stage` has `min-height: 160px`, the tray is capped at `40vh` (256 px) and the frame is only 366 px tall, so the grid rows overflow and the tray paints over the stage. That breaks "nothing floats over the canvas". For the Architect proposal, the primary buttons need an inner scroll the user is not told about. Suggested fix: at heights under about 700 px dock the tray beside the canvas (lower the `min-width: 900px` container query, or key it on height too) or let the tray take the stage's place; keep the Approve / Request changes row sticky at the tray bottom; make the stage and tray rows share the frame height (`grid-template-rows: auto minmax(160px, 1fr) minmax(0, auto)` with the tray's `max-height` as a share of the frame, not `40vh`).

## New High findings

None. Window inner size under `setSize(1024, 640)` is 1008x641, so "1024" here is a little narrower than the nominal width; the 900 px container threshold is not the cause (frame width is 496 px because the side panel takes 280 px and the sidebar 232 px).
