# UX review (baseline, before the redesign): Dashboard and Usage

Reviewer: UX Researcher. Build: `c452da32` (worktree `agent-a32ad4825492c398a`), `npm run build` run here.
Compared with: the redesign spec `docs/design/dashboard-usage-redesign/project/dashboard.md`, `usage.md`, `motion.md`, used only to
choose the questions. The spec is not reviewed. Earlier walks read for context: `ux-review-dashboard-4.md`,
`ux-review-usage-dashboard-post.md`.
Screenshots: `docs/design/ux-review-dashboard-usage-redesign-pre-shots/` (names below). Walk scripts and raw facts
(`facts.json`, `facts2.json`: page text, keyboard order, sizes) are in `e2e/shots/ux/redesign-pre/` (gitignored).

## Verdict: BASELINE, no data loss, 3 High answers the page cannot give

The pages are solid on inline safety (Allow once / Deny, 2 px rings everywhere, no horizontal overflow, honest `$0.017+` and
"4 of 5 priced"). Measured against the redesign's questions the gaps are structural, not bugs: the Dashboard cannot say what
changed while you were away, shows no visible status sentence, and gives a paused run no place in its top summary. Usage gives
totals and a breakdown but no pace or projection, and reads wasted spend only far down the page.

## Method

- `ORGAI_MOCK=1`, throwaway data dir from `e2e/lib.mjs`, no tokens. Windows 11, local time about 16:45 (greeting "Good afternoon.").
- Sizes by `setContentSize`: 1600x1000 and 1024x640. Dark and light by Settings > theme.
- States: (1) empty first launch; (2) one open run with a pending permission decision; (3) busy: 3 projects, 1 open run with a
  decision, 1 paused run (`[mock:model-switch-limit]`), 3 stopped runs (one `[mock:no-price]`, one `[mock:computed-cost]`);
  Usage on the same data (priced 4 of 5, one unpriced).
- Keyboard-only pass at 1024x640 light on both pages (Tab x70 on the Dashboard, x60 on Usage, focus read back).
- Reduced motion: Appearance > Reduce motion On, both pages at 1600 dark, then `document.getAnimations()`.

## Baseline answers to the eight questions (a first-time user, a few seconds)

| Question | Can they answer it? | What they actually see |
| --- | --- | --- |
| **Dashboard: what needs me** | Yes, fast. | A "1 Waiting on you" tile, then a "Waiting on you" card with Allow once / Deny / Open at the top. The bell row in the sidebar agrees. Shot `busy-dash-1600-dark`. |
| **Dashboard: what is happening** | Partly. | "Working now" lists the open run and its agents with state text ("Needs approval: Editing example.ts"), but it sits below "Waiting on you" and "Pick up", at 1600 beside Pick up, at 1024 far down. No plan progress and no sense of how many agents are busy. `busy-dash-1600-dark`, `busy-dash-scrolled-700-1024-dark`. |
| **Dashboard: what changed while I was away** | No. | There is nothing that says what finished, failed or was spent since the last visit. Stopped runs show "just now" in Pick up; "Commits this week" and "Your week" are weekly, not since-last-visit. |
| **Dashboard: where do I pick up** | Mostly. | "Pick up where you left off" lists the paused run (Resume now) and stopped runs (Continue). Titles are cut ("Mockmodel-switch-li...") and a stopped run offers the same Continue as a finished one. |
| **Usage: how much** | Yes. | Estimated cost `$0.017+` is the first and largest figure, with "4 of 5 priced" and a lower-bound note. Shot `busy-usage-1600-dark`. |
| **Usage: on what** | Yes. | Spend over time stacked by project, and "Where it went" ranked by project with Model / Role / Connection tabs. |
| **Usage: is it on pace** | No. | Every tile says "no prior data" next to a sparkline that has one point; there is no projection, no budget or plan line, and no hint of what "normal" is. Compare with previous period is off by default and needs a click. |
| **Usage: where is it wasted** | Only far down. | "37% of tokens went to agents that returned nothing" sits below the chart and breakdown (about 660 px down at 1600x1000, seen in the shot; further at 1024 and not measured); "Runs worth a look" is a table below that. |

## Findings, ranked

### High

**H1. Dashboard has no visible status sentence, and the paused run is nowhere in the top summary.**
Shots: `busy-dash-1600-dark`, `busy-dash-1024-light`.
Repro: busy state, open the Dashboard. The page text contains "1 decision is waiting on you. 1 run is paused until 04:43 PM."
(measured: element `.dash-brief.sr-only`, 1x1 px, absolute), so only a screen reader gets it. Sighted users get a greeting
("Good afternoon."), three number tiles (Waiting on you 1, Runs today 5, Spend this week $0.02+) and nothing about the paused run.
The paused run appears only when you scroll to Pick up (about 600 px down at 1600, further at 1024).
What the user experiences: "what is the state of my team?" is answered by arithmetic on three tiles; a paused run, which is
blocked until a time, is invisible in the first screen. The "Waiting on you" tile is clickable but the others are not labelled as such.
Fix: show the sentence as the headline of the first card. Copy: "1 decision needs you. 1 run is paused until 4:43 PM." When nothing
needs attention: "All quiet. 1 run is working." Use one time format ("4:43 PM"), the sentence and the row use "04:43 PM" and "4:43 PM".

**H2. "What changed while I was away" has no answer anywhere.**
Shot: `busy-dash-1600-dark` and the scrolled shots.
Repro: finish three runs, leave Dashboard, return. The page keeps a last-seen time (`orgai.dashboardSeenAt` is set on load) but
never shows it. Stopped runs read "Stopped · just now" with no heading such as "Since you left".
What the user experiences: after a morning away they must open each run to learn which finished, failed or cost money.
Fix: a line under the greeting built from run history since the last visit. Copy: "Since yesterday 18:40: 3 runs finished, 1 failed, $0.31 spent." and
"Nothing new since you were last here." when empty.

**H3. Usage shows no pace: every tile reads "no prior data", and nothing projects or compares to a budget.**
Shots: `busy-usage-1600-dark`, `busy-usage-1024-light`.
Repro: busy state, Usage, 30 days. The four tiles each read "no prior data" beside a flat sparkline with a single end point.
There is no line or sentence about where the month is heading.
What the user experiences: "$0.017+ ... so is that a lot, and where will it end up?" cannot be answered. "no prior data" four times is noise.
Fix: one sentence under the main figure. Copy: "$0.017+ so far this month. At this rate about $0.5 by 30 Nov." when priced and a fifth of the period has passed; otherwise
"Not enough days yet to project." / "Projection hidden: 1 run has no price." Show "no prior data" once, on the Compare control, not on every tile.

### Medium

**M1. The 1024x640 Dashboard is almost four screens long and the working state is a long way from the top.**
Measured scroll heights: Dashboard 2210 px at 1024x640 (client 584) and 1671 px at 1600x1000 (client 944); Usage 2024 px / 1726 px.
Shots: `busy-dash-1024-light`, `busy-dash-scrolled-1400-1024-dark`. At 1024 the first screen holds greeting, tiles and the
decision card; Pick up, Working now, Commits, Your week and Projects follow in one column. Fix: at 1024 keep Working now
as a compact strip right under the decision, and pull Pick up above Commits.

**M2. "Pick up" rows do not say why a run stopped or which is the best one to continue.**
Shot `busy-dash-1600-dark`. Three "Stopped" rows with identical "Continue", titles truncated ("Mockno-price Rewri...", "Add pagination to the"),
cost shown for some and not others (unpriced shows nothing, not "Cost unknown"). Paused and stopped are mixed in newest-first order with
no group cue. Fix: sort paused first, add a state reason in plain words ("Stopped by you", "Ended when OrgAI closed"), and show "Cost unknown" for unpriced runs as the project tiles already do.

**M3. "Your week" figures differ from the Usage page in name and number, and "See usage" does not keep the week.**
Dashboard "Time working 12s" against Usage "Wall time 44s" (and 47 s a minute later) for the same five runs; Usage opens on 30 days
even when reached from the week card (hand-off check: Estimated cost pressed, filter line "23 Oct to 21 Nov 2026 (30 days)", shot
`handoff-usage-1600-dark`). Fix: use the same label and definition on both pages, and open Usage on 7 days from the week card.
Copy: "Time working: 12 s (waiting for you is left out)" vs "Wall time: 44 s (start to end)".

**M4. Waste is below the fold and the headline reading disagrees with the table.**
Shots `busy-usage-1600-dark`. "37% of tokens went to agents that returned nothing" (Efficiency) is the only waste cue; the same three runs listed under
"Runs worth a look" each read "No result" and the row text reads "implementer-1 spent 1,640 tokens and produced no result" three times with identical text.
Fix: lead Efficiency with a one-line cost of waste ("$0.0058 of $0.017 went to runs with no result") and link it to the list.

**M5. Four metric tiles act as buttons, one does not, and the instruction repeats.**
Keyboard pass: Tab stops at Cost, Tokens and Runs tiles (indices 15, 17, 18), none at Wall time. Each tile's name reads "Estimated cost $0.017+ $0.017+ no prior data Point at the sparkline to read a day; the chart is the keyboard path."
(value twice, instruction four times). Fix: name = "Estimated cost, $0.017+, 4 of 5 runs priced. Show on chart"; put the sparkline instruction once on the page; give Wall time a non-button look so the difference is visible.

**M6. Empty first launch is a sign-up form, not a home.**
Shots `empty-dash-1600-dark`, `empty-dash-1024-light`. "Welcome to OrgAI." is followed by an inline project form that takes most of the page
and a disabled "Create and start setup" with "Choose what this project is for." The Usage page says "No usage yet ... Start a run in any project." with a Go to Dashboard button (good, shot `empty-usage-1600-light`).
There is no preview of what the Dashboard will answer once runs exist. Fix: keep the form but add one muted line: "Once a team is running, this page shows what needs you, what is working and what changed."

### Low

- **L1.** "Add your name" is a bordered button on every launch, even in the busy state (it is the first thing after the greeting). Make it quieter after the first visit.
- **L2.** Run titles in the mock carry the marker text ("Mockmodel-switch-limit Migrate..."): mock artefact, not judged.
- **L3.** The "5" with a sparkle on project tiles reads "5 team suggestions in Gamma docs" only in the accessible name; sighted users see a bare number. Fix: "5 suggestions".
- **L4.** "Commits this week 3" counts the mock fixture commits and is unrelated to the question the page asks; it takes the right column beside Waiting on you at 1600.
- **L5.** At 1024 the sidebar collapses to icons; the Waiting on you tile is the only text cue to the bell count. Fine, but the Usage page never shows the bell.
- **L6.** On Usage the Month button is dimmed in a 30-day period; its reason shows only as page text with Compare on (carried from the earlier walk).

## What was good (do not lose in the redesign)

- Inline Allow once / Deny with the whole request in the row, and focus rings at 2 px on every control (keyboard pass, both pages).
- Honest unknowns: `$0.017+`, "4 of 5 priced", "No price" in legend and ranked rows, Gamma docs "Cost unknown" on its tile.
- No horizontal overflow at either size in either theme (sw equals cw in every measurement).
- Reduced motion: zero running animations on both pages (`document.getAnimations()` returned 0 with a run open).
- Keyboard: Tab order is sidebar, topbar actions, then the page in reading order; the bar chart is a focusable group with documented arrow keys.

## Keyboard pass

Dashboard (1024x640 light): Tab from the page start passes Usage, Schedules, Needs you, assistants, projects, auth pill, settings, then New chat, New project,
Customise, Add your name, the three stat tiles, the decision card (open, Allow once, Deny, Open), Commits day bar, Pick up rows, Working now, Your week bars, See usage, project tiles.
The sidebar comes first, so a keyboard user passes 12 stops before the page content (the first stop in my probe was Usage; the
Dashboard item itself was skipped because focus started on it). "Skip to content" and "Skip to sidebar" links were reached at stops 44-45, after the whole page; I started
from a blurred element rather than a fresh load, so I cannot say whether they are first on a fresh load.
Usage: after the sidebar, Copy CSV, Save CSV, period group, projects, kinds, three tiles, chart overlay and table toggles, legend rows, the chart (one stop), Where it went, Efficiency info buttons, the sort select, run rows. Three radio inputs
(period, metric, grain) have no name in my probe because their label wraps them; screen-reader names were not read.

## Motion baseline

With reduced motion on, no animation runs on either page. With motion on I did not measure page arrival: the pages appear at rest in the
screenshots taken after 900 ms; I did not record frames, so I cannot say whether any arrival motion exists today.

## Not driven

- Page arrival timing and the breathing marks with motion on (no frame capture).
- Multi-day history (Compare shows no prior data because the mock produces all runs today), so pace over several days and the activity map equivalents could not be seen.
- A relaunch with "since last visit" content, schedules (Up next), usage-limit data per plan window and proxy budgets, which the mock cannot produce through this path.
- The lower half of Usage at 1024x640 (my scroll helper did not move the right container); the 1600 full-page structure is read from the page text and the 1600 shot.
- Screen-reader speech, a custom display name saved (not tried), Customise reorder (covered by the earlier walk).
