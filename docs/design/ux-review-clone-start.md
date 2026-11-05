# UX review: New project form, before "start from a GitHub repository"

Reviewer: UX Researcher. Build: 1ecb3c9 (`npm run build`). Run: `ORGAI_MOCK=1`, throwaway data dir, playwright driver on `e2e/lib.mjs`.
Sizes 1024x640 and 1600x1000 (`setContentSize`), dark and light (`data-theme`), mouse pass at all four, keyboard pass at 1024x640 dark.
Both entry points were walked: the inline form on first launch and the dialog opened from "New project" once a project exists.
Compared with: no spec (the feature is not built). This is a walk of what exists plus recommendations.
Shots and scripts: `e2e/shots/ux/clone-start/` (gitignored): `walk.mjs`, `walk2.mjs`, `results.json`, `results2.json`, `dialog-<w>-<theme>-existing-{empty,plain,agents,url}.png`, `inline-...` same set, `first-launch-*.png`, `kbd-*.png`.

## Verdict

The form is sound but already tight. At 1024x640 the dialog scrolls inside itself in every Existing code state and the submit row is below the fold. A GitHub mode adds fields and a long-running step, so the layout and the "close the form" behaviour need two small fixes first. Recommendation: a third segment "From GitHub", clone as an explicit step with progress and Cancel (option a), parent folder plus derived name for the destination, fork as a visible second choice that names the account it writes to.

## Answers

### 1. Entry point and fit at 1024x640

- Recommend a third segment: `New idea | Existing code | From GitHub`. It is the only option that is visible to a first-time user without reading hints, and it adds no vertical space (the segmented control is about 175 px wide of an 676 px column, so three labels fit). The fields already change per segment, so a third field set is consistent with how the form works.
- Not recommended: a field under Existing code. The sub-choice ("This computer / GitHub") adds a row of roughly 40 to 60 px (estimate, not built) to the state that already overflows. The other idea, accepting a URL in "Repository folder", is not discoverable: the label says folder and a pasted URL is refused today (M2).
- Keep the pasted-URL case as a bridge, not the entry: when the folder field holds something that looks like a repository address, say "This looks like a GitHub repository. Clone it instead" and switch the segment on click.
- Fit: measured today, see M1. A From GitHub panel before cloning has no brief and no setup choice (they need the files), so it should be about as tall as Existing code with a plain folder (estimate). Show the setup choice only after the clone, which grows the panel at the moment the user is waiting for it; the sticky footer in M1 prevents the submit from moving.

### 2. One step or two: recommend (a), clone first

- (a) Clone is a button inside the From GitHub panel with progress and Cancel. On success the panel shows "Cloned to <path>" in place of the clone controls and the form's normal tail appears (name, setup choice, submit), fed by the same `checkPath` as Existing code, so "Found 1 Claude Code agent" and the Import option work unchanged. Submit stays inert with the reason "Clone the repository first." until then.
- Why not (b): the setup choice cannot be shown honestly before the files exist (it would be Architect/default only, hiding Import), and every clone failure (not found, private, no sign-in, folder exists, no network) would happen behind a Create button that already looks final. With (a) no project exists until the clone has worked.
- Do not flip the segment to Existing code by itself after the clone: a control that moves under the user is hard to follow with a keyboard or screen reader. Stay on From GitHub, announce "Cloned. Choose how the team starts." through a polite region and move focus to the Name field or the setup legend.
- Abandoning: Cancel during the clone stops git and removes the partial folder, but only a folder this clone created (never a pre-existing one, and refuse a non-empty target up front). After a finished clone, closing the form leaves the folder on disk and creates no project. Say so on the success line ("Closing this form keeps the folder") and, when the form is reopened, offer "Use the folder you cloned" (the form keeps nothing today, see M3). Esc and the dialog close button must not close silently while a clone runs: ask "Stop cloning?" or keep it running with a visible state.

### 3. Clone vs Fork

- Two native radios under the repository field: "Clone it" (default) and "Fork to my GitHub account, then clone". The submit of the step changes its label with the choice ("Clone" / "Fork and clone"), so the write to GitHub is never behind a generic word.
- Before a fork the user must see, next to the radio, in plain words: which account ("Creates github.com/<login>/<repo> on your account"), that a public repo makes a public fork, that the clone will point at their fork and keep the original as `upstream`, and that nothing is deleted if they stop. The login comes from the CLI, so show "Signed in as <login>".
- GitHub CLI missing or logged out: Clone of a public repo can still work through git, so say that. Keep "Fork" visible but inert (focusable, aria-disabled, reason announced), the pattern the submit button already uses. Missing: "Forking needs the GitHub CLI (gh). Install it, then check again" with a "Check again" button. Logged out: "Sign in to GitHub to fork. Run `gh auth login`, then check again." with a copyable command. Private repo without sign-in is a separate message ("This repository is private or does not exist").
- Watch for two different "GitHub sign-ins": Connectors has a GitHub entry (MCP sign-in) that is unrelated to `gh`. The copy must say "GitHub CLI" so users do not conclude they are already signed in.
- Not driven: none of these states exist, I could only read the existing connection line pattern (`Runs on X. Change/Connect`, which parks the draft while the user visits App settings).

### 4. Destination: parent folder plus derived name

- Today the folder field is one full path. Relative paths are refused with "Use a full path, for example C:\Projects\shop" (seen), Existing code requires the folder to exist ("No folder at this path.", seen at `C:\nope\missing`), and New idea says "An empty folder is best. It is created if it does not exist."
- For clone, recommend "Save in" (parent folder, Browse, last parent remembered) plus a live line "Will clone into C:\Users\you\Projects\hello-world" and an editable "Folder name" defaulting to the repo name. A full path would make the user type the repo name twice and invites cloning into a non-empty folder.
- States to show: the target already exists and is non-empty (blocking, plain words, never overwrite); it exists and is a clone of the same repository (offer "Use it", which skips the clone); parent missing (offer to create it, as New idea does). Windows long-path and invalid-character names need a message of their own.
- The project Name field already falls back to the folder name (`effectiveName`), so keep it blank by default.

## Findings

### M1. At 1024x640 the dialog's submit row is below the fold in every Existing code state
- Screen: New project dialog, code, Existing code. Shots: `dialog-1024-dark-existing-plain.png`, `dialog-1024-light-existing-agents.png`.
- Steps: open ORGAI_MOCK app, resize to 1024x640, New project, Code project, Existing code, type a folder path.
- Seen: the body scrolls inside the dialog. Content height 629 (no folder), 674 (git repo found plus "already a project" line), 648 (agents found) against a visible 550. The Create button and the mock checkbox are off screen; the scrollbar is the only hint. Keyboard focus scrolls them in (`kbd-submit-focus.png`). At 1600x1000 there is no scroll (form 613 to 658 px high, submit bottom at 827 to 849 of 1000).
- Why it matters: a From GitHub mode adds a method choice, progress and a result line. A first-time user will not find the button.
- Fix: make the submit row a sticky footer of the dialog body (outside the scroller), or shorten the two project-kind cards (they use about 120 px of descriptive text) once a kind is chosen.

### M2. Pasting a GitHub address into "Repository folder" is a dead end with contradictory text
- Shot: `dialog-1024-dark-existing-url.png`. Steps: Existing code, type `git@github.com:octocat/hello-world.git`.
- Seen: red "Use a full path, for example C:\Projects\shop", Create inert, and underneath the hint still says "The Architect scans it and reads the code before proposing anything." Nothing says a clone is possible. People who have a repo URL on the clipboard will paste it here first.
- Fix: recognise URL and owner/repo in this field and offer the clone (see Answer 1). Replace the hint under an error state.

### M3. Closing the form throws everything away without a word
- Steps: 1024x640, Code, Existing code, type a path, Esc. Result: dialog closes, focus returns to "New project" (good), reopening shows an empty path and the Code radio focused (`results2.json`). Only the Connection link parks a draft (`parkedDraft`, session memory).
- Today it costs a typed path. With the feature it could cost a running or finished clone. See Answer 2.
- Fix: confirm or block close while cloning; remember the cloned folder for the session and offer it again.

### M4. First-launch inline form is below the fold at 1024x640
- Shot: `inline-1024-dark-existing-agents.png`. The Dashboard scrolls (content 935 to 958 against 592). The choices above (Welcome, Start a project / Chat now, kind cards) push the folder field to the bottom half and the submit out of sight. First-timers are the ones who will use clone most. Fix as in M1, or collapse the kind cards to one line after a pick.

### M5. The setup choice appears and changes the layout after a debounced check
- Seen: the one-line Architect checkbox turns into a four-line radio group when agents are found (`dialog-1024-light-existing-agents.png`), and the hint under the folder field changes. After a clone the same jump happens while the user is looking at the progress. Fix: reserve the space, or announce it (the checkbox-to-radio swap is not announced today, observed by reading the markup, not with a screen reader).

### L1. Field order differs between modes
New idea puts Name first, Existing code puts the folder first and Name after it with the placeholder "Defaults to the folder name". For clone put the repo first, destination second, name last, as Existing does.

### L2. The segmented control's group name ("Project type") is not visible, and "Existing code" does not say it means a folder on this computer
First-timers have to infer it from the field label below. A third segment makes this more important.

### L3. Mock-only: "Use the mock adapter" checkbox and "Runs on the mock adapter (no tokens)" line use up vertical space and are part of the overflow in M1
Not present in a real build; the real height is a little smaller. The real connection line is shorter than it looks here (not driven).

## Keyboard pass (1024x640, dark, dialog)
- Open: Enter on "New project" lands on the checked kind radio (good). Arrow keys change the kind. Tab goes to the segmented control as one stop (`New idea`), Arrow moves between segments and changes the fields (good), then folder, Browse, Name, brief, Architect checkbox, mock checkbox, Create, Cancel, Close, and wraps to the dialog start (focus is trapped).
- An inert Create is focusable and its reason is in `aria-describedby` and in the row hint: good. Focus ring visible on every stop in dark. A third segment keeps this order.
- Esc closes and returns focus to the opener (good, but see M3).

## Both themes
Layout and heights were identical in dark and light at each size (numbers in `results.json`). Contrast of hints, errors, warn and ok lines looked fine in the shots I opened (dark 1024 plain and url, light 1024 agents, light 1600 agents); the other shots were captured but not each opened.

## Not driven
- The feature itself, GitHub CLI states, fork, network, progress, cancel and partial-folder cleanup: nothing exists to drive.
- The native Browse picker; screen reader output; macOS and Linux; the System theme; a real (non-mock) connection line; a repo with only an AGENTS.md or template list present (the template select was not shown here, the mock data had none).
