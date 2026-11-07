# Outputs 2: a deliverables workspace (view, edit, version, annotate, revise)

Extends `docs/design/outputs.md` ("outputs.md") and supersedes it where stated in section 2. Driven by the walk
`docs/design/ux-review-outputs-2.md` (findings cited D1-D8, M1-M4, V1-V5 and the "Editing and iteration gaps" table, G1...).
Contract names: the `// ---- Run outputs ----` section of `src/shared/types.ts` today; section 13 lists what must be added.
Frontend rules: orgai:frontend-design (tokens only, shared wrappers, both themes, 1024x640 and 1600x1000). Motion: orgai:motion-design;
this spec defines no motion token and adds almost no motion (section 14). The competitive survey the brief names
(`outputs/output-viewing-competitive-survey.md`) was not in this worktree; its conclusions are taken from the brief's owner decisions below.

## 0. Owner decisions (binding) and what they mean here

1. The main use is engagement (client) work: deliverables in many formats. Viewing and editing happen inside OrgAI.
2. Editing depth is "round trip":
   - Text, Markdown, CSV (cell grid), JSON, SVG source and Mermaid source are edited in OrgAI with a live preview.
   - Word, Excel and PowerPoint files are edited in their own app; OrgAI sees the change and keeps it as a new version.
   - "Ask the team to revise this" (whole output or a selected part) starts or feeds a run; the result is a new version with a diff.
   - No embedded Office editor, now or in this plan.
3. PowerPoint: agents produce decks (`produce_output` kind `pptx` from a slide model); users see real slide previews
   (thumbnail strip plus slide view). Previews are built in main from the deck's XML into data the renderer turns into React
   elements (never HTML); an external `.pptx` gets a best-effort preview. LibreOffice is not used.
4. Every output can be deleted (registered ones too, with a confirm that says the file on disk goes) and edited ad hoc. Each has
   versions: list, compare, restore (restore adds a version, history is never destroyed). A later run making the same file is a new
   version of the same output (identity rule, section 3).
5. Notes (annotations) by type: highlight text (document, Markdown, text), mark a box or circle (slide, image, SVG, diagram), note a
   cell or range (sheet, CSV). Notes belong to a version, are listed in a panel, can be resolved, and can be sent to the team ("Revise
   with these notes").
6. Diagrams get their own viewer (section 8).
7. The project Outputs tab is a deliverables workspace: grid or list, prev/next, one Tab stop of kind chips, versions and notes visible,
   one row per output (not per file).

Visible vocabulary stays that of outputs.md section "Words": output, document, spreadsheet, diagram, file, produced, registered,
preview. New words: **version** (v3), **note**, **revise**, **slide**, **deck** (only for PowerPoint), **compare**, **restore**. Never
"artifact", "commit", "revision control", "diff" (the control says "Changes"), "index", "deliverable" in UI text. Status words for runs
stay those of `lib/runStatus.ts`.

## 1. Information architecture

Noun hierarchy: Project > Output (one deliverable, stable id) > Version (v1..vn, the current one is the highest unless a restore made
a later one) > Notes (belong to one version). One current file on disk per output (`path`), many stored snapshots.

Surfaces, from small to large; each reuses the same `OutputDetail` body so behaviour is identical:

| # | Surface | Where | Purpose |
| --- | --- | --- | --- |
| S1 | Run side tab Outputs | run view, 280-480+ px panel | what this run (chain) made; open one |
| S2 | Project Outputs tab | project tab, list/grid + detail pane | the workspace across all runs |
| S3 | Detail | pane in S1 / S2 | preview, actions, tabs Preview / Versions / Notes |
| S4 | Viewer ("Larger view") | `Dialog`, near full window; "Full window" mode covers all chrome | real reading, zoom, slides, diagram, compare, notes drawer |
| S5 | Editor | inside S3 / S4, text kinds | live preview editing, Save makes a version |
| S6 | Versions | S3 tab, S4 popover | list, view, name, compare, restore |
| S7 | Compare | S4 mode | per-kind change view between two versions |
| S8 | Notes | S3 tab, S4 drawer | list, resolve, revise with notes |
| S9 | Revise dialog | `Dialog` from S3 / S4 / S8 / transcript row | ask the team to change this |
| S10 | Delete confirm | `useConfirm` | delete file and versions |

Entry points that stay: RunMeta chip, transcript rows, History "N outputs", Needs you never involved (an output is never a decision).
Added: tab count `side-tab-outputs` label "Outputs 12" (M1); a pending revision shows a quiet chip in RunMeta (`run-meta-revision`, "Waiting
for the team's version of Project plan") until it lands.

Where it lives for the user: S3 is what you see in the panel; S4 is "Larger view" (existing control, now the main way to work);
the project tab is where you find and compare. Every action in S4 exists in S3 (narrow panel keeps the same buttons in its More menu).

## 2. What changes from outputs.md (supersedes)

- outputs.md 3 (list rows): one row per **output**, with a version chip, not one per file. The row gains `v3` chip, "3 versions" in the
  meta line, an open-notes badge.
- outputs.md 4 (preview): kinds gain `pptx` (slides). Mermaid preview is replaced by the diagram viewer (section 8). SVG and image get
  the shared pan/zoom surface (section 8.1). `Copy SVG` button leaves the toolbar and joins Export.
- outputs.md 5 (actions): "Delete file..." is offered for every output (section 12). "Remove from list" stays. "Open" stays and
  becomes "Edit in <app>" for Word, Excel and PowerPoint (section 10). New: "Ask the team to revise...", "Versions", "Notes",
  "Rename...", "Export image" (diagrams), "Copy source".
- outputs.md 8 (project tab): rebuilt as section 5. Kind chips become one Tab stop (V3). The empty detail pane is gone (newest output
  is selected without moving focus, M2).
- outputs.md 11 note "Primary row action is Show": unchanged. "Larger view" gains prominence (a primary-weight button for diagrams,
  D3).
- Transcript row copy (M1): "Produced diagram: Architecture diagram" (kind word, colon, title), "Updated Project plan to version 3"
  when it is a new version, "Registered image: Logo".

## 3. Identity and version rules (decision)

An **output** is one file path in one project. Identity key = the case-folded real path (case-folded on Windows and macOS only) of its
file. Consequences:

1. `produce_output` with a `fileName` that maps to an existing output's path, or no `fileName` and a title whose derived name maps to
   it, **adds a version** to that output instead of writing "name (2).ext". Any run of the project may do it (before: only the same run
   with `overwrite`). The title of the newest version becomes the output's title; earlier titles stay on their versions.
2. `register_output` of a path already indexed adds a version when the content digest differs, else changes nothing (the tool says "No
   change; still version 2"). A different title or description updates the entry only.
3. A produced path that exists but is **not** in the index (the user's own file in `outputs/`, or a forgotten output) is never
   overwritten: the old suffix rule applies (`name (2).ext`) and it becomes a new output. A forgotten output re-produced is a new
   output with a fresh version 1.
4. Content with the same digest as the current version adds no version (agents re-running the same tool is common).
5. Kind cannot change within an output (the extension is forced by kind). A registered path whose extension implies another kind than
   the entry keeps the entry's kind and logs a warning.
6. The agent can force a separate output with `separate: true` ("name (2)" behaviour). `overwrite` is accepted and ignored (same result
   as default) so older prompts keep working.
7. Existing "name (2)" entries from before this change are not merged. They stay separate outputs. (Open question OQ1: a "Merge into..."
   action; not in scope.)
8. Version creators (`OutputVersion.source`): `agent` (produce or register by a run), `edit` (the user saved in OrgAI), `external` (the
   file changed on disk outside OrgAI and was detected), `restore` (the user restored an older version), `revision` is not a separate
   source: it is `agent` with `answers` pointing at the revision request.
9. Every state change of the current file creates a version first (snapshot), then updates the index. Versions are never edited. The
   current version's snapshot equals the file on disk at the moment it was taken.
10. Caps: 100 versions per output (past it the oldest unnamed version except v1 is dropped with a log line and the versions list says
    "Older versions were removed to save space."), 500 MB of snapshots per project (same rule, oldest first across outputs, never the
    current version). A named version (user label) is never dropped by the cap.

## 4. Run side tab (S1)

Unchanged structure (outputs.md 3) with these differences:
- Row: kind icon (or a 40x30 thumbnail for pptx, image, svg, diagram; section 6), title, meta line "Document · v3 · 38 KB", provenance line
  of the **current** version ("Analyst · R2 · 7 Nov 2026"; "You · edited"; "Changed outside OrgAI"), badges `output-open-notes`
  ("2 open notes"), `output-new-version` "New" while the version is newer than the user last saw (session only, in memory).
- Primary Show, More actions. Filters: none in the panel.
- Detail inside the panel at under 480 px: replaces the list (existing), with **Previous / Next** (`output-prev`, `output-next`, "3 of 12";
  Alt+Left / Alt+Right while focus is in the detail) next to "Back to outputs" (M3). Order = list order.
- At `data-side-wide` the list stays above; unchanged.
- The tab's count and the polite announcement: "Produced Project plan" or "Updated Project plan to version 3" (one per 5 s window).
- Large diagrams: the panel does not draw the diagram inline at all above 20 shapes... it does (fit) but its primary button reads "Open large"
  (`output-open-large`); see 8.9.

## 5. Project Outputs tab (S2)

Layout (no CanvasFrame, page never scrolls):

```
+--------------------------------------------------------------------+
| Outputs                                         [List|Grid] [Select] |  toolbar row 1 (title + view + select)
| [search........]  (All) (Word) (Excel) (Deck) (Diagram) ...  [Run v]|  toolbar row 2 (roving chips, one Tab stop)
|--------------------------------------------------------------------|
| list or grid (scrolls)                         | detail pane (SidePanel)
|  day groups, one item per output               |  Preview | Versions | Notes
+--------------------------------------------------------------------+
```

- Toolbar: `outputs-view-switch` (`SegmentedControl` "View": List | Grid, persisted `orgai.outputsView.<pid>`), `outputs-select-toggle`
  "Select" (enters select mode, section 12.3). Search, Run filter and count line unchanged (`outputs-search`, `outputs-run-filter`,
  `outputs-count`, `outputs-status`).
- **Kind chips are one Tab stop** (`outputs-kinds`, `role=toolbar`, arrow keys move between chips, Home/End, Space/Enter toggles the
  focused chip `aria-pressed`; roving `tabindex`; V3). Chips show counts; "Deck" is the label for pptx.
- **Grouping by output**: one row/card per output. Day groups use the current version's `createdAt` ("Today", "Yesterday", date). A
  sort control is not added (newest first).
- List row (`output-row[data-id][data-kind][data-missing]`): 56 px high; leading 48x36 thumbnail or kind icon, title, meta "Excel
  workbook · v2 · 3 versions · 24 KB", provenance of the current version, trailing badges `output-open-notes` and `output-new-version`.
  Rows carry no buttons. Roving tabindex, Up/Down/Home/End, type-ahead, Enter opens detail (heading focused), Esc returns.
- Grid (`outputs-grid`, `ul[role=listbox]` with `aria-orientation` unset; arrow keys move in two dimensions; columns by container
  width: `repeat(auto-fill, minmax(176px, 1fr))`): card `output-card[data-id]` 176 px wide: 16:10 thumbnail, title (2 lines clamp),
  meta "v2 · Excel", badges. Same roving behaviour, Left/Right by one, Up/Down by a row (computed from measured columns).
- Thumbnails: section 6.
- **Default selection**: on entering the tab, with a list, the newest output is selected (detail pane shows it) without moving focus
  and without announcing. If an open focus request names an output (`openOutputItem`) that wins.
- Detail pane: `SidePanel` as before (`persistKey="outputs"`), now with the three tabs of S3. Prev/Next buttons and "3 of 12" in its
  header. In the pane, Alt+Left/Right moves selection to the previous/next output in the current filtered order, keeping focus in the
  detail.
- Empty and no-results states unchanged (`outputs-empty`, `outputs-clear-filters`). Rows past 300: `outputs-more`.
- Live: a new version of an output already listed does not move the row; the row gets `output-new-version` and the count line says
  "Updated Project plan to version 3" through `outputs-status`. A new output is inserted without moving focus or selection.
- 1024x640: pane is a rail (existing `autoCollapseBelow` 1100); selecting opens it over the list at 360 px (existing behaviour);
  Grid at that width shows 2 columns. 1600x1000: list 760 px+, pane 440 px by default, resizable as today.

## 6. Thumbnails (S2 grid, list leading image, S1 rows)

Thumbnails are small, lazy, cached and never required to use anything. Channel `outputs:thumb` (section 13) returns a `OutputThumb`:
- `slide`: the first slide as a `SlidePreview` (the renderer draws it with the slide renderer at thumbnail size).
- `image`: a downsized data URL (png or jpeg, at most 160x120 px, at most 24 KB), for image and svg outputs (svg is rasterized in the
  renderer from the checked SVG, not by main; main answers `{ kind: 'svg', text }` for svg and the renderer shows it through the
  `img` data URL path).
- `lines`: first 4 lines or 240 chars of text, markdown, csv, json, mermaid source or a document's first paragraphs; drawn as
  dimmed text lines.
- `cells`: top-left 4x6 block of a sheet.
- `none`: kind icon only.
For a diagram the thumbnail is `lines` (source) in S1 and S2 list; the grid draws the diagram itself small when the output is the
selected card or in view and the drawing is cheap (source under 8 KB), else shows the icon. (No hidden mermaid renders for 2,000 files.)
Loading rule: at most 3 `outputs:thumb` calls in flight, only for visible rows or cards (IntersectionObserver), results cached by
`id + version`. Failure shows the icon, no error text. A thumbnail has `alt=""` (the card's name already carries the title) and
`aria-hidden`.

## 7. Detail (S3), tabs, versions entry point, actions

`output-detail[data-id][data-kind][data-version]` keeps outputs.md 4's head (heading `#output-detail-heading`, meta, provenance, run
link, description, missing state). New head parts: version select `output-version-select` (a native `select`: "v3 · now, Analyst · 7
Nov", "v2 · edited by you · 7 Nov"...) beside the title; badge when viewing an older version (below).

**Action toolbar** (one row, wraps; at under 480 px primary actions stay and the rest go to More):

| Button | testid | Shown when |
| --- | --- | --- |
| Edit | `output-edit` | editable kinds (markdown, text, csv, json, mermaid, svg) and the viewed version is current |
| Edit in Word / Excel / PowerPoint | `output-edit-external` | docx, xlsx, pptx |
| Ask the team to revise... | `output-revise` | always except missing or pdf / other with no readable source (section 11.6) |
| Larger view | `output-detail-expand` | always; primary weight for diagram, pptx |
| More actions | `output-more` | always |

More menu (`output-actions`): Open (kinds main opens) / Show in folder / Save as... / Copy path / Rename... (`output-rename`, edits title
and description, no file rename, creates no version) / Copy source (text kinds) / Export image (diagram, svg; section 8.7) / Remove from
list / Delete... (every output).

**Tabs** (`SegmentedControl` or `Tabs` primitive, `output-detail-tabs`, label "Output views"): Preview, Versions (n), Notes (n open).
`output-tab-preview`, `output-tab-versions`, `output-tab-notes`. Arrow keys between tabs; the tab count badges are in the labels.

**Viewing an old version**: a quiet banner `output-old-version` above the preview: "You are looking at version 2. The current version is
3." with buttons "Back to current" (`output-back-current`) and "Restore this version" (`output-restore`). Edit is hidden; Revise reads
"Ask the team to revise the current version..."; notes may be added to the old version (they stay on it).

**Pending revision** (after S9): a row at the top of the Versions tab and a line under the head `output-revision-pending`:
"Waiting for the team's new version. Sent to R2 at 11:04." with "Cancel" for nothing (cancel does not exist; the user can interrupt the
run). When a new version lands: line becomes "Analyst made version 4." with "Compare with version 3" (`output-revision-compare`); when the run ends
without one: "R2 ended without a new version." (dismissable). Spoken through `output-live` (polite).

## 8. Diagram viewer (D1-D8; Phase A)

New component family under `components/outputs/diagram/`. It replaces `MermaidView`'s zoom/scroll model (the checked-SVG gate in
`lib/outputSvg.ts` and the shadow-root import stay unchanged: `safeMermaidSvg`, `document.importNode`, no `dangerouslySetInnerHTML`).

### 8.1 Pan/zoom surface (shared by diagram, SVG and image outputs)

`PanZoomSurface` is a `div` viewport (`diagram-viewport`, `role=group`, `aria-roledescription="diagram viewer"` for diagrams, "image
viewer" for images, `aria-label` = title, `tabIndex=0`, `touch-action: none`, `overflow: hidden`, `cursor: grab` / `grabbing`) holding
one content element (the shadow host, or the `img`) positioned with `transform: translate(x, y) scale(k)` and
`transform-origin: 0 0`. No scroll bars (the old scroll model is dropped: it is what made Fit unreliable). The vector drawing stays
crisp because the transform is applied to the SVG itself; `will-change: transform` is set only during a gesture.

State `{ k, x, y, mode: 'fit' | 'free' }`. Pure functions in `lib/diagramView.ts` (unit-tested): `fitScale(box, natural, pad)`,
`fitView`, `actualView`, `zoomAt(view, pointer, factor)`, `panBy`, `clampView` (the drawing may leave the viewport but at least 64 px of
it, or all of it if smaller, stays inside), `overviewRects(view, box, natural)`.

Rules (decisions):
- **Fit** = `min(areaFit, 1.5)`, centred, padding 16 px. It fixes D1 (no 25% floor: a drawing of any size fits), D3 (a small drawing
  is never shrunk below its natural size and never blown up past 150%). Opening any diagram, SVG or image starts in `mode: 'fit'`
  and follows the viewport size (window resize, side-panel drag) until the user pans or zooms (then `free`; "Fit" returns to fit).
- Zoom range 2% to 800%. Readout shows the percent of natural size.
- **Wheel**: in the Viewer (S4) the wheel zooms around the pointer (step factor 1.1 per notch, `deltaY` normalised, trackpad pinch =
  `ctrlKey` wheel zooms with the continuous delta). In the embedded detail (S3) a plain wheel scrolls the surrounding page and passes
  through; **Ctrl/Cmd + wheel and pinch zoom**, drag pans. Reason: nothing else scrolls in S4, but S3 sits in a scrolling column.
  Shift+wheel pans horizontally in S4. The surface's tooltip and its `diagram-hint` line (visible once focus enters, sr-only text
  too) say: "Drag to move. Ctrl + scroll or pinch to zoom. Arrow keys move, plus and minus zoom, 0 fits."
- **Drag** (pointer events, `setPointerCapture`): moves the view; a drag under 4 px is a click (selects a note pin or clears
  selection). Two pointers = pinch (zoom about their midpoint, pan with it). Middle button and Space+drag also pan.
- **Double-click** toggles Fit and 100% (about the pointer for 100%).
- **Keyboard** (when the viewport has focus; never captured when focus is in a control or the source editor): Arrow keys pan 48 px,
  Shift+Arrow 192 px; `+` / `=` zoom in, `-` zoom out (about the viewport centre, factor 1.25); `0` Fit; `1` actual size; `Home`
  resets to Fit; `F` toggles Full window (S4 only); `O` toggles the overview; `Esc` leaves Full window, else closes the viewer (existing
  Dialog behaviour). Tab always leaves the viewport (no key trap). Keys mutate the view immediately, no animation.
- Zoom bar (`diagram-zoom`, one `div[role=group]` "Zoom"): `-` (`output-zoom-out`) readout (`output-zoom-readout`, `role=status`,
  announces "Zoom 60 percent" only after a keyboard or button change, debounced 400 ms) `+` (`output-zoom-in`), then separate labelled
  buttons "Fit" (`output-zoom-fit`) and "Actual size" (`output-zoom-actual`) (D6). Existing testids kept; `output-mermaid-zoom[data-value=
  fit|<k>]` kept on the viewport.
- `prefers-reduced-motion` and the app's reduce-motion switches change nothing here because nothing animates.

### 8.2 Layout and control stack (D3)

One toolbar row, 36 px (`diagram-toolbar`, `role=toolbar` label "Diagram controls", roving arrow keys inside, one Tab stop):
`[Diagram | Split | Source]` (`diagram-mode`, `SegmentedControl`, label "Show"), zoom group, `Overview` toggle (`diagram-overview-toggle`,
`aria-pressed`), `Light drawing` switch (`diagram-light-toggle`), `Export` (popover, `diagram-export`), `Copy source` (`diagram-copy-source`),
`Larger view` / `Close` (`output-detail-expand`) , `Ask the team to revise...`. Under 560 px of container width everything after
the zoom group collapses into a "More" menu (`diagram-more`). The meta, provenance and Open rows above it are the S3 head, not part of
the viewer, and collapse into the head's own compact form (title + version + More) when the diagram is in the panel and the panel is
under 420 px high.

The viewport fills all remaining height of its container (container query on `.output-detail`; `min-height: 240px`). At 1024x640 in
the 360 px panel the viewport is therefore at least 240x240 and typically 300x330 (it was 245x320 with a blank drawing).

### 8.3 Large diagrams (D1)

Counted on first draw: shapes = elements matching `g.node, g.cluster, .actor, .entity` in the checked root (the count is cached per
drawing; `data-shapes` on the viewport). When `Fit` scale < 0.4 or shapes > 40:
- A single quiet line above the viewport, `diagram-large-note` (`role=note`, not a live region): "Large diagram, 80 shapes. Zoom in to
  read, or open the larger view." with a "Larger view" button when the diagram is in the panel.
- The **overview** opens by default in S4 (not in S3) when the drawing is larger than the viewport at the current zoom.
- Never an empty first impression: the initial view is always Fit, and Fit always shows the whole drawing.
Render guard: sources above 64 KB or 2,000 shapes show "This diagram is very large and may be slow to draw." with a "Draw it anyway"
button (`diagram-draw-anyway`) and the source meanwhile; sources above 256 KB never draw (preview truncation already applies at
256 KB: the viewer says so and offers "Open source").

### 8.4 Overview (minimap)

`diagram-overview` (`aria-hidden`, pointer only; keyboard users pan with arrows, so it adds no tab stop): bottom-left of the viewport,
at most 168x120 px (or 25% of the viewport's smaller side, whichever is less), `--surface-2` panel, 1px `--border-default`, a clone of the
drawing (`document.importNode` of the checked root into its own shadow root, sized by CSS) plus a viewport rectangle (stroke `--accent`
2 px, fill `--accent-soft`). Click or drag in it centres/moves the view. Shown when `O` toggled on; default on in S4 for large diagrams
(above), off otherwise. Persisted per window in `orgai.diagramOverview` only as the user's explicit choice.

### 8.5 Full window

`diagram-fullscreen` (IconButton "Full window", `Maximize2`/`Minimize2`) in S4 makes the Dialog cover the whole window content area
(app chrome and sidebar stay behind it; not the OS fullscreen API, because that would hide the menu bar). Esc leaves Full window first,
then closes. Focus stays on the viewport. Both themes: viewport background is `--surface-1`; the drawing's own colours follow
the theme unless "Light drawing" is on.

### 8.6 Source, split and live editing

Mode `Diagram` (default), `Split`, `Source`. Split puts the source editor and the viewport side by side when the container is at least
900 px wide (editor left 40%), else stacked (viewport on top 60%, editor below). `Source` shows the editor at full size.
- Editor (`diagram-source`): a native `textarea` (monospace token font, `spellcheck=false`, `wrap=off`, `aria-label` "Diagram source"),
  a status line under it `diagram-source-status`: "Line 4, column 12 · 2.7 KB" updated on selection change (not announced).
- **Live preview**: edits redraw after 400 ms of no typing (queue as today, one Mermaid render at a time). While a redraw is pending the
  viewport keeps the previous drawing; if the new source fails, the viewport keeps the **last drawing that worked**, dimmed 60%, with
  the badge `diagram-stale-badge` "Showing the last drawing that worked" and the error pane (8.8) appears; the source never leaves the
  screen (D7).
- **Edit permission**: Phase A edits are a scratch copy (see Phase A): the bar says "Changes here are not saved yet. Copy the source to
  keep them." (`diagram-scratch-note`). From Phase C the editor is the output's editor (section 9): Save (Ctrl+S) makes a version,
  Discard returns to the saved text, an unsaved indicator `output-edit-dirty` (the toolbar shows "Unsaved changes").
- Go to error line: the error pane's "Go to line 2" button (`diagram-goto-line`) focuses the textarea and selects that line.
- Tab key in the textarea moves focus (no tab trap); indentation is typed spaces.

### 8.7 Export (D4, D5)

`Export` popover (`diagram-export`, `Popover`): items
1. "Copy as image" (`diagram-copy-png`): PNG to the clipboard.
2. "Save image..." with a type choice: PNG or SVG (`diagram-save-png`, `diagram-save-svg`).
3. "Copy SVG" (`diagram-copy-svg`) (kept).
Options at the top of the popover (persisted `orgai.diagramExport`): Theme: **Light (for documents and decks)** (default) | As shown;
Background: White | Transparent; PNG size: 1x | 2x | 3x (default 2x). Exports **always redraw the diagram in Mermaid's `default` theme**
unless "As shown" is picked (D5): a second off-screen render through the same gate (`safeMermaidSvg`). SVG output is the checked tree
serialized with `xmlns`, `width`, `height` set from the viewBox (so it opens in other programs). PNG: the SVG as an `img` data URL drawn
to a canvas (no foreignObject exists because `htmlLabels:false`; `img` SVG can run no script), `toBlob`, size capped at 8,192 px per side
and 64 megapixels (the size drops to the largest allowed and the notice says "Saved at 2x. The diagram is large, so it was saved smaller."). "Copy as image" uses `ClipboardItem`; if the clipboard refuses the notice is
"Your computer would not copy the image. Save it instead." File save: Phase A downloads a Blob through an anchor (the existing CSV
pattern, notice "Your browser is saving the file."); Phase C uses `outputs:saveImage` and the native dialog ("Saved a copy to <path>.").
Export also works from a viewed older version and from the Compare view's side.
Copy source (`diagram-copy-source`): copies the textarea's current text (scratch edits included); notice "Copied the source."
Notices speak through the viewer's `output-live` and show in `output-notice`.

### 8.8 Error pane (D7)

When parse or draw fails: the viewport shows the last good drawing dimmed if any, else is replaced by the pane; the pane `diagram-error`
(`role=alert` once, on the transition into error only) says: "This diagram has a syntax error on line 2, so it cannot be drawn. The source
is below." (line from Mermaid's message when present, else "This diagram cannot be drawn: <message>."), the raw first message line in a
`code` block, buttons "Go to line 2", "Ask the team to fix it" (`diagram-ask-fix`, opens S9 with instruction "This diagram does not draw.
Mermaid says: <message>. Please fix the syntax and keep the content the same." and scope Whole output) and, in Phase C, "Edit". The
source stays visible in Split/Source: opening an erroring diagram switches to Split when width allows, else Source. Refused SVG
(active content): "OrgAI did not show this drawing because it contained active content." (unchanged) with the source and no
"Draw it anyway".

### 8.9 Diagram in the panel and "Open large" (D3)

Diagram outputs in S3 present the viewport (fit, centred) and a primary "Open large" button (S4). In S1 a narrow panel the viewport is at
most 40% of the panel height or 260 px (whichever is more) so the head and toolbar remain; the user can still pan and Ctrl+wheel zoom.
SVG outputs reuse 8.1-8.2 (no source split editing beyond text edit in section 9; Export offers Save as PNG/SVG, Copy source). Image
outputs use 8.1 plus "Copy image", "Save as..." and the region tool (section 11).

### 8.10 Diagram a11y

The drawing region is `role=img` inside the viewport group with `aria-label` = title plus, when the Mermaid source has a `title` or
`accTitle` line, that text; a visually hidden `output-diagram-text` (`id`, `aria-describedby` on the viewport) lists, for diagrams of
up to 60 shapes, the shape labels in source order ("Contains: Web app, API, Database..."), for larger ones "80 shapes; read the source
for the full text." Source view is the real accessible representation, one key away (`S`: switches to Source when the viewport is
focused). Pan/zoom needs no pointer: keyboard map above; zoom readout and mode changes are spoken through `output-live` (polite). Contrast of
Mermaid's own themes is outside our control; the "Light drawing" switch and the source are the fallback.

## 9. Editing (S5), Phase C

Editable kinds and what the editor is:

| Kind | Editor | Live preview |
| --- | --- | --- |
| text (`.txt`) | `textarea` full size | none |
| markdown | Split: source `textarea` left, rendered right (stacked under 700 px), `output-md-view` mode still available | yes (rendered, 250 ms debounce) |
| json | `textarea`, `Format` button (pretty-print, 2 spaces), validity line | validity only: "Valid JSON." / "Line 3: expected a comma" |
| csv | cell grid (below) with "Edit as text" toggle | the grid is the preview |
| mermaid | Split (section 8.6) | yes |
| svg | Split: source left, `img` preview right (the data URL path) | yes, same safety gate; active content shows the refusal and Save is disabled |
| docx, xlsx, pptx, image, pdf, other | not edited in OrgAI (section 10) | |

Common behaviour:
- `output-edit` switches the detail (and the viewer) to edit mode: `output-editor[data-kind]` replaces the preview; focus goes to the
  editor control. A sticky bar `output-edit-bar` at the editor's bottom: "Unsaved changes" / "No changes", **Save** (`output-save`, primary,
  Ctrl/Cmd+S, disabled with no changes or invalid JSON/active-content SVG, with the reason as a visible line), **Discard changes**
  (`output-discard`, asks `useConfirm` only when dirty: "Discard your changes to <title>? They cannot be brought back."), Close editor
  (returns to preview, asks if dirty).
- Save calls `outputs:saveEdit` with the base version. Success: new version vN+1, source `edit`, preview refreshes, notice "Saved as
  version 4." (`output-live`, polite). If the base is no longer current (a run or an external edit made a newer version): the call answers
  `stale`; the bar shows `output-edit-stale`: "Version 5 was made while you were editing. Your changes are still here." with "Save as
  version 6 anyway" (keeps both; v5 stays in history), "Compare with version 5" and "Discard changes". No silent overwrite.
- Dirty guard: leaving the editor by changing selection, tab, closing, prev/next or changing project asks first (`useConfirm`: "Save your
  changes to <title> first?" Save / Don't save / Cancel). Closing the window shows no custom prompt (not reliable); the editor keeps a draft in
  memory per output id for the session (restored when the output is reopened: "Your unsaved changes were kept. Save or discard them.").
- Read-only reasons are visible text, never a missing button: a missing file ("The file is gone."), an old version ("Restore this version
  to edit it."), a registered file outside the project's outputs folder that main cannot write ("OrgAI cannot change this file here: it
  is in a folder agents may only read." for reference folders).
- A live run adding a version while the editor is open: no editor reset; the bar shows the stale line only at Save.
- Size: edit allowed up to 1 MB (`OUTPUT_TEXT_MAX_BYTES`); larger files: "This file is too large to edit here. Edit it in your own app." with
  Open.

### CSV cell grid

`output-grid-editor` (`role=grid`, `aria-label` "<title> cells", `aria-rowcount`, `aria-colcount`, one Tab stop with roving cell focus).
- Cells are `td[role=gridcell]`; the active cell has a visible 2 px inset ring (focus token). **Enter** or **F2** or typing a character edits
  (a single reused `input` appears in the cell); Enter commits and moves down, Tab commits and moves right, Esc cancels. Arrow keys move
  between cells, Home/End row ends, Ctrl+Home/End corners, PageUp/PageDown by a screenful, Shift+arrows extend a selection range.
- Toolbar `output-grid-tools`: "Add row", "Add column", "Delete row", "Delete column" (operate on the active row/column, delete asks nothing
  but is undoable), "First row is a header" switch (affects display and sticky header only; the CSV text is unchanged), Undo / Redo
  (`output-grid-undo`, Ctrl+Z / Ctrl+Y, session stack of 100 steps).
- Windowing: at most 200 rows and the visible columns are in the DOM; scrolling inside the focusable grid region.
- Limits: 5,000 rows x 64 columns; beyond or for a delimiter other than comma, a quote pattern the parser cannot round-trip, or a ragged file
  with over 10% mismatched rows: the grid is not offered and "Edit as text" is the only editor (line: "This file is better edited as text.").
- Serialization (`lib/csvGrid.ts`, pure, tested): RFC 4180 quoting, original line ending (CRLF or LF) and trailing newline kept, a cell
  starting with `= + - @` is saved as typed (OrgAI never evaluates; a note line appears when any cell starts with `=`: "Some cells start
  with = and are saved as text. OrgAI does not calculate formulas." V1).
- Cell notes in the grid: section 11.

## 10. Round trip for Word, Excel and PowerPoint (S11), Phase C

- `output-edit-external` is labelled by kind: "Edit in Word", "Edit in Excel", "Edit in PowerPoint" (the app name is a courtesy
  label; the tooltip says "Opens the file in the app your computer uses for <kind> files. When you save there, OrgAI keeps the change as a
  new version."). It calls `outputs:open` (existing) then `outputs:watch` for that output.
- While watched (until the viewer/detail closes, 10 minutes after the last open, or the user clicks "Stop watching"), the detail shows
  `output-external-status` (quiet line, polite): "Watching <file> for changes. Save in your app and the new version appears here."
- On a change main waits until size and mtime are stable for 1.5 s, hashes the file, and if the digest differs from the current version
  adds a version with source `external`. The renderer says "Version 4 added from your changes in <app>." with "Compare with version 3"
  (`output-external-compare`) in the same line. No modal, no focus move.
- Without an active watch, main checks every indexed file of loaded projects' recently opened outputs on window focus (stat only, then
  hash if mtime or size moved); a detected change adds a version labelled "Changed outside OrgAI" and the row gets `output-new-version`.
- Office lock files (`~$name.docx`, `.~lock.name#`) are ignored. A file replaced by save-to-temp-then-rename is handled (stat by path).
- If the file vanishes mid-edit, nothing happens until it is gone for 5 s: then `missing` (existing state).
- If a run changes the same file at the same time, versions are serialized per output in arrival order; each keeps its source.
- Copy to say once per output on the first "Edit in..." per session, in `output-external-hint`: "Changes made outside OrgAI by a run are
  kept as versions too." (no hint thereafter).
- A docx or xlsx edited in its app and then revised by the team: see 11.6.

## 11. Notes (annotations) and Revise

### 11.1 Model

A note belongs to **one version** of one output. Fields (section 13): id, version, anchor, text (1-2,000 chars, no hidden characters),
status `open | resolved | sent`, createdAt, resolvedAt, `sentIn` (revision request id). Author is always the user (agents do not write
notes in this phase). Notes are not copied to new versions. The Notes tab shows the viewed version's notes first and a collapsed group
"Earlier versions (3 open)" for others, each with "Show on version 2".

Anchors (by kind):
- text, markdown, json, csv-as-text: `{ type: 'text', start, end, quote }` offsets into the canonical text of that version (the file
  text for text kinds; markdown offsets are in the **source**, drawn on the rendered view by mapping source ranges to blocks; selections
  in the rendered view that cannot be mapped (inside a table cell, code) anchor to the enclosing block's source range).
- docx: `{ type: 'block', index, start, end, quote }` (preview block index and character range inside that block's text).
- sheet / csv grid: `{ type: 'cells', sheet, r1, c1, r2, c2 }` (0-based, inclusive; sheet '' for csv) and `quote` = first cell's text up to 80 chars.
- slide: `{ type: 'region', slide, shape: 'box' | 'ellipse', x, y, w, h, labels? }`, or `{ type: 'slide', slide }` (whole slide).
- image, svg, diagram: `{ type: 'region', shape, x, y, w, h, labels? }` x,y,w,h as fractions (0..1) of the drawing's natural size
  (diagram: of the viewBox). `labels` (up to 20, each up to 80 chars) are the texts of shapes whose bounds intersect the region,
  collected by the renderer; they help the team find what you pointed at (images have none).
- pdf, other: no notes.

### 11.2 Adding notes by kind (the affordance)

A single toolbar button `output-note-add` ("Add note", `MessageSquarePlus`, Ctrl/Cmd+Shift+M) is enabled when there is something to attach to; the
word describes the state: with a text selection or selected cells it adds a note on it; with the region tool on and a region drawn it adds
there; with nothing it says (tooltip, and a disabled reason line `output-note-hint` under the toolbar): "Select text to add a note." /
"Select cells to add a note." / "Mark an area to add a note." (per kind). A whole-output note is available through the Notes tab's "Add a note
on the whole output" (`output-note-whole`, anchor `{ type: 'whole' }`).
- **Text and documents**: select with mouse or Shift+arrows in the preview (the preview is already a focusable region with
  selectable text); `output-note-add` opens the composer. Existing notes show as `mark.output-note-mark[data-note][data-status]` over the
  range (open: accent-soft background plus a 2px underline; resolved: dotted underline only, so status never rests on colour alone; a
  sr-only prefix "Note:"). A click on a mark selects that note in the panel. Marks are not tab stops; the panel is the accessible list
  and each note's "Show in output" button scrolls to and selects the range, focus returns to the button.
- **Sheet, CSV**: click a cell, Shift+click or Shift+arrows for a range; the grid exposes the selected range (`aria-selected`); Add note. A noted cell shows a corner
  mark (a 6 px triangle drawn by CSS border, with the count in `title`; open = filled accent, resolved = outline) and its note text through `aria-description`.
- **Slide, image, SVG, diagram**: the toolbar has the region tool `output-note-region` (`SegmentedControl`-like toggle group "Mark an area":
  Off | Box | Circle, `aria-pressed` buttons). With a tool on, dragging on the drawing draws a region (stroke `--accent` 2 px, fill
  `--accent-soft`, a number pin). **Keyboard path**: with a tool on and the viewport focused, `Enter` places a default box (20% x 20% of
  the visible area, centred); arrows move it 8 px, Shift+arrows resize it, `Enter` confirms (opens the composer), `Esc` cancels. While
  the tool is on, drag no longer pans (hold Space to pan). Regions are drawn in a transparent SVG layer over the content, in drawing
  coordinates, so they follow pan and zoom; pins are numbered to match the Notes list (numbers are the order in the list).
- **Composer** (`output-note-composer`, a `Popover` anchored to the selection or the button; becomes a bottom sheet under 560 px): label
  "Note", `textarea` (2,000 chars, counter only near the limit), quote chip of what it attaches to, **Add note** (`output-note-save`,
  Ctrl+Enter) and Cancel (Esc). Focus returns to the control that opened it. Adding speaks "Note added." through `output-live`.

### 11.3 Notes panel (S8)

`output-notes` (tab in S3; a right drawer `output-notes-drawer` in S4, 300 px, collapsible by `output-notes-toggle`, focus moves to the drawer heading on open;
at under 900 px of viewer width it overlays the right 320 px and starts closed).
- Header: count "2 open, 1 resolved", filter `SegmentedControl` Open | Resolved | All (`output-notes-filter`, default Open).
- List `ul` (`output-notes-list`) of `li.output-note[data-id][data-status][data-version]`: number pin, quote or region description ("Slide 3,
  box", "Cells B2:C4 on Budget"), text, "You · 7 Nov 11:04"; buttons "Show in output" (`output-note-show`), "Resolve" / "Reopen"
  (`output-note-resolve`), "Edit" (`output-note-edit`, inline textarea), "Delete" (`output-note-delete`, `useConfirm` "Delete this note?").
  Each row has a checkbox `output-note-select` ("Include in the revision") visible when at least one open note exists; "Select all
  open" (`output-notes-select-all`).
- Footer: "Revise with these notes" (`output-notes-revise`, primary, enabled with 1+ selected, label includes the count "Revise with 3
  notes"): opens S9 with scope "These notes". Notes sent are marked `sent` (badge "Sent in R2") and kept; when the team's new version
  arrives they show "Sent · answered in version 4" and the user resolves them (no automatic resolve).
- Live region: `output-live` says "Note added", "Note resolved", "3 notes sent to the team".
- Empty: "No notes yet. Select text, cells or an area, then choose Add note." (kind-specific).
- Notes badge counts (open only) feed `output-open-notes` on rows/cards and the Notes tab label.

### 11.4 Revise dialog (S9)

`output-revise-dialog` (`Dialog`, 520 px): heading "Ask the team to revise <title>"; fields:
1. **What to change** (radiogroup `output-revise-scope`): "The whole output" (`output-revise-whole`), "The part I selected" (`output-revise-selection`,
   disabled with "Select something first" when there is no selection; shows the quote or region description; for diagrams and slides shows
   `labels`), "The notes I selected" (`output-revise-notes`, with count; default when opened from the notes panel).
2. **What should change** textarea `output-revise-text` (required for whole and selection, optional for notes: placeholder per kind,
   e.g. "Tighten the executive summary", "Make the title slide shorter", "Rename the database box"). Max 4,000 chars. Fenced as the
   user's own words in the message (not data).
3. **Send to** `Select` `output-revise-target` with the options main reports for this output: "R2 (still running)" when the run that made
   the current version is live; "R2, continue the conversation" when it ended and can continue; "Another running run..." submenu list
   (live runs of the project); "A new run". Default = the first available in that order. Line under it states the consequence: "The
   result will be version 4. Version 3 stays."
4. Warning lines when they apply: docx/xlsx/pptx edited outside OrgAI (`current.source === 'external'` anywhere in history):
   "You changed this file in another app. The team rewrites it from its text, so some formatting may change." (`output-revise-format-warning`);
   unsaved edits: the dialog blocks Submit and offers "Save your edits first" (`output-revise-save-first`).
5. **Send to the team** (`output-revise-send`, primary), Cancel. On success: the dialog closes, focus returns to the Revise button,
   the pending-revision state (section 7) and RunMeta chip appear, and `output-live` says "Sent to the team. They will add a new version."
   Failure: inline error (`output-revise-error`, `role=alert`) with the reason from main ("R2 is held waiting for you. Answer its card
   first." or "OrgAI is quitting."); the dialog stays.

The request is composed in main (section 13): it names the output (title, path, current version number), quotes the selection or
notes as fenced data with their anchors and labels, tells the agent to `read_output` first and write the result with `produce_output` at
the **same file name** (so the identity rule makes a new version), and never to change the content outside the scope. Main records the
request id on the version created by that run for that path (`answers`).

### 11.5 Where Revise starts

Buttons: S3 toolbar, S4 toolbar, notes panel, diagram error pane, transcript output rows ("Revise" link beside Show), the project tab's
row More menu ("Ask the team to revise..."), slide viewer ("Revise this slide": prefilled selection = that slide). All open the same dialog.

### 11.6 What a team can read

New harness tool `read_output` lets agents read an output's text for a version (documents as Markdown-like text, sheets as a table text,
decks as per-slide text with speaker notes, others as stored) and its open notes. This is needed because a user may have edited the file.
Results are fenced data. Binary kinds without a text form (image, pdf) are refused with "OrgAI cannot read this kind of file as text."
and Revise is disabled for them with the reason.

## 12. Versions (S6), Compare (S7), Restore, Delete

### 12.1 Versions list

`output-versions` (tab in S3; in S4 a popover from the version select). Newest first `ul` of `li.output-version-row[data-n][data-current]`:
`v3` + "Now" badge for current; label (user name, optional); description of the source in words:
- agent: "Produced by Analyst · R2" / "Updated by Analyst · R3 (answering 2 notes)"
- edit: "Edited by you"
- external: "Changed outside OrgAI"
- restore: "Restored from version 1"
time ("7 Nov 11:04"), size and delta ("+2.1 KB"), "2 open notes".
Row actions: View (`output-version-view`), "Compare with current" (`output-version-compare-current`), "Compare with..." sets the A/B pick (a
checkbox `output-version-pick` on each row; picking exactly two shows the primary `output-compare-picked` "Compare 2 versions"),
"Name this version..." (`output-version-name`, 60 chars, keeps it from cap pruning), "Restore" (`output-version-restore`, hidden on current).
The row is the unit; the whole row is one list item whose actions are buttons (Tab through rows' buttons; no roving here because it is short; with
more than 12 versions the list windows).
Empty (first version only): "This is version 1. Later changes appear here."
Cap line: "Older versions were removed to save space." when pruned.

### 12.2 Compare (S7)

Entered from the list or the version select ("Compare"), full width in S4 (and as a detail mode in S3 stacked). `output-compare[data-kind]`:
header with two version `select`s (A, B; defaults older and current; `output-compare-a`, `output-compare-b`), a swap button
(`output-compare-swap`), a summary line spoken once (`output-live`) such as "12 lines added, 4 removed, 3 changed". Changes are never
conveyed by colour only: added = `+` glyph and underline, removed = `-` glyph and strike-through, changed cell = outline plus a "changed" marker.
- **Text kinds (text, markdown, csv as text, json, mermaid, svg source)**: `SegmentedControl` Changes | Side by side
  (`output-compare-mode`); line diff with 3 lines of context, collapsed unchanged blocks "12 unchanged lines" (button to expand),
  intra-line word marks on changed lines. Prev/Next change (`output-compare-prev`, `output-compare-next`, F3 / Shift+F3 and Alt+Up/Down when
  the pane has focus). Markdown also offers "Rendered" side-by-side (A and B rendered).
- **Document (docx)**: block diff by paragraph (equal, inserted, deleted, changed with word marks inside); tables compare by cell text.
- **Sheet and CSV**: per sheet tab; grid with changed cells outlined and a marker, added/removed rows tagged in the row header ("+" / "-"),
  "Only rows with changes" switch (`output-compare-only-changes`, default on); a cell tooltip and `aria-description` show "was 1,200, now 1,350".
- **Slides**: a filmstrip of aligned slide pairs (aligned by index, with title match to survive an inserted slide), status per pair
  (Unchanged / Changed / Added / Removed, text and words not colour) and a two-up stage for the selected pair (A left, B right, each a
  `SlideStage`); the strip lists only changed pairs by default (switch "Show unchanged slides").
- **Diagram**: two-up viewports (A, B) with linked pan/zoom (switch `output-compare-link`, default on) plus a "Source changes" tab
  with the text diff.
- **Image, SVG**: two-up with linked pan/zoom.
- pdf, other: Compare is not offered (no text); versions still list and restore.
Compute and data: `outputs:compare` returns `OutputDiff` (section 13) from main for text, document, sheets and slides (so caps and
speed are in one place); two-up kinds fetch `outputs:preview` per version.
Keyboard: Tab through header controls, then the diff region (one focusable scroller `output-compare-body`), prev/next buttons and keys as above.
Loading: `output-compare[data-state=loading]` "Comparing..."; failure "Could not compare these versions." with Try again.

### 12.3 Restore

`output-restore` / `output-version-restore`: no confirm (it is non-destructive); immediate; creates version N+1 with source `restore` ("Restored
from version 2"), the file on disk is rewritten with that snapshot (atomic write; for a missing file it is recreated), notice
"Restored version 2 as version 5." (`output-live`), the preview shows the new current version, focus stays on the button's place (the version
row for the new current version). If the file on disk has changes not yet captured as a version (external edit not yet detected), main
first snapshots it as an `external` version, then restores, so nothing is lost. Registered files in an allowed folder follow the same
confinement as register_output; a refusal reads "OrgAI cannot write to that folder."

### 12.4 Delete (every output), Remove from list

`output-delete` (More menu, row More menu, bulk). `useConfirm` `confirmTestId: 'output-delete-confirm'`, tone danger, confirm button "Delete":
- Produced: title "Delete <title>?", body "This deletes <relPath> and its 3 earlier versions from your computer. The file goes to the
  Recycle Bin or Trash when your computer has one."
- Registered: title "Delete <title> and its file?", body "This deletes <path>, a file the team registered. It is not in OrgAI's outputs folder. The file goes
  to the Recycle Bin or Trash when your computer has one. OrgAI's stored versions are deleted too." (the path is shown in full, `code`).
- Missing file: title "Remove <title> from OrgAI?", body "The file is already gone. This removes the output and its stored versions."
- Which wording is used comes from `outputs:deletePreview` (path, version count, trash availability, whether the path is outside outputs/).
After: replace list, "Deleted <title>." (`output-live`), the detail closes, focus to the next row, else the list, else the empty
state. Snapshots and notes are deleted. Past versions cannot be deleted one at a time (history is never destroyed), only with the output.
"Remove from list" (`output-forget`): keeps the file, deletes OrgAI's versions and notes after its own confirm
(`output-forget-confirm`): "Remove <title> from OrgAI? The file stays at <relPath>. OrgAI's earlier versions and notes are deleted."
Bulk (project tab): `Select` mode shows a checkbox on every row/card (`output-select`, Space toggles when focused on the row in select
mode), a sticky bar `outputs-bulk-bar`: "3 selected" (`role=status`), "Select all shown", **Delete** (`outputs-bulk-delete`, confirm with
the total "Delete 3 outputs? This deletes 3 files and 7 stored versions...", per-file path list in a scroller, registered ones marked
"outside the outputs folder"), Cancel/`Esc` exits select mode. Bulk results read "Deleted 3 outputs." and one failure line per refusal.
Bulk "Remove from list" is not offered.

## 13. Slides (pptx) viewer (S4 / S3), Phase C

### 13.1 Slide viewer (`output-slides`)

Layout (container query on the pane): at 700 px and wider of container width: thumbnails strip (`slide-strip`) on the left, 168 px
wide, vertical; the stage right. Under 700 px the strip is a horizontal row under the stage (96 px high, scrolls horizontally).
- Strip is a listbox (`role=listbox`, `aria-label` "Slides", `aria-orientation` per layout) of `slide-thumb[data-n][aria-selected]` options,
  each a 16:9 miniature (the same `SlideStage` at thumbnail size, `aria-hidden` contents) with the number and the slide title as its accessible name
  ("Slide 3: Next steps"); roving tabindex (one Tab stop), Up/Down (or Left/Right horizontal), Home/End, selecting follows focus. Notes on a slide show a pin on its thumbnail
  and "has 2 open notes" in the name.
- Stage (`slide-stage`, `role=group`, `aria-label` "Slide 3 of 12", `tabIndex=0`): the selected slide drawn at the largest size that fits
  (contain, centred, 8 px margin). Prev/Next buttons (`slide-prev`, `slide-next`) in a bar with the counter `slide-counter`
  (`role=status`: "Slide 3 of 12"); keys while the stage or strip has focus: PageUp/PageDown, Left/Right, Home/End. Slide changes are
  announced through the counter only.
- Speaker notes: disclosure `slide-notes` "Speaker notes" below the stage (closed by default, `aria-expanded`), plain text.
- Zoom: Ctrl+wheel and the zoom bar (shared engine) work on the stage in S4 only; in S3 the stage is fit-to-pane.
- Notes: region tool and Add note (section 11), whole-slide note via `output-note-whole-slide` in the notes composer ("This slide").
  "Revise this slide" (`slide-revise`) opens S9 with the selection prefilled.
- Compare: section 12.2.
- Edit in PowerPoint: section 10. Pre-render states: `output-slides[data-state=loading|error|empty]`: "Loading slides...", "Could not read
  this deck. Open it in PowerPoint." / "This deck has no slides."
- `truncatedSlides` "N more slides are not shown. Open the file to see them." (never a promise of the exact count when the cap hits: lower bound
  language like the sheet preview).

### 13.2 What a slide preview draws (`SlideStage`, React elements built from `SlidePreview`, never HTML)

Positioned layers inside a container with `container-type: size`; geometry in fractions of the slide; fonts in `cqw` (pt divided by slide width in pt):
- background: solid `#rrggbb` (default white); a picture background is drawn as an image layer.
- text boxes: paragraphs of runs (bold, italic, underline, strike, colour `#rrggbb`, size pt, font family name used only as a hint: OrgAI
  uses the UI font stack; no webfont loading), bullets (disc or number) with level indent, alignment, vertical anchor, `overflow: hidden`.
- images: `img` from safe data URLs only (png, jpeg, gif, webp, each at most 2 MB, total 20 MB per deck preview), `object-fit: contain`; others show a
  placeholder.
- shapes: rectangles, rounded rectangles, ellipses with fill and line colour; other geometries a rectangle outline.
- tables: simple grid, cell text only.
- unsupported (chart, SmartArt, video, OLE, EMF/WMF): a dashed box with the word "Chart" / "SmartArt" / "Video" / "Picture (not shown)" and the
  `alt` text if present.
The slide sits on its own paper in both themes: white (or the file's colour), a 1 px `--border-default` edge, a quiet shadow token; it never
inverts in dark mode. An overall caption under the stage in the viewer: "Preview. Open in PowerPoint for the exact look." (`slide-fidelity`).
Fonts and layout from the slide master/layout are resolved one level (layout then master) for placeholder geometry and default text style; theme
colours (`schemeClr`) resolve through the theme part's palette; anything unresolved falls back to near-black text, no fill.

## 14. Motion, accessibility, copy, keyboard

### 14.1 Motion
Nothing is added. Pan, zoom, Fit and slide changes apply at once (no transitions, no inertia). Existing hover and focus colour transitions use the shared
motion tokens only; no new token. Skeletons: none (a quiet text state, as before). The pending-revision line uses no animation and no spinner
(text "Waiting for the team's new version."); if the existing breathing mark is wanted later it comes from the other motion work. Reduced motion
switches change nothing here by construction; e2e checks that no element in these surfaces has a running animation.

### 14.2 Live regions (one per surface, polite)
S1/S2: existing (`tray-announce`, `outputs-status`). S3/S4: `output-live` (always mounted, `role=status`) speaks: version added/restored/saved,
note added/resolved, copy/export results, zoom (debounced), compare summary, external change, revision arrival. Errors that need action use
`role=alert` only once on transition (`diagram-error`, `output-revise-error`). No second live region in a viewer.

### 14.3 Focus rules
Opening a detail: heading focus (existing). Opening the viewer: the viewport/stage/first control per kind (diagram, image: viewport; slides: strip's selected thumb; document, text: preview region;
compare: header A select). Closing returns to the "Larger view" button. Dialogs (revise, composer, confirms) return to their opener. After delete, next row. After restore, the new current version row.
Esc order: composer > tool (region) > Full window > editor prompt > viewer.

### 14.4 Keyboard map (summary)
| Context | Keys |
| --- | --- |
| Outputs list/grid | Arrows, Home/End, type-ahead, Enter open, Esc back, Space in select mode |
| Kind chips | one Tab stop; arrows, Space |
| Detail | Alt+Left/Right previous/next output; Ctrl/Cmd+Shift+M add note; Ctrl/Cmd+S save in editor |
| Viewport (diagram, image, slide stage) | Arrows pan (or prev/next slide), +/- zoom, 0 fit, 1 actual, O overview, S source (diagram), F full window |
| Source/grid editors | normal text keys; Tab moves focus (textarea), Tab moves cell (grid) |
| Compare | F3 / Shift+F3 or Alt+Down/Up next/previous change |
| Region tool | Enter place/confirm, arrows move, Shift+arrows resize, Esc cancel |
No shortcut collides with the shared SHORTCUTS table (`lib/menuActions.ts`); Ctrl+Shift+M and Alt+arrows are new and must be added to it (`KeyboardShortcutsDialog`) by the implementer.

### 14.5 Copy table (key strings)
- "Ask the team to revise..." / "Send to the team" / "The result will be version 4. Version 3 stays."
- "You are looking at version 2. The current version is 3." / "Restore this version" / "Restored version 2 as version 5."
- "Saved as version 4." / "Version 5 was made while you were editing. Your changes are still here."
- "Edit in Word" (Excel, PowerPoint) / "Watching <file> for changes." / "Version 4 added from your changes in <app>."
- "Select text to add a note." / "Note added." / "Revise with 3 notes" / "Sent in R2"
- "Large diagram, 80 shapes. Zoom in to read, or open the larger view."
- "This diagram has a syntax error on line 2, so it cannot be drawn. The source is below."
- "Showing the last drawing that worked"
- "Preview. Open in PowerPoint for the exact look."
- "Delete <title>? This deletes <relPath> and its 3 earlier versions from your computer."
- "Shown as text. OrgAI does not calculate formulas." (sheet cells starting with "=", V1)
Plain words only; no "revision control", no "diff", no "commit", no "digest".

### 14.6 Both themes, both sizes
Tokens only (`--surface-*`, `--border-*`, `--accent`, `--accent-soft`, `--focus-ring`, existing status tokens for added/removed: success and danger with glyph + underline/strike).
Slide paper is the one place a fixed light surface is allowed; diagrams use the theme unless "Light drawing". 1024x640: panel 360 px (rail below 1100 px), viewer is
a Dialog of at most 960 x 600; its notes drawer overlays and starts closed; toolbars wrap to a More menu under 560 px; grid 2 columns. 1600x1000:
viewer 1400x860, notes drawer open by default when open notes exist, strip + stage layout, grid 4-5 columns. No page scroll anywhere; scrolling regions are focusable and named.

## 15. Testids (new, consolidated)

Detail and tabs: `output-detail-tabs`, `output-tab-preview|versions|notes`, `output-version-select`, `output-old-version`, `output-back-current`,
`output-restore`, `output-edit`, `output-edit-external`, `output-revise`, `output-rename`, `output-prev`, `output-next`, `output-live`, `output-open-large`,
`output-new-version`, `output-open-notes`, `output-revision-pending`, `output-revision-compare`, `output-external-status`, `output-external-compare`, `output-external-hint`.
Project tab: `outputs-view-switch`, `outputs-select-toggle`, `outputs-kinds`, `outputs-grid`, `output-card[data-id]`, `output-select`, `outputs-bulk-bar`, `outputs-bulk-delete`.
Editor: `output-editor[data-kind]`, `output-edit-bar`, `output-edit-dirty`, `output-save`, `output-discard`, `output-edit-stale`, `output-grid-editor`, `output-grid-tools`, `output-grid-undo`.
Versions and compare: `output-versions`, `output-version-row[data-n][data-current]`, `output-version-view`, `output-version-compare-current`, `output-version-pick`,
`output-compare-picked`, `output-version-name`, `output-version-restore`, `output-compare[data-kind][data-state]`, `output-compare-a|b|swap|mode|prev|next|link|only-changes|body`.
Notes: `output-notes`, `output-notes-drawer`, `output-notes-toggle`, `output-notes-filter`, `output-notes-list`, `output-note[data-id][data-status][data-version]`, `output-note-add`,
`output-note-region`, `output-note-composer`, `output-note-save`, `output-note-show`, `output-note-resolve`, `output-note-edit`, `output-note-delete`, `output-note-select`,
`output-notes-select-all`, `output-notes-revise`, `output-note-whole`, `output-note-hint`, `output-note-mark[data-note]`.
Revise: `output-revise-dialog`, `output-revise-scope`, `output-revise-whole|selection|notes`, `output-revise-text`, `output-revise-target`, `output-revise-format-warning`,
`output-revise-save-first`, `output-revise-send`, `output-revise-error`, `run-meta-revision`.
Delete: `output-delete`, `output-delete-confirm`, `output-forget-confirm`.
Diagram: `diagram-viewport[data-shapes][data-mode]`, `diagram-toolbar`, `diagram-mode`, `diagram-hint`, `diagram-overview`, `diagram-overview-toggle`, `diagram-light-toggle`,
`diagram-export`, `diagram-copy-png`, `diagram-save-png`, `diagram-save-svg`, `diagram-copy-svg`, `diagram-copy-source`, `diagram-source`, `diagram-source-status`,
`diagram-scratch-note`, `diagram-stale-badge`, `diagram-error`, `diagram-goto-line`, `diagram-ask-fix`, `diagram-large-note`, `diagram-draw-anyway`, `diagram-fullscreen`, `diagram-more`.
Kept: `output-mermaid`, `output-mermaid-zoom`, `output-zoom-out|fit|actual|in|readout`, `output-detail-expand`, `output-dialog`.
Slides: `output-slides[data-state]`, `slide-strip`, `slide-thumb[data-n]`, `slide-stage`, `slide-prev`, `slide-next`, `slide-counter`, `slide-notes`, `slide-revise`, `slide-fidelity`, `output-note-whole-slide`.

## 16. Contracts needed (main and shared; the Runtime Lead builds these, renderer needs none of this until Phase C)

All in `src/shared/types.ts` (Run outputs section), structured-clone safe, and registered in `HOST_CHANNEL_REGISTRY` / atlas / `jsonRoundTrip` as the existing outputs channels are.

### 16.1 Types
- `OutputKind` gains `'pptx'`; `OUTPUT_KINDS`, `OUTPUT_PREVIEW_KINDS`, `OUTPUT_PRODUCE_KINDS` and `OUTPUT_PRODUCE_EXTENSIONS` (`pptx: 'pptx'`) add it; `outputKindForPath` maps `.pptx`
  (and `.ppt`, `.pptm`, `.odp` stay `'other'`: not parsed; `.pptm` is refused by register as macro-bearing).
- `RunOutput` gains: `version: number` (current), `versionCount: number`, `contentDigest: string` (sha256 hex of the current file, renderer uses it only for equality),
  `openNoteCount: number`, `current: { source: OutputVersionSource; at: number }`. `updatedAt` is the current version's time.
- `OutputVersionSource = 'agent' | 'edit' | 'external' | 'restore'`.
- `OutputVersion { n, source, createdAt, runId?, agentId?, role?, title, label?, bytes, digest, answers?: string (revision request id), restoredFrom?: number, noteCount, openNoteCount }`.
- `OutputNoteAnchor` union (11.1): `{type:'text',start,end,quote}`, `{type:'block',index,start,end,quote}`, `{type:'cells',sheet,r1,c1,r2,c2,quote?}`,
  `{type:'region',slide?,shape:'box'|'ellipse',x,y,w,h,labels?}`, `{type:'slide',slide}`, `{type:'whole'}`.
- `OutputNote { id (note_ + 16 hex), outputId, version, anchor, text, status: 'open'|'resolved'|'sent', createdAt, resolvedAt?, sentIn?: string }`.
- `OutputPreviewInput` gains `version?: number` (default current). `OutputRef` gains nothing; new `OutputVersionRef { projectId, outputId, version }`.
- `OutputPreview` gains `{ kind:'slides'; size: { w:number; h:number } /* pt */; slides: SlidePreview[]; truncatedSlides?: number }`.
- `SlidePreview { n, title?, background?: string, shapes: SlideShape[], notes?: string }`;
  `SlideShape` union with fractional geometry `{x,y,w,h}`: `text { paragraphs: SlideParagraph[], anchor?: 'top'|'middle'|'bottom', fill?, line? }`,
  `image { dataUrl, alt? }`, `shape { geometry: 'rect'|'roundRect'|'ellipse'|'other', fill?, line? }`, `table { rows: DocumentRun[][][] }`,
  `placeholder { label: 'Chart'|'SmartArt'|'Video'|'Picture'|'Object', alt? }`. `SlideParagraph { runs: SlideRun[]; level?: number; bullet?: 'disc'|'number'; align?: 'left'|'center'|'right' }`,
  `SlideRun` = `DocumentRun` + `sizePt?` + `color?: string` (`#rrggbb` only) + `font?` (printable name, hint). Colours validated `^#[0-9a-f]{6}$`.
- `OutputThumb` union (section 6) with caps.
- `OutputDiff` union: `{kind:'text', hunks: {aStart,aCount,bStart,bCount,lines:{op:'eq'|'add'|'del',a?:number,b?:number,text:string,marks?:[number,number][]}[]}[], added, removed, truncated?}`;
  `{kind:'blocks', rows:{op:'eq'|'add'|'del'|'chg', a?:number, b?:number, marks?:..}[]}`; `{kind:'cells', sheets:{name, status, changes:{r,c,op:'add'|'del'|'chg',was?,now?}[], rowOps:{r,op:'add'|'del'}[], truncated?}[]}`;
  `{kind:'slides', pairs:{a?:number,b?:number,status:'same'|'changed'|'added'|'removed'}[]}`; `{kind:'none',reason}` for kinds with no text.
  Caps: text 5,000 changed lines, 500 rows x 64 columns per sheet (reuse preview caps), 200 slides.
- `SlideDeckInput` for `produce_output` kind pptx (16.3).
- `OutputReviseInput { projectId, outputId, version, scope: 'whole'|'selection'|'notes', anchor?: OutputNoteAnchor, noteIds?: string[], instruction: string, target: OutputReviseTarget }`,
  `OutputReviseTarget = { type:'run', runId } | { type:'new' }`; `OutputReviseOptions { runs: {runId, label, state:'live'|'continuable'|'held'}[], newRunAllowed: boolean }`;
  `OutputReviseResult = { requestId, runId, mode:'sent'|'continued'|'started' } | { refused: string }`.
- `OutputSaveEditInput { projectId, outputId, baseVersion, text, forceNew?: boolean }`; result `{ ok: true, output: RunOutput, version: number } | { stale: true, currentVersion: number } | { refused: string }`.
- `OutputDeletePreview { path, relPath, outsideOutputsFolder, versions, trash: boolean, missing: boolean }`.
- Constants: `OUTPUT_VERSIONS_MAX 100`, `OUTPUT_VERSIONS_BYTES_MAX` (500 MB per project), `OUTPUT_NOTE_TEXT_MAX 2000`, `OUTPUT_NOTES_MAX 500` per output, `OUTPUT_REVISE_TEXT_MAX 4000`,
  `OUTPUT_PPTX_MAX_SLIDES 100`, `OUTPUT_PPTX_ELEMENTS_PER_SLIDE 40`, `OUTPUT_PPTX_TEXT_MAX_CHARS 5000` per text, `OUTPUT_PPTX_IMAGE_MAX_BYTES 5 MB`, `OUTPUT_PPTX_TOTAL_MAX_BYTES 40 MB`,
  `OUTPUT_PREVIEW_SLIDES_MAX 200`, `OUTPUT_PPTX_PREVIEW_XML_MAX_BYTES 8 MB`, `OUTPUT_PREVIEW_DECK_IMAGES_TOTAL_BYTES 20 MB`, `OUTPUT_EDIT_MAX_BYTES = OUTPUT_TEXT_MAX_BYTES`,
  `OUTPUT_EXPORT_IMAGE_MAX_BYTES 25 MB`, `OUTPUT_EXTERNAL_SETTLE_MS 1500`, `OUTPUT_WATCH_MAX 8`, `OUTPUT_WATCH_TTL_MS 600000`.

### 16.2 Channels (`OUTPUTS_IPC` and `window.orgai.outputs`)
Reads (scope read): `outputs:versions(OutputRef) -> OutputVersion[]`; `outputs:readSource(OutputVersionRef) -> { text, digest, truncated: false }` (text kinds, up to
`OUTPUT_EDIT_MAX_BYTES`, else `{ refused }`); `outputs:preview` (+`version`); `outputs:thumb(OutputVersionRef) -> OutputThumb`; `outputs:compare({projectId,outputId,a,b}) -> OutputDiff`;
`outputs:deletePreview(OutputRef) -> OutputDeletePreview`; `outputs:reviseOptions(OutputRef) -> OutputReviseOptions`; `outputs:notes(OutputRef) -> OutputNote[]` (all versions).
Writes: `outputs:saveEdit` (configure); `outputs:restore(OutputVersionRef) -> RunOutput` (configure); `outputs:update({ref, title?, description?, versionLabel?: {n,label}})` (configure; no file change);
`outputs:delete` changes: allowed for every source, trashes the real file (`shell.trashItem`, permanent delete fallback when trashing is unavailable, `trash` reported by the preview), removes snapshots and notes;
`outputs:forget` also removes snapshots and notes; `outputs:noteAdd`, `outputs:noteUpdate` (text, status), `outputs:noteRemove` (operate); `outputs:revise(OutputReviseInput) -> OutputReviseResult` (operate);
`outputs:watch({ref}) / outputs:unwatch({ref})` (operate; max `OUTPUT_WATCH_MAX` per window, TTL `OUTPUT_WATCH_TTL_MS`). Desktop only: `outputs:open` (kept), `outputs:reveal`, `outputs:saveAs`, new
`outputs:saveImage({ ref, suggestedName, mime: 'image/png'|'image/svg+xml', dataBase64 }) -> OutputSaveAsResult` (native save dialog only, at most `OUTPUT_EXPORT_IMAGE_MAX_BYTES`, PNG magic check, SVG
re-checked as text for scripts/foreignObject by the same rules as the preview gate; the renderer never supplies a path).
Push: `OutputsChangedEvent.what` adds `'version' | 'notes' | 'watch'`; `ids` stay output ids; RunEvent `output.versioned { runId, output }` beside `output.created`.
Every channel is registered in `HOST_CHANNEL_REGISTRY` with its scope; desktop-only ones in `DESKTOP_ONLY_CHANNELS`; the socket/CLI may read versions and notes (`orgai outputs list|versions|notes` is optional follow-up work).

### 16.3 Harness tools
- `produce_output`: kind `'pptx'` with `content: SlideDeckInput`:
  `{ size?: '16:9'|'4:3', theme?: { accent?: '#rrggbb', fontHeading?: string, fontBody?: string }, slides: SlideInput[] }`;
  `SlideInput { layout: 'title'|'section'|'content'|'two-content'|'image'|'blank', title?, subtitle?, bullets?: {text:string, level?:0|1|2}[], body?: string, left?: SlideBlock[], right?: SlideBlock[], image?: {path:string, alt:string, caption?:string}, table?: {rows:string[][], header?:boolean}, notes?: string }`
  (a `SlideBlock` is bullets, body, image or table). Images come only from files inside the project or an allowed folder (same confinement as register_output, regular file, png/jpeg/gif/webp, at most 5 MB); no URLs, no data from the network.
  Fonts are names only (printable, at most 64). Generation uses **pptxgenjs** (MIT as far as known, with its own deps `jszip` and `image-size`; the implementer confirms the licence and the installed
  versions from the lockfile before adding it, records it in ARCHITECTURE.md and CLAUDE.md, and pins it exactly). If a licence problem turns up, the fallback is writing the OOXML parts with the `jszip` already in the tree (exceljs depends on it); the slide model does not change.
  Notes and text are plain strings, never HTML or markup; a string starting with `=` is irrelevant here.
- Identity rule (section 3): `produce_output` and `register_output` add versions; new optional `separate?: boolean`; `overwrite` accepted and ignored. Results say: "Produced Project plan (version 3 of this
  output; the user edited version 2 at 11:04). It is at outputs/Project plan.docx." (the user-edit remark only when relevant, fenced `datum`).
- New tool `read_output` (audience all, non-blocking, same run kinds as produce): `{ action: 'list' | 'read' | 'notes', outputId?, version? }`; `list` returns id, title, kind, version, openNotes (fenced, at most 50); `read` returns text of the
  version (documents as Markdown-like text, sheets as tab-separated text per sheet, decks per slide with notes, text kinds as stored), capped at `OUTPUT_TEXT_MAX_BYTES` with "truncated"; `notes` returns open notes with anchors and quotes
  (fenced, labelled "The user wrote:"). Refused for image/pdf/other with a plain reason.
- Prompts: the output paragraph (prompts.ts, Runtime Lead) tells agents to produce again with the same file name to revise, to call `read_output` before revising, never to delete or move outputs, and that notes and selections are the user's instructions (the note **text** is
  user instruction; the quoted document text is data).

### 16.4 Storage layout
- Index `<data>/projects/<id>/outputs.json` moves to format 2: entries gain `version`, `versionCount`, `contentDigest`, `openNoteCount`, `current`, and `versions: OutputVersionMeta[]` (small records). A format 1 file loads with `version: 1`,
  `versionCount: 1` and a lazily created v1 snapshot; writing is atomic (tmp + rename) as today; a file that does not parse is never overwritten (as the knowledge store).
- Snapshots: `<data>/projects/<id>/outputs/<outputId>/v<n>.<ext>` (regular files, generated names only, never a user-supplied segment); the current version's snapshot is written **before** the index is updated.
  Notes: `<data>/projects/<id>/outputs/<outputId>/notes.json` (format 1, at most `OUTPUT_NOTES_MAX`, atomic). Revision requests: `<data>/projects/<id>/outputs/<outputId>/revisions.json` (request id, run id, version, noteIds, createdAt, answeredBy?; at most 50).
  Removal of an output removes its folder. `removeProject` and `projects:remove` (engagements "forget runs") remove the project's outputs data folder too (check the existing remove preview counts).
- Per-output queue serializes snapshot + index + file write; `outputs:saveEdit` and `outputs:restore` take it too, so a run and the user cannot interleave.

### 16.5 Watcher behaviour
No always-on `fs.watch`. A watched output (`outputs:watch`, up to 8, TTL 10 min, extended by each `outputs:open`) is polled by `lstat` every 1 s; any other indexed output of a project whose window is focused is `lstat`-checked on window focus
(only those the user opened this session, plus the 20 newest). A change is accepted when size and mtime are unchanged for `OUTPUT_EXTERNAL_SETTLE_MS`, the path is the same regular file (no link), under the same confinement as register
(project folder or allowed folder, not a reference folder, not the data dir, not `.git`), at most `OUTPUT_FILE_MAX_BYTES`, and the digest differs. Lock/temp names ignored. Then: snapshot, version (source `external`), index update, `outputs:changed
what:'version'`. A run that changes a registered file with Edit/Write (not through the tools) is therefore also versioned as `external`. A failing check logs once per output per hour and never fails anything.

### 16.6 Security rules (all must hold; tests required)
1. Never render or ship HTML. `OutputPreview`, `SlidePreview`, `OutputDiff` carry data only; text in them is plain; slide colours are `#rrggbb` only, hrefs only http/https/mailto (documents as today), images only safe data URLs.
2. pptx read: reuse `zipGuard` (entry count, ratio, size, per-entry inflate verification, no path traversal names), XML parsing without DTD/entities (no external entity or network, `processEntities` limits), at most `OUTPUT_PPTX_PREVIEW_XML_MAX_BYTES` total; external relationship targets (`TargetMode="External"`) and `.pptm` macros/ActiveX/OLE are never followed, never fetched, never executed; embedded media read only as listed image types within the byte caps; media from relationships are resolved inside the package only (normalised path, no `..`). Previews run through the existing one-at-a-time queue (max 8 pending).
3. pptx write: pptxgenjs gets only validated structured input; image paths pass the register confinement then are read by main; no network access by the generator (no URL images); fonts as names; output within caps; hidden characters refused in every string; the slide count/element caps refuse with "REFUSED: ...".
4. Path confinement: every file op (`saveEdit`, `restore`, `delete`, `watch`, `read`) re-resolves the entry's path and applies the register rules (regular file, no link/junction in the final component or parents beyond the realpath check, realpath inside the project folder or an allowed folder, not reference folder, not data dir, not `.git`); a failure answers a sentence, never throws. Delete trashes/unlinks only that regular file (never a directory, never a path that no longer matches the entry's realpath). Atomic writes: temp file in the same directory + rename; never write through a link.
5. The renderer never sends paths: ids, version numbers, text and base64 only. `saveImage` path comes only from the native dialog. `saveEdit` accepts only text kinds, size ≤ `OUTPUT_EDIT_MAX_BYTES`, rejects control (except tab/CR/LF) and bidi/zero-width characters in JSON and csv? No: text content is the user's own and may contain them; hidden-character refusal applies to **titles, labels, note text, instruction and anything agent-facing metadata**, not file bodies. svg saves with active content are refused ("This drawing contains active content.") using the preview gate's text rules, in main.
6. Notes and revise: note text and instruction refused when containing hidden characters; quotes and labels are untrusted document text; `outputs:revise` composes the message in main, fences quotes/labels/notes' quoted text with the shared `fenceDatum`, and clearly marks the user's instruction as the user's own. A peer/agent never creates notes or revise requests (no harness tool writes either). Revise goes through RunManager's normal send/continue/start so holds, interrupts, quitting, usage limits and pending cards gate it exactly as a user message ("R2 is held waiting for you..." refusals).
7. Caps and failure modes: `OUTPUTS_MAX`, versions caps, notes caps, thumb concurrency (main queue 2), compare caps; every cap refusal is a plain sentence; version pruning never removes the current version, a named version or v1.
8. Delete is main-confirmed by the renderer's confirm only; main does not trust that: it requires the `OutputDeletePreview` fields to be true at call time (`expectedVersionCount` compared) so a delete after new versions arrived re-confirms ("This output changed. Check it and delete again.").
9. Windows: case-insensitive identity key, reserved names refused as today, long paths via the existing path helpers; macOS/Linux POSIX realpath checks unchanged. None verified live on macOS or Linux (unit tests only).

### 16.7 Mock script needs (`[mock:outputs]`, Adapter Engineer)
Extend (without changing the existing outputs; the e2e in `e2e/outputs.mjs` keeps its names): the default `[mock:outputs]` run also produces: a `pptx` deck (5 slides: title, bullets, two-content, image from the existing png, table, speaker notes on two), `report.csv`
(header + 6 rows, one cell starting with `=`), `config.json` (valid), `logo.svg` (small safe SVG), `Large system map` (`flowchart TD`, 80 nodes, as in the walk), `Sequence` (sequenceDiagram), and `Broken diagram` (syntax error on line 2). New markers:
`[mock:outputs-v2]` (a second run in the same project produces the same file names as the first: `Project plan` docx with changed paragraph text, `Budget` xlsx with two changed cells, the deck with slide 3 changed and a slide added, `architecture.mmd` with one node renamed, `report.csv` with
a changed row; each must become version 2 through the real service) and `[mock:outputs-revise]` (the mock answers a revise message by calling `read_output` then `produce_output` at the same file name; echoes the request id logic through the real harness path). Unit tests with the mock under the real RunManager and a real service in a temp dir.

## 17. Phased build order

### Phase A: renderer-only diagram viewer (no contract change)
Goal: D1-D8 fixed, plus the cheap findings M1, M3, V1, V3, M2 default selection. Verified by unit tests, `e2e/outputs.mjs` (extended) and a UX walk.
Files (renderer):
- New `src/renderer/src/components/outputs/diagram/DiagramViewer.tsx`, `PanZoomSurface.tsx`, `DiagramOverview.tsx`, `DiagramToolbar.tsx`, `DiagramSourcePane.tsx`, `DiagramExport.tsx`, `DiagramError.tsx`, `useDiagramDraw.ts` (the draw queue and last-good state moved out of MermaidView).
- New `src/renderer/src/lib/diagramView.ts` + `diagramView.test.ts`; new `lib/diagramExport.ts` + test (light-theme redraw args, PNG size cap, svg serialization with xmlns/size, blob download helper); `lib/outputZoom.ts` + `outputZoom.test.ts` reduced to what is still used (natural size, percent label); `lib/outputSvg.ts` unchanged except exporting a helper if needed.
- Changed: `components/outputs/MermaidView.tsx` (thin wrapper over `DiagramViewer`), `SvgPreview.tsx`, `ImagePreview.tsx` (use `PanZoomSurface`), `ZoomControl.tsx` (new zoom bar order, readout role), `OutputDetail.tsx` and the Larger view dialog (`OutputDialog` host; Full window; "Open large"), `OutputPreview.tsx`, `OutputActions.tsx` (Export / Copy source entries), `RunOutputs.tsx` and `OutputsFilters.tsx` (roving kind chips `outputs-kinds`, prev/next buttons and Alt+Left/Right, tab count label), `views/OutputsView.tsx` (default-select newest), `lib/outputsRun.ts` (transcript copy "Produced diagram: ..."), `components/SheetView.tsx` (the "=" note, V1), the side-tab label in `components/TranscriptPanel.tsx` / `revealOutputsTab.ts` (count), `lib/menuActions.ts` SHORTCUTS and `KeyboardShortcutsDialog` for the new keys that exist in this phase (none global; the viewport keys are local and listed in the viewer's hint), `styles/outputs.css`, `styles/outputs-preview.css`, `styles/outputs-view.css`.
- Tests: new `e2e/outputs.mjs` sections (large diagram fits at 1600x1000 and 1024x640 with the shape count note, wheel and Ctrl+wheel and drag, keyboard pan/zoom, double-click Fit/100%, small diagram not below 100%, split source live edit, broken diagram keeps source and last drawing, export notices, overview, Full window and Esc order, both themes, no page scroll, reduced motion has no running animations).
- Mock: the large and broken diagrams only needed under `ORGAI_MOCK_SCRIPT` (as in walk 2); the adapter-owned `mock.ts` change is Phase B. Phase A edits in Split/Source are scratch (`diagram-scratch-note`), Save as file uses the Blob download.
- Docs: `docs/design/outputs.md` section 4 note pointing here; atlas testIds for the new surfaces in `src/shared/view/atlas.ts` only for existing surfaces (no new surface).

### Phase B: contracts and main (Runtime Lead; the Adapter Engineer edits `mock.ts` only)
Files: `src/shared/types.ts` (16.1-16.2), `src/shared/view/atlas.ts` (new testIds for the existing `run-outputs` / `project-outputs` surfaces), `src/shared/view/outputs*.ts` for pure helpers (identity key, diff, anchors) if the CLI needs them;
`src/main/outputs/`: `service.ts` (identity rule, versions, restore, delete, saveEdit, watch, notes, revise glue), `store.ts` (format 2), `versions.ts` + `versions.test.ts` (new: snapshots, caps, pruning), `notes.ts` + test (new), `diff.ts` + test (new: text, blocks, cells, slides), `watch.ts` + test (new: stat poll, settle, confinement), `pptxWrite.ts` + test (new: `SlideDeckInput` validation and pptxgenjs call), `pptxPreview.ts` + test + `pptxPreview.measure.test.ts` (new: XML to `SlidePreview`, with hostile fixtures: zip bomb, external targets, huge XML, path traversal, macro file), `thumb.ts` + test (new), `revise.ts` + test (new: message composition, target options), `writers.ts` (pptx kind, text writes atomic), `preview.ts` (version param, slides), `paths.ts` (confinement for write/delete/restore), `api.ts`, `markdownDoc.ts` (read-as-text for `read_output`), `zipGuard.ts` (reuse; add pptx caps if needed);
`src/main/runtime/harnessTools.ts` (`produce_output` pptx / `separate`, `read_output`, results), `src/main/runtime/prompts.ts` (outputs paragraph), `src/main/runtime/runManager.ts` (revise routing through send/continue/start, `RuntimeContext.outputs` additions, `output.versioned` broadcast, run-end pending-revision resolution), `src/main/host/registry.ts` + `args.ts` + `dispatcher.ts` + `ipc.ts` (channels, argument rebuilders, desktop-only list), `src/preload/index.ts` (API), `src/main/store/projectData.ts` / project remove paths (outputs data removal and preview counts), `src/main/index.ts` (service wiring, focus check), `package.json` + lockfile (pptxgenjs pinned exactly; fast-xml-parser or the parser already in the tree), `.orgai/ARCHITECTURE.md` and `CLAUDE.md` (Run outputs bullets, licence note, Risks), `src/main/runtime/mock.ts` (16.7; Adapter Engineer), `src/main/runtime/mockOutputs.test.ts` (new).
Gate: typecheck, `npm test`, `jsonRoundTrip`, registry tests, Reviewer pass (security-relevant: file write/delete, pptx parsing, path confinement).

### Phase C: renderer for B
Files: `src/renderer/src/store/useAppStore.ts` (versions, notes, pending revisions, `output.versioned`, `outputs:changed` kinds, dirty drafts), `lib/outputs.ts` (version labels, source words), `lib/outputVersions.ts` + test (new), `lib/outputNotes.ts` + test (new: anchors, mark ranges, region math), `lib/outputDiff.ts` + test (new: view models over `OutputDiff`), `lib/outputRevise.ts` + test (new), `lib/csvGrid.ts` + test (new), `lib/slideStage.ts` + test (new: geometry, cqw), `lib/outputEdit.ts` + test (new);
`components/outputs/`: `OutputDetail.tsx` (tabs, version select, banners), `OutputActions.tsx` (Delete for all, Rename, Export), `OutputsList.tsx` + `OutputsGrid.tsx` (new), `OutputThumb.tsx` (new), `VersionsPanel.tsx`, `ComparePanel.tsx`, `CompareText.tsx`, `CompareCells.tsx`, `CompareSlides.tsx`, `CompareTwoUp.tsx` (new), `NotesPanel.tsx`, `NoteComposer.tsx`, `RegionLayer.tsx`, `NoteMarks.tsx` (new), `ReviseDialog.tsx`, `EditorBar.tsx`, `TextEditor.tsx`, `MarkdownEditor.tsx`, `JsonEditor.tsx`, `CsvGridEditor.tsx`, `SourceEditor.tsx` (new), `SlideViewer.tsx`, `SlideStage.tsx`, `SlideStrip.tsx` (new), `ExternalEditStatus.tsx` (new), `DeleteOutputs.tsx` (new, single and bulk), `OutputViewer.tsx` (the S4 shell, replaces the Phase A Larger view host), `DocumentView.tsx` and `SheetView.tsx` (selection and note marks), `diagram/DiagramViewer.tsx` (Save instead of scratch; region layer; Ask the team to fix), `diagram/DiagramExport.tsx` (`saveImage`);
`views/OutputsView.tsx` (grid, select mode, bulk bar, prev/next), `components/RunMeta` (`run-meta-revision`), `TranscriptPanel` row for outputs (Revise link, new copy), `lib/menuActions.ts` + `KeyboardShortcutsDialog` (Ctrl/Cmd+Shift+M, Alt+Left/Right, F3 additions), `styles/outputs*.css` plus new `styles/outputs-slides.css`, `styles/outputs-compare.css`, `styles/outputs-notes.css`; atlas entries; `e2e/outputs.mjs`, new `e2e/outputs-versions.mjs`, `e2e/outputs-notes.mjs`, `e2e/outputs-slides.mjs` (add to e2e:free in package.json), `CLAUDE.md` Renderer bullet.
Gate: typecheck, vitest renderer, build, e2e outputs scripts, Reviewer (note text, region math, no HTML), then a UX walk (`ux-review-outputs-3.md`).

Order inside C: (1) versions list, version select, old-version banner, restore, delete for all; (2) compare; (3) editors (text, markdown, json, svg, mermaid save, csv grid); (4) slide viewer; (5) notes; (6) revise and pending revisions; (7) project tab grid, thumbnails, bulk select; (8) external edit status.

## 18. What the UX walk must check
1. Diagram: 80-shape diagram fits at both sizes with the note and the overview; the wheel (S4), Ctrl+wheel (S3), pinch, drag, double-click, keyboard; 4-node diagram at 100%, centred; Fit never below visible; resize keeps fit; no page scroll.
2. Split live editing: broken then fixed source, last good drawing and stale badge, error pane copy and Go to line; export PNG/SVG light and as shown; copy source; Full window and Esc order; both themes.
3. Versions: second-run file becomes version 2 (no "(2)"); versions list wording; compare in each kind; restore adds a version and rewrites the file; viewing an old version disables edit; version select reachable by keyboard.
4. Edit: markdown split, csv grid keyboard walk (arrows, Enter/F2/Esc, undo), json invalid blocks Save with a reason, stale-save line, dirty guards on tab/selection/close, draft kept.
5. External: edit docx in a real app (or replace the file on disk), version appears with the right words, no focus move, announcement once.
6. Slides: strip is one Tab stop, stage keys, notes disclosure, fidelity caption, both themes, 1024x640 layout, a registered external pptx with a chart (placeholder).
7. Notes: add by each kind with keyboard only (selection, cells, region tool with Enter/arrows), marks not colour-only, panel order and pin numbers, resolve/reopen, select and Revise with notes, "Sent" state.
8. Revise: target choices for live, ended and held runs, pending line, arrival, run-ends-without-version; docx format warning; the dialog's errors.
9. Delete: produced, registered (path shown), missing, bulk; focus after; trash wording.
10. Project tab: grid and list, roving chips, default selection with no focus steal, prev/next, count and live announcements, 300+ rows, both sizes, both themes.
11. Reduced motion: no running animations; screen reader pass over `output-live` strings; contrast of marks and diff glyphs in both themes.

## 19. Open decisions
- OQ1: merge pre-existing "name (2)" outputs into one chain? Proposed: not now.
- OQ2: should agents be able to write notes (for example a reviewer agent annotating a deck)? Proposed: no in this phase.
- OQ3: a "package for the client" export (zip of the set, PDF of a deck or document) is not in this spec. Proposed next step after Phase C.
- OQ4: pptxgenjs licence and maintenance status must be confirmed at implementation time (fallback in 16.3); the preview parser's fidelity (theme fonts, grouped shapes, rotated shapes) is best effort and is shown as such.

## Phase A implementation notes (2026-11-07)

Built renderer-only on top of `5d0c2a53`; no change to `src/shared`, `src/main`, `src/preload` or types.

What landed:
- Diagram viewer `components/outputs/diagram/` (`DiagramViewer`, `PanZoomSurface` + `ShadowSvg`, `usePanZoom`, `DiagramToolbar` + `SurfaceToolbar`,
  `DiagramOverview`, `DiagramSourcePane`, `DiagramExport`, `DiagramError`, `useDiagramDraw`, `useSurfaceNotes`); pure maths in `lib/diagramView.ts` and
  export helpers in `lib/diagramExport.ts` (both unit-tested); `lib/outputZoom.ts` is reduced to `svgNaturalSize`; styles in the new `styles/outputs-diagram.css`.
  `MermaidView` is a thin wrapper; `SvgPreview` and `ImagePreview` use the same surface and zoom bar (image: the old Fit/Actual control is gone).
  `OutputPreview` passes the surface context (`detail` / `dialog`, Open large, Full window) through `OutputViewContext` (`previewStatus.ts`).
- Testids differ from section 15 in these ways: the zoom group keeps `output-mermaid-zoom[data-value]` (class `diagram-zoom`) and the viewport is
  `diagram-viewport[data-mode][data-k][data-x][data-y][data-natural-w][data-natural-h][data-shapes]` (one element cannot carry two testids). The
  export panel is `diagram-export-panel`, the narrow More menu `diagram-more-menu`, visible notices `diagram-notice` (`output-notice` stays the
  surfaces'), the guard line `diagram-guard`. The viewer root `output-mermaid[data-state=drawing|ok|error|refused|guard|truncated][data-view]`.
  Gone: `output-mermaid-view`, `output-mermaid-copy`, `output-mermaid-error`, `output-mermaid-refused`, `output-mermaid-stage`, `output-image-size`,
  `output-zoom-status`, and `output-source` for diagrams (the source is the `diagram-source` textarea).
- The embedded viewport is `clamp(240px, 42vh, 480px)` high (269 px at 1024x640, 420 px at 1600x1000). The large-diagram note has no second
  "Open large" button: the toolbar's primary one sits right above it. The Larger view moves focus to the viewport once it is drawn (unless the
  user moved focus first). Esc leaves Full window first unless a confirm opened from the viewer has focus.
- Toolbar roving: a radio group is one stop (its checked radio); Up/Down change the mode natively, Left/Right move between controls, modifiers
  are ignored (Alt+Left/Right steps outputs).
- Cheap findings: M1 tab count (`side-tab-outputs-count`; accessible name "Outputs, 12 outputs" through the shared Tabs count) and row copy
  ("Produced diagram: Architecture diagram", "Registered image: Logo"; `kindWord` in `lib/outputsRun.ts`); M2 default selection of the first
  filtered row without focus or announcement; M3 `OutputStepper` (`output-stepper`, `output-prev`, `output-next`, `output-position`, sr-only
  `output-step-status` that speaks "<title>, 3 of 12" after a button step) in the run side tab and the project pane, Alt+Left/Right focusing
  the new heading; V1 `output-sheet-formula-note`; V3 kind chips as one toolbar `outputs-kinds`.
- e2e `e2e/outputs.mjs`: the existing checks on the new testids plus a second project driven by an `ORGAI_MOCK_SCRIPT` set in main for that run
  (80-shape flowchart, two-node flowchart, broken flowchart), at 1024x640 and 1600x1000 in both themes: Fit fills and contains the large drawing,
  the shape note, plain wheel passes through in the panel, Ctrl+wheel zooms, drag pans, arrow / Shift+arrow / 0 / 1 / + / - keys, double-click
  Fit/100%, a small diagram between 100% and 150% centred, the broken diagram's error pane with its source, the toolbar's Tab stop, and in the
  Larger view: focus on the viewport, plain wheel zoom, O overview, F Full window and the first Esc, Split live redraw, a broken edit keeping
  the last drawing with the stale badge, Copy SVG's notice, no running keyframe animation, no page scroll. `E2E_DIAGRAMS_ONLY=1` runs only that part.

Not built in Phase A: "Ask the team to fix it" (needs the revise contract, Phase C); Export / Copy image from the More actions menu (the viewer
toolbar has them; the menu has Copy source); new keys in the shared SHORTCUTS table / Keyboard shortcuts dialog (the viewer keys are local and
listed in its hint; Alt+Left/Right is not listed yet); "3 of 12" inside the Larger view.

Unverified: PNG and SVG files actually saved (Blob download; Electron may show its own save dialog), Copy as image on the real clipboard, the
light-theme export redraw and "As shown", pinch and two-pointer gestures, middle-button pan, the overview's drag, screen reader output of
`output-live` and `output-step-status`, contrast of the stale (60%) drawing and the "Light drawing" paper, a source over 64 KB (Draw it anyway)
or truncated at 256 KB, SVG and image surfaces beyond the existing load checks, macOS and Linux. Light drawing paints with the literal white
keyword (no paper token exists). Alt+Left in Electron might also trigger history back (not seen).

Reviewer (two passes): the SVG / PNG path is safe; H1 (toolbar could leave the Tab order) and H2 (stale e2e) fixed, M1, L1-L4, L6, L8, L9
fixed. Open Lows: `output-step-status` is a second polite region on the surface (spec 14.2 wants one; route it through `outputs-status` /
`tray-announce`); the Larger view waits about 3 s for the drawing before focusing the viewport, a slower draw leaves focus on the dialog's first
control; Space on the viewport only stops page scroll (plain drag already pans); Alt+Left/Right and the viewer keys are not in the shared
SHORTCUTS table (a `src/shared/view` edit).
