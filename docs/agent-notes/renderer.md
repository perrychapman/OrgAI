# Renderer (general)

## Native popover rapid reopen (2026-11-10)

Chromium can coalesce a native close/reopen into one `toggle` from open to open.
The model-switch failure was captured with real Electron beforetoggle/toggle and
focus tracing at the empty-catalog Escape/Enter checkpoint; React's unchanged
open state left focus on the trigger. `Popover` now notifies closes synchronously
from `beforetoggle` and reruns placement/focus for each delivered open event using
an opening revision. Native listeners stay installed across consumer renders.
`LiveModelSwitch` also reloads the fresh catalog on every open callback. Its close
epoch still cancels ordinary dismissals and exempts deliberate confirmation.
Motion, exit retention, CSS and native light dismiss are unchanged. The strengthened
model-switch e2e forces coalescing in a single browser task across themes, sizes
and reduced motion, and checks a dismissed pending read cannot switch a model.
Typecheck, build, 48 focused picker/motion/token tests, strengthened model-switch
e2e with normal and fresh-empty Claude configuration, and motion e2e passed.
Reviewer approved the concrete patch after inspecting all 22 shared uses across
18 consumers; no actionable findings or Critical/High blockers remained.
Focused UX follow-up reran the mock model-switch matrix and inspected picker
screenshots; it did not complete a first-time keyboard walkthrough. Canvas radio
entry/reopen, Usage Projects-to-Kinds light dismissal and Add Service custom-dialog
focus handoff remain root QA checks, not locally verified claims.
Live providers, screen-reader speech, zoom and cross-platform behavior are unverified.

## Unified proxy setup (2026-11-10)

`AddProxyDialog` has one setup without a Kind selector. New records use
`openai-compatible` with `litellmFeatures: false`; `proxy-litellm-features` is the
optional native **Use LiteLLM reporting** checkbox in both Add and edit. Its hint
explains that the key is sent to reporting endpoints and figures may be unavailable.
`ProxyCard` derives the saved choice from `litellmFeatures ?? (kind === 'litellm')`,
saves the flag independently, and preserves id, kind and credentials. Base and
OpenAI endpoint defaults and origin-change key removal retain their existing
contract. Labels distinguish Proxy base URL, OpenAI base URL and the model-list
endpoint. Invalid submits focus the first invalid field. Proxy badges say Proxy;
Model prices uses actual check results, and usage visibility uses the reporting
capability with legacy fallback rather than kind alone. No motion was added.

Before-walk: a live root mock build showed the forced LiteLLM default promising
prices/spend before a test returned neither. Adding a mock proxy listed nine
mixed-family models, focused its heading and exposed the existing encrypted key
controls. Partial keyboard checks confirmed Name autofocus and Escape restoring
Add proxy. Only light at approximately 1024x615 and dark at approximately 1600x960
were viewed before implementation; those are not the full supported-size matrix.

Source verification: 45 focused tests passed across proxyForm, proxyChecks,
connectionLabel and usage; changed connections/multi-provider e2e scripts passed
syntax checks, and diff whitespace checks passed. Reviewer-2 approved all eleven
changed source/test files and the final label/legacy edit additions with no
actionable findings or Critical/High blockers. The e2e additions cover generic
default off, keyboard opt-in, and editing a legacy proxy while retaining id/kind/key.
Combined typecheck/build passed on root `ae8cde39`. The postwalk checked 1024x640
and 1600x1000 in dark/light: the dialog fits without overflow, the reporting
checkbox works by keyboard, invalid submission focuses the field, an opt-in mock
proxy adds nine models, and legacy id/kind/key/reporting survive edits.
Connections, multi-provider, project-connection and usage e2e passed against that
build normally and with fresh empty `CLAUDE_CONFIG_DIR`. Wrong-key handling and a
transient dialog observation after rapid driver input still need targeted QA;
the latter is not a confirmed defect. The final adapter integration gate remains
the orchestrator's responsibility. No live provider, paid test, screen-reader
speech, full keyboard-only task, zoom/reflow or measured performance claim was verified.

Shell, layout, primitives, motion, canvas (fold, themes), run view and run chains, dashboard, settings pages, application menu, cost UI, proxy and multi-provider UI, proposal cards, org change sessions. Moved out of CLAUDE.md on 2026-11-07; see CLAUDE.md for the index.

- Pocket Office (rework 2026-11-10, spec `docs/design/pocket-office.md` "Living office rework" and its implementation notes): the Canvas style popover and Settings Canvas section pick Graph/Pocket Office and Color (default)/Neutral/Green; presentation changes keep every graph preference, and the Settings sample is one inert framed picture. Team and Live draw one building per team and no floors: a lobby for the root agents, a corridor and themed department rooms (at most eight desks each, stable slots, labels `{Department} · {n}`), with the roster optional and every person a native 24 px button aligned with the sprite. Live adds one clock (`useOfficeClock`) that drives cues (typing, waving, glance, arriving, cheering, slumping, walking) from run state, at most twelve animated people; reduced motion or the Pause motion button (`aria-disabled` under Reduce motion, visibly pressed otherwise) stops it with no replay, and so does hiding the window. Messages (`useOfficeDeliveries`, `lib/office/scheduler.ts`) show a talk mark at the sender, a distance-based walk, a bubble at the recipient for a readable time and a 48 px strip log of the last three messages with `Show {To}`; the log holds still while focus is inside the strip and catches up when it leaves. A person with a live bubble or Needs-you mark outside the stage gets a chip in the controls row (`OfficeOffscreen`) that pans to them and hands them keyboard focus without changing the stage height. The camera (`useOfficeCamera`, `lib/office/camera.ts`) has zoom steps ½, 1, 2, 3, 4 (announced once as `Zoom 300%`), Fit, arrow-key pan, `+`/`-` that keep the focused person in view, `0` and Home, drag, and Find/Show with a ring and one `Showing {name}, {room}` line (the frame announcer joins lines said within a second of each other). Code: `components/canvas/office/*` and `lib/office/*` (pure rules, unit tested beside them). Checked by the `lib/office` unit tests, `npm run build`, `e2e/office.mjs` (runs `e2e/pocket-office.mjs`, also imported by `e2e/canvas.mjs`) on the mock adapter at 1024x640 and 1600x1000 in both themes and three palettes, and the spec's mock walk; screen-reader speech, a really minimised window, macOS and Linux, and a failed non-root agent in a live run are unverified.

The UI overhaul landed on native elements with container queries. Radix and react-resizable-panels are not installed,
and the frontend-design skill is not vendored in `.claude/skills` (only `run-desktop` is there).
- Primitives: `components/ui` (`ConfirmDialog` + `useConfirm` instead of `confirm()`, `Input`, `Textarea`, `Checkbox`,
  `Select`, `SettingRow` and the earlier ones). `IconButton` requires `label`, and `Button` takes `ariaLabel`.
- Shell: sidebar is `BrandLockup` + nav + project list + one 52 px account row (Popover with plan windows) and the gear
  "App settings"; below 1180 px or with Ctrl/Cmd+B it is a 56 px rail (`lib/useSidebarCollapsed.ts`). The topbar is 48 px:
  name, folder name only (`lib/paths.ts`), underline `Tabs` named "Project sections". e2e helpers: `projectTab`,
  `openAppSettings`, `openProject` (via `[data-testid=nav-project][data-name]`); the account row is `[data-testid=auth-pill]`,
  the folder `[data-testid=project-folder]`, run status is read from `.run-tab[aria-selected=true]`.
- Layout: `components/layout` (`CanvasFrame` with `FrameToolbar` / `FrameStage` / `FrameTray` / `FrameFooter`,
  `SidePanel`, `SaveIndicator`). Nothing floats over the canvas: decision cards sit in `FrameTray` on the
  `components/DecisionCard.tsx` shell.
- Run view: one 40 px run strip (`[data-testid=run-strip]`: run tabs plus Interrupt / End session / Org retrospective), then a 32 px canvas toolbar
  (`[data-testid=run-meta]` metadata, Hide finished switch, zoom IconButtons, the legend popover). The tray stacks under the canvas and docks
  beside it only in a frame of 1500 x 560 or more; `section.frame-tray[data-compact=true]` marks a frame under 480 px high.
- Run view without the side panel (assistant sessions 2026-11-11, every run kind 2026-11-12): `lib/assistants.ts`
  `hasRunSidePanel(layout)` is true only for the canvas layout (Pocket Office included) and false in the conversation
  layout for every run kind (Chat, Chat saved as a project, MCP / Skill assistant, Ask, setup, Team assistant / org
  change, team work runs shown as a conversation or opened as one by the ended-narrow rule; `isAssistantSession` is
  gone). LiveRunView then renders no `SidePanel`, marks `.run-body[data-side-panel=none]`
  (one grid column) and wraps the conversation in `components/RunDetailTabs.tsx` `RunStageTabs` (`run-stage-tabs`,
  first tab `run-tab-conversation`). The run detail tabs have one implementation: `lib/runTabs.ts` (pure:
  `showsPlanTab`, `showsOutputsTab`, `showsKnowledgeTab`, `runTabIds`, `resolveRunTab`) and `RunDetailTabs.tsx`
  (`useRunTabs`, `RunTabBody`, `PlanView`), used by both TranscriptPanel (side panel) and the stage strip; the tab test
  ids (`side-tab-plan`, `-usage`, `-logs`, ...) are shared. Selection stays `sideTabByRun`; the conversation stays
  mounted (hidden) under other tabs; a send resets the tab to Conversation. Every run on the canvas keeps the panel;
  Outputs and Knowledge appear in the strip by `showsOutputsTab` / `showsKnowledgeTab` (work runs of stored projects,
  engagements for Knowledge; their bodies work at stage width because `RunOutputs` falls back to its list/detail mode
  without a `.side-panel` ancestor). The strip's Plan tab needs a plan for every kind
  (`showsPlanTab` `stage`; the side panel still gives every work run one, with its "No plan yet" note, which is the only
  thing a work run in the conversation layout does not get; the steps chip and the blocked-plan banner need a plan
  anyway). A selected sub-agent's transcript and the agent meta/staffing lines belong to the canvas panel only. Checked by
  `lib/assistants.test.ts`, `e2e/assistants.mjs` (team work run both layouts), `e2e/engagement2.mjs` (Ask run), `layout.mjs`,
  `usage-app.mjs`; mock adapter only; `RunStageTabs` marks Conversation
  (`Tabs` `dot`/`dotLabel`, "Conversation, new reply") when a reply or "your turn" lands under another tab and calls
  `onReply` (LiveRunView's `setArrival`, the CanvasFrame announcer); Show thinking is a strip control held by LiveRunView
  (`TranscriptPanel` `showThinking` prop, not a store key: it never was one). Usage tab: By agent rows come from
  `agent.upsert` immediately while `summary.usage` (Cost card, run meta) is throttled up to `USAGE_THROTTLE_MS` (1 s,
  `runManager.ts` `refreshUsage`), so the two can differ briefly after a turn; the mock e2e shows them equal after 2.5 s.
  Checked by `lib/assistants.test.ts`,
  `lib/runTabs.test.ts` and `e2e/assistants.mjs` (`checkStageTabs`); design notes and open items in
  `docs/design/assistants-ui.md`.
- Resizable columns share one width budget (on the run view only while the canvas shows, since the conversation layout has no panel; `lib/panelWidth.ts` `panelBudget`): the canvas keeps 280 px (`CANVAS_MIN_PX`); when the side panel minimum (280 px) does not fit it shows as its rail (saved width and choice kept, re-applied when space returns). `SidePanel` `autoCollapseBelow` reacts to first layout and window resizes only, never to handle drags. Resize handles: Enter or double-click resets, arrows move the splitter.
- Resizable columns: `components/layout/ResizeHandle` is a `role=separator` (vertical, `aria-valuenow/min/max`, focusable) inside the column it resizes, on the edge facing the neighbour, so it never overlaps the canvas. It supports captured pointer drag, Left/Right (16 px, Shift 64 px), Home/End and double-click to reset; `lib/panelWidth.ts` holds the pure clamp/drag/key helpers (tested) and `usePersistedWidth`. Sidebar: 200-420 px (default 232), localStorage `orgai.sidebarW`, App sets `--sidebar-w` on `.app` and the main area keeps at least 480 px; shown only in the full sidebar, not in the rail (the chosen width survives collapse/expand). Right `SidePanel`: 280 px up to whatever leaves the canvas 280 px (no fixed maximum), localStorage `orgai.sidePanelW.<persistKey|default>`, drives `--side-panel-w` on the parent grid (`.editor`, `.run-body`; unset means the CSS default 360 px / clamp(280px, 28cqi, 400px)) and the canvas keeps at least 280 px; hidden while the panel is collapsed. Dragging below the minimum does not snap to the rail. From a measured panel width of 480 px `SidePanel` sets `data-side-wide` on the parent; `.run-body[data-side-wide]` then moves the same `.composer` element (no remount) into the panel column under the transcript. The run frame docks its tray beside the stage only when the tray has content (`.frame-tray:not(:empty)`), else an empty tray column left a blank strip beside the canvas. The account popover's `UsageMeter` has no Refresh button or Updated text: it calls `refreshUsage()` on open when data is older than 60 s, then every 60 s while open (one call in flight, at most one attempt per minute even on failure). A non-current connection gets a section only while it is in use (`connectionInUse` via `lib/usage.ts` `connectionsInUse`) and has a report (`connectionOrder`); stale reports of unused connections neither show nor force a refresh.
- Wide panel: `SidePanel` sets `data-side-wide` on its parent grid at panel width >= `PANEL_WIDE_PX` (480) and clears it below `PANEL_NARROW_PX` (448, hysteresis via `nextWide`). The Live view's canvas refit skips a resize caused by that layout switch. The composer is a container (`composer`) and drops its hint under 560 px; transcript text/user/thinking entries cap at 90ch.
- Dev builds: a package.json version with a `dev` prerelease tag (`0.1.6-dev1`; `lib/buildChannel.ts` `isDevBuild`) shows a quiet info "Dev" Badge beside the wordmark (a "D" pip on the mark in the 56 px rail), `[data-testid=dev-build-badge]`, labelled "Dev build <version>", plus a "Dev build" badge by the version in App settings > About. e2e/layout.mjs expects it whenever package.json says `-dev`; drop the tag for a release. After a release, dev is bumped to `<next patch>-dev1` and the dev number counts up per dev build (`0.1.6-dev1`, `0.1.6-dev2`, ...) until the next release drops the tag.
- Status words come only from `lib/runStatus.ts`: Running, Needs you, Idle, Paused, Finished, Stopped, Failed. An ended run's word comes from the summary (`endedBy` 'user' = Stopped; 'app' or `endedWithApp` = Stopped shown as "Ended when OrgAI closed" through `statusText`, which every status text uses; `isStoppedRun` only for old records).
- "Needs you" counts decisions (cards), never runs: the bell, the Needs-you row, the project row badge and subtitle
  ("3 decisions · 1 run") and the topbar all come from `lib/needsYou.ts` `waitingItems` / `decisionCount`. A run row's dot
  is the run's status. A Needs-you item names the kind and the ask first, then the location, and opens that card.
  A question card shows its options inline at every size (`DecisionCard` `inline`); the tray shows the first open decision.
- Project tabs are Live, History, Team and Settings. The org chart editor is `views/TeamView.tsx`, and project
  settings are sectioned through `components/settings/*`.
- Motion (spec `docs/design/motion.md`, section 7 is what landed): tokens in `styles/tokens.css` (`--dur-instant/fast/base/slow/fade/pulse`, `--ease-out/in/in-out/spring`, `--motion-distance(-sm)`, `--motion-scale-from`, `--motion-stagger`; ~0 under both reduced-motion switches, and global.css forces 0.01 ms incl. `::backdrop` / `::details-content`), recipes in `styles/motion.css` (`.motion-enter`, `.motion-view`, `.motion-pop`, `.motion-ring`, `[data-ping]`, `.motion-collapse[data-collapsed]`, native `details` content fades in on open with its layout final at once and closes instantly, never a height glide, since e2e reads and measures right after a click; `.motion-none` opts out), hooks `lib/useArrival.ts` (entry only for arrivals, never first paint / relaunch / scope switch), `lib/useExitPresence.ts` (`exitProps`: retained leaving nodes are inert + aria-hidden; focus is moved or dropped in the same tick, never left inside), `lib/layoutMotion.ts` (`<html data-layout-moving>` defers canvas refits, `data-columns-moving` lets side panel columns glide), `lib/useBellCue.ts`, `lib/transcriptFollow.ts`, canvas `useNodeArrival` / `beginCanvasGlide` (`.react-flow[data-canvas-gliding]`, up to 60 nodes) / `fitMs` / `refitMs` / `reducedMotionNow` in `lib/canvas.ts`. Dialogs and popovers fade and scale in and fade out (content kept for `--dur-fast`), tab indicators slide, sidebar and side panel Hide / Show glide, tray cards rise with a one-shot ring, the bell pings when decisions rise (5 s throttle), canvas nodes pop in and glide on auto-layout, every live cue breathes at `--dur-pulse` (canvas cap 12). e2e `e2e/motion.mjs` (in e2e:free) checks running transitions with motion on, ~0 ms with Reduce motion on, inert leaving dialogs, quick open/close cycles and the breathe cap; `setReduceMotion` / `motionOff` in e2e/lib.mjs; a test that reopens a dialog right after closing it waits for `[open]`, not "visible". Open: `BannerPresence` (ui/Banner.tsx) has no callers, band and New project heights snap, radio dots, side panel glide only for the Hide / Show buttons; screen reader output and macOS not checked.
- Run chains (spec 2.5 "Finished run", `docs/design/ux-review-continue.md`): a run and its continuations are one conversation. One tab per chain (`.run-tab-wrap[data-chain]` = oldest member id, `data-run` = newest), title and tag from the first member, status from the newest; openRun always shows the newest member (sends, Interrupt, End session go there) and `loadChain` fetches earlier records lazily (newest 10 members, 4 fetches at a time, older ones behind `chain-load-earlier`; the merged feed caps at 5000 items behind a `chain-omitted` row; the composer draft is keyed by chain). The feed merges every member oldest first with a `chain-divider` row per continuation ("Continued 3 min later" / "Continued after OrgAI closed"; the adapters' "Continued from run" row is hidden); earlier members' agents fold into "Earlier: N agents" groups; the root sums tokens and cost. An ended continuable run's composer continues by default (`endedComposerCopy`: "Session ended ... Send to continue with its memory.", primary Send, `composer-cut-notice` when OrgAI closed, `go-to-latest` on an older member); New run is the "+" tab / Ctrl+T only. Under 1100 px an ended continuable work run opens in the conversation layout. History is one row per chain (`N sessions` badge, `history-sessions-toggle` member rows, summed cost). Open chain tabs are restored per project on relaunch (`lib/openTabs.ts`); focus stays in the composer after a continue and End session. e2e: `e2e/runs.mjs` (continue in the same tab, divider, relaunch "Ended when OrgAI closed"; `relaunch()` in e2e/lib.mjs). Not done: the Usage tab "Whole conversation" switch; earlier groups sit under the root, not above.
- Canvas fold: Hide finished agents (`lib/foldFinished.ts`, pure, unit-tested): an agent folds when it has a parent, is settled (done or failed, worktree settled, 6 s grace; a done agent with no `endedAt` settles at once) and nothing under it is live; a hidden agent's whole subtree joins the group of its nearest visible ancestor, so a finished subtree is one `done-group` under the agent still shown above it (never a parentless group; earlier-session groups hang under the root). Counts, failed, unmerged and cost cover the subtree; the tooltip names direct reports first. `expandedGroups` is keyed by the group's key (that visible ancestor's id, or an earlier-session key): expanding shows the direct reports, whose own finished reports fold into one group per report; turning the switch off and on again folds everything back. The side panel `FinishedList` lists the whole subtree, newest first, with an "under <name>" line for members that are not direct reports. The grace is timed by one `setTimeout` for the next settle moment (`nextSettleAt` / `settleTimerDelay`, 250 ms floor, keyed only on that moment, never on the agents array), so reports fold while the run is still Running. Agents are named by `lib/agentTree.ts` `agentLabel` (handle first, as the canvas node shows it, else the role name; a handle with hidden or control characters falls back to the role name, longer than 64 chars is cut) in the group tooltip, the expand button label, the "Showing N agents under X" announcement and `FinishedList` (role name as a caption beside the handle). A report group's expansion stores its time: reports finished by then stay shown, ones that finish later fold again. UX walk: `docs/design/ux-review-fold.md` (d6e57b6); H1 (no fold while events stream), H2 (role names instead of handles) and M1 (sticky expansion) are fixed, unit-tested only (no app or e2e run); open: M2 (unreadable fit after a large expand), M3 (Enter/Space now select a focused node, fixed with canvas themes phase B; focus ring checked only by eye), M4 (cascading folds and re-fits), L1-L5, focus is lost when a focused node folds, and a report whose worktree settles after an expansion stays shown. The node carries `data-testid=done-group` and `data-count`. e2e/runs.mjs drives it with the mock marker `[mock:deep-tree]` (work runs, default script): root -> `mock-lead` -> `mock-lead-report-1` / `-2`, all reports finish; the run goes idle and finishes on End session. Checks: one "3 done" group under the root, expand to `mock-lead` plus a "2 done" group with an edge, fold back, both themes at 1024x640 and 1600x1000.
- Canvas themes, phase A (spec `docs/design/canvas-themes.md`, walk `ux-review-canvas-themes.md`; ARCHITECTURE.md
  "Canvas"): App settings > General > Canvas (`components/settings/CanvasSection.tsx`, right after Appearance, outside
  Advanced, whose group is now "Motion"; `APP_SETTINGS_SECTIONS.canvas`, the deep link focuses the checked style) has a
  live sample (`canvas-preview`, inert, `lib/canvasSample.ts`), the style gallery (`canvas-preset[data-preset]`, a
  one-stop radiogroup, Custom only when no available preset matches) and a Customise disclosure (`canvas-customise`,
  localStorage `orgai.canvasCustomise`; `canvas-backdrop-select`, wrappers `canvas-layout` / `canvas-edges` /
  `canvas-node-style` around native radios, switches `canvas-tint` / `canvas-minimap`), announced through
  `canvas-announce`. The Live and Team toolbars have `canvas-style-button` (popover `canvas-style-popover`, picks apply
  at once through `lib/canvasSettings.ts` `saveCanvas` and speak through the frame's `tray-announce`; `canvas-style-more`
  opens the section). `lib/theme.ts` writes `data-canvas-{pattern,edges,layout,node-style,tint,minimap}` on `<html>`;
  canvases read only `lib/canvas.ts` `useCanvasOptions()`. Each canvas draws `components/canvas/CanvasBackdrop`
  (`canvas-backdrop[data-pattern]`, 9 patterns, `circle.canvas-ring` guides in radial on Live and the sample,
  `div.canvas-scanlines` on Terminal), `CanvasMinimap` (bottom-left, `minimapSize` from the stage, one shape per node
  through `useNodeDims`), `.react-flow[data-layout]`, `layoutCanvas` (dagre TB / LR or `radialLayout`; the Team editor
  uses it for Auto-layout only) and `RadialEdge`; nodes carry `data-style` (card or compact 160 x 40 pills, detail in
  the tooltip) and call `useHandleRefresh` so edges follow a layout switch. Edges are `edgeStroke` mixes; messages are
  dotted `.msg-edge` in `--edge-message`. The legend has eight entries (Working, Needs you, Finished, Failed, Selected,
  Folded finished agents, Reporting line, Message between agents). e2e `e2e/canvas.mjs` (in e2e:free; mock, 1024x640
  and 1600x1000, both themes): the section and gallery keyboard, Customise, every backdrop on Live, Terminal in light,
  the three layouts on `[mock:deep-tree]` (and edges leaving the right side in left to right), compact sizes, the
  minimap count and size and that neither popover lands on it, reduced motion, the popover's focus return and deep
  link (`windowShift`), and the Team editor following backdrop, lines, minimap, name tags and Auto-layout. Unverified:
  message-edge styling and the Starfield glow (the mock sends no agent messages), contrast ratios (computed by hand in
  the spec, not measured), custom accents and role colours, System theme, large runs, ring guides in the Team editor
  (none drawn: its positions are the user's).
  - Phase B (spec sections 4b, 4c, 11): node styles `station` (subway map: a 32 px circle in `--role-ink`, the role
    colour through the edge mix, name pill `.station-name` beside it top down and below it otherwise per
    `stationGeometry`, the root an interchange, handles on the circle; 6 px lines in the lead's colour through
    `reportingLineRole`, no arrows, never dashed, smoothstep radius 12; a folded group is a `.station-terminus` bar) and
    `hex` (120 x 104 flat-top `.hex-tile` / `.hex-fill`, radial packs a honeycomb through `honeycombSnap` with no ring
    guides, radial edges clip at the hexagon or circle through `canvasShapes.ts` `exitPoint`). Subway and Hive show in
    the gallery and popover; "Agents as" offers Cards, Name tags, Stations, Honeycomb; the legend swaps its Finished,
    Folded and Reporting line shapes per style. A "Default" gallery entry (`data-preset=default`, renderer-only,
    `shownStyle`) is checked on the DEFAULT_APPEARANCE canvas, so a fresh profile no longer reads Custom.
  - Re-walk fixes (`ux-review-canvas-themes-2.md`): non-card nodes show `agentLabel` (handle first, middle-clipped
    through `splitLabelTail`), the role name is the tooltip caption; Enter / Space on a focused Live node selects it
    (React Flow 'select' changes in onNodesChange; the group chevron stops the key); message edges use the side
    handles facing each other (`messageSides`, ids `msg-out-<side>` / `msg-in-<side>`); selection wins over state
    colours and adds a shape cue (a 4 px leading bar on cards, a 3 px border on name tags) so it never reads as focus;
    radial cards fit no lower than zoom 0.7 (`canvasFit.ts`); the settings preview is sticky in the one-column layout
    with `scroll-padding-top` on the scroller.
  - e2e/canvas.mjs adds: Subway and Hive from the gallery, station lines from mock-lead share edgeStroke of its role
    colour (6 px, no marker), a station terminus, hex tiles 120 x 104 without overlap and without rings, no page scroll
    in both styles at both sizes and themes, Team role nodes in both styles, name tags showing distinct handles, Enter
    and Space selecting, Default checked on a fresh profile and after Blueprint, the sticky preview. Unverified:
    message edges in a live run (the mock sends no agent messages; side choice is unit-tested and seen in the settings
    sample), radial messages, contrast of `--role-ink` shapes (computed from the edge mix, not measured), hex and
    station at large runs, the Team editor selection cue by eye, System theme.
- Approved changes reach mounted surfaces through `project.updated` (store `handleEvent` replaces the project): `useProjectSkills`
  reloads when a value string of the project's skill ids and role grants changes (not references, so chart drags do not refetch;
  skipping the ones its own `apply()` pushed); saved rules refresh through the store's `rulesChangedByProject` counter
  (`lib/rulesChange.ts`, bumped on project-scope `rules.resolved` grants, `project.updated` and `permission.resolved` with
  `savedToProject`, the permission card's "Always allow for project") read by `PermissionRulesPanel`, which refreshes under a
  sequence guard; the MCP list already reloaded on `project.mcpServers`. Checked by unit tests of the helper and of
  RunManager.decide only; no e2e, not seen in the app.
- Proposal cards (`docs/design/proposal-cards.md`): an org chart card shows a changed role's new prompt ("Show new prompt") and an added role's prompt ("Show prompt") in an `org-diff-prompt` disclosure through `ClampText`/`showHidden` with the hidden-characters badge (review M3; e2e/proposals.mjs); card read errors speak through the frame's one `tray-announce` (`useFrameAnnounce` in `CanvasFrame`). Long proposals (fix 2026-11-07, proposal-cards.md section 12): a proposal body is always its own scroller (`overflow: auto` beside its cap in cards.css; the Team tab's Architect tray set `overflow: visible`, so a capped body ran on under the footer and never scrolled), and while it overflows `DecisionCard` gives it one Tab stop (`data-scrolls`, `role=group`, inset focus ring). e2e/proposals.mjs scenario 4 drives a 29-change org chart in the Live tray of a work run and of an org change session (the Team tab's Architect tray is gone, see Org change sessions) at both sizes and themes.
- Proposal cards (spec `docs/design/proposal-cards.md`, merged at e655838): `components/proposals/*` (`McpProposalBody`,
  `SkillsProposalBody`, `ClampText`, `useCurrent`), `lib/skillProposal.ts`, `lib/proposalSummary.ts`,
  `lib/hiddenChars.ts` (badges hidden characters; main is the gate, see Work-run configuration changes) and
  `styles/proposals.css`. The store keeps `proposalOutcomes` from `proposal.resolved`. Selectors: `proposal-decline`,
  `proposal-decline-note`, `proposal-decline-send`, `proposal-effect`, `mcp-proposal-secret[data-secret]`,
  `mcp-proposal-server[data-change]`, `mcp-proposal-removal`, `proposal-skill-item[data-action]`,
  `proposal-next-secrets`, `tray-announce` and `article.decision-card[data-focus-details]`. At 1024x640 the compact
  frame gives the card the stage; the frame stays compact until 544 px high (`COMPACT_FRAME_HEIGHT` 480 plus
  `COMPACT_EXIT_MARGIN` 64). e2e: `e2e/proposals.mjs` (in e2e:free). Open Lows: switching tray cards drops typed
  secrets and the decline note; the mock has no secret-slot or toggle proposals; the skill link, grant and remove rows
  and the before/after view are not driven by e2e.
- Org change sessions (owner decision 2026-11-07, walk `docs/design/ux-review-org-change-session-pre.md` "Status after the change"): Team > Design "Revise with the Architect" (`org-change-start`) and Settings > Maintenance "Review the org chart and setup" (`maintenance-org-review`, on every project) start an ordinary setup run through one hook, `components/team/useOrgChange.ts` (`startSetup(orgChangePrompt(text, kind))`, focus to the composer, run-tabs notice "Org change session started..."); while one is open both send into it / open it instead (button "Send to the open session"), so two Architects never revise one chart. It has a run tab, a sidebar row (`nav-run[data-kind=org-change]` with `nav-run-kind-mark`), History (`run-kind[data-kind=org-change]` "Org change", under the Setup filter), Dashboard and Needs-you rows, and restores after a relaunch like any run. The renderer no longer starts or hides `surface: 'team'` runs (`lib/runSurface.ts`, `ArchitectDecisions`, `designRun` / `designJump` are gone; main still accepts the field, old records list and get R numbers). `lib/orgChange.ts` (pure, tested) holds the prompt contract (`ORG_CHANGE_PREFIX`, `ORG_REVIEW_PROMPT[_ENGAGEMENT]`, legacy Maintenance prefix), `isOrgChangeRun` (kind 'setup' + prompt), `orgChangeTitle` / `displayRunName` ("Org chart: add a database specialist", "Org chart review"; used by run tabs, sidebar, History, RunLabel, Needs-you, Dashboard, NewRunPage, document title), `runKindWord`, `setupBannerShows` (the "Setup complete" / "Org change applied" banner never shows on a run cut off by a quit, and an org change needs an approval seen in that view; walk M2) and `liveOrgChangeRun`. The Team tray shows `org-change-pointer` / `org-change-open` above both modes while a session is live; RunMeta `run-meta-kind` reads "Org change session". `RunLabel` never prints "R?" (name only while unindexed). e2e `e2e/org-change.mjs` (in e2e:free; both sizes and themes, relaunch) and team.mjs `sectionDesignDecisions`. Open: the banner's approvals are view-local (gone after a remount or a decision in another window), other `runTag` callers can still print "R?" while history loads, no History "Org change" filter.
- Dashboard (pass 2, GitHub #36; spec `docs/design/dashboard-2.md`, which supersedes `dashboard.md` 2-5 and 7-9;
  pre-walk `ux-review-dashboard-3-pre.md`): `views/DashboardView.tsx` (store View id stays 'projects') is the page
  scroll; `.dashboard-grid` is the `dash` container; the work area `.dash-work` is one track in DOM order (needs, now,
  strip, setup, paused, ended) and from 880 px two tracks with the band spanning the right column. Fix-up after walk 3
  (e9c6fc54 plus the UI Lead's finish; spec section 21.1): instruments are boxed (Needs you rows, the only amber surface;
  Right now; Last 14 days), lists unboxed (To set up, Paused, Recently ended: gap 0 and a hairline; Needs you keeps
  `--space-2`; its rules are `styles/dashboard-needs.css`, imported after dashboard.css); tiles never tint, decisions
  included. Quiet states: with no decision Needs you stays mounted but `hidden` with no empty line and `.dash-work` gets
  `data-needs-empty`; with no open run the band is hidden and it gets `data-now-empty`; band live without a decision puts
  the band left and the strip and lists right; decisions without a band put Needs you beside the tall strip and the lists
  full width below; both quiet is the tall strip across, then the lists in a wrapping row (a lone list takes the whole
  row). The tall strip is 190 px; under 700 px of region (`useShortRegion`) a compact strip beside decisions draws
  `data-dense`. The band's height budget (`useBandBudget`: the other column + 180, at least 440, never reads the band;
  `fitBandModel` lowers agent rows to 2, then runs to 3) is `dash-now[data-budget]`. Two-track rows carry no row gap (areas below the
  first space themselves with a top margin), so an empty region leaves no hole. Caps narrow / wide (1280 px,
  `dashCaps.ts` through a ResizeObserver): Needs 3/5, band runs 3/5, agent rows 6/12 (4/6 per run), To set up 3/5,
  Paused / Recently ended 4/6, each with "Show N more". Regions: status bar `dashboard-hero` (`HeroBand.tsx`:
  `dash-status-line[data-working|open|paused]` from `lib/dashboard.ts` `statusSentence`, `dash-limits` / `dash-limit`
  hidden under the mock adapter and for API keys, `dashboard-app-facts`, the page's one polite region `dashboard-live`
  with the 1.5 s join; 36 px at 1024x640, 40 px at 1600x1000, at most 72); Needs you `dash-needs-you` (count = the bell;
  rows `dash-needs-row[data-kind][data-run][data-key][data-inline=allow|options|none]`, `NeedsInline.tsx`, pure
  `lib/needsInline.ts`); Right now `dash-now[data-working|waiting|idle]` (`RightNowBand.tsx` / `BandRun.tsx`, pure
  `lib/dashboardBand.ts` `bandModel`, snapshot recomputed at most every 250 ms in `useDashboardData.ts`
  `useBandSnapshot`; `dash-now-counts`, `dash-now-project[data-project]`, run header `dash-running-row[data-status]
  [data-needs]`, `dash-agent-row[data-state][data-agent][data-depth]`, `dash-agent-more`, `dash-agent-done[data-count]`,
  `dash-now-more`, `dash-now-empty`; working marks `.dash-mark[data-breathe]` breathe, off under both reduced-motion
  switches; Enter on an agent row opens Live with that node selected and focused, `lib/agentActivity.ts` shared with
  AgentNode); Last 14 days `dash-strip[data-size]` (`ActivityStrip.tsx`, pure `lib/activityStrip.ts` `dayLedger`, local
  days, 14 `dash-strip-day` buttons as one roving Tab stop, `dash-strip-readout`, totals `dash-strip-runs`, `dash-cost`
  (compact, unknown never $0), `dash-strip-waiting` only from 1 s); To set up `dash-setup` (`SetupGaps.tsx`, pure
  `lib/setupGaps.ts`; `dash-setup-row[data-kind]`, `dash-setup-action`; names and labels only, never a secret value;
  `connectionsNeeded`: mock-provider projects use no connection and under the mock adapter the default connection does
  not count, else a machine with no Claude login showed "Anthropic is not connected"); Paused `dash-paused` and
  Recently ended `dash-since` (`AttentionColumn.tsx`; a run the user ended in this window is left out, `dash-since-clear`
  "Clear", focus then goes to the next section heading); Projects `dash-projects` with `project-tile[data-name][data-id][data-state]` (`ProjectTile.tsx`: `tile-client`,
  `tile-team[data-count]` (decorative: root plus up to seven role marks breadth first, `tile-team-more` "+N" past eight;
  the Open button's name adds "team of N: A, B, C and M more"), `tile-run[data-status]` whose caption is "Needs you ·
  <decision line>", "Running · <plan step>" or the outcome alone (an ended tile's status line is "Last run <time> ago"
  without the outcome; never the root's raw activity), More as the li's last child so Tab goes Open, chips, More, `tile-chips` / `tile-chip[data-kind=branches|suggestions|folder-trust]`, `tile-folder`,
  `tile-cost` only when something was spent, menu `project-tile-new-run` / `-continue` / `-open-folder` (`app.openPath`
  on the project's own path only) / `-delete`). Inline answers: Allow once sends only `{ behavior: 'allow', scope: 'once' }`
  and Deny only the card's deny message (`decideIn` / `answerQuestionIn` in the store take the run id), never session or
  project scope, rules or the settings link, whatever `suggestions`, `maxScope` or `referenceFolder` say. Inline Allow is
  offered only when what it approves is shown whole on the row and in the buttons' names: a shell command (compound
  ones too: split on `&&` `||` `;` outside quotes, each step whole on its own line with its operator kept, unclamped) of
  at most 200 chars, 2 non-empty lines and 4 steps, with no hidden characters, no lone CR / LS / PS, no runs of spaces or
  tabs and no quoting the split cannot follow (backslash or backtick before a quote, typographic quotes, `$(`, backticks,
  an open quote); each refusal caption names its true reason; a file tool
  whose `permissionLocation` (the card's helper) is the project, a worktree, an allowed or a reference folder, with the
  full path (no line break in it) and the location line `dash-needs-where`; WebFetch / WebSearch with the URL or query (at most 200); never MCP,
  Agent or unknown tools. A question gets one-click options only for single choice, 2-4 options of at most 40 chars
  without descriptions. A sent answer locks the row (aria-disabled, focus kept) until its `*.resolved` event removes it;
  failures show `dash-needs-error`. Per-project signals: `useProjectSignals.ts` over `projectQueue.ts` (listWorktrees,
  seedTeamReview, `mcp.list`): at most 3 in flight, after first paint on mount only, never on a timer or run event, a
  session cache (team reviews once, worktrees and `mcp.list` again after 10 min), failures cached as null, a project
  deleted while queued is skipped. Checked by unit tests (needsInline, dashboardBand, activityStrip, setupGaps,
  dashboard, agentActivity, projectQueue, useProjectSignals, cost), e2e `e2e/dashboard.mjs` (mock: inline Allow once,
  no wider scope on the page, band rows and folding, data-needs, strip, no false chips, no To set up or Limits under the
  mock, reduced motion, both sizes and themes, relaunch Recently ended) and by eye on mock data (1024x640 rail and
  1600x1000, dark and light: deep-tree live, permission waiting, ended, paused, an engagement, empty band after a
  relaunch). Reviewer: three Highs in the inline Allow path (clamped command, file without location, MCP args unseen)
  fixed with M1-M3. Fix-up checks (UI Lead, 2026-11-07): typecheck, `npx vitest run src/renderer` (1180), build, and
  e2e dashboard / layout / engagement / team-files green; dashboard.mjs adds the tile captions (live, ended "Last run"),
  `tile-team` count 4 with no `tile-team-more` on a 4-role project and the "team of 4" name, no amber background on a
  `[data-state=decisions]` tile, More a direct child and Tab Open-chips-More, an empty Needs you `hidden` with no empty
  line, and a `[mock:fatigue]` compound `cd <worktree> && npm test` answered inline (two lines, whole command in both
  names, the following outside edit not inline). Seen by eye at both sizes and themes in states one decision + live deep
  tree, three decisions, relaunched, all quiet (measurements in spec 21.1). Final Reviewer (needsInline, NeedsInline,
  AttentionColumn, AttentionSection, band budget): no Critical or High, no layout thrash; M1 (lone CR / LS / PS), M2
  (escaped or typographic quotes, `$(`, backticks), L3 (line breaks in paths) and L6 (frozen decisions) fixed and
  unit-tested. Open: Reviewer L1 (single `&` / `|` are not step separators; shown whole on one line), L4 (Glob / Grep
  inline shows only the path, not the pattern), L5 (the pressed button's name does not say "Sending"); the band lists
  waiting runs newest first while Needs you lists oldest first; `data-budget` keeps a stale value while the band is
  hidden; no paused row was held on screen (the mock pause lasts 1.5 s; the clamp was checked by computed style);
  review L3 (focus when a section's last row leaves), L7 (`decideIn` takes any decision); not driven: real plan
  windows, proxy spend, chips, To set up rows, question options, `tile-team-more` past eight roles, a screen reader,
  macOS. Not built (need contracts): dashboard-2.md section 18.
- Cost and usage (#10): every cost goes through `lib/cost.ts` `costView` and `components/ui/Cost.tsx` (unknown is
  never $0, "$0.42+" is a lower bound). The run side panel has a Usage tab (`components/UsagePanel.tsx`, `SideTab`
  'usage'); History switches Runs | Trends (`components/UsageTrends.tsx`, `runs:usageStats`). App settings >
  Connections > Model prices is `components/settings/ModelPricesSection.tsx`; `lib/settingsTarget.ts`
  `requestModelPrice(model?)` deep-links to it with the model pre-filled. The account popover shows the quiet line
  `usage-no-five-hour` ("Five-hour window: not reported by your plan right now.", `UsageMeter.tsx` `missingFiveHour`)
  when a subscription report lists plan windows but no five-hour one (seen 2026-11-04 on a Max login: `five_hour:
  null` beside Seven-day and the Fable weekly window), and the sidebar footer bar shows the tightest reported window
  (`tightestWindow`); unit-tested in `components/usageMeter.test.ts`, not driven by e2e (the footer meter is hidden
  under the mock adapter).
  - LiteLLM spend by period (2026-11-04, walk + notes `docs/design/ux-review-litellm-periods.md`): the account row shows one figure from `lib/usage.ts` `spendRowLabel` ("LiteLLM · $3.20 today" with `UsageSpend.periods`, else the budget text); under about 244 px of sidebar `.sidebar-footer` (an inline-size container) hides the name to sr-only (`span.account-name`) so "$142.10 today" never clips, and the 4 px bar yields first; `title` and the rail name carry `spendSentence` ("LiteLLM spend: $3.20 today, $12.40 this week, $31.00 this month. $42.10 of $50.00 budget." / "... No budget set."). Bar and dot tone stay the budget level. The popover `SpendSection` adds a `dl` `spend-periods` (`spend-period[data-period=day|week|month][data-present]`, `spend-period-value`, `dt` title "Since <date> (UTC)" from `periodSince`; rows from `spendPeriodRows`), else `spend-periods-missing` showing the fixed `periodsNote`, then `spend-lifetime` ("Lifetime $X" from `lifetimeText`, only when `totalUsd` differs from `usd`), then the Stale line (`usage-stale`); the head figure is `spend-budget`. Dashboard Usage card: `spendRowFigure`, the bar, `dash-usage-periods` ("$12.40 this week · $31.00 this month"), empty text "No spend reported yet.". Helpers `periodText`, `spendRowLabel`, `spendRowFigure`, `spendSentence`, `periodsCaption`, `periodSince`, `lifetimeText`, `SPEND_PERIOD_LABEL`, `SPEND_PERIOD_ORDER` are unit-tested; the UI was hand-checked with a fake report through a throwaway hook (not in the repo) at both sizes and themes; never driven by e2e (the mock reports no LiteLLM spend) and never seen with a real proxy.
- Usage page (app-wide; spec `docs/design/usage-app.md`, contract ARCHITECTURE.md "App-wide usage overview"): store View 'usage' (not project-scoped), `usageFilters` / `setUsageFilters` (only period and bucket persist, localStorage `orgai.usage.v1`), `openUsage({ projectIds?, period?, day?, section? })`, `usageFocus`, `openUsageRun` (focusRun, side tab 'usage', `usageReturn`, so `SidePanel` `arrival` opens it at least 480 px wide under 1100 px for that visit, never saved). Entry points: sidebar `nav-usage` (rail too), View > Usage (`show-usage`, 'main', no accelerator, announces the scope), Dashboard `dash-strip-usage-link` (30 days; Enter on a strip day adds the Day chip), Trends `trends-see-all`, run Usage tab `run-usage-all`; atlas `usage`, `usage-efficiency`, `usage-runs` (`SURFACE_TARGETS` kind 'usage'). `lib/usageOverview.ts` (pure): periods, bucket rules, `overviewQuery` (period, kinds, projects only; limit 2000), `usageKindOf` (Chat wins over Ask), `needsClientFold` / `usageData` (server rollups unless a model, role, bucket, connection, no-price or Ask/Chat-within-work narrowing applies, then `foldRows` over the rows, `lowerBound` when truncated; a model chip shows the model's own cost and roles with unknown cost "Model cost per role is not recorded"), chips. `lib/usagePage.ts` (copy, deltas from a second query over the prior span, live refetch decisions), `lib/usageCharts.ts` (ticks, bucket fill, series, folding), `lib/usageEfficiency.ts` / `lib/usageRuns.ts`. Components `components/usage/*` on `panelProps.ts`; inline SVG only; `--chart-*` tokens in every theme block with measured ratios in tokens.css (`--chart-hatch` is `--surface-1`); every figure `Cost precision="page"` (`shared/view/cost.ts` `formatUsdPage`: 2 decimals from $1, 3 from $0.01, 4 above, "< $0.0001"; Dashboard and Trends not migrated yet). The run tab's old `.usage-panel` class is now `.run-usage-panel`. `scrollWithin` now honours the scroller's `scroll-padding-top`. Checked: unit tests for every lib above plus cost, appMenu, atlas, menuActions, scrollWithin, panelWidth; `e2e/usage-app.mjs` (in e2e:free; mock, two code projects, an engagement and a Chat with `[mock:no-price]` / `[mock:computed-cost]`, 1024x640 and 1600x1000, both themes: entry points, no $0 for unknown, coverage line, drilldowns and chips, focus never on body, keyboard on the plot / rows / efficiency grid, filtered-empty and first-launch empty, panels three across vs stacked, no page scroll, no layout shift from a live run) plus usage, dashboard, menu and self-help e2e; two screenshots looked at by eye (1600 dark, 1024 light). Reviewer: no Critical or High; M1-M7 and L2, L3, L4, L7, L8 fixed. Open: L1 (bars nest role=button segments inside a focusable group), L5 (several status regions, `aria-busy` on the root), L6 (test ids `usage-scope`, `usage-roles`, `usage-empty`, `usage-no-result-tag` exist on both the page and the run Usage tab), "Other" legend row does not open the Projects popover, the CSV ignores client-side narrowings (the status line says so), Efficiency uses the returned rows when truncated (it says so). Not driven: truncated, error / refresh-failed, legacy and all-unknown states (the mock cannot produce them), Months selects, More filters under 880 px, CSV contents, Day chip from the strip, screen readers, contrast by measurement in the app, macOS; no UX walk of the built page yet.
- Usage, team timing and staffing (orchestration-efficiency 4.7; `lib/usageStaffing.ts`, pure, with tests): EfficiencyPanel shows Time to first spawn, Overlap (reportSumMs / reportBusyMs, "1.8x") and Tail (tailMs / wallMs) as medians over runs with `usage.efficiency.reports > 0` (`usage-timing`, `usage-timing-item`); `StaffingPanel` shows Cost by tier (`usage-staffing`, `usage-tier-row`, `usage-tier-table`) and Lead alone vs With reports (`usage-lead-row`; team work runs; lead alone = no efficiency record and one agent). `RunStaffing` and per-agent usage do NOT reach the renderer (UsageOverviewRow carries RunUsage only), so a tier is read from each model entry: the run connection's `tierModels` (store `connections`), else `tierForModel`; the remainder ("Not tied to a tier") = total - tiers, so parts add to the total (rows-only total when main truncated). Unverified in the app: no e2e run, no screenshot.
- Settings pages (2026-11-03, `docs/design/config-review.md` + Implementation notes; ARCHITECTURE.md "Settings
  pages"): App panes General (Appearance, Notifications, New projects; Advanced: Motion and canvas, Assistant models,
  New projects (advanced)), Connections (cards; Advanced: Costs, Model prices), Connectors, Skill library, About; the
  Defaults pane is gone and its old ids open General. Project panes General (with the Connection section),
  Permissions (`PermissionsSection`, replaced Agents), Limits, Maintenance; stored ids agents / connection / tools map
  over, Plugins moved to Team > Catalog. Each pane has at most one closed "Advanced settings" disclosure
  (`settings-advanced[data-pane]`, open state in localStorage `orgai.settingsAdvanced.<paneKey>`; deep links open it).
  `requestAppSettingsSection` targets: `appsettings-section-connections`, `-model-prices` and `-costs` (Connections),
  `-assistant-models` and `-new-projects` (General), `-mcp-library`, `skill-library`, `-about`; the Chat start page
  (`chat-model-change`), `AssistantModelLine` and the MCP assist dialog's "Change in App settings" go to Assistant
  models. Store: `defaultConnection` from `ConnectionInfo.isDefault`, `defaultConnectionChosen` /
  `defaultConnectionStored` from settings, `setDefaultConnection(id | null)` the only writer. Testids:
  `settings-advanced[data-pane]`, `new-projects-section`, `default-mode-select`, `*-model-row-select`,
  `default-connection-badge`, `default-connection-mode` ("Chosen" only on the user's pick, "Automatic" on a fallback),
  `connection-make-default`, `connection-default-auto`, `connection-default-error`, `connections-live`,
  `community-prices-row`, `project-connection-line`, `proxy-family-notice` (only with other-family roles),
  `project-start-refusal` (`lib/remap.ts` `startRefusal` = shared `mixedFamilyRefusal`), `project-path`,
  `permission-mode-tradeoff`, `permission-mode-default`, `permissions-summary`, `permissions-summary-toggle`,
  `team-assistant-select`, `plan-guard-line`, `new-project-connection`, `new-project-connection-change`,
  `chat-model-change`, `role-model`, `role-model-advanced`, `role-exact-model`, `role-effort`,
  `role-effort-unsupported`, `plugin-add`. Removed: `role-tier-badge`, `catalog-plugin-settings`, `tools-team-pointer`,
  `open-team`, `skill-settings-section`. e2e (mock, Anthropic only): connections.mjs checks the panes, Advanced
  disclosures and deep links, the default badge, `project-connection-line` and the role Model select (`role-model`
  inside `role-model-fold`); assistants.mjs checks `chat-model-change`; permissions.mjs checks the Permissions pane,
  its summary toggle and the Limits pane (`plan-guard-line`). Not driven by e2e: `new-project-connection`,
  `role-exact-model`, make-default, Back to automatic,
  setDefault refusals, the multi-connection project cards, the LiteLLM notices and the unsupported-effort note
  (`defaultMode`, `defaultChangeAnnouncement`, `startRefusal` and `lib/roleModels.ts` are unit-tested).
  - Fix-up after the re-walk (39e0da6, `docs/design/ux-review-config-2.md` "Status after fix-up", config-review.md
    Implementation notes): deep links inside settings scroll with `lib/scrollWithin.ts` (only the nearest scroll
    container; shifted ancestors, html and body are reset), never `scrollIntoView`; e2e `lib.mjs` `windowShift(page)`
    checks the window did not move. The plan guard line is `lib/settingsCopy.ts` `planGuardLine(mode,
    maxWindowShare)`: automatic moves to the everyday tier past 80% of the weekly window, a run that reaches a plan
    limit pauses until it resets, and the five-hour share sentence appears only when a share is set.
    `PERMISSION_MODE_SHORT` (settingsCopy.ts) is the one short-name table for App General, project Permissions and the
    permission card. `perm-settings-link` targets the `rules` section (Permissions pane, disclosure open, "Saved
    permission rules" focused); `team-assistant-settings` (gear in the Team assistant tray) opens Permissions >
    Advanced with `team-assistant-select` focused (`lib/openProjectSettings.ts`, `PROJECT_ADVANCED_SECTIONS` in
    settingsTarget.ts). Role panel: `lib/roleModels.ts` `exactModelValue` (Exact model shows a pinned id only for a
    Custom role; "Not set" returns to the saved tier) and `roleChipLabel` (the org chart node chip shows the tier word,
    the model id in its tooltip). Assistant lines share `lib/assistantModels.ts` `useAssistantRunsOn` /
    `assistantModelLabel` / `runsOnText` ("Runs on Everyday tier (sonnet) via Anthropic"); `assistant-models-note`
    names the default connection. e2e (mock, Anthropic only): assistants.mjs checks the "Runs on" wording on the MCP
    and Skill lines and the dialog hint plus `windowShift` after every Assistant models link at both sizes;
    connections.mjs the App deep links' window shift, the shared mode names, the note and one "Model" in the role fold;
    permissions.mjs the plan guard line with and without a share, the card link landing on the open rules,
    `team-assistant-settings` in one click and the review switch's reason; team.mjs Exact model Not set and the
    custom round trip (skipped when the mock catalog has no id outside the tiers). Unit tests: scrollWithin,
    settingsCopy, roleModels, assistantModels, settingsTarget, permissionCopy. Non-Anthropic connections are not
    driven. Open: N7, N9, N13 and the Lows in ARCHITECTURE.md Risks.
- Application menu (renderer; `docs/design/ux-review-menu.md` Implementation notes): `lib/menuActions.ts` holds
  `routeMenuAction` (installed once by `lib/useAppMenu.ts` through `installMenuRouter`, also fed by `window.orgai.onMenuAction`
  and by `runMenuAction` from keydown handlers; unknown names ignored, never throws), the store fallbacks, `menuStateFor` /
  `menuStateChanged` (the five `MenuState` booleans, sent once on mount and then only on change), `announceMenu`, the one
  `SHORTCUTS` table, `openRunWindow` and `closeCurrentTab` (shared by Ctrl+W and Window > Close tab). A screen-local handler
  from `lib/menuRegistry.ts` runs first; it returns the sentence to announce when the action does not apply, else the store
  fallback runs. Announcements use the run tabs' `tabNotice` when a project is in the run view, else the app-wide sr-only
  status region `menu-announce` in `components/AppMenuLayer.tsx` (which also mounts `KeyboardShortcutsDialog`,
  `keyboard-shortcuts-dialog`, styles in `styles/menu.css`). `useRunTabShortcuts` routes Ctrl+T / Ctrl+W through
  `runMenuAction('new-run' | 'close-tab')`; LiveRunView registers the canvas, Hide finished, Show conversation and Go to
  decision handlers (Ctrl+. / Alt+D call `runMenuAction('go-to-decision')`, no tray guard), RunActions registers Save chat
  as project and Org retrospective only while they apply. The `run-tabs-notice` status span is always mounted and
  `setTabNotice` clears and re-sets a repeated text (a per-call sequence, so an older timer never clears a newer notice;
  Reviewer M1). A click on a greyed native item never reaches the renderer; only key presses or stale commands announce.
  Unit-tested (menuActions.test.ts, mocked store and window) and e2e/menu.mjs (in e2e:free; mock, 1024x640 and 1600x1000,
  dark and light: items clicked through `Menu.getMenuItemById(id).click()`; Team enabled/greyed, View > Team, New run and
  Ctrl+T one draft, Show conversation, Interrupt enabled while the session is open, Org retrospective on a live run
  announced, the shortcuts dialog with Esc and focus back, New chat, About, Ctrl+T on Projects announced). Not driven:
  macOS (Cmd keys may run twice if both the menu and the keydown fire; reviewer L2), run-scoped windows, canvas zoom/fit.
- Proxy connections (renderer, 2026-11-06; spec `docs/design/proxies.md`, pre-walk `ux-review-proxies-pre.md`): `lib/connectionLabel.ts` `connectionLabel(id)` is the one name (Anthropic, OpenAI, a proxy's name, "Removed proxy" when the id is not in the loaded list, "Proxy" before load; the store fills `setConnectionRegistry` and reloads on `connections.changed`); `connectionKindLabel`, `isProxyId`. Never write "LiteLLM" for a proxy; `CONNECTION_NAME` (shared) is no longer used by the renderer. Connections pane: `proxies-heading`, `proxy-add` (inert at PROXIES_MAX with `proxy-add-reason`), `proxies-empty`, `proxy-dialog` (`proxy-name`, `proxy-kind`, `proxy-anthropic-url`, `proxy-openai-url`, `proxy-models-url`, `proxy-key`), `connection-card[data-provider=<id>][data-kind=proxy]`, `proxy-save`, `proxy-test`, `proxy-delete-key`, `proxy-remove` (+ `proxy-remove-reason`), `proxy-checks` / `proxy-check[data-check][data-ok]`, `proxy-reports-note`, `proxy-models-host-note`. Pickers group by connection with the family (`lib/assistantModels.ts`, `lib/modelFamily.ts`, `ModelSelect`); on a proxy project Exact model is in the main role panel. New project: `new-project-connection-select` (two or more connected; else the `new-project-connection` sentence); the project is created on the default and then switched with `projects:remapModels` (no contract field; a failed switch holds the form and starts no setup). Project settings: `project-connection-option[data-id][data-state]` radio list. Usage: `spend-not-reported`, `dash-proxies`, `model-prices-unreported`; a proxy that reports no spend/prices says "not reported by this proxy", never $0 or "yet". e2e: `connections.mjs` (rewritten: proxy add/test/edit/delete key/remove refused then removed, four proxies and PROXIES_MAX, both sizes and themes), `project-connection.mjs` (in e2e:free), proxy blocks in `assistants.mjs` and `team.mjs`. Verified on the mock host only (reviewer: no Critical or High; M1-M3 fixed). Not seen: a real proxy, a LiteLLM-kind proxy that reports spend/prices, the sidebar footer with a proxy (hidden under the mock), screen reader output, the scroll-past-5 radio list. Open Lows from review: dialog closable while busy, no focus on invalid submit, card landmarks, store entries of a removed proxy linger. `npm test` has 7 failures in `src/cli/tui/*` (ink colour assertions) in this worktree, untouched by this change.
- Multi-provider org charts (renderer, 2026-11-07; spec `docs/design/multi-provider.md` "Renderer", pre-walk `ux-review-multi-provider-pre.md`): `lib/roleConnection.ts` (pure, unit-tested) turns connections:list into defaults.ts input (`connectionsViewOf`, `connectionStatesOf`), words problems ("Reviewer runs on OpenAI, which is not connected. Connect it in App settings or change the role's Runs on."), `ownConnection` (main's switch rule: a non-root role with any valid `connection` is kept on a switch, even when it equals the project's), `isPinned` (differs from the project's: tags and chips), `runsOnOptions` / `showRunsOn`, `connectionTag` / `connectionTagTitle`. Team role panel: `role-runs-on` first in the Model fold (2+ enabled connections or a pinned role, never the root; '' = Project default; a removed or turned-off pin stays as its own option; `role-runs-on-problem` with aria-invalid, `role-runs-on-hint` says what a change did to the model: a custom id the new connection does not serve or an unmapped tier falls back like Exact model's Not set); Model, Exact model, tiers and `role-effort` follow the role's connection, `role-effort-unsupported` names it. Chip `role-model-chip[data-connection]` "Everyday · OpenAI" only when pinned elsewhere (also in the node's aria-label); fold summary likewise. Live: `agent-connection` on agent cards, the side panel agent line and FinishedList when an agent's connection differs from the run's; UsagePanel `usage-connections` / `usage-connection[data-connection]` with 2+ entries. Project settings: `project-connection-roles-line`, Role models rows `role-model-connection`, remap dialog `remap-kept` / `remap-kept-role`, `project-start-refusal` from `lib/remap.ts` `projectStartRefusal` (role problems first, then `mixedFamilyRefusal`; other-family proxy roles never refuse, `proxy-family-notice` says they run as bridged reports); TierEditor previews projects with any role on the edited connection. New run: `new-run-start-refusal` (warning, Start stays enabled, hidden in Ask mode). e2e `e2e/multi-provider.mjs` (in e2e:free; mock, two mock proxies, both sizes and themes). Not seen: a real second provider, the By connection table and the disconnected (live status) wording by eye, compact node styles with a tag, screen reader output.
- Usage and skills walkthroughs on mock data: `docs/design/ux-review-usage-skills.md` (placement of the usage and skills UI, parts A and B), `ux-review-usage-2.md` (usage UI re-walk) and `ux-review-skills-2.md` (skills UI re-walk at 1024x640 and 1600x1000 in both themes plus a keyboard pass; the native Add from folder picker was not driven).
- Walkthroughs on mock data are in `docs/design/ux-review*.md`. The newest, `ux-review-runs-2.md`, predates the brief A
  run-view merge, so its N1 tray finding needs a re-walk. N2 (run windows miss pending decisions) and the focus and
  wording items are still open.
- Run staffing display (spec `docs/design/orchestration-efficiency.md` 4.7; not driven by e2e, not looked at in a live app): `lib/runStaffing.ts` (pure: newest assignment per agent via `assignmentOf`, `tierEffortLabel` "everyday / medium" never the model id, `staffingReason` words every `source` and appends the note) and `lib/planGraph.ts` (thin over `src/shared/planGraph.ts`, the one definition also used by main `continuation.ts` `readySteps` / `pathOverlaps` and the TUI: ready = pending, every existing `after` done or skipped, plus the later of two path-sharing parallel steps waits; missing ids ignored, cycles end, never throws; `planHasGraph` = any step with `after`, `paths` or `staff`, and without it nothing new shows). Three places, all silent for the orchestrator, older runs and plans without the graph: the card-style canvas node's sub line (`agent-staffing` chip, hover = reason and model; compact styles get it in the tooltip and sr-only line), the side panel agent header (`<details>` `agent-staffing-detail`: summary `agent-staffing-summary`, body `agent-staffing-reason`, `agent-staffing-model`), and the run meta line (`run-meta-staffing` with `run-meta-working`, `run-meta-ready`, each only above zero; hidden under 420 px with the agent count). Plan tab steps get `plan-step-state` (data-state running | ready | waiting; "Waiting on A, B and 2 more", titles cut to 28 chars) and `plan-step-staff` ("reviewer, everyday / medium"). Counts: working = agents in a working state, shown once the run has assignments or the plan has the graph. Not built: the pocket-office inspector, Dashboard and finished list rows show no staffing.

- Run staffing controls (`docs/design/orchestration-efficiency.md` 4.7; not driven in the app, unit-tested only): `lib/roleStaffing.ts` (pure) is the one place for the copy and the writes; effective values come from `effectiveRoleStaffing`, `staffingModeOf`, `staffingGoalOf`, `reviewPolicyOf`, nothing is re-derived. Role editor: `components/team/RoleStaffingControls.tsx` under the Model picker in the Model fold (`role-staffing`, `data-kind` root | exact | editable, `role-staffing-line`, `-note`, `-explain`, `role-staffing-mode`, `-min-tier`, `-max-effort`); the mode select's "Follow the project" clears `Role.staffing`, "Always" keeps no bounds, a floor or cap makes the role explicitly automatic; the root and exact-model roles get a line and a sentence but no controls. Project settings: `components/settings/StaffingSettings.tsx` is a "Run staffing" group inside the Limits pane's Advanced settings (it was a section at rest until the 2026-11-10 gate: `e2e/permissions.mjs` allows the pane two tab stops at rest) (`project-staffing`, `project-staffing-goal`, `project-review-policy`, segmented controls); choosing the default writes `undefined`. Import dialog: `import-spend` hint under Model, from the previewed `preview.roles` entry. Kit preview: `kit-role-spend` appears only when a `KitPreviewRole` carries `model` (it does not yet; `KitPreviewRole` has no model, effort or staffing, and `src/shared/types.ts` plus `main/kit/format.ts` `parseTemplate` must add them).

## Run settings row: Model, Effort, Permission, Goal (2026-11-10)

Spec: `docs/design/ux-review-run-start-pre.md` (H1-H3, M1-M8). Contract: `StartRunInput.modelSelection` / `effort` /
`permissionMode`, `RunSummary.rootEffort` / `permissionMode` / `permissionModeChosen` / `sessionPermissionMode`,
`runs:setPermissionMode` and the `run.permissionMode` event (src/shared/types.ts).

- Pure rules: `lib/runSettings.ts` (+ test). Defaults are what main would run anyway (`defaultRunModel`: Team = root role
  model on the project connection, Ask = `AppSettings.quickRunModel` through the tier mapping; `defaultRunEffort`: root
  role effort, none for Ask). `startChoicesToSend` sends only what differs, and never an effort the model's adapter does
  not take (`fitEffort` clamps down, the UI says so in `run-effort-fallback`). Narrowing/widening mirrors main's
  `canNarrowPermissionMode` (a parity test loads main's module by path). `permissionModeEventPatch` /
  `applyPermissionModePatch` read the `run.permissionMode` snapshot structurally (useAppStore replaces all three fields);
  `modeInForce` / `modeInForceLabel` show a card's accept-edits grant ("· edits accepted this session") without changing
  the run's own mode. `livePermissionOutcome` always shows main's reason and the running-reports count, applied or not.
- Components: `components/runSettings/` (`RunSettingsRow` group `run-settings[data-surface=start|live]`,
  `ModelPickerList` + `useModelCatalog` shared with `LiveModelSwitch`, `StartModelControl`, `EffortControl` /
  `EffortReadOnly`, `PermissionModeControl`, `LivePermissionMode`, `GoalControl` / `GoalReadOnly`), styles
  `styles/run-settings.css`. Every chip is one Tab stop with a Popover; `data-default`, and `data-tone=warning` plus a
  ShieldAlert icon for auto and acceptEdits; bypass is the danger tone with ShieldOff.
- Effort is a native radio `SegmentedControl` ordered least to most inside a popover (the "slider": arrow keys step,
  every level named; a native range would hide the names). Live it is read-only: the contract has no mid-run effort.
- Permission: the picker stages a choice and "Use this mode" applies it, because native radios fire change while arrow
  keys pass over options (applying on change would open the bypass confirm on the way). A widening (`isWideningMode`)
  goes through `ConfirmDialog` (`run-permission-confirm`, danger for bypass, cancel "Keep current mode"); narrowing
  applies at once. Live outcomes: `run-permission-note` (visible, `data-tone` ok | saved | refused) plus sr-only
  `run-permission-status`; thrown refusals in `run-permission-error`. A refusal while the run is replying offers
  `run-permission-interrupt` ("Interrupt and change": one interrupt, bounded wait for idle, one retry; blocked by open
  decisions or active reports like the model switch). Ended runs read "Permission: Next message: <mode>" and show the
  mode the continuation will carry. Open permission cards are never touched. The control is hidden on setup-like and
  assistant runs (`runPermissionModeChoices` empty); Chat shows only modes its adapter keeps.
- Choices are per run: never written to the project, not remembered across starts; they survive a refused start
  (Composer keeps the draft, `composer-error` shows main's text without the IPC prefix) and reset after a successful one.
- Live row placement: a fixed bar at the top of `.live-composer-region` (`live-settings-bar`), not inside Composer's
  `settings` slot: the slot remounts `LiveModelSwitch` when an ended assistant swaps the composer, which cancels a model
  handoff in flight (`e2e/model-switch.mjs` caught it). Visual order is therefore chips, then "Replying to X".
- RunMeta: `run-meta-permission[data-mode]` for every work-run mode except plain "Ask for everything risky" (auto keeps
  `run-meta-unattended`), "(this run)" when chosen, and the session grant.
- New run page fixes: Goal is a labelled chip ("Optimise for": Balanced / Faster / Cheaper), placeholder no longer
  repeats the hint, Ask's duplicate line is gone, one-sentence lead, composer widened to 768 px (shared `.new-run-inner`,
  so the Chat and instruction start pages widened too), role chips capped at 5 plus `new-run-more-roles`, label always
  "New run" / "Ask one assistant", setup pending shows `new-run-skip-setup` "Start without setup" (secondary) and no
  settings row, focus lands in the live composer textarea after Start.
- `ui/Popover` places itself again when its content resizes (a ResizeObserver while open, only when the panel's
  offsetWidth / offsetHeight differ from the last placement, so it cannot loop): the start model picker grew past the
  window after its catalog loaded. Focus moves into the panel in a requestAnimationFrame after placement, to a search input
  (`input[type=search]`) if present, else the checked radio (`input[type=radio]:checked`), else the first control, retried for a few frames, and a control the content already
  focused (the model picker's search box) is kept. Cause of the old "Enter leaves focus on the chip": on a popover's
  very first open the focus call ran inside the `toggle` event task, before the panel was rendered as an open popover, and
  was silently dropped (later opens worked, keys did not matter). This applies to every Popover user; no other screen's
  e2e changed.
- Interrupt and change (`LivePermissionMode`): the note stores `covered` (the baseline the choice or its confirmation
  was measured against) and `seen` (the mode in force when it was written). A `run.permissionMode` event that moves the
  mode in force clears the note; if a retry would now widen (`retryNeedsConfirm`, checked before the interrupt and again
  after the wait for the boundary) the same `ConfirmDialog` (`wideningConfirmOptions`) is shown, declining clears the
  note. A result for another run of the chain (`result.run.id !== run.id`) says "This conversation continued
  elsewhere..." and never claims the mode changed. Start page: a staged mode resets when the project's own mode changes,
  and Start confirms a staged widening that was not confirmed against the project's current mode (declining restores
  the draft with no error banner). Permissive options in the list carry the hidden icon (ShieldAlert, ShieldOff for bypass) (`run-permission-option-icon`);
  "Use this mode" is guarded so a double click opens one dialog.
- The start model default always uses the project's connection: `Role.connection` is ignored on the root
  (`defaults.ts` `roleConnection`, `Role.connection` doc, main `runManager` / `claude.ts`), so a stale value on the root
  role does not move the chip or the "same as default" test (unit-pinned in `runSettings.test.ts`).
- RunMeta on an ended or paused run shows the chip's value (`metaPermission`: `livePermissionValue`, not what the finished
  session ran with), prefixed `Next message:` (`data-next=true`) only when it is a pending user choice
  (`permissionModeChosen`); the chip's prefix follows the same rule. The plain default stays hidden.
- Tones: `permissionTone` (Bypass = danger with a ShieldOff icon on the chip, the list and RunMeta; Unattended and
  Auto-accept edits = warning with ShieldAlert). The "Default" tag is gone from every chip (an untouched default keeps
  its tone, only a picked change says "Changed"), which also lets the row fit on one line at 1024 and 1600. The reset link
  is one string (`RESET_TO_DEFAULT_LABEL`, "Use default") for model and effort.
- "Interrupt and change" is replaced by a hint while a decision is open or reports run (read from the store, so it comes
  back when they close) and is withdrawn when the mode in force moves (retry offers only; outcome sentences stay).
- Chat / assistants: no settings row on the Chat start page because `QuickRunInput` carries no model, effort or mode (the
  page keeps its summary line and "Change in App settings"); the live Chat chip resolves a tier alias ("everyday") to the
  catalog's friendly label through the connection's tier mapping and keeps the exact setting in the title; every assistant
  start (`showStartedAssistant`) puts focus in the live reply box like a project start.
- Popover first-open focus: reproduced with the e2e driver on the first open of every popover (Enter or Space alike); a
  hand walk that opens one before, or waits, sees it work. Whatever the cause of the walker's difference, the new
  rAF focus step is covered by run-start section 9 on first open.
- Not done (L3): when a project change narrows a run to Plan / Don't ask main drops the accept-edits grant, but the native
  session may keep accepting edits until it restarts. The `run.permissionMode` snapshot cannot say why a grant went away
  (a user change, a project change or a session end look alike), so the renderer shows no "may still accept edits until
  restart" suffix; it needs a contract field.
- Checked: typecheck, renderer unit tests (runSettings 27 tests, runGoal), build, `e2e/run-start.mjs` (start page, refusal
  with a real main refusal, widening confirm/cancel, saved-for-next-message, keyboard order and Escape, both themes and
  sizes), model-switch, runs, layout, permissions, assistants, engagement2. Run-start sections 5, 6 and 8 (applied
  mid-run change, `[mock:mode-refuse]`, `[mock:mode-reports-unchanged]`) needed the merged tree with the adapter's mock:
  the orchestrator ran `e2e/run-start.mjs` on merged dev d4258a4a and all checks passed.
  Unverified: real Codex effort fallback and Codex turn-boundary refusal, multi-connection pickers, screen-reader speech,
  reduced motion and forced colours, 320 px reflow, the stale "Interrupt and change" path in the app (the idle mock cannot
  stage a mid-reply refusal; the decision is unit-tested). Popover focus-in on first open is now asserted by run-start
  section 9 (it was a NOTE).
