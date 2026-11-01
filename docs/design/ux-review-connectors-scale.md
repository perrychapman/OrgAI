# UX review: connectors at scale (pre-planning)

Question: the catalog grows from 11 to roughly 40-60 services and one-click sign-in must become the preferred, most
visible path. Does the current UI survive that, and what should change first?

Method: built app, `ORGAI_MOCK=1`, fresh temp `ORGAI_DATA_DIR`, no smoke scripts. To judge scale I temporarily appended 48
synthetic connectors (59 total: 26 one-click `oauth`, 8 `token`, 8 `oauthClient`, the rest the real 11; reverted, nothing
committed to `src/`). Walked at 1024x640 and 1600x1000, dark and light: App settings > Connectors gallery, the dialog for
Notion (oauth), Gmail (oauthClient) and GitHub (token), project Settings > Tools > Add a service, connected rows, the
Use-in-project dialog and role inspector `RoleServices` (read from code; it renders the same list). One keyboard-only pass
through search, tiles and the Add picker. Shots: `docs/design/ux-review-connectors-scale-shots/`. Where a number is
quoted it was measured in the simulated 59-service catalog.

Caveat: the simulated services reuse generic copy and initial-letter logos, so only layout, ordering and wording are judged.

## Verdict

The structure is sound at 11 (search, connected-first, one primary action per tile, a plain-words dialog). It does not
scale. At 59 services the gallery is a 5,700 px column of identical tiles, the project picker is a flat 4,470 px list with
no search, and nothing tells a user which services are one click and which need a developer console. Today the first
tile is Gmail, the hardest flow in the catalog, and it looks exactly like Notion, the easiest. The three biggest levers,
in order: (1) show how hard each service is to connect and sort by it, (2) make the project picker search-first with
connected services on top, (3) make tiles roughly half the height and use the width at 1600.

## Findings, ranked by user impact

### S1 (high). Sign-in ease is invisible; the hardest flows lead the gallery

- Flow: first-time user connects a service. Step: gallery, first screen. Shots: `gallery-top-1024-dark.png`, `gallery-top-1600-light.png`.
- Expected: the services I can connect in one click to be obvious and first; the ones that need a developer console flagged before I click.
- Saw: every unconnected tile reads "Official" + "Not connected" + a primary "Connect". Gmail, Google Calendar, Google Drive and Slack (all need the user's own OAuth client, about 6 steps in a cloud console) are the first four tiles; Notion (one browser approval) is fifth. The only difference is revealed after clicking (`dialog-gmail-1024-dark.png`). With 50 services a user will open several, hit the six-step wall, and back out.
- Wording clash to avoid: the tile state "Needs setup" already exists and means "added but not signed in yet" (`stateChip`, `actionLabel` "Finish setup"). Reusing it for "needs your own OAuth app" would make one phrase mean two things.
- Severity: high.
- Fix:
  - Add a method badge derived from the default variant's `auth.kind`, shown on every unconnected tile, separate from the state chip: `oauth` -> "Sign in" (success-quiet, with a small browser/arrow icon); `token` -> "Paste a token"; `oauthClient` -> "Needs your own app" (neutral/warning tone, never danger). Services with both (Stripe) show the easiest.
  - Sort unconnected tiles by ease then by catalog order: one-click, token, own-app. Connected first stays; a connected error state stays next to it.
  - Tile primary label follows the method: `oauth` "Sign in" (aria-label "Sign in with Notion"), `token` "Add token", `oauthClient` "Set up". Keep "Manage" / "Fix" / "Finish setup" for the other states, and rename the existing state chip "Needs setup" to "Not signed in" (or "Setup unfinished") so the method badge owns the word "setup".
  - Do not hide the harder services; group them under a quiet heading ("Needs your own app or token") so they read as secondary, not missing.

### S2 (high). Add a service in a project is a flat list with no search

- Flow: project Settings > Tools > Add a service. Step: open the dialog. Shots: `addservice-top-1024-dark.png`, `addservice-top-1600-light.png`, `addservice-bottom-1024-dark.png`.
- Expected: type "notion" and pick it. Saw: no search field. 59 rows, 4,470 px of list inside a modal; at 1024x640 about 7 rows are visible, at 1600x1000 about 12. The "Not listed?" routes (Describe it to an assistant, custom server...) sit at 4,590 px, so someone with a service that is not in the catalog must scroll or Tab through all 59 buttons first. Typing after Tab does not jump anywhere (verified: focus stayed on Google Calendar after typing "notion").
- Connected services (the ones I can add in two clicks) are not grouped: Slack and Notion are rows 4 and 5 among unconnected ones, and with a second pick they would scatter further.
- Every row repeats "Not connected" (59 identical badges); the category and access words compete for the same right-hand edge. Connected rows show "Can read and change" while unconnected rows show nothing, so the right edge is ragged.
- Severity: high.
- Fix (search-first picker):
  - A search input at the top, autofocused, that filters by name, vendor, category and aliases ("mail", "drive", "tickets"); a live result count ("12 services") in a polite live region.
  - Default (empty query) layout in two sections: "Ready to use" (already connected in the app, action "Add to project") and "Connect a new service" (grouped or chip-filtered by category, one-click first). Drop the per-row "Not connected" badge: absence of the "Ready" section already says it. Keep a single right-aligned method badge (S1) so the right edge is consistent.
  - Make the "Not listed?" routes a pinned footer line ("Can't find it? Other ways to add"), always visible, not the tail of the list; repeat it in the no-results state.
  - A service already in this project should not be a dead disabled row: show it in "Ready" as "In this project" with a "Manage roles" action (jumps to its row) instead of a disabled button the keyboard cannot focus and that gives no reason.
  - Keyboard: search focused on open; Down arrow moves into the list; list is one tab stop with roving arrow-key selection (or a `listbox`), Enter picks. Cuts 59 Tab stops to one.

### S3 (high). Gallery density: tiles are tall and the grid never uses the width

- Flow: browse the gallery. Shots: `gallery-top-1024-dark.png`, `gallery-top-1600-light.png`, `gallery-scrolled-1024-dark.png`.
- Saw: tiles are 163 px high and the grid is 2 columns at both sizes (the settings column caps around 720 px; at 1600 about 55% of the window to the right is blank). 59 tiles = 5,700 px, about 9 screens at 640 high and 5.7 at 1000. Six tiles are visible at 1024x640 and about ten at 1600x1000. Each tile spends three of its five rows on low-information content: a one-line description, an "Official" badge that every service has, and a state chip plus a button saying the same thing ("Not connected" next to "Connect").
- Severity: high (it multiplies every other scale problem).
- Fix:
  - Cut tile height to about 88-96 px: logo, name, one-line description (clamped), and on the right one method badge + one button. Drop the "Official" badge from tiles and dialog while every service is official; if community connectors arrive, badge the exception ("Community") instead. Show "Preview" only when it applies.
  - Merge state chip and action: unconnected tile has the method badge and "Sign in"; connected tile has a small check, the account, and "Manage".
  - Let the gallery use the width: 3 columns from a container of about 900 px (so 1600 shows 3 columns, 1024 stays 2 with the sidebar expanded), or a list/row layout toggle (a 56 px row is the same pattern as the Add picker, so one component can serve both).
  - Expected result at 59 services: about 2,000-2,900 px instead of 5,700, and 12-18 tiles on screen at 1600.
  - Optional, cheap: `content-visibility: auto` on tiles; rendering 59 was fine but 60+ with real SVG marks is untested.

### S4 (high). Finding one service: search is name-only, there is no category filter, grouping or recency

- Shots: `search-empty-1024-dark.png`, `search-doc-1024-dark.png`, `gallery-connected-1024-light.png`.
- Saw, measured: query "doc" returns Notion plus five unrelated services because it matches inside descriptions, and ranking is catalog order, so a name match (Google Docs) is not first. "sign in", "oauth" and "official" return nothing, so a user cannot search by how easy a service is. The category (Chat, Docs, Code...) is printed on each tile but is not a filter. Connected tiles are ordered by catalog position, not by recency or use (Slack, Notion, GitHub, then two simulated ones, in catalog order), so the service I connected five minutes ago is not necessarily at the top.
- Severity: high at 50 services, minor today.
- Fix, in this order of value:
  1. Rank name matches first (prefix, then substring), then vendor/alias, then category, then description; stable otherwise. Add aliases to the catalog data (Gmail: "email", "mail", "google"; Drive: "files", "docs") so people find it by what they remember.
  2. A filter chip row under the search: All, Connected, then the categories that exist (10 today; chips wrap to two rows at 1024). Include "Easy sign-in" as a chip so ease (S1) is also a filter. Chips are toggle buttons with `aria-pressed`.
  3. When there is no query and no chip, group the unconnected tiles under category headings (sticky, quiet) once the catalog passes about 24 entries; with a query, show a flat ranked list.
  4. "Connected" is a pinned top section with its own count. Within it sort by most recently connected or used (needs a `connectedAt` / last-used timestamp on the library entry; `usedBy` links are a free proxy, with services used by more projects first). A separate "Recently used" section is not worth it at this scale; connected-first with recency order covers it.
- Empty state is good but needs to be better at scale: it names the no-match and offers Clear search and a pointer to Custom servers "below". With 59 tiles gone the Custom servers block is a screen below the empty card on 1024x640; add a button "Add a custom server" in the card itself, plus "Describe it to an assistant" as the project picker offers.

### S5 (medium). The dialog treats one-click and setup-heavy services the same way

- Shots: `dialog-notion-1024-dark.png`, `dialog-gmail-1024-dark.png`, `dialog-gmail-1600-dark.png`, `dialog-github-1600-light.png`.
- Notion (one click): the button says "Connect", the only hint that a browser opens is a muted sentence at the bottom, under a paragraph about write access. The access line reads "Can read and change. Agents can also create, edit or delete things in your account. Only pick this if you want them to act for you." There is nothing to pick (a single variant), so "Only pick this" is wrong and sounds like a warning about my own choice. The "Not yet tested with OrgAI" line appears in every dialog (all 11 are `verified: false`) and will be noise on 50.
- Gmail (own app): "Before you connect" is a six-step cloud-console procedure shown first, then the redirect address, then Client ID and Secret. At 1024x640 the dialog scrolls (content 637 px, visible 491 px); the Client ID field is cut at the fold and the disabled Connect button sits below six steps. The user cannot tell before opening that this takes about ten minutes in another product.
- GitHub (token): fine and compact, but the access choice (Read-only / Full) comes before the token with a long paragraph per option; for a token service the real task (create a token with the right scope) is third.
- Severity: medium.
- Fix:
  - One-click services: title the primary button "Sign in with Notion"; lead with one line "Opens Notion in your browser. Approve access, then come back. No keys or setup needed." Move the access sentence under it as a quiet line; for a single variant say "Agents can read and change your Notion content." without the "Only pick this" clause. While waiting, the existing "Waiting for your browser" + Cancel is good.
  - Own-app services: first line states the cost ("This service needs an OAuth app you create yourself. About 10 minutes, once."), then a numbered list, then a collapsed "I already have a client ID" shortcut that goes straight to the fields. Show the redirect address with the Copy button beside step 5, not after step 6. Put Client ID and Secret above the steps for returning users, or make the dialog body a two-step (Set up, Connect) with a sticky Connect.
  - Token services: put the token field and "Create one" link first, the access choice second; keep the "Stored encrypted" line.
  - Show the honesty note ("Preview", "Not yet tested") once, as a single quiet line, and only when the service is Preview. When all services are untested, put one sentence in the gallery description instead of 50 repeats.
  - Add an "Easy sign-in" / "Needs your own app" / "Needs a token" line to the dialog header so the badge from S1 continues into the dialog.

### S6 (medium). Project Tools buries the entry point and the connected list does not scale

- Shots: `tools-before-1024-dark.png`, `addservice-use-1024-dark.png`.
- Saw: project Settings > Tools opens on Skills (heading, four buttons, an empty-state card, an Evaluation block, "Last evaluation"). "Add a service" and the connected rows are below the fold at 1024x640 (reached only after scrolling about 600 px). A user who arrived here "to give my agents Notion" sees skills first. Once 10-15 services are used, the rows are an unfiltered list with a "Use in this project" button on each unlinked one.
- Role inspector `RoleServices` lists services as an initial-letter tile ("N") with name, not the brand logo the gallery and Add picker use, and it has no limit or grouping, so a role with 20 services is a 20-line block in a side panel. Inconsistent with the logos landed elsewhere.
- Severity: medium.
- Fix: order the Tools sections by how often people need them (Services/MCP first, or a jump list at the top of the pane); show a count in the section title ("Services, 3 connected"); in the role inspector use `ConnectorLogo`, cap at 5 with "and N more" linking to Tools; in the Tools rows a "Not used here" collapse once more than about 8 connected services exist.

### S7 (medium). Keyboard and screen reader at scale

- Saw: Tab order is search, then one button per tile (59 stops, each named "Connect Gmail" etc., which is good), then Custom servers. There is no skip past the grid. The Add picker is worse: each row is one button whose accessible name concatenates name, description, category, access words and state (the whole row is announced as one long string), and disabled "In this project" rows are removed from the tab order with no explanation. The search results change without any announcement (no live region on `connector-search`), so a screen-reader user typing "slack" hears nothing. No-results card text is not role=status.
- Focus handling inside the dialogs is already good (focus moves to Check connection after connect; Escape closes; the visible focus ring on Manage showed in `gallery-connected-1024-light.png`).
- Severity: medium (rises to high with the 59-stop list).
- Fix:
  - Add `role=status` / `aria-live=polite` "N services" under the search and move the no-results text into it.
  - Section headings are real headings (`h3`) so screen-reader users can jump between "Connected", "Easy sign-in" and the categories; skip link or heading shortcuts replace the long tab run. Chips: `aria-pressed`.
  - Picker row accessible name: "Notion, Docs, ready to use" with the description as `aria-describedby`, not part of the name. Roving focus as in S2.
  - Method badge text must not rely on colour (it carries an icon and words).

### S8 (low). Smaller points

- Connected tiles show "Connected" + account text + "Manage" (`gallery-connected-1024-light.png`): good. In the Add picker the same state appears as "Connected as mock@example.com" on some rows and a bare "Connected" on a token row: use one form.
- The gallery description says "Sign-in stays on this computer." Good; keep it in the section intro rather than repeating it.
- At 1600x1000 in light theme the primary "Connect" buttons on 50 tiles form a column of 50 saturated purple buttons. When S3 lands, make the one-click "Sign in" the only filled button and render "Set up" / "Add token" as secondary (outline), which also communicates "preferred path" visually without extra words.
- Loading state: four skeleton tiles; fine, but with a 3-column layout show 6.

## Recommendations in priority order

1. Add the method badge and sort order (S1), with the state chip renamed so the word "setup" is not overloaded. Smallest change, biggest effect on the stated goal.
2. Ship the search-first project picker with a "Ready to use" section and a pinned "Not listed?" footer (S2). Reuse the same row component as a list layout in the gallery.
3. Shrink tiles, drop the per-tile "Official" badge, merge chip and button, 3 columns from about 900 px of container width (S3).
4. Ranked search with aliases, category chips plus an "Easy sign-in" chip, connected pinned and ordered by recency or use, category headings past about 24 entries (S4).
5. Rewrite the dialog top section per method (S5): "Sign in with X" for one-click, the cost-up-front line for own-app services, token field first for token services.
6. Role inspector logos and caps, Tools section order (S6); accessibility pass (S7).

Data needs for the above (spec level, for the Product Designer): `ConnectorDef` needs `aliases?: string[]`; an "ease" is derivable from the default variant's `auth.kind`; recency needs `connectedAt` or last-used on the library entry (otherwise use `usedBy.length`). The catalog should keep one default variant per service whose auth is the easiest one offered (Stripe's `oauth` before `key`).

## Not walked

Real services (the 48 extras were synthetic and had generic copy and initial-letter logos), OAuth against a live provider (mock only), the native screen reader, the Add picker's Use-in-project step beyond its opening screen, and a keyboard run of the full oauthClient form.
