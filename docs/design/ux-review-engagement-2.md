# UX review: engagement project kind, re-walk after phase 1

- Reviewer: UX Researcher (mock-data walkthrough, no code changes).
- Build: 1a2aee0 (dev, "Engagement kind: renderer phase 1"), `npm run build` in a worktree, version 0.1.6-dev1.
- How it ran: built Electron app driven by playwright-core through `e2e/lib.mjs` `launch()`, `ORGAI_MOCK=1`, a fresh
  temp `ORGAI_DATA_DIR` per script (three scripts, one relaunch). Sizes 1024x640 and 1600x1000 (`setContentSize`),
  dark and light through `settings.appearance.theme`. Keyboard-only passes: first launch (Tab from the page start),
  the New project form after choosing a kind with the arrow keys, and Project settings > Permissions at 1024x640.
  Custom `ORGAI_MOCK_SCRIPT` files (one per script) added a Read and a `type` command in the reference folder (walk 2)
  and a Write plus a `del` command in it (walk 3); everything else is the default mock, including
  `[mock:reference-edit]`. No tokens, no smoke scripts, no network.
- Persona: as in `ux-review-engagement.md`, a non-developer consultant. Fixtures are plain folders (no git): working
  folder `Acme Access Review 2026` (an engagement letter, kickoff notes), reference folder `Acme shared docs` (and in
  walk 2 a long `OneDrive - Acme Corp (Shared with consultant) Access policies and exports`), two more working folders
  for `Acme tax` (client typed `acme corp`) and `Birch review` (Birch LLC), a git fixture `notes-app` for the code
  project, and one library server `client-idp-admin` ("Admin tools for the client identity provider").
- Compared with: `docs/design/engagement.md` (as built) and the earlier walk `docs/design/ux-review-engagement.md`.
- Screenshots: `docs/design/ux-review-engagement-shots-2/NN-what-size-theme.png` (20). Walk scripts and raw text dumps
  (`raw1.json` .. `raw3.json`): `e2e/shots/ux/engagement-2/` (gitignored).
- Labels: "seen" = observed in the app; "read in code" = from source or CLAUDE.md, not observed; "mock-limited" = the
  mock cannot produce the real behaviour.

## Verdict

PARTLY FIXED. The phase 1 work holds up in the app: the kind cards are the first thing in the form and drive the
fields, the engagement form has no git or code words, approving every setup proposal left the working folder holding
only the user's own files (checked on disk, twice), the engagement plan card says "Approving saves the engagement plan
in OrgAI. Nothing is written to your folder.", the reference folders card, lock / "Read only" labels, moves and
refusals all work, Maintenance and Advanced no longer talk about git, "Your servers" leads Add a service, and client
grouping works in the sidebar, rail, tiles and topbar. Two things stop it from being safe for client material: a shell
command can still delete or change a file in a reference folder, and the card for it gives no hint that the target is
read-only client material (H1); and when OrgAI does refuse an edit, the transcript says "Edited <client file>" and
hides the reason behind a truncated "Failed:" row inside a folded report (H2). The approved engagement plan also
disappears from view after setup (M1).

## Ready for client work?

Not yet with the defaults. With the project switched to "Ask for everything risky" and the user reading every command
card, the edit gate makes reference folders safe against the file tools. But the reference folder hint promises "They
can never change, add or delete anything, in any permission mode", the default mode is still Unattended (earlier M6),
and the default Analyst role has Bash, so the one mistake this user cannot afford is still possible without a visible
warning. Fix H1 (at least the card and the hint) and the default mode before telling consultants to use it on live client
shares.

## Status of earlier findings

| Item | Status | Evidence |
| --- | --- | --- |
| H1 OrgAI files written into the deliverables folder | Fixed | After approving the permission card and all three proposals, the working folder held only `Engagement letter.txt` and `Kickoff notes.txt` (walk 1) / `Engagement letter.txt` (walk 2), no `.orgai`, `.claude` or `CLAUDE.md` (seen, listed on disk). Plan card effect line seen (shot 06); settings card "...saves any allowed actions for this project."; rules panel "Saved in OrgAI for this project." (shot 08). The code project created afterwards still gets `.orgai/ARCHITECTURE.md` and `CLAUDE.md`, as intended. |
| H2 no read-only folders; edits look routine | Partly fixed | Reference folders exist in the form and in Settings (shots 02, 08); `[mock:reference-edit]` showed no card for the Edit and left `brief.md` unchanged (seen); a Read card names the folder: "In a reference folder (read only): C:\...\OneDrive - Acme Corp ..." with a lock (shot 15). Open: shell commands (H1 below), the refusal row wording (H2 below), and the card's "Always allow" for reads (M2). |
| H3 own servers not findable in Add a service | Fixed | "Your servers 1" is the first section with `client-idp-admin` and "Add" (shot 18, 1024 light; also 1600 dark); "identity" finds it by description ("1 service"); empty copy "No service or saved server matches "zzzq"" with "Set up a custom server". The default list below still opens with AWS Knowledge, Context7, DeepWiki (see L5). |
| M1 form frames every folder as a repository | Fixed | Engagement form text has no "git", "repository", "stack" or "CLAUDE.md"; "code" and "repository" appear only in the Code card's own description (seen, `raw1.json formEng`). Labels match the spec table (shots 02, 03). |
| M2 setup opens with git and proposes a software architecture | Partly fixed, mock-limited | Card title "Approve engagement plan" with headings Engagement summary, Platforms and systems, Workstreams, Working agreements, Recurring procedures, Risks (shot 06); run title "Set up this project with me."; New run setup lead reworded (read in code). Still seen: the first card is "Run git status --short" with "Always allow for project" (shot 05, mock script); node activity "Proposing the architecture..." and transcript row "Proposed architecture" while the card says engagement plan (L4). The real interview was not reachable. |
| M3 default chart and inspector speak code | Partly fixed | Default engagement chart: Engagement Lead, Specialist, Analyst, Writer, Reviewer, described in work terms ("Works with data: extracts, comparisons, calculations and spreadsheets."). Inspector unchanged: "Read, Glob, Grep + Edit, Write, Bash", "What this role may do on your files and shell.", "a service such as GitHub or Slack" (shot 19). |
| M4 Maintenance and Advanced only talk git | Fixed | Permissions > Advanced shows only Let runs message each other ("Off by default for engagements."), Max automatic continues, Team assistant (shot 10). Maintenance is the one line (shot 11). Code project keeps its git rows and danger zone (shot 20). New gap: M1. |
| M5 cost numbers disagree, no export | Open | Not in phase 1 (spec "Not done"). Not re-measured. |
| M6 Unattended default for client work | Open | Every engagement created was `permissionMode: 'auto'`; Permissions shows "Unattended" and the run strip "unattended" (shots 10, 13). |
| M7 agent-framework words on run and team pages | Partly fixed | New run lead "Give Engagement Lead a task. It plans the work and hands parts to the team..." (seen). Still seen on an engagement: "Import agents", "Export to repo", "I look at this repo, your computer and your library first.", transcript "Continuing: asked the orchestrator to write a plan before it works." (shot 13). |
| M8 rules panel is a developer grammar | Partly fixed | "Saved in OrgAI for this project." and placeholder "WebSearch" (seen, shot 08); examples are WebSearch, WebFetch, `mcp__<your server>` (read in code, `ruleExamples('app')`). Rule rows still show raw rules first (no rule saved in this walk; card chips still read `Bash(git status:*)`, shot 05). |
| L1 Catalog copy assumes a repository and a vendor tool | Open | "...or import the skills in your repository.", "Claude Code plugin folders that bundle skills, tools and commands." on an engagement Catalog (seen, `raw2.json`). |
| L2 "without asking" hint | Fixed | "Agents may read and change files here, with the same permission mode as the working folder." (shot 08). |
| L3 kind not first, Save as project focus | Partly fixed | Tab from the page reaches "Start a project" then the "Code project" radio; ArrowRight chose Engagement; the dialog opens focused on the checked (last used) kind (seen). Save as project not re-walked. |
| L4 Save as project makes a code project | Open | Spec "Not done"; not walked. |
| L5 finished setup run dominates | Open | After "Setup complete" the Architect node reads "Waiting for your reply" and the run stays Idle until End session (shot 07). |
| L6 Import agents wording | Partly fixed (not driven) | The found line shows only when agents exist (spec); no agent files in these fixtures, so not seen. The Team toolbar still says "Import agents". |
| dashboard-2 M4 first launch scrolls at 1024x640 | Open, larger | With the engagement form open the dashboard is 1103 px in a 592 px viewport; the submit sits at y=722 in a 640 px window (`raw1.json formFit`). It scrolls, so it is reachable. |
| dashboard-2 L3 wordmark "( MOCK Dev" | Open | Shots 12, 13, 16 at 1600. Mock and dev builds only. |

Proposal sections of the earlier walk: "Where the kind choice belongs" is built as proposed (shots 01-03). "Reference
folders" is built except the shell path, the refusal row, the reads-never-ask rule and the "Always allow" wording.
"Engagement grouping" is built for sidebar, rail, tiles and topbar; the dashboard "Group by client" toggle and per-client
totals are not (spec "Not done"). "Copy to keep neutral" is done for the form, cards, settings and Maintenance, not for
the Team tab, inspector, Catalog or transcript rows.

## Findings, ranked

### H1. A shell command can delete a file in a reference folder, and its card does not say so

- Where: Live run, permission card (shot 14) and transcript (shot 13); the reference folder hint in the form and in
  Settings > Permissions (shots 02, 08).
- Flow: engagement with `Acme shared docs` as a reference folder; a mock run whose root calls
  `del "C:\...\Acme shared docs\brief.md"` (custom mock script, `ask: true`).
- What the user sees: "Run del "C:\...\Acme shared docs\brief.md"", location "Starts in the project", "No rule can cover
  this command", buttons Allow once / Deny, same amber Command styling as any command. After Allow once the transcript
  says "Ran `del "C:\...\Acme shared docs\b...`". A `type` (read) command on the same folder is likewise "Starts in the
  project" with "Always allow for project: stops asking for "type" commands" (`raw2.json refReadCards`).
- Why it matters: the settings card says agents "can never change, add or delete anything, in any permission mode",
  and the form says "Read only. Agents can never change files here." Neither is true for commands: CLAUDE.md states
  "Bash writes there are NOT gated" (read in code). The default engagement Analyst has Bash, and the default mode is
  Unattended, where the model's safety check may approve such a call with no card at all (read in code; the mock
  forces a card, so mock-limited). The mock does not execute commands, so the file survived here; a real run would
  delete it.
- Likely owner: main runtime (`src/main/runtime/referenceDirectories.ts`, the Claude PreToolUse hook in `claude.ts`,
  the Codex command approval in `codex.ts`, mock parity in `mock.ts`); renderer `lib/permissionCopy.ts` (location kind for
  commands), `components/settings/AllowedDirectoriesSection.tsx` and `NewProjectForm.tsx` (hint copy).
- Fix:
  1. Copy now, whatever the runtime does: settings hint "Agents can read files here. OrgAI blocks file edits here in
     every mode, and any command that names this folder always asks you first."; form hint "Read only. Agents can
     read these files; edits are blocked and commands that touch them ask you first."
  2. Card: when a command's arguments name a path under a reference folder, `perm-location[data-kind=reference]` reads
     "Touches a reference folder (read only): C:\...\Acme shared docs" with the lock, and the card offers only
     "Allow once" and "Deny" (no session or project rule).
  3. Main: such a command always asks (never auto-approved in Unattended or Auto-accept, never covered by a saved
     rule); a recognised write or delete (del, erase, rm, move/mv, copy/cp to it, ren, rd, Remove-Item, Set-Content,
     Out-File, redirection into it) is refused like an Edit, with the same refusal row.
- Checkable: with the walk-3 mock script, the `del` card shows `perm-location[data-kind=reference]` and no
  "Always allow for project"; in Unattended the card still appears; the settings hint no longer says "never ... in any
  permission mode" unless main refuses shell writes.

### H2. A refused edit reads as "Edited <client file>"; the reason is cut off and folded away

- Where: report transcript in the side panel (shot 12), root transcript (shot 13), canvas "1 done" group, Logs tab.
- Flow: `[mock:reference-edit]` (a report reads then edits `brief.md` in the reference folder), or the walk-3 script
  (the root writes `notes.md` there).
- What the user sees: the root transcript says only "Handed work to engineer-1" and "Reviewed the client material; it
  is read-only, so notes go in the project folder." The report folds into "1 done" with Hide finished agents on. Opening
  it shows "Edited C:\...\OneDrive - Acme Corp (Shared with consultant) Access policies and exports\brief.md" then a red
  "Failed: C:\...\OneDrive - Acme Corp (Shared with consultan..." whose reason is behind "Show output". For the root's
  Write: "Wrote C:\...\Acme shared docs\notes.md" then "Failed: C:\...\Acme shared docs is a reference folder: age...".
  Only Logs says it plainly: "Blocked Edit by Engineer: ... is a reference folder: agents may read it, not change it".
- Why it matters: the first words the user reads are "Edited" / "Wrote" next to a client file. The earlier checkable
  ("Refused: <file> is in a reference folder (read only)") is not met, and nothing at run level says a change was
  blocked, so the user cannot tell whether the client copy was touched without opening a folded report and expanding
  output.
- Likely owner: `src/renderer/src/lib/transcriptRows.ts` (call-row verb and result-row text), `TranscriptPanel.tsx`,
  `lib/foldFinished.ts` (group badge); main for a harness row on the root (`source: 'harness'`), `RunMeta` for a count.
- Fix: when a file tool's result is a reference refusal, render one row "Refused: brief.md is in a reference folder
  (read only)." (file name first, folder path in details, lock icon, quiet warning tone) and drop the "Edited" / "Wrote"
  verb for that call ("Tried to edit brief.md" if two rows are kept). Add a harness row to the root transcript
  "OrgAI blocked 1 change to a reference folder (engineer-1)." and a "1 blocked" badge on the `done-group` and in
  `run-meta`. Path rows clamp from the middle so the file name survives.
- Checkable: after `[mock:reference-edit]` the root transcript contains "blocked 1 change", the report's rows contain
  "Refused: brief.md" and no row starting "Edited" for that file; `done-group` carries the badge.

### M1. The approved engagement plan cannot be seen or revised after setup

- Where: Project settings > Maintenance (shot 11) compared with a code project (shot 20); General; Team.
- What the user sees: the code project keeps "Architecture document / Not edited by agents since setup. / Review with
  the Architect". The engagement shows only "OrgAI keeps its notes for this engagement in its own data folder. Nothing is
  written to your working folder." There is no place to read the plan the user approved or to rerun the interview;
  the preload has no call that reads it (read in code: `MaintenanceSection.tsx` shows the row only for
  `setup.architecturePath`; `ENGAGEMENT.md` is read only by main for prompts).
- Why it matters: the plan is what every agent reads at the start of every run. Moving it out of the client folder
  (correct, H1) also made it invisible, and a consultant needs to check it when the scope changes.
- Owner: `components/settings/MaintenanceSection.tsx`, a read-only IPC for the engagement document (main
  `store/projectData.ts`, contract in `src/shared/types.ts`).
- Fix: Maintenance (or General) row "Engagement plan" / "Approved 3 Nov 2026. Agents read it at the start of every
  run." with "View plan" (read-only disclosure rendering the same headings as the card) and "Review with the
  Architect" (setup prompt "Review the engagement plan with me and propose changes."). Keep the "Nothing is written to
  your working folder." line under it.
- Checkable: after an engagement setup, Maintenance shows `engagement-plan-row` with View and Review; View shows
  "Engagement summary".

### M2. A read in a reference folder offers to allow every Read in the project

- Where: permission card for a Read under the reference folder (shot 15; mock forces the card with `ask: true`).
- What the user sees: the location line is right ("In a reference folder (read only): ..."), but the card says "Always
  allow for project: stops asking for every Read call in this project." with an amber "Read whole tool" chip, and the
  same for the session.
- Why it matters: for client work "every Read call" means any file on the machine, including other clients' folders.
  The user only wanted to stop being asked about this one folder. The spec's own "Not done" list notes the wording.
- Owner: `lib/permissionCopy.ts`, `components/PermissionCard.tsx`, suggestions in `src/main/runtime/permissionRules.ts`.
- Fix: for a read whose target is in a reference folder, the project option reads "Always allow reading this reference
  folder" and saves nothing broader (reads there need no rule at all once reads in reference folders never ask, as the
  earlier walk proposed: "no card in any mode except Ask for everything risky").
- Checkable: the walk-2 Read card has no `data-broad` chip and no "every Read call" text.

### M3. Defaults still leave a client project on Unattended with Bash for the Analyst

- Where: every new engagement (`permissionMode: 'auto'`), Permissions (shot 10), Team inspector (shot 19).
- Same as earlier M6, raised because H1 makes it worse: Unattended plus an ungated shell plus a Bash-holding Analyst is
  the path by which a client file can change with no card. Owner: `newProject` per kind (main `src/shared/defaults.ts`),
  `engagementRoles`. Fix: engagements start on "Ask for everything risky"; the Analyst gets Bash only when the
  interview says data work needs it, else Read, Glob, Grep, Write. Checkable: a new engagement's mode select value is
  `default`.

### L1. The client group label takes the spelling of the newest project

- Shot 16: the user created "Acme access review" with client "Acme Corp", then "Acme tax" with "acme corp". The header
  reads "acme corp (2)" while the older tile says "Acme Corp". `groupByClient` uses first-seen order of the sidebar list,
  which is newest first. Owner `lib/clientGroups.ts`. Fix: label a group with the spelling of its oldest project (or the
  most used spelling); optionally show that label on every tile of the group. Checkable: the header reads "Acme Corp (2)".

### L2. Folder rows cut off the folder name at 1024x640

- Shot 08: "C:\Users\chapp\AppData\Local\Temp\orgai-ux-eng2-tMuryK\Acme shar..." beside "Read only". The full path is
  in the row's title (seen), but the part that tells two shares apart is the last segment. Owner
  `components/settings/AllowedDirectoriesSection.tsx` (`FolderListSection`), `lib/paths.ts`. Fix: middle ellipsis that
  keeps the last segment ("C:\...\Acme shared docs"), as the permission card already does (shot 15).

### L3. Moving a folder between lists sends focus to the old list's path field

- Settings > Permissions, keyboard: after "Allow changes" focus lands on `reference-folder-input`, after "Make read
  only" on `allowed-folder-input` (seen, `raw1.json`). The polite status "Moved ... to allowed folders (read and
  change)." is announced, so nothing is lost, but the user then has to find the row again. Fix: focus the moved row's
  counterpart button ("Make read only" / "Allow changes") so a mistaken move is one keypress to undo.

### L4. Setup still says "architecture" while the card says engagement plan

- Shots 05, 06: node activity "Proposing the architecture...", transcript rows "Proposed architecture" and the mock
  Architect's "I will look at the repository first" (mock text). Owner `src/main/runtime/activity.ts` and
  `lib/transcriptRows.ts` (tool labels per project kind). Fix: "Proposing the engagement plan..." / "Proposed the
  engagement plan" for engagements. The `DecisionTray` chip ("Architecture", spec "Not done") belongs here too; not seen
  because only one card was open at a time.

### L5. Add a service still opens with developer documentation tools

- Shot 18: under "Connect a new service 38" the first five are AWS Knowledge, Context7, DeepWiki, Exa, Microsoft Learn
  (keyless first by ease). Fine for code; for an engagement the useful ones (Gmail, Google Drive, Notion, Box, Slack)
  are far down. Owner `lib/connectors.ts` `sortForGallery`. Fix: for an engagement project, rank the categories
  docs/knowledge, files, email, chat, meetings, crm above developer tools. Checkable: an engagement's first five
  include none of AWS Knowledge, Context7, DeepWiki.

### L6. The rail drops the client

- Shot 17: the 56 px rail shows the dividers and initials (BR / AT, AA), and each row's label is the project name only.
  A collapsed group still shows its rows in the rail (intended, but the collapse has no effect there). Owner
  `Sidebar.tsx`. Fix: the rail row tooltip and accessible name read "Acme tax, acme corp".

### L7. The disabled submit hides its reason from keyboard users

- First launch and the form at 1024x640: the submit is disabled until a kind and a working folder are chosen, the hint
  ("Choose what this project is for." / "Choose the working folder.") sits beside it, but the button is skipped by Tab
  and has no `aria-describedby` (seen, `raw3.json`). Owner `NewProjectForm.tsx`. Fix: keep the submit focusable with
  `aria-disabled` and point `aria-describedby` at the hint, or announce the hint on submit.

## Code project after engagements (task 7)

- Last-kind memory works: the dialog opened with Engagement checked and focused after three engagements, and with Code
  after the code project (seen).
- Nothing engagement-specific leaked: Code form "Repository folder", "Git repository found. The Architect scans it and
  reads the code...", "Create and start setup"; setup cards "Approve architecture proposal" with Stack / Modules /
  Commands and "Approving writes .orgai/ARCHITECTURE.md into the working directory and references it from CLAUDE.md.";
  rules panel "Saved in .claude/settings.local.json in the project folder."; Advanced "Isolate writers in worktrees -
  Automatic: git repository found."; Maintenance with branches and danger zone (shot 20); no topbar client, sidebar
  under a quiet "Code" label.
- Shared on purpose: the Reference folders card also shows for code projects ("No reference folders. Add folders
  agents may read but never change."), carrying the same H1 caveat.
- The code setup also proposed linking `client-idp-admin` from the library (mock), which is correct behaviour.

## Click counts

| Task | Earlier walk | Now |
| --- | --- | --- |
| Create an engagement with client and one reference folder | 6-7 with code wording | 6: Engagement card, Name, Client, Working folder, reference path + Add, Create and start interview |
| Add a read-only share later | Not possible | 4 plus typing: Settings, Permissions, Show, type path, Add folder |
| Give roles a library server | 6 plus roles | 5 plus roles: Team, Catalog, Add a connection, Add (Your servers), pick roles, Add to project |
| Read back the approved plan | n/a (it was in the folder) | Not possible (M1) |
| See why an edit to client material failed | n/a | 4: expand "1 done", click the report, find the red row, Show output (or the Logs tab) (H2) |

## Suggested order of work

1. H1: card location and "Allow once only" for commands that name a reference folder, and the hint copy (renderer, quick);
   then the main-side ask/refuse rule for shell commands in every adapter (Runtime, with a Reviewer pass).
2. M3 / earlier M6: engagement default mode "Ask for everything risky"; review the Analyst's Bash.
3. H2: refusal rows and the run-level "blocked" row and badge.
4. M1: engagement plan row with View and Review in Maintenance (needs a read-only IPC).
5. M2: reference-folder read wording and rule scope.
6. Copy sweep still open from the first walk (M3 inspector, M7 Team tab, L1 Catalog, L4 here), then L1-L3, L5-L7.

## Not driven

- The real Architect interview (mock-limited): its questions, whether it still runs `git status` in a plain folder, and
  real plan content. Only the mock script ran.
- Real effects of commands and edits: the mock executes nothing, so whether Unattended would auto-approve the `del` and
  whether Claude's PreToolUse refusal reaches the model as shown are unverified here.
- Codex and LiteLLM connections, so Codex's reference gate was not seen.
- Native folder pickers (Browse); every path was typed.
- The extras-save failure state ("OrgAI did not keep these folders"), Save as project (L3, L4), the Needs-you row label
  "Engagement plan: <title>" (the sidebar Needs-you list stayed collapsed) and the DecisionTray chip with two cards open.
- Agent files in an engagement folder (the found line and import wording, L6 of the first walk).
- Contrast of the client text and kind cards was judged by eye in both themes, not measured.
- The New project form at 1600x1000 was walked for the Code kind only (shot k01 in the scratch folder); the engagement
  form was walked at 1024x640 in both themes.
