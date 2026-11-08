// node --test scripts/verify-pack.test.mjs (npm run test:scripts). Pure helpers, plus main() against a fake release
// tree with an injected runner and git; never runs a packaged app.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bareImports, isNodeBuiltin, packageOf, packagedPaths } from './lib/packLayout.mjs'
import {
  checkDoctorReport,
  cleanupDaemon,
  daemonJsonPath,
  execOutcome,
  launchCommand,
  main,
  missingPackages,
  parseArgs,
  verifyEnv,
  versionMatches,
  versionChannelMatches,
  appInstallInfoProblem
} from './verify-pack.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version

test('packagedPaths: darwin arm64 and x64', () => {
  const arm = packagedPaths('darwin', 'arm64', '/r/release')
  assert.deepEqual(arm, {
    unpackedDir: '/r/release/mac-arm64',
    resourcesDir: '/r/release/mac-arm64/OrgAI.app/Contents/Resources',
    launcher: '/r/release/mac-arm64/OrgAI.app/Contents/Resources/bin/orgai',
    cliBundleDir: '/r/release/mac-arm64/OrgAI.app/Contents/Resources/app.asar.unpacked/out/cli',
    appBinary: '/r/release/mac-arm64/OrgAI.app/Contents/MacOS/OrgAI'
  })
  const x64 = packagedPaths('darwin', 'x64', '/r/release/')
  assert.equal(x64.unpackedDir, '/r/release/mac')
  assert.equal(x64.launcher, '/r/release/mac/OrgAI.app/Contents/Resources/bin/orgai')
})

test('packagedPaths: win32 and linux', () => {
  assert.deepEqual(packagedPaths('win32', 'x64', 'C:\\r\\release'), {
    unpackedDir: 'C:\\r\\release\\win-unpacked',
    resourcesDir: 'C:\\r\\release\\win-unpacked\\resources',
    launcher: 'C:\\r\\release\\win-unpacked\\resources\\bin\\orgai.cmd',
    cliBundleDir: 'C:\\r\\release\\win-unpacked\\resources\\app.asar.unpacked\\out\\cli',
    appBinary: 'C:\\r\\release\\win-unpacked\\OrgAI.exe'
  })
  assert.deepEqual(packagedPaths('linux', 'x64', '/r/release'), {
    unpackedDir: '/r/release/linux-unpacked',
    resourcesDir: '/r/release/linux-unpacked/resources',
    launcher: '/r/release/linux-unpacked/resources/bin/orgai',
    cliBundleDir: '/r/release/linux-unpacked/resources/app.asar.unpacked/out/cli',
    appBinary: '/r/release/linux-unpacked/orgai'
  })
})

test('bareImports: static, side-effect, export-from and dynamic imports', () => {
  const src = [
    "import { query } from '@anthropic-ai/claude-agent-sdk'",
    'import z from "zod"',
    "import 'side-effect-pkg'",
    "export * from 'reexported'",
    "export { a as b } from 'named-export'",
    "const ink = await import('ink')",
    'const r = import("react/jsx-runtime")',
    "import x from '@scope/name/deep/sub.js'"
  ].join('\n')
  assert.deepEqual(bareImports(src), ['@anthropic-ai/claude-agent-sdk', '@scope/name', 'named-export', 'ink', 'react', 'reexported', 'side-effect-pkg', 'zod'].sort())
})

test('bareImports: relative, absolute, URL and builtin specifiers are left out', () => {
  const src = [
    "import a from './local.mjs'",
    "import b from '../up.mjs'",
    "import c from '/abs/path.mjs'",
    "import d from 'node:fs'",
    "import e from 'path'",
    "import f from 'fs/promises'",
    "import g from 'node:test'",
    "import h from 'file:///x.mjs'",
    "import i from '#internal'",
    "const j = await import('./chunk-abc.mjs')"
  ].join('\n')
  assert.deepEqual(bareImports(src), [])
})

test('bareImports: comments, strings, templates and property access are not imports', () => {
  const src = [
    "// import a from 'commented-line'",
    "/* import b from 'commented-block' */",
    'const s = "import c from \'in-a-string\'"',
    "const t = `import d from 'in-a-template' ${x} more`",
    "const u = 'https://example.com/' // a URL is not a comment start inside a string",
    "obj.import('not-syntax')",
    "Array.from('abc')",
    "const re = /import e from 'in-a-regex'/g",
    "const url = 'a//b'; import real from 'real-pkg'",
    "const n = `${await import('in-substitution')}`"
  ].join('\n')
  assert.deepEqual(bareImports(src), ['in-substitution', 'real-pkg'])
})

test('bareImports: minified forms without spaces', () => {
  assert.deepEqual(bareImports('import{a as b}from"ink";import*as c from"react";export{d}from"zod";'), ['ink', 'react', 'zod'])
})

test('packageOf and isNodeBuiltin', () => {
  assert.equal(packageOf('@a/b/c'), '@a/b')
  assert.equal(packageOf('@a'), undefined)
  assert.equal(packageOf('pkg/sub'), 'pkg')
  assert.equal(packageOf('C:\\x.mjs'), undefined)
  for (const b of ['fs', 'node:fs', 'fs/promises', 'node:test', 'child_process', 'node:sqlite']) assert.equal(isNodeBuiltin(b), true, b)
  for (const n of ['zod', 'ink', 'test', '', '@scope/fs']) assert.equal(isNodeBuiltin(n), false, n)
})

test('parseArgs', () => {
  assert.deepEqual(parseArgs([]), { release: undefined })
  assert.deepEqual(parseArgs(['--release', 'x']), { release: 'x' })
  assert.deepEqual(parseArgs(['--release=y']), { release: 'y' })
  assert.throws(() => parseArgs(['--release']), /needs a folder/)
  assert.throws(() => parseArgs(['--nope']), /Unknown argument/)
  // the host / npm steps left with the daemon (cli-standalone-default.md 5.2)
  assert.throws(() => parseArgs(['--skip-host']), /Unknown argument/)
  assert.throws(() => parseArgs(['--npm']), /Unknown argument/)
})

test('verifyEnv drops run-as-node, secrets and app overrides, and sets the temp data dir and mock mode', () => {
  const env = verifyEnv(
    { HOME: '/h', PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', ORGAI_SECRET_X: 's', ORGAI_ELECTRON_PATH: '/e', ORGAI_APP_ROOT: '/a', ORGAI_DATA_DIR: '/real', ORGAI_CLI_DATA_DIR: '/real-cli' },
    '/tmp/d'
  )
  assert.deepEqual(env, { HOME: '/h', PATH: '/bin', ORGAI_CLI_DATA_DIR: '/tmp/d', ORGAI_MOCK: '1', NO_COLOR: '1', ORGAI_CLI_VAULT_NO_OS_KEYSTORE: '1' })
})

test('launchCommand: POSIX runs the script, win32 goes through cmd.exe with fixed quoted arguments', () => {
  assert.deepEqual(launchCommand('darwin', '/r/bin/orgai', ['--version']), { command: '/r/bin/orgai', args: ['--version'], windowsVerbatimArguments: false })
  const w = launchCommand('win32', 'C:\\a b\\orgai.cmd', ['exec', '[mock:exec-plan] do it'], { ComSpec: 'C:\\Windows\\system32\\cmd.exe' })
  assert.equal(w.command, 'C:\\Windows\\system32\\cmd.exe')
  assert.deepEqual(w.args, ['/d', '/s', '/c', '""C:\\a b\\orgai.cmd" "exec" "[mock:exec-plan] do it""'])
  assert.equal(w.windowsVerbatimArguments, true)
  assert.throws(() => launchCommand('win32', 'C:\\x\\orgai.cmd', ['a"b']), /Refusing/)
  assert.throws(() => launchCommand('win32', 'C:\\x\\orgai.cmd', ['%PATH%']), /Refusing/)
})

test('versionMatches', () => {
  assert.equal(versionMatches('0.1.6-dev1\n', '0.1.6-dev1'), true)
  assert.equal(versionMatches('orgai 0.1.6-dev1', '0.1.6-dev1'), true)
  assert.equal(versionMatches('0.1.6-dev10', '0.1.6-dev1'), false)
  assert.equal(versionMatches('', '0.1.6'), false)
})

const doctorDoc = (overrides = {}) =>
  JSON.stringify({
    ok: true,
    checks: [
      { id: 'node', status: 'ok', detail: 'Node 24.22.1' },
      { id: 'data-dir', status: 'warn', detail: '/tmp/x (from ORGAI_DATA_DIR): does not exist yet' },
      { id: 'git', status: 'ok', detail: 'git version 2.50' },
      ...(overrides.extra ?? [])
    ].map((c) => (overrides[c.id] ? { ...c, ...overrides[c.id] } : c))
  })

test('checkDoctorReport: node ok and no failure passes (warnings allowed, no launcher check needed)', () => {
  assert.deepEqual(checkDoctorReport(doctorDoc()), { ok: true, problems: [] })
})

test('checkDoctorReport: each problem fails the check', () => {
  assert.equal(checkDoctorReport('not json').ok, false)
  assert.equal(checkDoctorReport('[]').ok, false)
  assert.match(checkDoctorReport(doctorDoc({ node: { status: 'fail', detail: 'Node 20' } })).problems[0], /node is fail/)
  assert.match(checkDoctorReport(doctorDoc({ extra: [{ id: 'run-dir', status: 'fail', detail: 'mode 755' }] })).problems[0], /run-dir failed/)
  assert.match(checkDoctorReport(JSON.stringify({ checks: [{ id: 'git', status: 'ok', detail: 'x' }] })).problems[0], /no node check/)
})

test('execOutcome reads the exec json document', () => {
  assert.deepEqual(execOutcome(JSON.stringify({ runId: 'r', outcome: 'completed', exitCode: 0 })), { outcome: 'completed', exitCode: 0 })
  assert.deepEqual(execOutcome(`Created the project x.\n${JSON.stringify({ outcome: 'blocked', exitCode: 3 })}\n`), { outcome: 'blocked', exitCode: 3 })
  assert.deepEqual(execOutcome(JSON.stringify({ outcome: null, exitCode: 130 })), { outcome: null, exitCode: 130 })
  assert.equal(execOutcome(''), undefined)
  assert.equal(execOutcome('garbage'), undefined)
  assert.equal(execOutcome('[1]'), undefined)
})

test('missingPackages names each missing package and the files importing it', () => {
  const files = [
    { name: 'orgai.mjs', text: "import fs from 'node:fs'" },
    { name: 'inprocHost.mjs', text: "import { q } from '@anthropic-ai/claude-agent-sdk'; import z from 'zod'" },
    { name: 'tui.mjs', text: "import 'ink'" }
  ]
  const have = new Set(['zod'])
  assert.deepEqual(missingPackages(files, (p) => have.has(p)), [
    { file: 'inprocHost.mjs', pkg: '@anthropic-ai/claude-agent-sdk' },
    { file: 'tui.mjs', pkg: 'ink' }
  ])
})

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `orgai-verify-test-${tag}-`))
}

test('cleanupDaemon kills only the pid from the temp data dir daemon.json', async () => {
  const data = tempDir('daemon')
  try {
    const killed = []
    const alive = new Set([4242])
    const deps = {
      kill: (pid, sig) => {
        killed.push([pid, sig])
        alive.delete(pid)
      },
      isAlive: (pid) => alive.has(pid),
      sleep: async () => {},
      graceMs: 10
    }
    assert.equal(await cleanupDaemon(data, deps), undefined, 'no daemon.json: nothing killed')
    fs.mkdirSync(path.dirname(daemonJsonPath(data)), { recursive: true })
    assert.equal(daemonJsonPath(data), path.join(data, 'data', 'run', 'daemon.json'))
    fs.writeFileSync(daemonJsonPath(data), JSON.stringify({ pid: 4242, hostInstanceId: 'abc' }))
    assert.equal(await cleanupDaemon(data, deps), 4242)
    assert.deepEqual(killed, [[4242, 'SIGTERM']])
    killed.length = 0
    assert.equal(await cleanupDaemon(data, deps), undefined, 'a dead pid is left alone')
    for (const pid of [process.pid, 0, -1, 'x', 1.5]) {
      fs.writeFileSync(daemonJsonPath(data), JSON.stringify({ pid }))
      alive.add(pid)
      assert.equal(await cleanupDaemon(data, deps), undefined, `pid ${pid} is never signalled`)
    }
    fs.writeFileSync(daemonJsonPath(data), 'not json')
    assert.equal(await cleanupDaemon(data, deps), undefined)
    assert.deepEqual(killed, [])
  } finally {
    fs.rmSync(data, { recursive: true, force: true })
  }
})

test('cleanupDaemon escalates to SIGKILL when the host ignores SIGTERM', async () => {
  const data = tempDir('stubborn')
  try {
    fs.mkdirSync(path.dirname(daemonJsonPath(data)), { recursive: true })
    fs.writeFileSync(daemonJsonPath(data), JSON.stringify({ pid: 777 }))
    const killed = []
    const pid = await cleanupDaemon(data, { kill: (p, s) => killed.push([p, s]), isAlive: () => true, sleep: async () => {}, graceMs: 0 })
    assert.equal(pid, 777)
    assert.deepEqual(killed, [
      [777, 'SIGTERM'],
      [777, 'SIGKILL']
    ])
  } finally {
    fs.rmSync(data, { recursive: true, force: true })
  }
})

/** A fake release tree laid out for this platform; `unpacked` lists the packages under app.asar.unpacked/node_modules. */
function fakeRelease(unpacked) {
  const base = tempDir('release')
  const release = path.join(base, 'release')
  const p = packagedPaths(process.platform, process.arch, release)
  fs.mkdirSync(path.dirname(p.launcher), { recursive: true })
  fs.writeFileSync(p.launcher, '#!/bin/sh\nexit 0\n')
  fs.chmodSync(p.launcher, 0o755)
  fs.mkdirSync(path.dirname(p.appBinary), { recursive: true })
  fs.writeFileSync(p.appBinary, '')
  fs.mkdirSync(p.cliBundleDir, { recursive: true })
  fs.writeFileSync(path.join(p.cliBundleDir, 'orgai.mjs'), "import fs from 'node:fs'\nconst h = () => import('./inprocHost.mjs')\n")
  fs.writeFileSync(path.join(p.cliBundleDir, 'inprocHost.mjs'), "import { query } from '@anthropic-ai/claude-agent-sdk'\nimport { z } from 'zod'\n")
  fs.writeFileSync(path.join(p.cliBundleDir, 'tui.mjs'), "import path from 'node:path'\n")
  fs.writeFileSync(path.join(p.cliBundleDir, 'install.json'), JSON.stringify({ channel: 'app', version: VERSION, commit: '0123456789ab' }))
  for (const pkg of unpacked) {
    const dir = path.join(p.resourcesDir, 'app.asar.unpacked', 'node_modules', ...pkg.split('/'))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkg }))
  }
  return { base, release, paths: p }
}

/**
 * Does this command carry the word? On Windows the launcher runs through cmd.exe, so the args are one quoted string
 * (`/d /s /c ""...orgai.cmd" "exec" ..."`), not one element per argument; match by substring in any element.
 */
const hasArg = (cmd, word) => cmd.args.some((x) => x.includes(word))

/** The orgai words of a call: on Windows `cmd.exe /d /s /c ""<shim>" "word" ..."` is read back into its words, else the args. */
function wordsOf(cmd) {
  const a = cmd.args
  if (a[0] !== '/d' || a[1] !== '/s' || a[2] !== '/c' || typeof a[3] !== 'string') return a
  let line = a[3]
  if (line.length > 1 && line.startsWith('"') && line.endsWith('"')) line = line.slice(1, -1)
  return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2])
}

/** Canned answers per command; records each call. */
function fakeRunner(calls, overrides = {}) {
  return async (cmd) => {
    calls.push(cmd)
    const a = wordsOf(cmd)
    if (a.includes('--version')) return overrides.version ?? { code: 0, stdout: `${VERSION} channel app commit 0123456789ab\n`, stderr: '' }
    if (a.includes('doctor')) return { code: 0, stdout: overrides.doctor ?? doctorDoc(), stderr: '' }
    if (a.includes('exec')) return overrides.exec ?? { code: 0, stdout: JSON.stringify({ outcome: 'completed', exitCode: 0 }), stderr: '' }
    return { code: 9, stdout: '', stderr: 'unexpected command' }
  }
}

async function runMain(fake, args, overrides) {
  const calls = []
  const gitCalls = []
  const lines = []
  const tmp = tempDir('tmp')
  try {
    const code = await main(['--release', fake.release, ...args], {
      root: ROOT,
      run: fakeRunner(calls, overrides),
      git: (cwd, a) => gitCalls.push({ cwd, a }),
      log: (l) => lines.push(l),
      tmpDir: tmp,
      env: { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1', ORGAI_SECRET_TOKEN: 'shh' },
      cleanup: { isAlive: () => false }
    })
    const leftovers = fs.readdirSync(tmp)
    return { code, calls, gitCalls, lines, out: lines.join('\n'), leftovers }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

test('main: a complete fake release passes every check and cleans its temp dirs', async () => {
  const fake = fakeRelease(['@anthropic-ai/claude-agent-sdk', 'zod'])
  try {
    const r = await runMain(fake, [])
    assert.equal(r.code, 0, r.out)
    for (const id of ['(a)', '(b)', '(c)', '(d)', '(e) exec']) assert.match(r.out, new RegExp(`ok +${id.replace(/[()]/g, '\\$&')}`), id)
    assert.match(r.out, /All checks passed/)
    assert.deepEqual(r.leftovers, [], 'temp dirs removed')
    assert.equal(r.calls.length, 3)
    for (const c of r.calls) {
      assert.equal(c.env.ORGAI_MOCK, '1')
      assert.equal(c.env.NO_COLOR, '1')
      assert.equal(c.env.ELECTRON_RUN_AS_NODE, undefined)
      assert.equal(c.env.ORGAI_SECRET_TOKEN, undefined)
      assert.ok(c.env.ORGAI_CLI_DATA_DIR.includes('orgai-verify-data-'))
      assert.equal(c.timeoutMs, 90_000)
    }
    const exec = r.calls.find((c) => hasArg(c, 'exec'))
    assert.ok(hasArg(exec, '--create-project') && hasArg(exec, '[mock:exec-plan]'))
    for (const c of r.calls) for (const gone of ['--host', 'daemon']) assert.ok(!hasArg(c, gone), `no ${gone}`)
    assert.ok(r.gitCalls.some((g) => g.a[0] === 'commit') && r.gitCalls.every((g) => g.cwd === exec.cwd))
  } finally {
    fs.rmSync(fake.base, { recursive: true, force: true })
  }
})

test('main: a package that is not unpacked fails check (b) and names it', async () => {
  const fake = fakeRelease(['zod'])
  try {
    const r = await runMain(fake, [])
    assert.equal(r.code, 1)
    assert.match(r.out, /fail +\(b\) unpacked packages {2}not unpacked from app\.asar: @anthropic-ai\/claude-agent-sdk \(imported by inprocHost\.mjs\)/)
    assert.match(r.out, /1 check\(s\) failed/)
  } finally {
    fs.rmSync(fake.base, { recursive: true, force: true })
  }
})

test('main: a wrong outcome, a failing node check in doctor and a missing launcher each fail', async () => {
  const fake = fakeRelease(['@anthropic-ai/claude-agent-sdk', 'zod'])
  try {
    const bad = await runMain(fake, [], {
      exec: { code: 3, stdout: JSON.stringify({ outcome: 'blocked', exitCode: 3 }), stderr: '' },
      doctor: doctorDoc({ node: { status: 'fail', detail: 'Node 20' } })
    })
    assert.equal(bad.code, 1)
    assert.match(bad.out, /fail +\(d\) doctor/)
    assert.match(bad.out, /fail +\(e\) exec .*outcome blocked/)

    fs.rmSync(fake.paths.launcher)
    const gone = await runMain(fake, [])
    assert.equal(gone.code, 1)
    assert.match(gone.out, /fail +\(a\) files {2}launcher missing/)
    assert.match(gone.out, /fail +\(c\) --version {2}skipped/)
    assert.equal(gone.calls.length, 0)
  } finally {
    fs.rmSync(fake.base, { recursive: true, force: true })
  }
})

test('versionChannelMatches and appInstallInfoProblem', () => {
  assert.equal(versionChannelMatches('0.1.7 channel app commit abc\n', '0.1.7'), true)
  assert.equal(versionChannelMatches('0.1.7 channel dev', '0.1.7'), false)
  assert.equal(versionChannelMatches('0.1.7 channel application', '0.1.7'), false)
  assert.equal(versionChannelMatches('0.1.6 channel app', '0.1.7'), false)
  const dir = tempDir('info')
  try {
    assert.match(appInstallInfoProblem(dir, '0.1.7'), /install\.json missing/)
    fs.writeFileSync(path.join(dir, 'install.json'), '{nope')
    assert.match(appInstallInfoProblem(dir, '0.1.7'), /not valid JSON/)
    fs.writeFileSync(path.join(dir, 'install.json'), JSON.stringify({ channel: 'npm', version: '0.1.7' }))
    assert.match(appInstallInfoProblem(dir, '0.1.7'), /channel "npm", expected "app"/)
    fs.writeFileSync(path.join(dir, 'install.json'), JSON.stringify({ channel: 'app', version: '0.1.6' }))
    assert.match(appInstallInfoProblem(dir, '0.1.7'), /version "0\.1\.6", expected 0\.1\.7/)
    fs.writeFileSync(path.join(dir, 'install.json'), JSON.stringify({ channel: 'app', version: '0.1.7' }))
    assert.equal(appInstallInfoProblem(dir, '0.1.7'), undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('main: a pack without install.json fails (a), and a --version without channel app fails (c)', async () => {
  const fake = fakeRelease(['@anthropic-ai/claude-agent-sdk', 'zod'])
  try {
    fs.rmSync(path.join(fake.paths.cliBundleDir, 'install.json'))
    const r = await runMain(fake, [], { version: { code: 0, stdout: `${VERSION} channel dev\n`, stderr: '' } })
    assert.equal(r.code, 1)
    assert.match(r.out, /fail +\(a\) files {2}out\/cli\/install\.json missing/)
    assert.match(r.out, /fail +\(c\) --version {2}expected .* channel app/)
  } finally {
    fs.rmSync(fake.base, { recursive: true, force: true })
  }
})

test('main: an unknown argument exits 2', async () => {
  const lines = []
  assert.equal(await main(['--bogus'], { log: (l) => lines.push(l) }), 2)
  assert.match(lines[0], /Unknown argument/)
})

