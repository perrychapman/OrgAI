// Token-free. Mock adapter, temp ORGAI_DATA_DIR. The Dashboard (docs/design/dashboard.md): first launch (start choice is
// the first Tab stop, one primary, Chat now), the New project dialog (Escape returns focus), project tiles (More menu,
// delete confirm names the open run, Enter on Open lands on the topbar heading), the attention column against the
// sidebar bell, "1 decision · 1 run" on the waiting project's tile, 1024x640 and 1600x1000 in both themes with no
// horizontal overflow, and after a relaunch "Ended when OrgAI closed" with Continue.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TMP, check, createProject, deleteProject, finish, gotoProjects, launch, log, makeFixtureRepo, openProject, projectTab, relaunch, removeFixture, screenshot, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const scriptFile = path.join(fs.mkdtempSync(path.join(TMP, 'orgai-e2e-dash-script-')), 'script.json')
fs.writeFileSync(scriptFile, JSON.stringify({ delayMs: 400 }))
process.env.ORGAI_MOCK_SCRIPT = scriptFile

const WAIT = 'E2E dash waiting (orgai test)'
const BUSY = 'E2E dash busy (orgai test)'
const repoA = makeFixtureRepo('dash-a')
const repoB = makeFixtureRepo('dash-b')

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
  check((await page.locator('[data-testid=dash-running-row]').count()) >= 1, 'a live run appears in Running now')
  const firstTile = await page.locator('[data-testid=project-tile]').first().getAttribute('data-name')
  check(firstTile === WAIT, 'the project with a decision is the first tile', String(firstTile))
  const tileText = ((await tileOf(WAIT).innerText()) || '').replace(/\s+/g, ' ')
  check(/1 decision · 1 run/.test(tileText), 'its visible status line reads "1 decision · 1 run"', tileText)
  await shot('attention-1600x1000')

  // ---- More menu and delete confirm ----
  await tileOf(WAIT).locator('[data-testid=project-tile-more]').click()
  await page.locator('[data-testid=project-tile-open-folder]').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  const menu = ((await page.getByRole('menu').last().innerText().catch(() => '')) || '').replace(/\s+/g, ' ')
  check((await visible('[data-testid=project-tile-open-folder]')) && (await visible('[data-testid=project-tile-delete]')) && /Open folder/.test(menu) && /Delete project/.test(menu), 'the More menu offers Open folder and Delete', menu)
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
  await page.locator('[data-testid=dash-needs-row]').first().click()
  await page.locator('section.frame-tray article.decision-card').first().waitFor({ timeout: 10_000 })
  check(true, 'the Needs you row opens the decision card')
  await gotoProjects(page)

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
        return { over: d.scrollWidth - d.clientWidth, top: n.top, bottom: n.bottom, vh: window.innerHeight, hero: hero ? Math.round(hero.height) : null, theme: document.documentElement.dataset.theme }
      })
      check(m.theme === theme, `theme is ${theme} ${tag}`)
      check(m.over <= 1, `the dashboard has no horizontal overflow ${tag}`, JSON.stringify(m))
      if (h === 640) {
        check(m.top >= 0 && m.top < m.vh - 40, `dash-needs-you starts inside the viewport ${tag}`, JSON.stringify(m))
        if (m.hero != null) check(m.hero <= 88, `the hero is at most 88 px high ${tag}`, JSON.stringify(m))
      }
      await screenshot(page, `dashboard-${w}x${h}-${theme}`)
    }
  }
  await setTheme('dark')
  await setSize(1600, 1000)

  // ---- Relaunch: runs cut by quit ----
  ;({ app, page, shot } = await relaunch(app, { shotPrefix: 'dashboard' }))
  await gotoProjects(page)
  await page.locator('[data-testid=dash-since-row]').first().waitFor({ timeout: 15_000 }).catch(() => {})
  const since = ((await page.locator('[data-testid=dash-since]').innerText().catch(() => '')) || '').replace(/\s+/g, ' ')
  check(/Ended when OrgAI closed/.test(since), 'after a relaunch Since shows "Ended when OrgAI closed"', since.slice(0, 200))
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
      for (const n of [WAIT, BUSY]) {
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
  finish('dashboard')
}
log('done')
