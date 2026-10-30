# UX re-walk: App settings and Project settings after the pane reorganization (65da4e7)

Method: `npm run build`, built app driven with playwright (`ORGAI_MOCK=1`, fresh temp `ORGAI_DATA_DIR`), mock project "Demo", Skip AI setup. Every pane of both pages at 1280x800 and 1024x700, dark and light (theme switched through `data-theme`). Screenshots: `docs/design/ux-review-settings-shots/after-<page>-<pane>-<width>-<theme>.png` (page = app or project; extras carry a suffix such as `-scrolled`, `-learnmore`, `-rulefocus`, `-custom`, `after-deeplink-*`). Word counts are `innerText` of the pane at rest, so closed "Learn more" disclosures are excluded. Reference: `ux-review-settings.md` (the "before" report).

Verdict: the complaint is largely fixed. Each pane now answers one question, nothing exceeds about one and a half screens, sections are visibly separated, and rows follow one layout. What is left is polish and a few pane-model side effects. The biggest remaining issues are lost focus after the deep links, a layout shift when the rule field is focused, an inconsistent Permission mode row at 1024, and Defaults still being the longest pane.

## 1. The 12 original findings

| # | Finding | Status | What I saw |
| --- | --- | --- | --- |
| 1 | Limits mixed four topics, half the page's copy | Resolved | Limits is now six rows, 100 words (`after-project-limits-1280-dark.png`). Unattended execution and worktrees moved to Agents > Behaviour. No `set_plan` or `ask_user` in visible copy. Hints are one line at 1280 (two at 1024). |
| 2 | Sections not visually separated | Resolved | Cards with rounded borders, 20 px section titles, a hairline between sections, and a small caps tier (Theme, Canvas, Usage, Danger zone) below that. Same on both pages. |
| 3 | Sub-nav did not shorten the page and highlighted the wrong section | Resolved | Real tablist; one pane at a time; the active tab always matches. Nav stays sticky while the pane scrolls (`after-project-agents-1280-dark-scrolled.png`). Longest pane scrolls 160 to 330 px. |
| 4 | Helper text under every control at equal weight | Mostly resolved | One-line hints plus "Learn more" disclosures. Rule examples hide until focus (but see N1). Remaining wordiness is in Defaults (section 2). |
| 5 | Connections: three expanded cards, 195 words | Partly | Connected Anthropic is collapsed to one line, tier mapping is gone from the rest view, 88 words. But OpenAI and LiteLLM open by default because they are not connected, so the pane is still two forms deep (`after-app-connections-1280-dark.png`). In a mock or Claude-only setup that is noise: the user did not ask to configure them. |
| 6 | Inconsistent row layout | Mostly resolved | App General, Limits, Agents, Defaults all use label left, control right. Exceptions: the accent row (swatches over a right-aligned link, N5), the 1024 Permission mode row (N3), the project Name vs Working directory rows (inline vs stacked, acceptable because the path is wide). |
| 7 | Duplicated, unlabelled overlap between app Defaults and project settings | Partly | Wording is now identical, and Limits has "Threshold: 80% · Change in App settings" beside the Sonnet toggle. Usage threshold sits at the end of Defaults, under a "Usage" tier. There is still no "Default: 100" on the project rows, and no hint on the App Defaults that these are copied once at creation (the subtitle "Applied when a project is created. Existing projects keep their own settings." does say it; resolved for the page, not for the project rows). |
| 8 | Project Connection: odd link, mock toggle first, bare "Roles" line | Mostly resolved | The link reads as a normal text link "App settings > Connections". Provider cards are a compact selectable trio. The mock toggle is last, with a sentence saying what it does. Remaining: "Roles on this connection 4 / Everyday tier: sonnet" still reads as a mystery number; label it "4 roles use this connection". |
| 9 | Two things called "Settings" | Resolved | Sidebar says "App settings"; topbar and page title say "App settings"; project tab "Settings" has a page title "Project settings". Small leftover: the project tab button's accessible name is "Project settings" while its visible text is "Settings" (a voice-control user saying "click Settings" may fail). |
| 10 | Maintenance, raw git terms, weak danger sentence | Resolved | Quiet one-liner "No report branches waiting" with a refresh icon; danger card has a one-sentence consequence and one button (`after-project-maintenance-1280-light.png`). |
| 11 | Defaults: truncated select text, descriptions in option labels | Resolved | Selects show short names ("Unattended", "Opus"); description sits under the select. Cost cap and Runs to keep are single rows. No truncation seen at either width. |
| 12 | Smaller items | Mostly resolved | Accent has "Custom…" (but see N5); save indicator is wired on the app page (transient, not captured); About is one card, 17 words; MCP and Plugins sit in one Tools pane with a one-line empty state; "Let runs message each other" moved to Agents > Behaviour. Not done: the Tools pane still shows four equal-weight buttons plus Plugins button, and About still has a "Mock adapter" chip without explanation. |

## 2. Density per pane (visible words at rest)

| Page / pane | Words | Budget | Verdict | Scroll beyond viewport (1280 / 1024) |
| --- | --- | --- | --- | --- |
| App General | 60 | 60 | on budget | none / 90 px |
| App Connections (OpenAI and LiteLLM open) | 88 | 88 | on budget, but see finding 5 | none / 150 px |
| App MCP library | 31 | n/a | calm | none |
| App Defaults (incl. Usage) | 188 | 100 | over by about 90; the only dense pane | 200 / 380 px |
| App About | 17 | 17 | on budget | none |
| Project General | 17 | 12 | fine | none |
| Project Agents | 117 | about 90 | slightly over | 160 / 325 px |
| Project Limits | 100 | 83 | slightly over; reads clean because it is one uniform list | none |
| Project Connection | 42 | 39 | fine | none |
| Project Tools (empty) | 53 | 49 | fine; will grow with servers | none |
| Project Maintenance | 26 | 21 | fine | none |

Both pages are now 300 to 450 words in total spread over 5 or 6 panes, against 582 and 687 before. Light theme and dark theme counts are identical.

Panes that still read as dense:

- App Defaults (188). It is 11 rows, each with a hint and most with a "Learn more". Cut: (a) the duplicated project settings that a user rarely wants as defaults, i.e. Max automatic continues, Keep going until the plan is complete and Isolate writers; keep model, permission mode, cost cap, runs to keep and the Sonnet fallback; or (b) group them as "Models", "Safety" and "Behaviour" with the same card pattern as the project Agents pane so it scans as three short cards. (c) Drop the per-row "Learn more" under rows whose hint already says everything (Runs to keep, Max automatic continues, the Opus threshold).
- Project Agents (117, scrolls). It holds three sections (Permissions, Saved permission rules, Behaviour) and a pane called "Agents" whose first heading is "Permissions". Cut: make "Saved permission rules" a collapsed card or a count row ("No saved rules yet" plus an Add rule button) so the pane fits at 1280x800; or rename the pane "Permissions and behaviour".
- Project Limits at 100 is fine; the only cut is the "Learn more" under Stop at a share of the five-hour window and Prefer Sonnet, which both repeat the hint.

## 3. New problems introduced by the pane model, ranked

N1 (medium). Focusing the rule field shifts the layout by 55 px (`after-project-agents-1280-dark-rulefocus.png`; "Behaviour" heading moved from y=525 to y=581). The explanation and three example chips appear on focus, pushing the whole page down under the user's cursor. Fix: reserve the space (always show the one-line hint, keep chips collapsed behind "Examples"), or show the chips in a popover-free inline row that is always present.

N2 (medium). Deep links drop focus. After "Change in App settings", "App settings > Connections" and "App settings > MCP library" the pane is right (Defaults, Connections, MCP library) but `document.activeElement` is `body`, so a keyboard user's next Tab goes to the Skip link, then through the whole sidebar. There is also no highlight of the target row (for Limits the user lands on the top of Defaults, not at "Usage"). Fix: focus the active tab (or the pane heading with tabindex -1) after a deep-link navigation; for the Limits link scroll to and briefly outline the Usage row.

N3 (medium). The Permission mode row at 1024 breaks the row pattern: the select floats in the middle of the card, label and hint stacked above, description below (`after-project-agents-1024-light.png`). Every other row is label left, control right. Fix: let the select shrink (min 180 px) and keep it right-aligned like Max automatic continues, with the mode description under the label rather than under the control.

N4 (low to medium). Where am I. The pane title (h2) matches the tab for most panes, but the project Agents tab opens on "Permissions"; Tools opens on "MCP servers"; App General opens on "Appearance". A user who clicked Agents or Tools sees a different word. Also a pane has no breadcrumb context when entered through a deep link from another page (no "back to project settings"). Fix: lead each pane with an h2 equal to the tab label, and make the existing sections h3.

N5 (low). Accent "Custom…" link sits in the right-aligned hint slot under the swatches, two lines tall, and the row is taller than its neighbours. Clicking it swaps the link for a bare hex input with no label and no way back (`after-app-general-1280-dark-custom.png`). Fix: put "Custom" as a seventh swatch (a dashed ring with a plus) that opens the hex input in line, with a clear label "Hex".

N6 (low). Not-connected provider cards open by default (see finding 5). In mock mode with Anthropic connected, the pane opens with two forms the user did not ask for, and `LiteLLM` shows a greyed Save button and a greyed "Test and connect". Fix: collapse not-connected cards under "Other providers" with a "Connect" button, open on click or when a deep link or run error names them.

N7 (low). Pane selection persists inside the session (Connection stayed selected after Live then Settings) but resets on reload, because reload returns to Projects for the whole app; that is not settings-specific and acceptable. It does mean a deep link target cannot be bookmarked or restored, which only matters for tests.

N8 (low). No find-in-page: Ctrl+F does nothing (focus stayed where it was). With five or six panes and 100+ settings in total, finding "worktree" now needs the user to guess the pane. Fix: a small search box above the tab rail that filters labels and jumps to the pane, or at minimum keep the panes' names descriptive (the follow-up could add alias text to the tab tooltip).

N9 (low). Agents pane scrolls about 160 px at 1280x800 and 325 px at 1024x700 (Behaviour is partly below the fold). Not a real problem once the sticky nav is considered, but it is the one place the pane promise "one screen" is broken. Fix: see Agents cuts in section 2.

N10 (low). Authentication segmented labels no longer wrap at 1024 (`after-app-connections-1024-light.png`: "Sign in with ChatGPT" and "API key from environment variable" fit on one line). The wrapping from the brief did not reproduce. The two stacked segmented controls (Authentication, then Browser/Device code) with a lone paragraph between them are still heavy.

Smaller notes: the project page title "Project settings" stays above the tabs while the app page relies on the topbar, so the two pages have different headers (minor); the 1024 sidebar drops the "Resets in" usage text but the rest of the page does not need it.

## 4. Keyboard pass

Tablist (App, dark, 1280):
- Arrow Down, Arrow Up, Arrow Right, Arrow Left, Home and End all move selection and focus together and wrap. Selection follows focus. Roving tabindex works: Tab leaves the tablist for the pane's first control (App Defaults first Tab lands on "Orchestrator model", project Agents on "Learn more"). No `aria-orientation`, so a screen reader announces horizontal behaviour for a vertical rail (minor).
- Tab order inside App Connections: Refresh all, per-provider refresh and expand buttons, auth radios, Sign in, LiteLLM Base URL, API key. Logical. My probe could not read a name for the two radio inputs (OpenAI Authentication and Browser/Device code); worth a quick check by the Reviewer that the segmented radios have accessible names.
- Tab order inside App Defaults: both model selects, then each row's "Learn more" before its control, e.g. Permission mode "Learn more" then the select. Reading order is label, hint, link, control, which matches the visual order. Tab stops double (eleven rows, up to 20 stops); fine, but a keyboard user passes every "Learn more" on the way down.
- Tab order inside project Agents: Learn more, Permission mode select, Reload saved rules, rule input, Add rule, the three example chips (focusable even before the rule field is focused, hidden visually until focus), Learn more, Keep going switch, Max automatic continues, and so on. Reasonable.

"Learn more": native `details/summary`. Enter and Space toggle it, focus stays on the summary, the body expands in place without moving focus. Good.

Deep links (activated both with the mouse and by keyboard):
- Limits "Change in App settings": lands on App settings > Defaults. Correct pane, focus is `body` (N2), no highlight of the Usage row, which is below the fold.
- Connection "App settings > Connections": lands on App settings > Connections, focus on `body`.
- Tools empty state "App settings > MCP library": lands on App settings > MCP library, focus on `body`.
- Sidebar "Demo" returns to the project page and remembers the last pane within a session.

## 5. Follow-up brief, ranked

1. Restore focus and orientation after deep links (N2). After navigating from a project link to App settings, focus the active tab or the pane h2 (tabindex -1), and scroll to and briefly outline the target row (Usage threshold for the Limits link). Keyboard users currently start from the page top.
2. Make the rule examples not shift the layout (N1). Reserve the hint and chip space permanently, or render the chips as a collapsed "Examples" row.
3. Cut App Defaults to three scannable cards (188 words, 380 px of scroll at 1024). Group Models, Safety, Behaviour; drop "Learn more" where the hint is already complete; consider removing the continuation and worktree defaults.
4. Fix the Permission mode row at 1024 (N3) so the control stays right-aligned like every other row and its description sits under the label.
5. Make pane titles equal the tab labels (N4): Agents (Permissions, Saved rules, Behaviour as h3), Tools, General. Also give the project "Settings" tab a matching accessible name.
6. Collapse not-connected provider cards (finding 5, N6) into a short "Other providers" list with a Connect button, keeping Anthropic one line. Open a card automatically only when something links to it.
7. Replace the accent "Custom…" link with a seventh swatch that opens a labelled hex field (N5).
8. Add a "Default: X" link or reset on the project rows that shadow an app default (finding 7), label "Roles on this connection" as "4 roles use this connection" (finding 8), and consider a settings search (N8).

## What is good and should not be touched

- The sticky left tab rail with five or six short names, and the matching tab-strip behaviour at narrow container widths.
- Card plus SettingRow system: label and one-line hint left, control right, 20 px section titles, small caps tier, hairlines between sections.
- Project Limits as one uniform list; project General at 17 words; About and Maintenance (quiet one-liner and a single red danger card).
- The collapsed connected Anthropic card with status chip and a one-line summary.
- "Learn more" as a native disclosure; Enter and Space work and focus stays put.
- Project Connection as three compact selectable provider cards with the "App settings > Connections" text link.
- App General with Theme, Accent and Motion in one card and the canvas settings in another, notifications as a single row.
- The Limits row for Prefer Sonnet with "Threshold: 80% · Change in App settings" next to the toggle: the right way to show a value owned elsewhere.
