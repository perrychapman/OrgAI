# OrgAI UI review 2: placement, hierarchy and brand direction

Author: UI Lead. Status: proposal, documentation only (no renderer code was changed). Builds on `ux-review-placement.md` (Researcher walkthrough at dev HEAD `1108b74`, ids P1-P15 and B1-B10), `spec.md`, `plan.md`, `ui-review.md` (phase 1, mostly landed) and `.orgai/ARCHITECTURE.md`. Where this document and `spec.md` differ, `spec.md` is updated alongside (Revision 3 note and section 9) and this document wins.

How to read the evidence. File references are `path:line` at the worktree base. Shots are the files in `e2e/shots/` (fresh `layout-*`, `conn-*` and `runs-*` from the e2e:free run; the Researcher's `ux/placement/` folder is gone, so its shot names are cited only as "walkthrough"). Numbers marked "walkthrough" come from `ux-review-placement.md` section 6; numbers marked "code" were counted from source in this audit; numbers marked "computed" are WCAG 2.x relative-luminance ratios computed here. I did not re-run the app, so any walkthrough measurement is the Researcher's, not mine.

Ids used below: `P#` and `B#` are Researcher findings; `AU#` are findings from this code audit (section B.0).


## Status after Phases 1-2 (4b8b7a1)

Landed on dev: Phase 1 (1A tokens, brand, primitives; 1B shell) and Phase 2 (2A run workspace, 2B decision cards, 2C transcript and History), plus two follow-up rounds after the UX re-walk (`ux-review-placement-2.md`, Q1-Q15). Phases 3 and 4 are open. Where the follow-ups changed a decision below, this block wins; the original rows are kept as history and marked "superseded, see status block".

Amended decisions:
- **Tray placement.** The tray sits beside the stage only in a frame of at least 1500 x 560 px, 420 to 480 px wide; under the stage otherwise. Supersedes B.1 decision 2 (1100 x 560) and the B.2 canvas-size targets.
- **Stage budget.** 55 percent of the frame with a permission open; it may drop to 36 percent while a question card with inline options is open at 1024x640 (the Q1/Q4 trade-off). Fit-to-view keeps a minimum zoom of 0.8 when the stage is under 300 px tall, and the chart pans.
- **Question options** are always inline, in compact mode too. The compact Details toggle covers helper text only.
- **Decision chips** never shrink. Under 700 px of tray width they become numbered chips (label in tooltip and aria-label) and form one roving Tab stop; the tray never scrolls horizontally.
- **Needs-you unit is decisions**, counted at every level ("3 decisions · 1 run").
- **End session** is always labelled (never icon-only).
- **Stopped tone.** `stopped` is its own neutral tone, distinct from failed.
- **Permission cards** never clip a Bash command silently: multi-line and clipped markers, the full command scrollable, and in compact mode Details takes focus.
- **Markdown links** show a host suffix.
- **Light status text tokens darkened** (`tokens.css`, light block and its prefers-color-scheme mirror): `--success-text #096a48` (was #0b7a53), `--warning-text #7d4a00` (was #8f5400), `--danger-text #b3242f` (was #c62f3b), `--info-text #0a5fa2` (was #0b6bb5).

Commits: 487e864 (1A), 3f9f517 (1B), 9ee86a9 (2A), 4d545f6 (2B), e4734fb (2C); follow-ups 544a7de and 4b8b7a1.

---

## A. Summary

The UI already gets several hard things right. It has a real token layer with both themes (`styles/tokens.css`), a closed status vocabulary (`lib/runStatus.ts`), a docked decision tray that never floats over the canvas (`components/layout/CanvasFrame.tsx`), radii and type sizes that are almost entirely token-driven (radii: 108 of 110 declarations use `var(--radius-*)`; every `font-size` is a token, code count), accessible primitives, and a decision-card shell whose copy is consistent. Dark and light themes are at parity, and the logo tile reads in both. Functionally nothing here is broken; the problem is that the screen does not yet look designed around the logo, and it spends too much of a small window on chrome.

Three structural reasons it does not yet feel modern, clean and on-brand:

1. **Chrome outweighs content and status is shouted from too many places.** Three stacked rows (topbar 58, run tabs 37, run header 44 = 139 px, walkthrough) sit above the canvas at every size, the sidebar is 232 px at 1024 because the spec's auto-collapse was never built (AU2), and one fact ("Needs you") is carried by 8+ elements (P3). Six components render run status (App, RunHeader, RunTabs, Sidebar, RunHistory, AgentNode) with no rule for which one is authoritative at which level.
2. **There is no visual system, only tokens.** The three dark surfaces sit 1.8, 2.8 and 4.3 lightness points apart (L*), so cards and panels are separated by borders rather than by steps (B5). Five badge families coexist (`.pill`, `.badge`, `.chip`, `.chip-btn`, role chips) and the UI has 20 `pill` mentions across 8 TSX files and 43 `<Badge>` call sites. Two tab idioms stack within 37 px of each other, plus segmented controls used as navigation (the side-panel tabs). 69 distinct `padding` declarations (45 with raw px) and 53 raw-px `gap`s show the 4 px grid is a convention, not a constraint.
3. **The brand is a 26 px icon and nothing else.** The logo promises a violet-to-blue gradient and an org-chart glyph; the UI delivers a flat `#6e4df5`, no gradient in any control, and no glyph in the empty states (B1). Worse, colour semantics collide with the logo's own colours: violet is accent, working (legend), the Orchestrator role and the active nav fill; blue is message, stopped and the Implementer; orange is "Mock mode", "Needs you" and the Researcher; green is done and the Reviewer (B2, AU3).

The fix is a small, strict system (section C): three surface steps with visible gaps derived from the tile colour, one gradient with a short allow list and a hard forbid list, solid accent buttons (white on the gradient fails AA, so the gradient never carries text), role avatars that cannot collide with status hues, one `Badge`, one tab idiom for navigation, five type sizes and two weights. It lands in four phases (section D), with the shell and primitives first and serialized, then run workspace, views and polish in parallel.

---

## B. Placement review by region

### B.0 Audit findings that the walkthrough did not make

| Id | Finding | Evidence |
| --- | --- | --- |
| AU1 | **Root cause of P1.** The tray docks beside the canvas when `(min-width: 760px) or (max-height: 420px)`. At 1024x640 the frame is about 350 px tall, so the `or` clause forces the side-by-side layout in a frame that is only about 500 px wide (776 main minus the 280 px side panel). Spec 12.1 says 900 px and says nothing about height. | `styles/layout.css:79-93`, `docs/design/spec.md` 12.1 and 12.7 |
| AU2 | **Sidebar auto-collapse and Ctrl/Cmd+B are not implemented.** `--sidebar-w-collapsed` is defined and unused; there is no 1180 px rule or sidebar shortcut in the renderer. The sidebar is always 232 px. | `styles/tokens.css:293`; `styles/shell.css:5-7`; grep for `1180` and `sidebar` shortcuts: none; shortcuts that exist are `RunTabs.tsx:39` (tab switching) and `LiveRunView.tsx:474` (jump to decision) |
| AU3 | **"Working" has three colours.** Legend paints it `--accent` (violet); the token says `--state-working: var(--info)` (blue); node rings and glow use `--role` (the user's role colour), so a working Implementer is blue-ringed and a working Researcher orange-ringed, the orange being the colour of "needs you". | `views/LiveRunView.tsx:666-668`; `styles/tokens.css:302`; `styles/run.css:60-75`, `styles/tokens.css:329-333` |
| AU4 | **`--text-caption` is 11 px and used 48 times** (`var(--text-small)` 93, `--text-body` 20, `--text-mono` 10, `--text-title-sm` 8, `--text-title` 5, `--text-title-lg` 1). Legend, hints, reset lines, badge text, tray meta, run-header meta: all 11 px. The spec itself calls 11 the app minimum and rule 20 says 12. | `styles/tokens.css:251`; count over `styles/*.css` |
| AU5 | **Brand row is hand-built.** `.brand` hard-codes `padding: 16px 16px 12px`, `gap: 10px` and `letter-spacing: .3px`; `.brand-mark` paints a gradient behind the PNG tile (the PNG has a 16 px transparent margin on a 512 canvas, so a hairline of gradient can fringe the tile's edge at 26 px; in the 1024 shot the mark reads as a violet-edged square). The Mock-mode badge is a second row, making the block 76 px tall. | `styles/shell.css:17-37`, `components/Sidebar.tsx:73-83`; shot `layout-12-live-run-1024x640-dark.png` |
| AU6 | **"Mock mode" is shown in three visible places plus a tooltip:** sidebar badge (all screens), Projects topbar badge, the New project form checkbox, and the run-header hint "Starts a session (mock, no tokens)". All in `warning` tone, which is also "Needs you". | `Sidebar.tsx:77-83`, `ProjectsView.tsx:256-260`, `ProjectsView.tsx:207`, `RunHeader.tsx:167` |
| AU7 | **Where run status is rendered (code):** topbar badge (`App.tsx:75-80`), run header pill (`RunHeader.tsx:82`), run tab dot plus a second glyph (`RunTabs.tsx:120, 371-379, 424-428`), sidebar project subtitle (`Sidebar.tsx:139-145`), sidebar run dots (`Sidebar.tsx:183-199`), sidebar Needs-you block (`Sidebar.tsx:93-127`), History rows (`RunHistory.tsx:130,170`), node state (`AgentNode.tsx:58`), tray chip (`DecisionCard.tsx`). Nine carriers, three of them (topbar, header, tab) on screen together in Live. |
| AU8 | **P15 does not reproduce from source.** The DOM order is skip link, `Sidebar`, `main` (`App.tsx:56-67`), so the sidebar is first. The Researcher's tab order probably began from a focused `#main-content` (the skip link focuses it). Treat as "verify, then add a second skip link". | `App.tsx:56-67` |
| AU9 | **e2e is coupled to the elements this review moves:** `e2e/lib.mjs:379` and `e2e/worktree.mjs:43` read run status from `.topbar .pill .dot`; `layout.mjs`, `connections.mjs` click `.nav-item` with text `Settings`; `layout.mjs:23` reads `.sidebar-footer .pill`; `layout.mjs:37` reads the path pill; `layout.mjs:179` asserts the run header sits under the tabs. Selector changes are part of every brief that moves these elements. | `e2e/*.mjs` |
| AU10 | **Disabled state is `opacity: .5`** on the same fill. A disabled primary is a dimmed violet that still reads as clickable. | `styles/controls.css:22-25` (B7) |
| AU11 | **Run tabs use warm fills and three different trailing glyphs** (`CircleAlert` waiting, `Link2` unread note, `Pencil` draft) on top of the status dot; a waiting tab is filled with `--warning-soft` and an orange border. | `styles/run-tabs.css:42-46`; `RunTabs.tsx:371-379` (B4, B9) |
| AU12 | **Spacing is not a constraint.** 69 distinct `padding` declarations, 45 with raw `px`; 53 `gap` declarations with raw `px`. Radii and type sizes are fine. | counts over `styles/*.css` |
| AU13 | **Window title names the app first** (`OrgAI · R1 · prompt`); rule 7 says name the project and run. | `App.tsx:41` |
| AU14 | **Ambient animation:** 14 `infinite` animation declarations; four loops on node rings alone (`breathe`, `spin` x2, `ripple`, `blink`). A reduced-motion fallback exists for some (`shell.css` 285, `ui.css` spin) but the node ring loops are the visual noise on a working canvas. | `styles/run.css:62-80,152`; `grep infinite styles/*.css` |

### B.1 Decisions on the nine big questions

| # | Question | Decision | Why |
| --- | --- | --- | --- |
| 1 | Merge run tabs and run header? | **Yes, into one 40 px run strip.** Tabs on the left (the active tab already carries `R1`, status dot and the clipped prompt, full text in its tooltip); the active run's actions on the trailing edge (Interrupt turn, End session, Org retrospective). The 44 px run header row is deleted. Its metadata (cost, agents, steps, "unattended", "Continues R1") moves to a quiet 12 px text line at the left of the canvas toolbar (`FrameToolbar`), together with the Hide-finished switch, zoom buttons and the legend `?`. | P2, P6. The strip becomes the single "which run" carrier; the toolbar is canvas-owned chrome and replaces the controls that float over the canvas today. Chrome above the canvas drops from 139 to 88 px (topbar 48 + strip 40). Rules 1, 2, 11. |
| 2 | Tray under the canvas or beside it? (superseded, see status block: beside only at 1500 x 560, 420-480 px wide) | **Under the canvas by default; beside only when the frame is at least 1100 px wide and 560 px tall.** Delete the `or (max-height: 420px)` clause (`layout.css:79`). Below 480 px frame height the card renders compact (header and footer visible, body behind a "Details" toggle) so the stage keeps at least 55 percent. This overrides the 900 px threshold in spec 12.1 and 12.7 (superseded in the spec note). | AU1, P1, P7. Beside-docking only pays on large monitors; on the supported 1024 to 1600 range the canvas width is the scarce resource. A tray under the canvas also sits next to the composer, which is where a user answers. Rules 1, 23. |
| 3 | Sidebar footer? | **One 52 px account row** and a gear: `[dot] Claude · Max   [bar 29%]   [gear]`. Clicking the row opens a `Popover` with all plan windows, reset times, "Updated" and Refresh and a link to Settings > Connections. The Needs-you block and the usage meter stop competing for height. In mock mode the row says "Mock adapter" with no bar. | P4, P9, P10. Rule 4: usage is non-critical status, the gear is an entry point. Footer height 237 to 52 px. |
| 4 | One tab idiom? | **Underline tabs for all navigation** (project sections, side-panel sections): 40 px row, 2 px bottom indicator in the brand gradient, label in `--text-secondary` and `--text-primary` when active. **Run tabs keep a distinct chip-tab shape** (flat, 6 px radius, `--surface-2` fill when selected) because they are documents, not sections (NN/g: file-tab look for documents). **Segmented control only for value choices** (theme, filters, mode), never navigation. | P6, rule 8. Today there are three idioms for navigation: boxed segmented tabs (`shell.css:334-358`), file tabs (`run-tabs.css:21-41`) and a segmented control for the side-panel tabs (`transcript.css`). |
| 5 | Path display? | **Folder name only** (last path segment), `--font-mono` 12 px, `--text-tertiary`, folder icon, full path in the tooltip and in Settings > General with a copy button. If the project name equals the folder name, hide the folder. Never render a full path in a pill. Helper `lib/paths.ts` (`folderName`, `abbreviatePath`). | P5, P11. The recognisable part of a path is its end, and truncating the end loses it. |
| 6 | One carrier of run status per level? | **Sidebar level:** the project row dot plus a count badge (needs-you count) and, when something waits anywhere, one compact "Needs you · n" row that opens a popover list. **Project level (topbar):** a status `Badge` only on non-Live tabs and only when something needs the user. **Run level:** the active run tab (dot plus sr-only word) and nothing else on the strip. **Decision level:** the tray. **Node level:** the node. The run-header pill, the second tab glyphs and the filled orange sidebar rows go. History keeps one status `Badge` per row because status is the content there. | P3, B4, B9, AU7. Rule 11. |
| 7 | Org chart tab primary action? | **"Add role" is the primary of the canvas toolbar.** "Auto-layout" is secondary. The AI draft panel has one heading ("Design with the Architect") and its action is primary only while the chart is empty; once roles exist it is a secondary button. The panel starts at 320 px and starts collapsed below 1100 px window width unless a role is selected. | P8. One filled button per region, and direct editing outranks drafting once a chart exists. |
| 8 | Mock mode marker? | **One persistent 20 px neutral tag "MOCK" with a flask icon beside the wordmark** (tooltip: "ORGAI_MOCK is on: runs use scripted data, no tokens are spent"). Remove the Projects topbar badge and the sidebar badge row. The New project checkbox keeps its explanatory copy. Colour is neutral grey (`--surface-3`, `--text-secondary`), never orange. | P9, B2, AU6. |
| 9 | Sidebar DOM order for keyboard? | **Keep sidebar first in the DOM** (already true, AU8) and add a second skip link "Skip to sidebar" visible on focus, plus a Playwright check that the first four Tab stops are skip link, skip-to-sidebar, brand collapse toggle, Projects. | P15 / AU8. |

### B.2 Vertical and horizontal budget (targets)

| Measure | Now (walkthrough) | Target (canvas-size rows superseded, see status block) |
| --- | --- | --- |
| Chrome above the canvas on Live | 139 px (22% of 641) | 88 px (14% of 641): topbar 48, run strip 40 |
| Composer height with label, mode toggle, hint | about 150 px at 1024x640 (shot `layout-12-live-run-1024x640-dark.png`) | 96 px: textarea two rows, mode toggle on the label line, hint moves to placeholder and the `?` tooltip |
| Sidebar width at 1024 | 232 px | 56 px rail below 1180 px, 232 px at and above (Ctrl/Cmd+B toggles) |
| Sidebar footer height | 144 to 237 px | 52 px |
| Brand block | 76 px | 48 px (aligned with the topbar so the rules line up) |
| Live canvas at 1024x640 with 3 decisions | 216 x 366 | about 900 x 345 (rail 56, side panel collapsed to a 40 px rail below 1100, tray under the canvas compact) |
| Live canvas at 1424x881 | 480 x 538 | about 800 x 546 |
| Live canvas at 1600x1000 | 592 x 657 | about 952 x 480 with the tray under it (the tray's body scrolls inside 40 percent of the frame) |
| Org chart canvas / panel at 1024 | 416 / 360 | about 590 / 320 (panel 320 and collapsed unless a role is selected: 912 / 40) |

### B.3 Sidebar

Current anatomy (`components/Sidebar.tsx:72-218`, `styles/shell.css`): brand row (26 px mark, "OrgAI" 14 px semibold, 16 px padding) then a Mock-mode badge row, then `Projects` and `Settings` nav items, then (when waiting) a "Needs you (n)" block of filled orange rows (about 190 px with three items), then a "Workspaces" label, the project list with chevrons and run children, then the footer: auth pill, three usage bars each with a reset line, "Updated 1:15 AM", Refresh. Walkthrough: footer 237 px at 1424 (28 percent of 842), project list about 100 px for two projects, brand block 76 px; at 1024 only about 115 px remain for projects.

Violations: rule 4 (usage readout owns more height than navigation), rule 7 is not relevant, rule 11 and P3 (three carriers of one fact), rule 10 (account pill, mock badge, count chips), rule 18 and B1 (brand is a 26 px icon), P4, P9, P10, B4, AU2, AU5.

Target (expanded, 232 px; rail, 56 px):

```
+-- 232 --------------------+      +-- 56 --+
| [mark32] OrgAI  [MOCK]  « |      | [mark] |   row 48 px, mark 32, wordmark 16/600
+---------------------------+      +--------+
| [grid] Projects           |      | [grid] |   nav 32 px
| [bell] Needs you · 2    ▾ |      | [bell]2|   only when n > 0, 32 px, opens popover
+---------------------------+      +--------+
| PROJECTS             [ + ]|      |        |   label 12/600 tertiary (the "Workspaces" label is renamed)
| ▸ ● Notes API       2     |      | [NA]●  |   project row 32 px, dot + count badge
|   ● R1 Add rate limit...  |      |        |   run rows only when expanded, 28 px
| ▸ ○ OrgAI                 |      | [OA]   |
|                           |      |        |
+---------------------------+      +--------+
| [●] Claude · Max  ▮▮▯ 29% |      | [●]    |   52 px account row, opens popover
| [gear]  App settings      |      | [gear] |   32 px
+---------------------------+      +--------+
```

Specifics:
- Brand row is the `BrandLockup` component (section C.7). The collapse chevron sits at the trailing edge of the row.
- `Needs you · n` becomes a single row that opens a `Popover` (not an inline block). Rows inside: `<project> · R2: <prompt>` and the kind ("Permission", "Question", ...), reusing `waitingItems()` from the current block. This keeps "one click from anywhere" (spec 2.1) at 34 px instead of 190. Delete the filled `.nav-run.waiting` orange boxes (B4); the only orange in the sidebar is a 6 px dot and the count.
- Project rows: dot colours come from `lib/runStatus.ts` tones; the subtitle ("Last run 2h ago · Finished") stays but at 12 px and only on hover or when the row is active, otherwise one line. Tooltip shows the full path. Chevron expands open runs (two levels, rule 5; do not add agents).
- `Settings` leaves the nav and becomes a gear icon button in the footer with accessible name "App settings". The page heading is "App settings" (the topbar h1 is currently "Settings", `AppSettingsView.tsx:136,182`, over an `h2` "App settings" at `:187`).
- The "Workspaces" label (`Sidebar.tsx:129`) becomes "Projects" (P10).
- Auto-collapse below 1180 px and `Ctrl/Cmd+B` per spec 2.1 (AU2). State in `localStorage`, exposed by a small hook so `Sidebar` and `App` stay decoupled.

### B.4 Topbar

Current anatomy (`App.tsx:68-120`, `shell.css:302-365`): `h1` project name (14 px semibold), then a `.pill` with the full working directory, spacer, a status pill, the Saved indicator, then the boxed segmented project tabs `Live | History | Org chart | Settings` at the far right. Walkthrough: 58 px high; at 1024 the path ends `...\Temp\o`, Saved clips to "Save"/"Saved 0", status and tabs are far from the title. Shot `layout-12-live-run-1024x640-dark.png`; the older `layout-13-runs-1600x1000-dark.png` shows the pill at full length.

Violations: rule 1 (the trailing group has no primary but five unrelated items), rule 10 and B3 (path as a pill), rule 11 (status duplicated on the strip and header), P5, P6, P10, AU13.

Target (48 px high, `--surface-1`, 1 px `--border-subtle` bottom):

```
| Notes API  [folder] notes-api |  Live  History  Org chart  Settings |      ● Needs you   ✓ Saved |
                                   ━━━━ (2 px gradient indicator under Live, tab height 48)
```

- Left: project name 14/600 (max 220 px, ellipsis, full name in tooltip), then folder name (mono 12, tertiary, hidden below 900 px of main).
- Middle: underline tabs, left-aligned after the identity, 4 labels of 1-2 words (rule 8). The "Project settings" accessible name stays (`App.tsx:107`) because e2e depends on it.
- Right: at most two items (rule 2): the status badge when `view !== 'run'` and something needs the user (a `Button` styled badge that jumps to the decision), and the Save indicator as an icon plus "Saved" text above 1100 px, icon only below. Never clipped: it reserves its width.
- Breadcrumb "Projects / name" from spec 2.2 is dropped; the sidebar already shows where you are.
- Window title: `<project> · R1: <prompt> · OrgAI` while a run is viewed, else `OrgAI` (AU13).

### B.5 Run strip, run header and run metadata

Current anatomy (`views/LiveRunView.tsx:123,576`, `components/RunTabs.tsx`, `components/RunHeader.tsx:78-181`): a 37 px tab strip with 160 px file-tabs, a `+` and a `+n` overflow; under it a 44 px header (wraps to about 72 px once ended, walkthrough) with index, status pill, prompt, "Started just now · $0.00", `unattended` pill, `2 agents` pill, `0/3 steps` pill, the Hide-finished switch, `Interrupt turn`, `End session`, and when finished `Org retrospective` plus a hint ("Starts a session (mock, no tokens)", `RunHeader.tsx:167`). At 1024 the prompt shrinks to "Add rat..." while pills keep their space.

Violations: P2, P3, B3, B9, rules 1, 2, 3, 10, 11, AU11.

Target (one strip, 40 px, then a 32 px canvas toolbar inside `CanvasFrame`):

```
+-------------------------------------------------------------------------------------+
| [R1 ● Add rate limiting ×] [R2 ● Fix auth] [+]  [+2 ▾]      [ Interrupt ] [ End ▾ ]  |  run strip 40
+-------------------------------------------------------------------------------------+
| 3 agents · 1/3 steps · $0.04 · started 2m ago · unattended            [-][+][fit] [?]|  toolbar 32, 12/400 tertiary
+-------------------------------------------------------------------------------------+
|                                  canvas                                              |
```

- Strip trailing group: `Interrupt turn` (secondary, only while running), `End session` (danger-ghost, with a 8 px gap from Interrupt per P2). After the run ends, the trailing group shows `Org retrospective` and the "Starts a session" hint becomes its tooltip. At strip widths under 640 px the buttons become icon buttons; under 520 px they move into a `⋯` menu (rule 3).
- Active tab: status dot (tone from `runStatus`), index, prompt (clipped), close. The unread, draft and waiting glyphs become one indicator: the dot, with the details in the tooltip and `aria-label` that already exist (`RunTabs.tsx:132`). The waiting tab keeps its dot as amber and stops filling the whole tab (AU11, B4). Selected tab: `--surface-2` fill, 1 px `--border-default`, 2 px top inset `--accent` (solid; the gradient is for the project underline only).
- Toolbar left: plain text with 14 px icons: agents, steps (a text button that opens the Plan tab, `RunHeader.tsx:125-136`), cost, started, `unattended` (shield icon, tooltip with the existing explanation). "Continues R1: ..." is a text link at the toolbar's left end. The error message becomes a `Banner` above the canvas instead of a red pill (`RunHeader.tsx:161-165`).
- Toolbar right: Hide finished switch (shown when more than one agent), zoom out, zoom in, fit (custom buttons using `useReactFlow`, so React Flow's `Controls` no longer floats over the nodes, P1) and the legend `?` (a `Popover`).

### B.6 Canvas and its controls, legend

Current: React Flow `Controls` at bottom-left over the stage (`LiveRunView.tsx:617`), a 30 px legend row of five coloured dots under the stage (`LiveRunView.tsx:664-685`, `layout.css:59-77`), minimap off by default.

Violations: P1 (zoom buttons sit on a node), B6 (legend text 11 px, repeats colours users learn from nodes), AU3 (legend "working" is violet), rule 24 (legend is colour only; make it shape plus label).

Target:
- Controls move into the toolbar (B.5). The minimap stays opt-in and, when on, sits bottom-right on the stage (React Flow's own control, rule 23).
- The legend row is removed from the footer and becomes a `Popover` opened from the toolbar `?`. Content: one row per state with the same shape the node uses: working = blue ring with a pulse, needs you = amber ring with a bell, done = green check badge, error = red triangle badge, message = dashed grey line. 12 px text.
- `FrameFooter` is kept for the org chart hint row ("drag, Enter, Delete") and is hidden on Live.
- Node rings: working uses `--state-working` (blue), not `--role` (AU3). One ambient loop is allowed, the working ring `breathe` at 1.5 s; `spin`, `ripple` and `blink` are removed (AU14); needs-you is a solid amber ring plus an icon.

### B.7 Decision tray

Current (`CanvasFrame.tsx:44-64`, `layout.css:45-101`, `components/DecisionCard.tsx`): column beside the canvas on short or wide frames (AU1), card header "Kind chip, avatar, 'Implementer wants to use...'" with the object truncated (P7), stepper "3 of 3" hiding siblings, tray vertically centred in a tall column.

Violations: P1, P7, rule 1 (primary leftmost per spec 12.1 is right; keep), rule 23 (ok), B3 (kind chip is a differently styled pill).

Target:

```
| [Permission]  Implementer · wants to run                       ‹ 1 of 3 › |  meta 12 tertiary
| Run `npm test`                                                              |  title 14/600, one line
| Bash · cwd C:\...\repo                              [ Details ▾ ]           |  body, compact: 1 line; expanded: <= 40% frame
| [ Allow once ]  [ Allow ▾ ]                                       [ Deny ]  |  footer: primary left, deny right
```

- Title is the action (command, file, question), agent is meta (P7). The stepper becomes a list: `‹ 1 of 3 ›` plus three small tabs "Run npm test", "Edit server.js", "Question" so every open decision is visible (P7, rule 11).
- Tray is `--surface-1` with a 1 px top border, 12 px padding, max height `min(40cqh, 320px)` while the body scrolls; at frame heights under 480 px the body collapses behind `Details`.
- Kind labels are `Badge` neutral or accent (section C.5), not warning-filled; the warning tone is reserved for "needs you".

### B.8 Composer

Current (`components/Composer.tsx:28-107`, `views/LiveRunView.tsx:688-740`): a label ("Replying to Orchestrator"), the mode toggle `New run / Continue this run` at the top right on a finished run (about 250 px from Start, P13), a tall textarea, a hint line "Enter to send · Shift+Enter for a new line · paste or drop images", the attach button, and `Start`/`Send` at the far right, bottom-aligned with the textarea. Disabled primary is `opacity: .5` violet (AU10, B7).

Target (96 px):

```
| Replying to Orchestrator   [New run | Continue this run]                      |  label line 28, toggle left (P13)
| [clip] [ Describe the task...                               ]   [ Send  ⏎ ] |  textarea 2 rows (56), Send trailing and vertically centred
```

- Hint text becomes the textarea placeholder when empty and a tooltip on a `?` icon otherwise (B6).
- Disabled `Send`/`Start`: `--surface-3` fill, `--text-disabled` text, no border colour change, `cursor: not-allowed`, and `aria-describedby` reason text (B7).
- Composer stays in the canvas column, not under the side panel (spec 2.5, kept).

### B.9 Side panel (run panel and inspector)

Current: `SidePanel` (`components/layout/SidePanel.tsx`) at `clamp(280px, 32cqi, 400px)` (`run.css:231`), header with a collapse button, then `Orchestrator`, boxed segmented tabs `Transcript Plan Logs Runs` (`transcript.css`, `TranscriptPanel.tsx:224`), a stats line, "Show thinking" checkbox, entries. At 1024 the panel is 280 px of 776 and the canvas gets 216 px (P1).

Target:
- Width `clamp(280px, 28cqi, 400px)` (spec 12.7) and **collapsed to the 40 px rail by default below 1100 px window width**, persisted per user; selecting a node opens it. `SidePanel` gets `autoCollapseBelow` (container query in CSS plus an initial state from `matchMedia`).
- Tabs become the shared underline `Tabs` (section C.5), 32 px compact variant, left aligned.
- The stats line ("0 in / 0 out · 0s · done") moves into the node-selected header as 12 px tertiary text; the header shows name and role handle once.

### B.10 Org chart tab

Current (`views/OrgChartView.tsx:277-290,322-335`, `components/DraftPanel.tsx:53-81`): ghost toolbar buttons `Add role`, `Auto-layout` over the canvas, nodes about 176 x 70, a 360 px AI panel that is 46 percent of the main area at 1024 (walkthrough), `h2` "Design the org chart with AI", `h3` "Revise with the Architect", then a filled button "Revise with the Architect" and a collapsed "Advanced: quick draft". The only filled button on the screen is the drafting one.

Violations: P8, rule 1, B8 (three chips per node).

Target (decision 7): toolbar `[+ Add role]` primary, `[Auto-layout]` secondary, then Undo as a text link; panel title "Design with the Architect" once, a single textarea and an action that is primary only when the chart is empty; panel 320 px and collapsed below 1100 px unless a role is selected; fit the chart with a larger default zoom (`fitView` padding 0.15, `minZoom 0.4`) so nodes scale with the canvas; role nodes show avatar, name and role handle (two lines), model and tools in the inspector.

### B.11 Settings pages

Current: project settings has `h2.settings-page-title` "Project settings" (`views/SettingsView.tsx:40`) under a topbar tab "Settings", then the sticky sub-nav (General, Permissions, Limits, Connection, MCP and plugins, Maintenance) and one long scroll (3 of 6 sections visible at 1424, walkthrough). App settings has `h1` "Settings" in the topbar and `h2` "App settings" (`AppSettingsView.tsx:136,182,187`).

Target:
- Drop the project `h2` (the tab names the page) and keep the sticky sub-nav with scroll-spy (already built, `useSectionNav`). Danger zone stays last in the nav (`MaintenanceSection.tsx:175`).
- App settings: one heading, "App settings", in the topbar `h1`; delete the inner `h2`. Settings entry is the footer gear (B.3).
- Section headers become a 16/600 title plus a 12 px description line; rows are the existing `SettingRow`. One column of 720 px, left aligned next to the 200 px sub-nav (spec 12.7); extra width stays empty.
- Section cards use `--surface-2` with no border except `--border-subtle` between rows; no nested cards (P12).

### B.12 Projects page and the New project form

Current (`views/ProjectsView.tsx:228-318`, `styles/projects.css`): topbar "Projects" with a "Mock mode" badge and a "New project" primary; cards of about 285 x 142: `h3`, path cut at `...Temp\or...`, up to eight role avatars (two "RE" in different colours), a `4 roles` chip, a permanent text button "Delete" (P11). The empty first launch shows an intro paragraph and a 640 px form pinned left; at 1024 the submit button is below the fold, at 1600 60 percent of the page is empty (P14).

Target:
- Card: project name 14/600; folder name (mono, tertiary); one line "Last run 2h ago · Finished" or a status badge when something runs or waits (reuse the Sidebar derivation, extracted to `lib/projectStatus.ts`); avatar stack of at most four tonal avatars plus `+n`; "Delete" moves into a `⋯` overflow menu on the card (hidden until hover or focus-within, always keyboard reachable). Whole card is the button (already, `project-card-main`).
- Grid: `repeat(auto-fill, minmax(280px, 1fr))`, 24 px padding, max width 1200 px centred.
- New project form (first launch): one-line intro ("Describe an idea or point at a repository. The Architect proposes everything; you approve each step."), a two-column layout at 1100 px and wider (form 560 px left, "What happens next" three-step list right) and a sticky footer that holds `Create and start setup` so it is always visible; the mock and Architect options sit under a collapsed "Options" disclosure. Form width 560 px, centred when empty.

### B.13 Empty states

Current: `NewRunPage.tsx:56-95` "Give Orchestrator something to do" with role chips as a preview and the composer (the Researcher's Keep list); empty History, empty chart and empty Projects have text only.

Target: one `EmptyState` primitive: gradient glyph (the mark's org-chart glyph, `mask`ed, 14 percent opacity dark, 10 percent light, 96 px) above a 20/600 title, one 13 px sentence and at most one primary button. Used on Live with no run, History with no runs, Org chart with no roles, Projects with no projects. This is the only place a large gradient surface appears (section C.2).

### B.14 What stays (Keep list, confirmed)

One purple filled primary per region; decision card shell and copy; the empty "New run" copy; New project help text and disabled-reason text; the sticky settings sub-nav; the single status vocabulary; dark/light parity; History table; org chart footer hint; skip link and visible focus ring. All confirmed against source; none are touched except where a restyle above lists them.

---

## C. Brand and style direction: "Looks like the logo"

The logo is a near-black tile (`#0b0d12`), an org-chart glyph (one ring feeding two, `scripts/make-icon.mjs:41-61`) and a diagonal violet-to-blue gradient (`#7c5cff` to `#2bb0ff`, `make-icon.mjs:78`, `t = (x + y - 200) / 824`). The UI should feel like that tile enlarged: near-black surfaces with clear steps, thin crisp lines, restrained colour, and the gradient used rarely, as the thing that says "this is OrgAI".

### C.1 Surfaces and borders (dark and light)

`--surface-0` stays exactly `#0b0d12` (dark) and `#f4f5f9` (light) because `THEME_BACKGROUND` in `src/shared/defaults.ts:229` and the window `backgroundColor` depend on it. The other steps are widened so each step is about 3 L* points above the previous one (now 1.8, 2.8, 4.3).

| Token | Role | Dark now | Dark proposed (L*) | Light now | Light proposed |
| --- | --- | --- | --- | --- | --- |
| `--surface-0` | window, canvas, field background | `#0b0d12` | `#0b0d12` (3.6) unchanged | `#f4f5f9` | `#f4f5f9` unchanged |
| `--surface-1` | chrome: sidebar, topbar, run strip, side panel, tray | `#0f1218` (5.4) | `#12161f` (7.2) | `#fafbfd` | `#fafbfd` unchanged |
| `--surface-2` | raised: cards, nodes, popovers, settings sections | `#141821` (8.2) | `#181c27` (10.3) | `#ffffff` | `#ffffff` unchanged |
| `--surface-3` | hover, selected rows, avatar tint base, disabled fill | `#1b2030` (12.5) | `#20263a` (15.5) | `#eceff6` | `#e9ecf4` |
| `--code-bg` | code, tool output | `#0d1016` | `var(--surface-0)` (fold the near-duplicate) | `#f1f3f8` | `#f1f3f8` |
| `--border-subtle` | row dividers inside a surface | `#1c2130` | `#1d2332` | `#e6e9f1` | `#e6e9f1` |
| `--border-default` | panel and card edges | `#262d40` | `#283045` | `#d9dde8` | `#d5dae6` |
| `--border-strong` | hover, emphasis | `#364058` | `#39435b` | `#c3cadb` | `#bcc4d6` |
| `--border-input` | inputs, checkbox, switch outline | `#5d6882` | unchanged (3.6 on `#0b0d12`, 3.05 on `#181c27`, computed) | `#858ea3` | unchanged (3.0 / 3.3) |

Rules: panels are separated by a surface step, not a border, wherever two adjacent surfaces differ (sidebar to canvas, tray to canvas): keep only the 1 px `--border-default` on the edge that touches `--surface-0`. Cards inside `--surface-1` use `--surface-2` and no border; cards on `--surface-0` use `--surface-2` and `--border-subtle`. Three surfaces plus field and three borders is the entire palette; no new greys. `--text-primary` `#e8ebf3` and `--text-secondary` `#a3adc2` stay. **`--text-tertiary` becomes `#8791a8` in dark** (4.75:1 on the new `--surface-3`; the old `#8089a0` drops to 4.29 there) and stays `#636d82` in light (4.77 on `#f4f5f9`, 5.20 on white). Re-run the contrast table in `tokens.test.ts` after the change; `--text-disabled` is exempt.

### C.2 The gradient: allowed and forbidden

Tokens (new): `--gradient-mark: linear-gradient(135deg, #7c5cff, #2bb0ff)` for the mark only (fixed in both themes); `--gradient-ui` for everything else, themed so non-text strokes pass 3:1 on the page surface:

| Token | Dark | Light | Contrast vs page surface (computed) |
| --- | --- | --- | --- |
| `--brand-ui-from` | `#7c5cff` | `#6a4cf0` | 4.47 on `#0b0d12`; 4.94 on `#f4f5f9` (raw `#7c5cff` is 3.99, still passes) |
| `--brand-ui-to` | `#2bb0ff` | `#1a86d9` | 8.10 on `#0b0d12`; 3.53 on `#f4f5f9` (raw `#2bb0ff` is 2.20 and fails 3:1) |
| `--gradient-ui` | `linear-gradient(90deg, from, to)` | same | |

Allowed (at most two non-mark gradient surfaces per screen, none behind text):
1. The mark tile and the glyph inside it (`--gradient-mark`).
2. The 2 px active indicator under the selected project tab and the selected side-panel tab (`--gradient-ui`).
3. The usage bar fill while below 80 percent (4 px high); at 80 percent it turns solid `--warning`, at the limit solid `--danger`.
4. The large empty-state glyph at 14 percent (dark) or 10 percent (light) opacity.
5. The existing canvas wash (`--canvas-wash-opacity` 0.06) stays; it is ambient and non-text.

Forbidden: any fill that carries text (buttons including hover and active, badges, tabs, toasts), borders, focus rings, node rings, status or role colours, scrollbars, links, selection highlights, `background-clip: text`, charts, and any glow or blur (no `box-shadow` halo in a brand colour; the node `--glow-working` goes, `tokens.css:329-343`). Rule 18 allows "one hero or active moment per screen"; the empty-state glyph is that moment and appears only when a screen has no content.

Text on the gradient is therefore never needed, but the numbers settle the primary button question (computed WCAG ratios):

| Pair | Ratio | Verdict |
| --- | --- | --- |
| white on `#7c5cff` (gradient start) | 4.35 | fails 4.5 |
| white on `#2bb0ff` (gradient end) | 2.40 | fails |
| `#0b0d12` on `#7c5cff` | 4.47 | just fails |
| `#0b0d12` on `#2bb0ff` | 8.10 | passes |
| white on `#6e4df5` (dark `--accent`) | 5.19 | passes |
| white on `#5b3df0` (light `--accent`) | 6.23 | passes |
| white on `#5a3bd9` (dark `--accent-active`) | 6.86 | passes |

No single text colour passes across both ends, so **the primary button is a solid `--accent` fill with white text; hover `--accent-hover`, active `--accent-active`; never a gradient.** The brand shows up around the button (tab underline, usage bar, glyph), not on it.

### C.3 Accent and focus

Keep `--accent` `#6e4df5` (dark) and `#5b3df0` (light). They are the static derivation of the brand violet by the spec 5 algorithm and pass white text; re-deriving from the gradient would trade away that contrast. Accent means **interactive or selected**: primary fill, selected row, links, switch on, active tab label (`--accent-text`), selected node outline. It never means a state. Focus ring: `outline: 2px solid var(--focus-ring); outline-offset: 2px` plus the existing 3 px 35 percent halo; `--focus-ring` is `--accent-text` (`#a592ff` 7.55:1 on `#0b0d12`, 5.83 on the new `--surface-3`; `#4f33d6` 6.94 on light `--surface-0`), at least 2 px with 3:1 against the unfocused state (rule 16). The ring is never a gradient.

### C.4 Role avatars and the colour budget

One colour, one meaning.

| Hue | Means | Never means |
| --- | --- | --- |
| Violet (accent) | interactive, selected, focus, primary | working, a role |
| Blue (`--info`) | **working** (node ring, status dot) | message, stopped, a role |
| Amber (`--warning`) | **needs you**, permission, caution | mock, a role |
| Green (`--success`) | **done**, success | a role |
| Red (`--danger`) | **error**, destructive | a role |
| Slate dashed (`--edge`) | **message** line between agents | a status |
| Grey (`--surface-3`, `--text-secondary`) | neutral labels, **mock marker**, stopped | any hue |

Role identity is carried by the initials and the avatar **tint**, and no avatar is ever a saturated status colour:
- `.avatar { background: color-mix(in oklab, var(--role) 24%, var(--surface-2)); color: var(--text-primary); box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--role) 50%, transparent); }`. A user-chosen amber role becomes a muted warm tint that cannot be mistaken for a "needs you" ring, because rings are drawn by state, not role. `--text-on-role` is retired (`styles/editor.css:94-107`).
- Working node rings use `--state-working`, not `--role` (AU3). The waiting ring is `--warning`, solid.
- **Contract request for the Runtime Lead** (renderer must not edit `src/shared`): replace `ROLE_COLORS` in `src/shared/defaults.ts:46` with a brand-tonal palette that excludes the status hues: six violet-to-periwinkle steps (hue 245 to 285 degrees, same chroma) plus two neutrals (slate, stone). Existing projects keep their stored colours and rely on the tint. Not blocking: Phase 1 works without it.
- Two roles with the same initials ("RE" for Reviewer and Researcher) get a second letter from the role slug (`RV`, `RS`) in `initials()` (`lib/layout.ts:55`), the minimum fix for the side-by-side "RE" in P11.

### C.5 Chips and badges

One `Badge` component. Shape: 20 px high, `--radius-full`, 8 px horizontal padding, 12/400, no border, soft fill. Three tones:

| Tone | Fill and text | Used for |
| --- | --- | --- |
| `neutral` | `--surface-3`, `--text-secondary` | kind labels, counts, MOCK, tools ("6 tools"), role kinds |
| `accent` | `--accent-soft`, `--accent-text` | selected or "yours": Proposal, Setup |
| `status` (with `state`) | `*-soft` fill, `*-text` colour, leading dot or icon | the seven runStatus words only (`lib/runStatus.ts`), plus Permission/Question/Merge kind chips mapped through the spec 12.1 table |

What stops being a chip (becomes plain text with a 14 px icon at 12 px `--text-secondary`): the path, "N agents", "x/y steps", "unattended", cost, "Started ...", "4 roles", the account pill, "Setup session". The 1 px border is dropped everywhere (Apple: borders unnecessary when the container gives the grouping, rule 10). Delete `.pill` (`shell.css:247-288`, `run.css:442-481`, `global.css:161`) and `.chip` (`controls.css:146-169`) once no TSX uses them (Phase 4).

Tab component (new `Tabs`): `role="tablist"`, 40 px (32 px compact), underline indicator 2 px `--gradient-ui`, label 13/600 `--text-secondary`, active `--text-primary`; no boxes.

### C.6 Type

Five sizes and two weights, all existing tokens. 12 px is the floor (rule 20).

| Token | Size / line | Weight | Use |
| --- | --- | --- | --- |
| `--text-small` (and `--text-caption`, set to 12/16) | 12 / 18 | 400, 600 for labels | meta, badges, hints, legend, reset lines, tray meta |
| `--text-body` | 13 / 20 | 400, 600 for row titles | default, inputs, buttons |
| `--text-title-sm` | 14 / 20 | 600 | card titles, topbar project name, panel headers |
| `--text-title` | 16 / 24 | 600 | section titles, wordmark, dialog titles |
| `--text-title-lg` | 20 / 28 | 600 | page titles, empty-state titles |
| `--text-mono` | 12 / 18 | 400 | paths, ids, command text |

`--text-display` (24) stays only for the first-run hero heading and is dropped otherwise. Setting `--text-caption: 12px` changes 48 call sites at once (AU4). Weights: 400 and 600 only; `--weight-medium` (one use) and `--weight-display` 650 become 600 and are deleted. Letter spacing is 0 except the wordmark.

### C.7 Brand lockup and assets

- **Expanded:** `BrandLockup` row is 48 px high (equal to `--topbar-h`, new value 48), 16 px inline padding (0.5x the mark). Mark 32 px (tile, radius 22 percent), 12 px gap (0.4x spec), wordmark "OrgAI" 16/600, letter-spacing -0.01em, `--text-primary`, never accent-coloured. The collapse button sits at the trailing edge.
- **Collapsed rail (56 px):** the mark alone at 28 px, centred; clicking it expands the sidebar.
- **Mock:** the 20 px neutral "MOCK" tag follows the wordmark in the same row (decision 8).
- **Minimums:** mark 16 px, lockup 96 px wide (spec 9, kept).
- **Assets (yes, add them in Phase 1A):** `assets/brand/mark.svg`, `mark-glyph.svg` and a `BrandLockup` component. The geometry is already in `scripts/make-icon.mjs`, so no new design work is needed. viewBox `0 0 512 512`. Tile: `<rect x="16" y="16" width="480" height="480" rx="104" fill="#0b0d12"/>`. Gradient: `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="100" y1="100" x2="512" y2="512">` from `#7c5cff` to `#2bb0ff` (this is `t = (x + y - 200) / 824`: the vector from `x + y = 200` to `x + y = 1024`). Glyph, three rings as stroked circles (outer radius 60 / 52 / 52, inner 24 / 20 / 20, so stroke circles at r 42 sw 36 for the top ring at (256,168), r 36 sw 32 for the rings at (148,352) and (364,352)), and four 24-unit-wide round-capped lines: (256,210) to (256,262), (148,262) to (364,262), (148,262) to (148,316), (364,262) to (364,316). `mark-glyph.svg` is the same glyph with `currentColor` and no tile. The 16 px tile margin in the PNG disappears (the SVG tile can fill 0..512 at the same ratio; keep the 16 px inset so it matches `build/icon.png`). Use the img directly for the tile; use CSS mask for the glyph (spec 9). `wordmark.svg` is skipped: converting Inter to outlines needs a font tool, so the wordmark is live text in the system font stack until a font is bundled (D5); revisit if Inter ships.
- Remove the gradient `background` behind the `<img>` in `.brand-mark` (AU5): with an SVG tile there is no transparent margin to leak through.
- Light theme: the tile carries its own background and reads on `#fafbfd` without an outline; add `box-shadow: 0 0 0 1px var(--border-subtle)` on the tile in light only.

### C.8 Elevation, radius, motion

- **Radius:** five values stay: 4 (checkbox, kbd), 6 (dense rows, tabs, inputs inside rows), 8 (buttons, inputs, popover items), 12 (cards, nodes, popovers, dialogs), full (dots, avatars, badges). Remove `--radius-xl` (`tokens.css:245`): a grep finds no use outside `tokens.css`.
- **Elevation:** dark relies on surface steps; shadows only on popovers and dialogs (`--elev-2`, `--elev-3`) and a 1 px top inset highlight (`--elev-1`) on raised cards. Light uses `--elev-1` on cards. No glow, anywhere, including the mark.
- **Motion:** durations stay 100/160/260. One ambient loop (working ring `breathe`). Every loop has a `prefers-reduced-motion` and `data-reduce-motion` fallback (rule 25). No animation on layout (tab indicator slides allowed at `--dur-base`, reduced to 0 under reduced motion).

### C.9 Light theme adaptation

- Surfaces as C.1 (light barely moves; the cool-grey app background with white cards is already clean per B10).
- Gradient strokes use the darker `--brand-ui-from/to` (C.2) so the underline and usage bar pass 3:1 on `#f4f5f9`.
- Status text uses the existing darker `*-text` values; the orange "needs you" fill is removed so the weakest-contrast area in light (B4, B10) goes away.
- Avatars: the 24 percent tint on white is lighter, so keep `--text-primary` initials and raise the inset ring to 60 percent in light.
- Focus ring `#4f33d6`; primary button `#5b3df0` with white text (6.23).
- The mark tile is dark on light surfaces, which is intended; the empty-state glyph opacity is 10 percent.

---

## D. Phased implementation plan and briefs

Rules for every brief (inherited from `plan.md`, Definition of Done): tokens only, both themes, no new hex outside `tokens.css`, `npm run typecheck`, `npm test`, `npm run build && npm run e2e:free` green, dark and light screenshots at 1024x640 and 1600x1000 inspected, selectors updated in the same change. Every brief tells the engineer to read `.claude/skills/frontend-design/SKILL.md` if present (it is not vendored here: say "if present") and `docs/design/spec.md` plus this file. Use `window.orgai` only through `src/preload/index.d.ts`. Nothing in `src/main` or `src/shared` changes in any brief (the one contract request, `ROLE_COLORS`, goes to the Runtime Lead). After Phases 1, 2 and 3 the Reviewer runs (a security pass on the briefs that render untrusted content: 2B cards, 2C transcript and Markdown, 2A the tray, plus any brief that opens links) and the UX Researcher walks the changed flows on mock data; high-severity findings become follow-up briefs.

```
Phase 1 (serial):    1A tokens, brand, primitives  -->  1B shell (sidebar, topbar, footer, status carriers)
Phase 2 (parallel after 1B):  2A run workspace  |  2B decision cards  |  2C transcript and history
Phase 3 (parallel after Phase 2 merges):  3A org chart  |  3B projects and new project  |  3C settings
Phase 4 (serial after Phase 3):  4A nodes  -->  4B polish and cleanup
```

### Phase 1: Brand and shell (serialized) - LANDED (1A 487e864, 1B 3f9f517)

**Brief 1A: Tokens, brand assets and primitives** (L). Goal: the system in section C exists as tokens and components, with no view restyled yet.
- Closes: B1 (part), B2 (tokens), B3 (Badge), B5, B6 (type floor), B7, AU4, AU10, AU12 (spacing helpers); rules 10, 12-16, 18-20.
- Files (exclusive): `src/renderer/src/styles/tokens.css`, `styles/tokens.test.ts`, `styles/global.css`, `styles/controls.css`, `styles/ui.css`, `styles/editor.css` (only the `.avatar` rule, `editor.css:94-107`, and `.avatar.sm/.xs`), `assets/brand/mark.svg`, `assets/brand/mark-glyph.svg` (new), `components/ui/Badge.tsx`, `components/ui/Button.tsx`, `components/ui/Popover.tsx` (new, native `popover` attribute, anchored, Esc closes, focus returns), `components/ui/Tabs.tsx` (new, underline, standard tablist keyboard model), `components/ui/EmptyState.tsx` (new), `components/layout/BrandLockup.tsx` (new), `lib/layout.ts` and `lib/layout.test.ts` (`initials()`, `layout.ts:55`: second letter from the role slug on collisions).
- Work: C.1 surface and border values both themes, `--gradient-mark`, `--brand-ui-*`, `--gradient-ui`, `--text-caption: 12px`, drop `--weight-medium`/`--weight-display`, `--topbar-h: 48px`, retire `--text-on-role`, `.avatar` tint, `.btn:disabled` neutral, the three-tone `Badge` (keep `tone` props backward compatible: map `info/success/warning/danger` to `status`), new primitives with tests where logic exists. `tokens.test.ts` gains the new contrast pairs and asserts every theme block defines the new tokens. Do not delete `.pill` or `.chip` yet (Phase 4B).
- e2e selectors: none expected (`mock-mode-badge` testid is kept on whatever renders the MOCK tag).
- Sequential: nothing runs beside it. 1B starts after 1A merges.

**Brief 1B: Shell: sidebar, topbar, status carriers, footer** (L). Goal: sections B.3, B.4 and decisions 3, 5, 6, 8, 9.
- Closes: P3 (sidebar and topbar parts), P4, P5, P6 (project tabs), P9, P10, P15, B4 (sidebar), AU2, AU5, AU6, AU8, AU9, AU13; rules 4-8, 11, 17.
- Files (exclusive): `src/renderer/src/App.tsx`, `components/Sidebar.tsx`, `components/UsageMeter.tsx`, `components/layout/SaveIndicator.tsx`, `styles/shell.css`, `styles/usage.css`, `lib/paths.ts` (+ `paths.test.ts`), `lib/projectStatus.ts` (+ test; extracted from `Sidebar.tsx:133-145`, used again by 3B), `lib/useSidebarCollapsed.ts` (new), `e2e/lib.mjs`, `e2e/layout.mjs`, `e2e/connections.mjs`, `e2e/maintenance.mjs`, `e2e/runs.mjs`, `e2e/worktree.mjs`, `e2e/setup.mjs` (selector edits only; token-spending scripts are syntax-checked with `node --check`, never run).
- Work: `BrandLockup` in the sidebar with the MOCK tag; rail collapse below 1180 px and Ctrl/Cmd+B; Needs-you row plus `Popover` list; project rows with dot and count; footer account row with `Popover`; gear button "App settings"; renamed "Projects" label; topbar with folder name, underline `Tabs` after the identity, right group at most two items; status badge only on non-Live tabs and only when waiting; window title; second skip link.
- e2e selector changes: `.sidebar .nav-item` with text `Settings` becomes `getByRole('button', { name: 'App settings' })` (add `openAppSettings(page)` in `e2e/lib.mjs` and use it in `layout.mjs` and `connections.mjs`); `.sidebar-footer .pill` (`layout.mjs:23`) becomes `[data-testid=auth-pill]` (testid kept on the account row); `.topbar .tabs` becomes `[role=tablist][aria-label="Project sections"]` and its buttons become `role=tab`; `.topbar .pill` (path, `layout.mjs:37`) becomes `[data-testid=project-folder]`; run status reads (`lib.mjs:379`, `worktree.mjs:43`) switch from `.topbar .pill .dot` to the selected run tab (`.run-tab[aria-selected=true]` plus its sr-only word) so the topbar badge can disappear on Live; sidebar footer height and brand block assertions added in `layout.mjs` (footer under 80 px, brand 48 px).
- Estimate L. Depends on 1A.

### Phase 2: Run workspace (three parallel briefs, disjoint files) - LANDED (2A 9ee86a9, 2B 4d545f6, 2C e4734fb; follow-ups 544a7de, 4b8b7a1)

**Brief 2A: Run strip, toolbar, tray placement, composer, side panel** (L; one engineer, two sequential passes allowed: strip and toolbar first, then tray, composer and panel). Goal: B.5 to B.9, decisions 1 and 2.
- Closes: P1, P2, P3 (run level), P7 (tray layout), P13, B3 (run header chips), B6 (legend, hints), B9, AU1, AU3 (node ring colour is in 4A; the legend here), AU11; rules 1-3, 9, 23, 24.
- Files (exclusive): `views/LiveRunView.tsx`, `components/RunTabs.tsx`, `components/RunHeader.tsx` (reduced to run actions and the metadata line, or split into `RunActions.tsx` and `RunMeta.tsx`, new), `components/DecisionTray.tsx` (new; extracted from `LiveRunView.tsx:621-663`, hosts the stepper list and renders cards through the unchanged `DecisionCard` API), `components/Composer.tsx`, `components/NewRunPage.tsx`, `components/layout/CanvasFrame.tsx`, `components/layout/SidePanel.tsx`, `styles/layout.css`, `styles/run-tabs.css`, `styles/run.css` (strip, toolbar, composer and canvas rules only; node rules wait for 4A), `styles/flow.css`, `e2e/runs.mjs` and the Live block of `e2e/layout.mjs` (lines 160-190: header-under-tabs assertion becomes strip-and-toolbar assertions).
- Work: merge strip and header; canvas toolbar with metadata, switch, zoom, fit and legend popover; remove the tray `or (max-height: 420px)` clause and add the 1100 x 560 beside-rule and the compact card mode hook; `SidePanel` `autoCollapseBelow` and persisted state; composer 96 px; `EmptyState` in `NewRunPage`; error `Banner` in place of the red pill.
- e2e selector changes: `.run-header` (seven uses in `runs.mjs` and `layout.mjs`) becomes `[data-testid=run-strip]` for actions and `[data-testid=run-meta]` for the metadata line; `layout.mjs:179` asserts the strip is under the topbar and the toolbar is under the strip; `.run-tabs [role=tab]` and `.run-tab-new` are unchanged; legend assertions move to the `?` popover; tray placement assertions at 1024x640 (below the stage, stage at least 55 percent of frame).
- Estimate L. Depends on 1B. Concurrent with 2B and 2C: no shared file.

**Brief 2B: Decision cards** (M). Goal: B.7 anatomy and copy hierarchy.
- Closes: P7 (card), B3 (kind chips), B4 (tray), rule 10.
- Files (exclusive): `components/DecisionCard.tsx`, `components/PermissionCard.tsx`, `components/QuestionCard.tsx`, `components/RuleRequestCard.tsx`, `components/McpInstallCard.tsx`, `components/ProposalCard.tsx`, `components/MergeReviewCard.tsx`, `components/DiffView.tsx`, `styles/cards.css`, `styles/mcp-install.css`.
- Work: title is the action, agent is meta; compact mode (CSS container query on the tray plus a `Details` toggle, default collapsed under 480 px frame height); kind chips through `Badge` with the spec 12.1 tone table; button order and names unchanged (`Approve`, `Request changes`, `Send feedback`, `Merge into main checkout`, `Discard`, `Allow once`, `Deny`).
- Security pass required: these cards render agent-supplied commands, paths, diffs and MCP install specs. Reviewer checks no `dangerouslySetInnerHTML`, link handling in any rendered Markdown, and that registry text stays inert.
- e2e selector changes: `article.decision-card[data-kind=...]` is unchanged; card button names unchanged; `layout.mjs` assertion on "tray under the stage" is 2A's.
- Estimate M. Concurrent with 2A, 2C.

**Brief 2C: Transcript, side-panel content and History** (M). Goal: B.9 content and the History tab.
- Closes: B6 (transcript text), P6 (side tabs idiom), rule 10, rule 11 (History is the one place status is content).
- Files (exclusive): `components/TranscriptPanel.tsx`, `components/RunHistory.tsx`, `components/FinishedList.tsx`, `components/ImageAttachments.tsx`, `components/Markdown.tsx`, `styles/transcript.css`.
- Work: underline compact `Tabs` for Transcript / Plan / Logs / Runs; header with name and role once, stats as 12 px text; History status as `Badge` status with the dot; 12 px floor; harness rows stay quiet.
- Security pass required: `Markdown.tsx` and transcript entries render untrusted agent output and repo content; the Reviewer checks link and image handling, `target`/`rel`, and URL schemes.
- e2e selector changes: `.side .tabs` (`setup.mjs:56,68`, `worktree.mjs:68`) becomes `[role=tablist]` within `.side`; `.entry.user`, `.entry-thumb`, `.run-row` and `.run-open` are unchanged. `setup.mjs` and `worktree.mjs` are syntax-checked only.
- Estimate M. Concurrent with 2A, 2B.

### Phase 3: Views (three parallel briefs, disjoint files, start after Phase 2 merges and the Reviewer and UX passes) - OPEN

**Brief 3A: Org chart tab** (M). Goal: B.10, decision 7.
- Closes: P8, B8 (org nodes: avatar, name, handle), rule 1.
- Files (exclusive): `views/OrgChartView.tsx`, `components/DraftPanel.tsx`, `components/RoleInspector.tsx`, `components/RoleNode.tsx`, `components/RoleModelPicker.tsx`, `styles/editor.css`.
- Work: toolbar primary "Add role"; one heading; conditional primary on the panel action; panel 320 and collapsed below 1100 unless a role is selected; fit zoom; role node lines; `EmptyState` for an empty chart.
- e2e selector changes: `.draft-box` (`layout.mjs`) kept; `.canvas-toolbar` (one use) updated if renamed. Edits only the org-chart hunk of `e2e/layout.mjs` (lines about 40-66); 2A edited the Live hunk earlier, so the merge is textual only.
- Added after the Phase 1-2 re-walk: Org chart canvas toolbar and zoom parity with Live (the React Flow zoom buttons still float; move them into the toolbar, Q10) and graph edges not focusable (Q13).
- Estimate M.

**Brief 3B: Projects page and New project form** (M). Goal: B.12 and B.13 (projects empty state), decision 5.
- Closes: P11, P14, P9 (topbar badge removal), B1 (empty glyph).
- Files (exclusive): `views/ProjectsView.tsx`, `styles/projects.css`, `lib/projectsForm.ts` (+ test).
- Work: cards with folder, last-run line (from `lib/projectStatus.ts`), at most four tonal avatars, `⋯` overflow menu replacing the permanent Delete; grid and centred max width; form 560 px two-column at 1100+, sticky submit, collapsed Options, one-line intro; `EmptyState` on a project-free Projects page.
- e2e selector changes: `[data-testid=new-project]` and `use-mock` are kept; `lib.mjs` project-delete helpers update to the overflow menu (`lib.mjs` is 1B's, so 3B adds a small `deleteProject(page, name)` helper in a new `e2e/lib-projects.mjs` if one is needed and imports it, keeping `lib.mjs` untouched).
- Added after the re-walk: remove the orange "Mock mode" topbar badge on Projects (Q15); the neutral MOCK tag by the wordmark is the one marker.
- Estimate M.

**Brief 3C: Settings pages** (M). Goal: B.11.
- Closes: P12, P10 (App settings heading), rule 12.
- Files (exclusive): `views/SettingsView.tsx`, `views/AppSettingsView.tsx`, `components/settings/*.tsx` and `components/settings/useSectionNav.ts`, `components/connections/*.tsx`, `styles/connections.css`, and the settings rules in `styles/ui.css` (`ui.css:636-735`; 1A is merged and no other Phase 3 brief edits `ui.css`).
- Work: drop the project `h2`; one App settings heading; section header pattern; surfaces and no nested cards; connection cards use `Badge` status; sticky sub-nav kept.
- e2e selector changes: `#settings-section-*` ids are kept; `.editor .tabs, .tabs` with `Project settings` (`maintenance.mjs:73`) becomes the `Tabs` role selector; `connections.mjs` selectors for `[data-testid=connection-card]` are unchanged. Edits `e2e/connections.mjs` and `e2e/maintenance.mjs` only.
- Estimate M. MCP components (`components/mcp/*`, `styles/mcp*.css`) are intentionally out of scope; they adopt `Badge` and the surface steps in 4B only where a class is deleted.

### Phase 4: Polish and cleanup (serial, small) - OPEN

**Brief 4A: Nodes and canvas states** (M). Goal: B8 and AU3, AU14.
- Files (exclusive): `components/AgentNode.tsx`, `components/DoneGroupNode.tsx`, `styles/run.css` (agent-node rules, `run.css:1-200`), `styles/tokens.css` (delete `--glow-working` composites, `tokens.css:325-345`), `styles/flow.css` (edges: message dashed neutral).
- Work: node shows avatar, name and status line only; role handle, model, tokens and cost move to a tooltip and the side panel header; working ring `--state-working`; waiting ring solid; delete `spin`, `ripple`, `blink` loops; `breathe` only for working; reduced-motion fallbacks.
- e2e: `.agent-node`, `.react-flow__node` unchanged.
- Estimate M. Depends on Phase 3 (editor.css and run.css are free again).

**Brief 4B: Cleanup, small text and keyboard** (S). Goal: remove what is dead and verify.
- Files (exclusive): `styles/shell.css` (delete `.pill`), `styles/controls.css` (delete `.chip`), `styles/global.css`, `styles/tokens.css` (legacy alias block only if a grep finds no use; otherwise leave), `styles/run.css` (`.pill.plan-pill`, `run.css:442-481`), `styles/tokens.test.ts`, `App.tsx` (keyboard order test hooks only), `e2e/layout.mjs` (a Tab-order assertion: skip link, skip to sidebar, collapse toggle, Projects).
- Work: sweep for text under 12 px and raw-px `padding`/`gap` in files edited by Phases 1 to 4 (convert to `--space-*`); delete dead selectors; confirm the guard test finds no hex or shadow literal outside `tokens.css`.
- Estimate S. Depends on 4A (shares `run.css`, `tokens.css`).

Open contract: the `ROLE_COLORS` brand-tonal palette request to the Runtime Lead (`src/shared/defaults.ts`) is still open and non-blocking.

### D.1 File exclusivity matrix (check before parallel starts)

| File group | 1A | 1B | 2A | 2B | 2C | 3A | 3B | 3C | 4A | 4B |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `tokens.css`, `tokens.test.ts` | x |  |  |  |  |  |  |  | x | x |
| `ui.css`, `controls.css`, `global.css` | x |  |  |  |  |  |  | x (settings rules) |  | x |
| `shell.css`, `usage.css` |  | x |  |  |  |  |  |  |  | x |
| `layout.css`, `run-tabs.css`, `flow.css` |  |  | x |  |  |  |  |  | x (flow) |  |
| `run.css` |  |  | x |  |  |  |  |  | x | x |
| `cards.css`, `mcp-install.css` |  |  |  | x |  |  |  |  |  |  |
| `transcript.css` |  |  |  |  | x |  |  |  |  |  |
| `editor.css` | x (`.avatar` only) |  |  |  |  | x |  |  |  |  |
| `projects.css`, `ProjectsView.tsx` |  |  |  |  |  |  | x |  |  |  |
| `connections.css`, `SettingsView.tsx`, `AppSettingsView.tsx` |  |  |  |  |  |  |  | x |  |  |
| `LiveRunView.tsx`, `RunTabs.tsx`, `RunHeader.tsx`, `Composer.tsx`, `NewRunPage.tsx`, `CanvasFrame.tsx`, `SidePanel.tsx` |  |  | x |  |  |  |  |  |  |  |
| `App.tsx`, `Sidebar.tsx`, `UsageMeter.tsx`, `SaveIndicator.tsx` |  | x |  |  |  |  |  |  |  | x (App.tsx only) |
| `e2e/lib.mjs` and selector edits in all e2e scripts for shell |  | x |  |  |  |  |  |  |  |  |
| `e2e/runs.mjs`, `e2e/layout.mjs` (Live hunk) |  |  | x |  |  |  |  |  |  |  |
| `e2e/layout.mjs` (org hunk), `e2e/connections.mjs`, `e2e/maintenance.mjs` |  |  |  |  |  | x (layout org hunk) |  | x |  |  |

No two briefs that can run at the same time share a file. The one deliberate shared-file case is `e2e/layout.mjs` between 2A (Live hunk) and 3A (org hunk) and 4B (Tab order): they run in different phases, so there is no concurrency.

### D.2 Open items and risks (visual risks to check at review)

- The widened dark surfaces change the apparent contrast of every status `*-soft` fill; check status badges on `--surface-3` in both themes (computed pairs in `tokens.test.ts`).
- The sidebar rail at 56 px hides run children and the Needs-you list behind popovers: verify focus return and the screen-reader name of the project initials chip ("Notes API, 2 need you").
- Moving React Flow zoom into the toolbar means keyboard zoom must keep working (React Flow's keyboard handlers stay on the canvas; add `aria-label`s on the toolbar buttons).
- The native title bar stays (spec D7). A custom title bar would need Windows 11 caption-button clearance testing (Researcher: unverified); out of scope.
- The `ROLE_COLORS` contract request is non-blocking; legacy stored colours must still look acceptable under the 24 percent tint, so check a saturated amber and a saturated green role at 1024 in both themes.
- Popover uses the native `popover` attribute; verify behaviour in the pinned Electron 45 and that Esc and click-outside close it, since top-layer popovers sit above `--z-popover` and must still never cover the canvas (the legend popover is anchored to the toolbar and opens downward over the stage, which is allowed: popovers are transient and dismissible, nothing persistent floats over the canvas).

---

## E. Appendix

### E.1 Rules for OrgAI (from the Researcher's cited report) with sources

Verification status is the Researcher's. "Unverified" means no primary source was fetched or the page gave no number; "judgment" means a design call, not a sourced rule.

| # | Rule | Source | Status |
| --- | --- | --- | --- |
| 1 | One primary action per region on the trailing edge of its bar. | Apple HIG Toolbars | verified (quoted) |
| 2 | At most three groups of controls in any toolbar. | Apple HIG Toolbars | verified (quoted "aim for a maximum of three") |
| 3 | Rare actions go into a More menu; common ones stay visible. | Apple HIG Toolbars | verified |
| 4 | Sidebar holds navigation and the account entry; no critical action at its bottom edge (the Settings gear is allowed). | Apple HIG Sidebars | the Apple quote is verified; applying it to the gear and usage readout is judgment |
| 5 | At most two levels of hierarchy in the sidebar. | Apple HIG Sidebars | verified |
| 6 | Sidebar collapsible with a toggle; auto-collapse on resize allowed. | Apple HIG Sidebars | verified |
| 7 | Name windows and headers by project and run, never by the app name. | Apple HIG Toolbars | verified |
| 8 | Tab labels of 1-2 words and no more tabs than fit. | NN/g "Tabs, used right" | verified |
| 9 | A tab row never becomes a carousel; overflow goes into a +n menu. | NN/g "Tabs, used right" | verified |
| 10 | One badge style; pills reserved for status; borderless icon buttons. | Apple HIG Toolbars (borders); ui-review section 3 | verified for borders; the "pills for status only" part is the repo's own rule |
| 11 | Show each status once per view, using the single vocabulary. | spec 2.2 | repo rule, not external |
| 12 | About three surface steps and two or three border steps; no extra boxes. | Vercel Geist colours (10-step scale) | verified as a pattern; the exact count is judgment |
| 13 | Every text token passes 4.5:1 on its own surface. | WCAG 1.4.3 | verified |
| 14 | Choose accent button text to pass 4.5:1; white on `#7c5cff` is 4.35:1. | WCAG 1.4.3 plus a hand computation (re-computed in section C.2: 4.35, confirmed) | computed |
| 15 | Input borders, focus rings and checked states pass 3:1. | WCAG 1.4.11 | verified |
| 16 | Focus rings are at least a 2 px perimeter with 3:1 against the unfocused state. | WCAG 2.4.13 (AAA, used as a target) | verified |
| 17 | Targets at least 24 x 24 CSS px or properly spaced. | WCAG 2.5.8 | verified |
| 18 | The gradient only on the mark and at most one hero or active moment per screen; never on body text or every button. | spec section 9; Raycast (third-party summary) | Raycast part unverified; spec part is the repo's own. This review widens it to a short allow list (C.2). |
| 19 | Text over a gradient passes 4.5:1 against every stop it sits on. | WCAG 1.4.3 (the page has no gradient rule; check every stop) | verified; settled in C.2 by banning text on the gradient |
| 20 | Dark theme body text at least 12 px. | NN/g dark mode | judgment |
| 21 | Keep dark and light both tested; dark is the default, not a reason to skip light. | NN/g dark mode | verified |
| 22 | Keep the native title bar until a custom bar is needed; if custom, 32 px (48 px with search or tabs) with caption controls on the right. | Microsoft title bar guidance; Electron `titleBarOverlay` | verified on the pages fetched; Windows 11 caption clearance and Electron 45 behaviour unverified |
| 23 | Only React Flow's own controls, the legend and the fold toggle float on the canvas; decision cards go in the docked tray. | spec 12.1; ui-review H6; React Flow Controls and Panel docs | repo rule plus verified API facts. This review moves the controls and legend into the toolbar so nothing but the opt-in minimap floats. |
| 24 | Legends and status use a shape or icon plus a text label, never colour alone. | spec principle 4; WCAG 1.4.1 | repo rule |
| 25 | Animation without a reduced-motion fallback is not allowed. | ui-review L4 | the media query's source was not fetched: unverified |

Sources: Apple HIG Sidebars (`https://developer.apple.com/design/human-interface-guidelines/sidebars.md`) and Toolbars (`.../toolbars.md`); Microsoft Learn title bar design (`https://learn.microsoft.com/en-us/windows/apps/design/basics/titlebar-design`) and title bar development (`.../windows/apps/develop/title-bar`); Electron `BaseWindowOptions` and `BrowserWindow` docs; NN/g "Tabs, used right" and "Dark mode"; Vercel Geist colours; Linear "How we redesigned the Linear UI"; Raycast design summary (third-party, `webdesignhot.com`); W3C WCAG 2.2 Understanding pages for 1.4.3, 1.4.11, 2.4.13, 2.5.8; React Flow `Controls` and `Panel` API pages. Not found by the Researcher: primary sources for how Linear, VS Code, Figma, Vercel or GitHub Desktop place the brand mark, project switcher, settings entry or account; Material 3 pixel numbers (pages returned titles only). Rules citing those remain judgment.

### E.2 Cross-reference of Researcher findings

| Finding | Sev | Addressed in | Phase and brief |
| --- | --- | --- | --- |
| P1 canvas 216 px with tray, controls over a node | High | B.2, B.6, B.7, B.9, decision 2, AU1 | 2A (layout, controls into toolbar, side panel auto-collapse), 1B (sidebar rail) |
| P2 139 px of chrome, run header overloaded | High | B.5, decision 1 | 2A |
| P3 "Needs you" in 8+ places | High | B.3, B.4, B.5, decision 6, AU7 | 1B (sidebar, topbar), 2A (run strip), 2B (tray) |
| P4 sidebar footer 237 px | Med | B.3, decision 3 | 1B |
| P5 long path truncates the wrong end, Saved clipped | Med | B.4, decision 5 | 1B |
| P6 two tab idioms | Med | B.4, B.5, B.9, decision 4 | 1A (Tabs), 1B (project tabs), 2A (run tabs), 2C (side tabs) |
| P7 card header truncates the object, hidden siblings | Med | B.7 | 2B (card), 2A (tray list) |
| P8 org chart panel outweighs the chart | Med | B.10, decision 7 | 3A |
| P9 Mock mode shown repeatedly in warning orange | Med | B.3, decision 8, AU6 | 1B (tag), 3B (Projects badge) |
| P10 Projects / Workspaces / Settings naming | Low | B.3, B.11 | 1B, 3C |
| P11 project cards: path cut, delete in the click zone | Low | B.12 | 3B (initials in 1A) |
| P12 project settings h1 repeats the tab | Low | B.11 | 3C |
| P13 composer toggle far from Start | Low | B.8 | 2A |
| P14 new project: submit below the fold, form pinned left | Med | B.12 | 3B |
| P15 keyboard order | Low | decision 9, AU8 | 1B (skip link), 4B (assertion) |
| B1 brand almost absent | Med | C (all), B.13 | 1A (tokens, assets, lockup), 1B (lockup in sidebar), 3A/3B/2A (EmptyState uses) |
| B2 colour collisions | Med | C.4, AU3 | 1A (avatar tint), 4A (node ring colour), Runtime Lead (palette request) |
| B3 pill soup | Med | C.5 | 1A (Badge), 2A, 2B, 2C, 3C adopt; 4B deletes `.pill`, `.chip` |
| B4 filled orange rows | Med | B.3, B.5 | 1B (sidebar), 2A (tab) |
| B5 flat surfaces | Low | C.1 | 1A |
| B6 small text | Low | C.6, AU4 | 1A (token), 2A (legend), 2C (transcript), 4B (sweep) |
| B7 disabled primary | Low | B.8 | 1A (Button, controls.css) |
| B8 dense nodes | Low | B.10, B.6 | 3A (role nodes), 4A (agent nodes) |
| B9 amber "i" on the run tab | Low | B.5, AU11 | 2A |
| B10 light theme only inherits B4 | Low | C.9 | 1A, 1B |
