# UX review: app-wide Usage page, pre-design walk of what exists

Reviewer: UX Researcher. Build: 0f8008e1 (dev, version 0.1.7-dev1), `npm ci` and `npm run build` in this worktree.
How it ran: built app, `ORGAI_MOCK=1`, throwaway data dir, no tokens. Windows 11. Sizes 1024x640 and 1600x1000 (`setContentSize`), dark and light (`data-theme`), mouse pass then a keyboard Tab pass on the Dashboard and Trends. Nothing in source was changed.
Compared with: the brief only (no spec yet); contracts read in `src/shared/types.ts` (`UsageStatsQuery`, `RunUsageRow`, `UsageTrendPoint`).
Screenshots: `e2e/shots/ux/usage-app/` (gitignored, not committed). Walk scripts, raw text dumps (`notes.txt`, `notes2.txt`) and seed log are beside them.

Seed data (mock): 3 projects, Alpha API (code), Beta Web (code), Acme Review (engagement, client Acme Corp). 9 work runs: default, `[mock:deep-tree]`, `[mock:no-price]` and `[mock:computed-cost]` markers, one Ask (single-agent) run, plus one Chat run. Each run was ended with Stop after reaching Idle, so all show "Stopped". The mock produces tiny numbers (a run costs under one cent, about 5k tokens, all on one day), so charts have one bar and no trend. Real multi-week data is not seen.

## Verdict: NO APP-LEVEL ANSWER TODAY

Every cost and efficiency view is scoped to one project or one run. The only app-wide numbers are on the Dashboard: one 14-day strip with three totals and a per-tile "last 7 days" figure. From these a user can see "$0.06+ today" and nothing more. They cannot ask "this month, across everything, what did I spend, on what, and which runs were wasteful". The per-run data for the efficiency half of that (retries, nudges, no-result tokens, waiting) is collected and shown on one run's Usage tab, and the trend contract carries it per day, but the Trends UI shows none of it. The usage query takes one `projectId`, so an app-wide page needs a contract change, not only a new screen.

## Findings

### Critical
None. Nothing loses data or misleads in a way that causes harm.

### High

**H1. No way to see spend across projects, models or the month.**
Evidence: Dashboard strip says `Runs 10, Cost $0.06+` for 14 days (`dash-l-dark.png`), and each tile says `$0.02+ last 7 days`. The strip day buttons are not links: clicking Today only changes the readout (`strip-click-l-light.png`, no navigation). Trends exists only under Project > History > Trends (`trends-element-l.png`) and `runs:usageStats` requires `projectId` (types.ts `UsageStatsQuery`). Trends has no model breakdown at all (By role and By kind only).
Repro: Dashboard, try to find this month's total. Open each of the three projects, History, Trends, Month, and add three numbers by hand: Alpha `$0.01856+`, Beta `$0.01859+`, Acme `$0.01859`, which sum to about $0.0557 and leave out the Chat run's `$0.001425`, which belongs to no project; the Dashboard shows `$0.06+` for the same runs, rounded to two decimals, so neither side can be checked against the other.
Cannot answer today: month total across everything; which project costs most (tiles show last-7-day only, no sort, no share); which model costs most (no model view anywhere except the per-run unpriced note); what Chat costs in total; spend this month versus last month.
Fix: an app-level Usage page (see "Entry point") with project, model, role and kind breakdowns for a chosen month or range, reusing the Trends pieces.

**H2. Efficiency ("which runs were wasteful") is visible for one run only and invisible in every list.**
Evidence: the Usage tab of R3 (no-price run) says "1 agent spent 820 tokens and produced no result." and "1 API retry slowed the run down." (`usage-noprice-l-dark.png`). History rows (`notes.txt` "history list") show only Status, Cost, Age, Kind. Trends totals are Runs, Tokens, Estimated cost, Run time, Waiting on you. Yet `UsageTrendPoint` already carries `retries`, `nudges`, `noResultTokens`, `waitingMs`, `toolCalls`, `turns`, and `RunUsageRow.usage` carries the same per run. A user must open each run and its side tab and expand "More numbers" to find them.
Repro: Alpha > History > Runs: R3 looks identical to R2 except "unknown". Open R3 > Live > Usage to learn it wasted tokens.
Fix: a sortable run table on the Usage page with columns Cost, Tokens, Retries, No-result tokens (and its share of tokens), Auto-continues, Waiting. A "Needs a look" filter (any retry, any no-result tokens, nudges above N).

**H3. Totals mix known, partial and unknown cost without saying how many runs each covers.**
Evidence: Alpha Trends: Runs 4, Estimated cost `$0.01856+`, but R3 has cost "unknown" in full, so the figure leaves out a whole run and only a trailing "+" says so (`trends-s-dark.png`, History list shows R3 "unknown"). Acme Trends: role row `Specialist $0.009975+` but the total and By kind show `$0.01859` with no "+" (`trends-acme-l-light.png`). The same data is "partial" in one place and "complete" in another. `UsageTrendPoint.costUnknownRuns` exists but is not shown. The Dashboard `$0.06+` and tile `$0.02+` have the same "+" with no count.
Fix: replace the bare "+" with a count wherever a total is shown: "$0.0186 from 3 of 4 runs. 1 run has no price." linking to those runs, and fix the role/total inconsistency (one rule for when a total is a lower bound). Copy below.

### Medium

**M1. Trends chart is mouse-only.** Chart bars have `title` tooltips ("Nov 7: 4 runs, 17k tokens") and `tabindex=-1` on all 30 (measured). A keyboard user hears only the summary on the `role=img` chart and must open "Show as table" (works; `trends-table-l-light.png`). The Dashboard strip is better: 14 day buttons are one Tab stop with arrow keys and a readout ("Fri 6 Nov: no runs" after ArrowLeft). For an app-level page with drilldown, make bars real buttons with the strip's roving pattern and a readout line, and let Enter drill into that day's runs.

**M2. The two-state toggle and range controls reset or hide state.** Trends keeps a "Month" choice with a 25-entry month list; theme/size changes in my walk kept it, but nothing says which range the totals cover once you scroll (the range controls are not sticky, and the "Every run in this range" note is generic). With a month picker and Tokens/Cost toggle already separate, a page header that states the scope ("All projects, November 2026, 10 runs") is needed.

**M3. Cost precision is inconsistent.** Same run family shows `$0.00855`, `$0.001425`, `$0.009975+`, `$0.01856+`, `$0.06+` (Dashboard strip, 2 decimals), `$0.02+` (tile). Mock amounts are tiny, but real runs will show `$1.2` next to `$0.001425`. Column alignment and comparison across a table need one rule (for example 2 decimals at or above $1, 3 below, "< $0.01" floor, full precision on hover/title).

**M4. Chat and Ask runs have no home in the app-level story.** The Dashboard strip counts the Chat run (10 runs, matches 9 project runs + 1 chat) but no project Trends does, and Chat's History has a Runs | Trends switch of its own (seen in `chat-history-l-light.png`; I did not open its Trends). A user adding up project Trends will always be short. The Usage page needs a "Chat and assistants" row group, and Ask runs are a kind (By kind shows "Ask" separately, good).

**M5. Drilldown stops at the run.** History row > Open lands in Live with the transcript, and the side panel needs "Show panel" at 1024 plus clicking the Usage tab. At 1024x640 the Usage tab is a 300 px column where agent names truncate: `mock-lead-re…` twice, so report-1 and report-2 cannot be told apart (`usage-deep-s-dark.png`). A usage drilldown that needs per-agent comparison needs width (a dialog or page section), or a title with the full name on every truncated cell.

**M6. Efficiency lines do not name the culprit.** "1 agent spent 820 tokens and produced no result." does not say which agent; the row is only dimmed (`implementer-2`, greyed text in `usage-noprice-l-dark.png`) with the explanation in a `title`. Fix: name it in the sentence ("implementer-2 spent 820 tokens and produced no result.") and add a "No result" text tag on the row, not only a dim colour (the dim is colour-only information).

**M7. Dashboard strip does not lead anywhere.** The strip is a good one-glance instrument (rule: keep), but its days are buttons that only update a readout line, and the totals are not links. At 1024 the whole block is ~190 px of height for three numbers. It is the natural entry to the Usage page: make the heading "Last 14 days" a link ("Usage") and a day press-and-Enter open the page filtered to that day.

### Low

**L1. Account popover has no usage under the mock** ("Runs use scripted data. No plan limits apply. No spend is tracked.", `account-s-light.png`), so the plan-window meter (`usage-no-five-hour`, tightest-window bar) could not be walked. Its place next to the new page needs a real-account check (see Not driven).

**L2. "Estimated cost" vs "Cost".** Trends says "Estimated cost", the Usage tab and strip say "Cost", History column says "Cost". "Estimated" is right for token-priced runs and wrong for provider-reported; pick one word per source or explain once.

**L3. "Run time" 18s vs "Wall time" 6s vs "Waiting on you 0s" vs "Idle".** Trends "Run time" is a sum of wall times across runs, the Usage tab says "Wall time", and "More numbers" has both "Waiting on you" and "Idle" with no explanation. A first-time user cannot tell what is counted. Add a one-line definition or title on each.

**L4. "Recorded before usage tracking, so these numbers are approximate." (legacy note)** was not seen (mock runs are new). The term "approximate" does not say which figure is wrong. Needs a re-walk with a legacy record; suggested copy below.

**L5. Mock artefact, not a product finding:** run titles from the mock read "Price check mockno-price", "Ask what does the" (marker text is cut into the title). Real titles come from the model.

## Questions a user cannot answer today

1. How much did I spend this month, in total, across all projects and chats?
2. Which project, which model, which role costs the most? (models: no view at all)
3. How does this month compare with last month or with the same month of last year?
4. Which runs were wasteful (retries, no-result tokens, auto-continues, waiting) without opening each one? Which projects waste the most?
5. How many of my runs have no price, and which models are they, across the app?
6. What did Chat and Ask runs cost in total?
7. What does a typical run in project A cost versus project B (cost per run, tokens per run, cost per finished versus stopped run)?
8. Did a given model or role get cheaper or dearer over time?
9. Which day was expensive, and what ran that day? (Dashboard strip day press shows only a one-line readout.)

## Existing pieces to reuse or link

| Piece | Where | Use on the app-level page |
| --- | --- | --- |
| `UsageTrends` controls, totals row, per-day chart with Tokens/Cost toggle, table disclosure, By role, By kind, CSV | Project > History > Trends | Reuse as the page body; add project and model groupings. Keep "Show as table". |
| `Cost` / `costView` rules (unknown is never $0, "+" lower bound) | `lib/cost.ts`, `components/ui/Cost.tsx` | Reuse as is; add the run-count of unknowns. |
| `UnpricedNote` + "Set a price" deep link to Model prices | Run Usage tab | Reuse as an "N models have no price" callout with the same link. |
| Run Usage panel (By agent, By role, More numbers, efficiency lines) | `UsagePanel` | Final drilldown level; open from a run row in a dialog or the existing side panel, not by leaving the page. |
| Dashboard strip (`ActivityStrip`, roving day buttons, readout) | Dashboard | Keep; link it to the page. Reuse its roving-focus pattern for chart bars. |
| Per-day trend fields `retries`, `nudges`, `noResultTokens`, `waitingMs`, `costUnknownRuns` | `UsageTrendPoint` (contract only) | Surface them; they exist and are unused in the UI. |
| Model prices section | App settings > Connections > Advanced | Link target only. |
| Run chain and History rows | Project History | Row click target; show Usage tab on open. |

## Entry point

Recommended: a sidebar nav item named "Usage" directly under "Dashboard" (rail: its own icon, tooltip "Usage"), plus View > Usage in the application menu (the menu has Live, History, Team, Project settings as Ctrl+1..4; give Usage its own action and shortcut, atlas and shortcuts entries needed) and a "Usage" link on the Dashboard strip heading.
Why not App settings: it is a place you go to change things, and usage is read-mostly and needs the room (Settings columns are about 1120 px wide at most). Why not Dashboard only: the Dashboard's job is "what needs me now"; a month-level table does not fit there. The page should work from the Dashboard strip, the sidebar, the menu and a Chat/assistants deep link.
Seen today: the sidebar has Dashboard, Assistants (Chat, MCP assistant, Skill assistant), then projects. `View` ids in the store are 'projects' | 'team' | 'settings' | 'run' | 'history' | 'outputs' | 'knowledge' | 'appSettings'; none is app-wide usage (read from code).

## Natural drilldowns

Top: header scope ("All projects", range, kinds) and totals (Runs, Tokens, Cost with run counts, Run time, Waiting, Wasted tokens share).
Then one chart (per day, Tokens/Cost) and one group-by selector with the same table shape for each: Project, Model, Role, Kind, Connection.
Then: Project row > the same page filtered to that project with its runs listed (Cost, Tokens, Retries, No-result tokens, Nudges, Waiting, Status), sortable. Run row > the Usage panel content in a dialog, with a link "Open run". Agent row inside that run > select the agent in Live (the existing `onSelect`). Day bar > the runs of that day. Model row > the roles and projects using it, plus "Set a price" when unpriced. Everything keyboard-reachable; every drilldown shown as a breadcrumb chip that can be removed.

## Recommended copy

- Page title: "Usage". Subtitle: "What your runs cost and where the time and tokens went. Costs are estimates unless your provider reports them."
- Scope line: "All projects and chats, November 2026 · 10 runs".
- Cost total with unknowns: "$0.0186 from 3 of 4 runs" with a link "1 run has no price". Never a bare "+". Tooltip: "A lower bound. Runs with no known price are left out of the sum."
- Unknown cost cell: "No price" (with the model id on hover) instead of "unknown", and a column footer: "2 models have no price. Set a price".
- Efficiency chips: "Retried 2 times", "No result: 820 tokens (14%)", "Auto-continued 3 times", "Waited on you 12 min". Filter: "Runs that need a look".
- Efficiency sentence naming the agent: "implementer-2 spent 820 tokens and produced no result."
- Legacy: replace "Recorded before usage tracking, so these numbers are approximate." with "This run is from before OrgAI measured usage. Tokens and cost here are rough, and efficiency figures are not available."
- Definitions (title or one-line help): Run time "Time the run was working", Waiting on you "Time it waited for an answer or an approval", Idle "Time the session was open with nothing to do".
- Empty month: "No runs in November 2026. Pick another month." (not an empty chart).
- Chat row group name: "Chat and assistants".

## Not driven

- Plan-window meter in the account popover, spend by period for a proxy, and "five-hour window not reported": the mock adapter hides them (`account-s-light.png` shows only "No spend is tracked").
- Multi-day and multi-month trends, week buckets with several bars, a month with many runs, windowing at 300+ rows: all seed runs landed on one day.
- A legacy ("recorded before usage tracking") run and the partial-cost sentence with a real priced+unpriced mix inside one run: the mock only gave fully unknown (R3) or fully priced runs.
- Multi-connection runs ("By connection" table) and proxy spend: not seeded.
- Copy as CSV / Save CSV results (clipboard and download) not checked.
- Screen reader output (chart `role=img` summary text and table disclosure read only from the DOM), forced colours, macOS.
- Real prices, real model ids: the mock reports `mock-unpriced` and invented models, so a By model view could not be judged for density.
- Unfinished-run behaviour: all runs were ended by Stop; live runs mid-cost and the Dashboard strip while a run is working were not seen in this walk.
- Keyboard pass covered the Dashboard (Tab order reaches the strip as one stop, then tiles) and the Trends chart (not focusable); the Usage tab and History were mouse-driven.
- The seed script's last diagnostic call crashed (`usageStats` with no project id: "Project not found"), which itself shows the contract's single-project limit; it did not affect the data.
