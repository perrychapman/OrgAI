# QA: Pocket Office living office rework

Gate on the merged rework (worktree base 4e01f412). Mock adapter only (`ORGAI_MOCK=1`, throwaway data dir, `ORGAI_MOCK_SCRIPT` fixtures), built app from `out/`, driven with playwright-core `_electron`. No product code and no e2e script was changed; the fixtures were scratch scripts outside the repo (`%TEMP%\qa-office\*.mjs`, not committed). Screenshots: `e2e/shots/ux/pocket-office-qa/` (gitignored; absolute base `C:\Users\chapp\Projects\OrgAI\.claude\worktrees\agent-a2db0db7dfe109bec\e2e\shots\ux\pocket-office-qa\`).

## Verdict: PASS WITH FINDINGS

No crash, no console error, no wrong or replayed motion, no layout shift of placed people. Three Medium findings sit in Office files and are introduced by the rework (the strip shows two of its three rows, Find does not bring someone into view in a very small stage, and a long unbroken name breaks a strip row). Everything else is Low, Info or outside the Office files.

## Findings

Class: R = introduced by the rework, E = existing or outside the Office files, ? = could not tell which.

| # | Sev | Class | Finding |
| --- | --- | --- | --- |
| F1 | Medium | R | The message log shows two rows, not three |
| F2 | Medium | R | Find a person leaves the person outside a small stage |
| F3 | Medium | R | A long unbroken agent name breaks a strip row |
| F4 | Low | ? | Removing the focused person in Team drops focus to the page body |
| F5 | Low | R | Bubbles overlap each other, and at Fit they hide people and plates |
| F6 | Low | R | Off-screen chips and directory rows with long names are clipped |
| F7 | Info | R (by design) | The strip freezes while focus is inside it, with no visible hint |
| F8 | Medium | E (known) | The permission card and open directory shrink the stage to 106 to 123 px |
| F9 | Info | E | Names with emoji or an RTL override become the role name |

### F1 Medium (R): the log shows two rows, not three
- Steps: Live run on the mock with a message every 1.3 s (`a1` to `a2` and so on), any window size. Measure `.office-message-strip` and each `[data-testid=office-caption]`.
- Happened: strip is 48 px (`overflow-y: auto`, scrollHeight 72, clientHeight 47), every row is 24 px, rows sit at y 587-611, 611-635 and 635-659 against a strip bottom of 634. The oldest row is clipped and only reachable by scrolling or by Tab. The spec and CLAUDE.md say a three-row log.
- Expected: three rows visible in the 48 px (16 px rows) or a spec change to two rows at 24 px (the 24 px Show target is the likely cause).
- Why e2e misses it: `pocket-office.mjs` checks height about 48 and `rows.length === 3`, never visibility.
- Screenshots: `g-strip.png`, `a-data-final.png`.

### F2 Medium (R): Find a person does not show the person in a small stage
- Steps: window 1024 x 640, Live run with 19 agents (two departments plus a third later), open "Find a person", press the row for `b8` (off-screen). Optionally open another person first (inspector open) so the width does not change.
- Happened: the person is selected and ringed (`data-office-found`), but for the 3 s ring the person's button stays outside the stage. Rect with the inspector newly opened: person x 872-904 against stage right 744. With the inspector already open: person y 291-339 against stage bottom 286. The stage is 688 x 122 px (directory open, inspector open). `data-office-motion-phase` reads `pinned`. Works at 1600 x 1000 (person fully inside at once), and for a person still walking in (`late1` arrived and was inside the stage within 0.5 s).
- Expected: the camera ends with the person inside, or the directory collapses/scrolls the stage into view. Cause is not confirmed: the pan seems computed before the layout change (inspector opens, directory open), or the 122 px stage cannot hold person plus plate.
- Screenshots: `l-find-1024.png`, `b-find.png` (the ring is half clipped at the stage bottom).

### F3 Medium (R): long unbroken name breaks a strip row
- Steps: agent named `W` x 90 (no spaces), another agent messages it. Window 1280 x 800.
- Happened: the Show button is 767 px wide and ends outside the row (`showInRow: false`), and the message text collapses to 0 px (`textW 0`), so the row reads only "Show WWWW…". Rows with an Arabic 29-character name or a mixed Polish/CJK/Korean name stayed inside (Show 218 and 232 px, text truncated with overflow).
- Expected: the Show label truncates (the toolbar chip does: 192 px with an ellipsis) and the text keeps a minimum width.
- Screenshot: `i-bubbles.png` (second strip row).

### F4 Low (?): focus drops to body after removing the focused person in Team
- Steps: Team view, Pocket Office presentation, focus a person, Enter (inspector), Remove, confirm "Remove role".
- Happened: `document.activeElement` is `BODY`. In the Graph presentation the same flow lands on a graph node (`DIV#rf__node-…`). Whether the old Office did this too was not tested.
- Expected: focus on the neighbouring person or the Team stage.
- Screenshot: `h-after-remove.png`.

### F5 Low (R): bubbles collide and cover people
- At 1280 x 800, 2x: two simultaneous bubbles (`y1` to a long name, and the Orchestrator one) overlap and the lower one hides the upper's text (`i-bubbles.png`).
- At Fit with 81 agents, bubbles and exchange nameplates keep their full pixel size over the half-scale rooms; one plate (`d2w9`) is hidden under a bubble (`e-live-fit.png`). Bubbles are capped at three and ignore the pointer, so nothing is blocked; it is legibility only.

### F6 Low (R / E): clipping with very long names
- Toolbar off-screen chips are capped at 192 px with an ellipsis, correct. Room labels are truncated to 63 characters plus an ellipsis; one overflow room label (`… 3 · 1`) still reports `scrollWidth > clientWidth`.
- Directory rows (existing component) clip the wrapped long-name text vertically (`i-bubbles.png`, "Find a person" list).

### F7 Info (R, by design): held strip
- With keyboard focus on a Show button the rows hold still (code comment in `OfficeStrip.tsx`); I confirmed the same node stays connected for 10 s while the real log moved on. Nothing says the log is held. Fine for focus safety; consider a "paused while focused" hint.

### F8 Medium (E, known): stage height
- Permission card (needs-you) at 1600 x 1000: stage 975 x 314. At 1024 x 640: 918 x 106 and the lobby person's nameplate is clipped at the stage edge. Needs-you is still readable through the person's `?` mark, the sidebar badge and the "↓ b1 · needs you" chip.
- At 1024 x 640 with the directory open the stage is 688 x 122 (no permission card). Same cause: vertical space taken by the directory.
- Screenshots: `d-needsyou-1024-dark-color-1x.png`, `d-needsyou-1600-dark-color-2x.png`.

### F9 Info (E): name sanitising
- Spawn names with emoji (`👩🏽‍💻`) or `U+202E` render as the role name ("Implementer"). Arabic, Hebrew, Polish, CJK and Korean names pass unchanged. This is in the mock/runtime naming, not the Office; unverified for the real adapters.

## What held up
- Layout stability: 13 agents running, window 1600 -> 1024 -> 1600 -> 1280 -> 1024 mid-run: the `data-office-x/y` of every resting person identical in all sizes. Also unchanged from 4x to 0.5x. Bubbles stayed centred on their person at every zoom (dx 0, dy follows zoom). Building dims constant (58 x 28) at all sizes.
- Growth while zoomed (2x) and panned (scroll 632,389): three agents and two new rooms arrived, building went 58 -> 70 wide, scroll stayed 632,389, no resting person moved.
- Overflow rooms: department of 9 -> rooms 8 + 1 (`Name · 8`, `Name 2 · 1`); department of 17 -> 8 + 8 + 1; a 120-character department name is truncated with an ellipsis and the building width grows (70 x 33 for 29 agents, 118 x 33 for 81).
- Load caps: 29 agents running: `data-office-animated` 12, never more. 25-message burst: at most 3 bubbles / 3 walks, queue peaked 5 (cap 12), the strip keeps the last messages, no pile-up. A 2000-character message: the bubble clamps to at most 98 characters and 200 px; the strip shows the full text on one truncated line; `<b>` rendered as text. Messages to and from a finished agent show the correct names and Show buttons.
- Motion truthfulness: after a (simulated, see below) hide of 10 s, a Graph round trip, History and back, and a full reload, no earlier message was replayed (bubble texts for the skipped messages never appeared) and no one re-walked in (`arrive` appears only for the initial spawns). With no messages, no non-rest phase appeared.
- Pause motion: clock `stopped`, every cue `none`, bubbles and talk marks still appear with each message, wait/done marks stay. Reduce motion: no walks, bubble and talk mark appear together, Pause is disabled with the title "Motion is already off: Reduce motion is on in Settings", zero running animations in the scene.
- States by picture: waiting (`?`), finished (check) and failed (red triangle, nameplate "Failed") are distinguishable in Color, Neutral and Green at 1x and 2x (viewed: Color dark 2x, Neutral light 1x, Green dark 1x, failed Color 2x; the other combinations were captured but not individually reviewed). At 1x the marks are small (about 16 px) but the shapes differ.
- Camera: drag from empty floor pans (`data-dragging`), drag that starts on a person does not pan and keeps the button's focus; Home, Arrow keys (26 px at 1x), +, =, -, _, 0 all behave; min and max zoom clamp without scroll jump. Tab order: Zoom out, Zoom in, Fit, Pause, off-screen chip, stage, people in building order, deliveries log, Show. Chip press moves focus to the person. Focus ring on a person is a 2 px outline with 2 px offset in both themes (`rgb(165,146,255)` dark, `rgb(79,51,214)` light, `:focus-visible` true).
- Performance (renderer `rAF` gaps, 144 Hz display): 33-role Team pan/zoom p95 8 ms, max 16 ms; 81-agent Live pan p95 8 ms, zoom stepping p95 15 ms with 2 frames above 50 ms (max 67 ms); idle Live 81 agents p95 8 ms; paused p95 14 ms. No visible stutter.
- Memory (renderer working set, `getAppMetrics`): Team 33 roles 200 MB at start, 206 MB at 4x, 255 MB after 20 zoom in/out cycles; Live 81 agents 344 MB, 425 MB at 4x. JS heap reading stayed 26 MB (coarse). One sample each; a leak is neither shown nor ruled out.
- Team view: the 33-role Team renders (`e-team-4x.png`); static data attributes are covered by `e2e/pocket-office.mjs` and were not re-asserted here.

## Not driven
- A truly hidden window: Electron's `minimize()` left `document.visibilityState` at `visible` under the driver, so I overrode `document.hidden` and fired `visibilitychange`. The listeners are exercised; Chromium's own rAF throttling in a hidden window is not.
- An agent removed mid-walk or mid-bubble in a live run: the mock never removes agents (finished and ended agents stay). Only the Team role removal (F4) and scheduler code (`endpointsPresent` drops obsolete deliveries) were checked; no live drop was observed.
- 200% app zoom, High contrast / forced colors, screen-reader speech, touch and trackpad pinch.
- Real providers and real message volumes; real Windows hide/lock; macOS.
- The Settings sample (inert, no clock) and the static Team marks beyond the e2e coverage.
- Exact regression status of F4 and F6 against the pre-rework Office (not built).

## Touched files
Only this file: `docs/design/qa-pocket-office-rework.md`. Untracked and ignored: `node_modules` (a copy of the main checkout's, for the build) and `e2e/shots/ux/pocket-office-qa/*.png`.
