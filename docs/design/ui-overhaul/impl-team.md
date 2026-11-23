# UI overhaul: Team area implementation notes (ov-team)

Boards: `Team`, `EngagementTeam`, `Import`. Date: 2026-11-22. Lead: ov-team, with two UI Engineers (`team-import`,
`team-inspector`). Renderer only; nothing in `src/main`, `src/shared` or `src/preload` was changed.

## What was built, per board

### Team (`views/TeamView.tsx`, `components/team/*`, `RoleNode.tsx`, `RoleInspector.tsx`)

- **Org chart stays the React Flow editor.** The board draws groups as columns of buttons; the app keeps its pannable
  chart because drag-to-reparent, the node menu, Delete / Enter keys, undo, placement and fit all live there. The look is
  the board's: glass role cards (`--glass-strong`, `--glass-line`, `--radius-lg`, `--elev-1`, no backdrop-filter on
  nodes), a filled rounded-square avatar (the role colour darkened toward black so white initials keep contrast on every
  `ROLE_COLORS` entry), display-font names, a 2 px hover lift (off under reduced motion), and selection as the accent wash
  plus ring and soft glow, with the 4 px leading bar kept as the cue that does not depend on colour. Agreed with ov-run so
  `AgentNode` (Live) reads as the same family.
- **Selected role toolbar** (board: Duplicate / Move / Remove): a React Flow `NodeToolbar` above the selected node,
  `role=toolbar` named "Actions for {role}", buttons Add a report, Duplicate, Move, Remove (root: Add a report only),
  arrow keys / Home / End move between them. Actions come from `components/team/roleNodeActions.ts` (context), so node
  data and memo are unchanged. Duplicate adds "{name} copy" (`lib/roleOps.ts` `duplicateName`) under the same manager
  with the same description, instructions, tools, model, skills and service grants (servers granted by slug are granted
  to the copy by id), no reports, with the usual added-notice and Undo. Move focuses the inspector's Reports to. The node
  menu gained "Duplicate role" (`role-menu-duplicate`).
- **Header** (`TeamHeader.tsx`): display-font title, "N roles in G groups" (`team-role-count` keeps "N roles",
  `team-group-count` " in G groups"; a group is a root report that leads someone, `teamGroupCount`), new glass secondary
  buttons Add group (`team-add-group`: Add role popover with the root as manager) and Import (`team-import`: the import
  dialog), a Theme dropdown (`team-theme`, menu `team-theme-menu` with one checked "Org chart" item and the note that
  Pocket Office and Factory floor show a running team on Work: the Team editor is graph only by owner decision
  2026-11-19, while decision 4 wants themes as a dropdown), then Layout, Start from (templates, Architect, import, save),
  Team files chip and the primary Add role with an accent glow. Compact header keeps icons only; the theme button hides
  under 700 px of header width.
- **Zoom group** (board: − 100% + Tidy): React Flow `Controls` (horizontal, glass) with Zoom out, the zoom level
  (`team-zoom-level`), Zoom in, Fit (`.react-flow__controls-fitview` kept for e2e) and Tidy (`team-tidy`, the same
  arrange as Layout > Arrange automatically). Zoom durations are 0 under reduced motion.
- **Role inspector** (team-inspector): see "Inspector" below.
- **Ask the Architect bar** (team-inspector): the Team assistant tray reads as the board's glass bar with a labelled
  input and Ask; it starts or feeds the org change session through the existing Architect form.
- **Plain tier words** (`lib/tierWords.ts`, `TIER_LABEL` in `lib/roleModels.ts`): Fast, Standard, Advanced, Most capable
  for fast / everyday / deep / top. Exact model ids stay in the chip title, the model sentence and the selects.

### Inspector (team-inspector)

Header with 40 px avatar and "{group} · reports to {manager}"; sections in board order: What this role does, Model (tier
radio group plus the resolved model sentence; "Choose an exact model" reveals Runs on, Model select with Inherit, Exact
model, Effort, Staffing), What it can use (chips, dashed "Cannot edit files", Edit), Instructions ("Open full editor"
grows the same textarea), delegation, Who it is (name, Reports to, colour, ID), and "Every change must pass this role
before merging" (`role-must-pass`, the manager's `requiredReports`). Catalog groups are glass cards; "Connections" reads
"Tools and services".

### EngagementTeam

`.team-editor[data-kind=engagement]`: coral `--eng` for selection, the primary button and links; serif headings
(`--font-serif`) for the title and inspector; "Where it can work" (working folder Can write / Read only, reference
folders Read only); the provenance line (`components/team/TeamProvenance.tsx`, `team-provenance`): "The Architect
built this team from your interview on {date}." from the project's first non-org-change setup run the renderer holds
(history or live runs), else "Describe a change and the Architect proposes it.", with Read the engagement plan
(Project settings, plan section) and Review with the Architect (an org chart review session, or Open the Architect
session while one is open). Role and group names come from the project; nothing from the board's sample is shipped.

### Import (team-import)

Two-column glass dialog: From row (A folder of agent files / Another OrgAI project / A kit), Found N / M selected with
Select all, a glass row per agent (checkbox, Reports to and Level selects with plain tier words and the model id, clash
strip Keep both / Replace mine / Skip mapped to `AgentImportChoice.action`, dropped-tools line), and "What will change"
(groups with "+ name" chips, team size line). Kit export / import dialogs restyled. Engagements get coral accents.

## Deviations from the boards

- Chart is the React Flow editor, not the board's static three-column grid (keeps every editing path). No "+ Add a role
  to {group}" button per group column: Add a report on the selected role's toolbar and node menu, Add group and Add role
  cover it.
- "Templates" is the existing Start from menu (Save as template, Apply a template, Architect, Import); Import also has
  its own header button as on the board.
- Theme dropdown lists only Org chart in Team (see above).
- "All changes saved" and the project tabs / kind badge are the shell's header (ov-shell), not drawn here. EngagementTeam's
  Undo / Save changes buttons are not built: the Team saves as you edit and Undo lives on each change's notice.
- "Redo the interview" reads "Review with the Architect": the session it starts is an org chart review, not the first
  interview.
- Import's primary button stays in the dialog footer (always visible), not at the bottom of the aside.
- Tier words: the board has three (Fast / Standard / Most capable); the app has four tiers, so deep reads "Advanced".

## Needs runtime (asked of ov-runtime, 2026-11-22)

1. `Role.maxConcurrent` ("How many at once", node chip "up to N"): built, hidden behind `ROLE_CONCURRENCY_SUPPORTED`
   in `lib/roleStaffing.ts` until the field exists.
2. `Role.knowledgeWrite` ("Records what it learns in Knowledge", engagements): built, hidden behind
   `ROLE_KNOWLEDGE_WRITE_SUPPORTED`.
3. Import from another folder (`sourcePath` + folder picker) and from another OrgAI project (`fromProjectId`): the
   buttons are `aria-disabled` with "Not available yet" through `importSourceSupport()` in `lib/agentImport.ts`.
4. The board's "Suggested" role card (Add / Dismiss) has no token-free source; not built.

## Verified

- `npm run typecheck` clean; `npx vitest run`: every renderer test passes (failures only in `src/cli` and `src/main`
  symlink / ink-version tests that this change does not touch); `npm run build` ok.
- e2e on the mock adapter: `team.mjs` (new checks: node menu Duplicate entry, the selected-role toolbar, Duplicate and
  Undo), `import.mjs`, plus the engineers' runs of multi-provider, connectors, connections, skills, live-changes,
  layout, engagement2. See the final report for team-files, org-change, presets, layout and canvas results.
- Screenshots of the Team tab (code project and engagement) at 1600x1000 and 1024x640 in dark and light.

## Open

- Screen-reader speech of the node toolbar, tier radios and chips; the zoom readout is not announced (aria-live off).
- Performance of glass on charts with many roles was not measured (nodes deliberately have no backdrop-filter).
- The provenance date depends on run history the renderer has loaded for the project.
