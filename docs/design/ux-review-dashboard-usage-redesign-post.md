# UX review (after the redesign): Dashboard and Usage

Reviewer: UX Researcher. Build: `32e76ee5` (worktree `agent-aa229a08a3a607f9b`), `npm run build` run here.
Compared with: `docs/design/dashboard-usage-redesign/project/` `dashboard.md`, `usage.md`, `motion.md` and the baseline walk
`ux-review-dashboard-usage-redesign-pre.md` (read from `dev`).
Method: `ORGAI_MOCK=1`, throwaway data dir, no tokens. The app was driven through a small command server on `e2e/lib.mjs`
(`launch`, `createProject`). Sizes by `setContentSize`: 1600x1000 and 1024x640. Dark and light through Settings. Windows 11,
local time about 17:35 ("Good evening"). Screenshots: `e2e/shots/ux/redesign-post/shots/` (gitignored). Walk scripts and the seeding
script: `e2e/shots/ux/redesign-post/` (`seed.mjs` clones the three mock runs back over 20 days, in the throwaway dir only).

States walked: first launch with no project; three projects and no runs; a run waiting on a decision (Allow once by keyboard, Deny
by keyboard); a live run (breathing, Team pulse caption); stopped runs and a paused run (`[mock:model-switch-limit]`, one
`[mock:no-price]`); quit while a decision was open and reopen; 21 seeded older runs (multi-day activity map, Compare, projection on
one project); Customise (move, hide, reset, focus figure, Pause motion), pin; Your week hand-offs; Usage at 7 and 30 days, this month,
last month, one project, empty filter; Reduce motion on both pages; a keyboard-only pass on both pages at 1024x640 light.

## Verdict: PARTLY FIXED. Better home, still two keyboard gaps and some numbers that disagree

The Dashboard now answers what needs me and what is happening in the first screen: a visible sentence ("1 decision needs you."), a
live Team pulse with a caption ("2 agents in 1 run: 1 working, 1 needs you."), the decision answerable inline, Right now beside it.
Breathing, Pause motion and Reduce motion all behave. Usage gained a real Pacing hero, a projection when it can be said honestly, a
ribbon, a donut and tooltips for definitions. The remaining problems are in the details a keyboard or first-time user hits: focus is
dropped after an inline answer, the chart crosshair never shows from the keyboard, three of four Efficiency definitions cannot be
reached by keyboard, the hero comparison disagrees with the tiles beside it, and the Your week hand-off keeps the period but not
always the metric.

## Baseline findings: status

| # | Baseline finding | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Status sentence visible | **Closed** | Visible under the greeting in every state: "1 decision needs you.", "1 run is paused until 05:34 PM. Nothing needs you.", "2 agents are working in 1 run. Nothing needs you.", "No runs yet. Open a project to start one." Shots `decision-1600-light`, `busy-1600-dark`. Two time formats remain (see M3). |
| 2 | Agent time (Dashboard) and Wall time (Usage) defined differently and named differently | **Partly** | Still two names and two numbers (Dashboard Agent time 11s, Usage Wall time 56s for the same 3 runs), but the Dashboard card now defines Agent time and says it is not Wall time on Usage, and Usage has a Wall time tooltip ("The clock time a run was open..."). The person can reconcile them; the pages still do not agree on one figure. Dashboard text, `usage-definition-tip-1600-dark`. |
| 3 | Your week hand-off opens Usage on the same 7 days with the metric pressed | **Partly** | Period is kept (7 days from a stat card, 30 days from "Open Usage for the last 30 days"). Spend presses Cost. Runs and Agent time still land on Cost pressed (probe: pressed radio "Cost" after each). See M2. |
| 4 | All four KPI tiles reachable by Tab, names do not repeat value plus instruction | **Partly** | Tab reaches Cost, Tokens, Runs and Wall time; the instruction text is gone from the names. The names still read the value twice ("Estimated cost $0.124+ no prior data $0.124+", "Wall time, 6m 53s" as a non-button group). See M5. |
| 5 | Pick up: full titles, Continue/Open names include the run title, consistent cost, stop reason | **Partly** | Titles are full; button names are "Continue Rewrite the invoice rounding" and "Continue Migrate the docs site now"; every row carries a reason ("You ended this session", "Ended when OrgAI closed", "Was waiting on you when OrgAI closed."). Cost is still inconsistent: a priced run shows "<$0.01", an unpriced run shows nothing (see M6). |
| 6 | Page length at 1024x640 | **Partly** | Dashboard `.dashboard` scrollHeight 1556 to 1621 px at 1024x640 (client 592), against 2210 in the baseline: about 27% shorter, 2.6 screens against 3.8. At 1600x1000 it is 1553 to 1701 (client 952), against 1671: unchanged. Usage `.usage-scroll` 2052 at 1024x640 and 1545 to 1561 at 1600x1000, against 2024 and 1726: no shorter at 1024. |

## Findings, ranked

### High

**H1. After Allow once or Deny, keyboard focus falls to the page body.**
Shots `allowed-1600-light-t1`, `kb-dash-deny-focus-1024-light`. Repro: with a decision open, Tab to Allow once (or Deny) on the Needs you
row and press Enter. The row, and the whole Needs you section, disappear (it is drawn only while a decision exists). Probe after
the answer: `document.activeElement` is `BODY` both times; the live region says "Allowed once: Edit example.ts." / "Denied: Edit
example.ts." and the sentence turns to "2 agents are working in 1 run. Nothing needs you."
What the user experiences: a keyboard user loses their place on the one action the page exists for; the next Tab starts from the
top (skip links, then 12 sidebar stops, then the hero) and they must Tab again to reach Right now.
Fix: when the last Needs you row goes, move focus to the next sensible target and announce it: the "Right now" heading
(make it `tabindex=-1`) if a run is open, otherwise the status sentence. Announce: "Allowed once: Edit example.ts. 1 agent is working. Focus is on Right now."

**H2. The chart crosshair and tooltip never appear from the keyboard.**
Shots `kb-usage-crosshair-data-1600-dark`, `kb-usage-crosshair-1024-light`, `hover-usage-crosshair-1600-dark` (the pointer version works).
Repro: Usage, 30 days. Tab to the chart (one stop, `role=slider` "Cost per day, stacked area chart."), press Home, then ArrowRight until a
day has data. The slider's `aria-valuetext` updates ("Fri 20 Nov: $0.0060, 1 run. Alpha notes API $0.0060.") but the page shows only the focus
ring: probe finds no `.uc-crosshair` and no `.uc-tip` in the DOM (with the pointer they exist and show "Sun 15 Nov / Not priced / Beta billing service").
`usage.md` says the crosshair "follows the pointer or the arrow keys" and retires the separate readout because the tooltip and the Table carry the values.
What the user experiences: a sighted keyboard user presses arrows and sees nothing change; the only route to a day's value is the Table button.
Fix: draw the crosshair and tooltip for the focused day. Enter ("narrow the page to the day") already works; keep it. If the tooltip cannot render on focus, show the day line from `aria-valuetext` under the chart: "Fri 20 Nov: $0.0060, 1 run. Enter shows only this day."

### Medium

**M1. The Pacing hero compares against a period with no data, and its dial repeats the clock.**
Shots `usage-alpha-month-1600-dark`, `usage-alpha30-1600-dark`. Repro: Usage, project filter Alpha only, "This month" then "30 days".
(a) This month: "▲ $0.124 more than last month at this point", dial "69% of the projection", "Tick: last month at this point, $0.00" while the four tiles
beneath each say "no prior data" and Compare says "Previous 30 days: no runs". A $0.00 comparison is presented as a fact two lines above a statement that there is no previous data.
(b) 30 days: "Projected $0.125 by 21 November". The period ends today (21 Nov), so the "projection" is the spend; the dial reads "99% of the projection".
(c) The dial is spend over a straight-line projection from the same spend, so it equals the share of the period elapsed (21 of 30 days = 69%). It carries no pace information.
Fix: when the previous period has no runs, drop the comparison line and the tick and say "No runs in the previous 30 days to compare." For a rolling window ending today
show no projection: "Last 30 days: $0.124. Projections need a calendar month." Replace the dial's centre with something the clock does not decide, for example spend against last period at this point, or hide it.

**M2. "Your week" hand-off keeps the period but Runs and Agent time land on Cost.**
Shot `handoff-agenttime-1600-light`. Repro: Dashboard, press the Runs card, then the Agent time card. Usage opens on 7 days both times (good) with Estimated cost pressed and the chart "Cost per day".
Agent time (11s) has no Usage counterpart except Wall time (56s), which is not a chart metric.
Fix: Runs should press the Runs tile. Agent time cannot be pressed on Usage, so say so: after arrival show a one-line note on the KPI band, "Agent time is not on this page. Wall time counts the whole time runs were open." and keep the chart on Cost.
Also move focus to the Usage heading after the page opens (focus is `BODY` after every hand-off).

**M3. The Briefing's since line ignores runs cut by closing OrgAI, and the clock format changes inside one card.**
Shots `relaunch-1600-light`, `relaunch-scrolled-1600-dark`. Repro: leave a run waiting on a decision, quit, reopen. The Briefing says "Nothing needs you." with no since line, while Pick up marks the same row "Since your last visit:" and
"Was waiting on you when OrgAI closed." and a second run reads "Ended when OrgAI closed". (In the same session, after ending runs yourself the line did show: "Since 17:34: 1 stopped".) Cause read in code, not
changed: `sinceLastSeen` counts only status finished or error with kind stopped/finished/failed, not the closed kinds. The same card shows "1 run is paused until 05:34 PM" (12 h, zero padded) above "Since 17:34" (24 h).
What the user experiences: after being away, the top of the page says nothing changed while the list below says three things did, one of which needed them.
Fix: count the closed kinds. Copy: "Since 17:34: 2 runs ended when OrgAI closed, 1 was waiting on you." Use one clock format everywhere ("5:34 PM" or "17:34", matching the app setting).

**M4. The focus-figure control has no caption, and Decisions does nothing visible.**
Shots `customise-1600-dark`, `customise-decisions-1600-dark`. Repro: Customise. Four unlabelled pills (Spend, Runs, Agent time, Decisions) sit at the right of "Move, hide or show sections." Choosing Decisions announces "Your week now leads with decisions." but
the card shows the same three cards (Spend, Runs, Agent time); there is no Decisions card. Choosing Runs moves Runs first at the same width (415 px), so "leads" has no visual weight either. The radiogroup is named "Your week leads with" for assistive tech only.
Fix: a visible label, "Lead Your week with:", and hide or disable Decisions when there is no such card ("Decisions (none this week)"). Make the lead card visibly larger or add "Leads" to it.

**M5. Three of four Efficiency definitions cannot be reached by keyboard, and tile names read values twice.**
Shots `usage-definition-tip-1600-dark`, `kb-usage-kpi-tokens-1024-light`. Repro: Tab through Usage at 1024x640. Stop 22 is the "Cost per run" label (its tooltip opens); Overlap, Time to first report and No result are `tabindex=-1` and get no stop, so their tooltips are hover-only.
Tile stops read "Estimated cost $0.124+ no prior data $0.124+", "Tokens 100k no prior data 100k"; Wall time is a focusable `group` ("Wall time, 6m 53s") that looks and sounds unlike its three neighbours but is a tab stop.
Fix: make all four definition labels focusable (or fold the definition into the tile reading), name tiles "Tokens 100k, no prior data. Shows tokens on the chart." for the three buttons and "Wall time 6m 53s" for the group, and say once above the band (already there) that Wall time is a reading.

**M6. Pick up still treats cost and state unevenly.**
Shots `busy-1600-dark`, `relaunch-scrolled-1600-dark`. A priced stopped run shows "<$0.01"; an unpriced one (`[mock:no-price]`) shows nothing; the project tile says "Cost unknown" and its accessible name reads "Cost Cost unknown in the last 7 days" (doubled word). The paused row's button is "Continue Migrate the docs site now" with "resumes tomorrow at 5:34 PM if OrgAI stays open" (the time now was 17:35, so "tomorrow" may be mock data; not judged). The primary Briefing button reads "Continue Gamma docs" (shot `noruns-1600-dark`) for a project that has no run to continue.
Fix: show "Cost unknown" on unpriced rows; "Resume now" on the paused row; name the quick action "Open Gamma docs" or "Start a run in Gamma docs" when the project has no runs.

**M7. The activity map has no text or keyboard path for any cell.**
Shot `relaunch-1600-light`. 84 cells (`<i>`, tabindex -1, no aria-label, no title). The only reading is the summary line ("Today · 4 runs started today.", "18 runs · 14 days"); the earlier days cannot be read by keyboard, and I did not test the pointer tooltip. Fix: one stop on the map with arrow keys that read "Mon 16 Nov, 12:00 to 16:00: 2 runs", as the bar chart in Usage does.

### Low

- **L1.** Sidebar at 1600 shows a stray "(" glyph between the logo and the MOCK badge (shots `empty-1600-dark`, `busy-1600-dark`).
- **L2.** Usage at 1024x640 is as long as before (2052 px, 3.5 screens); the hero, band, chart and breakdown stack in one column. Consider putting the breakdown beside the chart from 1024 or the hero beside the band.
- **L3.** The chart's last axis label is clipped at 1024 ("21 Nov" shows as "21 Nov" cut at the plot edge, shot `kb-usage-crosshair-1024-light`).
- **L4.** "no prior data" is still printed on all four tiles (and a flat line) whenever Compare has nothing; once beside the hero would do.
- **L5.** Runs worth a look repeats "No result" as a chip and again in the sentence ("implementer-1 spent 1,640 tokens and produced no result"), and in the mock three rows read identically (seeded clones). Drop the chip when the reason is the same.
- **L6.** The Dashboard live region accumulates: after Customise the text reads "Your week now leads with runs. Pick up hidden. Layout reset to the default. Pinned Beta billing service. It is now first." Clear it after announcing.
- **L7.** "Pause motion" under the Team pulse looks like plain caption text, not a button; its label becomes "Motion paused" with `aria-pressed`. Add a visible state mark or border.
- **L8.** "Commits this week" (three mock commits) is still a full section at the bottom and the pin does not reorder the sidebar project list (pinned Beta is second there, first on the tiles).
- **L9.** Empty first launch is the same form-first page; the Briefing hero is there ("Welcome to OrgAI", one line), so baseline M6 is half answered: no line says what the page shows later.
- **L10.** The "Add your name" button stays on every visit; quieter after the first would help.

## What now works (keep)

- Visible status sentence in the right colour and wording; the decision, its tool, file and folder visible on the row, with Allow once and Deny only (shots `decision-1024-dark`, `decision-1600-light`).
- Team pulse and Right now: nodes breathe only while an agent works (`getAnimations`: one `breathe@dash-pulse-halo`, 1800 ms); caption "3 agents in 1 run: 1 idle, 2 finished."
- Motion: with Reduce motion on, Dashboard has zero running animations with a live decision; on Usage a filter change leaves no running animation after the first frame (8 then 0) and the figure does not count. With motion on, the Usage figure tweens ($0.123+, $0.124+, $0.070+, $0.051+ over 400 ms) only after the person's own filter change; Pause motion stops the breathing (0 running) and toggles back.
- Customise by keyboard: Move up / Move down / Hide buttons have full names ("Move Pick up up"), focus stays on the moved button, the announcement says "Pick up moved up. Position 1 of 7."; Reset layout restores order and lead figure; pin moves the tile first and announces it.
- Skip links first on a fresh load (Tab 1 "Skip to content", Tab 2 "Skip to sidebar"); 2 px rings on every control probed (KPI tiles draw theirs on `::before`).
- Usage: honest unknowns (`$0.124+`, "19 of 25 priced", "No price", hatched not-priced columns), empty filter result is helpful ("No runs match these filters ... The most recent run was on 21 Nov." with Clear all filters and Use 30 days), Cost by tier donut and Lead alone vs with reports table read clearly, the projection appears only when every run is priced ("Projected $0.179 by 30 November") and otherwise says why ("Projection hidden: some usage is not priced").
- No horizontal overflow at either size (`scrollWidth` equals `innerWidth` in every probe).

## Keyboard pass

Dashboard (1024x640 light, 70 Tabs): Skip to content, Skip to sidebar, sidebar toggle, 11 sidebar stops, then Add your name, quick actions, Customise, Pause motion, the three Your week cards (names such as "Spend at least $0.01, not compared: some runs are not priced. Opens Usage for the same 7 days"), Open Usage for the last 30 days, Pick up rows (row button then Continue button), project tiles (open, Pin, suggestions count, More), the Commits day. The activity map and the Team pulse nodes are not stops. With a decision open the order is hero, then Allow once, Deny, Open, then the cards (probe stopped on `dash-needs-deny` after 7 Tabs from the hero). See H1 for where focus goes after an answer.
Usage (1024x640 light, 62 Tabs): Copy as CSV, Save CSV, period group, project and kinds menus, four KPI tiles plus "N of M priced. Show them." button, metric and grain groups, Compare, Table, legend rows, the chart (one stop), Where it went tabs and rows, "Cost per run" definition, Show as table, sort select, run Details and run buttons, Show N more, All runs. See H2 and M5.

## Not driven

- First-launch empty Usage page (the data dir already had projects by then; the empty-filter state was seen instead). The earlier baseline shot of it is `docs/design/ux-review-dashboard-usage-redesign-pre-shots/`.
- Plan-limit and proxy-budget gauges on both pages (the mock has no plan windows), the second connection row, Up next with schedules (empty, "nothing to show right now" in Customise), Engagements and To-dos sections.
- "Since yesterday 18:40" wording and anything older than today (the machine clock is one day; only "Since 17:34" was seen).
- The dial and "Projected ..." with all runs priced across the whole project list (only Alpha alone is fully priced in the mock).
- Pointer tooltip on the activity map, Month grain (needs 60 days; the control says so), Save CSV (native dialog), screen-reader speech (names and `aria-valuetext` were read from the DOM only), frame timing of the draw motion (sampled at 100 ms only).
- Seeded runs are clones of three mock runs, so Runs worth a look, the activity map pattern and the sparklines are repetitive by construction, and "failed" seeds are marked failed only in the run index.
