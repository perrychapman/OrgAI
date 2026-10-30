# OrgAI UX review: placement and brand re-walk after Phases 1 and 2

Reviewer: UX Researcher. Baseline: `ux-review-placement.md` (P1-P15, B1-B10 at `1108b74`). Spec: `ui-review-2.md` B.1 to B.9 and C.

## 1. Header

- **Commit reviewed:** dev HEAD `9ee86a9`. `npm run build` was run first; `out/` was driven.
- **Method:** playwright-core `_electron` as in `e2e/lib.mjs`, from throwaway drivers in `e2e/shots/ux/_t/` (`p2-common.mjs` plus `p2-a.mjs` to `p2-j.mjs`). `ORGAI_MOCK=1`, a fresh temp `ORGAI_DATA_DIR`, `ORGAI_MOCK_SCRIPT` rewritten between runs. Two projects were created with "Use the mock adapter" ticked and "Set up with the Architect" off, so no tokens were spent and the real profile was never touched. One plain run (spawn, read, finish) and one run with three open decisions (two background permission asks, Bash and Edit, plus an `ask_user` question). Light theme was switched through Settings > Appearance. One keyboard pass: Tab from the skip links through the Live view, Ctrl+B, ArrowRight across the side tabs, Esc on the legend, needs-you and account popovers.
- **Sizes:** window 1024x640 (inner viewport 1008x641), 1424x881 (1408x842), 1600x1000 (1584x961), dark and light. Measurements are inner viewport pixels. 1280x800 was probed once.
- **Walked:** first launch, Projects, sidebar expanded and as a rail, account row and popover, Needs-you row and popover, topbar and tabs, Live empty, plain run, ended run, three decisions, legend popover, side panel collapsed and open, composer, History, Org chart (shell consistency only), project Settings, app Settings > Appearance.
- **Not walked:** a setup (Architect) session with proposal cards, the MCP install card, a real (non-mock) account row with usage bars (mock shows "Mock adapter" and no bar), real connection errors.
- **Shots:** `e2e/shots/ux/placement2/<name>.png`, 15 of them force-added (listed in section 7). Raw measurements: `e2e/shots/ux/placement2/measure.json` (gitignored, not kept).
- Note: the persisted sidebar and side-panel toggles carry over inside one data dir, so a few uncited probe shots show the toggled state. The cited shots say which state they show.

Severity: **High** hurts the main path or the first impression at a supported size. **Medium** costs scanning time or trust. **Low** polish.

## 2. Verdict and top findings

The shell and the run workspace are a large step forward. The strip merge, the 48 px topbar with underline tabs, the single account row, the "Needs you" row and popover, the tray under the canvas and the 40 px chrome budget all work and read as modern. At 1424 and 1600 the Live view is calm and the decision is the loudest thing on screen, as intended. The new problems are all in the decision tray at narrow widths and heights, which is exactly the situation a decision is most likely to arrive in.

1. **Q1 (High)** At 1024x640 a question decision cannot be answered without scrolling inside a 20 px window. Compact mode hides the options behind "Details"; opened, they sit in a sliver and the disabled Submit is flush with the tray edge.
2. **Q2 (High)** The decision chip row overlaps itself ("Question2Bash:Ie Edit:") and grows a horizontal scrollbar whenever the tray is under about 700 px wide. That happens with the side panel open at 1024 and whenever the tray docks beside the canvas, and it pushes the action footer to or past the tray edge.
3. **Q3 (Medium)** The tray moves from under the canvas to beside it when the user collapses the transcript at 1424. The primary action teleports and ends up in a 386 px column.
4. **Q4 (Medium)** At 1024x640 the stage is 245 px tall (44% of the frame, spec says 55%) so fit-to-view zooms the nodes to 0.61 and their 12 px text renders at about 7 px.
5. **Q5 (Medium)** The rail is only discoverable by hovering the logo tile, and in rail mode the MOCK marker disappears; the only hint left is a green dot.
6. **Q6 (Medium)** One fact, three numbers: "Needs you . 3", the project badge "1" and "1 needs you".

## 3. Status of every earlier finding

| Id | Status | Evidence |
| --- | --- | --- |
| P1 | **Partly** | Canvas at 1024 with 3 decisions went from 216x366 to 912x245 (`06-decisions-dark-1024`), tray is under the canvas, zoom is out of the canvas (toolbar). Width is fixed. Height and the narrow tray are not (Q1, Q2, Q4). |
| P2 | **Fixed** | Topbar 48 + run strip 40 = 88 px (was 139). Title is no longer squeezed; no run header row. With the 32 px canvas toolbar it is 120 px (`06-decisions-dark-1424`). |
| P3 | **Partly** | Orange block is gone; one "Needs you . 3" row with a popover; no pill in the topbar or the run header. Carriers on screen are 6 (was 8+), but the counts disagree (Q6). |
| P4 | **Fixed** | Footer is 52 px (89 px in the rail, was 144 to 237). One row, popover with "Runs use scripted data" and a Connections link (shot not kept). Real usage bars not re-walked (mock shows none). |
| P5 | **Fixed** | Folder name only in mono with a folder icon; tabs sit next to the name. Saved indicator at 1024 shrinks to a bare check mark with no label (Low, Q13). |
| P6 | **Fixed** | Underline tabs for sections, chip-shaped tabs for runs: two idioms, each with a clear job (`06-decisions-dark-1424`). |
| P7 | **Partly** | Cards are titled by the action ("Edit server.js") with a 12 px meta line, and a chip list shows all three decisions. But chip labels truncate ("Question: Which limiter st...", "Bash: $ npm test -- --run r...", "Edit: Editing server.js" repeats the verb), the tray opens on "3 of 3", and the chips break when narrow (Q2, Q7). |
| P8 | **Still** | Org chart is Phase 3. `18-org-dark-1024`: panel 360 px covers the Orchestrator node, triple "Revise with the Architect" headings, filled purple button outranks "Add role", React Flow zoom buttons still float over the canvas (Q10). |
| P9 | **Partly** | One neutral MOCK tag by the wordmark, no orange, no sidebar badge row. The Projects topbar still has an orange "Mock mode" badge (Phase 3, not ranked). In the rail the MOCK tag is gone (Q5). |
| P10 | **Partly** | Gear "App settings" is in the footer. The nav item "Projects" and the group label "Projects" still stack (`02-projects-grid-dark-1424`). |
| P11 | **Still** | Cards unchanged: path cut at `C:\Users\chapp\AppData\Local\Tem...`, "Delete" at chip weight, two "RE" avatars (`02-projects-grid-dark-1424`). Not in the Phase 1 or 2 scope. |
| P12 | **Still** | `19-psettings-dark-1424` (uncited): h1 "Project settings" repeats the tab, the sub-nav lists General first. |
| P13 | **Fixed** | Mode toggle "New run / Continue this run" is on the label line next to the textarea (`16-ended-dark-1424`). Composer is 107 px (was about 150, target 96). |
| P14 | **Still** | First-launch form at 1024: the "Create and start setup" button is below the fold; at 1600 the form is pinned left with 60% empty (`01-first-dark-1024`). |
| P15 | **Fixed** | Tab order verified: Skip to content, Skip to sidebar, Expand sidebar, All projects, Needs you, projects, account, gear, Live tab, run tabs, New run, Interrupt, End, toolbar, canvas, tray chips, Details, Allow once, Deny, composer, then the side-panel toggle. It matches the visual order. |
| B1 | **Partly** | Gradient shows on the logo tile and the tab underline; the brand glyph is in the empty state (`04-live-empty-dark-1424`). Primary buttons and focus ring are still a flat violet. |
| B2 | **Partly** | Mock is neutral now. Role avatars are still purple, blue, green, orange (`02-projects-grid-dark-1424`); orange still means both "Researcher" and "Needs you". Phase 3. |
| B3 | **Fixed** | Pills on Live fell from 9 to 4 (MOCK, project count, Decisions count, kind badge) plus the 3 chips. Cost, agents, steps and "unattended" are plain text with icons. |
| B4 | **Fixed** | No filled orange blocks. One bell row and an orange count (`07-needs-pop-dark-1424`). |
| B5 | **Fixed** | Three surface steps are visible in both themes (sidebar, canvas, tray, card); borders are lighter. |
| B6 | **Fixed** | Measured minimum font in stage, toolbar and tray is 12 px. Legend moved into a `?` popover (`08-legend-dark-1424`). |
| B7 | **Fixed** | Disabled "Start" and "Send" are a neutral slate with muted text; they no longer pass as primary buttons (`04-live-empty-dark-1424`). |
| B8 | **Still** | Nodes still carry name, mono `role . mock`, status and a tokens/cost line (`06-decisions-dark-1424`). |
| B9 | **Fixed** | One dot per run tab, status word is `aria-label` only. The amber "i" is gone. |
| B10 | **Fixed** | Light parity holds (`21-decisions-light-1424`); orange tints are quiet. |

## 4. New findings (Q)

| Id | Sev | Screen / size | What a user sees | Why it is a problem | Suggested fix | Shot |
| --- | --- | --- | --- | --- | --- | --- |
| Q1 | High | Live, 1024x640, a question among three decisions | The question card shows its title ("Answer: Which limiter strategy...") and a "Details" button. Opening Details reveals a 20 px high scrolling sliver that repeats the question; the options and the free-text note are below the fold of that sliver. "Submit" is disabled and sits flush against the tray bottom. The user has to scroll inside a tiny box to find out what they are choosing from. | A decision is the reason the run stopped. The options are the action, not a detail. Hiding them fails the "answer without reading docs" test at the smallest supported size. | For `ask_user`, render the options inline in the compact card (radio list, two lines) and make the tray able to grow to 45% of the frame when a decision is open. Or open the question in a sheet that replaces the stage. Do not repeat the question in title and body. | `14-question-details-1024`, `13-1024-sb-rail-side-open-q` |
| Q2 | High | Live, tray narrower than about 700 px | The chips overlap ("Question2Bash:Ie Edit:") and a horizontal scrollbar appears under them. The scrollbar takes about 10 px, so the card footer ("Allow once", "Deny") ends flush with the tray bottom and the card's bottom border is cut. Measured: chip list scrollWidth 180 > clientWidth 58 when the tray is beside the canvas at 1424. It also happens at 1024 with the side panel open (tray 672 px) and with both sidebar and side panel open (496 px). | The chip list is the way to reach decisions two and three. When it breaks the user can miss a decision, and the footer is the action area. | Do not let chips shrink: `flex: 0 0 auto`, and below about 700 px collapse to numbered chips ("1 2 3", label in tooltip) or a single "Decision 1 of 3" select with the pager. Remove the scrollbar. Reserve the footer height in the tray. | `13-1024-sb-rail-side-open-q`, `10-sidepanel-collapsed-dark-1424` |
| Q3 | Medium | Live, 1424x881 | Collapsing the transcript (the panel toggle at the top right) widens the frame to 1136 px and the tray jumps from under the canvas to a 386 px column beside it. The canvas becomes 750x615 and the card is squeezed. | The rule is "beside when the frame is at least 1100x560", but the user triggered a different intention (more room for the chart). Moving the primary action sideways without a cue disorients; 386 px is also narrow for a card with a command and Allow/Deny. | Keep the tray under the canvas at every width below about 1500 px, or make beside docking a user choice (a toolbar toggle). If kept, give the beside tray a 420 px minimum and the Q2 chip fix. | `10-sidepanel-collapsed-dark-1424` |
| Q4 | Medium | Live, 1024x640, 3 decisions | Stage 912x245 (44% of the 553 px frame; the spec target is 55%). Fit-to-view picks scale 0.61, so the 12 px node text is about 7 px and the second node ends at the tray edge. At 1424 the stage is 847x361 (48%), at 1600 973x480 (55%). | Chrome-to-content ratio: tray 169 px plus composer 107 px leave too little for the thing being watched, and the nodes become unreadable exactly when a decision asks about them. | Cap tray plus composer at 45% of the frame; shrink the composer to the 96 px target; below 300 px stage height render nodes in a compact two-line form (name, status) or clamp fit zoom to 0.8 and allow pan. | `06-decisions-dark-1024` |
| Q5 | Medium | Sidebar rail, below 1180 px | The rail is the logo tile. It is the only way to expand (a button with a "Expand sidebar" tooltip); there is no chevron, no hover state in a screenshot and no shortcut hint. Ctrl+B works but is not shown anywhere. The MOCK tag disappears in the rail; what is left is a green dot at the bottom with no word. The project buttons are two-letter initials (BS, NA) with a status dot. | Discoverability: a user at the default 1024 window sees an icon strip and no clue how to get the labels. A mock-mode user at 1024 cannot tell they are on mock data. Initials collide for projects with the same first letters. | Add a chevron icon under the tile, put the shortcut in the tooltip ("Expand sidebar (Ctrl+B)"), keep a 6 px flask badge on the tile in mock mode, and label the account dot with a tooltip "Mock adapter". | `06-decisions-dark-1024`, `01-first-dark-1024` |
| Q6 | Medium | Sidebar, Live | With one run holding three decisions: "Needs you . 3" (decisions), badge "1" and "1 needs you" on the project row (runs), bell "3" in the rail. | The unit changes between neighbours; clicking the "1" badge leads to a list of three. | Pick one unit per level: decisions everywhere, or "n runs" everywhere. Sidebar row "3 decisions . 1 run". | `07-needs-pop-dark-1424`, `06-decisions-dark-1424` |
| Q7 | Medium | Needs-you popover and tray | The popover lists "Notes API . R6: Add rate limiting to" three times and puts the actual ask ("Implementer wants to use Bash") in grey second lines. Opening the run lands on the tray's "3 of 3" (Edit), not the blocking question that is listed first. | The distinguishing text is the least prominent; the entry point and the destination disagree. | Show kind and ask first ("Bash: npm test"), location second (muted). Open the run on the decision the user clicked, and default to the oldest or blocking one. | `07-needs-pop-dark-1424`, `06-decisions-dark-1424` |
| Q8 | Medium | Narrow main area, run strip | With the sidebar expanded and the side panel open at 1024 (main 776 px) "Interrupt turn" and "End session" become two unlabeled icons: a bars icon and a red square. | A destructive action without a label; the red square reads as "stop" but nothing says "end session". | Keep the text on "End session" and drop the label from "Interrupt turn" first, or move both to a "..." menu below 800 px. | `10-sidepanel-expanded-dark-1024` |
| Q9 | Low | Side panel stat line, 329 px | "mock . 800 in / 20 out . $0.0027 est. . 1s . waiting" wraps with a dangling middot at the start of the second line ("· idle", "· 13s · waiting"). | Separator characters wrap as text. | Render the items as flex-wrap with a gap and no separator characters. | `06-decisions-dark-1424` |
| Q10 | Low (Phase 3) | Org chart tab | The shell changed around it but the tab did not. React Flow zoom buttons still float at the bottom left of the canvas while Live moved them to the toolbar. At 1024 with the sidebar open the 360 px panel hides the Orchestrator node. | Inconsistent canvas chrome between two tabs of the same project. Expected for Phase 3. | Use the same dense toolbar and zoom IconButtons; start the panel collapsed below 1100 px. | `18-org-dark-1024` |
| Q11 | Low | History | The "Ended when OrgAI closed" badge is green like "Finished". Each row repeats "Open", a purple "Continue" and "Retrospective" (33 buttons for 11 runs). Badges themselves are clear and sortable. | Colour says success for an abnormal end. Row actions repeat. | Use the neutral or warning tone for "Ended when OrgAI closed"; show Continue and Retrospective on hover or in a row menu, keep "Open". | `17-history-dark-1424` |
| Q12 | Low | Run tab dot | R11 shows a blue dot right after "End session" while the node says "Stopped" and the sidebar says "Stopped". | The dot disagrees with the status word. | Map the dot to the same tone table as the sidebar project dot (grey for Stopped). | `16-ended-dark-1424` |
| Q13 | Low | Keyboard and Saved | The graph edge, "0/3 steps" and each decision chip are separate Tab stops (45 stops to loop the Live view; one is an off-screen edge). At 1024 the Saved indicator is a bare check mark. | Extra stops slow the pass; an unlabeled check. | Make chips one roving group, `tabIndex=-1` on edges, add a tooltip/`aria-label` "Saved". | `15-kbd-sidetabs-1024` (uncited) |
| Q14 | Low | After create project | A project created with "Skip AI setup" opens on the Org chart tab (with the AI panel), not on Live where the next step ("give it a task") lives. | The first path after creation shows an empty-ish editor and a purple "Revise with the Architect" button for a project the user chose not to set up. | Land on Live with the New run empty state. | `02-projects-grid-dark-1424` (project cards) |
| Q15 | Info | Projects topbar | The orange "Mock mode" badge is still there. Phase 3 removes it; not ranked. | Duplicate of the MOCK tag; orange. | Remove. | `02-projects-grid-dark-1424` |

Things I checked that work: Esc closes the legend, needs-you and account popovers and returns focus to the trigger; ArrowRight moves across Transcript, Plan and Logs and wraps; Ctrl+B toggles rail and expanded sidebar; Tab order follows the visual order.

## 5. Measurements before and after

Inner viewport pixels. "Before" is from `ux-review-placement.md`.

| Measure | 1024x640 before | 1024x640 after | 1424x881 before | 1424x881 after | 1600x1000 before | 1600x1000 after |
| --- | --- | --- | --- | --- | --- | --- |
| Chrome above the canvas (topbar + run strip) | 139 (22%) | 88 (13.7%) | 139 (16.5%) | 88 (10.5%) | 139 (14.5%) | 88 (9.2%) |
| Same, plus the 32 px canvas toolbar | n/a | 120 (18.7%) | n/a | 120 (14.3%) | n/a | 120 (12.5%) |
| Live canvas with 3 decisions | 216 x 366 | 912 x 245 (side panel collapsed) or 672 x 245 (open) | 480 x 538 | 847 x 361 | 592 x 657 | 973 x 480 |
| Canvas width as share of the main area | 28% | 96% (72% with panel open) | 41% | 72% | 44% | 72% |
| Stage height as share of the frame (target 55%) | n/a | 44% | n/a | 48% | n/a | 55% |
| Tray height (under the canvas, 3 decisions) | n/a | 169 | n/a | 254 | n/a | 254 |
| Composer height | about 150 | 107 | about 150 | 107 | about 150 | 107 |
| Sidebar footer height | 144 | 52 (89 in the rail) | 237 | 52 | 237 | 52 |
| Sidebar width | 232 | 56 (rail) | 232 | 232 | 232 | 232 |
| Brand lockup height | 76 | 48 | 76 | 48 | 76 | 48 |
| Pills and badges visible on Live (excluding the 3 chips) | 9 | 4 | 9 | 4 | 9 | 4 |
| Run-status carriers for one waiting run | 8+ | 6 (sidebar row, project row, sidebar run dot, run tab dot, node text, tray) | 8+ | 6 | 8+ | 6 |
| Effective node text size | n/a | about 7.3 px (fit scale 0.61) | n/a | 12 px | n/a | 12 px |
| Minimum font in stage, toolbar and tray | about 11 | 12 | about 11 | 12 | about 11 | 12 |
| Org chart canvas / AI panel | 416 / 360 | 416 / 360 (sidebar open), Phase 3 | 816 / 360 | not re-measured | 992 / 360 | not re-measured |

The pill count is by eye plus the DOM badge classes (MOCK tag, project count, Decisions count, kind badge). The 1600 shot is not cited because its layout is the 1424 layout with a taller canvas; the numbers are in the table.

## 6. Brand feel

It reads much closer to the logo now. The 48 px lockup with the org glyph tile, the neutral MOCK tag, the purple to blue gradient on the active tab underline, the brand glyph in the empty "Give Orchestrator something to do" page and the quiet three-step surfaces give the dark theme a deliberate, cohesive look instead of a default admin template. Light theme keeps the same discipline and the dark logo tile still pops on the pale sidebar. What still reads generic is the large flat violet: "Allow once", "Start", "New project" and the focus ring are one solid colour, so the gradient lives only in the logo and a 2 px underline, and the product never feels as colourful as the mark. The role avatars (purple, blue, green, orange) and the pastel node rings still compete with status colours, so a coloured node is "this role" and "this state" at the same time. Nodes themselves remain a five-line stat card in monospace, which looks like a debug panel next to the polished chrome. The Projects page and the Org chart tab belong to Phase 3 and visibly lag the shell: orange "Mock mode" badge, cut paths, two "RE" avatars, floating zoom buttons, a three-times repeated drafting heading. Finally, the new tray is the least finished piece: when it is narrow it breaks (Q2), which undermines the otherwise polished feel.

## 7. Keep

- The 40 px run strip with the merged tabs and actions; the strip carries one dot per run (`06-decisions-dark-1424`).
- The 32 px canvas toolbar: metadata as plain text with icons, Hide finished agents, zoom and legend in one place, nothing over the canvas (`06-decisions-dark-1424`).
- The "Needs you . n" row plus popover instead of the orange block; Esc closes it and focus returns (`07-needs-pop-dark-1424`).
- The 52 px account row and its popover with a Connections link.
- Underline tabs next to the project name and the folder name only (`04-live-empty-dark-1424`).
- Cards titled by the action with a meta line and a sticky Allow once / Deny footer at 1424 and 1600 (`06-decisions-dark-1424`).
- The legend popover (`08-legend-dark-1424`).
- The empty "New run" page with the brand glyph, role chips and a neutral disabled Start (`04-live-empty-dark-1424`).
- The composer with the mode toggle on the label line (`16-ended-dark-1424`).
- History status badges and the "Viewing" marker (`17-history-dark-1424`).
- Tab order that follows the visual order, two skip links, Ctrl+B, ArrowRight across side tabs.
- Dark and light parity (`21-decisions-light-1424`).

## 8. Cited shots

`e2e/shots/ux/placement2/`: `01-first-dark-1024`, `02-projects-grid-dark-1424`, `04-live-empty-dark-1424`, `06-decisions-dark-1424`, `06-decisions-dark-1024`, `07-needs-pop-dark-1424`, `08-legend-dark-1424`, `10-sidepanel-collapsed-dark-1424`, `10-sidepanel-expanded-dark-1024`, `13-1024-sb-rail-side-open-q`, `14-question-details-1024`, `16-ended-dark-1424`, `17-history-dark-1424`, `18-org-dark-1024`, `21-decisions-light-1424`. Shots mentioned as uncited were not kept.
