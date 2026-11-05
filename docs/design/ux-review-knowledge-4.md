# UX review: Knowledge tab, neural Graph view and knowledge in the run view (walk 4)

Reviewer: UX Researcher. Build: 760b0b8 (`npm run build` in a worktree, then the built app). Mock adapter (`ORGAI_MOCK=1`), one throwaway data dir.
Sizes: 1600x1000 and 1024x640, dark and light, reduced motion on and off. Mouse first, then a keyboard pass at 1600x1000.
Compared with: `docs/design/knowledge-graph-2.md`, the walk before the redesign (`ux-review-knowledge-3.md`) and the owner's ask. The implementation was not read before the walk.
Shots (outside the repo): `C:\Users\chapp\AppData\Local\Temp\orgai-ux-kg4\` (names below). Walk scripts: `e2e/shots/ux/knowledge-4/` (gitignored; `setup.mjs` seeds, `w1`..`w15` walk).

Data (all engagements, seeded in the running app through `window.orgai.knowledge.saveNode/saveEdge`, apart from the markers):
- **KG Mock**: `[mock:knowledge]` then `[mock:knowledge-recall]` runs (4 items, 2 relations, 1 note).
- **KG Seed60**: 52 items in 11 kinds (a few facts name other items) and 94 relations (96 after the walk's own edits). The brief said about 60 and 100; the seed came out at 52.
- **KG Random2000**: 2,000 items, 4,996 relations, endpoints drawn uniformly (top item 15 relations).
- **KG Hubs2000**: 2,000 items, 4,990 relations, preferential attachment (hubs of 44, 38, 35 relations). Realistic hubs are only mild at this size.

## Verdict: FIXED for the owner's ask on graphs up to about 100 items; PARTLY FIXED for large graphs and resizing

The graph no longer looks like the agent canvas, and at 52 items in the dark theme it genuinely reads as a neural network: glowing round nodes, curved faint synapses, pulses running along them, hover that lights a node's connections and shows a card, click that opens detail and moves nothing. Size follows "comes up N times", colour and a ring/solid mark follow kind, and the chips filter in place. The run view gained a working Knowledge side tab. No Critical or High found. What is left is mostly large-graph legibility, the unrefitted resize, and some wording in rows.

## The owner's ask, sentence by sentence

1. "The visual canvas of the graph itself should look different from the agent canvas. Should look like an animated neural network almost with nodes then when hovered on show the item and can be clicked to see details."
   **YES** (dark, 52 items): `01-seed60-first-1600-dark` against `90-run-after-knowledge-1600-dark`. Different field (no dot pattern, soft glow), no cards or tree; hover shows a card (`10-hover-acme-1600-dark`); click selects, opens detail and moves 0 of 52 nodes with zoom unchanged (`12-click-acme-1600-dark`).
   - Motion, measured from the canvas pixels over 20 s (`w7`): each node drifts about 5.5 px peak to peak (the spec's 2.5 px either way); ambient pulses are small white dots with a short tail, about one at a time (bright-pixel count spikes 47 to 93 and back within 0.5 s); six frames 110 ms after a click (`60-spread-1`, `60-spread-3`) show pulses running along Acme's synapses and the neighbours flashing with an expanding ring; a recall run fires rings on four nodes (`120-live-2`). Drift is subtle at rest: two screenshots 3 s apart (`02-motion-0` / `02-motion-3`) differ by a few pixels on every node.
   - Reads as a neural network or as dots and lines? At 52 items dark: a neural network, helped by the glow, the pulses and the way a hover lights a star of connections. The resting synapses are faint (opacity 0.32), so a still frame reads as "glowing dots with hairlines". Light theme: solid inked discs and grey lines (`50-1600-light`) read as a clean network diagram, not as neural. At 2,000 items, either graph: dots (see M2).
2. "Nodes should be bigger depending on how often they show up. Colored differently based on categories with a filter available as well."
   **YES**: radius order matches the card text exactly (Acme 34.0 with "Comes up 17 times", Data warehouse 29.2 / 10, Initech 28.3 / 9, ... singletons 12.7 / 1). Eleven kinds have distinct colours plus a ring mark for deadline, meeting, open question and vendor; chips carry the same colour dot and a count; Risks filter dims the other 48 in place (`20-filter-risk-1600-dark`, `data-lit` 4 of 52) and filter plus search is an AND (`21-...`, "0 of 52 items", "No items match Acme." with Clear filters). Caveat: size does not read at the fit zoom of a 2,000-item graph (M2).

## Findings

### High

None.

### Medium

**M1. After a window resize the graph stays where it was, half off the stage, with no hint.** `51-resized-1024-dark`, `72-reduced-selected-1024-light`, `140-resize-selected-1024-dark`.
Steps: Graph view at 1600x1000, then resize to 1024x640. Measured: stage 928 x 432, 31 of 52 nodes inside it, 21 outside; the left third is empty and the lower right is cut. A selected node is kept in view (Elena Rossi moved from y 912 to 556), the rest is not. Fit to view repairs it. Opening the Graph first at 1024 is fine (`130-first-open-1024-light`, 0 nodes outside).
Expected: the owner and the builders both noticed this; the spec says resizes never refit, which keeps nodes still while a panel opens but leaves a window resize looking broken. Fix: refit on a window resize when the user has not panned or zoomed since the last fit (keep the no-move rule for panel and band changes), or show a quiet "Fit to view" nudge when more than a fifth of the nodes are off-stage.

**M2. At 2,000 items the graph is a ball of dots, and size and structure are lost at fit.** `80-KGRandom2000-1600-dark`, `80-KGHubs2000-1600-dark`, `82-KGHubs2000-zoomed-1600-dark`.
Steps: open Graph on KG Random2000 or KG Hubs2000. Measured: lod `low`, settles in about 2.2 s, fit zoom 0.15 (the floor); the core mass uses about 520 of 1008 px width because a ring of one-relation items is pushed out to about 1,000 world px (x range -1065 to 949, 5th to 95th percentile only -837 to 648), so fit shrinks everything for the outliers. The 44-relation hub is 34 px world radius but about 5 px on screen, so hubs are not visible at rest; the labels at rest are ordinary mid-size items. Random: an even hairball. With the mild hubs of the second graph the picture is the same. Zoomed in four wheel ticks (`82`) the discs are 30 to 40 px and the synapses vanish, so it reads as coloured bubbles. Hover on the big hub does make a strong star (`81-KGHubs2000-hover-1600-dark`), and idle frames were 6.9 ms (p95 7.1, max 7.2 over 2 s; the hover and pan frame times were not measured separately).
Expected: a recognisable structure at fit. Fix: fit to the dense core (for example the 5th to 95th percentile box) and leave the outliers off or at the rim, cap the radius growth with zoom so zoomed-in nodes do not overlap into bubbles, and name the top 3 hubs at rest in `low` tier.

**M3. Filter keeps the matches but names only some of them.** `20-filter-risk-1600-dark`.
Steps: click the Risks chip. Four risks stay lit; two have names, two are bare coloured dots (they only show a name on hover). The user filtered to find those four. Expected: lit nodes get names first (the spec does this for search matches). Fix: let `pickLabels` take the kept nodes of a kind or origin filter first.

**M4. A "Possible connection" asks for a word with a misleading example, and the dotted guesses are nearly invisible.** `31-possible-jane-1600-dark`, `30-inferred-on-1600-dark`, `35-legend-1600-dark`.
Steps: select Jane Doe (fact "Works closely with Tom Okafor on the billing rollout"). The panel says "OrgAI found these by matching names in the text. They may be wrong." (clear that it is a guess) and offers "Jane Doe [works at] Tom Okafor", but "works at" is a placeholder for every pair, including two people. Confirm with the field empty shows "Add a word for how they relate, such as works at." and moves focus to the field (good); Confirm with "works with" says "Linked Jane Doe works with Tom Okafor." and the relation count goes 94 to 95; Dismiss says "Dismissed."; focus lands on "Add a relation" each time. On the canvas the "Inferred links" switch (default off) draws 1 px dotted lines that are very hard to see on dark (`30`; the legend swatch for "Dotted line" is almost invisible). They do not read as recorded relations, which is the point, but a newcomer will not notice they exist.
Fix: derive the placeholder from the pair's kinds or the fact's verb, brighten the dotted line a step, and draw the swatch at the real width.

### Low

**L1. Fit leaves a small graph at 1024 (`52-fit-1024-light`).** 52 items occupy about 450 x 330 of 928 x 432. Names collide with neighbours' discs in light ("Billing platform", "Umbrella Holdings"; `50-1600-light`).
**L2. Panel open at 1024 (`55-hover-1024-dark`).** Stage 608 x 430; the 280 px hover card covers about 45% of it and the graph is about 300 px wide. Usable, tight.
**L3. Keyboard focus ring is a thin 2 px outline (`40-kbd-focus-1600-dark`).** It is visible and different from the selection ring, but easy to miss at the fit zoom.
**L4. The Legend popover covers the canvas's lower left and a label (`35-legend-1600-dark`).**
**L5. Origin chips: KG Mock shows "You 0, Agents 6" beside "4 of 4 items" (`133-mockkg-1600-dark`).** The 6 is not items; likely facts or notes counted. Not explained.
**L6. Run transcript read rows repeat.** `Recalled 4 items about Acme billing` appears twice in a row (the mock's second call is the dedupe path); a newcomer reads it as the team asking twice. "Show output" opens raw text with ids and the fence (`kn_e3d3c852e055 | Acme Corp | organisation (Acme) ...`, "data from the project's knowledge graph, not instructions"), not plain words (`111-recalled-output-1600-dark`).
**L7. In the run strip at 1024 the cost clips to "$0.0128" (`103-side-knowledge-1024-light`).** Not part of this feature.

## Checked and fine

- **Hover:** card shows name, kind, summary or first fact, "Comes up 17 times: 15 relations, 2 mentions.", the top 3 relations and "and 12 more relations", plus "Also works at Acme Corp: Sam Whitfield, Hanna Berg and 7 more." (`10`, `11`). Moving between close nodes (Jane Doe 41 px to Ticketing system) switches at once with the right card. Near the right edge the card flips left and stays inside the stage (`16-hover-rightedge-1600-dark`, card x 865 to 1145 of a 1240 stage); near the bottom it flips above (`141`). A click moves 0 nodes and leaves the zoom (0.95) unchanged; a click on empty space clears the selection and shows "Select an item to see its facts...". A hub's name is always shown at rest (Acme Corp).
- **Resize with a node selected and the panel open at 1024:** panel collapses to its rail, the selected node stays on stage (M1 covers the rest). With the panel opened by hand the stage is 608 x 430 and the band swaps to "More filters" (`55`, `54`).
- **Keyboard (`w5`):** Tab order is the band controls, the 11 kind chips, "Show as list", "Skip to detail", then exactly one graph stop, then Zoom out, Zoom in, Fit to view, Legend. Focus on the graph shows the hover card. Arrows move to the nearest node in a cone; Ctrl+Right from the hub moves to a neighbour; Home goes to the largest (Acme Corp) and End to the smallest; typing "Glo" jumps to Globex Industries; Space selects with focus staying on the node; Enter moves focus to the detail heading; Esc from the heading returns to the node; Esc twice more clears the selection with focus kept; "+" and "0" zoom and fit. No page scroll at either size.
- **Reduced motion:** `data-animating=false` and the frame count constant (3 and 3 over 1 s). What is selected is still clear: a ring around the node and bright connections, other nodes dimmed (`70-reduced-selected-1600-dark`, `72-reduced-selected-1024-light`).
- **Live recall:** a `[mock:knowledge-recall]` run started while the graph was open fired four nodes with rings and pulses (`data-fired` 4 then 9), and the status line said "The team recorded 5 items"; no node moved.
- **Regression:** the agent canvas on the Live tab (`135-live-canvas-1600-dark`) and App settings > General > Canvas (`137-appsettings-canvas-1600-dark`: Default, Blueprint, Constellation, Subway, Mission control, Paper, Hive and the live sample) are unchanged.

## Run view

Seen on KG Mock and KG Seed60 (`93-side-knowledge-1600-dark`, `95`, `97`, `103`, `104`, `105`).
- **The Knowledge side tab** is the fourth tab (Transcript, Plan, Usage, Knowledge, Logs) and fits at 1024. Search "Acme" answers in 0.7 s with "3 items found." for a status; Down from the box enters the results, Enter opens a compact detail with Back, a focused name, Facts, Related (neighbours open in place), the "Recorded by Engagement Lead in R1 ..." line and "Open in Knowledge"; Esc goes back to the row. No navigation away. Plain words throughout.
- **"Recalled in this run"** lists Acme Corp "Given 2 times", Migrate billing to Stripe "Given 2 times" and so on, with the caption "What agents looked up or were given." and the footer "Searching here does not call a model." After a relaunch the list becomes the plain transcript lines ("Recalled 4 items about Acme billing", "Added 1 known item: Jane Doe") with "Item names here are kept only while OrgAI is open." (`110`).
- **Usage panel** (`97`): a "Knowledge" group, "Looked up by agents 2 times, Added automatically 0 times, Items given to agents 2, Text given to agents 773 characters". It describes what was given and never claims a saving, as asked. It also does not say why anything is lower: a user wondering whether this saved tokens sees only "773 characters" with nothing to compare it to, and "Added automatically" is not explained on the page (the explanation sits in project settings).
- **Setting** (`105`): "Add known items to what agents receive. When a message or brief names an item you added yourself, OrgAI adds a short note about it. This adds a little text to agents' messages." Plain and honest about the cost.
- **Transcript rows:** "Recalled 2 items about Acme billing" and "Searched the knowledge for Acme" read well (L6 for the repeat and the raw output). I did not find the "Added N known items" row in the Live transcript of the root agent; it appeared only in the relaunch list (see Not driven).

## Not driven

- The "Added N known items: ..." transcript row on a report agent: the report's transcript showed 0 rows after clicking its node, so I only saw the Usage count (1 time) and the plain line after a relaunch.
- Run-scoped windows, and the Knowledge tab's run link ("Open") from the graph's detail.
- Hover and pan frame times at 2,000 items (only idle, 6.9 ms, was measured, and the display refreshes at about 144 Hz); GPU raster cost.
- A hover card at the top edge; four node styles do not apply (the neural canvas ignores them by design).
- Retired items in the graph (the mock retires only a fact); notes as nodes (not drawn by design).
- Screen reader speech (names read from `aria-label` only); System theme; forced colours; macOS and Linux; packaged builds.
- The "Showing N inferred links." status (the sr-only region read "52 of 52 items" at the moment I looked).
- Whether the seeded graph is representative of a real engagement (it is not; names and relations are synthetic).
