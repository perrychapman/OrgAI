// Throwaway: several concurrent mock runs, overflow, needs-you jump, keyboard.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TMP, check, cleanup, createProject, finish, launch, log, makeFixtureRepo, openProject, removeFixture, sleep, findProject } from '../e2e/lib.mjs'

process.env.ORGAI_MOCK = '1'
const NAME = 'Multi run (orgai test)'
const base = fs.mkdtempSync(path.join(TMP, 'orgai-e2e-multi-'))
const repo = path.join(base, 'repo')
makeFixtureRepo('multi', { at: repo })
const { app, page, shot } = await launch({ shotPrefix: 'multi' })
const live = () => page.locator('.topbar .tabs').getByRole('button', { name: 'Live', exact: true })
try {
  await createProject(page, { mode: 'existing', path: repo, name: NAME })
  const p = await findProject(page, NAME)
  await page.evaluate((x) => window.orgai.projects.save({ ...x, provider: { ...x.provider, id: 'mock' } }), p)
  await page.reload()
  await page.waitForSelector('.sidebar', { timeout: 30_000 })
  await openProject(page, NAME)
  await live().click()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1024, 640))
  await sleep(500)
  check((await page.locator('.new-run').count()) === 1, 'project with no runs shows the New run page')
  const prompts = ['Add caching to the API', 'Fix the header layout', 'Write the migration guide', 'Refactor auth module', 'Upgrade dependencies', 'Profile the slow query']
  for (let i = 0; i < prompts.length; i++) {
    if (i > 0) {
      await page.keyboard.press('Control+t')
      await sleep(300)
      check((await page.locator('.new-run').count()) === 1, `run ${i + 1}: Ctrl+T gives a blank page`)
      check((await page.locator('.react-flow, .run-header').count()) === 0, `run ${i + 1}: no other run on the blank page`)
    }
    const ta = page.locator('.composer textarea')
    await ta.fill(prompts[i])
    await ta.press('Enter')
    await page.locator('.run-header').waitFor({ timeout: 10_000 })
    const head = await page.locator('.run-header-prompt').innerText()
    check(head === prompts[i], `run ${i + 1}: header shows the full prompt`, head)
    await sleep(400)
  }
  await sleep(4500)
  await shot('six-runs-1024')
  const tabs = await page.locator('.run-tablist [role="tab"]').count()
  const more = await page.locator('.run-tab-more').count()
  log('visible tabs', tabs, 'more buttons', more)
  check(more === 1, 'overflow collapses into one +n button')
  check(await page.locator('.run-tab[aria-selected="true"]').count() === 1, 'the viewed tab is visible')
  const sw = await page.evaluate(() => { const l = document.querySelector('.run-tablist'); return [l.scrollWidth, l.clientWidth] })
  check(sw[0] <= sw[1] + 1, 'tab list never scrolls horizontally', JSON.stringify(sw))
  const plus = await page.locator('.run-tab-new').boundingBox()
  check(!!plus && plus.x + plus.width <= 1024, '+ button is on screen at the end', JSON.stringify(plus))
  // Permission card names the run.
  const cardText = await page.locator('.live-cards .run-label').first().innerText().catch(() => '')
  log('card run label:', cardText)
  check(/Run R6/.test(cardText), 'decision card names the viewed run', cardText)
  // Sidebar
  await shot('sidebar-needs-you')
  const needs = await page.locator('.nav-needs .nav-item').innerText().catch(() => '')
  log('needs you:', needs.replace(/\s+/g, ' '))
  check(/Needs you \(\d+\)/.test(needs), 'Needs you entry is in the sidebar')
  // Menu
  await page.locator('.run-tab-more').click()
  await sleep(200)
  await shot('more-menu')
  const items = await page.locator('.run-tab-menuitem').count()
  check(items >= 1, 'the +n menu lists hidden runs', String(items))
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await sleep(600)
  check((await page.locator('.run-tab[aria-selected="true"]').count()) === 1, 'choosing a hidden run swaps it into view')
  await shot('after-menu-pick')
  // Needs-you jump
  await page.locator('.nav-needs .nav-run').nth(2).click()
  await sleep(800)
  const active = await page.evaluate(() => document.activeElement?.className + ' in live-cards=' + !!document.activeElement?.closest('.live-cards'))
  log('focus after jump:', active)
  check(/in live-cards=true/.test(active), 'jump focuses the decision')
  await shot('after-jump')
  // Light theme + 1600
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000))
  await sleep(800)
  await shot('six-runs-1600-light')
  // Allow permission via keyboard, then hide a finished tab with Delete
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1024, 640))
  await sleep(600)
  // draft dot
  await page.keyboard.press('Control+t')
  await page.locator('.composer textarea').fill('half typed')
  await page.locator('.run-tab[aria-selected="false"]').first().click()
  await sleep(400)
  check((await page.locator('.badge-draft').count()) >= 1, 'a tab with a draft shows the draft badge')
  await shot('draft-dot')
  // finish everything: end sessions of all runs? check Ctrl+W on a live run is swallowed with a notice
  await page.keyboard.press('Control+w')
  await sleep(300)
  const notice = await page.locator('.run-tabs-notice').innerText().catch(() => '')
  check(/working run stays open/i.test(notice), 'Ctrl+W on a working run says why nothing happened', notice)
} catch (e) {
  check(false, 'multi flow ran', e.stack ?? String(e))
  await shot('error').catch(() => {})
} finally {
  await cleanup(app, page, NAME)
  removeFixture(base)
}
finish('multi')
