# QA: Dashboard overhaul (edge cases in the running app)

Tree: local dev d0863a14 (worktree build, `npm run build` ok). Mock adapter, throwaway data dirs, token-free. Driven with
throwaway Playwright scripts outside the repo (`%TEMP%\qa-dash\p1..p9.mjs`, built on `e2e/lib.mjs`; nothing added to the
repo). Sizes 1024x640 and 1600x1000, dark and light. Nothing in product code or e2e was changed.

## Verdict: PASS WITH FINDINGS

No Critical or High finding. Name, Customise, pins, layout-storage corruption, inline answers, overflow and keyboard reach
all held up under the cases below. Findings are Medium and Low.

## Findings

| # | Sev | Finding |
| --- | --- | --- |
| 1 | Medium | With every arrangeable section hidden, the Dashboard is only the greeting and footer. The brief still says "No runs yet. Open a project to start one." (or the waiting/paused sentences) but nothing on the page lets you open a project, and there is no line saying sections are hidden. Steps: Customise, Hide x5 (all five), Esc (any size, both themes; `qa4-all-hidden-normal`). Recovery exists (Customise > Show, and the sidebar lists projects) but the page gives no hint. Expected: a one-line "Sections are hidden. Customise to show them." when the visible arrangeable list is empty. Not covered by e2e/dashboard.mjs A21. |
| 2 | Low | Name field: a 41st character is dropped silently. `maxLength=40` truncates typed or pasted text with no message, so pasting a 41-character name saves the first 40 and the person is never told (the "Use up to 40" sentence only shows for refused hidden characters). Steps: Add your name, paste 41 `B`, Save: saves 40 `B`, no message (1024, dark). The spec says "refused" for 41; the product truncates at input instead. |
| 3 | Low | Name field: a ZWJ emoji sequence (family emoji, U+200D) is refused with "Use up to 40 letters, numbers or spaces." That matches the contract (format characters refused) but reads wrong for a visible emoji; a plain emoji ("Sam 🎉") and 40 CJK characters save fine. Not tested: skin-tone, flag, U+FE0F heart sequences. |
| 4 | Low | A 40-character wide name ("W" x 40) is ellipsised in the salutation at 1024x640 ("Hello, WWWW..."). The full name is reachable only in the popover or Settings. No overflow or overlap with the pencil and Customise. |
| 5 | Low | At 1600x1000 the two-track pair "Pick up" / "Today" leaves a large empty block (about 400 px) under the shorter column when the other has 5 to-dos plus schedules (`qa5-1600-light-mid`). Pure layout whitespace, no clipping. |
| 6 | Low | The page's live region reads "Position 2 of 5" style text correctly, but repeated key presses at an end announce "X is already first." once per press, and presses within 1.5 s are concatenated into one long run-on utterance (seen: the same sentence 3 to 6 times in one string). By design of the 1.5 s join; noting the noise, not a defect in the join. |
| 7 | Low | Mock run titles drop brackets and colons from the marker: "[mock:fatigue]" renders "mockfatigue" in Waiting, Pick up and Working rows. Mock-only artefact of the title cleaner; not a product risk. |

Checked and held (worth keeping out of the finding list):

1. Name. 40 characters saves; 41 typed is capped to 40 (finding 2); RTL override (U+202E) and zero-width (U+200B) are refused in the popover
   with the stated sentence (`role=alert`), input keeps what was typed, nothing stored, no stray announcement. Emoji, CJK, inner-whitespace
   collapse ("  Sam    Lee  " saves "Sam Lee") and markup (`<b>Sam</b> & "q"` shown as literal text, not parsed) all save. Clearing with an empty field
   and Enter reads "Name removed." and the control returns to "Add your name". Focus returns to the opening control after save, cancel and Esc
   from the input. Settings > General > About you shows the Dashboard-saved name, a Settings save ("Pat") shows in the greeting, a Settings
   zero-width name is refused with the inline sentence and the stored name stays "Pat", Settings clear removes the greeting name. A failed save
   was provoked (settings.json set read-only): the popover stays open, keeps the typed "Sam", shows "The name was not saved. Try again.", the
   greeting is unchanged. Not driven: a failed save from the Settings field.
2. Customise by keyboard (1024x640, three projects, no runs). Enter on Customise: button becomes Done, focus stays on it. Tab path: Reset layout,
   then each section Up, Down, Hide, in order. Each of the five sections moved to the top and to the bottom with repeated Enter: focus stays on
   the pressed button; at an end the button is `aria-disabled="true"` (not `disabled`) and the live region says "... is already first/last."
   Hide moves focus to that row's Show; Show moves it to that row's Hide. All five hidden: collapsed rows with Show, Esc returns focus to
   Customise. Reset keeps the pin (checked in localStorage), focus stays on Reset, says "Layout reset to the default." Esc leaves customise from
   Reset. Relaunch kept the layout byte-for-byte. Corrupt `orgai.dashboardLayout`: bad JSON, `null`, wrong version, unknown ids, duplicates,
   empty order with all ids hidden, 5000 pins, a prototype-shaped object: no render error each time, order falls back to a full valid layout
   (unknown ids dropped, valid hidden id kept, missing ids appended, pins pruned to known projects).
3. Pins. 32 projects (names: 120-char unbroken, 90-char, mixed Arabic/Hebrew/CJK, `<script>` text), all pin buttons present only in customise. Pinning
   past 24 stops at 24 (storage holds 24, 24 buttons pressed) and says "The pin limit is 24." Pin order follows pin order. Deleting a pinned
   project through the tile menu removes its pin from storage at once and focus lands on the next tile's main button. Deleting through the raw IPC
   (not the UI) leaves the stale pin and the tile until a reload; not a user path.
4. Data extremes. 30 projects plus 6 long-named ones; 4 pending decisions (3 projects); 2 live runs plus idle awaiting reply; a paused run
   (`[mock:model-switch-limit]`) and a stopped run in Pick up; 33 to-dos (30 in one project) and 7 odd ones (200-char spaced, 200-char unbroken,
   Hebrew/Arabic, markup and markdown characters, emoji, a newline); an 80-character unbroken schedule name and a CJK schedule name. No
   horizontal overflow and no clipped non-ellipsis text at either size in either theme (programmatic scan of every element in the Dashboard;
   screenshots read at 1024 dark/light and 1600 light). Truncation is ellipsis. The page scrolls in `.dashboard`, the window does not. Unknown
   cost reads "Cost unknown" (`[mock:no-price]`) and is never "$0": the scan found zero `$0`/`$0.00` strings. Stopped run reads "<$0.01", the week
   figure "$0.03+". The titles of long to-dos are ellipsised; whether a tooltip carries the full text was not checked. Show N more / Show fewer
   works and focus rests on the toggled button. Start session from a 2000-character-detail to-do opens Chat with the text prefilled and starts
   no run. The todo and schedule stores refused over-limit text (title over 200 chars, name over 80) before it reached the UI, so 200 and 80 were
   the exact tested maxima.
5. Inline answers. `NeedsInline.tsx` and `needsInline.ts`: `git diff 73b87c1b HEAD` on both paths is empty (byte-identical). Rows offer only "Allow once"
   and "Deny", no scope text anywhere in Waiting on you (regex scan for always/session/project-wide/every time/for this found none). Deny removed the
   first fatigue card and the next row was the second card (an edit outside the project), which offers no inline buttons, as documented.
   Allow once on that second card was not re-driven (my script timed out waiting for a button that row correctly does not have), so Allow once
   here rests on e2e/dashboard.mjs A8, not on my run.
6. Keyboard and focus (1024x640). Tab walks the whole page and wraps with no trap: skip link, topbar, Customise, name, each Waiting row
   (open, Allow once, Deny), Today start buttons, Working rows, day strip, usage link, each tile main and More. Every focusable control in
   `[data-testid=dashboard]` (22) was reached. The name popover is non-modal (Tab leaves it after Cancel); Esc from the input closes it and returns
   focus to "Add your name".
7. 200% zoom (webContents zoom factor 2, so 512 and 800 CSS px wide): `scrollWidth == clientWidth` in normal and customise mode at both sizes, no
   document horizontal overflow. Measured only; the zoomed screenshots are cropped by the capture so the zoomed layout was not judged visually.

## Not verified, and why

- Reduced motion: no moving cue could be driven. Mock runs in these setups never produced a Dashboard mark with `data-state="working"`
  and `data-breathe` (runs showed "Thinking..." with no breathing element), so `document.getAnimations()` was empty with Reduce motion both
  off and on, at both sizes, and with OS reduced-motion emulated. "Nothing moves" therefore holds only vacuously; the real check remains
  e2e A25. "Pause motion" is an Office control and does not exist on the Dashboard.
- `[mock:schedule]` from a work run did not add a schedule in my run (two schedules created through IPC were shown); `[mock:todo]` was not driven
  (to-dos were seeded through IPC). Marker behaviour is covered by e2e A14.
- A second real window (storage event), live providers, screen-reader speech, a failed save from the Settings field, and first-launch beyond a
  read of the text (A2 covers it).
- The sidebar (not in scope) shows a horizontal scrollbar stub and a white square at the bottom of the rail with 30+ projects at 1024x640.

## Missing e2e coverage (described, not added)

- All five sections hidden: the page says nothing about it (finding 1).
- 41 characters pasted into `dash-name-input` (finding 2): A7 asserts only that `maxLength` stops it.

## What I ran

`git diff 73b87c1b HEAD -- NeedsInline.tsx needsInline.ts` (empty); `npm run build`; throwaway scripts `p1` (first launch), `p2` (name cases and
Settings), `p3` (32 projects, 24 pins), `p4` (keyboard customise, relaunch, 8 corrupt-storage cases), `p5` (many decisions, live, paused, stopped,
overflow scan, 4 size/theme combos), `p6` (to-do and schedule extremes), `p7` (reduced motion probe, Tab walk, inline answers), `p8` (reduced
motion with live runs), `p9` (delete pinned, Esc, failed save, 200% zoom). No typecheck, unit suite or e2e script was run (the lead said to skip them).
Touched file: `docs/design/qa-dashboard-overhaul.md` only.
