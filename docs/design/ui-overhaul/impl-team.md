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

## Runtime contract (ov-runtime branch, merged 2026-11-22)

1. `Role.maxConcurrent` (1..`ROLE_MAX_CONCURRENT_LIMIT`, missing = no cap of its own): the inspector's "How many at once"
   stepper (`role-concurrency`; "No limit of its own" when unset, Fewer starts a cap at the limit, More past the limit
   clears it) and the node chip "up to N" (`role-node-many`).
2. `Role.knowledgeWrite` (engagements; missing = may write, false = reads only): "Records what it learns in Knowledge"
   (`role-knowledge-write`); ticking clears the field.
3. Import: "Choose another" calls `importSources.pickAgentFolder()` and previews / applies with `sourcePath`
   (`import-from-here` goes back); "Another OrgAI project" shows a project select and uses `fromProjectId` (inert with a
   reason when there is no other project). `importSourceSupport()` turns both on when the bridge has the picker.
4. Not built: the board's "Suggested" role card (Add / Dismiss) has no token-free source.

## Verified

- `npm run typecheck` clean; `npx vitest run`: every renderer test passes (failures only in `src/cli` and `src/main`
  symlink / ink-version tests that this change does not touch); `npm run build` ok.
- e2e on the mock adapter: `team.mjs` (new checks: node menu Duplicate entry, the selected-role toolbar, Duplicate and
  Undo), `import.mjs`, plus the engineers' runs of multi-provider, connectors, connections, skills, live-changes,
  layout, engagement2. See the final report for team-files, org-change, presets, layout and canvas results.
- Screenshots of the Team tab (code project and engagement) at 1600x1000 and 1024x640 in dark and light.

## Reviewer pass (2026-11-22) and fixes

- H1 fixed: the NodeToolbar is portalled but React bubbles its events to the node wrapper, so Duplicate re-selected the
  original. The toolbar row stops click, double click, context menu, pointer and mouse down and every non-arrow key;
  e2e/team.mjs now checks the copy is selected and its description has focus after Duplicate.
- M1 fixed: the required-review box now says what is enforced: "{manager} must always involve this role before
  finishing" (it is the manager's `requiredReports`, not a merge gate).
- M2 fixed: imported names, descriptions, slugs, tools and original models go through `showHidden`, and a row whose
  name, description or prompt has hidden characters says so (`import-hidden-chars`). (Pre-existing gap.)
- M3 fixed: "Review with the Architect" goes through `useArchitectForm` (asks before a full review, names the cost,
  busy while starting).
- M4 fixed: the line says "Your first Architect interview was on {date}." (a summary cannot tell whether the proposal was
  applied).
- Lows fixed: raw glow shadows removed (selection is ring plus `--elev-2`), stable context value for the node actions,
  the theme note is the item's description, zoom buttons disable at the limits, new roles avoid the provenance line,
  the duplicate's notice says it carries the same tools, services and model. Not fixed: L2 (`black` in the avatar mix,
  contrast not measured by a test), L3 (the toolbar comes late in Tab order; Shift+F10 on the node opens the same
  actions), L8 (the Ask bar's raw input).

## UX walk (`docs/design/ux-review-team-overhaul.md`, status checked in the code 2026-11-23)

The walk was first-time-user, mock data, build 26e2fb41: verdict "mostly working, one High". Fixed since (by the review
fixes above or the runtime merge): M6 in part (Another OrgAI project and Choose another are wired through `importSources`,
see "Runtime contract"). Confirmed still true in the code: M3 (Theme dropdown has one item, "Org chart") and M4 (Add group
opens the same popover titled "Add a role"). Not re-checked, so treat as open: H1 (the "Review with the Architect" confirm
clipped its cost sentence; the body text is built in `ArchitectDialog.tsx`), M1 (toolbar clipped at the canvas edge, no
pan-into-view), M2 (header loses labels and Theme at 1024), M5 (the toolbar is a late Tab stop; Esc on a node loses focus),
M7 (panel header truncated and see-through), M8 (chart small at 1024x640 because the assistant tray is tall), and the Lows
(L1 to L7). Nothing here was re-walked after the fixes.

## Open

- Screen-reader speech of the node toolbar, tier radios and chips; the zoom readout is not announced (aria-live off).
- Performance of glass on charts with many roles was not measured (nodes deliberately have no backdrop-filter).
- The provenance date depends on run history the renderer has loaded for the project.

## Since the first pass (read on dev 2026-11-23)

- The "UX walk" section above is partly out of date. Fixed since (the Medium round and the finish round): the selected-role
  toolbar stays inside the visible chart (right-aligned or below the role when needed) and is the next Tab stop after its role;
  Escape on a role keeps focus on it; a new or duplicated role is panned into view (two passes); Add group opens "Add group
  lead"; the header shows a compact Theme control at 1024; the chart may zoom out below React Flow's default; the engagement
  header carries the latest change's Undo; the import dialog and Tools and services links were reworded.
- Still true: the Theme dropdown has one item (M3). Not re-checked: H1 (the "Review with the Architect" confirm clipping its
  cost sentence) and the Lows.
- The Team assistant tray remembers the user's last fold choice across tab switches in memory (`lastFold`); a restart follows
  the window size and results again.
- Role cards: avatar contrast has a unit test (`roleAvatarContrast.test.ts`), which closes the "contrast not measured" Low L2 for
  the avatar mix only.
- From another surface (terminal, TUI, headless policy), approving an org chart card that drops or replaces a role carrying
  `maxConcurrent` or `knowledgeWrite: false` is refused as a revise (`impl-runtime.md`).
