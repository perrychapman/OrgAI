# To-dos

To-do lists the user keeps in the app: one per stored project (engagement or code project) and one for Chat. The
assistant adds an item when the user asks, for example "mark that for later". The user reads the list, edits it, and
starts a session from an item. Spec and behaviour rules: `docs/design/todos.md`. Each fact below says how it was
checked. "Unverified" means no test or run confirmed it.

## Contract

- `src/shared/types.ts` section "To-dos" (end of file) and `src/shared/todos.ts` (pure helpers). Unit-tested in
  `src/shared/todos.test.ts`.
- Channels and scopes:
  - `todos:list` is read.
  - `todos:save`, `todos:remove` and `todos:clearDone` are configure.
  - `todos:linkRun` is operate.
  - `todos:changed` is a desktop-only push through `DesktopHooks.todosChanged` (`index.ts`, every window, never on the
    bus or a socket). The event carries the scope and ids only, never item text.
  - Checked by `registry.test.ts`, `jsonRoundTrip.test.ts` (including `detail: null` over the wire), `params.test.ts`,
    `events.test.ts` and `secretChannels.test.ts`.
- Surfaces: `todos:list` answers on every surface. The writes and `linkRun` are wired for the desktop surface only for
  now, and every other surface gets `scope_denied` before the input is read (`dispatcher.ts`). To-dos are not
  desktop-only by design; the CLI has no to-do surface yet. Checked by reading the code; no dispatcher test drives a
  socket refusal.

## Main (`src/main/todos/`)

- `store.ts` `TodoStore`:
  - Stores `<data>/todos.json` as `{ version: 1, lists }`, keyed by `todoScopeKey`.
  - Writes are durable and atomic, and the good file is copied to `.bak` first.
  - An unreadable file (bad JSON, wrong shape, version other than 1, too big) is never overwritten. The store goes
    read-only and shows the `.bak` when that parses.
  - Junk items are dropped field by field on read and on write, including hidden characters in text and an item filed
    under the wrong list.
  - Checked by `store.test.ts`. The write path is listed in `writePathInventory.allowlist.ts`.
- `service.ts` `TodoService`:
  - Rebuilds every input with `cleanTodoScope` / `cleanTodoText`.
  - A project scope must name a stored, non-virtual project.
  - Main owns the id (`todo_` + 16 hex characters), the timestamps, `createdBy` / `editedBy` / `statusBy`, `source` and
    `startedRunIds`; input values for these are ignored.
  - `expectedUpdatedAt` that differs from the stored item is refused. One that is present but not a number is refused
    too.
  - `updatedAt` always increases. `linkRun` leaves it unchanged.
  - Caps: `TODOS_MAX_PER_SCOPE` items per list and `TODO_STARTED_RUNS_MAX` linked runs per item.
  - `linkRun` checks that the run exists and belongs to the item's list (bootstrap `runScope`: Chat runs belong to the
    Chat list, work runs to their project), then records the id only.
  - Agents:
    - Never remove items.
    - Never change the title or detail of an item the user created or edited ("Only the user can change that item;
      add a new one instead.").
    - May complete or reopen any item in their own list.
    - Get at most `TODO_RUN_WRITES_MAX` writes per run.
    - Adding an open item with the same title (case-insensitive) returns the existing item and writes nothing.
  - Every write pushes `todos:changed`.
  - Checked by `service.test.ts`.
- Project deletion: `projects:remove` (dispatcher) calls `TodoService.removeScope`, so the list goes with the project. A
  failure is logged and the orphan list cannot be reached. Checked by reading the code only; no test drives it.
- Wiring (`host/bootstrap.ts`): `TodoService` is built on every host. The agent side (`RunManagerOptions.todos`) is wired
  on the desktop host only, like the schedule tools. Checked by `harnessToolsTodos.test.ts` ("absent without the
  option").

## Runtime

- `todo_list` (`harnessTools.ts`, "To-dos" block):
  - One tool with `action: 'list' | 'add' | 'complete' | 'reopen' | 'update'` and optional `id`, `title` and `detail`.
    It takes no scope.
  - Offered only where RunManager bound `ctx.todos`, and only to the root (audience `root`; a bridged child's root
    loses it).
  - Non-blocking, no card.
  - `list` returns at most `TODO_TOOL_LIST_MAX` items between `<<<` / `>>>` fences, with every field passed through
    `datum()` (look-alike angle brackets, one line). A detail longer than 400 characters ends with a marker telling the
    model not to update the detail from the list.
  - Refusals read "REFUSED: <sentence>".
  - Checked by `harnessToolsTodos.test.ts`.
- `RunManager.bindTodos`:
  - Chat runs get the Chat list. Work runs (team or single) of a stored project get that project's list.
  - Setup-like runs, virtual-project runs and trust-restricted build sessions get no list. A build workspace is only
    allowed on MCP-assistant runs, which are setup-like.
  - The caller (run id, agent id, role name) is filled from the run.
  - Each changed item writes one harness transcript row on the root: "Added / Completed / Reopened / Updated to-do
    <title>".
  - Checked by `harnessToolsTodos.test.ts`, using a real `TodoService`.
- Spend: the tool definition adds about 531 to 559 characters to every root request on work, single and Chat runs.
  Budgets are raised and the tool is capped at 600 characters in `toolDefinitionSize.test.ts`.
- Prompt: `todosText()` (`prompts.ts`) is shown on the root when `flags.todos` is set, never on reports, setup-like
  runs or bridged children. Checked by `prompts.test.ts`.
- Adapters: Claude (`buildAgents`), Codex (`instructionsFor`) and the mock pass `todos: true` when `ctx.todos` is set
  and the run is not a bridged child; `prompts.ts` shows it only on the root. Checked by `claudeTodos.test.ts` (real
  `buildAgents`: root yes, reports no, none without `ctx.todos`, none for a bridged child) and a `codex.test.ts` case
  (fake app-server: root thread yes, report thread no, none without `ctx.todos`). The paragraph is not in
  `scripts/measure-prompt-size.mjs` output (a bare default run has no `ctx.todos`); no prompt budget test existed to change.
- Mock marker `[mock:todo]` (`todoMarkerSteps`, Chat and work runs, default script): the root calls the bound `todo_list`
  `add` (title "Follow up with Acme about the export format", detail about CSV as well as XLSX) and says "Added to your
  to-do list.". "Already on the list (open)" counts as added; a `REFUSED:` or "To-dos are not available" answer is said
  back as the tool's first line; without `ctx.todos` it says "To-dos are not available in this run.". Checked by
  `mockTodo.test.ts` with a fake `todos` context (tool call input, duplicate, refusal, none).

## Open and unverified

- Live Claude and Codex behaviour with the paragraph (whether the model follows it) is unverified.
- The per-run write count is held in memory: it resets after an app restart and is never pruned (small).
- A Chat run promoted to a project cannot be live (promotion refuses a live chain), so a live session never writes the
  wrong list. Checked by reading `quick/quickRuns.ts` `promote`.
- Not driven: the renderer, e2e, live Claude / Codex behaviour (whether models follow the "only when asked" rule), and
  macOS.
