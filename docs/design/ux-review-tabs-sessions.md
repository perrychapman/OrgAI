# UX review: run tabs and sessions are independent

Reviewer: UX Researcher. Build: `c815969f` (branch worktree-agent-a92ed017fcd2ee5b0, `npm run build` clean).
How it ran: built app, `ORGAI_MOCK=1`, fresh temp data dir per script (throwaway fixture repo), driven with playwright scripts on `e2e/lib.mjs`. Sizes 1600x1000 and 1024x640 (`setContentSize`), dark and light (`data-theme`), one keyboard-only pass at 1024x640. No tokens spent.
Compared with: the change brief (tabs hide any time, ended tabs stay, End session optional, idle-at-close wording). Earlier note: `ux-review-continue.md` M2 (tabs survive relaunch).
Shots and walk scripts: `e2e/shots/ux/tabs-sessions/` (gitignored; scripts `w1`-`w11.mjs`).

## Verdict: WORKS, with copy and priority problems

The core promise holds. I hid tabs of working, idle, waiting and ended runs; every one kept going, stayed findable (sidebar, History, dashboard) and came back with one click. Ended tabs stayed after relaunch for projects and Chat, and a message continued the same tab. I never needed End session. The remaining problems are wording that says the wrong thing for idle and ended runs, a calm "keeps going" message on a run that needs you, and overflow ordering that buries live waiting runs behind ended ones.

## What worked

- Hide notice appears at the strip's trailing edge, is a polite `status` region and disappears within about 8 s (`02-hidden-while-working`, `51-light-1600-hidden-notice`).
- The New run page names the survivor: "1 other run keeps going" with a link to it (`02`).
- A hidden run that reaches a decision surfaces three ways without opening anything: sidebar "Needs you · 1", an orange dot and count on the project row, and the dashboard "Needs you" card with inline **Allow once / Deny** (`03-hidden-poll-3`, `06-dashboard-needs-you`). Zero clicks to approve from the dashboard; one click (sidebar run row) to reach the full card (`07-reopened-card`); in the 1024 rail the bell shows a count (`30-five-live-1024`).
- History lists hidden runs with their status and an Open button (`44-history`).
- Chat: tab stays idle, survives leave-and-return and relaunch, a new message continues it ("2 sessions" appears in the tab name) (`21`-`24`).
- Dashboard after relaunch: a run that was waiting on a decision says "Was waiting on you when OrgAI closed." with a **Continue** button and the day line "waited on you 23s"; the idle one carried no such line and the header read "Nothing is running. Nothing needs you." (`12-relaunch-dashboard`, `55-light-dashboard-relaunch`).
- Keyboard: arrows, Home, End move between tabs; Delete hides the focused tab and focus lands on a neighbouring tab; Ctrl+W hides the active one; Shift+F10 and the ContextMenu key open "Hide / Open in new window" with focus on the first item, Esc returns focus to the tab; native menu File > Close tab (CmdOrCtrl+W) exists (`45-kbd-ctx-menu`). Ended and live ones behave the same.

## Findings

### Medium

**M1. An idle run that OrgAI cut reads "Ended when OrgAI closed" everywhere except one line.** Repro: start a run, Allow once, wait for Idle, quit and relaunch (`w4.mjs`). The tab label, sidebar row, canvas node ("Ended when OrgAI closed"), project tile and dashboard "Recently ended" all say "Ended when OrgAI closed"; only the composer notice says "OrgAI closed while this run was idle." (`13-relaunch-project`, `12-relaunch-dashboard`). A first-time user reads "ended" as lost work, while the notice (in a warning tint) says it can be picked up. Recommend: for `endedWhile: 'idle'`, status "Paused when OrgAI closed" (waiting: "Was waiting on you when OrgAI closed", working: "Cut off when OrgAI closed"), and a neutral tint for the idle notice.

**M2. "1 other run keeps going" and the hide notice say nothing about a run that needs you.** Repro: start a run, hide its tab, wait ~15 s. The sidebar turns to "Needs you · 1" but the New run page still reads "1 other run keeps going" with a plain link (`03-hidden-poll-3`). The user's current screen is the one they are looking at. Recommend: `1 other run needs you: R1 Add a delete endpoint` (link in the warning colour), and "N other runs keep going, 1 needs you".

**M3. Overflow buries live waiting runs behind ended ones.** Repro at 1024x640: five runs, relaunch (all Ended), start four more. The strip shows R1, R2 (ended) and the viewed R9; R3-R8, including three live runs waiting on a decision, sit in "+6" (`32-mixed-1024`, `33-more-menu-1024`). The chip's amber tint and its label "6 more runs, 3 waiting for you" are right, but nothing visible says which, and in the menu a waiting run is only a small circled "!" at the row end. Ended tabs now pile up (cap 20) and keep the best slots. Recommend: when overflowing, fill visible slots with viewed, then waiting, then live, then ended; or sort ended last. In the menu, add the words "Needs you" on those rows and a "Hide ended" row.

**M4. A decision card arriving steals focus from the tab strip.** Repro (keyboard): focus a tab, wait for the viewed run's card; focus jumps to **Allow once** (`w9.mjs`: tab focus held for 7 polls, then `Allow once`). The same happened in my Shift+F10 attempt on a tab, which then opened nothing because focus was already on the card (`w7.mjs`). Likely intended for the viewed run, but a user arrowing through tabs loses their place with no announcement. Recommend: move focus only if focus is in the transcript or composer; otherwise announce "Permission needed in R3" in the live region and leave focus.

### Low

**L1. Hide notice claims "keeps working" for an idle run.** Repro: hide an idle tab: "Hidden. It keeps working: find it in the sidebar or History." (`60-idle-hidden`). The tab's tooltip also says "The session keeps working." Idle is waiting for the user. Recommend by state: working "Hidden. It keeps working: find it in the sidebar or History." Idle "Hidden. It stays open: find it in the sidebar or History." Waiting "Hidden. It is waiting for you: find it in the sidebar." (ended already says "Hidden. Find it in History.", good.) Same for "1 other run keeps going" on an idle run (`60`): "1 other run is open".

**L2. Hide notice is small and sits beside the action buttons.** At 1600 it is a 12 px grey line between the tab and "Interrupt turn" (`51`); at 1024 it may be crowded out (not seen clipped, but the strip is full). It is also gone in about 8 s. Consider an inline "Show it" link.

**L3. "More runs" menu stays open across a window resize and shows stale content.** Repro: open "+6" at 1024, resize to 1600: the popover remained, listing R5-R8 under a new strip (`34-mixed-1600`). Close on resize.

**L4. Tab titles truncate hard.** "Task nine perf not", "What does this project" (tab name for "What does this project do?"), "Task five update READ" (`30`). Acceptable; the full title is in the tooltip and aria-label. A trailing ellipsis would signal truncation.

**L5. Ended composer line truncates at 1024.** "Enter to send · Shift+Enter for a new line · paste or..." (`53-light-1024-ended`). Drop the paste hint when width is short.

**L6. Permission card copy still ties to End session.** "Allow for session: auto-accepts file edits until you end this session." Sessions now end on their own or never; "for the rest of this session" would read better. "Always allow for project: the same as Allow for session; nothing is saved for later runs." is confusing on its own (pre-existing).

## Answers to the brief's questions

1. Hide while working or idle: clear that the run continues for working (notice, link, sidebar); idle copy is off (L1). Findable by sidebar, History, dashboard; reopen is one click.
2. Hidden run reaching a decision: sidebar "Needs you", orange dot, rail bell, dashboard card. Clicks to the card: 1 from the sidebar, 0 to answer from the dashboard. The New run page does not say it (M2).
3. Ended tab stays; follow-up continues in the same tab (`08`-`10`, `24`). Nothing forced or nudged me to End session. Only the tooltip "Optional. Ends the session..." and the permission copy in L6 mention it.
4. Chat: tab present after leaving and after relaunch, message continues it (`21`-`24`).
5. Many tabs: hide and find stay workable (menu, History, sidebar), but the strip fills with ended tabs and live waiting ones hide behind them (M3).
6. Dashboard after relaunch: idle run no longer counted as waiting; waiting run reads "Was waiting on you when OrgAI closed." with Continue. Idle status words remain "Ended" (M1).
7. Keyboard: see "What worked" and M4. Hide button (x) is not in the Tab order; Delete, Ctrl+W and the menu are the keyboard paths. Focus rings were visible in both themes (`51`).

## Not driven

- A session that ends by itself (turn limit, usage limit, plan end): the mock only idles; I used a relaunch to get ended tabs, so "ended while open, tab stays without a relaunch" was not seen.
- A dashboard "since you looked" line was not separately exercised; I saw "Recently ended" and the day line only.
- A question card (ask_user) on a hidden run; I used the mock permission card.
- Live providers, real timing, screen-reader speech (the status region exists, announcement not heard).
- Native File > Close tab click (I confirmed the menu item and accelerator exist, not the click).
- Setup/MCP/Skill assistant tabs, and more than nine tabs (the 20-tab cap).
- The Windows window height after relaunch shrank to the default; sizes were re-set by script each time.
