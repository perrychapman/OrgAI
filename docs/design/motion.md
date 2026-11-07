# Motion system

Status: spec, 2026-11-07. Inputs: `outputs/motion-research.md` (researcher), `docs/design/ux-review-motion-pre.md`
(inventory from CSS reading, nothing walked by eye), `styles/tokens.css`, the reduced-motion rule in `styles/global.css`.
Scope: the whole renderer except the Outputs tab (`outputs*.css`, `components/outputs/*`, owned by another run).
Nothing here has been built or seen; every duration is a starting value to tune by eye in the first walk.

The owner asked for more motion. The answer is not more animation, it is that every change of state gets one short,
quiet transition and nothing appears or vanishes in a single frame.

## 1. Principles

1. Motion explains a change of state (something arrived, left, moved, opened) or shows that something is alive. It never decorates.
2. Fast. Entries 160 ms (small) or 260 ms (large), exits 100 ms, presses 50-100 ms. Nothing over 260 ms except the live pulse.
3. Enter slower than exit. Entries decelerate (`--ease-out`), exits accelerate (`--ease-in`), moves use `--ease-in-out`.
4. `transform` and `opacity` only. Two allowed exceptions, both small and clipped: a disclosure or row-collapse height (grid `0fr` to `1fr` or `interpolate-size`) and the sidebar column. Never `box-shadow`, `filter` or `backdrop-filter` in a loop.
5. Entries start close to the final state: translate by `--motion-distance` (8 px) or `--motion-distance-sm` (4 px), scale from `--motion-scale-from` (0.96), never from 0.
6. Nothing animates on the first paint of a page or view, on a relaunch, or when a restored list mounts. Entry motion is for rows and cards that arrive while the user is looking (spec 2.9 "arrival rule"). Exception: dialogs and popovers, which are always user-triggered.
7. No motion blocks input. Never `pointer-events: none` during a transition, never delay focus, never wait on an animation before acting (no `await` on `animationend` in logic except exit retention, section 2.8).
8. Focus rings, selection, pressed and drag are instant. Direct manipulation (resize drag, pan, node drag) never has a transition.
9. State is never carried only by motion. A working agent keeps its colour, dot and word with motion off.
10. Motion never speaks. No live region is triggered by a transition; announcements stay text-only (see `better-accessibility`).
11. One live-cue rate: `--dur-pulse` everywhere (section 2.9).

## 2. Tokens

All in `styles/tokens.css`, Motion section; existing values unchanged. No literal `ms`, `ease` or `cubic-bezier` in a component stylesheet; the 80 ms / 120 ms / `ease` / `1.4s` literals found in the inventory are replaced during the slices.

| Token | Value | Use |
|---|---|---|
| `--dur-instant` | 50ms | hover colour, press release |
| `--dur-fast` | 100ms (existing) | press, every exit, tooltip, chevron rotate, checkbox tick |
| `--dur-base` | 160ms (existing) | popover/menu/dialog enter, row enter, switch thumb, disclosure |
| `--dur-slow` | 260ms (existing) | panels, tray cards, sidebar, layout glide, tab underline |
| `--dur-fade` | 80ms | the length of an opacity-only fade (tab view crossfade, panel tab content, skeleton swap) |
| `--dur-pulse` | 1800ms (existing) | the one live-cue period |
| `--ease-out` | existing | entering, responding |
| `--ease-in` | `cubic-bezier(0.4,0,1,1)` | leaving |
| `--ease-in-out` | existing | moves, resizes, underline slide |
| `--ease-spring` | `linear(...)` overshoot | switch thumb and popover scale only; tune by eye |
| `--motion-distance` | 8px | dialog, tray card, banner rise |
| `--motion-distance-sm` | 4px | rows, view fade, popover |
| `--motion-scale-from` | 0.96 | dialog, popover, node pop |
| `--motion-stagger` | 30ms | list step, at most 6 items (`--i` inline, `animation-delay: calc(var(--i) * var(--motion-stagger))`) |

Reduced motion (tokens.css, both `@media (prefers-reduced-motion: reduce)` and `:root[data-reduce-motion='on']`): distances 0, scale 1, stagger 0, all durations 0.01 ms. Entries written with these tokens therefore degrade to nothing (instant), with no per-component override.

Open decision D1: the research recommended keeping an 80 ms opacity fade under reduced motion (WCAG 2.3.3 targets motion, not fades). `global.css` forces `transition-duration: 0.01ms !important` on everything, so that cannot happen without editing the global rule. Recommendation: keep it as is (zero). A fade that is instant is always safe and matches the owner's existing "Reduce motion" meaning. Revisit only if the dialogs feel jarring when reduced.

### 2.1 Shared recipes (put once in `styles/motion.css`, imported after `tokens.css`)

A new file, `styles/motion.css`, holds the keyframes and utility selectors every slice uses, so slices do not collide. It contains: the `interpolate-size: allow-keywords` declaration on `:root`; `@keyframes motion-rise` (opacity 0 to 1, translateY(`--motion-distance-sm`) to 0), `motion-rise-lg` (`--motion-distance`), `motion-fade`, `motion-pop` (scale from `--motion-scale-from`), `motion-ring` (the one-shot attention ring); the `.motion-collapse` grid recipe (`display: grid; grid-template-rows: 1fr; transition: grid-template-rows var(--dur-base) var(--ease-in-out), opacity var(--dur-fast); > * { min-height: 0; overflow: hidden }` with `[data-collapsed='true']` `grid-template-rows: 0fr; opacity: 0`); and `.motion-enter` / `.motion-enter-lg` (animation using the keyframes, `animation-fill-mode: backwards`). `pop-in`, `dash-row-in` and `dash-row-fade` stay until their owners migrate, then are deleted.

### 2.2 The arrival rule (new vs restored)

Entry classes must apply only to items that arrive after the surface was shown. A tiny shared hook `lib/useArrival.ts` returns `isNew(id)`: ids present at first render of the list (and ids present after a project or run switch) are marked seen; only ids added later return true, and each id returns true once (a remount does not replay). Used by: needs rows, tray cards, transcript rows, canvas nodes, run tabs, banners, knowledge rows. Pure and unit-testable. This is the fix for inventory item 2 (pop-in replaying on remount).

### 2.3 Exit retention

CSS cannot play an exit for something React already unmounted. Two retention patterns, both in one hook `lib/useExitPresence.ts`:

- `useExitPresence(present, ms)` returns `{ mounted, state: 'in' | 'out' }`. When `present` goes false it keeps `mounted` true for `ms` (read from the token via `getComputedStyle(root).getPropertyValue('--dur-fast')`, so reduced motion gives about 0 ms and the node leaves at once), sets `data-state='out'`, then unmounts. A re-present before the timer cancels it.
- Only for a direct user action or a state the user is watching (dismiss a banner, resolve a decision, close a tab, End session). Never for rows that stream (transcript, needs rows leaving because a run ended while the user was elsewhere): those leave at once, which is quiet enough and avoids stale interactive controls.

Retained exiting nodes carry `inert` and `aria-hidden='true'` so focus and screen readers do not meet a dying control. Focus management is unchanged: it moves in the same tick as the action, never after the exit.

## 3. Per-surface specs

Notation: **Trigger** / **Props** (what changes) / **Timing** / **Enter-exit** / **Reduced** / **Owner** (component and CSS) / **Kind** (CSS = pure CSS; REACT = needs a React change). "Reduced" is "tokens zero it" unless stated, because the global rule and tokens already do that.

### 3.1 Dialogs and confirm dialogs (inventory 1)

- Trigger: `open` toggles; `showModal()` / `close()`.
- Props: panel `opacity` 0 to 1 and `translateY(var(--motion-distance))` + `scale(var(--motion-scale-from))` to none; `::backdrop` `opacity` only (no blur, static colour).
- Timing: enter `--dur-base` `--ease-out`; exit `--dur-fast` `--ease-in`, opacity and scale only (no translate on exit). Backdrop same durations.
- Recipe: the researcher's `@starting-style` + `transition-behavior: allow-discrete` with `overlay` and `display` in the transition list, on `.dialog` and `.dialog::backdrop` (declare durations on `:root` tokens; if `::backdrop` fails to resolve them in Chromium 140, use `:root` custom properties through `dialog::backdrop { transition-duration: var(--dur-base) }`, which inherits from the originating element in current Chromium; verify in the first walk). `@starting-style` blocks come after the normal rules.
- Exit needs REACT: `Dialog.tsx` renders `children` only while `open`, so on close the `<dialog>` fades out empty. Keep the last children and footer rendered while closing: `const shown = useExitPresence(open, ...)`; render the panel while `shown.mounted`, call `el.close()` only when `open` goes false (the CSS exit then runs against the retained content), unmount children after `--dur-fast`. The panel is `inert` during exit. Stacked `ConfirmDialog` over `Dialog` is fine (separate top layer entries).
- Never delay `showModal()` or the `data-autofocus` focus. Focus return to the opener happens at close as today.
- Reduced: instant open and close.
- Owner: `components/ui/Dialog.tsx` (REACT, small), `styles/ui.css` dialog rules (`.dialog`, `.dialog::backdrop`, `.dialog-panel`). Kind: CSS for entry, REACT for exit.
- Large dialogs (`size-lg`, New project, `output-dialog` excluded): same timing; do not scale from below 0.96.

### 3.2 Popovers, menus, tooltips (inventory 1)

- Popover (`[popover]`, `Popover.tsx`, row menus, the account popover, canvas style popover, `More actions`): `:popover-open` with `@starting-style`, `allow-discrete`, `overlay`. Enter `--dur-base` `--ease-out`: opacity 0 to 1, scale `--motion-scale-from` to 1 from the trigger side (`transform-origin` from the anchor side: use `top left` default; menus that open upward use `bottom`; set per popover class through a `data-side` attribute only where Popover already knows it). Exit `--dur-fast` `--ease-in`, opacity only. `--ease-spring` allowed for scale on small menus only if it reads calm; default `--ease-out`.
- Because popovers are always mounted (native `popover` attribute) exits are pure CSS. Check the ones rendered conditionally (`{open && <div popover>}`): those need the retention hook or accept no exit; list them in the slice walk.
- Tooltips (`title` is native, not styled; any custom tooltip, e.g. canvas node tooltips and the rail tooltip): opacity fade `--dur-fade`; show delay 300 ms on first, none when moving between tooltips; exit none. Do not add custom tooltips to get this.
- Reduced: instant.
- Owner: `components/ui/Popover.tsx` (none if CSS-only), `styles/ui.css` popover block, `styles/menu.css`, `styles/shell.css` (account popover). Kind: CSS.

### 3.3 Topbar tabs: underline slide and view crossfade (inventory 8)

- Underline: the active tab's 2 px indicator slides between tabs: a single absolutely positioned `.tabs-indicator` element inside the tablist, positioned with `transform: translateX(var(--tab-x)) scaleX(var(--tab-w-scale))` (or `left`/`width` on a 2 px element, acceptable) set by the Tabs component from `offsetLeft/offsetWidth` of the selected tab in a layout effect and on resize. Timing `--dur-slow` `--ease-in-out`. First paint and window resize set position with `transition: none` (a `data-ready` attribute added after first measure).
- View crossfade: on tab change, the new view's root gets `.motion-view` (`motion-rise`, `--dur-fade` plus rise `--motion-distance-sm`, `--dur-base` total at most). No exit; swap immediately and fade the new one in. No View Transitions API (it snapshots React Flow and the neural canvas as bitmaps and blocks input; not allowed).
- Triggers only for a user tab change (store `view` change), not for the initial view, project switch or relaunch restoration (arrival rule, section 2.2).
- Reduced: indicator jumps, no fade.
- Owner: `components/ui/Tabs.tsx` (REACT: indicator element and measure), `styles/ui.css` tabs; the view root class in `App.tsx` / `ProjectShell` (REACT: key by view and add the class when the change came from a click). Kind: REACT.
- Also applies to `run-tabs` (section 3.4) and the Settings pane switch (the same `.motion-view` on the pane body; pane change only).

### 3.4 Run tabs: insert, remove, indicator, status (inventory 11)

- Insert: a new tab enters `--dur-base`: `max-inline-size` is not animated (layout); use opacity + translateX(`--motion-distance-sm`) from the left only. Siblings do not glide (widths snap), accepted: tabs are few. Remove: only on the user's Close: opacity fade `--dur-fast` retained through `useExitPresence`, then the tab leaves.
- Selected underline: slides like the topbar underline (`--dur-slow`).
- Status dot: working breathes at `--dur-pulse` (see 3.18); a status word change swaps instantly.
- The `run-tabs-notice` is a status span; it fades in `--dur-fade` without moving anything.
- Reduced: none.
- Owner: `components/RunTabs*.tsx` (REACT for the exit and the indicator), `styles/run-tabs.css`. Kind: REACT (CSS entry only is acceptable as a first cut).

### 3.5 Sidebar full to rail (inventory 4)

- Trigger: Ctrl/Cmd+B, the collapse button, the 1180 px breakpoint, a resize.
- Props: `grid-template-columns` on `.app` from `var(--sidebar-w)` to `var(--sidebar-w-collapsed)` (interpolates in Chromium). Labels fade `opacity` over `--dur-fade` and are clipped (`overflow: hidden`) so text never wraps during the move. The inner sidebar has a fixed inner width (the full width) while animating so its content does not reflow every frame; `overflow: hidden` on the column.
- Timing: `--dur-slow` `--ease-in-out`. Labels: fade out first (`--dur-fade`), fade in after the column has mostly arrived (delay `--dur-fast`).
- Canvas refit: the existing refit skip for layout switches must also ignore the resize that comes from this transition (set `data-sidebar-moving` for the duration, refit once at `transitionend`); the Live canvas never refits per frame.
- The 1180 px breakpoint and a drag-resize (`ResizeHandle`) never transition: set `transition: none` while a drag is active (`.app[data-resizing]`) and on first layout.
- Reduced: snap (as today).
- Owner: `styles/shell.css` (`.app`, `.sidebar` label rules), `lib/useSidebarCollapsed.ts` / `App.tsx` (REACT: the `data-resizing` and `data-sidebar-moving` attributes; refit hook in Live view). Kind: mostly CSS plus one REACT attribute and the refit guard.

### 3.6 Side panel: collapse and tab content (inventory 12)

- Collapse to rail / expand: panel column width (`--side-panel-w`) with clipped inner content, `--dur-slow` `--ease-in-out`; not during a handle drag (`transition: none` while `data-resizing`) nor at first layout. The `data-side-wide` composer move stays a snap (it relocates one element; animating it needs FLIP, not worth it).
- Tab content swap (`SidePanel` tabs: Transcript, Usage, Outputs excluded, Knowledge, ...): new tab body uses `.motion-view` with `--dur-fade` and `--motion-distance-sm`. No exit.
- Reduced: none.
- Owner: `components/layout/SidePanel.tsx` (REACT: `data-resizing` during drag, key the body by tab), `styles/layout.css`. Kind: REACT (small).

### 3.7 Disclosures: details, Advanced settings, Customise, sessions toggle (inventory 9)

- Trigger: `<details>` open/close or a button-controlled region.
- Native `<details>`: `details::details-content { block-size: 0; opacity: 0; overflow: clip; transition: block-size var(--dur-base) var(--ease-in-out), opacity var(--dur-fast), content-visibility var(--dur-base) allow-discrete; } details[open]::details-content { block-size: auto; opacity: 1; }` with `interpolate-size: allow-keywords` on `:root`. Exit is the same transition reversed at `--dur-fast`.
- Button-controlled regions (Customise, the History `history-sessions-toggle` member rows, plan-guard panels): the `.motion-collapse` grid recipe keyed by `data-collapsed`; the region stays mounted (REACT only where it is currently conditionally rendered).
- Chevron: `rotate` `--dur-fast`. All disclosures already rotate or should; unify on `rotate: 90deg` for the open state, no `transform` shorthand clobbering.
- Not applied to the transcript, large lists or anything that holds a canvas; those open instantly (layout cost, section 5 of the research).
- Reduced: instant.
- Owner: `styles/ui.css` (`details` global rule, so `settings-advanced` and every native details inherit), `styles/settings.css`, `styles/canvas-settings.css` (Customise), `styles/mcp.css`, `components/history/*` (sessions toggle: REACT to keep it mounted). Kind: CSS for native details, REACT for the conditional ones.
- `::details-content` is Chromium 131+; Electron 45 (Chromium 140) has it. If a test shows it missing, fall back to no animation, not a polyfill.

### 3.8 Decision tray: arrive and resolve (inventory 2)

- Arrive: a new card in `FrameTray` enters `--dur-slow` `--ease-out`: opacity 0 to 1 and translateY(`--motion-distance` x 1.5 = 12 px, written as `calc(var(--motion-distance) * 1.5)`) to 0, plus a one-shot accent ring: `outline`/`::after` ring (opacity .5 to 0, scale 1 to 1.02, `--dur-slow` x 2.3 ~ 600 ms written as `calc(var(--dur-slow) * 2.3)`), once, no loop. Only a card arriving while the user is on the run (arrival rule). A card present at mount (relaunch, `pendingCards`) does not animate.
- Tray height changes (stage shrinks when the tray fills): the tray container animates `grid-template-rows` 0fr to 1fr (`.motion-collapse`) so the canvas shrinks smoothly instead of jumping; canvas refit is deferred to `transitionend` (shared with 3.5's guard).
- Resolve: on Allow/Deny/Approve the card fades `--dur-fast` and the tray collapses `--dur-base`, retained through `useExitPresence`. Focus moves in the same tick, as today.
- Switching cards inside the tray (first open decision changes): `.motion-view` `--dur-fade`.
- Announcement stays on the frame's `tray-announce`; the ring never speaks.
- Reduced: arrive and resolve are instant; the ring is `display: none`. The card's colour/eyebrow already marks it.
- Owner: `components/DecisionCard.tsx` (REACT: `isNew` and exit retention), `components/layout/FrameTray` / `CanvasFrame.tsx` (REACT: collapse wrapper, `data-moving`), `styles/cards.css`, `styles/layout.css`. Kind: REACT.

### 3.9 Needs-you bell attention cue (inventory 2)

- Trigger: the decision count rises (not on mount, not when it falls).
- Props: the bell badge (not the icon) plays `motion-pop` (scale 1.0 to 1.15 to 1.0, `--dur-slow`) once, and the bell gets a one-shot ring like 3.8 at 1x. At most one cue per 5 s (shared throttle with `tray-announce`'s text).
- A persistent count has no motion; a waiting state is colour and number, never a blink (motion-design rules).
- Reduced: none, the number changing is the cue.
- Owner: the bell component in `components/layout` or `Sidebar` (find via `needs-bell` test id), `styles/shell.css`. Kind: REACT (previous-count ref and a `data-ping` attribute that clears on `animationend`).

### 3.10 Needs-you rows, banners, notices (inventory 3)

- Enter: row or banner `.motion-enter` (opacity + translateY 4 px, `--dur-base`, `--ease-out`), arrival rule: not on mount or first render. Needs you rows on the Dashboard keep stagger at most 6 (`--i` capped at 5) and only on a batch arriving together.
- Exit (user-driven only: Dismiss, Clear, Undo notice, an answered inline decision): fade `--dur-fast`, then the `.motion-collapse` height collapse `--dur-base` so siblings glide up instead of snapping. Rows that leave because a run ended elsewhere leave instantly (section 2.3). Banners (`Banner`, `team-files-applied`, `knowledge-notice`, `import notices`, `maintenance-notice`, the New run `new-run-start-refusal`) all go through one wrapper in `components/ui/Banner.tsx` so the recipe lives once.
- Layout shift: appearing banners reserve their height through the same collapse (0fr to 1fr over `--dur-base`), so content below glides down rather than jumping.
- Locked inline answer rows (`aria-disabled`) stay as today; the exit starts on their `*.resolved` event.
- Reduced: none.
- Owner: `components/ui/Banner.tsx` (REACT: wrapper, `useExitPresence` for dismissals), `components/dashboard/NeedsYou*.tsx` and `AttentionColumn.tsx` (REACT: `isNew`; exits only for user actions), `styles/ui.css`, `styles/dashboard-needs.css`, `styles/dashboard.css`. The existing `dash-row-in` is replaced by `.motion-enter` (delete the keyframe after). Kind: REACT.
- The dashboard comment "rows never animate out" is superseded for user-driven removals only; update it when migrating.

### 3.11 Transcript rows, follow and Jump to latest (inventory 7)

- New rows: `.motion-enter` at `--dur-fade` plus `--motion-distance-sm` rise, only for rows appended while the user is at the bottom (following). Cap: at most 6 rows animate per animation frame batch; when more arrive at once (a burst, a chain load, a history prepend) none animate. No stagger. Rows loaded on mount, via `chain-load-earlier` or on a run switch never animate. Streaming text growth inside a row never animates.
- Smooth follow: when following, scroll with `scrollTo({ top, behavior: 'smooth' })` only if the delta is under one viewport and the user did not scroll in the last 300 ms; otherwise jump instantly. Reduced motion and `data-reduce-motion='on'` force `behavior: 'auto'` (the CSS `scroll-behavior: auto !important` does not cover script, so the follow code reads `useReducedMotion()`).
- Jump to latest (`conversation-jump`): opacity + translateY 4 px `--dur-base` in, `--dur-fast` out, kept mounted and toggled by `data-visible` (so the exit is CSS). It never steals focus.
- Reduced: rows instant; follow instant.
- Owner: `components/TranscriptPanel.tsx` (REACT: arrival tracking with batch cap, follow behaviour), `styles/transcript.css`. Kind: REACT.

### 3.12 Canvas nodes: pop-in for new ids, glide on layout (inventory 5, 6)

- Pop-in: only for node ids new since the canvas was shown (`useArrival`), applied to an inner element (`.run-node-inner` or each node style's root), not the React Flow wrapper (which sets inline `transform: translate()`): `motion-pop` opacity + scale from `--motion-scale-from` at `--dur-base` `--ease-out`. Replaces `pop-in`. A remount (view switch, refit, fold, layout switch, node style switch, relaunch restore) never replays it.
- Glide: node position changes from auto-layout (a new agent shifts siblings, a fold or expand, a layout or style switch, Auto-layout on Team) transition `transform` on the React Flow wrapper (`.react-flow__node`) at `--dur-slow` `--ease-in-out`, enabled only while the canvas root has `data-layout-moving`, a class added by the code that triggers the layout and removed at `transitionend` (or after `--dur-slow` + 50 ms). Never during drag, pan, zoom or while the user is selecting: a node drag sets `data-dragging` which wins (`transition: none`). Edges follow because RF recomputes paths from the node positions each frame during the transition; accept per-frame edge recompute for at most 60 nodes; above 60 nodes, skip the glide (snap) to protect the frame budget.
- Fit: `fitView` duration passed from `useReducedMotion()` (0 reduced, `--dur-slow` in ms otherwise); the canvas refit skip for layout switches stays. Refit after a fold or expand waits for the glide to end (single refit).
- Edges: new edge fades in `--dur-base` (opacity); no dash draw-in (needs a path length per edge; skip). Running edges keep their existing flow; message edges keep `msg-dots`.
- Node state border/shadow changes keep their existing 160 ms (`--dur-base`).
- Reduced: none of the above; fit duration 0.
- Owner: `components/canvas/*` and node components (`AgentNode`, `RoleNode`, station, hex, compact), `lib/canvasFit.ts`, `views/LiveRunView.tsx`, `views/TeamView.tsx` (REACT: `useArrival`, `data-layout-moving`, fit duration), `styles/canvas.css`, `styles/flow.css`, `styles/run.css`. Kind: REACT.

### 3.13 Done-group fold and expand (inventory 6)

- Fold (finished subtree becomes a `done-group`) and expand: the group node enters with `motion-pop`; folded children are removed from the graph by the existing fold, so the visible change is the layout glide of 3.12 for survivors. To avoid a one-frame "children vanish, group appears", the group node fades in over `--dur-base` while the glide runs; children are not retained (they leave at once; retaining them would need duplicate nodes in React Flow).
- Expand: the revealed direct reports `isNew` for this expand (a fresh arrival token per expand), so they pop; the group node itself just changes content.
- Edges to revealed children fade in `--dur-base`.
- Reduced: none.
- Owner: `lib/foldFinished.ts` consumers in `LiveRunView.tsx`, `components/canvas/DoneGroupNode.tsx`, `styles/canvas.css`. Kind: REACT (arrival tokens), builds on 3.12.

### 3.14 Dashboard: band reveal, Show N more, tiles (inventory 13)

- Band (`dash-now`) show or hide (`data-now-empty`, `data-needs-empty`): the `.dash-work` grid reflows; animate the band container with `.motion-collapse` for its own height and fade, `--dur-base` (the two-track layout itself is not animated: tracks snap, it is a one-off at arrival of a first run, accepted). Not on first paint.
- Agent rows: existing `dash-row-in` replaced by `.motion-enter` (arrival rule). Rows leaving: instant (run activity, not a user action).
- "Show N more" / "Show fewer": newly revealed rows `.motion-enter` with stagger capped at 6 (`--i` min(index, 5)), height snaps (a long list is not collapse-animated). Revealed rows after the first 6 appear at once.
- Project tiles: a tile appearing (create, clone) `.motion-enter`; tile status caption swaps instantly; hover keeps its `--dur-fast` border/background.
- Activity strip: existing `dash-strip-grow` stays on first mount only (it is first-paint motion; spec exception, one-shot, `--dur-slow`).
- Marks: breathing per 3.18.
- Reduced: none.
- Owner: `components/dashboard/RightNowBand.tsx`, `BandRun.tsx`, `AttentionSection`, `ProjectTile.tsx`, `DashboardView.tsx` (REACT for `isNew` and the "Show more" `--i`), `styles/dashboard-band.css`, `dashboard.css`, `dashboard-projects.css`, `dashboard-strip.css`. Kind: REACT (small).

### 3.15 New project dialog: field swaps, repo panel, clone progress (inventory 10)

- Kind radio swaps fields (code / engagement), setup choice appearing, `RepoStartPanel` showing, clone progress and result blocks, `TeamFoundPanel`: wrap each swappable region in `.motion-collapse` keyed by `data-collapsed`, fields inside fade `--dur-fade`. The dialog height therefore follows the content over `--dur-base` instead of jumping. The sticky submit row and `repo-action-block` stay sticky; they are not animated.
- The form's measured `--form-submit-h` is read once per layout; a height transition never causes a measurement loop: the measuring `ResizeObserver` already tolerates continuous resize, but the scroll-into-view after a clone (`repo-cloned-line` to top) must wait for `transitionend` or `--dur-base` + 50 ms (use `useReducedMotion` to skip).
- Clone progress bar width keeps its existing transition (`--dur-slow`); the status line text changes instantly.
- Reduced: none.
- Owner: `components/dashboard/NewProjectForm.tsx`, `RepoStartPanel.tsx`, `TeamFoundPanel.tsx` (REACT: keep regions mounted with `data-collapsed`; today they unmount), `styles/dashboard.css` / `import.css` as applicable. Kind: REACT (medium; regions currently unmount).
- Keep `new-project-status` as the one polite region; nothing here announces.

### 3.16 Switches, checkboxes, radios, buttons (inventory 14)

- Switch (`ui/Switch`): thumb `transform: translateX` `--dur-base` `--ease-spring`; track background `--dur-fast`. No bounce on reduced (tokens zero it).
- Checkbox: checked tick drawn via `stroke-dashoffset` (or `scale` 0.6 to 1 on an inline check) `--dur-fast`; background `--dur-instant`. Radio dot: `scale(0.5)` to 1 `--dur-fast`.
- Buttons and `IconButton`: press `transform: scale(0.98)` at `--dur-instant` in, `--dur-fast` out, only on `:active:not([aria-disabled='true'])` (inert buttons do not move); hover colour `--dur-instant`. Rail tiles and project tiles: no press scale (they are navigation).
- Focus ring: instant (existing `--ring`).
- Segmented controls (`project-kind` radios, `Tabs`-like chips): selected background `--dur-fast`, no slide.
- Reduced: the global rule makes the press a one-frame scale; acceptable (it is the user's own action).
- Owner: `components/ui/Switch.tsx`, `Checkbox.tsx`, `Button.tsx` (CSS only if the DOM already has thumb and tick), `styles/controls.css`, `styles/ui.css`. Kind: CSS.

### 3.17 Skeletons and loading (inventory 15 area)

- Large areas: opacity pulse 0.6 to 1 over `--dur-pulse` (the one loop rate), no shimmer sweep. Small chips: static. Replacement of a skeleton by content: content `motion-fade` `--dur-fade`; the skeleton leaves at once.
- Spinners (`spin`) keep their period (1 s linear is a rotation, not a pulse). Do not show a spinner over readable content.
- Loading that finishes in under 200 ms shows no skeleton at all (delay the skeleton by 200 ms with `animation-delay` on its opacity from 0 to 1 so a fast load never flashes): `.skeleton { animation: motion-fade var(--dur-fade) backwards; animation-delay: 200ms }`.
- Reduced: skeletons are static (global rule already).
- Owner: `styles/ui.css` (`.skeleton`), `styles/global.css` (`.skeleton` reduce rule stays), callers keep markup. Kind: CSS.

### 3.18 Live cues unified (inventory 15)

- One period: every working mark, tab status dot, node halo, band mark and breathing dot uses `--dur-pulse` (1800 ms). The five `breathe` uses at 1 s, 1.4 s, 1.5 s, 1.6 s (run.css 114 and 260, run-tabs 133, shell 81 and 451, ui 362) change to `animation: breathe var(--dur-pulse) var(--ease-in-out) infinite`; run.css:260 loses its 1 s.
- Amplitude: keep `breathe` at opacity .45 to 1 and scale .97 to 1.03; that is within the 8 % / 0.3 rules? Opacity range is .55, which exceeds the 0.3 guideline; change the keyframe to opacity 0.7 to 1 (amplitude 0.3) and keep scale. `dash-breathe` is merged into `breathe` (one keyframe, one amplitude); delete `dash-breathe` after the dashboard owner migrates.
- Phase: stagger by `animation-delay: calc(var(--i) * 150ms)`, `--i` set inline, at most 12 breathing elements per screen (the band's `data-breathe` cap applies on every surface; the canvas breathes at most the first 12 working nodes in DOM order, the rest are static with the colour and word).
- Waiting on the user: a static amber state, plus the one-shot ring of 3.8. Never a loop.
- Reduced: `animation: none`, halos `display: none` where decorative (existing).
- Owner: `styles/global.css` (the `breathe` keyframe), the five stylesheets above, `styles/dashboard-band.css`. Kind: CSS (the cap on canvas nodes is REACT in the node component: `data-breathe` only for index < 12).

### 3.19 Knowledge list rows and detail (inventory: Knowledge)

- Rows appended by `onEngagementChanged` while the tab is open: `.motion-enter` `--dur-base` (arrival rule; the first render and filter changes never animate). Selection and focus are instant. Rows never re-sort, so no FLIP.
- Detail panel open: SidePanel behaviour of 3.6; its content `.motion-view`.
- `knowledge-notice` and `knowledge-status`: banners (3.10); the status span fades `--dur-fade`.
- List to Graph switch: `.motion-view` on the new body (`--dur-fade`).
- Graph engine: out of scope (its own loop). Its `neural-card-in` 80 ms becomes `--dur-fade`.
- Reduced: none.
- Owner: `components/knowledge/KnowledgeList*.tsx`, `views/KnowledgeView.tsx` (REACT: `isNew`), `styles/knowledge.css`, `knowledge-neural.css` (token swap only). Kind: REACT (small).

### 3.20 Also worth doing (small, mostly CSS)

- Account popover and project row selection indicator: selected row background `--dur-fast` (no movement).
- Client group collapse in the sidebar (`nav-client-group`): `.motion-collapse` `--dur-base`, chevron rotate `--dur-fast` (REACT only if the list unmounts when collapsed).
- Connector tile highlight (`data-highlight`, 2 s) keeps its 2 s but only as a colour fade out; `skill-flash` 1.8 s is shortened to `calc(var(--dur-slow) * 4)` (about 1 s). Delete literals.
- Conversation/agents layout toggle (`run-layout-toggle`): `.motion-view` `--dur-fade` on the stage.
- Composer: send clears the field with no motion (feedback is the new transcript row); the ended-state notice enters `.motion-enter`.
- Settings pane switch and Team role panel: `.motion-view`; the role panel opening is a side panel (3.6).
- History: member rows under the sessions toggle (3.7), Trends bars keep `--dur-slow` width.
- Save indicator, usage bars: unchanged.

## 4. Slice plan (disjoint file lists)

Each slice is mergeable alone, in this order. Shared prerequisites go first so later slices do not touch the same files.

| # | Slice | Files (owned) | Kind |
|---|---|---|---|
| 0 | Foundations | `styles/motion.css` (new, imported in `main.tsx` or global after tokens), `lib/useArrival.ts`, `lib/useExitPresence.ts` (+ unit tests); tokens.css already done by this spec | REACT (hooks only) |
| 1 | Overlays | `components/ui/Dialog.tsx`, `components/ui/Popover.tsx` (only if conditional render found), `styles/ui.css` dialog/popover/backdrop blocks, `styles/menu.css` | CSS + REACT (Dialog exit) |
| 2 | Controls and disclosures | `styles/controls.css`, `components/ui/Switch.tsx`, `Checkbox.tsx` (only if markup lacks thumb/tick), `styles/settings.css`, `styles/canvas-settings.css`, `styles/mcp.css`, `styles/ui.css` `details`/skeleton blocks (coordinate: slice 1 owns the dialog/popover blocks, slice 2 owns the rest, split the file by comment markers), `components/history/*` sessions toggle | CSS (+ small REACT) |
| 3 | Navigation | `components/ui/Tabs.tsx`, `styles/ui.css` tabs block, `components/RunTabs*.tsx`, `styles/run-tabs.css`, `App.tsx` / `ProjectShell` view-root class, `styles/shell.css` sidebar rules, `lib/useSidebarCollapsed.ts`, `components/layout/SidePanel.tsx`, `styles/layout.css` | REACT |
| 4 | Banners, tray, needs | `components/ui/Banner.tsx`, `components/DecisionCard.tsx`, `components/layout/CanvasFrame.tsx`/FrameTray, bell component, `components/dashboard/Needs*`, `AttentionColumn.tsx`, `styles/cards.css`, `styles/dashboard-needs.css` | REACT |
| 5 | Canvas | `components/canvas/*`, node components, `lib/canvasFit.ts`, `views/LiveRunView.tsx`, `views/TeamView.tsx`, `styles/canvas.css`, `styles/flow.css`, `styles/run.css` | REACT |
| 6 | Transcript | `components/TranscriptPanel.tsx`, `styles/transcript.css` | REACT |
| 7 | Dashboard and new project | `views/DashboardView.tsx`, `components/dashboard/RightNowBand.tsx`, `BandRun.tsx`, `ProjectTile.tsx`, `NewProjectForm.tsx`, `RepoStartPanel.tsx`, `TeamFoundPanel.tsx`, `styles/dashboard*.css`, `styles/import.css` | REACT |
| 8 | Knowledge and live cues | `components/knowledge/*`, `views/KnowledgeView.tsx`, `styles/knowledge*.css`, `styles/global.css` `breathe` keyframe plus the five breathe call sites (`shell.css`, `run-tabs.css`, `run.css`, `ui.css`; do this slice after 3 and 5 so those files are not edited twice) | REACT (small) + CSS |

Pure CSS, can go first and in parallel: slices 1 (entry), 2 and the breathe unification (part of 8). Needs React: 0, 3, 4, 5, 6, 7 and exit retention in 1.

## 5. Testing

- e2e never waits on an animation. Selectors and state checks stay as today; a transition must not change when an element is attached, visible or enabled in a way existing waits cannot tolerate. Retained exiting nodes are `inert` and `aria-hidden`, and carry `data-state='out'`; helpers that wait for a thing to be gone use `waitFor` with the existing timeouts (a retained exit adds at most `--dur-fast` = 100 ms, which fits inside Playwright auto-retry).
- e2e runs with reduce-motion on where it matters for timing: `data-reduce-motion='on'` makes every duration 0.01 ms and every entry offset 0, so a test that sets it sees instant state. Add `e2e/lib.mjs` helper `setReduceMotion(page, on)` (writes the appearance setting) and a `motionOff(page)` shortcut.
- Assertions available: `el.getAnimations().length` (under reduce: 0 for finite animations); `getComputedStyle(el).animationName === 'none'` for every live mark under reduce; `getComputedStyle(root).getPropertyValue('--motion-distance')` is `0px` under reduce and `8px` otherwise; `data-*` hooks added by slices (`data-state='out'`, `data-collapsed`, `data-layout-moving`, `data-ping`, `data-breathe`) for CSS-driven states.
- One layout-shift guard per slice walk at 1024x640: no page scroll appears and no sibling moves outside the declared glide (compare bounding boxes before and after a settled state, never mid-transition).
- Each new live cue gets a `data-*` hook and a check that it is absent or `animationName: none` under reduced motion; the breathe cap check counts elements with `animation-name: breathe` (at most 12).
- Unit tests: `useArrival` (first render marks seen, later ids true once, remount does not replay), `useExitPresence` (timer, cancel on re-present, duration from token and ~0 under reduced), and the transcript batch cap.
- By eye (UX walk): both themes, both sizes, reduce motion on and off, a keyboard pass with a dialog opened and closed three times quickly (no stuck dim backdrop, focus returns), a sidebar collapse with the Live canvas open (no per-frame refit), a burst of 30 transcript rows (no stagger, no jank).

## 6. Open decisions

- D1 Reduced fade: zero (recommended) or keep an 80 ms fade (needs editing the global rule).
- D2 View-level crossfade: spec uses a plain `motion-rise` per view root. View Transitions rejected (canvas snapshots, input blocked). Confirm.
- D3 Canvas glide cap: 60 nodes, then snap. Tune after measuring.
- D4 `::backdrop` token inheritance in Chromium 140: verified only from memory; first slice confirms and falls back to `:root` literal durations if needed.
- D5 Whether the bell cue throttle is shared with the polite announcements (spec says 5 s).
- D6 React 19 `<ViewTransition>` is not used (canary only, unchecked for the pinned version).
