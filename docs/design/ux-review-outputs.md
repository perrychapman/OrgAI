# UX review: Run outputs (post-landing walk)

Reviewer: UX Researcher. Build: 714e5d60 (dev 0.1.7-dev1; `npm ci` and `npm run build` in a worktree). Ran with `ORGAI_MOCK=1`, throwaway data dirs, 1600x1000 and 1024x640, dark and light, a mouse pass and a Tab pass at 1024x640. Compared with `docs/design/outputs.md` and the pre-walk `ux-review-outputs-pre.md`. Prompt: "[mock:outputs] write the project plan, budget and architecture diagram" on a code project and on an engagement. Shots: `docs/design/ux-review-outputs-shots/` (named below). Walk scripts are in `e2e/shots/ux/outputs-walk/` (gitignored). No source file changed.

## Verdict: MOSTLY FIXED (pre-walk H1, H2, M1, M2, M3, M5 closed; M4 partly)

The pre-walk's core complaint is gone. The five outputs appear in three places without clicking a node (side tab, RunMeta chip, project tab) and as folded rows in the orchestrator's transcript. Previews really work in the window: document, a sheet grid with two tabs, a drawn diagram, rendered Markdown and an image. Show, Back, Esc and removal all put focus somewhere sensible. Nothing counted as "Needs you" (the one decision was the Edit card). No page scroll at either size or theme (`scrollHeight == clientHeight` at 1024x640 on every view I sampled). No Critical or High findings. The weak points are scale (a 280 to 383 px panel is the default home for previews), irreversible "Remove from list", and a few vocabulary and announcement mismatches.

## Status against the pre-walk

| Item | Status | Evidence |
| --- | --- | --- |
| H1 outputs invisible outside one agent's transcript | Fixed | Orchestrator transcript, side tab and project tab list all 5 (`03-run-outputs-list-1600-dark`, `09-transcript-wide-dark`) |
| H2 no open / reveal / copy path | Fixed, native actions not driven | Menu: Open, Show in folder, Save as..., Copy path, Remove from list, Delete file... (`07-actions-wide`) |
| H3 permission card wording | Not built (spec 11), no card appears for produce_output | |
| M1 placement | Fixed | Tabs: Live, History, Outputs, Knowledge (engagement), Team, Settings |
| M2 RunMeta clip | Mostly fixed | Icon plus count under 1100 px; see L2 |
| M3 announcements, no attention count | Fixed, see M3 here | Bell stayed at 1 |
| M4 previews | Fixed beyond the pre-walk | but see M1 |
| M5 missing file | Not driven (the mock writes real files) | |

## Findings

### M1. Previews live in a 280 to 383 px column by default; the wide split is hidden behind a drag
Steps: 1600x1000, start the run, open the Outputs side tab. The panel is 383 px and `data-side-wide` is false, so every Show replaces the list with the detail (`04-run-docx-wide-dark`). At 1024x640 the chip opens the panel at its 280 px minimum, squeezing the canvas to about 460 px (`14-run-xlsx-1024-dark`).
- The sheet fits (2 columns), the document reads well, but the diagram's labels are about 7 px and there is no zoom, "Open" is the only way to see it (`04-run-mermaid-wide-dark`, `15-mermaid-1024-light`). A wider diagram would be unreadable.
- The split mode (list on top, preview below) only appears after widening the panel to 480 px or more. I reached it with Shift+Left on the "Resize run panel" separator (639 px, `22-split-xlsx-1600-dark`). No hint tells a user this exists, and at 1600x1000 there is room for it by default.
- Fix: at windows 1500 px and wider open the panel at 480 px when the user first views Outputs (or remember a wider default for this tab); give the diagram preview a Fit / zoom control and let its drawing use the preview's full height; offer "Open in the Outputs tab" in the detail for a bigger view (the project tab pane is 360 px at 1024 but 480 px or more at 1600).

### M2. "Remove from list" is permanent with no undo and no way to bring it back
Steps: side tab, More actions on Summary, Remove from list. A notice "Removed Summary from the list." appears at the top of the list and the chip drops to "4 outputs" (`17-after-forget-1024`). After a reload the item is still gone (4 rows). Project tab: same.
- The file is still on disk but the app has no way to show it again (spec has no "Show removed" and Forget has no confirm).
- The notice does not time out in the 5 s I watched it (checked once, not timed).
- Fix: an Undo link in the notice for 8 s (as Knowledge retire does), or a "Removed" filter; say in the menu hint that the file stays.

### M3. Announcements and numbers disagree
The frame's one live region read "Produced 4 outputs New decision: Edit example.ts" (read from the DOM at 1600x1000 after the run) while the chip, the list and the project tab all say 5. Two sentences are also joined without punctuation.
- A first-time user hears a count that does not match what they see, and the output sentence is run into the decision sentence.
- Fix: count registered outputs in the same window as produced ones, or say "Produced 4 outputs and registered 1"; join messages with a full stop or announce them separately.

### M4. Words differ between surfaces
Transcript: "Produced document Project plan", "Produced workbook Budget", "Produced file Summary", "Registered output Logo". Panel and project tab: "Document", "Spreadsheet", "Markdown", "Image", "Diagram" (chips: Documents, Spreadsheets). The kind chips never say Word or Excel, so a non-developer asking for "the Word doc" must infer Documents. The file extension is visible only in the path part of the meta line ("outputs/project-plan.docx"), which middle-clips at 280 px ("outputs/Architectu..." at `17-after-forget-1024`).
- Fix: use "spreadsheet" in the transcript row, "file" is vague for Markdown (use "Markdown file"); add the app word to the row meta ("Document (Word) · 9.9 KB") or make search match "word", "excel", "docx" as aliases (I did not test search with those words; code not read).

### M5. History has no hint of outputs
History shows one row ("Needs you", Open, Open in Live) with no output count or link (`19-history-1024`). The pre-walk asked for the same run to be findable here. I did not click Open to see where it lands. Fix: an "N outputs" quiet line or chip on the row that opens the run's Outputs tab.

### L1. Split mode clips the selected row
In the split mode the list pane is capped at 40% and the selected Budget row sits half cut at the bottom, its meta lines hidden (`22-split-xlsx-1600-dark`). Scroll the selected row fully into view.

### L2. RunMeta at 1024x640 with the panel open
The chip is the folder icon and a bare "5" with the label only in its title (`12-run-1024-dark`), so it reads as a number without a unit. With the panel open, "unattended" clips to "unattendec" (`15-mermaid-1024-light`, `18-delete-confirm-1024`). Fix: hide "unattended" first under about 1060 px, or keep "5 outputs".

### L3. Empty project tab
Zero outputs: the right pane still says "Select an output to see its preview here." and the icon is the org chart glyph (`20-project-outputs-empty-1600`). Hide the pane (rail) until something exists and use a document icon.

### L4. Small things
- The filter column heading is "Show" (`11-project-tab-detail-1024-light`), which reads as an action; "Filter" is plainer.
- The mock PNG is 8x8, so the image preview is a dot at Fit (`23-split-image-1600-light`). Fit should not shrink below a visible size; Actual size scrolls inside a focusable region. A real image would show differently; I did not see one.
- In the document preview the numbered list shows "1." / "2." with no hanging indent, and the code block ("npm run build") renders as plain text, not monospace (`04-run-docx-wide-dark`). Check the document mapper against `code`.
- Provenance reads "Orchestrator · R1 · 7 Nov 2026" on every row; good, but outputs are written by one agent so it adds nothing here (a real team will differ).
- The refused register is a quiet amber "Refused: That file is outside the project folder and its allowed folders." row with no Show (`09-transcript-wide-dark`); good. It is the only warning; nothing in the Outputs tab says one was refused. Acceptable.

## What worked, with evidence

- Reachability: chip click at 1024x640 opens the panel on the Outputs tab (focus lands on the side tab). Side tab present with no outputs (empty text "No outputs yet." read from the DOM; the tab itself seen in the 1024 shot of a started run only).
- Focus: Show -> heading focused on every kind (docx, xlsx, mermaid, markdown, image); Esc or Back -> that row's Show button (narrow and split); Esc on the actions popover -> the More actions button; Cancel of Delete -> More actions button; Remove -> the next row's Show button; project tab Enter -> heading, Esc -> row.
- Project tab keyboard: Tab order topbar Needs you, search, kind chips, run filter, one listbox stop, pane toggle (`24-proj-tab-focus-1024-dark`). In the detail: run link, Open, More actions, view toggle, preview region. Arrow, Home/End and type-ahead were driven by the repo's e2e, not re-checked here.
- Status vocabulary: History says "Needs you" for the run; Outputs adds none. Delete confirm reads "Delete Project plan? This deletes outputs/project-plan.docx from the project folder. It cannot be undone." (`18-delete-confirm-1024`).
- Sheet: the formula-looking cell shows as text "=SUM(B2:B4)"; costs 1,200.00 and so on; second tab "Notes" works. The formula text is not explained to a user who expects 5,400.
- Diagram: Diagram | Source and Copy SVG; Copy gives a visible and focus-safe "Copied." (`05` seen in the walk). Light theme redraws with the light palette (`15-mermaid-1024-light`).
- Engagement: same Outputs side tab and project tab, between History and Knowledge, same five rows, provenance "Engagement Lead" (`30-eng-run-outputs-1600-dark`, `32-eng-budget-1024-light`).
- Dashboard shows nothing about outputs (by spec), and nothing counts as a decision.

## Status: not driven

- Native Open, Show in folder and Save as: only confirmed the menu items exist. Delete file was cancelled, not confirmed, so the file removal and "Deleted ..." notice were not seen.
- Missing-file state, too-large previews, truncated documents and sheets ("more rows"), the Refused/forgotten items from another run, many outputs, long titles, an output arriving while the tab is open (I saw only the final announcement text, not the throttling), hidden-character titles.
- A real Word, Excel or PNG made by an agent: the mock builds the files; the PNG is 8x8.
- Search for "word" or "excel"; Windows only; macOS, Linux, packaged builds, screen reader output, System theme, forced colours.
- History's Open and relaunch (outputs after a relaunch from an ended run). Chat and assistant runs (no Outputs tab by spec, not checked).
