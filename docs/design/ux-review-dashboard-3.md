# UX review: Dashboard pass 2, post-landing re-walk (walk 3)

- Reviewer: UX Researcher. Build: `0cff5052` on dev (`npm run build`, version shown 0.1.7-dev1).
- How it ran: `ORGAI_MOCK=1`, throwaway data dirs, no tokens, Windows 11, Electron driven through `e2e/lib.mjs` with a
  command-serving script (gitignored, `e2e/shots/ux/dash3b/`). Sizes 1600x1000 (full 232 px sidebar) and 1024x640
  (56 px rail), dark and light at both, mouse pass, a keyboard-only pass at 1024x640 dark, reduced motion once
  (`data-reduce-motion=on`, read from computed style).
- Seeded state (same as the pre-walk): 3 code projects (Billing API, Mobile app, Docs site), 1 engagement (Q4 audit,
  client Acme Corp), a permission card waiting in Billing API (`[mock:fatigue]`: `cd <worktree> && npm test`) and one in
  Q4 audit (default script: edit `example.ts`), a live `[mock:deep-tree]` run in Mobile app, a Docs site run ended with End
  session, an idle Chat run. Then: more waiting runs (Docs site, Mobile app), a working deep-tree run, a relaunch (every
  live run came back "Ended when OrgAI closed"), run records backdated on disk across 14 days (one with unknown cost) to
  see the strip with real shape, a `[mock:rate-limit]` run, an Architect setup run, and a fresh data dir for first launch.
- Compared with: `docs/design/dashboard-2.md` sections 1-14 and 21, `ux-review-dashboard-3-pre.md`, CLAUDE.md "Dashboard".
- Shots: `docs/design/ux-review-dashboard-3-shots/` (15 files). Statements marked (code) were read, not seen.

## Verdict: MOSTLY FIXED, NOT YET A CONTROL ROOM EVERYWHERE

No Critical or High. Both pre-walk Highs are fixed: the page now shows who is doing what (handles, roles, activity
strings, role-coloured marks on subway lines, working marks breathing), and a user can answer a simple permission without
leaving the page (1 click, announced, focus moves on, nothing wider than Allow once or Deny offered). The 14-day strip is
a real instrument. What keeps it from being finished: the status sentence contradicts the band it sits above (M1), the
most common command shape the user will meet, `cd x && npm test`, is refused inline with the wrong reason (M2), Clear
drops focus to the page body (M3), and the layout leaves a large hole in one column depending on state (M4). The same
decision still shows in five places (M5). Findings below; the owner's question is answered in section C.

## A. Status of the pre-walk findings

| Id | Finding | Status | Evidence |
| --- | --- | --- | --- |
| H1 | Page never shows what agents are doing | Fixed | `Right now` band: per run a header, per agent a handle pill, role, activity ("Delegating to implementer", "Needs approval: Editing example.ts"), role-coloured mark on a subway line (`02-1600-light-working.png`). Enter on an agent row opens its run with that node selected and focused (`12-agent-opened-from-band.png`, `.react-flow__node.selected` = `mock-report-1`, focus inside it); Enter on a run header lands on the root node. |
| H2 | "Running now" and hero count idle and waiting runs | Partly | The band counts are right ("1 working · 2 waiting for you · 2 idle", `dash-now-counts`). The status sentence is not: it read "1 agent working in 1 run" and "2 agents working in 2 runs" while the band said nobody or one run was working (M1). Idle rows show the root's activity ("Waiting for your reply"). |
| M1 | Same fact shown five times | Partly | Hero figure and the separate Running list are gone. A decision is still on the page in the Needs you row, the band run header, the band agent row, the tile status line, the tile newest-run line, plus the bell (M5). |
| M2 | Needs you rows indistinguishable, cannot be answered here | Fixed, one gap | Rows lead with project, run, then "{agent} wants to edit: example.ts src" and a location line ("In the project", "Starts in the project"). Inline Allow once / Deny worked by keyboard and mouse (section D). Gap: compound commands (M2 below). |
| M3 | Dead space at 1600, facts under the fold at 1024 | Partly | 1600x1000: no page scroll, content ends y 844 of 944 and the Usage / Cost / Connections cards are gone. But a column can end 218 px above the other (M4). 1024x640: page 950 px in a 584 px region (366 px of scroll, was 235) in the busy state; with 3 decisions the strip's bars are cut at the fold (`03-1024-dark-three-waiting.png`, M6). |
| M4 | Tile hierarchy puts folder noise first | Fixed, one repeat | Newest run in body font under the status line, folder in caption with the path in `title`, "$0.03 last 7 days" with the unit spelled out, no "N roles". Ended runs say the same words twice (L3). |
| M5 | Usage card contradicts popover on the mock; no reset time | Fixed under the mock | `dash-limits` and the Usage card are absent in every state I made (hidden under the mock as specified). Reset times and the real windows were not driven. |
| M6 | Per-project facts cost 2-3 clicks | Partly | A "5 team suggestions" chip shows on a tile (mock Team review) and is a Tab stop. Branches and folder-trust chips cannot be made on the mock; no chip showed when nothing was pending. Chip clicks not driven. |
| L1 | Cost figures: six decimals, "7 d" | Fixed | "<$0.01", "$0.03", "$0.07+" (lower bound kept), "last 7 days". New: "cost cost unknown" in a day label (L1 below). |
| L2 | Maintenance copy runs two sentences together | Not checked | Out of this page. |
| L3 | Mock markers drop brackets in run titles | Open | "Deep tree mockdeep-tree", "Mockfatigue Fix the billing", "Limit mockrate-limit check" on every row, tile and Recently ended line. Mock-only. |
| L4 | Wordmark reads "( MOCK Dev" with a clipped glyph | Open | Visible in every 1600 shot (full sidebar header). |
| L5 | "Since" lists the run the user just ended | Fixed | The run I ended with End session never appeared in Recently ended in the seeded state (section absent). After a relaunch it lists the quit-cut runs only. |
| L6 | Tab from the last stop goes to "Skip to content"; Mark all seen scrolls | Open, unchanged | Last tile stop is followed by "Skip to content" (stop 23). The old Mark all seen is now Clear, see M3. |

## B. Findings, ranked

No Critical or High.

### M1. The status sentence counts runs that are waiting on you as "working"

- Screens: Dashboard at both sizes, both themes (`01-1600-dark-after-allow.png` for the band; the sentence text was
  sampled with `[data-testid=dash-status-line]`).
- Steps: seed as above (two permission cards waiting, a deep-tree run idle). Read the sentence, then the band counts.
- Experience: "1 agent working in 1 run." with the band reading "2 waiting for you · 2 idle" and no working row. With
  three waiting runs: "2 agents working in 2 runs." beside "3 waiting for you · 4 idle". With one deep tree working and
  two waiting: "5 agents working in 2 runs" beside "1 working · 2 waiting for you". The cause is visible in the band:
  a run waiting on a card still has a root in "Delegating to implementer", which counts as a working agent. The user is
  told their money is being spent when the team is stopped on them. This is the sentence the pre-walk's H2 asked to fix.
- Fix: count only agents (and runs) of runs in the band's working group, as the band does; or say "N waiting for you"
  in the sentence when the runs it counts are blocked.

### M2. `cd x && npm test` is refused inline with the wrong reason

- Screen: Needs you, `[mock:fatigue]` row (`01-1600-dark-after-allow.png`, `11-permission-card-compound.png`).
- Steps: start a run with `[mock:fatigue] Fix the billing rounding bug` in a project, open the Dashboard, read the row.
  Compare with the permission card (click the row).
- Experience: the row shows "Orchestrator wants to run: cd C:\Users\...\agent-x && npm test", the location line, and
  "Long command: open it to review", with no buttons. The command is 105 characters. The card calls it "Run npm test"
  with "2 steps". So the user is told it is long when it is two steps, and the commonest real command (change folder, then
  run the tests) always costs 2 clicks. At 1024x640 the command is also clipped with "…" at two lines, so the row shows
  neither the end ("npm test") nor the whole thing; the aria label carries it.
- Fix: say what is true ("2 steps: open it to review"), or allow it inline with both steps on separate lines, which the
  row already has room for. Show the last step even when clipped.

### M3. Focus is lost after Clear in Recently ended

- Steps: relaunch so Recently ended shows rows (`04-1600-dark-relaunch.png`). Tab to Clear, Enter.
- Experience: the section disappears and `document.activeElement` is the body (the first Tab then starts at the page
  top). Spec 12.2 says focus goes to the next section's heading. The old behaviour in dashboard-2 fixed this once.
- Fix: focus the next visible section's h2 (here Projects, or Last 14 days) when Clear removes the section.

### M4. One column ends far above the other

- Screens: `01-1600-dark-after-allow.png`, `05-1024-light-relaunch.png`, `06-1024-dark-relaunch.png`.
- Steps: 1600x1000 with one decision left and five open runs: Needs you plus the strip end at y 490, the band at y 708,
  a 218 px hole under the strip (with two decisions they balance: 592 / 593). Relaunched, quiet, at 1024x640: Needs you is
  one 53 px line ("Nothing needs you.") beside Right now plus a 240 px strip, so the left half of the viewport is empty
  for 280 px. The tall strip is 240 px at both sizes (spec 7.5: 190), which is what leaves the right column so heavy.
- Experience: the page reads unfinished on the quiet days the user will see most. The grid areas stack the strip under
  Needs you and put the band beside both.
- Fix: in the band-empty state put the strip full width above Projects, or let Recently ended and To set up fill the
  left column first; cap the tall strip near 190.

### M5. One decision is shown in five places, and two of them print the raw command clipped mid-word

- Screens: `01-1600-dark-after-allow.png`, `14-inline-allow-shell.png`.
- Steps: seed one permission card. Count: Needs you row, band run header line 2, band agent row, tile status line
  ("1 decision · 1 run"), tile newest-run line, plus the sidebar bell and project badge.
- Experience: spec section 1 promises two places. The band header and the tile caption print the activity string
  "Needs approval: $ cd C:\Users\chapp\AppData\Local\Temp\orgai-e2e-d3-billing-wbtgB6\.clau" cut mid-word, with a "$ "
  prefix and a path nobody needs there. A first-time user reads it as an error string.
- Fix: for a run that has a Needs you row, make the band line say "Waiting on you: run npm test" (the verb and the last
  step) and let the tile caption say only "Needs you"; keep the full command in the Needs you row alone.

### M6. At 1024x640 a busy day pushes the strip and Projects under the fold

- Screen: `03-1024-dark-three-waiting.png`.
- Steps: three waiting runs, four idle, 1024x640 dark.
- Experience: Needs you shows three tall rows (about 100 px each), the strip's title is at y 507 and its bars are cut at
  640; Projects start at 596 + the scroll. The page is 950 px in a 584 px region. The spec expected the strip's totals and
  bars above the fold with up to three decisions. Light theme and the other states: same geometry.
- Fix: collapse a row's location line into its first line at narrow widths, or put the strip beside Needs you at the
  rail size; at the least keep the bars above the fold.

### L1. "cost cost unknown" in the day's accessible name

- Steps: the 2 Nov strip day (unknown cost): its label reads "Mon 2 Nov: 1 run (1 stopped), cost cost unknown".
- Fix: the cost text already says "cost unknown"; drop the lead word when the kind is unknown.

### L2. Strip date labels crowd the weekday initials

- Screen: `04-1600-dark-relaunch.png`, `05-1024-light-relaunch.png`: "25 Oct" and "Today" sit directly on top of
  "S" and "S", so they read as one two-line label. Fix: more row gap, or drop the weekday under the two end labels.

### L3. Tiles say an ended run's outcome twice

- Steps: relaunch. Billing API tile: "Last run 9 d ago · Ended when OrgAI closed", then under the run name "Ended when OrgAI
  closed · 9 d ago". Seeded: "Last run just now · Stopped" then "Stopped · just now". Fix: when the newest run is ended, the
  status line says only the age or the run line only the outcome.

### L4. The non-inline Needs you row has a barely visible chevron

- Screen: `01-1600-dark-after-allow.png`: the "›" sits at the far top-right of the Billing row, 7 px wide, so the row looks
  like text. Fix: align it vertically centred, brighter, or give the row the same "Open" word as the inline rows' buttons.

### L5. Tile Tab order is Open, More, chip; the spec says Open, chips, More

- Keyboard pass stops 18-20. Harmless; the visual order is right.

### L6. Accessible name "open for just started"

- Keyboard stop 10: "...cost <$0.01, open for just started". Fix: "started just now" or leave elapsed out under a minute.

### L7. Paused row copy

- `07-1600-dark-paused-race.png`: "resumes at 02:27 AM" (zero-padded 12 h clock) and the reason sentence cut by an
  ellipsis mid-clause ("Reports still ..."). Fix: no leading zero; clamp at a sentence or show two lines.

### L8. Mock titles and the wordmark (L3 and L4 of the pre-walk, still open)

## C. The owner's question: does it still read "AI generated"?

Plainly: less, but not gone. Half the page is now this product's, half is still a template.

What now feels like this product's control room:

- Right now. Role-coloured marks on subway lines, the handle pills ("specialist-1", "mock-lead-report-1"), the real
  activity strings ("Delegating to implementer", "Needs approval: Editing example.ts"), working marks that breathe with
  staggered delays (computed: `dash-breathe 1.8s`, delay -0.24 s per mark, `none` under reduced motion), and a click
  that lands on that agent's node. Nothing in a generic dashboard looks like it. (`02-1600-light-working.png`)
- The 14-day strip: one baseline, bars for cost, ticks per run coloured by outcome, a hollow circle for unknown cost, a
  readout line, arrow keys, pin, and "Waited on you 9m 24s". It reads as an instrument. (`04-1600-dark-relaunch.png`)
- The status line: one quiet sentence in place of the hero, including "2 were waiting on you when OrgAI closed".
- Needs you with the ask, the whole command or file name and where it runs, and Allow once beside Deny.

What still reads as a template, with causes:

1. Every region is the same box: dark rounded surface, title left, count right, same radius and padding. Needs you, Right
   now, Last 14 days and Projects have the same weight, so hierarchy comes only from size.
2. The project tiles are a generic card grid with a "..." menu, a footer caption and "last 7 days". They carry data that
   is already above (newest run, decision count) and show nothing of the team they stand for. They are the largest block
   on the quiet days (`05-1024-light-relaunch.png`).
3. One colour does all the work: the amber tint lights the Needs you row, the band header, the agent row and the tile for
   the same decision (M5). Colour repeats instead of directing.
4. Quiet states are blank, not designed: "Nothing needs you." as a lone grey line beside an empty column, 280 px of
   air at 1024 (M4), 220 px at 1600 under Projects.
5. The mock strings (`mockdeep-tree`, "Mockfatigue Fix the billing", "( MOCK") and the raw `$ cd C:\...` activity make
   the page look generated. The first two are mock-only; the raw command is not (M5).

## D. Region by region

- **Right now band.** Grouping by project (client as caption), runs ordered working, waiting, idle: seen. Waiting runs sort
  first, so a waiting run was never hidden behind "Show N more runs" in my states (1024 cap 3: three waiting shown, "Show 4
  more runs" held idle ones; with more than 3 waiting I did not drive it). Subway marks, elbow lines and "3 done" /
  hollow folded mark: seen, both themes. Activity strings are the canvas's. The plan step ("Step n of m") did not appear:
  the mock script sends no plan, so not seen. Enter on an agent row and on a header: works (above). Band re-renders did not
  move focus in the keyboard pass.
- **Needs you inline.** Edit in the project (`specialist-1 wants to edit: example.ts src / In the project`): inline. Simple
  shell (`git status --short`, "Starts in the project"): inline (`14-inline-allow-shell.png`). Compound `cd ... && npm test`:
  not inline, "Long command" (M2). Words match the card for the file case ("wants to edit", "In the project"); for the
  compound case they do not (row "Long command", card "Run npm test, 2 steps"). Pressing Allow once by keyboard: the row left
  when the run resolved, the bell went 2 to 1, `dashboard-live` read "Allowed once: Edit example.ts.", focus moved to the next
  row's main button. Deny by mouse: "Denied: Edit example.ts.", focus on the next row. The announcement names the file, not
  the project. No "Allow for session" or "Always allow" anywhere on the page. The inline question options could not be seen
  (below).
- **Status line and limits.** The sentence works in every state except as in M1; first launch reads "Welcome to OrgAI. Start
  a project or just chat. Nothing runs until you say so." (`08-1024-light-first-launch.png`); after a relaunch "Nothing is
  running. 2 were waiting on you when OrgAI closed." and the clause goes away after Clear. `dash-limits` is absent under the
  mock (confirmed, as specified); the plan-limit line was not seen.
- **Last 14 days.** 14 buttons, today `data-today`, one Tab stop (today). Left/Home/End moved the readout ("Fri 6 Nov: no
  runs", "Sun 25 Oct: no runs", back to "Today: ..."), Enter pinned (`aria-pressed` true, `data-pinned`), End / Esc unpinned,
  hover showed that day and leaving returned to today or the pinned day, click pinned a day and clicking again unpinned it. Cost
  was never "$0.00": "<$0.01" per run, "$0.07+" as the partial total, "cost unknown" for the unknown day. Day counts summed to
  Runs. `10-1024-dark-strip-focus.png` shows the focus ring on a day.
- **To set up.** Absent in every state (everything connected under the mock): confirmed, not a finding. A missing service or
  connection was not made.
- **Paused / Recently ended.** Paused appeared for about 3 s from a `[mock:rate-limit]` run (the mock then auto-resumes):
  "Paused 1 / Limit mockrate-limit check / Mobile app · resumes at 02:27 AM if OrgAI stays open / Resume now" and the
  status line "Nothing is running. 1 paused until 02:27 AM." For that moment the same run was in Paused and in Right now as
  "Running" (a transition, not a bug). Recently ended after a relaunch: "Ended when OrgAI closed ... Was waiting on you when
  OrgAI closed." with Continue per row and Clear. Continue lands in the composer of the newest member ("Session ended 1 min ago.
  Send to continue with its memory.", focus in the textarea).
- **Tiles.** Newest run, chips, folder caption, cost with the unit: seen. The More menu offers Open, New run, Continue {run},
  Open folder, Delete project (`13-tile-more-menu.png`); New run opens a draft with the composer focused; Continue from the
  menu and from Recently ended both land in the composer.
- **Announcements.** One live region (`dashboard-live`, polite), nothing else with `aria-live` or `role=status` inside the
  Dashboard. Agent rows appearing and changing activity said nothing. A "New decision in ..." announcement on arrival was
  not sampled.
- **Reduced motion.** `data-reduce-motion=on`: every working mark's `::after` `animationName` is `none`; off: `dash-breathe`.

## E. The UI Lead's open list

| Item | Result |
| --- | --- |
| Waiting run behind "Show 1 more run" at 1024x640 | Not reproduced. Waiting runs sort first; the hidden run was an idle Chat. More than 3 waiting not driven. |
| Left column ends ~250 px above the band at 1600x1000 | Reproduced when one decision is left: 218 px (M4). Balanced with two decisions. |
| A tile repeating "Ended when OrgAI closed" twice | Confirmed (L3), also "Stopped" twice. |
| Tall strip about 240 px vs the spec's 190 | Confirmed: 240 px at both sizes (M4). |
| Location line and wrapped commands after the Reviewer fix | Location line present on every permission row ("In the project", "Starts in the project", "Starts in worktree agent-x (inside the project)"). Inline commands show whole (the short one); the refused compound command wraps to two lines at 1600 and clips with "..." at 1024. |
| Mock titles like "Limit mockrate-limit" | Still there, mock-only (L8). |

## F. Keyboard pass (1024x640, dark)

From the topbar h1: New chat, New project, Needs you row 1 (main), row 2 (main), Allow once, Deny, band: run header, its agent
row, next header, header, "3 done", "Show N more runs", the strip (today only, arrows move), then per tile Open, More (and
the chip after More), then "Skip to content". 23 stops, DOM order equals visual order, every stop shows a 2 px accent
outline (the tile's ring is on its stretched Open cover, `::after`). Left/Right/Home/End on the strip move one day at a time. Enter on an agent row lands on its node. Esc unpins the strip day. After Allow once focus lands on the next
row's main button (not on a destructive button); after Clear focus is lost (M3). Nothing live moved focus.

## G. Click counts for the pre-walk's targets, now

| Target | Path now | Clicks (was) |
| --- | --- | --- |
| Agents working in one run | read the band; click the agent to open it | 0 to see, 1 to open (1) |
| Answer a permission | inline Allow once / Deny (simple edit or short command) | 1 (2); compound command 2 |
| Plan limits and reset | status bar (hidden under the mock); sidebar popover | not driven; popover 1 |
| Branches waiting (one project) | tile chip | not driven (3); no chip could be made |
| Team assistant suggestions | tile chip "N team suggestions" | seen; click not driven (2) |
| Services needing sign-in | To set up row | not driven (2) |
| Repo config trust | tile chip | not driven (1-2) |
| Team files awaiting approval | Needs you row | not driven (1) |
| 14-30 day activity | the strip (14 days, all projects) | 0 (3 per project) |
| Continue last chat / run | Recently ended Continue, or tile More > Continue | 1 or 2 (1); the sidebar Chat row is still 1 |
| Start from a template | New project > radio > pick > Create | unchanged (4+), not re-walked |
| Last decision made | not reachable | unchanged (spec section 18 says so) |

## Not driven

- Real plan windows, reset times, proxy spend and the status-bar limits line (hidden under the mock, as specified).
- To set up rows (nothing disconnected or missing under the mock), tile branches and folder-trust chips, chip clicks.
- Inline question options: no mock work run asks a single-choice question (the Architect run gave a proposal card, which
  correctly has no inline buttons). Long inline paths, hidden-character commands and reference-folder rows.
- More than 3 waiting runs or decisions, the wide caps (5 and 12) and "Show fewer", Dashboard with more than 6 projects.
- A Paused run that stays: the mock resumes it in about 3 s; seen only as a transient frame. The plan step line.
- Arrival announcements ("New decision in ..."), screen reader output, System theme, DPR above 1, macOS, Linux, a real hidden window.
- A run whose owner deleted the project mid-run; delete / forget flows (not changed by this pass).
