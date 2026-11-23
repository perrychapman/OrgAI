# UX review: UI/UX overhaul, first-time-user walk

Reviewer: UX Researcher (agent). Build: `05675add` on dev, `npm run build` clean, window sizes set with
`BrowserWindow.setContentSize`.

How it ran: the built app with `ORGAI_MOCK=1` and a throwaway data dir (`%TEMP%\uxwalk-data`, fixtures in
`%TEMP%\uxwalk-fixtures`). Two window sizes (1600x1000, 1024x640), both themes (switched with
`data-theme`, so the Appearance "Colour mode" cards still say Dark), mouse first, then a keyboard pass at 1600x1000 on
Inbox, the sidebar tab order, Permissions and Team. Boards compared: Welcome, NewProject, Main, Inbox, ProjectHome,
EngagementHome, NewRun, Limits, Templates (rendered with `tools/check.cjs`; the board shots are in `boards/`; Main
and Settings would not load in my offscreen renderer, so those were compared by reading the impl notes, not by eye).

Evidence: `e2e/shots/ux/ui-overhaul/*.png` (gitignored; the numbered prefix is the flow: 01 first launch and new
project, 02 sidebar, 03 Home, 04 Inbox, 05 project and engagement Home, 06 New run, 07 Settings, 08 Team,
09 Files / Knowledge / Usage / History / Schedules). Walk scripts sit beside them.

Projects used: `tiny-notes` (git fixture), `plain-folder` (no git), `trust-repo` (clone with folder config),
`Market study` (engagement, 90 knowledge items added by script).

## Verdict: PARTLY WORKS

The shell, Inbox, New run and History are in good shape: the unknown cost wording is right, held Enter answers
nothing, keyboard flows are real and the code project and engagement Home look clearly different. What a new
user will trip on is wording that disagrees with itself (four names for the same permission modes), engagement
screens that still say "client" and "deliverables" against owner decision 6, the Spending limits page showing no
limit at rest, and a handful of leaked or wrong numbers (sample elapsed time, "up from zero" deltas, an Inbox
empty state that says nobody is working while runs are).

## High

### H1. Engagement screens still use client / deliverable vocabulary (owner decision 6)

- Screens: New project > Engagement (`01-newproj-engagement-1600-dark.png`, `05-engagement-form-filled-1600-dark.png`),
  engagement Settings > Basics, the New project dialog from Home (`03-home-newproject-tile-click-1600-dark.png`).
- Repro: Home > New project (or first-launch form) > Engagement. Read the form. Then open the engagement >
  Engagement settings > Basics.
- What I saw: name placeholder "Client or case name"; a field "Client or case (optional)"; "Where the team saves
  deliverables."; brief placeholder "Who the client is, what you deliver, and anything the team must not touch."
  Basics: "Name, client, folder, plan and the provider this engagement uses.", "Client or case", and the knowledge
  hint "meeting notes, client preferences, terms". The right-hand "The team" card on New project says "the Architect
  looks at the code" for an engagement too.
- Board: NewProject / EngagementHome keep the neutral wording (no client, sponsor, deliverable). Engagement Home
  itself passed a scan: all eight engagement tabs are clean, only the form and Settings leak.
- Likely files: `components/dashboard/NewProjectForm.tsx` (engagement branch and the aside), the engagement Basics
  section in `components/settings/` (ProjectGeneral).
- Recommended copy: Name placeholder "Name this engagement". Replace "Client or case (optional)" with "Who or what it is for
  (optional)". "Where the team saves what it writes." Brief placeholder "What this is for, who it is for, and
  anything the team must not touch. The setup interview asks about the rest." Basics: "Name, who it is for, folder
  and the provider this engagement uses." Knowledge hint: "background the team can look up when it needs it:
  meeting notes, preferences, terms." Aside for engagements: "Once you pick a folder, the Architect reads what is
  in it and proposes roles. Nothing is created until you approve."

### H2. The Spending limits page shows no limit at rest on a subscription sign-in

- Screen: project Settings > Spending limits (`07-set-project-limits-1600-dark.png`).
- Repro: any project on the mock connection > Project settings > Spending limits.
- What I saw: a spend card ("$0.05581 in November"), a plan guard line, two selects (subagent depth and
  concurrency). No day cap, no month cap, no "Warn me at", no "most agents in one run". They exist, but only
  after opening "Advanced settings" (`07-limits-advanced-1600-dark.png`: "Per day and per month", "Warn me at",
  "Limit how many agents one run starts"). A page called Spending limits that holds no limit input looks like a
  page without limits. impl-settings.md records this as a deviation for subscription sign-ins, so it is by design,
  but a first-time user will not find it.
- Board: Limits shows one run, one day, one month, "When a limit is reached", "Warn me at" and "Most agents in one
  run" at rest.
- Likely file: `components/settings/LimitsSection.tsx` (`PERIOD_CAPS_LIVE` and the at-rest tab-stop budget).
- Recommended fix: keep the budget but add one visible row at rest: "Day and month limits" with the current values
  or "No limit set" and a "Set limits" button that opens the Advanced block. Rename the hero "Spent in November" and
  format money to two or three decimals ("$0.06"), not "$0.05581".

### H3. Four different names for the same permission modes

- Screens: first launch step 3, Home task box chip, New run "Asking you", project Permissions
  (`01-welcome-3-1024-dark.png`, `03-home-1600-dark.png`, `06-newrun-from-home-1600-dark.png`,
  `07-perm-arrow-preview-1600-dark.png`).
- What I saw for one and the same mode: setup "Go ahead within the rules"; Home chip "Unattended, asks when
  unsure"; New run "Unattended"; Permissions card title "Work on its own" with sub-label "Unattended"; App
  Settings > General lists "Unattended / Auto-accept edits / Ask for everything risky / Never ask / Plan only /
  Bypass all prompts". The strictest mode is "Ask about everything" (setup), "Ask before every change" /
  "Ask for everything risky" (Permissions, two names on one card), the bypass mode is "Bypass all prompts" in the
  list and "Skip all checks" on the card and in the confirmation. The engagement New run chip says "Ask for
  everything risky", the engagement Home "asks before risky actions", the code Home "works on its own and asks when
  unsure".
- Why it matters: this is the one setting that changes what an agent may do. A user cannot tell the setup choice
  "Ask before risky actions" is the same thing as "Edit freely, ask for commands".
- Board: README decision 8 ("Ask before risky actions", plain language everywhere).
- Likely files: `lib/permissionModes` copy, `components/settings/PermissionsSection.tsx`, `NewRunPage.tsx`,
  `components/dashboard/HomeTask*`, `FirstLaunch.tsx`.
- Recommended copy (one set, used everywhere, title only, with the engine name only in a tooltip):
  "Ask about everything" / "Ask before risky actions" / "Go ahead within the rules" / "Plan only, change nothing" /
  "Skip all checks". Remove the second line on the cards and the "Unattended" word from the UI.

## Medium

### M1. The first-run default is the least cautious mode and the setup step does not say so

`01-welcome-3-1024-dark.png`: step 3 opens with "Go ahead within the rules" ("Fewest questions") selected, while
the page text says "Whatever you pick, a team never leaves the folders you gave it". For a first-time user the
safe middle choice ("Ask before risky actions") should lead, or the default should be labelled "Recommended".
At 1024x640 the Back and "Open OrgAI" buttons sit on the bottom edge and are half cut off until you scroll
(same shot): the greeting hero takes a third of the height.

### M2. Home "Start run" does not start a run

Home > type a task > "Start run" opens the New run page of the first project, prefilled
(`06-newrun-from-home-1600-dark.png`), with focus in the task box. The button name promises a run; the page asks
again with a second "Start run". The chosen scope and permission chips from Home are not shown as carried over
(the New run page says "Asking you: Unattended, from this project's settings"). Recommended copy: Home button
"Review and start", helper line under the box "Opens New run with this message so you can check the team, model and
limit before it goes." (the Project Home already says this; Home does not). The default project in the target
menu is whichever opens first, not the one you last used (plain-folder in one launch, tiny-notes in the next).

### M3. "Save as a schedule instead" silently drops the choices made on New run

`06-save-as-schedule-filled-1600-dark.png`: I typed a task, left Reviewer out and set a $0.25 limit, then clicked
Save as a schedule. The New schedule dialog carries only the text (as both Name and What to do); the limit says "No
cap of its own", permission "The project's mode", no role selection. Recommended: carry the limit and permission
over, and say what is not kept: "Schedules always use the whole team. Reviewer is not left out here." Use a short
name ("Check dependencies") and not the whole prompt as the schedule name.

### M4. Inbox empty state says nobody is working when runs are working

`04-inbox-finished-1024-light.png`: after answering the last decision the page says "No teams are working right
now" while the rail shows PF and TN with blue (working) dots. Recommended copy: "Nothing is waiting on you.
Teams that are working will show here when they need a decision." (drop the claim). "0 finished" never changed
during the walk because the mock runs stayed live; the Finished section was not seen.

### M5. J / K do nothing on arrival in the Inbox

Click Inbox in the sidebar: focus stays on the sidebar button, "J K move, Enter go to the main action" is shown,
and J, K and Enter do nothing (Enter re-clicks the nav item) until a row is clicked. Tab order goes through the
whole sidebar (Needs you, Chat, helpers, every project and open run, about 12 stops) before reaching the list.
Recommended: move focus to the selected row when the Inbox opens from the keyboard, or add "Click a row, then J
and K" to the key hint. The skip links exist ("Skip to content", "Skip to sidebar"). Held Enter, tested separately,
did what the brief wants: the first keydown moves focus to Allow once and six repeats answered nothing; a fresh
Enter answered, focus moved to the next row and the live region said "Answered. Next: Edit example.ts,
plain-folder. 2 of 2."

### M6. The permission card repeats itself

`04-inbox-1600-dark.png`: "Always allow for project: stops asking for "npm test" commands in this project." appears
three times (rule line, scope list, button description), plus "Allow once: this call only.", "Allow for session: ...".
Next to the buttons that are named the same, this is read three times by a screen reader. Keep the one line
under the buttons and drop the duplicated rule line. "Starts in worktree agent-x (inside the project)" is
jargon: "Runs in a separate copy of the project".

### M7. Home "Your week" shows unknown prior data as growth from zero

`02-sidebar-narrowest-1600-dark.png` (full Home): "Spend $0.14 ▲ $0.14 vs the 7 days before", "Runs 23 ▲ 23",
"Decisions 26 ▲ 26" when there are no earlier runs. Usage correctly says "no prior data" for the same numbers.
Recommended: "No earlier week to compare" with no arrow, as Usage does. The 14-day heat map said "No runs in 14 days · No
runs started today yet" while three runs had just started and were waiting (`03-home-bottom-1600-dark.png`); it
counted 23 runs after they ended. Count started runs, not finished ones.

### M8. Estimated elapsed time of "26512h 14m" in the Appearance canvas preview

Settings > Appearance > Graph styles thumbnail, and the Canvas card row (`07-set-app-appearance-1600-dark.png`
text dump, `07-appearance-canvas-1600-dark.png`): the sample agents show "26512h 14m" (time since the epoch, a
missing start time shown as a number). Tiny in the picture but it is in the DOM and read aloud. Fix the sample
data, and never format a missing start as a duration.

### M9. Team toolbar loses its labels at 1024x640 and the canvas shrinks to about 600x330

`08-team-1024-light.png`, `08-team-role-1024-dark.png`: Add group, Import, Theme, Layout and Start from turn into six
unlabelled icons (a coloured square for Theme, a document icon for "Team files: not committed"). The Team assistant
dock and the hint bar take 40% of the height, so with the role panel open the chart is small and zoom drops to 60%.
Recommended: keep the text of Import and Add role and put the rest in a "More" menu below 1100 px, collapse the
assistant to one row until it is clicked.

### M10. Tools and services: the "The team could / could not" panel is out of sight at 1024x640

`07-tools-detail-1024-light.png`: select Exa. At 1600 the detail panel appears right of the grid
(`07-tools-detail-1600-light.png`, good, but its last line "Not sure what you need? Ask the Tools helper" runs
under a horizontal scrollbar). At 1024 nothing visible happens on selection; the panel is not in the viewport
(I did not scroll to find where it went). Recommended: open it as a side sheet over the grid at narrow widths.

### M11. Try again and Run it again sit side by side on a failed run

`09-history-try-again-1600-dark.png`: the detail pane offers "Open the run", "Run it again", "Try again" and
"Continue from here". The two "again" buttons differ (a new run vs continuing the failed one, which spends
tokens); only a long paragraph says which. Recommended labels: "Start a new run with this message" and "Retry this
run (continues it)". The confirmation card for Try again is good ("Nothing is sent until you confirm.").
A failed run shows cost "—" (unknown, correct).

### M12. Empty Engagement Home leaves a hole and no first step

`05-home-eng-1600-dark.png` vs board EngagementHome: with no runs the "Waiting on you" and "Recent work" panels are
absent, so the right-hand cards (What the team knows, Connections, Folders, The team) float under the task box at
the far right with a large empty area on the left. The "Add a description" empty state is fine. Recommended: show a
dashed placeholder where Recent work goes: "Work you start shows up here."

## Low

- L1. First launch: step 1 ("Connect an AI") has nothing to choose on the mock adapter (only a note); the real
  provider choice could not be seen. The right-hand "The team" card still says "the Architect looks at the code"
  while Work that is not code is chosen on step 2 (`01-welcome-2-1600-dark.png`).
- L2. Setup choice: the Architect interview is checked by default and recommended in both kinds (good). The native
  round radios in the fieldset look different from the card radios above (blue native in light mode,
  `01-newproj-code-1600-light.png`), and the sticky submit row covers the second radio until you scroll.
- L3. Sidebar at its narrowest (200 px): "MOCK" shows as "MO", the search box says "Search or jump tc", "Ctrl K"
  is cramped (`02-sidebar-narrowest-1600-dark.png`). The MOCK and Dev chips are dev-build only; the clipped search
  hint is not. At 1024 the sidebar auto-collapses to a rail with unlabelled grey dots on Chat and the two helpers.
- L4. Run titles: "/notes/:id" becomes "notesid" ("Add a DELETE notesid"), and the mock marker shows raw
  ("Mockfatigue Run the tests"). Likely `lib/runTitle`.
- L5. Cost precision is uneven: "$0.007155", "$0.01001", "$0.00573", "$0.05581" in History and the Limits hero,
  "<$0.01" on New run, "$0.14" on Usage. Pick two decimals (three under a cent).
- L6. Estimate sentence: "From your last 8 similar runs, including runs with other roles left out, as too few match
  yours." reads badly. "Based on your last 8 runs. Too few matched this team, so runs with other roles left out are
  included." The New run "Or pick up from" list shows three rows with the same title and an "Earlier" badge.
- L7. Settings > General: "Used for the greeting on the Dashboard" (the page is now Home). "Keep running / Quit"
  segmented control does not make the current choice obvious.
- L8. Templates: the section sentence "Teams you saved from a project" sits above the two built-in cards; the detail
  panel hangs past the content column at 1600 (`07-set-app-kit-1600-light.png`); card descriptions truncate with
  "a...".
- L9. Import agents dialog: the empty state lists nine folder names ("Searched .claude/agents, .opencode/agents ...").
  Recommended: "No agent files found in this folder. OrgAI looks for Claude Code, OpenCode, Codex and similar
  agent folders." Duplicate gives clear feedback ("Added Implementer copy ... Undo", good).
- L10. Files at 1024: the search box has an empty icon slot, the "All runs" select and chips wrap onto three lines
  (`09-files-1024-dark.png`). The empty-state icon is the org chart glyph.
- L11. The sidebar groups Engagements (with a count and a fold) above Code (no count, no fold). Engagement project tile
  on Home shows two bare numbers ("0" and "90") with unexplained icons.
- L12. Schedules: a schedule created at 09:14 lists today's 09:00 slot as part of "This week" without marking it
  past. Settings > Engagement shows "Maintenance" where code projects show "Branches".

## What works well

- Welcome: three steps with a visible "done" check, Skip and Back both work, Back keeps the earlier choice; copy is
  plain ("Nothing is created until you approve").
- The two project kinds look separate: violet, monospaced "Code project" next to a serif coral "Engagement" card,
  the engagement form and Home carry through; sidebar groups them.
- New run: "Likely cost / Likely time: Unknown" with "Not enough finished runs of this kind with a known cost to
  estimate yet." on a project with no history, "Type a message to enable Start" hint, per-run limit message "The
  run pauses and asks at $0.25.", leaving a role out recalculates the estimate.
- Inbox: three-pane flow, J/K, Enter then Enter, Escape back, live-region announcement of the next item, held
  Enter answers nothing, "Answer in order", project filter, focus ring visible (2 px solid).
- Command palette (Ctrl+K): open runs first, then pages; Esc closes, arrow keys and Enter hint shown.
- Permissions: arrow keys preview ("What would happen with ... (not saved)"), Enter saves ("Saved 09:07 AM" in
  the header), the bypass confirmation names the folder and defaults focus to "Keep the current mode".
- History: Running now | All runs switch, "Run it again" really opens New run prefilled (verified, text matched),
  "Try again" asks first.
- Schedules and Usage show unknown as unknown ("Weekly cost unknown", "no prior data", "—").
- Knowledge: "Showing the 60 most connected of 90 · Show all" appears and works.
- Home inline decisions ("Allow once / Deny"), project tiles with the dashed New project tile (below the fold, opens the
  dialog), Customise with Reset layout.
- Both themes: glass panels in light mode keep a visible edge in every screen I shot; no horizontal page overflow
  seen at 1024x640 (inner scroll only).

## Not driven

- First launch step 1 with a real provider list (mock adapter shows a note only), sign-in flows, Bypass saved
  (confirmed only that the dialog opens and I pressed Escape), banners (update, usage, offline: the mock cannot
  produce them), the Finished section of the Inbox (mock runs stayed live), Delete branch (the fixture had no
  branches to delete, so Branches > "Delete branch" and its confirmation were not seen), Skills Duplicate and
  Export (no skills; I opened New skill but did not save one), last-runs bars on Schedules (no scheduled run
  fired), real File previews, Brand row of the shipping build (the MOCK and Dev chips are dev only), screen reader
  speech, and the live run screen (excluded by the brief).
- Light theme was checked by `data-theme` switching, not through the Appearance control; Match my computer and the
  accent colours were not changed.
- One test oddity not chased: on a brand new profile the lib helper `pickSetup` could not tick the "default" radio in
  the first-launch inline form once (a later run on a second project worked). Not reproduced by hand.
- Engagement Settings was walked for wording only (screens `05-eng-*`).
