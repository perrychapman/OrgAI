# Pocket Office: post-change UX walkthrough

Reviewer: UX Researcher. Initial built UI worktree `b56a1fbf`, `ORGAI_MOCK=1`, fresh data and fixture project; no paid runs. Settings sample captured at 1024×640 and 1600×1000 in dark and light; Team and Live walked at 1600×1000 dark, with a 1024×640 Live capture. Compared with `docs/design/canvas-themes.md`, the pre-change review and `outputs/retro-office-canvas-research.md`. Screenshots under `e2e/shots/ux/pocket-office-before/` (gitignored). This review is provisional pending the UI lead's fixes and a re-walk.

**Verdict: PARTLY VERIFIED.** On initial build `b56a1fbf`, the office misrepresented an agent that ended without a result and called actual Team roles “Sample”. On final recheck `2c2f70f6` both are corrected in the exercised mock flow, as is the Team footer. Default scene names now wrap instead of being truncated. Coverage gaps remain below.

## Findings

### H1 — No-result agent was presented as having reported back — fixed in recheck

Screen: Live Pocket Office, `after-live-1600-dark.png`, `after-live-selected.png`.

1. Select Pocket Office in App settings > General > Canvas.
2. Start the default mock run, allow the edit once, and wait for both reports to finish.
3. Read `implementer-2` in the Agents list and select it.

The initial office list said “implementer-2 done · Current session · Reports to Orchestrator · Reported back”. The baseline graph showed the same mock agent as “Ended without a result”; its inspector contains a search but no report. On `7b79b027` the roster says “implementer-2 Finished · Current session · Reports to Orchestrator · Ended without a result” and the agent inspector opens. Updated screenshots `after-live-1024-dark.png` and `after-live-selected.png`.

### M1 — Editable Team roles were called samples — fixed in recheck

Screen: Team Pocket Office, `after-team-enter.png`.

1. Select Pocket Office, open a project's Team tab and read the Agents list.
2. Activate “Implementer Sample”; the actual project's editable role inspector opens.

Initially each actual role was labelled “Sample”, although the header correctly said “Team layout · roles, not live activity.” On `7b79b027` role buttons say “Role”; “Sample” remains appropriate for the Settings preview. Updated screenshot `after-team-enter.png`.

### M2 — Team footer called the actual office a sample — fixed in recheck

Screen: Team Pocket Office, `after-team-1600-dark.png`, build `7fab06b1`.

1. Open a project's Team tab with Pocket Office selected.
2. Read the instruction beneath the canvas: “Sample office. Select a role to edit it.”

These are the project's real editable roles, so “Sample office” was misleading. On `6a2b8b74` the footer instead says “Select a role to edit it. With a role focused, Enter edits it and Delete removes it.”

### M3 — Scene nameplates truncated default role names — fixed in recheck

Screen: Team, `after-team-1600-dark.png`, build `6a2b8b74`.

1. Open the default Team in Pocket Office at 1600×1000.
2. Read the nameplates over the workers.

Orchestrator, Implementer and Researcher appeared as “Orchest…”, “Implem…” and “Researc…” even with ample room around them. On `2c2f70f6` these names wrap over two lines and remain available in full in the roster (`after-team-1600-dark.png`).

## Preserved in this pass

- Settings explicitly calls its scene “Sample office · example agents”; dark/light captures exist at both requested window sizes.
- Team: Enter on a focused Implementer button opened its editable inspector; Escape returned focus to the selected agent button. This began with programmatic focus, not a complete Tab-only navigation.
- Live: Enter on `implementer-2` selected it and opened its transcript, including “Look for related tests”; focus remained on its agent button. Permission Allow once was available and allowed the run to proceed.
- Full-color builds `6a2b8b74` and `2c2f70f6`: selecting an off-floor finished agent from the roster switched to floor 2 and opened its transcript. Continuing the ended mock session exposed current and earlier-session agents with explicit labels; Enter on the earlier `implementer-2` switched floors and opened its original “Look for related tests” transcript (`final-prior-selected-1024.png`). Its roster retained “Ended without a result”.
- In this build the full-color scene fills the visible stage, walls are continuous, labels are anchored, and the earlier horizontal scroll margin is gone in the inspected 1600 dark Team screenshot. Team screenshots were also captured at 1024 dark/light and 1600 light (`final-team-*`).

## Not driven

A complete keyboard-only route and visible focus at each stop, palette persistence, switching back to Graph and preserving its preferences, Team save on this build, large rooms, actual delivery animation, reduced motion, no replay on reopening, and the full Live size-theme matrix remain unverified. The run showed no observed message delivery; do not infer animation or replay behavior from it.
