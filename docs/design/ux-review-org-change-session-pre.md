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

## Status after the change

Reviewer: UX Researcher. Build: `c5eaf8e1` (dev line, 0.1.7-dev1), `npm run build` in this worktree. How it ran: `ORGAI_MOCK=1`, fresh temp data dir per script (own `E2E_DATA_DIR`-less `launch()` dirs), Windows, one mock code project "OrgWalk" created with setup skipped. 1024x640 (56 px rail) and 1600x1000, dark and light (`data-theme`). Flows: Team > Design start, Live tab, sidebar, Team pointer, bell, Dashboard, History, Settings > Maintenance, a second text sent while the session is open, every card answered (permission, architecture, org chart, run settings), End session; a keyboard-only pass at 1024x640 light; a relaunch at 1600x1000 dark with a card open. Combinations: 1600 dark and 1024 light full flow; 1600 light and 1024 dark full flow again (`w2.mjs`), so every size/theme pair was seen. Scripts and shots: `e2e/shots/ux/org-change-session-2/` (gitignored; `w1`-`w4.mjs`; shot names below are relative to it and carry a `<width>-<theme>-` prefix, `kb-`, `rl-` or `m-`).

### Verdict: MET (with Medium and Low follow-ups)

The user's complaint is resolved. A Team > Design change now opens on Live as `R1 Org chart: add a database specialist under the…`, appears in the sidebar under the project (`nav-run`, kind mark, status word), in History as kind "Org change", in Dashboard "Needs you" and "Running now", and survives navigation and relaunch. The Team tray points back at it in both modes, and starting again sends into it. Maintenance starts the same kind of session. No "R?" was seen on any surface I opened. The remaining issues are copy and focus details, none blocking.

### Per-finding status

| Id | Status | Evidence |
| --- | --- | --- |
| H1 session cannot be left and found again | Fixed | `1600-dark-01-live`: tab, sidebar row, Live. `1600-dark-03-dashboard`: "Running now 1 Needs you Org chart: add a database specialist under the…". `04-history`: row kind "Org change", Open / Open in Live. Team Recommend mode shows the pointer (`02-team-pointer`, "…is open · Needs you. Open session"); Open session returns to the run. At 1024 (rail) the way back is the project's "OR" dot, the run tab and the bell (`1024-light-01-live-perm`, `03-bell`). Relaunch with a card open: tab `R2 Org chart: add a QA lead` "Ended when OrgAI closed", cut notice, composer "Pick up where it was cut off." (`rl-03-restored`); History and the project tile say "Ended when OrgAI closed". |
| H2 attention state contradicts the rest | Fixed | Project row "1 decision · 1 run" (was "· 0 runs"), Dashboard Running now lists it, hero "1 needs you / 1 run open". After every card: tab status "Idle", pointer "is open · Idle. Open session" (`1024-dark-07-team-idle`), banner "Org change applied: architecture, org chart, run settings" with Open Team and End session (`1600-dark-10-after-cards`); End session from the run strip works, tab becomes "Stopped", History "Stopped / Continue". |
| M1 leak into New run page as "R?" | Fixed | "+" tab page says "1 other run keeps going" and names "R1: Org chart review" (`m-03-new-run-page`); no "R?" in bell, Dashboard, sidebar, pointer, History, tab strip. The run tab is real (no half-state). |
| M2 Maintenance hidden / "Setup complete" banner after quit | Fixed | "Review the org chart and setup" is present on a project with no architecture document (`m-01-maintenance-fresh`); click opens `R1 Org chart review` with its own tab and sidebar row (`m-02`); with a session open the button reads "Open the org change session" (`1024-dark-08-maintenance`). No `setup-complete` banner on the relaunched cut run (`rl-03`, text "<none>"). Titles are now distinct ("Org chart review" vs "Org chart: add a QA lead"). |
| M3 Org retrospective only on a finished work run | Not re-walked | Not part of the change; unchanged by reading the brief. |
| M4 keyboard / screen reader | Partly fixed | Order Design tab, gear, textarea, start button is sensible (`K design tab1-3`). Bell item (Enter) lands on the card; sidebar bell and topbar pill both reach the run; the bell item is announced "Allow: Run git status --short, OrgWalk · R1: Org chart: add a…" (a real number, not "R?"). After the last card focus moves to the composer, after End session to the composer ("Message the orchestrator."). Gaps: see M-new-1 (focus at 1024 lands on the card's "Details"), the topbar pill is still Team-only (Live relies on the tab and bell), and I did not confirm Enter on a Dashboard Needs-you row. |
| M5 card cramped in Team tray at 1024x640 | Fixed | The card now lives in the Live tray: permission card 154 px, proposal cards 130 px, stage 253-277 px, composer 96 px, no page scroll (640/640). Header, summary ("2 added, 4 removed") and the Approve / Request changes bar are fully visible (`1024-light-05-card2`). The Added / Removed rows hide behind the collapsed "Details" disclosure. A many-role card was not driven. |
| L1 "R?" label | Fixed | None seen anywhere walked (sidebar, bell, Dashboard, History, strip, pointer, New run page, run panel head shows "R1 Architect"). |
| L2 tray status easy to miss | Fixed | The pointer line sits above both modes and reads Needs you / Idle; no hidden "session ended" below the fold. After End session the pointer disappears and Team shows nothing about the ended session (acceptable; History has it). |
| L3 titles are the whole prompt | Partly fixed | Titles now name the change ("Org chart: add a database specialist under the…"), Maintenance "Org chart review". The tail "under the…" is still the prompt cut at about 44 characters, so a long ask still shows its beginning only. |

### New findings

**M-new-1 (Medium). At 1024x640 focus after starting or jumping lands on the card's "Details" button, not on the decision.** `1024-light` / `1024-dark` (`focus: BUTTON.decision-details label=Details card=true`) after Team start, bell Enter, pill Enter and for the first three cards in the keyboard pass; at 1600x1000 it lands on "Allow once" (`1600-light` focus log). A keyboard user hears "Details" with a collapsed disclosure and has to Tab to Allow once. Steps: 1024x640, Team > Design, type text, Enter on "Revise with the Architect". Fix: focus the card's primary button (or the card heading) in the compact layout as in the wide one.

**M-new-2 (Medium, boundary of the change). "Setup is not finished ... Resume setup" shows on the New run page of a project while an org change session is live** (`m-03-new-run-page`: "Setup is not finished. The Architect scans the repository ... Resume setup", beside "1 other run keeps going"). The project was made with setup skipped, so this is old behaviour, but now a user who has just started an org change sees an invitation to start a second Architect run. Fix: show "Resume setup" only when no setup-kind run is live, or point at the open session.

**L-new-1 (Low). Redundant End session.** The "Org change applied" banner repeats "End session" beside the run strip's own button (`1600-dark-10-after-cards`; my locator hit two buttons). Keep one, or word the banner's "Done, end session".

**L-new-2 (Low). Run strip squeezes at 1024.** The "Org change session started. Its questions and proposals appear here, and it stays in the sidebar while it is open." notice sits beside the tab and clips both the tab title ("Org chart: add a database specialis") and itself (`1024-light-01-live-perm`). It clears after a few seconds. Also the notice says "stays in the sidebar" while the 1024 rail has no run list (the project dot and Live tab are the way back); the sentence is true only at the full sidebar.

**L-new-3 (Low). Sidebar run row has no status word when idle.** Row shows a blue dot and title (`1600-dark-10-after-cards`); "Needs you" shows as a word, Idle only as the dot. Check the dot has an accessible name (not verified).

**L-new-4 (Low). After a relaunch with a card open the Dashboard says "All quiet. Nothing needs you."** while the project tile reads "Last run just now · Ended when OrgAI closed" (`rl-05-dash`). Same as the existing quit behaviour for any run; the proposal the user was reviewing is recoverable only by opening the restored tab and continuing. Not specific to this change.

Positives worth keeping: the pointer is quiet in both themes (plain line with a link, no banner chrome, `1024-light-02-team-pointer`, `1600-light-02-team-pointer`, readable in dark `1600-dark-02-team-pointer`); "Send to the open session" delivered the second text into the same run (transcript "Also add a QA lead.", notice "Sent to the open org change session.", still one tab and one sidebar row, `1600-dark-08-after-send`, `10-after-cards`).

### Not driven

- The Team "Open session" link by keyboard, and Enter on a Dashboard Needs-you row (clicked only in the earlier pre-walk).
- A many-role org chart proposal and its Added rows (mock gives 2 added, 4 removed), "Request changes", a decision declined mid-session.
- The 1600x1000 keyboard pass (done at 1024x640 light only); screen reader output (focus and DOM text only; the bell item's accessible name read from `aria-label` text, live-region announcements not heard).
- Sidebar run row's accessible name for status; org retrospective (M3); a second project and cross-project jump; an engagement project; run-scoped windows.
- Reaching `R?` through `runTag` callers while history loads (CLAUDE.md lists it as open); I did not catch a loading moment.
- macOS, Linux, a real Architect, packaged builds.
