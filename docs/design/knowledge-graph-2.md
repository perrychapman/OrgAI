# Knowledge graph 2: the neural canvas, possible connections, knowledge during a run

Replaces `knowledge.md` section 5 (Graph view); its other sections stand unless changed here. Answers walk 3
(`ux-review-knowledge-3.md`) with the connections that passed evaluation (`knowledge-connections.md`). All contracts exist;
nothing on the main side changes. Visible words stay those of `knowledge.md`: item, fact, relation, note, kind, retired, recorded.

## 1. Neural canvas

### 1.1 Scope and what goes

`components/knowledge/KnowledgeNeural.tsx` replaces `KnowledgeGraph.tsx` under the "Graph" switch: same props plus
`inferred: KnowledgeInferredResult | null`, root `div[data-testid=knowledge-neural]`, no `@xyflow/react`.

**Its own look.** No cards, name pills, dagre, backdrops, node styles or layouts, and it reads no `useCanvasOptions`, `--canvas-*` or
`data-canvas-*`. App settings > General > Canvas does not apply to it. That section, `CanvasBackdrop`, `CanvasMinimap`, `layoutCanvas`,
`RadialEdge`, `useHandleRefresh`, `lib/canvas*` and `e2e/canvas.mjs` still hold for the Live, Team and sample canvases.

**Removed:** `KnowledgeGraph.tsx`, `KnowledgeGraphNode.tsx`, `KnowledgeGraphEdge.tsx`, `KnowledgeGraphLegend.tsx`,
`KnowledgeRetiredGroupNode.tsx`, `styles/knowledge-graph.css`, their helpers in `lib/knowledgeGraph.ts`, testids `knowledge-graph`, `-toolbar`,
`-depth`, `-all`, `-empty`, `-warn`, `-legend` (all `knowledge-graph-*`) and `knowledge-retired-group`. No depth control, no Show all, no "N retired"
groups: the whole graph is always drawn, and hover and selection do what depth did. `KnowledgeView.focusGraphNode` stops using `.react-flow__node`.

### 1.2 Page layout in Graph view (decision: a chip band)

The filter column becomes a band above the canvas at every size; List view keeps the column. Same `KnowledgeFilters` and state,
`knowledge-filters[data-layout=band|column]`. Grid areas in Graph view: `'toolbar toolbar' 'filters side' 'main side'`. "Show", "Kind" and "Recorded by" go sr-only.

| Band width | Row 1 | Row 2 |
| --- | --- | --- |
| 720 px or more | Search (200 px), You, Agents, Show retired, Inferred links, spacer, count line and Show new | Kind chips, wrapping, at most 2 rows (64 px), then scrolling inside |
| Under 720 px | Search (flex), `knowledge-filters-more`, count line and Show new | The same |

- `knowledge-filters-more`: `Button` "More filters" ("More filters, 2 on" when set), a `Popover` with You, Agents, Show retired, Inferred links.
- Chips gain `knowledge-kind-mark` (10 px, the mark of 1.4) in both layouts; Notes uses a `--text-tertiary` dot in the column and is left out of the band (notes are not drawn). The count line counts nodes only in Graph view.
- Stage with the rail sidebar and one chip row: **1024x640** about 928 x 430, 608 x 430 with the panel open (walk: 408 wide). **1600x1000** about 1368 x 820, 1008 x 820 with the panel. `autoCollapseBelow={1100}` stays, so at 1024 the panel starts as its rail and a click opens it. No page scroll.

### 1.3 Layout

`lib/knowledgeNeural.ts`, pure, no dependency, unit-tested: `initLayout`, `stepLayout`, `placeNew`, `neuralRadius`, `kindMark`, `lodFor`, `pickLabels`, `spatialTarget`, `cardPlacement`.

- **Seeded force layout.** Start: a phyllotaxis spiral in `orderItems` order; all random draws from a PRNG seeded with the project id. Same graph = same positions.
- **Forces.** Repulsion -220 per node (Barnes-Hut, theta 0.9, above 200 nodes), link length `70 + ra + rb`, collision `ra + rb + 10`, gravity 0.04 up to 400 nodes and `0.04 * n / 400` above, at most 0.2 (the cloud's radius is about `sqrt(220 n / gravity)`, so the base value left 2,000 nodes 6,600 units wide and fit at its floor), velocity decay 0.6.
- **Cools and stops.** Alpha 1, decay 0.02, stop under 0.02 or at 300 ticks (`data-settled=true`). Ticks run in slices of at most 8 ms per frame, so settling is visible.
- **Positions survive**, per project, in memory and in localStorage `orgai.knowledgeLayout.<pid>` (ids and whole-number coordinates only, written when settled; junk ignored). A stored layout starts settled. Filter and selection never affect layout.
- **A new node** starts at its neighbours' centroid plus a seeded 24-unit offset (no neighbours: the layout's rim) and gets 60 ticks with every other node pinned. Removing or retiring a node moves nothing.
- **View.** Wheel zooms at the pointer (0.15-3), drag pans (under 4 px is a click), fit uses 48 px padding and zoom 1.4 at most. Up to 300 drawn nodes a fit shows them all; above that it fits the dense core, the middle 95% of the x and y distributions, so a few far outliers sit off the stage instead of shrinking everything. It auto-fits during the first settle until the user pans or zooms.
- **Resizes.** The view is "the user's" from a pan, a wheel zoom or a zoom key or button until Fit to view hands it back (`data-user-view`). **A window resize** (the window's size changed; stage changes within 300 ms of the last one belong to it, since the panel, sidebar and band fold frames later): untouched, the view refits; the user's, a shrink scales the view with the stage and keeps the world point at the centre, so the same part of the graph stays on the stage, and a grow keeps the zoom. **A panel opening or closing, a notice, the band rewrapping** move nothing (`offsetView` holds nodes in place in the window). A selected node within 48 px of the new edge pans the minimum in every case.

### 1.4 Look

Canvas for field and synapses, canvas above for pulses; nodes and labels are the engineer's choice if this look holds. Resolve kind colours through a probe element's computed `color`, again on a `data-theme` change.

| Part | Dark | Light |
| --- | --- | --- |
| Field | `--neural-field`, soft central wash of `--neural-field-glow`, no pattern | The same tokens |
| Node | Glowing soma: kind colour, lighter core, soft halo to 2.4 r, `--neural-composite` (`lighter`) | Inked disc, 1 px darker outline, soft lighter nucleus (0.42 r, opacity 0.5), tinted halo to 2.2 r, `source-over`, never additive |
| Synapse | 1 px curve, seeded bend up to 8% of its length, `--neural-synapse` at `--neural-synapse-opacity` | The same tokens |
| Active synapse | 1.5 px `--neural-synapse-active`, opacity 0.9 | The same |
| Name | 12 px `--text-primary`, 3 px `--neural-field` text stroke, never scaled with zoom | The same |
| Pulse | 3 px `--neural-pulse` dot, 18 px fading tail | The same |

Node colour: `color-mix(in srgb, <slot> var(--neural-node-mix), var(--neural-node-ink))`. Targets, **to be measured on the running app and recorded here**: name on field 4.5:1, every node colour to field 3:1, both themes. A failing pair changes through the token.

**Size.** `r = 6 + 28 * log2(1 + total) / log2(1 + max(maxTotal, 16))`, world px at zoom 1, `total = appearances[id].total`, `maxTotal` over drawn nodes. Floor 6, ceiling 34. Top total 16: 0 -> 6, 1 -> 13, 4 -> 22, 9 -> 29, 16 -> 34. Top total 1,500: 1 -> 9, 5 -> 13, 50 -> 21. Changes ease over 300 ms. Without `appearances`, `total` is the node's live edges.

On screen (`screenRadius(r, k)`): below zoom 1, `max(r * k, 3 + 9 * ((r - 6) / 28) ^ 1.5)`, so at any low zoom a leaf is about 3 px and the largest node 12 px and size still reads. Above zoom 1, `r * (1 + (k - 1) * 0.35)`, so zooming in opens the gaps between nodes and their synapses instead of filling the stage with discs. Hit radius and the option's DOM box follow it.

**Colour by kind.** `kindColor` stops depending on `kindsInUse`, so a new kind never recolours another; new `kindMark(kind)`. Slots index `ROLE_COLORS`. Eight colours cannot cover the kinds, so the shape is part of the key. Slot 6 is unused (nearly slot 1).

| Kind | Slot | Mark | Kind | Slot | Mark |
| --- | --- | --- | --- | --- | --- |
| person | 0 | solid | risk | 4 | solid |
| organisation | 1 | solid | requirement | 5 | solid |
| system | 2 | solid | deadline | 3 | ring |
| document | 7 | solid | meeting | 0 | ring |
| decision | 3 | solid | open-question | 4 | ring |

Free-form kinds: stable hash of the key over slots 0-5 and 7, mark `ring-dot`; two may share a mark and the legend and card name them. `ring`: stroke `max(2, r * 0.28)` over the field. `ring-dot`: the ring plus a 0.35 r disc. Colour is never the only signal: card, spoken name, chips and legend say the kind.

**Level of detail** (`lodFor`, `data-lod`). The active node and its neighbours always draw in full. Target at 2,000 nodes and 5,000 edges: no frame over 50 ms, measured and reported.

| Tier | Nodes | Halos | Synapses | Drift | Ambient pulses | Frame cap |
| --- | --- | --- | --- | --- | --- | --- |
| `full` | up to 300 | all | curved | all | 12 at once | 30 fps |
| `medium` | 301-800 | top 100 by size | straight | top 100 | 8 | 30 fps |
| `low` | 801-2,000 | top 24 by size | straight, one batched path, opacity 0.2 | none | 4 | 20 fps |

**Names at rest** (`pickLabels`): `N = clamp(floor(stage area / 40,000), 4, 28)`, about 10 at 1024x640 and 28 at 1600x1000; 60 at zoom 1.6 or above. Take nodes by `total` descending, then creation order; the name goes below the node, else above, right, left, the first place whose box plus 4 px hits no placed name and no larger undimmed node; cut to 24 characters with an ellipsis. Recomputed 150 ms after pan or zoom stops. The selected node and up to 12 active neighbours by size go first.

**Names with a filter or search** (`LABELS_LIT`): the lit items go first, largest first, up to 40 names however small the stage (60 at zoom 1.6 or above). Dimmed nodes never block a name. A name with no free place of the four stays off until hover or zoom, so a filter of 196 risks names 40 and a filter of 4 names all 4 (`data-named-lit`).

**Emphasis, strongest first:**

| State | Target | Neighbours | Second hop | The rest |
| --- | --- | --- | --- | --- |
| Hover or keyboard focus | Full, name | Full, names, active synapses | 0.6, no names | `--neural-dim-opacity` |
| Selected | Full, selection ring | Full, names | 0.75 | 0.55 |
| Search | Matches full, name, 2 px ring | | | `--neural-dim-opacity` |
| Kind or origin filter | Kept nodes normal | | | `--neural-dim-opacity` |

Filtered-out nodes dim and never move, as do their synapses; they are not hit-tested and arrows skip them. Filter and search are the list's (`applyFilter`, `searchRank`), shared state. Selection ring: solid 2 px in the node colour, 3 px off the disc. Focus cue: 2 px `--focus-ring` DOM outline, 4 px off the disc. Both may show and they read differently (walk L3).

**Relation words** draw at 12 px mid-curve on the active node's recorded synapses at zoom 1 or more with at most 8 active synapses; otherwise the card and detail carry them. **Retired** items are hidden unless Show retired is on; then opacity 0.45 with a dashed 1 px ring and faint solid synapses. Dashes on synapses belong to inferred links alone.

**Stage controls.** Bottom right `knowledge-neural-zoom-out`, `-zoom-in`, `-fit` (`IconButton` "Zoom out", "Zoom in", "Fit to view"). Bottom left the quiet line `knowledge-neural-size-note` "Bigger means it comes up more often." (popover only under 480 px of stage) and `knowledge-neural-legend-trigger` "Legend", a `Popover` `knowledge-neural-legend`: kinds in use with mark and label (`knowledge-neural-legend-kind[data-kind]`), "Line: a recorded relation", "Dotted line: an inferred link, found by matching names in text; it may be wrong", "Faded with a dashed ring: retired", "Flash: an agent just used this item".

### 1.5 Hover, click, live

**Card** `knowledge-neural-card[data-id]`: `aria-hidden` (the spoken name says the same), `pointer-events: none`, 280 px wide, at most 240 px high, `--surface-2`, `--elev-2`, `--radius-md`.

1. Name, 14 px semibold, at most 2 lines. Then mark and `kindLabel` (", retired" when retired).
2. Excerpt: the summary, else the first live fact, at most 3 lines.
3. `knowledge-neural-card-count`: "Comes up 14 times: 9 relations, 4 mentions, 1 note." Zero parts left out; "Comes up once: 1 relation."; total 0 "Not connected to anything yet."
4. Top 3 relations by neighbour total: outgoing "works at Acme Corp", incoming "Jane Doe works at this", then "and 6 more relations".
5. `knowledge-neural-card-shared`, at most one line (2.3).

- **Placement** (`cardPlacement`): right of the node with a 12 px gap, then left, below, above; 8 px inside the stage; never covers the disc.
- **Timing:** appears 60 ms after landing, 80 ms fade. Moving to another node while shown switches at once with no fade. The current node holds until the pointer is over `r + 6` px away and on another node. Hit radius `max(r, 8)` screen px. Hides 120 ms after leaving, at once on pan or wheel.
- **Click on a node:** selects it and opens the existing detail `SidePanel`. Nothing re-roots, re-lays or refits. Focus goes to the node's DOM element (`openItem` gains `{ focus: false }`); only Enter sends it to the heading. A double click does the same.
- **Panel opening, notices:** the stage changes size and every node keeps its screen position. Only a selected node within 48 px of the new edge pans the view, the minimum needed, over 200 ms. A window resize is different (1.3).
- **Activation spread:** from the selected node pulses run along up to 12 recorded synapses (largest neighbours); on arrival each neighbour flashes and sends one pulse on, 12 more at most, about 900 ms in all.
- **Empty space click** clears the selection (`knowledge-detail-empty` in the panel). A selected item off-stage (list, deep link) pans into view over 300 ms. A note selected in the list selects no node.
- **`onEngagementChanged` 'knowledge':** refetch graph and `inferredLinks`. A new node scales in over 400 ms and fires; a removed one fades over 200 ms. Selection and focus never move. `knowledge.md` section 6 announcements stand.
- **`knowledge.recalled`** for a run of this project: the nodes fire, 'recall' and 'auto' alike, newest 12 ids, one burst per 2 s per run (later ids merge), no announcement.
- **Fire:** a ring grows from r to r + 14 px and fades over 900 ms, with up to 3 pulses along its synapses.

### 1.6 Motion

- **Drift:** up to 2.5 px on screen, period 11-19 s, seeded phase; drawn only, the stored position and hit test do not drift.
- **Ambient pulses:** one every 1,400 ms up to the tier's limit, along a recorded live synapse (seeded PRNG, weighted to larger nodes), lasting 1,400-2,200 ms by length.
- **The loop stops** (`data-animating=false`, no pending frame) in List view or another tab, when `document.visibilityState` is hidden, at zero stage size and under reduced motion. A blurred but visible window stops drift and ambient pulses; live fires still draw, then it stops again.
- **Reduced motion** (`useReducedMotion`: `data-reduce-motion` and the OS, live): static layout, no pulses, drift, spread, eases or fades. The layout computes off-screen behind `knowledge-neural-arranging` "Arranging the graph…" (past 200 ms). Frames draw only on a change. A fire is a static 2 px ring for 2 s and still counts in `data-fired`. Selection, focus and emphasis look the same.

### 1.7 Untrusted text

Names, kinds, summaries, facts, relations and evidence are user- or agent-written. React text or canvas `fillText` only, no HTML; no selector, RegExp or style value built from them. `data-id` and `data-kind` are written only after `KNOWLEDGE_ID_RE` / `KNOWLEDGE_KEY_RE` checks. Strip control, bidi and zero-width characters through `lib/hiddenChars.ts` wherever drawn.

### 1.8 Keyboard and screen readers

One Tab stop: `ul[role=listbox][aria-label="Knowledge graph"]` (`knowledge-neural-nodes`) with a roving `tabindex`. Options `li[role=option][data-testid=knowledge-node]` sit transparent over their node, `pointer-events: none`; the parent carries the view transform. Up to 300 drawn nodes all render; above that the focused, selected and active nodes, their neighbours and the 50 largest. Attributes: `data-id`, `data-kind`, `data-color` (slot hex), `data-mark`, `data-radius`, `data-total`, `data-x`, `data-y` (world), `data-active`, `data-dim`, `data-selected`, `data-retired`, `data-fired`, `aria-selected`; dimmed nodes `aria-disabled`.

Spoken name: "Acme Corp, organisation. Comes up 14 times: 9 relations, 4 mentions, 1 note. Top relations: Jane Doe works at this, owns Billing platform. Press Enter to open." Retired adds ", retired" after the kind. List view stays the full non-visual equivalent. Focus lands on the last focused node, else the selected, else the largest; the view pans to keep the focused node 48 px inside the stage, and keyboard focus shows the card.

| Keys | Action |
| --- | --- |
| Arrows | `spatialTarget`: nearest kept node inside a 90-degree cone. None = no move |
| Ctrl/Cmd + Arrow | The same among recorded neighbours; an empty cone takes the nearest neighbour by angle, so a hub works in all four directions (walk M5) |
| Home / End | Largest / smallest kept node |
| Letters | Type-ahead on names, 500 ms, largest match first |
| Space / Enter | Select / open the detail with focus on `#knowledge-detail-heading` |
| + or = / - / 0 | Zoom in / zoom out / fit |
| Esc | First hides the card, then clears the selection; focus stays on the node |
| Esc on the detail heading | Back to `knowledge-node[data-id]`; if filtered out, the entry rule above |
| Tab order | Band controls, `knowledge-skip-list`, `knowledge-skip-detail`, graph, zoom out, in, fit, Legend, panel |
| Filter by kind | Tab to the chip; Space or Enter toggles it (`aria-pressed`) |
| Possible connections | Tab through the panel: word, Confirm, Dismiss |
| Run side tab | Tab to `side-tab-knowledge`, Tab to search, type, Down, arrows, Enter; Esc goes back |

Skip controls stay clipped until focused. `knowledge-skip-list` reads "Show as list": it switches the view and focuses the selected or first row (the list is not on screen, so a plain skip has no target). `knowledge-skip-detail` "Skip to detail" focuses the heading, or the rail's Show button while the panel is a rail (fixes L8). `knowledge-status` stays the only live region. Forced colours: nodes `CanvasText`, focus outline `Highlight`.

### 1.9 Testable state

Root `knowledge-neural`: `data-drawn`, `data-edges`, `data-lit` (not dimmed), `data-lod`, `data-settled`, `data-animating` (`true|false`), `data-frames` (written at most every 10 frames and when the loop stops), `data-fired` (since mount), `data-fired-ids` (newest 12, comma-separated), `data-inferred` (inferred lines drawn), `data-zoom` (2 decimals), `data-user-view` (the user has panned or zoomed since the last fit), `data-named` and `data-named-lit` (names placed, and those on lit nodes). e2e reads no pixels and asserts: `data-radius` follows `data-total`; `data-color` + `data-mark` per kind; `[mock:knowledge-recall]` raises `data-fired` and names the ids; reduced motion, a hidden tab and List view give `data-animating=false` with `data-frames` constant over 500 ms; `data-x` / `data-y` unchanged after a save, click, filter and panel opening, and `data-zoom` unchanged after a click.

## 2. Connections

### 2.1 Canvas

Inferred links are suggestions, never facts. 'mention' and 'same-name' look alike: straight line of round 1.75 px dots 5 px apart, `--neural-synapse-inferred`, opacity 0.95, no pulses, no spread, not hit-testable, not neighbours for emphasis or Ctrl+Arrow. Drawn for the hovered, focused or selected node, or for every kept pair with `knowledge-inferred-links` on (`Switch` "Inferred links", default off, `orgai.knowledgeInferred.<pid>`; status "Showing N inferred links."). Rejected kinds (shared notes, same organisation, same run) are never drawn. Recorded relation words stay in their normal form.

### 2.2 Detail panel: Possible connections

`knowledge-possible`, `h3` "Possible connections", directly under Related, on live items with a link; never on notes or retired items. Quiet line: "OrgAI found these by matching names in the text. They may be wrong." Five rows by `strength`, then `knowledge-possible-more` "Show N more". Row `knowledge-possible-row[data-link][data-basis]`:

- **Why** (`knowledge-possible-why`). Evidence is shaped `Fact: "..."` / `Summary: "..."`; a pure `linkWhy` strips the label. This item is `from`: **Other** (a link selecting it, like `knowledge-relation-link`), "Named in a fact: <snippet>" / "Named in the summary: <snippet>". This item is `to`: **Other**, "Names this in a fact: <snippet>" / "Names this in its summary: <snippet>". Same-name: "Same name as **Other**: might be the same thing", evidence not shown.
- **Statement.** Always `from` then `to`, since for a mention `from` names `to`: "<from name> [word] <to name>". `[word]` is `knowledge-possible-word` (`Input`, label "Relation", `datalist` of relations in use, value `keyWords(suggestedRelation)` or blank, placeholder "How they relate": an instruction, because a relation word as a placeholder read as a suggestion for a pair OrgAI has none for). Same-name reads the same with the smaller id first.
- **Confirm** (`knowledge-possible-confirm`, secondary) stays enabled. A blank word on submit: `knowledge-possible-error` "Add a word for how they relate, such as works at." with `aria-invalid`, `aria-describedby` and focus on the word; main's refusals show there too. Valid: `normalizeKnowledgeKey`, `writes.saveEdge({ from: link.from, to: link.to, relation })`, then an ordinary relation under Related. Status "Linked Jane Doe works at Acme Corp." Focus: next row's Confirm, else `knowledge-relation-add`.
- **Dismiss** (`knowledge-possible-dismiss`, ghost, name "Dismiss the possible connection with <Other>"): `knowledge.dismissLink`, whose result replaces the state. Status "Dismissed." Same focus rule. No undo in the contract, no merge action.
- Refetch on every 'knowledge' push. Read failure: the canvas sizes from edges and the section shows `knowledge-possible-error-load` "Could not check for possible connections." with Retry.

### 2.3 The walk's "two people at one organisation"

No edge and no suggestion: it reads through the shared neighbour. Hovering Jane Doe lights Acme Corp in full and every other Acme person at 0.6, with their synapses at 0.5. `knowledge-neural-card-shared` takes the largest neighbour reached through a recorded relation another item shares in the same direction: "Also works at Acme Corp: Tom Okafor, Mara Lindqvist and 6 more." Computed on read, never stored, absent when nothing is shared.

## 3. Knowledge during a run

### 3.1 Side tab

`SideTab` adds `'knowledge'`: tab "Knowledge" (`side-tab-knowledge`) before Logs, on work runs of engagement projects (Ask runs too; not setup runs or assistants). Check it fits 280 px; `Tabs` scrolls otherwise. Run-wide: selecting an agent does not change it. Query and open item survive a tab switch (store, keyed by chain). Reads `knowledge.get` and searches in the renderer: no model call, read only. Refetches on 'knowledge' pushes while shown, one in flight. Panel `run-knowledge`, with its own sr-only `run-knowledge-status`:

1. **Search** `run-knowledge-search` (`Input`, label "Search what the team knows", placeholder "Name, fact or alias", 150 ms debounce, Esc clears and keeps focus).
2. **Results**, while there is a query, `run-knowledge-results`: `searchKnowledge(graph, { query, limit: 20 })`, one `useRovingFocus` Tab stop, Down from search enters. Row `button` `run-knowledge-result[data-id][data-kind]`: mark (kind colour), name, `kindLabel`, one-line `itemExcerpt`. At 20: "Showing the first 20. Search for more of the name." None: "Nothing recorded matches <query>." Status: "3 items found."
3. **Recalled**, with no query, `run-knowledge-recalled`, `h3` "Recalled in this run", caption "What agents looked up or were given." Rows `run-knowledge-recalled-row[data-id]`, same look plus "Given 3 times" / "Given once": one per item, newest first, counted over the chain's `knowledge.recalled` events, at most 200, `via` not shown, ids gone from the graph dropped. Rows reorder live without moving focus. Empty: "Nothing recalled yet. Items agents look up or are given show here."
4. **Older runs.** The events are not saved in the run record, so after a relaunch the list is empty. Then the transcript's "Recalled ..." and "Added ... known ..." rows show as plain lines (`run-knowledge-recalled-line`) with `run-knowledge-recalled-note` "Item names here are kept only while OrgAI is open."
5. Last line, quiet: `run-knowledge-free` "Searching here does not call a model."

States: "Looking…"; "Could not read what the team recorded." with Retry; no nodes: "Nothing recorded yet. Agents add items here as they work." with no search box.

### 3.2 Compact detail

A row replaces the panel with `run-knowledge-detail[data-id]`, read only. `run-knowledge-back` (`Button` ghost, `ArrowLeft`, "Back"; Esc too) goes one step on a stack of up to 20 and returns focus to the row or link it came from. `h3` name (`tabIndex=-1`, takes focus), `kindLabel` and "Retired" badges, summary, "Facts" (live, a list), "Related" (`relatedRows`, the neighbour a `button.link-btn` opening it here), "Notes" (linked titles, plain text), the first `historyLines` line (plain text). Empty sections are left out. `run-knowledge-open-tab` "Open in Knowledge" calls `openKnowledgeItem` and leaves the run. An item that went away: "This item no longer exists." with Back.

### 3.3 Run-scoped windows (decision: the tab works there)

The window has the IPC and events, so search, Recalled and the compact detail work. The project's Knowledge tab cannot be reached there (`parseRunWindowHash`), so `run-knowledge-open-tab` becomes the quiet line `run-knowledge-window-note` "To edit this item, open Knowledge in the main OrgAI window."; `knowledge-row-open` opens this compact detail (an unresolved target opens the tab with its name as the query) and `run-meta-recorded` opens the side tab. The main window keeps today's behaviour for both.

### 3.4 Transcript

Extend `lib/knowledgeRun.ts`, keeping reads out of `recordedCount` and `recordedBreakdown`. A `knowledge_recall` call (bare or `mcp__orgai__`) pairs with the same agent's harness row "Recalled N items about <query>": call and result rows hide, the result goes under "Show output". Row `knowledge-read-row` (`Database` icon, the look of `knowledge-write-row`, no Open link). "Show output" reads in plain words (`recallOutputText`): no node ids, fence or note to the model. The same read row twice in a row by one agent is one row, "Recalled 4 items about Acme billing (2 times)"; the plain lines of 3.1 fold the same way. "Added N known items: ..." is the same quiet row with no output. A refusal pairs with nothing: `humanizeToolUse` "Looked up <query>", `humanizeToolResult` "Failed: <message>". No "not instructions" text or tool name in a headline.

### 3.5 Usage panel

In run scope after "Skills loaded", when `usage.knowledge` exists: `dl.usage-list` `usage-knowledge`, headed "Knowledge". Never "tokens saved".

| Label | Value | Testid |
| --- | --- | --- |
| Looked up by agents | `recalls`: "3 times" | `usage-knowledge-recalls` |
| Added automatically | `autoContexts`: "5 times" | `usage-knowledge-auto` |
| Items given to agents | `itemsServed` | `usage-knowledge-items` |
| Text given to agents | `charsServed`: "4,210 characters" | `usage-knowledge-chars` |

### 3.6 Project settings

`ContextNotesSection` (engagements), under the summary line: `SettingRow` + `Switch` `knowledge-auto-context`, "Add known items to what agents receive", note "When a message or brief names an item you added yourself, OrgAI adds a short note about it. This adds a little text to agents' messages." (main matches only user-created entities by stored name) Reads `knowledgeAutoContextOn(project)`. Off saves `false`; on removes the field (unset = on). Confirm `projects:save` passes the field; raise it if not.

## 4. States and sizes

Check all at 1024x640 and 1600x1000, dark and light, with no page scroll and no `windowShift`.

| State | What shows |
| --- | --- |
| Loading | `knowledge-loading` "Looking…", band present |
| First layout | Nodes settle in view; reduced motion `knowledge-neural-arranging` |
| Empty, no runs / after runs | The list's `knowledge-empty` / `knowledge-empty-runs`, same copy and buttons, no canvas |
| Only notes | `knowledge-neural-only-notes` "Only notes so far" / "Notes show in the list. Items the team records show here." with "Show as list" |
| Only retired, switch off | `knowledge-empty-retired`, same copy |
| One node | Centred, zoom 1.4 at most, name shown, drift only; arrows do nothing |
| All filtered out | Nodes dim in place; top centre of the stage `knowledge-neural-none` "No items match <query>." / "No items match these filters." with `knowledge-clear-filters`. Only Notes pressed (from List view): "Notes are not drawn in the graph." with "Show as list" |
| Nothing selected | The whole graph, `knowledge-detail-empty` in the panel; never a "select an item" canvas (H3) |
| Panel open at 1024x640 | Stage about 608 x 430, names 12 px, card flips to fit, no refit |
| Read error | `knowledge-error` Banner with Retry |
| Large graph | `medium` or `low` tier, same interactions |

## 5. New tokens

Add to every theme block of `tokens.css` (dark, light, system light). Plain values so the canvas can read them.

| Token | Dark | Light |
| --- | --- | --- |
| `--neural-field` | `#070a12` | `#f3f5fb` |
| `--neural-field-glow` | `#111830` | `#ffffff` |
| `--neural-synapse` | `#6d7ea8` | `#66718c` |
| `--neural-synapse-opacity` | `0.32` | `0.45` |
| `--neural-synapse-active` | `#c7d2ee` | `#2a3350` |
| `--neural-synapse-inferred` | `#c4cff0` | `#2f3a5c` |
| `--neural-pulse` | `#dfe7ff` | `#4f33d6` |
| `--neural-halo-opacity` | `0.35` | `0.3` |
| `--neural-composite` | `lighter` | `source-over` |
| `--neural-node-mix` | `88%` | `50%` |
| `--neural-node-ink` | `#e8ebf3` | `#12151f` |
| `--neural-dim-opacity` | `0.22` | `0.25` |

## 6. New testids

- `knowledge-neural`, plus (all `knowledge-neural-*`) `-nodes`, `-card`, `-card-count`, `-card-shared`, `-zoom-in`, `-zoom-out`, `-fit`, `-size-note`, `-legend`, `-legend-trigger`, `-legend-kind`, `-arranging`, `-only-notes`, `-none`. Kept: `knowledge-node`, `knowledge-skip-list`, `knowledge-skip-detail`.
- `knowledge-kind-mark`, `knowledge-filters-more`, `knowledge-inferred-links`, `knowledge-auto-context`, `knowledge-read-row`.
- `knowledge-possible`, plus (all `knowledge-possible-*`) `-more`, `-row`, `-why`, `-word`, `-confirm`, `-dismiss`, `-error`, `-error-load`.
- `side-tab-knowledge`, `run-knowledge`, plus (all `run-knowledge-*`) `-status`, `-search`, `-results`, `-result`, `-recalled`, `-recalled-row`, `-recalled-line`, `-recalled-note`, `-detail`, `-back`, `-open-tab`, `-window-note`, `-free`.
- `usage-knowledge`, plus `-recalls`, `-auto`, `-items`, `-chars`.

## 7. Open questions, each with its default

- Should the run tab's search include context notes? `searchKnowledge` covers items only. **Default: items only**; linked note titles show in the detail.
- Should the recalled list survive a relaunch? It needs a `RunRecord` field. **Default: no**; the transcript lines of 3.1 stand in.

## 8. Implementation notes (2026-11-05)

Measured on the running app (Windows, 1600x1000, dark, DPR 1) from resolved colours and a synthetic graph. Contrast on `--neural-field`: name 16.59:1 dark, 16.71:1 light; lowest node colour person and meeting 5.35:1 dark, document 4.32:1 light; every other node colour 5.4 to 13.4:1. Frame JS time at 2,000 nodes and 5,000 edges (`low` tier): layout settles about 1.4 s after switching to Graph; settling p50 14.6 / p95 18.8 / max 44.7 ms; idle max 0.3 ms; hover p95 3.7, pan p95 4.1, wheel zoom p95 3.8 ms; no long task over 50 ms; GPU raster not measured. These numbers predate the label and frame fixes below, which only remove work.

Deviations from the text above:

- A new node's pinned placement runs 20 ticks instead of 60 above 800 nodes (60 ticks took 97 ms at 2,000 nodes, unit-level measurement).
- `KnowledgeFilters` measures the band with a ResizeObserver rather than a container query, so testids are not duplicated.
- The stage's corner moving (the band rewrapping) moves the view the opposite way, so nodes hold still in the window, not just in the stage.
- Options carry `aria-setsize` / `aria-posinset` for the whole graph, since above 300 nodes only some are in the DOM. The node holding focus leaving the graph moves focus to the nearest kept option with "That item left the graph. Now on <name>."
- `knowledge-possible-partial` shows when `KnowledgeInferredResult.partial` is set (the matcher stopped at its budget).
- The auto-context note says "an item you added yourself": main's automatic block matches user-created entities only.

Fixes after walk 4 (`ux-review-knowledge-4.md`) and review, 2026-11-05. Measured again on the running app, same machine and size, on 2,000 items and 5,000 relations, both a hub graph (eight client organisations, top total 453, preferential attachment for the rest) and a uniform random one (top total 15). Frame JS time, `low` tier; every rAF callback timed, no long task over 50 ms in any phase; GPU raster not measured:

| Phase | Hub graph: p95 / max ms | Random: p95 / max ms |
| --- | --- | --- |
| Settling (1.35 s / 1.04 s after the switch) | 15.3 / 29.2 | 14.8 / 16.9 |
| Idle, 2 s | 0.1 / 0.3 | 0.1 / 0.2 |
| Hover sweep across the stage | 3.2 / 6.1 | 2.1 / 2.6 |
| Pan | 1.9 / 2.6 | 1.9 / 2.6 |
| Wheel zoom, 20 ticks | 2.3 / 3.5 | 2.1 / 3.3 |

Fit before and after, computed from the layout on the same graphs (stage 1368 x 820; "core" is the 5th to 95th percentile span): hub graph zoom 0.19 -> 0.35, core 443 -> 623 px of the 724 px inside the padding, top node 6.6 -> 12 px, leaf about 3 px; random zoom 0.15 (the floor, 5 nodes off stage) -> 0.34 (17 of 2,000 off), core 392 -> 639 px. At 1024x640 (928 x 432) the stage is the limit: zoom 0.16, core about 290 of 336 px, 2 nodes off, and the cloud is dense there.

Contrast of the inferred dots on the field, computed from the tokens at opacity 0.95: dark about 12:1, light about 9.5:1 (`--neural-synapse-inferred`). Node colours and names are unchanged from the figures above. The light theme's nucleus sits inside the disc and its outline, so a node's edge still meets the figures above; it, the larger halo and the dots were judged by eye in screenshots, with no additive blending on white.

The light theme reads closer to cells than before, at 67 items and at 2,000; it is still calmer than dark, and that is the honest limit without a glow on white.

## 9. Verification owed

Unit: `lib/knowledgeNeural.ts` (determinism, pinned new node, radius, marks, tier bounds, labels without overlap, card placement, spatial and hub moves) and `linkWhy`. e2e in e2e:free, mock, both sizes and themes: `e2e/knowledge-graph.mjs` rewritten on 1.9, `e2e/knowledge-run.mjs` for section 3, `e2e/canvas.mjs` unchanged and green. Then a UX walk on a seeded graph of 60 and of 2,000 nodes. Report measured contrast, frame times at 2,000 nodes, and what was and was not seen by eye.
