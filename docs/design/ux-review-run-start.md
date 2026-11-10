# UX review: starting a run and the run settings row (post-change re-walk)

Reviewer: UX Researcher. Surface: the New run page and the live composer after the "Run settings row" change (Model, Effort, Permission, Goal chips; `components/runSettings/*`, `NewRunPage.tsx`, `LiveRunView.tsx`, `RunMeta.tsx`). Compared with `docs/design/ux-review-run-start-pre.md` (H1-H3, M1-M8, L1-L5) and `docs/agent-notes/renderer.md` "Run settings row".

## How it ran

- Build driven: the main checkout `out/` built from dev at `d4258a4a` (read-only; the worktree has no `node_modules`). I did not rebuild it and did not confirm the bundle hash against the commit beyond the brief.
- `ORGAI_MOCK=1`, a fresh throwaway `ORGAI_DATA_DIR`, mock projects only, no tokens. A small file-queue driver on playwright-core's Electron launcher (`e2e/shots/ux/run-start/driver.mjs`, `r.mjs`, snippets beside them). Projects Alpha (default Unattended), Beta (setup run, later ended to give a pending-setup project) and "Gamma long" (project mode Bypass, ten roles, one very long role name) were created through the app form and the preload API.
- Sizes 1600x1000 and 1024x640 (`setContentSize`), dark and light (`data-theme`). Every state was seen in at least one theme at each size; light at 1600 only for the start page. One keyboard-only pass (Tab order, Enter/Space/Arrow/Escape on every chip, a keyboard-only Start) at 1024.
- Shots: `e2e/shots/ux/rs-NN-*.png` (gitignored). Cited below as `rs-NN`.
- Known items from the brief, checked: see "Known items".

## Verdict

LARGELY FIXED. The three Highs are closed: before Start the page names the model, effort, permission mode and goal; the live composer carries the same four chips in the same order; and the run's chosen values show on the live run and in the meta bar (including Bypass, which was invisible before). Focus after Start now lands in the reply box on project runs. Mid-run permission change works end to end on the mock: narrowing applies at once with an outcome line, widening asks, the running-reports and refusal paths show text, ended runs read "Next message: <mode>". No page scrolls at 1024x640 and neither theme is broken.

What is left is mostly about the refusal path and the picker. The refusal text throws away the reason and gives an idle run nothing to do next. The permission picker opens with focus on the first option rather than the current one, which turns an arrow-key nudge on a changed choice into a silent widening. Unattended and Bypass look identical. Chat starts have no chips although Chat runs do, and focus is lost after a Chat start.

## Status of the pre-walk findings

| ID | Pre-walk finding | Status | Evidence |
| --- | --- | --- | --- |
| H1 | Model and effort invisible before Start | Fixed | Four chips above the textarea: "Model: Opus · Anthropic Default", "Effort: Model default Default" (`rs-10`, `rs-31`). A changed choice reads "Sonnet · Anthropic Changed" (`rs-15`). Start sends what differs; live run showed Sonnet/High as chosen (`rs-20`). |
| H2 | Permission mode invisible | Fixed | Permission chip before Start (Gamma showed "Bypass all prompts Default", `rs-32`); after Start the meta bar shows the mode for any run: "Auto-accept edits" (`rs-20`), "Plan only" (`rs-22`), "Bypass all prompts (permission mode)" on an Ask run (`rs-36`), not only `auto`. |
| H3 | Start page and live composer read as two things | Fixed for project runs | Same chips, same order live (`rs-20`, `rs-36`). Goal and Effort live are plain read-only chips with a screen-reader note "Set when the run started; it cannot change during a run." Not fixed for Chat, see M2 below. |
| M1 | Goal control unlabelled, "Cost" misleading | Fixed | Popover legend "Optimise for", options Balanced / Faster / Cheaper, help "Weighs speed and cost together. This is the project default." |
| M2 | Two segmented controls plus hint compete; placeholder repeats hint | Fixed | Placeholder is now "Describe the task"; the hint line stays once. The chip row is one compact group. Row wraps, see M3 below. |
| M3 | Hero outweighs composer | Partly | Paragraph cut to one sentence ("The orchestrator plans the task and hands parts to its team."). The glyph and block are still about 250px at 1600; the composer is the lower half of the page. Acceptable. |
| M4 | Role chips flat and unlimited | Fixed | Gamma (ten roles) shows five chips and a "+5 more" link, one stop in the Tab order (`rs-32`). They are still not buttons, which is fine. |
| M5 | "Other runs" stated twice and truncated | Fixed | The composer label stays "New run"; the list below reads "2 other runs keep going" once (`rs-31`, `rs-60`). The hint line still truncates on live composers at 1024 ("paste or drop i…", `rs-36`, `rs-61`), Low. |
| M6 | Setup-pending page offers two starts | Fixed | Button reads "Start without setup", the line "Skips the Architect: the run uses the current team and settings." No chips on this page (`rs-51`). Residual: see L5. |
| M7 | Live model line detached and unclickable | Fixed | Model chip with chevron inside the composer row (`rs-20`); live picker still works (Haiku to Sonnet, "Model changed to sonnet via Anthropic."). |
| M8 | Focus after Start on an unnamed button | Fixed for project runs, not for Chat | Project Team and Ask runs: `activeElement` is the reply textarea at 100 ms, 600 ms and 1.5 s after Start (mouse and Enter). A Chat start leaves `activeElement` on BODY (see M4 below). |
| L1 | Start/Send and New run/Replying wording | Not fixed (kept) | Unchanged; acceptable. |
| L2 | Radio inputs unnamed in the keyboard report | Not re-verified | Team/Ask is one Tab stop (value `team`); Goal is a named radiogroup "Optimise for"; the effort group is named "Effort". I did not read the Team/Ask radios' accessible names. |
| L3 | Ask repeats itself | Partly | The extra "New conversation with one assistant" line is gone; the empty-state still says "No team members start." once. Ask omits the Goal chip (`rs-35`). |
| L4 | Disabled Start gives no visible reason | Not fixed | Reason is still only an `aria-describedby`/title ("Type a message to enable Start"). Low. |
| L5 | Dark/light parity | Fixed | Both themes render the chip row and popovers the same; tones hold in light (`rs-33`, `rs-34`, `rs-60`). |

Known items from the brief:

- "Opening a chip popover with Enter leaves focus on the chip": **not reproduced** here. With Tab to the chip, then Enter (permission, effort) or Space (model), focus moved into the popover (first radio or the search box) and Escape returned it to the chip. If it happens for a real keyboard on another path, I did not see it.
- "Permission picker stages a choice and applies with 'Use this mode' even for a narrowing": **confirmed** (ArrowDown x4 to Plan only, chip unchanged, Tab to "Use this mode", Enter; chip then "Plan only Changed" and focus returned to the chip). The effort control by contrast applies on every arrow press. See M3 below on that mismatch.

## New findings

### High

None found.

### Medium

**M1. A refused permission change gives no reason and, on an idle run, no next step.** Where: live composer, any run whose session refuses (`rs-24`, `rs-61`). Repro: start a run containing `[mock:mode-refuse]`; open Permission, pick Plan only, "Use this mode". What happens: the amber line reads only "The session could not change its permission mode now." The mock's specific reason ("This provider applies a new permission mode from the next session.") never appears; by code reading, `runManager.ts` line 5094 replaces the adapter's reason with that fixed sentence. While the run is working there is an "Interrupt and change" button; once idle there is nothing, the chip stays "Unattended" and the user cannot tell whether the request was kept for later, lost, or can ever work. Compare the ended run, which says "Next message: Plan only". Suggested fix: pass the adapter's reason through, and when it is a next-session refusal say so with the remedy. Copy: "Could not switch to Plan only during this session. Your provider applies a new mode from the next session. End the session, then send a message to continue in Plan only." If the mode really is saved for the next session, show it as "Next message: Plan only" like an ended run.

**M2. Chat start page has no run settings; the live Chat run does.** Where: Chat start (`rs-40`) versus Chat live (`rs-42`). The start page says "Runs on Everyday tier (sonnet) via Anthropic" in a sentence with "Change in App settings" and offers a "Let it make changes" switch; after Start the composer suddenly carries "Model: everyday · Anthropic", "Effort: Model default" and "Permission: Ask for everything risky" chips. This is the H3 pattern again for the one surface that was not changed, and the live label "everyday" is a tier alias while project runs say "Opus". Suggested fix: either show the same chips on the Chat start page or keep the live row to a quieter "Runs on Sonnet (Everyday tier) via Anthropic" line. In both cases use the friendly name: "Sonnet · Anthropic" rather than "everyday · Anthropic". The same alias shows on the setup run chip ("deep · Anthropic", `rs-50`).

**M3. The permission picker opens on the first option, not the current one, and a changed choice can be widened by an arrow key without a confirm.** Where: Permission popover opened from the keyboard. Repro A (Gamma, project mode Bypass): focus the chip, Enter; the focused radio is "Unattended" while "Bypass all prompts" is the selected one (Tab then jumps to Bypass). Repro B (Alpha new run): pick Plan only and apply; reopen with Enter, press ArrowDown, Tab, Enter: the run is now "Auto-accept edits" with no dialog (`kbperm` log). Start-page widening is judged against the project default (Unattended), so Plan to Auto-accept edits is not a widening there, which is defensible, but a user who only meant to look has moved from Plan only to a mode that lets edits through. With a mouse the focus goes to the clicked radio, so this is keyboard-only. Suggested fix: open focus on the checked radio (roving tabindex on the selected option), and mark the current option in the list: "Plan only · Current". Also say in the popover what the start-page rule is: "Asks first only if this is wider than the project default."

**M4. A Chat start leaves focus on the page body.** Where: Chat start, press Enter on the first message. `document.activeElement` is BODY 2.5 s and 3.5 s later, with the transcript and composer on screen (`rs-42`). Project Team and Ask starts land in the reply box. A keyboard user has to Tab from the top of the page to reply. Suggested fix: apply the same post-Start focus rule to the Chat start, the setup-like starts and the instruction starts: focus the reply textarea.

**M5. Unattended and Bypass look identical, and the project's own default looks like a warning.** Where: Permission chip (`rs-10`, `rs-32`, `rs-34`). All permissive modes share the amber shield. An untouched Alpha start, which is just the project default, is amber ("Permission: Unattended Default"), the same colour a bypass project shows. Warning colour on the default makes it a constant, so the one chip that should mean "this is riskier than normal" cannot. Suggested fix: use the warning tone only when the chosen mode is wider than the project default, or only for Bypass; render Unattended and Auto-accept edits as neutral with the shield icon. Keep the text, which already says what it is.

### Low

**L1. The Goal chip wraps onto a row of its own at both sizes, and the "Default" / "Changed" tags crowd every chip.** Where: start composer (`rs-10`, `rs-31`, `rs-60`): the row is 742 px (1024) and 770 px (1600) wide; Model 206, Effort 186, Permission 219 leave Goal alone on the second line, one row of height (about 34 px) bought for one chip. Each chip also ends with "Default" or "Changed", so "Permission: Unattended Default" reads as a mode called "Unattended Default" and "Effort: Model default Default" is a stutter. Suggested fix: drop the tag when the value is the default and show only "Changed" (or a dot) for changes; put the default explanation in the title. All four then fit one row at both sizes. The row did not push Start below the fold: `scrollHeight` 640 = `clientHeight` 640 at 1024x640.

**L2. The effort control has no way to see its default while "Model default" is selected, and the reset link names a different default.** Opening Effort with the default shows Low to Max with nothing selected and focus on Low; once changed there is "Use project default", but the chip's own default text is "Model default". Suggested fix: pick one name. Copy: link "Use the model's default"; when the default is selected, show it as a checked first option "Model default".

**L3. Effort is offered up to "Max" for Haiku on the mock.** `rs-34`: Haiku with Effort Max, "Changed", no note. The row's fallback copy (`run-effort-fallback`) never appeared on any mock model, so I cannot say whether it works (see "Could not check").

**L4. The Interrupt-and-change offer is shown when it cannot work, then goes stale.** Repro: `[mock:mode-refuse]` run while a permission card is open; change mode; the offer appears; click it and the line becomes "Answer the open decisions before interrupting." Answer the card with Allow once and the line is still there, unchanged, until the next attempt. Suggested fix: show the offer disabled with the reason ("Answer the open approval first"), and clear the line when the block lifts.

**L5. "Start without setup" hides the settings it will use.** Beta, setup pending (`rs-51`): no model, effort or permission is shown, yet Start runs with the team's and project's. The pre-walk recommended hiding them, and the helper line is good, but it can say what will run. Copy: "Skips the Architect. Runs on Opus with the project's permission mode (Unattended)." A one-line summary, not chips.

**L6. Wording drift between start and live pickers and the confirm.** Start: "Use this model"; live: "Use model". The Bypass confirm on the start page ends "Open approval cards stay open." which is meaningless before a run exists (`rs-14`). The live confirm is clear (`rs-23`: "Switch this run to Auto-accept edits? ... applies to this run only (now Plan only). Open approval cards stay open."). Suggested fix: align the button to "Use this model"; drop the cards sentence on the start surface.

**L7. Ended-run chips read "Model: Next message: Opus · Anthropic" and "Permission: Next message: Plan only".** (`rs-26`, `rs-30`.) For an unchanged model "Next message:" implies a pending change. Suggested fix: show the prefix only when the value differs from the ended run's value; otherwise "Model: Opus · Anthropic".

**L8. Narrowing to Plan only on a live run sends a message the user did not write.** `rs-22`: after Plan only the transcript shows "Continuing: asked the orchestrator to write a plan before it works." and the mock replies. That may be intended (the agent has to be told), but it is not announced in the outcome line ("Permission mode is now Plan only."). Suggested fix: "Permission mode is now Plan only. The orchestrator was asked to write a plan first."

## Keyboard pass (1024x640)

- Tab order on the start page: tab, "+", "+5 more" (when present), Team/Ask (one stop), Model, Effort, Permission, Goal, Attach images, textarea, then the skip links. Start is skipped while empty and a Tab stop once text exists (Enter in the textarea also starts). Visible 2 px outline on every stop (`outline solid 2px`; the textarea also has a ring).
- Each popover opens on Enter or Space with focus inside (Model: search box; Effort: first level; Permission: first radio, see M3). Escape closes and returns focus to the chip in all three. Effort: Arrow keys step and the chip updates at once; Escape keeps the last level. Permission: arrows stage, Tab reaches "Use this mode", Enter applies and focus returns to the chip. The Bypass confirm opens with focus on "Keep current mode" (the safe button).
- Keyboard-only Start (focus textarea, type, Enter): reply textarea focused after Start on an Ask run; chips announce read-only with the sr-only "Set when the run started".
- The permission outcome text is a polite status (`role=status`, `run-permission-status`), seen in the DOM; I did not hear it.

## Not driven / could not check

- Real providers, real model lists, real effort support per model: the mock offers every effort level for every model, so the `run-effort-fallback` ("this model does not take that effort") and the clamp could not be provoked. A model name longer than a chip could not be produced either (mock names are short); the 160 px chip ellipsis and the chip title are unverified. The long role name was verified (Gamma).
- The mock always reports `claude-opus-4-5` in the transcript header and node (`mock.ts` line 1742) whatever model was chosen, so the transcript shows Opus on a run the chip shows as Sonnet. That is a mock artefact, not an app fault, and means I could not confirm that the chosen model reaches the run itself, only the chip.
- Mid-run permission change on real adapters (Claude, Codex, proxies): only the mock's markers. The mock's refusal text is replaced by main's fixed sentence (M1), so a real adapter's wording was not seen.
- A widening confirm on the start page: Bypass from Unattended (`rs-14`) and cancel were seen; "Auto-accept edits" as a widening was seen live (`rs-23`). I did not drive the start-page confirm for a project whose default is Plan or Ask for everything risky.
- The start-refusal banner, a `trust-restricted` run (which narrows the available modes), a team-file project and an engagement project: not driven.
- Light theme at 1600 was seen only on the start page (`rs-60`); live and Chat at 1600 light, and the Chat and instruction start pages at 1024, were not captured. The instruction (MCP/Skill) start page at 1600 dark has no chips and a composer the same width as Chat's (770 px); I saw no width regression there, and no earlier shot to compare against.
- Screen-reader speech, reduced-motion and OS high-contrast behaviour; a pointer drag or touch pass.
- Relaunch with the chosen settings: not done (choices are per run and not remembered, by the notes).
