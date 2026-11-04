# Engagement kind: renderer phase 1 (as built)

Source of the work: `docs/design/ux-review-engagement.md` (walk of OrgAI for a non-developer consultant). Contracts
live in `src/shared` (`Project.kind`, `client`, `referenceDirectories`; see ARCHITECTURE.md "Engagement kind (phase 1)").
This page is the renderer as built: what each surface says, its selectors, the storage keys and the grouping rules.
Wording is plain: "engagement", "client", "working folder", "reference folders". No repository, git or branch words in
an engagement's path.

## New project form (`components/dashboard/NewProjectForm.tsx`)

First control is the `project-kind` fieldset, legend "What is this project for?", two cards
(`project-kind-option[data-kind=code|engagement]`, each a `label` around a native radio named by its title and described
by its sentence). The last kind used is stored in localStorage `orgai.lastProjectKind` and checked on the next open; on
first launch nothing is checked, only the fieldset shows, and the submit is disabled with the hint "Choose what this
project is for." Initial focus is the checked radio, else the first (`NewProjectDialog` repeats it once the dialog is
open; the first-launch inline form does not take focus). Arrow keys move the choice (native radios).

| | Code project | Engagement |
| --- | --- | --- |
| Card text | "Software in a repository. Agents read and change the code, run tests and work in separate copies when several write at once." | "Work for a client or a case: research, analysis and documents. Agents read the material you point them to and write deliverables in one working folder." |
| Sub-switch | "Project type": New idea / Existing code | none (always an existing folder) |
| Name | placeholder "My app" / "Defaults to the folder name" | label "Name", placeholder "Client or case name" |
| Client | none | "Client or case (optional)", `new-project-client`, at most `PROJECT_CLIENT_MAX_CHARS` |
| Folder | "Folder to create it in" / "Repository folder" | "Working folder", hint "Where the team saves deliverables. Your files stay where they are." |
| Reference folders | none | "Folders the team may read (optional)": `new-project-ref-row` list, `new-project-ref-input` (Enter adds), `new-project-ref-browse`, `new-project-ref-add`, `new-project-ref-error`, hint "Agents can read files here. OrgAI refuses their file edits here, and every command that names this folder asks you first." (`REFERENCE_FOLDERS_HINT`, shared with the Permissions card) |
| Brief | "What do you want to build?" / "Anything the Architect should know? (optional)" | "What is the engagement about? (optional)" (hidden when agents were found and the import choice is not Architect) |
| Setup checkbox `architect-setup` | "Set up with the Architect (recommended)" | "Start with the setup interview (recommended)", description "Turn off to start with the standard engagement team." |
| Submit | "Create and start setup" / "Create project" | "Create and start interview" / "Create project" |

Reference rows refuse a relative path, a duplicate, more than the cap and any folder equal to, inside or containing the
working folder (`addReferenceFolder`, `lib/projectsForm.ts`, over `workingFolderRelation` in `lib/folderLists.ts`, case-
and separator-insensitive; main drops all three from both lists, so the UI refuses them first). Copy: "This is the
working folder. Agents can already change files in it." / "This folder is inside the working folder. Reference folders
must be outside it." / "This folder contains the working folder. Pick a folder outside it." (a code project says
"project folder"; both settings cards use the same helper). Submit re-checks the list against the working folder. A found-agents line
(`foundLine`, `agents-found`) shows for an engagement only when saved team members were found; instruction files
(CLAUDE.md, AGENTS.md) are not mentioned. The "Existing code" / "New idea" labels of the Code sub-switch replaced
"Existing repository".

Client and reference folders are saved after the project exists (`createProject(input, { onExtrasError })`). If that
save fails, or main kept fewer folders than were sent (or dropped the client; `droppedExtrasMessage`: "OrgAI did not keep
these folders: ..."), the project is kept, the form stays open with `new-project-extras-error` and the submit reads
"Open project".

## Project settings

- General: `project-kind-line[data-kind]` reads "Kind: Engagement" or "Kind: Code project"; engagements add a "Client or
  case" row (`project-client-input`, saves on blur and shows the value main returns, empty clears it).
- Permissions, inside the `permissions-summary` disclosure (`permissions-summary-toggle`): `reference-folders-section`
  "Reference folders (read only)" above `allowed-folders-section` "Allowed folders (read and change)". Rows
  `reference-folder-row[data-path]` / `allowed-folder-row`, an access label (`reference-folder-access` "Read only",
  `allowed-folder-access` "Can change"), a move button (`reference-folder-allow-changes` "Allow changes",
  `allowed-folder-make-readonly` "Make read only", one save), Remove, input `reference-folder-input` / `-add` /
  `-browse` / `-error`, and quiet `-notice` rows for folders main dropped. Adding a path that sits in the other list asks
  first ("Allow changes to it?" / "Make it read only?" ConfirmDialog; Cancel keeps both lists). The shared component is
  `FolderListSection` (`components/settings/AllowedDirectoriesSection.tsx`), pure helpers in `lib/folderLists.ts`.
  Summary line (`lib/permissionCopy.ts`): "2 reference folders, 1 folder you allowed". The saved-rules panel reads "Saved
  in OrgAI for this project." for an engagement (`rulesSavedIn('app')`).
- Maintenance: `maintenance-engagement-line` "OrgAI keeps its notes for this engagement in its own data folder. Nothing is
  written to your working folder."; no report-branch tools unless `isolateWriters` is on; no "Remove OrgAI files from
  repository" danger zone.

## Cards and text elsewhere

- Permission card: `perm-location[data-kind=reference]` "Touches a reference folder (read only): <folder>" (lock icon) when the request carries `referenceFolder`, plus `perm-reference-effect` ("This command names or runs inside a folder agents may only read..."); only Allow once and Deny, no rule chips, no "Fewer prompts" link. A file-tool location under a reference folder still reads "In a reference folder (read only)". Edit refusals are a quiet harness row "Refused: <file> is in a reference folder (read only)", no card.
- Architecture proposal card (`lib/projectKindCopy.ts`): title "Approve engagement plan", headings Engagement summary,
  Platforms and systems, Workstreams, Working agreements, Recurring procedures, Risks; apply note "Approving saves the
  engagement plan in OrgAI. Nothing is written to your folder."; settings apply note says "allowed actions", not
  `.claude/settings.local.json`.
- Needs-you rows (Sidebar list, dashboard) label the architecture proposal "Engagement plan: <title>" through
  `lib/decisionTitle.ts` `proposalKindLabel(kind, projectKind)` and `waitingItems(run, projectKind)`. Code and callers that
  pass no kind keep "Architecture".
- New run page lead for an engagement: "Give <root> a task. It plans the work and hands parts to the team. Each team
  member appears here when they start." (`newRunLead`); setup lead "The Architect looks through the folder and proposes a
  plan, a team and settings. You approve each one."

## Grouping by client (`lib/clientGroups.ts`)

- `groupByClient` makes client groups in first-seen order, keyed case-insensitively (the first spelling is the label),
  then "Other" (engagements with no client), then "Code" (code projects). Row order inside a group is the input order.
- Headers show only with two or more distinct real client names; with fewer the sidebar keeps today's flat list.
- Sidebar (full width): a header is a `button.nav-client-header` (`nav-client-group[data-client]`, `aria-expanded`,
  `aria-controls`, text "<Client> (N)", title the same). Collapsing hides that group's rows (`hidden`); while collapsed a
  count Badge shows open decisions in the group. Collapsed keys are stored in localStorage `orgai.sidebarClientGroups`
  (JSON array of group keys, at most 500, junk reads as empty) and survive a reload. "Other" has a header like a client;
  "Code" has a quiet label (`nav-client-code-label`), not a toggle.
- Rail (56 px): no headers; a `hr.nav-client-divider` (decorative) separates groups.
- Dashboard tile: `tile-client` line above the title for an engagement with a client.
- Topbar: `project-client` text after the project name (title = full client).
- Client text is the user's own: always a clamped text node, never markup or a link.

## localStorage keys

`orgai.lastProjectKind` (`code` | `engagement`), `orgai.sidebarClientGroups` (collapsed group keys).

## Verification

- e2e/engagement.mjs (in e2e:free, mock, 1600x1000 and 1024x640, dark and light): first-launch form, kind cards and
  focus, ArrowLeft/Right, reference-folder errors, creating three engagements (two for one client in different case,
  one more client) plus a Code project, General kind line and client edit across a reload, Permissions reference card
  (Read only, Allow changes, Make read only, summary count, order above Allowed, "Saved in OrgAI for this project."),
  Maintenance, sidebar grouping (headers, count, collapse, storage, reload, Enter), tile and topbar client, rail
  dividers, no horizontal overflow of the form, no window shift. Also e2e/permissions.mjs covers the reference card
  with its working-folder refusal.
- Unit-tested only: `projectsForm`, `clientGroups`, `folderLists`, `projectKindCopy`, `permissionCopy`, `settingsCopy`,
  `decisionTitle`, `needsYou`.
- Not seen in the app: the engagement architecture card, `perm-location[data-kind=reference]`, `NewRunPage` copy, the
  extras-save failure state.

## Not done

- M5: no "group by client" toggle on the topbar or the tiles, and no per-client totals (cost, runs).
- M6: the default permission mode for an engagement is unchanged (Unattended).
- M7: engagement wording beyond `NewRunPage` (run and team pages still speak in agent-framework words; the role inspector,
  the default chart's role names in the UI and the catalog copy).
- L4: Save as project still makes a "default team" code project. L5: a finished setup run still dominates the
  Dashboard. L6: the "Import agents" wording and vendor-folder list.
- The two folder cards each mount their own polite `role=status` announcer plus the notices list (not lifted into one
  shared announcer). Folder checks are lexical: a link into the working folder is only caught by main.
- The permission card's "Always allow for project" wording for a reference folder is unchanged (it reads as if a folder
  could be allowed; a reference folder never can be changed).
- NewRunPage title "Give X something to do" is unchanged; only the lead line differs.
- No deep link target for the reference folders card (`PROJECT_SETTINGS_SECTIONS` has no entry; the card id is
  `settings-section-reference-folders`).
- An extras-save failure keeps the form open with "Open project" instead of landing on the new project.
- The DecisionTray chip in `views/LiveRunView.tsx` (`PROPOSAL_KIND_LABEL[p.kind]`) still says "Architecture" for an
  engagement; switch it to `proposalKindLabel(kind, projectKindOf(project))` (file owned elsewhere).
- Not verified: contrast of the new client text and the kind cards was judged by eye in both themes, not measured.
