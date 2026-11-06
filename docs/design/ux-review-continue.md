# UX review: continuing an ended run (walk 1)

Walked 2026-11-02 on a2db367 (`npm run build`), ORGAI_MOCK=1, fresh temp ORGAI_DATA_DIR per walk, playwright-core
through `e2e/lib.mjs` helpers. Sizes 1024x640 and 1600x1000, dark and light, plus a keyboard pass. Two walks:

- Walk A (shots 01-22): finish R1 with End session, Continue it (R2), start R3, close the window while R3 works and
  R2 is idle (graceful quit, `app.close()`), relaunch, continue R3, keyboard-continue R2.
- Walk B (shots 31-41): finish R1, start R2, kill the Electron process while R2 works (crash path, the only path
  that sets `endedWithApp`), relaunch, continue R2.

Screenshots (local only, gitignored): `e2e/shots/continue/NN-*.png`; raw DOM notes `notes-walk1.json`, `notes.json`.
Scratch scripts there too (`walk.mjs`, `crash.mjs`). No smoke script, no token spend.

Goal under test: open OrgAI, click a run that ended (normal finish, or cut when the app closed), type in its composer,
and have the AI pick up IN THE SAME FEED with its memory.

## Verdict

Not met. Continuation works mechanically (memory is resumed, "Continues R1" links both ways), but every visible cue
says "new thing": the default on an ended run is New run, Continue makes a new tab with a fresh feed and a reset
canvas, focus is lost, and after a normal quit the cut run is indistinguishable from one the user ended. The data
model (session chains in `lib/runChains.ts`) already has what a one-conversation view needs; the gap is presentation
plus one main-process bug (H3).

## Earlier findings re-walked

| Id | Source | Then | Now | Evidence |
| --- | --- | --- | --- | --- |
| R2 | ux-review-runs-2 | Finished run defaulted to Continue; fixed to New run first | Still New run first (by design, spec.md "Finished run"). Now the opposite of this goal: see H2 | 02, 32, 10 |
| N8 | ux-review-runs-2 | Runs cut by restart read "Finished" | Partly. After a crash History says "Ended when OrgAI closed" (36); the tab, sidebar and composer still say Finished (35, 37). After a normal window close the run reads "Stopped", same as End session (16) | 16, 35, 36, 37 |
| N10 | ux-review-runs-2 | "Continues R9: ..." wrapped the header to 3 rows | Fixed. It is one item in the 32 px run-meta row at 1024 (40) | 05, 40 |
| N11 | ux-review-runs-2 | History "Viewing" while on History; Continue competed with Open | Partly. Continue is now outline-secondary; "Viewing" badge still shows on the History tab | 07, 16 |

## New findings

### High

**H1. A continuation is a new tab with a fresh feed and a reset canvas.**
Flow: finished R1 > "Continue this run" > type > Continue. 1600 dark (04, 05), 1600 light (39), 1024 light (40).
What a user expects: the message lands under the earlier conversation, in the same tab.
What happens: a new tab R2 opens and takes over; R1 stays as its own tab. R2's feed starts with
"Continued from run run_mvzp3cmgt2ihuqc4", then only the new message; none of R1's turns are visible. The canvas
restarts at 1 agent; R1's Implementer is gone until the mock re-spawns one. After four continues the strip held
R2..R5 (21), one tab per message the user chose to continue.
Owner: `views/LiveRunView.tsx`, `components/RunTabs.tsx`, `components/TranscriptPanel.tsx`,
`store/useAppStore.ts` (`showContinuation`, `showRunPatch`), `lib/runChains.ts`.
Fix (checkable): continuing from a chain's newest run keeps the same tab selected; the feed shows every chain member's
entries oldest first with one divider row per member; the strip shows one tab per chain (model below).

**H2. Typing into an ended run's composer starts an unrelated fresh run by default.**
Flow: open any ended run, type, press Enter. 1600 dark (02), 1024 dark (32), 1024 light after relaunch (10, 12).
Expects: "pick up where it left off". Happens: mode label "New run", placeholder "Describe the task", primary
"Start". Enter starts a new run with no memory in a new tab. Continue is the second segment of "What Send does",
and only on the chain's newest member.
Owner: `views/LiveRunView.tsx` (`sendMode`, `finishedChoice`); spec.md "Finished run" and the session-chain rules
say the opposite, and `e2e/runs.mjs` (around line 211) asserts it, so this needs the user's call and a same-change
e2e update.
Fix: on a continuable run (`canContinue`) the default is Continue, primary "Send", placeholder "Message the
orchestrator"; New run lives on the "+" tab (and Ctrl+T), not in the composer of an ended run. Check: `.composer`
reads Continue mode on 02's state without any click.

**H3. A normal quit records cut runs as "Stopped" by the user; "Ended when OrgAI closed" only appears after a crash.**
Flow: close the window while R3 is working and R2 idle; relaunch. 1024 light (11, 12, 16).
Expects: both runs marked as cut by the app closing. Happens: History, tab and node read "Stopped", identical to a
run the user ended with End session; the composer gives no hint. Only killing the process (walk B) produced the
"Ended when OrgAI closed" badge (36). Cause: `RunManager.stopAll` sets `userStopped = true` on every run and stops it
cleanly, so the record is saved finished; `store/runs.ts` sets `endedWithApp` only for records still live at boot.
`index.ts` `before-quit` also calls `void runManager?.stopAll()` without waiting, so which outcome a user gets is a
race.
Owner: `src/main/runtime/runManager.ts` (`stopAll`), `src/main/index.ts` (before-quit), `src/main/store/runs.ts`.
Fix: `stopAll({ appQuit: true })` marks open runs `endedWithApp` (not user-stopped) and quit waits for the flush with
a short deadline. Check: walk A's R3 and R2 read "Ended when OrgAI closed" after relaunch.

**H4. Even when the run is known to be cut, the run view hides it and shows it as still thinking.**
Flow: walk B relaunch > project opens on R2. 1600 light (35, 37, 38).
Expects: a clear "OrgAI closed while this run was working" with Continue ready. Happens: tab aria "Finished",
sidebar "Last run just now - Finished", composer "New run". The root node still says "Thinking..." and the panel
header says "thinking" on a dead run. The cut is only stated after the user picks Continue ("Continuing this run (it
ended when OrgAI closed)", placeholder "Pick up where it was cut off", 38).
Owner: `components/RunTabs.tsx` and `components/Sidebar.tsx` (use `statusOfRun` / `statusText` like RunHistory), the
record load in `src/main/store/runs.ts` or the renderer's record hydration (settle agents with `activity.ts`
`settleAgent` when `endedWithApp`).
Fix: tab, sidebar subtitle and composer notice all say "Ended when OrgAI closed"; no agent on an ended run shows
Thinking. Check: 37 shows no "Thinking..." and the composer notice is present before any click.

### Medium

**M1. Status words change across a restart and with whether the record is loaded.**
R1 ended by the user reads "Stopped" before quit (07) and "Finished" in History after relaunch (16, 41). Walk A's R2
reads "Finished" in History until it is opened, then "Stopped" (11 vs 16). Cause: `isStoppedRun` reads the root
agent's activity, which History rows only have once the record is loaded.
Owner: `lib/runStatus.ts`, `RunSummary` in `src/shared/types.ts` (persist a stop reason: user | app | self).
Fix: the status word comes from the summary alone. Check: History before and after opening a run shows the same word.

**M2. Relaunch restores one tab only, and not necessarily the conversation the user was in.**
Walk A: before quit the strip had R1, R2 (idle, the conversation in use) and R3; after relaunch only R3 (10). To reach
R2 the user goes to History. 1024 light.
Owner: `store/useAppStore.ts` (`settleWorkspace`, `defaultRunToOpen`, `dismissedRuns`).
Fix: remember the open tabs per project and restore them (one per chain once H1 lands), selecting the last viewed.

**M3. Focus is lost after Continue and after End session.**
Keyboard pass, 1024 dark (20-22). History Continue lands in the composer textarea (good, 20). After Enter the new
run's tab takes over and focus goes to BODY (`kbd-after-send`); the next reply needs 14 Tab stops from the run tab
(run tab > + > Org retrospective > Continues link > Hide finished > 4 zoom buttons > layout > 2 nodes > attach >
textarea). Same after End session (22).
Owner: `views/LiveRunView.tsx` / `Composer` (`focusToken`), `showContinuation` in `store/useAppStore.ts`.
Fix: after a send that switches runs, bump `composerFocusToken`; after End session, keep focus in the composer.

**M4. The continuation row shows a raw run id.**
"Continued from run run_mvzp3cmgt2ihuqc4" (05, 39), written by the adapters (`mock.ts:683`, `claude.ts:2362`,
`codex.ts:549`; Adapter Engineer). Fix: render the harness row in the renderer from `summary.resumedFrom` as a divider
"Continued <time>. Earlier: R1 <title>" (a link), or drop it once the merged feed has its own divider.

**M5. History lists chain members as unrelated rows; which row continues the conversation is unclear.**
1024 light (16), 1600 light (18), 1024 dark (17). Rows are newest first, so two chains interleave (R4, R3, R2, R1:
R4 continues R3, R2 continues R1). Each member has Open and Retrospective; Continue appears on the newest member of
every ended chain, so after walk B History shows two Continue buttons for two different conversations (36). Cost is
per member, never per conversation; a cut member shows "-" for cost (16).
Owner: `components/RunHistory.tsx`, `lib/runChains.ts`.
Fix: one row per chain (model below). Check: a two-member chain renders as one row with "2 sessions".

**M6. At 1024x640 the feed the user wants to continue is not on screen.**
The side panel auto-collapses below 1100 px, so a work run shows only the canvas and composer (10, 32, 40). The
conversation layout exists (`run-layout-toggle`) but is off for work runs.
Owner: `views/LiveRunView.tsx` (`runLayoutFor`), `lib/assistants.ts`.
Fix: on an ended, continuable run under 1100 px, open in the conversation layout or expand the panel to Transcript.

### Low

- **L1.** On an older member the mode label says "New run: 1 other run keeps going", and the "other run" is its own
  continuation; the notice "This run was continued by a later run. Open it" sits under it and the segmented control
  silently disappears (06). Say "This conversation continues in R2" with one "Go to latest" button.
- **L2.** "Continuing this run (from just now)" (03, 33): "from just now" is the run's start time, which reads like
  "starting now". Use the last activity time: "Continuing. Last reply 3 min ago".
- **L3.** Org retrospective is offered on every chain member, including a cut one with one prompt (16): offer it once
  per chain, on the whole conversation.
- **L4.** Every ended tab keeps its x and Continue adds a tab each time (21: R2..R5). Goes away with H1.
- **L5.** The mock title drops "/" ("Add a GET notescount", every shot); not this feature, noted for the titles owner.

## Click counts (mouse; typing excluded)

| Scenario | Today | With the model below |
| --- | --- | --- |
| Continue a run that just finished, same session | 2 (Continue segment, Continue) | 1 (Send / Enter) |
| After a graceful relaunch, continue the conversation that was open (walk A R2) | 4 (project, History, Continue, Continue) | 2 (project, Send) |
| After a crash relaunch, continue the cut run (walk B R2) | 3 (project, Continue segment, Continue) | 2 (project, Send) |
| Find the earlier turns after continuing | 1 (Continues R1 link) and the feed is replaced | 0 (same feed, scroll up) |
| Keyboard: from History to the reply after a continue | Tab 10, Enter, type, Enter, then 14 Tabs to reply again | Tab to the chain row, Enter, type, Enter; focus stays |

## Proposed interaction model: one conversation per session chain

1. **One tab per chain.** The run strip shows a chain as one tab named by its first member's title, status from its
   newest member. Opening any member (History, link, run window) selects the chain tab scrolled to that member.
   Continuing keeps the tab; the newest member's id becomes the tab's run for sends, interrupt and End session.
2. **One merged feed.** The transcript (and the conversation layout) lists every member's entries oldest first. Where a
   member starts there is one quiet divider row, centred, muted, no icon: "Continued 3 min later" or
   "Continued after OrgAI closed" (time in the title). The harness "Continued from run <id>" row is hidden in favour
   of it (M4). Per-member Usage stays reachable through a "This session / Whole conversation" switch in the Usage tab.
3. **Continue is the default on a continuable run.** On the chain's newest ended member the composer reads like a
   live run: mode "Replying to Orchestrator" with a second line naming the gap, primary "Send", placeholder
   "Message the orchestrator". No segmented control; New run is the "+" tab and Ctrl+T. Older members never show a
   composer of their own (the chain tab always targets the newest).
4. **Canvas.** Show the newest member's agents live. Earlier members' agents fold into one dashed "Earlier: N agents"
   group per member (the existing finished-group node, `Hide finished` keeps working), placed above the root, so the
   tree reads top to bottom in time; expanding it shows those nodes in their final state, never Thinking. The root
   agent is one node across the chain (same session), its token and cost totals summed.
5. **History.** One row per chain: title, "N sessions" chip, status of the newest member, total cost (lower bound when
   partly priced), last activity time, actions Open and (when continuable) Continue; Retrospective once per chain. A
   disclosure on the row lists the members (time, prompt, cost) for anyone who wants them. Filters and Trends count
   chains for "conversations", members for cost.
6. **Ended composer copy.** Normal finish (user ended or the run went idle and the session closed):
   mode "Session ended 12 min ago. Send to continue with its memory."; placeholder "Message the orchestrator".
   Ended when OrgAI closed: a notice row above the field, role=status, tone warning:
   "OrgAI closed while this run was working. Send to pick up where it stopped." (or "...while this run was waiting for
   you." when it was idle); placeholder "Pick up where it was cut off". Failed: "This run failed: <reason>. Send to
   try again with its memory." Paused with autoResume: unchanged pause banner. A chain that cannot be continued (no
   session id): composer offers New run only, with "This run cannot be continued (no saved session)."
7. **Focus.** Sending keeps focus in the composer even when the chain's run id changes; End session leaves focus on
   the composer; History Continue keeps landing in the textarea (already true).

## Suggested order of work

1. H3 (main: quit marks cut runs; await the flush) and M1 (persisted stop reason). Small, unblock honest labels.
2. H4 and M4 in the renderer: status words from the summary everywhere, settle stale agents, notice copy (model 6).
3. M3 focus fixes (two lines, independent).
4. User decision on H2 (spec.md and e2e/runs.mjs change with it), then the composer copy of model 3 and 6.
5. H1: chain tab, merged feed with dividers, canvas folding (model 1, 2, 4); then M2 tab restore per chain.
6. M5 History per chain, L1-L4 fall out of 5. M6 conversation layout for narrow ended runs.
7. Re-walk: walks A and B above, both sizes and themes, plus the keyboard pass.
