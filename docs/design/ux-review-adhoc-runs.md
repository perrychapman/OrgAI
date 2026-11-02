# UX review: ad-hoc runs outside of projects

Walked on a build of this worktree (`dev`), `ORGAI_MOCK=1`, fresh temp `ORGAI_DATA_DIR`, mock adapter only (no tokens). Fixtures: a scratch git repo with one file (`typo/index.js`) and a `Downloads/` folder.
Windows: 1600x1000 and 1024x640, dark; light spot-checked (shots 32 to 35). One keyboard-only pass of the New project form (shot 40). Screenshots are in `ux-review-adhoc-runs-shots/`.
Nothing about ad-hoc runs exists yet, so this is a walk of what a user does today to get that outcome, plus the one project-less pattern that exists (the MCP library assistant), followed by a recommendation.

## Verdict

A first-time user cannot start a one-off task today without creating a permanent project. The empty state of the app is a project form, the submit button is disabled until a folder is chosen, and the project that results comes with a four-role org chart on top-tier models and a default permission mode of `auto`. About 6 clicks and 2 typed fields to a first run, and the run is then bound to the whole folder you picked.

The existing project-less run (MCP library assistant) is a poor template for the interaction. It is reachable only from the bottom of one settings pane, opens a second full app window with the wrong chrome, never ends by itself, and is invisible in the sidebar afterwards. Reuse its engine (virtual project, run kind, `runs:listLive`), not its presentation.

Recommendation in short: a "Quick run" row at the top of the sidebar project list plus a button on the Projects view, one screen with prompt and optional folder, a single-agent chart (not the project's team), the default connection, safe permissions, shown in the main window as a pseudo-project "Quick runs" with its own Live and History, and a one-click "Save as project".

## Scenario counts

| Scenario | Path today | Clicks | Typed fields | Dead ends |
| --- | --- | --- | --- | --- |
| 1. "Summarize ~/Downloads/report.pdf", no folder in mind | Projects empty state is the New project form (shot 01). Existing repository, type or Browse to a folder, untick Architect, Create project, land on Team tab, click Live, type, Enter. | 6 (Existing repository, Browse + native dialog about 3, untick Architect, Create, Live, then Enter) | folder, prompt | Submit is disabled with "Choose a folder to create the project in." (shot 01). "New idea" mode asks for name, a brief and an empty folder. A file has no slot at all: the form takes a folder, so the user must pick Downloads and make it a project. |
| 2. "Fix the typo in this one file", folder not wanted as a project | Same as above on the repo folder (shots 03 to 07, 11) | 5 clicks plus typing the path (or about 8 with Browse) | folder, prompt | The folder becomes a permanent project, listed in the sidebar and on the Projects view, with a Delete button as its only visible action (shot 07). |
| 3. MCP assistant (project-less) | App settings (gear), Connectors, scroll past 38 connector tiles to "Custom servers (advanced)", Configure with AI, type, Start assistant run | 4 plus a long scroll | instruction | Reachable only from there (shot 22/21). |
| 4. Find a finished one-off again, keep it | Not possible for the assistant run from the main window (see F6). For a project run: sidebar project, History tab. "Keep it" does not apply, it is already a project. | 2 | none | See F5 and F6. |

## Findings, ranked by user impact

### F1. Critical: there is no path to a one-off run; the first screen forces project creation

- Flow: scenarios 1 and 2. Step: first launch. Shots 01, 03, 04.
- The empty state is "Start with a project" and its copy is about the Architect, an org chart and run settings. A user with a single task sees nothing that says "or just run something".
- The submit stays disabled until a folder is chosen; the reason is only given in a muted line next to the button ("Choose a folder to create the project in.").
- At 1024x640 the submit button is below the fold (shot 03); the user scrolls inside the card to find it.
- Expected: a prompt box, maybe an optional folder, Start.
- Severity: Critical for this feature. Fix: the entry point and the one-screen form in the recommendation below.

### F2. High: a single task drags the whole project apparatus along, and the defaults are heavy and risky

- Step: after Create project (shots 06, 07, 11, 12, 15).
- Creation with the Architect off lands on the Team tab with an org chart of four roles and the Team assistant open (shot 06), not on Live where the prompt box is. One extra click (Live), and a first-time user may not know a run starts there.
- The first run page says "Give Orchestrator something to do ... The orchestrator plans it and delegates to its reports" (shot 12). For "fix a typo" that means an opus-tier orchestrator delegating to a sonnet implementer: two agents, two billing lines ("2 agents · $0.00573" in shot 15) for a one-line change.
- Nothing on the start page says what the run may touch. The run meta shows "unattended" only after it starts (shot 15), and the meaning of the word is not explained. The project default permission mode is `auto` (`DEFAULT_APP_SETTINGS.defaultPermissionMode`), where a classifier approves calls and asks only when unsure. The decision card did appear in the mock (shot 15) but real behaviour was not tested.
- Severity: High. Fix: single-agent chart, visible access line before Start (see Trust and safety).

### F3. High: the closest existing pattern (the MCP assistant) is hidden and its presentation is wrong for ad-hoc work

- Step: scenario 3, shots 20 to 27 and 50.
- Entry: one button, "Configure with AI", at the bottom of the Connectors pane after a long scroll (shot 22). The pane's title for it is "Custom servers (advanced)".
- The dialog says "An assistant run proposes library servers in its own window" and it does open a second full app window (url `#/run/harness/...`), but the main window gives only a banner "An assistant run is configuring your library. Open run" (shot 22, `Open run`).
- The run window is a full copy of the shell: sidebar with all projects, "Needs you", the account row. It has the title "MCP library assistant", Live and History tabs, and a **"Back to MCP library"** button (shot 24). In a separate window, "Back" navigates that window away from its own run; the button belongs to the old in-window flow.
- The composer says "Replying to the orchestrator", and the empty Live state says "No assistant run yet. Start one from Configure with AI in the MCP library settings." (`LiveRunView`), even though the user cannot start from that window.
- It does not end. After Approve the run goes to Idle, "Waiting for your reply" (shot 25), and stays until the user clicks End session. The History row then reads Idle with the raw kind chip "mcp-assist" (shot 26).
- The Needs-you popover names the location as "Project" for the assistant's proposal ("Project · R1: List files...", shot 50), but there is no project.
- Severity: High. Judgement: reuse the virtual-project engine, not the separate window or the settings-pane entry. A run window is right for a quiet side task you want next to the main app, wrong for the main thing the user came to do.

### F4. High: no way to say "I don't want a folder" or "I want this one file"

- Step: scenarios 1 and 2. Shots 01, 04.
- Choosing a folder is a hard requirement. Pointing at Downloads to summarize one PDF gives an agent with Edit and Bash a standing foothold on that whole folder.
- The project flow has the right language for repos ("Nothing is modified until you approve") but that sentence is about the Architect scan, not the run.
- Fix: folder optional. Default "no folder" = a temp scratch directory owned by the app (precedent: `harnessProject()` creates `<data>/harness-workspace` as a dedicated empty folder). A file or a folder picked by the user is a context grant, not a project.

### F5. Medium: after a run there is nowhere a one-off lives

- Step: scenario 4. Shots 27, 30, 31, 33.
- Project runs show in History per project (shot 30) and the sidebar row shows "Last run 2 min ago · Stopped" (shot 31). The assistant run appears in no sidebar row; History for it exists only inside a harness window (shot 26), reached through the run window itself.
- The Projects view cards carry no run information (shot 07, 33); a user returning after a day cannot see that something ran or is waiting, except through the bell.
- Severity: Medium. Fix: a "Quick runs" pseudo-project row with its own History (below).

### F6. Medium: "keep it as a project" has no path and the existing project promotion path is heavy

- Step: scenario 4. Shots 06, 31.
- Today the only way to get a project is the full form. Settings > General has Name and Working directory, but that is for an existing project.
- Fix: a Save as project action on the run (and in the Quick runs History row) that creates the project from the run's folder and name with the default chart, moves the run into it and does not re-ask anything.

### F7. Medium: small wording and consistency issues found on the way

- The sidebar brand lockup renders a stray "(" next to the MOCK badge at 1600 (all full-width shots). Likely a clipped wordmark in mock/dev; not part of this feature, noted for the UI Lead.
- "unattended" in the run meta is an unexplained label and sits next to "Needs you" decisions (shot 15).
- The History kind chips read `work`, `setup`, `mcp-assist` (shots 26, 30): internal names. A quick run would add a fourth.
- New project form shows "Use the mock adapter" only in mock mode, so it is not a real-user issue; a Quick run form must not copy it.
- Keyboard pass (shot 40, 1024x640): the New project form is reachable and ordered (Name, brief, folder, Browse, two checkboxes, then the project card); the disabled submit is skipped by Tab, so a keyboard user gets no focusable cue to why they cannot continue. The reason is a plain line, not `aria-describedby` on the button (not verified).
- Light theme (shots 32 to 35): the forms and run page read fine; no ad-hoc issue.

## Recommendation

### Entry point

Alternatives weighed:

| Option | For | Against |
| --- | --- | --- |
| A. "Quick run" row at the top of the sidebar project list (plus the same button in the Projects view header next to "New project") | Visible on every screen, works in the 56 px rail as an icon, sits where the user already looks for work, one primary action per region keeps "New project" primary on the Projects view only if Quick run is the secondary there | Sidebar gets a second kind of row |
| B. A "+" in the Projects view only | Cheap | Invisible once a project is open; the user at a project has to leave it |
| C. A global shortcut only (e.g. Ctrl+Shift+N) | Fast for experts | Not discoverable; fails the first-time test |
| D. Reuse the Connectors "Configure with AI" style (Settings button) | Exists | Already shown to be hidden (F3) |

Choose A, and add C as an accelerator shown in the row's tooltip. The first-launch empty state gets two paths side by side: "Start with a project" (existing form) and "Run a task now" (the Quick run form), each with one sentence, one primary button each only if the card regions are separate (one primary per region).

### Minimum inputs

One form (a card on the Quick run page, built from the `NewRunPage` pattern with `EmptyState` and the `Composer`):

1. Task (the composer, same wording as today: "Describe the task").
2. Folder: optional, a "Work in a folder" row with Browse, default "No folder (a scratch area)". If the folder is already a project, say so and offer "Run in project <name>" instead.
3. Files: attach through the existing composer attachment affordance; files are context, not a project root.
4. Team: default "One assistant" (a single agent chart, no delegation) with a disclosure "Use the app's default team" for people who want the orchestrator. The default chart in this app is orchestrator plus three, which is too heavy for one-off tasks (F2).
5. Connection and model: the app's default connection and a tier resolved through it (no picker on the first screen; "Runs on <model> via <connection>. Change in App settings > Defaults." as one muted line, as `McpAssistDialog` already does).

Nothing else. No name, no brief, no Architect.

### Presentation

Alternatives weighed:

| Option | For | Against |
| --- | --- | --- |
| Main window, a "Quick runs" pseudo-project row in the sidebar with Live and History tabs only (no Team, Settings) | One shell, one place to find everything, reuses `LiveRunView`, `RunTabs`, `SidePanel`, `RunHistory`, decision cards and the bell exactly as projects do; no second window to lose | Needs a small non-project variant of the topbar (the harness project already does this: `isHarness` hides Team and Settings) |
| A run window per quick run (`window:openRun`) | Good for a side task beside the main app | Today's version has the stale "Back to MCP library" button, a full sidebar that can navigate the run away, and no entry from the main window (F3); results in many windows |
| Dialog or popover | Fast | Violates "nothing floats over the canvas" and the run needs the canvas, tray and decision cards |

Choose the pseudo-project in the main window, and keep `window:openRun` as an optional "Open in a window" action on a run tab (already how run windows work). Name the topbar "Quick runs"; show the folder chip or "Scratch" as the location. Do not show the Team or Settings tabs. When the task is done the run shows its result and a clear next step, not an idle "Waiting for your reply" with no explanation (F3); label the idle state "Done. Ask a follow-up or end the session."

Decision cards, Needs you and the bell are unchanged; the location text should say "Quick run" rather than "Project".

### Afterwards

A Quick runs History (the same table as project History, with the run's folder or "Scratch" as an extra column) reachable from the sidebar row. The sidebar row shows the same subtitle as projects ("Last run 2 min ago · Finished", "1 decision · 1 run"). Fix the History kind chip words (`quick`, not `mcp-assist` or `work`).

### Save as project

A secondary button "Save as project" on the run strip actions area and as a row action in Quick runs History. One click opens a small confirm (not a floating panel over the canvas: a `ConfirmDialog`) with the proposed name (folder name or the run title) and the folder. For a scratch run it says "Keep this work area as a project at <path>". Result: a project with the default chart, the run moved into its History, the user lands on its Live tab. If the quick run was in an existing project folder, offer "Open <project>" instead of creating a second one.

### Naming

| Rank | Name | Risk |
| --- | --- | --- |
| 1 | Quick run | Clear and short; the risk is that "quick" promises speed the model cannot guarantee, and "run" is already the app's word for a session, which helps consistency |
| 2 | Run a task | Plain English, but it blurs with the project's own Live "run" and has no pseudo-project noun |
| 3 | Scratch run | Conveys disposable and a scratch folder, good for the temp-dir default; developer slang, and wrong if the user points it at a real repo |
| 4 | Just run | Casual; unclear what it is next to "Projects" |
| 5 | Ad-hoc run | Accurate for developers; jargon for the broader audience and awkward in a sidebar, so keep it as the internal name only |

Use "Quick runs" for the sidebar row and page, "Quick run" for the button.

## Trust and safety notes

- Defaults for an unknown folder: read-only tools (Read, Glob, Grep) and edits that always ask. The app's default permission mode of `auto` is a poor default for a folder the user has not made a project; use `dontAsk` with read-only or `default` (ask on every edit and shell command) unless the user opts in. The run page should offer "Allow edits in this folder" as an explicit switch, off by default, and Bash off.
- Must be visible before Start, in one line under the composer: where the agent works ("No folder, a private scratch area" or the folder path), what it may do ("Reads files, asks before editing" ), the model and connection, and cost note ("Counts toward your usage"). Today's page shows none of this (shot 12); the access info appears only after start as "unattended" (shot 15).
- No folder means a fresh temp directory under the data dir (the precedent is `<data>/harness-workspace`, a dedicated empty folder). It should be per run so one run cannot read another run's files, and listed by the cleanup in Maintenance. Do not use the user's home or Downloads as the working directory.
- A file or folder given for context should be read-only by default and passed as a path the agent may read; do not widen the working directory to its parent.
- Worktree isolation (`isolateWriters`) is on for projects; a quick run in a real repo should keep it on, and the diff and merge card should work the same way. Not tested.
- `HARNESS_PROJECT_ID` is guarded by RunManager to the `mcp-assist` kind only. A quick run needs a separate virtual project id and kind (for example `quick` and `quick-run`) so that guard is not loosened; Reviewer pass applies (new run kind, folder access, permission defaults, process spawning).
- MCP: quick runs should get no project connectors unless the user turns them on; the assistant's pattern (library-scoped, per-run approval) is the right default.

## What I did not test

- Real model behaviour: all runs were on the mock adapter. How `auto` permission mode actually behaves on an unknown folder, and whether an agent can read a PDF outside its working directory, are untested.
- The native Browse folder picker (I typed the path).
- A real PDF, a single-file attach, or any run outside a git repo (the fixture was a git repo).
- A quick run in a folder that is already a project, and "Save as project" (no UI exists to walk).
- Light theme beyond the form and run start page; keyboard-only was done on the New project form only, not on a run or the assistant window.
- The assistant window at 1024x640 (the run window opened at its own size, 1264x801, and was not resized); the main window rail was seen at 1024 only for the project run.
- Behaviour with several simultaneous quick runs, and cleanup of scratch directories.

## Shot index

| Shot | What |
| --- | --- |
| 01 | First launch, 1600: "Start with a project" form, disabled submit |
| 03, 04 | Existing repository form at 1024 (submit below the fold) and 1600 |
| 05, 06 | Architect off, after Create: lands on the Team tab with the Team assistant |
| 07 | Projects view with one project card (Delete only action) |
| 11, 12 | New run page at 1600 and 1024: "Give Orchestrator something to do" |
| 13, 14, 15 | Typed prompt, run at 1024 and 1600 with permission card, "unattended" |
| 20 to 22 | Connectors pane, assist dialog, main window after start ("Open run") |
| 24, 25, 26 | Assist run window, after Approve (Idle, waiting for reply), its History |
| 27, 50 | Main window afterwards, Needs-you popover "Project · R1" |
| 30, 31 | Project History and Settings; sidebar "Last run ... Stopped" |
| 32 to 35 | Light theme spot-checks |
| 40 | Keyboard pass of the New project form at 1024 |
