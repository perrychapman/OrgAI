# OrgAI UX review: reaching and viewing runs

Reviewer: UX Researcher. Built from this worktree (`npm run build`), driven with playwright-core against `out/` with `ORGAI_MOCK=1`, a fresh temp `ORGAI_DATA_DIR`, two fixture repos (projects "Alpha API" and "Beta Web", created with Skip AI setup, provider set to mock) and a custom `ORGAI_MOCK_SCRIPT` (plan, spawn, a permission-gated Edit). No tokens were spent. Companion: `ux-review.md` (earlier full-app review; its M6, M7, M11, L9 touch the same area and are cross-referenced). Spec references are to `spec.md` 2.1, 2.2, 2.5, 2.6.

Sizes: 1024x640 and 1600x1000 (the window was resized with `BrowserWindow.setSize`). Themes: dark, and light by setting `data-theme` on `<html>` (the app still has no switch; `ux-review.md` H2). One keyboard-only pass (45 Tab presses from the sidebar). Shots are in `e2e/shots/ux/runs/` (gitignored; the cited ones are force-added). Names below are file stems.

Severity: **High** misleads or blocks a first-time user on the main path. **Medium** costs time or trust. **Low** polish.

## Part 1. The reported defect: "a new run keeps the view of another run in place"

### Result

**On the mock adapter the view does switch to the new run, within about 40 ms of pressing Start.** I could not reproduce a view that stays on the old run after the second run exists. What I can reproduce is four different things that each read, to a user, as "it kept the other run in place". Any of them, or a combination, matches the owner's sentence. The first two are the most likely.

Timeline of the main repro (1600x1000, run 1 "First task" idle, click chip `New run`, type, Start). Sampled every 250 ms (`snap()` in the throwaway driver, console log not kept; shots `04`, `05`, `06`, `07`):

| t after Start | Run strip | Canvas | Side panel | Composer | Topbar pill |
| --- | --- | --- | --- | --- | --- |
| 0 (before Start, New run mode) | run 1 chip highlighted (`viewed`), `New run` chip dashed outline | **run 1 untouched** incl. `Interrupt turn` / `End session` | run 1 transcript | "New run: 1 open run keeps going", Start | `idle` (run 1) |
| +40 ms | new chip first and highlighted, `Working Second task` | **one node**, `Thinking…`, `0 tok 0s` (run 2) | run 2 transcript, `Runs (2)` | back to "Replying to Orchestrator", Send | `running` |
| +1.2 s | plan count `0/3` appears on chip | same node, `1s` | | | |
| +4 s | | second node `Implementer` appears (delegating) | | | |
| +9 s | `Idle Second task` | `Waiting for you` | | | `idle` |

So nothing of run 1 survives after Start. The things that look like "the old run is still there":

1. **Before Start, "New run" mode changes only the composer and the chip outline** (shot `04-newrun-mode`). The canvas, the `Interrupt turn` and `End session` buttons, the root node status, the transcript and the topbar pill all still describe run 1. The user who clicked "New run" expects a blank run page ("almost a new window"). They get the same screen with a different heading. `End session` there ends **run 1**, not the run they are about to create. Code: `RunStrip.tsx:106` and `LiveRunView.tsx:777` only call `setComposerMode('new')`; nothing in `LiveRunInner` branches on `composerMode === 'new'` except the label and send path (`LiveRunView.tsx:337-351`).
2. **The new run's canvas is visually the same as the old one.** Same roles, same names ("Orchestrator", "Implementer"), same tree shape and position, because both runs belong to one org chart. Nothing on the canvas names the run (no title, no prompt, no start time); the only cues are the strip chip highlight and numbers that reset (`0 tok`). The fit-view animation (500 ms, `LiveRunView.tsx:215`, only when the topology key changes) makes it look as if the old nodes morph. A user glancing at the canvas sees "the same run, still working".
3. **Start on a finished run does not start a new run.** Open an older finished run from the Runs tab (or reach one after restart), type a prompt, press the button: the composer says "Continuing this session (run from 1 min ago)" and the primary button reads **Continue** (shots `10-run1-ended`, `11-after-third`). The typed task resumed the old session (`resumedFrom` set, toolbar shows `continued`, `session of 2 runs`), and the old run's chip **disappeared from the strip** because one chip is shown per session chain (`RunStrip.tsx:22-44`). Result: "I started a new run and the other run is still where it was, now with my text in it". The `New run` segment next to `Continue` is the only way out and it is easy to miss (also `ux-review.md` L9).
4. **Side-panel tab and the status pill carry state across runs.** `sideTab` is global (`useAppStore.ts:283`): if the Plan tab was showing run 1's plan it stays on Plan for run 2 and shows "No plan yet" for about 1.5 s, then run 2's plan, which in the same project usually has the same goal text (shots `15`, `16`, `17`). The topbar pill says `running` for a run that is `Waiting for you` (`App.tsx:110` does not consider `needsYou`), so it never agrees with the strip chip (shot `25-alpha-two-need-you`).

Repeats:

- **(a) Runs tab "Open" on an older run, then start a new one.** If the opened run is open (idle), typing replies to it (correct per the label). If it is finished and the newest of its chain, typing continues it (item 3). If it is finished and was already continued, there is no primary mode, the label reads "New run" and Start does start a new run (correct, no selector shown). Opening a run does reset the composer mode to Reply (`openRun`, `useAppStore.ts:494`), so a "New run" chosen before is lost.
- **(b) Switch project and back.** The viewed run per project is remembered (`activeRunByProject`) and restored, composer mode resets to Reply, the strip is intact, counts in the sidebar update ("Beta Web 1 open", "Alpha API 3 open", shots `13`, `14`). **The composer draft is not per project**: text typed in Alpha was still in Beta's composer (`LiveRunView.tsx:101` `text` state lives in a component that is not re-keyed on project or run). A task typed for one project can be sent to the other.
- **(c) A run with a plan.** The plan tab survives the switch (item 4). The plan pill in the toolbar and the chip `0/3` belong to the new run only after the first `plan.updated` (about 1 s); before it the chip has no count. Nothing stays stale after about 1.5 s.
- **Restart.** After an app restart the project opens on "Give Orchestrator something to do" with the run strip absent, although four runs exist (shot `22-restart-alpha`); history is behind the `Runs` tab (shot `23`). Already M6 in `ux-review.md`; re-confirmed.

### Renderer paths inspected

`useAppStore.ts`: `startRun` (`:497`) awaits `runs.start`, calls `handleEvent` for the status, then sets `runs`, `activeRunByProject`, `selectedAgentId: 'root'`, `view: 'run'`, `composerMode: 'reply'` in one `set`. `openRun` (`:483`), `handleEvent` (`:649`; an event for an unknown run creates a placeholder with `projectId: ''` and `queueMicrotask(fillSummary)`), `fillSummary` (`:789`; only auto-follows a paused run's continuation), `dismissRun` (`:760`), `selectProject` (`:424`, resets `composerMode` and `selectedAgentId`). `LiveRunView.tsx`: local state `text`, `images`, `sessionBlock`, `expandedGroups`, `pickedInstall`, `dismissedInstalls`, `collapseFinished`; `activeRun` selector; `sendMode` logic (`:337`). `RunStrip.tsx`: `useStripRuns` chain collapsing. `RunHistory.tsx` is the Runs tab.

### Best hypothesis for the real adapter

Not a race. `ClaudeAdapter.start()` returns `new ClaudeSession(ctx)` immediately (`claude.ts:1251`), the SDK query starts inside the session, and `RunManager.start` has no await between creating the summary and returning it except `adapter.start`. Events of the new run (`starting`, root `agent.upsert`, user transcript line) can arrive before `runs:start` resolves: they land on a placeholder whose `projectId` is `''`, so `projectRuns` hides it until `fillSummary` completes, and `startRun` then swaps `activeRunByProject`. Worst case the old run stays displayed for the IPC round trip (single-digit milliseconds). The only long gap is a refusal: `RunManager.choose` throws before a run exists (mixed model families, no adapter); then the draft is restored and the message goes into `imageNotice` (`LiveRunView.tsx:389`), a notice named for images. The user stays on the old run with a small grey line under the mode row, which also reads as "it kept the other run in place". On the real adapter the four items above apply unchanged, and item 2 is worse: real runs take a second or more to spawn the first report, so the new canvas is a single "Reading your request" node under an identical-looking chip.

## Part 2. Ranked findings

IDs use the prefix R (runs). "Shot" is the file stem under `e2e/shots/ux/runs/`.

### High

| ID | User's task | What happens vs what they expect | Where | Suggested fix |
| --- | --- | --- | --- | --- |
| R1 | Start a second task while another is running | Pressing `New run` (strip chip or composer segment) leaves the old run's canvas, toolbar (`Interrupt turn`, `End session`), transcript and pill on screen; only the composer heading and a chip outline change (shot `04-newrun-mode`). Expected: a fresh run page. `End session` on this screen ends the other run. | `RunStrip.tsx:106`, `LiveRunView.tsx:777`, `:337-351` | Make "New run" a state of the workspace, not of the composer: selecting it shows a blank run page (centred composer, role chips, example prompts, "N other runs keep going" with links) and hides the old run's toolbar. Keep it a draft until Start, then it becomes a tab. |
| R2 | Type a new task after opening an old finished run | The button says `Continue` and the typed text resumes the old session; the old run's chip vanishes behind the continuation (shots `10-run1-ended`, `11-after-third`). Expected: the new task is a new run, or a loud "this resumes the earlier conversation". | `LiveRunView.tsx:337-351`, `RunStrip.tsx:22-44` | On a finished run default to `New run`, with `Continue this run` as the explicit second choice (reverse today's default), keep the continued run's chip until dismissed, and write "Continues Run: <prompt>" on the new chip. |
| R3 | Find a run that needs me while I work elsewhere | The sidebar row says `1 open · 1 needs you` (good), but clicking it opens whichever run was last viewed, not the one that needs you; the only in-window signal is a chip colour; the topbar pill says `running` for a run that waits (shots `24-alpha-while-beta-needs-you`, `25-alpha-two-need-you`). With two waiting runs in one project the two chips read `Waiting for you Needs-you A2: ad…` and `Waiting for you Needs-you A: ad…`. The permission card says "Implementer wants to use Edit" without naming the run. | `App.tsx:48-70` (row click), `App.tsx:110` (pill), `RunStrip.tsx`, `LiveRunView.tsx:595-632` | Row click opens the run that needs you first (else the last viewed one). Pill uses `needsYou` ("Waiting for you"). Put the run name in every decision card ("Run: Add caching"). Add one global "Needs you (n)" entry (sidebar top and the Inbox tab of spec 2.5) that lists every waiting item across projects with the run name; clicking jumps to it. |
| R4 | See which run I am looking at | The canvas never names the run. Two runs of one project show identical node trees ("Orchestrator", "Implementer", same layout). The only identification is a truncated chip (`First task: add a healt…`) and, in the Runs tab, a `Viewing` button (shots `05`, `08`, `20-1600-light-4runs`). | `LiveRunView.tsx:481-547` | Run bar shows the full prompt (2 lines on hover/expand), status and start time, always. Tint the run bar or add a coloured run index (R1, R2…) that repeats on the chip, the canvas corner and the transcript header. |
| R5 | After restart, see what ran | Project opens on an empty "Give Orchestrator something to do" with no strip, though four finished runs exist (shot `22-restart-alpha`). History is behind the second-level `Runs` tab (shot `23`). The sidebar row shows no "last run" info. (`ux-review.md` M6.) | `useAppStore.ts` `loadHistory`, `LiveRunView.tsx:634` | On opening a project with history show the newest run (or the History tab) rather than the empty state; the empty state is for projects with no runs. Sidebar subtitle "Last run 2h ago · Finished". |

### Medium

| ID | User's task | What happens vs what they expect | Where | Suggested fix |
| --- | --- | --- | --- | --- |
| R6 | Switch between concurrent runs at 1024x640 | With 3+ runs the strip is `overflow: auto` with `nowrap` (scrollWidth 721 vs clientWidth 472), so the third chip is cut and the `New run` chip is scrolled out of sight; the toolbar overlaps the root node and the side-panel tabs (`End session` sits on `Transcript`); status pills in the Runs tab stretch (`ux-review.md` H7, still present) (shot `18-1024-dark-4runs`, light `19`). | `run.css` `.run-strip`, `.canvas-toolbar` (`top: 52` hard-coded in `LiveRunView.tsx:484`) | Spec 2.5 run bar in normal flow; overflow goes to a `+n` menu, not a scroll; `New run` is a fixed button at the end, never scrolled away. |
| R7 | Keep a half-typed task | The composer draft (`text`, `images`) is shared across projects and across runs (`LiveRunView.tsx:101`): text typed in Alpha appeared in Beta, where Enter would send it to a different repo. | `LiveRunView.tsx:101-103` | Key the composer state by project and run (`key={project.id}:{runId}` or a map in the store); show a "draft" dot on a tab that holds one. |
| R8 | Know what a chip click did | Chips are four-state buttons in a `role=group`, not tabs: no arrow keys, no `aria-selected`, `Tab` goes through all chips then toolbar then cards (shot `26`, Tab 10-12). There is no shortcut to the run that needs you, to the next run, or to New run. | `RunStrip.tsx:58` | Real `tablist` with arrow keys, `Ctrl+Tab`/`Ctrl+1..9`, `Ctrl+T` (new run), `Ctrl+W` (hide). Focus the first decision card when a run that needs you is opened. |
| R9 | Understand "Runs (n)" | `Runs (2)` counts open runs only while the list below also shows finished runs; the strip chips, the Runs tab and the sidebar counts are three lists of overlapping sets (`ux-review.md` M7). Row layout puts the status pill left and cost right in a stretched row and the prompt, the important part, below them (shot `08`). | `RunHistory.tsx`, `run.css` | Spec 2.6 History table for closed runs; open runs are the tabs. Row = prompt first, then status, cost, age. |
| R10 | Follow a run after it ends | After End session the root node still shows "Thinking…" with a tick, the chip says Finished (shot `10`). Mock-only noise: an idle mock run flaps between `Idle` and `Working` as the harness nudges an unfinished plan (shots `05`..`07` text samples); real runs do this too whenever auto-continue fires. A user who sees Idle ↔ Working with no cause will think the app is broken. | `AgentNode.tsx`, `continuation.ts` | Show "Auto-continuing the plan (3 of 40)" as a status line on the run bar whenever the harness itself restarted the turn. (`ux-review.md` H4 for the stale node.) |
| R11 | Return to a run from a notification | `onFocusRun` selects the project and opens the run (`useAppStore.ts:779`), good, but it also un-hides a dismissed chip silently and does not scroll or highlight; if the window was on Org chart & settings it switches tabs without saying so. Not exercised end to end here (OS notification not drivable). | `useAppStore.ts:779-787` | Flash the run bar and chip for one second; focus the decision that triggered the notification. |

### Low

| ID | User's task | What happens vs what they expect | Where | Suggested fix |
| --- | --- | --- | --- | --- |
| R12 | Read the strip | Chip text has the status word, prompt, plan count and cost in 400 px; plan count `0/3` appears only after the first plan event so chips resize while you watch (shots `05`, `06`). | `RunStrip.tsx:69-88` | Fixed chip anatomy: dot, prompt, one trailing badge. Status word in the tooltip. |
| R13 | See where a run lives | The side panel's `Runs` tab is the only list with Continue / Retrospective but sits under an agent heading ("Orchestrator" above run rows). | `TranscriptPanel.tsx` | Spec 2.6 History tab. |
| R14 | Dismiss a chip | The `x` appears only on finished chips, and hiding the viewed run silently jumps to another one. | `RunStrip.tsx:89`, `dismissRun` | Toast "Hidden. Find it in History." |

## What works and should survive

- The composer mode row names what Send does and the open-run count ("New run: 1 open run keeps going"). Good wording; the problem is only the default on finished runs (R2).
- Sidebar counts as text ("1 open · 1 needs you") are findable and colour is not the only cue.
- Starting a run switches the view within a frame and leaves the other runs running (no hidden stop). Concurrency works on the mock: four Alpha runs and one Beta run ran at once, each with its own plan and permission card.
- Project switch restores the viewed run and the strip per project.
- Opening any past run after a restart works and shows its transcript; Continue / Retrospective are discoverable in the Runs tab.

## Proposed navigation model

Options compared against `spec.md` 2.1/2.2/2.5/2.6:

| Option | Clicks to a given live run | Tells you which run you are on | Scales to 5 open runs at 1024 px | Fit with spec |
| --- | --- | --- | --- | --- |
| A. Run selector dropdown in the run bar (spec 2.5) | 2 (open menu, pick) | Yes, in the bar | Yes | Is the spec; hides concurrency behind a click, no ambient "needs you" per run |
| B. Browser-style run tabs in the workspace | 1 | Yes, tab title | Needs overflow menu | Replaces the selector; the owner's "new run opens a new window" maps to "new tab" |
| C. Nested runs under each project in the sidebar | 1 from anywhere | Yes | Yes (sidebar scrolls) | Extends 2.1, does not conflict |
| D. History page only | 2-3 | No | n/a | Spec 2.6; right for closed runs only |

**Recommendation: B + C + D, retire the dropdown.** (1) Run tabs in the run bar for the *open* runs of the viewed project: status dot, short prompt (first 24 chars), a `needs you` badge, `x` only on finished tabs, overflow into a `+n` menu, and a fixed `+` at the end. `+` opens a blank "New run" tab (a draft page: centred composer, role chips, "2 other runs keep going"). This is the "almost a new window" the owner asked for, and it also fixes R1 and R2 because a draft tab has no old run on screen and Start there can only start a new run; `Continue` becomes a button on a finished run's page. (2) Sidebar project rows expand to show their open runs (dot + prompt, needs-you first); click opens that run from any project in one click, which fixes R3. (3) Closed runs live in the History tab (spec 2.6) with Open / Continue; opening one adds a temporary tab. (4) The Inbox tab (spec 2.5) becomes global: it lists every waiting item across projects with the run name, because a run that needs you must be reachable from anywhere. (5) A real separate OS window ("Open in new window" in the tab menu) is worth offering later for multi-monitor use but is not what a first-time user means by "new window"; the tab behaviour is, and it needs no main-process work. Each tab and window should carry the run's index and prompt in its title, so notifications and the OS task switcher show them.

Why not only the dropdown: with 3 to 5 concurrent runs the user switches often and wants to see all statuses at once; a menu shows them only while open. Tabs are the pattern the user already knows from browsers and terminals. Spec impact to relay to the Product Designer: 2.5 "Run selector" becomes "Run tabs"; 2.1 sidebar rows get an expandable child list; 2.5 Inbox becomes global.

## Cross-run messages (orchestrator of run A to run B)

Not built in this version: in-run `agent.message` edges exist only within one run. Design so a user can follow and control it:

- **Consent first.** The first cross-run message in a project asks once: "Run A (Add caching) wants to send a note to run B (Fix header). Allow runs of this project to message each other?" Allow once / Always for this project / Deny. Setting lives in project settings; default off. Messages never cross projects.
- **Sender transcript** (run A): a system-style row on the orchestrator, not an assistant bubble: "To run B (Fix header): <text>" with an `Open run B` link and a delivered / read tick.
- **Receiver transcript** (run B): a visibly different row (tinted, left rule in the sender's run colour, header "Note from run A (Add caching)", link `Open run A`), not mixed into "You". The agent's reply, if any, goes back as the same kind of row on A. Nothing should look like the user typed it.
- **Canvas:** a dashed stub node on the root of each run labelled with the other run's index and prompt ("Run A") using the existing message colour; clicking selects the transcript row. No floating overlay.
- **Run tab:** a small link icon and a badge counter on the receiving tab while unread; the tab title stays unchanged. If the receiver is idle and the note wakes it, the tab shows `Working` and the Inbox gets an informational (not blocking) item "Run B was woken by run A".
- **Notifications:** none by default for message traffic. An OS notification only when the exchange creates something that needs the user (an approval, a question, a loop guard stopping a ping-pong after N messages). Text names both runs: "Run B needs you: asked by run A to edit src/db.ts".
- **Control:** `End session` on either tab stops its side; the other tab shows "Run A ended" on its next row. A visible counter ("12 messages with run A") and a hard cap protect against loops and token burn.

## Reproduction

```sh
npm run build
node e2e/shots/ux/_t/mkrepo.mjs                       # two fixture repos in os.tmpdir()
# DD = fresh temp dir; the driver launches out/ with ORGAI_MOCK=1, ORGAI_DATA_DIR=$DD, ORGAI_MOCK_SCRIPT=e2e/shots/ux/_t/script.json
DD=<temp dir> node e2e/shots/ux/_t/drv.mjs &          # then feed snippets with: sh e2e/shots/ux/_t/run.sh <snippet.js>
```

Projects are created through `window.orgai.projects.create` without `setupKind` (the same as ticking Skip AI setup) and saved with `provider.id = 'mock'`. The driver and snippets are throwaway and gitignored.
