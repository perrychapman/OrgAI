# Outputs: deliverables agents make, shown inside OrgAI

Spec for the renderer side of run outputs (ARCHITECTURE.md "Run outputs"; contract: the `// ---- Run outputs ----`
section at the end of `src/shared/types.ts`: `RunOutput`, `OutputKind`, `OutputPreview`, `DocumentBlock`,
`SheetPreview`, `OUTPUTS_IPC`, `window.orgai.outputs.{list, preview, open, reveal, saveAs, forget, delete}`,
`window.orgai.onOutputsChanged`, RunEvent `output.created`). It follows the pre-feature walk
`docs/design/ux-review-outputs-pre.md` ("pre-walk", findings cited as H1, M1 ...) except where section 11 says
otherwise. Nothing on the main side changes in this pass.

Owner requirement: outputs are displayed inside the OrgAI window as usable things (a rendered document, a sheet grid,
a drawn diagram, rendered Markdown) and are always reachable. Opening in another app is a secondary action.

Words in visible copy: "output", "document", "spreadsheet", "diagram", "file", "produced", "registered", "preview".
Never "artifact", "deliverable" or "index". Status words stay those of `lib/runStatus.ts`.

## 1. Placement (pre-walk M1)

1. Run side tab **Outputs** (`side-tab-outputs`, `SideTab` 'outputs'), on every work run of a stored project
   (never setup-like runs, quick runs or the assistants), always present, also with no outputs yet.
2. Project tab **Outputs** (`tab-outputs`, `View` 'outputs') between History and Knowledge, on every stored project
   (code and engagement), never on the assistants.
3. RunMeta chip `run-meta-outputs` "N outputs" (section 6) and a transcript row per produce / register call (section 7).
No Dashboard section and no attention count anywhere: an output is never a decision (pre-walk M3).

One source of truth: the store's `outputsByProject[projectId]` (`outputs:list`, newest first). A run surface filters it
to the run's chain (every member, every agent); the project tab shows all of it.

## 2. Store (`store/useAppStore.ts`)

- `outputsByProject: Record<string, RunOutput[]>`, `loadOutputs(projectId)` (outputs:list; a failure keeps the old
  list and logs), loaded on project select, on the side tab's and the project tab's mount.
- `handleEvent` `output.created`: replace by id or prepend (`lib/outputs.ts` `mergeOutput`), for the run's project.
- `window.orgai.onOutputsChanged(ev)`: refetch that project's list (any `what`), only for projects already loaded.
- `outputsFocus: OutputsFocusRequest | null` (`{ projectId, outputId? }`), `openOutputItem(req)` selects the project,
  sets `view: 'outputs'` and the focus; `clearOutputsFocus()`. The project tab resolves it once it has its list.
- `runOutputsByChain: Record<chainKey, { openId: string | null }>` and `openRunOutput(runId, outputId?)`: switch the
  run's side tab to 'outputs' and show that item (the transcript "Show" link and the RunMeta chip use it).
- `removeProject` drops the project's entries.

## 3. Run side tab (`components/outputs/RunOutputs.tsx`, `run-outputs`)

- List mode: `ul.run-outputs-list` (`run-outputs-list`) of `li.run-output-row[data-id][data-kind][data-missing]`
  (`run-output-row`): kind icon, title (one line, middle-clipped through `clampLabel` / CSS ellipsis, full title in
  `title`), quiet line "Document · 38 KB · outputs/Project plan.docx" (`outputMetaLine`), provenance line
  "Analyst · R1 · 7 Nov 2026" (`provenanceLine`; role missing = "An agent"), the primary `Button` "Show"
  (`run-output-show`, `ariaLabel` "Show <title>") and the More actions popover (section 5).
- Empty: `run-outputs-empty` "No outputs yet. Agents can produce documents, workbooks and diagrams here."
- Show at panel widths under 480 px: the preview replaces the list; a "Back to outputs" button (`run-output-back`)
  above the detail; Esc anywhere in the detail does the same; focus returns to that row's Show button.
- Show at `data-side-wide` (480 px and more): the list stays on top (at most 40% of the panel height, scrolling), the
  detail sits under it; the shown row carries `aria-current="true"`.
- The detail is `OutputDetail` (section 4). Its heading takes focus when it opens.
- A new output while the tab is open is prepended; nothing moves focus. One polite announcement per 5 s through the
  frame's `tray-announce` (`useFrameAnnounce`): "Produced Project plan" (one) or "Produced 3 outputs" (several in the
  window). Never in the bell, Needs you, badges or the Dashboard.

## 4. Detail and previews (`components/outputs/OutputDetail.tsx`, `OutputPreview.tsx` and the views)

`OutputDetail` (`output-detail[data-id][data-kind]`): `h3#output-detail-heading` (`output-detail-heading`,
`tabIndex=-1`, the title through `showHidden`), meta line, provenance line where the run tag is a link to the run
(`output-run-link`, lands like the Knowledge history link: opens the run, focus on the composer, else the selected run
tab, else the topbar h1), the description if any (ClampText), `output-missing` ("The file is gone from <relPath>. It
was moved or deleted outside OrgAI.") instead of a preview when `missing`, then a toolbar: "Open" (secondary,
`output-detail-open`, hidden for 'other'; title "Opens in the app your computer uses for this kind of file") and the
More actions popover, then `OutputPreview`.

`OutputPreview` fetches `outputs:preview` on demand with a sequence guard; while waiting
`output-preview[data-state=loading]` "Loading preview…"; a rejected call `output-preview-error` "Could not load the
preview." with "Try again". A small per-project cache (`lib/outputs.ts` `previewCache`, 24 entries, key id +
updatedAt ?? createdAt). Root `div.output-preview[data-kind=document|sheets|text|svg|image|none]` (`output-preview`).
The renderer never receives or inserts HTML; it builds elements from `OutputPreview`.

- **document** (`DocumentView`, `output-doc`): an `article` with a quiet first line "Simplified preview. Open the file
  for the exact layout."; headings `h4`..`h6` mapped by level (h1 -> h4 so the page outline stays sane, with
  `aria-level` = level + 3 capped at 6), paragraphs with runs as `strong` / `em` / `u` / `s` / `code`, links only for
  `http:` / `https:` / `mailto:` hrefs opened through the existing external-link path (else plain text), lists `ul` /
  `ol`, tables with `th scope=col` for header rows, images `img` (alt from the block, only `data:image/(png|jpeg|gif|
  webp);base64,` URLs, else omitted), code `pre`, rule `hr`, page break `div[role=separator]` labelled "Page break"
  (`output-doc-pagebreak`). `truncated`: `output-doc-truncated` "The preview stops here. Open the file to read the rest."
- **sheets** (`SheetView`, `output-sheets`): sheet tabs through the `Tabs` primitive (`output-sheet-tab`, label
  "Sheets") when there are two or more; a real `table` (`output-sheet-table`) with a caption (sheet name, sr-only),
  a sticky header row of column letters (A, B, ... `columnLetter`) and a sticky first column of row numbers (`th
  scope=row`); cell text from `sheetCellText` (fmt with '%' -> percent, fmt with '0.00' -> 2 decimals, booleans
  TRUE / FALSE, null empty, else as is), numbers right-aligned, formula text in the cell `title` (`f`). Truncation:
  `output-sheet-more-rows` "More rows not shown." (never a count: `truncatedRows` is a lower bound),
  `output-sheet-more-cols` "N more columns not shown.", `output-sheets-more` "N more sheets not shown.". The table
  scrolls inside a focusable region (`role=region`, `aria-label` "<sheet> cells", `tabIndex=0`).
- **text**, by the output's kind:
  - markdown: `SegmentedControl` "View" Rendered | Source (`output-md-view`); Rendered through `components/Markdown.tsx`
    (`output-md-rendered`), Source a `pre` (`output-source`).
  - mermaid (`MermaidView`, `output-mermaid`): Diagram | Source (`output-mermaid-view`). Lazy `import('mermaid')`
    (12.3.0), `initialize({ startOnLoad: false, securityLevel: 'strict', theme: data-theme light ? 'default' : 'dark' })`,
    `parse` first; a parse or render failure shows the source and a quiet line `output-mermaid-error` "This diagram
    could not be drawn: <message>." The rendered SVG is inserted only after `lib/outputSvg.ts` `safeMermaidSvg` parsed it
    with DOMParser and refused any `script`, `foreignObject`, `iframe`, `object`, `embed`, `on*` attribute, external
    `href` / `xlink:href` (anything but `#fragment`), `javascript:` anywhere, `url(` that is not `url(#...)`; a refused
    SVG shows the source and "OrgAI did not show this drawing because it contained active content." The drawing sits in
    `output-mermaid-svg` (`role=img`, `aria-label` = title). "Copy SVG" (`output-mermaid-copy`) copies the checked
    markup. Re-rendered when the theme changes.
  - csv: a table (`output-csv-table`, header row = first line, at most 500 rows, "More rows not shown.") when
    `parseCsv` succeeds, else a `pre`.
  - json, text and anything else: a monospace `pre` (`output-text`); json pretty-printed when it parses.
  - `truncated`: "The preview stops here. Open the file to read the rest." (`output-text-truncated`).
- **svg**: `img` (`output-svg-img`) with a `data:image/svg+xml;base64,` URL built from the text (never inline SVG),
  alt = title.
- **image**: `img` (`output-image`) from the data URL (only `data:image/(png|jpeg|gif|webp);base64,`), alt = title,
  `SegmentedControl` Fit | Actual size (`output-image-size`); Actual size scrolls inside a focusable region.
- **none**: the reason as a quiet paragraph (`output-preview-none`) plus "Open" when allowed.

Every preview region that scrolls is focusable (`tabIndex=0`) with a name; one that does not scroll is not.

## 5. Actions (`components/outputs/OutputActions.tsx`)

IconButton `output-more` ("More actions for <title>", `MoreHorizontal`) opening the `Popover` `output-actions`:
"Open" (`output-open`; never for kind 'other', where a quiet line `output-open-hint` reads "OrgAI does not open this
kind of file. Show it in its folder instead."), "Show in folder" (`output-reveal`), "Save as…" (`output-save-as`),
"Copy path" (`output-copy-path`, copies `path`), "Remove from list" (`output-forget`, the file stays), "Delete file…"
(`output-delete`, only `source === 'produced'` and not missing; `useConfirm` `confirmTestId: 'output-delete-confirm'`,
title "Delete <title>?", body "This deletes <relPath> from the project folder. It cannot be undone.", confirm
"Delete file", tone danger). Missing files show only Copy path and Remove from list.
open / reveal answer '' or a sentence: a sentence shows in the surface's notice line (`output-notice`, polite) and
focus stays where it was. Save as: `{ path }` -> "Saved a copy to <path>."; cancelled -> nothing. Forget / delete
replace `outputsByProject` with the returned list and say "Removed <title> from the list." / "Deleted <title>.";
the detail closes and focus moves to the next row, else the list, else the empty state.

## 6. RunMeta chip (pre-walk M2)

`button.run-meta-item.run-meta-outputs` (`run-meta-outputs`), shown when the chain has at least one output:
icon `Files` plus "5 outputs" ("1 output"); under 1100 px of window width only the icon and count, with the label in
`title` and an sr-only " outputs; opens the Outputs tab" sentence. Click: `openRunOutput(runId)`.

## 7. Transcript rows (pattern: `lib/knowledgeRun.ts` `collapseKnowledgeWrites`)

`lib/outputsRun.ts` `collapseOutputCalls(entries)` folds each `produce_output` / `register_output` call (bare name or
`mcp__orgai__…`) and its result into one row: the harness row "Produced document Project plan" / "Registered output
Logo" (main writes it on the calling agent) when there is one, else the result itself. The call row and the result row
are hidden. Row `div.entry.system.harness.output-write-row[data-state=produced|registered|refused]`
(`output-write-row`): `Files` icon, the sentence, an inner link button "Show" (`output-write-show`) that calls
`openRunOutput(runId, id)` where the id is matched from the project's outputs by run and title (else relPath from the
result text); no Show when nothing matches. A result starting "REFUSED:" renders "Refused: <reason>" with the
`AlertTriangle` icon and no Show. The full tool result sits under "Show details".

## 8. Project tab (`views/OutputsView.tsx`, `outputs-view`)

List-first like the Knowledge tab, no `CanvasFrame`; the page never scrolls.
- Filter column (`outputs-filters`, `form role=search`): search `outputs-search` (title, file name, relPath, role;
  Esc clears), kind chips `outputs-kind[data-kind][aria-pressed]` with counts (kinds in use only, "All kinds"
  `outputs-kind-all` resets), run filter `outputs-run-filter` (`Select`: "All runs", then "R3 · <run title>" per run
  that has outputs), Switch "Show missing files" is not built (missing rows always show, marked). Count line
  `outputs-count` "5 of 12 outputs", spoken through `outputs-status` (one `p.sr-only[role=status]`) debounced 400 ms.
- List `ul[role=listbox]` (`outputs-list`, label "Outputs") of `li[role=option]`
  `output-row[data-id][data-kind][data-missing]`: icon, title, meta line, provenance line; roving tabindex, one Tab
  stop, Up / Down / Home / End, type-ahead on titles, Enter or click selects and opens the detail pane, focus moves to
  `#output-detail-heading`; Esc in the pane returns focus to the row. Grouped by day ("Today", "Yesterday", "4 Nov
  2026"), newest first. Rows carry no buttons. Windowing is not needed under `OUTPUTS_MAX` 2,000 rows of fixed height
  but rows past 300 render on demand (`outputs-more` "Show 300 more").
- Detail pane: `SidePanel` (`label="output preview"`, `persistKey="outputs"`, `autoCollapseBelow={1100}`,
  `revealOn={selectedId}`, `testId="outputs-detail"`) holding `OutputDetail` with the full preview.
- Empty project: `outputs-empty` "No outputs yet. When agents produce documents, workbooks or diagrams, they appear
  here." No filter results: "No outputs match. Clear the filters" (`outputs-clear-filters`).
- Live: a new output is inserted without moving focus or selection; announced through `outputs-status` at most once
  per 5 s ("Agents produced 2 outputs").

## 9. Keyboard paths and sizes

- Run tab: Tab reaches the side tabs (roving), then the list's Show buttons and More actions buttons in row order;
  Show -> heading focused; Esc / Back -> the row's Show button.
- Project tab: Tab: search, chips, run filter, the listbox (one stop), the pane's toggle, the detail. Arrows move,
  Enter shows, Esc returns.
- Sheet tabs: arrows through the `Tabs` primitive; the cell region scrolls with arrows once focused.
- 1024x640: the run panel starts collapsed under 1100 px (existing rule); in the 360 px panel previews replace the list.
  The project tab's pane is a rail until something is selected. No page scroll at either size, both themes.

## 10. Atlas

`src/shared/view/atlas.ts` gains `run-outputs` (Run view › Outputs side tab) and `project-outputs` (Project › Outputs)
surfaces with their testIds.

## 11. Decisions against the pre-walk

- Side tab always present (pre-walk M1 said only with outputs): the owner wants outputs always reachable.
- Project tab on every stored project (pre-walk M1 suggested hiding it for code projects until something exists):
  same reason; the empty state explains it.
- The 360 px panel previews inline, replacing the list (pre-walk M4 said images and short text only): the owner wants
  the output usable in the window; the replace-with-Back pattern keeps the panel readable.
- Primary row action is "Show", not "Open" (pre-walk M4): in-window viewing is the point, Open is secondary.
- Not built here: a "Create Word document" permission card title (H3: produce_output asks no card), the Dashboard tile
  line "3 new outputs", "Finished, 3 outputs" in the status line, the folder chip as a control (L2), per-agent output
  counts in `FinishedList` and folded groups, a View > Outputs menu item (src/main/appMenu.ts is owned elsewhere this
  round).

## 12. Implementation notes

Filled in at hand-back.
