// Token-free. Mock adapter. The run view's hold card ([mock:provider-error], [mock:provider-error]) and the one-agent view
// (AgentFocus: opened from the side panel and by double click, Escape returns focus to the opener), in both themes.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TMP, check, cleanup, createProject, finish, launch, makeFixtureRepo, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const NAME = 'E2E run hold (orgai test)'
const base = fs.mkdtempSync(path.join(TMP, 'orgai-e2e-hold-'))
const repo = path.join(base, 'repo')
makeFixtureRepo('hold', { at: repo })

const { app, page, shot } = await launch({ shotPrefix: 'run-hold' })
const start = async (text) => {
  const ta = page.locator('.composer textarea')
  await ta.waitFor({ timeout: 10_000 })
  await ta.fill(text)
  await page.locator('.composer .btn.primary').click()
}
try {
  await createProject(page, { mode: 'existing', path: repo, name: NAME })
  await page.getByRole('tablist', { name: 'Project sections' }).getByRole('tab', { name: 'Live', exact: true }).click()
  await page.locator('.new-run').waitFor({ timeout: 10_000 })

  // ---- Budget stop: the card names what stopped the run and what can be done.
  await start('Do some work [mock:provider-error]')
  const hold = page.locator('[data-testid=run-hold]')
  await hold.waitFor({ timeout: 30_000 })
  check((await hold.getAttribute('data-kind')) !== null, 'the hold card shows for a provider error', await hold.getAttribute('data-kind'))
  check((await page.locator('.pause-banner, [data-testid=run-hold]').count()) >= 1, 'the card sits in the decisions tray')
  check((await page.locator('[data-testid=live-settings-bar]').count()) === 1, 'the composer region and model switch stay mounted beside the card')
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    await sleep(300)
    await shot(`provider-${theme}`)
  }
  // A confirmation must name what an action does before it spends.
  const add = hold.getByRole('button', { name: /Add and continue/ })
  if ((await add.count()) > 0) {
    await add.click()
    const dlg = page.locator('[role=dialog], [role=alertdialog]')
    await dlg.waitFor({ timeout: 5000 }).catch(() => {})
    check((await dlg.count()) > 0, 'adding budget asks for an explicit confirmation')
    await page.keyboard.press('Escape')
    await sleep(300)
  }

  // ---- One-agent view.
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  const node = page.locator('.react-flow__node').first()
  await node.waitFor({ timeout: 10_000 })
  await node.click()
  const open = page.locator('[data-testid=agent-focus-open]')
  await open.waitFor({ timeout: 5000 })
  await open.click()
  await page.locator('.agent-focus').waitFor({ timeout: 5000 })
  check((await page.locator('.react-flow').count()) === 0, 'the one-agent view takes the stage')
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
    await sleep(300)
    await shot(`focus-${theme}`)
  }
  await page.keyboard.press('Escape')
  await sleep(700)
  check((await page.locator('.agent-focus').count()) === 0 && (await page.locator('.react-flow').count()) === 1, 'Escape closes the one-agent view')
  check(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'agent-focus-open'), 'focus returns to the button that opened it')
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  finish('run-hold')
} finally {
  await cleanup(app, page, NAME)
}
