# UI overhaul: Project Home tab (implementation notes)

Area: the Home tab (`view === 'home'`) of a stored project. Boards: `project/ProjectHome.dc.html` (code),
`project/EngagementHome.dc.html` (engagement). Not shown for Chat or the helpers (virtual projects; App.tsx).

## Files

- `views/ProjectHomeView.tsx`: picks `CodeHome` or `EngagementHome` by `projectKindOf`.
- `components/home/`: `CodeHome.tsx`, `EngagementHome.tsx`, `HomeSection.tsx` (glass panel + h2 + link), `useHomeData.ts`
  (reads beyond the store), `startRun.ts` (open New run with text).
- `lib/projectHome.ts` (shared + code derivations), `lib/projectHomeGit.ts` (repo strip, health, nightly bar, merged
  lately, `normalizeGit`), `lib/projectHomeEngagement.ts` (purpose, facts, recent work, files, knowledge, connections,
  folders). Each has a `*.test.ts` beside it.
- `styles/home.css`: both looks. Tokens only.
- e2e: `e2e/home-checks.mjs` (shared block), called from `per-project.mjs` (code Home) and `engagement.mjs` /
  `engagement2.mjs` (engagement Home).

## Data sources (nothing is sample data)

| Section | Source |
| --- | --- |
| repo strip: folder | `project.path` (always) |
| repo strip: branch, last merge, open branches; health: unmerged, uncommitted, ahead/behind; merged lately | `window.orgai.projects.gitSummary(projectId)` when the build has it (feature-detected, normalised by `normalizeGit`); otherwise those lines are left out |
| running now | newest live work run in the store: `runMarks` over its agents (state colour per agent), `planProgress`, `waitingItems`, run cost |
| health: schedule lines | `schedules.list()` `lastEntry` of this project's team schedules |
| to-dos | `todosStore` (project scope), Run = `startSessionFromTodo` (fills New run, never sends) |
| team | `project.roles` grouped by lead (`teamSummary`), `permissionMode` in plain words |
| spend this month | `runs.usageOverview({ since: <month start>, projectIds: [id], limit: 500 })`; typical run = median of priced work runs when there are 3 or more |
| scheduled | `schedules.list()` + `lastResultText` |
| engagement: description | `engagement.document(projectId)` (first paragraphs, markdown reduced to plain text) |
| engagement: facts | project client / `createdAt`, run summaries, outputs |
| recent work | run summaries (history merged with live runs), plan step of a running run |
| latest files | `outputsByProject` |
| knowledge | `knowledge.get` + `engagement.listNotes` via `itemsOf`, `kindCounts` |
| connections | `mcp.list(projectId)`: sign-in state and missing secrets only (a server is never called "Connected": it only starts inside a run or by Test) |
| folders | `project.path`, `allowedDirectories`, `referenceDirectories` |

## Behaviour

- Start boxes never start a run. "Start run" / quick chips / Ctrl+Enter, and the engagement "Start", open the New run page
  with the text added to the existing draft (`mergeDraftText`: nothing lost, nothing doubled). Engagement "One assistant"
  writes `orgai.newRunMode.<projectId> = 'ask'` (NewRunPage's own key) before opening the page.
- Links: running now Open -> the run; All runs -> History; to-dos -> To-dos tab; team Edit/Open -> Team; Limits ->
  project Settings > Limits; Schedules -> `openSchedules()`; engagement Edit the description -> Settings > Engagement plan
  (`openProjectSettings`); Inbox -> `setView('inbox')`; Review -> `jumpToDecision`; file -> Files tab on that output;
  knowledge -> Knowledge tab; Connections Manage -> `openProjectMcp` (Team > Catalog).
- Motion: only the shared classes. A working agent mark pulses (`motion-pulse`, at most 12), a waiting one breathes
  (`motion-breathe`), sections that appear after their data loaded rise in (`motion-enter`, stagger from `--i`).
  Reduced motion and Pause motion stop the loops (global rules); the first paint does not animate.

## Deviations from the boards

- No "tests 42 passing" in the repo strip, no "Dependencies up to date" health line: the app does not know them.
- "Spend this month" has no limit bar and no "of $100": no per-project monthly limit exists (`maxBudgetUsd` is per run).
  A "Limits" link opens the project's Limits pane instead.
- The "> new run" box is a real text field (the board draws a placeholder line), and a hint says it opens New run.
- "to-dos the team left" is "to-dos" (user and team items; "from the team" marks the team's).
- Team groups come from the chart: a lead with reports heads a group; direct reports without reports share "Direct reports".
- Engagement mode toggle reads "Whole team" / "One assistant" (task text); the board's "Team / Ask one assistant" is NewRunPage's.
- Connections have no "Connect another" button; "Manage" opens Team > Catalog where connections are added.
- Facts list: For, Started, Runs, Files, Last activity, Spent (only those with data). The board's "Plan: Approved by you" is not
  built (no such state).

## Open

- Nightly test bar (health) and any schedule outcome history beyond the newest entry: needs a read that does not clear the
  schedule's unread count (`schedules.history` does). Not built until the runtime offers one.
- Git sections need `projects.gitSummary`; without it the code Home shows folder, new run, running now, to-dos, team, spend
  and schedules only.
- Fraunces is not bundled (`--font-serif` falls back to the system serif stack).
- Not checked: screen reader speech, macOS/Linux, real git data in the screenshots (the call did not exist when this was written).
