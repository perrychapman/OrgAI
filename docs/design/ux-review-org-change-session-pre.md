# UX review: changing the org chart as a leave-and-return session (pre-feature)

Reviewer: UX Researcher. Build: `0f7f1bed` (dev line, version 0.1.7-dev1), built in this worktree with electron-vite.
How it ran: `ORGAI_MOCK=1`, fresh temp data dir per script, Windows. 1024x640 (sidebar is the 56 px rail) and 1600x1000, dark and light (set through `data-theme`; each flow was walked in at least one theme per size, see the shot names). Mouse first, then a keyboard-only pass at 1024x640 light. Walk scripts and shots are in `e2e/shots/ux/org-change-session/` (gitignored, `walk1.mjs` to `walk7.mjs`); shot names below are relative to that folder and prefixed `<width>-<theme>-`.
Compared with: the user's complaint of 2026-11-07 ("make changes to the org chart, leave that session and come back to it later, without going through the project's settings; it should open as a new run in the nav sidebar we can navigate to") and the code notes in CLAUDE.md (team-surface runs, `lib/runSurface.ts`).

## Verdict: NOT MET

The complaint is accurate. The Team tab's "Revise with the Architect" session is the one the user reaches without Settings, and it is the one that cannot be left: it has no sidebar row, no run tab, no History row, no Dashboard count, and nothing at all after a relaunch. The two routes that do behave like a run (Maintenance's Architect review and Org retrospective) are the right shape but are buried (Settings > Maintenance, or a finished work run), and Maintenance's button exists only after an architecture document exists. The surprising part is that the hidden session still leaks into three places, inconsistently (the Live "New run" page, the sidebar's Needs-you popover and the Dashboard's Needs-you list), so the product both hides the session and points at it.

## Comparison of the three routes

| | Team tab "Revise with the Architect" | Settings > Maintenance "Review with the Architect" | Run strip "Org retrospective" |
| --- | --- | --- | --- |
| Run summary | `kind: setup`, `surface: team` | `kind: setup` | `kind: setup` |
| Run tab on Live | No | Yes ("R1 Review .orgai/ARCHITECTURE.md against t…") | Yes ("R2 Retrospective on the run…") |
| Sidebar row under the project | No (project says "1 decision · 0 runs") | Yes, with status ("Needs you") and "1 decision · 1 run" | Yes |
| History row | No ("No runs yet" while the session waits) | Yes, kind Setup, Open / Open in Live | Yes |
| Dashboard Running now | "Nothing is running." while it waits on a card | Listed, "1 Needs you" | Listed |
| Needs-you (bell, Dashboard) | Yes, as "R?: Revise this project's org chart and set…" | Yes, "R1" | Yes, "R2" |
| Where the card and composer live | Team tab tray only | Live view: stage + tray + composer ("Answering the Architect") | Same |
| After a relaunch | Gone: no trace, Design tray shows the empty form | Run tab restored, "Ended when OrgAI closed", composer continues | Same pattern (R2 row in History) |
| Return path without the Team tab | None (except leaks H2, M1) | Sidebar row, run tab, History | Sidebar row, run tab, History |

## Findings

### H1 (High). The Team-tab session cannot be left and found again

Screen: Team > Design tray, then Live, History, Dashboard, another view, relaunch. Shots: `1600-dark-03-session-running`, `05-live`, `06-dashboard`, `1600-light-r1-before-relaunch`, `r2-relaunch-landing`, `r5-design-after-relaunch`.
Steps:
1. Create a mock code project (existing folder, skip setup). Open Team, click the Design tab, type "Add a database specialist under the orchestrator.", click "Revise with the Architect".
2. A permission card appears in the tray ("Run git status --short"). Click Live, then Dashboard.
Observed:
- Live shows an empty "New run" page. No run tab, no sign of the session apart from the leak in M1.
- The sidebar project row reads "1 decision · 0 runs". The Dashboard hero says "1 needs you", the Needs-you card shows "Allow: Run git status --short", and Running now says "Nothing is running." while an agent is working or waiting. History says "No runs yet. Give the team a goal on the Live tab".
- Coming back to Team shows the tray on the Recommend mode, not Design (`data-mode=recommend`, shot `13-team-back` from `walk2`): the session is hidden until the user clicks Design. Only the "Needs you · 1" pill in the topbar hints at it.
- Quit and relaunch with the card open (`r2`): the session is gone. The run record exists (`kind setup, surface team, finished, endedBy app`) but nothing in the app lists it. The Dashboard says "All quiet. Nothing needs you." and the project tile says "Setup pending". Design shows the empty form; the "The Architect session ended" line is not shown for a session that is not in the store. The proposal the user was reviewing is lost without a word.
User impact: the user cannot "leave that session and come back later". Changing the org chart is a multi-step conversation (permission cards, architecture proposal, org chart proposal, requests for changes) and it is tied to one tab in one project.
Fix: make it an ordinary run in the sidebar (see the last section).

### H2 (High). The hidden session's attention state contradicts the rest of the UI

Same flow. The same run counts for Needs-you (bell, Dashboard card, project badge "1") but for nothing else: project subtitle "1 decision · 0 runs", Running now empty, hero "1 needs you" with no running runs, History empty. After you answer every card the run stays `idle` (still live) while nothing in the app says so; the tray text then reads "The Architect session ended" (shot `1024-dark-e-final`, below the fold at 1024x640) even though the run summary status is `idle`, not ended. A user cannot tell a finished change from one still open, and there is no way to End it other than starting another one.
Fix: derive the same live/idle/ended facts everywhere from the run (as the other setup runs do) and let the user end it from where it is shown.

### M1 (Medium). The session leaks into Live's New run page, as "R?", and opens in a half-state

Shots: `1600-dark-05-live`, `1600-dark-11-after-other-link` (from `walk2`), `1024-light-k2-live`.
Steps: with the Team session open, go to Live. The New run composer says "New run: 1 other run keeps going" and the page lists "R?: Revise this project's org chart and set…" as a link (`NewRunPage.tsx` does not filter team-surface runs, unlike Sidebar, History and Dashboard). Click it.
Observed: the session opens in the Live view (stage with the Architect node, "Approve / Request changes" card, "Answering the Architect" composer, Interrupt turn, End session, `R?` label in the panel) but the strip still shows a single "New run" tab selected and no tab for the session. Approving there works. Navigate away and the way back is again only this link.
Impact: it proves the session can live on the Live view, and it is the only route back that does not use the Team tab, but it is accidental: "R?" is a broken run label (the run has no tab number), the tab strip lies, and a user who finds it cannot tell why the session is here and not in the sidebar.
Fix: filter or label it in one place only; with the sidebar row the link should go away.

### M2 (Medium). Maintenance's Architect review is hidden behind a document and is not the same kind of session

Shots: `1600-light-m1-maintenance` (no button before an architecture exists), `m2-after-review-click`, `m4-back-in-project`, `m5-history`, `m6-relaunch`, `m7-relaunch-project`.
- "Review with the Architect" appears only when `project.setup.architecturePath` is set. On a mock project made without setup the Maintenance pane has no review button at all (the pane shows "No report branches waiting" and the danger zone). The user would not guess that "change the org chart" lives here, and the button's label and its sentence name the architecture document, not the org chart.
- After the click the app jumps to Live with a tab "R1 Review .orgai/ARCHITECTURE.md against t…" (truncated, status "Needs you"), a sidebar row under the project, a History row, and a Dashboard Running now row. This is the behaviour the user asked for. After a relaunch the tab is restored as "Ended when OrgAI closed", with a composer that says "Session ended ... Send to continue with its memory." and a notice "OrgAI closed while this run was waiting for you".
- The relaunched run also shows a banner "Setup complete: architecture, 2 roles. The Architect is done." while the same page says the run was cut off while waiting for the user. The banner reads project state, not this run's outcome, so it can mislead about whether the change was approved.
- The title is the prompt text, so every review is "Review .orgai/ARCHITECTURE.md against t…". Two reviews are indistinguishable in the rail.

### M3 (Medium). Org retrospective is the right shape but only on a finished work run

Shots: `1600-dark-t2-ended`, `t3-after-retro`, `t4-retro-back`, `t5-history`.
Steps: start a mock work run, End session, click "Org retrospective" in the run strip. A tab "R2 Retrospective on the run "Do a small ta…" opens with its own sidebar row, History row ("Setup", Open, Open in Live) and a permission card in the tray with a composer under it. It survives navigation. It is reachable only from a finished work run, and it is about "how the org chart performed", not "make this change". Hover text names the Deep tier.

### M4 (Medium). Keyboard and screen reader: the tray session is reachable but silent when you are elsewhere

Keyboard pass, 1024x640 light (`walk7.mjs`):
- Good: Design tab (Enter) -> "Team assistant settings" gear -> "What should change" textarea -> "Revise with the Architect" button, in a sensible order; after starting, focus moves to the first card's "Allow once" (`k1-after-start`). The Needs-you popover item (Enter) goes to Team, selects Design and focuses "Allow once" (`k4-after-jump`).
- Gaps: with the session open and the user on Live there is no topbar pill (`topbar-needs-you` is absent on Live; only the rail's bell "1" and the "OR" project dot show it); the sidebar popover item is announced as "Allow: Run git status --short OrgWalk · R?: Revise this project's org chart and set…", and "R?" is meaningless to a screen reader. The Dashboard needs-you row opens the Team tab by click (`k6`); a keyboard Enter on the row after `.focus()` stayed on the Dashboard in my script. I did not rule out a harness artifact (the row may hold the real button inside), so treat this as unconfirmed.

### M5 (Medium, recorded for the card fix in flight). Org chart proposal card is cramped in the Team tray at 1024x640

Shots: `1024-dark-b-arch-proposal`, `1024-dark-c-after-arch-approve`, `1024-light-k1-after-start`.
The tray is 674 px tall in a 640 px window and sits under a canvas that stays about 235 px tall: the tray's top is scrolled under the canvas (its own bounds start at y = -94), so the card header and first rows are hidden behind the canvas; in the org chart card the Added rows are cut off ("2 added, 4 removed": only the Removed rows show) and the "Takes effect from the next run" text collides with the Approve / Request changes bar (`c`). At 1600x1000 the card is fully visible (`1600-dark-04-card`). I could not see a many-roles card: the mock's org chart proposal is two added and four removed roles. Whether the list scrolls to its end was seen only in the architecture card (inner scrollbar, buttons pinned at the bottom); the org chart card's rows overflow the same way and its buttons stay pinned. A many-role case is not driven.

### L1 (Low). "R?" label everywhere for a team-surface run

`RunLabel` shows "R?" in the Needs-you popover, the Dashboard Needs-you row, the Live "other run" link and the run panel head (`R? Architect architect`). Any new row should use a real number or a plain title.

### L2 (Low). Tray status line is easy to miss

With no card and no live run the tray shows only the form; "The Architect session ended." sits below the fold at 1024x640 (`1024-dark-e-final`) and the form invites a second session with no mention that the first is still `idle`.

### L3 (Low). Titles are the whole prompt

"Revise this project's org chart and setup: Add a database specialist under the orchestrator." The run title generator is for work runs; setup titles are the prompt prefix, truncated at about 40 characters, so the part that matters (what changes) is cut.

## What a sidebar-listed org change session should do

Proposed from what the three working pieces already do (Maintenance review and retrospective runs are the model; they work as ordinary setup runs).

1. Row in the sidebar: under the project, like any live run, with the standard status dot and word (Working, Needs you, Idle, Stopped / Finished, "Ended when OrgAI closed") and a title that names the change ("Org chart: add a database specialist"), not "R?". An org change session gets a small kind mark (org chart icon) so it does not read as a work run. The project's subtitle and the Dashboard Running now / counts include it.
2. What opens when clicked: the Live view with its own run tab (one tab per session, like retrospective runs), showing the same stage, tray cards (permission, architecture, org chart proposal with Approve / Request changes) and the composer ("Answering the Architect"). Interrupt and End session work as on any setup run. After a relaunch it comes back as an ended run with Send-to-continue, as Maintenance reviews do now.
3. Where the card and the composer live: in the run view's tray and composer, not in the Team tray, so the full-height card and its buttons get the whole frame at 1024x640 (this also removes M5 for this route). The Team tab keeps a short, quiet line when a change session is open ("An org change is waiting: Open session") and the Recommend / Design start form; starting a session from there should open the new sidebar row and switch to it (or stay with a clear link). The Needs-you jump goes to the run, not the Team tab.
4. How it reads when ended: the same ended-run composer as other setup runs, with a result line that says what was approved ("Org chart updated: 2 roles added") rather than the project-wide "Setup complete" banner (M2). A History row of kind "Org change" (the kind chip filter may need a label).
5. What stays in the Team tab: the editor, Recommend, the Templates and Import actions, the start form (instruction plus "Revise with the Architect") and the "Revise ..." entry points; the proposed chart takes effect on the canvas when approved. Settings > Maintenance keeps its review button but it should start the same kind of session. Settings no longer needs to be the way back.

Files that would need to change (read from the code, not tried):
- `src/renderer/src/lib/runSurface.ts` (drop or narrow `isTeamSurfaceRun`; tests in `runSurface.test.ts`).
- `src/renderer/src/components/DraftPanel.tsx` (start without `surface: 'team'`, then open the run; the tray becomes the start form plus a link), `components/team/TeamAssistantTray.tsx` and `useTeamAssistantStore` (`designRun`, `designJump`, tray phases, `ArchitectRunCards`, `ArchitectDecisions`).
- `src/renderer/src/components/Sidebar.tsx` (lines ~61 and ~198 filter team-surface runs out), `store/useAppStore.ts` (about 12 `isTeamSurfaceRun` filters: history, run lists, `openRun`, `jumpToDecision`, seen-runs), `components/dashboard/ProjectsGrid.tsx`, `components/dashboard/useDashboardData.ts`, `components/RunLabel.tsx` (the "R?" label), `components/NewRunPage.tsx` (the unfiltered "others" list), `lib/needsYou.ts` and the Needs-you components.
- `src/renderer/src/components/settings/MaintenanceSection.tsx` (reach and label), `components/RunActions.tsx` (retro unchanged), `lib/openTabs.ts` (restore the tab).
- Main side: `RunSummary.surface` is the only thing that hides the run; the data is already stored and restored (a team-surface run record survives a relaunch as `finished`, `endedBy: app`), so no new persistence appears to be needed. A run title for org changes belongs in `src/main/ai/runTitle.ts` or the setup service. Not verified beyond reading the code.

## Not driven

- A many-role org chart proposal (the mock gives only 2 added, 4 removed) and its scroll-to-end behaviour; the architecture card was seen with its inner scroll only.
- "Request changes" on a card and a second Revise inside a live session (the live-session variant of the tray, `draft-revise-line`) were not driven.
- Keyboard pass was done at 1024x640 light only; the 1600x1000 keyboard pass and every dark/light combination for the Maintenance and retrospective routes were not repeated (the Maintenance and retrospective routes were seen at 1600x1000 only, mixed themes).
- A second project (cross-project navigation and the Needs-you jump from another project) was not walked; one project only.
- A screen reader was not used; announcements were read from the DOM and focus logs only.
- macOS, Linux, a real Architect (live model), packaged builds.
