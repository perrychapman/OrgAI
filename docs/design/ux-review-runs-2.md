# OrgAI UX review 2: reaching and viewing runs, after the run-tabs merge

Reviewer: UX Researcher. Build: dev HEAD `dc86f31` ("Merge UI Lead: run tabs, new-run page, run header, History tab, sidebar runs, cross-run message rows, run windows"), `npm run build`, driven with playwright-core against `out/` with `ORGAI_MOCK=1`, a fresh temp `ORGAI_DATA_DIR`, two fixture repos ("Alpha API", "Beta Web") created through the form with the Architect switch OFF and "Use the mock adapter" ticked, and a custom `ORGAI_MOCK_SCRIPT` (plan, spawn, a permission-gated Edit). No tokens were spent. Previous review: `ux-review-runs.md` (R1 to R14, navigation model, cross-run message design). Spec references: `spec.md` 2.1, 2.2, 2.5, 2.6.

Sizes: 1024x640 and 1600x1000 (`BrowserWindow.setSize`). Themes: dark, and light via `data-theme` on `<html>` (the app still has no theme switch). One keyboard-only pass at 1024x640. Shots are in `e2e/shots/ux/runs2/` (gitignored; the cited ones are force-added). Names are file stems.

Severity: **High** misleads or blocks a first-time user on the main path. **Medium** costs time or trust. **Low** polish.

## Headline

The navigation model landed well: a blank New run page, run tabs with R-labels, a global "Needs you" list that jumps to the decision, a History table, per-run drafts, and a clearly different receiver row for cross-run notes. Almost every R1 to R14 item is fixed.

One new defect undoes most of that on the main path. **Whenever a decision card is pending (a permission, a question, an Architect proposal), the Live view layout breaks** (N1): the tray is rendered outside the canvas frame, lands in an implicit third grid column, and squeezes the canvas to 47 px at 1024x640 (0 px with a proposal) and to about a third of the width at 1600x1000. A first-time user hits it at their first permission request and again on the first Architect proposal. It needs a fix before anything else in this review matters.

## Status of R1 to R14

| ID | Was | Now | Evidence |
| --- | --- | --- | --- |
| R1 | New run left the old run on screen | **Fixed.** Ctrl+T or "+" opens a blank New run page: no canvas, toolbar or transcript of another run, composer focused, "N other runs keep going" with links. Start creates the run and switches to its tab. Minor: the "+" button stays active next to the New run tab and does nothing (N9). | `20-ctrlt-newrun-1600-dark`, `22-newrun-while-run2-working-1600-dark`, `82-newrun-1024-light` |
| R2 | Finished run defaulted to Continue | **Fixed.** Finished run: "New run" first, "Continue this run" second, label "Continuing this run (from 3 min ago)" when chosen. A continued run keeps the old tab and shows "Continues R9: ..." as a link in its header. Header wraps to 3 rows at 1024 (N10). | `15-run1-ended-1024-dark`, `110-continued-run-1024-dark` |
| R3 | Could not find the run that needs me | **Fixed in function.** Sidebar "Needs you (n)" lists every waiting item across projects with project and run name; clicking jumps to the project, the run and focuses "Allow once". The topbar pill now says "Waiting for you". Every decision card is headed "Run R2: Fix the header layout". Caveats: the card it jumps to is inside the broken layout (N1), and with 5+ waiting items the list becomes a 140 px scroll box that pushes projects off the fold at 640 px (N6). | `25-jump-needs-you-alpha-1600-dark`, `31-6runs-1024-dark` |
| R4 | Run not named on screen | **Fixed.** Run header: R-index, status pill, full prompt, started and cost, plan and agents. The index repeats on tabs, sidebar, transcript header and decision cards. | `12-run1-needs-1600-dark`, `71-sender-after-message-1024-dark` |
| R5 | Restart opened an empty project | **Fixed.** After a restart the project opens on its newest run; sidebar subtitle "Last run 1 min ago, Finished"; History lists all ten runs. Runs that were live when the app quit now read "Finished" (N8). | `91-restart-alpha-1600-dark`, `92-restart-history-1024-dark` |
| R6 | 1024 strip scrolled, "New run" lost | **Partly.** The scroll strip is gone: overflow goes to a "+n" menu (amber when a hidden run needs you, with an alert icon per item) and "+" is fixed at the end. At 1024 only the viewed tab plus one more fit, and the visible set changes with selection (N5). The topbar clips "Saved 11:2..." under the tab group (N7). The menu opens over the run header (normal for a menu, no overlap with the canvas). | `31-6runs-1024-dark`, `32-overflow-menu-1024-dark`, `30-6runs-1600-dark` |
| R7 | Draft shared across runs and projects | **Fixed.** Drafts are per run and per project (typed in R11, R12 empty, Beta empty, R11 restored). A pencil marks a tab with an unsent draft. | `130-draft-marker-tab-1600-dark` |
| R8 | Chips were not tabs, no shortcuts | **Mostly fixed.** Real `tablist`, roving tabindex, arrows move focus, Enter opens, Ctrl+T new run, Ctrl+W hides a finished tab, Shift+F10 or right-click opens Hide / Open in new window. Still missing: Ctrl+Tab, Ctrl+1..9 (no effect), and any shortcut to the decision (25 Tab presses from the composer at 1024; N4). | `102-kb-tab-menu-1024-dark`, `101-kb-decision-1024-dark` |
| R9 | "Runs (n)" and three overlapping lists | **Fixed.** Open runs are tabs, history is the History table (Run, Status, Prompt, Kind, Started, Cost, actions), filter All / Work / Setup. The table also lists open runs, and the viewed one reads "Viewing" even while you are on History (N11). | `60-history-1600-dark`, `61-history-1024-dark`, `62-history-1024-light` |
| R10 | Stale "Thinking...", Idle/Working flaps unexplained | **Partly.** Ended runs now show "Stopped" on the node. Auto-continue shows as a dashed "Continuing: ..." row in the transcript but nothing on the run bar. An idle run's node still says "Waiting for you" while the header says "Idle" (N3). | `71-sender-after-message-1024-dark`, `73-sender-1600-dark` |
| R11 | Return from a notification | **Not verified.** OS notifications cannot be driven. | none |
| R12 | Chip anatomy resized while watching | **Fixed.** Tab = dot, R-index, prompt, one trailing icon (alert for needs you, link for unread notes, pencil for draft, x for finished). Status word is in the tooltip and aria-label. | `30-6runs-1600-dark` |
| R13 | List lived under an agent heading | **Fixed.** History is its own top-level tab. | `60-history-1600-dark` |
| R14 | Dismiss silently jumped | **Fixed, with a bug.** Ctrl+W on a finished tab shows "Hidden. Find it in History." The other notice, "A working run stays open. End its session first.", never goes away (N2b). | `75-after-hide-three-1600-dark`, `41-ctrlw-on-live-run-1600-dark` |

## New findings

### High

| ID | Flow / step | Shot | What happens vs what the user expects | Suggested fix |
| --- | --- | --- | --- | --- |
| N1 | Follow a live run: any decision card appears (permission, question, Architect proposal) | `12-run1-needs-1600-dark`, `13-run1-needs-1024-dark`, `13b-run1-needs-1024-light`, `83-beta-needs-1024-light`, `123-gamma-proposal-1024-dark`, `124-gamma-proposal-1600-dark` | The Live view breaks. The decision tray is a direct child of `.run-body` (DOM: `.run-body > section.frame-tray`) instead of the CanvasFrame slot that `layout.css` styles. `.run-body` has two columns (`1fr`, side panel), so the tray is auto-placed in an implicit third column. Measured: at 1024x640 the canvas is 47 px wide, the composer 47 px (the Send button floats over the legend), the side panel 280 px, the tray 449 px at the bottom right. With an Architect proposal the canvas is 0 px and the card's Approve buttons are below the fold of a 215 px tray. At 1600x1000 the canvas is 503 px, with black dead areas right and below. Light theme identical. The user expects the card beside or under a usable canvas. Because the Architect is the recommended path for a new project, this is the first thing a new user sees after "Create and start setup". Reported to the UI Lead and UI Engineer (both agents could not be resumed; relayed in the final report). | Render `FrameTray` inside `CanvasFrame` (its `tray` grid area) or give `.run-body > .frame-tray` explicit `grid-row` and `grid-column`. Re-check the 40vh cap at 640 px so a card with four buttons never needs inner scroll. |
| N2 | Run window: "Open in new window" on a run that needs you | `40-run-window-default-size` | A second window opens with the right run and title ("OrgAI · R2 · Fix the header layout"; the main window is retitled "OrgAI · R7 · ..."). But the new window never receives the pending decision: the header says "Working", the sidebar shows no "Needs you", the node says "Needs approval: Editing example.ts" and no card exists (0 cards after 3 s; the main window shows the same run as "Waiting for you" with the card). A user who moved a run to a second monitor to answer it cannot. Ctrl+W in the run window did not close it (good). It is also a full app window (all projects, all tabs) at 1280x840, not a single-run window. | Replay pending interactions to a new window at startup (with `listLive`), or show "Decision pending in the main window. Bring it here" instead of a silent "Working". Decide whether a run window should hide the other runs. |

### Medium

| ID | Flow / step | Shot | What happens vs what the user expects | Suggested fix |
| --- | --- | --- | --- | --- |
| N3 | Read an idle run | `73-sender-1600-dark` | Header and tab say "Idle" (blue), the orchestrator node says "Waiting for you" (the same words as the amber decision state). In the sidebar "Needs you" means a decision. A user will look for a card that is not there. | Node text for an idle run: "Idle, send it a reply". Reserve "Waiting for you" for a pending decision. |
| N4 | Keyboard: answer a decision | `101-kb-decision-1024-dark` | After Start, focus is in the composer. When a card appears focus stays there; reaching "Allow once" took 25 Tab presses (tabs, toolbar, canvas, composer, side panel, then the tray). After Enter on Allow once focus falls to `BODY`. Via the sidebar "Needs you" click focus does land on "Allow once", so the good behaviour exists for the mouse path only. After Enter on a sidebar project, focus also drops to `BODY` and 10 Tab presses reach the run tabs. | Move the tray before the side panel in DOM order or add a shortcut (for example Ctrl+Shift+D, or a "Jump to decision" link in the run header). After a card resolves, focus the next card or the composer. Return focus to the project row after selection, or to the first tab. |
| N5 | Switch runs at 1024 with 6+ runs | `31-6runs-1024-dark`, `32-overflow-menu-1024-dark` | Two tabs fit. Selecting a run from the "+n" menu swaps it into the strip and pushes another into the menu, so tab positions change under the user. A run that received a note shows its unread link icon only when it is a visible tab: the "+n" button and the menu items show needs-you but not unread (`72-overflow-menu-with-unread-1024-dark`), and the sidebar shows neither. | Show unread and draft markers on the "+n" button and on menu items. Keep tab order stable (menu holds the oldest, not the unselected). Raise the tab min-width cap so three tabs fit at 1024. |
| N6 | Sidebar with many waiting runs | `31-6runs-1024-dark`, `30-6runs-1600-dark`, `83-beta-needs-1024-light` | The global "Needs you" block grows with the list up to about 140 px and scrolls on its own; with five items at 640 px only one project row is visible below it, and two nested scroll areas appear in one narrow column. At 1600 only 3 of 7 items are visible. Counts are right ("Needs you (7)"), so the content is correct; the density is the issue. | Cap the block at 3 items with "+4 more" that opens the list on the Inbox/History view, or collapse it by default at heights under 700 px. The chevron already exists; default it closed when more than 3. |
| N7 | Topbar at 1024 | `61-history-1024-dark`, `71-sender-after-message-1024-dark` | The project path chip, the "Saved 11:2" save indicator and the status pill compete with the tab group; the indicator text is cut by the Live/History/Org chart/Settings tabs. The tab strip title "Settings" is labelled "Project settings" for assistive tech, which differs from the sidebar "Settings" (app settings). | Drop the path chip below 1100 px (tooltip on the name), keep the indicator whole. Name the project tab "Project settings" visibly or the sidebar one "App settings". |
| N8 | Restart: runs that were live | `92-restart-history-1024-dark` | R4 to R7 were waiting on a permission when the app closed; after restart they read "Finished" with Continue, no hint that they were cut off. A user checking last night's work cannot tell finished from interrupted. | Show "Stopped when the app closed" in History and the header (the `endedWithApp` note exists in `runStatus`). |
| N2b | Stale tab notice | `41-ctrlw-on-live-run-1600-dark`, `110-continued-run-1024-dark` | After Ctrl+W on a working run, "A working run stays open. End its session first." sits right of the tab strip for good: it was still there 9 s later, after switching to other tabs, after switching projects and after several minutes, so on a finished run it contradicts the page. Text is 11 px and right-aligned, easy to miss when it matters. | Clear it after 4 s or on the next navigation; render it as a toast in the run header. |

### Low

| ID | Flow / step | Shot | What happens vs what the user expects | Suggested fix |
| --- | --- | --- | --- | --- |
| N9 | Tab strip when only New run exists | `20-ctrlt-newrun-1600-dark`, `03-live-empty-1024-dark` | The New run tab has a "+" glyph inside it and a second "+" button beside it that does nothing. | Hide the button while a draft is the viewed tab, or let it focus the composer. |
| N10 | Continued run header | `110-continued-run-1024-dark`, `130-draft-marker-tab-1600-dark` | "Continues R9: ..." wraps the header to three rows (about 90 px), shrinking the canvas further at 640 px. | Put "Continues R9" in the tooltip of the "continued" pill or on the same row, truncated. |
| N11 | History while viewing | `60-history-1600-dark` | The viewed run's row reads "Viewing" and a purple left rule though you are on History, not that run. Open runs appear in both lists. Two purple "Continue" buttons per row compete with the primary action. | "Open" for all rows; mark open runs with their status only; make Continue secondary. |
| N12 | Topbar pill while on New run | `22-newrun-while-run2-working-1600-dark` | The pill says "Waiting for you" (project aggregate) while the New run page shows no run. Reads as a decision on this page. | Prefix with the count: "1 run needs you". |
| N13 | Raw JSON in the transcript for message_run | `71-sender-after-message-1024-dark`, `76-unread-badge-1600-dark` | Each cross-run message shows three things on the sender: the raw `message_run {"runId":"run_mvue...","message":...}` block, the clean "To run R8 (...) Delivered" row, then the raw tool result. The user reads the same note twice and sees an opaque id. | Collapse the raw tool call and result of `message_run` and `list_runs` under the clean row. |

## Specific checks from the brief

1. **"+" / Ctrl+T.** Blank New run page, nothing of the old run, composer focused, Start creates the run and its tab (~250 ms). Second Ctrl+T is a no-op. See R1.
2. **Finished run.** Defaults to New run, Continue second. See R2.
3. **Run tabs.**
   - Labels R1, R2 in tabs, sidebar, header, transcript and cards; distinct headers per run; needs-you shows as an amber tab with an alert icon; the "+n" menu works with 7 runs at both sizes.
   - Ctrl+W: finished tab hides with "Hidden. Find it in History."; working run shows a notice; it never closed a window. The run-view handler swallows it (no app menu on Windows anyway).
   - Right-click and Shift+F10 open "Hide / Open in new window". "Open in new window" opened a second window titled "OrgAI · R2 · Fix the header layout" on the right run, but without its pending decision (N2).
4. **Sidebar.** Project rows expand to their open runs, needs-you first, and the global "Needs you (n)" entry jumped from Beta to Alpha's R2 with focus on "Allow once". Density: N6.
5. **History.** Table, All/Work/Setup filter, Open, Continue, Retrospective all work; Continue from History lands in Continue mode with the composer focused. After a restart the project opens on its newest run.
6. **Decision cards name the run** ("Run R2: Fix the header layout", also for setup: "Run R1: Set up this new project..."). Fixed. The tray itself is broken (N1).
7. **Cross-run messages.** Drivable: the mock script's `harness` step calls `list_runs` and `message_run` by name, and the script file is read per run, so I started a receiver (R8, idle), rewrote the script with its run id, then started the sender (R9). Messaging was enabled in Project settings ("Let runs message each other", off by default, text says what it does). Results:
   - Sender: dashed system row "To run R8 (Alpha API: Update the docs folder) Delivered 11:27:47 PM" plus the text; not an assistant bubble. Plus raw JSON (N13).
   - Receiver: tinted block with a blue left rule, "Note from run R9 (Alpha API: Rewrite README for the API)", timestamp, body. It cannot be mistaken for the user's own message (the user rows are purple with "You"). The row has no link to R9 (the R9 label is plain text; the design asked for "Open run R9").
   - Unread: a small link icon appears on the receiver's tab (title "2 unread notes from other runs", aria-label has the count); no number, and none on the "+n" menu or in the sidebar (N5). It clears when the tab is opened.
   - Not exercised: messaging off (refusal text), the cap, a queued message to a run that waits on a card, and the canvas stub (not built).
7b. **Visual risks the UI Lead flagged.** Decision tray height at 640 px: broken (N1). Sidebar with six waiting runs: crowded (N6). "+n" menu: opens over the run header only while open, no overlap with the canvas (`32-overflow-menu-1024-dark`). Header wrap for a continued run: three rows (N10). Proposal cards in the tray: unusable at 1024 (N1, `123-gamma-proposal-1024-dark`).

## What works and should survive

- The New run page with the other-runs links and the per-run draft pencil.
- The R-index on tab, sidebar, header, card and transcript: you always know which run you answer.
- "Needs you (n)" with project, run and card summary, and the jump landing on the primary button.
- History as a table with Open / Continue / Retrospective.
- The receiver row for cross-run notes (distinct tint, names the sender, does not look like "You").
- Ctrl+W never closing the window; a clear "A working run stays open" rule (once N2b is fixed).

## Verdict (ten lines)

1. "A new run opens like a new window": **yes on the page itself** (blank New run page, Ctrl+T, focused composer, other runs keep going), and Start puts you on the new tab in about a quarter of a second.
2. The literal "Open in new window" works but gives a full second app window that is blind to pending decisions (N2).
3. "Runs are easy to get to and view": **mostly yes**. One click from the tab strip, the sidebar rows or the global Needs-you list; labels R1..Rn are consistent everywhere.
4. At 1024x640 with 6+ runs it is tolerable but cramped: two tabs, unstable "+n", a sidebar eaten by the Needs-you block (N5, N6).
5. It is not usable at the moment that matters: any pending decision collapses the canvas (N1, High). A first-time user hits it at the first permission and the first Architect proposal.
6. Keyboard-only: tabs, arrows, Ctrl+T, Ctrl+W and the context menu work; answering a decision takes 25 Tab presses and focus is lost afterwards (N4).
7. "Follow runs talking to each other": **yes, with gaps**. The sender row and the tinted receiver row are clear and never read as the user; the unread link icon helps only when the tab is visible and has no count.
8. Missing for message traffic: a link from the note to the sender run, an unread cue in the overflow menu and sidebar, and collapsing the raw `message_run` JSON.
9. Fix order: N1 (layout), N2 (run window decisions), N4 (focus), N3 and N2b (wording and the stale notice), then N5 to N8.
10. Re-walk after N1 lands; several findings above (the continued-run header, N6) get worse or better once the canvas has its width back.

## Reproduction

```sh
npm run build
node e2e/shots/ux/_t/mkrepo.mjs <tmp>/repos                  # two git fixture repos
APP=$PWD DD=<tmp>/dd SCRIPT=$PWD/e2e/shots/ux/_t/script.json node e2e/shots/ux/_t/drv.mjs &   # launches out/ with ORGAI_MOCK=1
node e2e/shots/ux/_t/q.mjs <snippet.js>                      # runs a snippet inside the driver (page, app, ss, size, theme)
```

Projects were created through the form (Existing repository, Architect switch off, mock adapter ticked). The driver and snippets are throwaway and gitignored.
