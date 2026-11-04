# UX review: application menu re-walk (menu-2)

Reviewer: UX Researcher. Walked 2026-11-03 on dev at 7a7d25e (contains the menu merge 02ae37f), built app
(`npm run build`), ORGAI_MOCK=1, fresh temp ORGAI_DATA_DIR per script, Windows 11 at 100% scaling. Content sizes
1024x640 and 1600x1000, dark and light, the 1024x680 minimum window, and a keyboard pass with real key presses (SendKeys,
only after checking the OrgAI window was the foreground window). Compared with `ux-review-menu.md` (proposed tree,
"When an item does not apply", Implementation notes) and the CLAUDE.md "Application menu" bullets. Items were clicked
with `Menu.getApplicationMenu().getMenuItemById(id).click()`; native popups and the bar were captured from the screen.
Scratch scripts and numbered shots: `e2e/shots/ux/menu2/` (gitignored, not committed): `a-bar.mjs` .. `g-save.mjs`,
shots `01`..`122`, raw results `a.json`..`g.json`. Nothing spent tokens. Interrupt turn and End session were never
clicked on a live run.

## Verdict

MOSTLY FIXED. The bar is there on Windows, follows the app theme in both themes (shots 01, 02, 21-36), every renderer
item I clicked did its job, renderer-owned keys fire once (real Ctrl+T on a live run: one draft; Ctrl+B: one toggle),
navigation from a run window lands in the main window, and the shortcuts dialog works at both sizes with Esc and focus
return. No High findings. What matters most: Go to decision is enabled by a decision anywhere but only acts on the
current project's run, so on the Chat page it says "No decision is waiting on this run." while the bell shows 1 (M1);
several items stay enabled and only announce, against the review's "disable, do not announce" rule (M2); the Ctrl+.
hint in the menu works only on Live (M3); the minimum-window content height is 615 px, not the 654 px CLAUDE.md states
(M4); and App settings counts as "no project", so Ctrl+1..4 are greyed and Ctrl+T says "Open a project first." with a
project open in the sidebar (M5).

## Status of earlier findings (ux-review-menu.md)

| Item | Status | Evidence |
| --- | --- | --- |
| H1 Electron default menu with Reload / devtools / Close Ctrl+W in every build | Fixed (code read for packaged) | Menu dump (a.json): OrgAI tree on win32; the only W accelerator is Close tab; Window > Close window has none. Reload / Force Reload / Toggle Developer Tools appear in this unpackaged build (shot 31) and are gated by `!app.isPackaged` (appMenu.ts); a packaged build was not run. |
| H2 one command path, no double fire | Fixed on Windows | Renderer keys carry `registerAccelerator: false` (dump). Real Ctrl+T on a live run opened exactly one draft; real Ctrl+B toggled once; Ctrl+W on a live run showed the notice and closed nothing (f.json). macOS not run. |
| M1 bar costs 26 px at the minimum window | Open (accepted), and the docs number is wrong | `setSize(1024, 680)` gives content 1008x615 (a.json, d.json), not "about 654 px" as CLAUDE.md says. See M4. |
| M2 shortcuts invisible | Mostly fixed | Help > Keyboard shortcuts lists them from one table (shots 74-77). Menu hints shown for every accelerator. See L6 for gaps. |
| M3 run-window routing | Fixed | With the run window focused, Help > About opened App settings in the main window and focus moved there (c.json "about from run window"). Run items with two windows were not clicked. |
| L1 two kinds of zoom | Partly | Canvas items sit in View > Canvas without accelerators, but View still has "Zoom In" / "Zoom Out" beside Canvas "Zoom in" / "Zoom out" (shots 27, 31). See L3. |
| L2 role labels title case | Open | "Actual Size", "Zoom In", "Toggle Full Screen", "Select All", "Paste and Match Style", "Toggle Developer Tools" (shots 30, 31). |
| L3 End session without accelerator | Fixed | No accelerator on Interrupt turn or End session (shot 32). |
| L4 Esc does not leave App settings | Open | Esc on About leaves App settings open (c.json "Esc on About"). Matters more now, see M5. |
| L5 New run from the menu must go to Live and focus the composer | Fixed | Run > New run from Team switched to Live with focus in the composer (c.json, shot 55). |
| Reviewer L5 Save as project focus | Fixed in what I saw | Run > Save chat as project on a folder chat opens the dialog (shot 122); Esc returns focus to the composer that had it (g.json). |
| Reviewer L6 no column headers in the shortcuts table | Open | 0 column headers (d.json); rows use `th scope=row` only. |
| Question 1 visible bar | Decided: visible | `autoHideMenuBar: false`. |
| Mnemonics (&File ...) proposed | Not done | Alt+V and Alt+R do nothing; Alt then Down opens File (shot 111). See L1. |

## Departures from the proposed tree (seen in the dump and popups)

| Proposed | Landed | Comment |
| --- | --- | --- |
| File > Settings submenu (General, Connections, Connectors, Skill library) | Flat: App settings Ctrl+Comma, Connections, Connectors, Skill library | Better: Connectors is 2 clicks, not 3. |
| File > Open MCP / Skill assistant | File > Assistants > Chat / MCP assistant / Skill assistant | One more level; Chat was not in the proposal. Fine. |
| File > New run Ctrl+T | Run > New run Ctrl+T | Fine; Run is where users look. |
| View > Collapse sidebar (checkbox) | View > Toggle sidebar (plain item) | See L2. |
| View > Canvas > Show conversation / Hide finished agents (checkboxes), Fit to view | Plain items; "Fit canvas" | See L2; "Fit canvas" differs from the dialog's "Fit to view". |
| Window > Main window, one item per run window | Minimize, Close window only | Run windows cannot be found from the menu (L8). |
| Help > OrgAI on GitHub / Report a problem | Documentation / Report an issue | "Documentation" opens the repository home (DOCS_URL), not docs. Not clicked. |
| Disable items that do not apply | Several enabled items only announce | See M2. |
| Org retrospective (dis: not an ended work run) | Enabled on every viewed run | See M2. |
| Shortcut hints "Ctrl+," / "Ctrl+." | Rendered "Ctrl+Comma", "Ctrl+Period", "Ctrl++" by Electron | Readable; see L3. |

## Greying by state (from main, polled after each step)

| State | Enabled beyond the always-on items (new project/chat, assistants, settings panes, sidebar, shortcuts, About) |
| --- | --- |
| Dashboard, no project | none; Live/History/Team/Project settings, New run, run and canvas items greyed (a.json) |
| App settings (project selected) | same as Dashboard (c.json); see M5 |
| Project, no run (Team) | Live, History, Team, Project settings, New run |
| New run page | same as above; Close tab greyed although Ctrl+W closes the draft |
| Live work run with a card | plus Close tab, Open in new window, Go to decision, Show what needs you, Interrupt turn, End session, Org retrospective, all Canvas items |
| Chat start page while a project run waits | Team, Project settings, Go to decision, Show what needs you enabled (M1, M2) |
| Live Chat run | as a live work run, Save chat as project greyed, Org retrospective and Team/Project settings enabled (M2) |
| Ended work run (after relaunch) | Close tab, Open in new window, Org retrospective, Canvas; Interrupt and End session greyed |
| Ended Chat run (opened from History) | plus Save chat as project, also for a scratch chat (M2) |

## Findings

### M1. Go to decision is enabled by any waiting card, but only acts on the current project's run

Flow: start a work run that waits on a permission card (bell shows 1), File > Assistants > Chat, then Run > Go to
decision (or Ctrl+. via the menu path). Shot 72: the run tabs' status line says "No decision is waiting on this run."
on the Chat start page, while the sidebar bell shows 1 and the menu item was enabled. From History, Team or App
settings of the same project it does jump (shots 57, 58).
Cause (code read): `menuStateFor` sets `hasDecision` from `anyDecision(s.runs)` across every run, while the
`go-to-decision` fallback looks only at `activeRunByProject[selectedProjectId]`.
Owner: `src/renderer/src/lib/menuActions.ts` (`menuStateFor`, fallback `go-to-decision`); `MenuState` in
`src/shared/types.ts` if a second flag is added.
Fix (checkable): either the fallback falls through to the Show what needs you behaviour when the current project's run
has no card, or Go to decision gets its own flag computed from the viewed project's runs. Check: with a card waiting in
project A and the Chat start page open, Run > Go to decision either opens A's card or is greyed; it never says "No
decision is waiting" while the bell counts one.

### M2. Items that do not apply stay enabled and only announce

The inventory's rule was "Disable, do not announce"; these stay enabled and answer with a sentence:
- View > Team / Project settings on every assistant page: "Assistants have no team or settings." (shot 62; c.json,
  d.json "settings on live chat").
- Run > Org retrospective on a live work run and on a live Chat: "Not available for this run." (shot 61, d.json). The
  run strip does not offer it there.
- Run > Save chat as project on an ended scratch chat: "A scratch chat cannot become a project" (shot 102; the strip's
  button is disabled with that reason; the sentence has no full stop, unlike every other announcement).
- Go to decision, see M1.
A user who opens the menu sees an active item, clicks, and gets a quiet line at the top right instead of an action.
Owner: `menuStateFor` in `lib/menuActions.ts`, `menuItemEnabled` in `src/main/appMenu.ts`, `MenuState` in types.ts.
Fix (checkable): add the flags needed (for example `isAssistant`, `canRetro`, `canSaveChat` computed with the same
`offersRetro` / `canPromote` helpers RunActions uses) and grey on them. Check with `getMenuItemById(id).enabled`: on
the Chat start page `show-team` and `show-project-settings` are false; on a live run `org-retrospective` is false; on
an ended scratch chat `save-chat-as-project` is false. Add the full stop to the scratch reason if it stays.

### M3. The Ctrl+. hint works only on the Live view

Flow: a run waits on a card; open History; press Ctrl+. (real key). Nothing happens and nothing is said (f.json "real
Ctrl+. from History"). Run > Go to decision from the menu does work from History (shot 57). The menu shows
"Ctrl+Period" next to the item on every screen.
Cause (code read): the item sets `registerAccelerator: false` and the keydown handler that calls
`runMenuAction('go-to-decision')` is registered by LiveRunView only.
Owner: `src/renderer/src/views/LiveRunView.tsx` and `App.tsx` (or `lib/useAppMenu.ts`).
Fix (checkable): handle Ctrl/Cmd+. and Alt+D at app level (as Ctrl+T / Ctrl+W are) so the key does what the menu item
does on every view. Check: on History with a card waiting, Ctrl+. opens Live with focus on the card's first button
(the menu path focuses "Allow once", d.json).

### M4. The minimum-window content height is 615 px, and CLAUDE.md says about 654

Measured: `setSize(1024, 680)` -> `getContentSize()` 1008x615 (a.json, d.json; title bar plus the 26 px bar take 65 px).
CLAUDE.md "Application menu": "at the minimum window the content area on Windows is about 654 px". At 615 px, 25 px below
the size e2e checks:
- Live with a permission card (shots 78, 79): tray compact, stage 237 px, the card's effect line is cut after
  "nothing" and the composer still fits.
- New project dialog (shot 81): fits, bottom at 657 of 680.
- Team (shot 80): chart 312 px; the Team assistant tray scrolls.
- Chat start page (shot 82): fits.
Owner: CLAUDE.md (and ARCHITECTURE.md if it repeats the number); `src/main/index.ts` `minHeight`.
Fix (checkable): correct the number to 615 px at 100% scaling; if the 640 px floor matters, set the minimum through
`setMinimumSize` after measuring the frame (`getSize()[1] - getContentSize()[1]`) so `getContentSize()[1] >= 640` at
the minimum, and let e2e keep `setContentSize(1024, 640)`.

### M5. App settings treats the open project as closed

Flow: open a project, press Ctrl+, (real key), then Ctrl+1 (real key): nothing happens, no sentence (f.json). Ctrl+T
there says "Open a project first." although the project is selected in the sidebar (f.json). View > Live / History /
Team / Project settings are greyed on App settings (c.json). With L4 (Esc does not leave App settings) the keyboard
has no way back; the sidebar is the only route.
Cause (code read): `menuStateFor` sets `hasProject` false whenever the view is 'appSettings' or 'projects'.
Owner: `lib/menuActions.ts` (`menuStateFor`, `NO_PROJECT` wording), `views/AppSettingsView.tsx` for Esc.
Fix (checkable): keep `hasProject` true on App settings when `selectedProjectId` names a project, so Ctrl+1..4 and
New run return to it; say "Open a project first." only when none is selected. Check: Ctrl+, then Ctrl+1 shows the
project's Live tab.

### L1. No mnemonics on the menu bar

Alt+V and Alt+R do nothing and no letter is underlined; Alt then Down opens File and arrows move (shot 111).
Owner: `src/main/appMenu.ts`. Fix: labels `&File`, `&Edit`, `&View`, `&Run`, `&Window`, `&Help` (none on D). Check:
Alt+V opens View.

### L2. Toggle items do not show their state

"Show conversation" keeps its label while the conversation shows (c.json: layout switched to conversation and back);
"Hide finished agents" and "Toggle sidebar" have no check mark. Owner: appMenu.ts plus `MenuState`. Fix: `type:
'checkbox'` with `checked` from the renderer state (layout, hide finished, sidebar collapsed), or labels that flip
("Show agents" / "Show conversation"). Check: with the conversation layout shown, the item reads checked or "Show agents".

### L3. Mixed case and duplicate zoom words in View

"Actual Size", "Zoom In", "Zoom Out", "Toggle Full Screen" (title case) sit under sentence-case items, and Canvas has
"Zoom in" / "Zoom out" (shots 27, 31). Owner: appMenu.ts. Fix: override role labels in sentence case and name page zoom
apart ("Actual size", "Make text larger", "Make text smaller", "Full screen"). Check: no two View items share a word
pair, all labels sentence case.

### L4. "No decision is waiting on this run." and "Open a run first." on screens with no run

A stale Go to decision on the Dashboard announced "No decision is waiting on this run." (c.json). Fix with M1: say
"Nothing needs you right now." when no run is shown.

### L5. Close tab is greyed on the New run page although Ctrl+W closes the draft

New run page state: `close-tab` false (c.json "new run page"), but Ctrl+W closes the draft (f.json "real Ctrl+W on
draft"). Owner: `menuStateFor` (`hasRun` excludes the draft). Fix: enable Close tab while a draft tab is shown.

### L6. Shortcuts dialog gaps

Shots 74-77. No column headers (reviewer L6). "Live, History, Team, Project settings: Ctrl 1 or Ctrl 2 or Ctrl 3 or
Ctrl 4" wraps at 560 px and does not say which key opens which section. The dialog itself has no shortcut, and menu
keys (Alt, F10), page zoom and full screen are missing. Initial focus is on Close (fine); Tab order is X, the scrollable
body, Close. Owner: `components/KeyboardShortcutsDialog.tsx`, `SHORTCUTS` in menuActions.ts. Fix: a visually hidden
header row (Action, Keys); one row per section; rows for "Open the menu bar: Alt or F10" and page zoom.

### L7. New project from the menu on the first-launch Dashboard does nothing visible

With no projects the form is already on screen; File > New project and real Ctrl+N leave focus where it was (shot 41,
c.json focus "Dashboard" button). With projects it opens the form with focus in Name (e.json). Owner:
`openNewProject` in the store. Fix: focus the Name field (and pick "Start a project") when the inline form is shown.

### L8. Run windows cannot be reached from the Window menu

Window has Minimize and Close window only (shot 25 dump). After Run > Open in new window there is no item to bring
either window forward. Owner: appMenu.ts. Fix: "Main window" plus one item per run window titled like the window
("R1: Menu walk task"), as proposed.

### L9. Save as project dialog opens with focus on its close button

Shot 122: focus starts on the X, not the Project name field. Owner: `SaveAsProjectDialog`. Fix: autofocus the name
field.

## Announcements

- Run view: the run tabs' status line (`.run-tabs-notice`, role=status) shows the sentence; `menu-announce` stays empty,
  so one region speaks (c.json `liveRegions`: only `run-tabs-notice` held the text).
- Elsewhere: `menu-announce` (sr-only, role=status, aria-live=polite) gets the text after 60 ms and clears after 4 s
  (c.json: empty 4.5 s later); a repeat is cleared and re-set.
- Wordings seen: "Open a project first.", "A working run stays open. End its session first.", "Not available for this
  run.", "Assistants have no team or settings.", "No decision is waiting on this run.", "Hidden. Find it in History.",
  "This run is not working right now.", "This session has already ended." (the last two only through a JS click on a
  greyed item), "A scratch chat cannot become a project" (no full stop).
- Not checked with a screen reader; "read once" is inferred from one region holding the text.

## Keyboard pass (1024x640, dark, real keys)

Ctrl+N (Dashboard with projects: form with focus in Name), Ctrl+1, Ctrl+3, Ctrl+4 switch sections (Ctrl+2 was skipped:
the window lost the foreground), Ctrl+, opens App settings, Ctrl+1 there does nothing (M5), Ctrl+T there says "Open a
project first." (M5), Ctrl+B toggles once each way, Alt then Down opens File (shot 111), Alt+V does nothing (L1), Ctrl+.
from History does nothing (M3), Ctrl+W on a live run shows the notice, Ctrl+T on a live run opens one draft, Ctrl+W
closes it, Ctrl+W on an ended chat hides it ("Hidden. Find it in History."). Shortcuts dialog: focus on Close, Tab
cycles X / body / Close, Esc returns focus to the composer that had it (d.json).

## Click counts

| Task | Before the menu | Now |
| --- | --- | --- |
| Open logs folder | 3 | 2 (Help, Open logs folder) |
| Connectors | 2 | 2 (File, Connectors) |
| Skill assistant | 1 (sidebar) | 3 (File, Assistants, Skill assistant) |
| Go to decision from another section | 2+ | 2 (Run, Go to decision); Ctrl+. only on Live (M3) |
| Keyboard shortcuts | not possible | 2 (Help, Keyboard shortcuts) |
| Back to the project from App settings | 1 (sidebar) | still 1; no key (M5, L4) |

## Suggested order of work

1. M1 and M2 together: extend `MenuState` (or derive in main) so Go to decision, Team / Project settings on
   assistants, Org retrospective and Save chat as project grey when they would only announce; unit-test
   `menuItemEnabled` and extend e2e/menu.mjs with the Chat-page checks above.
2. M5 plus L4: `hasProject` on App settings and Esc to leave it.
3. M3: app-level Ctrl+. / Alt+D.
4. M4: correct the CLAUDE.md number; decide on the minimum size.
5. Lows: L1 mnemonics, L2 checkboxes, L3 labels, L5, L6, L7, L8, L9.

## Not driven

- macOS and Linux (app menu, Cmd key equivalents and double fire, Ctrl+Q); a packaged build (the dev-only View items
  are gated by `app.isPackaged`, read in code only).
- Help > Documentation, Report an issue, Open logs folder, Open data folder, Window > Close window, Minimize, File >
  Exit (they open the browser or Explorer or close the app).
- Interrupt turn and End session on a live run (brief); their greyed state on ended runs was checked.
- Run actions with a run window focused (Interrupt in the run window); only navigation from it was driven.
- Canvas items in the conversation layout (enabled; what they do there was not checked).
- Scaling above 100%; a screen reader.
- Ctrl+2 with real keys (skipped by the foreground guard); synthetic `sendInputEvent` was unreliable for registered
  accelerators and is not used as evidence.
