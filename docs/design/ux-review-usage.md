# UX review: how usage and cost are communicated (ahead of LiteLLM usage)

Method: built app, `ORGAI_MOCK=1`, fresh temp `ORGAI_DATA_DIR`, mock project with one live run, 1280x800 and 1100x720, dark theme
(light spot-checked on Connections at 1100x720). Screenshots in `e2e/shots/` (gitignored): `u-run-1280`, `u-popover-1280`,
`u-rail-1100`, `u-popover-rail-1100`, `u-history-1280`, `u-projconn-1280`, `u-conns-1280`, `u-conns-1100`, `u-conns-light-1100`.
Non-mock states (Claude plan windows, Codex limits, API key) are not reachable in mock; they were read from
`Sidebar.tsx`, `UsageMeter.tsx`, `lib/layout.ts` `costLabel`, `useAppStore.handleEvent`, `RunMeta`, `AgentNode`, `RunHistory`,
`connections/*`. The LiteLLM card stayed collapsed in the walk (its expanded fields were read from source only).

## What a first-time user sees today

- Sidebar footer (`u-run-1280`): a green dot and "Mock adapter" plus the gear. In the rail (`u-rail-1100`) only a dot. The popover
  (`u-popover-rail-1100`) says "Runs use scripted data. No plan limits apply." plus a button "App settings: Connections".
  Non-mock: the label is always `Claude · <method>` (`claudePill`), whatever connection the user actually uses. The 4 px bar and
  the "%" next to it exist only when a Claude plan window is reported.
- Run meta strip: "2 agents · ≈$0.00 · Started just now". Agent nodes show "≈$0.0054" each, so the two nodes (0.0108) and
  the strip ("≈$0.00") disagree at a glance (the strip had not caught up with the node costs, or the total is not summed
  from them; cause not confirmed from source).
- History table: Cost column "≈$0.00" with the tooltip "API-equivalent estimate; not billed on a subscription".
- App settings > Connections: three collapsed one-line cards (Anthropic, OpenAI, LiteLLM proxy) with status badge and Connect.
  Nothing about usage, spend or limits on any card. Project settings > Connection: three tiles with a status badge each, no usage.

## Findings

### P0

**U1. The sidebar account row speaks only for Claude, so a LiteLLM user sees nothing about LiteLLM and a wrong identity.**
Flow: first look at the sidebar. Step: read the account row. Expected: the row reflects the connection I am actually working
with (default for new projects, or the open project's connection). Actual: label is `Claude · <method>` from the `anthropic`
connection status, the bar and "%" come from the one `usage` slot, and with no Claude plan windows the bar is hidden. For a
LiteLLM-only user the row can read "Claude · not connected" (warn dot) while their runs work. This is the reported symptom
("usage estimates show nowhere") and it is also a trust problem. Fix: make the row connection-aware (see Recommendation A).

**U2. One `usage` slot, last writer wins.** `handleEvent` does `set({ usage: e.usage })` for every `usage.status`. The type
already carries `connection`/`provider` ("lets Codex limits show beside Claude's") but the store discards it: a Codex probe
broadcast overwrites Claude's windows, and the bar and popover flip between providers depending on which probe ran last,
with no label saying whose numbers they are. Adding LiteLLM to the same slot makes it worse (spend is not a percentage window).
Fix: key usage by connection (Recommendation B). This is a spec issue, sent to the Product Designer.

### P1

**U3. Cost labels use the global `usage.authMode`, not the run's connection.** `RunMeta`, `AgentNode`, `RunHistory` read
`s.usage?.authMode ?? 'unknown'`. A LiteLLM run is shown with "≈", which the tooltip explains as "not billed on a
subscription": wrong for a proxy where the money is real (against a budget). A Claude run seen while Codex limits are the last
report gets the wrong mode too, and a history row from last week is labelled by today's login, not the one it ran on. The
rule is per run. Fix: Recommendation D.

**U4. The popover has no place for "several connections".** It shows a single title and a single `UsageMeter`. Someone who
uses Claude for one project and LiteLLM for another cannot see both, and a closed popover shows only one bar. Fix: sections per
connection (Recommendation A and B).

**U5. Spend without a budget has no wording, and the mock-or-empty states are vague.** "Usage not reported yet", "No plan
windows reported" and "API key in use: no plan limits" all describe the Claude plan model. A LiteLLM key with no `max_budget`
would fall into one of them ("API key in use: no plan limits" if the inherited env says apiKey) and read as "nothing is
tracked", which is wrong. Wording in Recommendation C.

**U6. Strip, nodes and history disagree on a fresh run.** Strip "≈$0.00" with nodes at "≈$0.0054" each (`u-run-1280`). Either the
strip lags `run.cost` or it rounds differently. For a user watching spend against a budget, a total that does not equal
the parts erodes trust. Fix: format the total with the same function and update it on the same event; show cents once the
total passes $0.01, 4 decimals below.

### P2

**U7. Connection cards and the project Connection tab have no usage line.** The natural place a user looks to confirm the
proxy works ("is my key good? how much is left?") shows only "Connected". After the planned change the card needs a one-line
summary (Recommendation A, third bullet) and the project tiles need the same line under the status badge.

**U8. The popover's only action is "App settings: Connections"**, shown even when the popover has nothing to say (mock). Fine
as a dead-end exit, but a user who hits a budget limit needs "Open LiteLLM connection" and, for a Claude limit, the reset time.

**U9. Rail has no usage cue at all.** At <1180 px the row is a lone dot; the "%" and the 4 px bar are hidden
(`!rail`). A user near a budget limit gets no warning unless they open the popover. The dot's tone should carry the state
(warn from 80 percent, danger at the limit), and the aria-label and title should include the figure ("LiteLLM: $42 of $50").

**U10. Estimate semantics are hidden in a tooltip.** "≈" is only explained on hover, and hover does not exist on keyboard. At
least the History column header and run meta should carry the explanation once ("≈ means estimated at list prices").

### P3

**U11. "Reset due" and "Out of date" are not translated for spend windows.** If the budget has a reset (`budget_duration`),
reuse "Resets in 12d 4h"; do not invent a second format.
**U12. Settings copy names "plan windows" and "five-hour window cap"** (Limits section) while the popover says "Plan usage".
Pick one term family: "Plan limits" for subscriptions, "Spend" for proxies.

## Recommendations

### A. Where LiteLLM spend and budget should appear

1. Sidebar row: keep a single row (52 px) but make its label name the connection in use: the open project's connection if a
   project is open, else the default connection. `LiteLLM · $42 of $50`, `Claude · Max`, `Codex · ChatGPT Plus`. The 4 px bar
   shows the tightest figure of that connection (budget fraction for LiteLLM). No budget: no bar, label `LiteLLM · $42 spent`.
2. Popover: one section per connected connection that reports anything, ordered with the current one first and a heading per
   section (connection name, quiet). A LiteLLM section has: a row "Spend", "$42.10 of $50.00" with the same bar, and
   "Resets in 12d 4h" below, same layout as plan windows so `.usage-row` is reused. Sections for connections that report nothing
   are omitted (do not print "not reported" for three providers). Keep the "App settings: Connections" button at the bottom.
3. Connection card (App settings): add a quiet second line in the collapsed card, after the model count: "Key spend $42 of
   $50 · resets in 12d". Same summary under the status badge in the project Connection tiles. This is the verify-it-works
   place, so show a refresh time and an error state there ("Could not read spend: key lacks permission to /key/info").
4. Do not put spend in the topbar or on the canvas. Per-run cost stays in the run meta strip.

### B. Several connections without overwriting

- Store `usageByConnection: Partial<Record<ConnectionId, UsageStatus>>`, keyed on `usage.connection ?? 'anthropic'`. Keep the
  current `usage` selector as a derived value (current connection's entry) so existing readers keep working. The `usage.status`
  event already carries the key; the fix is only in `handleEvent` and `refreshUsage`.
- LiteLLM spend is not a rate-limit window: model it as its own shape (`spend`, `budget | null`, `resetsAt | null`, `currency`)
  on `UsageStatus` or a sibling, rather than faking `fiveHour`. `tightestWindow`, `UsageBar` and `usageRows` stay Claude and
  Codex only; add a `tightestFor(connection)` that returns a 0-100 for budgets.
- Throttle per connection: `refreshIfStale` has one `lastAttempt` and one `inFlight`; a slow LiteLLM call must not block
  Claude's 60 s refresh.
- Stale cue per connection, not global ("Out of date" after 15 minutes already exists; reuse).

### C. Wording

| State | Text |
| --- | --- |
| Budget set | `$42.10 of $50.00` / `Resets in 12d 4h` |
| Budget set, over 80 percent | same, bar solid warning; the label adds `84%` |
| Budget exhausted | `Budget used up` + `Resets in 3d`, danger bar, and in the run strip "Stopped by LiteLLM budget" |
| Spend, no budget | `$42.10 spent` and a hint `No budget set on this key` (not "no limits": the proxy may still rate-limit) |
| Spend, reset configured but no budget | `$42.10 spent this period · resets in 12d` |
| Not yet read | `Reading spend…`, then `Spend unavailable` + reason on hover and in the card |
| Key cannot read its own info | `Proxy does not share spend for this key` (a settled state, not an error) |
| Mock | keep "Runs use scripted data. No plan limits apply." and add "No spend is tracked." |

Avoid "usage" alone for LiteLLM (it reads as tokens); use "spend". Avoid "limit" for a budget the user may not have set.

### D. Cost labels follow the run's own connection

- Resolve the connection per run (`RunSummary`/project connection at start) and pass it to `costLabel(usd, kind)` where `kind`
  is `'estimate'` (Claude subscription, Codex ChatGPT plan), `'spend'` (API key, LiteLLM) or `'unknown'`.
- LiteLLM from the planned per-model prices: show a leading "≈" only because it is a computed estimate, with the tooltip
  "Estimated from LiteLLM model prices; your key's spend is the proxy's figure". When the proxy returns real per-request
  spend later, drop the "≈". Never reuse "not billed on a subscription" there.
- Stamp the kind on the run record at completion so History does not relabel old rows when the login changes.
- Strip, nodes, history and transcript header must read from the same helper and number formatting (U6).
- Where a mixed list exists (History across projects), keep the column and add the connection name to the tooltip, not a new
  column.

## Accessibility notes

- The bar is `role="img"` with an aria-label; the spend variant needs the same ("LiteLLM spend 84 percent of budget").
- Add live region announcement only on crossing 80 and 100 percent, not on every refresh.
- Rail popover is reachable by keyboard (verified); its title/aria-label must carry the figure (U9).

## Ranked summary

1. P0 U1 sidebar row is Claude-only, hides LiteLLM.
2. P0 U2 single `usage` slot overwritten by last report; must be per connection.
3. P1 U3 cost labels use global authMode, not the run's connection.
4. P1 U4/U5 popover has no multi-connection sections or wording for spend without a budget.
5. P1 U6 strip total disagrees with node costs.
6. P2 U7-U10 cards, rail cue, estimate explanation.
