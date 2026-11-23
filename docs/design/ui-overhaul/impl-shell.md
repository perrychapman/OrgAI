# UI overhaul: shell and home (implementation notes)

Lead: ov-shell. Boards: Main, ProjectHome, EngagementHome, Empty, Inbox, Welcome, NewProject, Trust.
Status 2026-11-22: shell, sidebar, palette, banners, Welcome, NewProject and Trust are built; Home (sh-home), the project
Home tab (sh-projhome) and Inbox (sh-inbox) were still being built by engineers when this file was written. Their own
reports carry their sections; merge them in here once they land.

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
- **Welcome (`FirstLaunch.tsx`):**
  - The start choice is unchanged: radios "Start a project" and "Chat now", with the inline form. Many e2e helpers depend on it.
  - A side panel holds:
    - The steps (aria-current), taken from real state.
    - The real default connection, with Sign in / Change that opens App settings: Connections.
    - "What you are setting up": an Orchestrator card plus a neutral team card. There are no sample roles.
  - "Skip setup" shows the Empty board's "Start with a project" state (New project, Open Chat). It is remembered in `localStorage['orgai.welcome.skipped']`.
- **NewProject (`NewProjectForm.tsx`):**
  - The two kinds look separate: code is violet with a mono title, engagement is coral `--eng` with a serif title.
  - A "How they differ" table shows only while no kind is chosen.
  - The engagement text is neutral (no client or deliverable wording).
- **Trust (`settings/FolderTrustSection.tsx`, taken over from ov-settings for this run):**
  - Title "This folder comes with its own agent settings".
  - The path in mono (`folder-trust-path`), then a "What it would set up" label and glass item rows.

## Deviations

- **Opening a project:** it still lands on Live, not Home. Every area's e2e expects the composer after clicking `nav-project`.
- **Welcome:**
  - It is not a three-page wizard. `e2e/lib.mjs` `openProjectForm` and `assistants.mjs` drive the inline radio form.
  - The board's permission step is not drawn. Project permission defaults are set per project in Settings.
- **Trust:** there is no radiogroup. The real choice is binary (Allow these settings / Stop using these settings), and the buttons carry it.
- **Notices:** `AppNavigateBanner`, `RemapNotices` and `SecretNotices` keep their structure and take the restyled Banner primitive.

## Needs runtime

ov-runtime was asked for:
- a git summary and recent commits;
- schedule outcome history;
- month-to-date spend per project;
- test and dependency health (only if real data exists).

sh-projhome builds against whatever contract lands, and omits a section when its data is missing.

## Before and after, for the UX walk

- **Welcome:**
  - Before: a greeting and two radio cards.
  - After: the same choice plus a side panel with steps, the connection and its sign-in, what is being set up, and Skip setup.
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

- Merge the Home, project Home and Inbox engineer results, then run `dashboard`, `per-project`, `engagement`, `engagement2`, `clone-start`, `secrets-notices`, `runs`, `proposals` and `team-files`. Take screenshots in both themes and both sizes, and get a Reviewer pass.
- `scripts/e2e-select.mjs` has no mapping for the new files (`views/InboxView.tsx`, `views/ProjectHomeView.tsx`, `components/home/*`, `components/inbox/*`, `styles/onboarding.css`, `palette.css`, `banners.css`). Unmapped paths run everything.
- Ctrl+K is missing from the shortcuts table in `src/shared/view/shortcuts.ts`.
