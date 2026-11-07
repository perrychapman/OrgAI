// Token-free. Mock adapter, temp ORGAI_DATA_DIR. The Dashboard (docs/design/dashboard.md): first launch (start choice is
// the first Tab stop, one primary, Chat now), the New project dialog (Escape returns focus), project tiles (More menu,
// delete confirm names the open run, Enter on Open lands on the topbar heading), the attention column against the
// sidebar bell, "1 decision · 1 run" on the waiting project's tile, 1024x640 and 1600x1000 in both themes with no
// horizontal overflow, and after a relaunch "Ended when OrgAI closed" with Continue.
// Dashboard pass 2 (docs/design/dashboard-2.md section 17): the Right now band, the 14-day strip, inline answers in
// Needs you (Allow once removes the row, no wider scope on the page), no false chips, To set up and Limits absent on
// the mock, reduced motion on the band marks, the tile's newest run, folder and New run, Recently ended.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TMP, check, createProject, deleteProject, endSession, finish, gotoProjects, launch, log, makeFixtureRepo, openProject, projectTab, relaunch, removeFixture, screenshot, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const scriptFile = path.join(fs.mkdtempSync(path.join(TMP, 'orgai-e2e-dash-script-')), 'script.json')
fs.writeFileSync(scriptFile, JSON.stringify({ delayMs: 400 }))
process.env.ORGAI_MOCK_SCRIPT = scriptFile

const WAIT = 'E2E dash waiting (orgai test)'
const BUSY = 'E2E dash busy (orgai test)'
const INLINE = 'E2E dash inline (orgai test)'
const repoA = makeFixtureRepo('dash-a')
const repoB = makeFixtureRepo('dash-b')
const repoC = makeFixtureRepo('dash-c')

let { app, page, shot } = await launch({ shotPrefix: 'dashboard' })
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
const visible = async (sel) => (await page.locator(sel).count()) > 0 && (await page.locator(sel).first().isVisible())
const activeInfo = () =>
  page.evaluate(() => {
    const a = document.activeElement
    return { tag: a?.tagName ?? '', testid: a?.getAttribute('data-testid') ?? '', inMainTopbarH1: !!a?.matches?.('main .topbar h1'), type: a?.getAttribute('type') ?? '', inChoice: !!a?.closest?.('[data-testid=dash-start-choice]') }
  })
const startRun = async (text) => {
  await projectTab(page, 'Live').click()
  const ta = page.locator('.composer textarea')
  await ta.waitFor({ timeout: 10_000 })
  await ta.fill(text)
  await page.locator('.composer .btn.primary').click()
  await page.locator('[data-testid=run-meta]').waitFor({ timeout: 15_000 })
}
const bellCount = async () => {
  const t = (await page.locator('[data-testid=needs-you-row]').first().innerText().catch(() => '')).replace(/\s+/g, ' ')
  return Number(/Needs you · (\d+)/.exec(t)?.[1] ?? 0)
}
const tileOf = (name) => page.locator(`[data-testid=project-tile][data-name="${name}"]`)
/** Merge into the saved appearance through settings:set (the broadcast re-applies it on <html>). */
const setAppearance = async (patch) => {
  await page.evaluate(async (p) => {
    const info = await window.orgai.settings.get()
    const { dataDir: _d, appVersion: _v, ...s } = info
    await window.orgai.settings.set({ ...s, appearance: { ...s.appearance, ...p } })
  }, patch)
  await sleep(500)
}

try {
  // ---- First launch ----
  await setSize(1600, 1000)
  await gotoProjects(page)
  check(await visible('[data-testid=dash-start-choice]'), 'first launch shows the start choice')
  check((await page.locator('[data-testid=dash-needs-you]').count()) === 0, 'first launch has no attention column')
  await page.evaluate(() => {
    const h = document.querySelector('main .topbar h1')
    h.tabIndex = -1
    h.focus()
  })
  await page.keyboard.press('Tab')
  let ai = await activeInfo()
  check(ai.inChoice && ai.type === 'radio', 'the first Tab stop in main is the start-choice radio', JSON.stringify(ai))
  const primaries = await page.locator('main .btn.primary:visible').count()
  check(primaries === 1, 'first launch has exactly one primary button', String(primaries))
  await shot('first-launch')
  await page.locator('[data-testid=dash-start-choice]').getByRole('radio', { name: 'Chat now' }).check({ force: true })
  check(await visible('[data-testid=empty-chat-now]'), 'choosing Chat now shows the Chat now button')
  check((await page.locator('main .btn.primary:visible').count()) === 1, 'still exactly one primary with Chat now chosen')
  await page.locator('[data-testid=dash-start-choice]').getByRole('radio', { name: 'Start a project' }).check({ force: true })

  // ---- Projects ----
  const waiting = await createProject(page, { path: repoA, name: WAIT })
  check(!!waiting, 'first project created from the inline form')
  const busy = await createProject(page, { path: repoB, name: BUSY })
  check(!!busy, 'second project created from the dialog')
  check((await page.locator('main .topbar h1').first().innerText()).trim() === BUSY, 'creating a project opens it')

  // A permission card on WAIT.
  await openProject(page, WAIT)
  await startRun('First task')
  await page.locator('section.frame-tray article.decision-card[data-kind="permission"]').first().waitFor({ timeout: 20_000 })
  // A running deep-tree run on BUSY.
  await openProject(page, BUSY)
  await startRun('Deep tree [mock:deep-tree]')
  await sleep(1500)

  await gotoProjects(page)
  await page.locator('[data-testid=dash-needs-row]').first().waitFor({ timeout: 15_000 })
  const rows = await page.locator('[data-testid=dash-needs-row]').count()
  const bell = await bellCount()
  check(rows >= 1 && rows === bell, 'dash-needs-row count equals the bell decision count', `${rows} vs ${bell}`)
  // The band (spec 6): the run header sits on dash-running-row; a working agent shows while the tree runs.
  check((await page.locator('[data-testid=dash-now] [data-testid=dash-running-row][data-status]').count()) >= 1, 'a live run appears in Right now (dash-now > dash-running-row)')
  const working = await page.locator('[data-testid=dash-now] [data-testid=dash-agent-row][data-state=working]').count()
  check(working >= 1, 'Right now lists at least one working agent row while the deep tree runs', String(working))
  // 17.6 Reduced motion: the working mark's ::after has no animation.
  await setAppearance({ reduceMotion: 'on' })
  const markAnim = await page.evaluate(() => {
    const m = document.querySelector('.dash-mark[data-state=working]')
    return m ? getComputedStyle(m, '::after').animationName : 'no-mark'
  })
  if (markAnim === 'no-mark') log('SKIP reduced-motion mark check: no working mark on screen')
  else check(markAnim === 'none', 'reduced motion leaves no animation on the working mark', markAnim)
  await setAppearance({ reduceMotion: 'system' })
  // 17.4 The waiting run appears once in the band, never as a second list row.
  const runIds = await page.locator('[data-testid=dash-running-row]').evaluateAll((els) => els.map((e) => e.getAttribute('data-run')))
  check(new Set(runIds).size === runIds.length, 'each run appears once in the band', JSON.stringify(runIds))
  // The project name is the group's h3, not part of the run row, so scope through the group. The band recomputes at
  // most every 250 ms (spec 6.8), so wait for the mark rather than read it once.
  const waitGroup = page.locator('[data-testid=dash-now] [data-testid=dash-now-project]', { has: page.locator('h3', { hasText: WAIT }) })
  const needsMarked = await waitGroup
    .locator('[data-testid=dash-running-row][data-needs]')
    .first()
    .waitFor({ timeout: 5000 })
    .then(() => true, () => false)
  check(needsMarked && (await waitGroup.locator('[data-testid=dash-running-row]').count()) === 1, 'the waiting run is one band row marked data-needs', String(await waitGroup.count()))
  check((await page.locator('[data-testid=dash-running]').count()) === 0, 'there is no separate Running list any more')
  const firstTile = await page.locator('[data-testid=project-tile]').first().getAttribute('data-name')
  check(firstTile === WAIT, 'the project with a decision is the first tile', String(firstTile))
  const tileText = ((await tileOf(WAIT).innerText()) || '').replace(/\s+/g, ' ')
  check(/1 decision · 1 run/.test(tileText), 'its visible status line reads "1 decision · 1 run"', tileText)
  // Tile (spec 10): the newest run, the folder name as a caption with the path in its title, no "N roles".
  const tileRun = tileOf(WAIT).locator('[data-testid=tile-run]')
  check((await tileRun.count()) === 1 && !!(await tileRun.getAttribute('data-status')), 'the waiting project tile shows its newest run with a status', await tileRun.innerText().catch(() => ''))
  const tileFolder = tileOf(WAIT).locator('[data-testid=tile-folder]')
  check((await tileFolder.count()) === 1 && ((await tileFolder.getAttribute('title')) ?? '').length > ((await tileFolder.innerText()) ?? '').length, 'the tile folder is a name with the full path as its title')
  check(!/\d+ roles?\b/.test(tileText), 'the tile no longer counts roles', tileText)
  // 17.7 No false chips on mock projects with nothing pending; To set up and Limits stay away on the mock.
  check((await page.locator('[data-testid=tile-chip]').count()) === 0, 'no tile chip shows when nothing is pending')
  // Runners without a Claude login legitimately list the disconnected connection, so assert on content: no row about a
  // project's own servers, services or values (a connection row is machine-dependent and allowed).
  const setupKinds = await page.locator('[data-testid=dash-setup] [data-testid=dash-setup-row]').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')))
  check(setupKinds.every((k) => k === 'connection'), 'To set up holds no project, service or connector rows (only connection rows, which depend on the machine)', JSON.stringify(setupKinds))
  check((await page.locator('[data-testid=dash-limits]').count()) === 0, 'Limits are absent under the mock adapter')
  // Needs you rows: permission rows offer Allow once and Deny, never a wider scope; the page has no such words.
  const permRow = page.locator('[data-testid=dash-needs-row][data-kind=permission]').first()
  check((await permRow.getAttribute('data-inline')) === 'allow', 'a short permission row offers inline Allow', String(await permRow.getAttribute('data-inline')))
  check((await permRow.locator('[data-testid=dash-needs-allow]').count()) === 1 && (await permRow.locator('[data-testid=dash-needs-deny]').count()) === 1, 'the permission row has Allow once and Deny')
  const dashText = await page.locator('[data-testid=dashboard]').innerText()
  check(!/Allow for session|Always allow/i.test(dashText), 'the Dashboard never offers Allow for session or Always allow')
  // 17.5 The 14-day strip.
  const days = page.locator('[data-testid=dash-strip-day]')
  check((await days.count()) === 14, 'the strip has 14 days', String(await days.count()))
  const todays = await days.evaluateAll((els) => els.filter((e) => e.getAttribute('data-today') !== null && e.getAttribute('data-today') !== 'false').length)
  check(todays === 1, 'exactly one strip day is today', String(todays))
  const dayRuns = (await days.evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-runs')) || 0))).reduce((a, b) => a + b, 0)
  const stripRuns = Number(/\d+/.exec((await page.locator('[data-testid=dash-strip-runs]').innerText().catch(() => '')) || '')?.[0] ?? -1)
  check(dayRuns === stripRuns && dayRuns >= 2, 'the day counts add up to the Runs total', `${dayRuns} vs ${stripRuns}`)
  const readoutBefore = await page.locator('[data-testid=dash-strip-readout]').innerText().catch(() => '')
  await days.last().focus().catch(() => {})
  await page.keyboard.press('ArrowLeft')
  await sleep(200)
  const readoutAfter = await page.locator('[data-testid=dash-strip-readout]').innerText().catch(() => '')
  check(readoutAfter !== readoutBefore, 'ArrowLeft on the strip changes its readout', `${readoutBefore} -> ${readoutAfter}`)
  const costText0 = ((await page.locator('[data-testid=dash-cost]').innerText().catch(() => '')) || '').replace(/\s+/g, ' ')
  check(costText0 !== '' && !/\$0\.00/.test(costText0), 'the cost total never reads $0.00', costText0)
  await shot('attention-1600x1000')

  // ---- More menu and delete confirm ----
  await tileOf(WAIT).locator('[data-testid=project-tile-more]').click()
  await page.locator('[data-testid=project-tile-open-folder]').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  const menu = ((await page.getByRole('menu').last().innerText().catch(() => '')) || '').replace(/\s+/g, ' ')
  check((await visible('[data-testid=project-tile-open-folder]')) && (await visible('[data-testid=project-tile-delete]')) && /Open folder/.test(menu) && /Delete project/.test(menu), 'the More menu offers Open folder and Delete', menu)
  check((await visible('[data-testid=project-tile-new-run]')) && /New run/.test(menu), 'the More menu offers New run', menu)
  const focusedInMenu = await page.evaluate(() => !!document.activeElement?.closest?.('[role=menu]'))
  check(focusedInMenu, 'opening the More menu moves focus into it')
  await page.locator('[data-testid=project-tile-delete]').click()
  const dlg = page.getByRole('alertdialog').or(page.getByRole('dialog')).last()
  await dlg.waitFor({ timeout: 5000 })
  const body = ((await dlg.innerText()) || '').replace(/\s+/g, ' ')
  check(/Ends 1 open run/.test(body), 'the delete confirm names the open run', body.slice(0, 240))
  await dlg.getByRole('button', { name: 'Cancel' }).click()
  await sleep(300)

  // ---- Needs row opens the card ----
  await page.locator('[data-testid=dash-needs-row]').first().locator('[data-row-main]').click()
  await page.locator('section.frame-tray article.decision-card').first().waitFor({ timeout: 10_000 })
  check(true, 'the Needs you row opens the decision card')
  await gotoProjects(page)

  // ---- New run from the tile menu: a draft with focus on the page, not on the body ----
  await tileOf(BUSY).locator('[data-testid=project-tile-more]').click()
  await page.locator('[data-testid=project-tile-new-run]').click()
  await sleep(900)
  const newRunLanded = await page.evaluate(() => ({
    h1: document.querySelector('main .topbar h1')?.textContent?.trim() ?? '',
    focusOk: document.activeElement !== document.body && !document.activeElement?.closest?.('[data-testid=dashboard]'),
    composer: !!document.querySelector('.composer textarea')
  }))
  check(newRunLanded.h1 === BUSY && newRunLanded.focusOk && newRunLanded.composer, 'New run in the tile menu opens a draft with focus on a real element', JSON.stringify(newRunLanded))
  await gotoProjects(page)

  // ---- The band: Enter on an agent row opens the Live view with that node selected and focused ----
  const doneButton = page.locator('[data-testid=dash-now] [data-testid=dash-agent-done][data-count]')
  await doneButton.first().waitFor({ timeout: 60_000 }).then(
    () => check(true, 'a settled deep tree folds into a dash-agent-done group'),
    () => check(false, 'a settled deep tree folds into a dash-agent-done group')
  )
  const agentRow = page.locator('[data-testid=dash-now] [data-testid=dash-agent-row][data-agent]').first()
  if (await agentRow.count()) {
    const agentId = await agentRow.getAttribute('data-agent')
    await agentRow.focus()
    await page.keyboard.press('Enter')
    const nodeSel = `.react-flow__node[data-id="${agentId}"]`
    const landedNode = await page
      .waitForFunction(
        (id) => {
          const n = document.querySelector(`.react-flow__node[data-id="${id}"]`)
          return !!n && n.classList.contains('selected') && document.activeElement?.closest?.('.react-flow__node')?.getAttribute('data-id') === id
        },
        agentId,
        { timeout: 10_000 }
      )
      .then(() => true, () => false)
    check(landedNode, 'Enter on a band agent row opens the Live view with that node selected and focused', nodeSel)
    await gotoProjects(page)
  } else {
    check(false, 'the band lists an agent row to open')
  }

  // ---- Keyboard: Enter on Open lands on the heading ----
  await tileOf(BUSY).locator('[data-testid=project-tile-main]').focus()
  await page.keyboard.press('Enter')
  await sleep(600)
  ai = await activeInfo()
  check(ai.inMainTopbarH1, 'Enter on a tile Open leaves focus on the topbar heading', JSON.stringify(ai))
  await gotoProjects(page)

  // ---- Escape on the dialog ----
  await page.locator('[data-testid=new-project]').click()
  await page.locator('[data-testid=new-project-dialog]').waitFor({ timeout: 5000 })
  await page.keyboard.press('Escape')
  await page.locator('[data-testid=new-project-dialog]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
  await sleep(200)
  ai = await activeInfo()
  check(ai.testid === 'new-project', 'Escape on the New project dialog returns focus to New project', JSON.stringify(ai))

  // ---- Sizes and themes ----
  for (const [w, h] of [[1024, 640], [1600, 1000]]) {
    await setSize(w, h)
    for (const theme of ['dark', 'light']) {
      const tag = `at ${w}x${h} ${theme}`
      await setTheme(theme)
      await gotoProjects(page)
      await page.locator('[data-testid=dash-needs-you]').waitFor({ timeout: 10_000 })
      const m = await page.evaluate(() => {
        const d = document.querySelector('[data-testid=dashboard]')
        const n = document.querySelector('[data-testid=dash-needs-you]').getBoundingClientRect()
        const hero = document.querySelector('[data-testid=dashboard-hero]')?.getBoundingClientRect()
        const strip = document.querySelector('[data-testid=dash-strip]')?.getBoundingClientRect()
        return {
          over: d.scrollWidth - d.clientWidth,
          top: n.top,
          bottom: n.bottom,
          vh: window.innerHeight,
          hero: hero ? Math.round(hero.height) : null,
          theme: document.documentElement.dataset.theme,
          stripTop: strip ? Math.round(strip.top) : null,
          needsRows: document.querySelectorAll('[data-testid=dash-needs-row]').length
        }
      })
      check(m.theme === theme, `theme is ${theme} ${tag}`)
      check(m.over <= 1, `the dashboard has no horizontal overflow ${tag}`, JSON.stringify(m))
      if (h === 640) {
        check(m.top >= 0 && m.top < m.vh - 40, `dash-needs-you starts inside the viewport ${tag}`, JSON.stringify(m))
        if (m.hero != null) check(m.hero <= 88, `the hero is at most 88 px high ${tag}`, JSON.stringify(m))
        // 17.8 With at most 3 decisions the strip's top is on screen.
        if (m.needsRows <= 3) check(m.stripTop != null && m.stripTop < m.vh, `the strip's top is inside the viewport ${tag}`, JSON.stringify(m))
      }
      check(m.needsRows <= (w >= 1600 ? 5 : 3), `Needs you shows at most its cap of rows ${tag}`, JSON.stringify(m))
      await screenshot(page, `dashboard-${w}x${h}-${theme}`)
    }
  }
  await setTheme('dark')
  await setSize(1600, 1000)

  // ---- Inline Allow once (spec 5.2, 17.1): its own project, so the WAIT run still waits for the relaunch checks ----
  const inline = await createProject(page, { path: repoC, name: INLINE })
  check(!!inline, 'third project created for the inline answer')
  await openProject(page, INLINE)
  await startRun('Inline task')
  await page.locator('section.frame-tray article.decision-card[data-kind="permission"]').first().waitFor({ timeout: 20_000 })
  await gotoProjects(page)
  const inlineRow = page.locator('[data-testid=dash-needs-row][data-kind=permission]', { hasText: INLINE })
  await inlineRow.first().waitFor({ timeout: 15_000 })
  check((await inlineRow.first().getAttribute('data-inline')) === 'allow', 'the new permission row offers inline Allow')
  const before = await bellCount()
  const rowsBefore = await page.locator('[data-testid=dash-needs-row]').count()
  await inlineRow.first().locator('[data-testid=dash-needs-allow]').click()
  await page.locator('[data-testid=dash-needs-row]', { hasText: INLINE }).first().waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {})
  check((await page.locator('[data-testid=dash-needs-row]', { hasText: INLINE }).count()) === 0, 'Allow once removes the row')
  await sleep(500)
  const after = await bellCount()
  check(after === before - 1 && (await page.locator('[data-testid=dash-needs-row]').count()) === rowsBefore - 1, 'the bell and the rows drop by one', `${before} -> ${after}`)
  const focusAfter = await page.evaluate(() => {
    const a = document.activeElement
    return { ok: !!a?.matches?.('[data-testid=dash-needs-you] [data-row-main], [data-testid=dash-needs-you] h2'), tag: a?.tagName ?? '', testid: a?.getAttribute?.('data-testid') ?? '' }
  })
  check(focusAfter.ok, 'focus lands on another Needs you row or the heading, not the body', JSON.stringify(focusAfter))
  const live = ((await page.locator('[data-testid=dashboard-live]').innerText().catch(() => '')) || '').replace(/\s+/g, ' ')
  check(/Allowed once: /.test(live), 'dashboard-live reads "Allowed once: ..."', live)
  // The run's tray no longer shows the card.
  await openProject(page, INLINE)
  await sleep(800)
  check((await page.locator('section.frame-tray article.decision-card[data-kind="permission"]').count()) === 0, 'the run no longer shows the permission card')
  // L5: a run the user ends in this window's lifetime is not listed under Recently ended.
  await endSession(page)
  await gotoProjects(page)
  await sleep(500)
  check((await page.locator('[data-testid=dash-since-row]', { hasText: INLINE }).count()) === 0, 'a run the user just ended is not under Recently ended')

  // ---- Relaunch: runs cut by quit ----
  ;({ app, page, shot } = await relaunch(app, { shotPrefix: 'dashboard' }))
  await gotoProjects(page)
  await page.locator('[data-testid=dash-since-row]').first().waitFor({ timeout: 15_000 }).catch(() => {})
  const since = ((await page.locator('[data-testid=dash-since]').innerText().catch(() => '')) || '').replace(/\s+/g, ' ')
  check(/Ended when OrgAI closed/.test(since), 'after a relaunch Since shows "Ended when OrgAI closed"', since.slice(0, 200))
  check(/^Recently ended/.test(since), 'the section is called Recently ended', since.slice(0, 60))
  check((await page.locator('[data-testid=dash-since-clear]').getAttribute('aria-label')) === 'Clear recently ended runs', 'its Clear button is named "Clear recently ended runs"')
  check((await page.locator('[data-testid=dash-since-continue]').count()) >= 1, 'the run that was waiting has Continue')
  await shot('relaunch')

  // M2: "All quiet" names the runs cut while they waited.
  const hero = ((await page.locator('[data-testid=dashboard-hero]').innerText().catch(() => '')) || '').replace(/\s+/g, ' ')
  check(/waiting on you when OrgAI closed/.test(hero), 'the hero subline names the runs cut while waiting', hero)

  // M1: the Continue row survives a trip to a project and back.
  await tileOf(BUSY).locator('[data-testid=project-tile-main]').click()
  await sleep(600)
  await gotoProjects(page)
  const waitRow = page.locator('[data-testid=dash-since-row]', { hasText: WAIT })
  await waitRow.first().waitFor({ timeout: 10_000 }).catch(() => {})
  check((await waitRow.locator('[data-testid=dash-since-continue]').count()) === 1, 'the cut-while-waiting row keeps its Continue after leaving the Dashboard')

  // H1: Continue from the Dashboard opens that project's run with the cursor in the composer.
  await waitRow.locator('[data-testid=dash-since-continue]').click()
  await page.locator('.composer textarea').waitFor({ timeout: 15_000 })
  await sleep(500)
  const landed = await page.evaluate(() => ({
    h1: document.querySelector('main .topbar h1')?.textContent?.trim() ?? '',
    tabs: document.querySelectorAll('.run-tab[aria-selected=true]').length,
    inComposer: !!document.activeElement?.closest?.('.composer') && document.activeElement?.tagName === 'TEXTAREA'
  }))
  check(landed.h1 === WAIT && landed.tabs === 1, 'Continue on a Dashboard row opens the run in its project', JSON.stringify(landed))
  check(landed.inComposer, 'Continue puts the cursor in the composer', JSON.stringify(landed))

  // A plain row click opens the run and focus does not fall to the body.
  await gotoProjects(page)
  await page.locator('[data-testid=dash-since-row]', { hasText: WAIT }).first().locator('[data-row-main]').click().catch(() => {})
  await sleep(800)
  const rowLanded = await page.evaluate(() => ({ h1: document.querySelector('main .topbar h1')?.textContent?.trim() ?? '', body: document.activeElement === document.body }))
  check(rowLanded.h1 === WAIT && !rowLanded.body, 'a row click opens the run and focus stays on a real element', JSON.stringify(rowLanded))

  // H2: deleting a project removes its runs from the attention column and the Cost card.
  const left = await deleteProject(page, WAIT)
  check(left === 0, 'the project is deleted')
  await gotoProjects(page)
  await sleep(500)
  const ghostRows = await page.locator('[data-testid=dash-since-row]', { hasText: WAIT }).count()
  const costText = ((await page.locator('[data-testid=dash-cost]').innerText().catch(() => '')) || '').replace(/\s+/g, ' ')
  check(ghostRows === 0 && !costText.includes(WAIT), 'a deleted project leaves no Since row or Cost row', `${ghostRows} ${costText}`)
} catch (e) {
  check(false, 'dashboard script ran to the end', e.stack ?? e.message)
  await screenshot(page, 'dashboard-failure').catch(() => {})
} finally {
  try {
    if (page && !page.isClosed()) {
      for (const n of [WAIT, BUSY, INLINE]) {
        const left = await deleteProject(page, n)
        check(left === 0, `project "${n}" deleted`, `${left} tile(s) left`)
      }
    }
  } catch (e) {
    check(false, 'projects deleted', e.message)
  }
  await app?.close().catch(() => {})
  removeFixture(repoA)
  removeFixture(repoB)
  removeFixture(repoC)
  finish('dashboard')
}
log('done')
