# QA: Dashboard and Usage redesign (merged on dev, 2e4f4a10)

Verdict: PASS, with one Medium and three Low findings. No Critical or High. Token-free throughout: mock adapter, throwaway
data dir, synthetic run summaries written into the script's own `runs.json`. Not run (the orchestrator runs them): the
whole unit suite, the dashboard, usage, usage-app and motion e2e scripts.

How each fact was checked: [unit] vitest, [app] the built app driven by `e2e/qa-dash-usage-stress.mjs` (screenshots in
`e2e/shots/qa-*.png`), [code] read in code, [inferred] not observed.

## Findings

### M1 (Medium) Right now agent rows overflow their card when the run card is under 520 px

- Trigger: two-column Dashboard at 1024x640 (run card 460 px wide), a report whose role differs from its label and whose
  activity is a long sentence (here a 15-agent run with long spawn descriptions). [app]
- Observed: the activity text runs past the card edge with no ellipsis and a horizontal scrollbar appears at the foot of
  the page content (screenshot `qa-live-dash-now-1024.png`). Row `clientWidth` 460, `scrollWidth` 711; the activity span
  measures 507 px. The page itself does not overflow (`documentElement.scrollWidth` equals `clientWidth`), so a width check on
  the document passes. At 1600x1000 the same data truncates correctly with an ellipsis.
- Cause [code]: `styles/dashboard-band.css` `@container runcard (max-width: 519px) { .dash-role { display: none } }` removes a
  grid item from `.dash-agent-row`, whose template is `... max-content max-content minmax(0, 1fr) max-content`. The remaining
  children auto-place one track left, so the activity lands in a `max-content` track and the `1fr` track receives the empty
  worktree span. `BandRun.tsx` renders `dash-role` or an empty `<span />` in that slot; the hidden case drops it.
- Remedy: keep the slot and hide its content (`visibility`/zero-width track via a container-query template change) or render
  the empty `<span />` in that case; do not remove the grid item. Add a 1024 px check with a long activity to `e2e/dashboard.mjs`.

### L1 (Low) Dashboard money has no thousands separators

- Trigger: a 7-day spend of about $494k (synthetic). The Spend card reads `$493835.25+`; Usage reads `$493,862.13+`. [app]
- Location: `shared/view/cost.ts` `formatUsdCompact` (`$${usd.toFixed(2)}`), used by `lib/weekRecap.ts`, `lib/sinceSummary.ts`.
  `formatUsdPage` separates thousands. Unrealistic for most users, but the two pages disagree. Remedy: separate thousands in the compact form.

### L2 (Low) A stat card's note is cut at 1024 px

- "Not compared: some runs are not priced" shows as "Not compared: some runs are n..." on Spend and Decisions at 1024x640. [app]
  The full sentence is in the accessible description, so no information is lost for a screen reader; sighted users see it
  only if a title exists. Remedy: allow two lines or add a `title`.

### L3 (Low, pre-existing, cause not confirmed) sidebar initials for a long Japanese name

- With the project name "プロジェクト名前がとても長いです（日本語）テスト" the sidebar rail shows "プ" plus a missing-glyph
  box while the Dashboard tile shows "プ日". `lib/layout.ts` `initials()` indexes UTF-16 units; the cause is not
  confirmed [inferred]. Not part of the redesign. A Zalgo name also lets combining marks overlap the line above in the Right now
  group heading (extreme input, cosmetic).

## Held up (observed [app] unless noted)

- Both themes, 1024x640 and 1600x1000 (1024x640 is the 200% zoom case of a 2048x1280 window; no browser zoom run): no
  horizontal document overflow on first launch, six projects with extreme names (110-char unbroken, Japanese plus emoji, Arabic
  RTL, one letter, Zalgo), 92 seeded runs, and live data. Long names truncate in tiles, Needs you rows, the sidebar and Usage
  rows and chips.
- Worst-case live data: 6 runs, 15 reports each plus roots (96 agents) and 6 open decisions. Page breathing marks = 12 (the budget),
  Team pulse nodes = 12 with the caption "96 agents in 6 runs: 90 working, 6 needs you. +84 more not drawn." Right now caps each run
  at 6 agent rows plus "9 more agents". Looping animations on the Dashboard: only `breathe`.
- Pricing honesty: all unpriced, mixed and lower-bound data never shows "$0" for unknown. Spend `$493835.25+`, Runs, Decisions
  `10009+` with "Not compared: some runs do not count decisions"; Usage `68 of 92 priced`, `Cost by tier ... at least`, chart
  keys for Not priced and Lower bound, crosshair text "2 unpriced". The only `$0` on Usage is the chart axis label.
- Projection sentences: clock set to 3 Nov, This month: `data-projection=early`, "Projection needs more data". Clock 21 Nov
  with unpriced runs: "Projection hidden: some usage is not priced". Rolling 30 days: "No projection for a rolling period".
- Layout storage: junk text, `[]`, `null`, future version, wrong types, a version 1 value, every section hidden, stale pins
  (two deleted ids) and a 5000-pin value all render the Dashboard with Needs you and Right now present, no page error, no
  overflow. A version 1 value is rewritten as version 2.
- No schedules, no display name ("Add your name" only), Customise with all seven sections hidden: the empty regions are not
  drawn and no gap is left.
- Reduced motion (Appearance switch) and Pause motion: zero running infinite animations on the Dashboard; zero running animations on
  Usage after navigation. System reduced motion was not driven separately (the switch and the system flag share the same CSS
  blocks [code]).
- Keyboard: Tab reaches Name, Continue, New chat, New project, Customise, Pause motion, each Needs you Open / Allow once /
  Deny, each Right now row, "more" buttons, then the stat cards. Allow once and Deny only exist for a visible request. On
  Usage the chart plot is a `role=slider`; Left/Left moved 21 Nov to 19 Nov, Home reads "Fri 23 Oct: no runs.", End returns to 21
  Nov, each with a full `aria-valuetext`.

## Hard rules against the code [code]

- Needs you and Right now are not in `DASH_SECTIONS` (`lib/dashboardLayout.ts`) and are not Customise controls: pass.
- Looping animations: `infinite` in the new CSS is `breathe` (`dashboard-band.css`, `dashboard-pulse.css`) and
  `dash-pulse-trip` (`dashboard-pulse.css`); the other `infinite` rules in `styles/` predate the redesign: pass.
- Literal durations or easings in new CSS: none in `dashboard-*.css`, `usage*.css`, `instruments.css` or the 60 added lines of
  `motion.css`, except `animation-delay: calc(var(--i, 0) * 150ms)` in `dashboard-band.css`, which is older (Motion slice 7,
  7d93fe61), plus `0ms` and `0s` resets. Pass, with the known 150 ms.
- Team pulse imports (`TeamPulse.tsx`, `lib/teamPulse.ts`, and their `canvas`, `dashboardBand`, `runRoster` dependencies):
  nothing from Pocket Office or the Factory Floor: pass.
- CSP and network: `src/renderer/index.html` and `package.json` are untouched by the redesign; no `fetch`, URL, WebSocket or
  dynamic `import()` in `components/dashboard`, `components/usage` or the two views: pass.

## Runtime: RunUsage.decisions

(a) Added `RunUsage.decisions (decisionsOpened)` tests in `src/main/runtime/runManager.test.ts`:
- starts at 0; three `*.request` events (two permission, one question) give 3 and two `permission.resolved` events do not
  count; the value reaches `summaryOf().usage` and `usageStats()` for a live run. [unit, pass]

(b) Pre-field run, resumed or continued. Traced and tested [unit, pass]:
- A resume or continue starts a new run (`start({ resumedFrom })`, new id, `ActiveRun.decisionsOpened = 0`). It counts only its
  own cards from 0, which is correct per run and always set.
- The old run's usage is never recomputed by a resume: `usageSummaries` reuses a stored `summary.usage`, `cleanStoredUsage`
  copies `decisions` only when it is a number, and `normalizeRunRecord` leaves it unset. The pre-field run keeps `decisions`
  undefined, reads as unknown, and the Dashboard shows a lower bound ("N+", "Not compared: some runs do not count decisions").
  No misleading small number: no finding.
- Residual (not a defect): the count is in memory (`decisionsOpened` is not persisted). A run that crashes before its usage is
  saved keeps the last saved usage. A throttled save (`USAGE_THROTTLE_MS`) can therefore lag by up to one publish; the next
  app start does not recompute it. Low risk, not tested.

## Tests and files

- Added: `src/main/runtime/runManager.test.ts`, describe `RunUsage.decisions (decisionsOpened)`, 3 tests. Ran
  `npx vitest run src/main/runtime/runManager.test.ts src/main/runtime/runUsage.test.ts`: 255 passed. `npm run typecheck`: clean.
  `npm run build`: ran, clean.
- Added: `e2e/qa-dash-usage-stress.mjs`, a manual stress script (prints measurements and screenshots; not in `e2e:free`;
  run with `node e2e/qa-dash-usage-stress.mjs` after a build). Its checks all passed.
- Added: this file.

## Not verified

Live providers, plan gauges (the mock reports no limits), screen-reader speech, forced colours, macOS, real browser zoom,
contrast measurement, month grain, a real "Decisions" count from a live run reaching the card in the app (the card was
seeded with `decisions` in run summaries; the live counter is covered by the unit test), and answering a card inline by
keyboard end to end (existing `e2e/dashboard.mjs` NY checks own that; my probe only confirmed the buttons are reachable).
