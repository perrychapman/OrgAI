# Engagement kind: renderer phases 2-3 (spec)

Status: spec for the next UI passes. Builds on `engagement.md` (phase 1 as built) and the walks
`ux-review-engagement.md` (M5, H3 follow-ups) and `ux-review-engagement-2.md` (M1). Conventions from `config-review.md`
hold: `SettingsPage` / `SettingsSection` (h3) / `SettingsGroup` (h4) / `SettingsCard` / `SettingRow`, at most one
`SettingsAdvanced` per pane, deep links through `lib/settingsTarget.ts` and `lib/scrollWithin.ts`, never
`scrollIntoView`. Tokens only (no new token is needed by this spec), the type scale, lucide icons through `Icon`,
container queries on regions, both themes, `:focus-visible` rings, one primary action per region, status words only
from `lib/runStatus.ts`, costs only through `lib/cost.ts` / `ui/Cost.tsx`.

Copy rules for every string below: sentence case, plain words, industry-neutral ("client or case", "deliverables",
"working folder", "service", "sign in", "can read" / "can read and change"), no vendor or tool names, no "repository",
"git", "agent framework" words in an engagement's path. `<noun>` means "engagement" for an engagement and "project" for
a code project (new helper `projectNoun(kind)` in `lib/projectKindCopy.ts`).

Window sizes: every surface is specified at 1024x640 and 1600x1000, dark and light. Where nothing is said per size, the
surface lives in a settings pane or dialog whose existing container queries already handle both.

## 0. Contracts the UI reads (provisional)

Main-process work is landing in parallel. Names below are the brief's; the UI briefs adapt to the merged names and
must not invent fields. Anything marked **(ask)** is a contract gap this spec needs; the lead confirms or drops it.

| # | Contract (provisional) | Used by |
| --- | --- | --- |
| 1 | `McpLibraryEntry.perProjectSecrets` / `perProjectEnv` (slot names per kind); per-project has-flags on the project's `McpServerInfo` (which per-project slots are empty here); `mcp:copyFromLibrary({ projectId, serverId, copySecrets })`; a per-project value write (**ask**: e.g. `mcp:setProjectValue({ projectId, serverId, kind, name, value \| null })`, secrets write-only). | Section 1 |
| 2 | `connectorPresets:list / upsert / remove`; `ConnectorInfo.custom` (true for the user's own presets); **ask**: `ConnectorInfo.origin?: 'kit'` for presets that came from an imported kit. | Section 2 |
| 3 | `templates:list / saveFromProject / remove / apply`; `ProjectCreateInput.templateId`; apply returns the previous roles for Undo (like `projects:applyImport` `previousRoles`). **ask**: template list items carry `kind`, `roleNames`, `savedAt`. | Section 3 |
| 4 | `RunStartInput.team: 'single'`, `RunSummary.team`. Continuing an Ask run keeps `team: 'single'` (main). | Section 4 |
| 5 | `projects:engagementDocument` read (text, `updatedAt`, **ask** `updatedBy: 'setup' \| 'user'`) and update (**ask**: with the `updatedAt` the edit started from, refused when stale); `projects:listNotes / getNote / saveNote / removeNote` (at most 50 notes of 50,000 chars). | Section 5 |
| 6 | `projects:remove` returns counts (document, rules, notes, runs, skill snapshots, review files). **ask**: a dry run (`projects:removePreview(id)` or `remove(id, { dryRun: true })`) with the same shape, so the confirm can show the counts before anything is deleted. | Section 6 |
| 7 | `runs:usageStats` with month ranges (**ask**: an `until` bound) and every run kind counted (**ask**: `kind` on each `UsageStats.runs` row); `runs:usageCsv({ projectId, since, until, save })` returning the CSV text (copy) or the saved path (save, main's save dialog). | Section 7 |
| 8 | `kit:export({ skills, servers, presets, templates })` (main's save dialog), `kit:import` preview (main's open dialog; items, conflicts, digest) then apply with the digest. | Section 8 |

## 1. Team > Catalog > Connections: per-project values and project-only copies

### Placement

Team tab, side panel, Catalog tab, Connections group (`catalog-connections`), sub-group "Custom servers you added"
(`mcp-group-library`, rows `mcp-row`) and "Connected services" (`mcp-group-connectors`, rows `connected-service-row`).
Nothing new in the canvas region. App settings > Connectors > Custom servers (advanced) gets the slot marking in the
library form.

### Library side (App settings > Connectors > Custom servers > Add / Edit, `McpServerForm` in library mode)

- Each environment variable / header row gets a third checkbox after "Secret": "Per project"
  (`mcp-var-per-project`, `Checkbox`, accessible name "Per project: <NAME>"). Shown only in library mode (the writer is
  the library), never on a project-only server.
- A per-project row's value field is replaced by quiet text "Each project fills this in" (secret or not), so no
  library value is typed for it. Unticking brings the field back empty.
- Fieldset hint under the rows (`mcp-per-project-hint`): "Per project: each project that uses this server enters its
  own value, for example a client's own sign-in or address. Projects without it cannot start the server."
- Library row (`mcp-library-row`) secret line adds "<NAME> per project" after the set / not set items, with the
  `Users` icon, so the row tells the library slots from per-project ones.

### Project side: linked row (`mcp-row` with `mcp-row-library-badge`, and `connected-service-row` for a custom preset with slots)

New block under the row's main line, `PerProjectValues` (`mcp-per-project[data-server]`), shown only when the entry
declares per-project slots:

```
| [switch] client-idp-admin   npx -y @acme/idp-mcp@1.2.0       stdio  Library   Used by ...  [Test] [...] |
|   For this engagement                                                                                  |
|   TENANT_URL     [ https://acme.example.com          ]   saved                                         |
|   API_TOKEN      [ Set ] [Replace] [Clear]              (SecretField)                                  |
|   ! Needs 1 value for this engagement before agents can use it.                                        |
```

- Heading (h5-level text, `--text-body` semibold): "For this <noun>".
- Plain value (`perProjectEnv`): `Input` mono, label = the slot name (visible, `label for`), saves on blur and on
  Enter, then shows quiet "Saved" for 2 s in the row's status span (`mcp-per-project-status`, polite). An empty value
  clears it. Hidden or control characters are refused by main; the error shows as the field's `aria-describedby`
  message with `aria-invalid`.
- Secret (`perProjectSecrets`): the existing `SecretField` (write-only, no reveal, Clear asks first). Its name is the
  slot name.
- Missing state: any empty slot puts the row in `warn` (existing class), adds a `Badge tone="attention"`
  "Needs values" in `mcp-row-meta` (`mcp-per-project-badge`), and the line "Needs N value(s) for this <noun> before
  agents can use it." (`mcp-per-project-missing`, `TriangleAlert`). Focus order inside the row: switch, Test, More,
  then each slot field in row order.
- Filled state: no badge, no warning line; the block stays (values remain editable).
- The existing library-secret note ("Secrets not set in the library: ...") stays for library-level slots only.
- Team > Role inspector "Connections" rows (`RoleCapabilities`) reuse the existing "Needs sign in" badge pattern for
  a server with empty per-project slots: badge "Needs values", button "Fill in" moves to the Catalog tab and focuses
  the first empty slot field (same mechanism as `focusRow` in `McpSection.tsx`).
- Run start warning (main) is unchanged in wording; nothing new in the run view.

### "Make a project-only copy"

- In the linked row's More actions menu (`mcp-menu`), between "Open in library" and "Unlink...":
  "Make a project-only copy..." (`mcp-copy-from-library`, icon `CopyPlus`).
- Opens a `Dialog` (`mcp-copy-dialog`, size md), title "Make a project-only copy of <name>?", description:
  "This <noun> stops following the library entry. Later changes to the entry in your library do not reach the copy.
  Roles keep their access."
- Body: `Checkbox` "Copy the library's secret values too" (`mcp-copy-secrets`), off by default, description "Leave
  off to enter this <noun>'s own values after the copy." Per-project values already entered always move with it
  (one line of quiet text says so when any exist: "Values you entered for this <noun> stay.").
- Footer: Cancel, primary "Make a copy" (`mcp-copy-confirm`, loading while busy). Errors: `Banner tone="danger"`
  "Could not make the copy" at the dialog top, focus stays on the primary.
- After success: the row leaves "Custom servers you added" and appears under "Only in this project"
  (`mcp-group-local`) with its `SourceBadge`; focus moves to the new row's More actions button; the section's existing
  polite status (add one `mcp-section-status`, `role=status`, rendered empty first) says "Made a project-only copy of
  <name>." When secrets were not copied and the server has secret slots, the new row shows its normal "not set"
  secret items and warn state, which is the cue to fill them.
- Engagement vs code: identical except `<noun>`. The menu item is offered for every linked server, not only ones with
  per-project slots.

### Sizes

- Side panel at 1024x640 (panel ~ 280-360 px): slot rows stack label over field (container query on the
  `mcp-per-project` block: one column under 420 px, `label | field | status` grid at 420 px and up). SecretField
  buttons wrap under the field.
- 1600x1000 with a wide panel (>= 480 px, `data-side-wide`): grid layout, field max 40ch.

## 2. App settings > Connectors: "Your presets" and custom tiles

### Placement and order in the Connectors pane

1. Connectors gallery (`connectors-section`, unchanged position).
2. **Your presets** (new `SettingsSection`, `appsettings-section-presets`, testId `presets-section`), between the
   gallery and "Custom servers (advanced)".
3. Custom servers (advanced) (`mcp-library-section`, unchanged).

### Custom tiles in the gallery

- A preset appears as a normal `connector-tile` with `data-custom="true"` and, after the name, `Badge tone="neutral"`
  "Yours" (`connector-custom-badge`, icon `UserRound`), so it is told apart by text, not colour. A preset that came
  from an imported kit (origin 'kit') reads "From a kit" instead.
- Logo: `ConnectorLogo` fallback (initials on `--surface-3`); a preset never carries an image.
- Ease badge, state chip and the one action button follow the existing rules (`connectorEase`: none = "Add", token =
  "Add token", oauth = "Sign in"; a custom preset never has "Needs your own app" in this pass).
- Filter chip "Yours" (`connector-filter[data-filter=custom]`, count) after "Connected", shown only when at least one
  preset exists. Ordering (`sortForGallery`): presets are ranked like curated entries by state and ease; in the
  grouped view (past 24 entries) they form a first group "Your presets" when not connected.
- Search matches a preset's name, search words and description (`matchRank` unchanged order).
- Deep link `requestConnector(id)` works for presets (ids stay kebab-case).
- Add a service (Team > Catalog, `AddServiceDialog`): unconnected presets list under "Your servers"
  (`add-service-yours`) beside saved custom servers, with the "Yours" badge; connected ones under "Ready to use".

### ConnectorDialog for a custom preset

- Same leads per method as curated (`dialogTitle` / `dialogLead`).
- The "not yet tested" note is replaced by "You described this service yourself. OrgAI has not checked it."
  (`connector-custom-note`). For origin 'kit': "This service came from an imported kit. Check where it connects
  before you add it."
- Program presets (stdio) show the full command before the action, in mono, never clamped, inside a bordered block
  with the label "Runs this program on this computer" (`connector-custom-command`), passing through
  `lib/hiddenChars.ts` (badge when hidden characters are present; main refuses them anyway).
- Remote presets show the full address under "Connects to" (`connector-custom-url`).
- Footer secondary "Edit preset" (`connector-preset-edit`) opens the preset form in place of the dialog (the dialog
  closes, the form opens; on close focus returns to the tile's action button).

### "Your presets" section

- Description: "Services you describe once. They show as tiles above and travel in your practice kit without
  secret values."
- Header action (only button in the header, secondary because the section is optional): "Add a preset"
  (`preset-add`, icon `Plus`).
- Empty state (`presets-empty`, `card-block mcp-empty`): icon `Puzzle`, "No presets yet", "Describe a service your
  team uses that is not in the list, such as a client system. It then shows as a tile with a sign-in or token step."
- List (`ul.card-block mcp-list`, aria-label "Your presets"), row `preset-row[data-preset]`: name, one-line
  description (clamped, full text in title), method badge (`EaseBadge`), "Remote" / "Program" text badge, access
  options count ("2 access options"), state ("Connected", "Not added") from the matching `ConnectorInfo`. Actions:
  "Edit" (secondary, `preset-edit`), More actions popover (`preset-more`): "Duplicate", "Remove..." (danger).
- Remove confirm (`ConfirmDialog`, danger): title "Remove the preset <name>?", body "The tile goes away. A service
  you already added from it stays connected and keeps working in your projects." (if not added: "The tile goes
  away."). Confirm "Remove preset". Focus after: the next row's Edit, else "Add a preset".

### Preset form (`Dialog` size lg, testId `preset-form`)

Title "Add a preset" / "Edit <name>". Description "Describe how to reach the service. Secret values are entered when
you add it, never here." Fields in this order (tab order follows):

1. Name (`preset-name`, required, max 60). Hint "Shown on the tile."
2. What it does (`preset-description`, one line, max 160). Hint "One line, shown under the name."
3. Category (`preset-category`, `Select` over the 17 `CONNECTOR_CATEGORIES`, labels from `lib/connectors.ts`).
4. Search words (`preset-aliases`, optional, comma separated). Hint "Other names people might search for."
5. How it connects (`SegmentedControl` label "How it connects", `preset-transport`): "Remote address" (http) /
   "Program on this computer" (stdio).
   - Remote: Address (`preset-url`, mono, https required by main; error shown inline).
   - Program: Command (`preset-command`, mono) and Arguments (`preset-args`, `Textarea` mono, "One argument per
     line."), hint "Runs on this computer each time an agent uses it. Pin exact versions."
6. Sign-in (fieldset legend "Sign-in", native radios, `preset-auth[data-auth]`):
   - "No sign-in needed" (none).
   - "Paste a token" (token): sub-fields Header or variable name (`preset-token-name`, default "Authorization" for
     remote), Prefix (`preset-token-prefix`, optional, placeholder "Bearer "), Where to get it (`preset-token-help`,
     optional URL, shown as a link in the add dialog).
   - "Sign in with the browser" (oauth): remote only. For a program the radio is native-disabled with the visible
     reason under it: "Browser sign-in works only with a remote address."
7. Fixed values (fieldset "Other headers" / "Other variables"): the same row pattern as `McpServerForm` (Name, Value,
   "Asked when adding" checkbox instead of "Secret", "Per project" checkbox from section 1). A row with "Asked when
   adding" has no value field.
8. Access options (fieldset legend "Access options", `preset-variants`): one row per option, at most 6:
   Label (`Input`, e.g. "Read only"), Access (`Select`: "Can read" / "Can read and change"), Address or extra
   arguments for this option (optional; empty uses the base), Default (radio, exactly one), Remove (`IconButton`
   "Remove access option <label>", disabled while only one remains). "Add an access option" (`preset-variant-add`,
   native-disabled at 6 with the hint "Six is the most."). Hint "Offer a read-only option first if the service has
   one. People pick an option when they add the service."

Footer: Cancel, primary "Save preset" (`preset-save`). Validation on submit: first invalid field takes focus,
`aria-invalid` plus `aria-describedby` message; main's refusal shows as `Banner tone="danger"` "Could not save the
preset" at the top. Editing a preset that is already added: a quiet line at the top "Changes apply the next time it is
added. The added service keeps its current settings until you remove and add it again." (**ask** main whether an
upsert rewrites the library entry; if it does, change the line.)

### Sizes

- 1024x640: the Connectors pane column is already widened; the presets list rows wrap their badges under the name
  under a 560 px container. The form dialog scrolls inside its body; the footer stays visible.
- 1600x1000: rows are one line; the variants grid is `label | access | address | default | remove`.

## 3. Team templates

### One place to manage them

App settings, new pane **Templates and kit** (section 8) holds the list, section "Team templates"
(`appsettings-section-templates`, testId `templates-section`). Saving happens from a project's Team tab; using one
happens in the New project form and the Team tab. No template UI anywhere else.

### Team tab: Templates menu

- `FrameToolbar` "Team actions": new button "Templates" (`team-templates`, icon `LayoutTemplate`, `ChevronDown`)
  after "Export to repo" and before "Auto-layout". It is a `Popover` (role `menu`, label "Templates") anchored to the
  toolbar (it opens over the toolbar edge like the existing canvas style button; no new floating layer). Items:
  - "Save this team as a template..." (`team-template-save`)
  - "Replace the team with a template..." (`team-template-apply`), disabled with reason "No templates yet" when the
    list is empty (`aria-disabled` item, reason in its description).
- 1024x640: the toolbar already wraps; "Templates" keeps its label (no icon-only collapse). 1600x1000: one row.

### Save as template dialog (`template-save-dialog`, size md)

- Title "Save this team as a template". Description "Start new projects with this team. You can remove templates in
  App settings."
- Name (`template-name`, required, max 60, default "<project name> team").
- Description (`template-description`, optional, max 200).
- "What goes in" list (quiet, bullets): "N roles with their instructions, models as tiers and tools", "Which skills
  and services each role may use, by name", "Kind: Engagement" or "Kind: Code project". "Not included: secret values,
  folders, the engagement plan, context notes and run history." (code project: drop "the engagement plan, context
  notes"). Skills and services that are not in the library are named in a warning line: "Not in your library, so a
  new project will not have them: <names>." (`template-local-items`).
- Name taken (refusal from main or a match in `templates:list`): field error "You already have a template named
  <name>." plus a secondary button "Replace it" (`template-replace`) beside the primary; the primary stays "Save
  template".
- Footer: Cancel, primary "Save template" (`template-save-confirm`). Success closes the dialog and shows a success
  `Banner` in `.import-notices` (`template-saved-notice`): "Saved the template <name>." with a link button "Manage
  templates" (`requestAppSettingsSection(APP_SETTINGS_SECTIONS.templates)`), dismissable. Focus returns to
  "Templates".

### Apply on the Team tab (`template-apply-dialog`, size md)

- Title "Replace the team with a template". Description "The current roles are replaced. You can undo until you edit
  the chart."
- A radio list (`fieldset`, legend "Templates", rows `template-option[data-template]`): name, description (clamped),
  "N roles: Lead, Analyst, Writer..." (first 4 role names, then "and N more"), kind text "Engagement" / "Code
  project". Templates of the project's kind first, then the rest under a quiet divider "Other kinds". Choosing one of
  another kind shows "Made for a <kind>. Roles may speak in that kind's terms." (`template-kind-note`).
- Footer: Cancel, primary "Replace team" (`template-apply-confirm`).
- After apply: the chart is fitted (as after an import) and a `Banner tone="success"` in `.import-notices`
  (`template-notice`, label "Team template"): title "Team replaced with <template>." body "You can undo until you
  edit the chart." action "Undo" (`template-undo`). States mirror the import notice: busy, error ("Retry undo"),
  expired ("Undo ended because you edited the chart.", info tone), reverted ("Undo done. The previous team is back.",
  `template-undone`). Only one of import notice or template notice shows at a time; the newer replaces the older.

### New project form: start from a template

- When the user has at least one template, the setup checkbox (`architect-setup`) becomes the radio group already
  used for found agents (`setup-choice`, legend "How should the team start?" for both kinds; today's legend "How should
  the org chart start?" changes with it). Options in order:
  1. Interview / Architect (existing labels: engagement "Start with the setup interview (recommended)", code "Set up
     with the Architect (recommended)").
  2. "Start from a template" (`setup-choice-template`) with a `Select` beside it (`new-project-template`, label
     "Template", options "<name> (N roles)"; this kind's templates first, then "Other kinds" as an `optgroup`). The
     Select is enabled only while this radio is checked and is the next Tab stop after it.
  3. Import (only when agents were found; existing label).
  4. "Start with the standard team" (engagement) / "Start with the default chart" (code, existing).
- Hint under the template option while checked: engagement "The setup interview is skipped. Run it later from the
  Live tab to write the engagement plan."; code "The Architect is skipped. Run setup later from the Live tab."
- Submit label (`setupSubmitLabel`): "Create from template". Sends `templateId`.
- The last template used is remembered in localStorage `orgai.lastTemplateId` (preselected next time when it still
  exists); the choice itself is not remembered (the interview stays the default).
- Without templates the form is unchanged (checkbox). First launch is unchanged.
- Save as project (Chat) does not offer templates in this pass.

### App settings list (`templates-section`)

- Description: "Teams you saved from a project. Use one when you create a project or on a project's Team tab."
- Empty (`templates-empty`): "No templates yet. On a project's Team tab, choose Templates > Save this team as a
  template."
- Rows `template-row[data-template]`: name, description, "Engagement" / "Code project", "N roles", "Saved 4 Nov
  2026". One action: "Remove..." (`template-remove`, secondary danger style). Confirm: "Remove the template <name>?"
  / "Projects made from it keep their teams." / "Remove template". No rename or edit in this pass.

## 4. Ask: one assistant on a real project

### New run page (`NewRunPage`)

- The `Composer` `modeSwitch` slot gets a `SegmentedControl` (label "Who works on it", `new-run-mode`):
  "Team" / "Ask". Hidden while setup is pending (the setup state owns the page) and for virtual projects.
- The choice is remembered per project in localStorage `orgai.newRunMode.<projectId>` ('team' | 'ask'); default
  'team'.
- Team (unchanged): EmptyState "Give <root> something to do", lead from `newRunLead`, role chips, primary "Start".
- Ask:
  - EmptyState title "Ask one assistant". Description (`new-run-ask-lead`): "One assistant answers here as a
    conversation. It can use this <noun>'s folders, services and skills, with the same permissions. No team members
    start." Reference folders, if any, add: "It can read the reference folders but not change them."
  - No role chips.
  - Composer: modeLabel "New conversation with one assistant", placeholder "Ask a question or give a small task",
    primary "Ask". Sends `team: 'single'` through `startRun` (store option, see briefs).
- Keyboard: the segmented control sits before the textarea in tab order; arrow keys move the choice; switching does
  not move focus and does not clear the draft. The draft is shared between modes (same `newRunDraftKey`).
- Sizes: at 1024x640 the composer's mode row wraps the control under the mode label under 560 px (existing `composer`
  container); at 1600x1000 one line.

### The run

- Layout: conversation (`isSingleAgentRun` includes `summary.team === 'single'`), so the stage is
  `run-conversation`; the `run-layout-toggle` still switches.
- Run tab and History kind: `runKindLabel` returns "Ask" (chip `run-kind[data-kind=ask]`); History kind filter gains
  "Ask" for real projects.
- RunMeta: "Ask · one assistant" in place of "unattended" wording; never "unattended".
- Composer while live: `speaksAsAssistant` includes it: "Reply to the assistant", idle `ASSISTANT_IDLE_LABEL`.
- Org retrospective is not offered (`offersRetro` false when `team === 'single'`).
- Status words: from `lib/runStatus.ts` only.

### When it ends

- Same chain model as every run: the ended composer reads `endedComposerCopy` ("Session ended 3 min ago. Send to
  continue with its memory."), placeholder "Message the assistant" (new branch when `team === 'single'`), primary
  "Send". The continuation stays an Ask run in the same tab (`chain-divider` as today).
- No "continue with the team" switch in this pass. To hand the work to the team the user opens "+" (New run, Team).

### Engagement vs code

Copy differs only by `<noun>`. Engagement runs keep the reference-folder card rules.

## 5. Project settings > General: engagement plan and context notes

Engagements only. Code projects keep "Architecture document" in Maintenance and get neither section.

### Pane order (General)

1. General (kind line, Name, Client or case, Working directory, Project brief): unchanged.
2. **Engagement plan** (`settings-section-engagement-plan`, testId `engagement-plan-section`).
3. **Context notes** (`settings-section-context-notes`, testId `context-notes-section`).
4. Remap notices, Connection: unchanged.

Both ids join `PROJECT_SETTINGS_SECTIONS` (pane 'general') so the Live tab and Maintenance can deep-link.

### Engagement plan

- Section description: "What the team works from. Agents read it at the start of every run; a run already going
  keeps the version it started with."
- Revised line (`engagement-plan-revised`, quiet): "Approved in the setup interview, 3 Nov 2026" / "Edited by you,
  4 Nov 2026" / "Revised in the setup interview, 5 Nov 2026" (dates `toLocaleDateString`, full time in title).
- Empty (no document; setup skipped or not finished) (`engagement-plan-empty`): "No plan yet. The setup interview
  writes one, or you can write it yourself." Actions: primary "Start the setup interview" (`engagement-plan-interview`,
  `startSetup()` then the Live tab), secondary "Write it yourself" (`engagement-plan-write`, opens the editor empty).
- View (filled): the document rendered with the shared `Markdown` component inside a `SettingsCard`, height capped at
  `--scroll-region-max` with its own scroll (focusable region, `tabIndex=0`, `role=region`, aria-label "Engagement
  plan"). Actions under it, left to right: "Edit" (secondary, `engagement-plan-edit`), "Review in the setup
  interview" (secondary, `engagement-plan-review`, prompt "Review the engagement plan with me and propose changes.").
  No primary here: both actions are optional.
- Edit: the card swaps to a `Textarea` (`engagement-plan-editor`, sans font, 16 rows at 1600x1000, 10 at 1024x640,
  label "Engagement plan", character count "12,400 of 50,000" in its hint; **ask** the cap). Footer row: Cancel,
  primary "Save plan" (`engagement-plan-save`). Esc inside the textarea does nothing (it is a text field); Cancel with
  unsaved changes asks `useConfirm` "Discard your changes to the plan?" / "Discard". Leaving the pane with unsaved
  changes asks the same.
- Save success: back to view, revised line updated, polite status in the section (`engagement-plan-status`) "Plan
  saved.", focus to "Edit".
- Stale save (main refuses because the plan changed since editing began, e.g. an approved interview proposal):
  `Banner tone="warning"` above the editor (`engagement-plan-stale`): "The plan changed while you were editing."
  actions "Copy my text" (`CopyButton`) and "Load the new plan" (replaces the editor text after a confirm). The editor
  keeps the user's text until they choose.
- Read error: `Banner tone="danger"` "Could not read the plan" with Retry.
- While a setup run of this project is live: the Edit button is native-disabled with the visible reason "The setup
  interview is running. Edit after it ends." (`engagement-plan-busy`).

### Context notes

- Section description: "Background the team can look up when it needs it: meeting notes, client preferences, terms.
  Agents read these notes; do not put passwords or keys here."
- Header action: "Add a note" (`context-note-add`, secondary, icon `Plus`); native-disabled at 50 notes with the
  visible reason "50 notes is the most a <noun> can keep. Remove one to add another."
- Empty (`context-notes-empty`): "No notes yet. Add what the team should know but would not find in your folders."
- List (`ul`, aria-label "Context notes"), newest edit first, row `context-note-row[data-note]`: title, first line
  of the text (clamped, quiet), size ("3,200 characters"), "Edited 4 Nov 2026". Actions: "Edit" (`context-note-edit`)
  and `IconButton` `Trash2` "Remove note <title>" (`context-note-remove`).
- Count line under the list (quiet): "12 of 50 notes".
- Add / edit dialog (`context-note-dialog`, size lg): title "Add a note" / "Edit <title>"; Title (`context-note-title`,
  required, max 120); Text (`context-note-text`, `Textarea`, 14 rows, count "N of 50,000 characters", over the cap is
  a field error on save). Footer: Cancel, primary "Save note" (`context-note-save`). Closing with unsaved text asks
  "Discard this note?". Main's refusal (hidden characters, too long) shows as a field error on the text with focus on
  it.
- Remove confirm: "Remove the note <title>?" / "Agents can no longer read it. This cannot be undone." / "Remove note"
  (danger). Focus after: next row's Edit, else "Add a note".
- One polite status per section (`context-notes-status`, rendered empty first): "Note saved.", "Note removed."
- Sizes: 1024x640 rows stack actions under the title under a 520 px container; 1600x1000 single line.

## 6. Maintenance: "Forget this engagement"

### Placement

Engagement Maintenance pane, after the `maintenance-engagement-line` and any branch block: a "Danger zone"
`SettingsGroup` (engagements had none) with `danger-zone` styling. Code projects keep their danger zone unchanged; the
whole-project delete for them stays on the Dashboard tile.

- Text (`danger-zone-text`): "Deletes everything OrgAI keeps for this engagement: the plan, context notes, saved
  permission rules, run history and costs, and saved service values for it. Files in the working folder and in
  reference folders are not touched."
- Button: "Forget this engagement..." (`forget-engagement`, `variant="danger"`).
- Dashboard tile menu for an engagement reads "Forget engagement..." instead of "Delete project..." and opens the same
  confirm (`lib/dashboard.ts` copy per kind).

### Confirm (`ConfirmDialog`, danger, testId `forget-confirm`)

- Title "Forget <name>?"
- Body: a list built from the dry-run counts (zero rows are left out):
  - "The engagement plan"
  - "12 context notes"
  - "4 saved permission rules"
  - "23 runs with their transcripts and costs" (open runs first: "Ends 1 open run and deletes 23 runs ...")
  - "3 skill copies made for it"
  - "2 team review files"
  then "Stays: files in <working folder name> and in the reference folders, your library skills, custom servers and
  connected services." and "This cannot be undone."
- If the dry run is unavailable or fails: the body names the kinds without numbers ("its plan, context notes, saved
  rules, runs and costs") and a quiet line "OrgAI could not count them first."
- Confirm label "Forget engagement"; Cancel takes initial focus (danger dialog default).

### After

- Main returns counts. The app goes to the Dashboard (as after a tile delete) and the Dashboard's one live region
  announces, and a dismissable `Banner tone="success"` at the top of the Dashboard (`forget-notice`) shows: "Forgot
  <name>. Deleted the plan, 12 notes, 4 rules, 23 runs." (from the returned counts). Focus follows the existing
  delete rule (`idAfterRemoval`, else New project).
- Failure: `Banner tone="danger"` in the Maintenance pane (`forget-error`) "Could not forget this engagement" with the
  cleaned IPC message; nothing is navigated; focus returns to the button.

## 7. History > Trends: months and CSV

### Controls row (`trends-controls`)

Left to right; wraps under 640 px container width (existing `trends` container):

1. Range `SegmentedControl` (label "Range"): "7 days", "30 days", "90 days", "Month".
2. When "Month" is picked: `Select` (`trends-month`, label "Month") listing the current month first ("November 2026,
   so far") then the previous 23 months ("October 2026"...). It appears in place, right after the control; picking
   "Month" moves nothing and does not move focus. Default month: the current one.
3. Group by (Day / Week): unchanged.
4. Right-aligned (margin-inline-start: auto): "Copy as CSV" (`trends-copy-csv`, icon `ClipboardCopy`) and
   "Save CSV..." (`trends-save-csv`, icon `Download`). Both secondary; the region has no primary.

The range choice is remembered per project in localStorage `orgai.trendsRange.<projectId>`
(`7|30|90|month:YYYY-MM`). Month ranges are calendar months in local time.

### Body

- Totals heading line above the `trends-totals` list (quiet, `trends-scope`): "Every run in this range: work, setup,
  Ask and saved chats." Cost total label reads "Estimated cost" (the `dt`), with the existing unknown / minimum rules.
- New "By kind" table after "By role" (`trends-kinds`): Kind (Work, Setup, Ask, Chat, Skill assistant...), Runs,
  Tokens, Estimated cost. Kind words from `runKindLabel`.
- Empty state title becomes "No runs in this range" (was "No work runs in this range"); description "Usage appears
  here once a run has spent tokens. Try another range."
- Month chart buckets fill the whole month (days after today are empty columns).

### CSV

- Rows: one per run in the range (chains are not merged). Columns (main builds them; listed so e2e can assert):
  Date, Run, Kind, Status, Tokens, Estimated cost (USD), Cost note. An unknown cost is an empty cell with Cost note
  "unknown"; a lower bound has the number and "minimum". Never 0 for unknown. Engagements add Client and Engagement
  columns first, code projects add Project.
- Copy: on success, a polite status in the controls row (`trends-csv-status`, rendered empty first): "Copied 23 runs
  as CSV." Failure: the same region with `role=alert` text "Could not copy: <message>".
- Save: main's save dialog (default name "<project name> usage <YYYY-MM or range>.csv"). Success: "Saved to <path>"
  (path clamped from the middle, full in title). Cancelled: nothing.
- No runs in range: both buttons native-disabled; the empty state already explains.

### Sizes

1024x640: History tab content scrolls inside `trends-scroll`; the controls wrap to two rows (range + month, then group
+ CSV). 1600x1000: one row.

## 8. App settings > "Templates and kit"

### Pane

New App settings pane after Skill library, before About: nav label "Templates and kit"
(`APP_SETTINGS_PANES.kit = 'kit'`). Sections, in order:

1. Team templates (`appsettings-section-templates`), section 3.
2. Practice kit (`appsettings-section-kit`, testId `kit-section`).

### Practice kit section

- Description: "Your skills, custom servers, presets and templates in one file, to move to another computer or share
  with a colleague. Secret values and sign-ins never go in it."
- Two actions in the header row: "Export a kit..." (`kit-export`, secondary) and "Import a kit..." (`kit-import`,
  secondary). No primary in this region.
- Last result line (quiet, `kit-last`): "Exported 14 items on 4 Nov 2026." / "Imported 9 items on 4 Nov 2026." (kept
  in localStorage `orgai.kitLast`).

### Export dialog (`kit-export-dialog`, size lg)

- Title "Export a kit". Description "Choose what goes in. Secret values, sign-ins and folders are never included."
- Four groups, each a `fieldset` with a group checkbox in the legend row (`Checkbox` "Library skills (6)" with the
  mixed state when partly ticked) and an item list below (scrollable region capped at `--scroll-region-max`):
  - Library skills (`kit-group[data-group=skills]`), items `kit-item` with name and description.
  - Custom servers (`data-group=servers`): name and target; note "Saved without secret values or sign-in. People
    enter their own after importing."
  - Your presets (`data-group=presets`).
  - Team templates (`data-group=templates`): note "Skills and services the templates use are listed by name only;
    tick them above to include them." When a ticked template names a library skill or server that is not ticked, a
    warning line under the group: "<template> uses <names>, which are not in this kit." (`kit-missing-deps`) with a
    link button "Add them" that ticks them.
- All groups start ticked except none when the library is empty; an empty group shows "Nothing to export." and its
  checkbox is native-disabled.
- Footer: count "14 items" (polite), Cancel, primary "Save kit..." (`kit-export-save`, native-disabled at 0 items
  with the reason in the count line "Choose at least one item."). Main opens the save dialog. Success closes the
  dialog and the section status (`kit-status`, polite) says "Saved the kit to <path>." with a `CopyButton` for the
  path. Error: `Banner tone="danger"` "Could not save the kit" in the dialog.

### Import (`kit-import-dialog`, size lg)

1. "Import a kit..." opens main's file picker. Cancel: nothing. A file main cannot read: section status `role=alert`
   "This file is not an OrgAI kit." (or main's message).
2. The preview dialog: title "Import <file name>", description "Kits from other people can run programs on this
   computer. Check each custom server and preset before you import it."
3. Table (`kit-preview`, `table` with caption "Items in this kit"; columns Item, Type, Status, What to do):
   - Item: name, then for servers and program presets a "Show what it runs" disclosure (`kit-item-command`) with the
     full command or address in mono, never clamped, `lib/hiddenChars.ts` badge.
   - Type: "Skill", "Custom server", "Preset", "Template".
   - Status (`kit-status-cell[data-status]`): "New", "Same as yours" (identical; nothing to do), "Different from
     yours" (same name, other content), "Refused: <reason>" (main refused it, e.g. hidden characters; row is
     disabled).
   - What to do (`Select`, `kit-action`, accessible name "What to do with <name>"): New: "Add" / "Skip";
     Different: "Keep mine" (default) / "Replace mine" / "Add as a copy" / "Skip"; Same: plain text "Nothing to do".
   - Items that need secret values after import show `Badge tone="attention"` "Needs a secret" in the Item cell.
4. Footer: summary "Adds 6, replaces 1, skips 2." (polite), Cancel, primary "Import 7 items" (`kit-import-apply`).
   "Replace mine" anywhere asks `useConfirm` first: "Replace 1 of your items?" / names / "Replace".
5. Stale preview (main refuses the digest): `Banner tone="warning"` "The kit file changed. Preview it again." with
   "Preview again"; the table keeps its choices where items still match.
6. After apply: the dialog closes; the section shows a `Banner tone="success"` (`kit-import-notice`): "Imported 7
   items." and, when any need secrets, "These need secret values before agents can use them: <names>." with the link
   button "Open Connectors" (`kit-open-connectors`). No Undo in this pass.

### Sizes

- 1024x640: the table switches to stacked rows under a 640 px container (`kit-preview` container query): each row is
  name + type line, status line, then the Select full width. The dialog body scrolls; the footer stays.
- 1600x1000: a normal table, Select column 220 px.

## 9. Keyboard, focus and announcements (all surfaces)

- Every new control is a native element or a `components/ui` primitive; no `div` with `onClick`.
- Dialogs: `Dialog` moves focus to the first field (`data-autofocus`), `inert` background, Esc closes (asks first when
  there are unsaved changes), focus returns to the trigger. ConfirmDialog for danger starts on Cancel.
- Menus: `Popover role=menu` closes on Esc and returns focus to "Templates".
- One polite live region per section, rendered empty before it is used; `role=alert` only for errors. The Team tab
  notices use `Banner` labels as the import notices do; no new region in the frame tray (`tray-announce` stays the
  only tray region).
- Disabled with a reason: native `disabled` plus visible reason text next to it, except the "Templates" menu item and
  the New project submit, which follow the existing `aria-disabled` + `aria-describedby` pattern.
- Tab order per surface follows the visual order written above.

## 10. Test ids (new)

`mcp-var-per-project`, `mcp-per-project-hint`, `mcp-per-project`, `mcp-per-project-status`, `mcp-per-project-badge`,
`mcp-per-project-missing`, `mcp-copy-from-library`, `mcp-copy-dialog`, `mcp-copy-secrets`, `mcp-copy-confirm`,
`mcp-section-status`; `connector-tile[data-custom]`, `connector-custom-badge`, `connector-filter[data-filter=custom]`,
`connector-custom-note`, `connector-custom-command`, `connector-custom-url`, `connector-preset-edit`, `presets-section`,
`preset-add`, `presets-empty`, `preset-row[data-preset]`, `preset-edit`, `preset-more`, `preset-form`, `preset-name`,
`preset-description`, `preset-category`, `preset-aliases`, `preset-transport`, `preset-url`, `preset-command`,
`preset-args`, `preset-auth[data-auth]`, `preset-token-name`, `preset-token-prefix`, `preset-token-help`,
`preset-variants`, `preset-variant-add`, `preset-save`; `team-templates`, `team-template-save`, `team-template-apply`,
`template-save-dialog`, `template-name`, `template-description`, `template-local-items`, `template-replace`,
`template-save-confirm`, `template-saved-notice`, `template-apply-dialog`, `template-option[data-template]`,
`template-kind-note`, `template-apply-confirm`, `template-notice`, `template-undo`, `template-undone`,
`setup-choice-template`, `new-project-template`, `templates-section`, `templates-empty`, `template-row[data-template]`,
`template-remove`; `new-run-mode`, `new-run-ask-lead`, `run-kind[data-kind=ask]`; `engagement-plan-section`,
`engagement-plan-revised`, `engagement-plan-empty`, `engagement-plan-interview`, `engagement-plan-write`,
`engagement-plan-edit`, `engagement-plan-review`, `engagement-plan-editor`, `engagement-plan-save`,
`engagement-plan-status`, `engagement-plan-stale`, `engagement-plan-busy`, `context-notes-section`, `context-note-add`,
`context-notes-empty`, `context-note-row[data-note]`, `context-note-edit`, `context-note-remove`,
`context-note-dialog`, `context-note-title`, `context-note-text`, `context-note-save`, `context-notes-status`;
`forget-engagement`, `forget-confirm`, `forget-notice`, `forget-error`; `trends-month`, `trends-copy-csv`,
`trends-save-csv`, `trends-csv-status`, `trends-scope`, `trends-kinds`; `kit-section`, `kit-export`, `kit-import`,
`kit-last`, `kit-status`, `kit-export-dialog`, `kit-group[data-group]`, `kit-item`, `kit-missing-deps`,
`kit-export-save`, `kit-import-dialog`, `kit-preview`, `kit-item-command`, `kit-status-cell[data-status]`,
`kit-action`, `kit-import-apply`, `kit-import-notice`, `kit-open-connectors`.

Changed: `setup-choice` legend "How should the team start?"; `trends-empty` title; Dashboard tile menu item text for
engagements. Unchanged selectors: everything else in `engagement.md` and CLAUDE.md "Renderer".

## 11. e2e impact

- Existing scripts: `e2e/engagement.mjs` (legend text if asserted), `e2e/import.mjs` (`setup-choice` legend),
  `e2e/usage.mjs` (empty-state title "No runs in this range", Trends now counting setup runs: any exact run count
  assertion changes), `e2e/connectors.mjs` (gallery counts change only if the mock ships a preset; it should not by
  default).
- New scripts, one per brief (names below), all mock, both sizes and themes, `windowShift` after every settings deep
  link. Mock needs: a library entry with one per-project env and one per-project secret slot (fixture in the e2e data
  dir), `templates:*` and `kit:*` working token-free, a mock Ask run that answers once and goes idle (the quick-run
  script is the model), an engagement document fixture.
- Lead adds each new script to `e2e:free` in package.json (shared file).

## 12. Not in this spec

- Merging a template into an existing chart (apply replaces only); renaming or editing templates; templates in Save
  as project.
- Switching an Ask conversation to the team (or back) inside one chain.
- Undo for a kit import; signing or verifying kit files; a kit's own skill-file review beyond what the existing skill
  import shows.
- "Needs your own app" (own OAuth client) presets.
- Per-client totals and "group by client" on the Dashboard (engagement.md M5), and CSV across projects or clients.
- Context notes for code projects; note attachments, folders of notes, search inside notes.
- Copy sweep items still open from the walks (inspector words, Team assistant tray text, Catalog wording, L1-L7 of the
  second walk).
- A "Forget" for code projects in Maintenance (they keep the Dashboard delete).

## 13. Suggested UI engineer briefs (disjoint files)

Shared couplings the lead edits (or assigns to exactly one brief at a time): `src/renderer/src/store/useAppStore.ts`
(B3 template notice and apply, B4 `startRun` `team` option, B5 forget notice), `src/renderer/src/lib/settingsTarget.ts`
(B5 two project sections, B7 pane and two app sections), `src/renderer/src/views/AppSettingsView.tsx` (B7 only),
`package.json` `e2e:free`, `src/preload/index.d.ts` (main side), the styles index if a new css file is added.

Order: B1 and B2 in parallel; B3 and B4 in parallel; B5, B6 in parallel; B7 last (it mounts B3's list).

| Brief | Surface | Files it owns | e2e |
| --- | --- | --- | --- |
| B1 Per-project values | Section 1 | new `components/mcp/PerProjectValues.tsx`, `components/mcp/McpSection.tsx`, `components/mcp/McpServerForm.tsx`, `components/mcp/McpLibrarySection.tsx` (row slot line), `components/mcp/mcpHelpers.ts`, `components/connectors/ConnectedServices.tsx`, `components/team/RoleCapabilities.tsx` (badge only), `lib/projectKindCopy.ts` (`projectNoun`, + test), `styles/mcp.css`, `styles/mcp-library.css` | new `e2e/per-project.mjs` |
| B2 Presets | Section 2 | `components/connectors/ConnectorGallery.tsx`, `ConnectorTile.tsx`, `ConnectorDialog.tsx`, `AddServiceDialog.tsx`, new `components/connectors/PresetsSection.tsx`, new `components/connectors/PresetForm.tsx`, `lib/connectors.ts` (+ test), `styles/connectors.css` | new `e2e/presets.mjs` |
| B3 Templates | Section 3 (Team tab, New project, list component) | `views/TeamView.tsx`, new `components/templates/SaveTemplateDialog.tsx`, `ApplyTemplateDialog.tsx`, `TemplatesSection.tsx`, new `lib/templates.ts` (+ test), `components/dashboard/NewProjectForm.tsx`, `lib/agentImport.ts` (`setupSubmitLabel`, choice labels), `styles/team.css` | new `e2e/templates.mjs`; touch `e2e/import.mjs` legend |
| B4 Ask | Section 4 | `components/NewRunPage.tsx`, `lib/assistants.ts` (+ test), `lib/runChains.ts` (placeholder branch, + test), `components/RunMeta.tsx`, `components/RunHistory.tsx` (kind filter) | new `e2e/ask.mjs` |
| B5 Plan, notes, forget | Sections 5 and 6 | new `components/settings/EngagementPlanSection.tsx`, new `components/settings/ContextNotesSection.tsx`, `views/SettingsView.tsx`, `components/settings/MaintenanceSection.tsx`, `lib/dashboard.ts` (+ test), `components/dashboard/ProjectsGrid.tsx`, `components/dashboard/ProjectTile.tsx`, `views/DashboardView.tsx` (forget notice), `styles/settings.css` | new `e2e/engagement-plan.mjs`; touch `e2e/engagement.mjs` |
| B6 Trends | Section 7 | `components/UsageTrends.tsx`, `lib/trends.ts` (+ test), `styles/history-trends.css` | `e2e/usage.mjs` |
| B7 Templates and kit pane | Section 8 | new `components/kit/KitSection.tsx`, `KitExportDialog.tsx`, `KitImportDialog.tsx`, new `lib/kit.ts` (+ test), `views/AppSettingsView.tsx` (pane, mounts B3's `TemplatesSection`), new `styles/kit.css` | new `e2e/kit.mjs` |

B1 and B2 both read `lib/connectors.ts`; only B2 edits it. B1 adds `projectNoun` to `lib/projectKindCopy.ts`
first (a one-function change the others only import); B4 and B5 start after B1 merges or inline the two words and
switch later. B3's `TemplatesSection` is mounted by B7, so B7 starts after B3 merges.
