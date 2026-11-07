# UX review: Run outputs, walk 2 (viewing, diagrams, editing and iteration)

Reviewer: UX Researcher. Build: 6722ffd9 (dev `0.1.7-dev1`), `npm run build` in this worktree. Ran on `ORGAI_MOCK=1`, a throwaway data dir, a custom `ORGAI_MOCK_SCRIPT` (the built-in `[mock:outputs]` makes only docx, xlsx, one small diagram, markdown and a PNG, so the script adds csv, json, text, svg, a 40-service diagram, a sequence diagram and a deliberately broken diagram). Windows 11. Sizes 1600x1000 and 1024x640, dark and light, mouse first, then a keyboard pass at 1024x640. Two runs in one code project (to see what a second version looks like), one engagement project (Acme Corp) with one run. Compared with `docs/design/outputs.md` and `ux-review-outputs.md`. Shots and walk scripts: `e2e/shots/ux/outputs-2/` (gitignored, not committed).

Native Open, Show in folder, Save as, Copy SVG's clipboard result and Copy path were not driven (native or clipboard).

## Verdict: NOT GOOD ENOUGH FOR DIAGRAMS; VIEWING FINE, OWNING NOT BUILT

Viewing a small document, sheet, csv, json or text file works and is tidy. The owner's complaint is right for three concrete reasons. (1) Diagrams are drawn at a fixed zoom range with no pan, no wheel zoom and a "Fit" that gives up at 25%, so any real diagram is either unreadable or blank; the side panel gives them a 245-358 px box. (2) After the agents produce something, the user can only look at it or hand it to an external program; there is no edit, no version history and no way to ask the team to revise it from the output. A second run writes `name (2).ext` beside the first and the two are unrelated rows with identical titles. (3) The Outputs surfaces are a list plus a preview and nothing else: no thumbnails, no prev/next, no compare, no share.

## Findings

### Diagrams (called out separately)

**D1 (High). A large diagram opens blank or as 4 px dots, and Fit cannot fix it.**
Where: run side tab detail and Larger view. Shots: `20-large-dark-1600`, `20-large-light-1024`, `22-big-larger-dark`.
Repro: run with a 40-service flowchart (`flowchart TD`, 80 nodes, 2.7 KB source). Run tab > Outputs > Large system map.
Seen: the zoom readout says 25% and the pane at 358x440 (245x320 at 1024) is empty at the top; the drawing is 981x1255 px inside it and the visible part is blank until you scroll. In Larger view (1534x795) the drawing is a thin diagonal strip at the right with labels about 4 px high and still scrolls vertically; "Fit" stays at 25%. At 100% the drawing is 3922x5020 px. Fit never goes below 25%, so a diagram bigger than 4x the box is never "fitted"; the control still says Fit.
Why it matters: this is the case where the user most needs the picture, and the first impression is an empty box.
Direction: drop the 25% floor for Fit (fit to the box whatever the scale), scroll to the drawing's top-left (or centre) on open, and show a one-line note "Large diagram, 80 shapes. Zoom in to read, or open the Larger view." Pair with D2.

**D2 (High). There is no pan and no wheel zoom; the only way around is scrollbars.**
Repro (code project, 1600x1000): hover the Large system map, plain wheel, Ctrl+wheel, then click-drag.
Seen (measured): plain wheel scrolls the box (scrollTop 0 to 300); Ctrl+wheel does nothing (zoom value stayed `fit`, scroll stayed 0); drag does nothing. Zoom is only the minus/plus buttons, the three keys `+ - 0` once the region has focus, and the Fit and 100% buttons. Code confirms it: `MermaidView.tsx` has no wheel or pointer handlers.
Why it matters: every diagram viewer people know zooms with the wheel (or Ctrl+wheel) and pans by dragging. Without them a 4000 px diagram is unusable with a mouse and trackpad pinch does nothing.
Direction: Ctrl/Cmd+wheel and trackpad pinch zoom at the pointer, drag to pan (cursor grab), double-click to toggle Fit and 100%, and say so in the zoom bar's tooltip. Keep the scroll bars.

**D3 (High). Small diagrams are legible only by luck, and the panel wastes most of its space.**
Shots: `20-architecture-dark-1600`, `20-architecture-light-1024`.
The 4-node architecture diagram renders at 60% (39% at 1024) inside the panel; labels are about 7 px (about 4-5 px at 1024: "Database", "Queue" are barely readable in `20-architecture-light-1024`), while the box is 440 px tall with the drawing in its top 110 px. Fit scales to width only. The panel also sits under a stack of header, meta, Open, view switch, zoom bar and Copy SVG (about 230 px) before the drawing starts; at 1024x640 the drawing is below the fold.
Direction: when a diagram fits at 100% never shrink it below 100% (Fit = min(fit, 1)), centre it, and shorten the control stack (one toolbar row: Diagram | Source, zoom, Copy/Export, Larger view). Default to opening the Larger view for diagrams, or make Larger view the primary action ("Open large").

**D4 (Medium). Export is only "Copy SVG" (into the clipboard); no PNG, no SVG file, no source copy.**
Where: `MermaidView` toolbar and `OutputActions` menu. Seen: the toolbar has Copy SVG; the More menu has Open, Show in folder, Save as, Copy path, Remove, Delete. "Open" for a `.mmd` file hands it to whatever the OS associates (usually nothing useful on Windows; not driven). The consultant's real need is a picture for a slide: PNG, or SVG, saved or copied. Source view has no Copy button, so editing the diagram means opening a text file elsewhere.
Direction: "Copy as image (PNG)", "Save as image..." (PNG/SVG) and "Copy source" in the toolbar or menu; keep Copy SVG.

**D5 (Medium). Diagram theme follows the app theme, so a diagram pasted into a client deck is dark.**
Dark app renders Mermaid's `dark` theme (dark boxes, light text, see `20-architecture-dark-1600`); light renders `default`. Fine for reading, wrong for export. Direction: export always in the light "default" theme (or ask), and offer an optional "Light drawing" toggle in the preview.

**D6 (Medium). Zoom bar order reads wrong: "Fit  100%  +  60%".**
Shots: `20-architecture-*`. "100%" is a button (set to 100%), the "60%" after the plus is the readout. Users read "100%" as the current value. Direction: group `-  [60%]  +` together with the readout in the middle, then "Fit" and "100%" as separate labelled buttons ("Actual size").

**D7 (Low). Broken diagram: good message, thin help.**
Shot: `20-broken-light-1024`. It falls back to Source with "This diagram could not be drawn: Parse error on line 2." and the source in a box. Good. Missing: the text does not say whether the file or the agent is at fault, and there is no "Ask the team to fix it" action. Suggested copy: "This diagram has a syntax error on line 2, so it cannot be drawn. The source is below. Ask the team to fix it, or edit the file."

**D8 (Low). Sequence and other types render fine** (`40-sequence-dark-1600`); not further checked (gantt, ER, mindmap not produced).

### Finding outputs

**M1 (Medium). The Live view opens on the transcript; outputs are discoverable only through a chip and a tab.**
Shot: `01-live-code-1600-dark`. After a run the right panel shows the Transcript tab with 12 rows reading "Produced Diagram Architecture diagram Show". The meta chip "12 outputs" (icon plus count) is the only cue; the Outputs tab label has no count. Direction: a count on the tab ("Outputs 12"), and the transcript row copy "Produced diagram: Architecture diagram" (kind word and title are currently run together).

**M2 (Medium). Project Outputs tab: wide list, empty preview, nothing to scan by.**
Shots: `50-project-outputs-dark-1600`, `83-engagement-outputs-dark`. At 1600x1000 the list is about 770 px wide with one text row per output (kind icon, title, size, path, role and run) and a 360 px panel that reads "Select an output to see its preview here." No thumbnails, no first-line preview, so 23 rows with 11 duplicate titles are indistinguishable except by a path suffix. Rows are listed by run order, not grouped by deliverable. Direction: preview-first layout (thumbnail or first lines in each row), default-select the newest output so the panel is never empty, and group repeated titles (see E4).

**M3 (Medium). Switching between outputs costs a round trip.**
In the run side tab a narrow panel replaces the list with the detail ("Back to outputs"); there is no previous/next. Reviewing five deliverables is open, back, open, back. Direction: Prev/Next buttons and Alt+Left/Right in the detail and in Larger view ("3 of 12").

**M4 (Medium). "Show details" 12 times: the transcript rows are all the same shape.** Not a finding by itself; see M1.

### Viewing the other kinds

**V1 (Low). Document and sheet previews are honest but read-only and small.** Docx preview says "Simplified preview. Open the file for the exact layout." (`82-engagement-doc-dark`); the spreadsheet shows `=SUM(B2:B3)` as text, correctly flagged as intentional in the spec, but a consultant reading a Budget sheet will see a literal formula where a total should be (`20-budget-dark-1600`). Suggested sheet note when a cell starts with "=": "Shown as text. OrgAI does not calculate formulas."

**V2 (Low). SVG is "not openable" while diagrams are.** The More menu on an SVG says "OrgAI does not open this kind of file. Show it in its folder instead." and a PNG says the same; Open appears for text, csv, json and diagrams. A user cannot tell why an image has no Open. Direction: hint "Images open from the folder: use Show in folder" is fine, but then offer Copy image and Save as on the toolbar.

**V3 (Low). Kind chips are nine separate Tab stops** in the Outputs filter (keyboard pass: `outputs-kind-all`, then eight more, then the Run select, row, Show). Direction: one roving Tab stop with arrow keys, like the list.

**V4 (Low). Keyboard: Enter on a project-tab row moves focus to the detail heading; Esc did not move focus back to the row** in this pass (activeElement stayed `output-detail-heading` after Esc; I did not check whether the panel closed). The earlier walk reported Esc returning to the row in the run side tab; this is the project tab. Re-check.

**V5 (Low). History works:** "11 outputs" / "12 outputs" per run row, as specified. Run 2 shows 11 because the mock re-registered nothing; not an issue.

## Editing and iteration gaps

The product the owner describes (client deliverables in many formats, a PowerPoint deck to come, view and edit in OrgAI) needs a loop: produce, read, correct, revise, compare, send. Today the loop stops after "read".

| What a consultant wants | What OrgAI offers today (observed) | Gap |
| --- | --- | --- |
| Fix a sentence in a document | Nothing in app. Docx preview is read-only ("Simplified preview"); Markdown has Rendered and Source views, both read-only. "Open" hands the file to the OS default (Word), then OrgAI does not notice the change (not driven; no watcher in code) | In-place edit for Markdown, text, csv, json, diagram source at minimum; for docx an "edit text" path or a reliable round trip with the file |
| Change a cell | Sheet preview is read-only; formulas are text; cap on rows | Cell edit, or at least "Open in Excel" plus refresh when the file changes |
| Ask the team to revise one section | No action on an output. The user must go to Live, type into the composer, and name the file in words. Output rows do not carry the agent or a "revise" shortcut | "Ask the team to change this" on every output: opens the composer in that run (or a new continuation) with the output attached and a one-line prompt stub; select-text-to-comment on documents |
| Compare with the previous version | None. A second production of `project-plan` writes `project-plan (2).docx` (measured: all 11 files doubled, 23 rows, identical titles, only the path suffix and "R2" differ). Only the same run may overwrite (`overwrite`), and nothing links the two | Version chain per deliverable: one row "Project plan, v2" with earlier versions behind it, a side-by-side or change view (text diff for markdown, csv, json, diagrams; paragraph diff for docx; cell diff for xlsx) |
| Restore an earlier version | Not possible; the old file exists as a separate file and an index entry that you can only hide | "Restore this version" (copies it forward as the newest, never destroys the current) |
| Keep earlier versions | Accidentally, via the " (2)" suffix; nothing names or protects them | Explicit versions: keep all, label by run and time, never overwrite across runs |
| Delete an output | "Delete file..." only for `source: produced` (code: `canDeleteOutput`); registered files get only "Remove from list" (my walk opened the menu on a produced SVG by mistake, so the registered Logo's menu was read from code, not seen). Delete's confirm says "cannot be undone" | One Delete that works for every output (with a clear "also delete the file" choice for registered ones, and a bin or undo window); bulk select and delete from the project Outputs tab |
| Export or share with the client | "Save as..." (native), "Show in folder", "Copy path", "Copy SVG". No PDF, no zip of the set, no "package for the client", no PNG | Export set ("Save selected as a folder or zip"), PDF export for docx and slides, image export for diagrams, "Copy as image" |
| Decks (PowerPoint, coming) | No kind. `OutputKind` has no pptx; unknown kinds fall to "File", Open only | A slide viewer (thumbnail strip, next/previous, notes) before agents start producing decks; otherwise decks will be as opaque as docx is |

Ordering by value for the engagement use case: ask the team to revise (cheap, uses what exists), version chain with restore (the "(2)" files already hold the data), delete for every output, then in-place edit for text-like kinds, then export and share.

## Engagement project

`[mock:outputs]`-style outputs work identically on an Engagement ("Acme review", client Acme Corp): the Outputs tab appears between History and Knowledge, rows say "Engagement Lead", and the doc preview shows the plan (`82-engagement-doc-dark`, `83-engagement-outputs-dark`). No engagement-specific problem found; the gaps above matter more here because deliverables are the point of the project. Not driven: a client-facing "package" step, since none exists.

## Ranked top problems

1. Diagrams (D1, D2): large diagrams open blank or illegible, Fit is capped at 25%, no pan or wheel zoom.
2. Diagrams (D3, D4, D5): small diagrams shrink instead of filling the box, no PNG/SVG file export or source copy, exported drawings follow the dark app theme.
3. No revise loop: no "Ask the team to change this" on an output (Editing gaps).
4. No version control: second runs create `name (2)` files and unrelated duplicate rows; no compare, no restore.
5. Read-only everything: no edit for text-like kinds, docx and sheets only open externally with no refresh.
6. Delete is only for produced files; registered files can only leave the list.
7. Project Outputs tab: empty preview panel, no thumbnails, no prev/next (M2, M3).
8. Discoverability on Live: transcript rows read "Produced Diagram X", tab has no count (M1).
9. No share/export set, no pptx kind or slide viewer for the coming decks.

### Diagrams only, ranked

1. D1 blank/unreadable large diagram and a Fit that cannot fit.
2. D2 no wheel zoom, drag pan or pinch.
3. D3 small diagram shrunk to 4-7 px text with a mostly empty box and a tall control stack.
4. D4 no PNG/SVG file export and no source copy; D5 dark diagrams for export.
5. D6 zoom bar order, D7 broken-diagram help text.
