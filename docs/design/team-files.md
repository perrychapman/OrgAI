# Team files (renderer spec)

Answers `ux-review-team-files-pre.md`. The team of a code project is plain files under `.orgai/`; OrgAI shows whether they match what is in use and asks before anything adds power.

## Surfaces
- Status line (`team-files-line`): one quiet polite row in the Team toolbar's second row, never a Banner (H1). States: in sync; changed, not committed (Commit); N changes need approval (Review changes); a file cannot be read (names it); rejected; off (removed: Turn on; shared folder: names the owning project).
- Approval card (`team-files-card`): DecisionCard classes in the Team FrameTray. Changes in main's order (power first), `summary` and `reason` as main sends them, prompt and tools before/after, full MCP target, stored sign-in, reach. Approve and Reject send the digest shown. Omitted changes or a problem: Approve is inert and says why. Nobody approves what they cannot see: Approve is inert ("Scroll to the end of the changes to approve.") until the change list (`team-files-body`, a keyboard-focusable region while it scrolls) has been scrolled to its end, or when it fits without scrolling; in a compact frame the body is behind Details and the reason says so. In a frame under 720 px high (1024x640 is 592) the stage keeps 30% (about 180 px), the card fills the rest of the tray, only the body scrolls, the drag hint footer is hidden and the lead sentence is screen-reader only; the problem line names a next step (`PROBLEM_NEXT`). "Ask the Team assistant" (`team-files-assistant-toggle`) is a link in the card head, never beside Approve and Reject.
- Applied notice (`team-files-applied`, `team-files-undone`): shares the status line's row (a Banner took 97 px of a 592 px frame, H2): words, Undo, Dismiss. After an Approve main replaces `undo` but keeps the older `applied` batch, so the lead follows `undo.label` ("Approved 1 change.") and the applied summaries show only while `undo` is that batch's.
- Messages: an action's outcome (Approved, Committed, a refusal) belongs to the status it left behind (`statusKey`) and is gone when state, digest or commit state change. A rejection and an Undo say nothing extra: the status line and the undone notice already do.
- Live pointer (`team-files-pointer`): one sentence with "Open in Team" in run meta and above the New run page while changes wait or a file cannot be read.
- Needs-you: a pending or problem status is one decision with no run (bell, Dashboard, badges, menu).
- New project: "This folder already has a team" panel (`team-found`), primary Create project (digest), Architect as a checkbox; no default chart, Replace or import path. An existing project on the folder: Open it. A reason that several rows share is said once above the list (`team-found-reason`); settings read as what the files set ("The files set the project brief.", "Permission mode is set to default."), only set ones are listed with a count of the rest (`team-found-unset`).

## Wording
"Team files" everywhere. No "Export to repo". "Import from other tools" is only for Claude Code, Codex and the like.

## Accessibility
One polite status region; focus lands on the status line after Approve, Reject, Undo, Commit, Enable; inert buttons stay focusable with a readable reason; repository text is data (hidden characters badged).

Walks: pre-feature `ux-review-team-files-pre.md`. Post-landing walk (`ux-review-team-files.md`, lands with dev) fixed here: H1, H2, M1, M2, M3, M5, M6 (renderer side), M6b, M7. Open: M6: main keeps `applied` when an Approve replaces `undo` (service.ts approve, about line 1174), so the label pairing is guarded in the renderer only, not re-walked by eye.
