// SPENDS TOKENS. A work run with two parallel writing reports: checks each runs in an isolated git worktree and the
// harness merges both back into the main checkout. Usage: node e2e/worktree.mjs --yes
import { check, cleanup, createProject, endSession, finish, gitSafe, launch, log, makeFixtureRepo, removeFixture, requireYes, sleep } from './lib.mjs'

requireYes('e2e/worktree', '$0.20-$1.00 (opus orchestrator, sonnet implementers); about 2-5 minutes')

const NAME = 'E2E worktree (orgai test)'
const TASK =
  'Delegate these two tasks to the implementer IN PARALLEL (two Agent calls in the same turn), then wait for both reports: ' +
  '(1) add a GET /health endpoint to src/server.js that responds with {"ok":true}; ' +
  '(2) add a remove(id) method to the store in src/store.js that deletes a note by id and returns true if it existed, plus a node:test case in test/store.test.js. ' +
  'After the harness reports both merges, run npm test in the main checkout and tell me the result and the git log of the last 4 commits. Do not edit code yourself.'

const repo = makeFixtureRepo('worktree')
const { app, page, shot } = await launch({ shotPrefix: 'worktree' })
try {
  await createProject(page, { mode: 'existing', path: repo, name: NAME })
  await page.locator('.topbar .tabs').getByRole('button', { name: 'Live', exact: true }).click()
  await sleep(500)
  await page.locator('.composer textarea').fill(TASK)
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  await page.waitForSelector('.agent-node', { timeout: 120_000 })
  log('work run started')

  const started = Date.now()
  let seenIsolated = false
  let lastShot = 0
  while (Date.now() - started < 12 * 60_000) {
    // Approve permission cards (shell commands under acceptEdits).
    const perm = page.locator('article.decision-card[data-kind="permission"]').first()
    if (await perm.count()) {
      log('permission:', (await perm.locator('.what').innerText().catch(() => '')).slice(0, 100))
      await perm.getByRole('button', { name: 'Allow once' }).click()
      await sleep(800)
      continue
    }
    const badges = await page.locator('.agent-node .worktree').allInnerTexts().catch(() => [])
    if (!seenIsolated && badges.some((b) => /isolated/.test(b))) {
      seenIsolated = true
      log('worktree badges:', badges.join(' | '))
      await shot('isolated')
    }
    const status = await page.locator('.topbar .pill .dot').first().locator('..').innerText().catch(() => '')
    const rootActivity = await page.locator('.agent-node .activity').first().innerText().catch(() => '')
    if (Date.now() - lastShot > 40_000) {
      lastShot = Date.now()
      log('status:', status, '| root:', rootActivity, '| badges:', badges.join(' | '))
      await shot('progress')
    }
    const nodes = await page.locator('.agent-node').count()
    if (/idle/i.test(status) && /Waiting for you/.test(rootActivity) && nodes >= 3 && !badges.some((b) => /isolated|merging/.test(b))) {
      log('orchestrator idle with reports done')
      break
    }
    if (/finished|failed/i.test(status)) {
      log('run ended:', status)
      break
    }
    await sleep(3000)
  }
  await sleep(1500)
  await shot('final')
  const badges = await page.locator('.agent-node .worktree').allInnerTexts().catch(() => [])
  log('final badges:', badges.join(' | '))
  check(seenIsolated, 'reports ran in isolated worktrees')
  check(badges.filter((b) => /merged/.test(b)).length >= 2, 'both reports merged', badges.join(' | '))
  log('final root text:', (await page.locator('.transcript .entry.text').last().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 700))
  await page.locator('.side .tabs').getByRole('button', { name: 'Logs' }).click().catch(() => {})
  log('logs:\n' + (await page.locator('.logs').innerText().catch(() => '')).slice(0, 2500))
  await endSession(page)
} catch (e) {
  check(false, 'worktree flow ran without throwing', e.stack ?? String(e))
  await shot('error').catch(() => {})
} finally {
  await cleanup(app, page, NAME)
}

log('log:\n' + gitSafe(repo, ['log', '--oneline', '--graph', '-n', '8']))
const merges = gitSafe(repo, ['log', '--merges', '--format=%s']).split(/\r?\n/).filter((s) => /^Merge worktree-agent-/.test(s))
check(merges.length >= 2, 'two merge commits from report branches', String(merges.length))
check(!/worktree-agent-/.test(gitSafe(repo, ['branch', '--list'])), 'no report branches left')
check(gitSafe(repo, ['worktree', 'list']).split(/\r?\n/).length === 1, 'only the main worktree remains')
check(/\/health/.test(gitSafe(repo, ['show', 'HEAD:src/server.js'])), 'GET /health merged')
check(/remove/.test(gitSafe(repo, ['show', 'HEAD:src/store.js'])), 'store.remove merged')
check(!/node_modules\//.test(gitSafe(repo, ['ls-files'])), 'node_modules never committed')
check(gitSafe(repo, ['status', '--porcelain']) === '', 'main checkout clean')
removeFixture(repo)
finish('e2e/worktree')
