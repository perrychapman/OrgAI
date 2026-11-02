# OrgAI UX review: permission-prompt fatigue

Reviewer: UX Researcher. Build: dev `b00842c`, `npm run build`, `ORGAI_MOCK=1`, fresh temp `ORGAI_DATA_DIR` per pass, no tokens spent, no smoke scripts. Fixture: `makeFixtureRepo` at `<tmp>/notes-app` plus a sibling folder `<tmp>/shared-lib`. Project created on the mock adapter with the Architect off (new projects default to permission mode "Unattended"). Driver: `e2e/shots/perm/walk.mjs` (scratch, gitignored) with a custom `ORGAI_MOCK_SCRIPT` that replays the user's report: an Implementer working in `.claude/worktrees/agent-a1b2c3` runs `cd <worktree> && npm test` twice and `cd <worktree> && git add -A && git commit ...`, edits two files there, a second Implementer edits `../shared-lib/index.js`, runs `cd packages/api && npm test` and writes `packages/api/src/health.js`, and the Orchestrator runs `npm test && git status --short`. That is 9 approval-gated calls.

Window `setContentSize` 1600x1000 (mouse, and a second pass answering every card with Allow once) and 1024x640 (keyboard only), dark theme. Screenshots are in `e2e/shots/perm/out/` (gitignored; numbers below), raw card data in `results-*.json` there. Owner files are given as likely owners.

## What a fatigued user needs (summary)

- "Always allow" has to stop the prompt they just saw. Today it saves `Bash(cd:*)` for `cd <dir> && npm test`, which by OrgAI's own matcher never covers that command again (H1).
- One way to say "these folders are mine": the project folder, its worktrees and named sibling folders, saved with the project. There is none, and a folder grant offered by the CLI is silently kept for the session only, even under "Always allow for project" (H2).
- Every card must say which folder it touches and whether that is outside the project. Edit cards show only a file name (H3).
- The card must show, in plain words and without expanding anything, what "Always allow" will stop asking for (H4, M1, M2).
- A visible route from a card to "ask me less" (permission mode with trade-offs, saved rules, this run's grants), and batch answers when several cards queue (M3, M5, M6).

## Verdict

Not good enough for long unattended runs. The card itself is clean (one shell, scope buttons, focus on the primary, a decision stepper when several queue), but the scope buttons promise more than they save. A user who does the right thing, choosing "Always allow for project" on a `cd <worktree> && npm test` prompt, is asked again on the next identical command, and nothing on the card or in settings explains why. Edits outside the project root have no lasting answer at all.

## Click counts (the 9-call scenario)

| Way of answering | Cards shown | Clicks (mouse) | Keys (keyboard) | Evidence |
| --- | --- | --- | --- | --- |
| Allow once on every card | 9 | 9 | 9 to 18 (Enter, or Tab + Enter where focus starts on Details) | shots 41-49 |
| Always allow on the first `cd ... && npm test`, Allow for session on the first Edit (what a tired user does) | 6 on the mock | 6 | 6 + 4 Tab to reach "Always allow" | shots 01-08 |
| Same choices, expected on a real Claude run by OrgAI's matcher (`ruleMatch.ts shellRulesFor`: every `&&` segment must be covered, so `Bash(cd:*)` leaves `npm test` and `git commit` uncovered) | 8 | 8 | - | code read, not run live |
| What the user expected after "Always allow" plus "edits in my folders are fine" | 3 to 4 (first `npm test`, first `git commit`, first sibling edit) | 3 to 4 | - | target |

Opening a card from the sidebar's Needs-you list adds one click per card (open list, pick item); the list items cannot be answered in place (shot 48).

## Findings

### High

**H1. "Always allow for project" on a compound command saves a rule that never matches it again.**
Flow: card 1, `cd <worktree> && npm test`, chip `Bash(cd:*)`, click "Always allow for project" (shot 01). `.claude/settings.local.json` then holds `{"allow":["Bash(cd:*)"]}` and the rules panel shows `Bash(cd:*)` (shot 09). OrgAI's harness rule (`permissionRules.ts deriveSuggestions`, used whenever the provider offers no suggestion) takes the first word of the whole command. OrgAI's own matcher (`ruleMatch.ts shellRulesFor`) needs every `&&` / `;` segment covered, so the next `cd <worktree> && npm test` and `cd <worktree> && git commit` are not covered: the same card comes back after the user chose "Always". The card does not say the rule covers only the `cd` part. What the Claude CLI itself suggests for a compound command was not checked live (no smoke script). On the mock the repeat does not show (see M7), so e2e cannot catch this.
Owner: `src/main/runtime/permissionRules.ts` (`deriveSuggestions`), `src/main/runtime/ruleMatch.ts`, `components/PermissionCard.tsx`.
Expected: approving `cd X && npm test` "always" stops asking for `npm test` run from the project or any of its worktrees.
Fix idea: derive one rule per segment and drop `cd <path>` segments whose target is inside the project, its worktrees or a granted folder (let the matcher skip those `cd`s). The card then shows `npm test` (exact or `npm test:*`) as the saved rule.
Check: a unit test that `deriveSuggestions('Bash', { command: 'cd <wt> && npm test' })` yields `Bash(npm test:*)` and that `matchingRule` then covers `cd <other worktree> && npm test`. A mock walk with this script then shows 3 to 4 cards, not 8.

**H2. There is no way to say "edits in these folders are fine", and folder grants are never saved.**
Flow: a second Implementer edits `<tmp>/shared-lib/index.js`, a sibling of the project (shot 47 at 1600: "Edit index.js", Allow once and Deny only on the mock). Code read: `applyAllowScope` saves only `addRules` allow rules. An `addDirectories` or `setMode` suggestion from the CLI (the SDK `PermissionUpdate` types allow both; the card shows them as "Access to <dir>" / "Permission mode: ...") is applied with destination `session` by `toSdkSessionUpdates` even when the user picked "Always allow for project". So the card's "saved to the project rules" is false for these. Nothing passes `Options.additionalDirectories` (`grep additionalDirectories src/main` finds nothing), and neither Project settings nor the New project form has a folders field. Hand-typed `Edit(<folder>/**)` rules are accepted by the rules panel (shot 11) but are a workaround the user must invent (see M4).
Owner: `src/main/runtime/permissionRules.ts` (`applyAllowScope`), `src/main/runtime/claude.ts` (options build), `src/shared/types.ts` (`Project`), `components/settings/AgentsSection.tsx`.
Expected: one place to list extra folders. Edits there count as in-project under every mode, and "Always allow" on a card for a file outside the project offers "Always allow edits in <folder>".
Fix idea: add `Project.extraFolders: string[]` (contract first), pass it as `additionalDirectories` and to the harness matcher, persist an `addDirectories` suggestion into it on project scope, and add an "Extra folders" row under Permissions with Add and Remove.
Check: approve "Always allow for project" on a sibling-folder edit, end the run, start a new run with another edit there: no card. The folder is listed in Settings > Agents.

**H3. The card does not say where the agent is working.**
Flow: Edit cards read "Edit server.js" / "Edit index.js" with no path. At 1600 the path is under a collapsed "Tool input" disclosure (shots 03, 47). At 1024 it takes Details and then Tool input, 2 clicks (shot 24). A worktree edit, an in-project edit and an edit in a folder outside the project look the same. Bash cards show no working directory. The Needs-you list reads "Allow: Edit index.js / Notes app - R1" (shot 48). Two Implementers both show as "Implementer" (handles `implementer-1` / `-2` are not on the card, shot 04).
Owner: `src/renderer/src/lib/decisionTitle.ts` (`permissionTitle`), `components/PermissionCard.tsx`, `components/DecisionCard.tsx`, `lib/needsYou.ts`.
Expected: a glance tells "inside the project", "in worktree agent-a1b2c3" or "outside the project: ../shared-lib", plus which agent (handle).
Fix idea: add a location line under the title, relative to the project root (`src/server.js`, `worktree agent-a1b2c3 / src/server.js`, `../shared-lib/index.js`), with an attention Badge "Outside project". Show the handle beside the role name. Reuse the same location in Needs-you items.
Check: in this script's card 6 the title area shows `../shared-lib/index.js` and an "Outside project" badge at 1024 without expanding.

**H4. "Always allow for project" on an Edit saves the whole Edit tool, with no warning on the card.**
Flow: Edit card, chip `Edit`, buttons "Allow for session" / "Always allow for project" (shot 03). `deriveSuggestions` returns a bare tool-name rule for every non-shell tool. Once saved, the rules panel marks `Edit` "whole tool: approves every Edit call before any prompt, whatever its input", but the card shows only the plain chip. Per CLAUDE.md, saved rules reach the Claude PreToolUse hook (`matchingRule`), whose allow bypasses the permission system, so one click approves edits to any path on the disk, outside the project included. Seen on the mock. On Claude this happens only when the CLI offers no suggestion of its own (not checked live). I am raising it for the Reviewer's security pass too.
Owner: `src/main/runtime/permissionRules.ts`, `components/PermissionCard.tsx`.
Expected: an edit approval is scoped to a folder, and anything whole-tool is labelled as such on the card before the click.
Fix idea: derive `Edit(<project>/**)` (or the granted folder from H2) for file tools, and render the panel's "whole tool" chip and sentence on the card when a rule is whole-tool.
Check: the Edit card's chip reads `Edit(<project>/**)` / "Edits inside notes-app". A saved rule does not approve an edit in `../shared-lib`.

### Medium

**M1. At 1024x640 the user cannot see what "Always allow" saves.** In compact mode the scope sentences and the rule chip sit behind Details (shot 21). With Details open, the chip is below the tray's inner scroll fold (shot 22), so the user clicks "Always allow for project" without seeing `Bash(cd:*)`. Owner: `components/PermissionCard.tsx`, `styles` for `.decision-card[data-expanded]`. Fix: put the rule in the button or right beside it ("Always allow `npm test`"), and give the button an aria-describedby pointing at the rule. Check: at 1024x640 the saved rule is readable with the card collapsed.

**M2. Compound commands lead with the `cd` and hide the real action.** Title "Run cd C:\Users\...\worktrees\agent-a1b2c3 && npm test" (shots 01, 21). For the commit the title is cut to "Run cd C:\...\agent-a1b... (long command)", and `git add -A && git commit` is not in the title at all (shot 46). The command block is complete, but the card never says whether approving covers the whole line or only its first word. Owner: `lib/decisionTitle.ts`, `components/PermissionCard.tsx`. Fix: title from the non-`cd` segments plus the folder ("Run npm test in agent-a1b2c3", "Run git add, git commit in agent-a1b2c3"), and a segment list with "covered by this rule / still asks" marks. Check: shot 46's title names `git commit`.

**M3. The permission mode does not help a tired user choose.** Settings > Agents > Permissions shows a select with short names only (Unattended, Auto-accept edits, Ask for risky actions, Never ask, Plan only, Bypass all prompts) and a description for the selected mode only (shot 09). "Learn more" says "Other modes show approval cards in the live view", yet Unattended also shows them. Nothing says that "Auto-accept edits" still asks for files outside the project folder and for every command, or which mode asks least without bypassing. The wording says "Claude decides" whatever the connection. There is no link from a card, the tray or the Needs-you list to this pane or to the rules. Owner: `components/settings/AgentsSection.tsx`, `src/shared/types.ts` `PERMISSION_MODE_OPTIONS`, `lib/settingsCopy.ts`. Fix: a radio list with one trade-off line per mode ("asks for: commands and edits outside the project"), plus a quiet "Asking too often? Permission settings" link in the card helper after the 3rd card in a run. Check: from a card, one click reaches Settings > Agents > Permissions.

**M4. The rules panel takes any text and does not explain what a rule covers.** `Edit(<folder>/**)`, `Bash(cd *)` and `Bash(npm test)` were all accepted with no message (shot 11). The hint "Applies to open runs too" is wrong for `Edit(path)` content rules (`ruleMatch.ts` leaves them to the provider, which reads saved rules at session start) and for `Bash(cd *)` (the matcher knows only `:*` and exact forms). Rules are listed raw, with no plain-language line, no word on `&&` (every part must be covered) and no mention of the file they live in (`.claude/settings.local.json`). Owner: `components/PermissionRulesPanel.tsx`, `src/shared/types.ts`. Fix: one plain line per rule ("Any command starting with npm test, from any folder"), a warning for forms OrgAI cannot apply live, a folder example among Examples, and the file path in the section note. Check: adding `Bash(cd *)` shows a warning naming the supported form.

**M5. Session grants are invisible.** After "Allow for session" on `Edit` nothing in the run (side panel tabs Transcript / Plan / Usage / Logs) or in settings lists what this run may now do, so it can be neither reviewed nor promoted to the project (shots 08, 09). Owner: run side panel, RunManager grants. Fix: a "Grants" list in the run's Logs or Plan tab with "Save for project" and "Revoke". Check: after shot 03's session choice, `Edit` is listed for R1.

**M6. A queue of cards means one click each, with no batch and no shortcuts.** Four cards queued (shots 04, 24): stepper "Decisions 4" with chips and Previous / Next, focus on Allow once, and the next card mounts focused, which is good. But there is no "Allow all from this agent once" or "Allow all N", and no access keys (`DecisionCard` / `PermissionCard` handle no keys). On Bash cards focus starts on Details, so Allow once costs Tab + Enter and "Always allow for project" costs 4 Tab + Enter (1024 keyboard pass, `results-1024-keys.json`). Owner: `components/DecisionTray.tsx`, `components/PermissionCard.tsx`. Fix: an "Allow all N once" action in the stepper when every open card is a permission card, and focus on Allow once even for commands, with Details one Shift+Tab away (the command is already visible in compact mode). Check: the 4-card queue is cleared in 1 click or 1 key.

**M7. The mock is more permissive than the real matcher, so e2e cannot show H1.** `mock.ts` treats a call as pre-approved when its derived rules are all saved (`rules.every(r => savedUsable.has(r))`). After `Bash(cd:*)` was saved it ran `cd <wt> && npm test` again and `cd <wt> && git add -A && git commit` with no card (6 cards in the first pass against 9 with Allow once; transcript in shot 08). Background asks (`step.background`) also carry no suggestions, so queued cards on the mock never offer scope buttons (shots 04, 24, 47). Owner: `src/main/runtime/mock.ts` (Adapter Engineer). Fix: use `matchingRule` only, as the Claude hook does, and pass `suggestions` on background asks. Check: rerun this script; the repeat `cd ... && npm test` asks again until H1 is fixed.

### Low

**L1. The command is shown twice at 1600.** The summary line "$ cd C:\Users\...\notes-app\.c" (clipped) sits above the full Command block (shots 01, 46). Fix: hide `perm-summary` for Bash when the command block is open. Owner: `PermissionCard.tsx`.

**L2. The Edit diff is still collapsed by default.** "Tool input" is closed on Edit and Write cards, while a Bash command opens by itself (shot 03). This is `ux-review.md` M5 carried over: partly fixed (the diff exists, it is one click away). Fix: open the preview for Edit and Write as for Bash. Owner: `PermissionCard.tsx`.

**L3. "Allow for session: until the run ends" is ambiguous.** A run that goes Idle and continues is still "the run"? Fix: "until you end this session". Owner: `PermissionCard.tsx`.

**L4. Needs-you items name no agent or folder.** "Allow: Edit index.js" (shot 48). Follows from H3; fix there.

## Suggested order of work

1. H1 (segment-aware rules, `cd` into project folders ignored) together with M7, so the mock shows the fix. Main process, unit-testable, the biggest cut in prompts.
2. H2 contract (`Project.extraFolders`) and the settings row, then persisting `addDirectories` on project scope. Needs a Reviewer pass (permissions).
3. H4 (folder-scoped edit rules, whole-tool warning on the card). Reviewer pass.
4. H3 and M2 (location line, outside-project badge, segment-based title): renderer only.
5. M1, M6 (rule visible in compact mode, batch allow, focus), then M3, M4, M5.
6. Lows.

## Not checked

A live Claude or Codex run (what the CLI suggests for compound commands and out-of-root edits, and whether it prompts for edits under `.claude/worktrees/`: a grep of the bundled CLI suggests worktrees are not on its sensitive-path list, unverified), light theme, the rule-request card (`RuleRequestCard.tsx`), and separate run windows.
