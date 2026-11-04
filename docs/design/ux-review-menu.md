# UX review: application menu bar inventory (menu-1)

Walked 2026-11-03 on dev at 8a20167, built app (`npm run build`), ORGAI_MOCK=1, fresh temp ORGAI_DATA_DIR, Windows 11,
100% scaling. Content sizes 1024x640 and 1600x1000, dark and light, plus 1024x620 to stand in for the minimum window
with a visible menu bar, and one keyboard pass. Scratch scripts `e2e/shots/menu-walk.mjs` and `menu-probe.mjs`
(gitignored); screenshots `e2e/shots/menu-01..24-*.png` and `menu-31..39-*.png` (gitignored, not copied here because
this brief allows one file only). Mock markers used: `[mock:deep-tree]` (work run, folds), `[mock:fatigue]` (permission
card), a Chat run. Nothing spent tokens.

## Verdict

Ready to build with the tree below, provided three things are designed in: (H1) Windows already ships Electron's
default menu, hidden, with Reload, Toggle Developer Tools and Close (Ctrl+W) in every build; (H2) the renderer already
owns five shortcuts, so the menu must share one command table with it instead of re-implementing them; (M1) the visible
bar costs 26 px of content height at the minimum window, on screens that are already at their compact limits.

## Earlier findings touching this area

| Source | Item | Status seen today |
| --- | --- | --- |
| spec 2.1 | Esc returns from App settings | Not built: Esc on the About pane leaves App settings open (no handler in AppSettingsView.tsx). See L4. |
| spec 2.1 | Logs button moved to Settings > About "Open log folder" | Present: About lists Data folder and Logs folder, each with Copy and Open (shot 20). `window.orgai.app.openLogs` exists in the preload but no renderer code calls it. |
| ux-review-assistants L6 | First-launch focus | Unchanged: focus starts in the New project Name field; the first Tab goes to the brief textarea, skip links come after the form (keyboard pass below). Not menu work. |
| appMenu.ts | macOS-only menu (app, Edit, View, Window) | Confirmed: `installAppMenu` returns on non-darwin; no Help menu on any platform. |

## Action inventory

R = renderer-routed (main sends a command to the focused window's renderer), M = main process only.
"Keys today" lists only what works now.

| Action | Where it lives today | Keys today | Proposed menu > label, accelerator | R/M |
| --- | --- | --- | --- | --- |
| New project | Projects page form / `new-project` button; sidebar "All projects" | none | File > New project, Ctrl/Cmd+N | R |
| New chat | Sidebar "Chat" row, Projects page "Chat now", `projects-new-chat` | Ctrl/Cmd+Shift+N (App.tsx) | File > New chat, Ctrl/Cmd+Shift+N (display, see H2) | R |
| MCP assistant | Sidebar row (rail icon Plug) | none | File > Open MCP assistant | R |
| Skill assistant | Sidebar row (rail icon Sparkles) | none | File > Open Skill assistant | R |
| New run | "+" tab in the run strip (title "New run (Ctrl+T)") | Ctrl/Cmd+T in project views only; silently ignored on Projects and App settings | File > New run, Ctrl/Cmd+T | R |
| Close tab | Tab "x" / "Hide R1", tab context menu "Hide", Delete on a focused tab | Ctrl/Cmd+W (RunTabs.tsx; always swallowed; live run -> notice "A working run stays open. End its session first.", shot 12) | File > Close tab, Ctrl/Cmd+W (display, see H2) | R |
| Open run in new window | Tab context menu (right click, Shift+F10, ContextMenu key): Hide, Open in new window (shot 15) | none | Run > Open in new window | R (calls window:openRun) |
| Interrupt turn | Run strip, enabled only while status is running | none | Run > Interrupt turn | R |
| End session | Run strip (no confirm) | none | Run > End session | R |
| Go to decision | Tray hint text | Ctrl+. or Alt+D (LiveRunView.tsx) | Run > Go to decision, Ctrl/Cmd+. | R |
| Needs you | Sidebar bell with count (shot 36) | none | Run > Show what needs you | R |
| Org retrospective | Run strip, ended work run of a real project only (shot 13) | none | Run > Org retrospective | R |
| Save as project | Run strip, ended Chat run still in Chat | none | Run > Save chat as project... | R |
| Show conversation / Show agents | Canvas toolbar `run-layout-toggle` | none | View > Canvas > Show conversation (checkbox) | R |
| Hide finished agents | Canvas toolbar switch | none | View > Canvas > Hide finished agents (checkbox) | R |
| Canvas zoom in / out / fit | Live toolbar buttons; Team uses React Flow's +, -, fit controls | + / - / 0 only while the Live canvas has focus | View > Canvas > Zoom in, Zoom out, Fit to view (no accelerator) | R |
| Canvas legend | Toolbar popover | none | Leave out (screen-local) | - |
| Live / History / Team / Settings | Topbar tabs ("Project sections"); arrows inside the tablist | none | View > Live Ctrl+1, History Ctrl+2, Team Ctrl+3, Project settings Ctrl+4 | R |
| Sidebar rail | Lockup "Expand sidebar (Ctrl+B)" button; auto rail under 1180 px | Ctrl/Cmd+B (App.tsx) | View > Collapse sidebar (checkbox), Ctrl/Cmd+B (display) | R |
| App settings | Sidebar gear (`App settings`) | none | File > Settings > General, Ctrl/Cmd+, | R |
| App settings panes | Pane nav: General, Connections, Connectors, Skill library, About | arrows in the pane nav | File > Settings > Connections / Connectors / Skill library | R |
| About | App settings > About (version, Dev build, Mock adapter, data and logs folders) | none | Help > About OrgAI (win/linux; mac in the app menu) | R (opens the About pane) |
| Open logs folder | App settings > About > Logs folder "Open" (3 clicks) | none | Help > Open logs folder | M |
| Open data folder | App settings > About > Data folder "Open" | none | Help > Open data folder | M |
| GitHub repo / issues | Nowhere | none | Help > OrgAI on GitHub; Help > Report a problem | M |
| Page zoom | Nowhere visible | Ctrl+= / Ctrl+- / Ctrl+0 via the hidden default menu (could not confirm with synthetic keys) | View > Zoom in / Zoom out / Actual size (roles) | M |
| Full screen | Nowhere visible | F11 via the hidden default menu | View > Full screen (role) | M |
| Reload, developer tools | Nowhere visible | Ctrl+R, Ctrl+Shift+I via the hidden default menu, packaged builds too | View, dev builds only | M |
| Minimize / close window | Title bar | Ctrl+M and Ctrl+W via the hidden default menu (Ctrl+W is swallowed by the renderer) | Window > Minimize; Close window without Ctrl+W | M |
| Quit | Title bar close; hidden File > Exit | Alt+F4 | File > Exit (win), Quit Ctrl+Q (linux), app menu Cmd+Q (mac) | M |
| Cut / copy / paste / undo | Text fields | default roles | Edit roles | M |
| Team: Add role, Import agents, Export to repo, Auto-layout | Team toolbar | none | Leave out of this pass (screen-local; a later Team menu could take them) | - |

## Proposed menu tree

Labels in sentence case, like the app's own copy (override Electron's title-case role labels). No vendor names.
(dis) = disabled when it does not apply, with the reason in the table under "When an item does not apply".

```
OrgAI                          (macOS only)
  About OrgAI                  R  opens App settings > About
  ---
  Settings...        Cmd+,     R
  ---
  Services                     role
  ---
  Hide OrgAI / Hide others / Show all   roles
  ---
  Quit OrgAI         Cmd+Q     role quit
File
  New project        Ctrl+N    R
  New chat           Ctrl+Shift+N  R (display only on win/linux)
  New run            Ctrl+T    R (dis: no project)
  ---
  Open MCP assistant           R
  Open Skill assistant         R
  ---
  Settings  >                  R   (win/linux; on mac the same submenu, Cmd+, lives in the app menu)
     General         Ctrl+,
     Connections
     Connectors
     Skill library
  ---
  Close tab          Ctrl+W    R (display only on win/linux; dis: no tab)
  ---
  Exit                         role quit (win; "Quit  Ctrl+Q" on linux; absent on mac)
Edit
  Undo / Redo / --- / Cut / Copy / Paste / (mac: Paste and match style) / Delete / Select all   roles
View
  Collapse sidebar   Ctrl+B    R checkbox (display only on win/linux)
  ---
  Live               Ctrl+1    R radio (dis: no project)
  History            Ctrl+2    R radio (dis: no project)
  Team               Ctrl+3    R radio (dis: no project or assistant)
  Project settings   Ctrl+4    R radio (dis: no project or assistant)
  ---
  Canvas  >                    R (dis: not on Live with a run)
     Show conversation          checkbox
     Hide finished agents       checkbox
     ---
     Zoom in / Zoom out / Fit to view   (no accelerators; tooltips keep + / - / 0)
  ---
  Actual size        Ctrl+0    role resetZoom
  Zoom in            Ctrl+=    role zoomIn
  Zoom out           Ctrl+-    role zoomOut
  ---
  Full screen        F11 (mac Ctrl+Cmd+F)  role togglefullscreen
  [dev builds only] --- / Reload / Force reload / Developer tools   roles
Run
  Go to decision     Ctrl+.    R (dis: no decision on this run; Alt+D stays in the renderer)
  Show what needs you          R (dis: nothing waiting)
  ---
  Interrupt turn               R (dis: run not working)
  End session                  R (dis: no live session)
  ---
  Org retrospective            R (dis: not an ended work run of a project)
  Save chat as project...      R (dis: not an ended Chat run; scratch reason as in the strip)
  ---
  Open in new window           R -> window:openRun (dis: no run viewed)
Window
  Minimize           Ctrl+M    role
  Zoom                         role (mac only)
  Close window                 role close, NO accelerator on win/linux (mac: Cmd+Shift+W)
  ---
  Main window                  M  focus the unscoped window
  <one item per run window>    M  "R1 Fix header" (title from the run), focus it
  ---
  Bring all to front           role front (mac only)
Help
  OrgAI on GitHub              M  https://github.com/perrychapman/OrgAI
  Report a problem             M  https://github.com/perrychapman/OrgAI/issues
  ---
  Open logs folder             M  shell.openPath(logs dir)
  Open data folder             M
  ---
  About OrgAI                  R  (win/linux only; opens App settings > About)
```

Top-level mnemonics on Windows: &File, &Edit, &View, &Run, &Window, &Help. None may use D (Alt+D is the
decision jump) and none may take a letter already meaningful inside the renderer.

### When an item does not apply

Disable, do not announce. A native menu item that is enabled and does nothing is the worst outcome (today Ctrl+T on
Projects and App settings does nothing and says nothing). The renderer pushes a small state object to main on every
change (project selected, view, viewed run status, decision waiting, needs-you count, canvas shown, layout, Hide
finished state, sidebar collapsed) and main sets `enabled` / `checked`; Electron menus read `enabled` at open time,
so this stays correct for clicks.

Announce only when a key press or a stale command reaches the renderer for an action that does not apply, in the
existing polite region (`tray-announce` / tab notice), once per press:

| Command | Announcement |
| --- | --- |
| New run, Live/History/Team/Project settings | "Open a project first." |
| Team / Project settings on an assistant | "Assistants have no team or settings." |
| Close tab on a live run | "A working run stays open. End its session first." (existing text) |
| Close tab with no tab | silent (swallow as today) |
| Interrupt turn | "This run is not working right now." |
| End session | "This session has already ended." |
| Go to decision | "No decision is waiting on this run." |
| Org retrospective / Save chat as project | "Not available for this run." |
| Canvas items | "Open a run on Live to use the canvas." |

## Findings

### H1. Windows already has Electron's default menu, including Reload and Developer tools, in every build

Flow: launch, read `Menu.getApplicationMenu()` in main (menu-walk.json). On win32 the menu is Electron's default:
File > Exit; Edit roles; View > Reload (CmdOrCtrl+R), Force Reload, Toggle Developer Tools (Ctrl+Shift+I), Actual
Size, Zoom In/Out, Toggle Full Screen (F11); Window > Minimize (Ctrl+M), Zoom, Close (CmdOrCtrl+W). The window has
`autoHideMenuBar: true`, so Alt shows it. Packaged builds get the same menu, so a user can reload the renderer mid-run
or open devtools. Ctrl+W is safe only because RunTabs.tsx swallows it. Synthetic key presses (Playwright/CDP) did NOT
trigger Ctrl+R, Ctrl+Shift+I or Ctrl+= in the probe, so whether real keys do was not confirmed here.
Owner: src/main/appMenu.ts (`installAppMenu` returns early off darwin), src/main/index.ts (`autoHideMenuBar`).
Fix (checkable): install the OrgAI menu on every platform; in a packaged build (`app.isPackaged`) the menu contains no
item with role reload, forceReload or toggleDevTools and no item with accelerator CmdOrCtrl+W except "Close tab"
(display only); unit test on the template builder per platform, plus an e2e `app.evaluate` over
`Menu.getApplicationMenu()`.

### H2. The renderer owns five shortcuts; the menu must not become a second implementation

The renderer handles Ctrl/Cmd+B, Ctrl/Cmd+Shift+N, Ctrl/Cmd+T, Ctrl/Cmd+W and Ctrl+. / Alt+D on `window` keydown, and
e2e drives them with `page.keyboard`, which (probe) never reaches native accelerators. On Windows and Linux Electron
runs a menu accelerator only for a key event the page did not handle: Ctrl+T on the Projects page is not
preventDefault-ed, so a registered Ctrl+T menu item would fire there and not elsewhere, giving two code paths. On
macOS, key equivalents may reach the menu before the page (unverified; no Mac).
Owner: new renderer command table (e.g. `lib/commands.ts`), App.tsx, RunTabs.tsx, LiveRunView.tsx; contract in
src/shared/types.ts (command ids, the menu state object, a `menu:command` main-to-renderer channel and a
`menu:state` renderer-to-main channel); appMenu.ts.
Fix (checkable): one command id per action, run by both the keydown handlers and `menu:command`; on win/linux the
items for renderer-owned keys set `registerAccelerator: false` (shown, not registered), so one key press runs the
command exactly once (e2e: press Ctrl+T once on a run, exactly one draft page opens; call
`getMenuItemById('file.newRun').click()` through `app.evaluate`, same result). On mac, verify on hardware that Cmd+T
opens one draft, not two.

### M1. A visible bar costs 26 px at the minimum window; several screens are already at their limit

Measured: at the 1024x680 minimum window the content is 1008x641 with the bar hidden and 1008x615 with the default
bar shown (26 px, not 20, at 100% scaling; more at 125-150%). e2e is unaffected because it sets the content size
(`setContentSize(1024, 640)`), so it will not catch this. Seen at 1024x620 content (shots 32-39, dark and light):
- Live with a permission card (shots 36, 37): frame 456 -> 436 px, stage 253 -> 240 px; the tray is already compact
  (`data-compact=true`) at 640; the Orchestrator node and the card's buttons still fit, with no margin.
- New project form on first launch (shots 01-02, 32-33): already scrolls at 640 (form bottom 762 px in a 641 px
  window); the Create button is below the fold before the bar, and 20 px further after it.
- Team tab (shots 34, 35): chart stage 326 -> 315 px with the Team assistant tray (139 px) under it; three report
  nodes still fit.
- Project and App settings: scroll regions 592 -> 572 px; fine.
- Chat conversation layout and the New run page: fit with room.
Owner: src/main/index.ts (`minHeight: 680`).
Fix (checkable): on win/linux with a visible bar raise `minHeight` by the bar height (680 -> 706) so the minimum
content stays at least 640 px; check `getContentSize()[1] >= 640` after `setSize(1024, minHeight)`.

### M2. Shortcuts are invisible today; only two are named in the UI

Only "New run (Ctrl+T)" (the "+" tab title) and "Expand sidebar (Ctrl+B)" (lockup) and the tray hint (Ctrl+. / Alt+D)
name a shortcut. Ctrl+Shift+N appears only in the Chat rail tooltip; the tab context menu (Shift+F10) and Delete to
hide a tab are named nowhere. The menu fixes discovery by itself; keep the tooltips in sync with the menu
accelerators (one table).
Owner: the command table from H2. Fix: every accelerator shown in a tooltip comes from the same table as the menu.

### M3. Run-scoped windows need a routing rule

"Open in new window" opens a second renderer scoped to one run. Navigation commands (New project, New chat,
assistants, Settings, project sections, Collapse sidebar) make no sense inside it; run commands (Interrupt, End
session, Go to decision, Close tab) do.
Owner: appMenu.ts plus index.ts `windowScopes`. Fix: navigation commands from a run window focus the main window
(create it if closed) and run there; run commands go to the focused window's run; check with two windows open that
File > Settings changes the main window and Run > Interrupt turn hits the run window's run.

### L1. Two kinds of zoom

Page zoom (Ctrl+= / Ctrl+- / Ctrl+0, roles) and canvas zoom (+ / - / 0 with the canvas focused, toolbar buttons,
React Flow controls on Team) share words. Keep canvas items in View > Canvas without accelerators so the menu does not
show "Zoom in" twice at the same level. Check: no two items under View carry the same label.

### L2. Role labels are title case; the app writes sentence case

Electron role items read "Select All", "Toggle Full Screen", "Actual Size", "Toggle Developer Tools". Override `label`
on every role item, or decide on title case for menus only (see questions).

### L3. End session has no confirm and no accelerator

It is one click in the strip and stops every agent. Keep it without an accelerator in the menu.

### L4. Esc does not leave App settings (spec 2.1)

Not menu work, but a menu "Settings" entry makes the way back matter more. Owner: AppSettingsView.tsx. Fix: Esc with
no open dialog or popover returns to the previous view.

### L5. A new project without the Architect opens on Team, not Live (shot 06)

Fine as a first view, but "New run" from the menu must switch to Live and focus the composer (Ctrl+T already does:
focus lands in the composer textarea).

## Keyboard pass

From first launch at 1024x640: focus starts in the form's Name field; Tab order is brief textarea, folder field,
Browse, Architect checkbox, mock checkbox, Chat now, then "Skip to content", "Skip to sidebar", the lockup
("Expand sidebar (Ctrl+B) ..."), All projects, Chat, MCP assistant, Skill assistant, Mock adapter (account row), App
settings, then back to the form. Ctrl+B toggled the rail (on, off). Ctrl+Shift+N opened the Chat start page with
focus in its composer. Ctrl+T on a project opened the New run page with focus in the composer; Ctrl+W closed it;
Ctrl+W on the live run showed the notice; Ctrl+T on Projects and App settings did nothing and said nothing. Alt
did not show the hidden bar through synthetic input.

## Click counts (today -> with the menu)

| Task | Today | Menu |
| --- | --- | --- |
| Open logs folder | 3 (gear, About, Open) | 2 (Help, Open logs folder) |
| Report a problem | not possible in app | 2 |
| Connectors | 2 (gear, Connectors) | 3 (File, Settings, Connectors) |
| Open run in new window | 2 (right click, item) | 2 (Run, item) |
| Interrupt turn | 1 | 2 (or a future accelerator) |
| Skill assistant | 1 (sidebar) | 2 |

The menu adds discovery and keyboard reach, not speed; the in-app controls stay the primary path.

## Suggested order of work

1. Contract in src/shared/types.ts: command ids, menu state, `menu:command` / `menu:state` (H2).
2. Renderer command table; existing keydown handlers call it; announcements for not-applicable presses.
3. appMenu.ts: one template builder per platform, dev-only items, mnemonics, Help links via `shell.openExternal`
   (fixed URLs only), logs and data folders via `shell.openPath` (H1).
4. Enabled/checked state from `menu:state`; run-window routing (M3).
5. minHeight with a visible bar (M1); unit tests on the template; one e2e that clicks items through `app.evaluate`.

## Open questions

1. Visible bar on Windows, or keep `autoHideMenuBar` (Alt shows it, no height cost)? Word shows it; OrgAI at 1024x680
   pays 26 px.
2. Sentence case everywhere, or title case in menus to follow the macOS HIG?
3. Accelerators for Interrupt turn and Show what needs you? None proposed; Esc is taken by dialogs and popovers.
4. Ctrl+1..4 for project sections: wanted, or leave sections to the tab bar?
5. Should About on win/linux open the App settings About pane (proposed: it already shows version, dev badge and
   folders) or Electron's native about panel?
6. Linux: Quit at Ctrl+Q, and a visible bar there too?

## Not driven

- Native menus cannot be clicked through Playwright; the current menu was read from main with
  `Menu.getApplicationMenu()`.
- Synthetic keys (CDP) did not trigger Ctrl+R, Ctrl+Shift+I or Ctrl+= and Alt did not show the bar, so whether the
  hidden default menu's accelerators fire for real key presses was not confirmed.
- macOS (key-equivalent order vs page keydown, app menu) and Linux were not run.
- Scaling above 100% (bar height grows).
- Native folder pickers, the Save chat as project flow and the MCP and Skill assistant runs were not driven in this
  walk.

## Implementation notes

Renderer router (`lib/menuActions.ts`, `lib/menuRegistry.ts`, `lib/useAppMenu.ts`, `components/AppMenuLayer.tsx`).
A registered screen handler wins; otherwise the store fallback below; a returned or fallback sentence is announced.

| Action | Store call or fallback | Not applicable |
|---|---|---|
| new-project / new-chat | `openNewProject()` / `openNewChat()` | none |
| open-chat / -mcp-assistant / -skill-assistant | `openAssistant('quick' / 'harness' / 'skills')` | none |
| new-run | `setView('run')` if needed, `openDraft()`, `focusComposer()` | "Open a project first." |
| show-live / show-history | `setView('run' / 'history')` | "Open a project first." |
| show-team / show-project-settings | `setView('team' / 'settings')` | "Open a project first."; on an assistant "Assistants have no team or settings." |
| open-app-settings, -connections, -connectors, -skill-library, -about | `requestAppSettingsSection` (general, connections, mcp-library, skill-library, about), `setView('appSettings')`, then the `orgai:settings-section` event | none |
| toggle-sidebar | `toggleSidebar()` | none |
| keyboard-shortcuts | opens `KeyboardShortcutsDialog` | none |
| close-tab | `closeCurrentTab()` (draft closes, finished run `dismissRun`, working run notice) | silent |
| interrupt-run | `interrupt()` when status is Running | "Open a run first." / "This run is not working right now." |
| end-session | `stopRun()` when live | "Open a run first." / "This session has already ended." |
| go-to-decision (fallback) | `jumpToDecision` to the active run's first waiting item | "No decision is waiting on this run." |
| show-needs-you | `jumpToDecision` to the oldest waiting item in any run | "Nothing needs you right now." |
| open-run-window | `openRunWindow(projectId, runId)` | "Open a run first." |
| org-retrospective, save-chat-as-project (fallback) | RunActions registers them | "Not available for this run." |
| toggle-conversation, toggle-hide-finished, canvas-fit, canvas-zoom-in/out (fallback) | the Live view registers them | "Open a run on Live to use the canvas." |

Decisions: announcements use the run tabs' visible `tabNotice` when a project is in the run view, else the sr-only
`menu-announce` status region (cleared, then set 60 ms later, cleared after 4 s, so a repeat is read again). The
shortcuts dialog reads one `SHORTCUTS` table (Cmd on a Mac, detected from the platform string); after Esc, focus goes to
`#main-content` when nothing held it. Ctrl+T always calls preventDefault, Ctrl+W always does and keeps the repeat guard.
Two wordings are new, not from the table under "When an item does not apply": "Open a run first." (a run action
with no run tab shown) and "Nothing needs you right now." (Show what needs you with nothing waiting). Kept as is.
A click on a greyed item does nothing (Electron does not call it), so announcements come only from key presses the
renderer handles itself (Ctrl+T, Ctrl+W, Ctrl+., Alt+D) or a stale command. e2e/menu.mjs (mock, 1024x640 and
1600x1000, dark and light) clicks items through `Menu.getMenuItemById(id).click()` and checks: New chat, View > Team,
Help > About, New run (one draft, also for Ctrl+T), Show conversation, Interrupt turn enabled while the session is open
(the mock run waits on a card while running, so it is not clicked), Org retrospective on a live run announcing "Not
available for this run." in the run tabs' status line, View > Team greyed on the Projects page, the shortcuts dialog
(Esc, focus back), and Ctrl+T on the Projects page announcing "Open a project first." in `menu-announce`. Not driven:
macOS key equivalents, run-scoped windows, canvas zoom and fit.

Reviewer (reviewer-3): no Critical or High. Fixed: M1 (the run tabs' status span is always mounted; a repeated notice is
cleared and re-set, newest call owns the timer), L1 (Ctrl+. / Alt+D announce with no tray), L4 (announcements go to the
tab notice only when the project really exists). Open: L2 (macOS double fire, unverified), L3 (`anyDecision` builds
labels on every store change), L5 (Save as project from the menu may return focus to body), L6 (no column headers in the
shortcuts table).
