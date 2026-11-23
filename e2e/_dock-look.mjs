import * as fs from 'node:fs'
import * as path from 'node:path'
import { TMP, check, cleanup, createProject, finish, launch, makeFixtureRepo, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const NAME = 'E2E dock look (orgai test)'
const base = fs.mkdtempSync(path.join(TMP, 'orgai-e2e-dock-'))
const repo = path.join(base, 'repo')
makeFixtureRepo('dock', { at: repo })
const { app, page, shot } = await launch({ shotPrefix: 'dock' })
const size = async (w, h) => {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
  await sleep(700)
}
try {
  await createProject(page, { mode: 'existing', path: repo, name: NAME })
  await page.getByRole('tablist', { name: 'Project sections' }).getByRole('tab', { name: 'Live', exact: true }).click()
  await page.locator('.new-run').waitFor({ timeout: 10_000 })
  const ta = page.locator('.composer textarea')
  await ta.fill(process.env.PROMPT ?? 'Do some work [mock:provider-error]')
  await page.locator('.composer .btn.primary').click()
  await page.locator('.react-flow__node').first().waitFor({ timeout: 30_000 })
  await sleep(1500)
  for (const [w, h] of [[1024, 640], [1600, 1000]]) {
    await size(w, h)
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await sleep(300)
      await shot(`open-${w}-${theme}`)
      await page.getByRole('button', { name: /^Hide run panel/ }).click()
      await sleep(700)
      await shot(`hidden-${w}-${theme}`)
      await page.locator('[data-testid=dock-show]').click()
      await sleep(700)
    }
  }
  console.log(SHOTS())
  finish('dock-look')
} finally {
  await cleanup(app, page, NAME)
}
function SHOTS() { return 'shots in e2e/shots' }
