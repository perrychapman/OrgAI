# UX review: placement for usage/efficiency tracking (#10) and skills (#11)

Method: built app, `ORGAI_MOCK=1`, fresh temp `ORGAI_DATA_DIR`, driven with playwright over the e2e helpers at 1600x1000 (dark), 1024x640 (light) and a 1600x1000 light pass. Keyboard-only pass not repeated for this placement review (no new controls exist yet). One MCP library entry was seeded through the preload API. Shots (not in repo): `%TEMP%\uxw\shots\` (03/04 live, 05 node, 10-set-*, 11 inspector, 20 MCP library, 21 add-from-library, 22 run idle, 25 History, 28/29 light 1024). Not walked: Org retrospective result (button is hidden while the run is Idle; it only appears once a work run has ended), and a skill/MCP grant from the inspector (MCP has none, see B2).

## Part A: usage and efficiency (#10)

### What is confusing about cost and usage today

1. **Three precisions for one number (P0 for a feature built on cost).** Same run, same moment (shot 22 and 27): meta line `≈$0.02`, Orchestrator node `≈$0.0081`, side panel strip `$0.0081 est.`, collapsed group `$0.0081` (no tilde), later panel `$0.01 est.`, node `≈$0.01`. In shot 03 the two nodes show `≈$0.0054` each (sum 0.0108) while the meta line says `≈$0.00`. `formatCost` switches between 2 and 4 decimals at 0.01, and the tilde is dropped in the collapsed "1 done" group. A user cannot reconcile agent sums with the run total. Fix: one formatter for every surface (4 decimals under $0.10, 2 above), the tilde always present or always absent per auth mode, and the meta total must equal the sum of what is visible.
2. **Cost is a single `number`, so "unknown" cannot exist.** `AgentInstance.costUsd` and the History Cost column show `≈$0.00` for a mock or unpriced provider, which reads as "free". The brief asks for "unknown" rather than $0. This needs a contract change (nullable cost plus a `priced` flag) before any UI. Spec-level: raise with the Product Designer.
3. **Tokens are shown as one lump at the node (`1.6k tok`) and as `1.6k in / 42 out` only in the side panel strip.** No cache read or write anywhere, so the cache hit rate has no source in the UI today. The node's lump hides that cheap cached tokens and expensive output are different things.
4. **No run duration, turns or tool calls on the meta line.** Meta says `2 agents · ≈$0.02 · Started just now · unattended`. "Started just now" does not tick (still "just now" 40 s later) and is the only time signal. Wall time only appears per agent in the panel strip (`38s`).
5. **History has one number per run.** Columns: Prompt, Status, Cost, Age, Kind. No tokens, duration, or per-role split, no totals row, no sort. A user cannot answer "what did this week cost".
6. **Cost cap and plan-share limits sit in Limits without any view of current usage.** The cap (`Estimated-cost cap per run`, placeholder "No cap") offers no hint of typical run cost, so users cannot pick a number.
7. **Cost labelling differs by auth mode** (`≈` on subscription, plain on API key) but the History column header just says "Cost". The tooltip explaining "API-equivalent estimate; not billed on a subscription" is hover-only and absent on touch/keyboard.
8. **Connection pane is a status pane, not a model pane.** It shows three provider cards, "4 roles use this connection · Everyday tier: sonnet" and a collapsed "Role models" disclosure, and a Mock-adapter switch. There is no price information, so a price override has no neighbour yet.

### Findings and placement (ranked)

**A1 (P0): Unify cost semantics before adding anything.** One shared `CostFigure` (value, `unknown`, estimated vs billed) used by meta, node, panel, tray, History, sidebar. Without it every new column inherits the inconsistency in point 1. Placement: `lib/layout.ts` formatter plus one component; no new screen.

**A2 (P0/P1): Run meta line stays a one-line summary, with the detail in a popover opened from the run strip, not a floating panel over the canvas.** RunMeta is a 32 px toolbar; cramming input/output/cache/turns/tools there will truncate at 1024 (shot 28 already drops to icon-only controls). Recommendation: keep `2 agents · ≈$0.02 · 38s` plus one new chip `Usage`; the chip opens a side-panel tab, not an overlay.
   - Side panel gets a fourth tab next to Transcript / Plan / Logs: **Usage** (the panel already shows the agent's `mock · 1.6k in / 42 out · $0.0054 est. · 2s · delegating` strip, which is the natural summary header for that tab). Usage tab content: run totals (in, out, cache read, cache write, cost, wall time, turns, tool calls), then a per-agent table, then efficiency signals as plain sentences ("Cache hit rate 71%", "2 retries, 1 continuation nudge", "Idle 14s, blocked on you 38s"). The panel stays docked, resizes with the existing handle and goes under the transcript at wide widths.
   - Selecting an agent node scopes the tab to that agent, so "agent" and "role" tracking share one place.

**A3 (P1): Agent node: do not add more numbers.** The node already holds name, slug, model, activity, tokens, cost. Add at most one signal: a small "no output" treatment (dimmed cost, `no result` text) for agents that spent tokens and produced nothing. Everything else lives in the Usage tab. Nothing floats; tooltips only repeat what is in the tab.

**A4 (P1): History tab is the home for cross-run trends and per-role comparison.** Recommendation: History keeps its table (add Tokens, Duration, Turns columns, collapsible below 1100 px via container query) and gets a segmented view toggle `Runs | Trends` in the existing header, where `All / Work / Setup` already sits. Trends: cost per finished task, cache hit rate and nudges per run as small sparkline rows; a role table (tokens, cost, share of spend, "produced nothing" count). Row click opens the existing run; a run's usage detail opens on the Live tab Usage tab via Open.
   - Avoid: a separate top-level "Usage" tab. The project tabs are already Live, History, Org chart, Settings; History is where users look for past cost.

**A5 (P1): Per-model price override goes in App settings > Defaults or a new "Pricing" section next to Connections, not Project Limits.** Prices are per model and per provider, app-wide (mock and LiteLLM gateways need them most). Recommendation: App settings > Connections gets a `Prices` disclosure under each provider card (table of model, input, output, cache read, cache write per million tokens, blank = "unknown"), because Connection already owns the provider/model mapping. Project Connection gets a read-only link "Prices: App settings > Connections" matching its existing "Role models" read-only disclosure and its `App settings > Connections` link. Limits stays for caps; add one line under the cost cap showing the last run's cost for calibration.

**A6 (P2): Fix the stale "Started just now" and add elapsed wall time on the meta line.** A running run should show a ticking `38s`/`2m 10s`; a finished run the total.

**A7 (P2): History status vs run status.** After the run went idle, the History status pill says `Idle` while the retro action is hidden until the run ends. Not a usage issue, but trend views will count "finished tasks"; define what counts as finished (user-ended vs idle) first.

## Part B: skills (#11)

### What the MCP pattern does well (copy)

- Library page (App settings > MCP library, shot 20): one-line explanation ("Define a server once; any project can link it."), three creation routes in one toolbar (registry, manual, AI-assisted), cards with scope/provenance chips (`Remote server`, `You`, `Secrets: 0 of 1 set`) and a live "Not used by any project" line. Copy the "used by" line and provenance chip for skills.
- Project Tools (shot 10-set-Tools / 21): `Add from library` is the primary button, the empty state points back to the library, and the add dialog explains link semantics in one sentence ("Edits in the library reach every project that links it"). Copy the primary-link-first order and the sentence.
- Removal copy says which roles lose access right away (`McpSection` confirm). Copy for unlink and delete.

### What to avoid or fix in the pattern

**B1 (P0): "Plugins ... Add a folder to give agents its skills" already lives next to MCP in project Tools (shot 10-set-Tools).** A new Skills library will collide with this wording. Users will not know whether plugins or skills carry skills. Placement: rename the pane group to a single `Tools` page with three sections in this order: **Skills**, MCP servers, Plugins, and reword Plugins to "Claude Code plugin folders (may bundle skills, MCP servers and commands)". Surface plugin-provided skills in the Skills list read-only, labelled by source, so there is one place to see everything an agent can load.

**B2 (P0): MCP grants roles from the server side (`RoleAccess` inside each server row in Tools), and the role inspector (shot 11, 29) has no MCP section at all.** The brief wants per-role skill grants in the inspector. Do both, not one: in the inspector add a `Skills` group between Tools and Delegation (checkbox list like Tools, with the source chip and "from library" marker), and in each skill row keep a compact `Roles: all / 3 roles` control. Then backfill an `MCP servers` group in the inspector so the two patterns are consistent. Without that, users learn that grants live in Tools for MCP and in the inspector for skills.
   - 1024x640 caveat: the inspector is already about 1.5 screens long (Identity, Model, Tools, Delegation, Instructions). A third checkbox group adds scroll; use a collapsed disclosure with a count (`Skills · 2 of 5`) and put it above Instructions.

**B3 (P1): Library and project lists need a bulk "Import from repo" flow that reuses the Agent import dialog, not a new pattern.** Org chart already has `Import agents` (+ not-imported banner, Undo notice). Skills import from `.claude/skills` should appear (a) as a toolbar button `Import skills` in Tools > Skills and (b) as a second line in the existing "found agents" banner/New project found-line ("Found 2 agents and 3 skills."). Reuse preview -> apply -> Undo.

**B4 (P1): Skill-load events in the transcript, not the canvas.** The transcript already has quiet system rows (harness entries) and tool rows (`Read README.md ▶ Show details`). Add a `Skill: <name>` row of the same weight with the skill source in details. On the node only surface it via the existing activity line ("Using skill api-design"), no badge. Avoids more chrome on 1024 wide nodes.

**B5 (P1): "Evaluate skills" belongs in the Skills section header and as an Org retrospective sibling, with suggestions as decision cards.** The tray shows the first open decision (shot 03/04: Permission card with Allow once / Allow for session / Always allow / Deny); a skill suggestion card should use the same shell with `Apply` / `Dismiss` and a diff of the SKILL.md. Results: a `Last evaluation` summary row in Tools > Skills (date, N suggestions, N applied) and a History entry (`Kind` = `skill eval`, reusing the `All / Work / Setup` filter with a new `Evals` option). Do not put the action only in the run strip: it only appears at run end today (the retrospective button was absent in the Idle state, so users will not find it).

**B6 (P2): Naming.** The library uses "MCP library"; use `Skill library` as a sibling nav item (App settings nav is General, Connections, MCP library, Defaults, About). Consider "Libraries" as a parent only if more appear. Project side: `Skills` heading inside Tools, not a new project nav item (the Settings nav already has six items).

**B7 (P2): Skills and approvals.** A skill can grant effective tool use (it carries instructions that cause Bash/Edit). The grants UI should show elevated-tool hints like the agent import dialog does (`elevatedTools`) so a user sees "may run shell commands" before granting.

## Cross-cutting notes

- Nothing in these recommendations floats over the canvas: new surfaces are the side-panel Usage tab, History views, settings sections, and the existing decision tray.
- At 1024 wide the sidebar becomes a rail and the side panel competes with the canvas (shot 29). Any new panel tab must keep its table readable at 280 px: use stacked key/value rows under a container query, not wide tables.
- The first pass here is on mock data; real subscription runs will have cache read/write numbers that the mock does not produce. Spec check with the Adapter Engineer that the mock emits cache tokens, a null cost and a failed/idle agent, otherwise the Usage tab cannot be walked in review.

## Ranked summary

1. P0 A1: cost is shown at three precisions with and without the tilde, totals disagree with agent sums (shot 03: nodes sum 0.0108, meta says $0.00).
2. P0 A1/A2 contract: no "unknown" cost, no cache tokens in the model; UI cannot show either until `types.ts` changes.
3. P0 B1: the Plugins block already promises skills; unify under one Tools page with Skills first.
4. P0 B2: MCP grants live server-side, the inspector has no grant group; do both for skills and backfill MCP.
5. P1 A2: Usage as a side-panel tab, meta line stays one line.
6. P1 A4/A5: trends in History (Runs | Trends), prices under App settings > Connections.
7. P1 B3/B4/B5: import-from-repo via the agent-import pattern, skill rows in transcript, evaluation as decision cards plus a History kind.
8. P2: ticking elapsed time, naming, elevated-tool hints.
