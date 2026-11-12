// node --test scripts/verify-pack.test.mjs (npm run test:scripts). Pure helpers, plus main() against a fake release
// tree with an injected runner and git; never runs a packaged app.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bareImports, isNodeBuiltin, packageOf, packagedPaths } from './lib/packLayout.mjs'
import { agentBinaries, agentBinaryCheck, bootCheck, certReaderCheck, cliEntriesInAsar, main, parseArgs } from './verify-pack.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')

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

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `orgai-vp-${label}-`))
}

/** A fake release tree for this platform: the app binary, an app.asar file and the desktop's unpacked packages. */
function fakeRelease({ unpacked = ['@anthropic-ai/claude-agent-sdk', '@openai/codex', 'zod'], launcher = false, unpackedCli = false } = {}) {
  const base = tempDir('release')
  const release = path.join(base, 'release')
  const p = packagedPaths(process.platform, process.arch, release)
  fs.mkdirSync(path.dirname(p.appBinary), { recursive: true })
  fs.writeFileSync(p.appBinary, '')
  fs.mkdirSync(p.resourcesDir, { recursive: true })
  fs.writeFileSync(path.join(p.resourcesDir, 'app.asar'), '')
  for (const pkg of unpacked) {
    const dir = path.join(p.resourcesDir, 'app.asar.unpacked', 'node_modules', ...pkg.split('/'))
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkg }))
  }
  if (launcher) {
    fs.mkdirSync(path.dirname(p.launcher), { recursive: true })
    fs.writeFileSync(p.launcher, '#!/bin/sh\n')
  }
  if (unpackedCli) {
    fs.mkdirSync(p.cliBundleDir, { recursive: true })
    fs.writeFileSync(path.join(p.cliBundleDir, 'orgai.mjs'), '')
  }
  return { base, release }
}

async function runMain(fake, list, boot = async () => ({ ok: true, detail: 'fake boot' })) {
  const lines = []
  const code = await main(['--release', fake.release], { root: ROOT, log: (l) => lines.push(l), list, boot, certReader: () => ({ ok: true, detail: 'fake' }), agents: () => ({ ok: true, detail: 'fake' }) })
  fs.rmSync(fake.base, { recursive: true, force: true })
  return { code, out: lines.join('\n') }
}

const CLEAN_ASAR = () => ['/out', '/out/main', '/out/main/index.js', '/out/renderer/index.html', '/package.json']

test('parseArgs', () => {
  assert.deepEqual(parseArgs([]), { release: undefined })
  assert.deepEqual(parseArgs(['--release', 'x']), { release: 'x' })
  assert.deepEqual(parseArgs(['--release=y']), { release: 'y' })
  assert.throws(() => parseArgs(['--release']), /needs a folder/)
  assert.throws(() => parseArgs(['--nope']), /Unknown argument/)
  assert.throws(() => parseArgs(['--skip-host']), /Unknown argument/)
  assert.throws(() => parseArgs(['--npm']), /Unknown argument/)
})

test('cliEntriesInAsar finds out/cli entries with either slash and nothing else', () => {
  assert.deepEqual(cliEntriesInAsar(['/out/cli', '\\out\\cli\\orgai.mjs', '/out/cliche/x', '/out/main/index.js', '/node_modules/out/cli/x']), ['out/cli', 'out/cli/orgai.mjs'])
  assert.deepEqual(cliEntriesInAsar(CLEAN_ASAR()), [])
})

test('main: a plain desktop package passes every check', async () => {
  const r = await runMain(fakeRelease(), CLEAN_ASAR)
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /All checks passed/)
})

test('main: out/cli inside app.asar fails (b)', async () => {
  const r = await runMain(fakeRelease(), () => [...CLEAN_ASAR(), '/out/cli', '/out/cli/orgai.mjs'])
  assert.equal(r.code, 1)
  assert.match(r.out, /fail {2}\(b\) no out\/cli {2}app\.asar holds 2 out\/cli entries/)
})

test('main: an unpacked out/cli fails (b)', async () => {
  const r = await runMain(fakeRelease({ unpackedCli: true }), CLEAN_ASAR)
  assert.equal(r.code, 1)
  assert.match(r.out, /fail {2}\(b\)/)
})

test('main: a bin/orgai launcher fails (c)', async () => {
  const r = await runMain(fakeRelease({ launcher: true }), CLEAN_ASAR)
  assert.equal(r.code, 1)
  assert.match(r.out, /fail {2}\(c\) no orgai launcher/)
})

test('main: a desktop package that is not unpacked fails (d) and names it', async () => {
  const r = await runMain(fakeRelease({ unpacked: ['zod'] }), CLEAN_ASAR)
  assert.equal(r.code, 1)
  assert.match(r.out, /fail {2}\(d\).*@anthropic-ai\/claude-agent-sdk, @openai\/codex/)
})

test('main: an unknown argument exits 2, a missing release exits 2', async () => {
  const lines = []
  assert.equal(await main(['--nope'], { log: (l) => lines.push(l) }), 2)
  assert.equal(await main(['--release', path.join(os.tmpdir(), 'orgai-vp-nothing-here')], { log: (l) => lines.push(l) }), 2)
})

test('main: a packed app that does not boot fails (e) and names why', async () => {
  const r = await runMain(fakeRelease(), CLEAN_ASAR, async () => ({ ok: false, detail: 'no ready daemon.json within 60 s' }))
  assert.equal(r.code, 1)
  assert.match(r.out, /fail {2}\(e\) packed app boots {2}no ready daemon\.json/)
})

/** A stand-in "packed app": a node script that writes run/daemon.json under ORGAI_DATA_DIR and removes it on SIGTERM. */
function fakeApp(dir, { crash = false, stayOnQuit = false } = {}) {
  const file = path.join(dir, 'fake-app.js')
  fs.writeFileSync(
    file,
    `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path')
if (process.env.ORGAI_MOCK !== '1' || process.env.ORGAI_WINDOW_HIDDEN !== '1') process.exit(3)
if (${crash}) process.exit(1)
const run = path.join(process.env.ORGAI_DATA_DIR, 'data', 'run')
fs.mkdirSync(run, { recursive: true })
fs.mkdirSync(path.join(process.env.ORGAI_DATA_DIR, 'logs'), { recursive: true })
fs.writeFileSync(path.join(process.env.ORGAI_DATA_DIR, 'logs', 'main.log'), 'x')
fs.writeFileSync(path.join(run, 'daemon.json'), JSON.stringify({ state: 'ready', hostKind: 'desktop' }))
process.on('SIGTERM', () => { if (${stayOnQuit}) return; fs.rmSync(path.join(run, 'daemon.json')); process.exit(0) })
setInterval(() => {}, 1000)
`,
    { mode: 0o755 }
  )
  return file
}

test('bootCheck: ready, then a clean quit passes', { skip: process.platform === 'win32' && 'needs POSIX signals' }, async () => {
  const dir = tempDir('app')
  try {
    const r = await bootCheck(fakeApp(dir), { bootMs: 10_000, quitMs: 10_000 })
    assert.equal(r.ok, true, r.detail)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('bootCheck: the child gets no vault, CLI, secret or daemon variable', async () => {
  const keep = { ORGAI_VAULT_KEY_FILE: '/real/key', ORGAI_CLI_DATA_DIR: '/x', ORGAI_SECRET_X: '1', ORGAI_DAEMON_Y: '1' }
  const saved = Object.fromEntries(Object.keys(keep).map((k) => [k, process.env[k]]))
  Object.assign(process.env, keep)
  let seen
  try {
    const spawnApp = (_bin, args, opts) => {
      seen = { args, env: opts.env }
      throw new Error('stop')
    }
    await assert.rejects(() => bootCheck('/none', { spawnApp }), /stop/)
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  }
  for (const k of Object.keys(keep)) assert.equal(seen.env[k], undefined, k)
  assert.equal(seen.env.ORGAI_MOCK, '1')
  assert.deepEqual(seen.args, process.platform === 'darwin' ? ['--use-mock-keychain'] : [])
})

test('bootCheck: an app that exits at once, or never quits, fails', { skip: process.platform === 'win32' && 'needs POSIX signals' }, async () => {
  const dir = tempDir('app')
  try {
    const crashed = await bootCheck(fakeApp(dir, { crash: true }), { bootMs: 5_000, quitMs: 2_000 })
    assert.equal(crashed.ok, false)
    assert.match(crashed.detail, /exited/)
    const stuck = await bootCheck(fakeApp(dir, { stayOnQuit: true }), { bootMs: 5_000, quitMs: 1_500 })
    assert.equal(stuck.ok, false)
    assert.match(stuck.detail, /did not quit cleanly/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('main: a failing certificate reader or agent binary fails (f) / (g)', async () => {
  const run = async (deps) => {
    const fake = fakeRelease()
    const lines = []
    const code = await main(['--release', fake.release], { root: ROOT, log: (l) => lines.push(l), list: CLEAN_ASAR, boot: async () => ({ ok: true, detail: 'x' }), ...deps })
    fs.rmSync(fake.base, { recursive: true, force: true })
    return { code, out: lines.join('\n') }
  }
  const ok = () => ({ ok: true, detail: 'fake' })
  const a = await run({ certReader: () => ({ ok: false, detail: 'exit 1' }), agents: ok })
  assert.equal(a.code, 1)
  assert.match(a.out, /fail {2}\(f\) certificate reader starts {2}exit 1/)
  const b = await run({ certReader: ok, agents: () => ({ ok: false, detail: 'no codex binary' }) })
  assert.equal(b.code, 1)
  assert.match(b.out, /fail {2}\(g\) claude and codex start {2}no codex binary/)
})

test('certReaderCheck: runs the binary with ELECTRON_RUN_AS_NODE and reads its answer', () => {
  let seen
  const ok = certReaderCheck('/bin/app', (bin, args, opts) => {
    seen = { bin, env: opts.env }
    return { status: 0, stdout: 'cert-reader-ok function' }
  })
  assert.equal(ok.ok, true)
  assert.equal(seen.env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(certReaderCheck('/bin/app', () => ({ status: 1, stdout: '', stderr: 'boom' })).ok, false)
  assert.equal(certReaderCheck('/bin/app', () => ({ error: new Error('ENOENT') })).ok, false)
})

test('agentBinaries / agentBinaryCheck: find this platform\'s claude and codex and run --version', () => {
  const nm = tempDir('agents')
  try {
    const claudeDir = path.join(nm, '@anthropic-ai', 'claude-agent-sdk-darwin-arm64')
    const codexBin = path.join(nm, '@openai', 'codex-darwin-arm64', 'vendor', 'aarch64-apple-darwin', 'bin')
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.mkdirSync(codexBin, { recursive: true })
    fs.mkdirSync(path.join(nm, '@openai', 'codex'), { recursive: true })
    fs.mkdirSync(path.join(nm, '@anthropic-ai', 'claude-agent-sdk-linux-x64'), { recursive: true })
    fs.writeFileSync(path.join(claudeDir, 'claude'), '')
    fs.writeFileSync(path.join(codexBin, 'codex'), '')
    assert.deepEqual(agentBinaries(nm, 'darwin', 'arm64').map((b) => b.name), ['claude', 'codex'])
    assert.deepEqual(agentBinaries(nm, 'linux', 'x64'), [])
    const run = (bin) => ({ status: 0, stdout: `${path.basename(bin)} 1.2.3\n` })
    assert.deepEqual(agentBinaryCheck(nm, 'darwin', 'arm64', run), { ok: true, detail: 'claude claude 1.2.3, codex codex 1.2.3' })
    assert.equal(agentBinaryCheck(nm, 'darwin', 'arm64', () => ({ status: 2, stdout: '' })).ok, false)
    const missing = agentBinaryCheck(nm, 'linux', 'x64', run)
    assert.equal(missing.ok, false)
    assert.match(missing.detail, /no claude binary.*no codex binary/)
  } finally {
    fs.rmSync(nm, { recursive: true, force: true })
  }
})
