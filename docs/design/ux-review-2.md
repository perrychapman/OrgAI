# OrgAI UX review 2: full re-walk after the UX fix phase

Reviewer: UX Researcher. Companions: `ux-review.md` (H1-H8, M1-M19, L1-L12), `ux-review-runs.md` and `ux-review-runs-2.md` (R1-R14, N1-N13), `ux-review-mcp.md`.

## 1. Header

- **Commit reviewed:** `cc4e94f` (branch `worktree-agent-a4d740952c3aa7de9`). Source is identical to dev at `9297876`; the commits on top only add review documents. `npm run build` was run first.
- **Method:** the built `out/` was driven with playwright-core (`_electron`) through a throwaway HTTP driver kept outside the repo (`%TEMP%/ux2/drv.mjs`, same launch as `e2e/lib.mjs`). Environment: `ORGAI_MOCK=1`, a fresh `ORGAI_DATA_DIR` (`%TEMP%/ux2/dd`), `ORGAI_MOCK_SCRIPT` pointing at two hand-written work scripts (plan, spawn, `ask_user`, `request_permission_rules`, `request_mcp_install`, Edit and Bash permission asks, `propose_org_change`; the second script uses `background: true` asks so three decisions are open at once). Two fixture git repos from `makeFixtureRepo`. Nothing touched the real profile and no tokens were spent: every project was created with "Use the mock adapter" ticked (verified `data-testid=use-mock` checked before each Create). The one setup session ran on a mock project.
- **Sizes and themes:** 1424x881 and 1100x700 (`BrowserWindow.setSize`), 1024x640 and 1600x1000 once each. Dark first, light switched through Settings > Appearance (not by editing `data-theme`), and back to dark the same way. One keyboard-only pass: skip link, Tab order on Projects, New project form (name, brief, folder, Architect box, mock box, submit), org chart node Enter / Delete / Escape, decision cards (Enter on Allow once, Arrow + Space on a question, Tab to Submit), run tabs (Ctrl+T, Ctrl+W, Ctrl+1, Ctrl+Tab).
- **Walked:** first launch, create project (New idea and Existing repository, bad path, file path, non-empty folder, relative path, mock box, Architect box), setup on mock (permission, architecture, org chart diff, settings, completion banner), org chart by mouse and keyboard (add role, remove with confirm, undo, Delete key), work runs with question, rule request, MCP install, permission (Edit and Bash), org-change proposal, stepper with three decisions, End session with a pending card (MCP card, three open decisions), three concurrent runs and the overflow menu, Continue on a finished run, History, transcript rows, Plan and Logs tabs, project settings sub-nav, rules panel error, MCP manual form, test failure and registry dialog, app settings (theme, accent, motion, notifications, About), connection states (API key mode), skip link, reduced motion, restart, renderer reload.
- **Could not walk or verify:** OS notifications and the notification click path (R11); the real Claude, Codex and LiteLLM connections (no login on this profile, so only the "Not connected" and mock states were seen); a real MCP install approval (the card never rendered, finding A1); Windows high-contrast mode; screen reader output (only roles, labels and focus order were read); drag-to-connect on the org chart (not scriptable here); the draft marker and per-run composer drafts (R7), which the peer already verified; setup on a project that is not on the mock (forbidden by the spend rule).
- **Shots:** `e2e/shots/ux2/<name>.png` (the folder is gitignored; the cited ones are force-added). 82 shots were taken, names below are file stems.

Severity: **High** blocks or misleads a first-time user on the main path. **Medium** costs time or trust. **Low** polish.

## 2. Status of every earlier finding

Legend: Fixed, Partly, Still, Regressed, Not re-walked.

### H1-H8 (`ux-review.md`, High)

| Id | Was | Status | Evidence |
| --- | --- | --- | --- |
| H1 | Create disabled until Name typed, no reason | **Fixed** | Path alone enables Create, name defaults to the folder name (project "exist" from `C:/does/not/exist`); a disabled button explains why ("Choose the repository folder."). `02-form-existing-empty-1424-dark`, `07-form-goodpath-1424-dark`. |
| H2 | No way to reach the light theme | **Fixed** (discoverability: see A6) | Settings > Appearance, Dark / Light / System, applies at once and persists across restart. `33-appearance-light-1424`, `47-restart-1100-light`. |
| H3 | Wrong path accepted, setup starts | **Partly** | A file path is blocked ("This is a file, not a folder.", `77-existing-file-path-1100-dark`) and a good repo says "Git repository found." But a path that does not exist gets the wrong warning ("Empty folder. Choose New idea...") and Create stays enabled; it created a project and started a setup session (`03-form-badpath-1424-dark`, `04-badpath-submit-1424-dark`). Finding A7. |
| H4 | Cannot tell finished from waiting | **Partly** | After End session the node says "Stopped" and every card disappears (`30-end-with-pending-mcp-1424-dark`, `59-end-with-3-pending-1100-light`). An idle run still reads "Waiting for you" on the node while the header says "Idle" (`55-run-done-1100-light`, N3 still), and the topbar pill says "Finished" while the run header says "Stopped" for the same run (`30-end-with-pending-mcp-1424-dark`). |
| H5 | MCP install card below the fold | **Regressed** | The card does not render at all, so the run waits forever on a request the user cannot answer. Finding A1. `28-run-card3-mcp-1424-dark`. |
| H6 | Org chart nodes not editable by keyboard | **Fixed** | Node is a focusable group with "Press Enter to edit, Delete to remove." Enter opens the inspector, Delete opens an in-app confirm with focus on Cancel and a sentence on what happens to reports. `21-kbd-enter-node-1424-dark`, `22-kbd-delete-node-1424-dark`. Small gap: Enter does not move focus into the inspector (A19). |
| H7 | Status pills stretched 250-310 px | **Fixed** | Pills hug their text in header, tabs, plan and History. `25-run-card1-1424-dark`, `46-history-light-1424`. |
| H8 | Two notification controls | **Fixed** | One switch under Settings > Notifications, the sidebar checkbox is gone. `68-notifications-about-dark-1100`. |

### M1-M19 (`ux-review.md`, Medium)

| Id | Was | Status | Evidence |
| --- | --- | --- | --- |
| M1 | Setup ends with no sign of what was applied | **Partly** | A good "Setup complete: architecture, 2 roles, settings applied" banner with a "View org chart" button exists, but it only shows once the session is ended (`LiveRunView.tsx:536` needs `status === 'finished'`). When the Architect says "Setup is complete." the run is Idle and the banner is absent. `13-setup-complete-1424-dark` (no banner), `14-setup-ended-banner-1424-dark`. Finding A4. |
| M2 | Question card names the Architect for the Lead | **Fixed** | "Lead is waiting for your answer. Pick one." `25-run-card1-1424-dark`. |
| M3 | Cannot try the app without tokens | **Fixed** | "Mock mode" badge in topbar and sidebar, "Use the mock adapter (no tokens are spent)" checkbox on the form, on by default. `01-first-launch-1424-dark`. |
| M4 | Approval cards were not one family | **Fixed** | One shell (kind chip, agent avatar and name, "wants to use...", run line on top), the explanation as visible lines, Deny always right aligned. `08-setup-bash-card-1424-dark`, `27-run-card2-rules-1424-dark`, `11-setup-proposal-orgchart-1424-dark`. |
| M5 | Permission card hides what is approved | **Partly** | Bash shows `$ npm test`; Edit shows only "Editing server.js", the old and new text sit behind a collapsed "Tool input". Explanations are visible lines, not a tooltip. `50-run-stepper-1100-light`. |
| M6 | Restart opens an empty project | **Fixed** | Project opens on its newest run, sidebar says "Last run 9 min ago · Finished". `48-restart-project-1100-light`. |
| M7 | Run strip clips and scrolls | **Fixed** | Tabs with an overflow "+n" menu (but see A9). `58-three-runs-1100-light`. |
| M8 | Add role: hidden parent, silent canSpawn, "New role 5" | **Partly** | Toolbar says "New roles report to Engineer" and a notice explains "Engineer can now create subagents". New role is "New role" without a counter. It still attaches under the selected role, not the root, and the removal leaves Engineer at "leads 0" with canSpawn still on. `17-addrole-1424-dark`, `19-after-remove-undo-1424-dark`. |
| M9 | Remove role: faint link, native confirm, no undo | **Fixed** | Red Remove button, in-app dialog, "Role removed. Undo" in the toolbar. `18-remove-confirm-1424-dark`, `19-after-remove-undo-1424-dark`. |
| M10 | Save feedback differs per area | **Fixed** | "Saved HH:MM" in the topbar on org chart, project settings and app settings. At 1024 it is clipped (A15). `31-appsettings-1424-dark`, `18-remove-confirm-1424-dark`. |
| M11 | Settings in four places | **Partly** | Top-level tabs Live / History / Org chart / Settings replace the two tab layers and the footer links. The sidebar "Settings" (app) and the topbar "Settings" (project) share one word; only an aria-label says "Project settings". `34-projsettings-light-1424`, `31-appsettings-1424-dark`. |
| M12 | One 2,170 px settings column | **Partly** | Sections with a sub-nav (General, Permissions, Limits, Connection, MCP and plugins, Maintenance) and a Danger zone. Clicking the sub-nav scrolls the whole window and loses the topbar (A2); the active item lags (stays "Limits" while on MCP). `34-projsettings-light-1424`, `40-subnav-general-after-1424`. |
| M13 | Rule error below the fold | **Fixed** | Red field, message directly under it. `35-rule-error-light-1424`, `36-rule-added-light-1424`. |
| M14 | Connection status stale | **Partly** | In Settings the card, header and a banner switch to "Not connected: ANTHROPIC_API_KEY is not set..." and "No connection is set up." The sidebar pill still reads "Claude · claude.ai" with a green dot (A8). `74-conn-apikey-dark-1100`. |
| M15 | Keyboard and screen reader basics | **Partly** | Skip link is the first Tab stop and lands on `main`; project cards are real buttons; focus lands on the first card button and, after Allow once, on the next card. Gaps: focus drops to `BODY` after opening the New project form and after Create (A14). `62-kbd-skiplink-1100-light`, `63-kbd-after-skip-1100-light`, `64-kbd-newproject-form-1100-light`. |
| M16 | Raw tool names and harness text in transcript | **Partly** | Rows are humanized ("Planned 4 steps", "Searched for **/*", "Handed work to engineer-1", "Asked you: ..."). Tool results meant for the agent still read as if for the user: "Setup is marked complete. Give the user a brief closing message.", "Plan marked complete. Give the user your final report now.", "(empty)". `13-setup-complete-1424-dark`, `55-run-done-1100-light`. Finding A12. |
| M17 | Toolbar controls unclear | **Partly** | "Folding finished" is now a switch "Hide finished agents"; Interrupt and End session have descriptions. "unattended" is still an unexplained pill (it also appears on the Architect's setup run) and "Org retrospective" carries "Starts a session (spends tokens)" even in mock mode. `08-setup-bash-card-1424-dark`, `30-end-with-pending-mcp-1424-dark`. |
| M18 | "Skip AI setup" pill-checkbox | **Fixed** | "Set up with the Architect (recommended)" is a real checkbox with a one-line explanation; the button flips ("Create and start setup" / "Create project"). `01-first-launch-1424-dark`, `65-kbd-form-filled-1100-light`. |
| M19 | Images can only be pasted | **Fixed** | Paperclip button and "paste or drop images" in the hint. `25-run-card1-1424-dark`. |

### L1-L12 (`ux-review.md`, Low)

| Id | Was | Status | Evidence |
| --- | --- | --- | --- |
| L1 | Glyph icons, bare "O" brand | **Fixed** | lucide icons in the sidebar, brand mark replaced. `01-first-launch-1424-dark`. |
| L2 | Inert role chips on the empty state | **Still** | `Lead / Engineer / New role` chips on the New run page do nothing. `49-newrun-page-1100-light`. |
| L3 | Org toolbar mixes nav and actions | **Fixed** | Toolbar is Add role + Auto-layout only; the AI revise path lives in the side panel. `15-orgchart-1424-dark`. |
| L4 | Two AI paths with equal weight | **Fixed** | One primary "Revise with the Architect", quick draft under "Advanced". `15-orgchart-1424-dark`. |
| L5 | 11 px text | **Still** (not re-measured) | Footer legend, card captions and node footers still read about 11 px; at the squeezed canvas nodes render at roughly half that (see A3). `25-run-card1-1424-dark`. |
| L6 | 1024 canvas about 500 px | **Partly** | The side panel now collapses (icon top right) but is open by default; at 1024 the org chart canvas is 416 px and a node is clipped (`79-orgchart-1024-dark`), the live canvas 496 px (`70-card-1024-dark`). |
| L7 | Registry duplicates and empty start | **Partly** | Opening shows suggestion chips (filesystem, github, fetch, memory, playwright). Results still repeat identical package lines ("npm @agent-infra/mcp-server-filesystem@latest" x3, "filesystem-mcp@1.3.0" x2). `45-mcp-registry-results-light-1424`. |
| L8 | Test failure shown four times | **Fixed** | One red block with Copy output. `43-mcp-test-fail-light-1424`. |
| L9 | Idle sessions never end, unexplained | **Fixed** | "Waiting for your next message" beside End session, composer "Replying to Lead", New run / Continue this run choice on a finished run. `55-run-done-1100-light`, `60-continue-selected-1100-light`. |
| L10 | Sidebar footer is five things | **Fixed** | Footer is the auth pill and usage; Notifications and the logs folder moved to Settings (About has Open buttons). `68-notifications-about-dark-1100`. |
| L11 | Destructive action looks routine | **Fixed** | "Danger zone" group, red panel. `39-projsettings-maint-light-1424`. |
| L12 | Dimmed connection cards hard to read | **Fixed** | Cards are not dimmed; a sentence says the mock adapter is on. `37-projsettings-connection-light-1424`. |

### R1-R14 (`ux-review-runs.md`, re-checked against `ux-review-runs-2.md`)

| Id | Was | Status | Evidence |
| --- | --- | --- | --- |
| R1 | New run left the old run on screen | **Fixed** | Ctrl+T opens a blank New run page. `49-newrun-page-1100-light`. |
| R2 | Finished run defaulted to Continue | **Fixed** | "New run" first, "Continue this run" second, label "Continuing this run (from 1 min ago)". `60-continue-selected-1100-light`, `61-continued-1100-light`. |
| R3 | Could not find the run that needs me | **Fixed** | Sidebar "Needs you (n)", a click jumps to the run and the exact card (stepper "3 of 3", focus on a button in the tray). `80-needs-jump-1024-dark`. |
| R4 | Run not named on screen | **Fixed** | Run header "R3 ... prompt", index repeated on tab, card and sidebar. At 1100 the prompt is squeezed by the "Auto-continuing" label (A5). `55-run-done-1100-light`, `50-run-stepper-1100-light`. |
| R5 | Restart opened an empty project | **Fixed** | See M6. `48-restart-project-1100-light`. |
| R6 | 1024 strip overflow | **Partly** | "+n" menu works, but the button is neutral while a hidden run needs you (A9); three tabs at most at 1100. `58-three-runs-1100-light`, `70-card-1024-dark`. |
| R7 | Composer draft shared | **Not re-walked** | Peer verified Fixed in `ux-review-runs-2.md`; not exercised here. |
| R8 | Chips not tabs, no shortcuts | **Partly** | Ctrl+T and Ctrl+W work; Ctrl+1, Ctrl+Tab and Ctrl+PageDown change nothing. No shortcut to a pending decision. |
| R9 | Three overlapping run lists | **Fixed** | Open runs are tabs, History is a table with filter. `46-history-light-1424`. |
| R10 | Stale "Thinking...", Idle/Working flaps | **Partly** | Ended runs show "Stopped"; auto-continue is shown on the header, but its wording is misleading at run start (A5) and an idle node still says "Waiting for you". `55-run-done-1100-light`. |
| R11 | Return from a notification | **Not re-walked** | OS notifications cannot be driven. |
| R12 | Chip anatomy resized | **Fixed** | `58-three-runs-1100-light`. |
| R13 | List under an agent heading | **Fixed** | `46-history-light-1424`. |
| R14 | Dismiss silently jumped | **Partly** | Ctrl+W on a finished tab says "Hidden. Find it in History."; the other message, "A working run stays open. End its session first.", never clears (N2b still). `72-stale-notice-1600-dark`. |

Carried from `ux-review-runs-2.md`: N1 (decision tray breaks the Live view) is **Fixed at 1600x1000** (`71-card-1600-dark`, tray docks at 360 px) but **Still at 1424 and below**, see A3. N2 (decisions not delivered to a second window) is **Still**, reproduced by a renderer reload, see A5b. N2b, N3, N6, N7, N10, N11 are **Still** (listed under Low and Medium below with fresh shots). N4 (focus) is **Fixed** for the mouse and keyboard path: after Allow once focus lands on the next card's primary button (`51-after-allow-1100-light`); only the stepper order is surprising (A18).

## 3. New findings

Shot `NN-...` names are under `e2e/shots/ux2/`. File references are to this commit.

### High

| ID | Task | What happens vs expected | Shot | Where | Fix |
| --- | --- | --- | --- | --- | --- |
| A1 | Approve an MCP install request in a work run | The sidebar says "Needs you: Lead asks to install an MCP server", the node says "Asking you to add an MCP server...", but no card appears anywhere. Focus drops to the composer. The run waits forever; the only way out is End session. `decisionItems` adds install cards only when `it.outcome` is set, so open requests are never built into the tray. Expected: a card with Approve and Deny. | `28-run-card3-mcp-1424-dark`, `30-end-with-pending-mcp-1424-dark` | `LiveRunView.tsx:505` (`cardItems.filter((it) => it.outcome)`), `:425-431`, `:614` | Include open installs in `decisionItems` (collapsed state belongs inside the card). Add an e2e that starts the mock MCP script and clicks Approve. |
| A2 | Jump between project settings sections | Clicking a sub-nav item (Connection, MCP and plugins, Maintenance) scrolls the `html` element itself by 427 px: the topbar with Live / History / Org chart / Settings, the project name and the sidebar header disappear, a blank band opens at the bottom. Wheel up and Home do nothing (`scrollTop` stays 58). Clicking "General" only brings it back to 58, never 0. A user cannot reach the tabs without leaving the project. | `37-projsettings-connection-light-1424`, `39-projsettings-maint-light-1424`, `40-subnav-general-after-1424` | `SettingsView.tsx:40` (`document.getElementById(id)?.scrollIntoView({ block: 'start' })`) | Scroll the `.settings-scroll` container (`container.scrollTo({ top: el.offsetTop - pad })`) instead of `scrollIntoView`, and set `overflow: clip` on the shell. Same check for `TranscriptPanel.tsx:204`. |
| A3 | Answer any decision card at 1424 wide or less (and at 1100x700, 1024x640) | The tray stacks under the canvas and squeezes it. At 1424x881 the canvas is 200 px tall and nodes render at about half size (`09`, `25`). At 1100x700 the tray (232-496) overlaps the stage (139-299) by 67 px: the card title is hidden under the Engineer node, the stepper's "<" sits under the zoom buttons, the canvas controls draw over the card. At 1024x640 the same, with two unreadable nodes. The side-by-side layout only starts at a frame width of 900 px, which a 1424 window never reaches (frame 800). | `09-setup-proposal-arch-1424-dark`, `25-run-card1-1424-dark`, `50-run-stepper-1100-light`, `54-orgchange-proposal-1100-light`, `70-card-1024-dark`; fixed case `71-card-1600-dark` | `layout.css:31-35` (`.frame-stage min-height: 160px`), `:44-55` (`.frame-tray max-height: 40vh`), `:74-87` (dock at 900px) | Make the tray `max-height: min(40vh, calc(100cqh - 160px - footer))` so the sum never exceeds the frame; dock the tray from about 760 px frame width and let the side panel start collapsed under 1280; add a `fitView` pass after the tray settles. |
| A4 | Finish a setup session | The Architect says "Setup is complete." and the run sits Idle with "Waiting for you"; the success banner appears only after the user ends the session. A first-time user does not know to press End session, so the one place that says what was applied never shows. | `13-setup-complete-1424-dark` vs `14-setup-ended-banner-1424-dark` | `LiveRunView.tsx:536` (`setupDone` needs `status === 'finished'`) | Drop the status condition: show the banner when `project.setup.state === 'complete'` on a setup run; label the idle session "Setup done. Close this session when you are finished." |

### Medium

| ID | Task | What happens vs expected | Shot | Where | Fix |
| --- | --- | --- | --- | --- | --- |
| A5 | Read the run header when a run starts | "Auto-continuing the plan (0 of 40)" appears before the prompt on every new run, although nothing continued yet (0 of 40 is the limit, not progress). At 1100 it pushes the prompt out entirely ("Fix the..." or hidden) and the continued-run header takes three rows. Expected: the prompt first, auto-continue only after the first nudge. | `50-run-stepper-1100-light`, `55-run-done-1100-light`, `61-continued-1100-light` | `RunHeader.tsx:84-88` (`auto.active`) | Show only when `auto.count > 0`, after the prompt, with "Continued 2 of 40 times"; keep the prompt at flex 1 with a min width. |
| A5b | Come back to a run that was waiting after the window reloads or opens a second window | Pending decisions are not in the persisted record: after a reload R4 reads "Running" with no tray and no sidebar "Needs you" entry, though its session is blocked on three cards. This is the cause of N2 (run window never gets the card). | `69-r4-1024-dark` | `useAppStore.ts:689-697` (`loadLiveRuns` uses `runs.get` records), `runManager.ts:611` (`liveRuns` copies only the summary) | Include the open permissions, questions, rule requests, proposals, merge reviews and MCP installs in `runs:get` for a live run and rebuild them in `stateFromRecord`. |
| A6 | Find the theme switch | Settings is one 2,978 px page with no in-page navigation; Appearance starts 1,483 px down, below three connection cards. Project settings got a sub-nav, app settings did not. A new user who wants "dark / light" scrolls through API key forms first. | `31-appsettings-1424-dark`, `33-appearance-light-1424` | `AppSettingsView.tsx` | Reuse the project settings sub-nav (Connections, Appearance, Defaults, Usage, Notifications, About) and put Appearance first or second. |
| A7 | Create a project at a path that does not exist | Existing-repository mode shows an amber "Empty folder. Choose New idea if there is no code yet." for a path that is not there at all, and lets Create through; a project and a setup session start. A relative path in New idea ("relative/path") is accepted with "A new folder will be created at relative/path" (relative to the app's working directory). | `03-form-badpath-1424-dark`, `04-badpath-submit-1424-dark`, `76-newidea-nonempty-1100-dark` | `projectsForm.ts:22-27` | Add a `!exists` branch for Existing: "This folder does not exist." with `blocking: true`; reject relative paths in both modes. |
| A8 | Check the connection while looking elsewhere | After switching Anthropic to "API key from environment variable" (unset) the sidebar pill still says "Claude · claude.ai" in green, and the mode switch disconnects at once without a prompt. | `74-conn-apikey-dark-1100` | `Sidebar.tsx:196-199` (reads `auth`, not the connection state) | Drive the pill from `connections.list()`; when none is connected say "No connection" in amber and link to Settings. |
| A9 | See that a hidden run needs me | With three open runs at 1100 the "+2" overflow button is neutral although R4, behind it, has three open decisions (the sidebar lists them). The "+n" cue was meant to turn amber (peer review R6). | `58-three-runs-1100-light`, `61-continued-1100-light` | `RunTabs.tsx` (overflow trigger) | Amber dot on "+n" when any hidden run is waiting; unread note indicator likewise. |
| A10 | Work in the sidebar at 700 px tall | The "Needs you" block grows to six rows and has its own scrollbar; the Workspaces list under it shows one project and its own scrollbar. The same waiting run is also flagged by the topbar pill, the run header pill, the tab icon, the project row and the run row (five signals) and a block row per decision. | `50-run-stepper-1100-light`, `70-card-1024-dark` | `Sidebar.tsx` Needs-you block | One row per run ("R7: 3 decisions"), collapsed by default under 800 px tall; drop the duplicate pill in the run header. |
| A11 | Idle run: what does the node mean | N3 still. Header says "Idle", the node says "Waiting for you" (the words used for a decision). | `55-run-done-1100-light` | `runChains.ts:115` | "Idle, send it a reply" for an idle node without a decision. |
| A12 | Read what happened in the transcript | The agent-directed text of tool results is shown to the user: "APPROVED. Continue with the org c...", "Setup is marked complete. Give the user a brief closing message.", "Plan marked complete. Give the user your final report now. Note: p1, p2...". An empty result reads "(empty)". Some of it is bold harness voice mixed into the user's reading flow. | `13-setup-complete-1424-dark`, `55-run-done-1100-light` | `lib/transcriptRows.ts` (tool result rows) | For harness tools show a one-line outcome ("You approved the architecture"), hide the instruction text under Show output; render empty results as "No output". |
| A13 | Stop a run that has open decisions | The cards and the Needs-you entries vanish without a trace, and the transcript ends at "Asked you: ..." with no outcome. The topbar pill says "Finished" while the run header says "Stopped". | `30-end-with-pending-mcp-1424-dark`, `59-end-with-3-pending-1100-light` | `RunHeader.tsx`, `lib/runStatus.ts` | A transcript row "Stopped: 3 decisions were cancelled"; use one word in both places. |
| A14 | Keyboard: New project form and Create | "New project" is a button that unmounts when pressed: focus falls to `BODY`, and the next Tab reaches "Cancel", not the first field. After Create on a no-Architect project the view changes and focus is `BODY` again. | `64-kbd-newproject-form-1100-light`, `66-beta-created-1100-light` | `ProjectsView.tsx`, `App.tsx` | Focus the Name or Folder input when the form opens; after Create move focus to the page heading. |
| A15 | Read the topbar at 1024 and 1100 | "Saved 12:01 A" is cut under the tab group and the path chip is truncated mid-word (N7 still). | `79-orgchart-1024-dark`, `70-card-1024-dark` | topbar styles in `layout.css` | Hide the save text under 1100 and keep the check icon with a tooltip; drop the path chip to a tooltip. |

### Low

| ID | Task | What happens vs expected | Shot | Where | Fix |
| --- | --- | --- | --- | --- | --- |
| A16 | Stale tab notice | "A working run stays open. End its session first." is still on screen 6 s later and after switching tabs (N2b). | `72-stale-notice-1600-dark` | `RunTabs.tsx:61`; `useAppStore.ts` `setTabNotice` already has a 5 s timer, the `setState` at `RunTabs.tsx:61` bypasses it | Use `setTabNotice` there. |
| A17 | Continued run header | Three rows at 1100 (N10 still). | `61-continued-1100-light` | `RunHeader.tsx` | Put "Continues R5" on the status row, truncated. |
| A18 | Step through decisions | The stepper opens on the newest ("2 of 3") not the first; arrows are 24 px icon buttons that collide with the zoom control at 1100 (A3). | `50-run-stepper-1100-light` | `LiveRunView.tsx:603-611` | Open on the oldest, number "1 of 3", larger targets. |
| A19 | Org chart keyboard | Enter opens the inspector but focus stays on the node; Escape then drops focus to `BODY`. | `21-kbd-enter-node-1424-dark` | `OrgChartView.tsx` | Focus the Name field; return focus to the node on Escape. |
| A20 | Idle copy in mock | "Org retrospective: Starts a session (spends tokens)" and "Starts an Architect session (spends tokens)" show in mock mode. | `30-end-with-pending-mcp-1424-dark`, `15-orgchart-1424-dark` | `RunHeader.tsx:166`, `DraftPanel.tsx` | In mock mode say "(mock, no tokens)". |
| A21 | Settings sub-nav highlight | The active item lags: "Limits" is highlighted while Connection and MCP are on screen. | `41-mcp-add-manual-light-1424`, `43-mcp-test-fail-light-1424` | `SettingsView.tsx` observer | Use an IntersectionObserver on the section headings. |
| A22 | History | The viewed run's row reads "Viewing" while on History (N11 still); two purple "Continue" buttons per page compete. | `46-history-light-1424` | `RunHistory.tsx` | "Open" for all rows, Continue secondary. |
| A23 | Role chips on New run | L2 still. | `49-newrun-page-1100-light` | `NewRunPage.tsx` | Tags, or "Ask Lead to..." starters. |
| A24 | Search field Escape | In the registry dialog the first Escape clears the search, the second closes; users who typed then press Escape to leave see nothing happen. Expected for a search input, noted only. | `45-mcp-registry-results-light-1424` | `RegistryDialog.tsx` | None needed; consider one Escape closing. |

## 4. What works and should survive

- Mock mode is unmistakable (two badges and a default-on checkbox) and the form says why Create is disabled.
- The proposal cards: org chart diff with Added / Changed / Removed rows and the "Approving replaces..." sentence is the clearest part of the app (`11`, `54`).
- The role removal dialog (focus on Cancel, says what happens to reports) with undo, and the same pattern on Delete project.
- Sidebar "Needs you" jump: lands on the right decision with focus on its primary button.
- Appearance section: immediate effect, persisted, no reload.
- Light theme is complete: no unreadable states in any shot at 1100 or 1424.
- Project cards as buttons, skip link, History table.

## 5. Top 5 to fix next, grouped by files

1. **`src/renderer/src/views/LiveRunView.tsx`** (A1, A4, A18): build open MCP install cards into `decisionItems` (line 505), drop the `status === 'finished'` condition from `setupDone` (line 536), open the stepper on the first decision. A1 makes a documented flow impossible and A4 hides the last thing a new user must see.
2. **`src/renderer/src/styles/layout.css`** (A3, A15): cap the tray by the frame height, lower the dock threshold, collapse the side panel by default under 1280, hide topbar clutter under 1100. This is the Live view at every normal laptop size.
3. **`src/renderer/src/views/SettingsView.tsx`** (A2, A21), with `AppSettingsView.tsx` (A6): replace `scrollIntoView` with a container scroll, fix the active item, give app settings the same sub-nav with Appearance near the top.
4. **`src/renderer/src/store/useAppStore.ts` and `src/main/runtime/runManager.ts`** (A5b, N2): put open decisions into the live run record so a reload or a run window shows them; add an e2e that reloads with a pending card.
5. **`src/renderer/src/components/RunHeader.tsx`, `RunTabs.tsx`, `lib/runChains.ts`, `lib/projectsForm.ts`, `Sidebar.tsx`** (A5, A7, A8, A9, A11, A16): wording and state truthfulness: auto-continue label, a blocking "folder does not exist", the auth pill from connection state, the amber "+n", "Idle" node text, the stale notice.

## 6. Reproduction

Commands used from the worktree root (throwaway driver and scripts in `%TEMP%/ux2`, not committed):

```sh
npm run build                                   # out/ rebuilt first (node_modules junctioned from the main checkout)
node %TEMP%/ux2/mk.mjs                          # makeFixtureRepo x2 (alpha-api, beta-web) under %TEMP%/ux2/repos
# driver: HTTP server around playwright-core _electron; launches out/ with
#   ORGAI_MOCK=1 ORGAI_DATA_DIR=%TEMP%/ux2/dd ORGAI_MOCK_SCRIPT=%TEMP%/ux2/script.json (then script2.json)
APP=<worktree> DD=%TEMP%/ux2/dd SHOTS=<worktree>/e2e/shots/ux2 SCRIPT=%TEMP%/ux2/script.json node %TEMP%/ux2/drv.mjs
curl --data-binary @sNN.js http://127.0.0.1:9333/   # runs a snippet with (page, app, ss, size, theme, sleep, dlg)
git add -f e2e/shots/ux2/<cited>.png docs/design/ux-review-2.md
```

No `e2e/setup.mjs`, `history.mjs`, `worktree.mjs` or `scripts/smoke-*` was run, and no project was created without the mock checkbox ticked.
