// Focused Pocket Office runner; canvas.mjs imports the same checks for CI.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { TMP, check, cleanup, createProject, finish, launch, makeFixtureRepo, sleep } from './lib.mjs'
import { checkPocketOffice } from './pocket-office.mjs'

process.env.ORGAI_MOCK = '1'
const scriptFile = path.join(fs.mkdtempSync(path.join(TMP, 'orgai-office-script-')), 'script.json')
fs.writeFileSync(scriptFile, JSON.stringify({ delayMs: 300 }))
process.env.ORGAI_MOCK_SCRIPT = scriptFile
const name = 'E2E Pocket Office (orgai test)'
const repo = makeFixtureRepo('office')
const { app, page, shot } = await launch({ shotPrefix: 'office' })
const resizeTo = async (width, height) => {
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [width, height])
  await page.waitForFunction(w => Math.abs(window.innerWidth - w) <= 1, width)
  await sleep(250)
}
const setAppearance = async (patch, canvas = {}) => {
  await page.evaluate(async ([p, c]) => {
    const { dataDir: _d, appVersion: _v, ...settings } = await window.orgai.settings.get()
    await window.orgai.settings.set({ ...settings, appearance: { ...settings.appearance, ...p, canvas: { ...settings.appearance.canvas, ...c } } })
  }, [patch, canvas])
  await sleep(250)
}
const setCanvas = canvas => setAppearance({}, canvas)
const noPageScroll = () => page.evaluate(() => {
  const el = document.scrollingElement
  return el.scrollHeight <= innerHeight + 1 && el.scrollWidth <= innerWidth + 1 && el.scrollTop === 0
})
try {
  await createProject(page, { mode: 'existing', path: repo, name })
  await checkPocketOffice({ page, name, resizeTo, setAppearance, setCanvas, noPageScroll, shot, scriptFile })
} catch (error) {
  check(false, 'Pocket Office checks ran to the end', error.stack ?? error.message)
} finally {
  await cleanup(app, page, name)
  finish('office.mjs')
}
