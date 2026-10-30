// Token-free. Mock adapter, temp ORGAI_DATA_DIR. Concurrent runs: two run tabs (R1/R2), the run header names the
// viewed run, the New run page is blank, a finished run defaults to New run with Continue as the second choice, the
// sidebar lists open runs, the History tab lists runs, the run-messaging Switch persists, and "Open in new window"
// opens a window scoped to #/run/<projectId>/<runId> whose title carries the run tag.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TMP, check, cleanup, createProject, endSession, finish, findProject, launch, log, makeFixtureRepo, openProject, projectTab, screenshot, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
// Per-run script file: starts as the default work script (only the delay is set); the MCP step rewrites it.
const scriptFile = path.join(fs.mkdtempSync(path.join(TMP, 'orgai-e2e-runs-script-')), 'script.json')
fs.writeFileSync(scriptFile, JSON.stringify({ delayMs: 400 }))
process.env.ORGAI_MOCK_SCRIPT = scriptFile

const NAME = 'E2E runs (orgai test)'
const base = fs.mkdtempSync(path.join(TMP, 'orgai-e2e-runs-'))
const repo = path.join(base, 'repo')
makeFixtureRepo('runs', { at: repo })

const { app, page, shot } = await launch({ shotPrefix: 'runs' })
const tabsBar = () => page.getByRole('tablist', { name: 'Project sections' })
const startOnPage = async (text) => {
  const ta = page.locator('.composer textarea')
  await ta.waitFor({ timeout: 10_000 })
  await ta.fill(text)
  await page.locator('.composer .btn.primary').click()
}
try {
  const project = await createProject(page, { mode: 'existing', path: repo, name: NAME })
  check(!!project, 'project created on the mock adapter')
  check(project?.runMessaging !== true, 'run messaging is off by default')
  await tabsBar().getByRole('tab', { name: 'Live', exact: true }).click()
  await page.locator('.new-run').waitFor({ timeout: 10_000 })

  await startOnPage('First concurrent task')
  await page.locator('[data-testid=run-meta]').waitFor({ timeout: 15_000 })
  await page.keyboard.press('Control+t')
  await page.locator('.new-run').waitFor({ timeout: 5000 })
  check((await page.locator('[data-testid=run-meta]').count()) === 0 && (await page.locator('.agent-node').count()) === 0, 'New run page shows no old run metadata or nodes')
  await startOnPage('Second concurrent task')
  await page.waitForFunction(() => document.querySelectorAll('.run-tablist [role="tab"]').length === 2 && !document.querySelector('.new-run'), null, { timeout: 15_000 })
  await sleep(600)

  const tabs = await page.locator('.run-tablist [role="tab"] .run-tab-index').allInnerTexts()
  check(tabs.length === 2 && new Set(tabs).size === 2 && tabs.includes('R1') && tabs.includes('R2'), 'two concurrent runs have distinct R1/R2 tabs', tabs.join(','))
  const hdr2 = (await page.locator('[data-testid=run-strip] .run-tab[aria-selected=true]').getAttribute('aria-label')) ?? ''
  check(hdr2.startsWith('R2') && /Second concurrent/.test(hdr2), 'the active run tab names the viewed run (R2)', hdr2)
  await page.locator('.run-tablist [role="tab"]', { hasText: 'R1' }).click()
  await sleep(500)
  const hdr1 = (await page.locator('[data-testid=run-strip] .run-tab[aria-selected=true]').getAttribute('aria-label')) ?? ''
  check(hdr1.startsWith('R1') && /First concurrent/.test(hdr1), 'switching tabs changes the active tab to R1', hdr1)
  const liveRuns = await page.evaluate(() => window.orgai.runs.listLive())
  check(Array.isArray(liveRuns) && liveRuns.length === 2, 'runs.listLive reports both runs', String(liveRuns?.length))

  // Sidebar: the project row expands to its open runs.
  const toggle = page.locator('.sidebar button.nav-chevron').first()
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await sleep(200)
  check((await page.locator('.sidebar .nav-runs .nav-run').count()) === 2, 'sidebar project row lists its two open runs')
  await shot('two-runs')

  // Hash deep link: a second window scoped to R1.
  const proj = await findProject(page, NAME)
  const runs = await page.evaluate((id) => window.orgai.runs.list(id), proj.id)
  const r1 = [...runs].sort((a, b) => a.startedAt - b.startedAt)[0]
  await page.evaluate((t) => window.orgai.window.openRun(t), { projectId: proj.id, runId: r1.id })
  let win2
  for (let i = 0; i < 30 && !win2; i++) {
    win2 = app.windows().find((w) => w !== page)
    if (!win2) await sleep(500)
  }
  check(!!win2, 'window:openRun opens a second window')
  if (win2) {
    await win2.waitForSelector('[data-testid=run-meta]', { timeout: 20_000 }).catch(() => {})
    await sleep(500)
    check(win2.url().includes(`#/run/${proj.id}/${r1.id}`), 'second window loads the run hash', win2.url())
    const title = await win2.title()
    check(/R1/.test(title), 'second window title carries the run tag R1', title)
    await screenshot(win2, 'runs-window')
    await win2.close().catch(() => {})
  }
  const bad = await page.evaluate(() => window.orgai.window.openRun({ projectId: '../x', runId: 'nope' }).then(() => 'ok', (e) => String(e.message ?? e)))
  check(bad !== 'ok', 'window:openRun refuses a malformed target', bad)

  // Finish R1: the default action is a New run, Continue this run is the second choice.
  await page.locator('.run-tablist [role="tab"]', { hasText: 'R1' }).click()
  await sleep(300)
  // H4: a pending permission card must go away when its session ends.
  const permCards = page.locator('article.decision-card[data-kind="permission"]')
  await permCards.first().waitFor({ timeout: 15_000 }).catch(() => {})
  const permBefore = await permCards.count()
  check(permBefore >= 1, 'a pending permission card is shown before End session', String(permBefore))
  if (permBefore >= 1) {
    const needsRow = page.locator('[data-testid=needs-you-row]')
    check((await needsRow.count()) >= 1, 'the Needs you row appears in the sidebar while a decision is pending')
  }
  if (permBefore >= 1) {
    // Tray placement at 1024x640: under the stage (never beside it), the stage keeps 55 percent of the frame, cards go compact.
    const prevSize = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize())
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1024, 640))
    await sleep(700)
    const tm = await page.evaluate(() => {
      const r = (sel) => { const b = document.querySelector(sel)?.getBoundingClientRect(); return b && { l: b.left, r: b.right, t: b.top, b: b.bottom } }
      const btn = document.querySelector('section.frame-tray .decision-footer .btn')?.getBoundingClientRect()
      return { stage: r('.frame-stage'), tray: r('section.frame-tray'), frame: r('.canvas-frame'), compact: document.querySelector('section.frame-tray')?.getAttribute('data-compact'), ih: window.innerHeight, btnBottom: btn?.bottom, strip: r('[data-testid=run-strip]'), toolbar: r('.frame-toolbar'), topbar: r('main .topbar') }
    })
    check(!!tm.tray && !!tm.stage && tm.tray.t >= tm.stage.b - 0.5 && tm.tray.l <= tm.stage.l + 0.5, 'the tray sits under the stage at 1024x640', JSON.stringify(tm))
    check(!!tm.frame && !!tm.stage && (tm.stage.b - tm.stage.t) >= 0.55 * (tm.frame.b - tm.frame.t) - 1, 'the stage keeps at least 55 percent of the frame with the tray open', JSON.stringify(tm))
    check(tm.compact === 'true', 'the tray is compact (data-compact) in a frame under 480 px high', String(tm.compact))
    check(tm.btnBottom === undefined || tm.btnBottom <= tm.ih + 0.5, 'the card action row is reachable inside the window at 1024x640', String(tm.btnBottom))
    log('chrome above the canvas at 1024x640 (px from window top to stage):', Math.round(tm.stage?.t ?? 0), 'stage', `${Math.round((tm.stage?.r ?? 0) - (tm.stage?.l ?? 0))}x${Math.round((tm.stage?.b ?? 0) - (tm.stage?.t ?? 0))}`)
    await shot('tray-1024x640')
    await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), prevSize)
    await sleep(500)
  }
  await endSession(page)
  await sleep(500)
  const permAfter = await permCards.count()
  check(permAfter < permBefore, 'the permission card disappears after End session (H4)', `${permBefore} -> ${permAfter}`)
  const mode = (await page.locator('.composer').innerText()).replace(/\s+/g, ' ')
  check(/New run/.test(mode) && !/Continuing this run/.test(mode), 'a finished run defaults to New run', mode.slice(0, 120))
  check((await page.locator('.composer .btn.primary').innerText()).trim() === 'Start', 'finished run primary action is Start')
  check((await page.locator('.composer').getByText('Continue this run', { exact: true }).count()) === 1, 'Continue this run is offered as the second choice')
  await shot('finished-run')

  // History tab lists both runs.
  await tabsBar().getByRole('tab', { name: 'History', exact: true }).click()
  await sleep(500)
  const rows = await page.locator('.run-row').count()
  check(rows === 2, 'History tab lists both runs', String(rows))
  await shot('history')

  // A1: a pending request_mcp_install must render a card in the tray; denying it clears the card and the run goes on.
  fs.writeFileSync(scriptFile, JSON.stringify({
    delayMs: 300,
    work: [
      { type: 'text', text: 'I need a docs server for this task.' },
      { type: 'harness', name: 'request_mcp_install', args: { reason: 'Read the vendor docs.', manual: { name: 'e2e-docs', transport: 'stdio', command: 'npx', args: ['-y', 'e2e-docs-server@1.0.0'] } } },
      { type: 'text', text: 'Carrying on without the docs server.' }
    ]
  }))
  await tabsBar().getByRole('tab', { name: 'Live', exact: true }).click()
  await page.keyboard.press('Control+t')
  await page.locator('.new-run').waitFor({ timeout: 5000 })
  await startOnPage('Needs an MCP server')
  const mcpCard = page.locator('[data-testid=mcp-install-card]')
  await mcpCard.first().waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {})
  check((await mcpCard.count()) === 1 && (await mcpCard.first().isVisible()), 'a pending MCP install request renders a card (A1)')
  check((await mcpCard.getByRole('button', { name: 'Approve', exact: true }).count()) === 1 && (await mcpCard.getByRole('button', { name: 'Deny', exact: true }).count()) === 1, 'the MCP card has Approve and Deny buttons')
  await shot('mcp-card')
  await mcpCard.getByRole('button', { name: 'Deny', exact: true }).click()
  // A denied request stays as a resolved card (Denied badge, Dismiss) with no Approve or Deny left; Dismiss removes it.
  await mcpCard.getByRole('button', { name: 'Dismiss', exact: true }).waitFor({ timeout: 10_000 }).catch(() => {})
  check((await mcpCard.getByText('Denied', { exact: true }).count()) >= 1 && (await mcpCard.getByRole('button', { name: 'Deny', exact: true }).count()) === 0 && (await mcpCard.getByRole('button', { name: 'Approve', exact: true }).count()) === 0, 'the MCP card resolves to Denied with no Approve or Deny buttons')
  await mcpCard.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await sleep(300)
  check((await mcpCard.count()) === 0, 'Dismiss removes the resolved MCP card')
  await page.getByText('Carrying on without the docs server.').first().waitFor({ timeout: 15_000 }).catch(() => {})
  check((await page.getByText('Carrying on without the docs server.').count()) >= 1, 'the run proceeds after the MCP request is denied')
  await endSession(page)

  // AI run titles (mock adapter: the title is the first 4 words of the prompt, capitalised).
  fs.writeFileSync(scriptFile, JSON.stringify({ delayMs: 400 }))
  const TITLED_PROMPT = 'Please refactor the billing module and add tests'
  const TITLE = 'Please refactor the billing'
  await tabsBar().getByRole('tab', { name: 'Live', exact: true }).click()
  await page.keyboard.press('Control+t')
  await page.locator('.new-run').waitFor({ timeout: 5000 })
  await startOnPage(TITLED_PROMPT)
  await page.locator('[data-testid=run-meta]').waitFor({ timeout: 15_000 })
  const projNow = await findProject(page, NAME)
  const summaryFor = async (needle) => (await page.evaluate((id) => window.orgai.runs.list(id), projNow.id)).find((r) => r.prompt.includes(needle))
  let titled
  for (let i = 0; i < 30 && !titled?.title; i++) {
    titled = await summaryFor('billing module')
    if (!titled?.title) await sleep(300)
  }
  check(titled?.title === TITLE, 'the mock run title is the first four words of the prompt, persisted on RunSummary', String(titled?.title))
  const titledTab = page.locator('.run-tablist [role="tab"]', { hasText: TITLE })
  await titledTab.first().waitFor({ timeout: 10_000 }).catch(() => {})
  const tabText = ((await titledTab.first().innerText().catch(() => '')) || '').replace(/\s+/g, ' ')
  check(tabText.includes(TITLE) && !tabText.includes('module'), 'the run tab shows the 4-word title, not the prompt', tabText)
  const tabTip = (await titledTab.first().getAttribute('title').catch(() => '')) ?? ''
  check(tabTip.includes(TITLED_PROMPT), 'the run tab tooltip still carries the full prompt', tabTip)
  const head = ((await page.locator('[data-testid=run-strip] .run-tab[aria-selected=true] .run-tab-title').first().innerText()) || '').replace(/\s+/g, ' ').trim()
  check(head === TITLE, 'the active run tab shows the title', head)
  check((await page.locator('.run-header').count()) === 0, 'the 44 px run header is gone (strip + toolbar)')
  const metaText = ((await page.locator('[data-testid=run-meta]').innerText()) || '').toLowerCase()
  check(!metaText.includes('add tests') && /agent/.test(metaText), 'the metadata line shows facts, not the prompt', metaText.slice(0, 120))
  const sbToggle = page.locator('.sidebar button.nav-chevron').first()
  if ((await sbToggle.getAttribute('aria-expanded')) !== 'true') await sbToggle.click()
  await sleep(200)
  const sbRow = (await page.locator('.sidebar .nav-runs .nav-run-title').allInnerTexts()).map((t) => t.trim())
  check(sbRow.includes(TITLE), 'the sidebar row shows the title', sbRow.join(' | '))
  await shot('run-title')

  // A run window (new window, fresh renderer) loads the persisted title.
  await page.evaluate((t) => window.orgai.window.openRun(t), { projectId: projNow.id, runId: titled.id })
  let win3
  for (let i = 0; i < 30 && !win3; i++) {
    win3 = app.windows().find((w) => w !== page)
    if (!win3) await sleep(500)
  }
  if (win3) {
    await win3.waitForSelector('[data-testid=run-meta]', { timeout: 20_000 }).catch(() => {})
    await sleep(500)
    const heading = ((await win3.locator('[data-testid=run-strip] .run-tab[aria-selected=true] .run-tab-title').first().innerText().catch(() => '')) || '').trim()
    check(heading === TITLE, 'a run opened in a new window still shows the title', heading)
    const wt = await win3.title()
    check(wt.includes(TITLE), 'the run window document title carries the run title', wt)
    await win3.close().catch(() => {})
  } else check(false, 'a run window opened for the titled run')
  await endSession(page)

  // A failed title generation falls back to the prompt excerpt.
  const FAIL_PROMPT = 'Do [mock:title-fail] something with a long enough prompt to be cut'
  await page.keyboard.press('Control+t')
  await page.locator('.new-run').waitFor({ timeout: 5000 })
  await startOnPage(FAIL_PROMPT)
  await page.locator('[data-testid=run-meta]').waitFor({ timeout: 15_000 })
  await sleep(2500)
  const failed = await summaryFor('title-fail')
  check(!!failed && !failed.title, 'a failed title generation leaves RunSummary.title unset', String(failed?.title))
  const failTab = page.locator('.run-tablist [role="tab"]', { hasText: 'title-fail' })
  const failText = ((await failTab.first().innerText().catch(() => '')) || '').replace(/\s+/g, ' ')
  check(failText.includes('Do [mock:title-fail] something'), 'a run without a title shows the prompt excerpt on its tab', failText)
  await endSession(page)

  // A2: the Maintenance sub-nav item must not scroll the page away from the tabs.
  await tabsBar().getByRole('tab', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: 'Maintenance', exact: true }).click()
  await sleep(600)
  const a2 = await page.evaluate(() => {
    const r = [...document.querySelectorAll('[role=tablist][aria-label="Project sections"] [role=tab]')].find((b) => b.textContent?.trim() === 'Live')?.getBoundingClientRect()
    return { top: document.documentElement.scrollTop, live: r ? { t: r.top, b: r.bottom } : null, h: window.innerHeight }
  })
  check(a2.top === 0, 'Maintenance sub-nav leaves the document scrollTop at 0 (A2)', String(a2.top))
  check(!!a2.live && a2.live.t >= 0 && a2.live.b <= a2.h, 'the Live tab button stays inside the viewport after the sub-nav click', JSON.stringify(a2))
  await shot('settings-maintenance')

  // Run messaging switch persists through projects:save.
  await tabsBar().getByRole('tab', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: 'Agents', exact: true }).click()
  const sw =page.getByRole('switch', { name: 'Let runs message each other' })
  await sw.waitFor({ timeout: 10_000 })
  check((await sw.getAttribute('aria-checked')) === 'false', 'run messaging switch starts off')
  await sw.click()
  await sleep(1500)
  check((await findProject(page, NAME)).runMessaging === true, 'switch saved runMessaging=true')
  await page.reload()
  await page.waitForSelector('.sidebar', { timeout: 30_000 })
  await openProject(page, NAME)
  await tabsBar().getByRole('tab', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: 'Agents', exact: true }).click()
  const sw2 =page.getByRole('switch', { name: 'Let runs message each other' })
  await sw2.waitFor({ timeout: 10_000 })
  check((await sw2.getAttribute('aria-checked')) === 'true', 'switch is still on after reload')
  await shot('settings-messaging')
} catch (e) {
  check(false, 'runs e2e ran without throwing', e.stack ?? String(e))
  await shot('error').catch(() => {})
} finally {
  await cleanup(app, page, NAME)
  fs.rmSync(base, { recursive: true, force: true })
}
finish('e2e/runs')
