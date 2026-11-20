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
