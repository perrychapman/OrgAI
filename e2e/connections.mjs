// Token-free. Opens App settings > Connections and a project's Settings (connection picker, MCP servers, plugins,
// role model picker), checks the markup exists in either its loaded or its error state (the IPC handlers may
// still be stubs), and takes screenshots at 1024x640 and 1600x1000 in both themes.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { check, cleanup, createProject, finish, launch, makeFixtureRepo, removeFixture, sleep } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const NAME = 'E2E connections (orgai test)'
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orgai-e2e-conn-')))
const repo = path.join(base, 'repo')
makeFixtureRepo('conn', { at: repo })

const { app, page, shot } = await launch({ shotPrefix: 'conn' })
try {
  const project = await createProject(page, { mode: 'existing', path: repo, name: NAME })
  check(!!project, 'project created')

  const sizes = [[1024, 640], [1600, 1000]]
  for (const [w, h] of sizes) {
    await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0].setContentSize(cw, ch), [w, h])
    await sleep(300)
    for (const theme of ['dark', 'light']) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)

      // App settings > Connections
      await page.locator('.nav-item', { hasText: 'Settings' }).first().click()
      await page.waitForSelector('#connections-title', { timeout: 10_000 })
      await sleep(800)
      const cards = await page.locator('[data-testid=connection-card]').count()
      const errBanner = await page.getByText('Could not load connections').count()
      check(cards === 3 || errBanner === 1, `connections page shows three cards or a load error at ${w}x${h} ${theme}`, `${cards}/${errBanner}`)
      const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
      check(ov.sw <= ov.cw, `no horizontal scroll on connections at ${w}x${h} ${theme}`, JSON.stringify(ov))
      await shot(`connections-${w}x${h}-${theme}`)

      // Project settings
      await page.locator('.nav-item', { hasText: NAME }).first().click()
      await page.locator('.topbar .tabs').getByRole('button', { name: /Org chart/ }).click()
      await page.getByRole('button', { name: 'Project settings', exact: true }).click()
      await page.waitForSelector('#settings-section-connection', { timeout: 10_000 })
      await sleep(600)
      check((await page.locator('#settings-section-mcp').count()) === 1, `MCP section present at ${w}x${h} ${theme}`)
      check((await page.locator('#settings-section-plugins').count()) === 1, `plugins section present at ${w}x${h} ${theme}`)
      check((await page.getByRole('button', { name: 'Add from registry' }).count()) === 1, 'Add from registry button present')
      await page.locator('#settings-section-connection').scrollIntoViewIfNeeded()
      await shot(`project-connection-${w}x${h}-${theme}`)
      await page.locator('#settings-section-mcp').scrollIntoViewIfNeeded()
      await shot(`project-mcp-${w}x${h}-${theme}`)

      // Role inspector model picker
      await page.getByRole('button', { name: 'Org chart', exact: true }).first().click()
      await page.locator('.react-flow__node').first().click()
      await page.waitForSelector('[data-testid=role-model]', { timeout: 5000 })
      check((await page.locator('[data-testid=role-tier-badge]').count()) === 1, `role tier badge present at ${w}x${h} ${theme}`)
      await shot(`role-model-${w}x${h}-${theme}`)
    }
  }

  // LiteLLM against an unreachable proxy: error state (no crash), and the key never lands in plain text on disk.
  const CANARY = 'sk-e2e-canary-9f3a7c1d'
  await page.locator('.nav-item', { hasText: 'Settings' }).first().click()
  await page.waitForSelector('#connections-title', { timeout: 10_000 })
  const lite = page.locator('[data-testid=connection-card][data-provider=litellm]')
  if ((await lite.count()) === 1) {
    if ((await lite.locator('#litellm-url').count()) === 0) await lite.getByRole('button', { name: /^Expand/ }).click()
    const stored = await page.evaluate((k) => window.orgai.connections.setSecret({ id: 'litellm', apiKey: k }).then(() => true, () => false), CANARY)
    console.log('canary key stored:', stored)
    await lite.locator('#litellm-url').fill('http://127.0.0.1:9')
    await lite.getByRole('button', { name: 'Test and connect' }).click()
    await page.waitForFunction(
      () => /error|fail|reach|refused|ECONN|timed/i.test(document.querySelector('[data-provider=litellm] [data-testid=connection-status]')?.textContent ?? ''),
      null,
      { timeout: 30_000 }
    ).catch(() => {})
    const status = (await lite.locator('[data-testid=connection-status]').textContent()) ?? ''
    check(/error|fail|reach|refused|ECONN|timed/i.test(status), 'LiteLLM test against an unreachable URL shows an error state', status)
    check(!status.includes(CANARY), 'status text has no secret')
    check((await page.locator('[data-testid=connection-card]').count()) === 3, 'connections page still lists three cards after the failed test')
    await shot('litellm-unreachable')
    const userData = await app.evaluate(({ app: a }) => a.getPath('userData'))
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (['runs', 'Cache', 'Code Cache', 'GPUCache', 'blob_storage'].includes(e.name) ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]))
    const leaks = walk(userData).filter((f) => { try { return fs.statSync(f).size < 20e6 && fs.readFileSync(f).includes(CANARY) } catch { return false } })
    check(leaks.length === 0, 'no plain-text secret in settings, projects or logs in the data dir', leaks.join(', '))
    await lite.getByRole('button', { name: 'Remove connection' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Remove connection' }).click()
    await sleep(800)
    check((await page.evaluate(() => window.orgai.connections.list())).find((c) => c.connection.id === 'litellm')?.connection.hasApiKey !== true, 'Remove connection clears the stored key')
    await page.locator('.nav-item', { hasText: NAME }).first().click()
  } else {
    check(false, 'LiteLLM card present')
  }
} catch (e) {
  check(false, 'connections flow ran without throwing', e.stack ?? String(e))
  await shot('error').catch(() => {})
} finally {
  await cleanup(app, page, NAME)
  removeFixture(base)
}
finish('e2e/connections')
