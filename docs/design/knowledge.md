# Knowledge tab: what the team knows about an engagement

Spec for the renderer side of the engagement knowledge graph (ARCHITECTURE.md Shared contracts "Engagement knowledge
graph"; runtime bullets in CLAUDE.md). It follows the 19 numbered recommendations of
`docs/design/ux-review-knowledge.md` and cites them as "rec N". Deviations are listed in section 12 with a reason.
Contract: `window.orgai.knowledge.*`, `window.orgai.engagement.listNotes / getNote / saveNote / removeNote`,
`window.orgai.onEngagementChanged`, pure helpers in `@shared/knowledge`; nothing on the main side changes in this pass.

Words in visible copy: "item", "fact", "relation", "note", "kind", "retired", "recorded". Never "entity", "node",
"edge", "provenance" or "knowledge graph" (rec 14); "Graph" only as the view switch label.

## 1. Placement (rec 1, 2, 3)

- A project tab **Knowledge** between History and Team, engagements only (`projectKindOf(project) === 'engagement'`),
  never on the three assistants. `View` gains `'knowledge'`; App.tsx `SECTION_VIEWS` and the topbar `Tabs` get the
  entry `{ id: 'knowledge', label: 'Knowledge', testId: 'tab-knowledge' }`. Open-tab restore (`lib/openTabs.ts`) and
  `menuStateFor` are unaffected. No application-menu item in this pass (a main-side contract; open).
- The run view adds a RunMeta line "Recorded N items" (rec 2 alternative, section 8).
- Settings > General > Context notes becomes a summary line with "Open Knowledge" (rec 3, section 9).
- Deep links into the tab: the store's `openKnowledgeItem(req)` sets `view: 'knowledge'` and `knowledgeFocus`
  (`lib/knowledge.ts` `KnowledgeFocusRequest`: `nodeId` / `noteId`, else `kind` + `name`, else `noteTitle`); the tab
  resolves it with `resolveFocus` once it has its data, selects the item, opens the detail pane, moves focus to the
  detail heading, then `clearKnowledgeFocus()`. An unresolvable request just opens the tab.

## 2. Page layout (rec 4)

`views/KnowledgeView.tsx`, root `div.knowledge[data-testid=knowledge-view][data-view=list|graph]`, no `CanvasFrame`.
Three columns in a grid: the filter column (240 px at 1600, 200 px at 1024), the list (or the graph) taking the rest,
and the detail pane as `SidePanel` (`label="item details"`, `persistKey="knowledge"`, `autoCollapseBelow={1100}`,
`revealOn={selectedId}`, `testId="knowledge-detail"`). Under 1100 px (1024x640) the pane starts as its 40 px rail and
opens on selection, like the run panel; the list keeps the width. The page never scrolls: the list and the pane scroll
inside themselves.

Top row (`knowledge-toolbar`, 40 px): the view switch `knowledge-view-switch` (`SegmentedControl` label "View", options
"List" / "Graph"; the choice is remembered per project in localStorage `orgai.knowledgeView.<pid>`, default List), a
spacer, then "Add a note" (`knowledge-add-note`, secondary, icon `Plus`) and "Add an item" (`knowledge-add-item`,
secondary, icon `Plus`). Native-disabled with a visible reason beside it at the caps: "200 notes is the most an
engagement can keep." / "2,000 items is the most an engagement can keep." (ENGAGEMENT_NOTES_MAX, KNOWLEDGE_NODES_MAX).

One polite status region per tab, rendered empty first: `p.sr-only[role=status][data-testid=knowledge-status]`
(rec 18). `role=alert` only for a refused save (the Banner `knowledge-error`, tone danger, dismissable).

### Filter column (`knowledge-filters`, a `<form role="search">` with the heading "Show" as its legend, rec 14)

1. Search box `knowledge-search` (`Input`, label "Search", placeholder "Name, fact or note"; Esc clears it and keeps
   focus; a Clear button `knowledge-search-clear` appears while it has text). Debounced 150 ms.
2. Kind chips: a `<fieldset>` legend "Kind", one `button[aria-pressed]` per kind in use (`knowledge-kind[data-kind]`,
   label "People 8" with the count in a quiet span; the count follows the retired switch). Several may be pressed
   (OR). "All kinds" (`knowledge-kind-all`) resets. Counts from `kindCounts`.
3. Origin chips: legend "Recorded by", `knowledge-origin[data-origin=user|agent]` "You 12" / "Agents 38"
   (`originCounts`), both pressable; none pressed = both.
4. `Switch` "Show retired" (`knowledge-show-retired`), remembered per project (`orgai.knowledgeRetired.<pid>`).
5. The count line `knowledge-count` (quiet): "12 of 300 items" (`countLine`), also spoken through the status region
   on filter changes, debounced 400 ms.

### The list (`knowledge-list`, rec 4, 6, 14, 16)

- Grouped by kind in `groupItems` order: People, Organisations, Systems, Documents, Decisions, Risks, Requirements,
  Deadlines, Meetings, Open questions, free-form kinds as typed (sentence case, singular: "Vendor"), Notes last.
  Each group: `section.knowledge-group[data-kind]` with an `h2` (`knowledge-group-title`, "People" plus a quiet
  count) and its rows. Order inside a group is creation time (`orderItems`), never updatedAt (H3); with a query,
  best rank first (`searchItems`).
- One `ul[role=listbox][aria-label="Items"]` across all groups (groups are `li[role=presentation]` wrapping an
  `h2` and a nested `ul[role=group][aria-labelledby=<group title id>]`) so the whole list is **one Tab stop**: the
  options carry `tabindex` by a roving index (`useRovingFocus` with selector `[role=option]`), Up / Down move,
  Home / End, type-ahead on the name (letters typed within 500 ms), Enter opens the detail pane and moves focus to
  its heading, Esc in the detail returns focus to the row (rec 16). A click selects (single click) and opens (the
  same as Enter). `aria-selected` marks the selected row; the selection is shared with the graph.
- Row `li[role=option][data-testid=knowledge-row][data-id][data-kind][data-origin][data-retired]`:
  line 1 the name (`knowledge-row-name`, 13/500, one line, ellipsis) and the kind `Badge` (neutral, text
  `kindLabel`), the "Agent" badge (neutral) only when no origin chip is pressed (rec 8), the "Retired" badge
  (neutral) when retired; line 2 the excerpt (`itemExcerpt`, quiet, one line, ellipsis; omitted when empty);
  line 3 the provenance line (`provenanceLine`: "You · 4 Nov 2026" / "Analyst · R1 · 4 Nov 2026", quiet 12 px).
  Rows are 56 px (three lines) or 44 px without an excerpt. No buttons in the row (rec 16): the row's actions live in
  the detail pane; Shift+F10 or the context menu opens a per-row "More actions" `Popover` (`knowledge-row-more`)
  with Open, Retire / Restore and, for notes, Edit (menu items; Esc closes, focus back on the row).
- Past 100 shown rows the list windows: only rows within the scroll viewport plus 20 are rendered (a plain
  windowing hook over the ordered flat list with a spacer top and bottom; group titles stay in flow). Keyboard
  navigation scrolls the target row into view before focusing it.
- Empty states (rec 12), through `EmptyState` (`icon` for the nested panel):
  - nothing recorded and no run yet (`knowledge-empty`): "Nothing recorded yet" / "Add a note for the team, or run
    the team and it records people, systems, decisions and risks here as it works." with "Add a note" and
    "Add an item" (both secondary).
  - nothing recorded after runs (`knowledge-empty-runs`, when the project has any work run): "The team has not
    recorded anything yet" / "Notes you add here are read at the start of every run." plus the same two buttons.
  - filtered to nothing (`knowledge-empty-filter`): "No items match <query>." (or "No items match these filters."
    without a query) with "Clear search" (`knowledge-clear-filters`).
  - only retired items hidden (`knowledge-empty-retired`): "Only retired items." / "Show retired to see them."
- Loading: `p.panel-note` "Looking…"; read error: the `knowledge-error` Banner with Retry.

## 3. Detail pane (rec 7, 10, 11, 15)

`components/knowledge/KnowledgeDetail.tsx` inside the SidePanel body, `div[data-testid=knowledge-detail-body][data-id]`.
With nothing selected: `p.panel-note` "Select an item to see its facts, relations and history." (`knowledge-detail-empty`).

Header:
- `h2#knowledge-detail-heading` (`knowledge-detail-name`, `tabIndex=-1`, the focus target) holding the name as an
  inline-editable field: at rest it is a `button.inline-edit` labelled "Edit name"; activating it swaps in an `Input`
  (`knowledge-name-input`, maxLength 120) that saves on blur and Enter, Esc cancels. The same pattern for the kind
  (`knowledge-kind-input`, a text `Input` with a `datalist` of kinds in use; saved normalised, refused values shown as
  a field error), the aliases (`knowledge-aliases-input`, comma-separated, at most 10) and the summary
  (`knowledge-summary-input`, `Textarea`, 3 rows, grows to 8). Badges after the name: kind, "Agent" (origin), "Retired".
- A note shows title, the excerpt as plain text and "Edit note" (`knowledge-note-edit`) opening the note dialog
  (section 4); no inline fields.

Sections (each an `h3`):
- **Facts** (`knowledge-facts`): one row per fact (`knowledge-fact[data-id][data-retired]`): an `Input`
  (`knowledge-fact-input`, label "Fact N") following the `PerProjectValues` pattern (save on blur and Enter, a
  quiet "Saved" status per row through the pane's one status, Esc restores the text), a per-row `IconButton` "More
  actions for fact N" (`knowledge-fact-more`) with Retire / Restore and Remove. Retired facts show only with "Show
  retired" and carry the "Retired" badge and a muted field. "Add a fact" (`knowledge-fact-add`, secondary) appends an
  empty input with focus; an empty new fact on blur is dropped silently. Saving sends the full `facts` list with ids
  (an id keeps the fact's source; no id = a new user fact).
- **Related** (`knowledge-related`): one row per edge from `relatedRows` (`knowledge-relation[data-id]`): the
  text reads "works at **Acme Corp**" (outgoing) or "**Migrate billing to Stripe** decided by" (incoming) where the
  neighbour's name is a `button.link-btn` (`knowledge-relation-link`) that selects that item (the list scrolls to it,
  the pane shows it, focus stays on the link's replacement in the new pane: its heading). The edge note is a quiet
  line under it. A per-row "More actions" `IconButton` (`knowledge-relation-more`): Retire / Restore, Remove
  (ConfirmDialog "Remove this relation?" / "Agents and you can no longer see it." / "Remove"). "Add a relation"
  (`knowledge-relation-add`, secondary) opens an inline form: a search `Input` (`knowledge-relation-search`, label
  "Item") over the other live nodes (name / alias substring, a `listbox` of at most 8 matches under it, Up / Down /
  Enter pick), a text `Input` "Relation" (`knowledge-relation-text`, `datalist` of relations in use, placeholder
  "works at"), a `SegmentedControl` "Direction" (`knowledge-relation-direction`: "This item → other" / "Other → this
  item"), Save (`knowledge-relation-save`) and Cancel. Saved through `saveEdge` with the relation normalised.
- **Notes** (`knowledge-notes`, nodes only): the linked context notes (`noteIds`) as `button.link-btn` rows
  (`knowledge-note-link`) opening that note in the detail pane; "Link a note" (`knowledge-note-link-add`) opens a
  search over the notes by title; a per-row Unlink. Hidden when there are no notes to link.
- **History** (`knowledge-history`): the `historyLines` block, one `p` per line (`knowledge-history-line`): "Recorded
  by Analyst in R1 Summarise the kickoff, 4 Nov 2026 11:46" with the run as `button.link-btn`
  (`knowledge-history-run`, opens the run through `focusRun` / `openRun` as History's "Open" does), "Added by you,
  …", "Edited by you, …", "Changed by Analyst in R3 …", "Retired by …" (rec 15). Dates through `lib/dates.ts`.

Footer (`knowledge-detail-actions`): "Retire" / "Restore" (`knowledge-retire` / `knowledge-restore`, secondary, the
primary row action, rec 10) and "Delete…" (`knowledge-delete`, danger ghost). Delete asks `ConfirmDialog`
"Delete <name>?" / "Agents and you can no longer see it. Retire it instead to keep the record." / "Delete"
(`knowledge-delete-confirm` is the confirm button's testId). For a note: "Remove this note" wording stays ("Remove the
note <title>?" / "Agents can no longer read it. This cannot be undone." / "Remove note") as in engagement-2.

Rules:
- Agent items are read-only until the user activates an inline field ("Edit" is the field itself; rec 8); a save
  sets `updatedBy` on the main side and the History block gains "Edited by you". "Recorded by" is never overwritten.
- After any save: status "Saved <name>.", focus stays on the field (inline) or returns to the row (dialog).
- After Retire / Restore from the pane: status "Retired <name>." / "Restored <name>.", the selection moves to the
  next shown row (`idAfterRemoval`) when the retired row leaves the list (Show retired off), else stays; focus goes
  to that row. After Delete: the same, status "Deleted <name>."; with no rows left focus goes to "Add a note".
- A refused save (duplicate name, hidden characters, too long, the cap): the field gets `aria-invalid` and the
  message under it (`knowledge-field-error`, `role=alert`), focus stays; the stored value is kept in the list.
- Every write goes through the store-free `window.orgai.knowledge.*`; the view refetches on the push event, never
  from the write's result alone (so another writer's change is never lost).

## 4. Notes (rec 8, 11)

- Context notes are items in the same list ("Notes" group, origin filter, the "Agent" badge on the All view).
- Add / edit uses the existing dialog, moved out of `ContextNotesSection` into `components/knowledge/NoteDialog.tsx`
  (`context-note-dialog`, `context-note-title`, `context-note-text`, `context-note-save` keep their testIds; title
  "Add a note" / "Edit <title>"; the discard confirm; main's refusal as a field error). `saveNote` with `retired`
  untouched. After Save: status "Note saved.", focus to the note's row (new) or back to "Edit note" (edit).
- Retire / Restore for a note sets `retired` through `saveNote({ noteId, title, text, retired })` (the text is read
  with `getNote` first). Remove uses `removeNote` after the confirm above.

## 5. Graph view (rec 5, 17, 19)

`components/knowledge/KnowledgeGraph.tsx` (props `KnowledgeGraphProps`: `graph`, `filter`, `selectedId`,
`onSelect`, `onOpen`, `listDomId`, `detailDomId`, `announce`) renders in place of the list when the switch is "Graph".

- A React Flow canvas (`div.knowledge-graph[data-testid=knowledge-graph]`, the flow `aria-label="Knowledge graph"`),
  reusing `components/canvas/CanvasBackdrop`, `CanvasMinimap` (`ariaLabel="Knowledge graph minimap"`),
  `lib/canvas.ts` `useCanvasOptions` (pattern, edges, layout, node style, tint, minimap follow App settings > Canvas),
  `layoutCanvas` (dagre for top-down / left-right, `radialLayout` for radial with the selected item at the centre),
  `RadialEdge`, `useHandleRefresh`. Nodes carry `data-style` and the role-node sizes (card 220 x 96, compact 160 x 40,
  station, hex) so the four node styles and both themes come free; a kind takes its `kindColor` slot as `--role`.
- Toolbar above the canvas (`knowledge-graph-toolbar`, 32 px): "Skip to list" / "Skip to detail" links first
  (`knowledge-skip-list` / `knowledge-skip-detail`, visible on focus like the app's skip links; they focus
  `listDomId` / `detailDomId`), a `SegmentedControl` "Depth" (`knowledge-graph-depth`: "1", "2"; default 1), a
  `Switch` "Show all" (`knowledge-graph-all`), zoom in / out / fit `IconButton`s, and the legend `Popover`
  (`knowledge-graph-legend`): kinds in use with their colour swatch and label, then relation types in use
  ("works at" …) with the line sample, then "Retired" (dashed, muted) and "N retired" group.
- What is drawn: without "Show all", the neighbourhood of the selected node (`neighbourhood(graph, id, depth)`: the
  node, its live neighbours within `depth` edges, their edges) after the list's filter (`applyFilter` on nodes; a
  filtered-out neighbour is not drawn, its edge neither). With no selected node (nothing selected, or a note
  selected): the quiet message `knowledge-graph-empty` "Select an item in the list to see its relations." plus a
  "Show all" button. "Show all" draws every filtered node; past 150 nodes it first shows `knowledge-graph-warn`
  ("Showing all 420 items may be slow and hard to read. Show them anyway?" with "Show all" / "Keep the neighbourhood")
  and draws nothing until confirmed.
- Retired folding (rec 5c): retired neighbours (and retired edges' far ends) are not drawn one by one; per drawn node
  the retired items hanging off it fold into one node "N retired" (`knowledge-retired-group[data-count]`, the
  `done-group` look, a chevron that expands them for this session). With "Show retired" on, retired nodes draw as
  nodes with a muted fill and the "Retired" word in their label, and retired edges are dashed.
- Edges: `edgeStroke` of the from-node's kind colour; the relation as the edge label (`keyWords`, hyphens as spaces)
  rendered only at zoom >= 1 (a `label` with `labelShowBg`, hidden by a class under zoom 1 through `useViewport`),
  else in the edge's `title` (the SVG `<title>` through a custom edge wrapper) and in both nodes' spoken names.
  Edges are not focusable.
- Nodes: `components/knowledge/KnowledgeGraphNode.tsx` (type `knowledge`): the name, the kind label, the fact and
  relation counts ("3 facts · 2 relations"), the "Retired" word when retired. Every node is a Tab stop in **list
  order** (`orderItems` of the drawn nodes; React Flow's `tabIndex` on the node wrapper, `nodesFocusable`) with the
  spoken name `aria-label` "Jane Doe, person. 3 facts, 2 relations. Press Enter to open." (retired: "…, retired.").
  Enter opens the detail (`onOpen`), Space selects (`onSelect`); a click selects; a double click opens. Ctrl+Arrow
  follows an edge to the nearest neighbour in that direction (optional; if not built, say so in the notes).
- Selection: `selectedId` from props; selecting in the graph calls `onSelect`; the list keeps the same selection when
  the view switches back. The selected node has the canvas's selection cue (4 px leading bar / 3 px border).
- Motion: under `data-reduce-motion="on"` or `prefers-reduced-motion`, `fitView` duration 0 and no layout transition
  (rec 19). Layout changes (depth, filter, selection) re-fit once.
- Sizes: at 1024x640 the canvas is at least 480 px wide with the filter column; the toolbar wraps to two rows under
  600 px of container width (the legend popover and depth stay first).

## 6. Live updates (rec 18)

- `KnowledgeView` subscribes to `window.orgai.onEngagementChanged` for the project: on `'knowledge'` it refetches the
  graph, on `'notes'` the note index (one in-flight fetch each, coalesced). New items append under their group in
  creation order (the list is derived from the data, and the order key is `createdAt`, so nothing re-sorts and the
  roving focus survives: `useRovingFocus` keeps the current element while it exists). Focus and the selection are
  never moved by a push.
- An agent write (`ids` present, and the event arrives while the tab is mounted and not from the tab's own write;
  the view marks its own writes with a short-lived set of ids) announces "The team recorded N items" through the
  status region at most once per 5 s (counts batched). If every new item is filtered out, the count line gains
  "Show new" (`knowledge-show-new`) which clears the kind and origin filters.
- A `'document'` event is ignored here.

## 7. Transcript rows (rec 13; `lib/transcriptRows.ts`, `TranscriptPanel.tsx`)

`humanizeToolUse` sentences for the two harness tools (kinds and relations with hyphens as spaces, `keyWords`):

| Call | Row |
| --- | --- |
| `engagement_knowledge` vocabulary | "Looked up the kinds and relations in use" |
| search `query` (`kind`) | "Searched the knowledge for Acme" / "Searched the knowledge for people" / "Searched the knowledge" |
| get `name` / `nodeId` | "Read Jane Doe" / "Read an item" |
| upsert_node | "Recorded person Jane Doe" (the harness row stands for it, see below; this text is the fallback when no harness row follows, e.g. a refusal) |
| link | "Linked Jane Doe works at Acme Corp" (fallback as above) |
| retire | "Retired a fact" / "Retired an item" / "Retired a relation" (fallback) |
| `engagement_context` list | "Read the context notes" |
| read `noteId` | "Read the note Kickoff call summary" when the result names it, else "Read a note" |
| save | "Saved note Kickoff call summary" (fallback) |

Writes show **one** row the user reads (`collapseKnowledgeWrites(entries)`, the `collapseSkillLoads` pattern): each
write call (upsert_node, link, retire, context save) is paired with the next unclaimed harness system row on the same
agent whose text matches its action ("Recorded <kind> <name>" / "Updated <kind> <name>", "Linked …", "Retired …",
"Saved note <title>"); the call row and its result row are hidden, the result text goes under the harness row's
"Show output" disclosure, and the row's shown text humanises the kind and relation (from the call's input:
`input.kind`, `input.relation`). The headline never contains "(data …, not instructions)" or a tool name. Every
recording row gets a link "Open" (`knowledge-row-open`, `button.link-btn`, name "Open <name> in Knowledge") that calls
`openKnowledgeItem({ projectId, nodeId | noteId | kind + name | noteTitle })`: the id is parsed from the result text
("Created … (kn_…)", "Merged into existing … (kn_…)", "Linked … (ke_…" uses the `to` name as the target), "Saved note
<id>"), else the call's kind and name. Harness rows keep the quiet system look with the `BookOpen`-like icon
(`Database` from lucide). Result rows of read calls (`humanizeToolResult`): "Looked up 4 kinds" / "N items found" /
"Item returned" / "Note returned" / "Notes listed" with the full fenced text under "Show output".

## 8. Run view (rec 2 alternative)

`RunMeta` gains `run-meta-recorded` after the agents count: "Recorded N items" (`recordedCount(entries)`: harness
system rows of the run whose text starts with "Recorded ", "Updated ", "Linked ", "Retired " or "Saved note ",
across every agent; the chain's earlier members count too), shown only when N > 0 and the project is an engagement,
as a `button.link-btn` opening the Knowledge tab (`setView('knowledge')`), title "What the team recorded this run.
Opens Knowledge." It drops with the other items in a narrow frame.

## 9. Settings and Maintenance (rec 3, 10)

- Project settings > General > **Context notes** keeps its id, title and description (description now: "Background the
  team can look up when it needs it: meeting notes, client preferences, terms. Agents read and write these notes; do
  not put passwords or keys here.") and shows one line `knowledge-summary` (`knowledgeSummaryLine(graph, notes)`:
  "12 notes, 40 facts, 8 people" / "Nothing recorded yet") followed by " · " and `button.link-btn` "Open Knowledge"
  (`knowledge-open`, `setView('knowledge')`). The inline list, "Add a note", the dialog, `context-note-row`,
  `context-note-add`, `context-notes-empty` and `context-notes-status` leave this section (e2e/engagement2.mjs drives
  the note dialog from the Knowledge tab instead). The line refetches on `onEngagementChanged` ('notes' /
  'knowledge').
- Maintenance danger zone (engagements): a second button "Clear everything…" (`knowledge-clear`, danger, next to
  "Forget this engagement…") with `ConfirmDialog` "Clear everything the team recorded?" / "Deletes 12 items, 40 facts,
  8 relations (`clearCountsLine`). Context notes stay. Agents and you can no longer see them. Retire items on the
  Knowledge tab to keep records instead." / "Clear everything" (`knowledge-clear-confirm`). Calls `knowledge.clear`;
  the section's notice reads "Cleared everything the team recorded." The danger-zone text adds "what the team
  recorded".
- The forget confirm (`forgetConfirmText`) lists "N recorded items" from `ProjectRemoveResult.knowledgeRemoved`, and
  `forgetNoticeText` adds "N recorded items".

## 10. Dates (rec 15, L1)

`lib/dates.ts` `formatDate` ("4 Nov 2026"), `formatDateTime` ("4 Nov 2026 11:46"), `formatFullDateTime` (titles).
`planRevisedLine`, `noteEditedLabel`, `planDateLabel`, kit and template lines use it; the Knowledge tab uses nothing
else. The Maintenance "Architecture document" line and History are out of scope (listed as open).

## 11. Keyboard paths and sizes (rec 16, 17, 19)

- Tab order on the List view: topbar tabs → view switch → Add a note → Add an item → Search → kind chips (each a
  button) → origin chips → Show retired → the list (one stop) → the pane's Hide button → the pane's fields.
- Tab order on the Graph view: … → Show retired → Skip to list → Skip to detail → Depth → Show all → zoom → legend →
  the nodes in list order → the pane.
- In the list: Up / Down / Home / End, type-ahead, Enter opens, Shift+F10 more actions, Esc clears the search when
  it has focus. In the pane: Esc on the heading returns to the row; Esc in a field cancels the edit.
- Focus ring: the app's `:focus-visible` outline; a focused `role=option` row shows it on the row, and the graph node
  on the node wrapper (as the Live canvas does).
- Sizes: 1024x640 and 1600x1000, dark and light, no page scroll; the pane rail-collapsed at 1024 and opened by a
  selection; the filter column's chips wrap; a 120-character name ellipsises in the row and wraps in the pane.
- Contrast: kind colours are the role colour slots used only as a swatch and `--role` on canvas nodes (text never
  depends on them; badges carry words, rec 19).

## 12. Deviations from the UX walk

- rec 7 / 15 "Retired by <who>": the contract has no `retiredBy`; a retired node shows "Retired by <updatedBy>, <date>"
  because the store sets `updatedBy` on a retire (the last change of a retired node is its retirement), and a retired
  note shows "Retired" with no name (notes carry only a 'user' | 'agent' flag).
- rec 9 "Checked by you": no contract flag; not built.
- rec 10 "Retire all agent items from R3": no run-scoped Recorded list in this pass; not built.
- rec 17 Ctrl+Arrow between neighbours: optional in this pass (see Implementation notes for what landed).
- rec 1 `show-knowledge` menu item: a main-side contract; open.
- The e2e coverage is split over three scripts (`e2e/knowledge.mjs` list and detail, `e2e/knowledge-graph.mjs`,
  `e2e/knowledge-run.mjs` transcript / RunMeta / Settings / Maintenance), all in e2e:free, because three engineers
  built the surfaces in parallel.

## 13. Implementation notes

(Filled in by the engineers and the lead as the work lands: files, helpers, what was verified, what was not.)

### Run view, transcript, Settings and Maintenance (sections 7, 8, 9; UI Engineer 3)

- Files: `lib/transcriptRows.ts` (+ test), `lib/knowledgeRun.ts` (new, + test), `components/TranscriptPanel.tsx`,
  `components/RunMeta.tsx`, `components/settings/ContextNotesSection.tsx`, `components/settings/MaintenanceSection.tsx`,
  `lib/dashboard.ts` (+ test), `styles/run.css`, `styles/transcript.css`, `styles/settings.css`, `e2e/knowledge-run.mjs`.
- Transcript (section 7): `humanizeToolUse` gives `engagement_knowledge` and `engagement_context` calls (bare or
  `mcp__orgai__` names: the mock writes the bare name) the new `ToolKind` `'knowledge'` (lucide `Database`) and the
  sentences of the table; a search with only a kind reads "Searched the knowledge for people" through `kindGroupLabel`.
  `humanizeToolResult` labels their results ("Looked up N kinds" / "No kinds in use yet", "N items found" / "No items
  found", "Item returned" / "No such item", "Recorded", "Updated", "Linked", "Retired", "Already retired", "Notes
  listed" / "No context notes", "Note returned" / "No such note", "Saved note") with the fenced text under "Show
  output"; a "REFUSED: …" answer reads "Failed: <message>" in the error style (`ResultRow.failed`) although the call
  itself did not throw. `lib/knowledgeRun.ts` `collapseKnowledgeWrites(entries)` pairs each write call with the next
  unclaimed harness write row of the same agent whose text matches the action (any position after the call; RunManager
  writes the row during the call, so it sits between the call and its result), hides the call and its result, keeps
  the result as the row's body, and builds the row's `text` (`humanizeKnowledgeRow`: the kind token after "Recorded" /
  "Updated" / "Retired node" and the relation token of a "Linked" row, from the call's `relation`, else the one
  hyphenated token, as words; "Retired edge …" reads "Retired relation …"), `name` and `focus` (`KnowledgeFocus`: the
  `kn_` id from "Created … (kn_…)" / "Merged into existing … (kn_…)", else the call's normalised kind and the row's
  name; a link's `to` by id or name; a retired node by `nodeId`; a retired fact or relation by the entity whose earlier
  `get` result of the same agent listed that `kf_` / `ke_` id (first fenced line `kn_x | kind | name`), else no link;
  a saved note by the id in "Saved note <id> (<title>)", else the title). A refused or unchanged write ("REFUSED",
  "Already retired", "No knowledge graph", "No context notes", or an `isError` result) pairs with nothing, so it never
  steals a later write's row. Unclaimed write rows (older records, another agent's rows) still get a headline and a
  name-based link. `labels` gives a `get` by id and a note read their sentence from the result ("Read Acme Corp",
  "Read the note Kickoff call summary"). `TranscriptPanel` renders a paired row as `KnowledgeWriteRow`
  (`div.entry.system.harness.knowledge-row[data-testid=knowledge-row]`, `Database` icon, the plain headline, the
  `button.link-btn` "Open" `knowledge-row-open` named "Open <name> in Knowledge" that calls `openKnowledgeItem({ projectId,
  …focus })`, and "Show output"). `recordedCount(entries)` counts the harness write rows.
- RunMeta (section 8): `run-meta-recorded` is a `button.run-meta-item` "Recorded N items" after the agents count, title
  "What the team recorded this run. Opens Knowledge.", `setView('knowledge')`; N sums `recordedCount` over every chain
  member's transcript in the store (a zustand selector returning the number, so no re-render churn); engagements only,
  N > 0 only; it drops at a frame under 420 px like the other counts (run.css). It counts what the run did, not what is
  left: it stays "Recorded 8 items" after Clear everything.
- Settings (section 9): `ContextNotesSection` is the description plus one line `p.knowledge-summary-line`:
  `knowledge-summary` (`knowledgeSummaryLine(graph, notes)` from `knowledge.get` + `listNotes`, "Looking…" first, the
  newest request wins) " · " `knowledge-open` "Open Knowledge" (`setView('knowledge')`); refetched on
  `onEngagementChanged` 'notes' / 'knowledge'; a read error shows the danger Banner. The inline list, Add a note, the
  dialog, `context-note-*`, `context-notes-empty` and `context-notes-status` are gone from this file
  (`lib/engagementContext.ts` keeps `sortNotes` and the row labels for other callers; they are unused by Settings now).
- Maintenance (section 9): `knowledge-clear` "Clear everything…" (danger, next to Forget) reads the graph on mount and
  on every 'knowledge' push; it is natively disabled with the quiet reason `knowledge-clear-empty` "Nothing recorded
  yet." while the graph is empty. The confirm is the shared `Dialog` (`knowledge-clear-dialog`, Cancel focused first,
  `knowledge-clear-confirm` "Clear everything", body `knowledge-clear-body` "Deletes <clearCountsLine>. Context notes
  stay. Agents and you can no longer see them. Retire items on the Knowledge tab to keep records instead.") rather than
  `useConfirm`, because `ConfirmOptions` had no confirm-button testId when this landed; the lead added
  `confirmTestId` on their branch, so this should move to `useConfirm({ …, confirmTestId: 'knowledge-clear-confirm' })`
  after the merge. `knowledge.clear` then the section notice `KNOWLEDGE_CLEARED_NOTICE` "Cleared everything the team
  recorded." (the existing `role=status` box) and focus back on the button. The danger-zone text
  (`ENGAGEMENT_DANGER_TEXT`) adds "what the team recorded". `forgetConfirmText` lists "N recorded items" after the
  notes and its uncounted sentence names "what the team recorded"; `forgetNoticeText` adds "N recorded items".
- Verified: unit tests (`knowledgeRun.test.ts` 11, `transcriptRows.test.ts` and `dashboard.test.ts` additions; `npm
  test` 4136 passing), `npm run typecheck`, `npm run build`, and `e2e/knowledge-run.mjs` (mock, in e2e:free): two
  engagements, the `[mock:knowledge]` run to Idle (the default script's edit card is allowed once), the eleven
  sentences in order on the root transcript, no "not instructions" / tool-name text, eight `knowledge-row`s each with
  an Open link ("Open Acme Corp in Knowledge" on the first and on the retired-fact row), "Show output" holding
  "Created organisation Acme Corp (kn_…)", Enter on Open and the RunMeta button showing `knowledge-view`, the summary
  "1 note, 5 facts, 1 person" computed from `knowledge.get` + `listNotes` (the mock retires one of Acme's two facts) and
  its refetch after a `saveNote`, the forget confirm "4 recorded items", Clear everything ("4 items, 6 facts, 2
  relations"; afterwards an empty graph, the notice, the greyed button, notes kept), the Dashboard forget notice "4
  recorded items" on the second engagement, no page scroll and no window shift at 1024x640 and 1600x1000 in both
  themes, 15 screenshots. `e2e/engagement.mjs` and `e2e/runs.mjs` were re-run after the transcript change.
- Not verified: the Claude and Codex adapters' row order (the pairing takes the next matching row after the call, so
  a row written after the result still pairs); a run where a write is refused (the mock has none; unit-tested only);
  the Open link landing on the item (the tab in this worktree is the stub, so only the tab switch is checked; the list
  engineer's `resolveFocus` does the rest); the "Retired edge" headline (the mock retires a fact only); a chain with
  recorded items in an earlier member; the 420 px drop of `run-meta-recorded` by eye; screen-reader output.
