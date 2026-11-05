# Team files (renderer spec)

Answers `ux-review-team-files-pre.md`. The team of a code project is plain files under `.orgai/`; OrgAI shows whether they match what is in use and asks before anything adds power.

## Surfaces
- Status line (`team-files-line`): one quiet polite row in the Team toolbar's second row, never a Banner (H1). States: in sync; changed, not committed (Commit); N changes need approval (Review changes); a file cannot be read (names it); rejected; off (removed: Turn on; shared folder: names the owning project).
- Approval card (`team-files-card`): DecisionCard classes in the Team FrameTray. Changes in main's order (power first), `summary` and `reason` as main sends them, prompt and tools before/after, full MCP target, stored sign-in, reach. Approve and Reject send the digest shown. Omitted changes or a problem: Approve is inert and says why.
- Applied notice (`team-files-applied`): changes applied at once, Undo, and the files Undo rewrites.
- Needs-you: a pending or problem status is one decision with no run (bell, Dashboard, badges, menu).
- New project: "This folder already has a team" panel (`team-found`), primary Create project (digest), Architect as a checkbox; no default chart, Replace or import path. An existing project on the folder: Open it.

## Wording
"Team files" everywhere. No "Export to repo". "Import from other tools" is only for Claude Code, Codex and the like.

## Accessibility
One polite status region; focus lands on the status line after Approve, Reject, Undo, Commit, Enable; inert buttons stay focusable with a readable reason; repository text is data (hidden characters badged).

Walks: pre-feature `ux-review-team-files-pre.md`. A post-landing walk is still to do.
