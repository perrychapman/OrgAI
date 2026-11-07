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

## Re-walk after fixes (2026-11-07)

Scope: the usability fixes for GitHub issues #25-#32 on dev at 00596e9 (`git log 71c50d5..HEAD -- src/cli/tui`: tray 22c957a, palette
and status 8a9df24, theme 261a6f3, layout 3d62f0b, shell dcb7d33, contracts d1b3982). This file had no "Implementation notes" section yet,
so the reference for what was meant to change was the commit log and the issue text (`gh issue view 25`..`32`, read as data). No code
was changed; this section is the only edit. Issue acceptance is judged from the issue bullets.

### R0. How it was driven (same method as section 0)

Same method as the first walk: a throwaway vitest file (deleted afterwards, nothing of it is in the repo) booted a real `--host inproc`
mock host over a throwaway `ORGAI_DATA_DIR`, seeded nine runs with mock markers (default, `fatigue`, `deep-tree`, `exec-question`,
`turn-fail`, `rate-limit`, `config-change`, `exec-plan`), then called the real `main(['--project', dir, 'tui', ...])` (real `runTui`,
`App`, session, panes) with fake TTY streams, key bytes fed as stdin data, and every written byte replayed through a small VT emulator
(LF treated as CRLF; scrollback kept for inline frames). Token-free, no `npm run build` needed (the harness imports `src/`).
PAGER and PATH were emptied, so `/help` and full views use the in-TUI text overlay.

- Sizes: 120x40, 100x30, 80x24, 70x24 (all four are full-screen now), live resize 120x40 -> 70x24 -> 100x30 -> 120x40. Modes:
  `NO_COLOR=1`, `--ax-screen-reader`, `--inline`, `TERM=dumb`, each at 120x40 and 80x24 (frames from those modes are plain text; see below).
- Re-tried from last time: `z` / `Z`, `n` / `N`, `[` `]`, `/new` (typed a prompt, a second run started), `/stop` (then `y`: R2 became
  Stopped and offered "Send to continue R2 with its memory"), `/quit` not tried, first Ctrl+C notice.
- Limits of this harness: the fake stdout has no colour depth, so Ink emitted no SGR codes in any run (checked: the set of `ESC[..m`
  sequences was empty with default, `NO_COLOR` and `FORCE_COLOR=3`). Colour and the new tones were therefore NOT seen, only read from
  `theme.ts` and its unit tests. Timing: a key sent less than 750 ms after a card appeared or the tray took focus can be refused by the
  swap guard (see R2-L6), so card steps used a 1.2 s pause. Not a real console (see section 6, still true).

### R1. Status of every earlier finding

Legend: fixed (frame quoted), partly, not fixed, not checkable. Frames are plain text from the replay, trimmed.

| Id | Result | Evidence |
|----|--------|----------|
| H1 hint cut by run chips | fixed at 120 and 100, partly at 80 and 70 | 120x40: `R1 · Needs you · 5 need you · 8 live   Enter sends · / commands · Alt+D decisions · Tab panes · Esc Esc interrupts` (chips replaced by `5 need you · 8 live`). 80x24 and 70x24 keep only `Enter sends · / commands`; the missing keys are covered by `Alt+D to answer` in the tray and the pane's own hint line. The run list is no longer on the line at any size. |
| H2 tray never shows focus | fixed | Unfocused: `Alt+D to answer`. Focused: `> Needs you (5) • R1 • implementer-1 • permission: Edit example.ts` plus the key row and status `Keys on the card · ? keys · Esc back`. The marker is a character, so it survives NO_COLOR (`> Needs you` seen in the NO_COLOR run). Typing `y` with the composer focused still only types (`❯ y`), nothing is sent. |
| H3 no panes under 100 columns | fixed | 80x24 and 70x24 are full-screen stacked: `Agents 2 • 1 working • ! 1` / `* └─ ! implementer-1  Needs you ! 1   $0.00285`, Tab shows `> └─ ! implementer-1 ...` and `Up/Down move · Enter decide · n next needs-you · z focus · ? all keys`. `--inline` drops "Tab panes": `R1 · Needs you · 5 need you · 8 live   Enter sends · / commands`. Not walked below 70 columns. |
| M1 palette leaves tray text | fixed | 120x40 after `/`: rows are full width, `› /help                Show the keys and commands` ... `10 more · type to filter`; no fragments of the tray run on after a row. |
| M2 no gutter | fixed (one space) | `$0.00288 Orchestrator (thinking): ...`, `$0.0057 > → Orchestrator: Handed work ...`. It is a single blank column, enough to read. |
| M3 old run opened silently | fixed | Status `Opened R1: it needs you. /new starts a new run.`; composer `❯ Message R3 · Mockdeep-tree Build the report` names the run. (It still opens the oldest run that needs you, not the newest; see R2-L1 for the notice outliving a run switch.) |
| M4 `/runs` says Running | fixed | `R1 Needs you`, `R2 Needs you`, `R3 Idle`, `R5 Idle`, `R6 Finished`, `R9 Needs you`; no "Running" for a run that waits. |
| M5 failed turn is Idle | partly | Bar: `R5 · Idle · last turn failed · 5 need you`; tree `✗ Orchestrator  Failed`. The transcript row is unchanged: `Orchestrator: during execution` (a fragment, not a sentence), and `/runs` shows plain `Idle` for R5. |
| M6 unavailable command says "No matching" | fixed | `/ret` -> `/retro: The run has not ended yet. The retrospective reviews an ended run.` |
| M7 Esc interrupts, notice never clears | fixed | One Esc: `Press Esc again to interrupt the run.`; second: `Interrupting the run...`; 7 s later the line is back to `Enter sends · / commands · Alt+D decisions · Tab panes · Esc Esc interrupts`. On an idle run: `Nothing is running.` |
| M8 help cut at 80, no "more" | fixed | 80x24 `/help`: wrapped (`/runs  List this project's runs (pick one: Enter opens, c` / `continues, r retrospective) (also /ls, /history)`) and `lines 1-10 of 103 · more below · Up/Down PgUp/PgDn scroll · q or Esc closes`. Scrolling with Down works (`lines 4-13 of 103`). |
| M9 fast `/runs<Enter>` chunk | fixed | One stdin chunk `/runs\r` opens the Runs list (`│ Runs` ... `> R1  Needs you  Hello there friend  (following)`), same for `/help\r`. |
| L1 details cut with no ellipsis | partly | The card title gets a trailing `…` when its body is cut (`Needs you (5) • R2 • Orchestrator • permission: Run npm test …`). The first detail line still cuts at about 72 characters with none: `$ cd C:\Users\...\walk\.claude\w`. |
| L2 rejected keys silent | fixed | `9` on a two-option question: `Pick 1 to 2.`; `x`: `Not a key here. ? shows the keys.`; `n` inside the Always-allow confirm: `Answer the confirm first: a or y confirms, Esc cancels.` |
| L3 narrow tray wraps mid-phrase | fixed | 80x24 and 70x24 break at separators: `y Allow once · s Allow for session · a Always allow for project · n Deny (note)` / `v Full view · Esc Back · ? Keys` (70: after `project`). Not walked at 60. |
| L4 queued cards take the height | partly | 80x24 and 70x24 collapse the queue to `+4 more cards`. At 100x30 it still lists three cards plus `and 1 more` (the tray is 10 of 30 rows, the transcript about 8). |
| L5 `?` types a literal | fixed | `?` on the empty composer opens `Keys: Composer`; `?` in the focused tray opens `Keys: Decision Tray (only while the tray has focus)`. |
| L6 palette order, no count | fixed | `/help`, `/new` first, then `/agent`, `/app`, `/ask`...; last row `10 more · type to filter` (80x24: `12 more`). |
| L7 titles lose punctuation | not fixed (outside #25-#32) | `/runs` titles read `Mockfatigue Fix the build`, `Mockdeep-tree Build the report`, `Mockrate-limit Hit the limit` (main-side `runTitle.ts`). |
| L8 onboarding | partly | Now explains: `The Architect is the built-in setup assistant: it interviews you and proposes a team. It uses tokens.` and `Press a key to choose. Esc or q leaves without creating a project.` Esc and `q` still leave silently with exit 0 (the line above says so). |
| L9 inline overlay fragments | fixed | `--inline`, 80x24 and 120x40: the Runs and Help overlays are borderless (` Runs`, ` > R1 ...`); zero box-drawing characters in the whole inline scrollback of the run. |
| L10 colour | not checkable by eye, partly by code | Cursor: with NO_COLOR the composer shows `❯ |Message R1` (a glyph, `CURSOR_GLYPH`). `theme.ts`: dim is the attribute alone, running is `blueBright`, warn is `magenta`; Composer, StatusBar, palette and panes set attributes through `styleFor` or `Seg` (grep: `inverse` / `dimColor` appear only there and in `lines.tsx`). No colour was emitted in the harness, so contrast on real backgrounds is unverified. |
| L11 mixed separators | fixed | Screen reader: `R1, Needs you, 5 need you, 8 live. ... Enter sends, / commands` and tray `y Allow once, s Allow for session`. TERM=dumb: `R1 \| Needs you \| 5 need you \| 8 live   Enter sends \| / commands`. |
| L12 cuts mid-word at 60 | not checkable | 70 columns never cut mid-word in any frame; 60 was not walked. |

Code-review items from the issues:

| Item | Result | Evidence |
|------|--------|----------|
| rev-H1 read-first gate, scroll cue, `v` on permission cards | partly: cue and `v` fixed, the gate is NOT reliable | See R2-H1. Cue: `2 more lines · Down scrolls · v full view` (80x24 and 70x24), `6 more lines` on a proposal. `v` on a permission card opens `Run npm test` with the whole command. But `y` pressed with the cue showing was accepted. |
| rev-M6 composer focus vs tray keys | fixed | as H2. |
| rev-M5 danger notices after 50-70 columns | partly | `Press Ctrl+C again to quit   Enter sends` at 80x24 (notice first). At 70x24 the first Ctrl+C shows no notice at all (R2-M1). |
| rev-M2 tray not clamped | fixed | 80x24 and 70x24 with five cards: status line, panes, tray (9 rows), composer all on screen. |
| rev-M3 palette not reserved | fixed | 80x24 `/`: status, tree, tray, 8 palette rows and the composer all visible. |
| rev-M4 composer rows | fixed | Seven lines typed with Alt+Enter at 80x24 and 100x30: the composer shows the last six, the status line and the tray stay on screen. |
| rev-L3 tray `n` / Esc / `?` | fixed | `n` -> `Note (optional): _  Enter sends · Esc cancels the note` (label is now `n Deny (note)`); Esc -> `Cancelled`, the tray stays focused; `?` opens the tray's keys. |
| rev-M1 pager fallback truncates | fixed | Overlays wrap and the full view ends `Set $PAGER (for example PAGER=less) to page long text.` |
| rev-L1 / rev-L4 tones and `styleFor` | not checkable (colour) | code only, see L10. |
| rev-L2 width of VS16, ZWJ, combining marks | not checkable by eye | `panes/text.test.ts` (6 tests, one named "counts by grapheme cluster: VS16, ZWJ, flags and marks after wide characters") and `theme.test.ts` pass. No wide-character agent name was driven. |

Previously undriven, now driven: `z` on the root (`Focus: Orchestrator (4)` in the tree title) and `Z` (back; with nothing focused: `The tree already shows the whole run.`);
`z` on a group row says `Pick an agent of this session to focus on.`; `n` on R3 says `Nothing needs you.`; on R1 with the cursor
already on the one waiting agent nothing moves and nothing is said (a second waiting agent was not available, so a real jump was not
seen); `[` and `]` switch runs (`R2` -> `R3` -> `R2`, composer `Message R3 · Mockdeep-tree Build the report`); `/new` shows `Type the prompt for the new run.` and
`✚  Describe the work to start a run`; `/stop` asks `End this session?  y: yes · n or Esc: no`. Still not driven: `z` on a non-root
agent (the cursor stayed on the root), `/ask`, `/quit`, the Merge Review card, `s` secrets, `e` revise, `d` decline, the worktrees pane, a real pager.

### R2. New problems

#### R2-H1. The read-first gate lets `y` through while the card says more is below `[frame]`
Steps (mock): seed a run with `[mock:fatigue]`; `orgai --project <dir> tui --run <that run>` (R2 in the nine-run project) at 70x24 (or 80x24); Alt+D; wait 1 s; press `y`.
Frame before `y` (70x24):
```
> Needs you (5) • R2 • Orchestrator • permission: Run npm test
 $ cd C:\Users\...\walk\.clau
 de\w
 Command: cd C:\Users\...\walk\.claude\worktrees\agent-x && npm test   <- cut at 70 columns: "...\wal"
2 more lines · Down scrolls · v full view
y Allow once · s Allow for session · a Always allow for project
```
After `y` the card is gone and the next one shows (`Edit README.md`): the command was allowed with its tail unseen. Same at 80x24 on an
`Edit README.md` card with `2 more lines · Down scrolls · v full view` (`y` allowed at once). At 120x40 the command fits and `y` is correct.
Why (read from `DecisionTray.tsx:395`, not proven): `readAll` is set when `st.scroll + bodyRows >= detail.length`, which counts logical lines,
while the cue counts wrapped rows, so a card whose lines wrap passes the gate while rows are hidden. This is the rev-H1 risk the issue
asked to close. Fix: compute both from the same wrapped rows; add a test with a 120-char command at 70 columns.

#### R2-M1. No notice for the first Ctrl+C at 70 columns `[frame]`
Steps: `orgai tui` in a project, 70x24, empty composer, Ctrl+C. The bar stays `R1 · Needs you · 5 need you · 8 live   Enter sends · / commands`.
At 80x24 the same press shows `Press Ctrl+C again to quit   Enter sends` (and at 120x40 `Press Ctrl+C again to quit   Enter sends · / commands · Alt+D decisions`).
The notice (26 characters) would fit next to the 36-character run label, so this looks like the fitting order dropping it before the hint.
A user at 70 columns gets no feedback and may press Ctrl+C again and leave by accident or think the key is dead.

#### R2-M2. Inline, screen-reader and dumb modes cut the tray's key row to one line `[frame]`
`--inline`, `--ax-screen-reader` and `TERM=dumb`, 80x24, after Alt+D: `R1 implementer-1: Edit example.ts · y Allow once · s Allow for session · a Alwa…`
(screen reader at 120x40: `... n Deny (note), v Fu...`). `n`, `v`, `Esc` and `?` are never shown, so the keys for denying and for the full view are
undiscoverable in these modes (the wrapped rows of L3 exist only in full-screen). From the code, the inline variant (`variant: 'footer'`) also sets
`readAll` unconditionally, so it has no read-first gate; that was not driven with a long Bash command in inline mode.

#### R2-L. Low
- R2-L1 `[frame]` A notice outlives a run switch: after `]` to R2 and R3 the line still reads `Opened R1: it needs you. /new starts a new run.` while the bar says R2 / R3.
- R2-L2 `[frame]` The tray head names `An agent` for a card of another run (`Needs you (5) • R1 • An agent • permission: Edit example.ts` while viewing R3); viewing R1 it says `implementer-1`.
- R2-L3 `[frame]` Full view (`v`) repeats the title (`Run npm test` twice) and still cuts the first detail line at about 72 characters (`$ cd C:\Users\...\.claude\w`) with no ellipsis, so "full" is not full for that line (the `Command:` line below it is complete).
- R2-L4 `[frame]` Screen-reader status has a double stop: `Opened R1: it needs you. /new starts a new run.. Enter sends, / commands`.
- R2-L5 `[frame]` Onboarding's status line reads `0 need you   Esc cancels`; the count means nothing before a project exists.
- R2-L6 `[frame]` `y` about 0.4 s after Alt+D answers `The card just changed: wait a moment, then press the key again.` although the card did not change (the swap guard also seems to count tray focus); with a 1.2 s pause the same `y` was accepted. The sentence is wrong for what happened, and the notice stayed for 5 s.
- R2-L7 `[frame]` With the palette open the composer row is still drawn below it (`/` on the palette's own line, then the rows, then `❯ Message R1`): two input lines.
- R2-L8 `[frame]` After `/new` and sending, `Type the prompt for the new run.` stays on the status line for the notice lifetime although the run already started (R2 appeared).

### R3. Issue acceptance

| Issue | Acceptance met? | Evidence |
|-------|-----------------|----------|
| #25 tray focus and long cards | No (one blocker) | Focus cue, `Alt+D to answer`, scroll cue, `v` full view, `n` note, Esc, `?`, separator-aware wrap: met. Gate on `y/s/a`: not met (R2-H1). Ellipsis (L1): partly. |
| #26 status hints and notices | Mostly | Hint kept, run chips gone, danger notices first, notices expire (7 s check), L11 separators: met. Gaps: only two hint items at 80 and 70 columns, and no first Ctrl+C notice at 70 (R2-M1). |
| #27 panes under 100 columns | Yes | 80x24 and 70x24 full-screen stacked with panes and Tab; inline mode no longer promises "Tab panes". |
| #28 layout, palette, gutter | Yes, one part partly | Tray clamp, palette reserved, composer rows, palette fills, gutter, borderless inline overlays: met. L4 queue collapse only under the height at 80x24 / 70x24, not at 100x30. |
| #29 status words and replies | Mostly | `/runs` words, `/retro` reason, run named in the composer, "Opened R1" note: met. Failed turn: bar says `Idle · last turn failed` but the transcript row still reads `during execution`. |
| #30 help, pager fallback, first run | Yes | Wrapped help with `lines a-b of N · more below`, `$PAGER` pointer, `?` on the composer, `/help` and `/new` first with `N more`, Architect explained. Esc / q still leave silently (stated up front). |
| #31 Esc and chunks | Yes | Esc Esc with notices, `Nothing is running.`, chunk `/runs\r` works, rejected keys explained. |
| #32 colour and width | Not checkable by eye | NO_COLOR cursor glyph seen; tone changes and width handling verified only by code and unit tests (`theme.test.ts`, `panes/text.test.ts` pass); the harness emitted no colour. |

Top new items: R2-H1 (gate bypass), R2-M1 (no first Ctrl+C notice at 70 columns), R2-M2 (inline tray key row cut).
