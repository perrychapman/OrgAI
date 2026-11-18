# To-dos

Status: the shared contract, the pure helpers and the main-process side are built. The adapter prompt flag, the mock
marker and the renderer are still to come.

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
  card, and each change writes one transcript row such as "Added to-do <title>".
- Prompt paragraph `todosText()`: written and tested, but not shown yet. The adapters must pass `flags.todos` first.

## Still to build

- Adapters: pass `todos: !!ctx.todos` to the root's prompt flags (Claude, Codex, mock), and add the mock marker
  `[mock:todo]`.
- Renderer (UI lead): to-do panel for a project and for Chat, add / edit / complete / remove / clear done, "Start a
  session" that prefills the draft, live updates from `onTodosChanged`, both themes and window sizes, an e2e script.
