# Context menus (right click, Menu key, Shift+F10)

Status: evaluation and implementation contract, 2026-11-18. Owner: UI Lead. Primitive: `components/ui/ContextMenu.tsx`
with pure rules in `lib/contextMenu.ts` (tested in `lib/contextMenu.test.ts`). e2e: `e2e/context-menus.mjs`.

## 1. Rules

1. Right click is never the only way to an action. Every menu opens from the keyboard (the Menu key or Shift+F10 on
   the focused row, tab, tile or node), and every action in it also exists elsewhere: as a visible button, or behind
   one visible "More actions" button (`MenuButton`) that opens the same menu.
2. The primary action of a row or card stays a visible button. A visible button is removed only where the surface is
   crowded and the action is secondary; nothing a first-time user needs to find the feature is hidden.
3. Destructive items keep their existing confirmation (or undo) flow, are styled as danger and sit last, after a
   separator.
4. Menus only call actions the renderer already has (store actions and `window.orgai` calls). No new capabilities, no
   new IPC.
5. The platform menu wins over ours in text fields (input, textarea, select, contenteditable), on links and over a
   non-empty text selection inside the surface: the custom menu then does not call `preventDefault`, so the native
   Cut / Copy / Paste / Copy link address menu (added in main) appears. `lib/contextMenu.ts` `nativeMenuWins`.
6. Copy follows the app: sentence case, no em dashes, "..." on an item that opens a dialog only where the existing
   button already says so.

## 2. The primitive

- `useContextMenu<T>()` returns a control with `onContextMenu(e, target)`, `onKeyDown(e, target)` (Menu key and
  Shift+F10; ignored inside text fields), `openFrom(el, target, align)` and `close()`.
- `<ContextMenu control label items testId />` renders the open menu: `role="menu"` on a `popover="manual"` element
  (top layer, so it is never clipped by a scroll container or hidden under a dialog), `role="menuitem"` buttons,
  `role="separator"` lines, `aria-disabled` items that stay focusable and announce their reason, a `danger` style.
- `<MenuButton control target label testId />` is the visible "More actions" button (`aria-haspopup="menu"`,
  `aria-expanded`), anchored end-aligned under itself.
- Placement: at the pointer for a right click (flipped left or up near an edge); under the element for the keyboard
  and the More button (above it when there is no room below); always clamped 8 px inside the window.
- Keys inside: Up / Down wrap, Home / End, a letter jumps to the next item starting with it, Enter / Space activate,
  Escape and Tab close. Every key is kept inside the menu (it may be rendered inside a list with its own keys), and
  Escape is cancelled so it never also closes a dialog underneath.
- Dismissal: pointerdown outside, window resize, a wheel scroll outside the menu, window blur, focus moving elsewhere.
  Programmatic scrolls do not dismiss (built: focusing a tab scrolls its strip into view as the menu opens, and a
  streaming transcript scrolls itself; a `scroll` listener closed the menu at once, about half the time). Keyboard
  scrolling cannot happen while the menu holds every key, and a scrollbar drag starts with a pointerdown outside.
- Focus: the first enabled item on open; back to the invoking element on Escape, Tab, activation, and on any dismissal
  while focus was in the menu. When the invoker has left the document (the action removed its row) or cannot take
  focus (a table row, a card), an optional `fallbackFocus` is used, so focus never drops to the body. Surfaces whose
  right-click target is not focusable pass a focusable `invoker` (History: the row's More button; Schedules: the
  card's Run now). When the menu's target disappears while it is open (no items left), the menu closes and focus
  goes to the fallback.
- The Menu key and Shift+F10 inside a text field or on a link are left to the platform.
- Motion: a `--dur-fast` opacity fade on enter only, which both reduced-motion switches zero. Tokens only; both themes
  through the surface, border and danger tokens.

## 3. Evaluation

"Dup" lists the visible buttons a menu duplicates and what happens to each: keep (primary or not crowded) or
remove (secondary on a crowded surface; reachable through the row's More button and the context menu).

| # | Surface | Fit | Items (in order; `---` is a separator; D = destructive) | Dup buttons: keep / remove |
|---|---|---|---|---|
| 1 | Run tabs (`RunTabs.tsx`) | Yes, existed. Tabs are objects with secondary actions and no room for buttons. Migrated to the primitive. | Open in new window (runs only); --- ; Hide (built: any run tab can be hidden, hiding never ends the session; disabled with a reason only on the only, blank tab. Before the migration Hide came first; the order now follows this table) | Tab close X: keep (hover affordance, Ctrl+W). |
| 2 | Knowledge rows (`KnowledgeList.tsx`) | Yes, existed (Shift+F10 / right click, no row buttons by design, rec 16). Migrated. | Open; Edit (notes only); Retire or Restore | None (actions also in the detail pane). |
| 3 | Dashboard project tiles (`ProjectTile.tsx`) | Yes. The tile already had a More popover menu; right click on the tile and the Menu key on its Open button now open the same menu. Migrated from `Popover` to the primitive. | Open; New run; Continue "<run>" (when one can continue); Open folder; --- ; Delete project / engagement (D, existing confirm) | More button: keep (it is the visible path). |
| 4 | Sidebar project rows (`Sidebar.tsx`, `nav-project`) | Yes. Frequent, compact rows with no room for buttons; today Open folder and Project settings are several clicks away. | Open; New run; Open folder; Project settings | None (no visible row buttons). |
| 5 | Sidebar open-run rows (`nav-run`) | Yes, matches the run tab menu. | Open; Open in new window | None. |
| 6 | History table rows (`RunHistory.tsx`) | Yes. The actions cell holds up to four buttons (Open, Continue, Save as project, Retrospective) plus the "Open in Live" badge, which wraps at 1024 px. | Open; Open in new window; Continue (when offered); Open outputs (when there are any); --- ; Save as project (built without "...", rule 6: the existing button never had it; chat, when offered; disabled with the scratch reason when it cannot); Retrospective (when offered) | Open: keep (primary). Continue: keep (the main next step). Outputs chip: keep (it carries the count). Save as project: remove. Retrospective: remove. Both move behind one visible More button on the row. |
| 7 | Schedule cards (`ScheduleRow.tsx`) | Yes for right click and keyboard, no for removal: each card has its own full-width action row, so it is not crowded. | Run now; Pause or Resume; Edit (built without "...", rule 6); --- ; Delete (D, existing confirm). All disabled with "Working on it" while an action of the card is in flight. Menu key / Shift+F10 work from any control in the card | Run now, Pause/Resume, Edit, Delete: keep all. |
| 8 | Outputs list rows and grid tiles (`OutputsList.tsx`, `OutputsGrid.tsx`) | Yes. Rows have no buttons; the actions live in the detail pane's More menu, one click and a selection away. | Open (selects it in the viewer); Open in default app (disabled with the existing hint when it cannot open); Show in folder (not for a missing file); Copy path | None removed. Delete, Rename, Revise and Save as stay in the detail menu (they need its dialogs and versions context). Not in select mode. |
| 9 | Org chart role nodes (`TeamView.tsx`, React Flow presentation) | Yes. Nodes have no buttons; add-a-report and remove are toolbar or Delete-key actions today. | Edit role (selects it, opens the Role panel); Add a report (the existing Add role with this role as manager); --- ; Remove role (D, existing undo row; disabled on the root with a reason) | Toolbar Add role: keep (primary, the visible path). |
| 10 | Usage ranked bars (`usage/RankedBars.tsx` `RowMenu`) | Yes, existed. Not migrated: it has its own keyboard model (Right arrow opens, Left closes, right-edge anchoring) checked by `e2e/usage-app.mjs`; folding that into the primitive would change behaviour. Left as is. | (unchanged) | (unchanged) |
| 11 | Org chart canvas background | No. Nothing is under the pointer, and the toolbar right above holds the same actions (Add role, Tidy layout, Templates). | - | - |
| 12 | Transcript messages, tool blocks, code blocks | No. The useful right click there is text: Copy, Select all, Copy link address, which the native menu (main) provides; code blocks keep their visible Copy button. A custom menu would fight text selection. | - | - |
| 13 | Run view live canvas (agent nodes) | No for now. Agent nodes are status displays; their only action (select, inspect) is a click. | - | - |
| 14 | Pocket Office people | No. People are buttons that open the role; a menu adds nothing. | - | - |
| 15 | Settings: connection cards | No. One card per provider, actions are setup flows (Connect, Sign out) shown in the card. | - | - |
| 16 | Settings: MCP servers, connector library rows (`McpSection.tsx`, `McpLibrarySection.tsx`) | Deferred. They already collapse secondary actions behind an inline "More actions" disclosure row (not a menu), with test and remove flows inside; replacing that pattern is a separate change. | - | - |
| 17 | Settings: skills (`SkillsSection.tsx`), skill library rows (`SkillLibrarySection.tsx`) | No. Two visible buttons per row (Edit, Remove) on a wide row are not crowded; a menu would only duplicate them. | - | - |
| 18 | Team files card, team catalog, decision cards | No. Cards whose buttons are the decision itself; hiding them would hide the decision. | - | - |
| 19 | Dashboard Needs you, Right now, Paused / Ended rows | No. The inline actions are the decision (Allow once / Deny, options) or a single Open. | - | - |

### Buttons removed (before / after)

| Surface | Before | After | e2e updated |
|---|---|---|---|
| History row (`RunHistory.tsx`) | Open, Continue, Save as project, Retrospective | Open, Continue, More actions (`history-more`); Save as project (`history-save-as-project`) and Retrospective (`history-retro`) are menu items | `e2e/assistants.mjs` |

## 4. Verification

- Unit: `lib/contextMenu.test.ts` (placement at a point and at an anchor, flips and clamps, roving index, type-ahead,
  the menu-key predicate, the native-menu predicate).
- e2e: `e2e/context-menus.mjs` (token free, mock adapter, 71 checks, 3 consecutive green runs on Windows): on run tabs,
  Knowledge rows and Dashboard tiles, open by right click, Shift+F10 and the Menu key; focus on the first item; arrows
  (wrapping), Home / End, type-ahead; Enter activation (Hide, Open, Open); Escape returning focus; the More button's
  `aria-expanded` and toggle; a wheel scroll outside closing the menu; the menu staying open through the tab strip's own
  scroll; the tile menu inside the window at 1024x640 in both themes. The native-menu rule is checked with
  script-dispatched `contextmenu` events (over a text selection in a row, in a text input placed in a row, in the
  Knowledge search field): the event is not cancelled and no custom menu opens. A real right click there would pop the
  platform menu from main, which e2e cannot dismiss. `e2e/team.mjs` `sectionNodeMenu` covers row 9;
  `e2e/assistants.mjs` the History More button (row 6). Rows 4, 5, 7 and 8 have no e2e of their own; they were walked
  on mock data (`docs/design/ux-review-context-menus.md`).
- Not verified: screen-reader speech; the native text menu itself (main, added in parallel) is not driven by e2e;
  Open in new window, Open folder, Show in folder and Open in default app from a menu (they hand off to the OS or a new
  window); edge flipping of a right-click menu at 1024x640; Windows high-contrast rendering of the menu edge.

## 5. Built (2026-11-18)

All of rows 1 to 9 are built as listed; none was dropped. Row 10 stays as it is. Notes from the UX walk and review:

- The Team canvas footer hint now ends "Shift+F10 or a right click shows more", since nodes have no visible button.
- Remove role keeps its existing confirm dialog and the undo row after it (rule 3: no change to destructive flows);
  the walk found the double safeguard heavy, left for a separate change.
- Disabled-item reasons show as a tooltip and as screen-reader text only; Knowledge rows have no helper line for the
  menu (the actions are also in the detail pane). Both left as they are.
- Repeating the same Outputs notice ("Copied the path.") is not announced again (pre-existing status-region pattern).
