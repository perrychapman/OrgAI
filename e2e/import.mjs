// Token-free (mock adapter). A fixture repo holds two Claude Code agent files and AGENTS.md. Drives the New project
// form (found line, setup choice, "Review import"), the review dialog, the apply banner with Undo, the Org chart
// "Import agents" and "Export to repo" actions, and checks the repository stays untouched except for the export.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { check, cleanup, finish, findProject, gotoProjects, launch, log, makeFixtureRepo, removeFixture, sleep, writeFile } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const NAME = 'E2E import (orgai test)'

const repo = makeFixtureRepo('import')
writeFile(repo, '.claude/agents/backend-dev.md', '---\nname: backend-dev\ndescription: Builds the API\ntools: Read, Edit, Bash, Teleport\nmodel: claude-3-5-sonnet-20241022\n---\nYou build the backend. Keep handlers small.\n')
writeFile(repo, '.claude/agents/reviewer.md', '---\nname: reviewer\ndescription: Reviews changes\ntools: Read, Grep\nmodel: opus\n---\nYou review code for bugs.\n')
writeFile(repo, 'AGENTS.md', '# Agents\n\nUse ES modules.\n')
const before = fs.readFileSync(path.join(repo, '.claude/agents/reviewer.md'), 'utf8')
log('fixture at', repo)

const { app, page, shot } = await launch({ shotPrefix: 'import' })
try {
  await gotoProjects(page)
  const form = page.locator('form.card')
  if (!(await form.count())) await page.locator('[data-testid=new-project]').click()
  await form.waitFor({ timeout: 10_000 })
  await form.getByRole('radio', { name: 'Existing repository', exact: true }).check({ force: true })
  await form.locator('input[placeholder*="repo"]').fill(repo)
  await form.locator('input[placeholder*="Defaults to the folder name"]').fill(NAME)
  const found = form.locator('[data-testid=agents-found]')
  await found.waitFor({ timeout: 10_000 })
  check((await found.innerText()).trim() === 'Found 2 Claude Code agents and AGENTS.md.', 'form names the agents found', await found.innerText())
  const radios = form.locator('[data-testid=setup-choice] input[type=radio]')
  check((await radios.count()) === 3, 'three setup choices replace the Architect checkbox')
  check((await form.locator('[data-testid=architect-setup]').count()) === 0, 'no Architect checkbox when agents exist')
  await shot('form')
  await form.getByRole('button', { name: 'Review import' }).click()

  const dialog = page.locator('[data-testid=import-dialog]')
  await dialog.waitFor({ state: 'visible', timeout: 60_000 })
  await dialog.locator('[data-testid=import-row]').first().waitFor({ timeout: 20_000 })
  check((await dialog.locator('[data-testid=import-row]').count()) === 2, 'review lists two roles')
  const text = (await dialog.innerText()).replace(/\s+/g, ' ')
  check(/Not available in OrgAI: Teleport/.test(text), 'dropped tool is named', text.slice(0, 300))
  check(/claude-3-5-sonnet-20241022/.test(text), 'model before is shown')
  check(/Nothing is written until you import/.test(text), 'footer says nothing is written yet')
  check((await findProject(page, NAME))?.roles.every((r) => r.slug !== 'backend-dev'), 'nothing applied before the click')
  await dialog.getByText('Read prompt').first().click()
  check(/You (build|review)/.test(await dialog.innerText()), 'prompt can be read')
  await shot('review')
  // Untick one role: the count follows main's preview.
  await dialog.locator('[data-testid=import-include]').nth(1).uncheck({ force: true })
  await dialog.getByRole('button', { name: 'Import 1 role', exact: true }).waitFor({ timeout: 10_000 })
  await dialog.locator('[data-testid=import-include]').nth(1).check({ force: true })
  await dialog.getByRole('button', { name: 'Import 2 roles', exact: true }).click()
  await dialog.waitFor({ state: 'detached', timeout: 20_000 })

  const notice = page.locator('[data-testid=import-notice]')
  await notice.waitFor({ timeout: 10_000 })
  check(/Imported 2 roles from Claude Code/.test(await notice.innerText()), 'banner reports the import', await notice.innerText())
  let project = await findProject(page, NAME)
  check(!!project?.roles.some((r) => r.slug === 'backend-dev'), 'imported role is in the chart')
  await shot('imported')

  await page.locator('[data-testid=import-undo]').click()
  await page.getByText('Import undone').waitFor({ timeout: 10_000 })
  project = await findProject(page, NAME)
  check(!project?.roles.some((r) => r.slug === 'backend-dev'), 'undo restores the previous chart')

  // Org chart entry points.
  await page.locator('[data-testid=import-agents]').click()
  const again = page.locator('[data-testid=import-dialog]')
  await again.waitFor({ state: 'visible', timeout: 20_000 })
  check(await again.getByRole('radio', { name: 'Add to the chart' }).isChecked(), 'Import agents from the toolbar defaults to Add')
  await again.getByRole('button', { name: 'Cancel' }).click()
  await again.waitFor({ state: 'detached', timeout: 10_000 })

  await page.locator('[data-testid=export-org]').click()
  const dlg = page.locator('dialog[open]')
  await dlg.waitFor({ timeout: 10_000 })
  await dlg.getByRole('button', { name: 'Export to repo', exact: true }).click()
  await page.locator('[data-testid=export-notice]').waitFor({ timeout: 10_000 })
  check(fs.existsSync(path.join(repo, '.orgai', 'org.json')), 'export wrote .orgai/org.json')
  await sleep(200)
  await shot('export')
} catch (e) {
  check(false, 'import flow ran without throwing', e.stack ?? String(e))
  await shot('error').catch(() => {})
} finally {
  await cleanup(app, page, NAME)
}
check(fs.readFileSync(path.join(repo, '.claude/agents/reviewer.md'), 'utf8') === before, 'agent files unchanged')
removeFixture(repo)
finish('e2e/import')
