# Engagements and knowledge

Engagement kind (phases 1-3), reference folders, the engagement knowledge graph and retrieval, the Knowledge tab and graph view. Moved out of CLAUDE.md on 2026-11-07; see CLAUDE.md for the index.

## Main

- Engagement kind (phase 1, 2026-11-03; ARCHITECTURE.md Shared contracts, Conventions, Risks): `Project.kind`
  'code' | 'engagement' (read through `projectKindOf`; missing = code), `Project.referenceDirectories` (read-only
  folders), `Project.client`. Built-in roles, prompts and copy name no industry; the Architect specialises from its
  interview (`architectPrompt(kind)`, `engagementRoles`). Engagements write nothing into the working folder: the
  engagement document and saved rules live in `<data>/projects/<id>/` (store/projectData.ts), the document reaches
  agents through their prompt, maintenance's repository tools do nothing, isolateWriters is off unless the user sets
  it (`isolateWritersOn`), run messaging is off unless set (`runMessagingOn`). Reference folders: every adapter denies
  Edit / Write / MultiEdit / NotebookEdit and Codex file changes under one before any allow path
  (runtime/referenceDirectories.ts). A Bash / PowerShell call is reference-touching when its effective cwd (Claude hook
  `input.cwd`, Codex `req.cwd`, else the project path, followed through cd / pushd / Set-Location segments) is inside a
  reference folder or any word names a path at, under or above one (quotes removed, both separators, case folded on
  win32 and darwin, `~` expanded, prefix-safe). Such a call never matches a saved or session rule, gets no suggestion,
  is answered 'ask' with "<folder> is a reference folder: agents may read it, not change it; this command names it" (or
  "runs inside it"), carries `PermissionRequest.referenceFolder`, and RunManager (every adapter) drops its suggestions
  and ruleLabels and narrows any session or project allow to once (`permission.resolved` never has `savedToProject`).
  Reads are not told apart from writes (a `type` / `cat` asks too). A Read / Glob / Grep under a reference folder gets no
  suggestion. Edit-tool denials and Codex declined file changes write one harness transcript row "Refused: <file> is in
  a reference folder (read only)" (the folder in the detail). Engagements start on permission mode 'default'
  (`newProject`) and the engagement Architect recommends it; it proposes 'auto' only on request and says OrgAI still
  refuses edits in reference folders and asks before a command that names one. The Analyst keeps Bash and its prompt
  says to write only in the working folder. Shell check hardening (review fix): a UNC or device word (`\\host\share`,
  `//host/s`, `\\?\...`, `\\.\...`) counts as touching the first folder with no file-system access (resolving it would
  open an SMB connection), as does a UNC edit path, cwd or reference folder; `-Path:X`, `FileSystem::X` and bash `\x`
  spellings are checked, `HKCU:`-style non-file-system providers are not touching and (PowerShell only) any other
  `Name:\` word is; URLs (`://`) and `Foo::bar` words never are; a cd's own words are scanned (a cd into an ancestor of a folder, `cd ..` to a
  sibling's parent, asks; `Push-Location` counts as a cd), and after `cd -`, `popd`, `Pop-Location`, a bare cd or an
  untrackable target (a variable) EVERY later segment asks until a tracked cd (fail closed); a command over 32 KB asks
  with no file-system work, one with over 2,000 words or parts asks once that count is hit. `scratch.ts` `canonicalDeep`
  (every caller) never calls the file system for a network path (`isNetworkPath`: on win32 anything starting with two
  separators, on darwin `/net/` and `/Network/`) and returns it resolved lexically only. The refusal-row cleaner also
  strips U+E0100-E01EF. A `Bash` whole-tool rule
  never allows a touching command. Honest limits: a command that reaches a reference folder through a variable
  ($HOME, %USERPROFILE%), a link created at run time, a program's own config / script file, or a provider deciding by
  itself for calls OrgAI never sees (Codex commands that run inside its sandbox without an approval request; reference
  folders go to Claude as additionalDirectories, so the CLI may treat them as working folders for its own read-only
  command approval) is not detected; the permission mode decides those, and on Claude 'auto' the classifier still
  decides for them. Codex answers 'accept' (never acceptForSession) on runs with reference folders. Mock markers: `[mock:reference-edit]` (also writes the refusal row), `[mock:reference-shell]` (a root Bash
  `del "<first ref>\brief.md"` that asks with referenceFolder set). Verified by unit tests (fake query(), fake Codex
  app-server, mock, store, RunManager, profiler, setup service, prompt and nudge wording) only; unverified live: that a
  PreToolUse 'ask' prompts under 'auto' / 'bypassPermissions', and that Claude's hook `input.cwd` follows the Bash
  tool's cd.
- Engagement phases 2-3, runtime (2026-11-04; ARCHITECTURE.md Shared contracts "Engagement kind (phases 2-3, runtime)"):
  team templates (`setup/templates.ts`, templates:* IPC, `ProjectCreateInput.templateId`, propose_org_chart
  `fromTemplate` on setup runs), single-agent work runs (`RunTeam` 'single' on StartRunInput / RunSummary,
  defaults.ts `singleRunProject`, no plan nudges, no list_projects), the engagement document and context notes in
  `<data>/projects/<id>/` (projectData.ts; `expectedUpdatedAt` refuses a stale save) with the `engagement_context`
  harness tool (audience 'all', engagement work runs and single runs), `projects:remove` / `removePreview` returning
  `ProjectRemoveResult` (removeRuns default true; engagements always forget their runs), and usage export
  (`UsageStatsQuery.range` month, `runs:usageCsv` with formula-injection quoting, leading `project` and `client` columns (names from ipc.ts, client blank for code projects), `started` / `ended` as local ISO 8601 with the UTC offset plus `started_utc`; `RunUsageRow.team: 'single'` marks Ask runs and the CSV `kind` is then `ask`). Contracts sit in one types.ts section
  with their channels in `TEMPLATE_ENGAGEMENT_IPC`. Verified by unit tests and the mock only; no renderer uses it yet.
- Engagement knowledge graph (2026-11-04; ARCHITECTURE.md Shared contracts "Engagement knowledge graph", Runtime core
  "Engagement knowledge graph in runs", Risks): `<data>/projects/<id>/knowledge.json` (`src/main/store/knowledge.ts`,
  `knowledgeStore(dataDir)` = `KnowledgeStoreApi`; pure helpers in `src/shared/knowledge.ts`: `normalizeKnowledgeKey`,
  `matchKnowledgeNodes`, `resolveKnowledgeNode`, `searchKnowledge`, `knowledgeVocabulary`). Nodes `kn_`, edges `ke_`,
  facts `kf_`; free-form `kind` / `relation` normalised to `KNOWLEDGE_KEY_RE`; identity by id, else (kind, name) /
  (kind, alias) case-insensitive; edges unique per (from, to, relation); removing a node removes its edges; every item
  carries a `KnowledgeSource` main fills. Caps KNOWLEDGE_NODES_MAX 2000, _EDGES_MAX 5000, _NODE_FACTS_MAX 50,
  _RUN_WRITES_MAX 500 (per run, notes included; checked before the store call), _SEARCH_LIMIT 50, _FILE_MAX_BYTES
  64 MB (compact JSON; a write past it is refused, and a file that exists but did not parse to a graph reads empty
  and refuses every write so it is never overwritten; review H1); hidden characters and over-long strings refused,
  never cut; an agent never replaces a user-created entity's summary (appended as a fact, `summaryKept`; review M1).
  IPC `knowledge:get / saveNode / removeNode / saveEdge / removeEdge / clear`
  (`KNOWLEDGE_IPC`, preload `window.orgai.knowledge`, inputs rebuilt by ipc.ts `knowledgeArgs`, writes on engagements
  only, every write pushes `projects:engagementChanged` `what: 'knowledge'` with `ids`). Harness tools:
  `engagement_context` gained `action: 'list' | 'read' | 'save'` (agents create notes and replace only agent-written
  ones the user has not edited; "Only the user can change that note; save a new one instead."; ENGAGEMENT_NOTES_MAX is
  200 and reported at the cap) and `engagement_knowledge` (`KNOWLEDGE_TOOL`, audience 'all', non-blocking, engagement
  work runs only, never single / quick / setup-like / trust-restricted): vocabulary, search, get, upsert_node, link,
  retire (never deletes; refused on user-written items). Results are fenced data (`<<<` `>>>`, look-alike
  substitution, `datum()`); refusals read "REFUSED: ...". RunManager (`RuntimeContext.knowledge`,
  `engagementNotes.save`) fills the source (run id, agent id, role name from the agent record), writes one harness
  transcript row on the writing agent ("Recorded <kind> <name>", "Updated ...", "Linked <a> <relation> <b>",
  "Retired <item> <label>", "Saved note <title>") and broadcasts through `RunManagerOptions.engagementChanged`.
  Context notes carry `excerpt`, `createdAt` (order by it), `source`, `recordedBy`, `updatedBy`, `retired`. Prompts:
  engagement roots and reports are told to search the graph before dependent work and record what they learn; the
  single-assistant paragraph names note saving only. Verified by unit tests with fake stores and fake adapters only;
  no live run and no renderer yet.
  - Mock marker `[mock:knowledge]` (mock.ts `knowledgeSteps`, default script, engagement work runs): before the default
    script the root calls `engagement_knowledge` vocabulary, upsert_node for Acme Corp (organisation, alias Acme, facts
    "Headquartered in Leeds" / "Fiscal year ends in March"), Jane Doe (person, alias J. Doe), the decision "Migrate
    billing to Stripe" and the risk "Legacy export format undocumented", link Jane works-at Acme and the decision
    decided-by Jane (note "Sponsor sign-off"), `engagement_context` save "Kickoff call summary", search "Acme", then
    get Acme Corp and retire its March fact (`knowledgeFactId` parses the id from the fenced result; unparsable = the
    retire is skipped with an info log, never a failure), says "I recorded what I learned about the engagement." and
    goes on with the default script; on a code project (or without `ctx.knowledge`) it says "No knowledge graph is
    available in this run." instead. Each call goes through the real harness tools, so RunManager counts the writes
    and writes the harness rows. Unit-tested with fake `knowledge` / `engagementNotes` contexts (mock.test.ts).
  - Mock marker `[mock:knowledge-recall]` (mock.ts `knowledgeRecallSteps`, default script, engagement work runs): the
    `[mock:knowledge]` seeding steps, `knowledge_recall` "Acme billing" twice (the second answers "already shown"), "I
    recalled what the team knows.", then the default script with `mock-report-1`'s brief naming Jane Doe, so the row "Added
    1 known item: Jane Doe" lands on that report; "No knowledge graph is available in this run." plus the default script on a
    code project. `MockSession.deliveredMessages` holds what a model would receive (blocks included), and replies echo
    only the typed text. Unit-tested (mock.test.ts) and under the real RunManager and store (mockKnowledgeRecall.test.ts).
  - Adapter wiring of retrieval (`runtime/knowledgeDelivery.ts`, used by all three adapters): `knowledgeBrief` goes in every
    role prompt beside `engagementDocument`. `purpose: 'message'` on the first message (with hiddenContext) and each `send()`,
    `agentId` ROOT_AGENT_ID, the block beside the text and never in the transcript entry; empty text and `RESUME_TEXT` are
    skipped, `receive()` and harness messages never call it, a throw is caught and logged at warn. `purpose: 'spawn'`: Codex
    and the mock name the child after it is registered, so the row lands on it; Claude's PreToolUse appends the block to
    `updatedInput.prompt` with no `agentId` (the child's id arrives later with `task_started`), so no dedupe and the row
    lands on the root, and a later recall by that report may repeat what the block gave it. `knowledge_recall` caller:
    `caller.agentId` is ROOT_AGENT_ID for a known root, the agent id for a known report, undefined for unknown. On Claude
    (`HarnessCallerTracker.resolveKnown`) a tool_use id match is known; a first-in-first-out match counts only as the
    root and only with no report live; other tools keep `resolve`. On Codex an unbound thread is unknown. The bundled
    CLI 2.1.312 sets `_meta["claudecode/toolUseId"]` on tools/call (read from the binary's text). Unit-tested with a fake
    `query()` (claudeKnowledge.test.ts), a fake Codex server (codex.test.ts) and the mock. Unverified live: that the
    `_meta` key reaches the in-process server (without it, recalls with reports live read as unknown), and that a
    rewritten `updatedInput.prompt` reaches the subagent (only `name` and `isolation` were smoke-checked).
  - Round 2, retrieval (2026-11-05; ARCHITECTURE.md "Knowledge retrieval and inferred links"). `src/shared/knowledgeIndex.ts`
    (pure): `tokenizeKnowledge`, a ranked inverted index (`knowledgeIndexFor`, memo by graph object), `rankKnowledge` (per
    term, OR; name > alias > kind > summary > live facts; prefix for terms of 3+ chars; stopwords dropped),
    `searchKnowledge` now uses it and falls back to the old whole-query substring only when it finds nothing.
    `fenceDatum` / `fencedBlock` are the single implementation behind harnessTools `datum` / `fenced`. `recallKnowledge`:
    `text.length <= budget` always (default 1,500, 400..6,000), lines `id | name | kind | summary`, `  fact:`, `  ->` /
    `  <-`, `  ~ names: X (inferred)` (only `strongMentionLinks`), `  +N facts`, `id | name | already shown (fresh: true
    shows it again)`, `N more: A, B, ...` (at most 8 names, the count honest). A fact an agent wrote reads `  fact (agent):`.
    `KNOWLEDGE_RECALL_RELEVANCE_FLOOR` 0.2: only matches at or above that share of the best score get detail, so the budget
    is a ceiling, not a target. `knowledgeBrief`: <= 600 chars, fenced, in every agent's system prompt through
    `PromptFlags.knowledgeBrief` (after the team paragraphs, never beside the engagement document, which is the user's
    approved text). It carries only what no agent wrote: counts, kinds and relations from `KNOWLEDGE_COMMON_KINDS` /
    `_RELATIONS` ("+N other"), and most connected names of nodes with `source.by === 'user'`, never an alias
    (`upsertNode` never changes a stored name: an agent's spelling becomes an alias; tested). `knowledgeContextBlock`
    (exact name / alias matches in the first 64 KB of a text, <= 800 chars) reaches later turns unasked, so it prints name,
    kind, relations and only user-written summaries and facts, never an alias. `knowledgeNameMatcher` is the one matcher,
    a token trie: names over `KNOWLEDGE_NAME_TOKENS_MAX` (8) tokens are not matched as mentions, words of a name at most
    `KNOWLEDGE_NAME_GAP_MAX` (8) characters apart, at most `KNOWLEDGE_SAME_NAME_MAX` (16) entities per span,
    `find(text, budget?)`, a single-word name needs its own capitalisation, a single word in `KNOWLEDGE_COMMON_WORDS` is
    also refused at a sentence start, names under 3 chars skipped, longest match wins. One inference pass spends at most
    `KNOWLEDGE_MATCH_BUDGET` (4,000,000 units) and then `KnowledgeInferredResult.partial` says how far it got. Attack test
    `knowledgeMatcher.adversarial.test.ts`: the old matcher took 2,672 ms per fact and `timeout 120` killed the pass; now
    0.1 ms and 40 ms (names at exactly 8 tokens: the budget stops the pass at 241 ms). Values in `engagement_knowledge`
    results go through `knowledgeField` (no `|`, line break, `(inferred)` in any width) and `knowledgeListItem` (no comma);
    `fenceDatum` treats VT, FF, NEL, LS and PS as breaks and sanitize's one-line class refuses LS and PS (multi-line fields
    keep them). Stored text travels only inside a fence: a merge says `Merged into existing entity (kn_x): N facts added.`,
    a link `Linked kn_a works-at kn_b (ke_x, created).`, a retire `Retired fact (kf_x).`, a `get` starts `Entity (data
    from ...)` and `Created <kind> <name> (kn_x).` stays because those are the caller's own words of that call. A stored
    kind no longer appears in a refusal; a `get` fact line ends ` | by user` when the user wrote it. saveEdge: an agent
    never changes a relation the user wrote (`noteKept`, retired refused). A retired edge an agent wrote does not hold back a
    suggestion; a retired user edge does. Ambiguous mentions stay under 0.5 strength however often repeated.
    RunManager `bindKnowledgeReads` (same gate as `knowledge`, so single engagement runs included; never bare, quick,
    setup-like, trust-restricted or code): `knowledgeRecall` (harness tool `knowledge_recall`, audience 'all', read-only,
    never counts toward KNOWLEDGE_RUN_WRITES_MAX), `knowledgeContext` (off with `knowledgeAutoContextOn(project)` false,
    read at call time; `Project.knowledgeAutoContext` unset = on, junk dropped, never filled), `knowledgeBrief` (once per
    run, constant so prompt caching holds). Per-agent dedupe lives on ActiveRun (only for a named agent: no agent id = no
    dedupe, while the row still lands on the root; at most 500 agents; `complete` means everything live was printed,
    so an entity with a capped fact or relation list, hidden aliases or text the automatic block left out is never
    "already shown"; signature over the untrimmed content), `fresh: true` is the escape. A second per-agent map keeps an
    automatic block from repeating an entity it already gave. The automatic block matches only user-created entities by
    stored name (no alias, no agent-created entity) and prints a relation only when the edge and its other end are
    user-written (else "+N relations"), so on a graph mostly written by agents it rarely fires and agents call
    `knowledge_recall`; in a user message it follows the text under its own `---` separator (`withKnowledgeBlock`,
    first message via `KNOWLEDGE_BLOCK_MARK`), RESUME_TEXT lives in prompts.ts, and a recall on an 8 MB+ graph says
    "(Search index up to 30 s old.)". Open: L5 (undelivered message marks items shown), L7 (Agent card would show the
    block). Rows: "Recalled N items about <query>", "Added 2 known items:
    Acme Corp, Jane Doe" (a comma inside a name becomes a look-alike). `RunUsage.knowledge { recalls, autoContexts,
    itemsServed, charsServed }`; `knowledge.recalled` per agent: first at once, then one trailing per second, ids merged,
    newest 50, flushed before a terminal or paused status and at teardown. Store: per-file parsed cache, at most 4
    projects and 96 MB of file size, the newest always stays, stamp = lstat mtime + size + ino + kind + the cap + note ids;
    writes still re-read from disk and cache a new graph object (pure memos key on object identity, so never mutate a graph
    you read; store tests freeze the cache through `knowledgeFileLimits.freezeCached`, so a mutation throws).
    `readRecallView` (`KnowledgeStoreApi.recallView`): a file of 8 MB or more keeps one revision for a recall's ranking and
    inferred links for 30 s, so an entity written in that window is not found by a recall until it passes; printed text is
    always current; search and IPC stay exact.
    Measured (`knowledgeRecall.measure.test.ts`, real tool handlers over `knowledge.fixture.ts`, chars / 4 is an estimate;
    `today` is the best case, an agent that already knows which entities to get): vocabulary + search + get vs one recall:
    5,400 -> 1,483 chars (5 -> 1 calls, 3/3 names), 3,391 -> 1,046 (5 -> 1, 3/3), 4,824 -> 1,225 (5 -> 1, 3/3), 4,656 ->
    1,486 (6 -> 1, 4/4), 3,625 -> 1,174 (5 -> 1, 3/3). Asking again at the default budget: 930, 470, 529, 812, 562 chars.
    Synthetic 2,000 nodes / 5,000 edges / 2.2 MB: index about 60 ms, a broad rank about 80 ms, recall about 5 ms, inferred
    links about 65 ms once, store read about 40 ms cold and 0.4 ms cached (logged, not asserted). Near the file cap
    (`KNOWLEDGE_MEASURE_FULL=1`; 1,100 entities x 50 facts x 1,000 chars, 58.8 MB; 2,000 x 50 is 106.9 MB and the store
    refuses it): index 2.1 s, inference 0.3 s (partial), one write 0.4 s, on the main thread. Slow, not a hang; a worker
    thread is the real fix and is not built (docs/design/knowledge-connections.md section 8).
    Verified by unit tests and that measurement only; our own fixture is a weak test. Nothing ran live.
  - Round 2, inferred links (`docs/design/knowledge-connections.md`; `src/shared/knowledgeLinks.ts`, pure):
    `inferKnowledgeLinks` builds only what the evaluation passed, `KnowledgeLinkBasis` 'mention' and 'same-name'. Shared
    source, same target, same run, across engagements, co-occurrence and embeddings were rejected; temporal, contradiction,
    evidence, mitigation, answerer and owner are relations agents record (`KNOWLEDGE_COMMON_RELATIONS`). Other engagements'
    data must never reach a run or this view. Links are never stored as edges or reported as facts; a pair with a live
    edge or a retired user edge is not suggested; ambiguous mentions are never suggested. Ids `kl_` + 16 hex over basis and
    endpoints. The user confirms through `knowledge:saveEdge` or dismisses through `knowledge:dismissLink`
    (`KnowledgeGraph.dismissedLinks`, ids only, at most 2,000, oldest dropped, junk dropped on read); agents have no path to
    either. `knowledge:inferredLinks` -> `{ links, appearances }`, memoized per graph object. `knowledgeAppearances`:
    `{ relations, mentions, notes, total }` per node, derived only, no hub cutoff, recalls not counted. `knowledge_recall`
    shows `KNOWLEDGE_STRONG_MENTION` (0.65) mentions only, marked "(inferred)". Fixture precision (hand-labelled by the
    author, some rules changed after the first look, so fitted to it): all mentions 109/129 (0.845), unambiguous
    suggestions 38/40, strong ones 19/21 (0.905), same-name 3/5, suggested relation only for person > organisation
    `works-at` and risk > system `affects`. Unmeasured: real data, a large hub crowding the 500-link cap.

## Renderer

- Engagement kind (renderer, phase 1; `docs/design/engagement.md`, walk `docs/design/ux-review-engagement.md`): the New project form opens with the `project-kind` fieldset (`project-kind-option[data-kind=code|engagement]`, native radios, none chosen on first launch, last kind in localStorage `orgai.lastProjectKind`, initial focus on the checked radio) and swaps fields per kind (engagement: `new-project-client`, "Working folder", `new-project-ref-*`, `architect-setup` "Start with the setup interview (recommended)", "Create and start interview"). Settings: `project-kind-line`, `project-client-input`, `reference-folder-*` above `allowed-folder-*` (move with `reference-folder-allow-changes` / `allowed-folder-make-readonly`), `maintenance-engagement-line` (no "Remove OrgAI files"). Cards: `perm-location[data-kind=reference]`, "Approve engagement plan", Needs-you rows say "Engagement plan" (`proposalKindLabel`, `waitingItems(run, projectKind)`; the DecisionTray chip in LiveRunView still says "Architecture"). Grouping (`lib/clientGroups.ts`): sidebar `nav-client-group[data-client]` with two or more distinct clients or whenever engagements and code projects are both listed (no client names at all: the group is "Engagements"; engagement rows carry `data-kind=engagement`, a Briefcase `nav-kind-mark` in the list and "<name> · Engagement" in the rail tooltip and name) (collapse in `orgai.sidebarClientGroups`), `nav-client-code-label`, rail `hr.nav-client-divider`, `tile-client`, `project-client`. e2e/engagement.mjs (in e2e:free) drives the form, creation, settings, reference card, Maintenance, grouping, tile and topbar at both sizes and themes; the architecture card, reference `perm-location`, the extras-save failure and `NewRunPage` copy are unit-tested or unseen only.
- Engagement phases 2-3, renderer (2026-11-04; `docs/design/engagement-2.md` "Implementation notes"): Team tab
  Templates menu (`team-templates`, save / apply dialogs, `template-notice` with Undo through `undoImport` and
  `ImportNotice.source: 'template'`), New project "Start from a template" (`setup-choice-template`,
  `new-project-template`, `orgai.lastTemplateId`), App settings "Templates and kit" pane (`templates-section`,
  `kit-section`); New run Team / Ask switch (`new-run-mode`, `orgai.newRunMode.<pid>`, `startRun({ team: 'single' })`;
  Ask runs use the conversation layout, kind "Ask", `run-meta-ask`); Project settings > General Engagement plan
  (stale save banner `engagement-plan-stale`) and Context notes (engagements only); Maintenance "Forget this
  engagement" and the tile's "Forget engagement..." with preview counts (`forget-confirm`, Dashboard `forget-notice`);
  History > Trends months, every run kind, By kind table, Copy as CSV / Save CSV (Blob download, no main dialog);
  per-project MCP values and "Make a project-only copy" (`mcp-per-project`, `mcp-copy-*`); "Your presets"
  (`presets-section`, `preset-form`, tiles `connector-tile[data-custom]`). `lib/mcpScope.ts` and `lib/kitApi.ts`
  mirror contracts merged on dev after this branch; their surfaces hide while the API is absent. e2e:
  `e2e/engagement2.mjs` (templates, Ask, plan + stale, notes, Trends + CSV copy, forget, both sizes and themes),
  `e2e/per-project.mjs` and `e2e/presets.mjs` (SKIP until the runtime side is present; never run yet). Not driven:
  Save CSV's download, the kit dialogs (native pickers), the per-project confirm and queued saves, presets end to end;
  `needsSignIn` still also flags per-project secret gaps as "Needs sign in".
- Engagement follow-ups (renderer): `lib/mcpScope.ts` and `lib/kitApi.ts` now re-export their types and limits from `@shared/types` (no mirrors, no casts); Trends "Save CSV..." says "Your browser is saving the CSV." (the renderer cannot see where a Blob download lands); `roleCapabilities.ts` `waitingLabel` splits "Needs sign in" from "Needs a value for this project" / "Needs N values for this project" (`secretScope === 'project'`). `e2e/per-project.mjs` nudges the open Catalog with a library write after its raw IPC link; its last check (focus on the copy's More actions button) still fails and is pre-existing.
- Knowledge tab (spec `docs/design/knowledge.md`, walk `docs/design/ux-review-knowledge.md`; engagements only, between
  History and Team, `tab-knowledge`, `View` 'knowledge'; never on the assistants, no menu item yet):
  `views/KnowledgeView.tsx` + `components/knowledge/*` is a list-first page (no CanvasFrame): filter column
  (`knowledge-search`, kind chips `knowledge-kind[data-kind]` with counts, origin chips
  `knowledge-origin[data-origin=user|agent]`, `Switch` `knowledge-show-retired`, count line `knowledge-count` "12 of 300
  items"), one `ul[role=listbox]` Tab stop grouped by kind in `lib/knowledge.ts` `kindOrder` (People … Open questions,
  free-form kinds as typed, Notes last; context notes are items too), rows
  `knowledge-row[data-id][data-kind][data-origin][data-retired]` with name, kind badge, excerpt and the provenance line
  (`provenanceLine`: "You · 4 Nov 2026" / "Analyst · R1 · 4 Nov 2026"), ordered by createdAt only (agent writes never
  re-sort), roving focus with type-ahead, Enter opens the `SidePanel` detail (`persistKey` "knowledge", rail-collapsed
  under 1100 px, `revealOn` selection; `#knowledge-detail-heading` takes focus, Esc returns to the row), Shift+F10 /
  right-click a native `popover=auto` row menu `knowledge-row-more` (rows carry no buttons), windowing past 100 rows
  (`lib/knowledgeList.ts`). Detail: inline-editable name / kind / aliases / summary (`InlineField`, save on blur and
  Enter, summary Ctrl+Enter), Facts (`knowledge-fact-input`, full list sent with ids so agent facts keep their source;
  `withFactRetired` always sends the flag), Related (`relatedRows`, neighbour links select, add a relation form, retire /
  restore / remove), Notes links, History (`historyLines`: "Recorded by Analyst in R1 <run>, 4 Nov 2026 11:46" with the
  run as a link, "Edited by you, …", "Retired by …"), footer Retire / Restore and "Delete…" (`useConfirm`
  `confirmTestId: 'knowledge-delete-confirm'`); notes use the moved `NoteDialog` (`context-note-dialog` testIds kept).
  Live updates: `onEngagementChanged` refetches ('knowledge' graph, 'notes' index), never re-sorts or moves focus,
  announces "The team recorded N items" at most once per 5 s through the one `role=status` `knowledge-status`, "Show
  new" when filtered out; deep links through store `openKnowledgeItem(KnowledgeFocusRequest)` resolved by
  `resolveFocus` (id, else kind + name, else note title). A "List | Graph" switch (`knowledge-view-switch`, per project
  in localStorage) renders the neural canvas (see "Knowledge graph 2" below). Run view: `lib/knowledgeRun.ts`
  `collapseKnowledgeWrites` folds each engagement_knowledge / engagement_context write call and result into the harness
  row (`knowledge-write-row`, "Recorded organisation Acme Corp", kinds and relations with hyphens as spaces, result under "Show output",
  inner `knowledge-row-open` "Open" link; the name no longer collides with the list's `knowledge-row`; ids parsed from result text must match `KNOWLEDGE_ID_RE`), `transcriptRows.ts`
  gives reads their sentences ("Looked up the kinds and relations in use", "Searched the knowledge for Acme", "Read
  Jane Doe", "Read the note …", "Read the context notes"), RunMeta `run-meta-recorded` "Recorded N changes"
  (`recordedBreakdown` over the chain's harness rows, engagements only; the breakdown "4 items, 2 relations, 1 note, 1
  retired" is in its title and sr-only text via `recordedBreakdownText`, label `recordedLabel`) opens the tab. Settings > General > Context notes
  is one line `knowledge-summary` (`knowledgeSummaryLine`: "5 items (1 person, 4 systems), 2 notes, 6 facts", live counts only, at most 5 kinds then ", N more") + `knowledge-open`;
  Maintenance danger zone adds `knowledge-clear` "Clear everything…" (`clearCountsLine`: counts everything including retired,
  "5 items (1 retired), 7 facts, 2 relations", a parenthetical only when non-zero; `knowledge-clear-confirm`,
  notice `maintenance-notice` takes focus; notes stay) and the forget confirm / `forget-notice` count "N recorded
  items" (`knowledgeRemoved`, wording unchanged).
  - Fix-up of walk-2 M1-M5, M7 (cfa7737; `docs/design/ux-review-knowledge-2.md` "Status after fix-up"): retire / delete
    show a Banner `knowledge-notice` ("Retired <name>." with `knowledge-notice-undo`, "Deleted <name>." without Undo),
    announced through `knowledge-status`, cleared after 8 s (`NOTICE_MS`, restarted after a pause while pointer or
    focus is inside); after a retire the pane stays on the item (Restore shown), no jump to the next. RunMeta and
    Settings call `openKnowledgeItem({ projectId })`; a focus request with no target lands on the selected row, else the
    first row, else Add a note (a node in Graph view); the History run link lands on the composer, else the selected
    tab, else the topbar h1; `SidePanel` focuses the rail's Show button only after the user's Hide and only if focus is on
    body. Unit-tested and driven by e2e (knowledge.mjs, knowledge-graph.mjs, knowledge-run.mjs) only; not seen by eye, not re-walked.
    Unverified: the 8 s timer and its pause, Esc on a filtered-out selected item, retired-group edge geometry, radial
    layout with the new handles. Clicking "Show item details" still drops focus to body (open). Dates: `lib/dates.ts` `formatDate` / `formatDateTime` ("4 Nov 2026"), used by plan,
  notes, kit and template lines. `ConfirmDialog` / `useConfirm` take `confirmTestId`. e2e (in e2e:free; mock
  `[mock:knowledge]`, both sizes and themes, keyboard pass): `e2e/knowledge.mjs`, `e2e/knowledge-graph.mjs`,
  `e2e/knowledge-run.mjs`; engagement2.mjs drives the note dialog from the tab. Reviewer (two passes): no Critical or
  High after fixes. Post-landing walk: `docs/design/ux-review-knowledge-2.md`. Open: main's `knowledge:saveNode`
  now takes `expectedUpdatedAt` / `appendFacts` (cli-spec Wave 0) but the tab sends neither, so an agent's fact
  appended between the tab's fetch and the user's save is still dropped, run-scoped
  windows (Open link and RunMeta button do nothing visible there), no application-menu item, "Checked by you" and
  "Retire all agent items from R3" not built, the Lows in knowledge.md section 13.
- Knowledge graph 2 (2026-11-05, spec `docs/design/knowledge-graph-2.md`, replaces knowledge.md section 5): Graph view is `components/knowledge/KnowledgeNeural.tsx` (DOM, keyboard, card), `neuralEngine.ts` (two canvases, one rAF loop, hit grid, pulses), `neuralColors.ts`, `NeuralCard`, `NeuralLegend`, pure `lib/knowledgeNeural.ts` (seeded force layout in slices, `neuralRadius`, `lodFor` tiers at 300 / 800 nodes, `pickLabels`, `spatialTarget`, `cardPlacement`, `spokenName`). No React Flow, and it reads none of App settings > Canvas; `lib/canvas.ts` is used only for `useReducedMotion`. `--neural-*` tokens in every theme block. Whole graph always, positions survive updates (localStorage `orgai.knowledgeLayout.<pid>`, ids and coordinates only), filter and selection never move anything, a click opens the panel with focus staying on the node, a panel or band change moves nothing (`offsetView`), a window resize refits until the user pans or zooms (`data-user-view`; then `viewAfterWindowResize` scales a shrink so the same part stays on the stage; Fit hands the view back). Fit above 300 nodes aims at the dense core (`coreBox`, middle 95% per axis), gravity grows above 400 nodes (`gravityFor`, at most 0.2), and `screenRadius` keeps hubs at 12 px and leaves about 3 px at low zoom and slows growth above zoom 1. A filter or search names its lit items first (`LABELS_LIT` 40, 60 from zoom 1.6; below, above, right or left; dimmed nodes never block a name; `data-named-lit`). One Tab stop: `knowledge-neural-nodes` listbox of `knowledge-node[data-id][data-kind][data-color][data-mark][data-radius][data-total][data-x][data-y][data-active][data-dim]` options with a roving tabindex (all up to 300 drawn nodes, above that focused, selected, active, their neighbours and the 50 largest); root `knowledge-neural[data-drawn][data-edges][data-lit][data-lod][data-settled][data-animating][data-frames][data-fired][data-fired-ids][data-inferred][data-zoom]` is what e2e reads. `lib/knowledge.ts` `kindColor(kind)` no longer takes kinds in use (a new kind never recolours another; free-form kinds hash) and `kindMark(kind)` (solid, ring, ring-dot) is the shape half of the key, drawn through `KindMark`. Band: `knowledge-filters[data-layout=band]` in Graph view, `knowledge-filters-more` under 720 px, `knowledge-inferred-links` (`orgai.knowledgeInferred.<pid>`). Possible connections: `KnowledgePossible` (`knowledge-possible-*`), pure `lib/knowledgePossible.ts`; Confirm is an ordinary `saveEdge`, Dismiss `dismissLink`, `knowledge-possible-partial` when `KnowledgeInferredResult.partial` is set. Run: side tab `side-tab-knowledge` on work runs of engagements (`components/knowledge/RunKnowledge.tsx`, `run-knowledge-*`, pure `lib/runKnowledge.ts`), store `knowledgeRecalledByRun` (ids and time only, 500 events per run, not persisted, so after a relaunch the transcript's lines stand in) and `runKnowledgeByChain`; `knowledge-read-row` folds `knowledge_recall` calls into the harness row; `usage-knowledge`; `knowledge-auto-context` in `ContextNotesSection`. In a run-scoped window the tab works and `run-knowledge-window-note` replaces the deep link. How checked: unit tests; e2e (mock, 1024x640 and 1600x1000, both themes): `knowledge-graph.mjs` (hover card, click moves nothing, size order, colour per kind, filter dims, retired, inferred switch, recall fires, reduced motion, hidden tab and List view stop the loop by frame count, keyboard), `knowledge.mjs` (band, confirm, blank word, dismiss), `knowledge-run.mjs`; screenshots looked at by eye. Measured at 2,000 nodes and 5,000 edges on Windows at 1600x1000 after the walk-4 fixes, hub and random graphs, spec section 8: settle 1.3-1.4 s, frame JS p95 15 / max 32 ms while settling, p95 at most 3.0 / max 5.5 ms while interacting, no long task; GPU raster not measured. Fixes after walk 4 (`ux-review-knowledge-4.md`): transcript `recallOutputText` and repeats folded into one row (`KnowledgeCollapse.repeats`, `readRowText`), `POSSIBLE_WORD_PLACEHOLDER` "How they relate" (the old "works at" was a placeholder, never a value), round inferred dots and brighter tokens, light-theme nucleus and larger halo, `remapByEdge` keeps pulses across a new model, `lib/knowledgePrefs.ts` `clearKnowledgePrefs` (from `removeProject`), origin chips count nodes only in Graph view, focus lands on Add a note when the last node leaves and on Back when an open run-detail item vanishes, `RunKnowledge` reads focus during render instead of listening (reviewer N1 did not reproduce on the old code; e2e re-recalls while a row has focus, passes on both). Unverified: drift, ambient pulses and activation spread by eye or test, window blur, a real hidden window (faked `visibilityState`), macOS, Linux, DPR above 1, System theme, forced colours, a screen reader, `partial` with main's real field, an agent retiring the focused node, inferred dots at 2,000 nodes, a UX walk on the fixes. Open Lows: `revealKnowledgeTab` clicks the rail's DOM button (a choice gets saved), names in `KnowledgePossible` and `RunKnowledge` are not stripped of hidden characters (main refuses them on write), `-` `0` `+` always act as commands so type-ahead cannot match "Q-3", 2,000 nodes at 1024x640 is a dense ball (zoom 0.16, the stage's height limits it), walk-4 L1, L2, L4.
