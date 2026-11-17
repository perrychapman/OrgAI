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
