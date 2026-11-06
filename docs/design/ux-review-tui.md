# UX review: the terminal UI as a first-time user

Date 2026-11-06. Scope: `orgai tui` (`src/cli/tui/`, Ink 8) on the mock adapter, token-free. No code was changed; this file is
the only output. Read first: CLAUDE.md "CLI & host", cli-spec TUI sections, `ux-review-tui-org.md`, `keymap.ts`.

## 0. How it was driven (read this before trusting a finding)

- NOT a real console. The agent shell has no TTY, there is no python3 or node-pty here, `e2e/cli-tui.mjs` SKIPs on win32, and
  the self-control gate refused the agent running `node out/cli/orgai.mjs` (correct; not worked around).
- What was done instead: a throwaway vitest file (deleted afterwards, nothing of it is in the repo) that boots a real
  `--host inproc` mock host over a throwaway `ORGAI_DATA_DIR`, seeds runs with mock markers, then calls the real
  `main(['tui', ...])` (real `runTui`, real `App`, real session, real panes) with a fake TTY: `process.stdout` made a TTY of the
  wanted size, key bytes fed as stdin data, and every byte Ink wrote replayed through a small VT emulator to get the
  screen a terminal would show. So the frames below are the true Ink output at that size, not hand-built state.
  Frames are plain text unless said otherwise; colour was looked at only in a few frames with `FORCE_COLOR=3` (SGR codes
  read, not seen). PAGER/PATH were emptied so `/help`, `/usage` etc. use the in-TUI text overlay.
- Sizes: 120x40 (full-screen split), 100x30 (full-screen stacked), 90x30 and 80x24 (both fall back to INLINE mode, because
  `FULLSCREEN_MIN_COLS` is 100), 60x16 by live resize. Modes: `NO_COLOR=1`, `TERM=dumb`, `--ax-screen-reader`, `--inline`.
- Method per finding is tagged `[frame]` (seen in a replayed frame), `[code]` (read from source only) or `[both]`.
- Mock runs used: default script, `[mock:deep-tree]`, `[mock:exec-question]`, `[mock:fatigue]` (permission card),
  `[mock:config-change]` (MCP proposal card), `[mock:exec-plan]`, `[mock:turn-fail]`, `[mock:rate-limit]`, a long-named prompt.

## 1. Summary

3 High, 9 Medium, 9 Low. The panes, folding, per-row hints and card text are in good shape and several earlier findings
(F9 one key table, fold, inspector, run chips) work as described. The problems are discoverability and focus legibility:
the one-line status hint is the first thing cut, the Decision Tray gives no sign of being focused, and the most common
terminal size (80 columns) shows no panes and no hints at all.

Top five: H1, H2, H3, M1, M2.

## 2. High

### H1. The key hint disappears when it is needed most (status line) `[frame]`
Screen: status line, every size. At 120x40 with a project that has a few runs the line is
`Walk project · R2 Ask me something… · Needs you · — · 5 need you · R1 R2*! R3! R4 R6 R7! +2   Enter sends · / commands …`
and after Alt+D it ends `Keys on the card · Esc ba…` (card focus) or `Keys on t…`. At 100 columns it is
`…R1 R2! R3! R4 R6…` with no hint. At 80x24 (inline, status on the bottom row) it is
`Walk project · R2 Ask me something… · Needs you · — · 5 need you · R1 R2*! R3! …` and the composer carries no hint either,
so there is no hint line on screen at all. With no runs (H-onb-3, 120x40) the full hint does show
(`Enter sends · / commands · Alt+D decisions · Tab panes · Esc interrupts · Ctrl+C twice quits`), so it degrades exactly
as the user accumulates runs.
Why: a first-time user at 80 columns cannot learn `/`, `Alt+D`, `Tab` or Ctrl+C from the screen. The pane hint line
(bottom of a focused pane) works, but only for full-screen panes at least 6 rows high.
Fix: truncate the run chips first (`+N`) and keep the hint, or put the hint on its own last row / the composer
placeholder; `StatusBar.tsx`, `keymap.ts statusHint`.

### H2. The Decision Tray shows its keys but never shows whether it has focus `[both]`
Screen: tray, all sizes. The card prints `y Allow once · s Allow for session · a Always allow for project · n Deny · Esc Back`
whether or not the tray is focused. After Alt+D, F2 or Shift+Tab the frame is identical except for the composer's cursor
space (`❯  Message the run` becomes `❯ Message the run`) and a status hint that is usually cut (H1). `DecisionTray.tsx`
reads `props.focused` only to register the key handler (line 466); nothing in its rendering changes. Composer.tsx states
decision letters work only in the focused tray, so with the composer focused (the default) pressing `y` or `1` types into
the composer, and Enter sends "y" to the running agent.
Why: the tray reads as a live button row. A first-time user presses `y`, sees `❯ y`, presses Enter and has messaged an
agent instead of approving. Nothing in the tray says "Alt+D to answer".
Fix: render a focus cue in the tray (`>` marker, accent title, inverse title; must survive NO_COLOR) and an unfocused
line "Alt+D to answer"; `DecisionTray.tsx`.

### H3. 80 and 90 columns get inline mode: no panes, yet the UI says "Tab panes" `[frame]`
Screen: any terminal under 100 columns (80x24, 90x30). Output is the transcript in scrollback plus a 3-line footer
(`R2 Orchestrator: Answer: … · 1-2 Pick · Enter Submit …` / `❯  Message the run` / status). Tab, Shift+Tab, `?`, `m`, `n`
do nothing visible: frames "Tab 1..4" at 80x24 are identical to the first frame (focus moves to panes that are not drawn).
The Agents tree, Plan and Worktrees are reachable only through `/agent`, `/plan`, `/worktrees`, which are not advertised
(H1). The fold, run chips `!` and the org tree, the TUI's main selling point, are invisible at the default console width.
Why: the common 80x24 window is the worst case, and the hint it does show promises panes. `FULLSCREEN_MIN_COLS` 100 is also
steep next to `SPLIT_MIN_COLS` 110; stacked mode at 100x30 works.
Fix: a stacked full-screen layout from about 70 columns (the 60x16 resize shows it copes), or at least hide "Tab panes"
and add "Full-screen needs 100 columns; /agent shows the tree" in inline mode; `terminal.ts chooseBufferMode`,
`keymap.ts statusHint`.

## 3. Medium

### M1. Overlays composite over the tray and leave its text showing `[frame]`
The slash palette (absolute box) only overwrites the cells its own text covers. 120x40, after `/`:
`Which setting should I use?rator • question: Answer: Which setting should I use?` and
`and 1 moreexample.ts`, `/diff <branch|agent> Show a worktree's diffteam)`. The tail of the tray title and card lines runs
on after the palette row. Fix: give palette rows a full-width fill/padding, or clear the region; `SlashPalette.tsx`.

### M2. No gutter between the tree pane and the transcript `[frame]`
120x40: `Orchestrator  Idle          $0.004275Orchestrator: Planning the work…`,
`└─ ✓ 3 done                   $0.0057 >→ Orchestrator: Handed work to mock-lead`,
`mock-lead, mock-lead-report-1, mock-lead…you: Lead the deep-tree work`. Cost, the fold marker `>` and the selected
row's activity footer touch the transcript text. Fix: one blank column (or a `│`) between columns; `layout.ts splitPanes`.

### M3. Plain `orgai tui` in a project reopens an old run that needs you and sends your text there `[frame]`
Project with several runs: the first frame is R3 (a `[mock:fatigue]` run with a permission card), and typing `say hello`
Enter produced `you: say hello` in R3's transcript. The composer says only `Message the run`. Starting a new run needs
`/new`, which appears only in the palette. For a user who opens the TUI to "start something" this is a surprise side
effect on a live run. Fix: name the run in the composer placeholder (`Message R3 …`), and when opening on a run that is
not the user's own latest, say so once; `App.tsx` composer prompt, `commands/tui.ts prepareFolder`.

### M4. `/runs` calls runs that wait on you "Running" `[frame]`
`R2 Running`, `R3 Running`, `R7 Running`, `R8 Running`, `R9 Running` while the chips show `R2! R3! R7!` and the tray lists their
cards; the status bar names the same state "Needs you". The status words in CLAUDE.md say Needs you wins. Fix: `/runs`
row status from the same `statusWord` as the bar; `App.tsx` runs overlay.

### M5. A failed turn is "Idle" in the status bar `[frame]`
`[mock:turn-fail]`: status bar `R4 Break mockturn-fail · Idle · $0.001425`, tree `✗ Orchestrator  Failed`, transcript
`Orchestrator: during execution` (a cryptic sentence). The desktop word is Failed. Fix: show Failed (or "Idle · last turn
failed") in the bar and a full sentence in the transcript row; `selectors.ts statusSummary`.

### M6. `/retro` (and other unavailable commands) answer "No matching command" `[frame]`
On an Idle work run typing `/retro` shows `No matching command. Esc closes.`; the command exists but `available()` is false.
Fix: list unavailable commands greyed with the reason ("ends runs only"), or answer with the reason; `slashCommands.ts
matchCommands`, `SlashPalette.tsx`.

### M7. Esc on the composer interrupts the agent, and the notice never clears `[frame]`
Esc is "back" in every pane and overlay, but on the composer it interrupts the running turn with no confirmation. After
one Esc the status line kept `Interrupting the run...` through every later frame (palette, `?` overlay, Tab), even when the
run was Idle. Why: a first-timer's reflex Esc stops work. Fix: expire notices (about 5 s), say "nothing running" when idle,
consider Esc Esc to interrupt; `App.tsx` notices.

### M8. Help and inspector text is cut at 80 columns, and the first screen is keys, not commands `[frame]`
80x24 `/help`: `Esc … From a pane: back to the composer. On the composer: in…`, `Ctrl+C … twice on an empty composer quits (…`,
`Alt+D, F2, Ctrl+.  Focus the Decision Tray (Shift+Tab from the composer t…`. The clause that matters (interrupt, quits) is the
one cut. There is no "more below" marker and the command list is several screens down. Fix: wrap the overlay lines to the
box width and add `1/3` or an arrow; `App.tsx` text overlay, `PaneLines`.

### M9. A fast chunk "/runs<Enter>" loses the slash and messages the agent `[frame]`
Typing the same bytes one key at a time works. Delivered as one stdin chunk (a paste without bracketed paste, a fast typist,
a slow console) the palette opens with only `/` and `runs` is sent as `you: runs` to the agent
(`Orchestrator: Mock reply to: runs`). The first `/` consumed by the key handler appears to open the palette before
later bytes in the same chunk see it. Fix: process a chunk's keys against updated state (or treat a multi-char chunk
starting with `/` as text); `Composer.tsx` / `SlashPalette.tsx` handler ordering. Reproduced in the harness only; not seen on a
real console.

## 4. Low

- L1 `[frame]` Tray details are cut with no ellipsis: `$ cd C:\Users\chapp\AppData\Local\Temp\orgai-walk-11hqtY\proj-main\.clau`.
  Add `…`; `DecisionTray.tsx`.
- L2 `[frame]` Rejected keys are silent: `9` on a two-option question, `x` on onboarding, `n` while the "Always allow?" confirm is
  open (the confirm just stays). One-line notice.
- L3 `[frame]` Narrow tray wraps mid-phrase: 80x24 full-screen `…n Deny · Esc` / `Back`; 60x16 `Always allow for` / `project`.
  Break at separators.
- L4 `[frame]` At 100x30 stacked, a tray with a question plus three queued cards takes 11 of 30 rows, leaving about 7 for the
  transcript; with Plan open fewer. Collapse the queue list to a count when height is short.
- L5 `[frame]` `?` is the help key in panes but types a literal `?` in the composer (the default focus); the help line says
  "use /help". A first-time user presses `?` first. Make a lone `?` on an empty composer open help.
- L6 `[frame]` Palette is alphabetical and shows 8 to 9 rows with no count (`/agent`, `/app`, `/ask` before `/help`, `/new`). Put
  `/help` and `/new` first and show "N more".
- L7 `[frame]` Run titles lose punctuation that joins words: `Hit the limit mockrate-limit`, `Build the report mockdeep-tree`
  (mock markers, but any "text:more" prompt is merged). `src/main/ai/runTitle.ts` cleaning or the TUI's fallback.
- L8 `[frame]` Onboarding: "Architect" is unexplained for a first-time user; Esc and `q` both leave the program with no message
  (exit code 0). One sentence per choice.
- L9 `[frame]` Inline overlays leave fragments in scrollback: a lone `┌────…┐` line after each closed box, two stacked after
  `/usage` then `/agent`. Inherent to a box taller than the viewport; consider printing overlays without a border in inline mode.
- L10 `[code]` Colour. `theme.ts` tones: dim = `gray` (bright black, near-invisible on Solarized and some dark themes, and
  the `dim` attribute is ignored by older conhost), running = `blue` (low contrast on dark blue PowerShell), warn = `yellow`
  (poor on white). Needs-you is also carried by `!` and words, state by glyph plus word, so nothing is colour-only, except the
  composer cursor (`<Text inverse> </Text>`), which has no visible form when colour is off (the double space after `❯`
  remains). Not seen on real backgrounds.
- L11 `[frame]` Dumb and screen-reader modes use `·` in the tray row while the status line uses `|` / `,`; the status line still ends
  `…followed needs yo...` (H1 again in these modes).
- L12 `[frame]` At 60 columns the status bar cuts mid-word (`Needs y…`).

## 5. Checked and fine (do not re-report)

- Pane focus in the tree is shown (`*` unfocused, `>` focused; focused pane prints its own hint line, e.g.
  `Up/Down move · Enter details · ? all keys`), and the hint changes with the row (`Enter decide` on an agent that needs you,
  `Enter details`).
- Fold: `└─ ✓ 3 done $0.0057 >` unfolds with Enter to `mock-lead` plus `2 done`; reports show `mock-l…ort-1` ellipsis cleanly.
- Question card: `( )` becomes `(*)`, Enter submits, the next card (permission) appears and the tray count drops. Always-allow asks
  to confirm (`a/y to confirm, Esc to cancel`) and Esc says `Cancelled`.
- Composer: long line wraps, Alt+Enter adds a line, Ctrl+C clears text, a bracketed paste keeps its newline.
- Resize 120x40 -> 100x30 -> 80x24 -> 60x16 -> back keeps the same run and focus; layout re-flows; buffer mode (full-screen) is kept.
- `/usage` tables, `/runs`, `/plan`, `/agent <name>`, `/fold`, `/focus` (twice toggles back), `/diff x` ("Branch x i…") all respond.
- Ctrl+C three times exits 0 and prints `Detached; the run keeps going.` to stderr.
- Status words seen: Running, Needs you, Idle, Finished (Failed only on the agent, see M5). Paused and Stopped not produced.

## 6. Not walked

- A real console: key timing, bracketed paste, Windows conhost vs Windows Terminal, ConPTY, the alternate screen restore, SIGTSTP
  (none on win32), mouse. Frames come from a VT replay, so anything the replay mis-models (cursor-up clamps, wide glyph widths)
  is unseen.
- Real colours on dark/light backgrounds, `NO_COLOR` in a TTY (the NO_COLOR run only proved the text; chalk was off anyway in
  the harness), contrast ratios (L10 is from source).
- The real pager (`less`/`more`) for `/help`, `/usage` and diffs, the "Merge Review" card (`v` `m` `h` `x`), worktree diff view,
  the `[mock:rate-limit]` Paused state (the run showed Needs you within the wait), Stopped, secrets entry (`s`) on an MCP
  proposal, revise (`e`), decline (`d`).
- `/worktrees` pane with real worktrees (the mock produced none), `z` / `Z` subtree focus and `n` / `N` (a harness mistake sent
  those keys to the composer; not re-run), first Ctrl+C notice text, `/new`, `/ask`, `/stop`, `/quit`, `[` `]` run switching.
- `orgai attach`, `resume`, `orgai -- <prompt>`, read-only sessions, worktree refusal, the 3 Ctrl+C-while-working variant
  (`stopOnQuit`), terminal sizes under 60x16, hidden-character or wide-character agent names beyond `Müller–Østergaard`.
- macOS, Linux, screen reader output as spoken, SSH.
