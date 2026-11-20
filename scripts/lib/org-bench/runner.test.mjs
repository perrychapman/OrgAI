// Tests of the benchmark runner's argument handling and of the token-free CLI paths (node:test; no model, no network).
// Run: node --test scripts/lib/org-bench/runner.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { DEFAULTS, parseArgs, selectScenarios } from '../../bench-org-chart.mjs'
import { cleanupDir, initGitRepo, writeFixture } from './load.mjs'
import { renderReport } from './report.mjs'
import { RETRO_SCENARIOS, recordPaths } from './scenarios.mjs'
import { makeHandlers, makeInput, newState } from './session.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const runner = join(here, '..', '..', 'bench-org-chart.mjs')
const sample = join(here, 'fixtures', 'sample-results.json')

test('defaults: no model, repeat 1, max 5 dollars, every scenario of both families', () => {
  const o = parseArgs([])
  assert.equal(o.model, undefined)
  assert.equal(o.repeat, DEFAULTS.repeat)
  assert.equal(o.maxUsd, 5)
  assert.equal(o.family, 'all')
  assert.equal(selectScenarios(o).length, 15)
})

test('flags: model, repeat, repeatable scenario, family, label, out, max-usd', () => {
  const o = parseArgs(['--model', 'm1', '--repeat', '3', '--scenario', 'c1', '--scenario', 'r2', '--label', 'baseline', '--out', 'x', '--max-usd', '1.5'])
  assert.deepEqual([o.model, o.repeat, o.scenarios, o.label, o.out, o.maxUsd], ['m1', 3, ['c1', 'r2'], 'baseline', 'x', 1.5])
  assert.deepEqual(selectScenarios(o).map((s) => s.id), ['c1', 'r2'])
  assert.deepEqual(selectScenarios(parseArgs(['--family', 'retro'])).map((s) => s.id), ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'])
  assert.equal(selectScenarios(parseArgs(['--family', 'recommend'])).length, 9)
  assert.deepEqual(parseArgs(['--compare', 'a.json', 'b.json']).compare, ['a.json', 'b.json'])
})

test('bad input is refused', () => {
  for (const argv of [['--nope'], ['--repeat', '0'], ['--repeat', 'x'], ['--max-usd', '-1'], ['--scenario', 'zz'], ['--family', 'all-of-them'], ['--model'], ['--model', '--repeat'], ['--compare', 'a.json']]) {
    assert.throws(() => parseArgs(argv), undefined, argv.join(' '))
  }
})

test('--score re-scores a saved file and writes results.json and report.md, token-free', () => {
  const out = mkdtempSync(join(tmpdir(), 'orgai-bench-test-'))
  try {
    const r = spawnSync(process.execPath, [runner, '--score', sample, '--out', out], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /recommend: mean/)
    assert.match(r.stdout, /retro: mean/)
    assert.ok(existsSync(join(out, 'report.md')))
    const saved = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8'))
    assert.equal(saved.sessions.length, 9)
    assert.ok(saved.sessions.filter((s) => s.score).length === 8)
    assert.ok(saved.summary.weakestChecks.length > 0)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('--compare prints deltas for both families', () => {
  const r = spawnSync(process.execPath, [runner, '--compare', sample, sample], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /# Compare/)
  assert.match(r.stdout, /Recommendation: mean/)
  assert.match(r.stdout, /Self-healing \(retro\)/)
})

test('an unknown flag exits 2 with a message and a live run needs --model (no flags is only a plan)', () => {
  const bad = spawnSync(process.execPath, [runner, '--bogus'], { encoding: 'utf8' })
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /unknown argument/)
})

test('retro fixtures hold every path their record names, plus the architecture document; git scenarios become a one-commit repository', () => {
  for (const s of RETRO_SCENARIOS) {
    const dir = mkdtempSync(join(tmpdir(), 'orgai-bench-fixture-'))
    try {
      writeFixture(dir, s.files)
      const missing = recordPaths(s).filter((p) => !existsSync(join(dir, ...p.split('/'))))
      assert.deepEqual(missing, [], `${s.id} record names paths the folder lacks`)
      assert.ok(recordPaths(s).length > 0, `${s.id} names at least one path`)
      assert.ok(existsSync(join(dir, '.orgai', 'ARCHITECTURE.md')), `${s.id} architecture document`)
      assert.equal(s.git, true, `${s.id} mentions merges, so it is a git repository`)
      const g = initGitRepo(dir)
      if (!g.ok) continue // git unavailable: recorded as a note, the session still runs
      const n = spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: dir, encoding: 'utf8' })
      assert.equal(n.stdout.trim(), '1', `${s.id} one commit`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('cleanupDir never throws: it retries, then returns a note; a later success returns null', () => {
  let calls = 0
  const sleeps = []
  const note = cleanupDir('/x/y', { remove: () => { calls += 1; throw new Error('EBUSY: resource busy or locked') }, tries: 3, delayMs: 5, sleep: (ms) => sleeps.push(ms) })
  assert.equal(calls, 3)
  assert.deepEqual(sleeps, [5, 5])
  assert.match(note, /EBUSY/)
  assert.match(note, /left in place/)
  let n = 0
  assert.equal(cleanupDir('/x/y', { remove: () => { if (++n < 2) throw new Error('EBUSY') }, tries: 3, sleep: () => {} }), null)
})

test('a rejected proposal is recorded per session and listed in report.md', () => {
  const state = newState()
  const built = { project: { roles: [] }, probe: { proposals: [] }, tools: [{ name: 'propose_org_chart', call: async () => 'REVISE. Role x has an unknown manager.' }] }
  const h = makeHandlers(built, { family: 'recommend' }, state)
  return h.get('propose_org_chart')({}).then(() => {
    assert.equal(state.rejections.length, 1)
    assert.match(state.rejections[0], /^propose_org_chart: REVISE/)
    const md = renderReport({ sessions: [{ family: 'recommend', scenarioId: 'c1', repeat: 1, status: 'noChart', rejections: state.rejections, cleanupNote: 'left in place' }] },
      { scorerVersion: 1, sessions: 1, scored: 0, skipped: 1, costUsd: 0, families: {}, weakestChecks: [] })
    assert.match(md, /rejected: propose_org_chart: REVISE/)
    assert.match(md, /note: left in place/)
  })
})

test('the streaming input yields the first message, then pushed ones, and ends when closed', async () => {
  const input = makeInput('first')
  const it = input.iterable[Symbol.asyncIterator]()
  assert.equal((await it.next()).value.message.content, 'first')
  const next = it.next()
  input.push('second')
  assert.equal((await next).value.message.content, 'second')
  const end = it.next()
  input.close()
  assert.equal((await end).done, true)
})

test('stub handlers: ask_user and unknown tools are counted, and everything after the capture is refused', async () => {
  const names = ['propose_architecture', 'propose_org_chart', 'ask_user', 'complete_setup', 'propose_settings']
  const built = { project: { roles: [] }, probe: { proposals: [] }, tools: names.map((name) => ({ name, call: async () => 'APPROVED. ok' })) }
  const state = newState()
  const h = makeHandlers(built, { family: 'recommend' }, state)
  assert.equal(await h.get('ask_user')({}), 'No preference, use your judgment.')
  assert.match(await h.get('propose_settings')({}), /not available in this benchmark/)
  assert.match(await h.get('complete_setup')({}), /not available in this benchmark/) // a valid ending only in the retro family
  assert.deepEqual([state.askUserCalls, state.otherToolCalls, state.otherTools.propose_settings, state.otherTools.complete_setup, state.done], [1, 2, 1, 1, null])
  state.done = 'chart'
  assert.match(await h.get('ask_user')({}), /Stop now/)
})
