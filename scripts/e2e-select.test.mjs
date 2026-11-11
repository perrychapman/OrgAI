// The e2e selector (scripts/e2e-select.mjs): the decision is pure, so these tests feed it file lists. Nothing here runs
// git except the sha validation case, and nothing runs an e2e script.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { RULES, SMOKE, changedFilesBetween, globToRegExp, loadChain, parseArgs, parseChain, selectE2e } from './e2e-select.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const all = loadChain()
const sel = (...changedFiles) => selectE2e({ changedFiles, allScripts: all })

test('the chain is parsed from package.json e2e:free, in order', () => {
  assert.deepEqual(parseChain({ scripts: { 'e2e:free': 'node e2e/a.mjs && node e2e/b-c.mjs' } }), ['a', 'b-c'])
  assert.deepEqual(parseChain({}), [])
  assert.ok(all.length > 40)
  assert.equal(all[0], 'layout')
})

test('an unmapped file fails open to the full chain', () => {
  const r = sel('src/renderer/src/lib/someBrandNewThing.ts')
  assert.equal(r.mode, 'full')
  assert.deepEqual(r.scripts, all)
  assert.match(r.reasons[0], /someBrandNewThing/)
  assert.equal(sel('src/renderer/src/components/dashboard/ActivityStrip.tsx', 'weird/unknown.bin').mode, 'full')
})

test('an empty or missing diff means full', () => {
  assert.equal(selectE2e({ changedFiles: [], allScripts: all }).mode, 'full')
  assert.equal(selectE2e({ changedFiles: null, allScripts: all }).mode, 'full')
  assert.equal(selectE2e({ changedFiles: undefined, allScripts: all }).mode, 'full')
})

test('shared and hot paths force full, even next to a narrow change', () => {
  for (const p of [
    'src/shared/types.ts',
    'src/shared/view/cost.ts',
    'src/preload/index.ts',
    'e2e/lib.mjs',
    'e2e/cliLib.mjs',
    'package.json',
    'package-lock.json',
    'electron.vite.config.ts',
    'vite.cli.config.ts',
    'tsconfig.web.json',
    '.github/workflows/ci.yml',
    'scripts/e2e-select.mjs',
    'src/main/runtime/runManager.ts',
    'src/main/runtime/mock.ts',
    'src/main/ipc.ts',
    'src/main/store/runs.ts',
    'src/renderer/src/App.tsx',
    'src/renderer/src/components/ui/Dialog.tsx',
  ]) {
    const r = sel('src/renderer/src/components/knowledge/KnowledgeRow.tsx', p)
    assert.equal(r.mode, 'full', p)
    assert.deepEqual(r.scripts, all, p)
  }
})

test('a narrow renderer change selects its scripts plus the smoke set, in chain order', () => {
  const r = sel('src/renderer/src/components/knowledge/KnowledgeRow.tsx')
  assert.equal(r.mode, 'selected')
  assert.deepEqual(r.scripts, all.filter((s) => ['knowledge', 'knowledge-graph', 'knowledge-run', ...SMOKE].includes(s)))
  assert.equal(r.scripts.length, 6)
})

test('a narrow main change selects its scripts plus the smoke set', () => {
  const r = sel('src/main/repoClone.ts')
  assert.equal(r.mode, 'selected')
  assert.deepEqual(r.scripts, all.filter((s) => ['clone-start', ...SMOKE].includes(s)))
  const cli = sel('src/cli/commands/exec.ts')
  assert.deepEqual(cli.scripts, all.filter((s) => ['cli-exec', ...SMOKE].includes(s)))
})

test('brace globs and first-match order work', () => {
  assert.ok(globToRegExp('src/cli/commands/{org,team}.ts').test('src/cli/commands/team.ts'))
  assert.ok(!globToRegExp('src/cli/commands/{org,team}.ts').test('src/cli/commands/teams.ts'))
  assert.ok(globToRegExp('a/**/b.ts').test('a/b.ts'))
  assert.ok(!globToRegExp('a/*.ts').test('a/x/b.ts'))
  // the specific CliCommandRow rule beats the settings group
  assert.deepEqual(sel('src/renderer/src/components/settings/CliCommandRow.tsx').scripts, all.filter((s) => ['install-row', ...SMOKE].includes(s)))
})

test('a changed e2e script selects itself plus the smoke set', () => {
  const r = sel('e2e/team.mjs')
  assert.equal(r.mode, 'selected')
  assert.deepEqual(r.scripts, all.filter((s) => ['team', ...SMOKE].includes(s)))
  // an e2e file that is not in the chain and has no rule is an unknown helper: full
  assert.equal(sel('e2e/brandNewHelper.mjs').mode, 'full')
  // spend-tokens scripts never run in CI
  assert.deepEqual(sel('e2e/setup.mjs').scripts, [])
})

test('e2e helper parts map to the script that calls them', () => {
  assert.deepEqual(sel('e2e/outputs-revise.part.mjs').scripts.filter((s) => !SMOKE.includes(s)), ['outputs-notes'])
  assert.deepEqual(sel('e2e/pocket-office.mjs').scripts.filter((s) => !SMOKE.includes(s)), ['canvas'])
})

test('docs and unit tests alone select nothing (not even the smoke set)', () => {
  for (const files of [
    ['CLAUDE.md'],
    ['docs/agent-notes/platform-ci.md', 'e2e/README.md'],
    ['src/main/runtime/runManager.test.ts'],
    ['src/renderer/src/lib/foo.test.tsx', 'scripts/pack-local.test.mjs'],
  ]) {
    const r = sel(...files)
    assert.equal(r.mode, 'selected', files.join())
    assert.deepEqual(r.scripts, [], files.join())
  }
})

test('bundled reference docs select self-help, other docs do not', () => {
  assert.deepEqual(sel('docs/design/pocket-office.md').scripts.filter((s) => !SMOKE.includes(s)), ['self-help'])
  assert.deepEqual(sel('README.md').scripts.filter((s) => !SMOKE.includes(s)), ['self-help'])
  assert.deepEqual(sel('docs/agent-notes/cli-host.md').scripts, [])
})

test('docs plus code still gets the smoke set', () => {
  const r = sel('CLAUDE.md', 'src/main/repoClone.ts')
  assert.ok(SMOKE.every((s) => r.scripts.includes(s)))
})

test('a code file whose rule lists no script still runs the smoke set', () => {
  const r = sel('src/main/runtime/codexAppServer.ts')
  assert.equal(r.mode, 'selected')
  assert.deepEqual(r.scripts, all.filter((s) => SMOKE.includes(s)))
})

test('the smoke set is in the chain', () => {
  for (const s of SMOKE) assert.ok(all.includes(s), s)
})

test('every script named in the table is in the chain and on disk', () => {
  for (const rule of RULES) {
    for (const s of rule.scripts) {
      assert.ok(all.includes(s), `${s} (${rule.why}) is not in e2e:free`)
      assert.ok(existsSync(join(ROOT, 'e2e', `${s}.mjs`)), `e2e/${s}.mjs does not exist`)
    }
  }
})

test('every script of the chain is reachable by at least one rule', () => {
  const reachable = new Set([...SMOKE, ...RULES.flatMap((r) => r.scripts)])
  const missing = all.filter((s) => !reachable.has(s))
  assert.deepEqual(missing, [], `no rule selects: ${missing.join(', ')}`)
})

test('every rule is well formed', () => {
  for (const r of RULES) {
    assert.ok(r.match.length > 0 && typeof r.why === 'string' && r.why.length > 0)
    if (r.kind === 'full' || r.kind === 'none') assert.deepEqual(r.scripts, [], r.why)
    else assert.ok(r.kind === undefined, r.why)
  }
})

test('git refs are validated before they reach git', () => {
  assert.equal(changedFilesBetween('--output=x', 'abc1234'), null)
  assert.equal(changedFilesBetween('abc1234; rm -rf /', 'abc1234'), null)
  assert.equal(changedFilesBetween('0'.repeat(40), 'abc1234'), null)
  assert.equal(changedFilesBetween(undefined, undefined), null)
  assert.equal(changedFilesBetween('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef0'), null)
})

test('arguments', () => {
  assert.deepEqual(parseArgs(['--base', 'a', '--head', 'b', '--run']), { base: 'a', head: 'b', full: false, run: true, print: false })
  assert.equal(parseArgs(['--full']).full, true)
  assert.throws(() => parseArgs(['--bogus']))
})
