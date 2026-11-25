# UI polish pass: Team tab, Import and kit dialogs, scene chrome (Pocket Office, Factory floor)

Date 2026-11-24. Built from dev (aa1bcbd1), mock adapter, throwaway data dir. Driven by a throwaway Playwright script on
`e2e/lib.mjs` (not committed) at 1600x1000 and 1024x640, dark and light (`data-theme`), screenshots opened with the
image reader. Shots are in `e2e/shots/polish/` (gitignored). Boards compared by reading `impl-team.md`, `impl-scenes.md`
and the two UX reviews (the board HTML was not re-rendered).

Data used: a team of 3 (the default), 15 and 60 roles with long names and descriptions (`t15L-*`, `t60L-*`), a 40-role team
with one lead holding 39 reports (`t40-*`), a role with all 12 tools, 7 services, a cap of 3 at once and a 80-character name
(`r-*`), an engagement (`e-*`), team files changed on disk with a duplicate-parent file (`f-*`, `g-*`), an import of 14
agent files with slug clashes, unknown models and dropped tools (`i-*`), template dialogs and the kit export (`d-*`),
Pocket Office with 15 agents (`s-office15-*`), Factory floor 3D with 15 agents and the floor plan with 40 agents
(`s-factory15-*`, `s-factory40P-*`).

## Findings

Severity: High = blocks use or loses content; Medium = visible defect or unreachable content; Low = polish.
No High finding was found in this area.

| # | Sev | What, where | Shot | Status |
|---|-----|-------------|------|--------|
| 1 | Medium | Team header: "15 roles in 1 group" ran under the Add group button at 1600x1000 with the role panel open (header is about 980 px wide, the labelled buttons need about 870), cut mid-text with no ellipsis. | `t15L-1600-dark` | Fixed: the count shrinks and ends in an ellipsis; "in N groups" goes below 1100 px of header width and moves to the title tooltip (`teamHeader.css`, `TeamHeader.tsx`). |
| 2 | Medium | Import dialog, 1024x640: the "What will change" card is sticky and taller than the dialog body, so its last lines (team size, the three notes) could not be reached until the whole list ended. | `i-1024-dark-1` | Fixed: the card scrolls inside (max height of the window minus head and foot) (`import.css`). |
| 3 | Medium | Apply a template dialog: the radio in each card stretched to the card's height, so the radio and its focus ring were a tall oval. Both themes. | `d-apply-1024-light` | Fixed: `align-self: start` (`team.css`). Re-shot: `v-apply-1024-dark`. |
| 4 | Medium | Engagement Team: the role panel, catalog and assistant tray kept violet primary buttons and a blue "Show" link while Add role and the provenance links are coral (UX review L5, never fixed). | `e-1600-dark` | Fixed: primary buttons and links inside `.team-editor[data-kind=engagement]` take `--eng`; disabled buttons keep the neutral fill (`teamHeader.css`). Re-shot: `v-eng-1600-light`. |
| 5 | Medium | Role panel header at 1024x640: with a long name the sticky header was 130 px of a 560 px panel (two-line 28 px title), leaving about 330 px of sections. | `r-pane-1024-light-0` | Fixed: under 760 px window height the name takes one line (full name in its title) and the header padding shrinks, about 40 px back (`roleEditor.css`). Re-shot: `v-role-1024-dark`. |
| 6 | Low | Import row hint run-on: "Not recognised, so the Standard model was used.Runs on Standard...". | `i-1600-dark-0` | Fixed: trailing space (`ImportAgentsDialog.tsx`). |
| 7 | Low | Import "What will change" chips for new roles: with a long name that wraps, the "+" sat in the middle of the chip, at the start of the second line. | `i-1024-dark-0` | Fixed: baseline alignment and line padding (`import.css`). |
| 8 | Low | Targets under 24x24 in the Team panels and the scene filter: text links ("Edit", "Open full editor", "Change roles", catalog link) 19 to 21 px high, colour swatches 22x22, the Pocket Office and Factory "Show" segments 22 px high. | measured, no shot | Fixed: 24 px minimum (`roleEditor.css`, `office.css`, `factory-chrome.css`). Remeasured on the Team tab and both scenes. |
| 9 | Low | Pocket Office stage: a white square in the bottom right corner in the dark theme where the two scrollbars meet. The same white square shows at the bottom of the sidebar rail at 1024 (not mine). | `s-office15-1600-dark`, `v-role-1024-dark` | Fixed for the stage (`office.css`); the global `::-webkit-scrollbar-corner` rule sent to polish-shell. |
| 10 | Medium | Team assistant tray at 1600x1000: the open tray (cost hint, explanation, "What I looked at") takes about a third of the height, so a 15-role chart fits at 47% and a 60-role chart at 30%. At 1024x640 it already folds to the Ask bar. | `t15L-tidy-1600-dark` | Left for the owner (see below): the fold default follows `max-height: 760px` and e2e (`team.mjs`) expands it by hand; moving the default changes that script. |
| 11 | Low | Header at 1024: seven controls are icons (Add group, Import, Theme swatch, Layout, Start from, Team files, plus Add role). Names are in the accessible name and tooltip; the Theme swatch is a gradient square that reads as a selected state. Team files keeps its tone colour but not its text ("not committed", "problem"). | `t3-1024-light` | Left: design decision (UX review M2, partly worked through by the compact mode). |
| 12 | Low | Theme menu has one item. | `m-team-theme-1600-light` | Left: owner decision 2026-11-19 (UX review M3). |
| 13 | Low | Wide chart (40 roles under one lead), 1024x640: when the selected role is entirely off screen (script click), the selected-role toolbar is cut at the chart edge ("Add a report", "Duplicate"). With the mouse or keyboard React Flow pans the role in, so it was not reproduced by hand. | `t40-sel-1024-light` | Left: edge case; the placement logic in `RoleNode.tsx` only handles a node that is at least partly visible. |
| 14 | Low | Role panel sticky header has no divider, so scrolled content is cut by the header edge with no cue ("Cannot edit files" chip half shown). | `e-sel2-1600-dark` | Left: the board draws it borderless. |
| 15 | Low | Notice row: "Added Researcher copy under Orchestrator, with the same tools, services and model as Resea..." is cut with an ellipsis before Undo. | `g-dup-1024-dark` | Left: one fixed 32 px row by design (teamHeader.css); full text is in the live region. |
| 16 | Low | Factory floor plan (40 agents, 1024x640 dark): the "Plan 0 of 3 done · 1 bloc..." board is under the top row (Find and Show) at the default fit, and its text is cut. | `s-factory40P-1024-dark` | Left: both come from the camera fit and the plan board size in `engine/` and `cameraController.ts`, which are not part of this brief. |
| 17 | Low | Import warnings: 8 long "Duplicate slug ..." lines in one box (no cap), which pushes the agent rows two screens down at 1024. | `i-1024-light-0` | Left: content from main (`warnings`); a collapse is a design choice. |
| 18 | Low | Catalog switches (`button.switch`) are 32x20, sidebar `needs-you-row` 16x32. | measured | Left: shared `components/ui` and shell, sent to polish-shell. |
| 19 | Low | Role panel: "Instructions" is a display-font title while "Responsibilities" under it is a plain label. | `e-sel2-1600-dark` | Left: copy and hierarchy choice for the owner. |

Counts: 19 findings, 0 High, 6 Medium (5 fixed, 1 left), 13 Low (5 fixed, 8 left, one of those a hand-off).

## Checked and fine (no change)

- Header menus (Theme, Layout, Start from, Team files, Add role, Add group lead) open under their buttons and stay inside
  the window at 1600 and 1024, both themes; names, check column and notes read well; light glass keeps a visible edge.
- Role cards: initials contrast on every colour (unit test), selected ring plus bar, chips "Standard / up to 3 / 12 tools
  / 7 services", warnings glyph; light and dark.
- Role panel: tier choice, model sentence, exact-model block, stepper ("Up to 3", "No limit of its own"), chips with "+4
  more", service rows with long names ellipsised, Instructions, delegation, Who it is, colour swatches.
- Add a connection / Add a skill chooser, Save as template, Replace the team with a template, Export a kit: contained in
  the window at 1024x640, scroll inside, focus ring on the first control.
- Pocket Office: Find a person, Show filter, zoom group, message log card and Pause motion, nameplates, both themes and
  sizes. Factory floor: top row, bottom toolbar, stack-light legend (hidden at 1024 as designed), Floor log chip,
  nameplates over the 3D scene in both themes, the floor plan with 40 agents. Nothing overlaps at the default fit except
  finding 16.

## Left for the owner

1. Open Team assistant tray default at tall windows (finding 10): keep it open (current), or fold to the Ask bar below
   about 1100 px of height and let "Recommend tools and skills" open it. Needs `e2e/team.mjs` (`expandAssistant`) to be
   told; owner decision on how much of the tab the tray may take.
2. Header labels at 1024 (finding 11): keep icons, or move Layout, Start from and Team files into one "More" menu so
   Import and Add group keep text.
3. Theme dropdown with one option (finding 12).
4. A cap or fold for import warnings (finding 17).

## Verification

`npm run typecheck`, `npx vitest run src/renderer` (247 files, 3401 tests), `npm run build`; then alone, one Electron at a
time: `e2e/team.mjs`, `org-change.mjs`, `import.mjs`, `team-files.mjs`, `office.mjs`, `layout.mjs` all passed;
`factory-floor.mjs` (about 25 minutes on a busy machine; a first run was stopped by the 30 minute background limit, the second passed with 447 checks) all passed. No e2e file, test id or measured size was changed.

Not looked at: the org change session with a proposal card (needs an Architect session; not driven), team files in
conflict (only the "problem" chip and its popover were seen, not the approval card), kit import needing secrets (needs the
native file picker), the 3D Factory floor with 40 agents in the light theme, reduced motion and Pause motion in the
scenes (no motion rule was touched), screen readers, and Retina or touch devices.
