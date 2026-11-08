# Pocket Office: baseline UX walkthrough

Reviewer: UX Researcher. Built `2b0994db` in this worktree and ran the built app with `ORGAI_MOCK=1` and a fresh data directory. Compared with `docs/design/canvas-themes.md` and the main checkout's `outputs/retro-office-canvas-research.md`. Screenshots: `e2e/shots/ux/pocket-office-before/` (gitignored). This is a partial baseline, not an approval of the proposed design.

**Verdict: PARTIAL.** The mock run demonstrates that selecting an agent opens its inspector and that the decision tray is actionable independently of the canvas. At 1024×640, Enter on a focused Team node opens its editor and moves focus to the name, an edit persists across tab navigation, and a finished group reveals its reports. Preserve these behaviors in a scene presentation. The full size/theme and keyboard matrix remains unverified.

## Findings

### M1 — Sample canvas shows implausible elapsed time

Screen: App settings > General > Canvas; screenshots `settings.png`, `settings-light.png`.

1. Open App settings and scroll to Canvas.
2. Read the duration shown on the active sample agents.

The sample showed `26153h 5m` on three agents, making the preview look broken and distracting from its purpose. Use fixed, plausible sample durations (for example `2m 15s`) and ensure they do not depend on an epoch timestamp. Suggested explanatory copy remains: “How the org chart and run canvases look. Both follow these settings.”

## Baseline interactions to preserve

- Team: selecting Implementer opens its editable role inspector, including identity, reporting relationship, model, tools, skills, delegation and instructions. The toolbar changes to “New roles report to Implementer.” The canvas instructs: “With a node focused, Enter edits it and Delete removes it.” Screenshot: `team.png`.
- Live: the mock task produced a permission card for `Edit example.ts`, with Allow once, Allow for session, Always allow for project and Deny. Allow once dismissed the card; selecting Implementer changed the inspector to that agent's transcript, with Plan, Usage, Outputs and Logs tabs. Screenshot: `live.png` captures the decision.
- At 1024×640, focusing the Implementer Team node and pressing Enter placed focus in its name input. Renaming it Builder and switching Live → Team retained Builder on the canvas. Screenshot: `team-keyboard-1024.png`. The node exposed the accessible name “Implementer, role. 6 tools. Press Enter to edit, Delete to remove.” This exercised Enter after programmatic focus, not a complete Tab-only route.
- At 1024×640, after the mock run finished two reports, the canvas showed “2 done” and a button named “Show reports under Orchestrator”. Activating it revealed both reports, including the one that ended without a result, and announced “Showing 2 agents under Orchestrator”. Screenshots: `live-1024.png`, `reports-1024.png`.
- The existing canvas specification requires distinct selection and keyboard-focus indicators and reveal controls for earlier-session agents. These are specification requirements; this partial walk did not verify each one.
- Research calls for event-driven message illustration that never delays real communication, reduced-motion static indicators, and no implied durable message replay. These are design requirements, not observations of the current UI.

## Not driven

Exact 1600×1000 content size, a complete keyboard-only pass, accessibility-tree inspection, prior-session agent reveal and the full dark/light matrix were not verified. The light Settings preview was captured, but the other light screens were not walked. Team persistence was checked across tab navigation, not app relaunch. Native dialogs, long text, errors, relaunch and reduced motion were not exercised. No paid smoke scripts were run.
