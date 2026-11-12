# UX review: starting a run (pre-change walk)

Reviewer: UX Researcher. Surface: the blank New run page behind "+" (`NewRunPage.tsx`, `Composer.tsx`, `lib/runGoal.ts`, `.new-run*` styles) and the first seconds of the live run (`LiveRunView`, `LiveModelSwitch`, `RunMeta`). This is the "before" walk for the brief that adds a model and effort choice (and, per the owner's scope addition, permission mode) to starting and to live runs.

## How it ran

- Source SHA of the worktree: `58afeddb`. The worktree has no `node_modules`, so I could not rebuild it. I drove the existing built app in the main checkout (`out/` last built 13:30 on 2026-11-10, after that commit) read-only, through playwright-core's Electron driver. I did not confirm that `out/` matches `58afeddb` exactly; the New run page copy and structure I saw agree with the source I read.
- `ORGAI_MOCK=1`, fresh temp `ORGAI_DATA_DIR`, mock adapter only, no tokens. Projects were created through the preload API with `mock: true`.
- Sizes: 1600x1000 and 1024x640 (`setContentSize`). Themes: dark and light via `data-theme`, every state at every cell except where noted.
- One keyboard-only pass at 1024x640 light (Tab order, Enter to start). Arrow-key behaviour of the segmented controls was not captured (my probe selector missed).
- Scripts, log and screenshots: `e2e/shots/ux/run-start-pre/` (gitignored). Shot names are cited as `NN-name`.
- No earlier `ux-review-run-start*` exists. No spec for the new controls exists yet.

## Verdict

NOT READY FOR A MODEL, EFFORT AND PERMISSION CHOICE AS-IS; the page has room for them, but they need a plan. The owner is right: before Start, nothing on the page names the model, the effort or what the run is allowed to do. The page tells a first-time user the role names and a "goal", then Start. After Start the live view shows the model (a plain right-aligned line above the composer) and, only for the `auto` mode, an "unattended" label in the meta bar. The start page and the live composer therefore describe two different things: the start page is a draft of a team, the live composer is a conversation with one model. The new controls should close that gap, not add a third vocabulary.

Nothing is broken at either size: the New run page never scrolls (1024x640: `scrollHeight` 552 = `clientHeight` 552, composer and Start button fully visible), and both themes render cleanly.

## Findings

### High

**H1. Before Start the user cannot see which model will run, or the effort.** Where: New run page, Team and Ask (`10-team-*`, `11-ask-*`). What happens: the page says "Give Orchestrator something to do", lists four role chips, then the composer. The only run-shaping choice shown is a three-way "Balanced / Speed / Cost" control. The live run then shows "Opus · Anthropic" and a transcript line "claude-opus-4-5" (`51-after-start-1000`). A user who wanted a cheaper or stronger model has no way to act before Start; the first moment they learn the model is after tokens are already flowing. Fix: show a compact "Runs on" line with the model and effort in the composer (see the placement section).

**H2. What the run is allowed to do is invisible before Start, and nearly so during a run.** Where: New run page, live meta bar, project Settings. What happens: the project permission mode appears in exactly three places today. (1) Project Settings > Permissions, a native select with the full-sentence labels (`20-permissions-settings`). (2) The live meta bar, but only for mode `auto` and only on team work runs: a small shield and the word "unattended", with the explanation in a hover title (`51-after-start-1000`, `RunMeta.tsx`, read in code for the condition). (3) Permission cards, which add a chip like "Auto-accept file edits in this project" when a card is open (`52-live-1024-light`). The New run page shows no mode at all. I made a project with mode `bypassPermissions` (project "Long roles ...", shots `32-long-*`): the start page looks identical to a safe project, and by the code `RunMeta` only labels `auto`, so a bypass run would carry no cue in the meta bar either (code reading; I did not start a run on that project). A user who asks "what can this run do?" has to know to go to Settings > Permissions. Ask mode says "with the same permissions" without saying which. Fix: a visible permission chip before and during the run; any widening choice is signalled and confirmed (see placement).

**H3. The start page and the live composer disagree about what a run is.** Where: the hand-off from `NewRunPage` to `LiveRunView`. What happens: the start composer has Team/Ask, Goal and no model. Three seconds after Start the composer reads "Replying to Orchestrator" with a model line above it and no Team/Ask or Goal anywhere (`51-after-start-3000`, `52-live-1024-dark`). The user chose a Goal and never sees it again, and cannot confirm it was applied. Fix: carry the same chips into the live composer row (the run's Goal as read-only text, model, effort, permission), so the draft and the live run read as one thing.

### Medium

**M1. The Goal control has no visible label and its help text is easy to misread.** Where: `.new-run-goal` (`10-team-1600-dark`). What happens: "Balanced | Speed | Cost" sits on its own line under "New run Team | Ask". The only label is an aria-label ("Goal for this run"). "Cost" reads as "show me the cost", not "optimise for cost". The sentence beside it ends "(the project default)", which reads as an orphan. Fix: a visible "Optimise for" prefix, options "Balanced / Faster / Cheaper", help "Balanced: weighs speed and cost together. This is the project default." Keep the full help in the title.

**M2. Two segmented controls plus a hint line compete with the one thing the page is for.** Where: composer, 1600 and 1024. What happens: the composer card has four rows' worth of chrome before the text box: the label row (New run, Team|Ask, keyboard hint), the Goal row, then the field. Adding model, effort and permission to this naively would make it a toolbar of five or six controls above a 2-line text box. The keyboard hint "Enter to send - Shift+Enter for a new line - paste or drop images" also repeats the textarea placeholder, which says "Describe the task. Enter to send, Shift+Enter for a new line." (`10-team-1600-dark`). Fix: drop the sentence from the placeholder ("Describe the task") and keep the hint line; group the run-shaping chips on one row (see placement).

**M3. Empty-state hero outweighs the composer.** Where: `10-team-1600-*`. What happens: a glyph, a title, a four-line paragraph and the role chips take about 250px; the composer is a 640px-wide, 151px-tall card below it. The paragraph ("Every subagent appears here the moment it is created, attached to the agent that spawned it") describes the live canvas, not this page. At 1024x640 the glyph is dropped by the container query and the page still fits, so the weight is a 1600 issue and a reading-order one: the user reads who and how before where to type. Fix: shorten to one sentence ("The orchestrator plans the task and hands parts to its team."), keep the chips, and put the "Runs on" summary directly above the textarea.

**M4. Role chips are a flat list with no meaning and no limit.** Where: `.role-chips`. What happens: with nine roles (long names such as "Cross-functional Accessibility and Localization Reviewer") the chips wrap to three centred rows and push the composer down 30px (`32-long-1024-light`; composer top 398 vs 368 for four roles, still no scroll). They are not buttons and show no model, so they invite a click and do nothing. Fix: cap at about five, then "+4 more" linking to the Team tab; show the root agent's model next to the first chip instead of a separate control.

**M5. "Other runs" is stated twice and truncates.** Where: New run page with a live run (`60-other-runs-1024-light`). What happens: the composer label reads "New run: 1 other run keeps ..." (cut off at 1024) and the hint "Enter to send ... paste or drop..." is also cut off; the same fact is repeated as a heading and link list under the composer ("1 other run keeps going / R1: Add a health-check endpoint"). Fix: composer label stays "New run" always; the list below carries the other-runs fact.

**M6. Setup-pending page offers two competing starts.** Where: project whose setup is pending (`30-setup-1024-light`). What happens: the empty state says "Set this project up with the Architect" with a primary Start setup button; directly below, a second composer says "Describe the task (setup is not finished)" with a button also called Start. Which one applies is unclear, and I did not exercise what Start does there (the mock cannot tell me about its real consequence). Fix: while setup is pending, replace the composer with the setup call to action, or label the composer's button "Start without setup" and add one line saying what is skipped. Model, effort and permission controls should not show in this state.

**M7. Live composer: the model is a plain line detached from the composer.** Where: live view (`51-after-start-1000`, `52-live-1024-light`). What happens: "Opus - Anthropic" sits right-aligned on its own row above the "Replying to Orchestrator" row. In light theme it looks like static text, not a control; the picker (`53-live-model-picker-1024-dark`) lists raw ids ("fable", "opus") under friendly names, which is deliberate and fine, but the entry point does not look clickable. The meta bar (agents, time, cost, "unattended") sits a long way above it. Fix: move the chip into the composer's label row, give it a chevron and button styling, and put effort and permission next to it.

**M8. Focus after Start lands on an unlabelled button.** Where: first moments after Enter on the start page. What happens: `document.activeElement` is a BUTTON with no accessible name (`walk4.log`, "active element after start"); I did not identify which control. A keyboard user who just sent a task cannot tell where they are and is not placed in the reply box. Fix: after Start, focus the live composer textarea (or the transcript heading), never a nameless control.

### Low

**L1. The New run page and the live page use different words for the same actions.** "Start" versus "Send", "New run" versus "Replying to Orchestrator". Reasonable, but the 1024 live composer also truncates nothing and wastes the row, so there is room to say "Reply to Orchestrator" consistently.

**L2. The "Who works on it" radiogroup has an empty accessible label on its inputs** (Tab stops 2 and 3 in the keyboard pass report empty labels for the inner radio inputs; the group itself is named "Who works on it"). Check that each radio is named "Team" or "Ask" by its label text. Same for Goal.

**L3. Ask mode repeats itself.** The empty state says "No team members start." and the line under the composer says "New conversation with one assistant. No team is started." (`11-ask-1024-dark`). Keep the first; drop the second, and use that line for the "Runs on" summary.

**L4. Disabled Start gives no reason at a glance.** The visible button is dim; the reason ("Type a message to enable Start") exists only for assistive tech. A visible hint is not needed, but at 1024 light the disabled Start has low contrast (`60-other-runs-1024-light`).

**L5. Dark and light parity.** Both themes render the same layout; focus ring on the textarea is a clear violet in both. No theme-specific defect found on this page.

## Keyboard pass (1024x640, light)

Tab order from the Live tab: New run tab, "+" button, Team/Ask radio group (one stop), Goal radio group (one stop), Attach images, the textarea. Start is skipped while the textarea is empty (disabled), reachable once text is typed. Enter in the textarea starts the run. Visible 2px outline on every stop. The order matches the visual order top to bottom. The new controls must keep that order (chips before the textarea, Start last) and each be one Tab stop. After Start, see M8.

## Not driven

- The start-refusal banner (`new-run-start-refusal`): I tried a non-mock project; no banner appeared on the mock build (`refusal banner NONE`). I cannot say how it looks or how much room it takes. By the code it sits between the notices and the composer for team runs only.
- A real connection, real model lists, effort support differences between providers and cost goal numbers: mock only.
- A live run on a bypass-mode project and an Ask run's live view: not started; statements about them are from code reading and labelled as such.
- Arrow-key behaviour of the segmented controls, screen-reader speech, and a pointer/touch pass: not captured.
- Setup flow past the first page, and what Start does while setup is pending.
- Reduced motion and OS high-contrast themes.

## Where the model, effort and permission controls should go

Principle: one row of "run settings" chips directly above the textarea inside the composer, the same chips (same order, same wording, same popover pattern) in the start composer and the live composer. Start page = draft of those settings; live composer = the same chips, applied to the live run.

1. Row and order: `Goal` stays where it is for now but moves into this row as a chip; then `Model`, `Effort`, `Permission`. Left to right: Model, Effort, Permission, Goal. Text hierarchy: label row ("New run", Team|Ask, hint), then the chip row, then the field.
2. Model chip: a button reading the friendly name and connection ("Opus - Anthropic") with a chevron, opening the existing `Popover` with the `LiveModelSwitch` picker pattern (bounded search, grouped by connection, friendly label plus exact id). On the start page the picker only selects (no interrupt copy, no "Interrupt and switch"; the action is "Use this model"). On the live composer it is the existing `LiveModelSwitch`, unchanged, but moved into the same row. Default text when nothing is chosen: "Default: Opus - Anthropic", so the choice is visible even when untouched.
3. Effort chip: a `SegmentedControl` of the supported levels (for example Low, Medium, High) if there are at most four, otherwise a `Popover` with radios. Show it disabled with a reason ("This model does not set effort") when the chosen model has none; never hide it, so the row does not jump. Default text "Default effort".
4. Permission chip: a `Popover` radio list using the existing `PERMISSION_MODE_OPTIONS` labels (the same vocabulary as Settings > Permissions), showing the short name on the chip: "Unattended", "Auto-accept edits", "Ask for risky", "Never ask", "Plan only", "Bypass". Start default is the project's mode with the text "Project default" in the popover. This also answers "what can this run do?" in one glance.
5. Widening is the only dangerous direction. Moving toward fewer prompts (Unattended, Never ask... and above all Bypass) uses a `ConfirmDialog` that says what changes: for Bypass, "Let this run act without asking? Bypass skips every permission prompt, including shell commands and edits outside the project. Use it only on a folder you can restore." Buttons "Use bypass for this run" (destructive-styled) and "Keep current mode". Narrowing (Plan only, Ask for risky) applies at once with an inline note "Applies to this run only". A widened chip shows a warning tone and the shield icon in both the chip and the meta bar, and `RunMeta` should show the mode for every non-default or bypass state, not only `auto`. Say "this run only" or "saves to the project" explicitly: I recommend per-run only, with a small "Save as project default" link in the popover.
6. Mid-run: changes to model and permission apply at an idle safe boundary, as `LiveModelSwitch` already does ("Next message" copy). Do not allow a widening choice while a permission card is open; show the existing disruptive-switch block text. The live chip row keeps the same labels so a user can compare start and live.
7. Width: at 1024x640 the composer is 640px wide inside the page, so four chips plus the Team|Ask control will not fit one row. Let the chip row wrap and keep each chip no wider than about 160px with ellipsis and a full-text title. Do not push the Start button below the fold: the page currently has about 90px to spare at 1024x640 (composer bottom at 519 of 552) and one extra chip row costs about 36px; the "Give Orchestrator" paragraph can be shortened (M3) to pay for it.
8. Keep Start, Team/Ask and the textarea as they are; each new chip is one Tab stop, between Goal and the Attach button, in reading order. Focus returns to the chip after the popover closes (the `LiveModelSwitch` pattern).

### Recommended copy

- Chip tooltips: "Model for the lead agent. Team members keep the models set in the Team tab." (confirm this scoping with the runtime brief); "How hard the lead agent thinks. Higher is slower and costs more."; "What this run may do without asking."
- Summary line (Team): "Runs on Opus with high effort. Edits and commands need your approval." (Ask): "One assistant on Opus. Same permissions as the project."
- Bypass chip title: "Bypass: no permission prompts for this run."
- Live: "Next message: Sonnet" is already the right wording for a changed model; use the same pattern for "Next message: Plan only".
