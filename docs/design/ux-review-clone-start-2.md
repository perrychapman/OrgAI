# UX review 2: start a project from GitHub, and folder config trust

Reviewer: UX Researcher. Build: 42385ff (`npm run build`). Run: `ORGAI_MOCK=1`, throwaway data dirs, playwright driver on `e2e/lib.mjs`. `ORGAI_MOCK_GH=missing|logged-out` set at launch.
Sizes 1024x640 and 1600x1000 (`setContentSize`), dark and light (`data-theme`). Mouse pass at both sizes and themes for the trust screens and the cloned form; the clone, fork, failure and gh passes were walked mainly at 1024x640 dark, with the cloned form and the gh states also shot at the other three combinations. Keyboard pass at 1024x640 dark.
Compared with: `ux-review-clone-start.md` (pre-build walk) and CLAUDE.md. Shots and scripts: `e2e/shots/ux/clone-start-2/` (gitignored): `walk1.mjs` to `walk6.mjs`, `*.png`.

## Verdict: PARTLY FIXED

The path from address to first run works with no dead end: clone, Import, create, the import review opens at once, the run asks for `npm test`, Review, Allow, the next run does not ask. Cloning, cancelling, Esc and reopening are handled well. Two things hold it back. A failed fork-and-clone can hide its error behind the sticky button row at 1024x640 (H1). And the "agents ignore this folder's settings" story is told in one sentence in three places, never connected to the permission card that results from it, and the notice lives only on the New run page (M1, M2).

## Pre-walk findings

| Item | Status | Evidence |
| --- | --- | --- |
| M1 submit below the fold | Mostly fixed | Create and the clone button are sticky and in view at both sizes. After a clone at 1024x640 the setup choice starts at y 769 of 640 (see M3 below). |
| M2 pasted address in Existing code | Not driven | I did not paste into Existing code. |
| M3 close throws the clone away | Fixed for clones | Esc during a clone asks "Stop cloning?" (Keep cloning is focused, Esc keeps cloning, Stop and close removes the folder and returns focus to New project). Esc after a clone closes without asking; reopening shows "You cloned X to <path>. It is still there. Use the folder you cloned", which restores the finished result and moves focus to it. `ok-reopen-after-clone.png`, `ok-use-cloned.png`. |
| M4 first launch below the fold | Open | At 1024x640 the Repository field is below the fold once From GitHub is picked on the first-launch inline form (`gh-empty-1024-dark.png`, kind cards and welcome band above it). |
| M5 setup choice appears and jumps | Fixed | Focus lands on the "Cloned to ..." line and the polite status says "Cloned. Found 1 Claude Code agent and AGENTS.md. Choose how the team starts." |
| L1, L2, L3 | Open, not re-checked in detail | The segment group name is still not visible. |

## Findings

### H1. At 1024x640 a failed fork-and-clone hides its error behind the sticky action row
- Screen: inline New project form, From GitHub, Fork mode. Shots: `err-1024-dark-fork.png`, `fail-fork-clone-fails.png`, `fcf-error.png` (1424x855 window).
- Steps: launch with no projects, size 1024x640, New project form, Code project, From GitHub, pick "Fork to my GitHub account, then clone", Repository `mock-org/fork-clone-fails`, a Save in folder, click "Fork and clone".
- Seen: nothing visible happens after a moment. The error element exists and has focus, but at y 531-549 of 640 the topmost element at its centre is the sticky "Fork and clone" row (measured with `elementFromPoint`; same in light, 556-574). In Clone mode the error sits above the button and is visible (`err-1024-dark-clone.png`). At 1600x1000 it is visible. The text hidden is the important part: "Could not reach github.com... The fork exists at https://github.com/mock-user/fork-clone-fails." A user who was told the fork was created on their account sees no sign of it.
- Fix: put the failure and cancelled lines inside the sticky block above the button (or reserve scroll padding equal to the sticky rows' height so focus scrolls clear of them).
- Not measured: the same state inside the dialog (needs a project; the dialog scrolls itself).

### M1. The notice and the review say what, not why or what Allow means
- Screens: New run notice (`notice-1024-dark.png`, `notice-1600-light.png`), Settings > Permissions (`settings-trust-1024-light.png`), review dialog (`review-1024-dark.png`, `review-1600-light.png`).
- Seen, in order: clone form "Agents won't use these settings until you allow them in the project's Settings."; notice "Agents are ignoring this folder's own settings." with Review and Dismiss; Settings row "This folder's own agent settings ... Review". Only the dialog says why: "Some of them run commands on your computer. Agents ignore them until you allow them." That is honest and not alarming, but a newcomer meets three terse lines first.
- The dialog lists one permission rule (`Bash(npm test:*)`), which is clear. What `.mcp.json` and `.claude/agents/...` would add (tools, helpers) is only visible through "Show text". The list also includes OrgAI's own `.orgai/team.json` and `.orgai/agents/*.md` as "this folder's settings", which reads as foreign files the user never made. "Checked for changes" and "Not checked: ... they can change while you trust this folder" is jargon and slightly alarming; it does not say what happens on a change (the e2e covers the "changed" state; I did not drive it).
- After Allow the dialog still says "Permission rules it would add" (wrong tense); it does announce "Allowed. Agents use this folder's own settings from the next run." and the button becomes "Stop using these settings".
- Fix: one sentence in the notice ("This repository came with rules that can run commands. Until you allow them, agents ask before each command."), a one-line summary per file group in the dialog (rules / tools / helper agents / instructions), group OrgAI's own `.orgai` files as "Team files", say what a change does.

### M2. The notice is easy to miss, and the run that follows gives no link back
- Steps: clone `mock-org/with-agents`, Create (Import or default). The project opens on the Team tab (with the import dialog first), not Live. Go to Live: the notice is there, above the composer, and the composer has focus. Start a run with `[mock:folder-config]`: the notice is gone with the New run page, the Needs-you card says only "Run npm test ... Always allow for project: Bash(npm test:*)" (`run1-card-1024-dark.png`). The folder's own file already allowed `npm test`; nothing on the card or the run says so.
- User experience: the likeliest moment to understand and act is the card, and it carries no mention of the folder settings or a Review link. After the run ends the notice is back on the next New run page (seen), so it is findable, but only there; the Dashboard tile and the project row carry no mark.
- Fix: on a permission card for a gated project, one line "This folder's own settings would have allowed this. Review them" linking to the dialog; consider a quiet mark on the project row.

### M3. After a clone at 1024x640 the setup choice is below the fold while Create is in view
- Steps: first-launch inline form, 1024x640, clone `mock-org/with-agents`. `gh-cloned-1024-dark.png`: cloned line, then the config lines cut by the sticky Create row. The "How should the team start?" radios start at y 769 of 640 (measured; at 1600x1000 they end at 951 and fit). A user can press "Create project and review import" without ever seeing the three choices. Focus is on the cloned line, so scrolling is manual.
- Fix: after the clone move the scroll so the choice is in view, or show the choice above the config detail.

### M4. Import's default for one agent is "Replace the chart"
- Steps: as above, Import, Create. `import-dialog-1024-dark.png`: "Replace the chart" selected, "Replaces your 4 roles with these 1", warning "No orchestrator was found among the imported agents", button "Replace chart with 1 role". The dialog is older than this feature but this flow sends every user with agents through it. "Add to the chart" is the safe default for a newcomer.

### M5. Settings copy glitch
- `settings-trust-1024-light.png`: "None yet. Approval cards add them here.. This folder's own settings are not allowed yet." Double period, and the second sentence is appended to the saved-rules row rather than pointing at the row below it.

### L1. gh missing: "Install the GitHub CLI from cli.github.com" is plain text, not a link or copyable. Check again is present and focusable. `missing-panel-1600-dark.png`.
### L2. Review dialog keyboard: opens with focus on the dialog, then nine "Show text" stops before Allow. Esc returns focus to Review (good). Allow keeps focus in the dialog and the live region speaks.
### L3. A `gitlab.com` URL shows no parse error (clone not tried). Mock may differ from real here.

## What worked (seen)
- Clone: parse errors are plain; the Clone button is inert with a reason; live "Will clone into" line; success line names the path and says closing keeps the folder; Cloned status announced; Found line and radio group appear; fork preview names the account, the new repo, public, upstream.
- Failures read in plain words and move focus to the message (missing: "was not found, or this account has no access"; private: "Git could not sign in..."; no-fork and own repo: "Clone it instead"). Cancel removes the folder and says so, and for a fork says the fork exists.
- gh missing and logged-out: Fork stays visible, inert, reason via `aria-describedby`, arrow keys focus it without selecting, plain Clone still works. Logged-out shows `gh auth login` with a copy button.
- Both themes and both sizes: trust notice, Settings row and dialog were legible and unclipped; the dialog body scrolls (1132 px of content in 490 / 850).

## Not driven
- Check again after the state changes (the mock reads `ORGAI_MOCK_GH` at launch); a real gh, git missing, a real network clone, the native Browse picker.
- The "changed since you allowed" state, Stop using these settings, the "Not used" rules group (covered by `e2e/folder-trust.mjs`, not re-walked); the engagement kind; Existing code URL bridge; screen reader output; macOS and Linux; the System theme.
- The run text "Folder config ignored." and "loaded." comes from the mock marker only; the real run has no such line.
