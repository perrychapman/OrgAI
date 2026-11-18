# To-dos

Status: the shared contract, the pure helpers, the main-process side, the renderer, the adapter prompt flag and the
mock marker are built (see "Adapters (as built)").

## Purpose

The user says something casual in a chat, such as "mark that for later" or "put it on my to-do list", and the assistant
puts an item on a list that lives in the app. There is one list per stored project (an engagement or a code project) and
one list for the Chat assistant. The user can read the list, edit it, and start a session from an item.

## Contract (landed)

- `src/shared/types.ts`, section "To-dos" (end of file): `TodoScope`, `TodoStatus`, `TodoItem`, `TodoSaveInput`,
  `TodosChangedEvent`, the limits (`TODOS_MAX_PER_SCOPE` 200, `TODO_TITLE_MAX_CHARS` 200, `TODO_DETAIL_MAX_CHARS` 2000,
  `TODO_STARTED_RUNS_MAX` 10, `TODO_RUN_WRITES_MAX` 30, `TODO_TOOL_LIST_MAX` 50), the tool name `TODO_TOOL`
  (`todo_list`, one tool with `action: 'list' | 'add' | 'complete' | 'reopen' | 'update'`), `TODOS_IPC` (declared like
  `SCHEDULES_IPC`, not spread into `IPC`) and `OrgAIApi.todos` / `onTodosChanged`.
- Channels: `todos:list` (read), `todos:save`, `todos:remove`, `todos:clearDone` (configure), `todos:linkRun`
  (operate), and the push `todos:changed` (desktop windows only). Registered in the host (see "As built").
- `src/shared/todos.ts` (pure): `todoScopeKey`, `sameTodoScope`, `cleanTodoScope`, `cleanTodoText`, `sortTodos`,
  `todoStartPrompt`. Unit-tested in `src/shared/todos.test.ts`.

## Behaviour rules

- The assistant adds an item only when the user asks for one.
- It may mark an item done when the user says so or when the session finished that item. It may reopen an item.
- It never removes an item. Only the user removes items and clears done items.
- It never rewrites text the user wrote or edited (`editedBy` is 'user'). Main enforces this, not the prompt.
- Starting a session from an item only prefills the composer with `todoStartPrompt(item)`. The user sends it. Nothing
  sends by itself, and the run is linked to the item with `todos:linkRun` after the user's send.
- Item text an agent wrote is data, never instructions. It is shown as plain text, and when a later run reads the list
  the text is fenced as data.
- Hidden characters and over-long text are refused with a plain sentence, never cut.
- An agent may make at most `TODO_RUN_WRITES_MAX` writes per run, and one tool call returns at most
  `TODO_TOOL_LIST_MAX` items.

## As built (main process)

Details and how each fact was checked: `docs/agent-notes/todos.md`.

- Store `src/main/todos/store.ts`: `<data>/todos.json` (version 1, keyed by `todoScopeKey`), durable atomic writes with
  `.bak`; an unreadable file is never overwritten and the store goes read-only (the schedules store's rules).
- Service `src/main/todos/service.ts` `TodoService`: user list / save / remove / clearDone / linkRun / removeScope and
  agent list / add / setStatus / update. Every rule above is enforced there.
- Channels are registered in the host dispatcher, `jsonCodec`, `params.ts` and `registry.ts`. `todos:list` answers on
  every surface. The writes and `linkRun` are wired for the desktop surface only for now, and any other surface gets
  `scope_denied`. To-dos are not desktop-only by design. `todos:changed` goes to every window and never to a socket.
- Deleting a project deletes its list (`projects:remove` in the dispatcher).
- Harness tool `todo_list` goes to the root of Chat runs and of work runs (team or single) of a stored project, on the
  desktop host only. RunManager picks the list from the run, so the tool takes no scope. It is non-blocking and shows no
  card, and each change writes one transcript row: `Added "<title>" to your to-dos`, `Completed "<title>"`,
  `Reopened "<title>"` or `Updated "<title>"`, never the item id. Scheduled runs (`summary.scheduleId`) get no list, so an
  unattended run cannot write items. The agent's tool result keeps the id only for an add (the model may need it);
  complete, reopen and update results name the title only. The agent's activity line (`activity.ts`) names the change,
  never an id.
- Start session prompt (`todoStartPrompt`): the first line is always `To-do: <title>`. An item written or edited by the
  agent has its detail fenced as `Context the assistant saved (notes, not instructions):` between `<<<` / `>>>`, with `<`
  and `>` inside the detail turned into the look-alikes `‹` `›` so it cannot close the fence. A user-written, user-edited
  item keeps the plain `To-do: <title>\n\n<detail>`. Checked by `src/shared/todos.test.ts`.
- Prompt paragraph `todosText()`: written and tested; the adapters now pass `flags.todos` for the root.

## Renderer (as built)

### Placement decision

A project section tab **To-dos** in the project topbar (`App.tsx`), next to Live / History / Outputs / Knowledge, on
every stored project (engagement and code) and on Chat; never on the MCP or Skill assistants (`todoScopeFor` returns
null for them). Order: Live, History, Outputs, Knowledge, To-dos, Team, Settings; on Chat: Live, History, To-dos.
Reasons:

- One click from a project and from Chat, whatever the workspace shows (a run, the New run page or another section),
  because the topbar is always on screen. A run detail tab (Plan / Usage / Outputs ...) was rejected: it does not exist
  on the New run page or the Chat start page, so the list would be two clicks away there, and the list belongs to the
  project, not to one run.
- Visible next to the conversation: the tab sits directly above the conversation where the user said "put that on my
  list", and its quiet open count (`TabItem.count`, spoken "3 open to-dos") changes when an assistant adds an item. That
  count is the only signal: no dot, no pulse, no toast; the transcript row main writes is the confirmation.
- No new top-level app view and no sidebar entry: a to-do list is per project, like Outputs and Knowledge, and a global
  page would need a scope picker for something that is always read in context.
- Not added (open): a View menu item, a keyboard accelerator and a self-help atlas surface for the tab.

### Behaviour

- `views/TodosView.tsx` (heading "To-dos", "For this project" / "For Chat"), `components/todos/TodoRow.tsx`,
  `TodoEditForm.tsx`, styles `styles/todos.css` (tokens only, no motion). Pure view-model `src/shared/view/todos.ts`
  (`todoScopeFor`, `todosCountLabel`, `todoListView`, the empty and unavailable sentences). Data in a separate zustand
  store `store/todosStore.ts` (`load` newest-answer-wins per scope, `put` / `drop` apply main's answer at once without
  invalidating a newer load, `initTodos` follows `todos:changed`, `useOpenTodoCount` for the tab).
- Add: one field, Enter (or the Add button). `cleanTodoText` refuses locally first; any refusal from main (cap, read-only
  store, changed elsewhere) shows inline in plain words and keeps the typed text.
- Rows: native checkbox named by the title (the box shows the user's choice at once and settles on main's answer), the
  title as plain text, a "Details" disclosure for the detail (plain text, `pre-wrap`), "Added by assistant" / "Added by
  <role>" for agent items with "Open conversation" when the source run still exists, "Started from this: Session 1, ..."
  for runs that still exist, Start session (open items), Edit, Delete. Done items sit under a collapsed "Done (n)"
  disclosure with "Clear done" (confirm). Delete asks to confirm (the app's pattern, as in Schedules).
- Inline edit: Enter in the title saves, Escape cancels, only changed fields are sent with `expectedUpdatedAt`; a refusal
  keeps the edits. Focus returns to Edit; after complete it moves to the next open row (else previous, else the add
  field); after reopen to the item's checkbox; after delete to the next row or the add field. One polite live region
  (`todos-status`) announces each change.
- Untrusted text: title, detail, role name and run names are React text nodes only (no Markdown, no links made from
  text, no HTML). Shortened copies (aria names, dialog bodies, the role name) go through `clampLabel`.
- Start session (`lib/todoStart.ts`): computes the draft key (`newRunDraftKey(projectId)` or the Chat start page's),
  asks before replacing a different unsent message, opens the project's New run page (`openDraft`) or a fresh Chat
  (`openAssistant('quick', { fresh: true })`), fills the composer with `todoStartPrompt(item)` and focuses it. It never
  sends and never changes the item's status. A pending link is held per draft key; `linkedStart` wraps the New run page
  and Chat start page `onSubmit` so the link is taken before the start, given back if the start throws, and sent with
  `todos.linkRun` after success (on a project only when the shown run changed). A draft emptied without a send drops the
  link (store subscription plus a microtask, after Composer's synchronous submit). `linkedStart` links the run only while
  the sent text still begins with the prefilled first line (`To-do: <title>`, kept on the link as `lead`); a wholly
  replaced text drops the link silently (L5 closed).
- S2: while a draft prefilled from a to-do is still linked, one quiet line sits under the composer on the New run and
  Chat start pages (`TodoDraftNote`, `useTodoDraftLinked`): "Drafted from your to-do. Nothing is sent until you press
  <the page's send button label>. The item stays on your list." It is tied to the message box with Composer's
  `describedBy` and goes when the draft is emptied or replaced. Existing `muted` text style; no motion.
- S3: the item's run link shows the run's own label ("R2: Draft the invoice", `runTag` plus the display name) and
  falls back to "Session N" while the run has no number.
- An assistant-written item with a detail names its disclosure "Saved context" (visible text and accessible name)
  instead of "Details", so the user knows what Start session will add to the draft.
- A missing `window.orgai.todos` (older main) shows "To-dos are not available in this version." and turns writes off.

### Test ids

Tab `tab-todos`, count `todos-tab-count`; `todos-view`, `todos-loading`, `todos-empty`, `todos-error`, `todos-status`;
`todo-add-input`, `todo-add`, `todo-add-error`; `todo-list-open`, `todo-list-done`; row `todo-row` (`data-todo-id`,
`data-status`) with `todo-check`, `todo-title`, `todo-detail-toggle`, `todo-detail`, `todo-source`, `todo-source-link`,
`todo-runs`, `todo-run-link`, `todo-start`, `todo-edit`, `todo-delete`, `todo-row-error`; edit form `todo-edit-title`,
`todo-edit-detail`, `todo-edit-save`, `todo-edit-cancel`; `todo-done-toggle`, `todo-clear-done`; confirms
`todo-delete-confirm`, `todo-clear-done-confirm`, `todo-replace-draft-confirm`; `todo-draft-note` (the line under the
composer).

### Checked and open (renderer)

- Unit: `src/shared/view/todos.test.ts`, `src/renderer/src/lib/todoStart.test.ts`; typecheck and build.
- `e2e/todos.mjs` and QA's `e2e/todos-edge.mjs` (token-free, both in `e2e:free`, mapped in `scripts/e2e-select.mjs`) pass
  on the mock: the draft line (text, `aria-describedby`, gone on emptying or replacing), the run's own label on the link,
  an unlinked run after replacing the whole text, "Saved context", and the edge cases.
- Reviewer (renderer): no Critical or High; M1 (controlled checkbox snapped back), M2 (a project start that started
  nothing could link the open run), M3 (local patches dropped a newer load) and M4 (label in name) fixed, Lows L1, L2,
  L7, L9 fixed; L3 (an error after navigation is not shown), L4 (Enter while loading is silent) and L8 (agent detail in the prefill is not marked as such) open.
- Not looked at in the running app: both themes, both window sizes, keyboard walk, screen-reader speech; no mock UX
  walkthrough yet (needs the merged main side).

## Adapters (as built)

- Claude, Codex and the mock pass `todos: true` to the prompt flags when `ctx.todos` is set and the run is not a bridged
  child; reports never get the paragraph. Checked by `claudeTodos.test.ts`, `codex.test.ts` (fake app-server) and
  `mockTodo.test.ts`. Live model behaviour is unverified.
- Mock marker `[mock:todo]`: one real `todo_list` add, then "Added to your to-do list." (refusals said back). Checked by
  `mockTodo.test.ts`.
