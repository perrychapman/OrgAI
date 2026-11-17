# UX review: desktop updater (App settings > About > Updates, sidebar notice, Help > Check for Updates…)

Walked on the mock adapter (`ORGAI_MOCK=1`, throwaway data dir) from the UI lead's worktree `agent-a175fc53f1356d5aa`, one launch per `ORGAI_UPDATE_MOCK` mode: available, download-error, manual, error, up-to-date. Playwright `_electron`, `shell.openExternal` stubbed. 1024x640 and 1600x1000, dark and light, one keyboard pass. Screenshots: `e2e/shots/ux/` (names `<mode>-<state>.png`, `notice-*.png`). Scripts were kept outside the repo; no code edited.

Overall: the flow is clear. One primary action per state, plain status sentences, a confirmation that names the run count, quiet notice, correct focus handling. Findings below are polish, none blocks use.

## High

None.

## Medium

### M1. A failed download hides that it was the download that failed
- Where: About > Updates, mode `download-error`. Shot: `download-error-failed-1024-light.png`.
- Saw: after Download update fails the status becomes "OrgAI could not reach GitHub. Check your connection and try again." The "Version 99.0.0 is available" sentence is gone; only the release notes heading "What's new in 99.0.0" and the button "Retry download" say what is going on. The same sentence is shown for a failed check (mode `error`), so the two failures read identically.
- Repro: launch with `ORGAI_UPDATE_MOCK=download-error`, About > Check for updates > Download update, wait about 6 s.
- Suggest: keep the version in the line and say what failed. "Could not download version 99.0.0. OrgAI could not reach GitHub. Check your connection, then choose Retry download." For a failed check: "Could not check for updates. OrgAI could not reach GitHub. Check your connection, then choose Check again."

### M2. Manual mode explains the limit vaguely
- Where: About > Updates, mode `manual`. Shot: `manual-result-1600-light.png`.
- Saw: "OrgAI cannot install updates itself on this system yet. Download new versions from the release page." A first-time user does not learn why (unsigned build, portable copy, macOS), whether it will change, or what to do with the downloaded file. "Open release page" opens the browser with no feedback in the app (opened URL confirmed as `.../releases/tag/v99.0.0`). The line shows even before any check, where it sits under "Not checked yet." and reads as an error.
- Suggest: "This copy of OrgAI updates by hand. Open the release page, download the new version, and install it over this one. Your projects and settings are kept." Button stays "Open release page"; add a short note after click: "Opened in your browser." Show the capability line only once an update exists, or as quiet helper text under the heading.

### M3. Updates sits below the fold at 1024x640 when reached by the gear
- Where: App settings > About at 1024x640 (all shots `*-1024-*`). The About details card fills the first screen; the Updates heading starts at y 430 and its action at about 570 or lower, so "Check for updates" is hidden until the user scrolls. Help > Check for Updates… and the notice scroll to it correctly (heading focused).
- Suggest: put Updates first on the About page, or give About a one-line in-card status ("Up to date" / "Update available" with a link that jumps to Updates). Also consider a pane tab name that says it: "About and updates".

## Low

### L1. The status sentence is announced or rendered twice
- The text dump of the block ends with the status again ("... Version 99.0.0 is available." after the switch). This is the polite live region (`updates-announce`) and is fine for screen readers, but confirm it is visually hidden at every size (it was not visible in any screenshot). Verified only through text, not a screen reader.

### L2. "Downloading always waits for you" is awkward
- Where: the automatic-check switch description. "Checks about 30 seconds after launch, then every six hours. Downloading always waits for you; a downloaded update installs when you restart from here or the next time OrgAI quits."
- Suggest: "OrgAI checks shortly after launch and every six hours. It never downloads without you asking. A downloaded update installs when you choose Restart and install, or the next time you quit OrgAI." Also the switch name could say "Check for updates automatically" with the visible state word "On / Off".

### L3. "Last checked" is shown after a failed check
- Error and download-error states show "Last checked 17 Nov 2026 08:46" for a check that failed. Suggest "Last attempt" when the last result was an error, or hide it.

### L4. Download progress was not captured visually
- The progress bar appeared at 85 % after 600 ms and finished by 6 s; I read "Downloading version 99.0.0: 85%." and the action "Downloading…", but did not screenshot a mid-progress frame cleanly (`available-downloading.png` is the nearest). Mock progress is fast; a real download is not exercised.

### L5. Dismiss X is faint in the light theme
- Where: sidebar notice, light, 1600x1000 (`notice-1600-light-available.png`). The close X is much lighter than the purple notice text and about 14 px. Focus ring is clear in dark (`notice-1024-focus-dismiss.png`). Suggest the same contrast as the text and a 24 px hit area; the accessible name "Dismiss Update available: 99.0.0" is good.

### L6. Dismiss removes the notice with no hint where updates went
- After Dismiss the notice is gone and focus lands on App settings (good). A first-time user gets no hint that updates remain in App settings > About. Suggest the dismiss tooltip: "Hide this until the next version. Updates stay in App settings > About."

### L7. Sidebar rail notice is an icon only
- At 1024x640 the sidebar starts collapsed to a rail; the notice is a circle-up-arrow icon above the status dot (`available-notice-on-project-1024-dark.png`). It does not take space from the run view or interrupt the permission card, which is good. I did not read its accessible name or tooltip; recommend "Update available: 99.0.0. Open App settings > About".

## What worked (keep)
- Help > Check for Updates… from a run view lands on About with the "Updates" heading focused (`H3#appsettings-updates-title`), also the second time while installing.
- Status lines: "Not checked yet." / "Version 99.0.0 is available." / "Downloading version 99.0.0: 85%." / "Version 99.0.0 is ready. Restart to install it now, or it installs the next time OrgAI quits." / "OrgAI 0.1.8-dev1 is up to date." Each has one primary button: Check for updates, Download update, Downloading… (inert), Restart and install, Retry download, Check again, Open release page.
- Restart and install with a live run: dialog "Stop runs and install the update? Installing restarts OrgAI and stops 1 working run. They stay in History and can be continued, as after Quit." Buttons "Not now" (default focus) and "Stop runs and install" (red). Esc closes it, focus returns to the action, and the line "Not installed now. The update installs the next time OrgAI quits, or restart and install later." appears. Confirm leads to "Restarting to install version 99.0.0…" with an inert "Restarting…".
- Keyboard: Tab order in the block is action, Open release page, release notes (scrollable region, focusable), switch, then out to "Skip to content". Space and Enter both start the download. Notice: Tab reaches Open then Dismiss; Enter on Open lands on the Updates heading; Dismiss Enter moves focus to App settings.
- The notice is a quiet line above the footer (231x40 px), not shown on App settings, takes no focus, and did not overlap the run view or permission card at either size or theme. Both themes and both sizes showed no horizontal overflow in the shots.

## Could not verify
- A real download, real install, restart or the portable/unpacked/mac capability reasons; all runs were the mock (`ORGAI_UPDATE_MOCK`), packaged-only behaviour is untested.
- Screen-reader speech for the live region and the rail icon name; the automatic-check switch persisting across a relaunch (not re-tested here; the repo's `e2e/updates.mjs` covers it).
- The notice in a mid-download state and "Update ready" wording in the sidebar (only "Update available" was captured here; `e2e/updates.mjs` checks the ready wording).
- The collapsed rail via an explicit collapse click: the sidebar was already a rail at 1024 and my size changes switched it automatically, so the rail notice was seen but not toggled by hand.

## Resolution (UI lead, 2026-11-17)
- M1 fixed: a failed download reads "Could not download version 99.0.0. <reason>" (`lib/updates.ts` `updateStatusLine`; unit test and `e2e/updates.mjs`).
- M2 fixed: the manual notes now say the copy is "updated by hand" (OrgAI checks, you download from the release page), and Open release page answers "Opened the release page in your browser." (unit test, e2e).
- M3 accepted: About keeps the version facts first; Help > Check for Updates… and the sidebar notice scroll to and focus the Updates heading (e2e).
- L1 not a defect: the second copy is the sr-only polite region (`updates-announce`).
- L2 fixed: "Checks about 30 seconds after launch, then every six hours. Nothing downloads until you choose to. A downloaded update installs when you restart from here or when OrgAI next quits."
- L3 kept: "Last checked" records any finished check, including a failed one (contract: `checkedAt` is any result).
- L5, L6 open (the Dismiss X is the shared `IconButton`; no hint after Dismiss). L7: the rail button's name is "Update available: <v>. Open App settings, About" (code read; speech unverified); the rail has no Dismiss (accepted).
