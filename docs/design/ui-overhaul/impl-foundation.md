# UI overhaul: Foundation implementation notes

Area: tokens, global and motion styles, shared primitives (`components/ui`), decision cards and tray. Boards:
`project/tokens.css`, `Components.dc.html`, `ComponentsLight.dc.html`. Branch `worktree-agent-a8f37efa01be9630f`.

## Token contract (`src/renderer/src/styles/tokens.css`)

Re-valued in all three theme blocks (dark `:root`, light, system-light); the three blocks still define the same set
(`tokens.test.ts`).

| Token | Dark | Light / system-light | Note |
| --- | --- | --- | --- |
| `--surface-0` | `#0b0d12` | `#f4f5f9` | Unchanged: equals main's `THEME_BACKGROUND` (window colour before paint). The board's `#0a0c14` / `#eef0f7` are within a hair. |
| `--surface-1/2/3` | `#131722` / `#1a1e2c` / `#232839` | unchanged | Opaque. `--surface-2` is the board's `--panel`. |
| `--field-bg` | `#1f2330` | `#f3f4f8` | Board `--sunk`, as an opaque value (tests and `--border-input` need hex). |
| `--border-subtle/default/strong` | white 9 / 13 / 19 % | ink 10 / 15 / 22 % | Translucent lines, as on the board. `--border-input` stays hex (`#737d99` / `#7d869b`, 3:1 on the field). |
| `--text-primary/secondary/tertiary` | `#eef0f7` / `#bcc3d3` / `#a3acc0` | `#12151f` / `#444c60` / `#596277` | Dark tertiary lifted from the board's `#99a2b6` to pass 4.5 on glass at the violet corner. |
| `--accent` (+hover/active/text) | `#6a59f0` / `#7767ff` / `#5444d8` / `#b6acff` | `#5b4be0` / `#4f3fd4` / `#4535c0` / `#4a3bd0` | Board `--primary` and `--accent-text`. The user's accent override (`lib/theme.ts`) is unchanged and still writes these inline. |
| `--success/-text` | `#34c08a` / `#52d6a0` | `#12a06f` / `#0c6b47` | |
| `--warning/-text` | `#f5a623` / `#f5b260` | `#e08a00` / `#944705` | Amber = waiting on you. |
| `--danger/-text` | `#ff6b6b` / `#ff8a80` | `#d9363e` / `#b3261e` | |
| `--info/-text` | `#4cc9f0` / `#6fd3f3` | `#0a84ad` / `#086a8c` | Info is now cyan, the same hue as working. |
| `--elev-1/2/3` | board `--shadow` recipe | board light recipe | Keep the 1 px ring so existing popovers keep an edge. |

New names: `--bg-art` (ambient ground, the board's three radial gradients), `--glass`, `--glass-strong`,
`--glass-line`, `--glass-blur` (a `backdrop-filter` value), `--working`, `--working-soft`, `--working-text`,
`--glow-working` (global box-shadow; `.agent-node` / `.role-node` keep their role-coloured override in section 5),
`--eng`, `--eng-soft`, `--eng-line`, `--dot` (dot-grid colour, the board's `--dot`), and invariant `--font-display`
(Space Grotesk stack) and `--font-serif` (`Fraunces`, Iowan Old Style, Palatino Linotype, Georgia). `--state-working`
now reads `--working`. The legacy alias block (section 6) is unchanged (`--panel` there is still `--surface-1`; use the
app names). Canvas backdrop tokens (section 7) and the Terminal island are unchanged.

Utilities (`ui.css`): `.glass` (glass fill, blur, glass line, `--elev-2`) and `.glass-strong` (the more opaque fill for
floating chrome).

### Contrast (measured, WCAG 2.x)

Computed from the token values (script in `tokens.test.ts`, which now checks the glass cases). Worst case is glass over
the brightest point of the ground (the violet corner, unblurred):

| Text | Dark glass / glass-strong | Light glass / glass-strong |
| --- | --- | --- |
| primary | 9.82 / 14.36 | 16.15 / 17.22 |
| secondary | 6.33 / 9.25 | 7.61 / 8.11 |
| tertiary | 4.91 / 7.18 | 5.42 / 5.77 |
| accent text | 5.50 / 8.04 | 6.59 / 7.02 |
| success / warning / danger text | 6.12 / 6.08 / 4.90 (glass) | 5.80 / 5.89 / 5.80 (glass) |
| working text | 5.81 (glass, `#4cc9f0` value; `#6fd3f3` is higher) | 5.40 |

On the plain ground (no violet): dark glass primary 15.29, tertiary 7.64; light glass primary 17.63, tertiary 5.91.
White on `--accent`: 4.88 dark, 5.97 light. `--border-input` on `--field-bg`: 3.25+ dark, 3.26 light. The existing
surface, soft-fill badge and focus-ring checks in `tokens.test.ts` all pass with the new values.

Review round 2 changes (values only; token names unchanged):

- Light `--glass-line` is now `rgb(24 28 56 / 0.12)` in both light blocks (was white at 95 %, no edge on near-white
  glass). It is a decorative soft edge (about 1.3:1, estimated, not a script measurement). A clickable card tile
  (`.card` as button, link or role=button) takes `--border-input` (3:1) in `controls.css` because its boundary is the
  only cue.
- New glass checks in `tokens.test.ts` (worst case, violet corner): every tone's text on its own soft fill on glass at
  4.5, `--focus-ring` on glass at 3, `--border-input` on glass at 3. They found two real failures, fixed by values:
  dark `--danger-text` `#ff8a80` to `#ff9a92` (danger soft badge was 4.12) and dark `--border-input` `#737d99` to
  `#8089a6` (was 2.73 on glass; field and surface-2 pairs only get better).
- `--sheen` is a themed token (white 35 % dark, 55 % light); `.motion-sheen` uses it.
- `.agent-node` / `.role-node` no longer override `--glow-working`: working is cyan (owner decision 1); the role colour
  stays on the node's role border and other cues. No test or e2e asserted the role glow.
- `.ui-chip.is-selected` has a forced-colors rule (Highlight fill, HighlightText, outline).
- The quiet Deny on decision cards has a resting `--danger-border` border.
- `--panel` legacy alias stays `--surface-1` (existing TSX); the design boards mean `--surface-2`. Comment warns.

Known limits: the tray's breathing dot stops only under reduced motion (the app's reduce-motion setting), because only
the dashboard sets `[data-motion-paused]`. CLI `running` and `identityCyan` are close in light as well as in dark, so
the two must not be the only distinction between a running CLI and an identity mark.

## Display font

Space Grotesk (variable, weight 300 to 700) is bundled at `src/renderer/src/assets/fonts/SpaceGrotesk-Variable.ttf`
with the OFL 1.1 text (`SpaceGrotesk-OFL.txt`) and provenance and SHA-256 in `assets/fonts/PROVENANCE.md`. Loaded by
`@font-face` in `global.css` from the bundle (CSP `font-src 'self' data:` already allows it; no CSP change, no runtime
fetch). Used by `h1`-`h3`, dialog titles and empty-state titles through `--font-display`. Fraunces is not bundled:
`--font-serif` falls back to the system serif stack (Open item).

## Global and motion styles

- `global.css`: `body` paints `--bg-art` (fixed); `html` keeps `--surface-0` so the first paint and window colour match
  main. Headings use `--font-display`. Selection colour from the accent. Scrollbar thumbs no longer draw a
  `--surface-0` border (transparent, clipped), so they sit on glass.
- `motion.css` "Live cues": `.motion-pulse` (working dot: a ring of `--pulse-color`, default `--working`, expands and
  fades on `::after`), `.motion-breathe` (waiting: opacity 1 to 0.45 at `--dur-pulse`), `.motion-flow-v` /
  `.motion-flow-h` (a reporting line carrying work: dashes in `--flow-color`), `.motion-sheen` (indeterminate working
  bar), `.motion-lift` (hover lift by half the small motion distance with `--elev-2`), `.motion-rise` (arrival rise with
  the shared stagger). Loops stop: under reduced motion (system or `data-reduce-motion='on'`, `animation: none`) and
  under any ancestor `[data-motion-paused]` (each surface's Pause motion toggle sets it). Durations derive from the
  motion tokens. The state never depends on motion: the same element also carries a word or a static colour.

## Shared primitives

`controls.css` and `ui.css`, props and markup unchanged unless listed:

- Button: secondary is glass with a strong line; primary the violet fill (semibold); ghost transparent; danger a soft
  red fill; 32 px (26 px small); press scales to 0.97. Disabled stays the neutral flat style (readable, not a dimmed
  colour) instead of the board's 45 % opacity.
- Fields: `--field-bg`, `--border-input`, focus is an accent border plus a 3 px `--accent-soft` ring,
  `aria-invalid='true'` paints the danger border. Placeholders use `--text-tertiary`.
- `.card`: a glass panel, radius `--radius-xl`.
- Badge: neutral uses `--field-bg`, semibold; new tone `working` (`BadgeTone` gains `'working'`).
- Banner: glass-strong base, soft tone fills unchanged, radius `--radius-lg`.
- Dialog, Popover, ContextMenu: `--glass-strong` with blur and a glass line; dialog radius `--radius-xl`; dialog title
  in the display face; menu items highlight with `--accent-soft`.
- IconButton, Checkbox (radius `--radius-xs`), EmptyState title face, keyboard shortcut keys.
- New `.kbd-hint` class for key hints inside buttons and menu items.
- New `components/ui/Chip.tsx` filter chip: `{ selected?, onClick?, children, count?, tone?: 'neutral' | 'accent' |
  'working' | 'warning' | 'success' | 'danger', disabled?, className?, 'aria-label'?, 'data-testid'? }`. Native
  `<button type="button" aria-pressed>`; class `ui-chip` (`.chip` is the older static label).

## Decision cards

One look for every kind (`cards.css`, `DecisionCard.tsx`): near-opaque panel with the glass blur, amber border, a 3 px
amber stripe on the left, amber kind chip, 14 px title, a quiet deny (red text, no fill until hover). All kind chips
are amber because every decision waits on the person. Kind names in plain words: "Review and merge" (was "Merge") and
"New tool" (was "MCP install"); the card's accessible name follows (`<kind>: <title>`). Inner code and preview blocks
use `--field-bg`. The usage-limit pause banner gets the same panel. The tray row with several decisions reads
"<n> waiting on you" after a breathing amber dot, on an amber soft row. Behaviour, IPC, focus rules, keyboard paths
and test ids are unchanged; button labels were already plain and stay as they are (e2e and unit tests name them).

Deviations from the board:
- No per-card time ("2 min"), no costs, no "42 of 42 tests pass", no "Reviewer 1 approved", no "allowed 6 times": the
  cards do not receive them. No breakdown ("2 permissions · 1 question") in the tray row yet (derivable only from the
  card nodes, not the tray's items; left out).
- "After you answer" receipt rows with Undo are not built (see Needs runtime).
- `layout.css` (shell) overrides the tray row's background inside the canvas frame tray with an opaque surface; asked
  ov-shell to keep the amber look there.

## Needs runtime

- Per-decision age ("2 min ago") on each card: the renderer has no request timestamp on every pending decision kind.
- "After you answer" receipts with Undo (allow once / denied): no undo for an answered permission exists in main.
- Rule request count ("You have allowed this 6 times in this run") on the rule card.
- Merge review summary (test results, reviewer approval) on the merge card.

## CLI TUI palette (orchestrator-approved scope)

`src/cli/tui/theme.ts` follows the app's text and status hexes (the existing coupling test in `theme.test.ts` stays
strict): dark primary `#eef0f7`, secondary/code `#bcc3d3`, surface `#1a1e2c`, accent `#b6acff`, running `#6fd3f3`, ok
`#52d6a0`, warn `#f5b260`, danger `#ff8a80`; light secondary/code `#444c60`, accent `#4a3bd0`, running `#086a8c`, ok
`#0c6b47`, warn `#944705`, danger `#b3261e`. The existing contrast test (every tone at least 4.5 on the palette surface
and on `#0b0d12` / `#ffffff`) passes. Identity hues are unchanged; dark running (`#6fd3f3`) is now close to
identityCyan (`#64d8e8`), still told apart by glyphs and words.

## Verification

See the report for the final run. Unit: `tokens.test.ts` (new glass contrast and token presence checks), `theme.test.ts`,
CLI tests touched. Environment: `node_modules/ink` is missing in this worktree, so `src/cli/tui/inkVersion.test.ts` and
the CLI component tests that expect colour escape codes fail on the unchanged base as well (checked by running them
with the original `theme.ts`).

## Open

- Fraunces for `--font-serif` (not bundled).
- Screenshots of the cards and primitives in both themes and both sizes; a Reviewer pass (the run hit the concurrent
  agent limit when this was written).
