OrgAI is a desktop harness where a person runs teams of AI agents. Its interface is dense, calm and dark by default. This system covers the app's foundations and the redesigned **Dashboard** and **Usage** pages. Read `dashboard.md` and `usage.md` for the page designs and `motion.md` before animating anything.

## Voice

- Write plain sentences about the work. The Dashboard's status line is the model: "3 agents are working in 2 runs.", "Nothing needs you."
- Use sentence case everywhere: "Needs you", "Right now", "Runs worth a look". No title case, no exclamation marks, no emoji.
- Address the person as "you". The app never says "I" or "we".
- Status words are fixed: Running, Needs you, Idle, Paused, Finished, Stopped, Failed. Do not invent synonyms.
- "Needs you" counts decisions, never runs: "3 decisions · 1 run".
- An unknown cost is never "$0". Write "Not priced", or a lower bound as "$0.42+".
- Greet by name once, in the Briefing, and nowhere else. Without a saved name, greet with the time of day alone ("Good evening").

## Colour

- Build on four surfaces. The page is `surface-0`; boxed instruments sit on `surface-1`; raised controls and tiles on `surface-2`; tracks and pressed fills on `surface-3`.
- Set copy in `text-primary`, labels in `text-secondary`, counts and axes in `text-tertiary`. `text-disabled` is for disabled controls only.
- `accent` fills the primary button and the sliding indicators. Accent-coloured text uses `accent-text`, never `accent`.
- The user picks the accent in Appearance. Never hardcode violet; read `accent`, `accent-text` and `accent-soft`.
- Amber belongs to Needs you alone: `warning-soft` fill, `warning-border` edge, `warning-text` count. Project tiles never tint.
- State colours carry a word or a glyph every time: `state-working` (Running), `state-waiting` (Needs you), `state-done` (Finished), `state-error` (Failed), `state-idle` (Idle, Paused).
- Chart series use `chart-s1` to `chart-s5` in that order, then `chart-other`. Neighbouring fills alternate bright and mid so they differ in lightness. Draw unpriced usage hatched in `chart-unknown`.
- Role colours (`role-1` to `role-8`) tint agent marks and reporting lines. Never set text in a role colour.
- The gradient from `brand-ui-from` to `brand-ui-to` fills meters and the burn dial. Never put it behind text, on borders or on focus rings. The fixed `brand-from` to `brand-to` gradient belongs to the mark.

## Type

- One sans family (`sans`: Segoe UI Variable with system fallbacks) and one mono family (`mono`: Cascadia Code). No font files are bundled.
- Weights are 400 and 600 only.
- Body copy is `body` (13/20). Section headings are `title`. KPI values are `title-lg`; stat card values are `stat`.
- Each page has one large line: the Briefing greeting in `display-lg` on the Dashboard, the period spend in `figure` on Usage. Nothing else on the page is that size.
- Every number that can change uses `font-variant-numeric: tabular-nums` so it never shifts its neighbours. Counts, costs in rows and times are set in `mono`.

## Layout

- Space on the 4 px grid with the `space-*` steps. Cards pad `space-4`; the page gutter is `space-4`, `space-6` from 1100 px.
- Lay pages out with container queries, not viewport queries. The supported window sizes are 1024×640 and 1600×1000.
- One page scroll. Never scroll a column inside the page.
- Box instruments (things that are read as a unit: Needs you rows, Right now, charts). Leave lists unboxed with a `border-default` hairline between rows.
- A region with nothing to say is not drawn. No empty boxes, no "Nothing here" lines; the Briefing sentence says it.
- Radii: `radius-md` for controls, `radius-lg` for tiles and rows, `radius-xl` for cards, `radius-full` for badges, marks and tracks.
- Each page opens with one hero card: `surface-1`, a `border-default` edge, and an aura of `aura-from` (top left) and `aura-to` (bottom right). One per page; no other surface carries a gradient.
- Below the hero, compose a bento grid of cards of unequal size. The biggest card is the thing the person acts on.
- Borders before shadows. `elev-1` appears only on a hovered tile; `elev-2` and `elev-3` belong to popovers and dialogs.

## States

- Hover lifts a fill one surface step. Press scales a button to 0.98 for `dur-instant`.
- Focus is a 2 px solid `focus-ring` outline, offset 2 px (inset -2 px inside a tile's own hit area). Selection never looks like focus: it adds a shape cue (a 2 px bar or a weight change).
- A pressed toggle changes its label to `text-primary` at weight 600 as well as moving the indicator, so the state never lives in motion alone.
- A sent answer locks its row (`aria-disabled`, focus kept) until the result arrives.

## Iconography

- Icons are `lucide-react` 1.70.0 through `components/ui/Icon`, at `icon-xs` 12, `icon-sm` 14, `icon-md` 16 and `icon-lg` 20 px. The previews here load the Lucide web build as a stand-in for the same glyphs.
- Icons accompany a label. An icon-only button needs a `label`.
- No emoji, no decorative illustration. The only brand artwork is the mark (`assets/Logos`).

## Personalisation

- The Dashboard belongs to the person using it. Greet them, lead with what changed since they were last here, pin their projects first, and keep the sections in the order they chose.
- Personal choices are remembered per install and never block the page: with nothing saved, the default order and no name still read well.
- Personalisation never hides a decision. Needs you cannot be hidden, reordered below the fold or collapsed.

## Scope

Tokens for the canvas backdrops, the knowledge graph and Pocket Office live in the app's `tokens.css` and are not part of this system.
