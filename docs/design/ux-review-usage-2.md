# UX review: usage and cost UI (#10), walkthrough 2

Method: `npm run build`, `ORGAI_MOCK=1`, fresh temp `ORGAI_DATA_DIR`, driven with playwright over the built app. Project "UsageDemo" with three runs: a normal run (R1), `[mock:no-price]` (R2) and `[mock:computed-cost]` (R3). Passes: 1600x1000 dark (Live, Usage tab, History, Trends, App settings > Connections, Project settings > Connection), 1024x640 light (Live, Usage tab, Trends), 1600x1000 dark for the settings walk, one keyboard-only pass (Trends controls, Usage tab arrows, agent rows). Not repeated in all four theme/size combinations: Live and Usage at 1600 light and 1024 dark, Model prices at 1024. Shots (not in repo): `%TEMP%\uxu2\*.png` (1600-dark-usage-R2-node, 1600-dark-trends-cost, 1024-light-usage, 1024-light-live-R2-all, 1600-dark-p-err-empty, 1600-dark-p-saved, 1600-dark-hist). Compared with part A of `ux-review-usage-skills.md`.

## What is fixed since part A

- A1 (three precisions, tilde in some places only): largely fixed. One formatter (`costView`), one vocabulary across RunMeta, nodes, collapsed group, panel strip, History, Trends and the Usage tab: `$0.0057`, `unknown`, `$0.02+`, em dash.
- A2: the Usage tab sits beside Transcript / Plan / Logs, selects per node, and has a clear "Whole run" back control. A3: the no-result dim exists. A4: History has Runs | Trends. A5: prices live in App settings > Connections with a read-only link from the project. A6: wall time is on the meta line.
- Unknown cost is no longer `$0.00`. Cache read/write, hit rate, retries and a "waiting on you" time all exist.

## Findings, ranked

### P1

**P1-1. Mixed precision means totals still cannot be reconciled (Live meta, History, Trends, Usage tab).** `formatUsd` uses 4 decimals under $0.01 and 2 above. R3: agents `$0.0057 + $0.0043 + $0.0014` (sum 0.0114), meta line and History show `$0.01`, Trends totals `$0.02+` against role rows `$0.0086+` each. A reader sees a round number that disagrees with the rows beneath it, which is the same complaint as A1 at a smaller scale. Fix: 4 decimals whenever the value is under $0.10 (rows and totals), 2 above; or show totals at the finest precision any visible row uses.

**P1-2. "unknown" stands alone on the meta line and node strip with no noun (RunMeta, panel strip `mock-unpriced 3.2k in / 82 out unknown 58s done`).** Shot 1600-dark-live-R2-all: `3 agents · 58s · unknown · Started 4 min ago`. A first-time user cannot tell what is unknown (duration? start?). The title tooltip is hover only. Fix: prefix with the cost icon or word on those two surfaces ("Cost unknown", or a `$?` chip), keep bare `unknown` only in cost columns.

**P1-3. There is no route from "unknown" to the fix.** The Usage tab, History cell, node and meta say cost is unknown, but nothing says that a price can be set or where. The tooltip says "no price is known for the model used" and stops. Fix: in the Usage tab, when the cost is unknown or partial, add one line under the signals ("Cost is unknown for mock-unpriced. Set a price in App settings > Model prices.") with a link that lands on the section (see P1-4). Name the unpriced model, which the UI never does today.

**P1-4. Model prices is reached by a link that lands at the top of Connections, and the section is far below the fold (Project settings > Connection > "Open model prices"; App settings > Connections).** Confirmed open item. At 1600x1000 the heading sits at y 548; at 1024x640 it is off screen, under three provider cards. The explanation is also two stacked paragraphs ("What each model costs, used to estimate spend." then the units paragraph). Fix: scroll to and focus `#appsettings-section-model-prices` on arrival (the `orgai:settings-section` event already switches panes, extend it with a section id), or make Model prices its own nav item under Connections. Merge the two intro paragraphs.

**P1-5. "Add" for an override is below a 30-row built-in table, and the form opens at the top of the table (App settings > Connections).** Shot 1600-dark-p-err-empty: after clicking Add (at the bottom) the form appears above the table and the view lands with the form's first label clipped by the page edge. A first-timer wanting "set a price for my unpriced model" scrolls past 30 rows to find Add. Fix: put Add (and a filter box) in the section header next to the title, put override rows first (already true) and keep built-in rows behind a "Show built-in prices (30)" disclosure.

**P1-6. The Usage tab leads with 12 equal tiles; the findings sit below the fold at 1024x640 (Usage tab).** Shot 1024-light-usage: Cost, Tokens, Input, Output, Cache read, Cache write, hit rate, Turns, Tool calls, Retries, Auto-continues, Wall time, Waiting, Idle fill a 2-column grid of about 7 rows (roughly 600 px at 269 px wide). The efficiency sentences and the By agent / By role tables need two to three scrolls, so the most useful content ("2 agents spent 4.1k tokens and produced no result") is last. Fix: show Cost, Tokens, Wall time and hit rate as tiles, put the signals directly under them, and put the other ten behind a "More numbers" disclosure; or render the secondary stats as a compact dl list.

**P1-7. The "produced no result" signal flags the orchestrator and is misleading (Usage tab and node dim).** R2: "2 agents spent 4.1k tokens and produced no result" counts the Orchestrator, whose transcript is full of text and which spoke the final answer. The same `no-result` class is on the orchestrator node in R1 and R2. A user will read it as waste. Fix: exclude roots (or any agent with transcript text) from the no-result rule, or word it "ended without a report". Needs a Product Designer decision on the definition (spec-level).

**P1-8. The no-result dim is nearly invisible (Live nodes).** Light theme (shot 1024-light-live-R2-all): implementer-2 (no result) is indistinguishable from implementer-1; dark theme the difference is faint, and a selected dim node looks normal. It is opacity only, with no text. Fix: add a visible non-colour cue on the node ("No result" in the activity line, or a muted tag next to the cost) and raise the dim contrast, plus a `title`/aria label.

**P1-9. By agent table cannot tell two same-role agents apart.** Shot 1600-dark-usage-R2-node: two rows read "Implementer / implementer". The nodes say implementer-1 and implementer-2. Fix: show the instance slug in row two (`implementer-2`) and highlight the selected row more strongly (the current highlight is subtle).

### P2

**P2-1. Usage tab selection is not remembered per run (confirmed open item).** Switching run tabs or back from History returns to Transcript; a user reading Usage across runs re-clicks it each time. Fix: persist the active panel tab per run id in the store (`orgai.panelTab.<runId>`), default Transcript for new runs.

**P2-2. At 1024x640 the Usage tab is two clicks away.** The side panel is a rail by default (`Show run panel`), so the user must open the panel and then pick Usage. Fix: add a small cost figure on the rail or a "Usage" affordance in the meta line (cost opens the tab).

**P2-3. Trends cost tooltip says "Reported by the provider" (confirmed open item).** `COST_TITLES.provider` is used for aggregates mixing computed and provider costs; it is false for a computed total. The chart column tooltip, in contrast, only gives tokens even in Cost mode. Fix: aggregate wording "Provider-reported and computed costs", and make the column tooltip follow the selected metric.

**P2-4. Hatched partial bars are not explained.** The note "Hatched bars are days whose cost is unknown" only appears when a bucket is wholly unknown. Shot 1600-dark-trends-cost: Oct 30 is hatched (partial, `$0.02+`) and there is no key. Fix: show the note whenever any bar is hatched, worded "Hatched: some runs have no known price, so the cost is a minimum."

**P2-5. Chart is bare at low data.** One bar in a 30-day axis with only "Oct 1" and "Oct 30" labels, no y-axis or value label; values appear only on hover (columns are not focusable, keyboard users must open the table). Fix: print the value above each non-zero bar (or on the table by default when fewer than 3 buckets have data) and make columns focusable.

**P2-6. Trends table columns are far apart at wide widths (Runs, Tokens, Cost).** Shot 1600-dark-trends-cost: Day at left and the numbers pushed to the right with large gaps. Cap the table width (about 520 px) or add a divider.

**P2-7. Trends has no All / Work / Setup filter, and History Runs does.** Whether setup runs are counted is unstated. Add a one-line note ("Includes work runs only") or the same filter.

**P2-8. Price formatting drops trailing zeros: `$12.5`, `$0.1`, `$6.25` in one column (Model prices).** Fix: format as `$12.50`, `$0.10`, or use a consistent two to three decimals; put "per 1M tokens" in the column headers instead of the paragraph.

**P2-9. Source and computed-vs-reported are hover only.** `$0.0029` (provider) and `$0.0057` computed look the same. Fine for most users, but there is no visible mark. Fix: a small `computed` or tilde marker on computed figures in the Usage tab only.

**P2-10. No unsaved-form guard and no confirmation of Clear (Model prices).** Clear removes the override immediately from the reset icon (reversible by re-adding). Validation is good ("Enter a price, or 0 if it is free.", "Use a plain non-negative number, like 3 or 0.30."), the section shows "Saved 04:19 PM" in the header, but there is no per-row confirmation. Acceptable; add an undo toast or a tooltip naming the result ("Restores the built-in price").

**P2-11 (nit, mock only). Run titles lose bracket tokens ("Pricing unknown mockno-price").** Mock title generator artefact; real titles unaffected.

## Keyboard pass

- Trends: range, group and metric are radio groups (one Tab stop each, arrows within), "Show as table" is reachable, the chart is `role=img` with a summary. Good. Columns are not focusable (P2-5).
- Usage tab: Transcript, Plan, Usage, Logs respond to ArrowRight and Enter, the panel is a focusable scroll region, agent rows are real buttons that scope the tab, and a Whole run button returns. Good.
- Model prices: edit and clear icon buttons carry the model in their labels ("Edit override for mock-unpriced"). Good.
- Focus after Save and after Clear was not verified to land anywhere meaningful (the form disappears; focus likely returns to the body).

## Confirmation of known open items

| Item | Verdict |
| --- | --- |
| Usage tab selection not remembered per run | Confirmed, P2-1 |
| Model prices link lands on Connections, not the section | Confirmed, P1-4 (rank up: it is the only exit from "unknown") |
| Trend cost tooltip says "Reported by the provider" | Confirmed, P2-3 |

## Ranked summary

1. P1-3 and P1-4: unknown cost has no path to the fix; the link lands at the top of Connections with Model prices below the fold.
2. P1-1: totals and rows disagree in precision (`$0.01` over rows summing to $0.0114).
3. P1-2: a bare `unknown` on the meta line.
4. P1-6: Usage tab buries the efficiency sentences under 12 tiles at 1024x640.
5. P1-7 and P1-8: the no-result rule flags orchestrators and the dim is invisible in light theme.
6. P1-5, P1-9: Add price at the bottom of a 30-row table; indistinguishable same-role rows.
7. P2s: remembered tab, rail access, tooltip wording, hatched-bar key, bare chart, price formatting.
