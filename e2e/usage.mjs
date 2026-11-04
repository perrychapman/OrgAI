// Token-free (mock adapter, temp ORGAI_DATA_DIR). A run with [mock:no-price] shows "Cost unknown" (never $0) in the Usage
// side tab; History > Trends renders; App settings > Connections > Model prices adds, edits and clears an override.
// E2E_SIZE=1024x640 runs the whole flow in a small window (default: the app's own size).
import { check, cleanup, createProject, endSession, finish, launch, log, makeFixtureRepo, openAppSettings, openProject, projectTab, removeFixture, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const NAME = 'E2E usage (orgai test)'
const repo = makeFixtureRepo('usage')
const { app, page, shot } = await launch({ shotPrefix: 'usage' })
try {
  const size = /^(\d+)x(\d+)$/.exec(process.env.E2E_SIZE ?? '')
  if (size) await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [Number(size[1]), Number(size[2])])
  await createProject(page, { path: repo, name: NAME })
  await openProject(page, NAME)
  await projectTab(page, 'Live').click()
  const ta = page.locator('.composer textarea')
  await ta.waitFor({ timeout: 10_000 })
  await ta.fill('Check the notes API [mock:no-price]')
  await page.locator('.composer .btn.primary').click()
  await page.locator('[data-testid=run-meta]').waitFor({ timeout: 20_000 })

  // Usage side tab
  // Under about 1100 px the side panel starts as its rail.
  const showPanel = page.locator('aside.side-panel[data-collapsed=true]').getByRole('button', { name: /^Show / })
  if (await showPanel.count()) await showPanel.first().click()
  const tab = page.locator('[data-testid=side-tab-usage]')
  await tab.waitFor({ timeout: 10_000 })
  await tab.click()
  const panel = page.locator('[data-testid=usage-panel]')
  await panel.waitFor({ timeout: 10_000 })
  await page.locator('[data-testid=usage-unpriced]').waitFor({ timeout: 30_000 })
  const text = await panel.innerText()
  check(/Cost unknown/.test(text), 'the Usage tab says "Cost unknown" for an unpriced model')
  check(!/\$0(\.0+)?(?![\d.])/.test(text), 'the Usage tab never shows $0 for an unpriced model', text.match(/.{0,20}\$0.{0,10}/)?.[0] ?? '')
  check(/mock-unpriced/.test(await page.locator('[data-testid=usage-unpriced]').innerText()), 'the unpriced note names the model')
  const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
  check(ov.sw <= ov.cw, 'no horizontal scroll with the Usage tab open', JSON.stringify(ov))
  await shot('usage-tab')

  // "Set a price" deep-links to Model prices with the model id filled in.
  await page.locator('[data-testid=usage-set-price]').first().click()
  const form = page.locator('[data-testid=model-price-form]')
  await form.waitFor({ timeout: 10_000 })
  check(await page.locator('[data-testid=settings-advanced][data-pane=app-connections]').evaluate((el) => el.open), 'Set a price opens the Connections Advanced disclosure')
  check((await form.locator('#model-price-model').inputValue()) === 'mock-unpriced', 'Set a price opens Model prices with the model id filled in')
  await form.locator('#model-price-input').fill('1.5')
  await form.locator('#model-price-output').fill('7.5')
  await form.locator('[data-testid=model-price-save]').click()
  await form.waitFor({ state: 'detached', timeout: 10_000 })
  const row = page.locator('[data-testid=model-price-row][data-model="mock-unpriced"]')
  await row.waitFor({ timeout: 10_000 })
  check((await row.getAttribute('data-source')) === 'override' && /1\.5/.test(await row.innerText()), 'the saved override shows as an Override row with its price', await row.innerText())
  await shot('model-prices')

  // Validation: a negative price is refused and the form stays open.
  await page.locator('[data-testid=model-price-add]').click()
  await form.waitFor({ timeout: 5000 })
  await form.locator('#model-price-model').fill('e2e-model')
  await form.locator('#model-price-input').fill('-1')
  await form.locator('#model-price-output').fill('2')
  await form.locator('[data-testid=model-price-save]').click()
  await sleep(300)
  check(await form.isVisible(), 'an invalid price keeps the form open')
  await form.getByRole('button', { name: 'Cancel', exact: true }).click()
  await form.waitFor({ state: 'detached', timeout: 5000 })

  // Clear the override (confirm dialog).
  await row.locator('[data-testid=model-price-clear]').click()
  await page.getByRole('button', { name: 'Clear override', exact: true }).last().click()
  await page.waitForFunction(() => !document.querySelector('[data-testid=model-price-row][data-model="mock-unpriced"][data-source=override]'), null, { timeout: 10_000 })
  check(true, 'Clear override removes the override row')

  // Back to the run: the cost now is known (priced) or still not 0 for unknown.
  await openProject(page, NAME)
  await projectTab(page, 'History').click()
  await page.locator('.seg label', { hasText: 'Trends' }).click()
  await page.locator('[data-testid=usage-trends]').waitFor({ timeout: 10_000 })
  await page.locator('[data-testid=trends-totals]').waitFor({ timeout: 15_000 })
  check(true, 'History > Trends renders totals')
  const ov2 = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
  check(ov2.sw <= ov2.cw, 'no horizontal scroll on Trends', JSON.stringify(ov2))
  await shot('trends')
  check(await page.locator('[data-testid=trends-kinds]').isVisible(), 'Trends has a By kind table')
  check(await page.locator('[data-testid=trends-copy-csv]').isEnabled(), 'Copy as CSV is enabled with runs in range')
  await page.locator('.trends-controls .seg label', { hasText: 'Month' }).click()
  await page.locator('select[data-testid=trends-month]').waitFor({ timeout: 5000 })
  check(/so far/.test(await page.locator('select[data-testid=trends-month] option').first().innerText()), 'the Month picker lists the current month first')
  await page.waitForFunction(() => !document.querySelector('[data-testid=trends-loading]'), null, { timeout: 10_000 })
  check(await page.locator('[data-testid=trends-totals]').isVisible(), 'the current month shows the run')

  await openAppSettings(page)
  await page.getByRole('tab', { name: 'Connections', exact: true }).click()
  const adv = page.locator('[data-testid=settings-advanced][data-pane=app-connections]')
  await adv.waitFor({ timeout: 10_000 })
  if (!(await adv.evaluate((el) => el.open))) await adv.locator('> summary').click()
  await page.locator('[data-testid=model-prices]').waitFor({ timeout: 10_000 })
  check(true, 'Model prices section is under App settings > Connections > Advanced')
} catch (e) {
  check(false, 'usage e2e ran to the end', e.message)
  await shot('failure').catch(() => {})
} finally {
  await endSession(page).catch(() => {})
  await cleanup(app, page, NAME)
  removeFixture(repo)
  finish('usage')
}
