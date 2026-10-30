// Token-free. Plants two leftover report worktrees in a fixture repo (one clean, one that conflicts with main) plus
// the files OrgAI's setup writes, then drives the Maintenance panel: merge the clean branch, see the conflict reported
// and the branch kept, see "Remove OrgAI files" refuse while work is pending, discard the branch, remove the files,
// and delete the project. Finally checks the repository on disk.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { check, cleanup, createProject, finish, git, gitSafe, launch, log, makeFixtureRepo, projectTab, removeFixture, sleep, writeFile } from './lib.mjs'

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
  const until = Date.now() + ms
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
  await dlg.waitFor({ timeout: 10_000 })
  await dlg.getByRole('button', { name: button, exact: true }).click()
  await dlg.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {})
}

try {
  const project = await createProject(page, { mode: 'existing', path: repo, name: NAME })
  check(!!project, 'project created')
  await projectTab(page, 'Settings').click()
  await page.getByRole('tab', { name: 'Maintenance', exact: true }).click()
  await page.waitForSelector('.maint-row', { timeout: 20_000 })
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
  await page.waitForFunction(() => document.querySelectorAll('.maint-row').length === 1, null, { timeout: 15_000 }).catch(() => {})
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
  await page.waitForFunction(() => document.querySelectorAll('.maint-row').length === 0, null, { timeout: 15_000 }).catch(() => {})
  check((await rows.count()) === 0, 'no pending branches left')

  await page.getByRole('button', { name: /Remove OrgAI files from repository/ }).click()
  await confirmDialog('Remove files')
  const removed = await waitNotice(/^Removed /)
  check(/ARCHITECTURE\.md/.test(removed) && /CLAUDE\.md \(OrgAI section\)/.test(removed) && /exclude/.test(removed), 'uninstall removes doc, CLAUDE.md section and exclude line', removed)
  await shot('after')
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
