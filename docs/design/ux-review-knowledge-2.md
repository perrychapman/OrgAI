# UX re-walk: the Knowledge tab, run rows, Settings and Maintenance on mock data

- Reviewer: UX Researcher (mock-data walkthrough, no code changes).
- Build: 2c6e337 (dev), `npm ci` + `npm run build` in a worktree, version 0.1.6-dev1.
- How it ran: the built Electron app driven by playwright-core through `e2e/lib.mjs` `launch()` / `relaunch()` from two
  scratch scripts (`e2e/shots/ux/knowledge-2/walk.mjs` and `measure.mjs`, gitignored), `ORGAI_MOCK=1`, a fresh temp
  `ORGAI_DATA_DIR` per script. Sizes 1600x1000 and 1024x640 (`setContentSize`), dark and light through
  `settings.appearance.theme`. One keyboard-only pass at 1024x640 dark (topbar tab through the toolbar, filters, the
  list, the detail pane, the row menu, the pane's Hide button, the transcript's Open link) and the graph's keyboard
  path at 1600x1000 dark (skip links, toolbar, nodes, Ctrl+Arrow, Enter, Esc). No tokens, no network.
- Persona: a consultant on their first engagement, "Acme access review" (client Acme Corp, a working folder, interview
  skipped), who starts one work run "Summarise the kickoff call [mock:knowledge]", allows the default script's one edit
  card once, waits for Idle, then looks at what the team recorded. A code project ("Notes API") and the three assistants
  were opened to check the tab is absent.
- Compared with: `docs/design/knowledge.md` (sections 1-12 and the section 13 Implementation notes), the 19
  recommendations of `docs/design/ux-review-knowledge.md`, the "Engagement knowledge graph" bullet in CLAUDE.md.
- Screenshots: `docs/design/ux-review-knowledge-2-shots/NN-what-size-theme.png` (48). The raw `results.json`,
  `measure.json` and the scripts stay in `e2e/shots/ux/knowledge-2/`.
- Labels: "seen" = observed in the app; "read in code" = from source, not observed; "mock-limited" = the mock cannot
  produce it.

## Verdict

LANDED, NO HIGH. A first-time consultant can start the run, watch the root record eight things with plain sentences
and Open links, land on the right item from a transcript row, find Jane Doe by name, fact or alias, edit a fact inline,
add a fact, follow a relation, retire, restore and delete an item, add and edit a note, create an item, and see the
graph of Jane's neighbourhood with spoken node names and a working keyboard path, at both sizes and in both themes
with no page scroll and no window shift (seen). Sixteen of the 19 recommendations landed, three partly (rec 10's
bulk retire by run, rec 15's date tooltip and the bare "Retired" line on notes, rec 18's focus after four
navigations), none is missing except rec 9, which needs a contract flag.

What matters most, in order: (M1) the transcript's write rows reuse the Knowledge list's `.knowledge-row` class, so each
row is a fixed 56 px column with the icon alone on its first line and an expanded "Show output" overlapping the next row;
(M2) "items" means four different numbers across RunMeta (8), the tab (5 of 5), Settings (2 notes, 6 facts, 2 systems),
Clear everything (5 items, 7 facts) and Forget (5 recorded items); (M3) a relation that runs against the layout
("decided by", decision below Jane) loops out of the bottom of the lower node and into the top of the upper one; (M4)
the graph's two skip links stay visible as purple bars above the toolbar when not focused, and are clickable there;
(M5) Retire gives no visible confirmation and no Undo; (M6) the retire reason the agent gave ("Corrected: fiscal year
ends in April") never reaches the Knowledge tab; (M7) focus falls to the page body after Recorded N items, Open
Knowledge, the History run link and Hide item details.

## What I walked (seen)

| Step | Result |
| --- | --- |
| New project > Engagement, client Acme Corp, working folder, interview off | Created; topbar tabs Live, History, Knowledge, Team, Settings (shot 01). The code project shows Live, History, Team, Settings (shot 02); Chat, MCP assistant and Skill assistant show no Knowledge tab. |
| Knowledge tab before any run | "Nothing recorded yet / Add a note for the team, or run the team and it records people, systems, decisions and risks here as it works." with Add a note and Add an item; filters "You 0 / Agents 0", "0 of 0 items"; pane "Select an item to see its facts, relations and history." (shot 03). Graph view: "Select an item in the list to see its relations." plus Show all. |
| Settings > General and Maintenance before the run | Context notes: the description plus "Nothing recorded yet · Open Knowledge" (shot 04). Maintenance: "Clear everything…" greyed with "Nothing recorded yet."; the danger text names "what the team recorded". |
| Work run "Summarise the kickoff call [mock:knowledge]" | Within a second the meta read "1 agent · Recorded 2 items" and the panel showed "Recorded organisation Acme Corp Open", "Recorded person Jane Doe Open" (shot 05). The default script's edit card arrived ("Edit example.ts / In the project src/example.ts"), allowed once; the run reached Idle. Store: 4 nodes (Acme Corp with alias Acme and a summary, Jane Doe with alias J. Doe, the decision, the risk), 2 edges (works-at; decided-by with note "Sponsor sign-off"), 1 agent note, the March fact retired. |
| Root transcript | In order: "Looked up the kinds and relations in use / No kinds in use yet", "Recorded organisation Acme Corp Open", "Recorded person Jane Doe Open", "Linked Jane Doe works at Acme Corp Open", "Recorded decision Migrate billing to Stripe Open", "Linked Migrate billing to Stripe decided by Jane Doe Open", "Recorded risk Legacy export format undocumented Open", "Saved note Kickoff call summary Open", "Searched the knowledge for Acme / 3 items found", "Read Acme Corp / Item returned", "Retired fact Fiscal year ends in March (Corrected: fiscal year ends in April) Open", then "I recorded what I learned about the engagement." No row says "Used", "engagement_knowledge" or "not instructions". Show output holds "Created organisation Acme Corp (kn_…)". Open links are named "Open <name> in Knowledge"; the retired-fact row opens Acme Corp (shots 06, 07, 08). |
| Open link, RunMeta "Recorded 8 items" | Enter on "Open Jane Doe in Knowledge" opened the tab with Jane Doe selected, the pane open and focus on the heading (shot 09); the note row landed on "Kickoff call summary", the retired-fact row on Acme Corp. "Recorded 8 items" is a button titled "What the team recorded this run. Opens Knowledge." and opens the tab (focus on body, M7). |
| List | Groups People 1, Organisations 1, Decisions 1, Risks 1, Notes 1; rows 56 px: name, kind badge, "Agent" badge, excerpt (first fact or the note's first line), "Engagement Lead · R1 · 4 Nov 2026"; "5 of 5 items" (shot 10). Search "Acme" 3 of 5 (Jane by her summary, the risk by its fact), "Jane" 2, "Stripe" 1, "CFO" 2, "J. Doe" 1 (alias), "March" and "April" 0 (retired facts and retire reasons are not searched), "zzz" shows "No items match zzz. / Clear search" (shot 11). Esc clears and keeps focus. People chip "1 of 5 items", spoken; People + Decisions 2 of 5; All kinds resets; "You 0" gives "No items match these filters. / Clear search" (shot 12); "Agents" pressed drops the Agent badges. |
| Detail pane, Jane Doe | Heading with focus ring, badges Person / Agent, Kind, Aliases "J. Doe", Summary; Facts 2 as inputs with a "More actions for fact N" menu (Retire, Remove) and Add a fact; Related 2 "works at Acme Corp" and "Migrate billing to Stripe decided by / Sponsor sign-off"; Notes 0 "No linked notes." with Link a note; History "Recorded by Engagement Lead in R1 Summarise the kickoff call, 4 Nov 2026 13:24" (the run a link); footer Retire / Delete… (shot 13). Enter on an edited fact: "Saved Jane Doe." spoken, focus stays in the field, History gains "Edited by you, 4 Nov 2026 13:25", the row's provenance stays "Engagement Lead · R1". Add a fact focuses the new input; Enter saves "Based in Leeds" (the user's); an empty new fact is dropped on blur. Esc restores a field. Name, kind, aliases and summary are "Edit …" buttons that swap to inputs. |
| Follow a relation, Acme Corp | Click "Acme Corp": the pane shows Acme Corp, the list selects it, focus on the new heading. Facts 1 (Headquartered in Leeds); Show retired reveals "Fiscal year ends in March" with a Retired badge and a menu Restore / Remove (shot 14). Nothing in the tab shows the reason "Corrected: fiscal year ends in April" (M6). |
| Decision, relations, notes | "decided by Jane Doe / Sponsor sign-off" (shot 15). Add a relation: an Item combobox (listbox of the other items), Relation (datalist), Direction segmented, Save / Cancel (shot 16); saved "raises Legacy export format undocumented", "Saved Migrate billing to Stripe." spoken, focus on Add a relation. Link a note: a search over note titles, "Linked the note Kickoff call summary." spoken; the link opens the note in the pane (title, excerpt, "150 characters", Edit note, History, Retire / Delete…). |
| Retire, restore, delete the risk | Retire: "Retired Legacy export format undocumented." (sr-only), the row leaves, "4 of 4 items", the Risks chip disappears, selection and the pane move to "Kickoff call summary", focus on that row (shot 17, M5). Show retired: the row with a Retired badge; the pane says "Retired by you, 4 Nov 2026 13:26" and offers Restore (shot 18). Restore: spoken, focus on the restored row. Delete…: "Delete Legacy export format undocumented? / Agents and you can no longer see it. Retire it instead to keep the record. / Cancel · Delete", Cancel focused (shot 19); "Deleted …" spoken, focus on the next row. Shift+F10 on a row: Open / Retire (shot 20); on a note row: Open, Retire, Edit. |
| Notes from the tab | "Add a note" dialog: Title (focused), Text, "0 of 50,000 characters", Cancel / Save note (shot 21). Saved: "Note saved.", the row "Client preferences · Note · Jane prefers email on Tuesdays. · You · 4 Nov 2026" (no Agent badge), focus on the row. Edit note from the pane: "Edit Client preferences", Save: focus back on "Edit note", History "Added by you… / Edited by you…". Retiring the agent note: the pane shows "Recorded by … / Edited by you … / Retired" (bare, shot 22, L3). Esc on a dirty dialog: "Discard this note? / What you typed is not saved. / Cancel · Discard"; after Discard focus is on "Add a note". |
| Add an item, live update | "New item" form in the pane with Name focused, Kind placeholder "person, organisation, system…"; "SAP ERP" / "System" saved: "Saved SAP ERP." spoken, the pane shows it with "Added by you", a Systems group. With People pressed, a write from outside the tab (`knowledge.saveNode`) said "The team recorded 1 item", kept the filtered list and added "Show new" after "1 of 7 items" (shot 23); Show new cleared the filters. |
| Graph view (Jane selected) | Depth 1: Jane Doe (selected cue), Acme Corp, the decision; edge labels "decided by" and "works at" at zoom 1; SVG titles "Jane Doe works at Acme Corp", "Migrate billing to Stripe decided by Jane Doe / Sponsor sign-off" (shot 24). Depth 2 the same for this data; "Depth 2. Showing 3 items and 2 relations." spoken. Show all draws 5 (SAP ERP and Billing platform too) at zoom 0.71, labels hidden (shot 28). Legend: Kinds Person / Organisation / System / Decision with swatches, Relations decided by / works at, Retired (dashed), "3 retired" group (shot 29); Esc returns focus to the legend button. Tab order from Show retired: Skip to list, Skip to detail, Depth, Show all, Zoom out, Zoom in, Fit, legend, then the nodes in list order (Acme, Jane, the decision), then the pane's Hide button. Node focus ring 2 px solid. Spoken: "Jane Doe, person. 3 facts, 2 relations: works at Acme Corp, Migrate billing to Stripe decided by. Press Enter to open." Ctrl+Up from Acme moved to Jane; Enter opened the pane on Jane with the heading focused; Esc on the heading in Graph view did nothing (L6). Skip to list focused the filter form; Skip to detail the pane body. |
| Retired fold | Acme Corp retired from the pane: Jane's node reads "3 facts · 1 relation", a "1 retired" group hangs under Jane on a dashed line, spoken "1 retired item under Jane Doe. Press Enter to show them." (shot 30); the chevron draws Acme Corp with the word Retired and a dashed "works at" edge (shot 31). With the note selected the graph says "Select an item in the list to see its relations." |
| Settings > General, Maintenance | "2 notes, 6 facts, 2 systems · Open Knowledge" (shot 32; M2); Open Knowledge opens the tab (focus on body). Maintenance: Forget confirm lists "2 context notes / 5 recorded items / Ends 1 open run and deletes 1 run… / 1 team review file" (shot 33). Clear everything…: "Clear everything the team recorded? / Deletes 5 items, 7 facts, 2 relations. Context notes stay. Agents and you can no longer see them. Retire items on the Knowledge tab to keep records instead." with Cancel focused (shot 34); after confirming: "Cleared everything the team recorded." notice with focus on it, the button greyed with "Nothing recorded yet.", the two notes kept, the tab shows only the Notes group, Settings reads "2 notes", RunMeta still "Recorded 8 items" (shot 35). |
| Relaunch | Opened on the Dashboard (the Knowledge view is not remembered across a relaunch; the run tab is). Rows, provenance and History survived; the History run link opened the Live tab on "R1 … Ended when OrgAI closed" with focus on body (shot 47). |
| Sizes and themes | 1600x1000 and 1024x640, dark and light: no page scroll, no window shift, no cut row names; the pane is a rail at 1024 and opens on selection (list 408 px + pane 360 px); the graph stage is 408 px wide at 1024 with the pane open; the Settings summary line sits one scroll down at 1024 (shots 36-42). |

## Recommendation status

| Rec | Status | Evidence |
| --- | --- | --- |
| 1 Knowledge tab between History and Team, engagements only | Landed | Shots 01, 02; the three assistants show no tab. The `show-knowledge` menu item is open (spec section 12). |
| 2 Run panel "Recorded" tab, or the RunMeta line | Landed (the alternative) | "Recorded 8 items" button on RunMeta at both sizes; every write row links to its item. No per-run Recorded list. |
| 3 Settings > General as a summary line | Landed | Shot 32; the inline list, Add a note and the dialog are gone from Settings. |
| 4 List first, grouped, excerpt, provenance, detail pane as SidePanel, rail under 1100 | Landed | Shots 10, 38, 39. Windowing past 100 rows read in code only (the mock gives 7). |
| 5 Graph as a view switch: neighbourhood, Depth, Show all with a cap, retired fold, shared selection, legend, labels at zoom 1 | Landed, with M3 and M4 | Shots 24, 28-31. The 150-item warning is read in code (mock-limited). Canvas styles follow App settings (read in e2e only). |
| 6 One search box, ranked, count, Esc clears | Landed | Shot 11; count spoken; "Clear search" in the empty state. |
| 7 Provenance line per row and a History block | Landed | "Engagement Lead · R1 · 4 Nov 2026", "You · 4 Nov 2026"; "Recorded by … in R1 …, 4 Nov 2026 13:24" with the run as a link, "Edited by you", "Retired by you". A retired note reads bare "Retired" (L3). |
| 8 Agent notes in the same list, Agent badge only on All, origin chips | Landed | Shots 10, 12; the badge drops when Agents is pressed. |
| 9 Plain trust cues, "Checked by you" | Not built | No contract flag (spec section 12). Nothing in the UI claims confidence. |
| 10 Retire as the row action, Delete only in the pane, Clear everything in Maintenance, bulk retire by run | Partly | Row menu Open / Retire, pane Retire / Restore / Delete… with the spec confirm, Clear everything with counts (shots 19, 20, 34). "Retire all agent items from R3" not built. |
| 11 Inline facts and header fields, dialog for notes, "Saved <name>.", focus stays | Landed | Shot 13; status and focus as specified for facts, relations, notes and the create form. |
| 12 Empty states | Landed (two of four seen) | "Nothing recorded yet", "No items match zzz." and "No items match these filters." seen; "The team has not recorded anything yet" and "Only retired items." read in code only. |
| 13 Transcript rows name the thing, raw result under Show output, Open link | Landed, with M1 | Shots 06-08; eleven sentences, no tool names. |
| 14 Section and control titles, no "entity / node / edge / provenance" | Landed | Groups, "Show", "Recorded by", "Show retired", Facts / Related / Notes / History, Add a note / Add an item / Retire / Restore / Delete…; the legend says "item or relation". |
| 15 Provenance wording, one date format | Partly | Visible dates are "4 Nov 2026" / "4 Nov 2026 13:24" everywhere; the History line's tooltip is "11/4/2026, 1:24:36 PM" (L2); a retired note has no who or when (L3). |
| 16 List + detail keyboard path | Landed | One Tab stop, Up / Down / Home / End, type-ahead ("m" to Migrate…), Enter to the heading, Esc back to the row, Shift+F10 menu, native Switch (shots 43, 44). |
| 17 Graph keyboard path, skip links, spoken names, Ctrl+Arrow | Landed, with M4 and L6 | Tab order in list order, spoken names with relation words, Enter, Ctrl+Arrow, skip links (shots 24, 27). |
| 18 Live region, no re-sort, "The team recorded N", "Show new", focus after retire / delete / restore | Partly | All seen (shot 23) except focus after four navigations (M7). |
| 19 No animated layout under reduced motion, kind colours as swatches, badges with words | Partly verified | Badges carry words, swatches in the legend (shot 29); reduced motion not driven in this walk (covered by e2e/knowledge-graph.mjs, read only). |

## Findings

### M1. Transcript write rows borrow the Knowledge list's row style: icon alone on line one, "Open" wrapping, and an expanded output overlapping the next row

- Where: the run side panel's Transcript, every "Recorded / Linked / Saved note / Retired" row. Shots 06 (1600 dark,
  first row expanded), 07 (1024 dark clip), 08 (1600 light).
- Steps: start the run, select the root, open the Transcript tab, click "Show output" on "Recorded organisation Acme
  Corp".
- Seen and measured (`measure.json` `transcriptGeometry`, `transcriptOverlap`): the row is
  `div.entry.system.harness.knowledge-row`, computed `display: flex; flex-direction: column`, height 56 px; the Database
  icon's box is 14 x 14 at the row's top and the headline sits 23 px lower on its own line, while a normal tool row
  ("Looked up the kinds…") puts the icon and text side by side. At 1024 the "Open" link wraps under the headline
  (shot 07). With the output expanded, the `pre` (y 478-510) overlaps the next row's icon (y 502-516): `overlaps: true`.
- Cause (read in code): `styles/knowledge.css` `.knowledge-row { height: 56px; display: flex; flex-direction: column;
  padding: 0 … var(--space-4); border-left: 3px solid transparent }` is the list row's rule, and `TranscriptPanel`'s
  `KnowledgeWriteRow` uses the same class name `knowledge-row` (and the same `data-testid=knowledge-row`).
- Why it matters: the write rows are the one place a consultant sees what the team recorded while it runs; they read
  as broken and the expanded result covers the next row (a longer result, such as a search or a merged write, would
  cover the next headline).
- Fix: rename the transcript row's class and testid (for example `knowledge-write-row`) or scope the list rule to
  `.knowledge-list .knowledge-row`; the transcript row then inherits the `.entry.system` flex row (icon + `.tool-main`)
  and grows with its output. Update `e2e/knowledge-run.mjs`'s selectors in the same change.
- Checkable: a write row's icon and headline share one line; `pre` of an expanded row never overlaps the next row.

### M2. "Items" is four different numbers across RunMeta, the tab, Settings, Clear everything and Forget

- Where: RunMeta "Recorded 8 items" (shots 05, 06); the tab "5 of 5 items" after the run and "7 of 7 items" after my
  two additions; Settings > General "2 notes, 6 facts, 2 systems" (shot 32); Clear everything "Deletes 5 items, 7 facts,
  2 relations" (shot 34); Forget "2 context notes / 5 recorded items" (shot 33); after Clear the tab still shows two
  rows and RunMeta still "Recorded 8 items".
- Seen: after the run the store holds 4 entities, 1 note, 2 relations, 7 facts (one retired). RunMeta counts the eight
  write rows (4 Recorded + 2 Linked + 1 Saved note + 1 Retired fact), the tab counts entities plus notes, the summary
  picks the biggest kind only ("2 systems" while a person, an organisation and a decision also exist), Clear counts
  entities and every fact (retired included), Forget counts entities without notes.
- Why it matters: a consultant who reads "Recorded 8 items" and then finds 5 in the tab assumes three are missing; the
  summary line hides three of five items behind "2 systems"; Clear and the summary disagree on the fact count.
- Fix: say what each number counts. RunMeta: "Recorded 4 items, 2 relations, 1 note, 1 correction" or "8 changes"
  (keep the sr text), never "items" for writes. Summary line: the item total first, then kinds and notes ("5 items
  (1 person, 1 organisation, 2 systems, 1 decision), 2 notes, 6 facts"). Clear: "5 items, 6 facts (1 retired), 2
  relations". Forget: keep "5 recorded items" beside "2 context notes" (it already separates them).
- Checkable: with the mock run, the tab's total equals the Forget confirm's recorded items plus its notes, and the
  RunMeta text does not use the word "items" for a count that includes relations and retirements.

### M3. A relation drawn against the layout loops out of the bottom of the lower node and into the top of the upper one

- Where: Graph view, "Migrate billing to Stripe decided by Jane Doe". Shots 24 (1600 dark), 25 (clip), 37 (1600 light),
  40 (1024 dark).
- Steps: select Jane Doe, switch to Graph (top-down layout, the default).
- Seen and measured (`measure.json` `edgeGeometry`): every node has one target handle on top and one source handle at the
  bottom; the layout puts Jane (the centre) above the decision; the edge runs from the decision's bottom source handle to
  Jane's top target handle, path `M130,305.5 C130,411.75 260,-89.75 260,16.5`, so it curls under the decision and arrives
  from above Jane. At a glance the arrow appears to come from nowhere above Jane, and the label "decided by" sits on
  the straight middle section between the two nodes where "works at" also sits.
- Why it matters: direction is the only thing the picture adds over the list; a loop that enters from above reads as a
  third, unseen node.
- Fix: choose the handles by relative position, as the Live canvas does for message edges (`messageSides`): give nodes
  side handles too and pick, per edge, the pair that faces the neighbour (bottom to top when the source is above, top to
  bottom when below, left / right in left-to-right layouts), keeping the arrow at the target end. Radial already has
  `exitPoint`; top-down and left-right need the same.
- Checkable: with the mock data, no edge path leaves the drawn nodes' bounding box; the "decided by" arrow enters Jane
  from below.

### M4. The graph's skip links stay visible and clickable as two purple bars above the toolbar

- Where: Graph view at every size and theme. Shots 24, 28-31, 37, 40 (two purple bars at the top of the content area,
  x 480-565 and 600-700 at 1600, cut by the topbar), 26 (clip), 27 (the focused state, which is fine).
- Measured (`measure.json` `skipLinksUnfocused`): unfocused, both `a.skip-link` have `transform: translateY(-69.7px)`,
  `opacity 1`, `visibility visible`, z-index 60, boxes at y 22-57 inside the window, and `elementFromPoint(520, 50)` /
  `(650, 50)` returns them, so a click there lands on a skip link.
- Cause (read in code): `ui.css .skip-link { transform: translateY(-200%) }` hides the app's own link because that sits
  at the top of the page; the graph's copies are positioned inside the toolbar (`knowledge-graph.css
  .knowledge-graph-toolbar .knowledge-skip { top: var(--space-1) }`), 88 px down, so -200% of 35 px leaves them 22 px
  from the top of the window, over the toolbar row that holds the List / Graph switch.
- Fix: hide them the sr-only way until focus (`clip-path: inset(50%)` / `width: 1px` and restore on `:focus`), or give the
  toolbar a clipping wrapper (`overflow: clip` on a positioned ancestor that does not clip the popover), or anchor them at
  the top of the Knowledge view instead of the toolbar.
- Checkable: with the Graph view open and nothing focused, `elementFromPoint` over the toolbar row never returns a skip
  link and no `.skip-link` box is inside the viewport.

### M5. Retire gives no visible confirmation and no Undo; the pane silently shows the next item

- Where: the detail pane's Retire button and the row menu's Retire. Shots 17 (after retiring the risk), `measure.json`
  `afterRetireVisibleText`.
- Steps: open "Legacy export format undocumented", click Retire.
- Seen: "Retired Legacy export format undocumented." is spoken through the sr-only status only; visibly the row
  disappears, "5 of 5" becomes "4 of 4", the Risks chip vanishes, and the pane now shows "Kickoff call summary" with its
  own Retire button. Getting it back means knowing to turn on Show retired, find the row, and press Restore.
- Why it matters: a first-time user cannot tell whether the retire worked or whether they just retired the wrong thing
  (the pane changed to another item), and the spec's "retire is reversible" promise is invisible at the moment it
  matters; a second click on the (moved) Retire button retires the next item.
- Fix: a visible, dismissable notice under the toolbar or beside the count line for about 8 s: "Retired Legacy export
  format undocumented. Undo" (`Button` link), the same for Delete without Undo ("Deleted …"), and the same wording as
  the status region. Alternatively keep the pane on the retired item (badge Retired, button Restore) and move only the
  list selection.
- Checkable: after Retire a visible element contains "Retired <name>" and an Undo control; the pane's primary button
  is not another item's Retire until the user picks another row.

### M6. The reason an agent gave for retiring a fact never reaches the Knowledge tab

- Where: Acme Corp's retired fact (shot 14) versus the transcript row "Retired fact Fiscal year ends in March
  (Corrected: fiscal year ends in April)" (shot 06).
- Steps: open Acme Corp, switch Show retired on; search "April".
- Seen: the fact shows "Fiscal year ends in March" with a Retired badge and a menu Restore / Remove; no line says why,
  and the corrected value exists nowhere in the graph (search "April": "0 of 5 items"). The History block does not
  mention the retirement either (it was the agent's, in the same run).
- Cause (read in code): `KnowledgeFact` has no reason field; the tool's `reason` is "for the run transcript" only
  (`harnessTools.ts`). The mock does not record the April fact.
- Why it matters: the whole point of retire over delete is keeping the record; here the record keeps the wrong value
  and drops the correction, so the consultant must go back to the transcript to learn the fiscal year.
- Fix: a contract ask for the runtime lead: `KnowledgeFact.retiredReason` (and `retiredBy` / `retiredAt` from the
  source), filled from the tool's `reason`; then the pane shows "Retired: Corrected: fiscal year ends in April" under the
  fact and History gains "Retired a fact (Engagement Lead in R1): …". Until then, the prompt could tell agents to record
  the corrected fact when they retire one.
- Checkable: searching "April" finds Acme Corp; the retired fact row shows the reason text.

### M7. Focus falls to the page body after four navigations

- Where and seen (`results.json` `runMetaLanding`, `openKnowledgeLanding`, `historyRunLink`, `kbAfterHide`):
  - RunMeta "Recorded 8 items": the Knowledge tab opens, `document.activeElement` is `body`.
  - Settings > General "Open Knowledge": the same.
  - The History block's run link "R1 Summarise the kickoff call": the Live tab opens on the run, focus on `body` (shot 47).
  - The pane's "Hide item details" (keyboard pass at 1024): the pane collapses to its rail, focus on `body` (shot 45).
  By contrast the transcript's Open link lands on the detail heading (shot 09), and Skip to list / Skip to detail land
  on the filter form and the pane body.
- Why it matters: a keyboard user restarts from the window's first Tab stop after each of these; the dashboard re-walk
  fixed the same pattern for its rows (`continueFromHistory`, "land focus on a real element, else the topbar h1").
- Fix: after `setView('knowledge')` from RunMeta or Open Knowledge, focus the selected row, else the list's first row,
  else "Add a note" (the view already has `focusRow`); after the run link, focus the run's selected tab or the composer
  (as `focusRun` callers do elsewhere); after Hide, focus the rail's "Show item details" button.
- Checkable: `document.activeElement` is never `body` after each of the four actions.

### L1. The relation note "Sponsor sign-off" is an unlabelled line under the relation

- Shots 13, 15: "Migrate billing to Stripe decided by" then "Sponsor sign-off" on the next line in the same colour as a
  fact. A first-time reader cannot tell it belongs to the relation. Fix: quiet italic with a label ("Note: Sponsor
  sign-off") or a `title` on the relation line, and the same in the graph's edge title (it already appends it).

### L2. The History line's tooltip is in US format while the text is in the app's format

- `results.json` `janeHistory`: text "4 Nov 2026 13:24", `title` "11/4/2026, 1:24:36 PM" (`formatFullDateTime` uses
  `toLocaleString()`, read in code). Fix: format the tooltip through the same helper with seconds ("4 Nov 2026 13:24:36").

### L3. A retired note's History reads a bare "Retired"

- Shot 22: "Recorded by Engagement Lead in R1 …, 4 Nov 2026 13:24 / Edited by you, 4 Nov 2026 13:26 / Retired". The
  spec lists this as a deviation (notes carry no who); the date is still known. Fix: "Retired, 4 Nov 2026 13:27" from the
  note's `updatedAt` until the contract carries who.

### L4. "Clear search" under "No items match these filters." when no search text was typed

- Shot 12 (origin "You 0" pressed). Fix: "Clear filters" when the query is empty (the button already clears both).

### L5. The "Agent" badge on every row of the All view when every row is the agent's

- Shot 10: five rows, five "Agent" badges; the provenance line already says "Engagement Lead · R1". Spec'd (rec 8),
  noted for a later pass: show the badge only when both origins are present.

### L6. Esc on the detail heading does nothing in Graph view

- `measure.json` `graphEscActive`: after Enter on a node opened the pane, Esc leaves focus on the heading. In List
  view Esc returns to the row. Fix: in Graph view return focus to the selected node (`.react-flow__node[data-id]`).

### L7. "Show all" at 1024x640 with the pane open is unreadable

- Shot 41: five cards fit at about zoom 0.4 in the 408 px stage; names are not legible. Expected with three cards per
  row at 220 px; a hint ("Hide the details pane for a bigger picture") or an automatic pane collapse on Show all at
  this width would help. The depth-1 neighbourhood at 1024 is readable (shot 40).

### L8. RunMeta's cost is clipped at 1024 beside "Hide finished agents (2)"

- Shot 48 (Live at 1024): "3 agents · Recorded 8 items · 2m 14s · $0.01" then the switch. "Recorded 8 items" adds
  a chip to a row that already drops items under 420 px; at 1024 the cost loses its last digits instead of dropping.
  Fix: drop the cost before clipping, or shorten the recorded chip ("Recorded 8").

### L9. The Knowledge view is not remembered across a relaunch

- After a relaunch the app opened on the Dashboard; the project's open run tab was restored, the Knowledge tab choice
  was not (by design: views are not persisted). Only noted because a consultant who lives in Knowledge will reopen it
  each morning.

### L10. Edge labels disappear under zoom 1 with no visible hint

- Shot 28: after Show all (zoom 0.71) the relation words are only in the SVG tooltip and the spoken names; a first-time
  user has no cue that zooming in reveals them. Fix: a quiet toolbar hint "Zoom in to read relations" while labels are
  hidden, or always show labels for 10 or fewer edges.

## Fix list for the UI Lead (ordered by severity)

1. M1 Scope `.knowledge-row` to the list (or rename the transcript write row's class and testid) so the transcript
   rows are icon + text rows that grow with their output; update `e2e/knowledge-run.mjs`.
2. M4 Hide the graph's unfocused skip links the sr-only way (or clip them); they are visible and clickable above the
   toolbar now.
3. M3 Pick edge handles by relative position in top-down and left-right layouts so a relation never loops out of the
   bottom of the lower node into the top of the upper one.
4. M2 Make every count say what it counts: RunMeta "Recorded 4 items, 2 relations, 1 note, 1 correction" (or
   "8 changes"), the Settings line with the item total and kinds, Clear with "6 facts (1 retired)".
5. M5 A visible "Retired <name>. Undo" notice (and "Deleted <name>.") beside the count line, or keep the pane on the
   retired item with Restore.
6. M7 Land focus after RunMeta, Open Knowledge, the History run link and Hide item details.
7. M6 Contract ask to the runtime lead (`KnowledgeFact.retiredReason` with by / at), then show it under the fact and in
   History; meanwhile have the prompt ask agents to record the corrected fact when they retire one.
8. L1-L10 as above: relation note label, tooltip date format, retired note date, "Clear filters", the Agent badge
   only with mixed origins, Esc from the heading in Graph view, a Show-all hint at 1024, the clipped cost chip, the
   hidden-labels hint.

## Not driven

- Reduced motion, the canvas node styles (compact, station, hex), backdrops, the minimap and the radial / left-to-right
  layouts on the graph: covered by `e2e/knowledge-graph.mjs` (read), not walked here.
- The 150-item "Show all" warning, list windowing past 100 rows, the 200-note and 2,000-item caps and their disabled
  reasons, a refused agent write ("Failed: …"), a "Retired relation" transcript row and a chain with recorded items in
  an earlier member: mock-limited (the mock records 4 items, 2 relations, 1 note and retires one fact).
- The empty states "The team has not recorded anything yet" and "Only retired items." (read in code).
- The main-side `show-knowledge` menu item (not built), real Claude or Codex row order (the pairing of write rows is
  unit-tested only), screen-reader output (status texts were read from the DOM).
- Contrast was judged by eye in both themes, not measured; System theme not driven.
- The native folder picker, the setup interview, a second engagement's data isolation (one engagement only in this walk).
