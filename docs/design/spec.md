# OrgAI UI design spec (phase 1 proposal)

Status: proposal, awaiting approval of the decisions in section 11. Findings behind it are in `ui-review.md`; the build order is in `plan.md`.

Related: connections, model remap, the model picker, MCP servers and plugins, and the live MCP install approval are specified in `providers-and-mcp.md`.

Goal from the user: the app should feel **modern and clean**, and controls and data that are currently poorly organized should be grouped and easy to find.

Design stance: a calm, dense-but-airy desktop tool in the vein of Linear / VS Code settings / Vercel dashboard. Neutral surfaces, one accent, status color only for status, hierarchy from type weight and spacing rather than from borders and uppercase labels.

## 1. Principles

1. **One place per setting.** Every setting has exactly one home, named by what it affects (app, project, role, run).
2. **Group by task, not by data shape.** Settings pages are sections of a few related rows; actions that change the repo or delete data live in a labeled danger zone.
3. **Decisions get room.** Anything that gates the agents (permissions, proposals, merge reviews) is a first-class, consistently styled item, never a floating panel covering the graph.
4. **State is never color alone.** Every status has an icon or shape and a text label (WCAG 1.4.1).
5. **Tokens only.** No hex, rgba, shadow or radius literal outside `tokens.css`. Both themes define every token. Components are theme-agnostic.
6. **Native where it is better.** Native `<select>`, `<input type=number>`, scrollbars stay unless a primitive is needed for a11y or styling.

## 2. Information architecture

### 2.1 Shell

```
+----------------+-------------------------------------------------------------+
| [mark] OrgAI   |  Projects / Notes API                [status] [path ⧉]  ...    |
|                |  Run | Org chart | History | Settings                          |
| ▢ Projects     +-------------------------------------------------------------+
|                |                                                             |
| PROJECTS  [+]  |                    page content                             |
|  ● Notes API   |                                                             |
|  ◐ OrgAI    2  |                                                             |
|  ○ Cybrid      |                                                             |
|                |                                                             |
| ----------     |                                                             |
| [claude] Max ▾ |                                                             |
| 5h ▮▮▯▯ 29%  ⚙ |                                                             |
+----------------+-------------------------------------------------------------+
```

- **Sidebar, 232 px, collapsible to a 56 px icon rail** (auto-collapse below 1180 px window width; toggle with `Ctrl/Cmd+B`).
  - Header: brand lockup (section 9).
  - `Projects` nav item (home grid). Under it a `Projects` section list (one label only; the duplicate `Workspaces` label goes) with a `+` icon button that opens the New project dialog. Each row: status dot (idle, running, needs you) plus name; a numeric badge shows pending approvals when above zero; tooltip shows path.
  - Footer (pinned): one **Account card** and a **Settings** icon button (gear). The card shows the provider mark, `Claude · <method>` and, on subscription auth, the *single most constrained* plan window as a 4 px bar plus percent. Clicking the card opens the **Usage popover** (all windows, reset times, as-of, `Refresh`, link to `Settings > Claude and usage`). A logged-out or error state turns the dot warning/danger and the card text says what to do (`Not logged in · Fix`), opening Settings > Claude and usage.
  - Removed from the footer: the notifications checkbox (moves to Settings > Notifications), the `Logs` button (moves to Settings > Data and about > `Open log folder`), the always-expanded usage bars.
- **Main area** is either the Projects page, a project workspace, or App Settings. App Settings is a full-width page with its own left sub-nav and a `Back` link; `Esc` returns.
- **Window title** stays the OS title bar (no custom frame in this phase; see decision D7).

### 2.2 Project workspace

Header (one row, 52 px) then a tab bar:

| Element | Content |
| --- | --- |
| Breadcrumb | `Projects / <name>` (the first part links back). |
| Working directory | Mono text, middle-truncated, with a copy icon button and tooltip of the full path. Not a pill. |
| Run status | A single `Badge` (dot + label) for the viewed run: `Working`, `Waiting for you`, `Paused`, `Finished`, `Failed`, `Idle`. This is the only place the run status is repeated outside the run bar. |
| Tabs (Radix Tabs, underline style) | `Run` · `Org chart` · `History` · `Settings`. `Run` is the default when opening a project. Tab names replace `Live` and `Org chart & settings`. |

Rules: tabs are real `role=tablist`, arrow-key navigable, deep-linkable through the store (`projectTab`). Settings no longer contains the org chart.

### 2.3 Settings structure

Two scopes, same layout: left sub-nav (200 px) + content column (max 720 px) with page title, short description and groups. Each group is a `Card` containing **setting rows**: label and one-line description on the left, control on the right (`SettingRow`). Auto-save with a header `Saved` indicator (existing behavior, now shared by both scopes).

#### Project settings (tab `Settings`)

| Section | Rows | Notes |
| --- | --- | --- |
| **General** | Name, Working directory (path field + Browse), Project brief (textarea, full width). | Brief hint: "Added to every role's system prompt." |
| **Agents and permissions** | Permission mode (select with one-line explanation per option shown below the control), Max subagent depth, Max concurrent subagents, Saved permission rules (list with Remove, empty state, Refresh icon). | Rules list uses the shared list-row pattern. |
| **Limits and usage** | Estimated-cost cap per run (number, "No cap" placeholder, unit label `USD, API-equivalent`), Stop a run above N% of the five-hour window (number with `%` suffix, `Off` placeholder), Prefer Sonnet near the Opus weekly limit (Switch; description links to the global threshold). | Replaces the inline-sentence form. |
| **Repository and parallel work** | Isolate writing reports in git worktrees (Switch), Review each report's changes before it is merged (Switch, disabled with reason when isolation is off), Runs to keep (number, `runs` suffix), Branches waiting in the repository (list + Merge/Discard/View diff; Refresh icon; empty state), Architecture document (last updated + `Review with the Architect` button). | Maintenance moves here, as the lower half of this section. The notice area (`MaintenanceResult`) is an inline `Banner` directly under the list. |
| **Provider** | Provider (read-only value `Claude`), Authentication (RadioGroup: Claude Code login / API key from environment variable; env var input appears when selected). | One row; drop the apologetic sentence. |
| **Danger zone** | `Remove OrgAI files from repository` (describes the exact files), `Delete project` (moves here from the project card menu too). | Visually separated card with danger border; both open a `ConfirmDialog`. |

Order is the order of frequency of change; the left sub-nav scrolls to a section and highlights the active one (scroll-spy) so each section is also a bookmarkable anchor. Sections render on one scrolling page (not hidden panes) so Ctrl+F works.

#### App settings (gear in the sidebar)

| Page | Rows |
| --- | --- |
| **Appearance** | Theme (SegmentedControl: Dark / Light / System, each with a tiny preview), Accent color (swatch grid of 7 presets + custom hex input with live contrast readout), Canvas (Pattern: Dots / Grid / None; Accent tint: Switch; Edge style: Curved / Orthogonal / Straight; Show minimap: Switch), Reduce motion (System / Always). A live preview card (mini org chart + button + badge) renders at the top of the page so changes are visible without leaving. |
| **Notifications** | Notify me when a run needs attention or finishes (Switch). The single source of truth; the sidebar toggle is removed. |
| **Claude and usage** | Authentication (RadioGroup, same component as the project one), live plan usage (same bars as the popover, full width), Opus weekly threshold (number, with the sentence "Applies to projects that prefer Sonnet near the limit"). |
| **Defaults for new projects** | Orchestrator model, Report model, Permission mode, Estimated-cost cap, Runs to keep, Isolate writing reports (Switch), Prefer Sonnet near the limit (Switch). One group, one footnote: "Applied when a project is created. Existing projects keep their own settings." |
| **Data and about** | Data directory (path + Open folder), App logs (Open log folder), Version, link to docs, the OrgAI lockup. |

Settings that exist in both scopes (permission mode, cost cap, runs to keep, isolate, prefer Sonnet) use the same labels and descriptions; app-level rows are prefixed by the page title "Defaults for new projects" instead of re-labelling each field.

### 2.4 Projects page

- Page header: title `Projects`, search field (when more than 6 projects), primary `New project` button.
- **Grid of project cards** (min 280 px). Card anatomy: name (title-sm), mono path (middle-truncated), role avatar stack (max 5 + `+n`, derived foreground), and a status row: run status badge (`Working`, `Needs you`, `Setup pending`, or `Last run 2h ago`), role count. The whole card is a link (`<a>`/`button` with focus ring); the overflow `⋯` menu (Radix DropdownMenu) holds `Open`, `Open folder`, `Delete project…` (confirm dialog).
- **Empty state**: brand mark (48 px, monochrome), `Start with a project`, two sentences, primary `New project` and secondary `Open existing repository` (both open the dialog preselecting the mode).
- **New project dialog** (md, 560 px): step 1 chooses `New idea` or `Existing repository` as two large selectable option cards (RadioGroup); step 2 is the form. Field order is the same in both modes: Folder (with Browse), Name (auto-filled from the folder), then the mode-specific textarea (`What do you want to build?` / `Anything the Architect should know? (optional)`). `Skip AI setup` becomes an `Advanced` disclosure containing a Switch. Primary action `Create and start setup` (or `Create project` when skipping). Errors render in a `Banner` above the footer.

### 2.5 Run tab layout

```
+--------------------------------------------------------------+------------------+
| RUN BAR  [Run ▾ "Add auth..." · Working]  $0.42 · 4 agents   | Side panel       |
|          [Interrupt] [End session] [⋯]                       | Inbox(2) |Agent |  |
+--------------------------------------------------------------+ Log              |
|                                                              |                  |
|                 React Flow canvas                            | agent identity   |
|                                                              | stat chips       |
|   (controls bottom-left: zoom, fit, fold finished, legend)   | transcript       |
|                                                              |                  |
+--------------------------------------------------------------+                  |
| COMPOSER  [Replying to Orchestrator ▾]                       |                  |
| [ textarea.......................................... ] [Send]|                  |
+--------------------------------------------------------------+------------------+
```

- **Run bar** replaces the floating run strip and canvas toolbar. It is a normal 44 px row above the canvas (not absolutely positioned), left to right:
  1. **Run selector** (Radix DropdownMenu/Select): current run prompt (truncated) with kind icon and status dot; the list shows open runs first, then `New run`. Replaces the run strip chips. Closed sessions do not need a dismiss `x` because they are only listed in History.
  2. **Run facts** as plain text: cost (with the existing API-equivalent tooltip), agent count, `continued` badge, `Setup session` badge.
  3. **Actions**: while the session is open, `Interrupt turn` (secondary) and `End session` (danger-ghost). When finished: `Org retrospective` (secondary). Rare actions (fold finished toggle, retrospective) go in the `⋯` menu.
- **Canvas controls** (React Flow `Controls`) gain a `Fold finished (n)` toggle button and a `Legend` popover button, replacing the always-visible legend. The legend shows icon + color + label for each state.
- **Attention (decisions)**, three tiers, one visual family (`DecisionCard`: icon, title, agent, body, footer actions):
  - *Permission requests*: compact cards stacked in a **tray** docked to the top-right of the canvas, width 360, max three visible then `+n more` (opens the Inbox tab). Actions: primary `Allow once`, a split `Allow ▾` menu (`For this session`, `Always for this project`) shown only when suggestions exist, and `Deny`. The rule labels (`ruleLabels`) show inside the menu items.
  - *Proposals, questions and merge reviews*: open in a **right-anchored sheet** (560 px, non-modal Radix Dialog) over the side panel, never over the canvas. If the user dismisses it (`Review later` or `Esc`), it collapses into a banner on the run bar (`Architect proposal waiting · Review`) and a badge on the `Inbox` tab; the agents stay blocked as today.
  - Every item appears in the **Inbox** tab of the side panel (badge count). Opening Inbox is how the user finds anything dismissed.
  - Attention items announce through `aria-live="polite"` and the tab title/badge; they never steal focus from the composer.
- **Composer**: a labelled mode row above the textarea states what Send will do: `Replying to Orchestrator`, `Answering the Architect`, `Continuing this session`, or `New run`, with a small SegmentedControl to switch between `Continue` and `New run` when both are possible. Placeholder is short (`Message the orchestrator…`); `Enter to send · Shift+Enter for a new line` is persistent helper text on the right. Send is an icon+label primary button; disabled with a visible reason when empty.
- **Pause banner** becomes the shared `Banner` (warning) docked directly above the composer, with the countdown and `Resume now` / `Cancel auto-resume`.
- **Side panel** (resizable 360-560 px, default 400, collapsible; remembered per user): tabs `Inbox` · `Agent` · `Log`. `Agent` is selected when a node is selected, otherwise `Inbox` if it has items, otherwise `Agent` with an empty state.
  - Agent identity header: avatar, name, `role · model`, state badge; below it three stat chips (elapsed, tokens in/out, cost) and, when present, a worktree chip (`isolated · branch · status`). This replaces the key/value grid.
  - Transcript: prose entries render without borders (assistant text is plain Markdown; user messages are a tinted bubble); tool calls and results are collapsible rows (`Read src/app.ts` + chevron; results collapsed by default when longer than 6 lines; errors expanded). `Show thinking` becomes a header switch labelled `Thinking`.
  - `Log` is the *run* log (rename from Logs); it has level filter chips and shows an error count badge on the tab, never a bare `!`.
- **Project run history** leaves this panel and becomes the `History` tab (section 2.6).

### 2.6 History tab

A table: Status (badge) · Prompt (truncated, 2 lines max) · Kind · Started (relative with absolute tooltip) · Cost · actions (`Open`, `Continue` where possible, `⋯` with `Org retrospective`). Rows are real table rows with one primary `Open` link; buttons are not nested in buttons. Empty state: "No runs yet. Start one from the Run tab." Filter: segmented `All / Work / Setup`.

### 2.7 Org chart tab

```
+--------------------------------------------------------------+------------------+
| [+ Add role] [Auto-layout]                      [Ask Architect] | Inspector / AI |
|                                                              |                  |
|                 React Flow canvas (roles)                    |                  |
|                                                              |                  |
| hint: Drag from a node's bottom handle to connect.           |                  |
+--------------------------------------------------------------+------------------+
```

- Toolbar is **actions only** (the section tabs are gone). Left: `Add role` (primary-soft), `Auto-layout`. Right: `Ask the Architect` opens the AI panel. A one-line hint shows until dismissed, then lives in a `?` popover.
- **Side panel has two states.** No selection: the **AI panel** with the primary `Revise with the Architect` form (textarea, button) and, below it, a collapsed `Quick draft (no repository access)` disclosure containing instruction, a SegmentedControl `Revise current / Start fresh`, and a secondary `Draft org chart`. The proposal result shows as a `DecisionCard` with `Apply to project` / `Discard`. Role selected: the **Role inspector** (below).
- **Role inspector** is tabbed (Radix Tabs, segmented): `General` (name, description, reports to, model, effort; slug shown as muted derived text with an `Edit` affordance), `Tools and delegation` (tools as a grid of Checkbox rows with the tool name and a short description; `May create subagents` Switch; reports as Checkbox list with avatars), `Prompt` (responsibilities, system prompt). Header: avatar (click opens a color Popover with a 12-swatch grid and custom hex) and name, `⋯` menu with `Remove role…` (ConfirmDialog; root role cannot be removed).
- Node anatomy in section 6.

### 2.8 Global patterns

- **Confirmations** use `ConfirmDialog` (Radix AlertDialog). Title names the object (`Delete "Notes API"?`), body says what is and is not affected, destructive button repeats the verb (`Delete project`), focus starts on Cancel.
- **Toasts** (Sonner) for non-blocking results (`Saved`, `Merged branch X`, errors with action). Inline `Banner`s for results that need to remain visible (maintenance notice, pause).
- **Empty / loading / error**: one `EmptyState` (icon, title, description, optional action), one `Skeleton` row pattern for lists, one `Banner` pattern for errors with a Retry where meaningful.
- **Tooltips** replace native `title`, with 400 ms delay, shown on focus too. Icon-only buttons always have `aria-label` plus tooltip.

## 3. Component inventory

All primitives live in `src/renderer/src/components/ui/` and import styles from `styles/ui.css` (tokens only). Headless behavior from Radix; visual from our CSS.

| Component | Variants / props | States | Notes |
| --- | --- | --- | --- |
| **Button** | `primary`, `secondary` (default), `ghost`, `danger` (solid), `danger-ghost`; sizes `sm 28`, `md 32` (default), `lg 36`; optional leading/trailing icon | default, hover, pressed, `:focus-visible` ring, disabled (opacity .5 + `aria-disabled`, tooltip with reason when relevant), loading (spinner replaces leading icon, label kept, width stable, `aria-busy`) | One `primary` per view region. `ghost` for toolbar-level and tertiary. |
| **IconButton** | `ghost` (default), `secondary`; sizes 28/32 | same | Requires `label` (aria + tooltip). |
| **Input / Textarea / Select** | sizes `md 32`, `sm 28`; prefix/suffix adornment (`%`, `USD`, path icon); `invalid` | default, hover (border-strong), focus (border accent + ring), invalid (danger border + message), disabled, readonly (no hover) | Native `<select>` with custom chevron via CSS; number inputs hide spin buttons and use `inputmode`. Mono option for paths/ids. |
| **Field** | label above control, description below, error line | normal, invalid | Used in dialogs and forms; settings pages use `SettingRow`. |
| **SettingRow** | `label`, `description`, control slot, `stack` (control below for textareas) | disabled with reason | 56 px min height, divider between rows. |
| **Checkbox** | standard, in a row with label and optional description | unchecked, checked, indeterminate, focus, disabled | Native input kept in the DOM, visually replaced; replaces `.check` for multi-select lists (tools, reports). |
| **Switch** | label on left in `SettingRow` | off, on, focus, disabled | All booleans. |
| **RadioGroup** | `list` (rows with description) and `cards` (large options) | selected, focus, disabled | Auth choice, new-project kind. |
| **SegmentedControl** | 2-4 items, optional icons | selected (surface-3 + inset border), focus | Exclusive view/mode choices (Theme, quick-draft mode, History filter). |
| **Tabs** | `underline` (page level), `segmented` (in-panel); optional count badge and error dot | selected, hover, focus, disabled | Radix Tabs; arrow keys. |
| **Badge** | tones `neutral`, `accent`, `success`, `warning`, `danger`, `info`; `dot` or `icon`; sizes `sm 20`, `md 24` | static | Sentence case, 11-12 px, no uppercase. Replaces `.pill` and `.chip`. |
| **StatusDot** | `idle`, `working` (pulse), `waiting`, `success`, `danger`, `paused` | static / animated (respects reduced motion) | Always paired with text or `aria-label`. |
| **Card** | `surface`, `interactive` (link/button), `selected`, `attention` (warning left border), `danger` | hover (interactive), focus ring, pressed | Replaces `.card`, `.maint-row`, `.run-row`, `.project-card`, `.draft-box`. Radius `lg`. |
| **ListRow** | leading icon/avatar, title, meta, trailing actions | hover, selected, focus | Branch rows, saved rules, history rows, finished reports. |
| **Dialog** | sizes `sm 400`, `md 560`, `lg 720`; header, scroll body, footer with right-aligned actions | open/close motion, focus trap, `Esc` | New project, color picker (as Popover), etc. |
| **ConfirmDialog** | `tone: danger|default`, `confirmLabel`, `target` | focus on Cancel | Replaces all `confirm()`. |
| **Sheet** | right-anchored, 560, non-modal | collapsed to a run-bar banner | Proposals, questions, merge reviews. |
| **Popover** | arrow-less, 8 px offset | open/close | Usage popover, color picker, legend. |
| **DropdownMenu** | items with icons, shortcuts, separators, destructive item | highlighted, disabled | Card/row overflow, split `Allow`, run selector. |
| **Tooltip** | 11-12 px, max 280 px | delay 400 ms, instant on focus | Replace `title=`. |
| **Toast** | success, error, info with optional action | enter/exit | Sonner, themed by tokens. |
| **Banner** | tones `info`, `warning`, `danger`, `success`; optional action(s) and dismiss | static | Pause, maintenance notice, form errors, dismissed-proposal reminder. |
| **Toolbar** | group, separator, right-aligned cluster | – | Run bar, org chart toolbar. |
| **EmptyState** | icon or brand mark, title, description, action | – | One pattern everywhere. |
| **Progress** | `role=progressbar`, tones by threshold | – | Usage bars: accent below 80, warning 80-94, danger 95+ or limited. |
| **Code / Kbd** | inline mono; keycap | – | Rule labels, branch names, shortcuts. |
| **Avatar** | role color fill, derived foreground, sizes 16/24/32/40, optional state ring | – | Foreground via `readableOn(color)` (section 5.3). |
| **DiffView** | stat + patch; added/removed rows use success/danger soft backgrounds | – | Both themes; no hard-coded greens/reds. |
| **DecisionCard** | icon, title, subtitle (agent), body, footer | pending, busy, resolved | Base for permission, proposal, question, merge review. |

Button label rules: verbs for actions, no trailing ellipsis unless a dialog follows, Title case avoided (sentence case throughout).

## 4. Design tokens

All values are the contract for `styles/tokens.css`. Tokens are CSS custom properties on `:root`; light overrides sit under `:root[data-theme='light']`, and `system` is handled by `@media (prefers-color-scheme: light) { :root[data-theme='system'] { ... } }` using the same values (JS only sets `data-theme` to `dark|light|system`; no JS needed for first paint). `color-scheme` is set per theme so native controls and scrollbars follow.

### 4.1 Color roles

Surfaces step by lightness (dark) or tint (light). Borders are for separation; depth in dark mode comes from surface steps, not shadows.

| Token | Role | Dark | Light |
| --- | --- | --- | --- |
| `--surface-0` | app background, canvas base | `#0b0d12` | `#f4f5f9` |
| `--surface-1` | sidebar, top bar, side panel | `#0f1218` | `#fafbfd` |
| `--surface-2` | cards, node bodies, inputs' surround, popovers | `#141821` | `#ffffff` |
| `--surface-3` | hover, selected rows, segmented selected | `#1b2030` | `#eceff6` |
| `--field-bg` | input, textarea, select | `#0b0d12` | `#ffffff` |
| `--overlay-scrim` | dialog backdrop | `rgb(4 5 8 / .6)` | `rgb(16 20 32 / .35)` |
| `--border-subtle` | dividers inside cards, rows | `#1c2130` | `#e6e9f1` |
| `--border-default` | card and panel borders | `#262d40` | `#d9dde8` |
| `--border-strong` | hover borders, separators of emphasis | `#364058` | `#c3cadb` |
| `--border-input` | input, checkbox, switch track outline (>= 3:1) | `#5d6882` | `#858ea3` |
| `--text-primary` | body and headings | `#e8ebf3` | `#12151f` |
| `--text-secondary` | descriptions, secondary labels | `#a3adc2` | `#4a5368` |
| `--text-tertiary` | meta, timestamps, placeholders (still >= 4.5:1; never below 11 px) | `#8089a0` | `#636d82` |
| `--text-disabled` | disabled controls (exempt from AA by WCAG) | `#5b6479` | `#9aa3b5` |
| `--text-on-accent` | text on accent fill (derived, see 5) | `#ffffff` | `#ffffff` |
| `--accent` | primary fill, selected indicators | `#6e4df5` | `#5b3df0` |
| `--accent-hover` | hover fill | `#6444e8` | `#4f31de` |
| `--accent-active` | pressed fill | `#5a3bd9` | `#4527c8` |
| `--accent-text` | links, selected tab label, accent text on surfaces (>= 4.5:1 on surfaces 0-3) | `#a592ff` | `#4f33d6` |
| `--accent-soft` | selected-row/segment background | `color-mix(in oklab, var(--accent) 16%, transparent)` | `color-mix(in oklab, var(--accent) 10%, transparent)` |
| `--accent-soft-border` | border of soft accent surfaces | `color-mix(in oklab, var(--accent) 36%, transparent)` | `color-mix(in oklab, var(--accent) 28%, transparent)` |
| `--focus-ring` | 2 px outline + 3 px halo | `var(--accent-text)` | `var(--accent-text)` |
| `--success` / `--success-text` / `--success-soft` | status | `#22c58b` / `#34d399` / 14% mix | `#12a06f` / `#0b7a53` / 10% mix |
| `--warning` / `--warning-text` / `--warning-soft` | status | `#f5a524` / `#f5b73d` / 14% | `#e08a00` / `#8f5400` / 10% |
| `--danger` / `--danger-text` / `--danger-soft` | status | `#ff6b6b` / `#ff7b7b` / 14% | `#d9363e` / `#c62f3b` / 10% |
| `--info` / `--info-text` / `--info-soft` | status, "working" | `#2bb0ff` / `#4cb8ff` / 14% | `#1a86d9` / `#0b6bb5` / 10% |
| `--state-working` | alias of `--info` | | |
| `--state-waiting` | alias of `--warning` | | |
| `--state-done` | alias of `--success` | | |
| `--state-error` | alias of `--danger` | | |
| `--state-idle` | alias of `--text-tertiary` | | |
| `--code-bg` | inline/blocks of code, tool output | `#0d1016` | `#f1f3f8` |
| `--diff-add-bg` / `--diff-del-bg` | diff rows | `color-mix(in oklab, var(--success) 14%, transparent)` / `... var(--danger) ...` | 12% mixes |
| `--scrollbar-thumb` / `--scrollbar-thumb-hover` | | `#2a3041` / `#3a4258` | `#c3cadb` / `#a9b2c6` |
| `--brand-from` / `--brand-to` | brand gradient (fixed, not user-accent) | `#7c5cff` / `#2bb0ff` | same |

Rules:
- `*-text` tokens are the only status colors allowed for text; `*` solids are for dots, bars, icons and borders (3:1 non-text).
- Accent is never used for state. State colors are independent of the user's accent, so picking a green or amber accent cannot make "working" look like "done".
- The working state is blue (`--info`) rather than the accent; role color expresses identity on nodes, state expresses what is happening.

Contrast verified (WCAG 2.1 ratios, computed from the hex values above):

| Pair | Dark | Light |
| --- | --- | --- |
| `--text-primary` on surfaces 0-3 | 13.6-16.3 | 15.8-18.2 |
| `--text-secondary` on surfaces 0-3 | 7.2-8.6 | 6.7-7.7 |
| `--text-tertiary` on surfaces 0-3 | 4.6-5.6 | 4.5-5.2 |
| `--accent-text` on surfaces 0-3 | 6.3-7.6 | 6.6-7.6 |
| white on `--accent` / hover / active | 5.2 / 5.9 / 6.9 | 6.2 / 7.4 / 8.8 |
| `--success-text`, `--warning-text`, `--danger-text`, `--info-text` on surfaces 0-3 | 6.5-10.9 | 4.7-6.1 |
| `--border-input` on surface 0-2 | 3.2-3.5 | 3.0-3.3 |

Current app for reference: faint text 3.63:1, white on accent 4.35:1 (both fail AA).

### 4.2 Spacing (4 px grid)

| Token | px | Token | px |
| --- | --- | --- | --- |
| `--space-1` | 4 | `--space-6` | 24 |
| `--space-2` | 8 | `--space-8` | 32 |
| `--space-3` | 12 | `--space-10` | 40 |
| `--space-4` | 16 | `--space-12` | 48 |
| `--space-5` | 20 | `--space-16` | 64 |

Plus `--space-1h` = 6 px for icon-to-label gaps. Conventions: page padding `--space-6`; card padding `--space-4` (`--space-5` in dialogs); gap between cards `--space-4`; row padding `--space-3` vertical; control heights `--control-sm 28`, `--control-md 32`, `--control-lg 36`; sidebar width `--sidebar-w 232`, collapsed `--sidebar-w-collapsed 56`; run bar height 44; top bar 52.

### 4.3 Radius

| Token | px | Use |
| --- | --- | --- |
| `--radius-xs` | 4 | code, kbd, small badges, checkbox |
| `--radius-sm` | 6 | small buttons, segmented items, badges |
| `--radius-md` | 8 | buttons, inputs, menu items |
| `--radius-lg` | 12 | cards, nodes, popovers |
| `--radius-xl` | 16 | dialogs, sheets |
| `--radius-full` | 999 | dots, avatars, pills |

Replaces the current 6, 7, 8, 9, 10, 12, 14.

### 4.4 Typography

Families: `--font-sans: 'Inter Variable', 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif` (Inter bundled via `@fontsource-variable/inter`, decision D5; falls back to the current stack if not approved); `--font-mono: 'JetBrains Mono Variable', 'Cascadia Code', Consolas, monospace`. `font-feature-settings: 'cv11', 'ss01'` optional; `font-variant-numeric: tabular-nums` on `.tabular` (costs, tokens, percentages, elapsed).

| Token | Size / line | Weight | Use |
| --- | --- | --- | --- |
| `--text-caption` | 11 / 16 | 500 | timestamps, node footers, badge text. Minimum size in the app. |
| `--text-small` | 12 / 18 | 400 / 500 | descriptions, secondary text, tooltip |
| `--text-body` | 13 / 20 | 400 | default body, inputs, buttons |
| `--text-body-strong` | 13 / 20 | 600 | labels, row titles |
| `--text-title-sm` | 14 / 20 | 600 | card titles, panel headers |
| `--text-title` | 16 / 24 | 600 | page section titles, dialog titles |
| `--text-title-lg` | 20 / 28 | 600 | page titles, empty-state titles |
| `--text-display` | 24 / 32 | 650 | first-run / hero only |
| `--text-mono` | 12 / 18 | 400 | code, paths, ids, tool output |

Rules: three weights (400, 500, 600) plus 650 for display only; sentence case everywhere; the old uppercase tracked labels become `--text-small` with `--text-tertiary` or become `title-sm` group headings. Replaces the 11 sizes and five weights now in use. Base `body { font-size: var(--text-body) }` (13 px, down from 13.5).

### 4.5 Elevation

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `--elev-0` | `none` | `none` | flat, separated by border |
| `--elev-1` | `0 1px 0 rgb(255 255 255 / .03) inset, 0 1px 2px rgb(0 0 0 / .4)` | `0 1px 2px rgb(16 24 40 / .06), 0 1px 1px rgb(16 24 40 / .04)` | nodes, interactive cards at rest |
| `--elev-2` | `0 8px 24px rgb(0 0 0 / .5), 0 0 0 1px var(--border-default)` | `0 8px 24px rgb(16 24 40 / .12), 0 0 0 1px var(--border-default)` | popovers, menus, tooltips, sheets |
| `--elev-3` | `0 24px 64px rgb(0 0 0 / .6), 0 0 0 1px var(--border-strong)` | `0 24px 64px rgb(16 24 40 / .2), 0 0 0 1px var(--border-default)` | dialogs |
| `--ring` | `0 0 0 3px color-mix(in oklab, var(--focus-ring) 35%, transparent)` | same | focus halo; plus `outline: 2px solid var(--focus-ring); outline-offset: 2px` for `:focus-visible` on all interactive elements |

### 4.6 Motion

| Token | Value | Use |
| --- | --- | --- |
| `--dur-fast` | 100 ms | hover, press |
| `--dur-base` | 160 ms | menus, tabs, switches |
| `--dur-slow` | 260 ms | dialogs, sheet, node spawn |
| `--ease-out` | `cubic-bezier(.2, .8, .2, 1)` | enter |
| `--ease-in-out` | `cubic-bezier(.4, 0, .2, 1)` | move |

Node spawn: opacity 0 / scale .94 to 1 over `--dur-slow` (replaces the 0.6 overshoot). Ambient loops (`breathe`, `ripple`, `blink`, ring `spin`) are permitted only for states that are actively running and have a static fallback: under `prefers-reduced-motion: reduce` or `AppearanceSettings.reduceMotion = 'on'` all durations become 0.01 ms, loops stop, and state is carried by icon and label (ring remains a solid colored border).

### 4.7 Z-index and layout tokens

`--z-canvas-overlay 5`, `--z-tray 6`, `--z-sheet 20`, `--z-popover 40`, `--z-dialog 50`, `--z-toast 60`. Replaces literal 5, 6, 7 and the absolute `top: 56/96` offsets: nothing is absolutely positioned relative to a sibling that can change height; the run bar is in normal flow and overlays only dock to the canvas's own corners.

## 5. Accent derivation

User input: one base color `AppearanceSettings.accent` (hex, default `#7c5cff`, the brand violet). `lib/theme.ts` exports `deriveAccent(baseHex, mode: 'dark' | 'light')` (pure, unit tested) returning the tokens in section 4.1 and `applyAppearance()` writes them to `document.documentElement.style` for the resolved mode; when mode is `system`, it re-derives on `matchMedia('(prefers-color-scheme: dark)')` change. Default values for `#7c5cff` are also written statically in `tokens.css`, so first paint is correct and the JS only changes them when the user picks another accent.

Algorithm (OKLCH, WCAG 2.1 contrast):

1. Convert base to OKLCH. If chroma < 0.04 (grays), keep as-is (neutral accent is valid); otherwise leave chroma alone, only clamp to the sRGB gamut at the end.
2. **Fill (`--accent`)**: set L within `[0.50, 0.66]` for dark, `[0.44, 0.58]` for light (keeps it visible against surfaces). Then pick the foreground: try `#ffffff`, and lower L (down to the range floor) until contrast >= 4.5. If white cannot reach 4.5 within range, try ink `#0b0d12` and raise L (up to 0.84) until >= 4.5. Choose whichever needed the smaller L shift. `--text-on-accent` is the winner. (`#7c5cff` in dark becomes `#6e4df5`, white 5.2:1.)
3. **Hover / active**: shift L by -0.03 / -0.06 if the foreground is white, +0.03 / +0.06 if ink; re-check >= 4.5, and clamp.
4. **Text (`--accent-text`)**: from the base hue and chroma, move L toward readable until contrast >= 4.5 against *both* `--surface-0` and `--surface-3` (dark: raise L to at most 0.82; light: lower L to at least 0.38). If chroma must drop to stay in gamut, reduce it, never the hue.
5. **Soft / soft-border**: `color-mix(in oklab, var(--accent) 16% / 36%, transparent)` for dark; 10% / 28% for light (CSS only; no JS).
6. **Focus ring** equals `--accent-text`; the halo is 35% of it. Because step 4 guarantees 4.5:1 against all surfaces, the ring also meets the 3:1 non-text requirement against surfaces.
7. **Validation in the settings UI**: the custom-color input shows the derived fill and text swatches, the two contrast ratios, and a warning chip if the user's base had to move more than 0.08 in L (`Adjusted for readability`).

Not derived from the accent: the brand gradient (`--brand-from/--brand-to`), status colors, role colors, the canvas pattern.

Presets (swatches in Appearance): Violet `#7c5cff` (default), Blue `#3b82f6`, Teal `#14b8a6`, Green `#22c55e`, Amber `#f59e0b`, Rose `#f43f5e`, Slate `#64748b`.

### 5.3 Role colors

`Role.color` remains user data (existing `ROLE_COLORS` palette plus the new picker). Where role color is a *background* (avatars, `+n` stack), `readableOn(color)` returns `#0b0d12` or `#ffffff`, whichever has higher contrast (fixes white-on-amber 2.04:1). Where role color is *text* (empty-state role chips), use `color-mix(in oklab, var(--role) 70%, var(--text-primary))` so it follows the theme. Role color never encodes state.

## 6. Canvas options and React Flow styling

### 6.1 Canvas options (`AppearanceSettings.canvas`)

| Option | Values (default first) | Effect |
| --- | --- | --- |
| `pattern` | `dots`, `grid`, `none` | React Flow `Background` variant (`dots`, `lines`, none) at `gap 22` (dots size 1.2). |
| `tint` | `true` / `false` | When true, a radial wash of `--accent` at 6% (dark) / 5% (light) at the top center (replaces the hard-coded purple radial at `global.css:483-486`). |
| `edges` | `curved` (bezier) / `orthogonal` (`smoothstep`, radius 10) / `straight` | Edge `type` on both the editor and the live graph. Default stays bezier to avoid changing the current look unless D6 approves orthogonal. |
| `minimap` | `false` / `true` | Mounts React Flow `MiniMap` themed with `--surface-2` and `--border-default`. Off by default; helpful for large runs. |

Canvas tokens: `--canvas-bg` (= `--surface-0`), `--canvas-pattern` (dark `#1f2432`, light `#d3d8e4`), `--canvas-pattern-gap 22`, `--canvas-wash-opacity` (set by the tint option).

### 6.2 Wiring React Flow to tokens

- Pass `colorMode={resolvedTheme}` (`'dark' | 'light'`) to every `<ReactFlow>` so its built-in classes switch; then override its variables on the container:

```css
/* Variable names to be confirmed against @xyflow/react 12.12 style.css at implementation. */
.react-flow {
  --xy-background-color: transparent;
  --xy-node-background-color: var(--surface-2);
  --xy-node-border: 1px solid var(--border-default);
  --xy-node-border-radius: var(--radius-lg);
  --xy-edge-stroke: var(--edge);
  --xy-edge-stroke-width: 1.5;
  --xy-edge-stroke-selected: var(--accent-text);
  --xy-handle-background-color: var(--surface-3);
  --xy-handle-border-color: var(--border-strong);
  --xy-controls-button-background-color: var(--surface-2);
  --xy-controls-button-background-color-hover: var(--surface-3);
  --xy-controls-button-color: var(--text-secondary);
  --xy-controls-button-border-color: var(--border-default);
  --xy-minimap-background-color: var(--surface-2);
  --xy-attribution-background-color: transparent;
}
```

- `Background` takes `color` as `var(--canvas-pattern)` through CSS (preferred) or the resolved value from a `useResolvedToken('--canvas-pattern')` hook (reads `getComputedStyle` on theme change) when the prop must be a literal.
- **Edge marker colors** are props, and `var()` in those SVG paint attributes was not verified to resolve (current code uses hex for markers while edge `style` uses `var()`), so marker colors come from `useResolvedToken(...)` or from the role color directly; this removes the literals `#646d84`, `#9aa3b8`, `#11141c` and `#1f2432` in `SettingsView.tsx`/`LiveRunView.tsx`.

### 6.3 Node and edge styling, both themes

Tokens: `--edge` (dark `#3a4258`, light `#aab3c7`), `--edge-active` (role color), `--node-bg` = `--surface-2`.

| Element | Dark | Light |
| --- | --- | --- |
| Node surface | `--surface-2`, border `--border-default`, `--elev-1`, radius `--radius-lg` | same tokens (white card, hairline border, soft shadow) |
| Node title / sub | `--text-primary` 13/600; `role · model` `--text-secondary` caption mono | same |
| Node footer | tokens in `tabular` caption; consistent slots (tokens left, elapsed right, cost on its own chip when known) | same |
| Avatar | role fill, derived foreground, 40 px, state ring 2 px outside | same |
| **Selected** | `2px solid var(--accent-text)` outline offset 2 + `--elev-2` | same (the focus ring doubles as selection) |
| **Working** (`starting/thinking/tool/delegating`) | border `color-mix(role 55%)`, ring animation, soft glow `0 0 24px color-mix(role 22%, transparent)` | border role 70%, ring animation, **no glow** (invisible on light); instead a 2 px role-colored top border |
| **Waiting for approval** | border `--warning`, ring blink replaced by a `Waiting` badge with icon | same, border `--warning` darker variant |
| **Done** | opacity 1 (no more 0.72 which broke contrast); success check badge; border `--border-subtle` | same |
| **Error** | border `--danger`, `!` badge, `Failed` badge | same |
| **Idle** | `--border-default`, ring `--state-idle` | same |
| Worktree line | icon (branch) + text, colored by status via `*-text` tokens | same |
| Done-group node | 56 px pill: success icon `n done`, `--danger-text` `n failed`, `--warning-text` `n unmerged`, chevron IconButton with `aria-label="Show reports"` | same |
| Edge (idle) | `--edge`, 1.5 px | `--edge` |
| Edge (working) | role color, 2 px, `animated` dashes (disabled when reduced motion) | role color, 2 px |
| Edge (done) | role color at 45% | role color at 55% |
| Edge (not delegable, editor) | `--text-tertiary` dashed `4 4`, label chip on `--surface-0` | same |
| Handles | 9 px circles `--surface-3` with `--border-strong`; accent when connecting | same |
| Controls | 32 px buttons, `--surface-2`, radius `--radius-md`, grouped with 1 px dividers | same |
| Legend popover | icon + label per state: working (spinner dot), waiting (hand), done (check), error (alert), idle (dot) | same |

All node text is theme tokens; node chrome never uses the role color for text.

## 7. Libraries

Principle: headless behavior from a maintained library; visuals stay our plain CSS and tokens. This does not contradict the architecture line "Plain CSS with custom-property design tokens (no CSS framework)"; it adds unstyled primitives, so `ARCHITECTURE.md` should be amended to say so (needs user approval, D1).

**Recommended**

| Package | Why | Replaces | Cost |
| --- | --- | --- | --- |
| `radix-ui` (the unified package; imports `Dialog`, `AlertDialog`, `Tabs`, `Tooltip`, `Popover`, `DropdownMenu`, `Switch`, `Checkbox`, `RadioGroup`, `ToggleGroup`, `Collapsible`, `VisuallyHidden`, `Slot`) | Unstyled, accessible (focus trap, roving tabindex, ARIA, typeahead, collision-aware positioning, portal layering). Works with plain CSS and `data-state` attribute selectors. Tree-shakes per primitive; React 19 compatible. MIT. | `confirm()` x5, hand-built tabs, `.check` radios/checkboxes, native `title` tooltips, missing menus. | One dependency; ~20-40 kB gz for what we import. |
| `lucide-react` | Consistent 24 px stroke icon set; per-icon imports tree-shake to ~0.4 kB each; ISC license; stroke inherits `currentColor` so it themes automatically. | Unicode glyphs. | Imports only used icons. |
| `sonner` | Tiny (~5 kB) accessible toast stack; styled with CSS variables. | Inline `Saved` text, silent failures. | One small dep. Optional (D2). |

**Optional / later**

| Package | Why | Decision |
| --- | --- | --- |
| `react-resizable-panels` | Resizable/collapsible side panel and sidebar, with keyboard handles and persistence. Small. | Recommended for the Run and Org chart tabs; alternative is a hand-rolled CSS drag handle. |
| `@fontsource-variable/inter` + `@fontsource-variable/jetbrains-mono` | Bundled fonts: consistent look across Windows/macOS/Linux, works with the CSP (`font-src 'self' data:`). ~100 kB. | D5: approve or keep system fonts. |
| `cmdk` | Command palette (`Ctrl+K`: switch project, open run, jump to settings). | Out of scope for this overhaul; revisit. |

**Considered and rejected**

| Option | Reason |
| --- | --- |
| Tailwind / shadcn/ui | Violates "no CSS framework"; shadcn is Tailwind-bound and copies code into the repo, adding maintenance with little gain over Radix + tokens. |
| MUI, Mantine, Chakra, Ant | Bring their own theme systems and CSS-in-JS/emotion or large CSS; would fight `tokens.css`, accent derivation and React Flow styling; heavier for a desktop app that already ships a 1.7 MB renderer bundle. |
| Radix Themes / Park UI | Pre-styled; we want our tokens to be the single source. |
| Headless UI (Tailwind Labs) | Smaller primitive set (no tooltip, toggle group, scroll area), centered on Tailwind. |
| Native `<dialog>` only | Good for simple modals, but no popover collision, menu or tooltip story; we would still need Radix for the rest, so one library is simpler. |
| Radix Select | Native `<select>` is more accessible, handles long option lists and keyboard typeahead natively, and styles acceptably (`appearance: none` + chevron). Revisit only if option descriptions (model hints) need rich rendering. |
| Radix Toast | Sonner has a better stack and swipe behavior for less code. |

No package is installed by this phase. Version pinning follows the repo convention (exact versions for runtime deps: `radix-ui`, `lucide-react`) and is chosen at install time with `npm view`.

## 8. Accessibility requirements

- **Keyboard**: every control is focusable; visible `:focus-visible` ring on all interactive elements (outline 2 px + 2 px offset, `--focus-ring`); tab order follows visual order; sheet and dialogs trap focus and restore it; `Esc` closes overlays.
- **Native inputs stay in the DOM** (visually hidden, never `display: none`) for Checkbox, Switch and RadioGroup, or use Radix roles.
- **Roles and names**: icon buttons have `aria-label`; tabs are real tablists; project cards are links/buttons; no interactive element nested in another; progress bars use `role=progressbar` with `aria-valuenow`; run statuses have text, not color alone.
- **Live regions**: new decisions announce via a polite live region ("Permission needed: Implementer wants to run Bash").
- **Target size**: minimum 24x24 px hit area (WCAG 2.2 2.5.8); controls are 28-36 px.
- **Contrast**: section 4.1 table; role-color avatars use derived foreground; user accents are validated by `deriveAccent`.
- **Motion**: `prefers-reduced-motion` honored (section 4.6).
- **Zoom/min size**: layout supports 1024x680 with the sidebar collapsed and the side panel collapsible; text uses px tokens but scales with Electron zoom (`Ctrl +/-`).

## 9. Brand usage

Source of truth: `src/renderer/src/assets/brand/`, with `scripts/make-icon.mjs` and `build/icon.png` kept visually identical to the mark. Assets are not created in this phase; plan Brief 0 produces them from the geometry below.

| Asset | Description | Use |
| --- | --- | --- |
| `mark.svg` (tile) | Rounded square `#0b0d12`, corner radius 22% of width, containing the org-chart glyph: one node feeding two child nodes joined by rounded connector lines, in a violet `#7c5cff` to blue `#2bb0ff` gradient (the exact glyph in `build/icon.png`). | App icon, sidebar header at 24-28 px, About page, favicon, empty-state mark. Works on dark and light backgrounds because it carries its own tile. |
| `mark-glyph.svg` | Same glyph, `currentColor`, no tile. | Monochrome contexts (tray, loading, watermarks, empty-state 48 px at 40% opacity). |
| `wordmark.svg` | `OrgAI` set in a geometric sans (Inter 600, tracking -0.01em), converted to outlines, `fill="currentColor"`. | Always paired with the mark in the sidebar; alone in About/splash. Never recolored with the accent. |
| `lockup.svg` | Mark tile left, wordmark right, vertical center-aligned, gap 0.4x mark height. Vertical variant for splash. | Sidebar header (collapsed state shows only the mark), docs, installer artwork. |

Rules:
- Clear space on all sides = 0.5x mark height. Minimum mark 16 px, minimum lockup width 96 px.
- The gradient belongs to the mark only and is fixed (`--brand-from/--brand-to`); it does not follow the user's accent, because brand recognition must not change with a preference.
- Wordmark and glyph use `currentColor`, so they flip with the theme; an `<img>` cannot inherit `currentColor`, so render them as a CSS mask: a `<span>` with `background: currentColor; mask: url(<imported wordmark.svg>) center / contain no-repeat`. The gradient tile (`mark.svg`) is a plain `<img>`. Components import the SVGs from `assets/brand/`; no inlined copies (architecture rule).
- Accent is a UI color, not a brand color. Allowed uses: primary buttons, focus ring, selected tab/nav indicator, links, switch/checkbox on state, selected node outline, progress bars below 80%. Not allowed: status, role identity, charts of different series.
- Splash and first paint: `index.html` sets `<meta name="color-scheme">` and an inline background so the window never flashes the wrong theme; the main process uses the persisted theme for `BrowserWindow.backgroundColor` (replaces the hard-coded `#0b0d12`).
- Empty states may show the monochrome glyph at 48 px; no illustrations in this phase.

## 10. e2e selectors likely to move

Current selectors and what happens. `plan.md` Brief E0 introduces `e2e/selectors.mjs` and `data-testid` hooks so later changes are one-line; the contract below is what new markup must provide.

| Current selector (file) | Fate | Replacement contract |
| --- | --- | --- |
| `.sidebar .nav-item` with text (`lib.mjs:212,252`) | classes change | `[data-testid="nav-projects"]`, `[data-testid="nav-project-<id>"]` (or `nav-project` with `data-name`) |
| `.sidebar-footer .pill` (`layout.mjs:18`) | removed; becomes Account card | `[data-testid="account-card"]` |
| `.topbar .tabs` + `Live` / `Org chart & settings` (`layout.mjs:27`) | tabs renamed and re-rendered by Radix | `getByRole('tab', { name: 'Run' | 'Org chart' | 'History' | 'Settings' })` |
| `.topbar .pill` path (`layout.mjs:32`) | path pill removed | `[data-testid="project-path"]` |
| `.topbar .pill .dot` status text (`lib.mjs:338`) | status badge | `[data-testid="run-status"]` with text |
| `form.card`, `.tabs` kind buttons, placeholders (`lib.mjs:223-238`) | form moves to a dialog; placeholders may change | `getByRole('dialog', { name: 'New project' })`, fields by label; `getByRole('radio', { name: 'New idea' })` |
| `.project-card`, `Delete` button (`lib.mjs:260-265`) | card remains; delete moves into `⋯` menu and ConfirmDialog | `[data-testid="project-card"]`, menu item `Delete project…`, dialog button `Delete project` |
| `page.on('dialog')` for `confirm()` (all scripts) | native dialogs replaced by Radix AlertDialog | `getByRole('alertdialog')` then `getByRole('button', { name: <confirm label> })`; the scripts' dialog-accept handlers become clicks |
| `.editor` (`layout.mjs:24`) | wrapper class may change | `[data-testid="org-chart-view"]` |
| `.empty h2`, `.composer textarea` (`layout.mjs:35-37`) | empty state and composer re-skinned | `[data-testid="run-empty"]`, `getByRole('textbox', { name: 'Message' })` |
| `.proposal`, `.proposal-head strong`, `Approve` / `Request changes` / `Send feedback` (`lib.mjs:304-318`) | proposals move to a sheet | `[data-testid="decision-card"][data-kind="proposal"]`, `.title` via `data-testid="decision-title"`; button names stay |
| `.agent-node .activity` (`lib.mjs:327`) | node markup restyled | `[data-testid="agent-node"]` with `[data-testid="agent-activity"]` |
| `.transcript .entry.text` (`lib.mjs:331`) | transcript markup changes | `[data-testid="transcript-entry"][data-kind="text"]` |
| `End session` button (`lib.mjs:270`) | stays a button, location changes | `getByRole('button', { name: 'End session' })` (unchanged) |
| `.editor .tabs, .tabs` + `Project settings` (`maintenance.mjs:65`) | sub-tab removed; `Settings` is a project tab | `getByRole('tab', { name: 'Settings' })`, then the `Repository and parallel work` section via `[data-testid="settings-section-repository"]` |
| `.maint-row`, `Merge into main checkout`, `Discard` (`maintenance.mjs:46-99`) | restyled list rows; labels kept | `[data-testid="branch-row"]` (with `data-branch`); keep the button names `Merge into main checkout`, `Discard` |
| notice via `.side-section-title` `Maintenance` > `.draft-box` (`maintenance.mjs:48`) | notice becomes a Banner | `[data-testid="maintenance-notice"]` |
| `Remove OrgAI files from repository` button (`maintenance.mjs:93,105`) | moves to Danger zone, opens AlertDialog | same name; confirm button `Remove files` |

Naming of buttons whose accessible names are relied on (`End session`, `Approve`, `Request changes`, `Send feedback`, `Merge into main checkout`, `Discard`, `Create project`, `Create and start setup`) is kept verbatim to limit churn.

## 11. Decisions needed from the user

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Adopt Radix primitives (`radix-ui`) and `lucide-react`, and amend `ARCHITECTURE.md` "no CSS framework" to "plain CSS tokens + unstyled Radix primitives". | Yes. |
| D2 | Add `sonner` for toasts. | Yes (small); otherwise inline banners only. |
| D3 | Rename tabs: `Live` to `Run`; split `Org chart & settings` into `Org chart`, `History`, `Settings`. Moves run history out of the transcript panel. | Yes. |
| D4 | Proposals, questions and merge reviews open in a right-side sheet instead of floating over the canvas (permissions stay in a compact tray). | Yes. Alternative: keep floating cards but dock them as a column that pushes the canvas. |
| D5 | Bundle Inter and JetBrains Mono. | Yes for cross-platform consistency (~100 kB); otherwise system stack. |
| D6 | Default edge style: keep curved (current look) or switch to orthogonal. | Keep curved as default; orthogonal is an option. |
| D7 | Custom title bar (`titleBarStyle: 'hidden'` + `titleBarOverlay`) to merge window chrome with the app. | Not in this phase; revisit after the rebrand. |
| D8 | Working state color: blue (`--info`) instead of the accent, so accent choice cannot collide with state. | Yes. |
| D9 | Ship `reduceMotion` and canvas `minimap` as settings. | Yes; both are cheap. |
| D10 | Do not ship a density setting (comfortable only) in v1. | Agree. |
| D11 | Remove the sidebar notifications checkbox and `Logs` button; move to Settings. Remove the `notifications.setEnabled` IPC call from the renderer (main keeps the channel for now). | Yes; also fixes the dead-setting bug (H3). |
| D12 | Create the brand SVGs in this overhaul (Brief 0) and regenerate `build/icon.png` from them, or only add SVGs that match the existing icon. | Add SVGs matching the existing icon; regenerate only if the glyph is refined. |
