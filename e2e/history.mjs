// SPENDS TOKENS. Runs a setup session (approving everything), restarts the app, reopens that run from the Runs tab and
// checks the canvas and transcript are redrawn from disk. Deleting the project must remove the run records too.
// Usage: node e2e/history.mjs --yes
import * as fs from 'node:fs'
import * as path from 'node:path'
import { check, cleanup, createProject, driveSetup, endSession, finish, findProject, launch, log, makeFixtureRepo, openProject, removeFixture, requireYes, runRecordsDir, sleep } from './lib.mjs'

requireYes('e2e/history', '$0.30-$1.50 on opus; about 3-8 minutes')

const NAME = 'E2E history (orgai test)'
const repo = makeFixtureRepo('history')
const recordFiles = (ids) => (fs.existsSync(runRecordsDir()) ? fs.readdirSync(runRecordsDir()).filter((f) => ids.some((id) => f.startsWith(id.replace(/[^a-z0-9_-]/gi, '_')))) : [])

// ---- Session 1: run setup, approve everything.
let { app, page, shot } = await launch({ shotPrefix: 'history-1' })
let runIds = []
try {
  await createProject(page, { mode: 'existing', path: repo, name: NAME, skipSetup: false })
  await page.waitForSelector('.agent-node', { timeout: 120_000 })
  log('setup started')
  const { done } = await driveSetup(page, NAME, { deadlineMs: 10 * 60_000 })
  check(done, 'setup reached complete')
  await sleep(4000)
  await endSession(page)
  await page.getByRole('button', { name: 'History', exact: true }).click()
  await sleep(500)
  await shot('runs-tab')
  const rows = await page.locator('.run-row').count()
  check(rows >= 1, 'Runs tab lists the setup run', String(rows))
  const project = await findProject(page, NAME)
  runIds = (await page.evaluate((id) => window.orgai.runs.list(id), project.id)).map((r) => r.id)
  log('run ids:', runIds.join(','))
  check(recordFiles(runIds).length === runIds.length, 'one record file per run on disk', recordFiles(runIds).join(','))
} catch (e) {
  check(false, 'session 1 ran without throwing', e.stack ?? String(e))
  await shot('error').catch(() => {})
}
await app.close().catch(() => {})

// ---- Session 2: relaunch, reopen the past run from history.
;({ app, page, shot } = await launch({ shotPrefix: 'history-2' }))
try {
  await openProject(page, NAME)
  await sleep(800)
  await page.getByRole('button', { name: 'History', exact: true }).click()
  await sleep(500)
  check((await page.locator('.run-row').count()) >= 1, 'run history survives a restart')
  await page.locator('.run-row .run-open').first().click()
  await sleep(1500)
  const nodes = await page.locator('.agent-node').count()
  check(nodes >= 1, 'past run redrawn on the canvas', String(nodes))
  await page.getByRole('button', { name: 'Transcript', exact: true }).click()
  await sleep(400)
  const entries = await page.locator('.transcript .entry').count()
  check(entries > 0, 'transcript restored', String(entries))
  await shot('reopened')
} catch (e) {
  check(false, 'session 2 ran without throwing', e.stack ?? String(e))
  await shot('error').catch(() => {})
} finally {
  await cleanup(app, page, NAME)
  await sleep(500)
  check(recordFiles(runIds).length === 0, 'deleting the project removed its run records', recordFiles(runIds).join(','))
  removeFixture(repo)
}
finish('e2e/history')
