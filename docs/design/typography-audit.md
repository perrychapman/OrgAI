# Typography audit and proposal (renderer)

Date 2026-11-24, base `dev` at `17a6fbdf`. Status: review only, no product code changed. Owner request: "there are a lot of font
differences across the app ... a consistent font face and style".

Method in one paragraph. Part 1 is a static scan of every CSS file under `src/renderer/src/styles/` (2,514 typographic
declarations in 96 files), the TSX inline styles and the canvas text drawing. Part 2 is measured in the built app
(`npm run build`, `ORGAI_MOCK=1`, throwaway data dir, token-free): a scratch Playwright driver modelled on `e2e/lib.mjs` `launch()`
walked 63 screen states, each at four appearance settings (dark default, light default, dark Large, light Small; 227 screen-states
in all, plus 39 extra states in a second walk), read the computed `font-family`, size, weight, line height, letter spacing,
transform, style and numeric variant of every visible text node (about 13,000 nodes per pass, grouped into distinct combinations)
and asked Chromium which platform face actually drew a sample of each combination (`CSS.getPlatformFontsForNode`). The second walk
added one new combination out of 55, so the first walk covers the type space. The scratch scripts and screenshots were deleted at
the end. The `better-typography` skill is not granted to the UI Engineer role, so only `frontend-design` and the repo's own
guidance were applied.

## 1. Headline numbers

| Measure | Today (default size, dark) | Proposed |
| --- | --- | --- |
| Families requested (first in stack) | 5: Segoe UI Variable, Cascadia Code, Space Grotesk, Fraunces, generic `monospace` | 3 (sans, display, mono) plus one optional bundled serif |
| Platform faces that actually drew text | 7: Segoe UI (regular), Segoe UI Semibold, Cascadia Code, Space Grotesk, Palatino Linotype (stands in for Fraunces), Consolas (browser default for bare `code`/`pre`), Arial (glyph fallback) | 3 (+1) |
| Font sizes | 17 raw values, 13 excluding the 4 decorative file-preview sizes: 12 13 13.5 14 15 15.21 16 20 24 28 30 40 48 | 9: 12 13 14 16 20 24 28 32 48 |
| Weights | 4: 400, 500 (renders as 600), 600, 700 | 2: 400, 600 |
| Distinct line heights | 25 | 9, one per size |
| Distinct (face, size, weight, line height) | 71 (67 without the previews), 90 with letter spacing | about 14 |
| Per screen (median / max) | 17 / 26 combinations, 5 / 8 sizes, 3 / 6 faces | about 8 / 12, 4 / 6, 2 / 3 |
| Share of text by size | 12 px 68.9 %, 13 px 25.4 %, everything else 5.7 % | unchanged shares, on named roles |
| Share of text by face | Segoe UI 85.5 % (regular 55.6, Semibold 29.9), Cascadia Code 9.7 %, Space Grotesk 4.2 %, serif 0.3 % | sans about 86 %, mono under 5 %, display about 6 % |
| Declarations that bypass the tokens | about 110 of 2,514 (4 %): 14 sizes, 27 line heights, 43 weights, 21 letter spacings, 3 uppercase, 1 family | 0 outside the preview and user-content exceptions |

The token layer is healthy. The drift is not hard-coded values, it is what the tokens allow and what they leave undefined:
the base line height is a ratio that overrides the token pairs (section 2, finding 2), the display face and the serif are used
at every size, mono is used for labels and numbers, and the sans stack does not resolve the way it reads.

## 2. Current state in plain words

What is bundled and loaded. Exactly one font file ships: `assets/fonts/SpaceGrotesk-Variable.ttf` (136,676 bytes, weight axis
300 to 700, normal style only, `font-display: swap`, no `unicode-range`), declared once in `global.css`. Weights 400 and 600 (and
the 700 the UA gives `h3` and `strong`) are real instances of it; probing 400/500/600/700 gives four different renderings, so there
is no faux bold. Everything else is the machine's own fonts:

- `--font-sans: 'Segoe UI Variable', 'Segoe UI', system-ui, -apple-system, sans-serif`. On this Windows 11 machine the first entry
  matches nothing (probe: `'Segoe UI Variable'` alone resolves to no face, while `'Segoe UI Variable Text'`, `Display` and `Small`
  do). So all 12 and 13 px text is drawn in the static Segoe UI Regular and Segoe UI Semibold cuts, never the variable optical-size
  font the stack suggests. On macOS and Linux the same stack resolves to the system UI font instead.
- `--font-mono: 'Cascadia Code', 'Cascadia Mono', Consolas, 'JetBrains Mono', monospace`. Cascadia Code has distinct 400, 600 and
  700 renderings here (no faux bold). `JetBrains Mono` is not installed anywhere we ship, and the stack has no macOS monospace
  (Menlo, SF Mono, `ui-monospace`).
- `--font-serif: 'Fraunces', 'Iowan Old Style', 'Palatino Linotype', Georgia, serif`. Fraunces is not bundled (documented open
  item), so engagement headings are Palatino Linotype on Windows, Iowan Old Style on macOS and Georgia or the generic serif on
  Linux: three different serifs for one design role. Palatino and Georgia have only regular and bold, so serif 600 draws as bold.
- Bare `code`, `pre`, `kbd`, `strong`, `b` and `h4` to `h6` have no base rule. They fall to the browser defaults: Consolas for
  `code` (permission rule chips), the generic `monospace` stack for some `pre`, Segoe UI for `kbd`, weight 700 for `strong`
  ("No skills yet"), and the UA size for an unstyled `h3` (15.21 px bold, "Graph styles").

Where each face appears (dark default, 63 screen states): Segoe UI and Segoe UI Semibold on all 63, Space Grotesk on 62, Cascadia
Code on 59, Palatino Linotype on 8 (every engagement screen, the New project dialog and the first-launch form), Consolas on 6.
A typical screen shows three faces and 17 style combinations.

### Role tables

Format: screen (selector): face, size/line height, weight. "SG" is Space Grotesk. All values are computed, dark default; light
and the other text sizes change nothing but the size ramp (theme never changes type: 61 of 63 screen states have identical
combinations in both themes, the other two differ only by a toggled checkbox).

**Page title.** Seven sizes and three faces for one role.

| Screen | Face | Size / lh | Weight |
| --- | --- | --- | --- |
| Shell topbar h1 (Home, Chat, Usage, Schedules, Settings, every project) | SG | 14 / 20.3 | 600 |
| Engagement Team h1 (`team-title`) | Palatino | 14 / 20 | 600 |
| Inbox h1, History, Files, To-dos h2 | SG | 16 / 24 | 600 |
| Welcome step title, agent view name (`agent-focus-name`), role inspector name | SG | 20 / 28 | 600 |
| Settings pane title, New run heading, Tools and Skills helper intro | SG | 24 / 32 | 600 |
| Home hero (`home-hero-title`, literal 30 px) | SG | 30 / 36 | 600 |
| Welcome greeting (`dash-greeting-salutation`, first launch) | SG | 40 / 48 | 600 |
| Engagement hero title (`eng-hero-title`, a `p`) | Palatino | 20 / 28 | 400 |

**Section heading.** Four faces, six sizes, three weights across the same role.

| Screen | Face | Size / lh | Weight |
| --- | --- | --- | --- |
| Home "Working now", Usage "Spend over time", History, New project dialog | SG | 16 / 24 | 600 (tracking -0.16px, but Home "Good afternoon" has 0) |
| Settings "Colour mode" | SG | 16 / 24 | 600 |
| Team "Skills" group, Conversation h2, Team assistant h2 | SG | 13 / 18.9 to 20 | 600 |
| Inbox "Waiting on you", Knowledge "People", Dashboard project group | SG | 12 / 16 to 18 | 600 |
| Settings gallery h3 "Built in", History "Agents" h4 | Segoe Semibold | 12 / 17.4 or 18 | 600 |
| Team "Suggestions from past runs" h4 | Segoe Semibold | 13 / 18 | 600 |
| Engagement Home "What do you need?", every engagement `home-section-title` | Palatino | 14 / 20 | 400 |
| Engagement Live and Team "Conversation" | Palatino | 13 / 18.9 | 600 |
| Code Home "> new run" | Cascadia Code | 12 / 16 | 400 |
| Engagement eyebrow "What this engagement is for" | Segoe Semibold | 12 / 16, uppercase, +0.48px | 600 |
| Settings "Graph styles" h3 (no rule at all) | SG | 15.21 / 22 | 700 |

**Card and item title.**

| Screen | Face | Size / lh | Weight |
| --- | --- | --- | --- |
| Decision card title, first-launch option title | Segoe Semibold | 14 / 20 | 600 |
| Agent node name | Segoe Semibold | 14 / 16.8 (13.5 / 16.2 on the second node style, literal) | 600 |
| Role node name (Team) | SG | 13 / 15.6 | 600 |
| Project tile name (Home) | SG | 14 / 20 | 600 |
| Inbox row, dashboard run row, engagement name | Segoe Semibold | 13 / 20 | 600 |
| Welcome option title | Segoe Semibold | 13 / 18.9 | 600 |
| Provider tier name (Settings > AI providers) | SG | 13 / 18.9 | 600 |
| New project kind card: "Code project" | Cascadia Code | 12 / 17.4 | 600 |
| New project kind card: "Engagement" | Palatino | 14 / 20 | 600 |
| Selected run tab title (project) / (engagement) | SG / Palatino | 12 / 17.4 | 600 |

**Body, label, caption.**

| Screen | Face | Size / lh | Weight |
| --- | --- | --- | --- |
| Transcript assistant and user text, helper lead, dashboard brief | Segoe | 13 / 20 | 400 |
| Sidebar empty note, palette option | Segoe | 13 / 18.9 | 400 |
| Settings and card descriptions, welcome option text | Segoe | 12 / 18 | 400 |
| Checkbox label / checkbox description | Segoe | 13 / 20 and 12 / 20 | 400 |
| Form label (project form, add role) | Segoe | 12 / 17.4, +0.2px | 400 |
| Form legend (project kind) / legend (setup choice) | Segoe Semibold / Segoe | 12 / 17.4 | 600 / 400 |
| Sidebar group label ("Helpers") / client label ("Code") | Segoe Semibold | 12 / 18 and 12 / 16 | 600 |
| Aside label "What you are setting up" | Segoe Semibold | 12 / 17.4, uppercase, +0.72px | 600 |
| Meta lines (decision who, dash hints) | Segoe | 12 / 16 | 400 |

**Chip and badge.** One role, five line heights.

| Screen | Face | Size / lh | Weight |
| --- | --- | --- | --- |
| Badge, mock-mode badge, run-status chip | Segoe Semibold | 12 / 18 | 600 |
| Role model chip, filter chip label | Segoe Semibold | 12 / 17.4 | 600 |
| Project kind chip | Segoe Semibold | 12 / 16 | 600 |
| Run chips ("Model:", "Effort:", "everyday") | Segoe | 12 / 18 or 16 | 400 |
| Avatar initials | Segoe Semibold | 12 / 17.4, +0.3px | 600 |

**Button and tab.**

| Screen | Face | Size / lh | Weight |
| --- | --- | --- | --- |
| Sidebar nav (Home, Inbox) | Segoe | 13 / 18.9 | 400 (600 selected) |
| Sidebar search, secondary buttons | Segoe | 12 / 17.4 | 400 |
| Primary and ghost buttons (Allow once, New schedule) | Segoe Semibold | 12 / 17.4 | 600 |
| Project tabs (Home, Live ...) | Segoe Semibold | 13 / 18.9 | 600 |
| Run dock tabs (Transcript ...) | Segoe Semibold | 12 / 17.4 | 600 |
| Canvas theme trigger | Segoe / Semibold | 13 / 20 | 400 / 600 |
| Home project select (`home-target`) | Segoe Semibold | 13 / 18.9 | 600 (every other select is 400) |

**Table cell.**

| Screen | Face | Size / lh | Weight |
| --- | --- | --- | --- |
| Usage and run-dock Usage cells | Segoe | 12 / 18 | 400 |
| History cells | Segoe | 12 / 17.4 | 400 (cost 600) |
| Usage th / history th | Segoe Semibold / Segoe | 12 / 18 and 12 / 16 | 600 / 400 |
| Permissions table th | Segoe | 13 / 18.9 | 400 |
| Usage sort button | Segoe Variable stack | 12 / 18 | 500 (renders as 600) |

**Numeric and cost.** Tabular figures are applied almost everywhere (569 nodes carry `tabular-nums`, and only three numeric
nodes are proportional: Inbox count badge at 600, Home spend figure, Knowledge group count). The face and size are what drift.

| Screen | Face | Size / lh | Weight |
| --- | --- | --- | --- |
| Usage period spend (`usage-pacing-figure`) | SG | 48 / 56 | 600 |
| Dashboard stat value | Segoe Semibold (no display face) | 28 / 36 | 600 |
| Usage dial percent | SG | 28 / 36 | 600 |
| Usage KPI value, efficiency value | SG | 20 / 28 | 600 |
| Home spend figure | SG | 20 / 28 | 600, no tabular |
| Usage readout, History stats, New run estimate | SG | 14 to 16 | 600 |
| Run meta cost, history cost cell | Segoe Semibold | 12 / 16 and 12 / 17.4 | 600 |
| Usage legend and table cost | Segoe | 12 / 18 | 400 |
| Dashboard run line cost, agent token count, "6 runs" totals | Cascadia Code | 12 / 17.4 | 400 |
| Run index "R1" in the sidebar, run tabs, decisions, run header (about 760 nodes) | Cascadia Code | 12 / 18, 12 / 17.4 | 600 |

**Code.**

| Screen | Face | Size / lh | Weight |
| --- | --- | --- | --- |
| Permission command, tool details, diagram source and error | Cascadia Code | 12 / 16 to 18 | 400 |
| Permission rule chip (`code`, no rule) | Consolas | 12 / 17.4 | 400 |
| Some tool-detail `pre` | generic monospace | 12 / 16 | 400 |
| `kbd` hints ("Ctrl K", "J", "Esc") | Segoe, not mono | 12 / 16 | 400 |
| Project and folder paths, model ids | Cascadia Code | 12 / 16, 12 / 17.4 or 12 / 18 | 400 |

**Transcript text.** Assistant and user text 13 / 20 regular; tool label ("Ran `cd ...`", "Handed work to ...") 12 / 16;
"You" tag 12 / 20 semibold; agent meta line 12 / 18; logs 12 mono; user message time is inside the tag. Transcript is the best
aligned surface, with one real fault: the tool label is 12 / 16 next to 13 / 20 body, a 4 px line-height step inside one entry.

**Input text.**

| Screen | Face | Size / lh | Weight |
| --- | --- | --- | --- |
| Project form inputs, add-role, todo add | Segoe | 13 / 18.9 | 400 |
| Selects (template, scope, usage sort) | Segoe | 13 or 12 / normal | 400 (home-target 600) |
| New run, engagement start, agent message | Segoe | 13 / 20 | 400 |
| Home task box (`home-task`) | Segoe | 15 / 22 | 400 |
| Mono inputs (paths) | Cascadia Code | 12 / 17.4 | 400 |
| Diagram source textarea | generic monospace | 12 / 18 | 400 |

### Text size setting

`data-text-size` rewrites 11 tokens only (caption, small, body, title-sm, title, title-lg, mono and their line heights, 1 px steps
at Small, 1 to 2 px at Large). Measured: 12 px text becomes 11 / 14 px, 13 px becomes 12 / 15 px, 16 becomes 15 / 18, 20 becomes 19 / 22.
It does not scale `--text-display`, `--text-display-lg`, `--text-stat`, `--text-figure`, any hard-coded size (the 30 px hero,
13.5 px, the 14 px Knowledge card), the neural graph canvas labels (fixed 12 px) or the Team edge labels (inline 11 px). At Large,
page titles (24) sit 2 px above panel titles (22), so the hierarchy flattens, and caption and small are 13 and 14 although they
are the same size at default and at Small.

## 3. Inconsistencies, ranked

### High (different face or clearly different size for the same role)

1. **Page titles use seven sizes and three faces.** See the page title table. On Home alone the topbar says "Home" at 14 px,
   the hero says 30 px (returning user) or 40 px (first launch), and the engagement Team heading is 14 px serif beside a 14 px
   display topbar title. Source: `home.css`, `dashboard-home.css`, `settings.css`, `new-run.css`, `inbox.css`, `onboarding.css`,
   `agent-focus.css`.
2. **Line height is not the token.** `body` sets `line-height: 1.45` (a ratio) and 629 of the 1,173 rules that set a token
   `font-size` set no `line-height` (54 %), so they inherit the ratio instead of the paired token. Result: 12 px text has four line
   heights in use (16, 17.4, 18 and 20 px; 4,855 nodes at 17.4), 13 px has three (18.9, 20, 18), 14 px has three (20.3, 20, 16.8),
   16 px two (24, 23.2). Neighbouring controls of the same size are 0.6 px apart and row heights are fractional. 15 rules pair a
   size token with a different line height token (for example `.dash-stat-value[data-word]` takes the title size with the stat
   line height). Source: `global.css`
   body rule; worst files `settings.css` (56 rules), `home.css` (31), `import.css` (29), `transcript.css` (28), `cards.css` (26).
3. **The same role is drawn in different faces: numbers.** Costs and counts appear in Segoe regular, Segoe Semibold, Cascadia Code
   and Space Grotesk at 12, 14, 16, 20, 28 and 48 px. The dashboard stat value (28 px) is Segoe Semibold while the Usage dial
   percent (28 px) is Space Grotesk. Source: `dashboard-week.css`, `dashboard.css` (`.dash-num` in mono), `usage-*.css`, `home.css`.
4. **Kind cards disagree with each other.** In the New project dialog and the first-launch form, "Code project" is Cascadia Code
   12 px 600 and "Engagement" is Palatino 14 px 600, side by side in one radio group. Likewise Home section headings are
   `> new run` in mono (code) versus 14 px serif regular (engagement) versus 16 px display (everywhere else). Source:
   `onboarding.css`, `home.css`. Note `e2e/home-checks.mjs` asserts the mono and serif choices today.
5. **The display face leaks below heading size and misses real headings.** Space Grotesk is drawn at 12 and 13 px in the
   Conversation h2, Team assistant h2, catalog group titles, Inbox section titles, Knowledge group titles, role node names,
   provider tier names, the selected run tab title and the agent-view "Where it sits" label, next to Segoe Semibold headings of the
   same size (settings gallery h3, History section h4, Skills evaluation h4). Both kinds exist inside single panels.
6. **The engagement serif is not one font.** It is Palatino here, Iowan Old Style on macOS and Georgia on Linux, used at 12 to 20
   px in tab titles, kind cards, `Conversation`, section headings and a hero title that is a `p`; headings are weight 400 in
   engagement Home and 600 elsewhere in the same view. Source: `home.css`, `onboarding.css`, `run-tabs.css`, `canvas-chrome.css`,
   `teamHeader.css`, `import.css`, `knowledge.css`.
7. **Reading size is two sizes with no rule.** The root is 13 px (`--text-body`) but 12 px is 69 % of all text. Sidebar nav and
   project tabs are 13 px, the sidebar search, dock tabs and buttons are 12 px, the checkbox label is 13 px and its description 12 px,
   form inputs 13 px but the Home task box 15 px, run-chip labels 12 px beside 13 px run text.

### Medium (weight, line height, letter spacing)

8. **Mono is used as a label, not just for code.** 1,262 mono nodes (9.7 %): run indexes "R1" at weight 600 in four places
   (about 760 nodes, in line heights 17.4 and 18), token counts, `dash-num`/`dash-count`, project folder, the "Code project" kind
   title, the agent node role slug, `.run-tab-index`. Bare `code`, `pre` and `kbd` get Consolas, the generic monospace or Segoe.
9. **Weight drift.** `--weight-medium` is an alias for 600 used by 26 declarations, so the name lies; two literal 500s and one 700
   exist; `strong` and an unstyled `h3` draw at 700; weight 500 on Segoe renders as 600 (probe). 43 literal `600`/`400` declarations
   skip the token (`kit.css` 4, `run-hold.css` 5, `usage-tab.css` 3, `team.css` 3, `outputs-edit.css` 3).
10. **Three tracking systems.** Display headings use -0.01em or -0.02em (sometimes 0: Home "Good afternoon", role inspector name),
    form labels +0.2 px, avatars +0.3 px, uppercase eyebrows +0.04em to +0.06em (12 nodes in `onboarding.css`, `home.css`), against
    the guidance that hierarchy comes from scale, weight and spacing and not uppercase micro-labels.
11. **Sans stack is partly dead and OS-dependent.** The first entry, `'Segoe UI Variable'`, matches nothing, and macOS and Linux
    draw SF or `system-ui` instead of Segoe. The same screen is a different font per OS; across screens on one OS it is consistent.
12. **Text size does not scale the whole ramp** (see the text size section).

### Low (one-offs and sub-pixel)

13. Literal values: 14 sizes (30, 15, 14, 13.5, 11, preview sizes, `cqw` slide sizes), 27 line heights, 21 letter spacings.
    `13.5px` in `run.css`, `30px`/`15px` in `dashboard-home.css`, `14px` in `knowledge-neural.css`.
14. Decorative file previews draw 4.85, 8, 8.9 and 9 px text (`outputs-view.css`, `outputs-slides.css`). They are `aria-hidden`
    thumbnails of user content; keep them out of the scale.
15. `var(--font-body, inherit)` in `outputs-compare.css` names a token that does not exist; `var(--ri-heading)` is a local alias.
16. Three numeric nodes lack tabular figures (Segoe 600 digits and Space Grotesk digits are proportional, verified: "1111" is 32 px
    against "0000" 44 px at Semibold 20 px, and 35.5 against 51.7 in Space Grotesk; regular Segoe is tabular by default).
17. Canvas text: only the Knowledge graph draws text on a canvas (12 px, root family); Pocket Office, the Factory Floor and the
    org chart draw labels as DOM text. `TeamView.tsx` passes `fontSize: 11` for edge labels.

## 4. Proposed type system

Principles: one sans for everything that is read or operated, the display face only for headings and figures at 14 px and above,
mono only for code and literal strings, serif (if kept) only for engagement titles at 16 px and above, two weights, one line
height per size, tabular figures for any number that is compared or changes.

### Roles

| Role | Token (today to proposed) | Face | Size / lh | Weight | Tracking | Used for |
| --- | --- | --- | --- | --- | --- | --- |
| Figure | `--text-figure` (exists) | display, tabular | 48 / 56 | 600 | -0.02em | the one period spend on Usage |
| Hero | `--text-display-lg` renamed `--text-hero`, 40 to 32 / 40 | display | 32 / 40 | 600 | -0.02em | Welcome greeting and Home hero (one per page) |
| Stat | `--text-stat` (exists) | display, tabular | 28 / 36 | 600 | -0.01em | dashboard stat value, dial percent |
| Page title | `--text-display` (exists) | display | 24 / 32 | 600 | -0.01em | Settings pane, New run, helper intro |
| Panel title | `--text-title-lg` (exists) | display | 20 / 28 | 600 | -0.01em | welcome step, agent view name, role name, empty-state title, KPI value (tabular) |
| Section title | `--text-title` (exists) | display | 16 / 24 | 600 | -0.01em | Home, Usage, History, Files, To-dos, Inbox, dialog titles |
| Chrome title | `--text-title-sm` (exists) | display | 14 / 20 | 600 | -0.01em | shell topbar h1, card h3 |
| Body | `--text-body` (exists) | sans | 13 / 20 | 400 | 0 | transcript text, descriptions that are read, inputs, sidebar nav, project tabs |
| Body strong | same token | sans | 13 / 20 | 600 | 0 | item titles in rows and cards (decision, inbox, run, node names), labels above fields |
| Small | `--text-small` (exists) | sans | 12 / 18 | 400 / 600 | 0 | secondary text, table cells and headers, buttons, dock tabs, form labels, chips |
| Caption | `--text-caption` (exists) | sans | 12 / 16 | 400 / 600 | 0 | single-line chrome only: chips, badges, kbd, counts, meta |
| Mono | `--text-mono` (exists) | mono | 12 / 18 | 400 only | 0 | code, commands, paths, model ids, logs |
| Serif title (optional) | `--text-title`, `--text-title-lg` | serif | 16 / 24, 20 / 28 | 400 or 600 (pick one) | -0.01em | engagement hero title and engagement Home sections only |

Sizes: 12 13 14 16 20 24 28 32 48 (nine). Weights 400 and 600. Line heights 16 18 20 24 28 32 36 40 56. Bold is never 700 and never
500: add `strong, b { font-weight: var(--weight-semibold) }` and give `h1` to `h6` an explicit weight in `global.css`.

Face rules (testable):

- Display face: a heading element (`h1` to `h3`, dialog and empty-state titles) at 14 px or more, plus figures (stat, KPI,
  period spend) with tabular figures. Never on a button, tab, chip, node name, list row or anything under 14 px. Headings under
  14 px (Conversation, group titles, History "Agents", eyebrows) become Body strong or Small strong in sans.
- Serif: engagement only, titles at 16 px and above, one face on every OS (bundle it or drop the serif; owner decision 3).
  Not on tabs, kind cards, labels, `Conversation` or anything under 16 px.
- Mono: code, commands, file paths, shell output, model ids, logs. Not run indexes, counts, token totals, kind names, section
  labels or a number that only needs alignment. Those become sans tabular. Give `code`, `pre`, `kbd` and `samp` a base rule
  (`font-family: var(--font-mono)`, size and line height of `--text-mono`) so no element falls to Consolas.
- Uppercase: none. The three uppercase rules become sentence case Small strong in the secondary text colour.

Numeric rules: every cost, count, token total, duration, percent and table figure uses tabular figures: `.tabular` plus the
`Cost` component, and `font-variant-numeric: tabular-nums` in the display roles that hold numbers (Segoe at 600 and Space
Grotesk both have proportional digits by default, regular Segoe does not, so rely on the declaration, not the face). Costs are
Body or Small in sans, and Stat or Figure in display only where they are the point of the card; one cost never switches
face between screens.

Minimum sizes: 12 px at the default text size, 11 px at Small (the existing floor); nothing below 11 px outside `aria-hidden`
file previews. Remove 13.5 px, 15 px, 15.21 px and 30 px.

Line heights: one per size. A px token on `body` would be inherited as that fixed height by every child, so the base stays a
ratio but moves from 1.45 to 1.5, which gives 18 px at 12 px, 24 px at 16 px and 19.5 px at 13 px (within half a pixel of the
20 px token) for every rule that sets a size and no line height. The token pair stays where a rule needs a fixed height
(caption 16, controls, display roles), and the guard test (slice 6) requires new rules to pair them.

Sans stack: `'Segoe UI Variable Text', 'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif` (Text is the real
family name; Display is for 20 px and above, only if the display role ever stops using Space Grotesk). Mono stack:
`'Cascadia Code', 'Cascadia Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace` (drops `JetBrains Mono`, adds the macOS
faces so the mac fallback is deliberate).

### How `data-text-size` scales it

Keep the 1 px (Small) and 1 to 2 px (Large) steps for the sans ramp. Make caption equal small in pixels at every setting (they
differ only in line height). Add the display ramp to both attribute blocks so the hierarchy survives; values to tune by eye:

| Token | Small | Default | Large |
| --- | --- | --- | --- |
| `--text-hero` | 30 / 38 | 32 / 40 | 36 / 44 |
| `--text-stat` | 26 / 34 | 28 / 36 | 32 / 40 |
| `--text-display` (page title) | 23 / 30 | 24 / 32 | 27 / 35 |
| `--text-figure` | 48 / 56 | 48 / 56 | 52 / 60 |

No size may be hard-coded; a rule that needs another size picks a role. `tokens.test.ts` already asserts the three theme blocks
define the same tokens; add the same check for the two text-size blocks.

### Tokens to add, rename or remove

- Add: `--text-hero` (+ `-lh`, `-ls`); display-ramp overrides in the two `data-text-size` blocks; `--tracking-display: -0.01em`
  and `--tracking-hero: -0.02em`, so the 21 literal letter spacings have somewhere to go.
- Rename: `--text-display-lg` to `--text-hero` (2 users, keep an alias one release).
- Remove: `--weight-medium` (26 users move to `--weight-semibold`); the `--font-body` fallback in `outputs-compare.css`.
- Change values: `--font-sans`, `--font-mono`, `--font-serif` (if bundled, see owner decision 3).

## 5. Migration plan

Slice 0 lands first and alone. Slices 1 to 5 touch disjoint files and can merge in any order after it. Slice 6 lands last.
Counts are rules or declarations to change by hand; "pair" is the optional mechanical addition of `line-height: var(--text-X-lh)`
to a rule that sets a size token and no line height, which the new base ratio makes unnecessary for correctness.

| Slice | Files | Changes | Checks that cover it |
| --- | --- | --- | --- |
| 0 Foundation | `styles/tokens.css`, `styles/global.css`, `styles/tokens.test.ts` | about 45: two font stacks, `--text-hero`, display ramp in two blocks, caption equals small, tracking tokens, remove `--weight-medium`, base `line-height: 1.5`, base rules for `strong`/`b`/`h1`-`h6`/`code`/`pre`/`kbd`/`samp`, `font-display` swap kept; the test gains text-size block parity and weight checks | `tokens.test.ts`, `typecheck`, `layout.mjs` (every screen reflows by under 1 px), `menu.mjs` |
| 1 Shell and primitives | `ui.css`, `controls.css`, `shell.css`, `layout.css`, `menu.css`, `palette.css`, `banners.css`, `motion.css`, `instruments.css`, `updates.css`, `mcp-install.css` | 8 required (2 `weight-medium`, 2 literal weights, 2 letter spacings, 1 literal line height, 1 numeric weight) + 10 mono rules to review (`.mono`, `.code-block`, `kbd` stay; account and chip counts move) + 47 pair | `layout.mjs`, `menu.mjs`, `context-menus.mjs`, `updates.mjs`, `self-help.mjs`, `motion.mjs` |
| 2 Home, first run, inbox | `home.css`, `onboarding.css`, `dashboard.css`, the 11 `dashboard-*.css`, `new-run.css`, `assistants.css`, `inbox.css`; `e2e/home-checks.mjs`, `e2e/limits-checks.mjs` | 28 required (7 serif, 8 letter spacings, 3 uppercase, 2 sizes, 4 line heights, 3 medium, 1 weight) + 21 mono rules to review (about 12 move to sans tabular: `dash-num`, `tile-chip`, `project-tile-runs-n`, kind titles) + 106 pair; Home hero to the hero token; stat value to display; kind cards aligned | `dashboard.mjs`, `engagement.mjs`, `engagement2.mjs`, `run-start.mjs`, `assistants.mjs`, `per-project.mjs`, `clone-start.mjs`; update the face assertions in `home-checks.mjs` (lines 74-80, 218-230) and `limits-checks.mjs` (line 175) in the same change |
| 3 Run view and decisions | `run.css`, `run-header.css`, `run-hold.css`, `run-settings.css`, `run-tabs.css`, `transcript.css`, `agent-focus.css`, `cards.css`, `permissions.css`, `proposals.css`, `live-model-switch.css`, `office.css`, `factory*.css`, `flow.css`, `canvas*.css`, `editor.css` | 31 required (11 literal line heights, 11 literal weights, 4 medium, 2 serif, 1 size 13.5, 1 spacing, 1 numeric weight) + 31 mono rules to review (run index, agent node sub and foot, token counts move to sans tabular; code stays) + 133 pair; display off the selected run tab title, role node name, Conversation h2 | `runs.mjs`, `run-hold.mjs`, `permissions.mjs`, `model-switch.mjs`, `transcript-media.mjs`, `office.mjs`, `pocket-office.mjs`, `factory-floor.mjs`, `canvas.mjs`, `live-changes.mjs` |
| 4 Data views | `usage*.css` (9), `history*.css`, `schedules.css`, `todos.css`, `outputs*.css` (10), `knowledge*.css` (4); `components/knowledge/neuralEngine.ts` (font size from a token) | 61 required (11 literal sizes, 10 line heights, 14 weights + 6 numeric, 11 medium, 7 letter spacings, 1 serif, 1 display-small) + 11 mono to review + 134 pair; previews and slide runs documented as exceptions | `usage.mjs`, `usage-app.mjs`, `schedules.mjs`, `todos.mjs`, `todos-edge.mjs`, `outputs*.mjs` (4), `knowledge*.mjs` (3) |
| 5 Settings, team, connections | `settings.css`, `connections.css`, `connectors.css`, `mcp*.css`, `skill-library.css`, `model-prices.css`, `project-connection.css`, `kit.css`, `import.css`, `team*.css` (5), `roleEditor.css`; `views/TeamView.tsx` (edge label size) | 28 required (15 literal weights, 6 medium, 2 serif, 2 letter spacings, 3 display-small) + 10 mono to review + 207 pair; settings gallery h3 and History-style h4 to the shared small-strong role | `connections.mjs`, `connectors.mjs`, `project-connection.mjs`, `multi-provider.mjs`, `skills.mjs`, `team.mjs`, `team-files.mjs`, `org-change.mjs`, `import.mjs`, `presets.mjs`, `permissions.mjs` |
| 6 Guard | new `styles/typography.test.ts`, new `e2e/typography.mjs` (the scratch walker, shortened to 12 screens and an allow-list of role tuples); `package.json` `e2e:free` entry and `scripts/e2e-select.mjs` mapping | about 120 lines new: the unit test scans CSS for literal sizes, weights other than 400 and 600, uppercase, `font-family` outside the four tokens, and a size token without a line height; the e2e fails on any visible text outside the allow-list at the three text sizes | itself; `tokens.test.ts` |

Totals: about 45 + 8 + 28 + 31 + 61 + 28 = 201 required declaration changes, 83 mono rules to review (about 25 expected to move),
627 optional line height pairs (629 minus 2 inside slice 0), 2 TSX files, 2 e2e assertion files. Slice 3 and slice 5 are the largest by files; if a smaller unit
of review is wanted, split slice 3 into run view (`run*.css`, `transcript.css`, `agent-focus.css`, `cards.css`) and scenes
(`office.css`, `factory*.css`, `canvas*.css`, `flow.css`, `editor.css`).

Order of risk: slice 2 (assertions on faces, engagement look), slice 3 (densest screens, node sizes feed layout), the rest are
low. Reviewer: none of this touches security or spend; a UX walkthrough at 1024x640 and 1600x1000 in both themes and the three text
sizes should follow each slice, because line height changes by up to 1 px move every row.

## 6. Owner decisions

1. **Body face: keep the system sans, or bundle one UI face for every OS?** Recommend keep it, and fix the stack so Windows gets
   Segoe UI Variable Text. The font is consistent across screens already, bundling a UI face adds a file and a licence for a
   difference only a mac or Linux user would see; revisit if the mac walkthrough shows a problem.
2. **Display face: keep Space Grotesk for headings, or one face throughout?** Recommend keep it, restricted to headings and
   figures at 14 px and above. It is bundled, it is the brand, and the drift comes from using it at 12 and 13 px, not from
   having it.
3. **Engagement serif: titles only (and bundle Fraunces), titles only on the OS fallback, or drop the serif?** Recommend titles
   only at 16 px and above and bundle Fraunces (variable, OFL, add provenance like Space Grotesk): today the serif is three
   different faces depending on the OS and is used on tabs and labels where it reads as a mistake. If you do not want another
   font file, drop the serif and let engagements use the display face; do not keep the OS fallback.
4. **Mono as flavour: keep the code Home `> new run` labels in mono and lowercase, or follow the "mono is for code" rule?**
   Recommend follow the rule (labels become Small strong sans). The labels were a deliberate choice (an e2e check asserts them),
   so this needs your call; run indexes, counts and token totals move to sans tabular either way.
5. **Reading size: keep both 13 px (read) and 12 px (operate), or collapse to one?** Recommend keep both with the written rule in
   section 4: 13 for text a person reads (transcript, descriptions, inputs, nav, project tabs), 12 for dense operating chrome
   (buttons, dock tabs, cells, chips). Collapsing to 12 hurts the transcript; collapsing to 13 makes tables and chips crowded.
6. **Hero size: one 32 px hero, or keep 30 (Home) and 40 (Welcome)?** Recommend one 32 / 40 hero: the two never share a screen,
   and a single token lets the text size setting scale it. Check by eye that the longest Home question still wraps cleanly at
   1024x640.

## 7. What was not inspected

- macOS and Linux: all numbers are from Windows 11 (Segoe UI, Cascadia Code, Palatino Linotype). The macOS stack resolves to
  `-apple-system`, `Menlo` or the generic monospace and `Iowan Old Style`; those faces were not rendered. The `Segoe UI Variable
  Text` recommendation is untested on screen.
- Windows high-contrast and forced-colors, browser zoom, and the three window sizes other than the default 1424 x 881 content size.
- First-launch Welcome at Large and Small (measured at default size only); the usage-limit pause banner and the hold card (the
  mock run for `[mock:budget-stop]` ended Idle with an error badge and no hold card); populated Schedules (only the empty state was
  walked); the update, MCP install and Import dialogs; toasts; the Terminal island and the CLI TUI (separate surface).
- Dock Files tab at default size was walked only in the second pass (identical combinations).
- Space Grotesk at 600 on a very high-DPI screen, and hinting differences on a non-ClearType display.
- Variable-font opsz/optical-size behaviour of Segoe UI Variable once the stack is fixed: the proposal assumes it improves
  small text, not measured.
- The 3D Factory Floor canvas and Pocket Office sprites draw no text (verified in code: no `fillText` outside the Knowledge
  graph); their DOM chrome and nameplates were measured and use the same sans.
