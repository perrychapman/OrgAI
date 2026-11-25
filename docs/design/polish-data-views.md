# UI polish pass: data views

Scope: Files (outputs), Knowledge, Usage, Run history, Schedules and To-dos. Looked at in the built app on the mock
adapter with a throwaway data dir, at 1024x640 and 1600x1000, in dark and light.

Seed data (token-free, driven through the preload API and the mock adapter's `ORGAI_MOCK_SCRIPT`):

- Files: a project with 49 files (12 versions of one document, 14 open notes on it, long titles, a 40-slide deck, a
  30-column by 80-row workbook, a 150-node diagram, a corrupt PNG, CSV, JSON, SVG, text, Markdown).
- Knowledge: an engagement with 104 items in 10 kinds, long names, facts, 300 relations.
- Usage and History: 120 runs over 30 days across three projects, several models, failed, stopped, scheduled and
  unpriced runs (costs scaled to dollars).
- Schedules: 9 schedules (one every 15 minutes, weekly, cron, once; long names; some off, some never run).
- To-dos: 60 items with long text and details, 12 done.

Severity: High (broken or unusable), Medium (clearly wrong, seen by everyone), Low (small or only in some data).

## Findings

| # | What | Where | Sev | Status |
| --- | --- | --- | --- | --- |
| 1 | The search icon was invisible: the input's backdrop filter makes a stacking context that painted over the absolutely placed icon, so the field showed an empty 32 px gap (ux-review L10) | Files filter row (`outputs-view.css`) | Medium | Fixed (`z-index: 1` on the icon) |
| 2 | In the detail line the "·" separator floated at the far right edge, away from the text it separates ("path ........ · Orchestrator · R1") | Files detail, `output-detail-line` (`outputs.css`) | Low | Fixed (meta no longer grows) |
| 3 | Computed numbers showed float noise in the sheet preview (`6.8500000000000005`, `12.330000000000002`) | Files, sheet viewer (`lib/outputPreview.ts` `sheetCellText`) | Medium | Fixed (15 significant digits, as a spreadsheet shows) |
| 4 | Empty and no-match states in the list column used the large org-chart glyph (ux-review L10) | Files and Knowledge compact empty states | Low | Fixed (small quiet icons: file, search-x, network, archive) |
| 5 | "Recorded by" (Everyone 105 / You 100 / Team 5) wrapped into two rows in the 240 px filter column, leaving a ragged box | Knowledge list view, filter column (`knowledge.css`) | Medium | Fixed (stacked, label left, count right, full width) |
| 6 | A long fact is cut mid-letter in its always-editable field ("a good deal longer thar") with no way to see all of it without clicking in | Knowledge detail, Facts | Low | Fixed in part (full text in the tooltip). Left: a field that grows to wrap needs a design decision (Enter saves today) |
| 7 | The summary line of "Where it went" had `flex: 1 1 100%` in a column and stretched into a 60 px empty gap above the ribbon | Usage, Where it went (`usage-breakdown.css`) | Medium | Fixed |
| 8 | Spend over time: the metric and period controls sat right-aligned on their own row, 45 px in from the title's left edge | Usage, spend card (`usage-charts.css`) | Medium | Fixed (own row, left edge) |
| 9 | All runs table: every column after the first was right-aligned, including project, result, when, kind and models, so names started at ragged x positions ("Polish main" / "Polish bulk") | Usage, All runs (`usage-tables.css`) | Medium | Fixed (text columns left, figures right) |
| 10 | Runs worth a look: the "Run" and "No result" tags wrapped with a left indent, so the line started ragged | Usage (`usage-tables.css`) | Low | Fixed (flush left, gap on the right) |
| 11 | The action row of a run's detail stretched buttons to the tallest neighbour: "Open the run" and "Continue from here" became 53 to 70 px tall blocks beside "Run it again" with its caption | Run history detail (`history.css`) | Medium | Fixed (`align-items: flex-start`) |
| 12 | "Weekly cost / Weekly cost unknown": the label said it twice | Schedules detail panel | Low | Fixed (reads "Unknown"; the basis stays in the screen reader text) |
| 13 | A slot earlier today looked the same as one still to come (ux-review L12) | Schedules week strip | Low | Fixed (dotted edge and quieter chip, title says "already past") |
| 14 | Sheet tab shows "Second sheet with a long name h" | Files, workbook tabs | Low | Not a defect: the 31 character sheet name limit cuts the name before the renderer sees it |
| 15 | Cost precision is uneven in rows ("$0.00573", "$0.009975", "$0.0798", "$12.49"): four significant digits under $1 | History rows, Limits (shared `shared/view/cost.ts`) | Low | Left: the rule is documented in `cost.ts`; changing it to two decimals (three under a cent) is a decision and a shared file (ux-review L5) |
| 16 | Run titles drop the brackets of a marker: "Hit the budget mockbudget-stop" (ux-review L4) | Everywhere a title shows | Low | Left: `lib/runTitle`, not in this area, mock markers only |
| 17 | Knowledge graph labels collide with nodes and edges when 60 nodes are drawn in light theme ("Meeting number 8" under a node) | Knowledge graph | Low | Left: label placement is in the engine (`neuralEngine.ts`), outside this pass |
| 18 | History Trends: the per-day bars have no value axis or readout (only the first and last date), and the By role table is 1300 px wide with the figures far from the names | History > Trends | Low | Left: needs a chart design (axis, hover readout). The table is available under "Show as table" |
| 19 | Schedules rows say "No runs yet." and "Not run yet" and "Weekly cost unknown" for a schedule that has never run: three lines for one fact | Schedules rows | Low | Left: the words live in `lib/schedulesBoard.ts` and are checked by e2e/schedules.mjs; needs a copy decision |
| 20 | At 1024 the History filter selects wrap onto a second row, so the list shows about three and a half rows | History at 1024 | Low | Left: no room in one row; a menu for the two selects is a design change |
| 21 | Expanded sidebar (a saved choice) at 1024 leaves the Knowledge detail column squeezed to a sliver with a sideways scrollbar | Knowledge list view with the sidebar open at 1024 | Medium | Fixed in part two (23). Was: needs the Knowledge grid to fold the detail pane below a width; I did not change layout rules here since the auto sidebar collapses at 1024. Reported for the owner |
| 22 | Large diagram fits at 2%: the drawing is a thin strip, the note says "Zoom in to read, or open the larger view" | Files, diagram preview | Low | Left: by design, the text says what to do |

Checked and fine: both themes keep a visible glass edge on every panel I opened; the preview and detail panes are in
view at 1024x640 in Files, History and Schedules; the viewer dialog, note dialog and schedule editor fit the window
(editor scrolls inside); the filter chips, bulk bar and no-match states; slide strip in the larger view; versions list
with 12 versions; notes with 14 cards; To-dos at 60 items, edit form and done section; the sticky Usage filter bar over
scrolled content.

## Not looked at

Revise dialog and revision status; compare in each mode; the editors (document, sheet, slides, diagram, CSV grid,
JSON); delete confirmation text; the run side tabs (Files, Knowledge, Usage); the sidebar usage meter; Usage in
Model, Role and Connection modes and its empty and loading states; Knowledge hover and selected node cards, the
legend, Show all, possible links; the schedule editor opened from New run; a 100-item Chat to-do list. Reduced-motion
behaviour was not re-checked (no motion was added).

## Left for the owner

- Cost precision rule (finding 15) and the `Weekly cost unknown` family of lines (19).
- Whether a Knowledge fact should wrap (a growing field) instead of scrolling inside a one-line field (6).
- A narrow-width rule for the Knowledge detail column (21).
- A value axis and hover readout for the History Trends bars (18).
- Label placement in the Knowledge graph on a light ground (17).

## Checks

See the report that came with this change for the commands run and their results.

## Part two

Second pass over what part one did not look at: Files compare (Side by side, Changes, Rendered, Drawings) for markdown, CSV,
JSON, Word, Excel and diagram; the in-app editors (markdown, CSV grid, JSON, diagram); the Revise dialog; Usage "Where it
went" in Model, Role and Connection modes; Knowledge at 1024 with the sidebar open. Mock data, throwaway data dir, 1024x640
and 1600x1000, dark and light.

| # | What | Where | Sev | Status |
| --- | --- | --- | --- | --- |
| 23 | Finding 21 fixed: with the sidebar open at 1024 the list column was 184 px (names cut to one letter) beside a 360 px detail | Knowledge list view (`knowledge.css`) | Medium | Fixed: the detail column is `clamp(280px, 38cqi, 360px)` (cqi of `.main`, as the run view does), so the list keeps 243 px at 1024 with the sidebar open and 360 px stays for wide windows; a dragged width still wins. Same rule in the Graph view band layout |
| 24 | In that narrow list the origin chip ("Agent") shared the row with the kind chip and left names of 2 to 4 letters ("Ac...") | Knowledge rows | Low | Fixed: below 860 px of tab width the second chip is hidden (provenance is on the line below) |
| 25 | The diagram editor in the detail panel at 1024x640: the 200 px source box did not shrink, so the drawing painted over it and the source text was hidden | Files, diagram Edit, Split | Medium | Fixed (`outputs-diagram.css`: the source box shrinks to 88 px before the drawing's 200 px floor, which e2e asserts, gives way). Margin is about 1 px at 1024x640 |
| 26 | The Revise dialog's target read "R2 (still running) (still running)": main already tags the label and the renderer added the words again | Files, Revise dialog | Low | Fixed in `lib/outputRevise.ts` (the tag is dropped once; unit test added) |
| 27 | Usage "Where it went" in a narrow card (1024): the count after the cost was cut ("11 r...", "1 re...") and names to 7 characters | Usage, Project / Model / Role / Connection ranked rows | Medium | Fixed: below 560 px of card width a row takes two lines (name and cost, bar and counts) |
| 28 | Compare: the "with" picker wraps under "Compare" at 1024 and starts left of the first select's edge (labels differ in width) | Files, compare head | Low | Left: a fixed label column or a stacked pair is a layout decision for the head |
| 29 | The markdown editor's source box sits flush under the tab strip (no gap) | Files, markdown Edit | Low | Left: shared `output-edit` spacing, one pixel row, no overlap |
| 30 | Role breakdown table lists "Orchestrator" twice (two projects) with the project column hidden when the card is narrow | Usage, Role, Show as table at 1024 | Low | Left: the optional project column is dropped by design; the ranked list above names the project |
| 31 | Connection mode with one connection leaves the card mostly empty beside the taller spend card | Usage at 1600 | Low | Left: expected for one row; no filler wanted |
| 32 | Sidebar usage meter | Sidebar footer | n/a | Not reachable on the mock adapter: the footer shows only "Mock adapter" with no plan or spend figure, so it was not seen |

Checked and fine: compare in Changes and Side by side for text, grids and drawings in both themes (focus ring on the select
is visible); the editors for markdown, CSV and JSON; Revise dialog layout and focus; Usage Model, Role and Connection ranked
rows and tables; light-theme contrast of chips and tabs. To-dos and the schedule editor were already covered in part one and
were not re-walked.

Left for the owner: the compare head layout (28), the Role table's project column (30). Not verified by eye after the
changes: Knowledge Graph band at 1024 (the grid column rule is shared; the e2e band checks pass), a schedule or to-do at
other sizes.
