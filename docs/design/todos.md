# To-dos

Status: the shared contract and pure helpers are landed. Everything else is not built yet.

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
  (operate), and the push `todos:changed`. They are not registered in the host dispatcher, `jsonCodec`, `params.ts` or
  `registry.ts` yet; the main lead does that together with the handlers.
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

## To build (not built yet)

- Main (runtime lead): store (`<data>/todos.json`, durable atomic writes like the schedules store), service
  (save, remove, clearDone, linkRun, the editedBy rule, expectedUpdatedAt check, the per-scope and per-run limits),
  host channel registration and handlers, the `todos:changed` push to every window, the `todo_list` harness tool and
  its prompt text on Chat and project roots, mock marker for tests.
- Renderer (UI lead): to-do panel for a project and for Chat, add / edit / complete / remove / clear done, "Start a
  session" that prefills the draft, live updates from `onTodosChanged`, both themes and window sizes, an e2e script.
