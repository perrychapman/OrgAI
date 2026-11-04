# Handoff: engagement knowledge graph (paused 2026-11-04, usage limit)

Request: "In engagements, the harness must be able to make its own context notes, dynamically structured to build a
knowledge graph of the engagement." Orchestrator run paused with the feature merged on local dev but NOT gated end to
end and NOT pushed.

## Where things are

- Local `dev` = 641ec4f, 28 commits ahead of `origin/dev` (b90571b, pushed by a peer run; its CI 41875399600 was green).
- Landed on dev (all merged, tree clean, no leftover worktrees except the one below):
  - Runtime (Runtime Lead, merged 0a00571 + store fix be13a23): contract in `src/shared/types.ts` "Engagement
    knowledge graph" section, pure helpers `src/shared/knowledge.ts`, store `src/main/store/knowledge.ts`
    (`<data>/projects/<id>/knowledge.json`, KNOWLEDGE_FILE_MAX_BYTES, unreadable-file guard), IPC `knowledge:*`
    (ipc.ts `knowledgeArgs`), preload `window.orgai.knowledge`, harness tools `engagement_knowledge` and
    `engagement_context` save (harnessTools.ts), RunManager wiring (provenance, KNOWLEDGE_RUN_WRITES_MAX, harness rows,
    `engagementChanged` push), prompts. Notes gained excerpt / createdAt / source / recordedBy / updatedBy / retired;
    ENGAGEMENT_NOTES_MAX 200. Reviewer: H1 + M1 + M2 fixed; open Lows L5, L7, L8 in ARCHITECTURE.md Risks.
  - Mock: `[mock:knowledge]` (mock.ts, 9fc5a25).
  - Renderer (UI Lead, e35da8c / 858f664 + Graph view 2c6e337): Knowledge tab for engagements (`views/KnowledgeView.tsx`,
    `components/knowledge/*`, `lib/knowledge*.ts`, `lib/dates.ts`), transcript rows, RunMeta "Recorded N items",
    Settings summary line, Maintenance "Clear everything…", e2e `knowledge.mjs` / `knowledge-graph.mjs` /
    `knowledge-run.mjs` in e2e:free. Two Reviewer passes, no Critical/High left. Spec `docs/design/knowledge.md`.
  - Docs: CLAUDE.md runtime + renderer bullets, ARCHITECTURE.md Shared contracts / Runtime core / Renderer / Risks.
  - UX: pre-build walk `docs/design/ux-review-knowledge.md`, post-landing walk `docs/design/ux-review-knowledge-2.md`
    (no High; Mediums M1-M7, Lows L1-L10).

## In flight when paused

- `ui-lead-2` (worktree `.claude/worktrees/agent-a78acb6eb636af66d`, branch `worktree-agent-a78acb6eb636af66d`):
  fix-up of walk-2 Mediums M1 (transcript write rows reuse `.knowledge-row` / its testid and overlap), M2 (count
  wording), M3 (graph edge handles by relative side), M4 (graph skip links visible when unfocused), M5 (visible
  "Retired <name>. Undo" notice), M7 (focus after RunMeta / Open Knowledge / History run link / Hide item details).
  It was told to commit what it has and hand back without a Reviewer. Next run: `git log dev..worktree-agent-a78acb6eb636af66d`;
  merge it if it builds (`git merge`, then typecheck + `npm test`), or discard it and re-brief the fix-up.

## Gate status (why dev is not pushed)

- typecheck + `npm test` green at 858f664 (4,194 tests at the QA run). `npm run build` green at the QA run.
- Full `npm run e2e:free` was run ONCE on 2c6e337 + the package.json edit: 21/22 scripts green; `knowledge-graph.mjs`
  had 3 test-side failures, fixed in 2e04c1e (the three knowledge scripts then 92/134/70 green). The full chain has
  NOT been re-run on 641ec4f, and the ui-lead-2 fix-up will change strings in those scripts again.

## Remaining steps for the next run

1. Resolve the ui-lead-2 branch (above).
2. QA Engineer gate on the final tree: typecheck, `npm test`, `npm run build`, `npm run e2e:free` (token-free).
3. `git push origin dev`, then `gh run list --branch dev` and watch that run; a red run goes to the QA Engineer.
4. Final report: what landed (above), files touched (see the merge commits listed by `git log b90571b..dev --stat`),
   open items below.

## Open items (do not lose)

- Contract gaps: `knowledge:saveNode` has no `expectedUpdatedAt` (a fact an agent appends between the tab's fetch and
  the user's save is dropped); `KnowledgeFact` has no retire reason / by / at, so an agent's "Corrected: …" reason never
  reaches the tab (walk-2 M6); no application-menu `show-knowledge` item (menu contract in types.ts / appMenu.ts).
- Walk-2 Lows L1-L10 and knowledge.md section 13 Lows; runtime Lows L5 / L7 / L8; `knowledgeFileState` not exposed to
  the renderer; the tool still pre-reads a fact count instead of using the store's `factsAdded`.
- Never run live: no Claude or Codex run has called `engagement_knowledge`; everything is unit tests + the mock.

## Update at pause: the ui-lead-2 fix-up never started

Its branch was empty and has been deleted (no in-flight branch remains; `git worktree list` shows only the main
checkout). The walk-2 Mediums M1-M5 and M7 are all untouched. Pointers it gathered, so the next run can brief engineers
on disjoint files straight away:

- M1: `components/TranscriptPanel.tsx` `KnowledgeWriteRow` (~line 240) renders `div.entry.system.harness.knowledge-row`
  with `data-testid=knowledge-row`; `styles/knowledge.css` ~223 `.knowledge-row` (list row, 56 px flex column) breaks it;
  `styles/transcript.css` ~137 has `.knowledge-row .knowledge-row-open`. Rename to `knowledge-write-row` in the
  component, transcript.css, `e2e/knowledge-run.mjs` ~188-189, the CLAUDE.md "Knowledge tab" bullet and knowledge.md
  section 13.
- M4: `styles/knowledge-graph.css` ~28-35 positions `.knowledge-skip` inside the toolbar; `styles/ui.css` ~586
  `.skip-link` hides by `translateY(-200%)` only. Make `.knowledge-graph-toolbar .knowledge-skip:not(:focus)` sr-only;
  `e2e/knowledge-graph.mjs` ~228-232 checks the focused box is visible.
- M7: `RunMeta.tsx` ~112 and `ContextNotesSection.tsx` ~61 call `setView('knowledge')` only; use the store's
  `openKnowledgeItem({ projectId })` (useAppStore.ts ~1457) and make `KnowledgeView.tsx` (~271-276, `resolveFocus`)
  focus the selected row, else the first row (`listRef.current.focusCurrent()`), else `knowledge-add-note` when nothing
  resolves. History run link: `KnowledgeView.tsx` ~471 `onOpenRun` -> follow `components/dashboard/AttentionColumn.tsx`
  ~144 `settleFocus`. "Hide item details": `components/layout/SidePanel.tsx` `setCollapsed(true)` removes the focused
  button; focus the rail's "Show <label>" IconButton after collapse.
- M5: `KnowledgeView.tsx` `setRetired` (~297); add a dismissable notice "Retired <name>." with Undo
  (`setRetired(item, false)`), announced through `announce()` / `knowledge-status`; `e2e/knowledge.mjs` ~241-244 checks
  the status and next-row focus.
- M3: `lib/knowledgeGraph.ts` + test, `components/knowledge/KnowledgeGraph.tsx` (edges), `KnowledgeGraphNode.tsx` (one
  top target / one bottom source handle today), `KnowledgeGraphEdge.tsx`; pattern `lib/canvasShapes.ts` `messageSides`
  / `msgHandleId` as used by `views/LiveRunView.tsx` ~585 and `components/AgentNode.tsx` `MessageHandles`.
- M2: `lib/knowledge.ts` `knowledgeSummaryLine` (~344), `clearCountsLine` (~359) + tests ~188-191; `lib/dashboard.ts`
  `forgetConfirmText` / `forgetNoticeText` (~314, ~334) + tests ~327-362; RunMeta ~112-116; strings in
  `e2e/knowledge-run.mjs` lines 4, 125-137, 218, 250, 284, 297, 333, 338.
- Suggested split (disjoint files): A graph (M3 + M4), B tab (M5 + M7 view side incl. SidePanel.tsx), C run / settings
  (M1 + M2 + M7 trigger side + the two doc bullets).
