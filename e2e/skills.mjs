// Token-free (mock adapter). Project Settings > Tools > Skills: create a skill, grant it to a role, import from a
// fixture repo's .claude/skills (preview, apply, Undo), run Evaluate with evaluation disabled; App settings > Skill library.
import { check, cleanup, createProject, finish, findProject, launch, log, makeFixtureRepo, openAppSettings, openProject, projectTab, removeFixture, sleep, writeFile } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const NAME = 'E2E skills (orgai test)'
const repo = makeFixtureRepo('skills')
writeFile(repo, '.claude/skills/pdf-fill/SKILL.md', '---\nname: pdf-fill\ndescription: Fill in PDF forms when the user supplies a form and values.\n---\nOpen the form, fill the fields, save a copy.\n')
writeFile(repo, '.claude/skills/pdf-fill/scripts/fill.py', '#!/usr/bin/env python3\nprint("fill")\n')
log('fixture at', repo)

const { app, page, shot } = await launch({ shotPrefix: 'skills' })
try {
  const size = /^(\d+)x(\d+)$/.exec(process.env.E2E_SIZE ?? '')
  if (size) await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [Number(size[1]), Number(size[2])])
  await createProject(page, { path: repo, name: NAME })
  await openProject(page, NAME)
  await projectTab(page, 'Settings').click()
  await page.getByRole('tab', { name: 'Tools', exact: true }).click()
  const section = page.locator('[data-testid=skills-section]')
  await section.waitFor({ timeout: 10_000 })
  await shot('tools')

  // Create a skill; invalid input is refused first.
  await section.locator('[data-testid=skill-new]').click()
  const form = page.locator('[data-testid=skill-form]')
  await form.waitFor({ timeout: 5000 })
  await form.locator('[data-testid=skill-name]').fill('Bad Name')
  await form.locator('[data-testid=skill-save]').click()
  check(await form.isVisible(), 'invalid name keeps the form open')
  await form.locator('[data-testid=skill-name]').fill('api-design')
  await form.locator('[data-testid=skill-description]').fill('Use when designing REST endpoints.')
  await form.locator('[data-testid=skill-body]').fill('Prefer nouns. Version the API.')
  await form.locator('[data-testid=skill-save]').click()
  await form.waitFor({ state: 'detached', timeout: 10_000 })
  const row = section.locator('[data-testid=skill-row][data-name="api-design"]')
  await row.waitFor({ timeout: 10_000 })
  check((await findProject(page, NAME))?.skills?.some((s) => s.name === 'api-design'), 'created skill is stored on the project')

  // Grant it to a role through the Roles control.
  await row.locator('[data-testid=skill-roles]').click()
  await row.locator('input[type=checkbox]').first().check({ force: true })
  await sleep(500)
  const proj = await findProject(page, NAME)
  check(proj.roles.some((r) => (r.skills ?? []).length > 0), 'a role holds the skill grant')
  await shot('granted')

  // Import from the repo.
  await section.locator('[data-testid=skill-import]').click()
  const dlg = page.locator('[data-testid=skill-import-dialog]')
  await dlg.waitFor({ timeout: 20_000 })
  await dlg.locator('[data-testid=skill-import-item]').first().waitFor({ timeout: 20_000 })
  check(/may run shell commands/i.test(await dlg.innerText()), 'scripts get the elevated hint')
  await shot('import')
  await dlg.locator('[data-testid=skill-import-apply]').click()
  await dlg.waitFor({ state: 'detached', timeout: 20_000 })
  await section.locator('[data-testid=skill-row][data-name="pdf-fill"]').waitFor({ timeout: 10_000 })
  await section.locator('[data-testid=skill-import-notice]').waitFor({ timeout: 10_000 })
  await section.locator('[data-testid=skill-import-undo]').click()
  await section.locator('[data-testid=skill-row][data-name="pdf-fill"]').waitFor({ state: 'detached', timeout: 10_000 })
  check(true, 'undo removes the imported skill')

  // Evaluate with evaluation disabled: deterministic findings only.
  await section.locator('[data-testid=skill-evaluate]').click()
  await section.locator('[data-testid=skill-eval-last]').waitFor({ timeout: 20_000 })
  check(/Checked/.test(await section.locator('[data-testid=skill-eval-last]').innerText()), 'last evaluation summary shows')
  await shot('evaluated')

  // Remove the skill with a confirm.
  await row.getByRole('button', { name: /More actions/ }).click()
  await page.locator('[data-testid=skill-remove]').click()
  await page.getByRole('button', { name: /^(Delete|Remove)/ }).last().click()
  await row.waitFor({ state: 'detached', timeout: 10_000 })

  // App settings > Skill library.
  await openAppSettings(page)
  await page.getByRole('tab', { name: 'Skill library', exact: true }).click()
  await page.locator('[data-testid=skill-library]').waitFor({ timeout: 10_000 })
  await page.locator('[data-testid=skill-library-new]').click()
  const lf = page.locator('[data-testid=skill-library-form]')
  await lf.waitFor({ timeout: 5000 })
  await shot('library')
  await lf.getByRole('button', { name: 'Cancel' }).click()
} catch (e) {
  check(false, 'skills flow ran without throwing', e.stack ?? String(e))
  await shot('error').catch(() => {})
} finally {
  await cleanup(app, page, NAME)
}
removeFixture(repo)
finish('e2e/skills')
