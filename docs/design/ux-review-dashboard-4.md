# UX review: Dashboard overhaul (walk 4)

Reviewer: UX Researcher. Build: `6bddab0c` (worktree `agent-ad1285e3d1a0b0b52`), `npm run build` run in this worktree.
Compared with: `docs/design/dashboard-overhaul.md` sections 1-11, 13 and 17.
Screenshots: `e2e/shots/ux-dashboard-4-*.png` (first pass) and `e2e/shots/ux-dashboard-4-b-*.png` (second pass). They are in the
gitignored `e2e/shots/` folder, so they are on disk in this worktree and not in the commit. The walk scripts and raw facts
(`facts.json`, `facts2.json`) are in `e2e/shots/ux-dashboard-4/` (also not committed).

## Verdict: PARTLY GOOD, no High findings

The page does what the spec set out to do. The brief is true in every state I could make, one decision shows in one place,
Waiting on you is clearly the loudest block, both sizes work with no horizontal overflow, and the keyboard path through
Customise, the ledger, the name popover and Allow once is complete with a visible 2 px ring everywhere. The problems are
about words: a pause time that hides its day, a name that is saved on the first-launch screen but never appears, and a few
places where the brief and the rows below it say different things. Five Medium and eight Low findings.

## Method

- `ORGAI_MOCK=1`, fresh throwaway data dir per script (`ORGAI_DATA_DIR` from `e2e/lib.mjs`), `ORGAI_MOCK_SCRIPT` with `delayMs 400`.
  Nothing that spends tokens was run. Windows 11, local time about 22:40 (so the salutation was "Hello" throughout, the 22:00-04:59 band).
- Sizes by `setContentSize` in the main process: 1024x640 and 1600x1000, plus a 1280x800 spot check. Dark and light by Settings theme.
- Mouse pass first, then keyboard-only (Tab, Shift+Tab, Enter, Space, arrows, Home, Esc) at 1024x640 light and 1600x1000 dark, with
  the focused element read back (`data-testid`, accessible name, computed outline).
- Reduced motion: Settings > Appearance reduce motion set to On, then a live deep-tree run for the working marks.

## States walked

| State | How made | Sizes and themes |
| --- | --- | --- |
| First launch, no projects | fresh data dir | both sizes, both themes |
| First launch with a name saved from the popover | Add your name, "Sam", Enter | 1024 dark |
| Three projects, no runs ("No runs yet. Open a project to start one.") | inline form, then dialog | both sizes, both themes |
| Busy day: 2 decisions (a permission card and a `[mock:schedule]` proposal), a paused run, a stopped run with an output, a stopped Chat run, a schedule due in 20 min, 4 open to-dos (IPC, plus an assistant one from `[mock:todo]`), a live deep tree | scripted | both sizes, both themes, scrolled to the bottom at dark |
| Pin from More > Pin to top; Customise (move, hide, show, Reset, Esc) | mouse and keyboard | 1024 dark, 1600 dark and light |
| Relaunch: runs cut by quit | app closed and reopened on the same data dir | both sizes, both themes |
| One decision plus one failed run (`[mock:auth-fail]`), keyboard Allow once, then the working and quiet briefs | second script | 1600 dark, 1024 dark |
| A paused run on its own | `[mock:model-switch-limit]` | 1024 dark |
| 40-character name | settings | 1024 dark |
| Reduced motion on, live run | settings | 1600 dark |
| Settings > General > About you | mouse | 1600 dark |

## Findings

### Medium

**M1. "Paused until 10:40 PM" has no day, and the pause is 24 hours long.**
Where: greeting brief and the Pick up paused row. Shots: `ux-dashboard-4-b-06-paused-1024.png`, `ux-dashboard-4-05-busy-1600x1000-dark.png`.
Repro: start a run with `[mock:model-switch-limit]`, open the Dashboard at 22:40. The brief reads "1 run is paused until 10:40 PM." and the row
reads "Docs site · resumes at 10:40 PM if OrgAI stays open". Measured: `pausedUntil` is `now + 23.99 h` (Fri 20 Nov 22:40 local).
What a first-time user thinks: it is 10:40 PM now, so the run should be back this minute; they wait, then wonder why Resume now is still offered.
A real usage-limit pause can be up to hours or a day away, so this is not only a mock artefact.
Fix: say the day when it is not today. Copy: "1 run is paused until tomorrow at 10:40 PM." and "Resumes tomorrow at 10:40 PM if OrgAI stays open"
(weekday name beyond tomorrow, "Fri 22:40" style in 24-hour locales). Keep "until 10:40 PM" only for a time later today.

**M2. On first launch the name is saved but nothing shows it, and "Add your name" does not look like a control.**
Where: first-launch greeting. Shots: `ux-dashboard-4-01-first-launch-1600x1000-dark.png`, `...-01-first-launch-1024x640-light.png`, `ux-dashboard-4-03-first-launch-named-1024-dark.png`.
Repro: fresh data dir, click "Add your name", type Sam, Enter. The greeting stays "Welcome to OrgAI." (by design, 5.2) and a pencil appears.
Two problems. (a) The button is a borderless ghost in small body text, `Add your name`, under the brief; in the light theme it is almost
indistinguishable from a caption. (b) After saving, the person sees no reaction at all; the spec keeps the name out of the first-launch
screen, so the only evidence is a pencil icon and the live-region text "Name saved." that sighted users never see.
Fix: give the ghost button a visible affordance (an icon, or `secondary` styling) and, on first launch only, show the saved name so the action
lands: "Welcome to OrgAI, Sam." If the spec decision stands, put a hint in the popover: "Your name appears in the greeting once you have a project."

**M3. The quiet brief says "nothing is waiting on you" while a row below says "Waiting for your reply".**
Where: greeting brief vs Working now. Shot: `ux-dashboard-4-b-05-return-1600.png`.
Repro: run First task, Allow once its permission, let it settle idle, leave the Dashboard and return. Brief: "Nothing has changed since you were last here,
and nothing is waiting on you." Working now (heading) shows "1 idle", the run "Idle First task" with "Waiting for your reply". A Failed row sits in Pick up.
What a first-time user thinks: the page contradicts itself; either the assistant is waiting for me or it is not. Also nothing in the "Working now"
section is working.
Fix: either count an idle run that is waiting for the person's reply in the waiting sentence ("1 assistant is waiting for your reply."), or reword the
band line to something that is not a request ("Idle, last reply 2 min ago"). Rename the section when no agent is working: "Open runs" (or hide idle runs
from it), and change the quiet sentence to "Nothing new since you were last here, and no decisions are waiting." so it only claims what is true: decisions.

**M4. Three words for one state, and a repeat inside one row.**
Where: sidebar "Needs you · 2", section "Waiting on you", Working now row "Needs you  Please schedule a check ... · Waiting on you", Working now
counts "2 waiting for you". Shot: `ux-dashboard-4-05-busy-1600x1000-dark-bottom.png`.
What a first-time user thinks: are "Needs you" and "Waiting on you" different things? In the band the same row says both within one line.
Fix: pick one phrase for the person's decisions. Suggest "Waiting on you" everywhere the Dashboard and sidebar speak of decisions (the status word
in `lib/runStatus.ts` can stay "Needs you" for a run's badge) and drop the " · Waiting on you" suffix when the row already carries the "Needs you"
word, so the row reads "Needs you  Please schedule a check" with the decision label under it.

**M5. The paused row is the only one with a long reason, and it is cut mid-sentence on a half-width column.**
Where: Pick up, paused row. Shot: `ux-dashboard-4-05-busy-1024x640-dark.png`, `ux-dashboard-4-05-busy-1600x1000-dark.png`.
"The five-hour usage limit was reached, so the session ended. Reports still working were cut off; an..." ends on "an..." (two lines, then ellipsis), so the one
fact the person needs (what to do, and when it resumes) is the part clipped. The time is on line 2, so the action is clear; the cut sentence is noise.
Fix: show the first sentence only: "The five-hour usage limit was reached." and keep the rest in the row's `title` and in the run.

### Low

**L1. After a keyboard Allow once that empties Waiting on you, focus lands on the heading "Pick up where you left off".** Measured in the second pass
(`allow-focus-after`: `H2 Pick up where you left off`; the live region said "Allowed once: Edit example.ts."). Waiting on you is hidden when empty, so the
spec's "this section's h2" fallback falls through to the next section. It is a sensible place, but a screen-reader user hears an unrelated heading.
Fix: announce "No decisions are waiting." through `dashboard-live` in the same message, so the jump has a reason.

**L2. "Schedules: Schedules: Create ..." in the proposal row.** Known (section 17). Shot `ux-dashboard-4-05-busy-1600x1000-dark.png`. Fix the label to
`Schedule: Create "Nightly PR monitor"`; also in Working now where the same text repeats.

**L3. Customise mode is long and repeats every title.** At 1600x1000 the page becomes one full-width column (spec), so six control rows and the content
stack to well over a screen, and each section name shows twice (the dashed control row, then the h2). The up/down chevrons are small and dim, and at the top
the first section's "up" looks active though it is `aria-disabled`. Shots `ux-dashboard-4-07-customise-1600-light.png`, `ux-dashboard-4-b-11-customise-hidden-1024.png`.
Fix: in the control row drop the repeated title when the h2 sits directly below, or collapse content to the heading while customising; dim the disabled end
button. Add a short reason for the two fixed sections: "Waiting on you stays at the top."

**L4. Wide layout leaves a hole under Pick up.** 1600x1000 busy: Pick up has 3 rows and Today has 4 to-dos plus a schedule, so the left column is empty for about
200 px (y 660 to 860) before Working now. Spec 2.2 accepts paired rows, so this is polish. Shot `ux-dashboard-4-05-busy-1600x1000-dark.png`.

**L5. After relaunch the page is correct but heavy: six Pick up rows, four reading "Ended when OrgAI closed", all with a "Continue" that looks identical.** The brief names
only the two that were waiting; the other two (a deep tree and a paused run) are not distinguishable at a glance. Shot `ux-dashboard-4-12-relaunch-1600x1000-light.png`.
Fix: keep the detail line for rows that need an answer and show the other ended-with-app rows in a muted tone, or sort the two waiting ones first (they already are).

**L6. "Hello" at 22:00-04:59.** At 10:40 PM the greeting reads "Hello, Sam." (spec 5.2). Not wrong; slightly cold in the evening and the most likely time for people who work late.
Consider "Good evening" until 02:00.

**L7. First launch at 1024x640 scrolls by 52 px just to show the footer** (`scrollHeight 644` against `clientHeight 592`). The only content below the fold is the app-facts line;
not harmful, but the window gets a scrollbar on its one screen. Fix: reduce the vertical gap above "How do you want to start?" (about 56 px at 1024).

**L8. Mock artefacts, not product.** Run names show the marker text ("Please remember this mocktodo", "Deep tree mockdeep-tree"). Mentioned so nobody files them.

## Checked and fine

- One h1, section h2s in visual order at both sizes; no horizontal overflow (`scrollWidth == clientWidth` at 958 and 1368); the window never scrolled.
- 1024x640 busy: greeting, both decisions and the first two Pick up rows are inside the viewport (shot `ux-dashboard-4-05-busy-1024x640-dark.png`).
- Brief truth in each state I could make: no runs, 2 decisions plus paused, decision plus failed, working plus failed, quiet, ended-while-waiting on relaunch. Never "$0.00".
- One home per fact: the decision shows as a row once; the band says it in words, the tile only its count ("1 decision waiting"), no raw command outside the card row.
- Keyboard: Tab order follows reading order; Pick up main button then action; Today rows; band rows; ledger is one stop and arrows, Enter (aria-pressed true), Home all work
  and the readout follows; the Allow once and Deny names carry the full command; Customise Tab path is Customise, Reset, each section's up, down, Hide; Esc leaves and focus returns to Customise
  (`after-esc-focus` = `dash-customise`); the live line spoke "Today hidden. Projects moved up. Position 4 of 5." Tile focus draws a 2 px purple border on the tile (shot `ux-dashboard-4-b-09-tile-focus.png`), though the button itself reports `outline: none`.
- Pin: More > Pin to top, live line "Pinned Mobile app. It is now first.", tile moves first with a pin glyph, Pick up gets a pinned row if the project has no thread.
- Name: popover has the labelled field and hint; 40-character name ("Bartholomew-Maximilian Featherstonehaugh") fits on one line at 1024 (shot `ux-dashboard-4-b-01-long-name-1024.png`); the same name field is under Settings > General > About you with the same hint (shot `ux-dashboard-4-11-settings-about-you.png`).
- Reduced motion: with a live run, the marks read `::after` animation `breathe` normally and `none` with reduce motion on; no `.motion-ring` left after a section move.
- 1280x800: two tracks (container 1038 px), as the 1000 px breakpoint says.
- Both themes: text, rows, the tinted Waiting block and the ledger all read in light (`ux-dashboard-4-05-busy-1600x1000-light.png`); I did not measure contrast ratios.

## Not verified

- Brief variants I could not produce on the mock: "N runs finished since you were last here, costing $X" (a run that finishes by itself without being Stopped did not occur; the only ones I got ended Stopped or
  Idle), "finished and failed", the "in the past 7 days" wording (needs a stored last-seen older than 7 days), a paused-only brief with an auto-resume time and a closed-while-waiting plus working pair. Unit tests cover them; not seen on screen.
- A failed name save (`dash-name-error`), a refused 41-character or zero-width name by hand, the 25th pin, the pin limit message.
- A decision arriving two seconds after load (arrival motion), and a second real window following a layout change.
- Plan limits in Your week (mock adapter hides them), real Claude or Codex run output, real schedules firing.
- Screen-reader speech (I read the live region text, not speech), high-contrast mode, macOS.
- Open output on a chain with several outputs and "Show N more" in Pick up and Today (no more than 6 Pick up rows or 5 to-dos reached the cap in my data; `dash-today-more` showed "Show 1 more" in the first pass but I did not press it).
- Dragging: none exists by design, so none was tried.
