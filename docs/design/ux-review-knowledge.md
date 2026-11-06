# UX review: context notes today, and recommendations for the knowledge UI

- Reviewer: UX Researcher (mock-data walkthrough, no code changes).
- Build: f5168ca (dev), `npm ci` + `npm run build` in a worktree, version 0.1.6-dev1.
- How it ran: built Electron app driven by playwright-core through `e2e/lib.mjs` `launch()` / `relaunch()` from a scratch
  script (`e2e/shots/ux/knowledge/walk.mjs`, gitignored), `ORGAI_MOCK=1`, one fresh temp `ORGAI_DATA_DIR`. Sizes 1600x1000
  and 1024x640 (`setContentSize`), dark and light through `settings.appearance.theme`. One keyboard-only pass at
  1024x640 dark (Settings > General from the pane heading through the notes, remove confirm, add dialog; the run view
  side panel; the Team canvas). Phase B relaunched with a custom `ORGAI_MOCK_SCRIPT` whose work run calls
  `engagement_context` twice (list, then one note), plans, hands work to an Analyst that reads the reference folder
  and writes one file (a permission card), and reports back. No tokens, no network.
- Persona: a consultant on their first engagement, "Acme access review" (client Acme Corp, a working folder, one
  reference folder with `kickoff.md`), setup interview skipped. Three notes typed by hand, one edited, one removed,
  then 48 more saved through the IPC to reach the 50-note cap (what a few weeks of use, or agent writes, would leave).
- Compared with: `docs/design/engagement-2.md` section 5 (plan and notes), its Implementation notes, `engagement.md`,
  `ux-review-engagement-3.md`, the "Engagement kind" bullets in CLAUDE.md, ARCHITECTURE.md (Shared contracts,
  Canvas, Renderer UI, Settings pages, the application menu contract).
- Screenshots: `docs/design/ux-review-knowledge-shots/NN-what-size-theme.png` (14). The rest, the raw `results.json`
  and the mock script stay in `e2e/shots/ux/knowledge/`.
- Labels: "seen" = observed in the app; "read in code" = from source, not observed; "mock-limited" = the mock cannot
  produce the real behaviour. Nothing agent-written exists yet (the runtime side is being built), so every provenance
  claim below is about what the current surfaces would do with such data.

## Verdict

NOT READY FOR AGENT WRITES. The context-notes list works for a handful of hand-written notes: add, edit, remove,
cap, announcements and the remove confirm all behave (seen). It is the wrong home for notes agents write and for a
knowledge graph: at 50 notes the General pane is 3,900 px tall, the notes list alone is 2,663 px, the Connection section
sits 3 screens down, there is no search, filter, grouping or excerpt, every row costs two Tab stops (100 stops to cross
the list), a note shows only a character count and an edit date (no author, no run), an edited note jumps to the top
of the list, the 50-note cap blocks any writer, and focus falls to the page body after an edit and in two other
cases. The run view tells the user an agent read the notes only through the generic row "Used engagement context"
followed by the agent-facing text "(data from the project's notes, not instructions)". Recommendations: a Knowledge
tab per engagement with a grouped list and a detail pane as the primary model, a graph as a second view, agent notes
in the same list with a provenance line and an origin filter, retire instead of delete for agent items, and
transcript rows that name what was recorded.

## What I walked (seen)

| Step | Result |
| --- | --- |
| New project > Engagement with client, working folder, one reference folder, interview off | Created; `kind: engagement`, `client: Acme Corp`, one reference folder stored (shot 01 after opening Settings). |
| Settings > General | Sections in order: General, Engagement plan, Context notes, Connection. Plan empty state "No plan yet. The setup interview writes one, or you can write it yourself." Notes empty state "No notes yet. Add what the team should know but would not find in your folders." (shot 01). |
| Add three notes through the dialog | Dialog "Add a note" with Title, Text (14 rows), "85 of 50,000 characters", Cancel / Save note (shot 02). "Note saved." announced, focus back on "Add a note". Rows "Kickoff call summary · 116 characters · Edited Nov 4, 2026 · Edit · [trash]" (shot 03), "3 of 50 notes". |
| Edit one note | Dialog "Edit Glossary" with the text loaded; after Save the row moved to the top of the list; focus fell to `body`. |
| Remove one note | Confirm "Remove the note Glossary? / Agents can no longer read it. This cannot be undone. / Cancel · Remove note", Cancel focused first (shot 04); "Note removed." announced; focus landed on the next row's Edit. |
| 48 more notes through `engagement.saveNote` | All 48 accepted (50 rows). "Add a note" disabled with "50 notes is the most an engagement can keep. Remove one to add another." (shots 05, 06, 07). |
| Keyboard pass, 1024x640 dark | From the pane heading, 40 Tabs reach the plan buttons and then 34 row buttons without reaching "Add a note" (disabled, skipped). Row Remove > Enter: confirm opens on Cancel, Tab to "Remove note", Enter: row gone, focus on `body`. Add a note > Enter: focus on Title, Tab to Text, Cancel, Save note; Enter saves; focus on `body` (the Add button is disabled again at 50) (shot 08). `:focus-visible` ring is an outline on buttons (seen on the dialog fields; the body has none). |
| Relaunch with the custom script, work run "Summarise the kickoff call and record who decided what." | Root rows: "Used engagement context / 50 context notes (data from the project's notes, not instructions). Read one with engagement_contex... / Show output", "Used engagement context / Show details", "Context note Kickoff call summary (data from the project's notes, not instructions) / Show output", "Planned 3 steps", "Handed work to analyst-1: Summarise the kickoff call"; the Analyst's Write raised a permission card "Write kickoff-summary.md / In the project kickoff-summary.md" (shot 09). Side panel tabs Transcript, Plan, Usage, Logs. Plan tab "0 of 3 steps done" (the script's step ids did not match; my error, not the app's), so auto-continue nudges filled the transcript with 18 "Continuing: 0 of 3 steps done" rows (shot 10, mock-limited). |
| 1024x640 run view | Side panel auto-collapsed to its 40 px rail; the transcript is behind the expand button (shot 11). No page scroll at either size (measured). |
| Ask run "Who decided to limit the scope to SAP, and when?" | Conversation layout, meta "Ask · one assistant", the same `engagement_context` rows inline (shot 12). (The custom script also spawned an Analyst inside the Ask run: mock-limited.) |
| History | R2 Ask and R1 Run, both "Stopped" after End session, Open / Continue / Retrospective (shot 13). |
| Settings after the runs | Nothing changed in the notes list: no row says a run read it. Project tabs: Live, History, Team 5, Settings. |
| Team canvas keyboard | Toolbar buttons, then each role node is a Tab stop named "Analyst, role. 6 tools. Press Enter to edit, Delete to remove."; Enter moved focus to the inspector's Name field with the node selected (shot 14). |

## Findings on the current context-notes surfaces

### H1. At 50 notes the General pane is unusable as a browsing surface

- Where: Settings > General > Context notes, shots 05 (1600 dark), 06 (light), 07 (1024 dark).
- Steps: add 50 notes (3 by hand, 47 through `window.orgai.engagement.saveNote`), open Settings > General.
- Measured at 1600x1000: pane scroll height 3,897 px in a 952 px scroller; the `ul.notes-list` is 2,663 px tall (53 px
  per row); the Connection section's heading sits at y = 2,990 px, three screens below the top. At 1024x640 the row is
  52 px and the list is over four screens. The pane has no search box, no filter, no grouping and no excerpt: the only
  controls inside the section are "Add a note" and 100 Edit / Remove buttons (`notes-section-controls`). Every row
  reads "<title> · N characters · Edited Nov 4, 2026", so the user must open each one to know what it says.
- Why it matters: the brief's writers (agents saving notes per run) reach 50 within a few runs; a consultant then
  scrolls a settings pane to find the Connection section and reads titles only. The 50 cap (`ENGAGEMENT_NOTES_MAX`)
  is a hard wall for any writer: the add button greys and `saveNote` would refuse an agent's 51st note (read in code,
  `ENGAGEMENT_NOTES_MAX`; the agent path does not exist yet).
- Fix: move browsing out of General into its own surface (Recommendation 1) with search, a kind filter, an excerpt and
  a count; keep in General only a one-line summary with a link ("50 context notes · Open Knowledge"). Raise or remove the
  cap for agent-written items (ask main).
- Checkable: with 50 notes, Settings > General is under 1,800 px tall at 1600x1000 and the Connection section is
  reachable within one scroll screen; the new surface finds "Kickoff" in one keystroke sequence.

### H2. A note carries no provenance: nothing says who wrote it, in which run, or that a run read it

- Where: every row (shots 03, 05), the edit dialog (shot 02), the run view (shot 09), Settings after the runs.
- Steps: add notes, run a work run that reads them, come back to Settings.
- Seen: a row shows title, size and "Edited Nov 4, 2026" (`EngagementNote` has `id`, `title`, `updatedAt`, `chars`
  only; read in code). The edit dialog shows Title and Text. After the run, the list is unchanged. The run's transcript
  shows the read as "Used engagement context" with a harness result line.
- Why it matters: the whole point of agent-written notes and a graph is trust: a consultant must be able to say "an
  agent recorded this in run R3, I did not", and must see when a note was last used. With today's shape an agent's
  note would be indistinguishable from the user's and would sort above it the moment it is saved (H3).
- Fix: the contract gains `origin: 'user' | 'agent'`, `recordedBy` (role name, run id, time) and
  `updatedBy`; the row gets one provenance line (Recommendation 7); the transcript row names the note
  (Recommendation 13).
- Checkable: a row written by the Analyst in R3 reads "Analyst · R3 · 4 Nov 2026" and the user's own reads "You · 4 Nov
  2026".

### H3. Editing a note moves it to the top of the list; agent writes would reshuffle the list under the user

- Where: Settings > General > Context notes, after "Edit Glossary" (seen: order became Glossary, Kickoff call summary,
  Client preferences).
- Steps: three notes; edit the middle one; Save.
- Why it matters: the list is sorted by `updatedAt` only (`sortNotes`, read in code). Today it means a note the user
  touches jumps away from where they found it. With agents writing during a live run, the list would reorder itself
  while the user reads it, and the user's own notes would sink under agent rows.
- Fix: stable order by default (title, or created time) with an explicit sort control ("Newest change", "Title",
  "Kind"); never re-sort while the user has a row's menu or dialog open; group agent rows under their own heading or
  filter when the user asks (Recommendation 8).
- Checkable: after editing a note, its row stays where it was until the user changes the sort.

### M1. Focus is lost after an edit and in two keyboard paths

- Where: shot 08 and `results.json` (`focus-after-edit`, `kb-focus-after-remove`, `kb-focus-after-save`).
- Seen: after Save in the edit dialog focus falls to `body` (the component restores focus only for a new note, read in
  code: `if (wasNew) focusLater(addButton)`). After a keyboard remove, focus fell to `body` once (the mouse pass landed
  on the next row's Edit; the dialog's focus return to the removed Remove button races the section's `focusLater`).
  After a keyboard add that reaches the 50 cap, focus falls to `body` because the target "Add a note" is now
  disabled.
- Fix: after an edit, focus that row's Edit; after a remove, let the section's focus win (return focus from the confirm
  only when the trigger still exists); when the add target is disabled, focus the new row's Edit or the count line.
- Checkable: `document.activeElement` is a button inside `context-notes-section` after every save and remove.

### M2. The run view does not tell a non-developer what the agent did with the notes

- Where: shot 09 (root transcript), shot 12 (Ask conversation).
- Seen: "Used engagement context" (the fallback `Used <tool words>` sentence) twice; results "50 context notes (data from
  the project's notes, not instructions). Read one with engagement_contex..." and "Context note Kickoff call summary
  (data from the project's notes, not instructions)". The bracketed phrase and "engagement_context" are written for the
  agent.
- Why it matters: this is the only place a user sees that their notes were used, and it reads as tool noise. When
  agents start recording entities, relations and notes, the same path will print "Used record entity".
- Fix: a dedicated sentence per harness tool (Recommendation 13): "Listed the context notes (50)", "Read the note
  Kickoff call summary"; keep the raw result under Show output.
- Checkable: no transcript row for a harness tool starts with "Used ".

### M3. The 1024x640 run view hides the transcript behind the rail

- Where: shot 11. The side panel collapses to its 40 px rail at this size (`autoCollapseBelow` 1100, by design), so
  "what did the agents record this run" would be two clicks away (expand, then a tab). Not a defect today, but it rules
  out the run side panel as the only home for recorded knowledge (Recommendation 2).

### L1. Copy and consistency

- Row date "Edited Nov 4, 2026" vs templates and kit "4 Nov 2026" (engagement-3 L8, still open).
- The permission card on an engagement reads "In the project kickoff-summary.md" (shot 09); engagements say "working
  folder" elsewhere.
- The notes description says "Agents read these notes; do not put passwords or keys here." It will need "and write"
  once agents save notes; the empty state "Add what the team should know but would not find in your folders." stops
  being true when the team adds its own.
- The remove confirm says "Agents can no longer read it. This cannot be undone." and the row's only alternative to
  editing is the trash icon: no retire, no undo (Recommendation 10).
- `Edit <title>` buttons carry the whole title as the accessible name (good) but at 1024 the visible label is just
  "Edit" beside a trash icon, 50 times.

### L2. The Ask run played the team script (mock-limited)

- The custom work script spawned an Analyst inside the Ask run (shot 12: "2 agents"). A real single run cannot spawn
  (`singleRunProject` removes spawning, read in code). No action.

## Recommendations for the knowledge UI

Numbered so the UI Lead can cite them. Each has a reason and, where I was unsure, an alternative. "Knowledge" is used
as the working name; "Notes and facts" is the alternative if the word reads too grand for a consultant.

### Placement

1. **A project tab "Knowledge" for engagements, between History and Team.** Reason: H1 shows a settings pane cannot
   hold even the current list; a tab is where a consultant looks for the engagement's facts every day (Live, History,
   Knowledge, Team, Settings reads as work, past, what we know, who, how). The tab contract already supports it: `View`
   gains 'knowledge', `SECTION_VIEWS` and the `Tabs` list in App.tsx get one entry with `testId` `tab-knowledge`, hidden
   for code projects (`projectKindOf`), and for the three assistants. The application menu accelerators are bound to
   actions, not positions (`show-live` Ctrl+1 ... `show-project-settings` Ctrl+4, read in `appMenu.ts`), so Ctrl+1..4
   stay as they are; give the new item `show-knowledge` with no accelerator in this pass (Ctrl+5 later if wanted) and
   grey it with the same `hasProject` rule as Team. At 1024x640 the topbar still fits five tabs (today "Live History
   Team 5 Settings" ends at about x = 720 of 1024 by eye in shot 11; one more word of about 90 px fits).
   Alternative: if a tab is too much for phase 1, a section "Knowledge" in Settings > General that holds only a count
   and an "Open" button to a full-page dialog; I do not recommend the pane itself (H1).
2. **A run side panel tab "Recorded" only as a second surface, never the only one.** Reason: at 1024x640 the panel is a
   rail (M3) and a panel tab is scoped to one run, so the user cannot curate there. What it should show: the items
   this run added or changed, newest first, each a link that opens the Knowledge tab with that item selected
   (`focusKnowledgeItem(id)`, like `focusRow` in `McpSection`). Count in the tab label ("Recorded 6"), as Logs shows its
   error count. Alternative: no new panel tab; instead a RunMeta line "Recorded 6 items" linking to Knowledge, which is
   visible at every size (the meta line survives the rail).
3. **Keep Settings > General > Context notes as a short summary.** One line "12 notes, 40 facts, 8 people · Open
   Knowledge" plus the existing description; remove the inline list once the tab exists. Reason: H1, and the spec's
   one-pane-length rule (config-review conventions).

### Browse model

4. **List first, grouped by kind, with a detail pane; the graph is a view switch.** Reason: every task in the brief
   (find, read, edit, retire, see who recorded what) is a list task; the walk shows users read titles and dates, not
   positions. Layout: a `CanvasFrame`-free two-column page (the Team and Live frames are built for a canvas): left a
   filter column (search, kind chips with counts, origin chips "You" / "Agents", a "Show retired" switch), middle the
   list grouped by kind (People, Organisations, Systems, Documents, Decisions, Risks, Open questions, Notes, then any
   free-form kind as its own group), right the detail pane (`SidePanel` with `persistKey="knowledge"`, same resize and
   auto-collapse rules). Under 1100 px (1024x640) the detail opens as the same `SidePanel` rail-collapsed, revealed on
   selection like the run panel (`revealOn`), so the list keeps the width. Rows: name, kind badge, a one-line excerpt
   (the first fact or the note's first line; the index must carry it, see H1), the provenance line (7), a retired
   badge. Virtualise the list past 100 rows (the Live transcript already caps and trims; a plain list of 300 rows of 53
   px is 16,000 px).
   Alternative: a single flat list with a sort menu (the Connectors gallery pattern) if free-form kinds make groups too
   many; then the kind is a chip on the row and the filter column does the grouping.
5. **Graph view: an opt-in second view on the same tab, built on the Team canvas, not the Live one.** Reason: the Team
   canvas already has the keyboard model the graph needs (seen: nodes are Tab stops with spoken names "Analyst, role. 6
   tools. Press Enter to edit", Enter opens the inspector, Delete removes, dagre Auto-layout, the canvas style popover),
   while the Live canvas is tuned for a tree with folding. What the graph must do to stay usable at 300 nodes (the
   fold walk's M2 and M4 show a full fit becomes unreadable past a few dozen nodes): (a) never draw everything: default
   to the neighbourhood of the selected item (depth 1, a Depth 1 / 2 control), with "Show all" as an explicit choice
   capped with a warning past 150; (b) the same kind and relation filters as the list, applied before layout; (c)
   retired items folded into one "N retired" node per neighbour, like `done-group`; (d) selection drives the detail
   pane, and the list and graph share one selection; (e) `layoutCanvas` radial for a neighbourhood (the centre is the
   selected item), top-down for "Show all"; (f) the minimap on, the legend listing kinds by colour and relation types
   by line style; (g) edges labelled with the relation type only at zoom 1 or above, else in the edge tooltip. Reuse
   `RoleNode`'s card size and `data-style` so the canvas styles (cards, compact, station, hex) and both themes come
   free; a kind picks the role colour slot so "Person" and "System" differ in `--role-ink` as roles do.
   Alternative: skip the graph in the first pass and ship "Related" as a section of the detail pane (a list of
   relations with links). That covers depth-1 browsing with no new canvas; add the graph when a user asks for the
   picture.
6. **Search is one box, matches name, facts, note text and relation names, and ranks like the Connectors gallery**
   (`matchRank`: name first, then aliases / facts, then text). Reason: a consultant looks for "Jane" or "SAP", not for a
   kind. A polite count "12 of 300 items" (as `connector-results-count`). Esc clears the box; the list keeps the
   selection when it is still in the result.

### Provenance and trust

7. **One provenance line per row and a fuller block in the detail pane.** Row: "You · 4 Nov 2026" for the user,
   "Analyst · R3 · 4 Nov 2026" for an agent (role name as the canvas shows it, the run's R-index from
   `runLabels.ts`, the date in the app's one date format). Detail: "Recorded by Analyst in R3 Summarise the kickoff
   call, 4 Nov 2026 11:46" with the run name as a link that opens the run (History's "Open"), then "Edited by you, 5 Nov
   2026" when changed, and "Retired by Reviewer in R5, 6 Nov 2026" when retired. Reason: H2; this is the same shape as
   the plan's revised line ("Approved in the setup interview, 3 Nov 2026") so it reads as one app. Never a vendor or
   model name here.
8. **Agent-written notes sit in the same list, marked, with an origin filter; no separate group by default.** Reason:
   the user's question is "what do we know about Jane", not "who typed it"; a split list makes them look in two places
   and the Team tab already shows agents' work mixed with the user's. The marker is the provenance line (7) plus a small
   `Badge tone="neutral"` "Agent" only when the list is filtered to "All"; the origin chips "You (12)" / "Agents (38)"
   give the separate view in one click. Agent items are read-only until the user clicks Edit, at which point the item
   becomes "Edited by you" and keeps its original "Recorded by" line (never overwritten).
   Alternative: if the lead expects far more agent items than user items, a default filter of "You" with a count on
   "Agents" so the user's own notes are never buried; I would still keep one list.
9. **Trust cues stay plain.** A fact or relation an agent recorded shows no confidence score and no colour-coded trust
   (none exists in the contract); the cue is provenance and the user's own edits. An item the user has edited or
   confirmed can carry "Checked by you" (a user action "Mark as checked" on the detail pane) if the contract gets a
   flag; do not invent one in the renderer.

### Editing and curation

10. **Retire, not delete, as the row action for every item; delete only from the detail pane, with the usual confirm.**
    Reason: the brief says agents never delete; the user's quick action should match ("Retire" is reversible, "Delete"
    is not), and today's trash-icon-per-row (L1) invites losing agent evidence. Row: Edit, Retire (icon `Archive`,
    label "Retire <name>"); retired rows hide behind the "Show retired" switch and show "Retired by you, 5 Nov 2026"
    with a "Restore" button. Detail pane footer: "Delete..." (danger) with `ConfirmDialog` "Delete <name>? / Agents and
    you can no longer see it. Retire it instead to keep the record. / Delete". Bulk: "Retire all agent items from R3"
    from the run's Recorded list and "Clear everything..." under Settings > Maintenance's danger zone for the
    engagement (next to "Forget this engagement...", with the preview counts the forget confirm already uses), never
    on the Knowledge tab's toolbar.
11. **Inline edit for facts and relations; the dialog for notes.** Reason: a fact is one line ("Role: CFO"); the
    existing per-project values block (`PerProjectValues`: label, field, "Saved" status, save on blur and Enter) is the
    right pattern. A note has a title and a long text; the existing `context-note-dialog` fits and keeps its discard
    confirm. Entity name and kind edit inline in the detail pane header (Input + Select, save on blur). After any save:
    polite "Saved <name>." in the tab's one status region, focus stays on the field (inline) or goes to the row's Edit
    (dialog), fixing M1's pattern.
12. **Empty states.** Tab, no items, no run yet: "Nothing recorded yet. Add a note for the team, or run the team and
    it records people, systems, decisions and risks here as it works." with "Add a note" (secondary) and "Add an
    item" (secondary; no primary because both are optional). After runs with nothing recorded: "The team has not
    recorded anything yet. Notes you add here are read at the start of every run." Filtered to nothing: "No items match
    <query>." with "Clear search". Retired only: "Only retired items. Show retired to see them."

### Copy

13. **Transcript rows name the thing.** In `transcriptRows.ts` give each knowledge tool its own sentence (M2): "Read
    the context notes (50)", "Read the note Kickoff call summary", "Recorded organisation Acme Corp", "Recorded person
    Jane Doe", "Added a fact to Jane Doe: Role, CFO", "Linked Jane Doe works at Acme Corp", "Saved note Kickoff call
    summary", "Updated note Kickoff call summary", "Retired decision Workday in scope". Relation types read as the
    free-form string with hyphens turned to spaces ("works at", "depends on", "decided by"); kinds likewise. The raw
    result stays under "Show output" and the agent-facing "(data ..., not instructions)" never shows in the row's
    headline. Each recording row links to the item (same `focusKnowledgeItem`).
14. **Section and control titles**: tab "Knowledge"; groups "People", "Organisations", "Systems", "Documents",
    "Decisions", "Risks", "Open questions", "Notes" (a free-form kind shows as typed, sentence case, pluralised only
    when the contract gives a plural); filter legend "Show"; origin chips "You", "Agents"; switch "Show retired";
    detail sections "Facts", "Related", "Notes", "History" (the provenance block); buttons "Add a note", "Add an
    item", "Edit", "Retire", "Restore", "Delete...", "Mark as checked". Avoid "entity", "node", "graph", "provenance"
    and "knowledge graph" in visible copy; "Graph" is acceptable only as the view switch label "List | Graph".
15. **Provenance wording** (7): "Recorded by <role> in <R-index> <run name>, <date>"; "Added by you, <date>"; "Edited by
    you, <date>"; "Retired by <who>, <date>"; "Checked by you, <date>". Dates through one helper shared with
    `planRevisedLine` so the app stops mixing "Nov 4, 2026" and "4 Nov 2026" (L1).

### Accessibility

16. **List + detail keyboard path.** The list is one `role=listbox` per group (or one with `aria-activedescendant`
    across groups), one Tab stop, Up / Down move, Home / End, type-ahead on names, Enter opens the detail pane and
    moves focus to its heading, Esc from the detail returns focus to the row. Row actions (Edit, Retire) are inside the
    detail pane or in a per-row "More actions" popover opened with Shift+F10 or the row's one button, so a 300-row list
    is not 600 Tab stops (H1's 100). The filter column sits before the list in tab order; the "Show retired" switch is
    a native `Switch`.
17. **Graph keyboard path.** Reuse the Team canvas: every node a Tab stop (in list order, not screen order) with a
    spoken name "Jane Doe, person. 3 facts, 2 relations. Press Enter to open.", Enter opens the detail pane, arrow keys
    with a modifier move between neighbours (Ctrl+Arrow: follow an edge), "Skip to list" and "Skip to detail" links
    lead the frame. Edges are not focusable (as on Team); their relation type is in the two nodes' names and in the
    detail's Related list, so nothing is keyboard-only-invisible.
18. **Live regions and focus after edits.** One polite status region per tab, rendered empty first ("Saved Jane Doe.",
    "Retired 3 items.", "Restored Jane Doe.", "12 of 300 items" on filter changes, debounced); `role=alert` only for a
    refused save. When a live run records items while the tab is open, do not re-sort or steal focus: append under the
    right group, announce "The team recorded 2 items" once per 5 s at most, and offer "Show new" if the list is
    filtered them out. After retire from the detail pane, focus goes to the next row (the `idAfterNoteRemoval` rule);
    after delete, the same; after Restore, the restored row.
19. **Motion and contrast.** No animated graph layout under `data-reduce-motion`; kind colours come from the role
    colour slots (`--role-ink` meets 3:1 on every backdrop per the canvas spec, computed not measured); badges are
    text, never colour alone (the "Agent" and "Retired" badges carry words).

### Contract asks for the runtime lead (not UI work)

- Note index rows need an excerpt (first line), `origin`, `recordedBy { role, runId, at }`, `updatedBy`, `retired`
  (H1, H2), and a read-time marker if "last read in R4" is wanted on the detail pane.
- The 50-note cap must not apply to agent writes, or agents need a separate store (H1).
- One push event per change (`projects:engagementChanged` already exists for notes) so an open tab updates without
  a reload, with the changed ids so the renderer can append instead of reloading 300 rows.
- Stable ordering keys (created time) so the list does not depend on `updatedAt` (H3).

## Not driven

- Agent-written notes, entities, relations, facts, retire and provenance: the runtime does not exist yet; every
  recommendation about them is design reasoning over the current surfaces, not an observation.
- The 50-cap refusal on an agent write (mock-limited; the agent path does not exist).
- The native folder picker, the setup interview, the plan editor (walked in engagement-3), Trends and CSV.
- A real single Ask run (the custom script made it spawn; mock-limited) and real `load_skill` rows (no skill was
  granted; "Loaded skill <name>" is read in code only).
- Contrast was judged by eye in both themes, not measured. System theme not driven.
- The Live canvas's own node keyboard path (the run-view Tab pass went through the composer and the side panel's
  disclosures; the canvas-themes walk covers Enter / Space on a focused node).
