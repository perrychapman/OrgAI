# Settings polish pass

Lead: ui-engineer (settings), 2026-11-24, base dev. Scope: every App and Project settings pane and the dialogs they
open, in the built app on the mock adapter with a throwaway data dir seeded with worst-case data. Screenshots are
gitignored (`e2e/shots/pol-*.png`, `srch-*`, `prov-*`, `mcp-*`, `upd-*`, `tour-*`, `open-*`); their names are given
below. Boards compared: `docs/design/ui-overhaul/project/*.dc.html` (read in `impl-settings.md`; not re-rendered).

## What was looked at

- Data: 6 proxies with long names and URLs (3 with a key, 3 without, all failing to connect), Anthropic connected,
  OpenAI not connected; 19 custom MCP library servers (http and stdio, long descriptions, a missing-secret slot) and the
  38 curated services; 30 library skills with long names and a 2,355 character body; 2 built-in and 8 saved templates;
  a code project with every limit set, three long allowed folders and a reference folder; a code project with none set;
  an engagement; an update ready to install (`ORGAI_UPDATE_MOCK=available`); a server test that failed (npm 404).
- Sizes and themes: 1024x640 and 1600x1000, dark and light, every pane. Text size Small / Default / Large and
  Comfortable / Compact were run through a DOM audit of all eleven panes in all 24 combinations (page and scroller
  horizontal overflow, clipped text, controls under 24x24, overlapping controls, ellipsis), and Large with Compact was
  looked at on Appearance, General, Permissions, Branches and Tools. Tall captures (up to 4200 px) showed whole panes.
- Dialogs opened: Add proxy, a service's dialog, the MCP registry dialog, New skill, the template "Start a new project"
  form. The Save template, kit import and export, and Import skills dialogs were not opened (they use native pickers or
  need a project with a team; see "Not verified").
- Search: results, no results, a long query.

## Findings

Severity: High = unusable or wrong; Medium = visibly broken or inconsistent; Low = polish. Status F = fixed here, L = left.

| # | Sev | What | Where | Screenshot | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | High | The Settings search results opened behind the settings menu and the pane (the glass top bar paints under the page), and what showed was see-through, so the list was unreadable | Settings top bar, any pane, 1024 and 1600 | `srch-results-1024x640-dark` | F: `.settings-topbar` gets its own level; the popover is solid |
| 2 | High | A proxy's detail panel laid its fields out in two columns (the container query measures the settings column, not the 300 to 400 px panel), so the second column was cut off at the panel edge: "Pr", "UR", "Us" | AI providers, a proxy tile selected | `prov-proxy-open-1600x1400-dark` | F: fields stack inside the panel |
| 3 | High | Below about 1280 px the detail panel is stacked under the tile grid (12 provider tiles, 38 services, 30 skills): the selected tile and its panel are screens apart and after the jump there was no way back to the list | AI providers, Tools and services, Skills, Templates at 1024x640 | `pol-app-aiproviders-1024x2600-light-tall`, `pol-app-toolsandservices-1280x4200-dark-tall` | F: "Back to the list" at the top of the panel (only where it is stacked; moves focus to the selected tile) |
| 4 | Medium | The Tools filter chips were a one-line strip with its scrollbar hidden: chips were cut off at the edge ("Proje"), a mouse could not reach the rest, focus rings were clipped | Tools and services, 1024 | `pol-app-toolsandservices-1024x640-dark-lg` | F: chips wrap |
| 5 | Medium | The Test command field was 238 px wide and clipped real commands ("npm run lint && npm run typeche") | Branches | `pol-project-branches-1600x1000-dark` | F: own line, full width |
| 6 | Medium | The project Name (and "Who or what it is for") field was 238 px wide and clipped long names | Basics | `pol-project-basics-1600x1000-dark` | F: full width |
| 7 | Medium | Basics still sent people to "App settings > Connections" and "Open connections"; the pane is "AI providers" | Basics, project connection row | `pol-project-basics-1600x1000-dark` | F |
| 8 | Medium | Library rows in Tools had a 32 px indent (made for a switch library rows do not have) on the Edit / Remove menu, errors, secrets note and test result, and a failed test drew a red box inside a bordered box | Tools and services, custom tools | `mcp-tested-1280x1000-dark`, `mcp-menu-1280x1000-dark` | F |
| 9 | Medium | Dollar limits showed bare numbers ("2.5", "20", "300") | Spending limits | `pol-project-spendinglimits-1600x1000-dark` | F: a "$" inside the field (the stored and typed value is unchanged) |
| 10 | Medium | Gallery names were cut to one line with an ellipsis, so skills, templates and proxies named alike looked identical ("polish-skill-0-with-a-very-lo...") | Skills, Templates, AI providers | `pol-app-skills-1600x1000-dark` | F: two lines before the ellipsis; the full name stays the title |
| 11 | Medium | Status lines on tiles in one row sat at different heights (a wrapped line above pushed them) | AI providers | `pol-app-aiproviders-1600x1000-dark` | F: pinned to the bottom of the tile |
| 12 | Medium | The chosen option of a segmented control was one grey step from its track (hard to see in dark), its right edge did not line up with the selects, switches and numbers above and below, and unselected options had no hover | Every segmented choice: General (When I close the window), Spending limits, staffing, auth pickers | `pol-app-general-1600x1000-dark`, `open-spendinglimits-1280x2600-dark` | F: accent wash and edge, right aligned in rows, hover |
| 13 | Medium | The colour mode cards wrapped to two and one at 1024, and the "Match my computer" thumbnail had a dark line down its right edge (the gradient repeated under the border) | Appearance | `pol-app-appearance-1024x640-light` | F |
| 14 | Medium | "Your name" put a three-line hint under a 240 px field, and still said "Dashboard" (the page is Home); this is UX review L7 | General | `pol-app-general-1600x1000-dark` | F: hint under the title, reworded |
| 15 | Medium | Switches are 32x20 (32x16 in Compact), under the 24x24 target, on every settings page | `styles/ui.css` `.switch` | audit | L: shared file, sent to polish-shell |
| 16 | Low | Panes with and without a scrollbar laid out at different widths, so the detail panel and the Practice kit buttons jumped about 10 px between Skills and Templates (UX review L8) | all panes | `pol-app-templates-1600x1000-dark` vs `pol-app-skills-1600x1000-dark` | F: `scrollbar-gutter: stable` |
| 17 | Low | Group captions ("Run staffing", "Danger zone", "Runs") sat 4 px in from the section titles and cards | Maintenance, Spending limits, Permissions | `pol-project-branches-1600x1000-dark` | F |
| 18 | Low | The Context notes switch sat outside any card, 16 px to the right of every other switch | Basics (engagement) | `pol-project-basics-1600x1000-dark-eng` | F: inside a card |
| 19 | Low | The Spending limits hero grew by a line when the numbers arrived and pushed the page down | Spending limits | by reading `MonthSpend.tsx` | F: a second line while loading |
| 20 | Low | The "Secrets: 0 of 1 set" link in a tool row was 20 px tall | Tools and services | audit | F: 24 px |
| 21 | Low | The no-results line wrapped without a break point for a long unbroken query | Search | `srch-long-1024x640-dark` | F |
| 22 | Low | Canvas style descriptions are cut at two lines at 1024 and have no full text anywhere | Appearance > Canvas | audit | L: `canvas-settings.css` is not in this pass's files |
| 23 | Low | Permissions says "The model's safety check approves routine calls and asks when unsure" twice (the effects table and the line under it) and the rule line is indented differently from both | Permissions | `open-permissions-1280x2400-dark` | L: wording, owner |
| 24 | Low | A proxy that failed to connect shows the error twice (the banner and the first line of "what the last test found") | AI providers, proxy | `prov-proxy-open-1600x1400-dark` | L: both are useful alone; owner |
| 25 | Low | "Your skills" is both the section title and the list label under it | Skills | `pol-app-skills-1600x1000-dark` | L: owner |
| 26 | Low | The Off state of a switch is a heavy slate fill in light, close to the On weight | all switches in light | `pol-app-general-1600x1000-light-v3` | L: shared |
| 27 | Low | UX review L5 (cost precision), L12 (Maintenance versus Branches for engagements) | Spending limits hero, nav | | L5: the hero uses `formatUsdCompact` (not re-measured); L12 is by design (engagements have no branches) |

## What was found fine

- Both themes: glass edges are visible on every card in light; contrast of secondary text on glass looked fine in the
  captures; no horizontal overflow on any pane in any of the 24 text-size, spacing, theme and size combinations.
- Dialogs: Add proxy fits 1024x640 with its footer pinned and the body scrolling; service, registry and New skill
  dialogs fit.
- Long data: 19 custom servers with long descriptions wrap and keep their Test and menu buttons in the corner; the
  failed test output scrolls inside its box with Copy output.
- A fresh project (no limits set) shows "No limit" placeholders and the Automatic main branch.

## Left for the owner

- Switch size (finding 15): a 24 px hit area on a 32x20 track needs the shared `.switch` styles.
- Whether the seg control's accent look should differ from the Run settings use (it is one control; the change is in
  `connections.css`).
- Permissions wording duplicates (23) and the repeated "Your skills" (25).
- Canvas style descriptions (22): show the full text in a tooltip or let the cards grow.

## Files

`src/renderer/src/styles/settings.css`, `connections.css`, `connectors.css`, `mcp.css`, `mcp-library.css`;
`components/settings/SettingsGallery.tsx` (new `DetailBack`), `GeneralSection.tsx`, `BranchRulesSection.tsx`,
`LimitsSection.tsx`, `ContextNotesSection.tsx`; `components/connectors/ConnectorDetail.tsx`;
`components/connections/ProjectConnection.tsx`; `components/limits/MonthSpend.tsx`; `views/AppSettingsView.tsx`.

## Not verified

- Screen reader speech (the new "Back to the list" button is a native button with a visible label); macOS and Linux;
  Save template, Import skills, kit import and export dialogs; the OAuth and auth notices, per-project values and the
  Skills evaluation panel (no data for them in this profile); the folder trust section (another engineer's file).
