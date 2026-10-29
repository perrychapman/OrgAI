// SPENDS TOKENS. Drives the AI-driven setup flow against a fixture repo: create the project in "Existing repository"
// mode (or "New idea" with --new), approve the architecture, send the org chart back once with feedback, approve the
// rest, then check what was applied to the project and the repository. Usage: node e2e/setup.mjs --yes [--new]
import * as fs from 'node:fs'
import * as path from 'node:path'
import { check, cleanup, createProject, driveSetup, endSession, finish, findProject, launch, log, makeFixtureRepo, removeFixture, requireYes, sleep } from './lib.mjs'

requireYes('e2e/setup', '$0.30-$1.50 on opus; about 3-8 minutes')

const NEW_MODE = process.argv.includes('--new')
const NAME = NEW_MODE ? 'E2E setup new idea (orgai test)' : 'E2E setup (orgai test)'
const repo = makeFixtureRepo('setup')
const target = NEW_MODE ? path.join(repo, 'new-app') : repo

const { app, page, shot } = await launch({ shotPrefix: 'setup' })
try {
  await createProject(page, {
    mode: NEW_MODE ? 'new' : 'existing',
    path: target,
    name: NAME,
    brief: NEW_MODE ? 'A tiny command-line todo app in Node. Keep it minimal: one file of logic plus tests.' : 'I mostly add endpoints and fix bugs here. Keep it small.',
    skipSetup: false
  })
  await page.waitForSelector('.agent-node', { timeout: 120_000 })
  log('setup run started')
  await shot('started')

  let revised = false
  const { done, approved } = await driveSetup(page, NAME, {
    shot,
    decide: (kind) => {
      if (kind === 'orgChart' && !revised) {
        revised = true
        return 'Rename the root orchestrator to "Tech Lead" and make sure there is a read-only reviewer role. Otherwise fine.'
      }
      return 'approve'
    }
  })
  log('approved:', approved.join(', '), '| done:', done)
  check(done, 'setup reached complete')
  check(['architecture', 'orgChart', 'settings'].every((k) => approved.includes(k)), 'architecture, org chart and settings approved', approved.join(','))
  check(revised, 'org chart was sent back once')
  await sleep(4000) // let the closing message land
  await shot('final')

  const p = await findProject(page, NAME)
  log('roles:', p?.roles.map((r) => `${r.name}[${r.model}]${r.reportsTo ? '' : '*'}`).join(', '))
  check(p?.roles.filter((r) => r.reportsTo === null).length === 1, 'applied org chart has exactly one root')
  check(/tech lead/i.test(p?.roles.find((r) => r.reportsTo === null)?.name ?? ''), 'feedback applied: root is "Tech Lead"')
  check(p?.roles.some((r) => /review/i.test(r.name) && !r.tools.includes('Edit') && !r.tools.includes('Write')), 'feedback applied: read-only reviewer exists')
  check(!!p?.brief, 'project brief set by settings proposal')
  check(fs.existsSync(path.join(target, '.orgai', 'ARCHITECTURE.md')), '.orgai/ARCHITECTURE.md written')
  const claudeMd = path.join(target, 'CLAUDE.md')
  check(fs.existsSync(claudeMd) && fs.readFileSync(claudeMd, 'utf8').includes('<!-- orgai:architecture -->'), 'CLAUDE.md references the architecture')

  await page.getByRole('button', { name: 'Logs' }).click().catch(() => {})
  log('run logs:\n' + (await page.locator('.logs').innerText().catch(() => '')).slice(0, 1500))
  await endSession(page)
} catch (e) {
  check(false, 'setup flow ran without throwing', e.stack ?? String(e))
  await shot('error').catch(() => {})
} finally {
  await cleanup(app, page, NAME)
  removeFixture(repo)
}
finish('e2e/setup')
