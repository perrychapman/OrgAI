// Token-free (mock adapter). Team > Catalog > Skills: create a skill, grant it to a role, import from a
// fixture repo's .claude/skills (preview, apply, Undo), run Evaluate with evaluation disabled; App settings > Skill library.
import { check, cleanup, createProject, finish, findProject, launch, log, makeFixtureRepo, openAppSettings, openProject, openTeam, removeFixture, sleep, teamPanelTab, writeFile } from './lib.mjs'

process.env.ORGAI_MOCK = '1'
const NAME = 'E2E skills (orgai test)'
const repo = makeFixtureRepo('skills')
writeFile(repo, '.claude/skills/pdf-fill/SKILL.md', '---\nname: pdf-fill\ndescription: Fill in PDF forms when the user supplies a form and values.\n---\nOpen the form, fill the fields, save a copy.\n')
writeFile(repo, '.claude/skills/pdf-fill/scripts/fill.py', '#!/usr/bin/env python3\nprint("fill")\n')
// A skill that loses frontmatter keys on import, and one the importer refuses (shell injection in the body).
writeFile(repo, '.claude/skills/deploy-check/SKILL.md', '---\nname: deploy-check\ndescription: Use before deploying to verify the release checklist and the rollback plan.\nallowed-tools: Read\nhooks: none\n---\nRead the checklist and confirm each item.\n')
writeFile(repo, '.claude/skills/env-probe/SKILL.md', '---\nname: env-probe\ndescription: Inspect the environment before running a build.\n---\nRun !`echo hi` first.\n')
log('fixture at', repo)

const { app, page, shot } = await launch({ shotPrefix: 'skills' })
try {
  const size = /^(\d+)x(\d+)$/.exec(process.env.E2E_SIZE ?? '')
  if (size) await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [Number(size[1]), Number(size[2])])
  await createProject(page, { path: repo, name: NAME })
  await openProject(page, NAME)
  await openTeam(page)
  await teamPanelTab(page, 'Catalog').click()
  const section = page.locator('[data-testid=skills-section]')
  await section.waitFor({ timeout: 10_000 })
  await shot('catalog')
  check((await page.locator('[data-testid=catalog-skills]').count()) === 1, 'the Catalog has a Skills section')

  // Create a skill; invalid input is refused first.
  await page.locator('[data-testid=catalog-skills-add]').click()
  await page.locator('[data-testid=skill-new]').click()
  const form = page.locator('[data-testid=skill-form]')
  await form.waitFor({ timeout: 5000 })
  await form.locator('[data-testid=skill-name]').fill('Bad Name')
  // Esc on a dirty form asks first; Cancel in the confirm keeps the typed work.
  await page.keyboard.press('Escape')
  const discard = page.getByRole('button', { name: 'Discard', exact: true })
  await discard.waitFor({ timeout: 5000 })
  check(true, 'Esc on a dirty form asks before discarding')
  await page.getByRole('button', { name: 'Cancel', exact: true }).last().click()
  await discard.waitFor({ state: 'detached', timeout: 5000 })
  check((await form.locator('[data-testid=skill-name]').inputValue()) === 'Bad Name', 'keeping the form keeps what was typed')
  check(await form.locator('[data-testid=skill-role-picker]').isVisible(), 'the add form shows the role picker inline')
  check(/Until you choose roles/.test(await form.locator('[data-testid=skill-role-hint]').innerText()), 'the picker says nothing is loaded until roles are chosen')
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
  check(/No role can load it/.test(await section.locator('[data-testid=skill-notice]').innerText()), 'the success notice says no role can load a skill created without roles')
  await row.locator('[data-testid=skill-no-roles]').waitFor({ timeout: 5000 })
  check(true, 'an enabled skill with no roles shows "No role can load this"')

  // Grant it to a role through the Roles control.
  await row.locator('[data-testid=skill-choose-roles]').click()
  const opened = await row.locator('[data-testid=skill-roles][aria-expanded=true]').waitFor({ timeout: 5000 }).then(() => true, () => false)
  check(opened, '"Choose roles" opens the Roles control')
  await row.locator('input[type=checkbox]').first().check({ force: true })
  await sleep(500)
  const proj = await findProject(page, NAME)
  check(proj.roles.some((r) => (r.skills ?? []).length > 0), 'a role holds the skill grant')
  check((await row.locator('[data-testid=skill-no-roles]').count()) === 0, 'the warning goes once a role holds the skill')
  await shot('granted')

  // Import from the repo. The banner names the counts once; one skill is refused.
  const banner = section.locator('[data-testid=skill-import-banner]')
  await banner.waitFor({ timeout: 20_000 })
  check(/2 can be imported, 1 cannot/.test(await banner.innerText()), 'the import banner names the counts once')
  await page.locator('[data-testid=catalog-skills-add]').click()
  await page.locator('[data-testid=skill-import]').click()
  const dlg = page.locator('[data-testid=skill-import-dialog]')
  await dlg.waitFor({ timeout: 20_000 })
  await dlg.locator('[data-testid=skill-import-item]').first().waitFor({ timeout: 20_000 })
  check(/may run shell commands/i.test(await dlg.innerText()), 'scripts get the elevated hint')
  check((await dlg.locator('[data-testid=skill-import-invalid-item]').count()) === 1, 'the refused skill is listed once')
  check((await dlg.locator('[data-testid=skill-import-dropped]').count()) === 1, 'dropped frontmatter keys get a warning note')
  await shot('import')
  await dlg.locator('[data-testid=skill-import-apply]').click()
  await dlg.waitFor({ state: 'detached', timeout: 20_000 })
  await section.locator('[data-testid=skill-row][data-name="pdf-fill"]').waitFor({ timeout: 10_000 })
  const importNotice = section.locator('[data-testid=skill-import-notice]')
  await importNotice.waitFor({ timeout: 10_000 })
  check(/deploy-check: dropped allowed-tools, hooks, which OrgAI does not run/.test(await importNotice.innerText()), 'the import notice keeps the dropped keys and the reason')
  check(/1 skill in the repository cannot be imported/.test(await section.locator('[data-testid=skill-import-refused-line]').innerText()), 'a quiet line keeps the refused count after import')
  check((await section.locator('[data-testid=skill-row][data-name="pdf-fill"] [data-testid=skill-no-roles]').count()) === 1, 'an imported skill without roles carries the warning')
  await shot('imported')
  await section.locator('[data-testid=skill-import-undo]').click()
  await section.locator('[data-testid=skill-row][data-name="pdf-fill"]').waitFor({ state: 'detached', timeout: 10_000 })
  check(true, 'undo removes the imported skill')

  // Promote to library: a notice with an Edit in library action; the row keeps Edit.
  const promoteRow = section.locator('[data-testid=skill-row][data-name="api-design"]')
  await promoteRow.getByRole('button', { name: /More actions/ }).click()
  await page.locator('[data-testid=skill-promote]').click()
  const promoted = section.locator('[data-testid=skill-notice]')
  await promoted.waitFor({ timeout: 10_000 })
  check(/api-design is now in the library\. Edits happen there\./.test(await promoted.innerText()), 'promote gives a notice that edits happen in the library')
  check((await promoted.locator('[data-testid=skill-notice-edit-library]').count()) === 1, 'the promote notice has Edit in library')
  check((await promoteRow.locator('[data-testid=skill-edit]').count()) === 1, 'a linked skill keeps its Edit button')
  check((await promoteRow.locator('[data-testid=skill-library-badge]').innerText()).trim() === 'Library', 'the linked badge reads Library')

  // Evaluate with evaluation disabled: deterministic findings only. Focus lands on the results heading.
  await section.locator('[data-testid=skill-evaluate]').click()
  await section.locator('[data-testid=skill-eval-last]').waitFor({ timeout: 20_000 })
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'skill-eval-heading', null, { timeout: 10_000 })
  check(true, 'focus moves to the Last evaluation results heading after Evaluate')
  check(/Evaluation finished, \d+ findings?, \d+ suggestions?/.test(await section.locator('[data-testid=skill-eval-live]').innerText()), 'the live region announces the result')
  check(/Checked/.test(await section.locator('[data-testid=skill-eval-last]').innerText()), 'last evaluation summary shows')
  check(/(Show|Hide) /.test(await section.locator('[data-testid=skill-eval-toggle]').innerText()), 'the disclosure says what it shows')
  await shot('evaluated')

  // Remove the skill with a confirm.
  await row.getByRole('button', { name: /More actions/ }).click()
  await page.locator('[data-testid=skill-remove]').click()
  await page.getByRole('button', { name: /^(Delete|Remove|Unlink)/ }).last().click()
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
