# UX review: Factory Floor (slice 6 build)

Reviewer: UX Researcher. Build: `12b4c3b5` (worktree build, `npm run build`). Mock adapter only (`ORGAI_MOCK=1`, throwaway data dir, no tokens).
Spec compared: `docs/design/factory-floor.md` sections 6, 7, 8 and the Implementation notes. Factory Floor is Live only by owner decision, so Team showing the Graph is not reported.

Method: Electron driven through playwright on `e2e/lib.mjs`. Sizes 1600x1000 and 1024x640 (`setContentSize`), dark and light, mouse first, then a keyboard pass at 1600x1000. Renderer was `webgl2` (this machine's own GPU path), plus the floor plan forced with `localStorage['orgai.factory.renderer']='floor-plan'`. Runs: a plain prompt (2 agents, one permission card), `[mock:factory-floor]` (39 agents on the floor, one failed, one Needs you, a 3-step plan with one blocked) and a custom 122-agent script for Large team.
Shots: `docs/design/factory-floor-shots/slice-6/ux/` (26 files, named in each finding). The raw walk scripts and all 43 shots are in `e2e/shots/ux/factory-floor/` (gitignored).

## Verdict: GOOD, with three things to fix first

A first-time user can pick it, see a believable factory, find a failed worker, open its inspector and operate the floor from the keyboard. Stations, lamps, nameplates, Find, Floor log, plan board and the floor plan all work and read well in both themes. The problems are about the camera and the space around it: once a decision card is open the stage is too small to show the floor, Fit does not fit, and the card steals focus from someone walking the floor.

Observed things that work: the settings sample is a real picture of the floor in both themes (shots 02, 03); Tab enters the floor on the selected worker; arrows, Home, End, Enter, Space, Shift+arrows, `+`, `-`, `0` all behave as the hint says; Escape in the inspector returns focus to the worker; Find filters, shows the empty message "No worker matches “w31zzz”." and moves focus to the chosen worker; Pause motion sets `aria-pressed`; Floor log lists entries newest first; no page scroll at either size; Large team shows the exact copy from section 8.

## High

### H1. Fit and zoom-out cannot show the whole floor when a decision card is open (1600x1000 and 1024x640)

Screens: Live, 40-agent run with a permission card. Shots `09-ff-settled-dark-1600`, `11-ff-zoomout-min-dark-1600`, `33-1024-ff-light-fit`.
Repro: start a prompt containing `[mock:factory-floor]`; wait about 30 s for the floor to fill and the Needs-you card to appear; press Fit (or `0`), then Zoom out repeatedly.
What happens: the stage is 985 x 450 px at 1600x1000 (card below it) and 928 x 240 px at 1024x640. Fit and minimum zoom are both ppm 7. Measured with 39 workers: lines 10 to 13 (about 14 workers) sit below the stage edge (their buttons are at y 605 to 805 on a stage that ends at y 570), and the bottom visible row is hidden behind the control bar. At 1024x640 only lines 1 to 3 are visible, the Needs-you worker (line 7) is off screen, and the control bar covers a visible station. Fit and Zoom out stay enabled and give no sign that nothing changed. The floor does not re-fit when the card arrives and shrinks the stage.
What a user does: presses Fit, sees the same thing, concludes the floor is cut off or broken, and cannot see the worker that is waiting for them.
Fix: let Fit and the minimum zoom use the real stage size (lower the minimum ppm when the floor is taller than the stage), re-fit once when the stage resizes if the user has not moved the camera, and disable Zoom out at the minimum. Also keep the Needs-you worker in view: when a card arrives, offer "Show {name}" on the card or the Needs-you nameplate that pans to it. Recommended copy for the card link: "Show ff-w211 on the floor".

### H2. A new decision card takes keyboard focus away from the floor

Shot `24-card-arrived-focus-dark-1600` (state), observed with a script. This is the known open item; here is what I saw.
Repro: start a plain prompt; as soon as the booth button exists, Tab or focus it and press an arrow key; wait about 3 s.
What happens: focus moves from `Orchestrator, control booth` to the card's `Allow once` button the moment the card appears (3 s in, held for the next 11 s I sampled). Nothing is announced on the floor. The card also shrinks the stage by about 300 px at the same moment (stage 985 x 429 at 1600, 928 x 242 at 1024). A keyboard user who presses Enter next accepts the permission without having looked at it, and a user who was reading the floor loses their place. After Allow once, focus went to the composer, not back to the floor.
Fix: do not pull focus while focus is inside the floor controls. Instead announce "Permission needed from {worker}" through the existing frame announcer and mark the Needs-you worker. If focus must move, move it to the card heading, not to the primary action. After the card is answered, return focus to the worker that was focused before.

## Medium

### M1. "Back to floor" is shown with nothing selected and does not change anything visible
Shots `06-live-plain-later-dark-1600`, `14-select-failed-worker-dark-1600`, `15-after-back-to-floor-dark-1600`.
Repro: start any Live run, do not click anything.
What happens: the inspector is already open on Orchestrator and shows "Back to floor" at the top. Click a worker, press "Back to floor": focus returns to the worker, the inspector and the selection stay. A new user expects it to close the inspector and clear the selection.
Fix: rename to "Focus the floor" or make it also deselect and close; hide it while the root is the automatic selection. Recommended copy: "Return to floor".

### M2. Inspector title does not say which worker it is
Shot `14-select-failed-worker-dark-1600` (ff-w123 selected; panel header reads `R2 Implementer implementer`). Select any of 27 workers: all show "Implementer". Only the nameplate or Find row has the name. Fix: lead the header with the agent name, "ff-w123 · Implementer". Same in the Transcript ("You: Worker 1.2.3" is the only clue).

### M3. Floor log names every new worker "Implementer"
Shot `21-floor-log-open-dark-1600`. 27 of the 50 entries read "ff-s12 assigned work to Implementer" three times in a row. The child's role is shown instead of its name. Fix: "{parent} assigned work to {child name}" as section 6.5 specifies ("ff-s12 assigned work to ff-w121"). The log also keeps only 50 and restarts at "Floor log (0)" after leaving Factory Floor and coming back mid-run (shot `37-floorplan-1600-dark`); say so: "Floor log (0): earlier events are in the transcript".

### M4. Floor log summary overlaps the control bar when the inspector is open at 1024x640
Shot `28-1024-click-worker-dark`. Stage is about 690 px wide, the Floor log summary sits on top of the "Pause motion" button (reads "Pause mo"). Fix: stack the log above the controls or collapse the controls to icons at that width (section 6.7 says below 560 px; this happens at about 690).

### M5. "Use Graph" changes the app-wide setting, drops focus, and the banner cannot be dismissed
Shot `42-large-team-1600-dark`, `43-after-use-graph-1600`.
Repro: run a team of more than 120 agents; press "Use Graph".
What happens: the Large team banner (about 110 px of stage) has no dismiss control although section 8 says dismissible. "Use Graph" switches the presentation everywhere, stored in App settings; focus falls to the page (BODY). The user is not told the choice is saved, and the next Live run will not try the 3D floor again.
Fix: add a dismiss button; rename to "Show this run as a Graph" if it is per run, or keep the setting and say it: "Use Graph (changes Canvas in App settings)". Move focus to the Graph or the run header after the switch.

### M6. Canvas settings copy promises Team too
Shot `02-settings-factory-selected-dark`. The section subtitle says "Applies across the app, including Live and Team." After choosing Factory Floor, Team still shows the Graph. Fix: "Factory Floor shows in Live. Team keeps the Graph." (This is a copy mismatch, not a defect in the decision.)

### M7. No key to the lamps or stations
Shots `08-live-ff-1600-dark`, `39-ff-zoomed-failed-light-1600`. A first-time user sees amber stripes, lamp colours, a dock with a "merged" count and a plan board with no explanation. The nameplates carry the words, but only for selected, Needs-you, Failed and a few more at close zoom; at Fit only 3 plates show of 39 workers (the rest are silent shapes). Fix: a "What am I looking at?" entry in the Find popover or a small "Key" button in the controls: "Green lamp: working. Amber: needs you. Red: failed. Stripes: a branch waiting to merge."

## Low

- L1. Floor plan tiles show a status icon but no status word (shot `37-floorplan-1600-dark`: "ff-l1" with a pulse icon only); the spec asks for the word. The plan board tile truncates "0 of 3 done · 1 bloc…".
- L2. Pause motion keeps the label "Pause motion" when on; only a faint fill and `aria-pressed` change (shot `40-ff-paused-light-1600`). Show "Resume motion" or a clear pressed look. It is also shown on an ended run and in the floor plan, where nothing moves (shots `07-live-plain-ended-dark-1600`, `42-large-team-1600-dark`).
- L3. Zoom in after Find keeps the old camera centre, so the worker you just found drifts off screen (shot `39-ff-zoomed-failed-light-1600`: ff-w123 selected, not visible). Zoom around the selected worker when one is focused.
- L4. Find popover opens upward over the run tab strip and stat line and is scrollable but not clamped (shot `18-find-open-dark-1600`); a first-time user loses the run tabs while searching.
- L5. The plan board button's focus ring collides with the "Main checkout" label (shot `23-plan-board-opened-dark-1600`).
- L6. Nameplate text for Needs you repeats itself: "Needs you · Needs approval: Editing exa…" (shot `06-live-plain-later-dark-1600`). Use "Needs you · Edit example.ts".
- L7. Ended run reads "Finished · Stopped" and "Finished · Ended without a result" for a session the user ended (shot `07-live-plain-ended-dark-1600`); "Ended" would be accurate.
- L8. The sample picture in settings sits flush against the Presentation card with no gap (shot `02-settings-factory-selected-dark`), and the thumbnails are 70 x 46 px so the 3D look is hard to see. The Graph sample (not this feature) prints "26444h 40m" for elapsed time in the mock preview (`01-settings-before`).
- L9. Selection ring at Fit (ppm 7) is a few pixels (shot `20-find-chosen-dark-1600`); it is there but easy to miss. Consider a larger ring at low zoom.

## Not driven or not seen

- Context loss, chunk load failure, "3D view unavailable" (no WebGL2), "Try 3D again": the mock cannot force them and this machine has WebGL2. Only the forced floor plan and Large team were seen.
- Screen reader speech and the announcement timing (2 s coalescing): not heard; I read the DOM names only (e.g. "ff-w123, Failed", hint text matches spec).
- Reduced motion and OS contrast modes were not toggled. Pause motion was toggled but I did not measure motion stopping frame by frame.
- Software-GPU path and real-GPU performance numbers: not measured; frame feel was fine but not timed.
- Mid-run switch from 3D to floor plan when the agent count passes 120: I saw the counts rise (114 then 122) and the floor plan at the end, but did not capture the moment of the swap.
- The initial camera of a 40-agent run at 1024x640 before the card arrives: one capture (`30-1024-ff-light`, not copied) showed a close zoom with only booth and dock; later captures showed a fit view. I cannot say whether that was a transition after the theme switch or the real first view.
- Hover emissive lift (spec says not built) not checked beyond the nameplate showing.
- Windows only; macOS and Linux not driven.
