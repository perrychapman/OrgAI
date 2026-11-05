// node --test scripts/pack-local.test.mjs (npm run test:scripts). Pure parts, plus main() with a fake exec and a
// fake repo in a temp dir; never runs the real pack.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { formatBuildInfo, unpackedLayout, assertInside, plan, buildSteps, childEnv, main } from './pack-local.mjs'

test('formatBuildInfo writes version, commit and ISO time', () => {
  const s = formatBuildInfo({ version: '0.1.6-dev1', commit: 'abc1234', builtAt: new Date('2026-11-03T10:00:00Z') })
  assert.equal(s, 'version: 0.1.6-dev1\ncommit: abc1234\nbuilt: 2026-11-03T10:00:00.000Z\n')
})

test('formatBuildInfo fills unknowns and adds a note', () => {
  const s = formatBuildInfo({ version: '', commit: undefined, builtAt: '2026-11-03T10:00:00.000Z', note: 'x' })
  assert.equal(s, 'version: unknown\ncommit: unknown\nbuilt: 2026-11-03T10:00:00.000Z\nnote: x\n')
})

test('unpackedLayout per platform', () => {
  assert.deepEqual(unpackedLayout('win32', 'x64'), { dir: 'win-unpacked', marker: 'OrgAI.exe' })
  assert.deepEqual(unpackedLayout('darwin', 'arm64'), { dir: 'mac-arm64', marker: 'OrgAI.app' })
  assert.deepEqual(unpackedLayout('darwin', 'x64'), { dir: 'mac', marker: 'OrgAI.app' })
})

test('assertInside refuses the folder itself and anything outside', () => {
  const rel = path.resolve('/r/release')
  assert.doesNotThrow(() => assertInside(rel, path.join(rel, 'previous')))
  assert.throws(() => assertInside(rel, rel))
  assert.throws(() => assertInside(rel, path.resolve('/r/release-v3')))
  assert.throws(() => assertInside(rel, path.join(rel, '..', 'out')))
})

test('plan keeps every path under release/', () => {
  const root = path.resolve('/repo')
  const p = plan(root, 'win32', 'x64')
  assert.equal(p.current, path.join(root, 'release', 'win-unpacked'))
  assert.equal(p.marker, path.join(root, 'release', 'win-unpacked', 'OrgAI.exe'))
  assert.equal(p.previousDir, path.join(root, 'release', 'previous', 'win-unpacked'))
  assert.equal(p.previousTxt, path.join(root, 'release', 'previous', 'BUILD.txt'))
  assert.equal(p.buildTxt, path.join(root, 'release', 'BUILD.txt'))
  for (const k of ['current', 'previous', 'previousDir', 'previousTxt', 'buildTxt']) assertInside(p.release, p[k])
})

test('buildSteps: the CLI vite build runs after electron-vite and before electron-builder', () => {
  const steps = buildSteps()
  assert.deepEqual(
    steps.map(([pkg]) => pkg),
    ['electron-vite', 'vite', 'electron-builder']
  )
  assert.deepEqual(steps[1][2], ['build', '-c', 'vite.cli.config.ts'])
  assert.deepEqual(steps[2][2], ['--dir', '--publish', 'never'])
})

test('childEnv: darwin gets CSC_IDENTITY_AUTO_DISCOVERY=false unless the caller set it', () => {
  const mac = childEnv('darwin', { PATH: '/bin' })
  assert.equal(mac.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false')
  assert.equal(mac.env.PATH, '/bin')
  assert.match(mac.note, /CSC_IDENTITY_AUTO_DISCOVERY=false/)
  const kept = childEnv('darwin', { CSC_IDENTITY_AUTO_DISCOVERY: 'true' })
  assert.equal(kept.env.CSC_IDENTITY_AUTO_DISCOVERY, 'true')
  assert.match(kept.note, /set by the caller/)
  const win = childEnv('win32', { PATH: 'C:\\x' })
  assert.equal(win.env.CSC_IDENTITY_AUTO_DISCOVERY, undefined)
  assert.equal(win.note, undefined)
  const src = { A: '1' }
  childEnv('darwin', src)
  assert.deepEqual(src, { A: '1' }, 'the caller env is not changed')
})

function fakeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgai-pack-test-'))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'orgai', version: '9.9.9' }))
  return root
}

test('main --dry-run lists the CLI build step and the signing env choice on darwin', () => {
  const root = fakeRoot()
  try {
    const lines = []
    main(['--dry-run'], root, (l) => lines.push(l), { platform: 'darwin', env: {} })
    const out = lines.join('\n')
    assert.match(out, /Would set for every step: CSC_IDENTITY_AUTO_DISCOVERY=false/)
    const ev = out.indexOf('electron-vite')
    const cli = out.indexOf('build -c vite.cli.config.ts')
    const eb = out.indexOf('--dir --publish never')
    assert.ok(ev >= 0 && cli > ev && eb > cli, out)
    assert.match(out, /npm run pack:verify/)
    assert.equal(fs.existsSync(path.join(root, 'release')), false, 'a dry run writes nothing')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('main --dry-run on win32 sets no signing env', () => {
  const root = fakeRoot()
  try {
    const lines = []
    main(['--dry-run'], root, (l) => lines.push(l), { platform: 'win32', env: {} })
    assert.doesNotMatch(lines.join('\n'), /CSC_IDENTITY_AUTO_DISCOVERY/)
    assert.match(lines.join('\n'), /vite\.cli\.config\.ts/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('main passes the darwin child env to every build step, in order', () => {
  const root = fakeRoot()
  try {
    for (const [pkg, bin] of [
      ['electron-vite', 'bin/ev.js'],
      ['vite', 'bin/vite.js'],
      ['electron-builder', 'cli.js']
    ]) {
      const dir = path.join(root, 'node_modules', pkg)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkg, bin: { [pkg]: bin } }))
    }
    const calls = []
    const exec = (cmd, args, opts) => {
      calls.push({ cmd, args, env: opts.env })
      // The last step "builds" the app so the marker check passes.
      if (args.includes('--dir')) fs.mkdirSync(path.join(root, 'release', 'mac-arm64', 'OrgAI.app'), { recursive: true })
    }
    const lines = []
    main([], root, (l) => lines.push(l), { platform: 'darwin', env: { HOME: '/h' }, exec })
    assert.equal(calls.length, 3)
    assert.ok(calls[0].args[0].endsWith(path.join('electron-vite', 'bin', 'ev.js')))
    assert.ok(calls[1].args[0].endsWith(path.join('vite', 'bin', 'vite.js')))
    assert.deepEqual(calls[1].args.slice(1), ['build', '-c', 'vite.cli.config.ts'])
    for (const c of calls) {
      assert.equal(c.cmd, process.execPath)
      assert.equal(c.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false')
      assert.equal(c.env.HOME, '/h')
    }
    assert.ok(fs.existsSync(path.join(root, 'release', 'BUILD.txt')))
    assert.equal(lines.at(-1), 'Check it with npm run pack:verify')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
