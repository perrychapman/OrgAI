# UX review: Dashboard re-walk

- Reviewer: UX Researcher (mock-data walkthrough, no code changes)
- Build: e25f8bb (worktree HEAD; the Dashboard merge on dev). The brief named 79257a4: that commit is the same merge
  but its package.json still holds conflict markers in `e2e:free`; dev carries e25f8bb instead, so the renderer
  under test is identical. `npm run build`, version 0.1.6-dev1.
- How it ran: built Electron app driven by playwright-core through `e2e/lib.mjs` `launch()` / `relaunch()`,
  `ORGAI_MOCK=1`, fresh temp `ORGAI_DATA_DIR`, fixture git repos named `docs-site`, `billing-service`, `notes-api`,
  `release-tools`, `scratch-tool`. Three mock scripts across relaunches (a plan plus rate limit for a paused run; the
  default script at 3 s per step for a live `[mock:deep-tree]` run and a permission card; a plan plus an Edit card).
  Sizes 1024x640 (rail), 1600x1000 (full sidebar), plus 1424x855 and 1280x800; dark and light through
  `settings.appearance.theme`; one keyboard-only Tab pass on the first-launch page and one on the populated page
  (1024x640); two relaunches. No tokens, no smoke scripts.
- Compared with: `docs/design/dashboard.md` (incl. section 12 implementation notes), the earlier walk
  `docs/design/ux-review-dashboard.md` (H1-H3, M1-M6, L1-L4), `.orgai/ARCHITECTURE.md` "Renderer UI".
- Screenshots: `docs/design/ux-review-dashboard-2-shots/NN-*.png`. Walk scripts and raw measurements (`raw.json`,
  `raw2.json`): `e2e/shots/ux/dashboard-2/` (gitignored).
- ASCII note: the app writes a middle dot; it is shown here as " . ".

## Verdict

NOT READY (two Highs, both small fixes). The Dashboard is a real improvement and reads as OrgAI: attention first,
honest status lines, folder names, the More menu, an honest Delete confirm, the New project dialog with correct focus
return, and the fact cards. Every earlier High is addressed in layout and copy. But two things mislead the user:
the "Continue" button on a run cut by a quit does nothing when pressed from the Dashboard (new H1), and a deleted
project's last run keeps showing as "Finished ... Project" in "Since you were last here" and keeps counting in both
cost figures (new H2). Fix those two, then the Mediums around the "Since" list lifetime and the hero after a relaunch.

## Status of the earlier findings

| Item | Status | Evidence |
| --- | --- | --- |
| H1 no run / decision state on the page | Fixed | Needs you, Running now (status word, elapsed, "Step 1 of 3"), Since, Paused; tile status lines "1 decision . 1 run", "1 open", "Last run 1 min ago . Ended when OrgAI closed" (shots 08, 09, 29). Needs you row count = bell count (1 = 1). |
| H2 nothing says runs were cut by a quit | Partly | After relaunch both cut runs show "Ended when OrgAI closed" with "Was waiting on you when OrgAI closed." and Continue (shots 26-28). But Continue does nothing (new H1), the rows vanish after any navigation (new M1) and the hero still says "All quiet" (new M2). |
| H3 Delete silently wipes history | Fixed | Delete sits in the More menu; confirm reads "Ends 1 open run and deletes the history, transcripts and costs of 2 runs. Its project skills and saved service secrets go too. Files in its folder are untouched." (shot 15); initial focus on Cancel; Esc returns focus to the More button; a real delete moved focus to the next tile's Open. Leftovers after delete: new H2. |
| M1 cut paths | Fixed | Tiles show `docs-site`, `billing-service`, `notes-api` in mono, full path in the title (shot 09). |
| M2 order ignores attention | Fixed | Waiting project first, then live, then newest run (shots 08, 26, 29). |
| M3 focus lost after open / cancel | Fixed for tiles and the dialog | Enter on a tile: focus on the topbar h1 with a visible ring; Escape and Cancel on the dialog: focus on `new-project`. Remaining gap: a mouse click on a Running or Since row leaves focus on BODY (L5). |
| M4 first launch: submit below fold, Chat now last | Partly | Start choice is the first Tab stop, arrows switch, one primary (shots 01, 05). At 1024x640 the page still scrolls 239 px (scrollHeight 831 / client 592) and the submit sits at y 803 of 640. The spec check "under 60 px" is not met. |
| M5 form pushes projects off screen | Fixed | New project is a 720 x 583 dialog that fits 1024x640, one primary, Cancel in the submit row (shots 16, 17). |
| M6 nothing cross-project about money / limits | Fixed | Usage (tightest window and bar), Cost last 7 days with top 3 projects, Connections with default and status (shot 08). Totals disagree by a rounding step (L1). |
| L1 role initials | Fixed | Tiles show "4 roles" only. |
| L2 mock announced four times | Partly | Topbar badge gone. First launch still says it four times plus the account row: MOCK brand badge, hero "Mock adapter" badge, the `use-mock` checkbox and "Runs on the mock adapter (no tokens)." (shot 03). |
| L3 wordmark squeezed to "( MOCK Dev" | Open | Shots 03, 08, 20 at 1600: the lockup still reads "( MOCK Dev". |
| L4 page mostly empty at 1600 | Improved | Three tracks fill the width; at rest content ends near y 630 of 1000 (shot 08), which is fine. |

## Findings, ranked

### H1. "Continue" on a run cut by a quit does nothing from the Dashboard

- Screen: Dashboard after a relaunch, "Since you were last here". Shots 27 (before), 41 (after the click).
- Steps: start a default-script run (permission card) on Notes API; quit; relaunch; on the Dashboard press Continue
  on "Ended when OrgAI closed  Add a search e... . Was waiting on you when OrgAI closed."
- What the user sees: nothing. The view stays on the Dashboard, no run opens, the row stays, focus stays on the
  button. Measured: topbar still "Dashboard", no run tab selected, Running now empty, Since unchanged (`raw2.json`
  `continue.lands`, `since.after`).
- Cause (read in code): `useAppStore.ts` `continueFromHistory` (line 976) resolves the chain inside
  `selectedProjectId` and calls `openRun` but never selects the run's project or sets the view to 'run'; it was
  written for the History tab inside a project. From the Dashboard `openRun` returns early and the intent is dropped.
- Owner: `src/renderer/src/store/useAppStore.ts` (`continueFromHistory`) or `components/dashboard/AttentionColumn.tsx`
  (call `focusRun(projectId, runId)` first, then continue).
- Fix: Continue opens the run's project and run (as the row does), puts the cursor in the composer in its "Send to
  continue" state, and keeps the chain's memory, exactly as History > Continue does inside the project.
- Checkable: after a relaunch, pressing `dash-since-continue` on the Notes API row shows the Notes API Live tab with
  that run's tab selected and `document.activeElement` inside `.composer textarea`. Add this to `e2e/dashboard.mjs`
  (today it only checks that the button exists).

### H2. A deleted project's run stays on the Dashboard and in both cost figures

- Screen: Dashboard right after "Delete project". Shots 30, 45, 46.
- Steps: create "Release tools", start a run that is waiting on a card, More > Delete project... > Delete project.
- What the user sees: the tile goes and "Deleted Release tools." is (briefly) announced, but "Since you were last
  here" now lists "Finished  Plan the release . Project . just now $0.00285" (the location falls back to the word
  "Project"), the Cost card lists a row "Project $0.00285", and both the hero subline and the Cost figure still
  include it ($0.02141, `raw.json` `del.texts`; `raw2.json` `ghost.cost`). Clicking the ghost row does nothing
  (shot 46). It survives navigating away and back (`ghost.cost.afterNav`). The confirm had just promised "deletes the
  history, transcripts and costs".
- Cause (read in code): `removeProject` stops the live run, which arrives as a finished summary in the store's `runs`
  after the project is gone; the Dashboard sums `runs` plus `historyByProject` without checking that the project still
  exists (`useDashboardData.ts` `useAllSummaries`, `dashboardProjects.ts` `mergeSummaries` / `topProjectCosts`,
  `HeroBand.tsx`).
- Owner: `src/renderer/src/store/useAppStore.ts` (`removeProject`: drop the project's entries from `runs`,
  `historyByProject`, `activeRunByProject`, also when a late `run.status` arrives for an unknown project) and, as a
  guard, the Dashboard selectors (ignore summaries whose project is neither a stored nor a virtual project).
- Checkable: after deleting a project that had an open run, no `dash-since-row`, no Cost card row and no hero cost
  includes it; the Cost figure equals the sum of the remaining tiles' 7-day costs.

### M1. "Since you were last here" empties after any trip away, including runs still waiting on you

- Screen: Dashboard after a relaunch. Shots 26-28 (two rows with Continue), 29 (gone).
- Steps: relaunch with two runs cut while waiting; open New project, create a project, come back.
- What the user sees: both "Was waiting on you when OrgAI closed" rows and their Continue buttons are gone, without
  "Mark all seen" and without acting on them. The same happens after opening any run from a row and returning
  (`raw.json` `since.afterNav` empty after a Stopped row was shown once). This follows spec 4.3 (last seen advances on
  every in-app exit), but for cut-while-waiting runs it hides the only trace of the unanswered decision after one
  glance; the tiles then say only "Last run ... Ended when OrgAI closed".
- Owner: `components/dashboard/useLastSeen.ts`, `lib/dashboard.ts` `sinceLastSeen`, spec `dashboard.md` 4.3.
- Fix: keep `closed-waiting` rows (and failed runs) until the user continues, opens that run, or presses Mark all
  seen; let plain Finished / Stopped rows age out as today. Or advance last seen only on Mark all seen and on opening
  the row's run.
- Checkable: relaunch with a cut waiting run, create a project, return: the row and its Continue are still there.

### M2. The hero says "All quiet" right after OrgAI cut two runs that were waiting on you

- Screen: Dashboard after a relaunch. Shots 26, 27, 28.
- What the user sees: the biggest text on the page says "All quiet"; the subline drops "runs open"; the only signal is
  the Since section below. The figure counts decisions, live and paused runs only (`lib/dashboard.ts` `heroFigure`).
- Fix: when no decision, live or paused run exists but Since holds `closed-waiting` rows, the figure reads e.g.
  "2 to pick up" (or "2 cut when OrgAI closed") and the subline names them; "All quiet" only when nothing is
  waiting in any form.
- Owner: `lib/dashboard.ts` `heroFigure`, `components/dashboard/HeroBand.tsx`, spec 3.
- Checkable: relaunch the mock state; `dashboard-figure` is not "All quiet" while a `dash-since-continue` exists.

### M3. "Paused . resumes at 09:38 PM" is a promise a quit silently breaks

- Screen: Paused section, then after a relaunch. Shots 06, 07.
- Steps: a run hits the mock five-hour limit (`rateLimit`, 25 min); the Paused row says "Docs site . resumes at
  09:38 PM" with Resume now; quit and relaunch.
- What the user sees after relaunch: the run is "Ended when OrgAI closed", with no Continue (it was not "waiting")
  and no mention that it had been paused for a limit; nothing will resume. Before the quit, nothing said the resume
  needs OrgAI to stay open.
- Fix: the Paused caption says "resumes at 09:38 PM if OrgAI is open"; after a relaunch a run that was paused shows
  "Was paused for a usage limit when OrgAI closed." with Continue (spec 4.3 extends `closed-waiting` to paused runs;
  needs `endedWhile` or a paused marker from main, see CLAUDE.md "absent for a paused run").
- Owner: `components/dashboard/AttentionColumn.tsx` (`pausedCaption`, Since row), `lib/dashboard.ts` `endedKind`;
  main-side marker is a contract change.
- Checkable: a run paused before quit shows a Continue in Since after relaunch.

### M4. The delete announcement is overwritten by "All quiet" 11 ms later

- Screen: Dashboard live region (`dashboard-live`). `raw.json` `del.live`: `"Deleted Release tools."` at 39145 ms,
  `"All quiet"` at 39156 ms.
- What a screen-reader user hears: most likely only "All quiet" (the figure changed because the deleted project's
  card closed), not that the delete worked. The same channel also speaks "All quiet" once on mount after a relaunch
  (L4).
- Fix: when a delete message is pending, let it win over a figure change in the same tick (queue the figure, or
  append it: "Deleted Release tools. All quiet.").
- Owner: `components/dashboard/HeroBand.tsx` (the two effects writing `spoken`), `views/DashboardView.tsx`.
- Checkable: after a delete that also changes the figure, the live region's final text contains "Deleted <name>."

### L1. The hero cost and the Cost card disagree by a rounding step

- Shots 22, 24: hero "$0.01855 in the last 7 days", Cost card "$0.01856" on the same screen (tile costs $0.0114 +
  $0.00573 + $0.001425). Both should come from one sum. Owner: `HeroBand.tsx` (sums `useAllSummaries`) vs
  `FactsCards.tsx` `CostCard` (`costInWindow` over `mergeSummaries`). Checkable: both strings are equal.

### L2. The tile status dot is orphaned on its own line when the status wraps

- Shots 09, 24, 27 (1024 and 1280): "Ended when OrgAI closed" wraps and the dot sits alone above the text. Owner:
  `styles/dashboard-projects.css` `.project-tile-status` (make the dot and text one grid row, text wraps beside the
  dot). Checkable: at 1024x640 the dot's top equals the first text line's top.

### L3. State colour edges do not match the word

- Running now rows all get the blue left edge, including "Needs you" (amber dot) and "Idle" rows (shots 08, 22); the
  spec reserves the glow for Running. A paused project's tile dot is grey while its Paused row dot is amber (shot
  06). Owner: `styles/dashboard.css` `.dash-row-running`, `ProjectTile.tsx` state. Checkable: only rows with
  `data-status=Running` carry the edge.

### L4. The live region speaks "All quiet" on mount after a relaunch

- `raw.json` `phase2.texts0` / `relaunch.texts`: the sr-only region holds "All quiet" moments after mount (history
  loaded after the first render). Known open item in spec section 12; still present. Owner: `HeroBand.tsx`.

### L5. Opening a run from a Running or Since row leaves focus on BODY

- `raw.json` `running.click.lands`: focus BODY after a row click (the Needs you row correctly lands on "Allow once",
  shot 11). Owner: `AttentionColumn.tsx` (`focusRun` path) - focus the topbar h1 as tiles do.

### L6. First-launch hero and brand

- The hero mark is a plain gradient square rather than the OrgAI mark (shots 01, 03), so the one "brand moment" reads
  generic; the sidebar wordmark is still clipped to "(" (earlier L3). Owner: `HeroBand.tsx` `.dash-hero-mark`,
  `BrandLockup`.

### L7. 1424x855 and 1280x800: the fact cards no longer squeeze, but leave dead space

- Shots 22, 23, 24: in the two-track layout the facts sit two across under the tiles; Usage stretches to the Cost
  card's height with an empty lower half and Connections wraps alone onto a third row, below the fold at 855 px. No
  clipping (`clipped` empty in every measurement). Owner: `styles/dashboard-projects.css` `.dash-facts-grid` (align
  start, or stack Usage and Connections in one column beside Cost).

### L8. ErrorBoundary still says "Back to projects" (read in code, not seen)

- `components/ui/ErrorBoundary.tsx` line 37; spec 1 asks for "Back to Dashboard".

## Click counts (from the Dashboard)

| Task | Before (Projects view) | Now | Note |
| --- | --- | --- | --- |
| Answer the waiting permission | 2 | 1 (Needs you row lands on the card with "Allow once" focused) | |
| See what is running / waiting | sidebar only | 0 | |
| Learn a project's last outcome | hover or 1 per project | 0 | tile status line |
| Learn what ended while away | 1 per project | 0 | until the first navigation (M1) |
| Continue a run cut while waiting | open project, then Continue | 1 click that does nothing (H1); 2 via the row then the composer | |
| Cost this week, all projects | 3 per project, add by hand | 0 | L1 rounding, H2 ghost |
| Delete a project | 1 + confirm | 2 + confirm (More, Delete) | honest copy |
| New project from a populated page | 1, form pushes the list away | 1, dialog | |

## Keyboard pass (1024x640)

- First launch: start-choice radio, then New idea / Existing, Name, brief, folder, Browse, Architect, mock checkbox,
  then the skip links. Every stop has the 2 px ring. The disabled submit is not a stop and sits below the fold.
- Populated: New chat, New project, Needs you row, two Running rows, Mark all seen, the Since row, then per tile Open
  and More, then Connection settings, then the sidebar. DOM order equals visual order. The tile Open button draws its
  ring on the tile through `::after` (shots 43, 44, both themes). More opens with focus on "Open", arrows move, Esc
  returns to the More button. Mark all seen moves focus to the "Running now" heading.
- Contrast: an automated pass over every text node in the Dashboard in both themes at both sizes found nothing under
  4.5:1 except the disabled "Create and start setup" button (exempt).

## Suggested order of work

1. H1: Continue from the Dashboard opens the run and focuses the composer; extend `e2e/dashboard.mjs` to press it.
2. H2: drop a deleted project's runs from the store and guard the Dashboard sums; e2e: delete a project with an open
   run and compare the Cost figure with the remaining tiles.
3. M1 + M2: keep cut-while-waiting rows until acted on, and let the hero count them.
4. M4, L4: one announcement policy for the live region.
5. M3: paused-run copy now, the main-side marker as a contract step.
6. Lows: L1 one cost sum, L2 dot row, L3 edges, L5 focus, L6/L7 polish, L8 copy.

## Not driven

- Open folder (it opens Windows Explorer on the real desktop); `project-tile-error` therefore not seen.
- Resume now on a paused run (the paused run was ended by the relaunch before it was pressed).
- Reduced motion (`data-reduce-motion`), the "Show N more" caps, the project search past 6 projects, long names.
- Failed runs, setup-pending tiles, a connection in error or disconnected, LiteLLM spend, an API-key connection.
- Assistant runs (Chat, MCP, Skill) in Running now and their kind chips.
- The parked-draft round trip through App settings from the New project dialog.
- The 79257a4 build itself (identical renderer to e25f8bb; its package.json conflict markers would break npm scripts).
