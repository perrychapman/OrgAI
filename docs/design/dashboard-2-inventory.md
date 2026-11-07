# Dashboard, second pass: data inventory

Read-only inventory for the Dashboard rebuild (UI Lead, 2026-11-07). For each candidate signal: where the data lives
today, its scope, when it loads, which helpers already turn it into words, and whether the renderer can show it with
no new IPC contract. Read from code at this branch's base (cf3b1a41); nothing was run.

## How the Dashboard gets data today (baseline)

- Boot (`useAppStore.init`, `src/renderer/src/store/useAppStore.ts` ~line 1231): `onRunEvent` subscription (every
  run event of every run reaches every window), `onTeamFilesChanged`, `loadTeamFilesAttention()`
  (`window.orgai.teamFiles.listAttention()`, one cross-project call), `loadProjects()` (`projects.list()`, full
  `Project` records incl. roles, skills, mcpServers spec, kind, client, `folderConfigTrust`), `loadAllHistory()`
  (one `runs.list(id)` per project plus the three virtual ids: every `RunSummary` of every project, unpaged, from
  RunStore's in-memory index, `src/main/store/runs.ts` `list`), `loadConnections()`, `loadLiveRuns()`
  (`runs.listLive()` then `runs.get(id)` for each live run, plus `runs.pendingCards(id)` through `seedPendingCards`),
  `auth.status()`.
- `DashboardView` mount: `loadAppInfo()` and `loadAllHistory()` again.
- Usage: `usageByConnection` (store), filled by `usage.status` run events and `refreshUsage()`
  (`window.orgai.usage.refresh()`); UsageCard calls it on mount when the newest report is over 60 s old.
- Team assistant summaries live in a second store, `src/renderer/src/store/teamAssistant.ts`
  (`useTeamAssistantStore.summaries`), pushed by `onTeamReviewUpdated` (subscribed in App.tsx `initTeamAssistant`)
  and seeded only for the selected project (`seedTeamReview`, App.tsx line 83).
- Hooks in `components/dashboard/useDashboardData.ts`: `useAllSummaries` (history merged with live, live wins,
  team-surface runs and deleted projects dropped), `useWaitingRuns`, `useLiveRuns`, `useNow`.

So: projects, every run summary (with `usage: RunUsage` on runs recorded since usage tracking), every live run's full
state (agents, plan, open cards, transcript), connections, usage reports and team-files attention are already in the
renderer at boot. Anything else costs a call.

## Candidates

### 1. Agents working right now, across every live run

- Data: `useAppStore.runs[runId].agents: Record<string, AgentInstance>` for every live run (`loadLiveRuns` loads the
  full record; `agent.upsert` / `agent.remove` events keep it current, store lines ~1861-1870). `AgentInstance`
  (types.ts ~2490): `id`, `name` (role name), `handle?`, `roleSlug`, `parentId`, `state: AgentState`
  ('starting' | 'thinking' | 'tool' | 'waiting' | 'delegating' | 'idle' | 'done' | 'error'), `activity` (one line,
  already words, written by main's `activity.ts`), `startedAt`, `endedAt?`, `usage?`, `worktree?`. Project and run
  come from `run.summary.projectId` / `run.summary`.
- Scope: cross-project. Loaded at boot, live through events. Cost: zero calls.
- Words: `@shared/view/agentTree` `agentLabel(a)` (handle first, hidden/control chars fall back to the role name, cut
  at 64), `lib/foldFinished.ts` (settled rules if you want "working" to mean not done/error and not inside the 6 s
  grace), `lib/assistants.ts` `locationLabel(projectId, projects)`, `@shared/view/runLabels` `runName(summary)`,
  `@shared/view/runStatus` `statusOfRun`. `activity` needs no helper. `agent.partial` (streaming text) also lands in
  `run.partial`, but do not show it on a home page.
- Caveat: a burst of `agent.upsert` events re-renders anything selecting `runs`; select a derived, shallow-compared
  list (`useShallow`) and cap rows.
- Verdict: **renderer-only.**

### 2. Plan limits per connection

- Data: `useAppStore.usageByConnection: Partial<Record<ConnectionId, UsageStatus>>` (`usage` is the anthropic entry).
  `UsageStatus` (types.ts ~3144): `authMode`, `subscriptionType`, `available`, `windows { fiveHour?, sevenDay?,
  sevenDayOpus?, sevenDaySonnet? }` each `RateLimitWindow { utilization: 0-100 | null, resetsAt: epoch ms | null }`,
  `modelWindows?: { model, utilization, resetsAt }[]`, `status?` ('allowed' | 'allowed_warning' | 'rejected'),
  `limitedWindow?`, `limitedUntil?`, `spend?: UsageSpend` (proxies: `usd`, `budgetUsd`, `resetsAt`, `totalUsd?`,
  `periods? { day, week, month }`, `periodsNote?`), `updatedAt`.
- Scope: cross-project (per connection). Loaded from events and `refreshUsage()`; the idle probes in main run only for
  connections in use. Cost: one `usage.refresh()` on mount (already done by UsageCard).
- Words: `components/UsageMeter.tsx` `tightestWindow(usage)` -> `{ label, pct, level }` (note: it drops `resetsAt`;
  read `usageRows(usage)` in the same file for the window's reset), `UsageBar`, `SpendBar`, `missingFiveHour`;
  `lib/usage.ts` `connectionsInUse`, `connectionOrder`, `WARN_AT` (80), `spendRowLabel`, `spendRowFigure`,
  `spendSentence`, `periodsCaption`, `periodText`, `lifetimeText`, `periodSince`, `reportsSpend`;
  `components/dashboard/dashboardProjects.ts` `windowLabel`, `usageIsStale`; `lib/connectionLabel.ts`
  `connectionLabel`, `isProxyId`. Reset time: `@shared/view/runChains` `relativeTime` or `lib/dates.ts`.
- Already shown: the Usage card shows the tightest window's label and percent and the proxy figure. Not shown: the
  reset time, five-hour vs weekly side by side, `status === 'rejected'` with `limitedUntil` ("limited until 14:00").
- Verdict: **renderer-only.** (Under the mock no plan windows are reported, so e2e cannot see it; a fake report
  through a throwaway hook is how the LiteLLM pass was checked.)

### 3. Worktrees / branches waiting to merge

- Data, two sources:
  - Live runs: `runs[id].agents[*].worktree: WorktreeInfo { path, branch, status, changedFiles?, mergeTarget? }`;
    statuses that need a person are 'conflict', 'review', 'held' (and 'review' also shows as an open merge card in
    `runs[id].mergeReviews`, already counted by Needs you). Cross-project, zero calls.
  - Leftover report branches on disk (what Maintenance lists): `window.orgai.maintenance.listWorktrees(projectId):
    Promise<PendingWorktree[]>` (IPC 'maintenance:listWorktrees'; `PendingWorktree { path, branch, agentId, exists,
    uncommittedFiles, commitsAhead, changedFiles, lastCommitAt?, lastSubject? }`). Per project only; there is no
    cross-project channel. The CLI (`src/cli/commands/worktrees.ts`) calls the same channel for one project.
- Cost: `src/main/maintenance.ts` -> `runtime/worktrees.ts` `inspectPending(root)`: an fs check, then one
  `git worktree list`, then 4 git processes per pending branch (status, rev-list, diff --name-only, log). Read-only,
  not under the repo lock. For 20 projects with no leftovers: 20 git spawns (engagements and non-git folders return
  [] without git). Affordable once per Dashboard mount with a concurrency cap of 3-4 and code projects only; not on a
  timer and not on every history change.
- Words: CLI `worktreeState(w)` (`src/cli/commands/worktrees.ts`: "branch only", "N uncommitted", "unmerged",
  "clean") is not in `src/shared/view/`; the renderer's Maintenance section has its own wording
  (`components/settings/MaintenanceSection.tsx`). Moving `worktreeState` to `src/shared/view/` is a small shared
  refactor, not a contract.
- Verdict: **live runs renderer-only; leftover branches renderer-only with N calls** (N = code projects, throttled).
  A cross-project channel would be a contract (new channel in types.ts, dispatcher, registry, preload) for no new
  data; not worth it now.

### 4. Team assistant suggestions pending per project

- Data: `window.orgai.capabilities.lastReview(projectId): Promise<TeamReview | null>` (reads
  `<data>/team-reviews/<pid>.json` synchronously in main, `capabilities/service.ts` `lastReview`; no discovery, no
  model). `TeamReview.pendingCount` (= recommendations.length), `newCandidateIds`, `checkedAt`. The push
  `onTeamReviewUpdated(TeamReviewSummary { projectId, checkedAt, trigger, mode, pendingCount, newCount,
  evidenceCount })` updates `useTeamAssistantStore.summaries`; `summaryFromReview(r)` maps a review to a summary.
  The Team tab badge reads `useTeamReviewSummary(projectId)`.
- Scope: per project. Today seeded only for the selected project (`seedTeamReview`, once per project per session).
- Cost: one call per project, but each returns the whole review including its discovery (up to
  `CAPABILITY_MAX_ITEMS` 500 items with full MCP targets, evidence strings), so tens to hundreds of KB each. For 20
  projects: acceptable once, after first paint, sequential or 3 at a time; call `seedTeamReview(id)` for each real
  project (it already de-dupes and lets a push win).
- Not the same as `teamFiles.listAttention` (that is team files, item 7).
- Verdict: **renderer-only with N calls** (N = real projects, one-shot per session). A tiny contract would make it
  cheap: `capabilities:summaries(): TeamReviewSummary[]` (main already has `reviewSummary()`); only worth it past
  ~50 projects.

### 5. Services needing sign-in or a missing secret

- Data:
  - `window.orgai.mcpLibrary.list(): McpLibraryInfo[]` (cross-project, one call): `entry`, `missingSecrets`,
    `auth: McpAuthStatus { state, expiresAt?, account?, error?, needsClientId? }`, `usedBy: { projectId, projectName
    }[]`, and for per-project entries `projectSecrets?: { projectId, projectName, serverId, missingSecrets }[]`.
    `onMcpLibraryChanged` pushes the whole list.
  - `window.orgai.connectors.list(): ConnectorInfo[]` (cross-project, one call): `state` 'available' |
    'needsSetup' | 'connected' | 'error', `library?`, `connectedAt?`.
  - Project-only servers (not library links): `window.orgai.mcp.list(projectId): McpServerInfo[]` (`missingSecrets`,
    `auth`, `secretScope?`, `libraryMissing?`). Per project; `McpService.list` reads the library, the project and
    the secret store's has-flags, no network. `Project.mcpServers` (already loaded) says which projects have any
    servers at all, so call only those.
- Words: `lib/roleCapabilities.ts` `needsSignIn(info)` (missing secret, or enabled and auth 'notAuthorized' /
  'expired'; a missing library entry does not count) and `waitingLabel(info)` ("Needs sign in", "Needs a value for
  this project", "Needs N values for this project"); `lib/connectors.ts` for names and marks;
  `requestConnector(id)` / `requestAppSettingsSection` / store `mcpFocus` for the deep link.
- Caveat: "used by a project" matters: an unused library entry that needs sign-in is not urgent. Filter by `usedBy`
  (library) or by enabled project servers.
- Verdict: **renderer-only with 2 calls** (library + connectors) for linked services; **plus N calls** for
  project-only servers (N = projects with a non-library server, usually small).

### 6. Folder config trust state per project

- Data: `Project.folderConfigTrust?: FolderConfigTrust { state: 'untrusted' | 'trusted', digest?, decidedAt? }` in
  `useAppStore.projects` (boot). 'changed' is never stored: it needs `window.orgai.folderConfig.review(projectId):
  FolderConfigReview` (re-hashes the folder's config paths; file reads, no git).
- Words: `lib/folderTrust.ts` `hasFolderTrustField(project)` (code project with the field), `folderTrustState(project,
  review)`, `folderTrustIgnored(state)`, `folderTrustSummary(state)`, `folderTrustSentence(state, decidedAt)`,
  `folderTrustNoticeText(state, review)` (counts need the review), `requestFolderTrustReview(projectId)` deep link
  (opens Permissions with the dialog), dismissal per digest `readDismissedDigest`.
- Verdict: **'untrusted' renderer-only** (zero calls). **'changed' renderer-only with N calls** (N = projects whose
  stored state is 'trusted'; usually few). The topbar pointer already re-reads on view change.

### 7. Team files awaiting approval

- Data: `useAppStore.teamFilesByProject: Record<string, TeamFilesStatus>` seeded at boot by
  `teamFiles.listAttention()` (cross-project, only projects that need the user) and kept fresh by
  `onTeamFilesChanged`. `TeamFilesStatus.state` ('pending' | 'problem' | ...), `changes[].needsApproval`,
  `omittedChanges`, `problems`, `uncommitted`, `uncommittedFiles`.
- Words: `lib/teamFiles.ts` `teamAttentionItems(statuses)` (pending and problem only, one item per project, label
  "Team files: N changes need your approval" / "Team files: <file> cannot be read"), `approvalCount`,
  `teamFilesLine`, `teamPointerText`; `lib/menuActions.ts` `useTeamAttentionItems()` and
  `openTeamFilesDecision(projectId)`.
- Already shown: Needs you includes them (`dash-needs-row[data-kind=team]`) and the counts include them
  (`combinedDecisionCount`). "Uncommitted team files" (`uncommitted`) is not shown anywhere on the Dashboard, but
  `listAttention` may not return projects that are only uncommitted; a per-project `teamFiles.status` call would.
- Verdict: **renderer-only** (already on the page).

### 8. Activity over the last 14 / 30 days, cross-project

- Data: `useAppStore.historyByProject` holds every summary of every project (not paged), merged with live runs by
  `useAllSummaries()`. Each `RunSummary` has `startedAt`, `endedAt?`, `status`, `kind`, `team?`, `quick?`,
  `totalCostUsd`, and `usage?: RunUsage` (`costUsd | null`, `costSource`, `costPartial?`, `tokens`, `wallMs`,
  `turns`, `toolCalls`, `agents`, `agentsWithoutResult`, `nudges`, `waitingMs`, `limitHoldMs`, `idleMs`, `skills?`,
  `knowledge?`). Runs recorded before usage tracking have no `usage` until `runs:get` / `runs:usageStats`
  normalizes them; `runCostInput` falls back to `totalCostUsd` there.
- `runs.usageStats(UsageStatsQuery)`: `projectId` is required, so cross-project means one call per project (up to
  500 rows each, returns per-day `trend` buckets with `runs`, `costUsd`, `costUnknownRuns`, `waitingMs`...). Not
  needed for counts and cost: the summaries already carry it.
- Words: `@shared/view/cost` `costView`, `runCostInput`, `sumCosts`, `formatDuration`, `formatTokens`;
  `components/ui/Cost.tsx` (unknown is never $0); `dashboardProjects.ts` `costInWindow`, `topProjectCosts`,
  `mergeSummaries`; `lib/dashboard.ts` `weekCost` (currently unused); `UsageTrends.tsx` draws buckets (its bucketing
  is inside the component; a pure day-bucket helper would need writing, ~20 lines).
- Decisions answered: **not available.** `RunUsage` has `waitingMs` (time with a card open) but no count of
  decisions. Answered cards are kept only as in-memory tombstones in main (`runtime/decisionIndex.ts`, socket-only
  `runs:findDecision` by request id, not listable) and as tool results inside each run's transcript (would need
  `runs.get` per run: far too costly).
- Verdict: **runs per day, cost per day, wall / waiting time: renderer-only** (zero calls). **Decisions answered:
  needs contract**: smallest is `RunUsage.decisions?: { asked: number; answered: number }` counted by RunManager
  where it already measures `waitingMs` (types.ts + runManager.ts; both hot right now). Recommend showing "time
  waiting on you" from `waitingMs` instead and deferring the count.

### 9. Last decisions the user answered

- Data: `useAppStore.proposalOutcomes: Record<proposalId, ProposalOutcome>` (from `proposal.resolved`, this window's
  lifetime only, ids only). `permission.resolved`, `question.resolved`, `rules.resolved`, `merge.resolved` events
  only remove the card from `runs[id]` (store ~1882-1906); nothing keeps what was decided. Nothing persisted in a
  list form (see item 8).
- Verdict: **needs contract** for anything that survives a reload: smallest is a bounded recent-decisions list,
  e.g. `runs:recentDecisions(limit) -> { runId, projectId, kind, title, decision, at }[]` backed by the existing
  `DecisionIndex` tombstones (which lack title and projectId, so that also grows) or persisted with the run summary.
  A **renderer-only session log** (append on `*.resolved` events in the store, title taken from the card before it
  is removed) is possible but empties on reload and only sees this window's decisions; I would not ship that on a
  home page. Low value for the cost; skip.

### 10. Quick actions

- Resume a paused run: `useAppStore.resumeNow(runId)` (`runs.resumeNow`), `cancelAutoResume(runId)`; paused list from
  `lib/dashboard.ts` `pausedRuns(summaries)` (`pausedUntil`, `pauseReason`, `autoResume` on the summary). Already on
  the page (`dash-paused-resume`). **Renderer-only.**
- Continue the last chat: `continueFromHistory(runId, projectId?)` (selects, opens the chain's newest run, focuses the
  composer; never starts a run). Newest chat = newest `historyByProject['quick']` row with `canContinue(runs, id)`
  (`@shared/view/runChains`). Already used by `dash-since-continue`. **Renderer-only.**
- Start a new chat: exported `openNewChat()` (`projects-new-chat`). **Renderer-only.**
- Start from a template: `useAppStore.templates: OrgTemplateInfo[] | null` + `loadTemplates()` (`templates.list()`,
  one cross-project call; `{ id, name, description, kind, roleCount, roleNames, createdAt, updatedAt }`). Starting a
  project from one goes through the New project form (`new-project-template`, localStorage `orgai.lastTemplateId`);
  there is no "open the form preset to template X" entry point yet, a small store addition (renderer-only).
  **Renderer-only with 1 call.**
- Open the newest run of each project: `useAppStore.openProject(projectId)` (the run that needs you, else last
  viewed, else newest; `defaultRunToOpen` in `@shared/view/needsYou`) or `focusRun(projectId, runId)`. Newest
  summary per project from `historyByProject[id][0]` (sorted newest first by main). **Renderer-only.**
- New run in a project: no direct store action from outside the project; `selectProject` + `openDraft()` works.
  **Renderer-only.**

### 11. Knowledge counts per engagement

- Data: `window.orgai.knowledge.get(projectId): KnowledgeGraph` returns the whole graph (file cap
  `KNOWLEDGE_FILE_MAX_BYTES` 64 MB; main caches at most 4 projects / 96 MB of parsed graphs, so 20 engagements thrash
  the cache and each read can be a cold parse: ~40 ms at 2.2 MB, seconds near the cap, on the main thread).
  `engagement.listNotes(projectId)` returns the notes index (small). `onEngagementChanged({ projectId, what, ids? })`
  says something changed, with ids only, no counts.
- Cheap stand-in already loaded: `RunSummary.usage.knowledge { recalls, autoContexts, itemsServed, charsServed }`
  per run (reads served, not items stored), and the harness transcript rows of live runs ("Recorded ...",
  `lib/knowledgeRun.ts` `recordedBreakdown`) for live runs only.
- Words: `@shared/view/knowledge` `knowledgeSummaryLine(graph, notes)` ("5 items (1 person, 4 systems), 2 notes, 6
  facts"); store `openKnowledgeItem({ projectId })` deep link.
- Verdict: **renderer-only with N calls is affordable only for small graphs**; for a general home page it **needs
  contract**: smallest is `knowledge:summary(projectId) -> { nodes, edges, facts, notes, updatedAt }` (or one
  cross-project `knowledge:summaries()`), computed in main from the cached graph. Recommend leaving item counts off
  the Dashboard for now; the engagement tile can show `usage.knowledge.recalls` from its runs if wanted.

### 12. Skill evaluation suggestions pending

- Data: `window.orgai.skills.lastEvaluation(projectId): SkillEvaluationReport | null` (per project, one small file
  read: `<data>/skill-evaluations/<pid>.json`). Pending = `suggestions.filter((s) => !s.appliedSkillId)`; warnings =
  `findings.filter((f) => f.severity === 'warning')`; `at`.
- Caveat: dismissals are component state in `components/skills/SkillEvaluationPanel.tsx` (`useState<Set<string>>`),
  never persisted, so a count read from the report includes suggestions the user dismissed. Showing "N skill
  suggestions" on the Dashboard would therefore resurface dismissed ones after every reload.
- Verdict: **renderer-only with N calls** (cheap), but the number is **not trustworthy until dismissals persist**
  (that is a contract: `skills:dismissSuggestion` or a `dismissed` flag in the report). Skip until then, or show only
  "Evaluated 3 days ago" style facts.

### 13. Needs-you items already on the page

- `lib/needsYou.ts` re-exports `@shared/view/needsYou`. `waitingItems(run, projectKind?)` counts, per run that
  `needsYou(run)` (open status and something pending): rule requests, questions, proposals, merge reviews,
  permissions, MCP installs, one item each, in that order; plus one 'plan' item only when there is nothing else and
  `run.plan.status === 'blocked'`. `decisionCount(runs)` sums them; `combinedDecisionCount(runs, teamItems)` adds one
  per team-files item (pending or problem, `teamAttentionItems`). The Dashboard's Needs you list
  (`AttentionColumn.tsx` `NeedsYouSection`) = `useWaitingRuns()` x `waitingItems` + `useTeamAttentionItems()`; the
  bell, sidebar badges, hero and the app menu's `hasDecision` use the same numbers. Not counted: folder trust,
  services needing sign-in, Team assistant suggestions, leftover branches, paused runs (paused are their own
  section), failed runs (Since section). Cards of live runs survive a reload through `runs.pendingCards`
  (`seedPendingCards` in `loadLiveRuns`); a run cut by a quit loses its cards (main cancels them).
- If the rebuild adds a "Needs attention" tier for items 3, 5, 6, keep it separate from the decision count: the
  decision count is a contract with the bell and the menu.

### 14. Other cheap signals for a daily user

All renderer-only, zero calls unless noted:

- **Live plan progress per run**: `runs[id].plan: RunPlan { goal, steps[{ title, status, owner? }], status,
  blockedReason?, autoContinues }`. `lib/dashboard.ts` `planStepLabel(plan)` ("3 of 7") is already on Running rows;
  the goal and the current in-progress step title are not shown and are the most useful one-liner for "what is it
  doing".
- **Per-run cost so far and elapsed**: `runs[id].summary.usage` (live, throttled 1 s) via `runCostInput` / `Cost`;
  `elapsedLabel`.
- **Time held on a limit / waiting on you**: `usage.limitHoldMs`, `usage.waitingMs`, `usage.idleMs` per summary;
  `@shared/view/usageView` `timeRows(u)`, `runSignals(u)` (already sentences: "40% of the run (12 min) was spent
  waiting on decisions.", "Held 20 min on a usage limit.", "2 agents spent 30k tokens and produced no result.").
- **Agents that returned nothing**: `usage.agentsWithoutResult`, `noResultTokens` (`runSignals` words it).
- **Run errors**: `summary.error` + `errorFirstLine` (Since section already shows failed runs).
- **Unread cross-run messages**: `useAppStore.unreadByRun` (counts per run; cleared when viewed).
- **Team size and makeup per project**: `Project.roles` (count, root role name, models via `lib/roleModels.ts`
  `roleChipLabel`), `Project.skills`, `Project.mcpServers` (count), `Project.kind`, `Project.client`.
- **Connection per project and connection health**: the project's connection (`connectionsInUse` in `lib/usage.ts`
  shows how it is read), `connections` (`ConnectionInfo`
  with `status.state`, `isDefault`); `dashboardProjects.ts` `connectionProblems` (already on the Connections card).
- **Open tabs per project after relaunch**: `lib/openTabs.ts` `readOpenTabs(projectId)` (localStorage) for a
  "Pick up where you left off" row.
- **Ended-with-app runs**: `summary.endedBy === 'app'`, `endedWhile` ('waiting' means it was your turn);
  `heroSublineParts` already counts "were waiting on you when OrgAI closed".
- **App facts**: `appInfo { version, platform, dataDir, logsDir, mockAdapter, packaged }`; `lib/buildChannel.ts`
  `isDevBuild`.
- **Skill library / connector counts**: `skillLibrary.list()` (1 call), `connectors.list()` (1 call) for "3 services
  connected" facts.
- Not available without a contract: update check, per-project "last opened" (Project has no timestamps; use the
  newest run's `startedAt`), run outcome / files changed per finished run (needs `runs.get` per run or a summary
  field), decisions answered (item 8), knowledge counts at scale (item 11).

## e2e selectors the rebuild must keep (or update in the same change)

Other scripts depend on these; `e2e/dashboard.mjs` uses more, listed after.

| Selector | Used by | What it relies on |
|---|---|---|
| `[data-testid=dashboard]` | lib.mjs (`gotoProjects`, `openProjectForm`, `createProject` wait for it to detach), assistants, clone-start, engagement, engagement2, folder-trust, knowledge, knowledge-graph, knowledge-run, project-connection, team-files | page root; the first-launch inline form is `[data-testid=dashboard] form.project-form` |
| sidebar nav item text "Dashboard" (or aria-label "Dashboard") | lib.mjs `gotoProjects` | how e2e reaches the page (no `nav-dashboard` testid) |
| `new-project` (topbar button), `new-project-dialog` (+ `form` inside), `new-project-*` form fields | lib.mjs, many scripts | dialog flow when projects exist |
| `dash-start-choice` (radio "Start a project") | lib.mjs, assistants, dashboard | first launch |
| `empty-chat-now`, `projects-new-chat` | assistants, dashboard | first launch chat, topbar New chat |
| `project-tile[data-name][data-id]`, `project-tile-more`, `project-tile-delete`, `project-tile-main`, `project-tile-open-folder` | lib.mjs `deleteProject`, engagement, dashboard | tile per project with a menu |
| `tile-client` inside `project-tile` | engagement.mjs | engagement client line, absent on code tiles |
| `dash-needs-row[data-kind]` (incl. `data-kind=team`), `dash-needs-you` | team-files.mjs, dashboard | one row per decision, click opens it |
| `forget-notice`, `forget-confirm`, `forget-engagement` | engagement2, knowledge-graph, knowledge-run | `forget-notice` Banner is rendered by DashboardView; the other two live in MaintenanceSection |

Also in `e2e/dashboard.mjs` only: `dashboard-hero` (text and geometry), `dash-since`, `dash-since-row[data-status]`,
`dash-since-continue`, `dash-running-row`, `dash-cost` (text), `project-tile-main`. Present in code but not
referenced by any e2e: `dashboard-figure`, `dashboard-live`, `dashboard-app-facts`, `dash-running`,
`dash-since-clear`, `dash-paused`, `dash-paused-row`, `dash-paused-resume`, `dash-project-search`, `dash-projects`,
`dash-usage`, `dash-usage-row`, `dash-usage-periods`, `dash-connections`, `dash-connection-problem`,
`dash-connections-settings`, `dash-proxies`, `project-tile-error`. CLAUDE.md's Renderer notes and
docs/design/dashboard.md list several of these, so keep the docs in step if any go.

## Summary

| # | Candidate | Verdict | Cost |
|---|---|---|---|
| 1 | Agents working now, all runs | renderer-only | 0 calls (store `runs`) |
| 2 | Plan limits per connection, reset time, proxy periods | renderer-only | 0 (1 refresh already made) |
| 3a | Worktrees needing a person in live runs | renderer-only | 0 |
| 3b | Leftover report branches per project | renderer-only with N calls | 1 per code project, git spawns, throttle, mount only |
| 4 | Team assistant suggestions pending | renderer-only with N calls | 1 per project, 10-300 KB each, once per session |
| 5 | Services needing sign-in / a value | renderer-only with 2 (+N) calls | mcpLibrary.list + connectors.list; mcp.list for projects with own servers |
| 6 | Folder config untrusted / changed | renderer-only (untrusted); N calls (changed) | 0, or 1 per trusted project |
| 7 | Team files awaiting approval | renderer-only (already shown) | 0 |
| 8 | Runs, cost, time per day, 14/30 d | renderer-only | 0 (historyByProject) |
| 8b | Decisions answered count | needs contract: `RunUsage.decisions` | types.ts + runManager.ts (hot) |
| 9 | Last decisions answered | needs contract: recent-decisions channel | new channel; skip |
| 10 | Quick actions (resume, continue chat, template, open newest) | renderer-only (+1 call for templates) | 0-1 |
| 11 | Knowledge counts per engagement | needs contract: `knowledge:summary` | whole-graph reads otherwise; skip |
| 12 | Skill suggestions pending | N calls, but count unreliable (dismissals not persisted) | skip until dismissals persist |
| 13 | Needs-you on the page | renderer-only (exists) | 0 |
| 14 | Plan goal / current step, waiting & limit time, team makeup, open tabs | renderer-only | 0 |

## Best value for cost (my opinion)

1. **Working now, by agent** (items 1 + 14 plan step): one live board of "Analyst in Acme audit: Reading
   billing/export.ts" rows with the plan's current step and cost so far. It is the harness's core promise ("shows the
   work live"), the data is already in the store, and it replaces the thin "Running now" rows. Zero calls.
2. **Plan limits with reset time** (item 2): "Weekly 82%, resets Thu 09:00" and a 'rejected' line with
   `limitedUntil`. Decides whether the user starts work now; the data is loaded, only `resetsAt` needs reading.
3. **Activity strip, last 14 days** (item 8): runs and cost per day across projects, plus "waited on you N h" from
   `waitingMs`. Replaces the single 7-day cost figure with something a returning user can read at a glance; pure
   math over `historyByProject`.
4. **Setup problems tier** (items 5 + 6, untrusted only): "GitHub needs sign in (used by 3 projects)", "Acme API:
   this folder's settings are ignored". Two cheap cross-project calls plus fields already loaded; each row deep-links
   to an existing fix (`requestConnector`, `requestFolderTrustReview`). Keep it out of the decision count.
5. **Quick actions per project tile** (item 10): Continue last chat, Resume paused, Open newest run, New run, Start
   from template; all existing store actions. Makes the tiles do something instead of describing.

Deliberately left out: decisions answered and recent decisions (need contracts in hot files), knowledge counts (whole
graph reads), skill suggestions (count resurfaces dismissed items), and leftover branches unless the brief accepts a
throttled git pass on mount (worth a sixth slot for code-heavy users: it is the one real "work is stuck" signal not on
the page today).
