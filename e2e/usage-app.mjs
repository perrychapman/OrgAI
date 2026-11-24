// Token-free (mock adapter, temp ORGAI_DATA_DIR). The app-wide Usage page (docs/design/usage-app.md): first launch empty
// state, entry points (sidebar / rail, View > Usage without an accelerator, Dashboard strip, Trends, run Usage tab),
// figures (no $0 for an unpriced run or model, "+" with the coverage line), drilldowns and chips (focus never on body,
// one announcement per action), keyboard (spend plot, project rows, efficiency grid), states (filtered-empty, Kind chip),
// layout at 1024x640 and 1600x1000 in both themes, and a live run with the page open. Seeds through the IPC
// (runs.start / runs.startQuick), so it never drives the composer. A check that cannot be driven logs SKIP with a reason.
import { DATA_DIR, TMP, check, endSession, gotoProjects, finish, launch, log, makeFixtureRepo, openProject, projectTab, relaunch, removeFixture, runRecordsDir, sleep, pickSetup } from './lib.mjs'
import * as fs from 'node:fs'
import * as path from 'node:path'

process.env.ORGAI_MOCK = '1'
const A = 'E2E usage A (orgai test)'
const B = 'E2E usage B (orgai test)'
const ENG = 'E2E usage Acme (orgai test)'
const repoA = makeFixtureRepo('usage-a')
const repoB = makeFixtureRepo('usage-b')
const repoE = makeFixtureRepo('usage-e', { initGit: false })
const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim()

let { app, page, shot } = await launch({ shotPrefix: 'usage-app' })
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
/** The spend chart's plot: one slider Tab stop; its aria-valuetext is the tooltip sentence of the day the crosshair is on. */
const plot = () => T('usage-spend-plot')
/** Moves the pointer to a fraction (0..1) of the plot's width, at mid height. */
const pointPlot = async (frac) => {
  const b = await plot().boundingBox()
  if (!b) return false
  await page.mouse.move(b.x + Math.max(40, b.width * frac), b.y + b.height / 2)
  return true
}
const valueText = () => plot().getAttribute('aria-valuetext')
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

const DAY = 86_400_000
/**
 * The mock puts every run on one day, so pacing, Compare and the areas over several days would have nothing to show.
 * With the app closed, copies the seeded runs of the code projects into the throwaway data dir's own run store
 * (runs.json plus one record file each) at earlier dates: some inside the 30 days, some in the 30 before them.
 * `data/runs.json` is the index; `data/runs/<id>.json` holds { summary, agents, transcript, logs }.
 */
function backdateRuns(sourceIds, offsetsDays) {
  const indexFile = path.join(DATA_DIR, 'data', 'runs.json')
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
  const added = []
  let n = 0
  for (const src of sourceIds) {
    const base = index.runs.find((r) => r.id === src)
    if (!base) continue
    const recFile = path.join(runRecordsDir(), `${src}.json`)
    const rec = fs.existsSync(recFile) ? JSON.parse(fs.readFileSync(recFile, 'utf8')) : null
    for (const days of offsetsDays) {
      const id = `${src}_old${++n}`
      const shift = days * DAY
      const copy = (r) => ({ ...r, id, startedAt: r.startedAt - shift, ...(r.endedAt ? { endedAt: r.endedAt - shift } : {}), ...(r.usage ? { usage: { ...r.usage, updatedAt: (r.usage.updatedAt ?? r.startedAt) - shift } } : {}) })
      added.push(copy(base))
      if (rec) fs.writeFileSync(path.join(runRecordsDir(), `${id}.json`), JSON.stringify({ ...rec, summary: copy(rec.summary) }))
    }
  }
  index.runs = [...index.runs, ...added]
  fs.writeFileSync(indexFile, JSON.stringify(index))
  return added.length
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
  await pickSetup(form, true)
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
  // Older history: copies of the priced / plain runs 3, 6, 11 and 20 days back (this period) and 34, 41 and 52 days back
  // (the period before it, for Compare and the pace line). The unpriced run stays on today only.
  await app.close().catch(() => {})
  const copies = backdateRuns([runIds.aPrice, runIds.aPlain, runIds.bPlain, runIds.bPrice], [3, 6, 11, 20, 34, 41, 52])
  log('backdated copies', copies)
  ;({ app, page, shot } = await launch({ shotPrefix: 'usage-app-b', clearPrefs: false }))
  await page.waitForSelector('.sidebar')

  // ---------- 1. Entry ----------
  await setSize(1600, 1000)
  await setTheme('dark')
  await gotoProjects(page)
  // The first navigation to the page in this session stages its arrival: the pacing hero rises, the bands rise in
  // order, the plot wipes in. The classes go after ARRIVAL_REST_MS (800 ms), so they are caught while they are there.
  await T('nav-usage').click()
  const arrived = await page
    .waitForFunction(() => document.querySelector('[data-testid=usage-pacing].motion-arrive-hero') && document.querySelectorAll('[data-testid=usage-view] .motion-arrive-band').length >= 3, null, { timeout: 15_000, polling: 'raf' })
    .then(() => true)
    .catch(() => false)
  check(arrived, 'arrival: the first navigation to Usage stages it (motion-arrive-hero on Pacing, at least three motion-arrive-band bands)')
  await settle()
  await sleep(1200)
  check((await page.locator('[data-testid=usage-view] .motion-arrive-hero, [data-testid=usage-view] .motion-arrive-band').count()) === 0, 'arrival: the arrival classes are gone once the page is at rest')
  check(Number(await plot().getAttribute('data-draw')) >= 1, 'arrival: the plot drew once on arrival (data-draw is at least 1)', String(await plot().getAttribute('data-draw')))
  // Back to the Dashboard and again to Usage, no data change: the page appears at rest.
  await gotoProjects(page)
  await T('nav-usage').click()
  await T('usage-view').waitFor({ timeout: 15_000 })
  await page.waitForSelector('[data-testid=usage-pacing]', { timeout: 15_000 })
  const again = await page.locator('[data-testid=usage-view] .motion-arrive-hero, [data-testid=usage-view] .motion-arrive-band').count()
  check(again === 0, 'arrival: returning to Usage without a data change shows no arrival classes', String(again))
  check(Number(await plot().getAttribute('data-draw')) === 0, 'arrival: and the plot does not redraw (data-draw is 0)', String(await plot().getAttribute('data-draw')))
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

  // Your week's "See usage" opens on 30 days
  await gotoProjects(page)
  await page.waitForSelector('[data-testid=dashboard]')
  if (await T('dash-week-usage').count()) {
    await T('dash-week-usage').click()
    await settle()
    check(await visible('[data-testid=usage-view]') && /30 days/.test(await T('usage-period-label').innerText()), 'entry: dash-week-usage opens Usage on the 30 days period')
    check((await chips()).length === 0, 'entry: the See usage link adds no chip', JSON.stringify(await chips()))
  } else skip('dash-week-usage', 'Your week is not rendered (no runs in the last 7 days)')

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
  const oldWords = await page.evaluate(() => [...document.querySelectorAll('[data-testid=usage-view] .cost, [data-testid=usage-kpi-value], [data-testid=usage-pacing-figure-text]')].map((e) => e.textContent?.trim() ?? '').filter((t) => /^(No price|Cost unknown|unknown)$/i.test(t)))
  check(/Not priced/.test(text) && oldWords.length === 0 && !/Cost unknown/i.test(text), 'figures: an unpriced model/run reads "Not priced" (one wording; never "No price" or "Cost unknown" as a figure)', JSON.stringify(oldWords) + (text.match(/.{0,30}Cost unknown.{0,20}/i)?.[0] ?? ''))
  check(!/waste|\bbill(ed)?\b|invoice|charged|LiteLLM/i.test(text), 'copy: no "waste", "bill", "invoice", "charged" or "LiteLLM" on the page', text.match(/.{0,30}(waste|bill|invoice|charged|LiteLLM).{0,20}/i)?.[0] ?? '')
  check(/Estimated cost/.test(text), 'copy: the summary says "Estimated cost"')
  const costItem = T('usage-summary-item').filter({ has: page.locator('[data-signal=cost]') })
  const summaryCost = clean(await page.locator('[data-testid=usage-summary-item][data-signal=cost]').innerText())
  const partial = /\+/.test(summaryCost.split('\n')[0] ?? summaryCost)
  const coverage = (await T('usage-coverage').count()) ? clean(await T('usage-coverage').innerText()) : ''
  if (partial || /Not priced/.test(summaryCost)) {
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
    // The page says at most one thing per 2 s (ANNOUNCE_GAP_MS) and joins what arrives inside the gap into one later
    // message. The step before (a chip added, then "Filters cleared") can still have its joined message waiting: on a slow
    // runner it landed after watchLive() and was counted as this step's announcement (macOS CI). Let the gap pass first.
    await sleep(2300)
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
  // All runs may still be open from the no-price link above: close it, so the check is about what the row does.
  if (await T('usage-runs').locator('details').evaluate((d) => d.open)) await T('usage-runs').locator('details > summary').click()
  await page.evaluate(() => document.querySelector('.usage-scroll')?.scrollTo(0, 0))
  await sleep(200)
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

  await drill('a day on the spend chart (Home, Enter)', async () => {
    await plot().focus()
    await page.keyboard.press('End')
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
  const stops = await plot().evaluate((el) => [el, ...el.querySelectorAll('[tabindex]')].filter((e) => e.tabIndex === 0).length)
  check(stops === 1, 'keyboard: the spend plot is one Tab stop', String(stops))
  check((await plot().getAttribute('role')) === 'slider', 'keyboard: the spend plot is a slider (one stop, arrow keys inside)')
  // UX post walk H2: focus that did not arrive by keyboard (a pointer press, a script) is not :focus-visible, yet arrow keys must
  // still draw the crosshair and the tooltip.
  await T('usage-view').locator('h1').click()
  await plot().focus()
  await page.keyboard.press('ArrowLeft')
  await sleep(150)
  const slotsA = Number(await plot().getAttribute('aria-valuemax')) + 1
  if (slotsA > 1) {
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowRight')
    await sleep(150)
    check((await T('usage-chart-crosshair').count()) >= 1 && (await T('usage-chart-tooltip').count()) === 1, 'keyboard: arrow keys draw the crosshair and tooltip even when focus was not keyboard-initiated (:focus-visible false)', `${await T('usage-chart-crosshair').count()} crosshair, ${await T('usage-chart-tooltip').count()} tooltip`)
    await shot('keyboard-crosshair')
    await page.keyboard.press('Escape')
    await sleep(100)
    await page.evaluate(() => document.activeElement?.blur())
    await sleep(100)
    check((await T('usage-chart-crosshair').count()) === 0 && (await T('usage-chart-tooltip').count()) === 0, 'keyboard: blur hides the crosshair and tooltip again')
  }
  await page.keyboard.press('Shift')
  await plot().focus()
  await sleep(150)
  const slots = Number(await plot().getAttribute('aria-valuemax')) + 1
  const vt0 = await valueText()
  check(!!vt0 && /\d/.test(vt0), 'keyboard: focusing the plot gives aria-valuetext with the tooltip sentence', String(vt0))
  check(slots > 1, 'keyboard: the backdated history gives several days on the chart', String(slots))
  if (slots > 1) {
    await page.keyboard.press('Home')
    const first = await valueText()
    const firstNow = await plot().getAttribute('aria-valuenow')
    await page.keyboard.press('End')
    const last = await valueText()
    const lastNow = await plot().getAttribute('aria-valuenow')
    check((await T('usage-chart-tooltip').count()) === 1 && (await T('usage-chart-crosshair').count()) >= 1, 'keyboard: arrowing in the plot shows the tooltip and the crosshair')
    check(first !== last && firstNow === '0' && Number(lastNow) === slots - 1, 'keyboard: Home and End jump to the first and last day (aria-valuenow, aria-valuetext)', JSON.stringify({ first, last, firstNow, lastNow }))
    await page.keyboard.press('ArrowLeft')
    const left = await valueText()
    check(left !== last && Number(await plot().getAttribute('aria-valuenow')) === slots - 2, 'keyboard: ArrowLeft moves one day back', `${last} | ${left}`)
    await page.keyboard.press('ArrowRight')
    check((await valueText()) === last, 'keyboard: ArrowRight moves one day forward')
  } else skip('spend plot Left/Right/Home/End', 'one day on the chart')
  check((await focusInfo()).testid === 'usage-spend-plot', 'keyboard: focus stays on the plot while the crosshair moves', JSON.stringify(await focusInfo()))
  // Escape: the tooltip first, then a picked day.
  await page.keyboard.press('Escape')
  await sleep(150)
  check(!(await T('usage-chart-tooltip').isVisible().catch(() => false)), 'keyboard: Escape hides the tooltip')
  check((await focusInfo()).testid === 'usage-spend-plot', 'keyboard: focus stays on the plot after Escape')
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await sleep(2500)
  check((await chipKinds()).includes('bucket'), 'keyboard: Enter on the plot picks the day (day chip)', JSON.stringify(await chips()))
  await plot().focus()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await sleep(1500)
  check(!(await chipKinds()).includes('bucket'), 'keyboard: Escape (tooltip hidden) clears the day pick', JSON.stringify(await chips()))
  await clearAll()

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
  // Every one of the four definition labels is a native button and its own Tab stop (the walk found only the first reachable);
  // the sortable values are buttons too.
  const effStops = await page.locator('[data-testid=usage-eff-main]').evaluate((g) => ({
    terms: [...g.querySelectorAll('button.usage-term')].filter((e) => e.tabIndex === 0).length,
    all: [...g.querySelectorAll('button.usage-term, button.usage-eff-value')].filter((e) => e.tabIndex === 0).length
  }))
  check(effStops.terms === 4, 'keyboard: all four Efficiency definition labels are Tab stops (native buttons)', JSON.stringify(effStops))
  await page.locator('[data-testid=usage-eff-main] button.usage-term').nth(3).focus()
  await sleep(250)
  const lastTip = await page.locator('[data-testid=usage-eff-item]').nth(3).locator('[data-testid=usage-term-tip]').evaluate((el) => ({ vis: getComputedStyle(el).visibility, text: el.textContent?.length ?? 0, r: el.getBoundingClientRect().right, w: innerWidth }))
  check(lastTip.vis === 'visible' && lastTip.text > 10 && lastTip.r <= lastTip.w, 'keyboard: focusing the fourth Efficiency label shows its definition inside the window', JSON.stringify(lastTip))
  const sortBefore = await T('usage-wasteful-sort').inputValue()
  // Cost per run sorts by cost (the default) and No result by no-result: press the last sortable measure so the sort moves.
  const target = page.locator('[data-testid=usage-eff-item] button[data-testid=usage-eff-value]').last()
  check((await page.locator('[data-testid=usage-eff-item] button[data-testid=usage-eff-value]').count()) >= 1, 'keyboard: at least one efficiency value is a sort button')
  await target.click()
  await sleep(500)
  const hf = await page.evaluate(() => ({ id: document.activeElement?.id, text: document.activeElement?.textContent?.trim() }))
  check(hf.id === 'usage-wasteful-h' && /Runs worth a look/.test(hf.text ?? ''), 'keyboard: pressing an efficiency value focuses the "Runs worth a look" heading', JSON.stringify(hf))
  const sortAfter = await T('usage-wasteful-sort').inputValue()
  const pressed = await page.locator('[data-testid=usage-eff-item]:has(button[data-testid=usage-eff-value])').evaluateAll((els) => els.map((e) => e.getAttribute('data-signal')))
  const expectSort = { 'cost-per-run': 'cost', 'no-result': 'no-result' }[pressed[pressed.length - 1]]
  // WastefulRuns falls back to Cost when no run has a no-result agent (the mock never has one), so No result may read cost.
  check(!!expectSort && (sortAfter === expectSort || (expectSort === 'no-result' && sortAfter === 'cost')), 'keyboard: the efficiency press sets usage-wasteful-sort to that measure (Cost per run: cost, No result: no-result, or the cost fallback with no such agent)', `${pressed.join(',')}: ${sortBefore} -> ${sortAfter}`)

  // ---------- 4b. Dashboard interactions (metric switch, legend toggle, overlay, highlight, tabs, sort) ----------
  await clearAll()
  await page.evaluate(() => document.querySelector('.usage-scroll')?.scrollTo(0, 0))
  check((await T('usage-summary-item').count()) === 4 && (await page.locator('[data-testid=usage-summary-item][data-signal=cache]').count()) === 0, 'kpi: four tiles; Cache hit lives only in Efficiency')
  // Crosshair and tooltip on the spend chart.
  await pointPlot(0.5)
  await sleep(200)
  const tip = T('usage-chart-tooltip')
  check((await tip.count()) === 1 && (await tip.isVisible()), 'chart: pointing at a bucket shows usage-chart-tooltip')
  check((await T('usage-chart-crosshair').count()) >= 1, 'chart: pointing at the plot shows the crosshair')
  const crossW = await T('usage-chart-crosshair').first().evaluate((el) => Math.round(el.getBoundingClientRect().width))
  check(crossW <= 2, 'chart: the crosshair is a 1 px line', String(crossW))
  check(!/No price/.test(clean(await T('usage-chart-tooltip').innerText())), 'chart: the tooltip says "Not priced", never "No price"')
  check(!/\$0(\.0+)?(?![\d.])/.test(clean(await T('usage-chart-tooltip').innerText())), 'chart: the tooltip never shows $0')
  check(Number(await plot().getAttribute('data-cursor')) >= 0, 'chart: the plot carries data-cursor for the slot under the pointer')
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
  await page.mouse.move(5, 5)
  // A keyboard event first, so the focus is a keyboard focus (focus-visible) and the tooltip follows the arrow keys.
  await page.keyboard.press('Shift')
  await plot().focus()
  await page.keyboard.press('End')
  await sleep(150)
  const tipA = clean(await tip.innerText().catch(() => ''))
  const vtA = await valueText()
  await page.keyboard.press('ArrowLeft')
  await sleep(150)
  const tipB = clean(await tip.innerText().catch(() => ''))
  const vtB = await valueText()
  check(tipA !== tipB && vtA !== vtB, 'chart: ArrowLeft moves the tooltip and aria-valuetext to the previous day', `${tipA} | ${tipB}`)
  await page.keyboard.press('Escape')
  await sleep(150)
  check(!(await tip.isVisible().catch(() => false)), 'chart: Escape hides the tooltip')
  check((await focusInfo()).testid === 'usage-spend-plot', 'chart: focus stays on the plot after Escape', JSON.stringify(await focusInfo()))
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
  const segsBefore = await page.locator(`[data-testid=usage-spend-area][data-project="${hiddenProject}"]`).count()
  await watchLive()
  await legend0.focus()
  await page.keyboard.press('Enter')
  await sleep(2500)
  check((await legend0.getAttribute('aria-pressed')) === 'false', 'legend: Enter on a legend entry hides its series (aria-pressed false)')
  check(segsBefore >= 1 && (await page.locator(`[data-testid=usage-spend-area][data-project="${hiddenProject}"]`).count()) === 0, 'legend: the hidden series draws no area', `${segsBefore} before`)
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
    await plot().focus()
    await page.keyboard.press('End')
    await sleep(150)
    check(/Previous/.test(`${await valueText()} ${clean(await T('usage-chart-tooltip').innerText().catch(() => ''))}`), 'overlay: the tooltip sentence names the previous period', String(await valueText()))
    const marks = await T('usage-spend-overlay-mark').evaluateAll((els) => els.map((e) => ({ tag: e.tagName.toLowerCase(), state: e.getAttribute('data-state') })))
    check(marks.length >= 1 && marks.filter((m) => m.state === 'line').every((m) => m.tag === 'path'), 'overlay: the previous period draws dashed paths (one per run) and circles for unknown', JSON.stringify(marks.slice(0, 6)))
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
    const others = [...document.querySelectorAll('[data-testid=usage-spend-area]')].filter((s) => s.getAttribute('data-project') !== k)
    return others.length ? Math.max(...others.map((s) => parseFloat(getComputedStyle(s).opacity))) : null
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

  // ---------- 4c. The redesigned page: pacing, KPI band, definitions, efficiency, reasons, donut, ribbon ----------
  await setSize(1600, 1000)
  await goUsage()
  await clearAll()
  await page.evaluate(() => document.querySelector('.usage-scroll')?.scrollTo(0, 0))
  check((await T('usage-pacing').count()) === 1 && (await T('usage-pacing-figure').count()) === 1, 'pacing: one Pacing hero and one figure on the page')
  const figureText = clean(await T('usage-pacing-figure-text').innerText().catch(() => ''))
  check(figureText.length > 0 && !/^\$0(\.0+)?$/.test(figureText), 'pacing: the figure has a text for assistive tech and is never $0', figureText)
  check((await T('usage-pacing-figure').getAttribute('aria-hidden')) === 'true', 'pacing: the counting figure is hidden from assistive tech (the final one is read once)')
  // The default period is 30 days, a rolling window that ends today: a straight line to "today" is the spend itself, so
  // there is no projection and no dial, with a plain sentence; the pace sentence stays.
  const projAll = clean(await T('usage-pacing-projection').innerText().catch(() => ''))
  check(projAll === 'No projection for a rolling period' && (await T('usage-pacing').getAttribute('data-projection')) === 'rolling' && (await T('usage-pacing-dial').count()) === 0, 'pacing: a rolling 30 day period has no projection and no dial, and says so', projAll)
  const paceRolling = clean(await T('usage-pacing-pace').innerText().catch(() => ''))
  check(/more than|less than|Level with|Not compared|No runs in/.test(paceRolling), 'pacing: a rolling period keeps its pace sentence', paceRolling)
  const glyphHidden = await T('usage-pacing-pace').evaluate((el) => [...el.querySelectorAll('.usage-pacing-glyph')].every((g) => g.getAttribute('aria-hidden') === 'true'))
  check(glyphHidden, 'pacing: the ▲ / ▼ glyph is aria-hidden; "more than" / "less than" carry the direction')
  // A calendar period projects. This month: the unpriced run is in it, so the reason shows (or "needs more data" early in a month).
  await T('usage-period').getByText('This month', { exact: true }).click()
  await settle()
  const projMonth = clean(await T('usage-pacing-projection').innerText().catch(() => ''))
  const monthState = await T('usage-pacing').getAttribute('data-projection')
  check(['unpriced', 'early', 'shown'].includes(monthState ?? '') && /^(Projected |Projection needs more data|Projection hidden: some usage is not priced)/.test(projMonth), 'pacing: a calendar month uses the usage.md sentences', `${monthState} | ${projMonth}`)
  if (monthState === 'unpriced') check((await T('usage-pacing-dial').count()) === 0, 'pacing: with unpriced runs in the period the dial is absent')
  // One project, all priced: the projection and the dial show (from a fifth of the month; "needs more data" before).
  await T('usage-project-row').filter({ hasText: 'E2E usage B' }).locator('button').first().click()
  await sleep(2500)
  const projB = clean(await T('usage-pacing-projection').innerText().catch(() => ''))
  const stateB = await T('usage-pacing').getAttribute('data-projection')
  if (stateB === 'shown') {
    check(/^Projected /.test(projB), 'pacing: a fully priced scope in a calendar month shows "Projected ..."', projB)
    const dialLabel = await T('usage-pacing-dial').locator('[role=img]').getAttribute('aria-label').catch(() => null)
    check(!!dialLabel && /so far of a projected/.test(dialLabel) && /percent/.test(dialLabel), 'pacing: the dial has one text alternative that says spend, projection and percent', String(dialLabel))
    check((await T('usage-pacing-dial').locator('svg').getAttribute('aria-hidden')) === 'true', 'pacing: the dial drawing is hidden from assistive tech')
    check((await T('usage-pacing-arc').count()) === 1, 'pacing: the dial arc is drawn')
    await shot('pacing-month-dial')
    const cap = clean(await T('usage-pacing-tick-text').innerText().catch(() => ''))
    check(/^Fill: spend so far/.test(cap) && /(Tick: where .* stood at this point|No tick: nothing to compare with)/.test(cap), 'pacing: the dial caption says what the fill and the tick mean', cap)
    const tickN = await T('usage-pacing-tick').count()
    check(tickN === 0 || /Tick: where/.test(cap), 'pacing: a tick is drawn only with a previous point named in the caption', `${tickN} | ${cap}`)
  } else skip('pacing dial', `the month state is ${stateB} (${projB}); a projection needs a fifth of the month and priced runs`)
  const paceText = clean(await T('usage-pacing-pace').innerText().catch(() => ''))
  check(/more than|less than|Level with|Not compared|No runs in/.test(paceText), 'pacing: the pace line compares with the previous period or says there is nothing to compare', paceText)
  // The pace line and the KPI band agree about a previous period with no runs.
  const priorNone = await T('usage-summary-item').first().evaluate((el) => /no prior data/i.test(el.textContent ?? ''))
  if (/^No runs in /.test(paceText)) check(priorNone && (await T('usage-pacing-tick').count()) === 0, 'pacing: "No runs in ... to compare" agrees with the tiles ("no prior data") and draws no tick', paceText)
  const noZero = !/\$0(\.0+)?(?![\d.])/.test(clean(await T('usage-pacing').innerText()))
  check(noZero, 'pacing: the hero never shows $0')
  await clearAll()
  await T('usage-period').getByText('30 days', { exact: true }).click()
  await settle()

  // KPI band: four tiles, each one keyboard stop; the pressed one has aria-pressed and the indicator.
  const tileInfo = await T('usage-summary-item').evaluateAll((els) =>
    els.map((e) => {
      const stop = e.querySelector('button.usage-kpi-switch, .usage-kpi-static button.usage-term')
      return { signal: e.getAttribute('data-signal'), stop: !!stop && stop.tabIndex === 0, pressed: stop?.getAttribute('aria-pressed') ?? null, static: !!e.querySelector('.usage-kpi-static') }
    })
  )
  check(tileInfo.length === 4 && tileInfo.every((t) => t.stop), 'kpi: all four tiles (Cost, Tokens, Runs, Wall time) are keyboard stops', JSON.stringify(tileInfo))
  check(tileInfo.filter((t) => t.static).length === 1 && tileInfo.find((t) => t.static)?.signal !== 'cost', 'kpi: Wall time is the one static tile; its label is a native button (the defined term) and the only stop in it', JSON.stringify(tileInfo))
  for (const t of tileInfo) {
    await T('usage-summary-item').and(page.locator(`[data-signal=${t.signal}]`)).locator('button.usage-kpi-switch, .usage-kpi-static button.usage-term').focus()
    const at = await page.evaluate(() => document.activeElement?.closest('[data-testid=usage-summary-item]')?.getAttribute('data-signal'))
    check(at === t.signal, `kpi: the ${t.signal} tile takes focus`, String(at))
  }
  const costPressed = await T('usage-kpi-metric').and(page.locator('[data-metric=cost]')).getAttribute('aria-pressed')
  check(costPressed === 'true', 'kpi: with no hand-off the Cost tile is the pressed one', String(costPressed))
  await T('usage-kpi-metric').and(page.locator('[data-metric=tokens]')).click()
  await sleep(500)
  const ind = await page.evaluate(() => {
    const t = document.querySelector('[data-testid=usage-kpi-metric][data-metric=tokens]')?.closest('li')?.getBoundingClientRect()
    const i = document.querySelector('[data-testid=usage-kpi-indicator]')?.getBoundingClientRect()
    return t && i ? { tileL: Math.round(t.left), tileR: Math.round(t.right), indL: Math.round(i.left), indR: Math.round(i.right) } : null
  })
  check(!!ind && ind.indL >= ind.tileL - 2 && ind.indR <= ind.tileR + 2, 'kpi: the pressed tile (Tokens) has the indicator under it', JSON.stringify(ind))
  check((await T('usage-kpi-metric').and(page.locator('[data-metric=tokens]')).getAttribute('aria-pressed')) === 'true' && (await T('usage-kpi-metric').and(page.locator('[data-metric=cost]')).getAttribute('aria-pressed')) === 'false', 'kpi: exactly the Tokens tile is pressed')
  await T('usage-kpi-metric').and(page.locator('[data-metric=cost]')).click()
  await sleep(300)
  const kpiTitles = await T('usage-summary-item').evaluateAll((els) => els.flatMap((e) => [e, ...e.querySelectorAll('*')]).filter((n) => n.hasAttribute('title') && !n.matches('.usage-kpi-delta, .usage-kpi-priced, .usage-kpi-spark-wrap *')).map((n) => n.getAttribute('title')))
  check(kpiTitles.length === 0, 'kpi: the tiles carry no title attribute (the tooltip is the definition)', JSON.stringify(kpiTitles))
  // Accessible names: the figure is read once. Name = label, figure, delta (or its note) from the accessibility tree.
  const tileNames = []
  for (const sig of ['cost', 'tokens', 'runs', 'wall']) {
    const li = T('usage-summary-item').and(page.locator(`[data-signal=${sig}]`))
    const figureText = clean(await li.locator('[data-testid=usage-kpi-value]').innerText())
    const snap = await li.ariaSnapshot()
    const reads = snap.split(figureText).length - 1
    tileNames.push({ sig, figureText, reads, snap: snap.replace(/\s+/g, ' ') })
    log(`info: kpi ${sig} accessibility tree: ${snap.replace(/\s+/g, ' ')}`)
  }
  check(tileNames.every((t) => t.reads <= 1), 'kpi: no tile reads its figure twice in its accessible name', JSON.stringify(tileNames))
  check((await T('usage-kpi-static').evaluate((el) => !el.hasAttribute('role') && !el.hasAttribute('aria-label') && el.tabIndex === -1)) === true, 'kpi: the static Wall time tile has no group role or label of its own (its label button is the one stop)')

  // Definitions are tooltips on the labels, reachable by keyboard; the closed section and More signals are gone.
  check((await T('usage-definitions').count()) === 0 && (await T('usage-eff-more').count()) === 0 && (await T('usage-eff-info').count()) === 0 && (await T('usage-timing').count()) === 0, 'definitions: no Definitions section, More signals disclosure or timing grid')
  const term = T('usage-eff-term').first()
  await term.focus()
  await sleep(350)
  const termInfo = await term.evaluate((el) => {
    const tip = document.getElementById(el.getAttribute('aria-describedby') ?? '')
    const cs = tip ? getComputedStyle(tip) : null
    return { role: tip?.getAttribute('role') ?? null, text: (tip?.textContent ?? '').length, shown: !!cs && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.5, tab: el.tabIndex }
  })
  check(termInfo.role === 'tooltip' && termInfo.text > 10 && termInfo.shown, 'definitions: focusing a defined term shows its tooltip, which the term describes', JSON.stringify(termInfo))
  await page.keyboard.press('Escape')
  await sleep(350)
  const termShown = await term.evaluate((el) => {
    const cs = getComputedStyle(document.getElementById(el.getAttribute('aria-describedby') ?? '') ?? document.body)
    return cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.5
  })
  check(!termShown, 'definitions: Escape hides the tooltip while focus stays on the term')
  // Every tile that has a description (its definition, the token split, a note) shows it as a tooltip on focus.
  const kpiTips = await page.evaluate(async () => {
    const out = []
    for (const li of document.querySelectorAll('[data-testid=usage-summary-item]')) {
      const el = li.querySelector('button.usage-kpi-switch, .usage-kpi-static button.usage-term')
      if (!el) continue
      el.focus()
      await new Promise((r) => setTimeout(r, 350))
      const tip = document.getElementById(el.getAttribute('aria-describedby') ?? '')
      const cs = tip ? getComputedStyle(tip) : null
      out.push({ signal: li.getAttribute('data-signal'), described: !!tip, role: tip?.getAttribute('role') ?? null, shown: !!cs && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.5 })
    }
    return out
  })
  check(kpiTips.filter((t) => t.described).length >= 2 && kpiTips.filter((t) => t.described).every((t) => t.role === 'tooltip' && t.shown), 'definitions: focusing a KPI tile shows its description as a tooltip (at least two tiles have one)', JSON.stringify(kpiTips))
  await page.mouse.move(5, 5)
  await page.evaluate(() => document.activeElement?.blur())

  // Efficiency: exactly four measures, each with a reading.
  const eff = await T('usage-eff-item').evaluateAll((els) => els.map((e) => ({ signal: e.getAttribute('data-signal'), reading: (e.querySelector('[data-testid=usage-eff-reading]')?.textContent ?? '').trim(), value: (e.querySelector('[data-testid=usage-eff-value]')?.textContent ?? '').trim() })))
  check(eff.length === 4 && JSON.stringify(eff.map((e) => e.signal).sort()) === JSON.stringify(['cost-per-run', 'first-spawn', 'no-result', 'overlap']), 'efficiency: four measures (cost per run, overlap, first spawn, no result)', JSON.stringify(eff.map((e) => e.signal)))
  check(eff.every((e) => e.reading.length > 8 && e.value.length > 0), 'efficiency: each measure has a value and a one-line reading', JSON.stringify(eff))
  check(!eff.some((e) => /\$0(\.0+)?(?![\d.])/.test(`${e.value} ${e.reading}`)), 'efficiency: no value or reading shows $0')

  // Runs worth a look: reasons.
  const sortSel = T('usage-wasteful-sort')
  const sortOpts = await sortSel.locator('option').evaluateAll((os) => os.map((o) => o.value))
  let reasonRows = 0
  for (const v of sortOpts) {
    await sortSel.selectOption(v)
    await sleep(250)
    reasonRows = await T('usage-wasteful-row').count()
    if (reasonRows > 0) break
  }
  if (reasonRows > 0) {
    const reasons = await T('usage-wasteful-row').first().locator('[data-testid=usage-why-reason]').evaluateAll((els) => els.map((e) => ({ key: e.getAttribute('data-reason'), text: (e.textContent ?? '').trim() })))
    check(reasons.length >= 1 && reasons.every((r) => r.key && r.text.length > 3), 'runs worth a look: a row says why it is listed (usage-why reasons)', JSON.stringify(reasons))
    // The defined word of a reason carries its definition: a native button (Tab stop) whose floating tip is not clipped by the table.
    const whyTerms = T('usage-why-term')
    const nTerms = await whyTerms.count()
    if (nTerms > 0) {
      const first = whyTerms.first()
      await first.scrollIntoViewIfNeeded()
      await first.focus()
      await sleep(250)
      const wt = await first.evaluate((el) => {
        const tip = document.getElementById(el.getAttribute('aria-describedby') ?? '')
        const r = tip?.getBoundingClientRect()
        const wrap = el.closest('.usage-table-wrap')?.getBoundingClientRect()
        return { tag: el.tagName, tab: el.tabIndex, role: tip?.getAttribute('role') ?? null, open: !!tip?.matches(':popover-open'), text: (tip?.textContent ?? '').length, inWindow: !!r && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, wrapBottom: wrap ? Math.round(wrap.bottom) : null, tipBottom: r ? Math.round(r.bottom) : null }
      })
      check(wt.tag === 'BUTTON' && wt.tab === 0 && wt.role === 'tooltip' && wt.open && wt.text > 10 && wt.inWindow, 'definitions: a reason in Runs worth a look has a native-button term whose tooltip opens on focus and stays in the window', JSON.stringify(wt))
      await shot('reason-term-tip')
      await page.keyboard.press('Escape')
      await sleep(200)
      check(!(await first.evaluate((el) => document.getElementById(el.getAttribute('aria-describedby') ?? '')?.matches(':popover-open'))), 'definitions: Escape closes a reason tooltip while focus stays on the term')
      await page.evaluate(() => document.activeElement?.blur())
    } else skip('reason terms', 'no reason with a defined word in this seed')
  } else skip('usage-why reasons', 'no run is listed under any sort in this seed')
  await sortSel.selectOption(sortOpts[0])

  // Cost by tier: donut with a text alternative, a legend and a table.
  if (await T('usage-tier-donut').count()) {
    const dl = await T('usage-tier-donut').getAttribute('aria-label')
    const segN = await T('usage-tier-seg').count()
    const rowN = await T('usage-tier-row').count()
    check(/^Cost by tier, /.test(dl ?? '') && segN >= 1 && segN <= rowN, 'tier: the donut has one text alternative and a segment per legend row', `${dl} | ${segN} segments, ${rowN} rows`)
    check((await T('usage-tier-donut').getAttribute('role')) === 'img' && (await T('usage-tier-donut').locator('svg').getAttribute('aria-hidden')) === 'true', 'tier: the donut is an image whose drawing is hidden from assistive tech')
    check((await T('usage-tier-table').count()) === 1, 'tier: the table of the same figures is in the page')
    // Cost semantics: with unpriced runs the total is a lower bound, never "in all" as if exact.
    const unpricedTier = await T('usage-tier-unpriced').count()
    const centre = clean(await T('usage-tier-donut').locator('.usage-donut-center').innerText())
    if (unpricedTier > 0) check(/\+/.test(centre) && !/in all/.test(centre) && /^Cost by tier, at least \$/.test(dl ?? '') && !/in all/.test(dl ?? ''), 'tier: with unpriced runs the donut centre reads "$X+" and the text alternative "at least $X", never "in all"', `${centre} | ${dl}`)
    else check(!/\+/.test(centre.split('\n')[0] ?? centre) && / in all\./.test(dl ?? ''), 'tier: with every run priced the donut total reads as exact ("in all")', `${centre} | ${dl}`)
  } else skip('tier donut', `no tier split in this seed: ${clean(await T('usage-tier-summary').innerText().catch(() => ''))}`)

  // Where it went: the ribbon is a pointer shortcut; rows are the accessible path and light their segment.
  await whereTab('project')
  const ribbon = T('usage-where-ribbon')
  if (await ribbon.count()) {
    check((await ribbon.getAttribute('aria-hidden')) === 'true' && (await T('usage-where-ribbon-seg').count()) >= 1, 'ribbon: the Where it went ribbon is decorative (aria-hidden) and has segments')
    const segKinds = await T('usage-where-ribbon-seg').evaluateAll((els) => els.map((e) => ({ tag: e.tagName, tab: e.tabIndex })))
    check(segKinds.every((s) => s.tag === 'BUTTON' && s.tab === -1), 'ribbon: the segments are native buttons kept out of the Tab order inside the aria-hidden ribbon (rows are the keyboard path)', JSON.stringify(segKinds))
    await T('usage-project-row').first().locator('button').first().hover()
    await sleep(250)
    check((await ribbon.getAttribute('data-hl')) === 'on' && (await page.locator('[data-testid=usage-where-ribbon-seg][data-peek=true]').count()) === 1, 'ribbon: pointing at a row lights its ribbon segment')
    await page.mouse.move(5, 5)
  } else skip('ribbon', 'no ribbon for the Project breakdown in this seed')

  // Table view and CSV export still work.
  const tbtn = T('usage-spend-table-toggle')
  await tbtn.click()
  await sleep(200)
  check((await T('usage-spend-table').count()) === 1 && (await T('usage-spend-table').locator('tbody tr').count()) >= 2, 'chart: the Table view lists the days', String(await T('usage-spend-table').locator('tbody tr').count()))
  await tbtn.click()
  check(await T('usage-copy-csv').isEnabled() && await T('usage-save-csv').isEnabled(), 'csv: Copy as CSV and Save CSV are enabled with runs in range')
  await T('usage-copy-csv').click()
  await page.waitForFunction(() => /\S/.test(document.querySelector('[data-testid=usage-csv-status]')?.textContent ?? ''), null, { timeout: 8000 }).catch(() => {})
  const csvStatus = clean(await T('usage-csv-status').innerText())
  check(/cop|row|run/i.test(csvStatus) && (await T('usage-csv-status').getAttribute('class'))?.includes('failed') !== true, 'csv: Copy as CSV reports its result', csvStatus)

  // A row click narrows and does not scroll.
  await page.evaluate(() => document.querySelector('.usage-scroll')?.scrollTo(0, 400))
  await sleep(200)
  const sc0 = await page.evaluate(() => document.querySelector('.usage-scroll')?.scrollTop ?? -1)
  await T('usage-project-row').first().locator('button').first().click()
  await sleep(2000)
  const sc1 = await page.evaluate(() => document.querySelector('.usage-scroll')?.scrollTop ?? -1)
  check(sc0 > 100 && sc1 === sc0, 'drilldown: a row click narrows and the page scrollTop is unchanged', `${sc0} -> ${sc1}`)
  await clearAll()

  // Dashboard hand-off: the Your week figures open Usage on 7 days with that figure's metric pressed.
  await gotoProjects(page)
  await page.waitForSelector('[data-testid=dash-stats]', { timeout: 15_000 }).catch(() => {})
  for (const [card, metric] of [['spend', 'cost'], ['runs', 'runs']]) {
    if (!(await T(`dash-stat-${card}`).count())) {
      skip(`dash-stat-${card}`, 'the card is not rendered')
      continue
    }
    await T(`dash-stat-${card}`).click()
    await settle()
    check(/7 days/.test(await T('usage-period-label').innerText()), `hand-off: dash-stat-${card} opens Usage on 7 days`, await T('usage-period-label').innerText())
    check((await T('usage-kpi-metric').and(page.locator(`[data-metric=${metric}]`)).getAttribute('aria-pressed')) === 'true', `hand-off: dash-stat-${card} presses the ${metric} tile`)
    check((await T('usage-spend').getAttribute('data-metric')) === metric, `hand-off: the chart shows ${metric}`)
    await T('usage-period').getByText('30 days', { exact: true }).click()
    await settle()
    await gotoProjects(page)
  }

  // ---------- 5. States ----------
  await goUsage()
  await clearAll()
  // The backdated history reaches last month, so the empty period is the oldest month the picker lists.
  await T('usage-period').locator('label', { hasText: 'Months' }).click()
  await settle()
  const monthValues = await T('usage-month').locator('option').evaluateAll((os) => os.map((o) => o.value).sort())
  await T('usage-month').selectOption(monthValues[0])
  await T('usage-month-to').selectOption(monthValues[0])
  await settle()
  await sleep(500)
  check(await visible('[data-testid=usage-empty]'), 'states: the oldest month (no runs) shows usage-empty', monthValues[0])
  check(!(await chipKinds()).includes('period') && /Oct|Nov|Sep|Dec|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug/.test(await T('usage-period-label').innerText()), 'chips: a non-default period gets no chip; the date text names it', JSON.stringify(await chipKinds()))
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

  // ---------- 5b. Polish round: Months picker height, Where table fit, scroll kept after Clear all ----------
  for (const [w, h] of [
    [1024, 640],
    [1600, 1000]
  ]) {
    await setSize(w, h)
    await goUsage()
    await clearAll()
    const stickyH = () => page.evaluate(() => Math.round(document.querySelector('.usage-sticky')?.getBoundingClientRect().height ?? 0))
    await T('usage-period').locator('label', { hasText: 'Months' }).click()
    await settle()
    const mb = await page.evaluate(() => {
      const r = (id) => document.querySelector(`[data-testid=${id}]`)?.getBoundingClientRect()
      const a = r('usage-month')
      const b = r('usage-month-to')
      return a && b ? { aTop: Math.round(a.top), bTop: Math.round(b.top) } : null
    })
    check(mb && Math.abs(mb.aTop - mb.bTop) <= 2, `polish ${w}: From and To sit on one row`, JSON.stringify(mb))
    const withMonths = await stickyH()
    check(withMonths < 130, `polish ${w}: the sticky block stays under 130 px with Months open`, String(withMonths))
    await T('usage-period').locator('label', { hasText: '30 days' }).click()
    await settle()

    await whereTab('project')
    const spendH0 = await page.evaluate(() => Math.round(document.querySelector('[data-testid=usage-spend]').getBoundingClientRect().height))
    await T('usage-where').locator('summary').click()
    await sleep(300)
    const fit = await page.evaluate(() => {
      const wrap = document.querySelector('[data-testid=usage-where] .usage-table-wrap')
      return wrap ? { sw: wrap.scrollWidth, cw: wrap.clientWidth, region: wrap.getAttribute('role') === 'region' && wrap.tabIndex === 0 && !!wrap.getAttribute('aria-label') } : null
    })
    // The breakdown is the 5-column card beside the chart now, so a narrow window may scroll its table sideways; that is
    // allowed only as a labelled, focusable region (TableWrap), never as a clipped table.
    if (w >= 1600) check(fit && fit.sw <= fit.cw + 1, `polish ${w}: the Where table has no inner horizontal scroll`, JSON.stringify(fit))
    else check(fit && (fit.sw <= fit.cw + 1 || fit.region), `polish ${w}: the Where table either fits or scrolls as a labelled, focusable region`, JSON.stringify(fit))
    const heads = await T('usage-where').locator('thead th').evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().width > 0).map((e) => (e.textContent ?? '').trim()))
    check(heads.includes('Runs') && heads.includes('Cost'), `polish ${w}: Runs and Cost stay visible in the Where table`, JSON.stringify(heads))
    if (w >= 1600) {
      const hh = await page.evaluate(() => Math.round(document.querySelector('[data-testid=usage-spend]').getBoundingClientRect().height))
      check(Math.abs(hh - spendH0) <= 2, `polish ${w}: the chart card keeps its height when the Where table opens`, `${spendH0} -> ${hh}`)
    }
    await shot(`polish-where-table-${w}`)
    await T('usage-where').locator('summary').click()
  }
  await setSize(1600, 1000)
  await goUsage()
  await clearAll()
  await T('usage-kinds').click()
  await T('usage-kinds-picker').waitFor({ timeout: 5000 })
  {
    const opts = T('usage-kinds-picker').locator('[data-testid=usage-kind-option] input[type=checkbox]')
    const n = await opts.count()
    for (let i = 0; i < n; i++) {
      if (await opts.nth(i).isChecked()) {
        await opts.nth(i).uncheck({ force: true })
        break
      }
    }
  }
  await page.keyboard.press('Escape')
  await settle()
  if (await T('usage-clear-all').count()) {
    await page.evaluate(() => document.querySelector('.usage-scroll')?.scrollTo(0, 500))
    await sleep(200)
    const before = await page.evaluate(() => document.querySelector('.usage-scroll')?.scrollTop ?? 0)
    await T('usage-clear-all').evaluate((el) => el.click())
    await settle()
    const after = await page.evaluate(() => document.querySelector('.usage-scroll')?.scrollTop ?? 0)
    check(before > 100 && after >= before - 5, 'polish: Clear all keeps the scroll position', `${before} -> ${after}`)
  } else skip('Clear all scroll', 'no chip appeared after narrowing kinds')

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
        // From a 900 px container (both window sizes: 958 px and 1500 px) the hero row is two columns, chart 7 : breakdown 5.
        check(beside, `layout ${tag}: the spend chart and the narrower "Where it went" card sit side by side (7 : 5)`, JSON.stringify(boxes))
        check(Math.abs(boxes.s.w / (boxes.s.w + boxes.w.w) - 7 / 12) < 0.03, `layout ${tag}: the hero columns are about 7 : 5`, JSON.stringify(boxes))
      } else check(false, `layout ${tag}: the spend chart and the Where it went card are rendered`, JSON.stringify(boxes))
      if (boxes.k && boxes.s) check(boxes.s.y < h, `layout ${tag}: the KPI band and the top of the spend chart are in the first view`, JSON.stringify(boxes))
      if (boxes.s && boxes.w) check(Math.abs(boxes.s.h - boxes.w.h) <= 2, `layout ${tag}: the hero cards have equal heights`, JSON.stringify(boxes))
      const pageH = await page.evaluate(() => document.querySelector('.usage-scroll')?.scrollHeight ?? 0)
      log(`info: layout ${tag}: page content height ${pageH} px`)
      log(
        `info: layout ${tag}: sections`,
        JSON.stringify(
          await page.evaluate(() =>
            [...(document.querySelector('.usage-page')?.children ?? [])].map((c) => `${c.getAttribute('data-testid') ?? c.className.toString().split(' ')[0] ?? c.tagName}:${Math.round(c.getBoundingClientRect().height)}`)
          )
        )
      )
      // Tuned to this seed (Runs worth a look stacks above Cost by tier below a 1500 px container).
      check(pageH < (w >= 1600 ? 2300 : 2700), `layout ${tag}: the page is shorter than before the rework (2906 / 3881 px)`, String(pageH))
      // The page has one scroll: the breakdown card never scrolls inside the page, and its table fits its cell with no sideways scroll.
      if (theme === 'dark') {
        for (const tab of ['project', 'model', 'role', 'connection']) {
          await whereTab(tab)
          const sum = T('usage-where').locator('details.usage-table-details > summary')
          const opened = (await sum.count()) > 0
          if (opened) await sum.first().click()
          await sleep(250)
          const fit = await page.evaluate(() => {
            const card = document.querySelector('[data-testid=usage-where]')
            const body = card?.querySelector('.usage-where-body')
            const wraps = [...(card?.querySelectorAll('.usage-table-wrap') ?? [])]
            return {
              bodyY: body ? body.scrollHeight - body.clientHeight : 0,
              cardX: card ? card.scrollWidth - card.clientWidth : 0,
              wrapX: wraps.map((x) => x.scrollWidth - x.clientWidth),
              wrapFocusable: wraps.filter((x) => x.tabIndex === 0).length
            }
          })
          log(`info: layout ${tag}: Where it went (${tab}) ${JSON.stringify(fit)}`)
          check(fit.bodyY <= 1 && fit.cardX <= 1 && fit.wrapX.every((x) => x <= 1) && fit.wrapFocusable === 0, `layout ${tag}: Where it went (${tab}) fits its cell: no inner scroll, table without sideways scroll`, JSON.stringify(fit))
          if (opened) await sum.first().click()
        }
        await whereTab('project')
      }
      const pairFit = await page.evaluate(() => {
        const wasteful = document.querySelector('[data-testid=usage-wasteful]')?.getBoundingClientRect()
        const tier = document.querySelector('[data-testid=usage-staffing]')?.getBoundingClientRect()
        const wraps = [...document.querySelectorAll('[data-testid=usage-wasteful] .usage-table-wrap, [data-testid=usage-staffing] .usage-table-wrap')]
        return { beside: !!wasteful && !!tier && Math.abs(wasteful.top - tier.top) < 4 && wasteful.right <= tier.left, wrapX: wraps.map((x) => x.scrollWidth - x.clientWidth), focusable: wraps.filter((x) => x.tabIndex === 0).length }
      })
      check(pairFit.beside && pairFit.wrapX.every((x) => x <= 1) && pairFit.focusable === 0, `layout ${tag}: Runs worth a look sits beside Cost by tier and neither table scrolls sideways`, JSON.stringify(pairFit))
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
      await page.locator('[data-testid=usage-eff-main] .usage-term').first().focus()
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
  const drawBefore = await page.evaluate(() => document.querySelector('[data-testid=usage-spend-plot]')?.getAttribute('data-draw') ?? null)
  const liveRun = await page.evaluate((i) => window.orgai.runs.start(i), { projectId: pa.id, prompt: 'Live work [mock:computed-cost]' })
  const liveId = liveRun.id ?? liveRun.runId ?? liveRun.summary?.id
  // Put focus on a stable element and note it
  await plot().focus()
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
  const drawAfter = await page.evaluate(() => document.querySelector('[data-testid=usage-spend-plot]')?.getAttribute('data-draw') ?? null)
  check(drawBefore !== null && drawAfter === drawBefore, 'live: a background refresh from a run starting and ending does not redraw the chart (data-draw holds)', `${drawBefore} -> ${drawAfter}`)
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
