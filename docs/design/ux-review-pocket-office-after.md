# Pocket Office: post-change UX walkthrough

Reviewer: UX Researcher. Initial built UI worktree `b56a1fbf`, `ORGAI_MOCK=1`, fresh data and fixture project; no paid runs. Settings sample captured at 1024×640 and 1600×1000 in dark and light; Team and Live walked at 1600×1000 dark, with a 1024×640 Live capture. Compared with `docs/design/canvas-themes.md`, the pre-change review and `outputs/retro-office-canvas-research.md`. Screenshots under `e2e/shots/ux/pocket-office-before/` (gitignored). This review is provisional pending the UI lead's fixes and a re-walk.

**Verdict: PARTLY VERIFIED.** On initial build `b56a1fbf`, the office misrepresented an agent that ended without a result and called actual Team roles “Sample”. On the updated built UI worktree `7b79b027`, both issues are fixed in the exercised mock flow. The historical and other coverage listed below remains open.

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

## Preserved in this pass

- Settings explicitly calls its scene “Sample office · example agents”; dark/light captures exist at both requested window sizes.
- Team: Enter on a focused Implementer button opened its editable inspector; Escape returned focus to the selected agent button. This began with programmatic focus, not a complete Tab-only navigation.
- Live: Enter on `implementer-2` selected it and opened its transcript, including “Look for related tests”; focus remained on its agent button. Permission Allow once was available and allowed the run to proceed.

## Not driven

A complete keyboard-only route and visible focus at each stop, palette persistence, switching back to Graph and preserving its preferences, Team save, prior-session agents and transcripts, large rooms, actual delivery animation, reduced motion, no replay on reopening, and the full Live/Team size-theme matrix remain unverified. Settings screenshots alone do not establish the entire matrix. The run showed no observed message delivery; do not infer animation or replay behavior from it.
