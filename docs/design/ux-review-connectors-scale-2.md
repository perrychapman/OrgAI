# UX re-walk: connectors at scale (after the UI rework)

Method: built app, `ORGAI_MOCK=1`, fresh temp `ORGAI_DATA_DIR`, no smoke scripts. Real catalog: the gallery lists 38 services
(the brief said 41; `connector-tile` count is 38 in the build I walked). Walked at 1024x640 and 1600x1000 in dark and light:
App settings > Connectors gallery, ConnectorDialog for Notion (sign-in), DeepWiki (none), Zapier (token), Gmail (own app),
a project with 10 connected services (Team > Catalog > Add a service, connected rows, the "Show them" fold, role inspector),
one keyboard-only pass over gallery and picker. Shots: `docs/design/ux-review-connectors-scale-2-shots/` (named in brackets
below). Measurements come from the DOM in the running app.

Where the tools live: Add a service and the connected rows are in the project's **Team > Catalog** side panel, not in
Settings (Settings has General, Agents, Limits, Connection, Plugins and skill settings, Maintenance). The brief and CLAUDE.md
say "Settings > Tools"; the doc drift is worth a fix.

## Verdict

The rework works. The gallery is now scannable (89 px tiles, 3 columns at 1600, 2 at 1024, groups by effort, ease badges,
chips, ranked alias search, live count), the picker is search-first with roving focus, and the dialogs lead with the cost of
the path. What is left is polish at the small size (the chip block and the picker footer eat the viewport), two search gaps,
the missing role-inspector cap, and the Gmail shortcut sitting below the fold.

## Earlier findings 1-8

| # | Earlier finding | Status | Evidence |
|---|---|---|---|
| S1 | Ease invisible, hard flows first | **Fixed** | Badges "Sign in", "No sign-in needed", "Paste a token", "Needs your own app" with icons; unconnected sorted Easy sign-in (24), Needs a token (2), Needs your own app (12); "Sign in" and "Add" are filled buttons, "Add token" and "Set up" outline. [`gallery-top-1600-light`, `gallery-token-group-1600-light`] |
| S2 | Picker flat, no search | **Fixed, one size issue** | Autofocused searchbox, "38 services" live count, "Ready to use 10" then "Connect a new service 28", in-project rows say "Manage roles", one tab stop, ArrowDown from search into the list, Home/End work, option names "Name, Category, status". Footer is pinned. See N2. [`picker-top-1024-dark`, `picker-top-1600-light`] |
| S3 | Tall tiles, 2 columns | **Fixed** | Tile 89 px (was 163). Columns: 2 at 1024 (section 710 px), 3 at 1600 (1110 px). Page height 2,216 px at 1024 and 1,579 px at 1600 for 38 tiles. |
| S4 | Name-only search, no filter | **Partly** | Fixed: ranking (name first), aliases ("email" -> Gmail, "issues" -> Atlassian, Linear, GitHub, GitLab, Sentry; "postgres" -> Neon, Supabase; "tickets", "mail", "database", "meeting" all useful), category chips with counts, group headings, Connected pinned with chip, no-results card with Add a custom server. Still open: "sign in" returns only Miro and "token" only Figma (matched in descriptions, not the ease labels), "free" returns Google Calendar. Chips are single-select, so Easy sign-in cannot be combined with a category. See N3. [`search-email-1024-dark`, `search-zzz-1024-dark`, `chip-docs-1024-dark`] |
| S5 | Dialog treats all kinds alike | **Mostly fixed** | Notion: title "Sign in with Notion", "Opens your browser. No keys to paste.", one calm access line. DeepWiki: "Add DeepWiki", "No sign-in needed", Add. Zapier: token field first, "Create one" link, stored-encrypted line. Gmail: "About 10 minutes, once. This service needs an app you create yourself." leads. Still open: the "I already have a client ID" shortcut is below the fold (N4); "Not yet tested with OrgAI" appears in every dialog. [`dialog-notion-1600-light`, `dialog-zapier-1024-dark`, `dialog-gmail-1024-dark`, `dialog-gmail-haveclient-1024-dark`] |
| S6 | Tools entry buried, role inspector letters and no cap | **Partly** | Role inspector now uses brand logos (`ConnectorLogo`), but there is no "and N more" cap in `RoleServices.tsx` (6 connections show 6 cards of about 65 px each; 20 would be 1,300 px). Connected rows do fold: with 10 connected and 6 used here the panel says "and 2 more connected services not used here. Show them", which works. Skills still sit above Connections in the Catalog panel; "Add a connection" is below the fold at 1024x640. [`role-services-1024-light`, `connected-rows-1280-dark`, `connected-more-open-1280-dark`] |
| S7 | Keyboard and screen reader | **Mostly fixed** | Gallery count is `role=status aria-live=polite`; chips are a labelled group with `aria-pressed`; group sections are labelled and headed; tiles are one roving tab stop (arrows, Home, End work; Tab after the grid lands on "Add manually"); picker is a listbox with roving focus and short names. Open: 18 chip tab stops before the grid (N5); tile buttons are named "Sign in with Amplitude" with no ease or description relation. |
| S8 | Smaller points | **Fixed** | One "Connected as mock@example.com" form on tiles and rows; filled primary only for the easy paths. |

## New findings and regressions, ranked

### N1 (medium). Preview and "Not yet tested" noise
About 17 of 38 tiles carry a grey "Preview" badge next to the ease badge, and every dialog repeats "Not yet tested with
OrgAI". Gmail says it three ways: a bullet about the Developer Preview Program, step 1 of the procedure, and "Preview - not
yet tested with OrgAI". Badge and caption are quiet but they dilute the ease signal. Fix: keep one honesty line in the
gallery intro ("Most services are not yet tested end to end"), show the tile Preview badge only for services whose vendor
calls them preview, and fold Gmail's three mentions into step 1. Pointers: `connector-honesty` in `ConnectorDialog.tsx`,
`ConnectorTile.tsx`.

### N2 (medium). Picker footer eats a fifth of the dialog at 1024x640
The pinned "Can't find it?" footer wraps to two button rows (four routes plus Close) and one explanatory sentence: about
105 px of the 641 px window, leaving roughly 5 rows of results; in the no-results state the same routes appear twice
("Add a custom server" in the card and "Set up a custom server" in the footer). [`picker-top-1024-dark`,
`picker-empty-1024-dark`]. Fix: one row of two buttons ("Describe it to an assistant", "More ways to add" menu with link,
community and custom), drop the sentence to a tooltip or the assistant dialog, and hide the card duplicate or make the card
the only place in the empty state. `.addsvc-foot` in `AddServiceDialog.tsx`. Also: the dialog subtitle says "One that is
ready to use goes straight to choosing roles; the others sign in first." which is accurate but long.

### N3 (medium). Search does not know how a service connects
Typing "sign in", "token", "easy" or "own app" returns a stray description match (Miro, Figma, none). The badge text is the
thing users have just learned, so they will try it. Fix: add the ease label as a hidden search keyword in the gallery and the
picker. Also make the Easy sign-in chip a real filter that composes with a category (it currently deselects the category and
its count, 24, includes the five "No sign-in needed" services). `ConnectorGallery.tsx` filter state.

### N4 (medium). Gmail: the "I already have a client ID" shortcut is below the fold
At 1024x640 the dialog body is 782 px in a 491 px viewport; the shortcut sits after seven steps and the redirect-address
box, so returning users must scroll to find it. When used it collapses the steps and focuses Client ID, which is good.
[`dialog-gmail-1024-dark`, `dialog-gmail-haveclient-1024-dark`]. Fix: put the shortcut link on the line under "About 10
minutes, once." and keep the Redirect address copy button visible next to the steps heading.

### N5 (low). 18 chip tab stops before the first tile; 1024 chip block is three rows
Tab from search needs 18 presses to reach the first tile (17 chips). At 1024x640 the chips wrap to three rows and the first
tile row starts at y=355, so only 2.5 rows of tiles are visible. Fix: make the chip row one roving tab stop (arrows move
between chips, like the grid) or a single row that scrolls horizontally; let ArrowDown from the search field move into the
grid as the picker already does (now it does nothing). `connector-chips` in `ConnectorGallery.tsx`.

### N6 (low). Role inspector has no cap
See S6. Cap at 5 with "and N more" that opens the Catalog tab (same pattern as `connected-more`). `RoleServices.tsx`.

### N7 (low). Wording drift: connection, service, connector
Catalog panel says "Connections 6", "Add a connection" and "Connected services"; the dialog is "Add a service"; the App
settings pane is "Connectors"; Project Settings has a separate "Connection" tab that means the AI provider. A new user will
not know "Connection" in Settings is unrelated. Fix: use "Services" for the panel heading and button ("Add a service"), keep
"Connectors" only as the App settings pane name, and rename the Settings tab to "AI provider". Also the panel shows "Connections
0" before a pick while ten connected services are listed below it.

### N8 (low). Ease order inside "Easy sign-in" is alphabetical
"No sign-in needed" (Add) and "Sign in" tiles interleave (AWS Knowledge between Atlassian and Cloudflare). Putting the five
no-sign-in services first is the shortest path and makes the group's purpose obvious.

## Logo legibility (38 services)
Magnified strip in both themes: [`logos-zoom-light`, `logos-zoom-dark`]. Black marks (Notion, Miro, Vercel, GitHub) swap to
light marks in dark, so they read. **Intercom on the light tile is still pale**: cyan-white mark on an almost white tile, the
weakest of all. Exa's thin outline mark is low contrast on the dark tile. Five services use letter tiles (DeepWiki, Context7,
Granola, AWS Knowledge, Microsoft Learn); acceptable, but they vary in tint. Zapier and Zoom wordmarks are tiny at 36 px.
Fix: Intercom needs a darker blue (`#1F8DED` family) or a dark-tile variant on light; Exa a heavier stroke or lighter tint on
dark.

## Widened settings column and Custom servers
The section is 710 px at 1024 and 1110 px at 1600, and "Custom servers (advanced)" below it uses the same width. Its three
actions (Add manually, Configure with AI, Browse community servers) sit on one row at 1600 and wrap fine at 1024; no clipping or
horizontal scroll. [`gallery-bottom-custom-1600-light`, `gallery-bottom-custom-1024-dark`]. No issue; the empty-search card
now links straight to it.

## Keyboard and screen-reader notes
- Gallery: search, then 17 chips, then one grid tab stop; arrows, Home, End move; Tab leaves to Add manually; Escape clears
  the search. [`kbd-first-tile-1024-dark`]
- Picker: search autofocused, ArrowDown into the list, Home/End, Shift+Tab back to search, Tab to the footer; option name
  "Slack, Chat, ready to use" with the description as `aria-describedby`. Good.
- Not driven: native screen reader; the names above come from the DOM.

## Ranked top findings
1. N2 picker footer weight at 1024x640 (every Add-a-service use).
2. N3 search ignores the ease labels; Easy sign-in chip cannot combine with a category.
3. N4 Gmail shortcut below the fold.
4. N1 Preview and untested repeats dilute the ease signal.
5. N5/N6 chip tab stops, no role-inspector cap.
6. N7 wording drift; N8 ordering; Intercom (light) and Exa (dark) marks.
