# Pocket Office pre-change UX walkthrough

Reviewer: UX Researcher. Built `0773769c` with `npm run build`; ran the built app with `ORGAI_MOCK=1` and a fresh temporary data directory. Compared with `docs/design/pocket-office.md`. The captured window was 1424 × 855, dark theme. The walk was stopped early at the lead's request; this is not the required full size, theme and keyboard matrix.

Screenshot directory (absolute): `C:\Users\chapp\Projects\OrgAI\.claude\worktrees\agent-cx_mw8dc88urfi9krl4\.claude\worktrees\agent-cx_mw8dd6jci1vab0dj\e2e\shots`. Screenshots are gitignored and will not follow the report when the worktree is removed.

**Verdict: PARTLY VERIFIED.** The presentation and palette can be found in Settings, and a Team person opens the role panel. In a compact Live scene, names and the actionable status are visually truncated. The Office entry and controls also need clearer visible labels.

## Findings

### M1 — Live person plates truncate identity and actionable status

1. Start a mock run, choose Pocket Office from Canvas style, and wait for the mock permission request.
2. Read the two people while the permission tray is open.

At the resulting 1× scene scale the plates show “Orchest…” and “implem…”; the latter's “Needs you” status appears as “Needs y…”. The accessible text contains the full words, but they cannot be read visually on the scene. Make plates fit or wrap complete names and status independently of sprite scale. Preserve the concrete copy “Needs you”.

Screenshot: `e2e/shots/ux-pocket-live.png`.

### M2 — Canvas style entry and choices lack visible context

1. Open Team and select the palette icon in its toolbar.
2. Read the Office presentation and palette controls and the graph gallery below.

The icon has the accessible name “Canvas style” but no visible label. The rows of Graph/Pocket Office and Color/Neutral/Green have no visible group headings; graph styles follow under “Choose a graph style to switch to Graph.” Add visible “Canvas style” to the trigger where space permits and label the groups “Presentation”, “Office palette”, and “Graph styles”.

Screenshot: `e2e/shots/ux-pocket-toolbar.png`.

### M3 — Settings sample is too constrained to preview the office

1. Open App settings > General > Canvas and select Pocket Office.
2. Inspect the sticky sample alongside the graph gallery.

The small sample shows only part of a room and a narrow black Lead / Sample plate; the graph gallery occupies much more space. The gallery has explanatory text but no visible “Graph styles” heading. Give the Office sample enough space to show the room and legible person labels, and add the heading “Graph styles” above the gallery. The scope copy “Applies to Live, Team and the sample preview.” was present.

Screenshot: `e2e/shots/ux-pocket-settings.png`.

### L1 — Team role panel has an obscure close affordance

1. In Team, select Orchestrator in the office.
2. Look for a way to close the role panel.

The existing inspector opens, but its visible close affordance is an icon at the far top right, named “Hide team panel” to assistive technology. Consider a visible “Close” control or tooltip that clearly connects the action to the panel. Escape returned focus to the person button in this check; the role panel remained present.

Screenshot: `e2e/shots/ux-pocket-inspector.png`.

## Also observed

Escape from Canvas style returned focus to its trigger. Selecting Graph in the popover returned the Team canvas to Graph while keeping the role inspector open (`e2e/shots/ux-pocket-graph.png`). These were targeted interactions, not a complete keyboard-only pass.

## Not driven

1024 × 640 and 1600 × 1000, light theme, a complete keyboard-only journey and accessibility-tree audit, palette persistence, Live inspector close and focus return, finished and historical agents, activity and message delivery, reduced motion, screen-reader speech, measured contrast and zoom were not verified. The walk was stopped early to unblock the design. The mock run incurred no provider spend.
