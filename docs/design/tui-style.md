# Terminal style

The terminal follows [the design specification](spec.md), its [visual refinement](ui-review-2.md),
and the current text colors in `src/renderer/src/styles/tokens.css`. The terminal equivalents live
in `src/cli/tui/theme.ts`; tests check token parity and text contrast in both themes.

| Element | Treatment |
| --- | --- |
| Logo | White on dark, dark ink on light; a brief violet sweep followed by a long quiet interval |
| Commands, selected controls, prompt marker | Violet accent text |
| Agent names | Bold, with stable violet, cyan, green, amber, pink and blue role colors shared by sidebar and transcript |
| Active work | Blue glyph and a shimmering description of the reported activity |
| Agent exchanges | Slate-blue direction marker, tinted sender/recipient, secondary body text |
| Tools, paths, code | Secondary ink; prefix and indentation distinguish them from prose |
| Success, attention, error | Green, amber, red respectively, always with words or glyphs |
| Conversation | Terminal foreground, with bold headings and restrained inline formatting |
| Input | Paired foreground and surface from the theme; readable secondary placeholders |

The logo sweep is an explicit brand exception to the otherwise work-only motion rule. It appears
only in the welcome/setup header, with one shared phase across the two logo rows. Menus, input
surfaces, completed work and message bodies remain still. There is no glow or gradient behind text.
Reduced motion, no color, screen readers, dumb terminals, inline mode and terminal suspension keep
the logo static. Meaningful secondary text uses a foreground token without an additional dim effect.

`ORGAI_THEME=dark` or `ORGAI_THEME=light` overrides `COLORFGBG`; dark is the fallback when the terminal
does not advertise its theme. `ORGAI_REDUCED_MOTION=1` disables animation. Layout follows terminal
dimensions, with plain text labels and selection markers preserved when styling is disabled.

Previews use the actual Ink components with simulated task events, rendered entirely offscreen:
[dark](../media/tui-team-dark.gif) and [light](../media/tui-team-light.gif).

Wide terminals put the conversation on the left and the agent room, plan and worktrees in a right
sidebar capped at 42 columns. A nonempty run plan appears automatically in the wide sidebar, directly below the
compact team roster, with a task count and one pinned progress/ETA line, even in short panes. The checklist fills the available pane height with
one-line task labels, without the goal paragraph, notes, or owners. Labels use a short leading phrase
and mark omitted detail with an ellipsis. Lists that exceed the available height keep the active/blocked task visible; focus the pane
to scroll the list. The ETA is a rough step-pace estimate
from elapsed run time and completed steps; tasks can differ in size and prior waits remain part of elapsed time.
It shows "Estimating" until progress exists, and suppresses estimates while blocked, awaiting a decision,
paused, or ended. Skipped steps fill the bar without inflating the observed work rate. Continued runs establish a fresh
observation baseline and wait for a newly completed step before estimating; reopening the pane restarts that observation. It remains visible at
completion; pane visibility commands can still hide it. Narrow screens auto-show only blocked plans
to preserve conversation space. Worktrees follow the plan when they need attention.
Short conversations align to the bottom, keeping the latest message
near the composer; scrolling up preserves the reading position. Agent inspection replaces the
conversation and keeps the agent room visible. Narrow terminals keep the stacked layout. The composer
uses a single footer row for run status, notices and essential shortcuts, with no separate hint row or gap below the input. Approval choices and their command details appear inline above the composer. New requests never take typing focus. Shift+Tab from the composer or F2 from another pane selects
the inline choices; Esc returns to typing. Long permission bodies must still be read
before approval, and the arrival guard prevents buffered keys from answering a new request.
A single-agent sidebar shows only the name and state until focused. The fullscreen footer omits
duplicate single-run titles, zero-decision counts and lone run chips; multiple-run navigation and
connection warnings remain visible.

The fullscreen conversation shows a bold agent heading when the speaker changes or after a user
message. Prose has space to breathe; completed tool calls collapse into muted, single-line summaries,
while failures remain visible. Ctrl+O toggles full tool commands and output from the composer or
conversation without changing the draft. The activity row keeps one shimmering state label followed
by elapsed run time and reported total tokens (including cache usage), with the interrupt hint at the right.
The activity row and sidebar use the same reported activity, such as reading files, running tests,
updating a plan or waiting for reports. Generic thinking falls back to "Working". Setup proposals show a short preview with a full
review action, and quit confirmations occupy a compact area above the input while the conversation
stays visible. Action hints include one way back to typing, without duplicate Escape labels.

Completed assistant messages render Markdown tables as separated records, with bold column labels
and wrapped values instead of raw pipes and separator rows. This layout stays readable when the
sidebar or a narrow terminal leaves little room for columns. Inline Markdown links read as their
label plus a numbered reference; full destinations appear once in a References block after the
message. Code examples stay literal, and malformed tables or links remain visible as written.
The same formatting applies in fullscreen and inline scrollback, including no-color and screen-reader
modes. Streaming partials remain literal until committed; stored transcripts retain the original text.

Formatting verification (2026-11-09, integrated with fork/dev): all 862 TUI tests pass, including 23 focused parser/transcript tests covering narrow/wide
panes, fullscreen/inline rendering, ASCII/screen-reader modes, code literals and retained link targets.
The CLI bundle builds. Full typecheck and desktop build are blocked by the local missing `mermaid`
dependency. All checks in the mock terminal walkthrough pass after its sidebar status assertions were
updated to allow the visible tree guides. The earlier full suite also encountered sandbox
socket restrictions and an SDK/package-lock version mismatch; it was interrupted after repeated
socket-related timeouts. This is not a green repository-wide gate.

Setup review cards are capped at 96 columns, with a left border, bold proposal title, secondary
summary and timing text, and bracketed action keys separated from the preview by a blank line.
The right sidebar includes the configured project team. Unstarted roles show "Available" in their
reporting hierarchy; starting an agent replaces that role entry with its live state. Configured
roles stay visible after completion. Enter on an available role opens its description without
starting work. Projects without a configured team retain the run-agent view.

Agent identity colors distinguish roles; they are not status indicators. State is carried separately
by a labeled glyph and state text, so a green or amber agent name does not imply success or a warning.
Tab follows the visible conversation column, then the sidebar from top to bottom.

The wide team roster separates each agent name from its activity and adds a blank row between agents
when the available height permits. Smaller panes fall back to two-line or single-line rows so names
and decision badges stay reachable. The checklist remains below the roster.
New agent-to-agent message events animate a brief sender-to-recipient courier beneath the roster and
mark both participants. It lasts about 1.6 seconds, works even for idle agents, and settles to a static
last-message label. Mounting history, switching runs, or resuming animation never replays old traffic.
Reduced-motion, screen-reader, no-color, inline, and dumb-terminal modes retain a static message cue.
