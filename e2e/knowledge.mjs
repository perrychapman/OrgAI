// Token-free. Mock adapter, temp ORGAI_DATA_DIR. The Knowledge tab's List view, detail pane, note dialog and live
// updates (docs/design/knowledge.md sections 1-4, 6, 11): the tab only on engagements, the empty state, a
// [mock:knowledge] work run filling the list, groups and provenance, search, the detail pane (facts, related,
// history), inline fact edits, retire / restore / delete, notes from the tab, the History run link, a live write
// arriving while filtered ("Show new"), the keyboard pass at 1024x640 and both sizes and themes without page scroll.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TMP, check, createProject, deleteProject, findProject, finish, gotoProjects, launch, makeFixtureRepo, openProject, openProjectForm, projectTab, removeFixture, sleep, windowShift } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const base = fs.mkdtempSync(path.join(TMP, 'orgai-e2e-knowledge-'))
const wf = path.join(base, 'acme-review')
fs.mkdirSync(wf, { recursive: true })
const codeRepo = makeFixtureRepo('knowledge-code')

const ENG = 'E2E Knowledge Acme (orgai test)'
const CODE = 'E2E Knowledge code (orgai test)'

const { app, page, shot } = await launch({ shotPrefix: 'knowledge' })
page.setDefaultTimeout(8000)

const setSize = async (w, h) => {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
  await page.waitForFunction((cw) => Math.abs(window.innerWidth - cw) <= 1, w, { timeout: 10_000 }).catch(() => {})
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await sleep(600)
}
const setTheme = async (theme) => {
  await page.evaluate(async (t) => {
    const s = await window.orgai.settings.get()
    await window.orgai.settings.set({ ...s, appearance: { ...s.appearance, theme: t } })
  }, theme)
  await sleep(400)
}
const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim()
const until = async (fn, ms = 10_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      if (await fn()) return true
    } catch {
      /* keep polling */
    }
    await sleep(200)
  }
  return false
}
const noPageScroll = () => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight }))
const fitsWindow = async (what) => {
  const o = await noPageScroll()
  check(o.sw <= o.cw && o.sh <= o.ch + 1, `${what}: the page does not scroll`, JSON.stringify(o))
}
const active = () =>
  page.evaluate(() => {
    const el = document.activeElement
    if (!el || el === document.body) return 'body'
    const t = el.getAttribute('data-testid')
    const role = el.getAttribute('role')
    return `${el.tagName.toLowerCase()}${t ? `[${t}]` : ''}${role ? `{${role}}` : ''}${el.id ? `#${el.id}` : ''}${el.getAttribute('aria-label') ? `(${el.getAttribute('aria-label')})` : ''}`
  })
const status = async () => clean(await page.locator('[data-testid=knowledge-status]').innerText())
const statusIs = (text, ms = 6000) => until(async () => (await status()) === text, ms)
/** After a filter change: let the 150 ms search debounce and the 400 ms count-line announcement pass. */
const settle = () => sleep(700)
const graph = (id) => page.evaluate((pid) => window.orgai.knowledge.get(pid), id)
const nodeNamed = async (id, name) => (await graph(id)).nodes.find((n) => n.name === name)
const openKnowledge = async () => {
  await page.locator('[data-testid=tab-knowledge]').click()
  await page.locator('[data-testid=knowledge-view]').waitFor({ state: 'visible' })
}
const row = (name) => page.locator('[data-testid=knowledge-row]', { has: page.locator(`[data-testid=knowledge-row-name]`, { hasText: name }) }).first()
const openRow = async (name) => {
  await row(name).click()
  await page.waitForFunction((n) => document.activeElement?.id === 'knowledge-detail-heading' && (document.querySelector('[data-testid=knowledge-detail-name]')?.textContent ?? '').includes(n), name, { timeout: 8000 })
}
const todayText = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

/** Create an engagement through the form with the setup interview off. */
async function createEngagement({ name, client, dir }) {
  await gotoProjects(page)
  const form = await openProjectForm(page)
  await form.locator('[data-testid=project-kind-option][data-kind=engagement] input[type=radio]').check({ force: true })
  await form.getByLabel('Name', { exact: true }).fill(name)
  if (client) await form.locator('[data-testid=new-project-client]').fill(client)
  await form.getByLabel('Working folder', { exact: true }).fill(dir)
  const arch = form.locator('[data-testid=architect-setup]')
  if (await arch.isChecked()) await form.locator('label.checkbox', { hasText: 'Start with the setup interview' }).click()
  await form.getByRole('button', { name: 'Create project', exact: true }).click()
  await page.waitForSelector('[data-testid=dashboard]', { state: 'detached', timeout: 60_000 })
  return findProject(page, name)
}
const startRun = async (text) => {
  await projectTab(page, 'Live').click()
  if (!(await page.locator('.new-run').count())) {
    await page.keyboard.press('Control+t')
    await page.locator('.new-run').waitFor({ timeout: 8000 })
  }
  const ta = page.locator('.composer textarea')
  await ta.waitFor({ timeout: 10_000 })
  await ta.fill(text)
  await page.locator('.composer .btn.primary').click()
}

try {
  await setSize(1600, 1000)
  await setTheme('dark')

  // ======== 1. Placement ========
  const eng = await createEngagement({ name: ENG, client: 'Acme Corp', dir: wf })
  check(!!eng && eng.kind === 'engagement', 'engagement created')
  check((await page.locator('[data-testid=tab-knowledge]').count()) === 1, 'the engagement has a Knowledge tab')
  const code = await createProject(page, { mode: 'existing', path: codeRepo, name: CODE })
  check(!!code, 'code project created')
  check((await page.locator('[data-testid=tab-knowledge]').count()) === 0, 'a code project has no Knowledge tab')
  await page.locator('[data-testid=nav-assistant][data-id=quick]').click()
  await sleep(400)
  check((await page.locator('[data-testid=tab-knowledge]').count()) === 0, 'the Chat assistant has no Knowledge tab')

  // ======== 2. Empty state, then the mock run fills the list ========
  await openProject(page, ENG)
  await openKnowledge()
  await page.locator('[data-testid=knowledge-empty]').waitFor({ state: 'visible' })
  check(/Nothing recorded yet/.test(await page.locator('[data-testid=knowledge-empty]').innerText()), 'before any run the tab shows "Nothing recorded yet"')
  check((await page.locator('[data-testid=knowledge-empty] [data-testid=knowledge-add-note]').count()) === 1, 'the empty state offers Add a note')
  await fitsWindow('empty Knowledge (1600x1000 dark)')
  await shot('empty')

  await startRun('Summarise the kickoff [mock:knowledge]')
  // The mock root records 4 items and 1 note before the default script goes on (which may raise a card): wait for the data.
  check(await until(async () => (await graph(eng.id)).nodes.length === 4 && (await page.evaluate((id) => window.orgai.engagement.listNotes(id), eng.id)).length === 1, 60_000), 'the [mock:knowledge] run recorded 4 items and 1 note', `${(await graph(eng.id)).nodes.length} nodes; run tab: ${clean(await page.locator('.run-tab[aria-selected=true]').first().innerText().catch(() => ''))}`)
  // The root's last knowledge step retires Acme Corp's fact; wait for it so no late push lands during the checks below.
  check(await until(async () => (await nodeNamed(eng.id, 'Acme Corp'))?.facts.some((f) => f.retired), 30_000), 'the root retired "Fiscal year ends in March"', JSON.stringify((await nodeNamed(eng.id, 'Acme Corp'))?.facts))
  check(await until(async () => /Idle|Needs you/.test(await page.locator('.run-tab[aria-selected=true]').first().innerText().catch(() => '')), 60_000), 'the run is Idle or waiting on a card afterwards', clean(await page.locator('.run-tab[aria-selected=true]').first().innerText().catch(() => '')))
  const rootRole = (eng.roles ?? []).find((r) => r.reportsTo == null)?.name ?? ''
  check(!!rootRole, 'the root role name is known', JSON.stringify((eng.roles ?? []).map((r) => [r.name, r.reportsTo])))

  await openKnowledge()
  await page.locator('[data-testid=knowledge-row]').first().waitFor({ state: 'visible', timeout: 15_000 })
  check(await until(async () => (await page.locator('[data-testid=knowledge-row]').count()) === 5), 'five rows: four items and the note', String(await page.locator('[data-testid=knowledge-row]').count()))
  const groupKinds = await page.locator('[data-testid=knowledge-group]').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')))
  check(JSON.stringify(groupKinds) === JSON.stringify(['person', 'organisation', 'decision', 'risk', 'note']), 'groups in order People, Organisations, Decisions, Risks, Notes', JSON.stringify(groupKinds))
  const groupTitles = await page.locator('[data-testid=knowledge-group-title]').evaluateAll((els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()))
  check(JSON.stringify(groupTitles) === JSON.stringify(['People 1', 'Organisations 1', 'Decisions 1', 'Risks 1', 'Notes 1']), 'group titles carry their counts', JSON.stringify(groupTitles))
  check(clean(await page.locator('[data-testid=knowledge-count]').innerText()) === '5 of 5 items', 'the count line reads "5 of 5 items"', clean(await page.locator('[data-testid=knowledge-count]').innerText()))
  const prov = clean(await row('Jane Doe').locator('[data-testid=knowledge-row-prov]').innerText())
  check(prov === `${rootRole} · R1 · ${todayText}`, `Jane Doe's provenance reads "${rootRole} · R1 · ${todayText}"`, prov)
  check((await row('Jane Doe').locator('.badge', { hasText: 'Agent' }).count()) === 1, 'an agent row carries the Agent badge on the All view')
  const kindChips = await page.locator('[data-testid=knowledge-kind]').evaluateAll((els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()))
  check(JSON.stringify(kindChips) === JSON.stringify(['People 1', 'Organisations 1', 'Decisions 1', 'Risks 1', 'Notes 1']), 'kind chips carry counts', JSON.stringify(kindChips))
  check(/Agents 5/.test(clean(await page.locator('[data-testid=knowledge-origin][data-origin=agent]').innerText())), 'the Agents chip counts 5')
  await fitsWindow('Knowledge list (1600x1000 dark)')
  await shot('list-1600-dark')

  // ======== 3. Search ========
  const search = page.locator('[data-testid=knowledge-search]')
  await search.fill('Acme')
  // Acme Corp by name, Jane Doe by her summary ("... at Acme Corp"), the risk by its fact; the decision and the note do not match.
  check(await until(async () => clean(await page.locator('[data-testid=knowledge-count]').innerText()) === '3 of 5 items'), 'search "Acme" gives "3 of 5 items"', clean(await page.locator('[data-testid=knowledge-count]').innerText()))
  const found = await page.locator('[data-testid=knowledge-row-name]').evaluateAll((els) => els.map((e) => e.textContent))
  check(found.includes('Acme Corp') && found.includes('Legacy export format undocumented') && !found.includes('Migrate billing to Stripe'), 'Acme Corp (by name) and the risk (by its fact) match; the decision does not (groups keep their order)', JSON.stringify(found))
  check(await statusIs('3 of 5 items'), 'the count line is spoken after the search', await status())
  check((await page.locator('[data-testid=knowledge-search-clear]').count()) === 1, 'a Clear button shows while the search has text')
  await search.focus()
  await page.keyboard.press('Escape')
  check(await until(async () => clean(await page.locator('[data-testid=knowledge-count]').innerText()) === '5 of 5 items'), 'Esc clears the search')
  check((await active()).includes('knowledge-search'), 'Esc keeps focus in the search box', await active())
  await settle()
  await search.fill('zzzz')
  await page.locator('[data-testid=knowledge-empty-filter]').waitFor({ state: 'visible' })
  check(/No items match zzzz\./.test(await page.locator('[data-testid=knowledge-empty-filter]').innerText()), 'no match shows "No items match zzzz."')
  await page.locator('[data-testid=knowledge-clear-filters]').click()
  await page.locator('[data-testid=knowledge-row]').first().waitFor({ state: 'visible' })
  check((await search.inputValue()) === '', '"Clear search" empties the box')
  await settle()
  await page.locator('[data-testid=knowledge-kind][data-kind=person]').click()
  check(await until(async () => (await page.locator('[data-testid=knowledge-row]').count()) === 1), 'the People chip filters to one row')
  check(await statusIs('1 of 5 items'), 'the count line is spoken after a chip', await status())
  check((await page.locator('[data-testid=knowledge-kind][data-kind=person]').getAttribute('aria-pressed')) === 'true', 'the pressed chip says aria-pressed')
  await page.locator('[data-testid=knowledge-kind-all]').click()
  check(await until(async () => (await page.locator('[data-testid=knowledge-row]').count()) === 5), '"All kinds" resets the kind filter')
  await settle()

  // ======== 4. Detail pane ========
  await openRow('Jane Doe')
  const detail = page.locator('[data-testid=knowledge-detail-body]')
  check((await detail.getAttribute('data-id')) === (await nodeNamed(eng.id, 'Jane Doe'))?.id, 'the pane shows Jane Doe')
  const factTexts = await detail.locator('[data-testid=knowledge-fact-input]').evaluateAll((els) => els.map((e) => e.value))
  check(JSON.stringify(factTexts) === JSON.stringify(['Role: CFO', 'Prefers written summaries before meetings']), "Jane Doe's two facts", JSON.stringify(factTexts))
  const related = await detail.locator('[data-testid=knowledge-relation]').evaluateAll((els) => els.map((e) => e.querySelector('.knowledge-relation-text').textContent.replace(/\s+/g, ' ').trim()))
  check(JSON.stringify(related) === JSON.stringify(['works at Acme Corp', 'Migrate billing to Stripe decided by']), 'Related reads "works at Acme Corp" and "Migrate billing to Stripe decided by"', JSON.stringify(related))
  check(/Sponsor sign-off/.test(await detail.locator('[data-testid=knowledge-relation]').nth(1).innerText()), 'the edge note shows under its relation')
  const hist = clean(await detail.locator('[data-testid=knowledge-history-line]').first().innerText())
  check(new RegExp(`^Recorded by ${rootRole.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')} in R1 `).test(hist), 'History reads "Recorded by <role> in R1 …"', hist)
  check(clean(await detail.locator('[data-testid=knowledge-kind]').innerText()) === 'Person' && clean(await detail.locator('[data-testid=knowledge-aliases]').innerText()) === 'J. Doe', 'kind and aliases show at rest', `${await detail.locator('[data-testid=knowledge-kind]').innerText()} / ${await detail.locator('[data-testid=knowledge-aliases]').innerText()}`)
  await shot('detail-jane')

  // The neighbour link selects Acme Corp; its retired fact hides until Show retired.
  await detail.locator('[data-testid=knowledge-relation-link]').first().click()
  await page.waitForFunction(() => (document.querySelector('[data-testid=knowledge-detail-name]')?.textContent ?? '').includes('Acme Corp'))
  check(await until(async () => (await active()).includes('knowledge-detail-heading')), 'following a relation lands focus on the new heading', await active())
  check((await detail.locator('[data-testid=knowledge-fact]').count()) === 1, 'Acme Corp shows one live fact (the retired one hidden)')
  await page.locator('[data-testid=knowledge-show-retired]').click()
  check(await until(async () => (await detail.locator('[data-testid=knowledge-fact][data-retired=true]').count()) === 1), 'Show retired reveals the retired fact', String(await detail.locator('[data-testid=knowledge-fact]').count()))
  check((await detail.locator('[data-testid=knowledge-fact][data-retired=true] [data-testid=knowledge-fact-input]').inputValue()) === 'Fiscal year ends in March', 'the retired fact is "Fiscal year ends in March"')
  // Restore the retired fact from its menu (the flag must reach main as false), then retire it again.
  await detail.locator('[data-testid=knowledge-fact][data-retired=true] [data-testid=knowledge-fact-more]').click()
  await page.locator('[data-testid=knowledge-fact-retire]').click()
  check(await until(async () => (await nodeNamed(eng.id, 'Acme Corp'))?.facts.every((f) => !f.retired)), 'Restore from the fact menu clears the retired flag in the store', JSON.stringify((await nodeNamed(eng.id, 'Acme Corp'))?.facts))
  check(await until(async () => (await detail.locator('[data-testid=knowledge-fact][data-retired=true]').count()) === 0), 'the restored fact loses its Retired badge')
  await detail.locator('[data-testid=knowledge-fact]', { has: page.locator('input[value="Fiscal year ends in March"]') }).locator('[data-testid=knowledge-fact-more]').click()
  await page.locator('[data-testid=knowledge-fact-retire]').click()
  check(await until(async () => (await nodeNamed(eng.id, 'Acme Corp'))?.facts.some((f) => f.retired)), 'Retire from the fact menu sets the flag again')
  await page.locator('[data-testid=knowledge-show-retired]').click()
  check(await until(async () => (await detail.locator('[data-testid=knowledge-fact]').count()) === 1), 'Show retired off hides it again')
  await settle()

  // Inline edit a fact and add a fact (checked through knowledge.get).
  await openRow('Jane Doe')
  const fact1 = detail.locator('[data-testid=knowledge-fact-input]').first()
  await fact1.fill('Role: CFO (Chief Financial Officer)')
  await fact1.press('Enter')
  check(await until(async () => (await nodeNamed(eng.id, 'Jane Doe'))?.facts[0]?.text === 'Role: CFO (Chief Financial Officer)'), 'editing a fact inline saves it', JSON.stringify((await nodeNamed(eng.id, 'Jane Doe'))?.facts.map((f) => f.text)))
  check(await statusIs('Saved Jane Doe.'), 'the status says "Saved Jane Doe."', await status())
  const jane0 = await nodeNamed(eng.id, 'Jane Doe')
  check(jane0.facts[0].source.by === 'agent' && jane0.source.by === 'agent' && jane0.updatedBy?.by === 'user', 'the edited fact keeps its agent source; the item gains updatedBy user', JSON.stringify({ f: jane0.facts[0].source, s: jane0.source, u: jane0.updatedBy }))
  await detail.locator('[data-testid=knowledge-fact-add]').click()
  const newFact = detail.locator('[data-testid=knowledge-fact][data-id=new] [data-testid=knowledge-fact-input]')
  await newFact.waitFor({ state: 'visible' })
  check(await until(async () => (await active()).includes('knowledge-fact-input')), 'Add a fact focuses the new input', await active())
  await newFact.fill('Based in Leeds')
  await newFact.press('Enter')
  check(await until(async () => (await nodeNamed(eng.id, 'Jane Doe'))?.facts.length === 3), 'a new fact is appended', String((await nodeNamed(eng.id, 'Jane Doe'))?.facts.length))
  check((await nodeNamed(eng.id, 'Jane Doe')).facts[2].source.by === 'user', 'the new fact is the user\'s')
  check(await until(async () => /Edited by you/.test(await detail.locator('[data-testid=knowledge-history]').innerText())), 'History gains "Edited by you"')
  check(await until(async () => (await detail.locator('[data-testid=knowledge-fact]').count()) === 3), 'the pane shows three facts after the push')

  // ======== 5. Retire, restore, delete (the risk) ========
  const RISK = 'Legacy export format undocumented'
  await openRow(RISK)
  const notice = page.locator('[data-testid=knowledge-notice]')
  const rowName = () => page.evaluate(() => document.activeElement?.querySelector('[data-testid=knowledge-row-name]')?.textContent ?? null)
  await detail.locator('[data-testid=knowledge-retire]').click()
  check(await statusIs(`Retired ${RISK}.`), 'retire announces "Retired <name>."', await status())
  check(await until(async () => (await page.locator('[data-testid=knowledge-row]').count()) === 4), 'the retired row leaves the list')
  check(clean(await page.locator('[data-testid=knowledge-count]').innerText()) === '4 of 4 items', 'the count line follows (4 of 4 items)')
  check(await until(async () => (await active()).includes('knowledge-row')), 'focus moved to the next row', await active())
  check((await nodeNamed(eng.id, RISK))?.retired === true, 'the node is retired in the store')
  // M5: a visible notice with Undo; a labelled region, not a second live region.
  await notice.waitFor({ state: 'visible' })
  check(clean(await notice.innerText()).startsWith(`Retired ${RISK}.`) && (await page.locator('[data-testid=knowledge-notice-undo]').isVisible()), 'a visible notice says "Retired <name>." with Undo', clean(await notice.innerText()))
  check((await notice.getAttribute('role')) === 'region' && (await notice.getAttribute('aria-label')) === 'Last change' && (await notice.locator('[role=status],[role=alert]').count()) === 0, 'the notice is a labelled region, not a live region')
  check((await page.locator('[role=status]', { hasText: `Retired ${RISK}.` }).count()) === 1, 'the retirement is announced once (knowledge-status only)')
  // The pane stays on the retired item: a second click on the same spot cannot retire another.
  check((await detail.getAttribute('data-id')) === (await nodeNamed(eng.id, RISK))?.id && (await detail.locator('[data-testid=knowledge-restore]').count()) === 1 && (await detail.locator('[data-testid=knowledge-retire]').count()) === 0, 'the pane stays on the retired item and offers Restore, not another item\'s Retire')
  await fitsWindow('Knowledge with the notice (1600x1000 dark)')
  const sn = await windowShift(page)
  check(sn.ok, 'the notice did not shift the window', JSON.stringify(sn))
  await shot('notice')
  // Undo restores, speaks once and lands focus on the restored row (Show retired is off, so the row returns after the refetch).
  await page.locator('[data-testid=knowledge-notice-undo]').click()
  check(await statusIs(`Restored ${RISK}.`), 'Undo announces "Restored <name>."', await status())
  check(await until(async () => (await nodeNamed(eng.id, RISK))?.retired !== true), 'Undo makes the node live again')
  check(await until(async () => (await notice.count()) === 0), 'the notice clears after Undo')
  check(await until(async () => (await rowName()) === RISK), 'after Undo focus is on the restored row', `${await active()} ${await rowName()}`)
  // Retire, rename in the pane, Undo: the new name survives and the item is live (Undo uses the live item, not the retire-time snapshot).
  const RENAMED = `${RISK} (renamed)`
  await openRow(RISK)
  await detail.locator('[data-testid=knowledge-retire]').click()
  await notice.waitFor({ state: 'visible' })
  await detail.locator('[data-testid=knowledge-name]').click()
  await detail.locator('[data-testid=knowledge-name-input]').fill(RENAMED)
  await page.keyboard.press('Enter')
  check(await until(async () => (await nodeNamed(eng.id, RENAMED)) != null), 'the rename after the retire is saved', RENAMED)
  await page.locator('[data-testid=knowledge-notice-undo]').click()
  check(await until(async () => { const n = await nodeNamed(eng.id, RENAMED); return !!n && n.retired !== true }), 'Undo keeps the new name and makes the item live')
  check((await nodeNamed(eng.id, RISK)) == null, 'Undo did not bring the old name back')
  await until(async () => (await notice.count()) === 0)
  await detail.locator('[data-testid=knowledge-name]').click()
  await detail.locator('[data-testid=knowledge-name-input]').fill(RISK)
  await page.keyboard.press('Enter')
  check(await until(async () => (await nodeNamed(eng.id, RISK))?.retired !== true && (await nodeNamed(eng.id, RISK)) != null), 'the name is put back for the checks below')
  // Dismiss clears the notice and lands focus on a row.
  await openRow(RISK)
  await detail.locator('[data-testid=knowledge-retire]').click()
  await notice.waitFor({ state: 'visible' })
  await notice.getByRole('button', { name: 'Dismiss notice' }).click()
  check(await until(async () => (await notice.count()) === 0), 'Dismiss clears the notice')
  check(await until(async () => (await active()).includes('knowledge-row')), 'Dismiss lands focus on a row', await active())
  check((await nodeNamed(eng.id, RISK))?.retired === true, 'the item is retired again after the second retire')
  await page.locator('[data-testid=knowledge-show-retired]').click()
  check(await until(async () => (await row(RISK).count()) === 1 && (await row(RISK).getAttribute('data-retired')) === 'true'), 'Show retired lists the retired row with data-retired')
  await settle()
  await openRow(RISK)
  check((await detail.locator('[data-testid=knowledge-restore]').count()) === 1, 'a retired item offers Restore')
  await detail.locator('[data-testid=knowledge-restore]').click()
  check(await statusIs(`Restored ${RISK}.`), 'restore announces "Restored <name>."', await status())
  check(await until(async () => (await nodeNamed(eng.id, RISK))?.retired !== true), 'the node is live again')
  await page.locator('[data-testid=knowledge-show-retired]').click()
  await settle()
  await openRow(RISK)
  await detail.locator('[data-testid=knowledge-delete]').click()
  const confirmDlg = page.locator('dialog.dialog[open]')
  await confirmDlg.waitFor({ state: 'visible' })
  check(new RegExp(`Delete ${RISK}\\?`).test(await confirmDlg.innerText()) && /Retire it instead to keep the record/.test(await confirmDlg.innerText()), 'the delete confirm has the spec wording', clean(await confirmDlg.innerText()))
  await shot('delete-confirm')
  await confirmDlg.locator('[data-testid=knowledge-delete-confirm]').click()
  check(await statusIs(`Deleted ${RISK}.`), 'delete announces "Deleted <name>."', await status())
  await notice.waitFor({ state: 'visible' })
  check(clean(await notice.innerText()).startsWith(`Deleted ${RISK}.`) && (await page.locator('[data-testid=knowledge-notice-undo]').count()) === 0, '"Deleted <name>." shows a notice with no Undo', clean(await notice.innerText()))
  await notice.getByRole('button', { name: 'Dismiss notice' }).click()
  check(await until(async () => (await graph(eng.id)).nodes.length === 3), 'the graph has three nodes after the delete')
  check(await until(async () => (await page.locator('[data-testid=knowledge-row]').count()) === 4), 'the list has four rows (three items and the note)')

  // ======== 6. Notes from the tab ========
  await page.locator('[data-testid=knowledge-toolbar] [data-testid=knowledge-add-note]').click()
  const dlg = page.locator('[data-testid=context-note-dialog]')
  await dlg.waitFor({ state: 'visible' })
  await dlg.locator('[data-testid=context-note-title]').fill('Client preferences')
  await dlg.locator('[data-testid=context-note-text]').fill('Prefers email on Tuesdays.')
  await dlg.locator('[data-testid=context-note-save]').click()
  await dlg.waitFor({ state: 'detached' })
  check(await statusIs('Note saved.'), 'adding a note announces "Note saved."', await status())
  check(await until(async () => (await row('Client preferences').count()) === 1), 'the new note is a row in the Notes group')
  check((await row('Client preferences').getAttribute('data-origin')) === 'user' && /You · /.test(await row('Client preferences').locator('[data-testid=knowledge-row-prov]').innerText()), 'the user\'s note reads "You · <date>"')
  check(await until(async () => (await active()).includes('knowledge-row')), 'after Save focus lands on the note\'s row', await active())
  await openRow('Client preferences')
  check(/Prefers email on Tuesdays\./.test(await detail.innerText()), 'the note detail shows its excerpt')
  await detail.locator('[data-testid=knowledge-note-edit]').click()
  await dlg.waitFor({ state: 'visible' })
  check((await dlg.locator('[data-testid=context-note-text]').inputValue()) === 'Prefers email on Tuesdays.', 'Edit note loads the text')
  await dlg.locator('[data-testid=context-note-text]').fill('Prefers phone calls.')
  await dlg.locator('[data-testid=context-note-save]').click()
  await dlg.waitFor({ state: 'detached' })
  const notesNow = await page.evaluate((id) => window.orgai.engagement.listNotes(id), eng.id)
  const edited = notesNow.find((n) => n.title === 'Client preferences')
  const content = edited ? await page.evaluate((r) => window.orgai.engagement.getNote(r), { projectId: eng.id, noteId: edited.id }) : null
  check(content?.text === 'Prefers phone calls.', 'editing the note saved the new text', JSON.stringify(content))
  check(await until(async () => (await active()).includes('knowledge-note-edit')), 'after an edit focus returns to "Edit note"', await active())

  // ======== 7. Add an item inline ========
  await page.locator('[data-testid=knowledge-toolbar] [data-testid=knowledge-add-item]').click()
  const create = page.locator('[data-testid=knowledge-create]')
  await create.waitFor({ state: 'visible' })
  check(await until(async () => (await active()).includes('knowledge-name-input')), 'Add an item focuses the Name field', await active())
  await create.locator('[data-testid=knowledge-name-input]').fill('Stripe')
  await create.locator('[data-testid=knowledge-kind-input]').fill('Vendor')
  await create.locator('[data-testid=knowledge-create-save]').click()
  check(await statusIs('Saved Stripe.'), 'creating an item announces "Saved Stripe."', await status())
  check(await until(async () => (await nodeNamed(eng.id, 'Stripe'))?.kind === 'vendor'), 'the item is saved with the normalised kind "vendor"')
  check(await until(async () => (await page.locator('[data-testid=knowledge-group][data-kind=vendor] [data-testid=knowledge-group-title]').count()) === 1), 'a free-form kind gets its own group')
  check(clean(await page.locator('[data-testid=knowledge-group][data-kind=vendor] [data-testid=knowledge-group-title]').innerText()) === 'Vendor 1', 'the free-form group title reads "Vendor 1"')
  // A duplicate name is refused as a field error.
  await page.locator('[data-testid=knowledge-toolbar] [data-testid=knowledge-add-item]').click()
  await create.waitFor({ state: 'visible' })
  await create.locator('[data-testid=knowledge-name-input]').fill('stripe')
  await create.locator('[data-testid=knowledge-kind-input]').fill('vendor')
  await create.locator('[data-testid=knowledge-create-save]').click()
  await create.locator('[data-testid=knowledge-field-error]').waitFor({ state: 'visible' })
  check(/already exists/.test(await create.locator('[data-testid=knowledge-field-error]').innerText()), 'a duplicate name shows the refusal under the field', clean(await create.locator('[data-testid=knowledge-field-error]').innerText()))
  await create.locator('[data-testid=knowledge-create-cancel]').click()

  // ======== 8. Live update while filtered: "The team recorded", "Show new" ========
  await page.locator('[data-testid=knowledge-kind][data-kind=person]').click()
  await until(async () => (await page.locator('[data-testid=knowledge-row]').count()) === 1)
  check(await statusIs('1 of 6 items'), 'the count line is spoken after the chip', await status())
  // A write from outside the tab (the renderer IPC here stands in for an agent's write).
  await page.evaluate((id) => window.orgai.knowledge.saveNode({ projectId: id, kind: 'system', name: 'Billing platform', facts: [{ text: 'Legacy' }] }), eng.id)
  check(await statusIs('The team recorded 1 item'), 'a write that is not the tab\'s own announces "The team recorded 1 item"', await status())
  check((await page.locator('[data-testid=knowledge-row]').count()) === 1, 'the filtered list did not change')
  await page.locator('[data-testid=knowledge-show-new]').waitFor({ state: 'visible' })
  check(true, '"Show new" appears when the new item is filtered out')
  await page.locator('[data-testid=knowledge-show-new]').click()
  check(await until(async () => (await row('Billing platform').count()) === 1), 'Show new clears the filters and shows the item')
  check((await page.locator('[data-testid=knowledge-show-new]').count()) === 0, '"Show new" goes away once the item is shown')

  // ======== 9. History run link opens the run ========
  await openRow('Jane Doe')
  await detail.locator('[data-testid=knowledge-history-run]').first().click()
  check(await until(async () => (await page.locator('[data-testid=tab-live]').getAttribute('aria-selected')) === 'true' && (await page.locator('.run-tab[aria-selected=true]').count()) === 1), 'the History run link opens the run on the Live tab')
  check(await until(async () => (await active()) !== 'body'), 'after the History run link focus is not on body', await active())
  const s1 = await windowShift(page)
  check(s1.ok, 'opening the run did not shift the window', JSON.stringify(s1))

  // ======== 10. Keyboard pass at 1024x640 ========
  await setSize(1024, 640)
  await openKnowledge()
  await page.locator('[data-testid=knowledge-row]').first().waitFor({ state: 'visible' })
  check((await page.locator('[data-testid=knowledge-detail]').getAttribute('data-collapsed')) === 'true', 'at 1024x640 the detail pane starts as its rail')
  await fitsWindow('Knowledge list (1024x640 dark)')
  await shot('list-1024-dark')
  await page.locator('[data-testid=tab-knowledge]').focus()
  const order = []
  for (let i = 0; i < 24; i++) {
    await page.keyboard.press('Tab')
    order.push(await active())
    if (order[order.length - 1].includes('[knowledge-row]')) break
  }
  // One more Tab leaves the list (the pane's rail button at this size): the list is one stop.
  await page.keyboard.press('Tab')
  const afterList = await active()
  const want = ['knowledge-view-switch', 'knowledge-add-note', 'knowledge-add-item', 'knowledge-search', 'knowledge-kind-all', 'knowledge-kind', 'knowledge-origin', 'knowledge-show-retired', 'knowledge-row']
  const name = (o) => want.find((w) => o.includes(`[${w}]`)) ?? (o.startsWith('input') && !o.includes('[') ? 'knowledge-view-switch' : null)
  const named = order.map(name)
  const from = named.indexOf('knowledge-view-switch')
  const seen = named.slice(from).filter((x, i, a) => x && a.indexOf(x) === i)
  check(from >= 0 && JSON.stringify(seen) === JSON.stringify(want) && named.slice(from).every(Boolean), 'Tab order: view switch, Add a note, Add an item, Search, kind chips, origin chips, Show retired, the list', JSON.stringify(order))
  check(order.filter((o) => o.includes('[knowledge-row]')).length === 1 && !afterList.includes('[knowledge-row]') && /Show item details/.test(afterList), 'the list is one Tab stop, then the pane', `${JSON.stringify(order)} then ${afterList}`)
  // Into the list: Up / Down / Enter / Esc / Shift+F10.
  await page.locator('[data-testid=knowledge-row]').first().focus()
  const firstName = await page.locator('[data-testid=knowledge-row]').first().locator('[data-testid=knowledge-row-name]').innerText()
  await page.keyboard.press('ArrowDown')
  const second = await page.evaluate(() => document.activeElement?.querySelector('[data-testid=knowledge-row-name]')?.textContent)
  check(second && second !== firstName && (await active()).includes('knowledge-row'), 'ArrowDown moves to the next row', `${firstName} -> ${second}`)
  check((await page.evaluate(() => document.activeElement?.getAttribute('aria-selected'))) === 'true', 'the selection follows the focused row')
  await page.keyboard.press('ArrowUp')
  check((await page.evaluate(() => document.activeElement?.querySelector('[data-testid=knowledge-row-name]')?.textContent)) === firstName, 'ArrowUp moves back')
  await page.keyboard.press('End')
  check((await page.evaluate(() => document.activeElement?.querySelector('[data-testid=knowledge-row-name]')?.textContent)) === (await page.locator('[data-testid=knowledge-row-name]').last().innerText()), 'End moves to the last row')
  await page.keyboard.press('Home')
  await page.keyboard.type('s')
  check((await page.evaluate(() => document.activeElement?.querySelector('[data-testid=knowledge-row-name]')?.textContent)) === 'Stripe', 'type-ahead "s" lands on Stripe', await page.evaluate(() => document.activeElement?.textContent))
  await page.keyboard.press('Enter')
  check(await until(async () => (await active()).includes('knowledge-detail-heading')), 'Enter opens the pane with focus on its heading', await active())
  check((await page.locator('[data-testid=knowledge-detail]').getAttribute('data-collapsed')) === 'false', 'the pane opened on Enter at 1024x640')
  await fitsWindow('Knowledge with the pane open (1024x640 dark)')
  await shot('detail-1024-dark')
  await page.keyboard.press('Escape')
  check(await until(async () => (await active()).includes('knowledge-row') && (await page.evaluate(() => document.activeElement?.querySelector('[data-testid=knowledge-row-name]')?.textContent)) === 'Stripe'), 'Esc on the heading returns focus to the row', await active())
  await page.keyboard.press('Shift+F10')
  const menu = page.locator('[data-testid=knowledge-row-more]')
  check(await until(async () => await menu.evaluate((el) => el.matches(':popover-open'))), 'Shift+F10 opens the row\'s More actions menu')
  check(await until(async () => (await active()).includes('{menuitem}')), 'the menu takes focus on its first item', await active())
  const menuItems = await menu.locator('[role=menuitem]').evaluateAll((els) => els.map((e) => e.textContent.trim()))
  check(JSON.stringify(menuItems) === JSON.stringify(['Open', 'Retire']), 'the menu offers Open and Retire for an item', JSON.stringify(menuItems))
  await page.keyboard.press('Escape')
  check(await until(async () => (await active()).includes('knowledge-row')), 'Esc closes the menu and returns focus to the row', await active())
  // Shift+F10 on the note row offers Edit.
  await page.keyboard.press('End')
  await page.keyboard.press('Shift+F10')
  await until(async () => await menu.evaluate((el) => el.matches(':popover-open')))
  const noteMenu = await menu.locator('[role=menuitem]').evaluateAll((els) => els.map((e) => e.textContent.trim()))
  check(noteMenu.includes('Edit'), 'the menu offers Edit for a note', JSON.stringify(noteMenu))
  await page.keyboard.press('Escape')
  const s2 = await windowShift(page)
  check(s2.ok, 'the keyboard pass did not shift the window', JSON.stringify(s2))

  // ======== 11. Both sizes and themes ========
  for (const [w, h] of [[1024, 640], [1600, 1000]]) {
    for (const theme of ['dark', 'light']) {
      const tag = `${w}x${h} ${theme}`
      await setSize(w, h)
      await setTheme(theme)
      await openProject(page, ENG)
      await openKnowledge()
      await page.locator('[data-testid=knowledge-row]').first().waitFor({ state: 'visible' })
      await openRow('Jane Doe')
      await fitsWindow(`${tag} Knowledge with Jane Doe open`)
      const sh = await windowShift(page)
      check(sh.ok, `${tag}: no window shift`, JSON.stringify(sh))
      await shot(`knowledge-${w}-${theme}`)
      // The retire notice at this size and theme: no page scroll, no window shift, then Undo.
      await openRow('Billing platform')
      await page.locator('[data-testid=knowledge-detail-body] [data-testid=knowledge-retire]').click()
      await notice.waitFor({ state: 'visible' })
      await fitsWindow(`${tag} Knowledge with the notice`)
      const shn = await windowShift(page)
      check(shn.ok, `${tag}: no window shift with the notice`, JSON.stringify(shn))
      await shot(`notice-${w}-${theme}`)
      await page.locator('[data-testid=knowledge-notice-undo]').click()
      check(await until(async () => (await notice.count()) === 0 && (await rowName()) === 'Billing platform'), `${tag}: Undo clears the notice and focuses Billing platform`, `${await active()} ${await rowName()}`)
      const nameCut =await page.locator('[data-testid=knowledge-row-name]').evaluateAll((els) => els.some((e) => e.scrollWidth > e.clientWidth + 1))
      check(!nameCut, `${tag}: no row name is cut`)
      await page.locator('[data-testid=knowledge-view-switch] label', { hasText: 'Graph' }).click()
      check(await until(async () => (await page.locator('[data-testid=knowledge-view]').getAttribute('data-view')) === 'graph'), `${tag}: the view switch shows the Graph`)
      check((await page.locator('[data-testid=knowledge-graph]').count()) === 1, `${tag}: the graph component renders in place of the list`)
      await fitsWindow(`${tag} Graph view`)
      await page.locator('[data-testid=knowledge-view-switch] label', { hasText: 'List' }).click()
      await page.locator('[data-testid=knowledge-row]').first().waitFor({ state: 'visible' })
    }
  }
  check((await page.evaluate((id) => localStorage.getItem(`orgai.knowledgeView.${id}`), eng.id)) === 'list', 'the view choice is remembered per project')

  // ======== 12. Retire in the Graph view, and Hide item details ========
  await openRow('Billing platform')
  await page.locator('[data-testid=knowledge-view-switch] label', { hasText: 'Graph' }).click()
  await page.locator('[data-testid=knowledge-graph]').waitFor({ state: 'visible' })
  await page.locator('[data-testid=knowledge-detail-body] [data-testid=knowledge-retire]').click()
  await notice.waitFor({ state: 'visible' })
  check(await until(async () => (await active()).includes('knowledge-notice-undo')), 'a retire in the Graph view lands focus on Undo', await active())
  await page.locator('[data-testid=knowledge-notice-undo]').click()
  check(await until(async () => (await notice.count()) === 0 && (await nodeNamed(eng.id, 'Billing platform'))?.retired !== true), 'Undo in the Graph view restores Billing platform and clears the notice')
  check(await until(async () => (await active()).includes('knowledge-add-note')), 'after Undo in the Graph view focus lands on Add a note', await active())
  await page.locator('[data-testid=knowledge-view-switch] label', { hasText: 'List' }).click()
  await page.locator('[data-testid=knowledge-row]').first().waitFor({ state: 'visible' })
  const pane = page.locator('[data-testid=knowledge-detail]')
  check((await pane.getAttribute('data-collapsed')) === 'false', 'the detail pane is open before Hide')
  await pane.getByRole('button', { name: 'Hide item details' }).click()
  check(await until(async () => (await pane.getAttribute('data-collapsed')) === 'true'), 'Hide item details collapses the pane')
  check(await until(async () => /Show item details/.test(await active())), 'Hide item details lands focus on "Show item details"', await active())
  await pane.getByRole('button', { name: 'Show item details' }).click()
  check(await until(async () => (await pane.getAttribute('data-collapsed')) === 'false'), 'Show item details reopens the pane')
  check(true, `after Show item details focus is ${await active()}`)
} catch (e) {
  check(false, 'script ran to the end', e.stack ?? e.message)
  await shot('failure').catch(() => {})
} finally {
  for (const n of [CODE, ENG]) await deleteProject(page, n).catch(() => {})
  await app.close().catch(() => {})
  removeFixture(codeRepo)
  fs.rmSync(base, { recursive: true, force: true })
  finish('knowledge')
}
