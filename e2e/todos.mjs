// Token-free. Mock adapter, temp ORGAI_DATA_DIR. To-dos (docs/design/todos.md): the project To-dos tab (empty state, add with
// Enter, edit title and detail, detail shown as plain text, title length refusal, complete / Done section / reopen, Clear done
// and Delete with confirms), "Start a session" from an item (the composer is prefilled and nothing is sent; after the user's
// Send the run is linked to the item with a run link and the item stays open), the same on Chat, an item the assistant adds
// (`[mock:todo]`, source label and link, no toast) and persistence (restart on the same data dir keeps both lists and
// statuses). Waits on conditions, not fixed sleeps.
import { check, createProject, endSession, finish, launch, log, makeFixtureRepo, openProject, relaunch, removeFixture, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'

const PROJECT = 'E2E todos (orgai test)'
const repo = makeFixtureRepo('todos')
const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim()
const EMPTY_TEXT = "Say 'put that on my to-do list' in a conversation, or add one here."
const AGENT_TITLE = 'Follow up with Acme about the export format'

let { app, page, shot } = await launch({ shotPrefix: 'todos' })
page.setDefaultTimeout(10_000)

const T = (id) => page.locator(`[data-testid=${id}]`)
const visible = async (sel) => (await page.locator(sel).count()) > 0 && (await page.locator(sel).first().isVisible())
/** Poll `fn` until it returns a truthy value (returned) or the deadline passes (null). */
async function until(fn, ms = 20_000, every = 250) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() > end) return null
    await sleep(every)
  }
}
const row = (title) => T('todo-row').filter({ has: page.locator('[data-testid=todo-title]', { hasText: title }) })
const rows = () => T('todo-row').count()
const store = (scope) => page.evaluate((s) => window.orgai.todos.list(s), scope)
const runsOf = (projectId) => page.evaluate((id) => window.orgai.runs.list(id), projectId)
const menu = (id) =>
  app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId)
    if (!item) throw new Error(`no menu item ${itemId}`)
    item.click()
  }, id)
const chatField = () => page.locator('[data-testid=assistant-start-quick] .composer textarea')
const mainText = () => page.evaluate(() => document.querySelector('#main-content')?.textContent ?? '')

async function openTodosTab() {
  await T('tab-todos').click()
  await T('todos-view').waitFor({ timeout: 10_000 })
  await until(async () => (await T('todos-loading').count()) === 0, 10_000)
}
const openChatTodos = async () => {
  await page.locator('[data-testid=nav-assistant][data-id=quick]').click()
  await openTodosTab()
}
const openProjectTodos = async () => {
  await openProject(page, PROJECT)
  await openTodosTab()
}
async function addItem(title) {
  const before = await rows()
  await T('todo-add-input').fill(title)
  await T('todo-add-input').press('Enter')
  await until(async () => (await rows()) === before + 1, 10_000)
}
const count = async () => clean(await T('todos-tab-count').innerText().catch(() => ''))
const openDone = async () => {
  if ((await T('todo-done-toggle').getAttribute('aria-expanded')) !== 'true') await T('todo-done-toggle').click()
}

try {
  const proj = await createProject(page, { path: repo, name: PROJECT })
  check(!!proj, 'seed: the mock project exists')
  const pid = proj?.id
  const PSCOPE = { kind: 'project', projectId: pid }
  const CSCOPE = { kind: 'chat' }

  // ---------- 1. Project list ----------
  check(await visible('[data-testid=tab-todos]'), '1 the project topbar has a To-dos tab')
  await openTodosTab()
  check(await visible('[data-testid=todos-empty]'), '1 the empty state shows with no items')
  check(clean(await T('todos-empty').innerText()) === EMPTY_TEXT, '1 the empty state text is exact', clean(await T('todos-empty').innerText()))
  await shot('project-empty')

  await addItem('Write the release notes')
  await addItem('Check the export format')
  check((await rows()) === 2, '1 two items were added with Enter', String(await rows()))
  check((await T('todo-add-input').inputValue()) === '', '1 the add field is cleared after adding')
  check(await until(async () => (await count()).includes('2'), 5000), '1 the tab count shows 2 open items', await count())
  check((await store(PSCOPE)).length === 2, '1 the store holds two items for the project')

  // edit title and add a detail (rendered literally)
  const DETAIL = 'Include <b>x</b> and [link](http://x) as written.'
  await row('Write the release notes').locator('[data-testid=todo-edit]').click()
  await T('todo-edit-title').fill('Write the v1 release notes')
  await T('todo-edit-detail').fill(DETAIL)
  await T('todo-edit-save').click()
  await row('Write the v1 release notes').waitFor({ timeout: 10_000 }).catch(() => {})
  const edited = row('Write the v1 release notes')
  check((await edited.count()) === 1, '1 the edited title shows')
  await edited.locator('[data-testid=todo-detail-toggle]').click()
  await edited.locator('[data-testid=todo-detail]').waitFor({ timeout: 5000 }).catch(() => {})
  const det = edited.locator('[data-testid=todo-detail]')
  check(clean(await det.innerText().catch(() => '')) === DETAIL, '1 the detail shows as plain text', clean(await det.innerText().catch(() => '')))
  check((await det.locator('b, a').count()) === 0, '1 the detail has no b or a element inside (rendered literally)')
  await shot('project-detail')

  // too-long title
  const long = 'x'.repeat(201)
  await T('todo-add-input').fill(long)
  await T('todo-add-input').press('Enter')
  await T('todo-add-error').waitFor({ timeout: 5000 }).catch(() => {})
  check(await visible('[data-testid=todo-add-error]'), '1 a 201 character title shows the add error')
  check((await T('todo-add-input').inputValue()) === long, '1 the typed text is kept after the refusal')
  check((await rows()) === 2 && (await store(PSCOPE)).length === 2, '1 nothing was added for the long title')
  await T('todo-add-input').fill('')

  // complete one
  await row('Write the v1 release notes').locator('[data-testid=todo-check]').click()
  check(await until(async () => (await store(PSCOPE)).some((i) => i.title === 'Write the v1 release notes' && i.status === 'done'), 10_000), '1 completing stores status done')
  check(await until(async () => (await count()).includes('1') && !(await count()).includes('2'), 5000), '1 the tab count drops to 1', await count())
  check((await T('todo-done-toggle').getAttribute('aria-expanded')) !== 'true', '1 the Done section is collapsed by default')
  check((await T('todo-list-open').locator('[data-testid=todo-row]').count()) === 1, '1 one item stays in the open list')
  await openDone()
  check((await T('todo-list-done').locator('[data-testid=todo-row]').count()) === 1, '1 the done item shows under Done')
  check((await T('todo-list-done').locator('[data-testid=todo-row]').first().getAttribute('data-status')) === 'done', '1 the done row has data-status=done')
  await shot('project-done')

  // reopen
  await row('Write the v1 release notes').locator('[data-testid=todo-check]').click()
  check(await until(async () => (await T('todo-list-open').locator('[data-testid=todo-row]').count()) === 2, 10_000), '1 reopening moves the item back to the open list')
  check(await until(async () => (await count()).includes('2'), 5000), '1 the count is 2 again', await count())

  // complete again, Clear done with confirm
  await row('Write the v1 release notes').locator('[data-testid=todo-check]').click()
  await until(async () => (await T('todo-clear-done').count()) > 0, 10_000)
  await openDone()
  await T('todo-clear-done').click()
  await T('todo-clear-done-confirm').waitFor({ timeout: 5000 }).catch(() => {})
  check(await visible('[data-testid=todo-clear-done-confirm]'), '1 Clear done asks for confirmation')
  check((await store(PSCOPE)).length === 2, '1 nothing is cleared before the confirm')
  await T('todo-clear-done-confirm').click()
  check(await until(async () => (await store(PSCOPE)).length === 1, 10_000), '1 Clear done removed the done item')
  check((await row('Write the v1 release notes').count()) === 0, '1 the cleared row is gone')

  // delete the other with confirm
  await row('Check the export format').locator('[data-testid=todo-delete]').click()
  await T('todo-delete-confirm').waitFor({ timeout: 5000 }).catch(() => {})
  check(await visible('[data-testid=todo-delete-confirm]'), '1 Delete asks for confirmation')
  check((await row('Check the export format').count()) === 1, '1 the row stays until the confirm')
  await T('todo-delete-confirm').click()
  check(await until(async () => (await store(PSCOPE)).length === 0, 10_000), '1 Delete removed the item after the confirm')
  check(await until(async () => await visible('[data-testid=todos-empty]'), 5000), '1 the empty state is back')

  // ---------- 2. Start a session from a project item ----------
  await addItem('Draft the changelog')
  // add a detail so the prefill covers title and detail
  await row('Draft the changelog').locator('[data-testid=todo-edit]').click()
  await T('todo-edit-detail').fill('Group by area.')
  await T('todo-edit-save').click()
  await until(async () => (await store(PSCOPE))[0]?.detail === 'Group by area.', 10_000)
  const runsBefore = (await runsOf(pid)).length
  await row('Draft the changelog').locator('[data-testid=todo-start]').click()
  const composer = page.locator('.composer textarea').first()
  await composer.waitFor({ timeout: 10_000 }).catch(() => {})
  const wantPrefill = 'To-do: Draft the changelog\n\nGroup by area.'
  check(await until(async () => (await composer.inputValue()) === wantPrefill, 10_000), '2 Start a session opens the New run page with the prefilled composer', JSON.stringify(await composer.inputValue().catch(() => '')))
  await sleep(500)
  check((await runsOf(pid)).length === runsBefore, '2 nothing was sent: no new run appeared')
  check(!((await store(PSCOPE))[0]?.startedRunIds?.length), '2 the item has no linked run before Send')
  await shot('project-start-prefill')
  await composer.press('Enter')
  const linked = await until(async () => (await store(PSCOPE))[0]?.startedRunIds?.[0], 30_000)
  const projRuns = await runsOf(pid)
  check((await runsOf(pid)).length === runsBefore + 1, '2 pressing Send started one run', String(projRuns.length))
  check(!!linked && projRuns.some((r) => r.id === linked), '2 startedRunIds[0] is the new run', String(linked))
  check((await store(PSCOPE))[0]?.status === 'open', '2 the item stays open')
  await endSession(page)
  await openProjectTodos()
  check(await until(async () => (await row('Draft the changelog').locator('[data-testid=todo-run-link]').count()) >= 1, 10_000), '2 the row shows a run link')
  await shot('project-run-link')

  // ---------- 3. Chat list ----------
  await openChatTodos()
  check(await visible('[data-testid=todos-empty]'), '3 the Chat list starts empty (separate from the project list)')
  await addItem('Ask about the weather')
  check((await store(CSCOPE)).length === 1, '3 the Chat item is stored under the chat scope')
  await row('Ask about the weather').locator('[data-testid=todo-check]').click()
  check(await until(async () => (await store(CSCOPE))[0]?.status === 'done', 10_000), '3 completing a Chat item stores done')
  await openDone()
  await row('Ask about the weather').locator('[data-testid=todo-check]').click()
  check(await until(async () => (await store(CSCOPE))[0]?.status === 'open', 10_000), '3 reopening a Chat item stores open')
  await addItem('Remove me')
  await row('Remove me').locator('[data-testid=todo-delete]').click()
  await T('todo-delete-confirm').click()
  check(await until(async () => (await store(CSCOPE)).length === 1, 10_000), '3 deleting a Chat item works')

  const chatBefore = (await runsOf('quick')).length
  await row('Ask about the weather').locator('[data-testid=todo-start]').click()
  await T('assistant-start-quick').waitFor({ timeout: 10_000 }).catch(() => {})
  check(await until(async () => (await chatField().inputValue()) === 'To-do: Ask about the weather', 10_000), '3 Start a session prefills the Chat start page', JSON.stringify(await chatField().inputValue().catch(() => '')))
  await sleep(500)
  check((await runsOf('quick')).length === chatBefore, '3 nothing was sent on Chat')
  await shot('chat-start-prefill')
  await chatField().press('Enter')
  await page.locator('.run-tab[aria-selected=true]').first().waitFor({ timeout: 20_000 }).catch(() => {})
  const chatLinked = await until(async () => (await store(CSCOPE)).find((i) => i.title === 'Ask about the weather')?.startedRunIds?.[0], 30_000)
  check(!!chatLinked && (await runsOf('quick')).some((r) => r.id === chatLinked), '3 startedRunIds[0] is the new Chat run', String(chatLinked))
  check((await store(CSCOPE)).find((i) => i.title === 'Ask about the weather')?.status === 'open', '3 the Chat item stays open')

  // ---------- 4. An item the assistant adds ----------
  await endSession(page)
  await menu('ask-about-orgai')
  await T('assistant-start-quick').waitFor({ timeout: 10_000 })
  await chatField().fill('Please remember this [mock:todo]')
  await chatField().press('Enter')
  await page.locator('.run-tab[aria-selected=true]').first().waitFor({ timeout: 20_000 })
  check(!!(await until(async () => (await mainText()).includes('Added to your to-do list.'), 30_000)), '4 the mock replies "Added to your to-do list."')
  check(!!(await until(async () => (await store(CSCOPE)).some((i) => i.title === AGENT_TITLE && i.createdBy === 'agent'), 10_000)), '4 the item is stored with createdBy agent')
  const toasts = await page.locator('.toast, [data-testid=toast]').count()
  if (toasts) check(false, '4 no toast announces the added item', String(toasts))
  else check(true, '4 no toast announces the added item')
  await endSession(page)
  await openChatTodos()
  check(!!(await until(async () => (await row(AGENT_TITLE).count()) === 1, 10_000)), '4 the Chat list shows the assistant item')
  check(!!(await until(async () => (await count()).includes('2'), 5000)), '4 the Chat tab count rose to 2 open items', await count())
  const src = row(AGENT_TITLE).locator('[data-testid=todo-source]')
  check(/^Added by /.test(clean(await src.innerText().catch(() => ''))), '4 the row says "Added by ..."', clean(await src.innerText().catch(() => '')))
  await shot('chat-agent-item')
  await row(AGENT_TITLE).locator('[data-testid=todo-source-link]').click()
  check(!!(await until(async () => (await mainText()).includes('Added to your to-do list.'), 15_000)), '4 the source link opens the conversation')

  // ---------- 5. Persistence ----------
  // Put one done item on each list so statuses are checked too.
  await openChatTodos()
  const weather = (await store(CSCOPE)).find((i) => i.title === 'Ask about the weather')
  await page.evaluate((i) => window.orgai.todos.save({ id: i.id, scope: i.scope, status: 'done' }), weather)
  const chatSnapshot = (await store(CSCOPE)).map((i) => `${i.title}|${i.status}`).sort()
  const projSnapshot = (await store(PSCOPE)).map((i) => `${i.title}|${i.status}`).sort()
  await endSession(page)
  ;({ app, page, shot } = await relaunch(app, { shotPrefix: 'todos-restart' }))
  page.setDefaultTimeout(10_000)
  await openChatTodos()
  await openDone().catch(() => {})
  const chatAfter = (await store(CSCOPE)).map((i) => `${i.title}|${i.status}`).sort()
  check(JSON.stringify(chatAfter) === JSON.stringify(chatSnapshot), '5 the Chat list and its statuses survive a restart', chatAfter.join('; '))
  check((await row('Ask about the weather').getAttribute('data-status').catch(() => null)) === 'done', '5 the done Chat item shows as done after the restart')
  check((await row(AGENT_TITLE).count()) === 1, '5 the assistant item is still listed')
  await openProjectTodos()
  const projAfter = (await store(PSCOPE)).map((i) => `${i.title}|${i.status}`).sort()
  check(JSON.stringify(projAfter) === JSON.stringify(projSnapshot) && projAfter.length === 1, '5 the project list survives a restart', projAfter.join('; '))
  check((await row('Draft the changelog').locator('[data-testid=todo-run-link]').count()) >= 1, '5 the run link survives a restart')
  await shot('after-restart')
} catch (e) {
  check(false, 'script ran to the end', e.stack ?? String(e))
  await shot('error').catch(() => {})
} finally {
  await endSession(page).catch(() => {})
  await app?.close().catch(() => {})
  removeFixture(repo)
  finish('todos')
}
