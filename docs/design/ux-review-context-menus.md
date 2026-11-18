# UX review: context menus (right click, Menu key, Shift+F10)

Walked 2026-11-18 on the built app (`npm run build`), mock adapter (`ORGAI_MOCK=1`), throwaway data dir, as a first-time
user. Contract judged against: `docs/design/context-menus.md` sections 1 to 3.

Matrix: 1600x1000 and 1024x640 x dark and light. Every surface was opened by mouse (right click, visible More button)
and by keyboard (Tab or focus to the element, then Menu key or Shift+F10, arrows, Enter, Escape). Actions were
activated at 1600x1000 dark. Seed data: a code project "Walk code" with a `[mock:outputs-all]` run (12 outputs), an
engagement with a `[mock:knowledge]` run (5 Knowledge rows), two schedules (one paused), one scratch Chat run.
Screenshots: `e2e/shots/ux/<surface>-<width>-<theme>.png` (git-ignored); for example `hist-right-1600-dark.png`,
`node-right-1024-light.png`, `chathist-right-1600-dark.png`, `team-remove-1600-dark.png`.

## Summary

The shared primitive behaves consistently on all eight surfaces: the menu opens in the top layer, is never clipped at
1024x640 (every menu box measured inside the viewport, 8 px or more from the edges), focus lands on the first item,
Escape returns focus to the invoker on 6 of 8 surfaces, and both themes read well. The gaps are focus return on the two
surfaces whose invoker is not focusable (History rows, Schedule cards), a hidden reason on disabled items, and
discoverability of the menu on surfaces that have no visible More button.

No High findings.

## Medium

### M1. History row and Schedule card: Escape (and a completed action) drops focus to the page body

- Surface: Project History tab rows, Chat History rows, Schedules cards.
- Did: right click a History row (or a Schedule card body), press Escape. Also: right click a Schedule card, choose
  Edit, press Escape in the editor; choose Delete, press Escape on the confirm.
- Happened: the menu closes and `document.activeElement` is `BODY` (next Tab starts again from "Skip to content").
  Measured at all four size and theme combinations. The same menus opened from the visible More button, or from the
  Run now button on a card, return focus correctly, so the failure is only on the right-click path. Contract section 2
  says focus returns to the invoker, with `fallbackFocus` when it is gone; the row is not focusable so there is no
  invoker, and the Schedules fallback (the page `h1`) is only used after Pause. Schedule card Edit, then Escape in the
  editor, also ends on the body.
- Impact: a keyboard or screen reader user who right-clicks (or a mouse user who then starts tabbing) loses their
  place in a long table. Low for a pure mouse user.
- Fix: for rows that cannot take focus, return focus to the row's More button (History) or the card's first action
  button (Schedules), and use that as `fallbackFocus` for the dialog return too.

### M2. Team: Remove role asks for confirmation although the text promises undo

- Surface: Team tab org chart role node, Remove role.
- Did: right click the Reviewer node, choose Remove role.
- Happened: a modal "Remove Reviewer?" opens, body "You can undo this for a few seconds.", buttons Cancel / Remove
  role. The contract (section 3, row 9) says the existing undo row is the safety net. Asking first and then offering
  undo is two safeguards for one reversible action, and the body text reads like a statement made before anything
  happened.
- Fix (one of): if the confirm is the existing Delete-key flow, keep it, and change the copy to "Remove Reviewer? Roles
  that report to it move up to Orchestrator." (say the consequence, not the undo); or drop the modal and show the
  undo row only, as the contract says. Raise with the UI lead which is intended.

### M3. Menu is not discoverable on rows with no visible button (Knowledge rows, Team nodes, Sidebar rows)

- Did: opened each as a first-time user without knowing about right click.
- Happened: Knowledge rows show nothing that hints at Retire or Edit (Open is also reachable by clicking the row, but
  Retire and Edit are only in the menu and in the detail pane, which a new user may not open). Team node: the footer
  hint reads "Drag from a node's bottom handle to another node to make it a report. With a node focused, Enter edits
  it and Delete removes it." It does not mention the menu, and Add a report is only reachable through toolbar Add role
  plus the manager field, or this menu. Sidebar project rows: Open folder and Project settings have no other short path
  at 1024 (the sidebar is an icon rail of initials).
- Rule 1 says every action also exists elsewhere. That is true for Retire (detail pane) and Remove role (Delete key),
  but the "elsewhere" is itself not visible from the list or canvas.
- Fix, copy only: Team footer hint: "Drag from a node's bottom handle to make a report. Select a node: Enter edits,
  Delete removes, Shift+F10 or right click opens more." Knowledge list helper under the count ("5 of 5 items"):
  "Right click or press Shift+F10 on an item for Open, Edit and Retire."

## Low

### L1. Disabled menu items give their reason only to screen readers and as a tooltip

- Surface: Team (Remove role on the root), Chat History (Save as project... on a scratch chat), Run tabs (Hide while
  working, not driven).
- Did: opened each menu.
- Happened: the item is greyed (also low contrast in light, which is normal for disabled) and the reason ("The root
  role cannot be removed." / "A scratch chat cannot become a project") exists in the accessible name and a title, but a
  sighted keyboard user sees nothing, and a mouse user sees it only after hovering. Screenshots:
  `node-right-1600-dark.png`, `chathist-right-1600-dark.png`.
- Fix: show the reason as a muted second line inside the item at 12 px (menu is 176 px wide, so wrap). Or give the
  Chat case a clearer message: "Save as project... Not available for a scratch chat. Start the chat in a folder to
  save it."

### L2. History menu: Retrospective has no icon, so its label is out of line with the items above

- Surface: Project History menu (`hist-right-1600-dark.png`, `hist-more-1024-light.png`).
- Every other item has a leading icon; Retrospective is indented with an empty slot. Add an icon or remove the slot
  indent for icon-less items.

### L3. Right-click opens at the pointer on top of the thing clicked

- Surface: all pointer-anchored menus, most visible on Team (`node-right-1600-dark.png`: the menu covers the "leads 3"
  chip) and the Sidebar (covers the row's own label). Expected for a context menu; no action needed unless the Team
  menu is later extended. The More button and keyboard placement (under the element) did not have this.

### L4. Keyboard reach to the first dashboard tile is 18 Tab stops from the page body

- Surface: Dashboard. Pressing Tab from the body reaches the first project tile's Open button on the 18th press
  (sidebar rows, assistants, projects). Pre-existing, but the Menu key path depends on it. A "Skip to projects" link
  next to the existing skip links would shorten it.

### L5. Sidebar scrolled sideways once after using a sidebar menu (not reproduced)

- In one run, after choosing Project settings from a sidebar project menu while the engagement row was selected, the
  sidebar showed a horizontal scrollbar and its content was shifted a few pixels left (`sidebar-settings-1600-dark.png`).
  A clean re-run (right click, Escape, right click, Project settings) did not reproduce it
  (`sidebar-shift-1600-dark.png`, scrollLeft 0 throughout). The trigger may be the selected row's long "Last run ...
  Ended when OrgAI closed" subtitle rather than the menu. Worth a look if someone sees it.

## What worked

- Run tabs: menu is "Open in new window, separator, Hide". Hide shows the toast "Hidden. Find it in History." and focus
  lands on the next real element (the composer), not the body.
- Knowledge rows: Open, Edit (only on the note), Retire. Retire shows "Retired Migrate billing to Stripe." with Undo;
  focus moves to the neighbouring row. Edit opens the note editor and Escape returns to the row.
- Dashboard tiles: right click, the Menu key on the Open button and the visible More button open the same menu; Delete
  ("Forget engagement...") is last, red, after a separator, and asks to confirm; Escape on the confirm returns focus to
  More. New run lands in the composer.
- Sidebar project rows (Open, New run, Open folder, Project settings) and open-run rows (Open, Open in new window)
  open from right click and the Menu key and return focus to the row.
- History: visible More button; right-click menu contents correct (Open, Open in new window, Continue, Open outputs,
  separator, Retrospective; Save as project... only on Chat history). Open outputs jumps to the Outputs tab; Retrospective
  starts a run.
- Schedules: Run now, Pause (toast "Nightly check paused."), Resume, Edit, Delete with its confirm all work; the visible
  buttons make the menu a shortcut only, which is the right call.
- Outputs list rows and grid tiles: Open, Open in default app, Show in folder, Copy path; Open selects it and puts focus
  on the detail heading; Copy path toasts "Copied the path.".
- Team nodes: Edit role selects the node and opens the Role panel; Add a report creates "New role" under it and toasts
  the consequence ("Implementer can now create subagents, because New role reports to it."); Remove role is disabled on
  the root.
- Both sizes: no menu clipped, none off-screen. Both themes: item text, separators and the danger red are legible.

## Not checked

- Open in new window (run tab, sidebar run, History): opens a second native window; not driven.
- Open folder and Show in folder, Open in default app: hand off to the operating system; not driven.
- Retrospective was started once (runs on the mock adapter); its result was not walked.
- Right-click near the bottom or right window edge (flip left or up) at 1024x640: only the e2e geometry check covers it.
- Save as project... on a Chat run that has a folder (the walked chat was scratch, so the item was disabled).
- Hide on a run that is still working (disabled with a reason), and the Retire then Restore menu on a retired row
  (needs Show retired on).
- Outputs select mode (menu should not appear) and a missing-file output.
- Schedules Delete confirmed (only cancelled, to keep the data).
- Screen reader speech and the native text menu over a text selection (script-dispatched in the e2e only).
- Light theme and 1024x640 actions were not activated, only opened and screenshotted.
- Scratch scripts used for this walk live in `e2e/shots/ux/` (git-ignored) and are not part of the change.
