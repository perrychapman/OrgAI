# UX review: LiteLLM spend by day, week and month (design walkthrough)

UX Researcher, build `ad2ee6d`, `ORGAI_MOCK=1`, fresh temp data dir, 1600x1000 and 1024x640, dark and light, one
keyboard pass at 1024x640 light. Compared with `dashboard.md` 5.2, `ux-review-usage-2.md`, `UsageMeter.tsx`,
`Sidebar.tsx`, `FactsCards.tsx`, `usage.css`, `shell.css`. Shots and scripts: `e2e/shots/ux/litellm-periods/`
(gitignored). The mock hides the spend bar and figures, so geometry was measured by swapping candidate label text into
the live row; no LiteLLM figure was seen. `periods` is not in `UsageSpend` yet (types.ts ~2826).

## Verdict: DESIGN NOTES, no blocker

The row has room for one figure: today's spend, with the budget on the bar. The popover lists the three periods as a
definition list and the Dashboard card repeats the row's line.

## 1. Account row

Measured: full sidebar row 179 px at the default 232 (147 at 200, 367 at 420), 36 px tall inside the 52 px footer;
rail 43x36 with no bar or text. With the 24 px bar, two gaps, the dot and padding, the label gets about **115 px** at
232 and **83 px** at 200. Label widths at 12 px: "LiteLLM · $3.20 today" 112, "LiteLLM · $42.10 of $50.00" 137
(clipped at 200 today), "LiteLLM · $142.10 of $500.00" 150, a combined "today · budget" line 208 (fits only near 420).

Recommendation:

- `periods.day` present: `LiteLLM · $3.20 today`. Else `periods.week`: `LiteLLM · $12.40 this week`. Else the
  current budget text. Never two figures.
- `title` and the rail name (`triggerLabel` already reuses the label) carry the whole sentence:
  `LiteLLM spend: $3.20 today, $12.40 this week, $31.00 this month. $42.10 of $50.00 budget.`
- The 4 px bar keeps one meaning: share of the key budget (warn 80 %, danger 100 %). No budget: no bar, as now. A
  "today" bar has no denominator and would mislead.
- The dot tone stays the budget level; a "today" figure never turns it amber.

## 2. Popover `SpendSection` (320 px panel, `.usage-meter` min 15 rem)

```
Spend                         $42.10 of $50.00   <- usage-head, bar below, "Resets in 12 d"
Today        $3.20
This week    $12.40
This month   $31.00
Since Mon 2 Nov (tooltip per row)
```

- Markup: a `dl.spend-periods` with `dt`/`dd` rows (mono `dd`, `--text-caption`), under the existing budget row. No
  `role=img` around the three figures: a list reads "Today, $3.20; This week, $12.40; This month, $31.00" by itself.
  The bar's `role=img` label stays budget-only (`spendAria`).
- Words: "spend", "budget", "today / this week / this month". Never "usage", "limit", "daily usage". Section label
  stays "LiteLLM spend".
- No budget: the periods list first, then the quiet "No budget set on this key".
- Danger: "Budget used up" stays first; periods still show (the user wants to know how fast).
- Partial: show the present rows; absent ones as `—` with one hint
  `spend-periods-missing`: "Weekly and monthly spend not reported by the proxy." All absent: drop the list and show
  "Daily, weekly and monthly spend not reported. The proxy needs spend logs this key can read." (`usage-hint`).
- Stale: the one existing `Stale` line covers budget and periods; no per-row stamps. If `since` of a period is older
  than its calendar start, say "Since <date>" in the `dt` tooltip only.
- Keyboard (observed): `auth-pill` is 5 Tab stops from the top with a 2 px inset ring; Enter opens, focus lands on
  "App settings: Connections", Esc returns it to the row. The list adds no tab stop.

## 3. Dashboard Usage card (`dash-usage`)

Yes: the LiteLLM row shows the same one line as the account row (`$3.20 today`) with the budget bar, so the two never
disagree. The card is 276 px at 1600 and 263 px at 1024 (two columns), both above the fold with one project; a
second caption line "$12.40 this week · $31.00 this month" fits at both widths (`dash-fact-line` wraps). Fix the
empty text for LiteLLM: today it reads "No usage reported yet." (M2).

## 4. Themes and sizes

- Text contrast from tokens: `--text-tertiary` on `--surface-1` 5.7:1 dark, 5.0:1 light; `--warning-text` 10:1 dark,
  7.4:1 light. Fine for the caption rows.
- The 4 px fill `--warning` on `--surface-3` in light is about 2.3:1 (`#e08a00` on `#e9ecf4`), below 3:1 for a
  component; the text beside it carries the state, so keep it but never add a bar without text (L1).
- At 1024x640 the sidebar is the rail: the row is icon-only, so the line reaches the user only through the tooltip
  and the popover (320 px at x 8, over the dashboard; fine).
- Do not add a second figure at wide sidebars: the line would change meaning on resize.

## 5. Testids

- `auth-pill` (exists): label text asserted by e2e.
- `spend-row` (exists), `spend-budget` on the head figure, `usage-mini` (exists) for the bar.
- `spend-periods` on the `dl`; `spend-period[data-period=day|week|month][data-present=true|false]`, value in
  `spend-period-value`.
- `spend-periods-missing` for the hint, `usage-stale` (class exists; add the testid).
- `dash-usage-row[data-connection=litellm]` (exists) plus `dash-usage-periods` for the second line.

## Findings

- **M1** Row width: at 200 px the current budget label already clips (measured, shot `1600x1000-dark-home`); a
  combined line never fits under 420. Fix: one figure as in section 1.
- **M2** `FactsCards.tsx` LiteLLM empty state says "No usage reported yet." and the card heading is "Usage"; the
  popover rule is "spend". Fix: "No spend reported yet." for LiteLLM; heading can stay (it covers plan windows).
- **M3** Accessibility: the bar's name is "LiteLLM spend 84 percent of budget" only; periods as loose text would be
  unnamed. Fix: the `dl` above.
- **L1** Light-theme warning fill contrast 2.3:1 (pre-existing).
- **L2** Whether Tab-out closes the native `popover` is not verified (my probe tested DOM presence, always true).

## Not driven

LiteLLM figures, bar, warn and danger levels, stale state (the mock reports no spend); the `periods` payload; a
resized sidebar with a real bar (label budget computed from CSS); System theme; 320 px reflow; browser zoom.

## Implementation notes (2026-11-04)

### Popover

`UsageMeter.tsx` `SpendSection` keeps the budget head, bar, "Budget used up" line, "No budget set on this key" hint
and reset line as they were. After the reset line it renders, in this order:

- `spend.periods` present: `dl.spend-periods` (`data-testid=spend-periods`) with one `div.spend-period`
  (`data-testid=spend-period`, `data-period=day|week|month`, `data-present=true`) per `SPEND_PERIOD_ORDER` entry, each
  a `dt` ("Today" / "This week" / "This month" from `SPEND_PERIOD_LABEL`) and a mono `dd.spend-period-value`
  (`data-testid=spend-period-value`, `money(usd)`). No `role=img` and no `aria-label` on the list: the definition
  list reads itself, and the bar's name stays budget-only (`spendAria`, M3). `data-present` is always "true" today
  because the contract is all three periods or none; the attribute stays so a partial contract later needs no selector
  change. The rows come from the pure `spendPeriodRows(spend)` (unit-tested in `usageMeter.test.ts`).
- `spend.periods` absent and `spend.periodsNote` set: one `div.usage-hint` (`data-testid=spend-periods-missing`) with
  the note, which is one of the three fixed `SPEND_PERIOD_NOTES` sentences from types.ts, never proxy text.
- Both absent (a report written before periods were read): nothing in that slot.
- `lifetimeText(spend)` non-empty: one `div.usage-hint` (`data-testid=spend-lifetime`, "Lifetime $142.10") after the
  list. Hidden when the proxy reports no lifetime total or it equals the budget period's spend.
- `Stale` stays last (`data-testid=usage-stale`); it covers the budget and the periods, no per-row stamps.

The head figure carries `data-testid=spend-budget`. "Since" rule: each `dt` carries `periodSince(since)` as its
`title` ("Since Mon 2 Nov (UTC)"); period starts are UTC calendar boundaries, so the date is printed in UTC and says
so. An unparseable `since` gives no tooltip. Danger order unchanged: "Budget used up" in the head first, then the bar,
then the budget text, then the periods list. Styles in `usage.css` (`.spend-periods` grid `auto 1fr`,
`.spend-period { display: contents }`, `dt` in `--text-tertiary`, `dd` mono in `--text-primary`, all from tokens).

Not seen in the app: the mock adapter hides every LiteLLM figure, so the list, the missing note, the lifetime line and
the danger / no-budget orderings were checked by reading the code and by the unit test only; the lead adds the
by-hand check with a real LiteLLM report later. Verified: `npm run typecheck`, `npx vitest run src/renderer`,
`npm run build` and `node e2e/layout.mjs` (the account popover opens and focus returns to the row).

### Account row and Dashboard (UI Lead, after the hand check)

- Account row (`Sidebar.tsx` `connectionPill`): one figure from `lib/usage.ts` `spendRowLabel` (`LiteLLM · $3.20
  today` with periods, else the budget text); `title` and the rail's accessible name (`railName`) carry
  `spendSentence` ("LiteLLM spend: $3.20 today, $12.40 this week, $31.00 this month. $42.10 of $50.00 budget." /
  "... No budget set."). The `SpendBar` and the dot tone stay the budget level (`spendAria`, `spendLevel`); a period
  figure never colours them. The full-width row gets the sentence as its tooltip too (Reviewer M: the label can clip).
- Deviation from section 1, forced by measurement: the hand check gave the label 107 px at the default 232 px
  sidebar (the walk estimated 115), because the 4 px bar shrank in proportion with the label; with the bar yielding
  first (`usage.css` `.account-label + .usage-mini { flex: 1 1 var(--space-6) }`) it is 114 px, which fits
  "LiteLLM · $3.20 today" (112) but not "LiteLLM · $42.10 today" (119) or "LiteLLM · $142.10 today" (125). So the
  row renders the name as its own `span.account-name` and `.sidebar-footer` is an inline-size container: under 228 px
  of footer content (a sidebar narrower than about 244 px, the default included) the name goes screen-reader-only,
  exactly as the topbar hides the folder name, and the row reads "$142.10 today" beside the dot and bar. The
  accessible name keeps "LiteLLM · "; the popover title and the tooltip name the connection. From 244 px the full
  label shows. Measured in the hand check: 200 px and 232 px show "$142.10 today" (75 px, nothing clipped); 260 px and
  420 px show "LiteLLM · $142.10 today" (125 px, nothing clipped).
- Dashboard Usage card (`FactsCards.tsx`): the LiteLLM row shows the same figure (`spendRowFigure`: "$3.20 today",
  else `spendText`), the `SpendBar`, and `dash-usage-periods` "$12.40 this week · $31.00 this month" only with periods;
  the `li` carries `spendSentence` as its title; empty text "No spend reported yet." (M2). Spec: `dashboard.md` 5.2.
- Helpers (`lib/usage.ts`, unit-tested in `usage.test.ts`): `periodText`, `spendRowLabel`, `spendRowFigure`,
  `spendSentence`, `periodsCaption`, `periodSince`, `lifetimeText`, `SPEND_PERIOD_LABEL`, `SPEND_PERIOD_ORDER`.

Hand check (UI Lead, 2026-11-04, build of this change, `ORGAI_MOCK=1`, token-free): a throwaway driver on
`e2e/lib.mjs` wrote a fake LiteLLM report into the renderer store through a temporary window hook (removed before
hand-back; nothing of it is in the repo) and read the DOM at 1024x640 (rail) and 1600x1000 in dark and light. Seen:
the row, tooltip and rail name above; the popover list (Today $3.20 / This week $12.40 / This month $31.00 with
"Since Wed, Nov 4 (UTC)"-style `dt` titles), "Lifetime $142.10", the `unsupported` note without the list, the
no-budget order (head "$42.10 spent", "No budget set on this key", then the list, no lifetime line when equal, no
bar), the danger + stale order ("Budget used up", "$55.00 of $50.00", reset, list, lifetime, "Out of date · updated
20m ago"); the Dashboard row "LiteLLM / $3.20 today / bar / $12.40 this week · $31.00 this month" at both sizes and
"No spend reported yet." without a report; Enter opens the popover with focus on "App settings: Connections" and Esc
returns it to the row. Not seen: a real proxy payload, warn-level (80 %) colouring, System theme, 320 px reflow,
browser zoom, the accessibility tree of the `display: contents` rows.
