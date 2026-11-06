# UX review: engagement project kind, phases 2-3 (third walk)

- Reviewer: UX Researcher (mock-data walkthrough, no code changes).
- Build: 6d98b4d (dev, "UI Lead: Engagement phase 2-3 renderer"), `npm run build` in a worktree, version 0.1.6-dev1.
- How it ran: built Electron app driven by playwright-core through `e2e/lib.mjs` `launch()` (a small scratch eval server
  under `e2e/shots/ux/engagement-3/`, gitignored), `ORGAI_MOCK=1`, one fresh temp `ORGAI_DATA_DIR`. Sizes 1600x1000 and
  1024x640 (`setContentSize`), dark and light through `settings.appearance.theme`. One keyboard-only pass at 1024x640
  dark (Team > Templates menu and save dialog, New run Team / Ask switch, plan editor, context notes add / remove,
  Forget confirm). The kit's native save / open dialogs were stubbed in the main process (`dialog.showSaveDialog` /
  `showOpenDialog` replaced for the export and import, then restored) so the export file and the import preview could
  be walked; nothing else was faked. No tokens, no smoke scripts, no network. I also ran `node e2e/presets.mjs` once
  (token-free) to confirm H1.
- Persona: a non-developer consultant with two clients. Fixtures (plain folders, no git): `Acme Access Review 2026`
  (working folder, an engagement letter) with reference folder `Acme shared docs`; `Acme tax 2026` (client typed
  `acme corp`); `Birch LLC review` (Birch LLC); `Cedar Holdings` (setup left pending); a git fixture `notes-app` for the
  code project; library servers `client-idp-admin` (per-project `TENANT_URL` and per-project secrets `API_TOKEN`) and
  `shared-drive` (library secret `DRIVE_TOKEN`), seeded through `mcpLibrary.upsert` and `mcp.linkLibrary` as
  `e2e/per-project.mjs` does.
- Compared with: `docs/design/engagement-2.md` (spec and its Implementation notes), `docs/design/engagement.md`, and the
  earlier walks `ux-review-engagement.md` (W1) and `ux-review-engagement-2.md` (W2).
- Screenshots: `docs/design/ux-review-engagement-shots-3/NN-what-size-theme.png` (20). Raw dumps and the other shots
  stay in `e2e/shots/ux/engagement-3/`.
- Labels: "seen" = observed in the app; "read in code" = from source, not observed; "mock-limited" = the mock cannot
  produce the real behaviour.

## Verdict

PARTLY READY. Most of phases 2-3 works on the first try and reads well: saving a team as a template, starting a
second engagement from it, replacing a team and undoing it, the Ask switch and its conversation (including continuing
an ended Ask in the same tab), the engagement plan view / edit / stale refusal, context notes, Forget this engagement
(the project, its runs, plan and notes really are gone, the folders are untouched), the Trends month picker and Copy as
CSV, per-project values with the project-only copy, and the kit export and import preview. The defaults finally start
an engagement on "Ask for everything risky" with run messaging off. One feature is dead in the built app: a preset
cannot be saved at all ("Custom connectors are not available.", H1), which also turns `e2e:free` red. The rest is
friction that a consultant will hit in week one: the plan cannot be edited until they find and end the finished setup
session (M1), a plan review can silently replace their hand edits (M2), the Ask switch is squashed (M3), and the usage
export still cannot be billed per client (M4, M5).

## Ready for client work?

Closer, not yet. What now holds: nothing OrgAI writes lands in the client's folder, reference folders refuse file
edits, a new engagement asks before every edit and command, cross-run messaging is off, and a finished engagement can be
forgotten completely. What still stands in the way:

1. The default Analyst still has Bash, Edit and Write (seen in the inspector on a fresh engagement). Under "Ask for
   everything risky" each command asks first, so this is now a card-reading risk, not a silent one; but one click on a
   card's "Always allow for project" for an edit moves the whole project to Auto-accept edits (Permissions help text,
   seen), and shell writes into a reference folder are only covered by the ask (W2 H1, main side not re-walked).
2. A refused edit to client material still first reads "Edited <client file>" and a red "Failed:" row inside a folded
   report; the new "Refused: brief.md is in a reference folder (read only)" row is there but last, and nothing on the
   root or the canvas says a change was blocked (W2 H2, shot 20).
3. Billing: the CSV has no client or engagement column and UTC timestamps (M5).
4. Presets for client systems do not work at all (H1).

Fix H1 before anything else (it blocks the dev gate); then M1 and M2, which decide whether the plan is trustworthy.

## Status of earlier findings

| Item | Status | Evidence |
| --- | --- | --- |
| W2 H1 shell command can change a reference folder; card says nothing | Partly fixed (copy seen; card and main not re-walked) | Form and Settings hints now read "Agents can read files here. OrgAI refuses their file edits here, and every command that names this folder asks you first." (seen at 1600 and 1024). The default Analyst prompt says the same (read in code, `defaults.ts`). The `del` card and the main-side ask were not re-run (needs the W2 walk-3 mock script). |
| W2 H2 refused edit reads as "Edited <client file>" | Partly fixed | `[mock:reference-edit]` on Acme: the report now ends with "Refused: brief.md is in a reference folder (read only)", but "Edited C:\...\Acme shared docs\brief.md" and a red "Failed: C:\...\Acme shared docs is a reference folder: agen..." still come first; the root transcript has no "blocked" row and the "1 done" group carries no badge (shot 20). |
| W2 M1 approved plan invisible after setup | Fixed, with a new problem | Settings > General > Engagement plan shows the rendered plan in a focusable region (role region, label "Engagement plan"), the revised line "Approved in the setup interview, Nov 4, 2026" (full time in title), Edit and Review in the setup interview (shot 08). Edit is blocked while the finished setup run sits Idle (new M1). |
| W2 M2 Read in a reference folder offers "every Read call" | Not re-walked | `e2e/engagement.mjs` asserts no rule chips and no project scope on that card (read in code). |
| W2 M3 / W1 M6 defaults: Unattended, Bash for the Analyst | Partly fixed | Three new engagements stored `permissionMode: 'default'`; Permissions shows "Ask for everything risky / Every edit and command asks. Most prompts."; `runMessaging` unset and Advanced says "Off by default for engagements." (seen). The Analyst still has `Read, Glob, Grep, Bash, Edit, Write`; inspector "Read, Glob, Grep + Edit, Write, Bash" (seen). The run strip no longer says "unattended". |
| W1 M5 cost numbers, no export | Partly fixed | Month picker (current month "November 2026, so far" plus 23 earlier), Copy as CSV ("Copied 3 runs as CSV.", clipboard read back in main), setup runs counted (By kind "Setup 3"). Open: M4 and M5 below. |
| W1 M7 agent-framework words on run and team pages | Open | Engagement Team toolbar "Import agents", "Export to repo"; Team assistant "I look at this repo, your computer and your library first."; inspector "Slug (subagent type)", "Nobody (root orchestrator)", "System prompt"; setup-pending page "The Architect looks through the folder..." (seen). |
| W1 M8 rules panel developer grammar | Not re-walked | No rule was saved in this walk. |
| W1 L1 Catalog copy assumes a repository | Open | "Write one, add one from the library, or import the skills in your repository.", "Claude Code plugin folders that bundle skills, tools and..." (shot 01). |
| W1 L3 / L4 Save as project | Not walked | Out of this brief. |
| W1 L5 finished setup run stays Idle | Open, now blocks plan edits | After "Setup complete" the Architect reads "Waiting for your reply" and R1 stays Idle; every "Review in the setup interview" run does the same (new M1). After End session the setup run shows "Stopped" in the sidebar although setup completed. |
| W2 L1 client group label takes the newest spelling | Open, worse | The header flips with sidebar order: "acme corp (2)" (shot 03) and "Acme Corp (2)" (shots 02, 04) in the same session, while the topbar of the older project says "Acme Corp". |
| W2 L2 folder rows cut the folder name | Fixed | At 1024x640 the reference row wraps the whole path, last segment visible ("...\Acme shared docs"). |
| W2 L3 focus after moving a folder | Fixed | "Allow changes" leaves focus on the moved row's "Make read only", and back (seen). |
| W2 L4 setup says "architecture" | Open | Node "Proposing the architecture...", transcript "Proposed architecture", Architect "I will look at the repository first" (mock text) on a plan review run (shot 10). |
| W2 L5 developer tools first | Open (seen elsewhere) | Add a service not re-opened; the Team assistant recommends DeepWiki to the Specialist ("Ask questions about public GitHub repositories") on an engagement (shot 16). |
| W2 L6 rail drops the client | Open | Rail rows' names: "Acme access review", title adds the path and status, no client (seen at 1024). |
| W2 L7 disabled submit hides its reason | Fixed | Submit stays focusable with `aria-disabled="true"` and `aria-describedby` pointing at the hint (seen). |
| dashboard-2 L3 wordmark "( MOCK Dev" | Open | Every 1600 shot. Mock and dev builds only. |
| dashboard-2 M4 first launch scrolls at 1024x640 | Not re-measured | |

## Findings, ranked

### H1. A preset cannot be saved: "Custom connectors are not available."

- Where: App settings > Connectors > Your presets > Add a preset (`preset-form`), shot 18; App settings > Templates and
  kit > Export ("Your presets (0) / Nothing to export.").
- Flow: Add a preset, Name "Birch vendor portal", What it does, Category, Search words, Remote address
  `https://portal.birch.example/mcp`, Paste a token (prefix "Bearer ", where to get it), one access option "Read only /
  Can read", Save preset.
- What the user sees: at 1600x1000 the click seems to do nothing: the dialog body is scrolled to Access options, the
  danger banner "Could not save the preset / Custom connectors are not available." sits at the top of the body out of
  view, and focus falls to the page body. Scrolling up shows the banner (shot 18). `connectorPresets.list()` stays
  empty. Everything after it in the brief's task 7 is unreachable: the "Yours" tile, adding it to a project, Edit, and
  the remove refusal while in use.
- Why it matters: the feature exists to describe client systems; it is visibly offered and cannot work. `e2e:free` is red
  at this build: `node e2e/presets.mjs` fails at "saving closes the form" (run once, token-free).
- Cause (read in code): `src/main/index.ts:295` constructs `McpService` without `dataDir`, so `service.ts:266` leaves
  `presets` undefined and every upsert throws (service.ts:587 / 1243). The same missing `dataDir` makes built MCP
  servers refuse staging ("Built servers cannot be saved here: no data folder is configured.", service.ts:1679); not
  walked, please check.
- Owner: main `src/main/index.ts` (one argument); renderer `components/connectors/PresetForm.tsx` for the hidden banner.
- Fix: pass `dataDir` to `McpService` in index.ts. In the form, when main refuses, scroll the body to the banner with
  `lib/scrollWithin.ts` and move focus to the banner (or keep it on Save with `aria-describedby` to the banner).
- Checkable: `npm run e2e:free` passes `e2e/presets.mjs`; saving the preset above shows a tile with
  `connector-tile[data-custom=true]` and "Yours"; forcing a main refusal leaves the banner inside the dialog's visible
  body and focus on it.

### M1. The plan cannot be edited after setup until the user ends a session they think is over

- Where: Settings > General > Engagement plan (shot 08), Live run strip.
- Flow: create an engagement with the setup interview, approve the four cards ("Setup complete"), open Settings >
  General.
- What the user sees: Edit and "Review in the setup interview" are disabled with "The setup interview is running. Edit
  after it ends." The setup is complete; R1 just sits Idle with the Architect "Waiting for your reply". The user has to
  go to Live, find End session on the setup tab, come back and click Edit (6 clicks instead of 2). Every "Review in the
  setup interview" run leaves another Idle setup run that blocks the plan again. After End session the sidebar says
  "Last run ... Stopped" for a setup that succeeded.
- Why it matters: the moment a consultant reads the plan and wants to fix one line is right after setup.
- Owner: `components/settings/EngagementPlanSection.tsx` (`setupLive`), runtime end of setup (W1 L5).
- Fix: count a setup run as busy only while it is running or has an open card (Idle after `setup.state === 'complete'`
  does not block); or end the setup session automatically after "Setup complete". Until then, the busy line offers the
  way out: "The setup interview is still open. End it to edit the plan." with an "End the interview" button.
- Checkable: after the mock setup completes, `engagement-plan-edit` is enabled without touching the Live tab.

### M2. Reviewing the plan in the setup interview can replace hand edits with no comparison

- Where: Settings > General > Review in the setup interview, then the plan card on Live (shot 10).
- Flow: edit the plan by hand ("Quarterly user access review of SAP and Workday..."), Save ("Edited by you, Nov 4,
  2026"), click Review in the setup interview, approve the cards.
- What the user sees: the card "Approve engagement plan" shows a whole new plan with no hint that it replaces the text
  they wrote; after approving, their summary is gone and the line reads "Approved in the setup interview, Nov 4, 2026"
  again (seen; mock-limited: the mock always proposes the same plan, a real Architect reads the current one). The review
  run also re-proposes the org chart and run settings (mock-limited).
- Why it matters: the plan is what every run reads; a silent overwrite of the consultant's correction is the kind of
  loss they cannot spot later.
- Owner: renderer proposal card for the plan (`components/proposals/*`, plan body), `lib/engagementContext.ts`
  `planRevisedLine`, main for the "previous text" on the request.
- Fix: when a plan already exists, the card's effect line reads "Replaces the plan you edited on 4 Nov 2026." with a
  "Show changes" disclosure (lines added and removed); the revised line after an approval over an existing plan reads
  "Revised in the setup interview, <date>" (spec section 5).
- Checkable: after a hand edit, a review's plan card contains "Replaces the plan you edited"; after approval
  `engagement-plan-revised` starts with "Revised in the setup interview".

### M3. The Ask switch is squashed into a two-row box and the mode label is cut

- Where: New run composer, Ask selected (shots 05 at 1600, 06 at 1024).
- What the user sees: with Team selected the switch is one row ("New run [Team | Ask]"). With Ask selected the label
  becomes "New conversation with one ass..." and the segmented control wraps into a 93 x 59 px box with Team above Ask,
  at both sizes; the hint is cut as well.
- Why it matters: it is the control the user just used; it looks broken and the cut label hides what Ask does.
- Owner: `components/NewRunPage.tsx` (mode label), composer mode row styles.
- Fix: modeLabel "Ask one assistant"; the segmented control never shrinks (`flex: none; white-space: nowrap`), the mode
  row wraps the hint under 560 px as the spec says.
- Checkable: `[data-testid=new-run-mode]` is one row (height about 32 px) in Ask mode at 1024x640 and 1600x1000, and the
  mode label is not ellipsised.

### M4. Trends "By role" repeats the same role once per run

- Where: History > Trends, By role (shot 14).
- What the user sees: "Architect 3.3k $0.0057 1 36%", "Architect 3.3k $0.0057 1 36%", "Architect 2.5k $0.004275 1
  27%" for three setup runs; on Birch "Assistant" twice for two Ask sessions.
- Why it matters: the table is meant to show which role costs what; three rows with one name cannot be read or added up.
- Owner: `lib/trends.ts` / `components/UsageTrends.tsx`.
- Fix: aggregate by role name (or slug) across runs: one "Architect 9.0k $0.01568 3 100%" row.
- Checkable: after three setup runs By role has exactly one Architect row with Runs 3.

### M5. The CSV still cannot be billed per client

- Where: History > Trends > Copy as CSV (clipboard read in main).
- What the user sees: header `started,ended,kind,status,title,roles,tokens_in,tokens_out,tokens_cache_read,
  tokens_cache_write,cost_usd,cost_partial`; times are UTC ISO (`2026-11-04T13:52:31.630Z` for a run started 8:52 AM
  local); an Ask run is `work`; runs the UI calls Stopped are `finished`; `roles` is a count (1). No Client or Engagement
  column (the spec asks for both, first).
- Why it matters: this is the export for invoicing two clients. Pasting two months or two engagements into one sheet
  loses which row belongs to whom, and the dates are off by the time-zone offset.
- Owner: main `runUsage.ts` (`USAGE_CSV_COLUMNS`), renderer `UsageTrends.tsx`.
- Fix: columns `Client, Engagement, Date, Start time, End time, Run, Kind, Status, Tokens, Estimated cost (USD), Cost
  note` in local time; kind "ask" for `team: 'single'`; status words from `lib/runStatus.ts`; drop or rename `roles`
  ("agents").
- Checkable: an engagement's copied CSV starts `Client,Engagement,` and an Ask row says `ask`.

### L1. Plan stale banner loses focus and hides its copy action behind an icon

- Shot 09. After the refused save focus falls to the page body; the banner is `role=status`; "Copy my text" is an
  unlabelled copy icon (accessible name present) while the text says "Copy it". Saving again stays refused (good). Fix:
  focus the banner title (or `role=alert`), give the copy button its visible label "Copy my text".

### L2. The plan editor shows raw Markdown and is short at 1600x1000

- Shot 09. The editor shows `## Risks`, backticks and `_Maintained by OrgAI..._`; 10 rows at 1600x1000 (spec 16). Fix:
  a one-line hint "Lines starting with ## are headings." and 16 rows on tall windows.

### L3. The month picker stretches across the whole controls row

- Shot 15: the native select is 936 px wide at 1024 and 1336 px at 1600, pushing Day / Week and the CSV buttons to a new
  row. Fix: size it to its content after the range control.

### L4. Focus and stale status after template removal and kit import

- Removing a template sends focus to the page body; after a kit import focus also lands on the body, and the polite
  line "Removed the template Client review team." stays above the re-imported template. Fix: focus "Import a kit..."
  or the new row; clear the section status on the next change.

### L5. Forget confirm wording

- Shot 12: "Ends 1 open run and deletes 1 run with its transcripts and costs" reads as two runs; "Stays: files in Acme
  tax 2026 and in the reference folders" for an engagement with none; the Maintenance button already reads
  "Forgetting..." behind the open confirm. Fix: "Ends the open run and deletes 1 run ..."; name reference folders only
  when there are some; switch the button label after Confirm. After forgetting, localStorage keeps
  `orgai.openTabs.<id>`, `orgai.newRunMode.<id>`, `orgai.teamSeenAt.<id>` (no client text) and `main.log` keeps run lines
  with the id; acceptable, worth dropping the keys.

### L6. The New project form does not say a template is made for the other kind

- A code project's template select lists "Client review team (5 roles)" with no "Other kinds" group and no "Made for an
  engagement" note (spec section 3); the Team tab's apply dialog has the note (seen). Fix: reuse the dialog's grouping
  and note in `NewProjectForm.tsx`.

### L7. Per-project row repeats the secret state; a copy hides the entered value

- Shot 16: the row's main line says "API_TOKEN not set" while the same slot is in "For this engagement" below (the
  spec keeps the library note for library slots only). After "Make a project-only copy..." the row shows only the
  command; the TENANT_URL the user entered is kept (seen in `mcp.list`) but no longer visible. The dialog title says
  "project-only" while the body says "This engagement". Fix: hide per-project names from the library line; show the
  copied env names in the copy's row.

### L8. Smaller copy and consistency items

- Dates: "Nov 4, 2026" (plan, notes) vs "4 Nov 2026" (templates, kit line).
- Permissions on an engagement shows "App default for new projects: Unattended" under "Ask for everything risky",
  although engagements ignore that default.
- Kit import "Different from yours" (shot 19) gives no way to see the difference (`@firm/drive-mcp@2.0.0` vs `2.1.0`).
- The setup-pending page on an engagement says "The Architect looks through the folder..." and offers "Resume setup"
  while setup is running.

## What worked (seen)

- Templates: the menu with the disabled "Replace the team with a template... No templates yet" (shot 01), the save
  dialog (name defaulted to "Birch vendor review team", "What goes in" list, focus on the name), the notice with Manage
  templates, the App settings list ("Engagement - 5 roles - Saved 4 Nov 2026", shot 03), the New project radio group
  "How should the team start?" with the Select disabled until chosen and the hint "The setup interview is skipped..."
  (shot 02), "Create from template" landing on the Team tab with the template's roles, Replace team on an existing chart
  with Undo ("Undo done. The previous team is back.", roles restored, shot 04), Remove with "Projects made from it keep
  their teams.".
- Ask: lead text including "It can read the reference folders but not change them." on Acme, conversation layout, meta
  "Ask - one assistant", ended composer "Session ended just now. Send to continue with its memory." with placeholder
  "Message the assistant...", the continuation in the same tab with the divider and "2 sessions" (shot 07), History kind
  "Ask". The switch is hidden while setup is pending (Cedar: "Setup is not finished", no `new-run-mode`).
- Plan and notes: write, save ("Plan saved.", focus to Edit), stale banner keeps the typed text (shot 09), discard
  confirm; notes add / edit / remove with "Note saved." / "Note removed.", "2 of 50 notes", Cancel first in the remove
  confirm, focus to the next row's Edit (shot 11), hidden-character refusal on per-project values.
- Forget: from Maintenance and from the Dashboard tile ("Forget engagement..."), counts in the confirm, the Dashboard
  notice "Forgot Acme tax review. Deleted the plan, 1 note, 1 run." with focus on the next tile (shot 13);
  `projects.get` null, `runs.list` empty, document and notes calls answer "Project not found", no data file mentions
  the id, the working folder untouched.
- Per-project values: "For this engagement" block, "Needs values" badge, "Needs 2 values for this engagement before
  agents can use it.", "Saved TENANT_URL", badge gone once both are set, role inspector "Needs values / Fill in";
  project-only copy keeps the entered values; the copy-secrets checkbox appears only when the library holds secret
  values (shot 16, 17).
- Kit: export dialog groups with counts, disabled empty groups, "3 items"; the exported file holds no secret values
  (checked for both stored tokens); import preview with Same / Different / New, "Needs a secret", role tool badges and
  prompts for the template, a confirm "Import 1 item? Imported items cannot be undone.", the notice and "Imported 1 item
  on 4 Nov 2026." (shot 19).
- Layout: no page scroll in New run, Trends or the preset form at 1024x640 and 1600x1000 in both themes; settings deep
  links did not shift the window.
- Code project afterwards: Kind "Code project", Maintenance keeps "Remove OrgAI files from repository", no plan or notes
  sections, tile menu "Delete project...", mode `auto`, Orchestrator chart, Ask lead says "this project's", the apply
  dialog marks the engagement template "Made for an engagement." Nothing engagement-specific leaked beyond L6.

## Click counts

| Task | Clicks |
| --- | --- |
| Save the team as a template | 4: Team, Templates, Save this team as a template..., Save template |
| New engagement from a template | 5 plus typing: New project, Engagement, Start from a template, (pick), Create from template |
| Replace a team and undo | 4: Templates, Replace the team with a template..., Replace team, Undo |
| Ask a question | 3 plus typing: + (or Ctrl+T), Ask, Ask |
| Edit the plan right after setup | 6 (Live, End session, Settings, General, Edit, Save plan) where 3 would do (M1) |
| Add a context note | 3 plus typing: Settings, Add a note, Save note |
| Forget an engagement | 4 from Maintenance (Settings, Maintenance, Forget this engagement..., Forget engagement); 3 from the tile |
| Copy a month's CSV | 4: History, Trends, Month, Copy as CSV |
| Fill a server's values for one client | 4 plus typing: Team, Catalog, Enter in the field, Save on the secret |
| Add a client system as a preset | Not possible (H1) |

## Suggested order of work

1. H1: pass `dataDir` to `McpService` (index.ts) and re-run `e2e/presets.mjs`; then surface the form's refusal banner.
2. M1: stop an Idle, completed setup run from blocking the plan (or end setup sessions after "Setup complete").
3. M2: plan cards over an existing plan say what they replace and show changes; "Revised in the setup interview".
4. M5 and M4: client and engagement columns, local times, Ask kind, status words; aggregate By role.
5. M3: Ask mode label and the segmented control.
6. W2 H2 remainder (drop "Edited" / "Failed" for refused edits, root row and badge) and the Analyst's Bash default.
7. Lows L1-L8, then the open copy sweep (W1 M7, W1 L1, W2 L4, W2 L1, W2 L6).

## Not driven

- Presets after saving (tile, add to a project, edit, remove refusal): blocked by H1.
- The native kit save and open dialogs themselves (stubbed in main for export and import); "Refused" kit items, the stale
  kit digest, "Replace mine", "Add as a copy" and Save CSV... (Electron download path).
- A live setup interview revising the plan (mock-limited: the mock proposes the same plan and team every time), and the
  real effect of an approval over hand edits beyond the mock text.
- The W2 walk-3 shell-command card (`del` in a reference folder), Unattended behaviour, Codex and LiteLLM.
- Save as project, the Needs-you list wording, the rules panel (no rule saved), Add a service ordering.
- Contrast was judged by eye in both themes, not measured.
