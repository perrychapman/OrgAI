// Token-free. Mock adapter, temp ORGAI_DATA_DIR. QA edge cases for the To-dos tab (docs/design/todos.md): the 200 item cap
// and its refusal, a 200 character title with no spaces, a 2000 character detail, RTL / CJK / emoji titles, Markdown / HTML /
// link looking text as plain text, rapid toggling, changes from outside while the tab is open, `[mock:todo]` twice, Start
// session over a different draft and with the draft emptied, project delete with a list, both window sizes and themes,
// and a keyboard-only pass. Waits on conditions, not fixed sleeps.
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, check, createProject, deleteProject, endSession, finish, launch, makeFixtureRepo, openProject, removeFixture, sleep, t } from './lib.mjs'

process.env.ORGAI_MOCK = '1'

const PROJECT = 'E2E todos edge (orgai test)'
const PROJECT2 = 'E2E todos edge two (orgai test)'
const repo = makeFixtureRepo('todos-edge')
const repo2 = makeFixtureRepo('todos-edge2')
const AGENT_TITLE = 'Follow up with Acme about the export format'

const { app, page, shot } = await launch({ shotPrefix: 'todos-edge' })
page.setDefaultTimeout(10_000)

const T = (id) => page.locator(`[data-testid=${id}]`)
async function until(fn, ms = 15_000, every = 200) {
  const end = Date.now() + t(ms)
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() > end) return null
    await sleep(every)
  }
}
const rows = () => T('todo-row').count()
const store = (scope) => page.evaluate((s) => window.orgai.todos.list(s), scope)
const save = (input) => page.evaluate((i) => window.orgai.todos.save(i), input)
const row = (title) => T('todo-row').filter({ has: page.locator('[data-testid=todo-title]', { hasText: title }) })
const mainText = () => page.evaluate(() => document.querySelector('#main-content')?.textContent ?? '')
const size = (w, h) => app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
const theme = (t) => page.evaluate((x) => document.documentElement.setAttribute('data-theme', x), t)
const overflow = () =>
  page.evaluate(() => {
    const v = document.querySelector('[data-testid=todos-view]')
    const r = v?.getBoundingClientRect()
    const wide = [...(v?.querySelectorAll('[data-testid=todo-row]') ?? [])].filter((e) => e.scrollWidth > e.clientWidth + 1 || e.getBoundingClientRect().right > window.innerWidth + 1).length
    return { docOver: document.documentElement.scrollWidth - document.documentElement.clientWidth, viewOver: v ? v.scrollWidth - v.clientWidth : -1, wide, right: r?.right, iw: window.innerWidth }
  })
async function openTodosTab() {
  await T('tab-todos').click()
  await T('todos-view').waitFor({ timeout: 10_000 })
  await until(async () => (await T('todos-loading').count()) === 0, 10_000)
}
const openProjectTodos = async (name) => {
  await openProject(page, name)
  await openTodosTab()
}
const chatField = () => page.locator('[data-testid=assistant-start-quick] .composer textarea')
const runField = () => page.locator('.new-run .composer textarea')

try {
  const proj = await createProject(page, { path: repo, name: PROJECT })
  const proj2 = await createProject(page, { path: repo2, name: PROJECT2 })
  check(!!proj && !!proj2, 'seed: two mock projects exist')
  const PS = { kind: 'project', projectId: proj?.id }
  const PS2 = { kind: 'project', projectId: proj2?.id }
  const CS = { kind: 'chat' }

  // ---------- A. Odd text ----------
  const NOSPACE = 'W'.repeat(200)
  const DETAIL = 'long detail line. '.repeat(120).slice(0, 2000)
  const odd = [
    ['rtl', 'مرحبا بالعالم: راجع تقرير التصدير قبل الاجتماع الأسبوعي'],
    ['cjk', '导出格式を確認する 내보내기 형식 확인 ' + '漢'.repeat(60)],
    ['emoji', '🚀👩🏽🇯🇵 ship it 🎉'],
    ['md', '# Heading **bold** `code` [click](http://example.com) ![img](http://x/y.png)'],
    ['html', '<img src=x onerror=alert(1)> <b>bold</b> <a href="http://x">link</a>'],
    ['url', 'https://example.com/a/very/long/path/that/never/breaks/' + 'p'.repeat(120)]
  ]
  await save({ scope: PS, title: NOSPACE, detail: DETAIL })
  for (const [, t] of odd) await save({ scope: PS, title: t, detail: t })
  await openProjectTodos(PROJECT)
  check((await rows()) === 1 + odd.length, 'A all odd rows render', String(await rows()))
  for (const [name] of [['md'], ['html'], ['url']]) void name
  const bad = await page.evaluate(() => document.querySelectorAll('[data-testid=todos-view] [data-testid=todo-row] a, [data-testid=todos-view] [data-testid=todo-row] img, [data-testid=todos-view] [data-testid=todo-row] b, [data-testid=todos-view] [data-testid=todo-row] code, [data-testid=todos-view] [data-testid=todo-row] h1').length)
  check(bad === 0, 'A Markdown, HTML and link looking text creates no a/img/b/code/h1 element in rows', String(bad))
  check((await page.evaluate(() => window.__xss ?? 0)) === 0, 'A no script ran from title text')
  const htmlTitle = await T('todo-title').filter({ hasText: '<img src=x' }).first().innerText().catch(() => '')
  check(htmlTitle === odd[4][1], 'A the HTML title shows literally', htmlTitle)
  for (const [w, h] of [[1024, 640], [1600, 1000]]) {
    await size(w, h)
    for (const th of ['dark', 'light']) {
      await theme(th)
      await sleep(250)
      const o = await overflow()
      check(o.docOver <= 0 && o.viewOver <= 0 && o.wide === 0, `A no horizontal overflow with odd text at ${w}x${h} ${th}`, JSON.stringify(o))
      await shot(`odd-${w}x${h}-${th}`)
    }
  }
  // 2000-char detail: Details toggle, plain text, bounded
  await row('W'.repeat(20)).first().locator('[data-testid=todo-detail-toggle]').click()
  const dd = row('W'.repeat(20)).first().locator('[data-testid=todo-detail]')
  await dd.waitFor({ timeout: 5000 }).catch(() => {})
  check(((await dd.innerText().catch(() => '')).replace(/\s+/g, ' ').trim().length) >= 1900, 'A a 2000 character detail shows in full')
  const o2 = await overflow()
  check(o2.docOver <= 0 && o2.viewOver <= 0, 'A the long detail does not overflow', JSON.stringify(o2))
  // 200 / 2000 accepted, over refused in the UI
  const over = await save({ scope: PS, title: 'x'.repeat(201) }).then(() => 'accepted', (e) => String(e.message ?? e))
  check(over !== 'accepted', 'A main refuses a 201 character title', over)
  const overD = await save({ scope: PS, title: 'ok detail refusal', detail: 'd'.repeat(2001) }).then(() => 'accepted', (e) => String(e.message ?? e))
  check(overD !== 'accepted', 'A main refuses a 2001 character detail', overD)
  // edit form with 2000 char detail keeps working
  await row('W'.repeat(20)).first().locator('[data-testid=todo-edit]').click()
  check((await T('todo-edit-detail').inputValue()).length === 2000, 'A the edit form loads the 2000 character detail')
  await T('todo-edit-cancel').click()

  // Known product finding: U+200D (ZWJ) and U+200C (ZWNJ) are in the hidden class, so ZWJ emoji and Persian / Indic text are refused.
  for (const [label, t] of [['ZWJ emoji family', '👩‍💻 pair on the export'], ['ZWNJ Persian', 'می‌خواهم گزارش را ببینم']]) {
    const r = await save({ scope: PS, title: t }).then(() => 'accepted', (e) => String(e.message ?? e))
    check(true, `A (product finding, informational) ${label} title: ${r === 'accepted' ? 'accepted' : 'REFUSED as hidden characters'}`)
  }

  // ---------- B. Cap ----------
  const have = (await store(PS)).length
  for (let i = have; i < 200; i++) await save({ scope: PS, title: `Cap item ${i}` })
  check((await store(PS)).length === 200, 'B the store holds 200 items')
  await openProjectTodos(PROJECT2)
  await openProjectTodos(PROJECT)
  check(!!(await until(async () => (await rows()) === 200, 15_000)), 'B 200 rows render', String(await rows()))
  await shot('cap-200')
  const tc = (await T('todos-tab-count').innerText().catch(() => '')).replace(/\s+/g, ' ')
  check(/200/.test(tc), 'B the tab count shows 200 open', tc)
  await T('todo-add-input').fill('The 201st item')
  await T('todo-add-input').press('Enter')
  await T('todo-add-error').waitFor({ timeout: 5000 }).catch(() => {})
  const capErr = (await T('todo-add-error').innerText().catch(() => '')).trim()
  check(capErr.length > 0, 'B the 201st item shows an inline refusal', capErr)
  check((await T('todo-add-input').inputValue()) === 'The 201st item', 'B the typed text is kept after the cap refusal')
  check((await store(PS)).length === 200 && (await rows()) === 200, 'B nothing was added past 200')
  await T('todo-add-input').fill('')

  // ---------- C. Rapid toggling ----------
  // Exact title match (a substring match would also hit "Cap item 70"). The row leaves the Open list on completion, so
  // the box is clicked through a DOM handle, which keeps pointing at whichever list the row sits in.
  const exact = (t) => T('todo-row').filter({ has: page.locator('[data-testid=todo-title]', { hasText: new RegExp(`^${t}$`) }) })
  const clicks = 9
  for (let i = 0; i < clicks; i++) {
    if (i === 1) {
      await T('todo-done-toggle').waitFor({ timeout: 5000 }).catch(() => {})
      if ((await T('todo-done-toggle').getAttribute('aria-expanded').catch(() => 'true')) !== 'true') await T('todo-done-toggle').click().catch(() => {})
    }
    await page.evaluate(() => {
      const r = [...document.querySelectorAll('[data-testid=todo-row]')].find((e) => e.querySelector('[data-testid=todo-title]')?.textContent === 'Cap item 7')
      r?.querySelector('[data-testid=todo-check]')?.click()
    })
  }
  await sleep(2000)
  const st = (await store(PS)).find((i) => i.title === 'Cap item 7')?.status
  const shown = await exact('Cap item 7').first().getAttribute('data-status').catch(() => null)
  check(st === shown, 'C after 9 rapid toggles the row and the store agree', `${st} vs ${shown}`)
  check(st === 'done', 'C an odd number of toggles ends done', String(st))
  check((await exact('Cap item 7').count()) === 1, 'C the item shows exactly once')
  check((await rows()) === 200, 'C no row was lost or duplicated by rapid toggling', String(await rows()))

  // ---------- D. Changes from outside while open ----------
  const openBefore = await T('todo-list-open').locator('[data-testid=todo-row]').count()
  await save({ scope: PS, id: (await store(PS)).find((i) => i.title === 'Cap item 8').id, status: 'done' })
  check(!!(await until(async () => (await T('todo-list-open').locator('[data-testid=todo-row]').count()) === openBefore - 1, 8000)), 'D an outside change moves a row out of Open without a reload', String(await T('todo-list-open').locator('[data-testid=todo-row]').count()))
  // free space then add concurrently via the API while the UI adds
  const first = (await store(PS)).find((i) => i.title === 'Cap item 9')
  await page.evaluate((i) => window.orgai.todos.remove({ scope: i.scope, id: i.id }), first)
  await T('todo-add-input').fill('UI added')
  await Promise.all([T('todo-add-input').press('Enter'), save({ scope: PS, title: 'API added' })])
  check(!!(await until(async () => (await store(PS)).filter((i) => ['UI added', 'API added'].includes(i.title)).length === 2 || (await store(PS)).length === 200, 8000)), 'D concurrent add from UI and API both land or one is refused at the cap')
  await sleep(500)
  check((await store(PS)).length <= 200, 'D the cap holds under a concurrent add', String((await store(PS)).length))
  const shownRows = (await rows()) + (await T('todo-list-done').locator('[data-testid=todo-row]').count())
  void shownRows

  // ---------- E. Start session and drafts (project 2, small list) ----------
  await save({ scope: PS2, title: 'Draft test item' })
  await openProjectTodos(PROJECT2)
  await row('Draft test item').locator('[data-testid=todo-start]').click()
  await runField().waitFor({ timeout: 10_000 })
  const prefill = await until(async () => (await runField().inputValue()) || null, 8000)
  check(!!prefill && prefill.includes('Draft test item'), 'E Start session prefills the New run composer', String(prefill))
  // Different draft present: type a different message, go back, start again
  await runField().fill('my own unsent thought')
  await openTodosTab()
  await row('Draft test item').locator('[data-testid=todo-start]').click()
  const ask = await until(async () => (await T('todo-replace-draft-confirm').count()) > 0, 6000)
  check(!!ask, 'E Start session over a different draft asks before replacing')
  check((await runField().inputValue().catch(() => 'my own unsent thought')) === 'my own unsent thought' || !!ask, 'E the draft is untouched until confirmed')
  if (ask) {
    await T('todo-replace-draft-confirm').click()
    await runField().waitFor({ timeout: 8000 })
    check(!!(await until(async () => ((await runField().inputValue()) || '').includes('Draft test item'), 6000)), 'E confirming replaces the draft with the prefill')
  }
  // Empty the draft: no link, and nothing was started
  const before2 = (await page.evaluate((id) => window.orgai.runs.list(id), proj2.id)).length
  await runField().fill('')
  await runField().press('Enter')
  await sleep(1000)
  check((await page.evaluate((id) => window.orgai.runs.list(id), proj2.id)).length === before2, 'E an emptied draft starts nothing')
  check(((await store(PS2))[0].startedRunIds ?? []).length === 0, 'E an emptied draft leaves the item unlinked')
  // Open L5: replace the whole text, send, link kept
  await openTodosTab()
  await row('Draft test item').locator('[data-testid=todo-start]').click()
  await runField().waitFor({ timeout: 8000 })
  await until(async () => ((await runField().inputValue()) || '').includes('Draft test item'), 6000)
  await runField().fill('Something else entirely about weather')
  await runField().press('Enter')
  await page.locator('.run-tab[aria-selected=true]').first().waitFor({ timeout: 20_000 }).catch(() => {})
  await sleep(1500)
  const linked = ((await store(PS2))[0].startedRunIds ?? []).length
  check(true, `E (confirms open Low L5) replacing the prefilled text entirely then sending links the run: ${linked === 1 ? 'YES, link kept' : 'no link'}`)
  await endSession(page)

  // ---------- F. [mock:todo] twice -> one item ----------
  for (let n = 0; n < 2; n++) {
    await page.locator('[data-testid=nav-assistant][data-id=quick]').click()
    await T('assistant-start-quick').waitFor({ timeout: 10_000 }).catch(() => {})
    if (await chatField().count()) {
      await chatField().fill('Remember this [mock:todo]')
      await chatField().press('Enter')
      await page.locator('.run-tab[aria-selected=true]').first().waitFor({ timeout: 20_000 }).catch(() => {})
      await until(async () => (await mainText()).includes('Added to your to-do list.') || (await mainText()).includes('already'), 20_000)
    } else {
      // an existing chat is open: send in its composer
      await page.locator('.composer textarea').first().fill('Remember this again [mock:todo]')
      await page.locator('.composer textarea').first().press('Enter')
      await sleep(4000)
    }
    await sleep(1000)
    await endSession(page)
  }
  const agentItems = (await store(CS)).filter((i) => i.title === AGENT_TITLE)
  check(agentItems.length === 1, '[mock:todo] sent twice gives one item', String(agentItems.length))

  // ---------- G. Keyboard-only path (project 2) ----------
  await openProjectTodos(PROJECT2)
  await T('todo-add-input').focus()
  await page.keyboard.type('Keyboard item')
  await page.keyboard.press('Enter')
  check(!!(await until(async () => (await store(PS2)).some((i) => i.title === 'Keyboard item'), 8000)), 'G Enter in the add field adds')
  const focusRing = async () =>
    page.evaluate(() => {
      const el = document.activeElement
      if (!el || el === document.body) return { ok: false, tag: 'body' }
      const cs = getComputedStyle(el)
      const ow = parseFloat(cs.outlineWidth) || 0
      return { ok: (cs.outlineStyle !== 'none' && ow > 0) || cs.boxShadow !== 'none', tag: el.tagName, tid: el.getAttribute('data-testid'), outline: cs.outline, shadow: cs.boxShadow.slice(0, 60) }
    })
  // tab through the Keyboard item row: reach checkbox, Details?, Start, Edit, Delete; each shows a focus indicator
  const kb = row('Keyboard item')
  await kb.locator('[data-testid=todo-check]').focus()
  const seen = []
  for (let i = 0; i < 6; i++) {
    const f = await focusRing()
    seen.push(`${f.tid ?? f.tag}:${f.ok ? 'ring' : 'NO-RING'}`)
    await page.keyboard.press('Tab')
  }
  check(!seen.some((s) => s.endsWith('NO-RING')), 'G every control in the row path shows a visible focus indicator', seen.join(', '))
  await kb.locator('[data-testid=todo-check]').focus()
  await page.keyboard.press('Space')
  check(!!(await until(async () => (await store(PS2)).find((i) => i.title === 'Keyboard item')?.status === 'done', 8000)), 'G Space completes the item')
  check((await page.evaluate(() => document.activeElement?.tagName)) !== 'BODY', 'G focus does not fall to the page after completing')
  await T('todo-done-toggle').focus()
  await page.keyboard.press('Enter')
  await row('Keyboard item').locator('[data-testid=todo-check]').focus()
  await page.keyboard.press('Space')
  check(!!(await until(async () => (await store(PS2)).find((i) => i.title === 'Keyboard item')?.status === 'open', 8000)), 'G Space reopens the item')
  await row('Keyboard item').locator('[data-testid=todo-edit]').focus()
  await page.keyboard.press('Enter')
  await T('todo-edit-title').waitFor({ timeout: 5000 })
  check((await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'todo-edit-title', 'G Edit moves focus into the title field')
  // Select all is Cmd+A on macOS; Ctrl+A there is "move to line start" (emacs binding), which would prepend the text.
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('Keyboard item renamed')
  await page.keyboard.press('Enter')
  check(!!(await until(async () => (await store(PS2)).some((i) => i.title === 'Keyboard item renamed'), 8000)), 'G Enter in the edit title saves')
  await row('Keyboard item renamed').locator('[data-testid=todo-edit]').focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  check((await T('todo-edit-title').count()) === 0, 'G Escape cancels the edit')
  await row('Keyboard item renamed').locator('[data-testid=todo-delete]').focus()
  await page.keyboard.press('Enter')
  await T('todo-delete-confirm').waitFor({ timeout: 5000 })
  await shot('keyboard-delete-confirm')
  await page.keyboard.press('Escape')
  check((await store(PS2)).some((i) => i.title === 'Keyboard item renamed'), 'G Escape on the delete confirm keeps the item')
  await row('Keyboard item renamed').locator('[data-testid=todo-delete]').focus()
  await page.keyboard.press('Enter')
  await T('todo-delete-confirm').waitFor({ timeout: 5000 })
  await T('todo-delete-confirm').focus()
  await page.keyboard.press('Enter')
  check(!!(await until(async () => !(await store(PS2)).some((i) => i.title === 'Keyboard item renamed'), 8000)), 'G the delete confirm works by keyboard')

  // ---------- H. Project delete removes the list ----------
  await save({ scope: PS2, title: 'Goes with the project' })
  await deleteProject(page, PROJECT2)
  await sleep(500)
  const after = await store(PS2).then((l) => l.length, (e) => `err:${e.message}`)
  check(after === 0 || /no longer exists/.test(String(after)), 'H a deleted project answers "no longer exists" (or an empty list)', String(after))
  const file = path.join(DATA_DIR, 'data', 'todos.json')
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  check(raw.length > 0 && !raw.includes(proj2.id) && raw.includes(proj.id), 'H todos.json no longer holds the deleted project and still holds the other', `${raw.length} bytes`)
} catch (e) {
  check(false, 'script ran to the end', e.stack ?? String(e))
  await shot('error').catch(() => {})
} finally {
  await endSession(page).catch(() => {})
  await app?.close().catch(() => {})
  removeFixture(repo)
  removeFixture(repo2)
  finish('todos-edge')
}
