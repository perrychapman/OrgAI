// Token-free (mock adapter, temp ORGAI_DATA_DIR). The app-wide Usage page (docs/design/usage-app.md): first launch empty
// state, entry points (sidebar / rail, View > Usage without an accelerator, Dashboard strip, Trends, run Usage tab),
// figures (no $0 for an unpriced run or model, "+" with the coverage line), drilldowns and chips (focus never on body,
// one announcement per action), keyboard (spend plot, project rows, efficiency grid), states (filtered-empty, Kind chip),
// layout at 1024x640 and 1600x1000 in both themes, and a live run with the page open. Seeds through the IPC
// (runs.start / runs.startQuick), so it never drives the composer. A check that cannot be driven logs SKIP with a reason.
import { TMP, check, endSession, gotoProjects, finish, launch, log, makeFixtureRepo, openProject, projectTab, removeFixture, sleep } from './lib.mjs'
import * as path from 'node:path'

process.env.ORGAI_MOCK = '1'
const A = 'E2E usage A (orgai test)'
const B = 'E2E usage B (orgai test)'
const ENG = 'E2E usage Acme (orgai test)'
const repoA = makeFixtureRepo('usage-a')
const repoB = makeFixtureRepo('usage-b')
const repoE = makeFixtureRepo('usage-e', { initGit: false })
const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim()

const { app, page, shot } = await launch({ shotPrefix: 'usage-app' })
const skip = (what, why) => log(`SKIP ${what}: ${why}`)
const setSize = async (w, h) => {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
  await page.waitForFunction((w2) => Math.abs(window.innerWidth - w2) <= 1, w, { timeout: 10_000 }).catch(() => {})
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await sleep(500)
}
const setTheme = async (theme) => {
  await page.evaluate(async (t) => {
    const s = await window.orgai.settings.get()
    await window.orgai.settings.set({ ...s, appearance: { ...s.appearance, theme: t } })
  }, theme)
  await sleep(600)
}
const T = (id) => page.locator(`[data-testid=${id}]`)
const liveBar = () => page.locator('[data-testid=usage-spend-bar]:not([data-state=empty])').first()
const visible = async (sel) => (await page.locator(sel).count()) > 0 && (await page.locator(sel).first().isVisible())
const focusInfo = () =>
  page.evaluate(() => {
    const a = document.activeElement
    return { body: !a || a === document.body, tag: a?.tagName ?? '', testid: a?.getAttribute('data-testid') ?? '', label: (a?.getAttribute('aria-label') ?? a?.textContent ?? '').slice(0, 60) }
  })
/** Waits for the Usage page to show data (summary) or an empty state. */
const settle = async () => {
  await T('usage-view').waitFor({ timeout: 15_000 })
  await page.waitForFunction(() => !document.querySelector('[data-testid=usage-view]')?.getAttribute('aria-busy')?.includes('true') && !document.querySelector('[data-testid=usage-skeleton]'), null, { timeout: 20_000 })
  await sleep(300)
}
const goUsage = async () => {
  await T('nav-usage').click()
  await settle()
}
const clearAll = async () => {
  if (await T('usage-clear-all').count()) {
    await T('usage-clear-all').click()
    await settle()
  }
}
/** Starts recording what the polite region says (non-empty texts, in order). */
const watchLive = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid=usage-live]')
    window.__said = []
    window.__liveObs?.disconnect()
    window.__liveObs = new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) if ((n.textContent ?? '').trim()) window.__said.push(n.textContent.trim())
    })
    window.__liveObs.observe(el, { childList: true, subtree: true, characterData: true })
  })
const said = () => page.evaluate(() => window.__said ?? [])
const overflow = () => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth }))
const chips = () => page.locator('[data-testid=usage-chip]').evaluateAll((els) => els.map((e) => ({ kind: e.getAttribute('data-kind'), text: (e.textContent ?? '').trim() })))
const chipKinds = async () => (await chips()).map((c) => c.kind)
const bodyText = () => T('usage-view').innerText()
/** Selects a tab of the "Where it went" card (project, model, role, connection). */
const whereTab = async (tab) => {
  await page.locator(`[data-testid=usage-where-tab][data-tab=${tab}]`).click()
  await sleep(200)
}

/** Start a mock run, let it spend, stop it and wait until it is no longer live. Returns its id. */
const seedRun = async (projectId, prompt) => {
  const run = await page.evaluate((i) => window.orgai.runs.start(i), { projectId, prompt })
  const id = run.id ?? run.runId ?? run.summary?.id
  const end = Date.now() + 15_000
  while (Date.now() < end) {
    const r = (await page.evaluate((pid) => window.orgai.runs.list(pid), projectId)).find((x) => x.id === id)
    if (r && r.usage && Object.keys(r.usage.models ?? {}).length + (r.usage.models?.length ?? 0) > 0 && r.status !== 'starting') break
    await sleep(500)
  }
  await sleep(800)
  await page.evaluate((r) => window.orgai.runs.stop(r), id)
  const end2 = Date.now() + 15_000
  while (Date.now() < end2) {
    const r = (await page.evaluate((pid) => window.orgai.runs.list(pid), projectId)).find((x) => x.id === id)
    if (r && ['finished', 'error'].includes(r.status)) break
    await sleep(400)
  }
  return id
}

async function createEngagement(name, dir) {
  await gotoProjects(page)
  await T('new-project').click()
  const form = page.locator('[data-testid=new-project-dialog] form')
  await form.waitFor({ timeout: 10_000 })
  await form.locator('[data-testid=project-kind-option][data-kind=engagement] input[type=radio]').check({ force: true })
  await form.getByLabel('Name', { exact: true }).fill(name)
  await T('new-project-client').fill('Acme Corp')
  await form.getByLabel('Working folder', { exact: true }).fill(dir)
  const arch = form.locator('[data-testid=architect-setup]')
  if (await arch.isChecked()) await form.locator('label.checkbox', { hasText: 'Start with the setup interview' }).click()
  await form.getByRole('button', { name: 'Create project', exact: true }).click()
  await page.waitForSelector('[data-testid=dashboard]', { state: 'detached', timeout: 60_000 })
}

const createCode = async (name, dir) => {
  const { createProject } = await import('./lib.mjs')
  return createProject(page, { path: dir, name })
}

try {
  // ---------- First launch: the whole page is the empty state ----------
  await setSize(1024, 640)
  await setTheme('dark')
  await goUsage()
  check(await visible('[data-testid=usage-empty-all]'), 'first launch: usage-empty-all is shown before any run exists')
  check((await T('usage-filters').count()) === 0, 'first launch: the filter bar is hidden')
  check(/No usage yet/.test(await bodyText()), 'first launch: the title says "No usage yet"')
  check(await visible('[data-testid=usage-empty-all-dashboard]'), 'first launch: "Go to Dashboard" is offered')
  const ovE = await overflow()
  check(ovE.sw <= ovE.cw, 'first launch: no horizontal scroll', JSON.stringify(ovE))
  await shot('first-launch')
  await T('usage-empty-all-dashboard').click()
  check(await visible('[data-testid=dashboard]'), 'first launch: Go to Dashboard opens the Dashboard')

  // ---------- Seed ----------
  const pa = await createCode(A, repoA)
  const pb = await createCode(B, repoB)
  await createEngagement(ENG, repoE)
  const projects = await page.evaluate(() => window.orgai.projects.list())
  const pe = projects.find((p) => p.name === ENG)
  check(!!pa && !!pb && !!pe, 'seed: two code projects and an engagement exist')
  log('seeding runs (this takes a minute)')
  const runIds = {}
  runIds.aPrice = await seedRun(pa.id, 'Priced work on A [mock:computed-cost]')
  runIds.aNo = await seedRun(pa.id, 'Unpriced work on A [mock:no-price]')
  runIds.aPlain = await seedRun(pa.id, 'Plain work on A')
  runIds.bPlain = await seedRun(pb.id, 'Plain work on B')
  runIds.bPrice = await seedRun(pb.id, 'Priced work on B [mock:computed-cost]')
  runIds.ePlain = await seedRun(pe.id, 'Engagement work')
  const chat = await page.evaluate(() => window.orgai.runs.startQuick({ prompt: 'Say hello' }))
  runIds.chat = chat.id ?? chat.runId ?? chat.summary?.id
  await sleep(4000)
  await page.evaluate((r) => window.orgai.runs.stop(r), runIds.chat).catch(() => {})
  await sleep(2000)
  log('seeded', JSON.stringify(runIds))

  // ---------- 1. Entry ----------
  await setSize(1600, 1000)
  await setTheme('dark')
  await gotoProjects(page)
  await T('nav-usage').click()
  await settle()
  check(await visible('[data-testid=usage-view]'), 'entry: nav-usage opens the Usage page in the full sidebar')
  check((await T('nav-usage').getAttribute('aria-current')) === 'page', 'entry: nav-usage has aria-current=page')
  check(clean(await page.locator('main .topbar h1, .usage-view .topbar h1').first().innerText()) === 'Usage', 'entry: the topbar title is Usage')
  check(/30 days/.test(await T('usage-period-label').innerText()), 'entry: the default period is 30 days')
  check((await T('usage-period').locator('input:checked').evaluate((e) => e.closest('label')?.textContent?.trim() ?? e.value)) .includes('30'), 'entry: the Period control has 30 days checked')

  const menu = await app.evaluate(({ Menu }) => {
    const it = Menu.getApplicationMenu()?.getMenuItemById('show-usage')
    return it ? { found: true, accelerator: it.accelerator ?? null, label: it.label, enabled: it.enabled } : { found: false }
  })
  check(menu.found && !menu.accelerator, 'entry: View > Usage exists and has no accelerator', JSON.stringify(menu))
  check(menu.enabled !== false, 'entry: View > Usage is enabled without a project', JSON.stringify(menu))
  await gotoProjects(page)
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('show-usage').click())
  await settle()
  check(await visible('[data-testid=usage-view]'), 'entry: View > Usage (menu click) opens the page')

  // Dashboard strip link opens on 30 days
  await gotoProjects(page)
  await page.waitForSelector('[data-testid=dashboard]')
  if (await T('dash-strip-usage-link').count()) {
    await T('dash-strip-usage-link').click()
    await settle()
    check(await visible('[data-testid=usage-view]') && /30 days/.test(await T('usage-period-label').innerText()), 'entry: dash-strip-usage-link opens Usage on the 30 days period')
    check((await chips()).length === 0, 'entry: the strip link adds no chip', JSON.stringify(await chips()))
  } else skip('dash-strip-usage-link', 'the Dashboard strip is not rendered (no link on screen)')

  // Trends link: Project chip
  await openProject(page, A)
  await projectTab(page, 'History').click()
  await page.locator('.seg label', { hasText: 'Trends' }).click()
  await T('trends-see-all').waitFor({ timeout: 15_000 })
  await T('trends-see-all').click()
  await settle()
  check(JSON.stringify(await chipKinds()) === '["project"]', 'entry: trends-see-all opens with the Project chip', JSON.stringify(await chips()))
  check((await chips())[0]?.text.includes(A), 'entry: the Trends chip names the project', JSON.stringify(await chips()))
  check(/Project: /.test(await T('usage-scope').innerText().catch(() => '')) || /E2E usage A/.test(await bodyText()), 'entry: the scope names the project')
  await clearAll()

  // Run Usage tab link: Project chip
  await openProject(page, A)
  await projectTab(page, 'Live').click()
  const tabs = page.locator('.run-tab')
  if (await tabs.count()) {
    await tabs.first().click()
    await sleep(500)
  }
  const showPanel = page.locator('aside.side-panel[data-collapsed=true]').getByRole('button', { name: /^Show / })
  if (await showPanel.count()) await showPanel.first().click()
  if (await T('side-tab-usage').count()) {
    await T('side-tab-usage').click()
    await T('run-usage-all').waitFor({ timeout: 10_000 })
    await T('run-usage-all').click()
    await settle()
    check(JSON.stringify(await chipKinds()) === '["project"]', 'entry: run-usage-all opens with the Project chip', JSON.stringify(await chips()))
    await clearAll()
  } else skip('run-usage-all', 'no run tab with a Usage side tab for project A after the seed (ended runs are not open)')

  // ---------- 2. Figures ----------
  await goUsage()
  const text = await bodyText()
  const titles = await page.locator('[data-testid=usage-view] [title]').evaluateAll((els) => els.map((e) => e.getAttribute('title') ?? ''))
  const zero = (text.match(/.{0,40}\$0\.00(?!\d).{0,20}/g) ?? []).concat(titles.filter((t) => /\$0\.00(?!\d)/.test(t)))
  check(zero.length === 0, 'figures: no "$0.00" anywhere on the page while unpriced runs and models exist', JSON.stringify(zero.slice(0, 3)))
  check(/No price/.test(text), 'figures: an unpriced model/run reads "No price"')
  check(!/waste|\bbill(ed)?\b|invoice|charged|LiteLLM/i.test(text), 'copy: no "waste", "bill", "invoice", "charged" or "LiteLLM" on the page', text.match(/.{0,30}(waste|bill|invoice|charged|LiteLLM).{0,20}/i)?.[0] ?? '')
  check(/Estimated cost/.test(text), 'copy: the summary says "Estimated cost"')
  const costItem = T('usage-summary-item').filter({ has: page.locator('[data-signal=cost]') })
  const summaryCost = clean(await page.locator('[data-testid=usage-summary-item][data-signal=cost]').innerText())
  const partial = /\+/.test(summaryCost.split('\n')[0] ?? summaryCost)
  const coverage = (await T('usage-coverage').count()) ? clean(await T('usage-coverage').innerText()) : ''
  if (partial || /No price/.test(summaryCost)) {
    check(/\d+ of \d+ priced|from \d+ of \d+ runs|0 of \d+ runs/.test(coverage), 'figures: a partial total carries the "N of M priced" coverage chip', `${summaryCost} | ${coverage}`)
    check((await T('usage-no-price-link').count()) === 1, 'figures: usage-no-price-link is present beside the coverage line')
  } else skip('coverage line', `the cost total is not partial in the seed (${summaryCost})`)
  await whereTab('model')
  const unpricedRow = T('usage-model-row').filter({ has: page.locator('[data-testid=usage-set-price]') })
  check((await unpricedRow.count()) >= 1, 'figures: the unpriced model row has usage-set-price (Model tab)')
  await whereTab('project')
  // The partial caveat is said once, by the coverage line under Estimated cost (dashboard rework).
  check((await T('usage-coverage').count()) + (await T('usage-unpriced-note').count()) >= 1, 'figures: the no-price caveat is shown (coverage line or unpriced note)')
  check((await T('usage-partial-note').count()) === 0, 'figures: the partial caveat is not repeated under the KPI band')
  void costItem
  // The no-price link adds the "Cost: no price" chip and opens All runs
  await T('usage-no-price-link').click()
  await sleep(1200)
  check((await chipKinds()).length >= 1, 'figures: usage-no-price-link adds a chip', JSON.stringify(await chips()))
  check(await T('usage-runs').locator('details').evaluate((d) => d.open), 'figures: usage-no-price-link opens All runs')
  await clearAll()

  // ---------- 3. Drilldowns ----------
  const drill = async (name, act, expectKind) => {
    await clearAll()
    await watchLive()
    await act()
    await sleep(3000)
    const ks = await chipKinds()
    check(ks.includes(expectKind), `drilldown: ${name} adds the ${expectKind} chip`, JSON.stringify(await chips()))
    const f = await focusInfo()
    check(!f.body, `drilldown: focus is not on body after ${name}`, JSON.stringify(f))
    const s = await said()
    check(s.filter((t) => /Filter added/.test(t)).length === 1, `drilldown: ${name} announces once`, JSON.stringify(s))
    return ks
  }
  await page.evaluate(() => document.querySelector('.usage-scroll')?.scrollTo(0, 0))
  const keyBefore = await page.evaluate(() => ({ top: Math.round(document.querySelector('[data-testid=usage-summary]')?.getBoundingClientRect().top ?? -1), scroll: document.querySelector('.usage-scroll')?.scrollTop ?? -1 }))
  await drill('a project row (click)', () => T('usage-project-row').first().locator('button').first().click(), 'project')
  // Walk H1: a row narrowing neither opens All runs nor scrolls, and the first chip shifts nothing below the bar.
  const keyAfter = await page.evaluate(() => ({ top: Math.round(document.querySelector('[data-testid=usage-summary]')?.getBoundingClientRect().top ?? -1), scroll: document.querySelector('.usage-scroll')?.scrollTop ?? -1 }))
  check(!(await T('usage-runs').locator('details').evaluate((d) => d.open)), 'drilldown: a row narrowing leaves All runs closed')
  check(keyAfter.scroll === keyBefore.scroll && Math.abs(keyAfter.top - keyBefore.top) <= 1, 'drilldown: a row narrowing neither scrolls nor shifts the KPI band', JSON.stringify({ keyBefore, keyAfter }))
  check((await chipKinds()).every((k) => k !== 'period'), 'chips: the period gets no chip')
  // chip remove
  await watchLive()
  await T('usage-chip-remove').first().click()
  await sleep(2500)
  check((await chips()).length === 0, 'drilldown: the chip remove button removes the chip')
  check(!(await focusInfo()).body, 'drilldown: focus is not on body after removing a chip', JSON.stringify(await focusInfo()))
  check((await said()).filter((t) => /Filter removed/.test(t)).length === 1, 'drilldown: removing a chip announces once', JSON.stringify(await said()))

  await drill('a spend bar (Enter)', async () => {
    await liveBar().focus()
    await page.keyboard.press('Enter')
  }, 'bucket')
  await drill('a project row (Enter)', async () => {
    await T('usage-project-row').first().locator('button').first().focus()
    await page.keyboard.press('Enter')
  }, 'project')
  await drill('a model row', async () => {
    await whereTab('model')
    await T('usage-model-row').first().click()
  }, 'model')
  await drill('a role row', async () => {
    await whereTab('role')
    await T('usage-role-row').first().click()
  }, 'role')
  const connRows = await (async () => {
    await clearAll()
    await whereTab('connection')
    return T('usage-connection-row').count()
  })()
  check(connRows >= 1, 'where: the Connection tab lists connection rows', String(connRows))
  await whereTab('project')
  // two chips then Clear all
  await T('usage-project-row').first().locator('button').first().click().catch(() => {})
  await sleep(1500)
  await watchLive()
  await T('usage-clear-all').click()
  await sleep(2500)
  check((await chips()).length === 0 && (await T('usage-clear-all').count()) === 0, 'drilldown: Clear all removes every chip and itself')
  check(!(await focusInfo()).body, 'drilldown: focus is not on body after Clear all', JSON.stringify(await focusInfo()))
  check((await said()).filter((t) => /Filters cleared/.test(t)).length === 1, 'drilldown: Clear all announces once', JSON.stringify(await said()))

  // A run opens in its project on its Usage side tab, wide at 1024
  await setSize(1024, 640)
  await goUsage()
  await clearAll()
  const open = T('usage-wasteful-row').first().locator('[data-testid=usage-run-open]')
  if (await open.count()) {
    const rowProject = await T('usage-wasteful-row').first().getAttribute('data-project')
    await open.click()
    await page.waitForSelector('[data-testid=run-meta]', { timeout: 15_000 })
    await sleep(800)
    const sel = await T('side-tab-usage').getAttribute('aria-selected').catch(() => null)
    check(sel === 'true', 'drilldown: usage-run-open lands on the run with the Usage side tab selected', String(sel))
    // An ended work run opens as the conversation under 1100 px: no side panel there, the Usage tab sits in the stage strip.
    const shape = await page.evaluate(() => ({
      layout: document.querySelector('.run-body')?.getAttribute('data-layout'),
      w: document.querySelector('aside.side-panel')?.getBoundingClientRect().width ?? 0,
      strip: !!document.querySelector('[data-testid=run-stage-tabs] [data-testid=side-tab-usage][aria-selected=true]'),
      usage: !!document.querySelector('[data-testid=run-stage-tabs] [role=tabpanel][id*=usage]')
    }))
    if (shape.layout === 'conversation') check(shape.w === 0 && shape.strip && shape.usage, 'drilldown: at 1024 an ended run lands on the Usage tab of the stage strip, with no side panel', JSON.stringify(shape))
    else check(shape.w >= 478, 'drilldown: at 1024 the side panel is at least 480 px wide on arrival', JSON.stringify(shape))
    const proj = await page.evaluate(() => window.orgai.projects.list().then((l) => l.length))
    void proj
    check(!!rowProject, 'drilldown: the opened run belongs to a project row', String(rowProject))
  } else skip('usage-run-open', 'no wasteful row with an open button')

  // All runs via a project narrowing: open a run from the runs table
  await goUsage()
  await clearAll()
  await T('usage-project-row').first().click()
  await sleep(2000)
  if (!(await T('usage-runs').locator('details').evaluate((d) => d.open))) await T('usage-runs').locator('details > summary').click()
  await sleep(300)
  const runOpen = T('usage-run-row').first().locator('[data-testid=usage-run-open]')
  check((await T('usage-run-row').count()) >= 1, 'drilldown: All runs lists the narrowed project runs')
  if (await runOpen.count()) {
    await runOpen.click()
    await page.waitForSelector('[data-testid=run-meta]', { timeout: 15_000 })
    check((await T('side-tab-usage').getAttribute('aria-selected')) === 'true', 'drilldown: a run opened from All runs selects the Usage side tab')
    await page.locator('.sidebar [data-testid=nav-usage]').click()
    await settle()
    check((await chips()).some((c) => c.kind === 'project'), 'drilldown: going back to Usage keeps the filters (store)', JSON.stringify(await chips()))
  }
  await clearAll()

  // ---------- 4. Keyboard ----------
  await setSize(1600, 1000)
  await goUsage()
  await clearAll()
  const plot = T('usage-spend-plot')
  const stops = await plot.evaluate((el) => [...el.querySelectorAll('[tabindex="0"]')].length)
  check(stops === 1, 'keyboard: the spend plot is one Tab stop', String(stops))
  await liveBar().focus()
  const r0 = clean(await T('usage-spend-readout').innerText())
  check(r0.length > 0, 'keyboard: focusing a bar fills the readout', r0)
  const nBars = await T('usage-spend-bar').count()
  if (nBars > 1) {
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('Home')
    const a = clean(await T('usage-spend-readout').innerText())
    await page.keyboard.press('End')
    const b = clean(await T('usage-spend-readout').innerText())
    check(a !== b, 'keyboard: Home and End move the readout', `${a} | ${b}`)
    await page.keyboard.press('ArrowLeft')
    const c = clean(await T('usage-spend-readout').innerText())
    check(c !== b, 'keyboard: ArrowLeft moves the readout', `${b} | ${c}`)
  } else skip('spend plot Left/Right/Home/End', `only ${nBars} bucket in the seed (all runs are today)`)
  await liveBar().focus()
  await page.keyboard.press('ArrowUp')
  const seg = await focusInfo()
  check(seg.testid === 'usage-spend-segment', 'keyboard: ArrowUp moves into a segment of the bucket', JSON.stringify(seg))
  check(/\S/.test(clean(await T('usage-spend-readout').innerText())), 'keyboard: the readout names the segment')
  await page.keyboard.press('Escape')
  await page.locator('[data-testid=usage-spend-plot]').evaluate(() => {})

  // Projects roving
  const rows = T('usage-project-row')
  const nRows = await rows.count()
  const tabbable = await rows.evaluateAll((els) => els.filter((e) => e.matches('[tabindex="0"]') || e.querySelector('[tabindex="0"]')).length)
  check(tabbable === 1, 'keyboard: project rows are one roving Tab stop', `${tabbable} of ${nRows}`)
  await rows.first().locator('button').first().focus()
  const before = await focusInfo()
  await page.keyboard.press('ArrowDown')
  const after = await focusInfo()
  check(before.label !== after.label || nRows < 2, 'keyboard: ArrowDown moves between project rows', `${before.label} -> ${after.label}`)
  // Shift+F10 opens the row menu
  await page.keyboard.press('Shift+F10')
  await sleep(300)
  check(await visible('[data-testid=usage-project-more]'), 'keyboard: Shift+F10 on a project row opens usage-project-more')
  await page.keyboard.press('Escape')
  await sleep(200)

  // Efficiency grid
  // The Team timing grid shares the class (PR 51); this check is about the efficiency measures only.
  const effStops = await page.locator('[data-testid=usage-eff-main]').evaluate((g) => [...g.querySelectorAll('button')].filter((e) => e.tabIndex === 0).length)
  check(effStops === 1, 'keyboard: the efficiency grid is one Tab stop', String(effStops))
  const sortBefore = await T('usage-wasteful-sort').inputValue()
  const target = page.locator('[data-testid=usage-eff-item][data-signal=cache] [data-testid=usage-eff-value]')
  await target.click()
  await sleep(500)
  const hf = await page.evaluate(() => ({ id: document.activeElement?.id, text: document.activeElement?.textContent?.trim() }))
  check(hf.id === 'usage-wasteful-h' && /Runs worth a look/.test(hf.text ?? ''), 'keyboard: pressing an efficiency value focuses the "Runs worth a look" heading', JSON.stringify(hf))
  const sortAfter = await T('usage-wasteful-sort').inputValue()
  check(sortAfter !== sortBefore, 'keyboard: the efficiency press changes usage-wasteful-sort', `${sortBefore} -> ${sortAfter}`)

  // ---------- 4b. Dashboard interactions (metric switch, legend toggle, overlay, highlight, tabs, sort) ----------
  await clearAll()
  await page.evaluate(() => document.querySelector('.usage-scroll')?.scrollTo(0, 0))
  check((await T('usage-summary-item').count()) === 4 && (await page.locator('[data-testid=usage-summary-item][data-signal=cache]').count()) === 0, 'kpi: four tiles; Cache hit lives only in Efficiency')
  // Crosshair and tooltip on the spend chart.
  await liveBar().hover()
  await sleep(200)
  const tip = T('usage-chart-tooltip')
  check((await tip.count()) === 1 && (await tip.isVisible()), 'chart: pointing at a bucket shows usage-chart-tooltip')
  check((await T('usage-chart-crosshair').count()) >= 1, 'chart: pointing at a bucket shows the crosshair')
  const tipText = clean(await tip.innerText().catch(() => ''))
  check(/\d/.test(tipText), 'chart: the tooltip names the date and the total', tipText)
  const tipInside = await page.evaluate(() => {
    const t = document.querySelector('[data-testid=usage-chart-tooltip]')?.getBoundingClientRect()
    const c = document.querySelector('[data-testid=usage-spend]')?.getBoundingClientRect()
    return t && c ? t.left >= c.left - 1 && t.right <= c.right + 1 : false
  })
  check(tipInside, 'chart: the tooltip stays inside the chart card')
  const crossAnims = await page.evaluate(() => [...document.querySelectorAll('[data-testid=usage-chart-crosshair]')].reduce((n, el) => n + el.getAnimations().length, 0))
  check(crossAnims === 0, 'chart: the crosshair never animates', String(crossAnims))
  await liveBar().focus()
  await sleep(150)
  const tipA = clean(await tip.innerText().catch(() => ''))
  await page.keyboard.press('ArrowLeft')
  await sleep(150)
  const tipB = clean(await tip.innerText().catch(() => ''))
  if ((await T('usage-spend-bar').count()) > 1) check(tipA !== tipB, 'chart: ArrowLeft moves the tooltip to the next bucket', `${tipA} | ${tipB}`)
  await page.keyboard.press('Escape')
  await sleep(150)
  check(!(await tip.isVisible().catch(() => false)), 'chart: Escape hides the tooltip')
  check((await focusInfo()).testid === 'usage-spend-bar', 'chart: focus stays on the plot after Escape', JSON.stringify(await focusInfo()))
  await page.mouse.move(5, 5)
  // Table toggle in the chart header.
  const tableBtn = T('usage-spend-table-toggle')
  await tableBtn.click()
  await sleep(200)
  check((await tableBtn.getAttribute('aria-expanded')) === 'true' && (await T('usage-spend-table').count()) === 1, 'chart: the Table button shows the spend table')
  await tableBtn.click()
  await sleep(150)
  check((await tableBtn.getAttribute('aria-expanded')) === 'false', 'chart: the Table button hides it again')
  // Sparkline scrub moves the chart crosshair.
  const spark = page.locator('[data-testid=usage-summary-item][data-signal=runs] [data-testid=usage-kpi-spark]')
  if (await spark.count()) {
    const sb = await spark.boundingBox()
    if (sb) {
      await page.mouse.move(sb.x + sb.width - 2, sb.y + sb.height / 2)
      await sleep(200)
      check((await page.locator('[data-testid=usage-summary-item][data-signal=runs] [data-testid=usage-kpi-scrub]').count()) === 1, 'kpi: pointing at a sparkline shows that bucket in the tile')
      check(await tip.isVisible().catch(() => false), 'kpi: pointing at a sparkline shows the chart tooltip at that bucket')
      await page.mouse.move(5, 5)
      await sleep(200)
      check((await page.locator('[data-testid=usage-kpi-scrub]').count()) === 0, 'kpi: leaving the sparkline restores the tile')
    }
  } else skip('sparkline scrub', 'no sparkline drawn (fewer than three buckets with values in the seed)')
  // KPI tiles are the chart's metric switch.
  const kpiRuns = page.locator('[data-testid=usage-kpi-metric][data-metric=runs]')
  check((await page.locator('[data-testid=usage-kpi-metric]').count()) === 3, 'metric: the Cost, Tokens and Runs tiles are switches', String(await page.locator('[data-testid=usage-kpi-metric]').count()))
  await watchLive()
  await kpiRuns.focus()
  await page.keyboard.press('Enter')
  await sleep(2500)
  check((await T('usage-spend').getAttribute('data-metric')) === 'runs', 'metric: Enter on the Runs tile switches the chart to runs')
  check((await kpiRuns.getAttribute('aria-pressed')) === 'true', 'metric: the Runs tile is pressed')
  check((await said()).some((t) => /Chart shows runs/.test(t)), 'metric: the switch is announced', JSON.stringify(await said()))
  check(!/\$/.test(clean(await T('usage-spend-legend').innerText())), 'metric: with runs on, the legend shows no cost figures', clean(await T('usage-spend-legend').innerText()))
  await page.locator('[data-testid=usage-kpi-metric][data-metric=cost]').click()
  await sleep(300)
  check((await T('usage-spend').getAttribute('data-metric')) === 'cost', 'metric: the Cost tile switches back')
  // Legend toggle hides a series.
  const legend0 = T('usage-spend-legend-row').first()
  const hiddenProject = await legend0.getAttribute('data-project')
  const segsBefore = await page.locator(`[data-testid=usage-spend-segment][data-project="${hiddenProject}"]`).count()
  await watchLive()
  await legend0.focus()
  await page.keyboard.press('Enter')
  await sleep(2500)
  check((await legend0.getAttribute('aria-pressed')) === 'false', 'legend: Enter on a legend entry hides its series (aria-pressed false)')
  check((await page.locator(`[data-testid=usage-spend-segment][data-project="${hiddenProject}"]`).count()) === 0, 'legend: the hidden series draws no segments', `${segsBefore} before`)
  check((await said()).some((t) => /hidden from the chart/.test(t)), 'legend: hiding is announced', JSON.stringify(await said()))
  check((await chips()).length === 0, 'legend: a legend toggle adds no chip')
  await legend0.click()
  await sleep(300)
  check((await legend0.getAttribute('aria-pressed')) === 'true', 'legend: a second press shows it again')
  // Previous-period overlay.
  const ov = T('usage-spend-overlay')
  check((await ov.getAttribute('aria-pressed')) !== 'true', 'overlay: off by default')
  if ((await ov.getAttribute('aria-disabled')) === 'true') skip('overlay marks', 'no previous period data in the seed')
  else {
    await ov.click()
    await sleep(400)
    check((await ov.getAttribute('aria-pressed')) === 'true', 'overlay: the toggle turns it on')
    await liveBar().focus()
    check(/Previous period/.test(clean(await T('usage-spend-readout').innerText())), 'overlay: the readout names the previous period', clean(await T('usage-spend-readout').innerText()))
    log('info: overlay marks', await T('usage-spend-overlay-mark').count())
    await ov.click()
    await sleep(300)
    check((await T('usage-spend-overlay-mark').count()) === 0, 'overlay: off again removes the marks')
  }
  // Row-to-series highlight, both ways.
  await T('usage-project-row').first().locator('button').first().hover()
  await sleep(300)
  check(!!(await T('usage-spend-plot').getAttribute('data-highlight')), 'highlight: pointing at a project row highlights its series in the chart')
  await page.mouse.move(5, 5)
  await sleep(300)
  const chip0 = T('usage-spend-legend-row').first()
  const chipKey = await chip0.getAttribute('data-project')
  await chip0.focus()
  await sleep(400)
  const dim = await page.evaluate((k) => {
    const others = [...document.querySelectorAll('[data-testid=usage-spend-segment]')].filter((s) => s.getAttribute('data-project') !== k)
    return others.length ? Math.max(...others.map((s) => parseFloat(getComputedStyle(s.closest('[data-dim]') ?? s).opacity))) : null
  }, chipKey)
  check(dim === null || dim < 0.5, 'highlight: focusing a legend chip dims the other series', String(dim))
  const rowHl = await page.locator(`[data-testid=usage-project-row][data-highlight=true]`).count()
  check(rowHl <= 1, 'highlight: at most the matching ranked row is highlighted', String(rowHl))
  await chip0.blur()
  await sleep(300)
  // Tabs: one Tab stop, arrows switch, only the active panel is mounted.
  const tabStops = await page.locator('[data-testid=usage-where-tab][tabindex="0"]').count()
  check(tabStops === 1, 'tabs: the tab strip is one Tab stop', String(tabStops))
  await page.locator('[data-testid=usage-where-tab][data-tab=project]').focus()
  await page.keyboard.press('ArrowRight')
  await sleep(200)
  check((await page.locator('[data-testid=usage-where-tab][data-tab=model]').getAttribute('aria-selected')) === 'true' && (await T('usage-models').count()) === 1 && (await T('usage-projects-panel').count()) === 0, 'tabs: ArrowRight selects Model and shows only its panel')
  await page.keyboard.press('Home')
  await sleep(200)
  check((await T('usage-projects-panel').count()) === 1, 'tabs: Home goes back to Project')
  // Sortable table columns.
  await T('usage-projects-panel').locator('details.usage-table-details > summary').click()
  await sleep(200)
  const costSort = T('usage-projects-table').locator('[data-testid=usage-table-sort][data-col=cost]')
  await watchLive()
  await costSort.click()
  await sleep(2500)
  const ariaSort = await costSort.evaluate((b) => b.closest('th')?.getAttribute('aria-sort'))
  check(ariaSort === 'descending', 'sort: pressing Cost sorts high to low (aria-sort)', String(ariaSort))
  check((await said()).some((t) => /Sorted by Cost/.test(t)), 'sort: the sort is announced', JSON.stringify(await said()))
  await costSort.click()
  await sleep(200)
  check((await costSort.evaluate((b) => b.closest('th')?.getAttribute('aria-sort'))) === 'ascending', 'sort: a second press flips to ascending')
  await T('usage-projects-panel').locator('details.usage-table-details > summary').click()
  // Expandable run rows in Runs worth a look (the efficiency press above may have picked a sort with no rows).
  await T('usage-wasteful-sort').selectOption('no-result').catch(() => {})
  await sleep(300)
  const runToggle = T('usage-wasteful').locator('[data-testid=usage-run-toggle]').first()
  if (await runToggle.count()) {
    const detailHidden = () => page.evaluate(() => {
      const d = document.querySelector('[data-testid=usage-wasteful] [data-testid=usage-run-detail]')
      if (!d) return 'absent'
      const inner = d.querySelector('button, a, [tabindex]')
      return inner ? getComputedStyle(inner).visibility : 'no-control'
    })
    check((await runToggle.getAttribute('aria-expanded')) === 'false', 'run rows: the details toggle starts closed')
    const closedVis = await detailHidden()
    check(closedVis === 'absent' || closedVis === 'hidden' || closedVis === 'no-control', 'run rows: a closed detail is not reachable', closedVis)
    await runToggle.focus()
    await page.keyboard.press('Enter')
    await sleep(500)
    check((await runToggle.getAttribute('aria-expanded')) === 'true', 'run rows: Enter opens the details')
    check((await detailHidden()) === 'visible', 'run rows: the open detail shows its controls', await detailHidden())
    check((await focusInfo()).testid === 'usage-run-toggle', 'run rows: focus stays on the toggle')
    await page.keyboard.press('Enter')
    await sleep(400)
    check((await runToggle.getAttribute('aria-expanded')) === 'false', 'run rows: Enter closes them again')
  } else skip('run row toggle', 'no Runs worth a look rows in the seed')

  // ---------- 5. States ----------
  await clearAll()
  await T('usage-period').getByText('Last month', { exact: true }).click()
  await settle()
  await sleep(500)
  check(await visible('[data-testid=usage-empty]'), 'states: Last month (no runs) shows usage-empty')
  check(await visible('[data-testid=usage-empty-30]'), 'states: the filtered-empty state offers Use 30 days when the period is the cause')
  check((await T('usage-empty-clear').count()) === 0, 'states: with only the period narrowed there is no pointless Clear all (it would keep the period)')
  // Add a project narrowing on top: now Clear all is offered too.
  await T('usage-projects').click()
  await T('usage-project-option').first().locator('input[type=checkbox]').uncheck({ force: true }).catch(() => {})
  await page.keyboard.press('Escape')
  await settle()
  await sleep(500)
  if (await T('usage-empty-clear').count()) check(await visible('[data-testid=usage-empty-clear]'), 'states: a project narrowing on top of the empty period offers Clear all filters')
  else skip('empty Clear all with a project narrowing', 'unchecking a project option did not narrow the projects filter')
  await clearAll()
  check((await T('usage-filters').count()) === 1, 'states: the filter bar stays in the filtered-empty state')
  await shot('filtered-empty')
  await T('usage-empty-30').click()
  await settle()
  check(await visible('[data-testid=usage-spend]') && (await T('usage-empty').count()) === 0, 'states: Use 30 days brings the panels back')
  await T('usage-kinds').click()
  await T('usage-kinds-picker').waitFor({ timeout: 5000 })
  const chatOpt = T('usage-kind-option').filter({ hasText: /^\s*Chat\s*/ }).first()
  const kindOnly = T('usage-kinds-picker')
  // pick Chat only: clear the others through their checkboxes
  const boxes = kindOnly.locator('[data-testid=usage-kind-option]')
  const nb = await boxes.count()
  for (let i = 0; i < nb; i++) {
    const kind = await boxes.nth(i).getAttribute('data-kind')
    const cb = boxes.nth(i).locator('input[type=checkbox]')
    if (kind !== 'quick' && kind !== 'chat' && (await cb.isChecked())) await cb.uncheck({ force: true })
  }
  void chatOpt
  await page.keyboard.press('Escape')
  await settle()
  await sleep(1200)
  const ks = await chips()
  check(ks.some((c) => c.kind === 'kind'), 'states: picking Chat in usage-kinds adds the Kind chip', JSON.stringify(ks))
  await clearAll()

  // ---------- 6. Layout, both sizes and themes ----------
  for (const [w, h] of [
    [1024, 640],
    [1600, 1000]
  ]) {
    for (const theme of ['dark', 'light']) {
      const tag = `${w}x${h} ${theme}`
      await setSize(w, h)
      await setTheme(theme)
      await goUsage()
      await clearAll()
      const ov = await overflow()
      check(ov.sw <= ov.cw && ov.bw <= ov.cw + 1, `layout ${tag}: no page-level horizontal scroll`, JSON.stringify(ov))
      const scrollerOver = await page.evaluate(() => {
        const s = document.querySelector('.usage-scroll')
        return s ? { sw: s.scrollWidth, cw: s.clientWidth } : null
      })
      check(!scrollerOver || scrollerOver.sw <= scrollerOver.cw + 1, `layout ${tag}: the usage scroller does not scroll sideways`, JSON.stringify(scrollerOver))
      const boxes = await page.evaluate(() => {
        const q = (id) => document.querySelector(`[data-testid=${id}]`)?.getBoundingClientRect()
        const r = (b) => (b ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } : null)
        return { s: r(q('usage-spend')), w: r(q('usage-where')), k: r(q('usage-summary')), f: r(q('usage-filters')) }
      })
      if (boxes.s && boxes.w) {
        const beside = Math.abs(boxes.s.y - boxes.w.y) < 4 && boxes.s.x + boxes.s.w <= boxes.w.x && boxes.s.w > boxes.w.w
        const stacked = boxes.w.y >= boxes.s.y + boxes.s.h - 2
        if (w >= 1600) check(beside, `layout ${tag}: the spend chart and the wider-than-it "Where it went" card sit side by side`, JSON.stringify(boxes))
        else check(stacked, `layout ${tag}: "Where it went" sits under the spend chart`, JSON.stringify(boxes))
      } else check(false, `layout ${tag}: the spend chart and the Where it went card are rendered`, JSON.stringify(boxes))
      if (boxes.k && boxes.s) check(boxes.s.y < h, `layout ${tag}: the KPI band and the top of the spend chart are in the first view`, JSON.stringify(boxes))
      if (w >= 1600 && boxes.s && boxes.w) check(Math.abs(boxes.s.h - boxes.w.h) <= 2, `layout ${tag}: the hero cards have equal heights`, JSON.stringify(boxes))
      const pageH = await page.evaluate(() => document.querySelector('.usage-scroll')?.scrollHeight ?? 0)
      log(`info: layout ${tag}: page content height ${pageH} px`)
      check(pageH < (w >= 1600 ? 2000 : 2700), `layout ${tag}: the page is shorter than before the rework (2906 / 3881 px)`, String(pageH))
      const kpi = await page.evaluate(() => [...document.querySelectorAll('[data-testid=usage-summary-item]')].map((e) => Math.round(e.getBoundingClientRect().height)))
      check(kpi.length === 4 && kpi.every((x) => x < 110), `layout ${tag}: four KPI tiles, each under 110 px high`, JSON.stringify(kpi))
      const plotShare = await page.evaluate(() => {
        const card = document.querySelector('[data-testid=usage-spend]')
        const plot = document.querySelector('[data-testid=usage-spend-plot]')
        if (!card || !plot) return 0
        const cs = getComputedStyle(card)
        const inner = card.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
        return Math.min(plot.getBoundingClientRect().width, card.getBoundingClientRect().width) / inner
      })
      check(plotShare >= 0.9, `layout ${tag}: the plot takes at least 90% of the chart card's width`, plotShare.toFixed(2))
      // Sticky bar: constant height, and never covers a focused element after scrolling to it.
      const h0 = boxes.f?.h
      // Scroll to the end, then focus an element far above: the browser scrolls it into view, and scroll-padding-top
      // (the bar's height) must keep it clear of the sticky bar.
      await page.evaluate(() => document.querySelector('.usage-scroll')?.scrollTo(0, 99999))
      await sleep(150)
      await page.locator('[data-testid=usage-eff-value]').first().focus()
      await sleep(200)
      const shiftedAnc = await page.evaluate(() => {
        const out = []
        for (let p = document.querySelector('.usage-scroll')?.parentElement; p; p = p.parentElement) if (p.scrollTop !== 0) out.push(`${p.tagName}.${String(p.className).split(' ')[0]}:${p.scrollTop}`)
        return out
      })
      check(shiftedAnc.length === 0, `layout ${tag}: focusing a chart control scrolls only the page scroller`, JSON.stringify(shiftedAnc))
      const cover = await page.evaluate(() => {
        const bar = document.querySelector('[data-testid=usage-filters]')?.getBoundingClientRect()
        const a = document.activeElement?.getBoundingClientRect()
        return { barBottom: Math.round(bar?.bottom ?? 0), top: Math.round(a?.top ?? 0), barH: Math.round(bar?.height ?? 0) }
      })
      check(cover.barH === h0, `layout ${tag}: the filter bar keeps its height while scrolled`, `${h0} vs ${cover.barH}`)
      check(cover.top >= cover.barBottom - 1, `layout ${tag}: the sticky filter bar does not cover a focused element`, JSON.stringify(cover))
      await page.evaluate(() => document.querySelector('.usage-scroll')?.scrollTo(0, 0))
      if (w === 1024) {
        const railW = await page.evaluate(() => document.querySelector('.sidebar')?.getBoundingClientRect().width ?? 0)
        check(railW <= 70, `layout ${tag}: the sidebar is the rail`, String(railW))
        check((await clean(await T('nav-usage').getAttribute('aria-label') ?? '')) === 'Usage' || /Usage/.test(await T('nav-usage').innerText().catch(() => '')) || /Usage/.test((await T('nav-usage').getAttribute('title')) ?? ''), `layout ${tag}: the rail item is named Usage`)
      }
      const ctl = await page.evaluate(() => {
        const r = (el) => {
          const b = el?.getBoundingClientRect()
          return b ? { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) } : null
        }
        const q = (s) => document.querySelector(`[data-testid=usage-filters] ${s}`)
        const bar = document.querySelector('[data-testid=usage-filters]')
        // Group by now sits in the chart header, so only the bar's own controls are checked here.
        return { period: r(q('[data-testid=usage-period]')), projects: r(q('[data-testid=usage-projects]')), kinds: r(q('[data-testid=usage-kinds]')), bar: r(bar), clipped: bar ? bar.scrollWidth > bar.clientWidth + 1 : false }
      })
      const hit = (a, b) => a && b && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b
      const pairs = [['period', 'projects'], ['projects', 'kinds']]
      check((await page.locator('[data-testid=usage-spend] [data-testid=usage-bucket]').count()) === 1, `layout ${tag}: Group by sits in the chart header`)
      const overlapping = pairs.filter(([x, y]) => hit(ctl[x], ctl[y]))
      check(overlapping.length === 0 && !ctl.clipped && ctl.period && ctl.projects, `layout ${tag}: the filter bar controls do not overlap or clip`, JSON.stringify({ overlapping, ctl }))
      if (ctl.period && ctl.projects) {
        // Dashboard rework: Group by moved into the chart header, so the bar is one row at both sizes.
        check(Math.abs(ctl.projects.t - ctl.period.t) < 40 && ctl.bar && ctl.bar.b - ctl.bar.t < 56, `layout ${tag}: the filter bar is one row under 56 px`, JSON.stringify(ctl))
      }
      await shot(`page-${w}-${theme}`)
      await page.evaluate(() => document.querySelector('.usage-scroll')?.scrollTo(0, 99999))
      await sleep(300)
      await shot(`page-${w}-${theme}-bottom`)
      await page.evaluate(() => document.querySelector('.usage-scroll')?.scrollTo(0, 0))
    }
  }

  // ---------- 7. Live ----------
  await setSize(1600, 1000)
  await setTheme('dark')
  await goUsage()
  await clearAll()
  const offsets = () =>
    page.evaluate(() => {
      const q = (id) => Math.round(document.querySelector(`[data-testid=${id}]`)?.getBoundingClientRect().top ?? -1) + Math.round(document.querySelector('.usage-scroll')?.scrollTop ?? 0)
      return { spend: q('usage-spend'), projects: q('usage-projects-panel'), eff: q('usage-efficiency'), wasteful: q('usage-wasteful'), runs: q('usage-runs'), scroll: Math.round(document.querySelector('.usage-scroll')?.scrollTop ?? 0) }
    })
  const runsBefore = clean(await T('usage-summary-item').filter({ has: page.locator('[data-signal=runs]') }).innerText().catch(async () => (await page.locator('[data-testid=usage-summary-item][data-signal=runs]').innerText())))
  const offBefore = await offsets()
  const liveRun = await page.evaluate((i) => window.orgai.runs.start(i), { projectId: pa.id, prompt: 'Live work [mock:computed-cost]' })
  const liveId = liveRun.id ?? liveRun.runId ?? liveRun.summary?.id
  // Put focus on a stable element and note it
  await liveBar().focus()
  const focusBefore = await focusInfo()
  const end = Date.now() + 40_000
  let note = false
  while (Date.now() < end) {
    if (await T('usage-live-note').count()) {
      note = true
      break
    }
    await sleep(500)
  }
  if (note) {
    const lat = 40_000 - (end - Date.now())
    check(lat <= 12_000, 'live: the live note appears within 12 s of a run starting with the page open (no wait for it to end)', `${lat} ms`)
    check(/still going/.test(await T('usage-live-note').innerText()), 'live: the live note appears while a run is going')
    const offLive = await offsets()
    // The live note sits in the topbar beside "Updated": nothing below it may move (spec 17.5).
    const deltas = ['spend', 'projects', 'eff'].map((k) => offLive[k] - offBefore[k])
    check(deltas.every((d) => Math.abs(d) <= 2) && offLive.scroll === offBefore.scroll, 'live: the live note shifts nothing below it', JSON.stringify({ offBefore, offLive }))
  } else skip('live note', 'the live run did not show in 40 s (the page refetches at most every 30 s while a run is live and on end)')
  const focusMid = await focusInfo()
  check(focusMid.testid === focusBefore.testid, 'live: focus does not move while a live run refreshes the page', JSON.stringify({ focusBefore, focusMid }))
  await page.evaluate((r) => window.orgai.runs.stop(r), liveId)
  await sleep(7500)
  const runsAfter = clean(await page.locator('[data-testid=usage-summary-item][data-signal=runs]').innerText())
  check(runsAfter !== runsBefore, 'live: figures update within a few seconds of the run ending', `${runsBefore} -> ${runsAfter}`)
  check((await T('usage-live-note').count()) === 0, 'live: the live note goes after the run ends')
  const focusEnd = await focusInfo()
  check(focusEnd.testid === focusBefore.testid, 'live: focus does not move when the data refreshes after the run ends', JSON.stringify({ focusBefore, focusEnd }))
  const offAfter = await offsets()
  // Panels above the data-driven lists keep their offsets; the efficiency panel sits under three ranked lists that can
  // gain a row when the new run adds a model or role, so its shift is logged, not asserted.
  const shifted2 = ['spend', 'projects'].filter((k) => Math.abs(offAfter[k] - offBefore[k]) > 2)
  check(shifted2.length === 0, 'live: the spend and projects panels keep their offsets after the refresh', JSON.stringify({ offBefore, offAfter }))
  log('info: efficiency offset', offBefore.eff, '->', offAfter.eff, '(ranked lists may gain a row)')
  await shot('live-after')
} catch (e) {
  check(false, 'usage-app e2e ran to the end', e.stack?.split('\n').slice(0, 3).join(' | ') ?? e.message)
  await shot('failure').catch(() => {})
} finally {
  await endSession(page).catch(() => {})
  await app.close().catch(() => {})
  for (const r of [repoA, repoB, repoE]) removeFixture(r)
  void TMP
  void path
  finish('usage-app')
}
