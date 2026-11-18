# UX review: To-dos (first-time user, mock data)

- Reviewer: UX Researcher. No product code changed.
- Build: `695cd333` (`npm run build` clean). Ran with `ORGAI_MOCK=1` and a throwaway temp data dir (`launch()` from `e2e/lib.mjs`).
- Sizes and themes: 1600x1000 (dark; shots 11-14, 20-27, 40-42 are at about 1424x855 or 1600x1000 as the default window gave) and 1024x640, dark and light. One keyboard-only pass at 1024x640 dark.
- Compared with: `docs/design/todos.md` ("Renderer (as built)").
- Shots: `docs/design/ux-review-todos-shots/`. Walk scripts and raw results: `e2e/shots/ux/todos/` (gitignored).
- Walked on an engagement ("Acme audit"), a code project ("Code app") and Chat.

## Verdict: OK TO SHIP, with three should-fix items

The feature does what was asked and stays quiet. The core loop works on the first try and no item was lost or sent by accident: add, edit, complete, reopen, delete and clear done all behave; destructive steps ask first with plain copy; Start session only fills a draft and asks before replacing an unsent message; focus returns sensibly; nothing pulses, toasts or interrupts. The weak spot is the seams: the in-conversation confirmation is a pair of debug-looking rows that leak an internal id and do not say where the item went, and the prefilled new-session page gives no hint that it came from a to-do or that nothing has been sent. No blocker.

Rating key: blocker / should-fix / polish.

## Findings

### S1 (should-fix). The chat confirmation shows an internal id and does not say where the item went

Shot: `03-after-todo-marker.png`, `41-chat-after-marker`.
Repro: open any stored project, Live, send `Please keep the export notes in mind [mock:todo]`.
Seen in the transcript, in this order:
1. "Used todo list" with "Show details" (a tool row)
2. "Added to-do Follow up with Acme about the export format"
3. "Added to-do todo_ab03a53e77b3786b: Follow up with Acme about the export format." (the tool result)
4. the assistant's "Added to your to-do list."

Four lines say one thing; line 3 exposes `todo_ab03a53e77b3786b`; none says which list or links to it. The only other signal is the tab count going from nothing to "1", which a first-time user is unlikely to connect to the message (item 1 of the brief: it is clear that something happened, not where or how to get to it).
Smallest fix: (a) collapse the tool row and the tool-result row into the single row 2; (b) drop the id from user-visible text; (c) make row 2 end with a link: "Added to your to-do list for this project. View list". Recommended copy: "Added “Follow up with Acme about the export format” to your to-dos." with a "View to-dos" button that opens the tab. Keep the quiet count; do not add a toast.
Note: whether a real model's own reply line would also appear is unverified; the mock says "Added to your to-do list." with no pointer.

### S2 (should-fix, done: `TodoDraftNote`). The prefilled session page does not say it is a draft from a to-do

Shots: `25-start-session-draft.png`, `52-keyboard-start-session-1024.png`.
Repro: To-dos tab, "Start session" on an item.
You land on Live > "New run" with the heading "Give Engagement Lead something to do" and the box already holding "To-do: Draft the invoice summary for Acme" plus the detail. Nothing says it came from a to-do, that it has not been sent, or that the item will stay on the list with a link. The box is focused, which helps, and Start is a plain button, so the risk of a surprise send is low, but a user who clicked Start session expecting it to start may not notice they must press Start. The tab also switches away from To-dos, so the list is gone from view.
Smallest fix: one quiet line under the composer when a to-do prefill is pending: "Drafted from your to-do. Nothing is sent until you press Start. The item stays on your list." Recommended: same text on the Chat start page.
After sending (`26-after-send-run-link.png`) the item shows "Started from this: Session 1" and stays open, which is correct and reads well.

### S3 (should-fix, done: the link uses the run's own label). Run naming does not match: "Session 1" vs "R2 To-do Draft the invoice"

Shot: `26-after-send-run-link.png`.
The item's link says "Session 1" but the sidebar and run tab call the same run "R2 To-do Draft the invoice". Two runs on the list would be "Session 1, Session 2", while the sidebar says R2, R3. A user cannot match them. The "To-do " prefix also becomes part of the run title.
Smallest fix: label the link with the run's own name ("R2 To-do Draft the invoice" shortened), or at least "Run R2". Consider dropping the "To-do: " prefix from the prefilled text so the run title is the task ("Draft the invoice summary for Acme").

### S4 (polish). No sign of when or from which conversation a hand-added item came, and the source link name is role-based

Shots: `14-eng-two-more-added.png`, `42-chat-todos.png`.
Assistant items show "Added by Engagement Lead · Open conversation" (Chat: "Added by Assistant"), which answers "where did this come from" well. Hand-added items show nothing, and no item shows a date. With 14 items there is no way to tell old from new except order (newest first). Polish: show a muted "Added today" / date on each row; call the Chat one "Added by Chat".

### P1 (polish). The add field has no placeholder and the empty state is the only teaching

Shot: `11-eng-todos-empty-1600-dark.png`.
The field is labelled "Add a to-do" above and has no placeholder. The empty state, "Say 'put that on my to-do list' in a conversation, or add one here.", teaches the phrase and is good, but it uses straight quotes and sits tiny under the field in muted text, and it vanishes after the first item, so a user with items never learns it. Fix: placeholder "e.g. Follow up with Acme" and keep the phrase in a one-line hint under the list heading, "Tip: say “put that on my to-do list” in any conversation." (always visible, one line).

### P2 (polish). "Clear done" dialog title and the unnamed count in the sidebar

Shot: `24-clear-done-confirm.png`.
Dialog "Clear done to-dos?" reads awkwardly; use "Remove done to-dos?" with button "Remove 1 done to-do" (the button currently repeats "Clear done"). The dialog does not name what will be removed when more than one is done; "Remove 3 done to-dos from this list? This cannot be undone." already gives the count, good.
Separately the sidebar's project line says "1 open" (open sessions) while the tab count says "1" (open to-dos). Same word, different thing, two places. Fix: sidebar "1 session open"; leave the tab as is.

### P3 (polish). Tab count is faint

Shots: `11`, `13`, `30-todos-1024-light.png`.
The "1" after "To-dos" is very dim in dark and light. It is meant to be quiet, and screen readers get "To-dos, 1 open to-do", so this is not blocking; a slightly stronger tone would make it findable. I did not measure the contrast ratio.

### P4 (polish). Newest-first order, reopened items jump to the top

Observed: a reopened item moves to the top of the open list, above items added later by hand. Acceptable, but a user reopening something may lose it. Fix: keep reopened items in their original place or flash the row's focus (focus already moves to its checkbox, so this is minor).

## Answers to the brief's questions

1. Chat confirmation: it happened (the assistant says so, the count goes to 1). One click is not quite enough to reach it from the conversation: there is no link, so the user must find the tab (see S1). Quiet enough; arguably too quiet about where.
2. Finding the list: "To-dos" with a count sits in the project topbar, between Knowledge and Team, in the first view after creating a project. I found it unprompted. Empty state teaches the phrase (P1).
3. Hand operations: add (Enter or button; field clears and keeps focus; a 210-character title is refused in plain words, "The title is longer than 200 characters. Shorten it and put the rest in the details."), edit (inline form, focus on title, saved items return focus to Edit), complete (strike-through, moves to a collapsed "Done (n)"), reopen (back to the open list), delete and clear done (both confirm, "This cannot be undone", Cancel is the default focus and Escape cancels and returns focus to the row). No surprises. The confirm for a single delete is slightly heavy for a one-line item but is consistent with the app.
4. Start session: see S2 and S3. With an existing unsent message the app asks "Replace your unsent message?" with "Cancel" and "Replace message"; cancelling leaves focus on the Start session button. Item stays open and gains a run link after the send.
5. Not too aggressive: nothing nags, pulses, toasts or fills the conversation. The only clutter is the verbose tool rows (S1). Missing sense of management: no date and no hand-added source (S4).
6. Themes and sizes: no horizontal or page scroll at either size (`scrollWidth` check, both themes); at 1024x640 the sidebar collapses to icons and the list fills the width; 14 items scroll inside the main area; the edit form opens in place at the bottom of the list and a 190-character title scrolls inside a single-line input (the full text is not visible while editing, minor). Light and dark both read well (`30-todos-1024-light.png`, `30-todos-1024-dark.png`).
7. Keyboard pass (1024x640, dark): the tab can be focused and opened with Enter; Tab goes add field, Add, checkbox, Details, Open conversation, Start session, Edit, Delete, then out of the list. Every stop shows a visible ring (2px solid outline). Enter adds, Space completes, Delete opens a confirm with focus on Cancel, Escape closes and returns focus to Delete, Start session moves focus into the composer. A polite live region announced "Added “Keyboard only item”." and "Marked “Keyboard only item” done." The row checkbox name was blank in my `aria-label` probe (it is likely named by its label, which I did not check). Screen-reader speech was not heard.
8. No View menu item, shortcut or self-help entry: it did not hurt me in the walk, because the topbar tab was found at once. It would hurt on Chat if the user lives in the Chat tab, and with the tab hidden behind a narrow window. Suggest the menu item and an accelerator later, not now.

## Not driven

- Live model behaviour: whether a real assistant words the confirmation, adds items unprompted, or declines is unverified; the mock only adds on `[mock:todo]`.
- The "Open conversation" link and the Details disclosure after the source run is removed or ended were not exercised.
- A refused or read-only store ("unavailable" state), an item changed in another window (`expectedUpdatedAt` refusal) and the 200-item cap were not reproduced.
- The "Replace message" confirm was seen, but replacing and then sending did not get a link check; I did not confirm the link is dropped when a prefilled draft is emptied.
- MCP and Skill assistants: my probe returned the same three tabs ("Live, History, To-dos 1") for the MCP page, so I could not confirm the tab is absent there (the navigation click likely did not change the page). Not reliable; unverified.
- Relaunch persistence, macOS, screen-reader speech and the exact contrast ratio of the count.
