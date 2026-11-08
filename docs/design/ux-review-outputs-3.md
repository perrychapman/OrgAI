# UX review: outputs, Usage and motion — walk 3

Reviewer: UX Researcher. Windows, `ORGAI_MOCK=1`, separate temporary data directories, no live tokens. The first mouse pass used the existing main-checkout build while source HEAD was `72183bfe`; its build SHA was not independently verified. The keyboard note check used the main build reported built at `f2a99e89`. Screenshots: `e2e/shots/ux/outputs-3/` (gitignored). Compared with `outputs-2.md`, `usage-app.md`, `motion.md`, and the prior `ux-review-outputs-2.md`.

## Verdict: INCOMPLETE

The mock run produced five outputs. In the project Outputs view I switched list to grid, opened the Markdown output, saved an edit as version 2, opened the Versions tab and compared it with version 1. The revise dialog explained that the result would become version 3 and that version 2 would stay. The small diagram rendered in Larger view. Usage showed the mock run and estimated figures. On the later build, a Markdown note could be created with keyboard commands, but the screen did not explain how to make that selection. These are limited observations, not a full acceptance walk.

## Previous findings checked

| Earlier item | Observed status | Evidence |
| --- | --- | --- |
| M1 output count and transcript copy | Fixed in observed run | The Outputs tab displayed 5; transcript rows read, for example, “Produced diagram: Architecture diagram”. |
| M2 empty preview / no grid | Partly checked | Logo was selected by default; List and Grid both appeared, with thumbnails for the five outputs (`outputs-list.png`, `outputs-grid.png`). Duplicate grouping was not tested. |
| M3 previous / next | Partly checked | The detail displayed “2 of 5” and arrow controls; their actions were not exercised. |
| Editing and version gaps | Partly checked | A Markdown edit saved as v2; Versions showed v1 and v2 and comparison displayed changes (`editor.png`, `compare.png`). Other kinds, restore and second-run identity were not exercised. |
| Revise gap | Partly checked | The revise dialog offered whole output, a disabled selection option and a choice of the waiting run or a new run (`revise.png`). No request was sent. |
| D1–D7 diagrams | Not verified | A small four-node diagram rendered in Larger view (`diagram-settled.png`); large diagrams, interactions and export were not tested. |
| V1–V5 | Not verified | The prior checks were not repeated. |

## Findings

### M1 (Medium): Keyboard selection for a note is not explained

Screen: project Outputs, Markdown preview. Shots: `keyboard-cursor.png`, `keyboard-note-saved.png`.

Repro: open the Summary Markdown output. The disabled Add note control is accompanied by “Select text to add a note.” Focus the rendered text region and press Down; a block becomes selected. Press Ctrl+Shift+M, type a note and press Ctrl+Enter. The note is added and focus returns to the preview. In this check I placed focus on the preview programmatically before using the keys, so this does not establish the full Tab path.

Experience: the visible hint gives no keyboard selection instructions or shortcut, so a first-time keyboard user has no visible clue that the arrow keys select a block. Recommended copy alongside the preview or Add note: “Select text with the mouse, or focus the preview and use Up and Down to select a block. Hold Shift to extend the selection. Press Ctrl+Shift+M to add a note.” Use the platform-appropriate shortcut label.

## Not driven

Exact 1024x640 and 1600x1000 sizes; light theme; reduced motion; a complete keyboard-only journey and accessibility-tree pass; large diagram pan/zoom and export; notes on other kinds and resolution; sending revisions; slides; comparison for other kinds; restore, external editing and deletion; populated Usage drilldowns; native dialogs; 320 px reflow and zoom. The mock runs were left waiting at their permission cards. Screenshots capture the driver's default window size, not the requested matrix.
