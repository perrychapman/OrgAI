# UX review: how runs are named today, and what AI run titles should change

Reviewer: UX Researcher. Scope: every place a run is named, on mock data, before building `RunSummary.title`.

## Setup

- `npm run build`, then the built app driven with playwright-core `_electron` (same mechanism as `.claude/skills/run-desktop`), `ORGAI_MOCK=1`, fresh temp `ORGAI_DATA_DIR`, mock project created with "Use the mock adapter" and Skip AI setup.
- Four work runs started on one project: R1 a 25-word prompt (LRU cache for the search endpoint), R2 "fix tests", R3 a near-twin of R1 (same first 12 words, "list endpoint" instead of "search endpoint"), R4 image-only (a 1x1 PNG attached through the composer's file input, no text). Plus a continuation of a finished run (R1 -> R2 in a second project), a run opened in its own window (`window:openRun`), R2 ended to get a finished run.
- Viewports 1024x640 and 1440x900, dark theme, one light-theme pass at 1024. Keyboard: arrow keys on the tab list, tab focus label read back. Reduced-motion was not exercised visually (no swap exists yet).
- Screenshots in `docs/design/ux-review-run-titles-shots/` (cited below by number).

## Where a run is named today

| Place | Source | Text shown | Full prompt reachable |
| --- | --- | --- | --- |
| Run tab | `RunTabs.tsx` | `R1` + `shortPrompt(60)`, CSS-ellipsised in a fixed-width tab | Tooltip (`title`) only |
| Tab overflow "+n" menu | `RunTabs.tsx` | `R1` + `shortPrompt(60)`, ellipsised | No tooltip seen |
| Tab accessible name | `RunTabs.tsx` | `R1: <60 chars>. Needs you.` | No |
| Sidebar "Needs you" list | `Sidebar.tsx` | `<Project> · Run R1: <28 chars>` and the card's reason below | Tooltip only |
| Sidebar project -> runs | `Sidebar.tsx` | `R1` + `shortPrompt(28)`, then ellipsised again by width | Tooltip only |
| Run header | `RunHeader.tsx` | status, one line `promptLine`, ellipsised to width; `Continues R1: <48 chars>` | `title` tooltip; the "You" bubble in the transcript has the full text |
| History tab | `RunHistory.tsx` | full prompt, 2-line clamp, `Continues/Continued by R1: <32 chars>` | `title` tooltip |
| New run page, "n other runs keep going" | `NewRunPage.tsx` | `R1: <60 chars>` as links | No |
| Decision card run label | `RunLabel.tsx` | `Run R1: <full prompt>`, CSS-clamped to one line | `title` tooltip |
| Window title | `App.tsx` | `OrgAI · R4 · <40 chars>` | No |
| Transcript "continued" row | harness text | `Continued from run run_mvuizi1allkboccz` (raw id) | n/a |

The prompt is cut up to three times: JS `shortPrompt` (28/32/40/48/60 chars, five different numbers), then CSS ellipsis on top. Nothing is cut at a word boundary.

## Ranked findings

### T1 (high) Sidebar "Needs you" and project run rows cannot tell similar runs apart
Where: Sidebar, global "Needs you (n)" list and the expanded project rows. Shots 06, 02, 11.
Saw: R1 and R3 both read `Titles demo · Run R1: Add an in…` / `Run R3: Add an in…` at 1024 (about 7 characters of prompt survive after the project name and "Run R1:" take the width), and in the project rows `R3 Add an in-memory LRU …` and `R1 Add an in-memory LRU …`. This list is the place a user goes when something needs them, and the part that distinguishes the runs is exactly the part that is cut. Both rows also repeat the same reason line ("Implementer wants to use Edit"), so the two cards are visually identical.
Title should: replace the prompt here, and be the only run text beside the index. Drop the redundant word "Run " in the Needs-you rows (the index already says it) so more of the title fits.

### T2 (high) Run tabs: fixed-width tabs show about 13 characters; similar prompts collide
Where: `RunTabs.tsx`, `.run-tab-w` is 160px (`--space-16 * 2.5`). Shots 02, 09, 12, 13.
Saw: unselected tabs show `R3 Add an in-m…` (R1 and R3 identical to the eye), at 1440 the same. Only the selected tab seems to grow (R1 at 1440 shows about 45 characters), so the labels shift as you switch tabs. The tab tooltip does carry the full prompt, which is good, but tooltips are not visible on keyboard focus the same way and not at all on touch.
Title should: be written to fit a 160px tab: roughly 14-18 visible characters, so the first two words must carry the meaning ("Add caching", "Fix tests"). See recommendations for the generation target.

### T3 (high) Run header: continuation collapses the prompt to "No…" at 1024
Where: `RunHeader.tsx`, a continued run at 1024x640. Shot 22.
Saw: with `Continues R1: Refactor the notes store so list and add share…` present, the header prompt is squeezed to `No…` (R2's prompt is "Now also add input length limits"), and `Continues …` itself is cut to `Continues …`, so neither the prompt nor the predecessor can be read. At 1440 (R1 selected, no predecessor) the prompt takes about 380px; with a predecessor it loses everything. Also the full prompt is never visible as full text in the header, only in a tooltip, though the transcript's first "You" bubble shows it (good).
Title should: be the header's main text (short enough never to be squeezed out), and the full prompt should move to a second, wrappable line or an expandable "Show full prompt" so it is visible without hovering. The "Continues R1: …" link should drop to its own line or use the predecessor's title only.

### T4 (medium) Continuation prompts are context-free follow-ups, so a title from the first message alone will be poor
Where: History, tabs, header for a continued run. Shots 22, 23.
Saw: R2 is `Now also add input length limits`, which reads fine only next to R1. In the tab bar, sidebar and Needs-you list it stands alone. The "Continues R1: …" line is the only link to meaning.
Title should: for a continuation, generate from the first message plus the predecessor's title ("Add input length limits", ideally not "Now also add input…"), or fall back to a title that shows the lineage (`R1 · follow-up`). Do not title a continuation as a standalone "Now also…".

### T5 (medium) Image-only runs are named "Image prompt" everywhere, and several can exist
Where: all surfaces. Shots 01-06, 07.
Saw: `R4 Image prompt` in tab, sidebar, history, window title and decision card. Two image-only runs would be indistinguishable. The label also reads like a prompt type, not a task.
Title should: if the model can describe the image, "Screenshot: <what it shows>" or a 3-6 word summary of the image plus any text; if generation fails or there is no vision-capable fast model, keep "Image prompt" but append the time ("Image prompt, 10:42"). Never produce a title from nothing.

### T6 (medium) Window title and accessible names re-truncate differently
Where: `App.tsx` (40 chars), tab `aria-label` (60), header `aria-label` (60). Observed window title: `OrgAI · R3 · Add an in-memory LRU cache to the notes…`.
Title should: the window title becomes `OrgAI · R3 · <title>` with no truncation (it is already short enough for the taskbar), and every `aria-label` uses the same title, so screen reader and taskbar names are stable and distinct. A title also fixes the "five different cut lengths" problem: one string, one cut (CSS only).

### T7 (medium) Decision card run label shows the whole prompt, then ellipsis
Where: `RunLabel.tsx` on `DecisionCard`. Shots 13, 14.
Saw: `Run R3: Add an in-memory LRU cache to the notes list endpoint, invalidate it whenever a note is created, and write tests covering ex…`. It is a quiet, small first line, but it spends a line to say less than a title would. In the narrow tray at 1024 it is clipped to `Run R1: Add an in-memory LRU cache to the…`.
Title should: use the title here (`Run R3: Cache list endpoint`). This is where a title helps most per pixel because the card's own title already carries the question, and the label only needs to say which run.

### T8 (medium) History: no title column, the full prompt is the row title and predecessor links use yet another cut
Where: `RunHistory.tsx`. Shots 07, 16, 23.
Saw: rows show the full prompt clamped to two lines, so two near-identical prompts (R1/R3) differ only past the cut (`…tests covering hit, miss and invalidation…` vs `…tests covering expiry behaviour`). Links read `Continues R1: Refactor the notes store so lis…` (32 chars cut mid-word).
Title should: the row's primary text becomes the title (bold), with the full prompt as a muted second line (the clamp can stay at 2 lines). History is the one list where full text belongs, because it is the archive. Predecessor/successor links use the title.

### T9 (low) New run page "keep going" links truncate mid-word with a text link style
Where: `NewRunPage.tsx`. Shot 09. `R1: Add an in-memory LRU cache to the notes search endpoint, in…` and `R3: Add an in-memory LRU cache to the notes list endpoint, inva…` look the same until the 7th word. Titles fix this; the 60-character cut is also wider than needed.

### T10 (low) Tab overflow menu has the same cuts but no title attribute, and shows one visible tab at 1024 in some states
Where: `RunTabs.tsx`. Shots 02, 03, 09.
Saw: after starting four runs back to back the bar showed one tab and `+3` (R1, R2, R3 in the menu). After the window was resized it showed three tabs and `+1`. The visible-tab count is computed from the first tab's width and the selected tab is wider, so the count looks unstable. The `+n` rows show `R1 Add an in-memory LRU cache to the notes search endp…` with no tooltip. Not a naming bug, but it increases how much a good short title matters: users spend a lot of time in this menu.

### T11 (low) "Continued from run run_mvuizi1allkboccz" row shows a raw run id
Where: transcript system row at the top of a continued run. Shot 22. The id is meaningless. Use `Continued from R1: <title>`.

## Where the full prompt must stay visible

1. The transcript's first "You" bubble (already there; keep it, with attached images).
2. History: second muted line under the title, clamped at 2 lines, full text in the tooltip.
3. Run header: reachable without hovering. Suggest a one-line title plus a "Show prompt" disclosure, or a wrapped second line on wide windows. A tooltip alone is not discoverable and is not available on keyboard focus.
4. Tab, sidebar, window title, decision card label, New run links: title only (tooltip with the full prompt can stay on tab and sidebar rows).

## Recommendations for the title

- Length: generate 3-6 words and hard-cap at 32 characters (store it capped). The 160px tab at 1024 shows about 14-18 characters after the index, dot and badge, so write the first two words to carry the meaning. Everything wider (history, header, window title) shows the whole 32. Ask the model for "at most 5 words, at most 32 characters, a noun phrase or imperative, no trailing punctuation, no quotes".
- Keep the index in front of the title (`R3 Add caching`). The index is the stable handle: it matches the tab, header, sidebar, history and decision cards, titles can be duplicated or change, and "R3" is what the user types or says. Do not put the index inside the title field.
- Swap: until the title arrives the surfaces show today's excerpt. A new title replaces it in place with an instant swap by default, no layout shift is possible because the tab is fixed-width and rows are one-line ellipsised. If a fade is added, use a 150ms opacity cross-fade on the text only and none at all when `data-reduce-motion` or `prefers-reduced-motion` is set (instant swap). Do not animate width or reflow. Never swap a title while the user is editing/renaming it, and never replace one the user has set (leave room for a manual rename later; add a `titleSource` if so).
- Stability: set the title once. Do not regenerate when the run continues, or the label changes under the user's eye in tabs and the Needs-you list.
- A screen reader should not announce the swap (no live region); the tab `aria-label` just uses whichever string is current.
- Image-only prompt: if the fast model can see the image, summarise it ("Screenshot of login error"); otherwise keep "Image prompt" plus a short time suffix so several do not collide. For text plus image, use the text.
- Continuations: generate from the first message plus the predecessor's title (T4).
- One formatter: replace `shortPrompt(…, 28/32/40/48/60)` and `runTitle` with a single `runName(summary)` returning `title ?? excerpt`, and let CSS do the cutting. That removes the inconsistent cuts (T6) as a side effect.
- Drop the word "Run " in the Needs-you rows and predecessor links; the `R` index already says it (T1).
