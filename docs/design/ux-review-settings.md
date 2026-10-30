# UX review: App settings and Project settings

Method: built app (`npm run build`), launched with `ORGAI_MOCK=1` and a fresh temp `ORGAI_DATA_DIR`, project "Demo" created on the mock adapter. Dark theme, Connected Anthropic state, empty MCP library, no plugins. Walked both pages top to bottom at 1280x800 and 1024x700. Screenshots: `docs/design/ux-review-settings-shots/` (`app-<width>-NN.png`, `project-<width>-NN.png`, NN = scroll step; `00-*` are the project creation steps). Light theme and keyboard-only were not part of this brief and were not walked.

Complaint under test: "They both feel very clumped and like there's too much text everywhere. Very unorganized."

Verdict: the complaint is correct and mostly structural. Both pages are one long scroll (about 2,640 px project, 3,040 px app at 1280x800, 3,050 and 3,270 at 1024x700, against a viewport of 700) of 6 to 8 sections with nearly identical visual weight, and every control carries a one to three line sentence under it. The sub-nav exists but does not reduce the length, and it highlights the wrong section.

## Density measurement (visible words, labels plus helper text, dark, mock, empty library)

Measured from `innerText` of the scroll container. Collapsed content (Models lists, MCP server rows) is excluded, so real numbers are higher once a user has data.

| Page | Section | Words |
| --- | --- | --- |
| Project | General | 51 |
| Project | Permissions | 103 |
| Project | Limits (incl. Unattended execution, Subscription limits, Parallel work) | 319 |
| Project | Connection | 62 |
| Project | MCP servers | 61 |
| Project | Plugins | 26 |
| Project | Maintenance (incl. Danger zone 25) | 38 |
| Project | Total | 687 |
| App | Appearance | 41 |
| App | Notifications | 22 |
| App | Connections (3 provider cards, Anthropic expanded) | 195 |
| App | MCP library | 54 |
| App | Defaults for new projects (incl. Usage 28) | 209 |
| App | About | 30 |
| App | Total | 582 |

The project Limits section is the single densest block: 319 words, 4 sub-groups, 5 checkboxes with 2 to 3 line descriptions, 6 numeric inputs. It alone is about 47 percent of the page. Target for after: under 400 words per page visible at rest, no section over 90.

## Ranked findings

### 1. Project settings, Limits: one section holds four unrelated topics and half the page's copy
Screens: `project-1280-01.png`, `project-1280-02.png`, `project-1024-01.png`, `project-1024-03.png`.
Experience: after Permissions the user meets "Limits" and keeps scrolling for roughly two screens. Inside are cost cap, run retention, subagent depth, concurrency (grid of 4 inputs), then "Unattended execution" (checkbox with a 3-line paragraph that mentions `set_plan`, `ask_user`, `mark_blocked`), then "Subscription limits" (percent input, a Sonnet checkbox with a 3-line paragraph), then "Parallel work" (git worktrees, review-before-merge). Only the first group matches the section title. Sub-headings are 14 px bold and barely distinguishable from field labels.
Why it hurts: grouping and copy. "Parallel work" and "Unattended execution" are behaviours, not limits. Internal tool names leak into user copy.
Recommendation: split into Limits (cost cap, runs to keep, depth, concurrency, subscription cap, Sonnet fallback) and Agent behaviour (unattended continuation, worktrees, review before merge). Turn every checkbox into a `SettingRow` with a one-line description (max 15 words) and move the long explanation into a "Learn more" disclosure or a `title` tooltip. Cut `set_plan`/`ask_user`/`mark_blocked` from the visible copy. Put "Max automatic continues" inside the disclosure that appears only when the checkbox is on, or inline to the right on the same row. Put the numeric limits in a two-column row grid with the label left and a narrow input right, not stacked full-width label, input, hint triples.

### 2. Both pages: sections are not visually separated, so it reads as one wall
Screens: `project-1280-00.png` to `-03.png`, `app-1280-03.png`.
Experience: project settings has no dividers or cards between General, Permissions, Limits, Connection, MCP, Plugins, Maintenance. The section title (16 px semibold) is only slightly larger than the 14 px sub-headings and field labels, and spacing between sections is about equal to spacing between fields inside a section. The app page draws a hairline between sections; the project page does not (see inconsistency table). Users cannot tell where one topic ends.
Why: hierarchy and grouping (proximity law violated).
Recommendation: one shared `SettingsSection` for both pages: larger title (20 px), a rule above, 40 px between sections versus 16 px between rows, and optional card background for the group of rows. Make sub-headings (Parallel work, Subscription limits) a clearly lower tier (overline caps or 12 px muted) or remove them by splitting sections as in finding 1.

### 3. Both pages: the sub-nav does not shorten the page and its active state is wrong
Screens: `project-1280-01.png` (Limits highlighted while the Permissions rules block is on screen), `project-1280-02.png` (Limits highlighted while Connection and Parallel work are on screen), `app-1280-02.png` (Connections highlighted while MCP library is at the bottom), `app-1280-03.png` and `-04.png` (Defaults highlighted while Usage and About are on screen).
Experience: a sub-nav suggests tabs; here it is only scroll-anchors over a long page. The highlight follows the section whose top passed, which lags by a screen on every tall section, so "where am I" is regularly wrong. At 1024 the nav plus app sidebar consume about 440 px of 1024 (43 percent) while the content column gets 530 px, which is why helpers wrap to 3 lines.
Why: hierarchy and navigation.
Recommendation: make the sub-nav real: show one section at a time (tab-style master-detail), so each pane is 150 to 350 words and no pane scrolls more than about one screen. If scrolling is kept, fix the active-section logic (use the section crossing 30 percent of the viewport) and make the nav sticky below the page title. At 1024 collapse the sub-nav into a horizontal tab strip or a select above the content to return 180 px to the content.

### 4. Helper text under nearly every control, at the same size and brightness
Screens: all, e.g. `project-1280-00.png` (Permissions mode explainer, saved rules explainer, rule field hint, "Examples" chips), `app-1280-04.png` (Defaults).
Experience: Permissions alone shows: subtitle, mode select, a 2-sentence mode explanation that repeats itself ("Unattended: Claude decides each call, asks only when unsure. Unattended mode still asks when the classifier is unsure; saved rules below never ask."), "Saved permission rules", an empty-state sentence, an input with a 20-word hint, and example chips. That is 103 words to configure two things.
Why: copy volume. Hints are all the same 12 px muted style, so none is skippable by eye, and a reader cannot tell what is critical (cost cap is a safety cap) from trivia.
Recommendation: rule of one line (about 12 words) per hint at rest. Remove restated labels, move rationale to a `?` tooltip or "Learn more" disclosure, show only the hint for the currently selected permission mode, and hide the rule examples behind the Add rule input focus. Reserve the visible warning style for the three or four settings with real consequences (cost cap, permission mode, worktrees, danger zone).

### 5. App settings, Connections: three expanded provider cards inline, 195 words, plus nested sub-sections
Screens: `app-1280-01.png`, `app-1280-02.png`.
Experience: Anthropic is expanded by default and contains Authentication, a segmented control, Sign out, a caveat paragraph, a "Models (4)" disclosure and a Tier mapping table (4 rows, each with name, description and a select). OpenAI shows two segmented controls stacked (auth method, then Browser/Device code) and a primary button. LiteLLM has two fields, a Save button, a "Not set" chip, a caveat and Test and connect. This is one page section but about 1.5 screens, and it is the first thing under three short items so the page jumps from calm to dense. Tier mapping (Top/Deep/Everyday/Fast, with descriptions) is advanced and sits above the other providers.
Why: density and progressive disclosure. Setup tasks and advanced tuning share one level.
Recommendation: collapse every provider card by default with a one-line summary (status chip plus "claude.ai login, 4 models"), expand only the one that needs action (Not connected shows its connect form). Move Tier mapping into a collapsed "Model tiers (advanced)" inside the card. Drop the secondary caveat lines into tooltips. Consider making Connections its own sub-page, because it is the heaviest section on either page.

### 6. Inconsistent row layout: SettingRow in some places, stacked label, input, hint elsewhere
Screens: `app-1280-00.png` (Theme and toggles use label-left, control-right rows; Accent colour, Canvas pattern, Connection lines, Motion stack label above control), `project-1280-00.png` (the "Let runs message each other" toggle is right-aligned but sits directly below a full-width textarea with a left hint).
Experience: within Appearance, four settings are label-above (control left-aligned, different widths) and three are label-left (control right). Eyes have to re-learn the layout every 40 px. Selects and inputs range from 100 px to full width with no logic: Runs to keep is a 160 px input, Orchestrator model is 380 px, Working directory is 690 px.
Why: consistency.
Recommendation: one rule: label plus one-line description on the left (about 55 percent), control on the right (fixed widths: 120 px number, 240 px select/segment, full width only for path, textarea). Convert Accent colour, Canvas pattern, Connection lines, Motion, and all number fields to `SettingRow`. Group Appearance into "Theme" (theme, accent) and "Canvas" (pattern, lines, tint, minimap, motion), with Motion near Theme because it is a general accessibility setting not a canvas one.

### 7. Duplicated and overlapping settings across the two pages, with unlabelled relationship
Screens: `app-1280-03.png` vs `project-1280-01.png`/`-02.png`.
Experience: "Defaults for new projects" in the app page repeats Runs to keep, Isolate worktrees, Keep the orchestrator going, Max automatic continues, Prefer Sonnet, permission mode and cost cap, with shorter copy than the project page. The "Usage" section (Opus weekly threshold) is a global setting that the project's "Prefer Sonnet ... above 80%" checkbox points at ("the threshold in app settings"), but there is no link. "Usage" also has no sub-nav entry. A user who wants to change "what happens on every new project" cannot tell if they are editing app or project values. Copy differs between the two ("Re-prompts the orchestrator until its plan is done, up to the limit below" versus a 3-line explanation).
Why: consistency and copy duplication.
Recommendation: share one copy table for the repeated settings so wording is identical; in the project page show a small "Default: 100 (change in App settings)" affordance, or a "Reset to default" link. Place Usage threshold directly after the Sonnet-fallback default it belongs to, or inside Defaults under an "Usage fallback" heading, and put a link from the project checkbox to it. Add "Usage" to the nav or fold it into Defaults.

### 8. Project Connection section: odd inline link, redundant card state, mock toggle first
Screens: `project-1280-02.png`, `project-1024-03.png`.
Experience: the subtitle reads "Sign-in and keys are set once in [Settings > Connections] ." where the pill-style link has stray padding and a floating period. The first control is "Run on the scripted mock adapter (no tokens)", a developer testing toggle, above the real choice (three provider cards). Under the cards a bare grey line "Roles on this connection: 4 · Everyday: sonnet" carries meaning but no label or control. The link target name ("Settings") is also the same word as the project's own "Settings" tab, which is confusing (finding 9).
Recommendation: render the link as a normal text link ("App settings > Connections"), move the mock toggle to the bottom of the section and show it only in mock/dev mode, turn the Roles line into a `SettingRow` ("Models for this connection: 4 roles, Everyday uses sonnet" with a "Map tiers" link to app settings).

### 9. Two things called "Settings"
Screens: `app-1280-00.png` (sidebar "Settings", topbar "Settings", page title "App settings") vs `project-1280-00.png` (tab "Settings", page title "Project settings").
Experience: the app-wide control is a sidebar item below Projects (not in the top bar), labelled just "Settings"; the project tab is also "Settings". The topbar shows "Settings" while the page title says "App settings". A first-time user clicking sidebar "Settings" after opening a project is not sure which scope they are in. The topbar on the app page has a redundant title because the page then repeats it.
Recommendation: rename the sidebar item "App settings" (and the topbar title the same); keep the project tab "Settings" but add the project name to the page title ("Demo settings" or keep "Project settings"). Remove the duplicate title line on the app page.

### 10. Maintenance and Danger zone: raw git terms and a weak destructive pattern
Screens: `project-1280-03.png`.
Experience: "Report branches waiting in the repository", "None. Every report branch has been merged or discarded." and a bare "Refresh" link-style button next to a long caption. The Danger zone card is good (red border, only one button) but its first line is a label not a sentence: "Files OrgAI added to the repository / None recorded. Any leftover worktrees and the .git/info/exclude entry are still removed."
Recommendation: when nothing is pending, collapse Maintenance to a single quiet line "No report branches waiting" with the Refresh icon. State the Danger-zone consequence in one sentence ("Deletes the files OrgAI created in your repo. Your own files stay.").

### 11. Defaults for new projects: select text is truncated and descriptions are packed into option labels
Screens: `app-1280-03.png`.
Experience: "Permission mode" select shows "Unattended: Claude decides each call, asks only when unsu" cut mid-word. Model selects show "Opus · Deep reasoning, orchestration, architecture". Cost cap and Runs to keep sit in an inconsistent two-column then one-column grid (Runs to keep alone on row 3, leaving a hole to its right).
Recommendation: options show the short name only; put the description in the hint under the select, matched to the chosen value. Use a stable grid: two columns of selects, then number inputs in a single compact row.

### 12. Smaller items
- Appearance: the accent hex input is exposed at rest, next to six swatches. Offer "Custom..." that reveals it. (`app-1280-00.png`)
- "Changes apply right away." (Appearance) and the Saved indicator in the project topbar behave differently: the app page has no save feedback at all while project settings shows Saving.../Saved. Add the same SaveIndicator to the app page.
- About: duplicates "Mock adapter available" as a chip with no explanation; version, platform and two folder paths take 4 rows at 150 px of label gutter. Fine content, but a muted footer treatment would reduce weight.
- Project MCP section: four equal-weight buttons in a row ("Add from library" primary, "Add from registry", "Add manually", "Configure with AI") plus an empty-state card that repeats the same four choices in a sentence. Keep the buttons, cut the empty-state sentence to one line.
- Plugins sits under the nav item "MCP and plugins" but the MCP and Plugins headings are equal weight; make MCP servers and Plugins sub-sections of one section.
- General: the "Let runs message each other" toggle is a cross-project capability buried under Project brief with a long hint; move it to Agent behaviour or Permissions.

## Inconsistencies between the two pages

| Aspect | App settings | Project settings |
| --- | --- | --- |
| Section separator | hairline rule above each section | none, whitespace only |
| Page header | "App settings" plus a duplicate "Settings" topbar | "Project settings" under a tabbed topbar |
| Sub-nav | 6 items, includes About, omits Usage | 6 items, "MCP and plugins" merges two sections, "Limits" hides four groups |
| Control layout | mix of SettingRow (right-aligned) and stacked label | almost all stacked label, input, hint; two-column grid in Limits |
| Control width | selects and numbers at three widths | inputs at full, 50 percent and 160 px |
| Group heading | section heading only | section plus unlabeled bold sub-headings (Unattended execution, Subscription limits, Parallel work) |
| Save feedback | none visible | SaveIndicator in topbar |
| Empty states | card with icon and title plus sentence (MCP library) | same card, but extra sentence repeating the buttons |
| Nav active state | lags one section | lags one section |

## What to keep

- The Danger zone card on the project page: red outline, single button, clearly separated.
- Provider cards with a status chip (Connected / Not connected) and a refresh icon: status is readable at a glance.
- Theme as a Dark / Light / System segmented control with "System follows your operating system" as the only hint.
- Notifications is correctly a single row: one toggle, one-line hint (22 words total). This is the pattern to copy.
- Appearance toggle rows right-aligned (Tint the canvas, Show the minimap).
- Tier mapping as a table of label plus select with the role described beside it, once moved under an advanced disclosure.
- MCP empty states with an icon, a title and an action row.
- The numeric hints that state units and consequences ("Blank turns it off. The run is interrupted and waits for you") are useful when shortened to one line.

## Suggested structure (for the UI Lead)

App settings: General (Appearance, Notifications), Connections, MCP library, Defaults (including Usage), About. Five tabs or panes, none over about 150 words at rest.
Project settings: General (name, folder, brief), Agents and limits (permission mode, saved rules, limits, unattended, parallel work), Connection, Tools (MCP and plugins), Maintenance. Five panes. The per-section word budget after: General 40, Permissions 50, Limits 90, Connection 40, Tools 50, Maintenance 20.
