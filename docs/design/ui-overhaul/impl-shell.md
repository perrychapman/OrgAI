# UI overhaul: shell and home (implementation notes)

Lead: ov-shell. Boards: Main, ProjectHome, EngagementHome, Empty, Inbox, Welcome, NewProject, Trust.
Status 2026-11-22: shell, sidebar, palette, banners, Welcome, NewProject and Trust are built; Home (sh-home), the project
Home tab (sh-projhome) and Inbox (sh-inbox) were still being built by engineers when this file was written.
Update 2026-11-23: all three have landed. Home is described in `docs/agent-notes/renderer.md` "UI overhaul: shell, Home
and Inbox" and `.orgai/ARCHITECTURE.md` "UI overhaul", the project Home tab in `impl-project-home.md`, and the Inbox in
`views/InboxView.tsx` (key guard in `lib/inbox.ts`). Corrections to the text below are marked "Corrected".

## Built per board

- **Shell (`side()` on every board), by sh-shell:**
  - The `.app` root paints `--bg-art`. The sidebar and the topbar are glass.
  - Sidebar order:
    - Search ("Search or jump to", Ctrl K).
    - Home (`nav-home`), Inbox (`nav-inbox`, amber count) and Chat.
    - A "Helpers" group with the MCP and Skill assistants.
    - Projects, with a `+` button (`nav-new-project`). Engagement rows carry a Briefcase mark.
    - Footer: Usage, Schedules, Settings (`app-settings-button`), then the plan-limit account row (`auth-pill`).
  - The Needs-you popover (`needs-you-row`, `needs-you-list`, `.needs-item`) stays as a bell beside the Inbox row.
  - Command palette (Ctrl/Cmd+K): pure ranking in `lib/commandPalette.ts`.
  - Project header: a kind chip ("Code project" or "Engagement · client") and a Project or Engagement settings button (`project-settings-button`). `<main>` gets `data-kind="engagement"` on engagements.
  - App-wide banners in `AppBanners`: offline, sign-in needed, update ready.
- **Tabs (App.tsx):**
  - A Home tab (`tab-home`, view `home`) comes first, on stored projects only.
  - Outputs now reads "Files" (`tab-outputs` unchanged).
  - App-level view `inbox`.
- **Welcome (`FirstLaunch.tsx`, `lib/welcome.ts`):** first launch opens on three setup steps (`welcome-setup`, `data-stage` 1 to 3), then the start choice.
  - Step 1, "Connect the AI your teams will use":
    - A radiogroup of the real enabled connections, the default first, each with its real status.
    - A connected pick becomes the default through `setDefaultConnection`.
    - An unconnected pick offers "Sign in" (App settings: Connections, where sign-in opens the browser) and "Continue without it".
    - The mock adapter shows a note instead.
  - Step 2, "What will you work on first?":
    - Code, not code, or "Just look around".
    - Code and not code preselect the New project kind (`writeLastProjectKind`). Chat opens a new Chat and finishes setup.
  - Step 3, "How much should the team ask you?":
    - Three real modes in plain words: `default`, `acceptEdits` and `auto`.
    - The saved `AppSettings.defaultPermissionMode` is preselected when it is one of the three, and Next saves it through `settings:set`.
  - Navigation:
    - Back, Skip setup and the steps list (aria-current) work on every step.
    - After a step change, focus moves to the new step's heading.
    - The place is kept for the window while the user signs in.
  - Finishing or skipping lands on the start choice and is remembered in `localStorage['orgai.welcome.done']`.
  - The start choice keeps its radios "Start a project" and "Chat now" and the inline form, so the e2e helpers still work.
  - The side panel shows the real default connection card and "What you are setting up": an Orchestrator card plus a neutral team card that names no roles.
  - e2e:
    - `launch()` marks setup as done unless a script passes `welcome: true`.
    - `openProjectForm` clicks Skip setup if the steps are showing.
    - `layout.mjs` W1 to W4 walks the steps.
- **NewProject (`NewProjectForm.tsx`):**
  - The two kinds look separate: code is violet with a mono title, engagement is coral `--eng` with a serif title.
  - A "How they differ" table shows only while no kind is chosen.
  - The engagement text is neutral (no client or deliverable wording).
- **Trust (`settings/FolderTrustSection.tsx`, taken over from ov-settings for this run):**
  - Title "This folder comes with its own agent settings".
  - The path in mono (`folder-trust-path`), then a "What it would set up" label and glass item rows.

## Deviations

- **Opening a project:** the sidebar name row (and the palette's project entry) opens the project's Home (`openProjectHome`); open runs are their own rows under it (`nav-run`). Earlier it opened the default run, which hid Home. The e2e helper `openProject` in `lib.mjs` clicks the name and then the Live tab, so area scripts still land on the composer. Dashboard tiles still open Live on purpose.
- **Welcome:**
  - The board's last button "Open OrgAI" leads to the start choice and the inline New project form, not to an empty Home. The project still has to be created.
  - Step 1 has no API-key or company-gateway cards. Connections are added in App settings, and the step lists the ones that exist.
  - No option carries a "Recommended" badge, because the app does not mark a recommended mode for this choice.
- **Trust:** there is no radiogroup. The real choice is binary (Allow these settings / Stop using these settings), and the buttons carry it.
- **Notices:** `AppNavigateBanner`, `RemapNotices` and `SecretNotices` keep their structure and take the restyled Banner primitive.

## Needs runtime

ov-runtime was asked for:
- a git summary and recent commits;
- schedule outcome history;
- month-to-date spend per project;
- test and dependency health (only if real data exists).

sh-projhome builds against whatever contract lands, and omits a section when its data is missing.

Corrected: the first three landed as `gitInfo.summary`, `runInsights.scheduleHistory` and `runInsights.projectSpend`
(`impl-runtime.md`) and the project Home reads them. Test and dependency health are not recorded, so they are not drawn.

## Before and after, for the UX walk

- **Welcome:**
  - Before: a greeting and two radio cards.
  - After: three steps (connection, first work, how much to ask) with Back and Skip setup, then the same two radio cards and form beside a side panel with the connection and what is being set up.
- **New project:**
  - Before: two plain kind cards.
  - After: visually distinct kind cards and a "How they differ" table until a kind is picked.
- **Folder review:**
  - Before: a plain dialog.
  - After: the path in mono, a "What it would set up" label and glass rows.
- **Shell:** see sh-shell's notes in the lead's report (Inbox row, palette, header chip, banners).

## Verified

- typecheck clean.
- build green.
- `e2e/folder-trust.mjs` passed after keeping the form's radios clear of the sticky submit row.
- `e2e/assistants.mjs` passed.
- sh-shell ran `layout`, `assistants`, `updates`, `engagement`, `context-menus` and `menu`.
- Screenshot of Welcome at 1024x640 in dark.

## Open

- Still open: screenshots of Welcome, Home and Inbox in both themes and both sizes, and a mock UX walkthrough of the
  shell (Inbox row, palette, banners); screen-reader speech; macOS. Reviewer verdicts for Home and Inbox are not recorded
  in this folder; the Welcome and palette changes were checked by the e2e scripts named under "Verified" only.
- Corrected: `scripts/e2e-select.mjs` maps the new files now (Inbox files to `dashboard`, `runs`, `proposals`; project
  Home files to `per-project`, `engagement`, `engagement2`; the palette and banner files to `layout`, `updates`;
  `onboarding.css` and `FirstLaunch.tsx` to `dashboard`, `assistants`, `folder-trust` and the project-form scripts).
- Corrected: Ctrl+K is in the shortcuts table now (`src/shared/view/shortcuts.ts`: "Search or jump to", Mod+K).

## Since the first pass (read on dev 2026-11-23)

- Project header at 1024 px: the name shrinks with an ellipsis (full name as title), the folder pill hides under 1100 px of
  pane and the kind chip becomes its icon under 900 px (its words stay in the accessible name); `e2e/layout.mjs` checks no
  overlap and nothing past the topbar.
- First launch step 3 and the Home task box name the permission modes with the shared words (`lib/permissionWords.ts`);
  Home "Start run" still opens New run and never sends.
- The Inbox focuses its first row on arrival and the empty state names the teams with a run going; the attention sound,
  command palette and banners are unchanged.
- The Live run view is no longer "the shell's": the dock, header and hold card are in `impl-run.md` and `impl-run-header.md`.
- Not re-walked; screen reader, macOS unverified.
