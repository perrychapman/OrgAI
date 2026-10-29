# OrgAI renderer: UI review (phase 1)

Scope: every view and component in `src/renderer/src`, `styles/global.css`, and the screenshots `npm run e2e:free` writes to `e2e/shots/` (`layout-01..04`, `maint-01..03`, 1424x881). Everything here was read from source and the screenshots; nothing was changed. File references are `path:line` against the tree at commit `6eab480`.

Companion documents: `spec.md` (the proposed design) and `plan.md` (implementation briefs).

Severity: **high** = broken, inaccessible or structurally confusing; **med** = clear usability or consistency cost; **low** = polish.

## 0. State of the foundation

Facts that shape every finding below.

| Fact | Evidence |
| --- | --- |
| The token layer the architecture describes does not exist yet. There is no `styles/tokens.css`, no `lib/theme.ts`, no `AppearanceSettings` type, and no `assets/brand/`. | `ls src/renderer/src/lib` shows only `layout.ts`; `docs/` did not exist. |
| `global.css` is 1,776 lines with one `:root` block of 17 variables (`global.css:1-21`). It still contains 25 hex colors and 33 `rgba()` literals, so "tokens" cover only part of it. | `grep -c` on the file. |
| 119 inline `style={{...}}` props in TSX, several with hex colors (`SettingsView.tsx:61-65,185`, `LiveRunView.tsx:122,206,485`, `RoleInspector.tsx:184`). | `grep`. |
| 11 distinct font sizes: 9, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14.5, 15 px. | `grep font-size global.css`. |
| 4 `aria-*`/`role` attributes in the whole renderer. 5 native `confirm()` calls. No `:focus-visible` rule and no `prefers-reduced-motion` rule anywhere. | `grep`. |
| Brand is the letter "O" on a gradient square (`App.tsx:39-42`, `global.css:91-101`), not the org-chart glyph in `build/icon.png`. | source and `scripts/make-icon.mjs`. |

## 1. Prioritized issue list

### High

| # | Issue | Where |
| --- | --- | --- |
| H1 | **Settings are scattered across four places with two levels of tabs.** Top bar has `Live` and `Org chart & settings`; inside the second, a floating toolbar tab switches `Org chart` and `Project settings`; app settings are a third page; notification and logs controls live in the sidebar footer. The user cannot predict where a setting is. | `App.tsx:121-128`, `SettingsView.tsx:139-170`, `AppSettingsView.tsx`, `App.tsx:100-103` |
| H2 | **Project settings is a 20-control single scroll with no grouping**, mixing identity, permissions, cost, git, retention, provider, saved rules, branch maintenance and a destructive action in one 640px column. The AI "Design the org chart" panel stays open beside it though it is irrelevant there (see `maint-01-list.png`). | `SettingsView.tsx:378-531`, `199-376`, `150-152` |
| H3 | **Notifications have two controls and one is dead.** The sidebar checkbox writes `localStorage` and calls `notifications.setEnabled`. The Settings page checkbox writes `AppSettings.notifications`, which `main` never reads (only `store/settings.ts:32` normalizes it). Flipping the Settings checkbox does nothing. | `NotificationsToggle.tsx:4-32`, `AppSettingsView.tsx:201-207`, `main/index.ts:90` |
| H4 | **Keyboard and screen-reader access is broken.** `.check input { display:none }` removes every checkbox and radio (tools, delegation, auth, kind, quick-draft mode, skip-setup, notifications, show-thinking) from tab order. Buttons, tabs and nav items have no focus indicator. Project cards and run chips are `div role="button"`/`div onClick` or have no role at all. `RunHistory` nests `span role="button"` inside a `<button>` (invalid, double activation). | `global.css:358-378,329-334`, `ProjectsView.tsx:69-76`, `TranscriptPanel.tsx:28-95` |
| H5 | **Contrast failures.** `--text-faint #646d84` on `--panel #0f1218` is 3.63:1 (used for hints, paths, usage resets, tags, 22 rules). White text on the accent `#7c5cff` is 4.35:1 on every primary button. White initials on amber (`#f5a524`, 2.04:1), green, light blue and lime role avatars. The 9-11 px sizes make this worse. | `global.css:10-11,280,592-604`, `AgentNode.tsx:54` |
| H6 | **The live canvas is covered by absolutely positioned layers with magic offsets.** Run strip (`top:12`), canvas toolbar (`top:12` or `52`), proposals/questions (`top:56` or `96`, 520px wide), permission cards (360px, jumps to the *left* when proposals exist), merge reviews, pause banner and legend all float over the graph and are re-positioned by ternaries. Large proposals cover the agents the user is being asked to judge. The latest commit ("Keep approval and proposal cards below the canvas toolbar") is a symptom. | `LiveRunView.tsx:300-410`, `global.css:487-494,815-824,1041-1054,1353-1364` |
| H7 | **Native `confirm()` for five destructive actions** (delete project, remove role, discard branch x2, uninstall). It blocks the renderer, cannot be styled for the theme, offers no target name emphasis, and Delete sits beside the card's open click target. | `ProjectsView.tsx:100`, `RoleInspector.tsx:32`, `SettingsView.tsx:295,360`, `MergeReviewCard.tsx:17` |
| H8 | **No light theme, no theming path.** All colors are literal dark values; React Flow marker and background colors are hex strings in TSX. The architecture requires dark/light/system, accent and canvas options. | `global.css:1-21`, `SettingsView.tsx:61-65,185`, `LiveRunView.tsx:485` |

### Medium

| # | Issue | Where |
| --- | --- | --- |
| M1 | **Sidebar footer carries five unrelated things** (auth pill, three usage bars with reset lines, as-of/refresh, notifications checkbox, Logs button) in 11-12 px faint text. The usage block is about 190 px tall and out-weighs the project list in `layout-01-editor.png`. | `App.tsx:83-105`, `UsageMeter.tsx:83-110` |
| M2 | **Two things called "Logs".** The sidebar `Logs` button opens the app's log folder; the transcript panel `Logs` tab shows the run log. Same word, different scope. The tab also appends a bare `!` for errors. | `LogsLink.tsx`, `TranscriptPanel.tsx:132-134` |
| M3 | **Header carries the wrong things.** The working directory is a truncated pill that competes with the title and must be shrunk in e2e (`layout.mjs:31-35`); the run status pill duplicates the canvas toolbar's `Session finished` pill and the run chip dot; tab labels are `Live` and `Org chart & settings` (a conjunction that signals a junk drawer). Status is a nested ternary of class names. | `App.tsx:107-134` |
| M4 | **Canvas toolbar mixes data, state and actions in one row** with the same pill styling: `Setup session`, `continued`, cost, agent count, fold toggle, Interrupt, End session, status text, Org retrospective. Primary actions (Interrupt/End) are `sm` buttons indistinguishable from the fold toggle. | `LiveRunView.tsx:301-350` |
| M5 | **Approval cards are not one family.** Permission cards are hand-built markup in `LiveRunView`; proposal, question and merge-review cards are components with different headers and border colors (`rgba(124,92,255,.55)` vs `rgba(245,165,36,.55)`); primary labels differ (Allow once / Approve / Submit / Merge). The permission card has four to five buttons in a wrapping row with `Allow for session` and `Always allow (project)` equal in weight to `Deny`. | `LiveRunView.tsx:373-410`, `ProposalCard.tsx`, `QuestionCard.tsx`, `MergeReviewCard.tsx`, `global.css:825-861,1055-1070` |
| M6 | **Transcript panel mixes three different scopes.** Header shows the selected agent's name but its tabs are `Transcript` (per agent), `Logs` (per run), `Runs` (per project). Project history rows (kind chip, status pill, resumed chip, cost, Continue, Retrospective, prompt, date) are crammed into 400 px. | `TranscriptPanel.tsx:17-139` |
| M7 | **Agent summary is a mono key/value dump** (role, model, state, elapsed, tokens, cost, worktree), the same visual weight as transcript text, repeating information already on the node. | `TranscriptPanel.tsx:142-173`, `global.css:942-955` |
| M8 | **Transcript entries are all boxed cards.** Prose, tool calls and tool results share one bordered rounded box; there is no collapsing of long tool results (they scroll in 220 px), so reading an agent's reasoning means scanning boxes. `Show thinking` is a pill checkbox floating above entries. | `TranscriptPanel.tsx:177-233`, `global.css:896-940` |
| M9 | **Role inspector is one long scroll** (identity, description, model, effort, reports-to, tools, delegation, responsibilities, 160 px system prompt, color) with sections separated only by faint uppercase labels. Slug is exposed as a peer of Name though it is derived. Color picker is 8 unlabeled buttons with a literal `#fff` selection border. | `RoleInspector.tsx:60-189` |
| M10 | **Two AI drafting paths with equal weight.** "Revise with the Architect" (agentic, approvals) and "Quick draft (no repository access)" (one-shot) are stacked, with a `Revise current chart / Start fresh` radio pair styled like tabs and a `Draft org chart` button that looks like the primary action. The user cannot tell which to choose. | `DraftPanel.tsx:36-139` |
| M11 | **Projects page makes creation permanent furniture.** A 380 px form column is always present, even with several projects; the empty state is a plain card beside it. Field order differs between the two modes (name first vs path first); `Skip AI setup` is a checkbox chip. Whole cards are click targets with a ghost Delete inside. | `ProjectsView.tsx:58-198`, `global.css:422-469` |
| M12 | **The composer hides its mode.** Reply vs Continue vs New run vs Setup answer is signalled only by a 100-character placeholder and a changing button label. `New run` appears and disappears. | `LiveRunView.tsx:510-544` |
| M13 | **Run strip is a second navigation system** overlaid on the canvas (chips with kind, prompt, cost, dismiss) next to a third (Runs tab) and a fourth (sidebar dots). | `RunStrip.tsx`, `global.css:1353-1446` |
| M14 | **Duplicated settings with different wording and layout.** App defaults and project settings repeat permission mode, cost cap, runs to keep, isolate writers, prefer Sonnet; labels are inconsistent ("Subscription limits" label above a single checkbox; "Parallel work" label above a checkbox) and hints run to three sentences. | `AppSettingsView.tsx:105-196`, `SettingsView.tsx:408-510` |
| M15 | **`.check` pill is used for five different controls**: boolean, radio, multi-select, tool toggle, choice chip. Users cannot tell state or type. Booleans should be switches; exclusive choices a segmented control or radio group. | `global.css:358-378` and every `className="check"` |
| M16 | **Uppercase 10-11 px tracked labels** (`.chip`, `.side-section-title`, `.sidebar-label`, `.permission .who`) are the main hierarchy device and the lowest-contrast text. Section titles in settings are weaker than field labels. | `global.css:110-116,380-393,522-528` |
| M17 | **Fixed-width side panels at a 1024 px minimum window.** `.editor` is `1fr 360px`, `.live` is `1fr 400px` plus a 240 px sidebar, leaving ~380 px of canvas at the minimum size. Nothing collapses or resizes. | `global.css:473-478,783-789`, `main/index.ts:40` |
| M18 | **Agent node footer swaps data**: tokens always, then cost *or* elapsed depending on whether cost is known, so the same slot changes meaning during a run. `tok` is not a word. Worktree status is a text line with no icon. State is conveyed mainly by ring color and animation. | `AgentNode.tsx:78-81` |
| M19 | **Usage meter semantics.** Bars are a blue unrelated to the accent; warning at 80% is fixed in code (`UsageMeter.tsx:25`); `refresh` is a tiny faint text button; `Fable weekly` and other model labels are shown without a grouping; the empty state is two lines of faint text. | `UsageMeter.tsx`, `global.css:1649-1707,1753-1776` |
| M20 | **Provider shown twice and read-only in project settings** (a `Claude (...)` pill followed by the auth picker) with a sentence that apologizes for there being only one provider. | `SettingsView.tsx:511-527` |

### Low

| # | Issue | Where |
| --- | --- | --- |
| L1 | Unicode glyphs (`▦`, `⚙`, `▾`, `×`, `✓`, `!`) as icons; baselines and weights differ by font. | `App.tsx:48-52`, `DoneGroupNode.tsx:54`, `RunStrip.tsx:68`, `AgentNode.tsx:56-57` |
| L2 | `LogsLink` uses `margin-left: 6px` inline to align with the checkbox above it. | `LogsLink.tsx:19` |
| L3 | `UsageMeter.tsx` has an import after a component (line 23). | `UsageMeter.tsx:23` |
| L4 | `pop-in` scale from 0.6 with overshoot is playful for a dense tool; four infinite loops (`breathe`, `spin`, `ripple`, `blink`) run with no reduced-motion fallback. | `global.css:988-1028` |
| L5 | `.btn:hover` and scrollbar thumb are hex literals; `.legend` background is an rgba of the dark panel. | `global.css:268,57,872` |
| L6 | The legend explains color only, not the ring shapes and icons that also encode state. | `LiveRunView.tsx:490-507` |
| L7 | Spinner is a bare ring with no label for assistive tech. | `global.css:1029-1037` |
| L8 | `RoleNode` shows raw model ids (`opus`) in an uppercase chip and a `6 tools` count that says nothing about which tools. | `RoleNode.tsx:21-26` |
| L9 | Hint text uses inline `style` overrides in several places instead of the `.hint` class (`AppSettingsView.tsx:101,172`). | |

## 2. Findings per screen

### 2.1 Shell and navigation (`App.tsx`, sidebar, top bar)

*What works:* fixed left rail with project list and live/attention dots (`App.tsx:60-72`); the attention state uses a distinct dot color.

*Problems:*
- **Two labels for one concept.** Nav item `Projects` and section label `Workspaces` both name the project list, and clicking a project does not reveal the nav hierarchy (`App.tsx:46,57,65`). (med)
- **Footer overload** (M1). The auth pill is the only account-level indicator and is not actionable although clicking it is the obvious way to fix a logged-out state (`App.tsx:84-99`). (med)
- **Top bar** (M3). Path pill, status, and a two-segment tab group at the far right; tab group is rendered as a pill inside a bordered box and wraps (`Org chart & settings` breaks onto two lines in `layout-02-live-long-path.png`). (med)
- **Brand** (see foundation table): no mark, no wordmark, only the letter O. (med)
- **No back affordance from App Settings**: Settings is a nav item that replaces the main area; leaving it means clicking Projects or a project. (low)
- **Nothing is collapsible.** (M17)

### 2.2 Projects view (`ProjectsView.tsx`)

- Layout is `1fr 380px` for list and creation form (`global.css:422-429`): the form dominates a screen whose job is picking a project (M11). (med)
- Card is a clickable `div` without keyboard support (H4). Delete is placed in the card footer (H7). The role dots use `#fff` text on arbitrary color (H5). (high)
- Cards show path, role dots, role count, setup pending. They do not show the one thing a returning user wants: *is anything running or waiting, and when did it last run?* (med)
- Empty state is a plain card with a paragraph; no primary action because the form is the action (`ProjectsView.tsx:60-65`). (med)
- Form: mode tabs reuse the global `.tabs` pill; name/path ordering differs per mode; `Skip AI setup` is a pill checkbox that changes the submit label (`ProjectsView.tsx:178-197`). The error uses `draft-box` with an inline red override (`183`). (med)

### 2.3 Org chart editor (`SettingsView.tsx` canvas half, `RoleNode`, `RoleInspector`, `DraftPanel`)

- Toolbar combines a tab pair (navigation) with two buttons (actions) in a single floating row (`SettingsView.tsx:160-171`; see `layout-01-editor.png`). (H1)
- Tool hint `Drag from a node's bottom handle…` is in the same legend slot as run state in the live view; it is the only discoverability for connecting roles and is faint (`SettingsView.tsx:188-190`). (low)
- Nodes: clear hierarchy of avatar, name, mono slug; chip row is uppercase 10.5 px. Selected state is a role-colored ring and nothing else. Edges color by child role, which is good for identity but ambiguous for direction; `not delegable` edges use hard-coded hexes (`SettingsView.tsx:61-65`). (med)
- Inspector (M9) and draft panel (M10). Remove role is a `ghost sm danger` button in the header next to the title with a native confirm (H7).
- `Auto-layout` and `Add role` do not show keyboard shortcuts or an undo; deleting role is irreversible. (low)

### 2.4 Live run view (`LiveRunView.tsx` and children)

- Layering problems (H6) and toolbar mixing (M4).
- **Empty state** is the strongest screen in the app: concise, role chips, clear instruction. Role chips use `color` for text on dark; in a light theme they need derived contrast. Keep and restyle (`LiveRunView.tsx:437-469`).
- **Setup empty state** offers `Start setup` only; no explanation of cost or duration. (low)
- **Agent nodes**: well structured (avatar ring, name, role and model, activity line, worktree line, footer). Issues: M18, small mono 10.5 px text, the `done` state lowers opacity to 0.72 which also lowers text contrast below AA on the already-dim faint colors (`global.css:638-640`). (med)
- **Done-group node**: good idea, but its toggle is a `▾` glyph button with title only (`DoneGroupNode.tsx:50-57`). (low)
- **Legend** at bottom-left is easy to miss and duplicates a side-panel idea (L6).
- **Pause banner** sits above the composer inside the canvas column; it is the right location and the right content, but it uses its own styling (`global.css:1709-1752`). (low)
- **Composer** (M12): `Enter` sends, `Shift+Enter` newline is only in a placeholder that disappears once typing starts. No character of affordance for attaching context or choosing which agent to address. (med)
- **Run strip** (M13).

### 2.5 Transcript, logs and history (`TranscriptPanel`, `FinishedList`, `Markdown`)

M6, M7, M8, M2. Additionally: tab bar plus header plus summary consume ~190 px before the first transcript line (see `layout-02`, where the empty panel is mostly chrome). `FinishedList` and `Markdown` were not reviewed in depth beyond consistency of class naming. (med)

### 2.6 Approval, proposal, question and merge cards

M5. Additionally:
- Cards are 360-520 px floating panels with `max-height: 46vh` scrolling bodies (`global.css:1078-1087`), so a long architecture proposal is read through a small window over a live graph. These are the highest-stakes decisions in the product (approve an org chart, an architecture document, a merge) and get the least room. (high, with H6)
- `Approve` / `Request changes` (`ProposalCard.tsx:63-77`) are good, plain labels; keep them.
- Destructive discard in `MergeReviewCard` is a red text button of the same size as Merge. (low)

### 2.7 App settings (`AppSettingsView.tsx`)

- Four sections (`Claude authentication`, `Defaults for new projects`, `Usage`, `App`) in a 640 px column using `side-section-title` (the inspector's sub-heading style) as page headings (`AppSettingsView.tsx:97,105,177,199`), M14, H3.
- Saves automatically with a `Saved` text in the top bar (good), but no indication until a change happens and no per-field confirmation. (low)
- `Usage` holds a single numeric field, `Opus weekly threshold`, whose meaning only makes sense next to the per-project checkbox it refers to; a placeholder-level hint explains it in two sentences. (med)
- Data directory field is read-only text in an input; `Open folder` is the only action. No version, no logs, no about. (low)

### 2.8 Project settings (`SettingsView.tsx:378-531`) and maintenance (`199-376`)

H2, M14, M20. Additionally:
- The control order starts with Name, Working directory, Brief, then jumps to Permission mode, cost cap, depth, concurrency in a two-column grid, then free-form sentences with inline inputs (`Stop when one run uses more than [ ] % of the five-hour window`, `SettingsView.tsx:447-465`). (med)
- Maintenance (branches, architecture review, footprint, uninstall) is below the fold, followed by a notice box that renders at the very bottom, far from the button that caused it (`SettingsView.tsx:369-373`). e2e relies on this DOM position (`maintenance.mjs:48`). (med)
- A branch row is the densest in the app (code, three chips, date, subject, mono file list, three buttons, diff). It is well organized internally and should become the model for list rows elsewhere. (positive)
- Destructive `Remove OrgAI files from repository` is styled identically to an in-card danger button and is not separated from routine actions. (high when combined with H7)

### 2.9 Usage meter (`UsageMeter.tsx`)

M1, M19. One additional point: the semantic color ramp (accent blue, then warn at 80, danger when limited) is correct in intent but the `danger` state is only reached when the provider says rejected, not when utilization nears 100; users get no intermediate "nearly out" level. (low)

### 2.10 Logs and notifications

M2 and H3. The log-folder link has no visible state or tooltip text on the button itself.

## 3. Cross-cutting consistency findings

| Topic | Observation |
| --- | --- |
| **Buttons** | `.btn`, `.btn.primary`, `.btn.danger`, `.btn.ghost`, `.btn.sm`: five variants but no icon button, no loading state, no size above default; `danger` is text-only red, `primary` is flat purple with white text (H5). A `span role="button"` imitates `.btn` (`TranscriptPanel.tsx:53-57`). |
| **Inputs** | One style for input/select/textarea with a 3 px purple halo on focus only. Selects are native with default arrow. No invalid or disabled-reason state. Number inputs show spinners (`maint-01-list.png`, Runs to keep). |
| **Badges** | `.pill` (rounded, dot), `.chip` (rounded 6, uppercase), `.check` (selectable chip), `run-chip`, `.entry .tag`. Five badge-like things. |
| **Cards** | `.card`, `.draft-box` (dashed border!), `.proposal`, `.permission`, `.maint-row`, `.entry`, `.run-row`, `.project-card`, `.finished-row`. Radius values 6, 7, 8, 9, 10, 12, 14 are all used. |
| **Spacing** | No scale. Paddings of 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 18, 24 px appear. |
| **Typography** | 11 sizes, five weights (600, 650, 700, 800, 900); uppercase tracking used for four different roles. |
| **Empty states** | Plain text in `.entry.system` (`Select an agent...`), `.usage-empty`, `.card` paragraph, and the live view's centered block. No shared pattern or icon. |
| **Loading / error** | `Loading…` text, `Looking…` hint, bare spinner; errors as red text or a red dashed box in four forms. |
| **Dialogs** | None. All confirmation is `window.confirm`. |
| **Tooltips** | Native `title` attributes (41). Not themed, delayed by the OS, unavailable to keyboard users. |
| **Icons** | None except unicode glyphs. |

## 4. What is already good (keep it)

- The org-chart-as-canvas idea and the live graph are the product's identity; node anatomy (avatar with state ring, activity line, worktree line) is information-rich and scannable.
- The live-view empty state and the `Approve` / `Request changes` vocabulary.
- The branch maintenance row structure.
- Debounced auto-save with a visible `Saved` indicator.
- The semantic `--ok --warn --danger` triplet and the sidebar's live/attention dots.
- Folding finished reports into a group node is a good answer to canvas growth.
