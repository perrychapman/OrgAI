# UX review: Outputs usability (too many buttons, small previews)

Reviewer: UX Researcher. Build: `fd67e020` (`npm run build` in this worktree). Ran on `ORGAI_MOCK=1`, token-free, with a seeded data dir (project "UX Outputs", two mock runs R1 and R2) driven by e2e/lib.mjs scripts. Windows 11. Sizes 1600x1000 and 1024x640 (`setContentSize`), dark and light (settings), mouse pass first, one keyboard-only pass at 1024x640 dark. Compared with `docs/design/outputs.md`, `outputs-2.md` and the earlier `ux-review-outputs*.md`. Shots, scripts and raw JSON (inventories and measurements): `e2e/shots/ux/outputs-usability/` (gitignored, not committed). Shot names: `<kind>-<Title>-preview|larger-<theme>-<width>.png` (for example `mermaid-Architecture_diagram-preview-dark-1024.png`), `s-*` for surfaces, `t-*` for tasks, `k-*` for the keyboard pass. Raw numbers: `kinds-all.json`, `surfaces-*.json`, `kinds.log`.

"Observed" means I saw it or measured it in the running app. "Inferred" means I read code or reasoned and did not see it.

## Seeded data (what the panel held)

13 outputs in one project: Word (Project plan, 2 versions, 1 note), Excel (Budget, 40 rows, 2 sheets), PowerPoint deck (Client deck, 5 slides, 1 note), Diagram (Architecture, 6 nodes), Markdown (Summary, 2 versions, 1 note), Text (Meeting notes; Handoff, registered), CSV (Report, 45 rows, 2 versions, 1 note), JSON (Config), SVG (Logo mark), Image (Site photo, 1200x800 PNG, registered), PDF (Signed report, registered, 394 bytes), "other" (Raw data .bin, registered). All 12 kinds, one output with several versions (Report, Summary, Project plan, v2) and three with user notes (Summary text note, Report cell note, Client deck slide note, Project plan block note added through the preload API).

## Verdict: BOTH COMPLAINTS CONFIRMED

The owner is right on both counts, and the two are one problem. The detail panel is the default place a user reads an output, it is 360 px wide at both window sizes (22% of 1600, 35% of 1024), and it spends its top 240-530 px on a stack of 9-26 controls before the content begins. At 1024x640 a diagram preview starts 529 px down a 640 px window, so the drawing itself is below the fold. At 1600x1000 the project Outputs tab gives the list 768 px (48% of the window) and the preview 360 px, although the list rows carry no controls at all and need only a fraction of that width. The Larger view is good for most kinds (full 1534x793 at 1600) but it is a second step, it is a full-screen modal even for PDF and unknown files where it shows one line of text, and for tables it shows a 224 px wide table in a 1500 px wide window.

## Ranked findings

| # | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| H1 | High | Diagram preview is unreadable and below the fold at 1024x640; two identical purple buttons both open the Larger view | `mermaid-Architecture_diagram-preview-dark-1024.png`: 26 controls in the panel, drawing box starts at y=529 of 640, drawing 283x24 px (zoom 30%, label text about 5 px). At 1600: 293x25 px, zoom 31%. |
| H2 | High | Previews sit in a fixed 360 px panel while the list takes 768 px; the user has to click "Larger view" for almost everything but plain text | Panel 360x952 (1600), list 768x904; `a-list-dark-1600.png`. Preview content widths 317-327 px at both window sizes. |
| H3 | High | 9 to 26 controls compete above every preview; 12-16 sit above the Preview tab alone | Inventory table below. Diagram 26, deck 25, SVG 22, image 19, text 13. |
| M1 | Medium | Larger view for PDF and "other" is a full-window modal with one sentence and the same Open button | `pdf-Signed_report-larger-dark-1600.png` (dialog 1568x968, content 1 line). |
| M2 | Medium | Tables (xlsx, csv) do not use the width in the Larger view | `xlsx-Budget-larger-dark-1600.png`: table 224 px wide in a 1534 px area; 40 rows needs 1134 px of scroll both in panel and in larger view. |
| M3 | Medium | Slide deck at 1024: stage 317x185 in the panel, 646x233 in the Larger view; filmstrip sits below the fold in the panel | `pptx-Client_deck-larger-dark-1024.png`: notes drawer open by default takes 300 px; stage 646x233 of a 958x433 area. |
| M4 | Medium | Image preview shows at 24-27% zoom; a 1200x800 photo appears about 290x190 px, and image rows/cards have no thumbnail | `image-Site_photo-preview-light-1024.png`; `s-grid-dark-1024.png` shows icons for Site photo, Raw data, Signed report while SVG gets a real thumbnail. |
| M5 | Medium | Comparing versions happens inside the 327 px panel; the same panel and tabs hold it for every kind | `t-c-compare-dark-1600.png`: compare area 327x344 next to 768 px of empty list. Works (5 added rows visible) but a wide diff would not. |
| M6 | Medium | Run side tab: R2 says "No outputs yet" although R2 produced new versions of 3 outputs | `s-run-list-dark-1600.png` (R2 tab text "No outputs yet. Agents can produce documents, workbooks and diagrams here."). Observed after relaunch ("Ended when OrgAI closed"). Inferred: `RunOutputs` filters on each output's original `runId` (`lib/outputsRun.ts:184`), so versions written by a later run never show under it. Verify live. |
| M7 | Medium | Run side tab rows carry two buttons each ("Show" plus "..."), 26 buttons for 13 rows; the project tab rows carry none | `s-run-list-dark-1600.png`. |
| L1 | Low | "Large diagram, 5 shapes. Zoom in to read, or open the larger view." appears for a 5 shape diagram | `mermaid-...-preview-dark-1600.png`. The note is right about reading but wrong to call 5 shapes large. |
| L2 | Low | "Mark an area  Off  Box  Circle  Add note" is a 5 control row on every diagram, image, SVG and deck; most users never mark an area | `image-Site_photo-preview-light-1024.png`. |
| L3 | Low | Keyboard: Larger view opens with focus on the drawing viewport, so Tab starts at Close; the content is the 10th Tab stop after nine toolbar buttons | Keyboard section. |
| L4 | Low | Kebab menu repeats buttons already visible in the panel (Open, Ask the team to revise...) | `s-menu-docx-dark-1600.png` (menu: Open, Show in folder, Save as..., Copy path, Rename..., Ask the team to revise..., Remove from list, Delete...). |

### H1 Diagram preview (details)

Observed at 1600x1000 and 1024x640, dark and light. The control stack in the panel for a diagram: Hide preview, Resize, Previous, Next, run link, Edit, Open, Ask the team to revise..., Off, Box, Circle, Add note, Larger view, More, three tabs (Preview, Versions, Notes), Diagram | Split | Source, Zoom out, Zoom in, Fit, Actual size, a second "More diagram actions" and "Open large": 26. "Larger view" (head row) and "Open large" (diagram toolbar) both open the same dialog (clicked both; the dialog opened at 150% with the same toolbar). Both are filled purple.

Recommendation: the panel becomes a "card": title, kind, a preview that fills the width, and at most three buttons (Larger view, Open, More). Zoom, view switch, mark area, export, copy source live only in the Larger view (they already exist there: `diagram larger controls` in the raw JSON). Delete "Open large". For a diagram that fits at 100% in the larger view, do not render it at 30% in the panel; render it as a fit-to-width image with no zoom bar. Suggested copy for the preview hint (drop it for small diagrams): "Click to open the larger view" as the whole preview being a button.

### H2 Panel width

Observed: detail panel x=1240 w=360 at 1600; the list x=472 w=768; each list row is a single line group with no controls. The panel can be dragged wider (separator "Drag to resize, double-click to reset") but nothing tells the user that before the first read, and the width is not remembered per kind (not tested). Recommendation, in order of cost: (1) default the panel to 45-50% of the window when the list is not in grid mode (about 640 px at 1600, 460 at 1024) or let the list narrow to 360 px; (2) make the preview itself the click target for Larger view and show an "Expand" icon on hover and focus; (3) offer "Preview below" vs "Preview beside". Suggested tooltip: "Open larger view (Enter)".

### M1/M2 Larger view uses of space

PDF and "other": Larger view button is shown, but the preview line is "OrgAI cannot preview this kind of file; open it instead." Suggested: hide Larger view for kinds with no preview and show the sentence once, with the real action as the one primary button: "Open in your PDF app". Suggested copy: "OrgAI cannot show PDFs yet. Open this file in your PDF app."

Tables: the xlsx and csv tables keep their intrinsic width (224 px). Recommendation: in Larger view, let columns grow to content (min 96 px, max 320 px) and freeze the header row; in the panel, keep as is. Add "Freeze header" or make it always.

## Button inventory

Counts are controls visible at rest (not hidden by `display`, `visibility`; no hover-only controls were found at rest, I did not hover every item) within the scope named. "Icon-only" means no text label (aria-label or title only).

### Surface: project Outputs tab (1600, nothing special selected)

| Control | Label / icon | Always visible | Plausibly needed | Recommendation |
| --- | --- | --- | --- | --- |
| Search | text field | yes | often | keep |
| Kind chips | All kinds + 12 kinds with counts (13 buttons, two rows at 1600, four rows at 1024 in a 200 px rail) | yes | rarely (once there are more than about 10 outputs) | move to overflow: one "Kind" dropdown or show only kinds present; single tab stop already (roving) |
| Run select | "All runs" dropdown | yes | rarely | keep, collapse under the kind filter as "Filters" |
| List / Grid | segmented 2 radios | yes | once | keep |
| Select | text button | yes | rarely (bulk delete) | move to overflow ("..." beside List/Grid) |
| Hide / show output preview | icon-only, tooltip "Hide output preview" | yes | rarely | keep (add visible label on first use) |
| Resize separator | icon-only drag handle | yes | rarely | keep, mention in a one time hint |
| Rows (13) | whole-row option, no buttons | yes | each | keep; the best pattern on the page |

Controls outside the detail panel: 18 (1 search, 13 chips, 1 select, 2 radios, 1 Select) plus 13 rows.

### Surface: output detail panel (project tab and run tab), per kind

Counts exclude rows. "Above tab" = controls above the Preview / Versions / Notes tab row. Measured with the driver; 1600 values equal 1024 values (same panel).

| Kind | Total in panel | Above tab | Preview box starts (y of 640 / of 1000) |
| --- | --- | --- | --- |
| Other (.bin) | 9 | 9 | about 270 / 270 |
| PDF | 10 | 10 | about 270 / 270 |
| Text, JSON | 13 | 13 | about 355 / 355 |
| xlsx | 15 | 12 | about 355 |
| csv, Markdown | 15-17 | 14 | about 370 |
| docx | 14 | 13 | about 400 |
| Image | 19 | 14 | about 425 (zoom bar then image) |
| SVG | 22 | 15 | about 425 |
| Deck | 25 | 15 | stage at y=355; filmstrip at y=653 (off screen at 1024) |
| Diagram | 26 | 16 | box at y=529 (1024), 508 estimated at 1600 in the run tab |

Controls (every kind carries a subset):

| Control | Label / icon | Visible | Needed | Recommendation |
| --- | --- | --- | --- | --- |
| Hide preview, Resize | icon only | always | rarely | keep |
| Previous / Next, "n of 13" | icon only chevrons, counter | always | sometimes | keep; move into the panel title row |
| Run link "R1" | text link, 14x16 px hit area | always | rarely | merge into the provenance line; make the hit area at least 24 px |
| Edit / "Edit in Word" / "Edit in Excel" / "Edit in PowerPoint" | text + icon | always (varies by kind) | sometimes | keep in the Larger view; in the panel keep one "Edit" |
| Open | text | always except svg | often | keep |
| Ask the team to revise... | text + icon | always | often | keep |
| Mark an area: Off / Box / Circle | segmented, 3 stops | image, svg, diagram, deck | rarely | move into the Larger view; reduce to one "Mark area" toggle |
| Add note (+ hint "Select text to add a note.") | text, disabled until selection | always (disabled most of the time) | sometimes | merge into the Notes tab ("Add note" is already there) and keep a selection popover |
| Larger view | text + icon | always | often | keep; make the preview itself clickable |
| More ("..." ) | icon only; menu of 7-8 items | always | sometimes | keep |
| Version select (v2 now, Orchestrator) | dropdown | multi-version outputs | sometimes | merge into the Versions tab |
| Tabs Preview / Versions n / Notes n | tabs | always | often | keep; fold Notes into Versions? Do not; keep (counts are useful) |
| Zoom out / readout / Zoom in / Fit / Actual size | icon + text, 4 stops | image, svg, diagram | rarely | move to Larger view; in the panel keep only a Fit toggle |
| Diagram / Split / Source | segmented | diagram, md | rarely | move to Larger view; panel default Diagram |
| Export, Copy source | text | svg, diagram | rarely | move to More |
| "More diagram actions" (second "...") | icon only | diagram | rarely | remove (duplicates More) |
| Open large | text, filled | diagram | duplicates Larger view | remove |
| Slide prev/next, "Revise this slide", Speaker notes, 5 thumbs | various | deck | sometimes | keep in Larger view; panel shows stage and slide counter only |

### Surface: Larger view dialog

| Kind | Controls (incl. Close) | Notes |
| --- | --- | --- |
| Other / PDF | 5-6 | content: 1 line |
| Text, JSON | 10 | content 1534x793 at 1600; 958x433 at 1024 |
| xlsx | 11 | table 224 px wide |
| csv | 21 | with notes drawer open by default |
| docx | 20 | content 1222x776 (1600), 646x416 (1024, notes drawer open) |
| Markdown | 23 | content 1222x737 (1600), 646x377 (1024) |
| Image | 15 | viewer 1534x793 (1600), 958x433 (1024) |
| SVG | 18 | drawing 600x360, does not fill the area |
| Diagram | 25 | 150% fit at 1600, drawing 1404x120; the toolbar has Zoom -, +, Fit, Actual size, Overview, Light drawing, Export, Copy source, Full window |
| Deck | 31 | stage 1046x697 (1600), 646x233 (1024) |

Recommendation for the dialog: group into two toolbars (document actions left, view actions right), put Notes drawer closed by default at 1024 (it takes 300 px; open it when "Notes (n)" is pressed), keep Escape-to-close.

### Surface: output list row / grid card

Rows: no buttons, title + ext badge + kind/size + provenance + "1 open note" badge + 48 px thumbnail (text-like kinds, svg, deck) or kind icon (image, pdf, other, xlsx? xlsx gets a thumbnail). Keep. Run side tab rows: "Show" (filled) + "..." per row: recommend making the row itself the click target and dropping "Show" (merge); keep "...". Grid cards: 177x163 (1600) and 223x192 (1024), no buttons, thumbnail + title + kind. Keep.

### Surface: versions and notes

Versions tab for Report (2 versions): 22 controls in the panel (16 are the standing header, 6 specific): Name version 2 (text field/button), version pick radio, View version 1, Compare version 1 with the current, Name version 1, Restore version 1, version pick. Compare screen: Back, two version selects, Swap, "Only rows with changes" toggle, previous change, next change: 8. Recommendation: keep; move "Name version" to the kebab of each version row ("Name...") since naming is rare.

Notes tab: Add a note on the whole output, output-note-select, Show in output, Resolve, Edit, Delete, Revise with these notes: 7 per note. Keep; "Delete" and "Edit" can move to a "..." menu once there is more than one note.

## Preview size per media kind

Measured with getBoundingClientRect on the content element in the project Outputs detail panel (width x height, px), then in the Larger view. Panel body 359 x 920 at 1600 (359 x 560 at 1024); window 1600x1000 / 1024x640. The content height of text-like kinds is its full length (the panel scrolls); only the width is the usable measure.

| Kind | Default preview 1600 | Default preview 1024 | Legible without Larger view | Clicks to a comfortable view | Larger view (1600 / 1024) | Recommended default |
| --- | --- | --- | --- | --- | --- | --- |
| Text | 317 x 1124 (mono, wrapped) | 317 x 1124 | yes | 2 to read, 3 for width | 1534x793 / 958x433 | keep; show first 40 lines and "Show all in larger view" |
| JSON | 317 x 1736 | same | yes | 2 | 1534x793 / 958x433 | keep; collapse nested levels by default |
| CSV | table 224 x 1242 | same | yes up to about 4 columns; 40 rows needs scrolling | 2 | table 224x1242 in 1534 wide (not widened) | show first 10 rows, sticky header, "45 rows, open larger" |
| xlsx | table 224 x 1134 | same | yes for 3-4 columns | 2 | same 224x1134 | same as csv; sheet tabs stay |
| Markdown | 317 x 1343 | same | yes | 2 | 1222x737 / 646x377 | keep |
| docx | 317 x 1561 ("Simplified preview") | same | yes, text and tables | 2 | 1222x776 / 646x416 | keep |
| SVG | 293 x 176 (73% of 400x240) | 283 x 170 | yes for simple graphics, no for detailed art | 3 | 600x360 (not filled) / 592x355 | fit to width, remove zoom bar from panel; Larger view fills the area |
| Image | 327 x 464 box, image about 288x192 (24%) | 317 x 313 box, 26% | no for detail, yes as a thumbnail | 3 | 1534x793 / 958x433 | fit to width with the toolbar hidden; click to open |
| Diagram | svg 293 x 25 (31%) | 283 x 24 (30%), box below the fold | no | 3 | 1404x120 at 150% / 924x79 | fit to width with a minimum scale 60%; if smaller, show "Open to read" and thumbnail |
| Deck | stage 327 x 191 (title legible, body about 5 px) | 317 x 185; strip at y=653, off screen | titles yes, bullets no | 3 | 1046x697 / 646x233 | stage fills width; strip and notes in Larger view |
| PDF | no preview: 1 text line | same | n/a | n/a | empty modal | show "Open" as the primary action; hide Larger view |
| other | no preview: 1 text line | same | n/a | n/a | empty modal | same as PDF; show size, path, Show in folder |

Observed zoom readouts: image 24% (1600), mermaid 31% / 30%. Does the Larger view use the space well: yes for text, json, markdown, docx, image, deck at 1600; partly for diagram (fit scales to the drawing, so a small flowchart fills 1404x120 of 1534x793, centered), no for xlsx and csv (fixed width), no for svg (600x360 of 1534x793), no for pdf/other (nothing to show). At 1024x640 the Larger view with notes drawer open leaves 646 px for the content (md, docx, deck); with the drawer closed it would be 958 px.

## Task friction

Observed with the driver at 1600x1000 dark, clicks counted (timings are driver timings including a 700 ms wait after each click, so not human times). Hand clicks are what a user performs.

| Task | Path and clicks | Notes |
| --- | --- | --- |
| (a) Find an output and read it | project: Outputs tab (1), row (2). The first row is selected by default so a panel is never empty. Run tab: Live (1), Outputs side tab (2), Show (3) | Good. The run side tab needs one more click than the project tab. |
| (b) Open it larger | + "Larger view" = 3 clicks. Diagram has a second button "Open large" | Esc closes and returns focus to Larger view (observed). |
| (c) Compare versions | row (1), Versions tab (2), "Compare version 1 with the current" (3): 3 clicks | Result renders inside the 327 px panel (`t-c-compare-dark-1600.png`): 5 added rows fit; wider diffs will not. |
| (d) Leave a note | row, double-click a word (2), Add note, type, Add note (or Ctrl+Enter): 5 interactions | Observed on Markdown at 1600. The floating composer appears over the panel header and hides the rows under it (`t-d-composer-dark-1600.png`). Works. |
| (e) Open or reveal the file | "Open" button (1 click from the panel); Show in folder: More (1) + menu item (2) | Not driven: native Open / Show in folder / Save as. |
| (f) Get back to where you were | Dialog: Esc (focus returns to Larger view, observed). Run tab: "Back to outputs". Project tab: nothing to undo | Fine. |

## Keyboard pass (1024x640, dark, observed)

- From the Outputs tab: Tab goes search, kind chips (one stop: roving), run select, List/Grid (one stop), Select, the list (one stop), then "Show output preview" (the panel was collapsed in a fresh launch) and out of the view to the page skip links. Seven stops, good.
- In the list, ArrowDown moves focus but not the selection; Enter selects and moves focus to the preview heading; Escape returns to the row (observed). Good.
- Larger view: opens with focus on the drawing viewport, not the dialog title or Close. Tab order afterwards: Close, Open, Off, Box, Circle, Add note, More, Preview tab, Notes toggle, Zoom out, then the drawing: the content is the 10th stop for an image (9 for a diagram: Preview, ... Zoom). Tab wraps inside the dialog (trap works). Escape closes and returns to "Larger view" (observed).
- Focus ring: a 2 px solid outline appears on every stop; Off/Box/Circle shows an extra purple box-shadow on the selected one. Visible in dark.
- Not covered: arrow keys inside slide strip and diagram pan (documented elsewhere); screen reader speech.

## Observed vs inferred

Observed: every number in this document labelled with a shot or table; control counts; click counts; keyboard order; PDF and other Larger view; duplicate "Open large"; diagram preview position at 1024; R2 "No outputs yet".
Inferred (code only): why R2 shows no outputs (`lib/outputsRun.ts` filters `o.runId`); that the panel is not remembered per kind.

## Not driven / could not verify

- Native Open, Edit in Word/Excel/PowerPoint, Show in folder, Save as (OS handlers; the mock does not exercise them). Their results are not known.
- Hover-only and focus-only reveals were not enumerated; the inventory is of controls visible at rest, so a control that appears on hover is not counted.
- Real files: I seeded a 394 byte PDF and a 8 byte .bin; a real multi-page PDF is shown by the same placeholder (kind has no preview), not driven. Docx is the app's own simple output, not a Word file with images.
- A live run, so the R2 "No outputs yet" finding is from a relaunched (ended) run: re-check in a live run.
- Image thumbnail absence in list and grid (icon instead of a thumbnail for the PNG): seen, cause not investigated (could be size, lazy generation or a mock limit).
- Large diagram (80 nodes), notes on other kinds, restore, delete, external-edit status, reduced motion, 320 px reflow: covered by earlier reviews and e2e, not repeated.
- Light theme was screenshotted for every kind at both sizes (`*-light-*.png`) and spot-checked (deck, Markdown, docx), with no theme-specific defects seen; I did not measure contrast.
- Timings are driver timings and not representative of a human.

## Top recommendations (ranked)

1. Make the panel a preview first: at most three buttons (Larger view, Open, More) and the preview directly under the title; move Mark area, zoom, view switch, export and version naming into the Larger view (H1, H3, L2).
2. Remove "Open large" and the second "..." from diagrams (H1); stop showing "Large diagram, 5 shapes" for small diagrams (L1).
3. Give the detail panel half the width, or make the preview click to open the Larger view (H2).
4. Hide Larger view for PDF and "other"; make "Open in your PDF app" the primary action (M1).
5. Fill the Larger view for tables, SVG and slide decks at 1024 (close the Notes drawer by default) (M2, M3).
6. Run side tab: drop the "Show" button on rows (the row is the target), and list outputs whose latest version came from this run (M6, M7).
7. Add an image/PDF thumbnail (M4) and let the compare view use the Larger view (M5).

## Re-walk after the fix (2026-11-17)

Reviewer: UX Researcher. Build under test: the uncommitted working tree of worktree `agent-a609828a1e4756c6d`, its `out/` built 2026-11-17 10:37 (I did not rebuild or edit it; the commit sha was not readable from here). Ran the built app on `ORGAI_MOCK=1`, token-free, with a throwaway data dir, project "UX Outputs", 17 outputs: all 12 kinds (diagram x4, image x2, text x2, and one each of csv, deck, xlsx, other, json, markdown, pdf, svg, docx), R1 `[mock:outputs-all]`, R2 `[mock:outputs-v2]` (5 outputs get version 2), R3 registered files (text, png 1200x800, .bin, handoff.txt, a tiny pdf). Three notes were added through the preload API (Summary text, Project deck slide 2, Report cell). Sizes 1600x1000 and 1024x640 (`setContentSize`), dark and light (settings), mouse pass then one keyboard pass at 1024x640 dark. Scripts, 139 screenshots and raw JSON (`m1-all.json` panel, `m2.json` larger view, `m3.json` widths, menus and drawer, `m4.json` run tab, `m5.json` keyboard): `e2e/shots/ux/outputs-recheck/` (gitignored). The seed differs from the first walk (17 outputs, not 13; the first walk's scripts were not available), so counts for a kind are comparable but not row-for-row.

"Observed" means I saw or measured it. "Inferred" means I did not see it. Counting rules: (a) every visible button, select, link, tab, radio, input and the Resize separator inside the output detail panel, as the first review counted; (b) Tab stops inside the panel (a tablist, radio group or the diagram toolbar counts as one; the scrollable content region counts as one stop). "Above content" is the chrome that sits above the preview (Hide, Resize, Previous, Next, run link, three tabs, toolbar); controls that live inside the preview region (zoom, view switch, sheet tabs, slide arrows) are listed as "in preview". Numbers are identical in dark and light and at both sizes unless a column says otherwise.

### Verdict: MOSTLY FIXED

Both original complaints are largely gone. The panel is now a preview-first card: the toolbar holds at most 4 controls, the preview starts 184 px from the window top (text) instead of 355 to 529, and the panel is 677 px wide at 1600 and 581 px at 1024 (was 360). The diagram, previously 293x25 px at 31%, is now 634x209 px at 115% (1600) and 538x178 px at 97% (1024). Larger view is reachable one way, closes with focus returning to its button, opens the Notes drawer closed at 1024, and widens tables. The Run side tab now lists R2's versioned outputs. What is left is polish and a few structural leftovers: the panel header is still 8 controls tall before the toolbar for every kind, the diagram still carries a second "..." menu, PDF and "other" panels are one line of text over a blank pane, and a few keyboard details.

### Before and after

Panel control counts per kind (baseline `fd67e020` first review, now this build). Cells for now are dark 1600; the other three combinations were identical.

| Kind | (a) total before | (a) total now | Above content before | Above content now | In preview now | (b) Tab stops now | Toolbar controls now | Preview top, window y before | Preview top, window y now |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Other (.bin) | 9 | 9 | 9 | 9 | 0 | 7 | 1 (Open) | about 270 | 184 |
| PDF | 10 | 10 | 10 | 10 | 0 | 8 | 2 (Open, More) | about 270 | 184 |
| Text | 13 | 12 | 13 | 12 | 0 | 11 | 4 | about 355 | 184 |
| JSON | 13 | 12 | 13 | 12 | 0 | 11 | 4 | about 355 | 184 |
| xlsx | 15 | 14 | 12 | 12 | 2 (sheet tabs) | 12 | 4 | about 355 | 184 (sheet tabs, table at 251) |
| csv | 15-17 | 12 | 14 | 12 | 0 | 11 | 4 | about 370 | 185 |
| Markdown | 15-17 | 14 | 14 | 12 | 2 (Rendered / Source) | 13 | 4 | about 370 | 184 |
| docx | 14 | 12 | 13 | 12 | 0 | 11 | 4 | about 400 | 211 |
| Image | 19 | 15 | 14 | 12 | 3 (zoom out, in, Fit) | 12 | 4 | about 425 | 228 (stage) |
| SVG | 22 | 15 | 15 | 12 | 3 | 12 | 4 | about 425 | 228 (stage) |
| Deck | 25 | 15 | 15 | 12 | 3 (Previous / Next slide, Revise this slide) | 13 | 4 | stage 355, filmstrip 653 off screen | 211 (stage); strip gone |
| Diagram | 26 | 19 | 16 | 12 | 7 (3 view radios, zoom out, in, Fit, "More diagram actions") | 12 | 4 | 529 (below the fold at 1024) | 228 (stage) |

Notes on the table. "Above content" is now the same 12 for every kind that has an Edit/Open, Add note, Larger view and More toolbar: Hide, Resize, Previous, Next, run link, Preview, Versions, Notes, plus the toolbar's four. The count dropped mostly because Ask the team to revise, Mark an area (3 radios), Larger view duplicates, Name version and the zoom stack left the head; some of those are now one level down in menus. The (b) number includes one stop for the scrollable content ("Meeting notes text", "Report table"), which is reasonable (keyboard users scroll it). Panel header height: top of the Preview/Versions/Notes tab row is at window y 160, the toolbar shares the same row as the tabs (observed), so the header is two rows (title and meta, then tabs plus toolbar), not the 240-530 px stack of the first walk.

Preview size, project Outputs detail panel (dark; light matches):

| Kind | Before 1600 | Now 1600 | Now 1024 | Notes |
| --- | --- | --- | --- | --- |
| Panel width | 360 (22%) | 677 (42%) | 581 (57%) | Panel body height 952 at 1600, 592 at 1024 |
| Text, JSON | 317 x 1124 / 1736 | 652 wide (pre fills 652x796 box) | 556 wide (box 556x436) | Reads at full panel width |
| xlsx, csv table | 224 wide | 650 wide | 554 wide | Table now uses the panel width (first review M2) |
| Image | image about 288x192 at 24% | 634x423 at 53% | 538x359 at 45% | Stage 652x752 / 556x392 |
| SVG (64x64 source) | 293x176 | 256x256 at 400% | 256x256 at 400% | Capped at 400% so a small icon stays small (not a defect, see M3 below) |
| Diagram, 6 shapes | 293x25 at 31% | 634x209 at 115% | 538x178 at 97% | Readable at both sizes; box starts at y 228 |
| Diagram, 80 shapes | not measured | 6091x235 at 60% | same | Large-diagram note shown, illegible without Larger view as expected |
| Deck | stage 327x191 | stage 652x367 (svg 650x365) | stage 556x313 (svg 554x311) | Filmstrip removed from the panel; slide arrows below the stage |

### Toolbar and where things live (observed)

- Toolbar controls at rest: Text, JSON, csv, xlsx, Markdown, docx, image, SVG, deck, diagram: 4 (Edit or Edit in Excel/Word/PowerPoint or Open, Add note, Larger view, More). PDF: 2 (Open, More). Other: 1 (Open). Target of 4 met.
- Duplicates between toolbar and More: none. More holds Open (kinds that show Edit in the toolbar), Ask the team to revise..., Show in folder, Save as..., Copy path, Rename..., Copy source (text-like and diagram), Remove from list, Delete.... For image, PDF and other, More has no "Open" (it is the toolbar button) and no "Ask the team to revise" (not offered for those kinds; the mock registered them, so this may be by design, inferred).
- "Mark an area" lives in the Add note menu: "Note on the selection", then a "Mark an area" group of radios Off, Box, Circle (`menu-addnote-diagram-1600.png`). Choosing Box returns focus to the button, whose name becomes "Add note, Marking: Box", and the panel shows "Marking an area: box. Drag on the drawing to place it. Press Escape to turn the tool off." A text output's Add note is disabled with the tooltip "Select text to add a note." (an icon-only disabled button).
- Larger view is an icon-only filled purple button with the accessible name and tooltip "Larger view". PDF and other have no Larger view button; Open is their only action (outlined, not filled, see M5).
- Diagram: one way into Larger view (the old "Open large" is gone). A second "..." ("More diagram actions") still sits in the viewer row beside the toolbar's "More actions" (observed, `menu-addnote-diagram-1600.png`, top right of the stage). Its contents were not opened.
- The "Large diagram, N shapes" note shows only for the 80 shape diagram ("Large diagram, 80 shapes."), not for the 6 shape one or the sequence diagram (first review L1 fixed).

### Panel and list widths, resize, hide (observed)

| | 1600x1000 | 1024x640 |
| --- | --- | --- |
| Filter rail | x 232, 240 wide | stacked above the list: 387 wide, 243 tall |
| List | x 472, 451 wide (was 768) | x 56, 387 wide, 349 tall including the filter rail |
| Detail panel | x 923, 677 wide | x 443, 581 wide |
| Drag handle left 120 px | 797 | 688 |
| Drag handle right 260 px | 537 | 428 |
| Double-click handle | back to 677 | back to 581 |
| Arrow Left on the focused handle | 693 (+16) | 597 (+16) |
| Hide output preview | panel 40 wide at x 1560, list takes the width | 40 wide at x 984 |
| Show output preview | 677 again | 581 again |

Drag-resize, keyboard resize and Hide/Show all work. After Hide, focus moves to "Show output preview" (observed). After clicking Show the focus drops to the document body (the Show button is replaced; observed by mouse click, the keyboard path was not tested separately).

### Larger view per kind (observed)

| Kind | Dialog 1600 / 1024 | Content area 1600 / 1024 | Notes |
| --- | --- | --- | --- |
| Other, PDF | no button | n/a | Open is the only action; panel shows one line plus a blank pane |
| Text, JSON | 1568x968 / 992x608 | 1534x829 / 958x469 | 7 controls |
| xlsx | same | table 1532 wide / 956 wide | Uses the width; two columns stretch to 750 px each, so right aligned numbers sit far from the labels (`lv-xlsx-dark-1600.png`) |
| csv | same | table 1532 / 956 wide | |
| Markdown, docx | same | 1534x829 / 958x469 (md), 1534x812 / 958x452 (docx) | Text blocks fill the width |
| Image | same | viewer 1534x785 / 958x425, image 1127x751 at 94% / 587x391 at 49% | |
| SVG | same | stage 1534x785, drawing 256x256 at 400% | Not filling because the source is 64x64 and zoom caps at 400% |
| Deck | same | stage 1358x717, slide 1244x699 / stage 782x357, slide 604x339 | |
| Diagram | same | stage 1534x768, drawing 1104x364 at 200% / 924x305 at 167% | Opens fit, not at a tiny zoom |

Notes drawer at 1024x640: closed on open for Summary (1 note), Project deck (1 note) and Report (1 note); the button reads "Notes (1)" and the content gets the full 958 px (`n-lv-Summary-1024.png`). The drawer open state was not exercised by opening it. Control counts in the dialog (including Close) went from 5-31 to 7 (text), 8-10 (tables, docx), 9 (md), 11-13 (image, svg), 12 (deck), 20 (diagram).

### Run side tab (observed)

| Run | Rows before / now | Controls per row |
| --- | --- | --- |
| R1 (outputs-all) | 12 / 12 | row "Show <title>" plus "More actions for <title>" |
| R2 (only added versions) | "No outputs yet" / 5: Report, Project deck, Architecture diagram, Budget, Project plan, each "v2 - 2 versions" (`run-1-dark-1600.png`) | same |
| R3 (registered files) | n/a / 5 | same |

Per row: before 2 buttons (filled "Show" plus "..."), now 2 tab stops (the row itself is a button named "Show <title>" and a "..." menu) and one visible icon. M6 is fixed, with one caveat: this was a relaunched (ended) run. I did not drive a live run. The side tab at 1600 is 358 wide, at 1024 607 wide.

### Keyboard pass, 1024x640 dark (observed)

- Tab order in the panel from "Hide output preview": Hide, Resize (separator), Previous, Next, run link "Open run R2", Preview tab (the tablist is one stop), Edit, Add note, Larger view, More, view switch (one stop for the diagram toolbar), then the diagram viewport. 12 stops; then the page wraps to "Skip to content".
- Selecting a row with the mouse leaves focus on the preview heading, so Tab goes next to "Open run R2"; Previous/Next/Hide are reached backwards. Keyboard list behavior matches the first review: ArrowDown moves focus, Enter selects and moves focus to the heading, Escape returns to the row.
- The diagram toolbar ("Diagram controls") is a roving toolbar: one Tab stop, then ArrowRight walks Zoom out, Zoom in, Fit, More diagram actions and wraps; in the Larger view it also visits Actual size, Overview, Light drawing, Export, Copy source and Full window. Arrow keys in the radio group (Diagram, Split, Source) work with ArrowDown/ArrowUp; ArrowRight from the checked radio skips Split and Source and goes to Zoom out. The viewport itself answers "+", "-" and "0" (97% -> 122% -> 78% -> 97%).
- Add note menu: Enter opens with focus on "Note on the selection"; ArrowDown goes Off, Box, Circle and wraps; Home and End work; Esc closes and focus returns to the Add note button; Enter on Box applies it and returns focus to the button (`k-addnote-open-dark-1024.png`).
- More menu: Enter or Space opens on "Open"; ArrowDown cycles through the 9 items and wraps; Home works; Esc returns focus to "More actions for Architecture diagram". Tab inside the open menu moves to the next item and leaves the menu open (it does not close the menu; observed).
- Larger view: opens with focus on the drawing viewport, not on Close. Tab order: Close, version select, Preview tab, Edit, Add note, More, "Show notes", view switch toolbar, viewport; then it wraps inside the dialog (trap works). Esc closes and focus returns to the "Larger view" button.
- Focus ring: 2 px solid purple (`rgb(165, 146, 255)`) on every stop I sampled. Not measured: contrast.

### Remaining issues, ranked

No High items remain. Ranking is by what a first-time user would hit.

| # | Severity | Finding | Evidence | Recommended fix and copy |
| --- | --- | --- | --- | --- |
| M1 | Medium | "Ask the team to revise..." is now only in the More menu. It was a visible button and is a main reason to open an output. A first-time user will not look under "..." for it. | `menu-more-diagram-1600.png`: item 2 of 9 | Keep it as a labelled toolbar button for kinds that support it ("Ask for changes") and drop "Open" into More; or replace the first toolbar slot's label with it. The toolbar stays at 4 for revisable kinds if Add note and Larger view become one overflow. Suggested button copy: "Ask for changes". |
| M2 | Medium | Two "..." buttons side by side on a diagram: "More actions for X" and "More diagram actions". The first review asked for the second to be removed. | `menu-addnote-diagram-1600.png`, `k-more-open-dark-1024.png` | Merge "More diagram actions" into the main More menu or rename to "Diagram options" with a visible label. Contents of the second menu were not opened, so check what it holds first. |
| M3 | Medium | Larger view of an SVG shows a 64x64 icon at 400% (256 px) in a 1534x785 stage; no readable way to know it is capped. A deck's image slides and small icons look unfinished. | `lv-svg-dark-1600.png` | If the zoom cap stops fit-to-window, show "Fit (400% max)" in the readout or raise the cap for SVG only, since vector scales cleanly. |
| M4 | Medium | The filter rail eats half of the left column at 1024x640: filters and kind chips are 243 px tall, the list gets about 350 px and shows 5 rows. The panel got wider, but the list is now the cramped part. | `p-pdf-dark-1024.png` | Collapse the kind chips into one "Kind" dropdown or a single scrolling row under 1100 px wide; keep search always visible. Suggested label: "Kind: All (12)". |
| M5 | Medium | PDF and "other" panels are one line of text above an empty pane (the "other" panel was measured but its screenshot was not inspected); Open is outlined, not the primary. | `p-pdf-dark-1024.png`: header and one sentence, then blank space | Make Open the filled primary, and fill the pane with the file facts and "Show in folder": "OrgAI cannot show PDFs yet. Open the file in your PDF app." is fine; add size, path and a primary "Open in your PDF app". |
| L1 | Low | After Show output preview the focus drops to the page body (observed by mouse click). | `m3.json` `shownFocus` = BODY at both sizes | Move focus to "Hide output preview" after Show. |
| L2 | Low | Disabled "Add note" on text kinds is an icon-only button that explains itself only through a tooltip ("Select text to add a note."). | `m3.json` `addnote-text` | Show the hint as helper text under the toolbar for a few seconds on first select, or keep the label "Add note" visible. |
| L3 | Low | Menu keyboard: Tab inside the open More menu moves between items and does not close the menu; ArrowRight from the Diagram radio skips Split and Source (they need ArrowDown). | `m5.json` `moreTab`, `m7` output | Close the menu on Tab and return focus to its button. Make Left/Right move inside the radio group before leaving it. |
| L4 | Low | The diagram and image sit in the lower half of the stage, and the right-hand shapes touch the right edge (Event bus ends 18 px from the stage border at 1600), leaving about 120 px of empty space above. | `p-diagram-dark-1600.png`, `p-image-light-1600.png` | Centre the fit vertically with the same padding on all four sides. |
| L5 | Low | In the Larger view, a 2-column xlsx stretches each column to 750 px so numbers sit far from their labels. | `lv-xlsx-dark-1600.png` | Cap column width at about 320 px and let the table be as wide as its content, left-aligned. |
| L6 | Low | The Run tab row's accessible name is "Show <title>" while the whole row is the target; there is no visible "Show", so the name reads as an instruction the row does not display. | `m4.json` | Name the row with its title and kind ("Report, CSV, 2 versions"), keep "More actions for Report" on the menu. |

### Did the fix meet the targets?

- Controls at rest in the toolbar at most 4: met (1 to 4).
- Toolbar and More duplicates: none observed.
- Mark an area: inside Add note, as a radio group (one control instead of 5).
- Drag-resize and Hide/Show: work; keyboard resize works (Arrow keys 16 px).
- Larger view: tables use the width, SVG limited by its 400% cap, notes drawer closed at 1024, PDF/other have no button.
- R2 lists its versioned outputs: yes, after relaunch; live run not driven.
- Diagram: one entry into Larger view, opens at 97% to 115% in the panel (200% / 167% in Larger view), no "Large diagram" note for the small one: met.
- Keyboard: Tab order and menu focus return behave as described; two small gaps (L1, L3).

### Not driven in this re-walk

- Native Open, Edit in Word/Excel/PowerPoint, Show in folder, Save as: OS handlers, not exercised.
- A live (not ended) run for the Run side tab.
- The contents of "More diagram actions", the Larger view Notes drawer when opened, restore, delete, compare, grid mode, reduced motion, 320 px reflow and the Broken diagram preview (no stage measured).
- Real multi-page PDF and a real Word/Excel file; the PDF here is a 69 byte stub.
- Screen reader speech, and contrast numbers (light theme was screenshotted for every kind at both sizes and showed no theme specific defects at a glance, not measured).
- Hover-only and focus-only reveals beyond the menus above.
- Timings are driver timings.
