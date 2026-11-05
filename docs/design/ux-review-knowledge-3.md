# UX review: Knowledge tab, Graph view, pre-redesign walk (walk 3)

Reviewer: UX Researcher. Build: 006a362 (`npm run build`, then the built app). Mock adapter (`ORGAI_MOCK=1`), throwaway data dir.
Sizes: 1600x1000 and 1024x640, dark and light. Mouse first, then a keyboard pass at 1600x1000.
Compared with: `docs/design/knowledge.md` section 5, CLAUDE.md "Knowledge tab", and the owner's three asks (a graph that looks unlike the agent canvas, more connections, faster lower-token access during runs).
Shots (outside the repo): `C:\Users\chapp\AppData\Local\Temp\orgai-ux-kg3\` (names below). Walk scripts: `e2e/shots/ux/knowledge-3/` (gitignored).

Data: an engagement created through the form, a work run with `Summarise the kickoff [mock:knowledge]` (4 items, 2 relations, 1 note), then seeded in the running app only through `window.orgai.knowledge.saveNode/saveEdge`: 59 nodes (15 people, 4 organisations, 10 systems, 9 decisions, 9 risks, 6 questions, 6 milestones) and 101 edges, plus 8 decisions linked to the Kickoff note. Several facts mention other items in prose ("Reports to Mara Lindqvist", "Works closely with Jane Doe", "Sponsor of the billing migration", "Replaced by Stripe Billing") so missing links can be judged.

## Verdict: NOT READY for the owner's goals

The graph works as a quiet, accessible neighbourhood viewer, but it reads as the agent canvas in a different colour, is unreadable at any size beyond about 10 nodes, has no hover reveal, and nothing in a run lets you look something up. The neighbourhood default is sensible but hides almost everything a newcomer wants to see.

## Findings

### High

**H1. At fit zoom the nodes are unreadable, and Show all and Depth 2 overflow the pane.** `12-graph-showall-1600-dark`, `18-acme-d2-1600-dark`, `23-detail-1024-dark`.
Steps: Knowledge > Graph > Show all (or select Acme Corp, Depth 2). Measured: Show all 59 nodes draws at scale 0.2 (the floor) with the viewport translated off the left edge (-279 px), so nodes are cut at the right and left edges; the pane is 768x912 at 1600 and 728x552 at 1024 (408 px wide with detail open). Depth 1 on Acme (10 nodes) fits at 0.27, node 59x26 px, text about 3 px. Even Jane Doe (6 nodes) fits at 0.49, with names at roughly 6 px. Fit also lays every neighbour in one row (dagre top-down), so a hub's graph is a thin strip using under a tenth of the pane (`15-click-acme-1600-dark`: a 9-wide row in a 768x912 pane, top and bottom empty).
Expected: a hub's neighbours around it, large enough to read, fills the pane. Fix: radial or force layout by default for the knowledge canvas, fit to the pane with a readable floor, and cluster or collapse when more cannot fit; show names only (kind colour, count on hover) at small scale.

**H2. Hover does nothing; click re-roots the graph instead of revealing the item.** `14-hover-1600-dark`, `15-click-acme-1600-dark`.
Steps: hover any node for 1 s, no tooltip, no highlight of its edges, no element with a title attribute (the node has only an `aria-label`). Click Acme Corp: the node becomes selected, the detail panel changes, and the whole neighbourhood is redrawn around Acme and re-fitted (10 nodes at 0.27), so the node you clicked jumps. Double-click Mara Lindqvist: the graph re-roots again, the detail opens, and focus is on `main#main-content` (not the detail heading, which the Enter key does reach). Expected from the owner's description: hover shows the item (name, kind, summary, a fact or two), click opens details, and moving through the graph does not rearrange it under you. Fix: a hover card or in-place expand with summary, facts count and relation list; click selects and opens detail without re-rooting; re-root only through an explicit action (double click or "Focus here").

**H3. The first thing a newcomer sees is an empty state with no graph.** `11-graph-first-1600-dark`.
Steps: open Knowledge, choose Graph with nothing selected. A 768x912 black pane says "Select an item in the list to see its relations." with a small "Show all" button; the list is hidden because the switch replaced it, so the sentence points at something not on screen. The right panel says "Select an item to see its facts, relations and history." Pressing Show all then yields H1's unreadable view. Expected: a graph on first open (most-connected items, or the last recorded ones), with the detail empty state quiet. Fix: default to a overview of the top N hubs by relation count, or the items the latest run recorded.

**H4. In a run there is no way to see or look up what the team knows without leaving the run.** `04-run-idle-1600-dark`, `35-after-recorded-1600-dark`.
Steps: finish the knowledge run, stay on Live. Seen: the canvas shows only agents (Engagement Lead, Specialist x2). The run strip metadata has "Recorded 8 changes" (breakdown "4 items, 2 relations, 1 note, 1 retired" in title only) and it navigates to the Knowledge tab, leaving the run (after the click, tab Knowledge selected, focus on "Add a note"). The side panel tabs are Transcript, Plan, Usage, Logs; there is no knowledge tab, search, or card. The only lookup is Ctrl+K, which opens nothing visible in this build (2 dialogs counted in the DOM, none on screen, `37-ctrlk`). Transcript rows are generic (see M3). Fix: a Knowledge tab in the run side panel (search box, recent writes, the Graph of what this run touched) with the same detail card, no navigation away.

### Medium

**M1. The graph looks like the agent canvas.** Compare `13-graph-jane-1600-dark` with `04-run-idle-1600-dark`: same rounded card nodes with an avatar and initials, same dotted backdrop, same dagre tree, same smoothstep edges, same toolbar. It is built from the shared canvas pieces by design (section 5), but a newcomer cannot tell the Knowledge canvas from the Live canvas except by labels. There is no animation at all (`document.getAnimations()` returned 0 on the graph), so the "neural network" feel the owner wants is entirely missing. Fix: its own visual language (round nodes sized by connections, kind colour glow, soft curved links, slow drift or pulse on recently written items, off under reduced motion).

**M2. Edges carry no readable meaning.** `33-legend-1600-dark`. Relation labels appear only at zoom >= 1, which is never reached by fit (0.2 to 0.49), so the user sees unlabelled curves coloured by the source node's kind. The legend lists relations (affects, collaborates with, decided by, manages, owns, reports to, works at) as seven identical white lines, so it does not help tell them apart. Direction is an arrowhead only. Fix: label on edge hover and on node hover (highlight a node's edges and dim the rest), and distinguish a few relation families by dash or weight.

**M3. Run transcript rows say what was done, not what was found.** `02-run-mid-1`, `04-run-idle`. Seen rows: "Looked up the kinds and relations in use" / "No kinds in use yet"; "Recorded organisation Acme Corp Open"; "Linked Jane Doe works at Acme Corp Open"; "Searched the knowledge for Acme" / "3 items found"; "Read Acme Corp" / "Item returned"; "Retired fact Fiscal year ends in March (Corrected: fiscal year ends in April) Open". Writes read well and "Open" links work (it lands on the Knowledge tab in the last used view with the item selected). Reads do not: "3 items found" does not name the items and "Item returned" says nothing; the content is only under "Show output" (not expanded by default, not summarised). Also "No kinds in use yet" after the lookup is the user's first sign the run starts from empty memory with nothing hinting why.

**M4. Neighbourhood default hides the answer to most questions.** `13-graph-jane-1600-dark`. Jane Doe's depth 1 shows 5 neighbours; the organisation Acme appears, but not its other 8 members, so "who else is at Acme" needs Depth 2 (33 nodes for Acme at Depth 2, overflowing, H1). Depth is only 1 or 2, and the selected node is the only handle: there is no "expand this node" on a neighbour. The title of the pane says nothing about what is hidden (no "5 of 59 shown" count). Fix: expand-in-place per node ("+9 more") and a "showing N of M" line.

**M5. 59 Tab stops, one per node, in list (creation) order.** Keyboard pass (`p4`). Tab from the toolbar reaches Zoom out, Zoom in, Fit, Legend, then 59 node stops (Acme, Jane, the decision, the risk, then the other organisations, then people by creation, then systems, decisions, risks, questions, milestones) before "Hide item details". There are no skip links in the Show all tab sequence between toolbar and nodes shown to me (the spec's Skip to list/detail are sr-only and were not in the sequence I recorded, which began at the Show all switch). Expected: one stop for the graph with arrows to move (roving). Ctrl+Arrow: from Acme (9 neighbours) Ctrl+Right, Ctrl+Down and Ctrl+Up did nothing; only Ctrl+Left moved (to Tom Okafor, the selected node). Space selects (detail changes), Enter moves focus to the detail heading (`h2 knowledge-detail-name`); Esc leaves focus there rather than returning to the node. Screen reader name per node: "Acme Corp, organisation. 1 fact, 9 relations: Jane Doe works at, Mara Lindqvist works at, ... Press Enter to open." Good facts, but for a hub it reads all relations (up to the truncation I could not see), and the sentences are inconsistent in direction ("Jane Doe works at" vs "works at Acme Corp").

**M6. Side panel and canvas at 1024x640.** `23-detail-1024-dark`, `42-portal-1024-light`. With a node selected the detail opens by default at 360 px, leaving the canvas 408 px wide and a 6-node neighbourhood at about 0.25 scale; the canvas is usable only if you collapse the panel (then 728 px wide, 6 nodes at 0.46, readable at about 7 px, `42`). The filter column (about 240 px) is also open the whole time, so at 1024 the graph gets 40% of the width. No page scroll at either size (document 1024x640 and 1600x1000 matched the client size in every state). The panel is 56 px wide when collapsed.

### Low

**L1. Show all warning and button wording.** At 59 nodes no warning appears (threshold 150), yet the result is unreadable; the warning is about count, not legibility.
**L2. The legend pops over nodes** (`33`, it covers the left of the canvas) and lists only kinds drawn at that moment, so colours for risks, questions and milestones are not discoverable until they appear.
**L3. A selected node and a focused node look alike when both are on the same card**; the 4 px bar helps in dark, less in light (`40-portal-1600-light`).
**L4. Selecting a list row whose text matched a fact picked another item** (the first "Customer portal" row was Ines Alvarez whose fact contains it). The list search matches facts but rows do not show why they matched.
**L5. The Notes chip counts 1 and the 8 decisions linked to that note show no note anywhere in the graph**; notes are never nodes or edges.
**L6. Detail text for a hovered or selected node shows "Agent" badge** (provenance) the same weight as the kind, so Jane Doe reads "Person Agent" (`13`).

## Connections: what a newcomer finds obvious and missing (seeded data)

Each is stated as the user would say it. Not drawn today unless noted.

1. "Priya works closely with Jane" (Priya's fact; no Priya-Jane edge). Also "Tom Okafor reports to Mara": drawn only because I added it; the mock agent would only record it as a fact.
2. "Why isn't Mara connected to the migration she sponsors?" (fact "Sponsor of the billing migration"; no edge to the decision "Migrate billing to Stripe").
3. "Marcus raised the SSO concern" (fact on Marcus; no edge to the risk "SSO rollout may lock out users", which has no raised-by).
4. "Northwind runs the warehouse for Acme" (fact; no Northwind-Acme edge).
5. "Billing platform is replaced by Stripe Billing" (fact; no edge from the system to Stripe or the decision).
6. "Jane and Tom both work at Acme, show me everyone at Acme": today needs Depth 2 on a person, or selecting Acme (9 neighbours in a strip). There is no "colleagues" relation and it is not implied.
7. "These 8 decisions came from the kickoff call": all link to the same note (note id shared), but notes are not drawn, so the common origin is invisible.
8. The mock's own risk "Legacy export format undocumented" has no edges at all after the run: agent-recorded items often arrive unlinked, so open questions and risks show 0 or 1 relation (`Open question ... 0 facts, 2 relations`) and the graph is thin where it matters.
9. "Which decisions does this risk block?" is expressible only as the generic `threatens`; a newcomer expects separate relations for owner, source and impact.

Fix direction (for a client engagement): derive suggested links from fact text that names another item (shown as dashed, one click to accept), from shared notes and shared organisations, and from decided-by / raised-by on decisions and questions; record who raised or decided something by default.

## What the redesign must keep

- Plain, accurate spoken names for every node (kind, counts, relations, "Press Enter to open"), and the "Knowledge graph" labelled flow.
- Enter moving focus to the detail heading, Space selecting, the list/graph selection shared both ways, and the single polite status region.
- Depth 1 default for a selected item: the neighbourhood is the right answer when an item is chosen.
- Kind colours through role slots, both themes, the four node styles, and the canvas settings integration; no page scroll at 1024x640 or 1600x1000.
- Retire/restore folding ("N retired") and the detail pane's edit-in-place facts and relations.
- The harness write rows with the "Open" link and "Recorded N changes" in the run strip, and the transcript sentences for writes.

## What the redesign must fix

1. Fit-to-pane readability: nothing below about 9 px; no overflow with Show all or Depth 2 (H1).
2. A graph visible on first open without choosing an item (H3).
3. Hover reveal with highlight, click that selects and opens details without rearranging the graph (H2).
4. A look of its own, with motion that respects reduced motion (M1).
5. Labelled or distinguishable relations (M2) and more drawn connections: facts naming items, shared notes, shared organisation (Connections list).
6. A Knowledge surface inside the run (search, recent writes, the graph of this run) so the user need not leave it, and read rows that name what was found (H4, M3).
7. One Tab stop with arrow-key movement; Ctrl+Arrow that works from a hub; Esc returning to the node (M5).
8. A better 1024x640 split: panel collapsed by default on selection, or a hover card instead of a panel (M6).

## Not driven

- Live updating while a run is recording (the "Show new" announcement and the 5 s throttle): the mock run finished before the graph was open; not seen.
- Screen reader speech: names were read from `aria-label` only, no screen reader was run.
- Token cost or latency of agent knowledge lookups: not measured (no tokens spent, mock only); the run view's "faster, lower-token access" can only be judged from the run view above.
- The four node styles in the knowledge graph, custom canvas themes, System theme, reduced motion, retired items, run-scoped windows, packaged builds, macOS and Linux.
- Ctrl+K opened nothing visible; whether a command palette is intended was not checked in code.
- Graphs over 100 nodes (Show all warning at 150) and the real graph density of a live engagement.
