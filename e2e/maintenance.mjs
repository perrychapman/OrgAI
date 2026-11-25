// Token-free. Plants two leftover report worktrees in a fixture repo (one clean, one that conflicts with main) plus
// the files OrgAI's setup writes, then drives the Maintenance panel: merge the clean branch, see the conflict reported
// and the branch kept, see "Remove OrgAI files" refuse while work is pending, discard the branch, remove the files,
// and delete the project. Finally checks the repository on disk.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { check, cleanup, createProject, finish, git, gitSafe, launch, log, makeFixtureRepo, projectTab, removeFixture, sleep, writeFile, t } from './lib.mjs'
import { engagementEmptyChecks, limitsChecks } from './limits-checks.mjs'

const NAME = 'E2E maintenance (orgai test)'
const MARKER = '<!-- orgai:architecture -->'
const ORIGINAL_CLAUDE_MD = '# Tiny notes API\n\nUse ES modules. Keep handlers small.\n'

// ---------- Fixture: what a finished setup plus two interrupted reports leave behind ----------
const repo = makeFixtureRepo('maint')
fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '.claude/worktrees/\n')
writeFile(repo, '.orgai/ARCHITECTURE.md', '# Tiny notes API architecture\n\nExpress, in-memory store.\n')
writeFile(
  repo,
  'CLAUDE.md',
  `${ORIGINAL_CLAUDE_MD}\n${MARKER}\n## Architecture and conventions\n\n` +
    'Read `.orgai/ARCHITECTURE.md` before changing code. It records the agreed stack, module layout, conventions and commands for this project. Keep it current when they change.\n'
)
git(repo, ['add', '-A'])
git(repo, ['commit', '-q', '-m', 'architecture doc'])

const plant = (id) => {
  const rel = `.claude/worktrees/agent-${id}`
  git(repo, ['worktree', 'add', '-q', '-b', `worktree-agent-${id}`, rel])
  return path.join(repo, rel)
}
// Clean: one commit plus an uncommitted file the harness must commit before merging.
const wtA = plant('cleanA')
writeFile(wtA, 'src/health.js', "export const health = () => ({ ok: true })\n")
git(wtA, ['add', '-A'])
git(wtA, ['commit', '-q', '-m', 'Implementer: add health helper'])
writeFile(wtA, 'src/version.js', "export const VERSION = '0.2.0'\n")
// Conflicting: edits README on the branch while main edits the same line.
const wtB = plant('conflictB')
writeFile(wtB, 'README.md', '# tiny-notes-api (from the report)\n')
git(wtB, ['commit', '-q', '-am', 'Implementer: retitle README'])
writeFile(repo, 'README.md', '# tiny-notes-api (from main)\n')
git(repo, ['commit', '-q', '-am', 'main: retitle README'])
log('fixture at', repo)

const { app, page, shot } = await launch({ shotPrefix: 'maint' })
const rows = page.locator('.maint-row')
// The panel's own notice: a direct child of the Maintenance section.
const notice = page.locator('#settings-section-maintenance > .draft-box')

/** Wait for the maintenance notice to match. */
async function waitNotice(re, ms = 30_000) {
  const until = Date.now() + t(ms)
  let text = ''
  while (Date.now() < until) {
    text = (await notice.innerText().catch(() => '')).trim()
    if (re.test(text)) return text
    await sleep(250)
  }
  return text
}

/** Click the confirm button of the in-app ConfirmDialog (window.confirm is gone). */
async function confirmDialog(button) {
  const dlg = page.locator('dialog[open]')
  await dlg.waitFor({ timeout: t(10_000) })
  await dlg.getByRole('button', { name: button, exact: true }).click()
  await dlg.waitFor({ state: 'detached', timeout: t(10_000) }).catch(() => {})
}

try {
  const project = await createProject(page, { mode: 'existing', path: repo, name: NAME })
  check(!!project, 'project created')
  await projectTab(page, 'Settings').click()
  await page.getByRole('tab', { name: 'Branches', exact: true }).click()
  await page.waitForSelector('.maint-row', { timeout: t(20_000) })
  const count = await rows.count()
  check(count === 2, 'maintenance lists two pending branches', String(count))
  const rowA = rows.filter({ hasText: 'worktree-agent-cleanA' })
  const rowB = rows.filter({ hasText: 'worktree-agent-conflictB' })
  const textA = (await rowA.innerText()).replace(/\s+/g, ' ')
  log('row A:', textA)
  check(/1 uncommitted/i.test(textA) && /1 commit ahead/i.test(textA), 'clean row shows uncommitted file and commit ahead', textA)
  check(/src\/health\.js/.test(textA), 'clean row lists touched files', textA)
  await rows.first().scrollIntoViewIfNeeded()
  await shot('list')

  // Merge the clean branch.
  await rowA.getByRole('button', { name: /Merge into main checkout/ }).click()
  const merged = await waitNotice(/Merged worktree-agent-cleanA/)
  check(/Merged worktree-agent-cleanA/.test(merged), 'clean branch merged', merged)
  await page.waitForFunction(() => document.querySelectorAll('.maint-row').length === 1, null, { timeout: t(15_000) }).catch(() => {})
  check((await rows.count()) === 1, 'merged branch disappears from the list')

  // The conflicting branch is reported and kept.
  await rowB.getByRole('button', { name: /Merge into main checkout/ }).click()
  const conflict = await waitNotice(/could not be merged/)
  check(/could not be merged/.test(conflict) && /README\.md/.test(conflict), 'conflict reported with the file', conflict)
  check((await rows.count()) === 1, 'conflicting branch is kept')
  await shot('conflict')

  // Uninstall refuses while the branch holds work.
  await page.getByRole('button', { name: /Remove OrgAI files from repository/ }).click()
  await confirmDialog('Remove files')
  const refused = await waitNotice(/unmerged work/)
  check(/unmerged work/.test(refused), 'uninstall refuses while work is pending', refused)
  check(fs.existsSync(path.join(repo, '.orgai', 'ARCHITECTURE.md')), 'architecture file untouched after refusal')

  // Discard, then uninstall.
  await rowB.getByRole('button', { name: 'Discard' }).click()
  await confirmDialog('Discard branch')
  const discarded = await waitNotice(/Discarded worktree-agent-conflictB/)
  check(/Discarded/.test(discarded), 'conflicting branch discarded', discarded)
  await page.waitForFunction(() => document.querySelectorAll('.maint-row').length === 0, null, { timeout: t(15_000) }).catch(() => {})
  check((await rows.count()) === 0, 'no pending branches left')

  // "Finished copies on this computer": a count and size, "None", or a stated failure; never a bare 0 or a blank.
  const copiesText = (await page.locator('[data-testid=finished-copies-size]').innerText().catch(() => '')).trim()
  check(/^(None|\d+ copies?( · (at least )?[\d.,]+ ?\w+)?|Measuring…|Could not be measured)$/.test(copiesText), 'finished copies shows a value or a stated unknown', copiesText)
  await page.waitForFunction(() => !/Measuring/.test(document.querySelector('[data-testid=finished-copies-size]')?.textContent ?? ''), null, { timeout: t(15_000) }).catch(() => {})
  const copiesDone = (await page.locator('[data-testid=finished-copies-size]').innerText().catch(() => '')).trim()
  check(copiesDone !== '' && !/Measuring/.test(copiesDone), 'finished copies settles to a value or a stated unknown', copiesDone)

  // ---------- Delete branch (three fresh report branches, each with one commit) ----------
  const plantWithCommit = (id) => {
    const wt = plant(id)
    writeFile(wt, `src/${id}.js`, `export const ${id} = 1\n`)
    git(wt, ['add', '-A'])
    git(wt, ['commit', '-q', '-m', `Implementer: ${id}`])
  }
  plantWithCommit('delF')
  plantWithCommit('delG')
  plantWithCommit('delM')
  await page.getByRole('button', { name: 'Refresh', exact: true }).first().click()
  await page.waitForFunction(() => document.querySelectorAll('.maint-row').length === 3, null, { timeout: t(15_000) }).catch(() => {})
  check((await rows.count()) === 3, 'delete-branch fixture: three report branches listed', String(await rows.count()))
  const rowF = rows.filter({ hasText: 'worktree-agent-delF' })
  const rowG = rows.filter({ hasText: 'worktree-agent-delG' })
  const rowM = rows.filter({ hasText: 'worktree-agent-delM' })
  const opener = (row) => row.locator('[data-testid=delete-branch]')
  const exists = (b) => gitSafe(repo, ['branch', '--list', b]).trim() !== ''
  const dlg = page.locator('dialog[open]')
  const closeDialogs = async () => {
    for (let i = 0; i < 3 && (await dlg.count()) > 0; i++) {
      await page.keyboard.press('Escape')
      await sleep(250)
    }
  }

  // The project's main branch is a protected branch: its row offers no Delete (the checkout's current branch and the default
  // branch are refused the same way; a checked-out branch cannot have a finished copy, so only the main-branch row can be drawn).
  // Leave the pane and come back so the Main branch list is read again (it was read before these branches existed), then pick one.
  await page.getByRole('tab', { name: 'Branches', exact: true }).evaluate((el) => el.parentElement?.querySelector('[role=tab]:not([aria-selected=true])')?.click())
  await sleep(500)
  await page.getByRole('tab', { name: 'Branches', exact: true }).click()
  await page.waitForSelector('.maint-row', { timeout: t(15_000) })
  const mainSelect = page.getByLabel('Main branch', { exact: true })
  await mainSelect.selectOption('worktree-agent-delM')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid=delete-branch]').length === 2, null, { timeout: t(15_000) }).catch(() => {})
  check((await opener(rowM).count()) === 0, 'the main-branch row offers no Delete branch')
  check((await opener(rowF).count()) === 1 && (await opener(rowG).count()) === 1, 'the other report branches offer Delete branch')

  // Dialog: names the exact branch, focus starts on "Keep branch".
  await opener(rowF).click()
  await dlg.waitFor({ timeout: t(10_000) })
  const dlgText = (await dlg.innerText()).replace(/\s+/g, ' ')
  check(/worktree-agent-delF/.test(dlgText) && !/worktree-agent-delG/.test(dlgText), 'the dialog names the exact branch', dlgText)
  const focused = await page.evaluate(() => (document.activeElement?.textContent ?? '').trim())
  check(focused === 'Keep branch', 'focus starts on "Keep branch"', focused)
  await page.keyboard.press('Escape')
  await dlg.waitFor({ state: 'detached', timeout: t(10_000) }).catch(() => {})
  check(exists('worktree-agent-delF'), 'Escape deletes nothing')
  await opener(rowF).click()
  await dlg.waitFor({ timeout: t(10_000) })
  await dlg.getByRole('button', { name: 'Keep branch', exact: true }).click()
  await dlg.waitFor({ state: 'detached', timeout: t(10_000) }).catch(() => {})
  check(exists('worktree-agent-delF'), '"Keep branch" deletes nothing')

  // A held Enter on the opener (auto-repeat) cannot confirm; neither can a double click.
  await opener(rowF).focus()
  await page.keyboard.down('Enter')
  for (let i = 0; i < 6; i++) {
    await sleep(60)
    await page.keyboard.down('Enter')
  }
  await page.keyboard.up('Enter')
  await sleep(600)
  check(exists('worktree-agent-delF') && exists('worktree-agent-delG'), 'a held Enter on the opener deletes nothing')
  await closeDialogs()
  await opener(rowF).dblclick()
  await sleep(600)
  check(exists('worktree-agent-delF') && exists('worktree-agent-delG'), 'a double click on the opener deletes nothing')
  await closeDialogs()
  check((await dlg.count()) === 0, 'the dialogs are closed again')

  // A confirmed delete removes exactly that branch (and its finished copy).
  await opener(rowF).click()
  await dlg.waitFor({ timeout: t(10_000) })
  await dlg.getByRole('button', { name: 'Delete branch', exact: true }).click()
  const deletedNote = await waitNotice(/Deleted worktree-agent-delF/)
  check(/Deleted worktree-agent-delF/.test(deletedNote), 'a confirmed delete reports the branch', deletedNote)
  check(!exists('worktree-agent-delF') && !fs.existsSync(path.join(repo, '.claude', 'worktrees', 'agent-delF')), 'the confirmed branch and its copy are gone')
  check(exists('worktree-agent-delG') && exists('worktree-agent-delM') && fs.existsSync(path.join(repo, '.claude', 'worktrees', 'agent-delG')), 'the other branches and copies are untouched')
  await mainSelect.selectOption('')
  // Tidy the rest through Discard so the uninstall below is not refused for unmerged work.
  for (const id of ['delG', 'delM']) {
    await rows.filter({ hasText: `worktree-agent-${id}` }).getByRole('button', { name: 'Discard' }).click()
    await confirmDialog('Discard branch')
    await waitNotice(new RegExp(`Discarded worktree-agent-${id}`))
  }
  await page.waitForFunction(() => document.querySelectorAll('.maint-row').length === 0, null, { timeout: t(15_000) }).catch(() => {})

  await page.getByRole('button', { name: /Remove OrgAI files from repository/ }).click()
  await confirmDialog('Remove files')
  const removed = await waitNotice(/^Removed /)
  check(/ARCHITECTURE\.md/.test(removed) && /CLAUDE\.md \(OrgAI section\)/.test(removed) && /exclude/.test(removed), 'uninstall removes doc, CLAUDE.md section and exclude line', removed)
  await shot('after')

  // Spending limits at rest and the empty engagement Home (UI overhaul H2, M12; e2e/limits-checks.mjs).
  await limitsChecks({ app, page, shot, name: NAME })
  await engagementEmptyChecks({ app, page, shot, name: 'E2E empty engagement (orgai test)', dir: makeFixtureRepo('maint-eng', { initGit: false }) })
} catch (e) {
  check(false, 'maintenance flow ran without throwing', e.stack ?? String(e))
  await shot('error').catch(() => {})
} finally {
  await cleanup(app, page, NAME)
}

// ---------- Repository on disk ----------
const subjects = gitSafe(repo, ['log', '--format=%s', '-n', '6'])
log('log:\n' + gitSafe(repo, ['log', '--oneline', '--graph', '-n', '8']))
check(/^Merge worktree-agent-cleanA: /m.test(subjects), 'merge commit for the clean branch', subjects)
check(gitSafe(repo, ['ls-files', 'src/version.js']) === 'src/version.js', 'uncommitted leftover was committed and merged')
check(!/worktree-agent-/.test(gitSafe(repo, ['branch', '--list'])), 'no report branches left', gitSafe(repo, ['branch', '--list']))
check(gitSafe(repo, ['worktree', 'list']).split(/\r?\n/).length === 1, 'only the main worktree remains')
check(fs.readFileSync(path.join(repo, 'README.md'), 'utf8').includes('from main'), 'main README kept after the conflict')
check(!fs.existsSync(path.join(repo, '.orgai')), '.orgai removed')
check(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8') === ORIGINAL_CLAUDE_MD, 'CLAUDE.md restored to its original text')
check(!fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8').includes('.claude/worktrees/'), 'exclude line removed')
removeFixture(repo)
finish('e2e/maintenance')
