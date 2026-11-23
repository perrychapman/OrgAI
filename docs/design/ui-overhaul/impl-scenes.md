# UI overhaul: scenes (Pocket Office and Factory floor), implementation notes

Lead: ov-scenes, 2026-11-22. Boards: `project/Office.dc.html`, `project/Factory.dc.html`. Scope: the DOM chrome around
the real scenes (pixel sprites, three.js floor). The boards draw both scenes with plain shapes at 16 agents (README
"Loose ends"); those drawings were not copied. Scene logic, cues, fallback rules and the "no import between Pocket
Office and Factory Floor" rule are unchanged.

## Host contract (agreed with ov-run)

- `LiveRunView` mounts `<OfficeScene mode="live">` and `<FactoryScene>` unchanged inside `.frame-stage`, which owns the
  glass frame, radius and clip, the canvas theme dropdown, Canvas style, the earlier-sessions loader, Show conversation,
  the plan strip and the minimap row.
- Both scene roots are now transparent, so the run view's stage shows through. The Factory 3D canvas still paints its
  clear colour (= `--surface-0`, unchanged by ov-foundation).
- ov-run keeps `.live-panel[data-office-palette]`, `.office-inspector*` and `.factory-inspector-action` unchanged; their
  rules were not restyled here (they keep the pixel-paper palette that matches the scene).
- The org chart Show filter is ov-run's; the scenes draw their own.

## Office board

Built:
- Toolbar over the stage: **Find a person** (a glass chip; the native `<details>` roster now drops over the stage,
  Escape closes it and returns focus, a press on the stage closes it, a pick leaves it open), the off-screen cue chips
  (unchanged logic, amber tint) and a **Show** filter `All n / Working n / Waiting n` (live only; `SegmentedControl`
  radios). The filter dims the art of people outside it (`data-office-dimmed`, opacity, no transition) and narrows the
  Find list (with a note of how many are left out). Nobody moves, hides or loses their button or nameplate contrast.
  Counts come from agent statuses through `officeState` (`lib/office/showFilter.ts`, unit tested).
- **Zoom group** `− 2x + Fit` as a glass overlay at the stage's bottom left (IconButtons named Zoom out / Zoom in; the
  `office-zoom` readout is unchanged).
- **Message log** glass card (live): "Message log", the run's message count, **Pause motion** (moved here from the
  toolbar; same `office-pause` testid, same inert rule under Reduce motion), then the three-row strip. Rows now read
  `From to To · text` with bold names, a relative time (`relativeTime` from `AgentMessage.at`, a 30 s text tick while
  rows exist) and the `Show {To}` button. The strip's 73 px height, focus hold and region are unchanged.
- **Needs you nameplate**: amber-tinted plate with an amber edge and semibold name (the `?` mark and the word stay).

Deviations:
- The board's arrow `→` between names is the word "to" (plain language, and it keeps the row text e2e reads).
- Room labels keep the pixel-paper look and their existing `Name · n`; the board's coloured room square is left out
  because rooms have no colour identity in the app.
- The board shows Pause motion in the log header and the zoom group in a row under the scene; here the zoom group sits
  over the stage so the scene keeps its height.

## Factory board

Built:
- Top row over the stage: **Find a worker** (glass chip, moved out of the bottom toolbar; its popover now opens below)
  and the **Show** filter (live). The filter keeps nameplates outside it off the floor through the label layer's hidden
  set (the selected, focused or hovered worker keeps theirs), dims floor plan tiles outside it, and narrows Find
  (earlier sessions drop under Working / Waiting). `lib/factory/showFilter.ts`, unit tested.
- Bottom row: the role=toolbar (Zoom out, Zoom in, Fit, Pause motion; roving tabindex unchanged), the **Stack light**
  legend (Failed red, Needs you amber, Running cyan, words always shown; hidden below an 880 px stage, where plates and
  tiles still carry the words) and the **Floor log** chip (`Floor log n` with a chevron; the e2e text check was updated).
- **Labels**: nameplates are rounded, near-solid surface plates (no backdrop blur: up to 24 move with the camera) whose
  edge takes the lamp colour; line signs show the line on one row and the lead under it (text content unchanged).
  Floor plan tiles are rounded with a lamp-tinted edge (amber fill for Needs you).
- **3D lamps** (Technical Artist ta-lamps): the Running lamp and the plan board's active step take `--working` (cyan),
  done steps take `--success` (green) with a near-black check mark; the message capsule moved from cyan to magenta
  (dark `#f07ad8`, light `#a0237f`) so it never reads as a lamp. Palette and kit tests updated.

Deviations:
- No zoom percentage in the Factory toolbar (the board's "100%"): the camera has no fixed 100% view.
- The 3D stations outside a Show filter are not dimmed (that needs an engine change); their nameplates go instead.

## Needs runtime

Nothing. Every drawn chrome element is fed by data the renderer already has (agent statuses, lamps, `AgentMessage.at`,
message count, dock count, plan counts).

## Verified

- `npm run typecheck`, `npm test`, `npm run build`, `e2e/office.mjs` (includes `pocket-office.mjs`),
  `e2e/factory-floor.mjs` and `E2E_FACTORY_PLAN=1 e2e/factory-floor.mjs` in the worktree after merging dev (see the
  hand-back report for the exact results).
- Screenshots from the e2e runs looked at: Office live at 1600x1000 dark; Factory floor plan at 1600x1000 dark and
  1024x640 light.
- Reviewer (rev-scenes): no Critical or High. Fixed: roster closes on a press on the stage (M1); dimmed people keep full
  nameplate contrast (M2); the Find count is named "people" (L1); legend swatch on tokens (L2).

## Open

- The settings sample pictures (`assets/factory/sample-*.png`) still show the old green Running lamps and cyan capsules
  unless the hand-back says they were regenerated (`scripts/render-factory-sample.mjs`).
- 3D screenshots of the new lamp colours were not looked at by eye in both themes at full size.
- Not walked with a screen reader; no mock UX walkthrough beyond the e2e runs.
- Reviewer lows left: the log's `h3` level depends on the run view's heading outline (ov-run); the inert Pause motion
  keeps its existing title-only reason.
