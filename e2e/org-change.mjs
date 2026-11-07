// Token-free (mock adapter, temp data dir). Org change sessions: Team > Design "Revise with the Architect" starts an
// ordinary setup run that opens in the Live view with its own tab, titled "Org chart: <text>". Covers the start, focus,
// the tray card, the sidebar run row (full sidebar only), the Team > Design pointer, History, the Maintenance review
// and a relaunch (a session cut by the quit reads "Ended when OrgAI closed" and never shows the setup-complete banner).
// Every size and theme is covered at least once: the full flow at 1600x1000 dark and 1024x640 light, the start checks
// at the other two combinations.
import { check, cleanup, createProject, endSession, finish, launch, log, makeFixtureRepo, openProject, openTeam, projectTab, relaunch, removeFixture, sleep, windowShift } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const NAME = 'E2E org change (orgai test)'
const repo = makeFixtureRepo('orgchange')
log('fixture at', repo)

const TEXT = 'Add a database specialist.'
const TITLE = 'Org chart: add a database specialist'
const COMBOS = [
  [1600, 1000, 'dark', true],
  [1024, 640, 'light', true],
  [1600, 1000, 'light', false],
  [1024, 640, 'dark', false]
]

let { app, page, shot } = await launch({ shotPrefix: 'org-change' })

const resizeTo = async (w, h) => {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
  await sleep(500)
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await sleep(300)
}
const setTheme = (t) => page.evaluate((x) => document.documentElement.setAttribute('data-theme', x), t)
const selectedTab = () => page.locator('.run-tab[aria-selected=true]').first()
const activeRunId = () => page.locator('.run-tab-wrap').evaluateAll((els) => els.map((e) => e.getAttribute('data-run')))

/** Team > Design, type the text and start. Resolves once the Live run tab shows. */
async function startFromTeam(text, tag) {
  await openTeam(page)
  const tray = page.locator('[data-testid=team-assistant]')
  await tray.waitFor({ timeout: 10_000 })
  await tray.locator('[data-testid=architect-open]').click()
  const box = tray.getByLabel('What should change')
  await box.fill(text)
  await tray.locator('[data-testid=org-change-start]').click()
  await page.locator('[data-testid=run-meta]').waitFor({ timeout: 20_000 })
  await selectedTab().waitFor({ timeout: 10_000 })
  log(`started session (${tag})`)
}

async function startChecks(tag, full) {
  const tab = (await selectedTab().innerText()) + ' ' + ((await selectedTab().getAttribute('aria-label')) ?? '')
  check(tab.includes(TITLE), `the run tab is titled "${TITLE}" at ${tag}`, tab.replace(/\s+/g, ' '))
  check((await page.locator('[data-testid=tab-live]').getAttribute('aria-selected')) === 'true', `the app switched to Live at ${tag}`)
  await page.waitForFunction(() => !!document.activeElement?.closest('.composer'), null, { timeout: 5000 }).catch(() => {})
  check(await page.evaluate(() => !!document.activeElement?.closest('.composer') || document.activeElement?.tagName === 'TEXTAREA'), `focus is in the composer at ${tag}`)
  check(/Org change session/.test(await page.locator('[data-testid=run-meta-kind]').innerText().catch(() => '')), `RunMeta names the kind at ${tag}`)
  const notice = await page.locator(".run-tabs-notice").first().textContent({ timeout: 3000 }).catch(() => "")
  check(/Org change session started/.test(notice), `the tabs notice says the session started at ${tag}`, notice)
  const card = page.locator('.frame-tray .decision-card').first()
  await card.waitFor({ timeout: 25_000 }).catch(() => {})
  check((await card.count()) === 1, `the Architect's card shows in the Live tray at ${tag}`)
  const chrome = await page.locator('.sidebar, .run-tabs-notice, .run-tablist, [data-testid=dashboard]').allInnerTexts()
  check(!chrome.some((t) => /\bR\?/.test(t)), `no "R?" in the sidebar or run strip at ${tag}`)
  if (!full) return
  await shot(`live-${tag}`)
}

async function fullFlow(w, h, theme) {
  const tag = `${w}x${h} ${theme}`
  const wide = w >= 1180
  await openProject(page, NAME).catch(() => {})
  await startFromTeam(TEXT, tag)
  await startChecks(tag, true)
  const runIds = await activeRunId()
  const runId = await selectedTab().evaluate((el) => el.closest('.run-tab-wrap')?.getAttribute('data-run'))

  // Sidebar row (full sidebar only).
  const row = page.locator(`.sidebar [data-testid=nav-run][data-kind=org-change]`)
  if (wide) {
    await row.first().waitFor({ timeout: 10_000 }).catch(() => {})
    check((await row.count()) >= 1, `the sidebar lists the org change session at ${tag}`)
    check((await row.first().locator('.nav-run-title').innerText()).includes(TITLE), 'the sidebar row carries the display title')
    check((await row.first().locator('[data-testid=nav-run-kind-mark]').count()) === 1, 'the sidebar row has the kind mark')
  } else {
    check((await page.locator('.sidebar [data-testid=nav-run]').count()) === 0, `the rail shows no run list at ${tag}`)
  }

  // Dashboard: rows carry the title and never "R?".
  await page.locator('.sidebar .nav-item', { hasText: /^\s*(Dashboard|Projects)\s*$/ }).or(page.locator('.sidebar [aria-label="Dashboard"]')).first().click()
  await page.waitForSelector('[data-testid=dashboard]', { timeout: 10_000 })
  await sleep(500)
  const dash = await page.locator('[data-testid=dashboard]').innerText()
  check(!/\bR\?/.test(dash), `no "R?" on the Dashboard at ${tag}`)
  check(dash.includes(TITLE), `the Dashboard names the session by its title at ${tag}`, dash.replace(/\s+/g, ' ').slice(0, 300))
  let shift = await windowShift(page)
  check(shift.html === 0 && shift.body === 0, `the Dashboard did not shift the window at ${tag}`, JSON.stringify(shift))

  // Back to the same run: sidebar row at 1600, project row + run tab in the rail.
  if (wide) await row.first().click()
  else {
    await openProject(page, NAME)
    await page.locator('[data-testid=tab-live]').click()
    await page.locator(`.run-tab-wrap[data-run="${runId}"] .run-tab`).click()
  }
  await page.locator('[data-testid=run-meta]').waitFor({ timeout: 10_000 })
  const back = await selectedTab().evaluate((el) => el.closest('.run-tab-wrap')?.getAttribute('data-run'))
  check(back === runId, `navigating back shows the same run at ${tag}`, `${runId} -> ${back}`)

  // Team > Design pointer.
  await openTeam(page)
  const tray = page.locator('[data-testid=team-assistant]')
  await tray.locator('[data-testid=architect-open]').click()
  const pointer = tray.locator('[data-testid=org-change-pointer]')
  await pointer.waitFor({ timeout: 10_000 })
  const ptxt = await pointer.innerText()
  check(ptxt.includes(TITLE) && /is open/.test(ptxt), `Team > Design shows the pointer at ${tag}`, ptxt.replace(/\s+/g, ' '))
  check(!/\bR\?/.test(ptxt), 'the pointer has no "R?"')
  await shot(`pointer-${tag}`)
  await tray.locator('[data-testid=org-change-open]').click()
  await page.locator('[data-testid=run-meta]').waitFor({ timeout: 10_000 })
  check((await page.locator('[data-testid=tab-live]').getAttribute('aria-selected')) === 'true', 'Open session goes to Live')
  const opened = await selectedTab().evaluate((el) => el.closest('.run-tab-wrap')?.getAttribute('data-run'))
  check(opened === runId, 'Open session selects the same run tab', `${runId} -> ${opened}`)
  check(await page.evaluate(() => !!document.activeElement?.closest('.decision-card, .composer')), 'Open session lands focus on the card or the composer')

  // Needs-you in the topbar jumps to the card in Live.
  const pill = page.locator('[data-testid=topbar-needs-you]')
  if (await pill.count()) {
    await openTeam(page)
    await pill.click()
    await page.locator('.frame-tray .decision-card').first().waitFor({ timeout: 10_000 }).catch(() => {})
    check((await page.locator('[data-testid=tab-live]').getAttribute('aria-selected')) === 'true' && (await page.locator('.frame-tray .decision-card').count()) >= 1, `the Needs-you pill lands on the card in Live at ${tag}`)
  }

  // End the session and check History.
  await endSession(page)
  await page.locator('[data-testid=tab-history]').or(projectTab(page, 'History')).first().click()
  const kind = page.locator('[data-testid=run-kind][data-kind=org-change]').first()
  await kind.waitFor({ timeout: 10_000 }).catch(() => {})
  check((await kind.count()) === 1, `History has an org-change row at ${tag}`)
  check(/Org change/.test(await kind.innerText().catch(() => '')), 'the kind cell reads "Org change"')
  const hist = await page.locator('table, .history, main').first().innerText()
  check(hist.includes(TITLE) && !/\bR\?/.test(hist), 'the History row shows the display title', hist.replace(/\s+/g, ' ').slice(0, 200))
  await shot(`history-${tag}`)
  void runIds
}

async function maintenanceReview() {
  await page.locator('[data-testid=tab-settings]').click()
  const btn = page.locator('[data-testid=maintenance-org-review]')
  await page.getByRole('tab', { name: 'Maintenance', exact: true }).click()
  await btn.waitFor({ timeout: 10_000 })
  await btn.click()
  await page.locator('[data-testid=run-meta]').waitFor({ timeout: 20_000 })
  const t = (await selectedTab().innerText()) + ' ' + ((await selectedTab().getAttribute('aria-label')) ?? '')
  check(/Org chart review/.test(t), 'Maintenance "Review the org chart and setup" opens a tab titled "Org chart review"', t.replace(/\s+/g, ' '))
  await endSession(page)
}

try {
  await createProject(page, { path: repo, name: NAME })
  for (const [w, h, theme, full] of COMBOS) {
    await resizeTo(w, h)
    await setTheme(theme)
    const tag = `${w}x${h} ${theme}`
    if (full) await fullFlow(w, h, theme)
    else {
      await openProject(page, NAME).catch(() => {})
      await startFromTeam(TEXT, tag)
      await startChecks(tag, false)
      await shot(`start-${tag}`)
      await endSession(page)
    }
  }

  await resizeTo(1600, 1000)
  await setTheme('dark')
  await openProject(page, NAME).catch(() => {})
  await maintenanceReview()

  // Relaunch: a session waiting on its card when OrgAI quits comes back as "Ended when OrgAI closed".
  await startFromTeam('Add a QA lead.', 'relaunch')
  await page.locator('.frame-tray .decision-card').first().waitFor({ timeout: 25_000 })
  const cutTitle = 'Org chart: add a qa lead'
  ;({ app, page, shot } = await relaunch(app, { shotPrefix: 'org-change-relaunch' }))
  await page.waitForSelector('.sidebar', { timeout: 30_000 })
  await openProject(page, NAME)
  await page.locator('[data-testid=tab-live]').click()
  const cut = page.locator('.run-tablist [role="tab"]', { hasText: /Org chart: add a qa lead/i }).first()
  await cut.waitFor({ timeout: 15_000 })
  await cut.click()
  await page.locator('[data-testid=composer-cut-notice]').waitFor({ timeout: 10_000 }).catch(() => {})
  const label = (await cut.getAttribute('aria-label').catch(() => '')) + (await cut.innerText().catch(() => '')) + (await cut.getAttribute('title').catch(() => ''))
  check(/Ended when OrgAI closed/.test(label), `the restored tab "${cutTitle}" reads Ended when OrgAI closed`, label.replace(/\s+/g, ' '))
  check((await page.locator('[data-testid=setup-complete]').count()) === 0, 'no setup-complete banner on a run cut off by the quit')
  const ta = page.locator('.composer textarea')
  check((await ta.count()) === 1 && (await ta.isEnabled()), 'the composer offers to continue')
  const chainOf = () => page.locator('.run-tab[aria-selected=true]').first().evaluate((el) => el.closest('.run-tab-wrap')?.getAttribute('data-chain'))
  const chainBefore = await chainOf()
  await ta.fill('Pick it up')
  await ta.press('Enter')
  await sleep(2500)
  const divider = page.locator('[data-testid=chain-divider]', { hasText: 'Continued after OrgAI closed' })
  await divider.first().waitFor({ timeout: 10_000 }).catch(() => {})
  const chainAfter = await chainOf()
  check(chainAfter === chainBefore && (await divider.count()) >= 1, 'Send continues in the same tab (one chain, divider shown)', `${chainBefore} -> ${chainAfter}`)
  check((await page.locator('[data-testid=setup-complete]').count()) === 0, 'still no setup-complete banner after continuing')
  await shot('relaunch-continued')
  await endSession(page)
} catch (e) {
  check(false, 'org-change flow ran without throwing', e.stack ?? String(e))
  await shot('error').catch(() => {})
} finally {
  await cleanup(app, page, NAME)
}
removeFixture(repo)
finish('e2e/org-change')
