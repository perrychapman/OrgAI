// Token-free. Creates projects in both form modes with "Skip AI setup", checks the live view's layout with a very
// long repository path (no horizontal page scroll, sidebar visible, empty state shown), screenshots, and deletes them.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { check, cleanup, createProject, deleteProject, finish, launch, log, makeFixtureRepo, removeFixture, sleep } from './lib.mjs'

const NAME = 'E2E layout (orgai test)'
const NEW_NAME = 'E2E layout new idea (orgai test)'

// A long path stresses the topbar path pill.
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'orgai-e2e-layout-')))
const repo = path.join(base, 'a-rather-long-directory-name-for-layout-checks', 'and-another-nested-level-to-make-it-longer', 'repo')
makeFixtureRepo('layout', { at: repo })

const { app, page, shot } = await launch({ shotPrefix: 'layout' })
try {
  log('auth pill:', await page.locator('.sidebar-footer .pill').innerText())

  const project = await createProject(page, { mode: 'existing', path: repo, name: NAME })
  check(!!project, 'existing-repo project created')
  check(project?.setup === undefined, 'skip AI setup leaves no setup record')
  check(project?.roles?.length === 4, 'default org chart has 4 roles', String(project?.roles?.length))
  check((await page.locator('.editor').count()) > 0, 'lands on the org chart editor after create')
  await shot('editor')

  await page.locator('.topbar .tabs').getByRole('button', { name: 'Live', exact: true }).click()
  await sleep(800)
  const overflow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
  check(overflow.sw <= overflow.cw, 'live view has no horizontal page scroll', `${overflow.sw}/${overflow.cw}`)
  check(await page.locator('.sidebar').isVisible(), 'sidebar stays visible with a long path')
  const pillBox = await page.locator('.topbar .pill', { hasText: 'a-rather-long' }).first().boundingBox()
  const vw = await page.evaluate(() => window.innerWidth)
  check(!!pillBox && pillBox.x + pillBox.width <= vw, 'path pill fits in the window', JSON.stringify(pillBox))
  const heading = await page.locator('.empty h2').innerText({ timeout: 5000 }).catch(() => '')
  check(/something to do/i.test(heading), 'empty state invites a first task', heading)
  check((await page.locator('.composer textarea').count()) === 1, 'composer is present')
  await shot('live-long-path')

  // New-idea mode, also token-free with setup skipped.
  const created = await createProject(page, { mode: 'new', path: path.join(base, 'new-idea-folder'), name: NEW_NAME, brief: 'A tiny todo app for layout testing.' })
  check(!!created, 'new-idea project created')
  check(created?.brief === 'A tiny todo app for layout testing.', 'new-idea brief stored')
  await shot('new-idea')
  check((await deleteProject(page, NEW_NAME)) === 0, 'new-idea project deleted')
  await shot('projects-after-delete')
} catch (e) {
  check(false, 'layout flow ran without throwing', e.stack ?? String(e))
  await shot('error').catch(() => {})
  await deleteProject(page, NEW_NAME).catch(() => {})
} finally {
  await cleanup(app, page, NAME)
  removeFixture(base)
}
finish('e2e/layout')
