// node --test scripts/pack-local.test.mjs (npm run test:scripts). Pure parts, plus main() with a fake exec and a
// fake repo in a temp dir; never runs the real pack.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CLEANUP_SIGNALS, withInstallInfoCleanup, writeInstallInfo } from './write-install-info.mjs'
import { formatBuildInfo, unpackedLayout, assertInside, plan, buildSteps, childEnv, main } from './pack-local.mjs'

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url))

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

test('buildSteps: electron-vite then electron-builder; the app ships no CLI bundle, so no CLI build', () => {
  const steps = buildSteps()
  assert.deepEqual(
    steps.map(([pkg]) => pkg),
    ['electron-vite', 'electron-builder']
  )
  assert.deepEqual(steps[1][2], ['--dir', '--publish', 'never'])
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

test('main --dry-run lists the build steps (no CLI build, no install.json) and the signing env choice on darwin', () => {
  const root = fakeRoot()
  try {
    const lines = []
    main(['--dry-run'], root, (l) => lines.push(l), { platform: 'darwin', env: {} })
    const out = lines.join('\n')
    assert.match(out, /Would set for every step: CSC_IDENTITY_AUTO_DISCOVERY=false/)
    const ev = out.indexOf('electron-vite')
    const eb = out.indexOf('--dir --publish never')
    assert.ok(ev >= 0 && eb > ev, out)
    assert.doesNotMatch(out, /vite\.cli\.config|install\.json/)
    assert.match(out, /npm run pack:verify/)
    assert.equal(fs.existsSync(path.join(root, 'release')), false, 'a dry run writes nothing')
    assert.equal(fs.existsSync(path.join(root, 'out')), false, 'a dry run writes nothing in out/')
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
    assert.doesNotMatch(lines.join('\n'), /vite\.cli\.config\.ts/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('main passes the darwin child env to every build step, in order, and writes no install.json', () => {
  const root = fakeRoot()
  try {
    for (const [pkg, bin] of [
      ['electron-vite', 'bin/ev.js'],
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
      if (args.includes('--dir')) fs.mkdirSync(path.join(root, 'release', unpackedLayout('darwin', process.arch).dir, 'OrgAI.app'), { recursive: true })
    }
    const lines = []
    main([], root, (l) => lines.push(l), { platform: 'darwin', env: { HOME: '/h' }, exec })
    assert.equal(fs.existsSync(path.join(root, 'out')), false, 'no out/cli/install.json is written')
    assert.equal(calls.length, 2)
    assert.ok(calls[0].args[0].endsWith(path.join('electron-vite', 'bin', 'ev.js')))
    assert.ok(calls[1].args[0].endsWith(path.join('electron-builder', 'cli.js')))
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


/** A process stand-in: listeners per signal, and the kills asked for. */
function fakeProc() {
  const listeners = new Map()
  const kills = []
  return {
    pid: 4242,
    kills,
    on: (sig, l) => listeners.set(sig, [...(listeners.get(sig) ?? []), l]),
    removeListener: (sig, l) => listeners.set(sig, (listeners.get(sig) ?? []).filter((x) => x !== l)),
    emit: (sig) => (listeners.get(sig) ?? []).slice().forEach((l) => l()),
    count: () => [...listeners.values()].reduce((n, ls) => n + ls.length, 0),
    kill: (pid, sig) => kills.push([pid, sig])
  }
}

test('withInstallInfoCleanup removes install.json on SIGINT / SIGTERM / SIGHUP and re-raises; no listener is left', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgai-pack-sig-'))
  try {
    fs.writeFileSync(path.join(dir, 'orgai.mjs'), '')
    for (const sig of CLEANUP_SIGNALS) {
      const proc = fakeProc()
      withInstallInfoCleanup(
        dir,
        () => {
          writeInstallInfo(dir, { channel: 'app', version: '9.9.9' })
          assert.equal(proc.count(), 3)
          proc.emit(sig)
          assert.equal(fs.existsSync(path.join(dir, 'install.json')), false, `${sig} removes it at once`)
          assert.equal(proc.count(), 0, 'the listeners are dropped before the re-raise')
        },
        proc
      )
      assert.deepEqual(proc.kills, [[4242, sig]])
    }
    // a normal end and a throw both remove it and leave no listener
    const proc = fakeProc()
    assert.throws(() =>
      withInstallInfoCleanup(
        dir,
        () => {
          writeInstallInfo(dir, { channel: 'app', version: '9.9.9' })
          throw new Error('builder failed')
        },
        proc
      )
    )
    assert.equal(fs.existsSync(path.join(dir, 'install.json')), false)
    assert.equal(proc.count(), 0)
    assert.deepEqual(proc.kills, [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('withInstallInfoCleanup: a real signal to the process group during a synchronous child removes install.json', { skip: process.platform === 'win32' && 'POSIX process groups only' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgai-pack-ctrlc-'))
  try {
    const cli = path.join(dir, 'cli')
    fs.mkdirSync(cli)
    fs.writeFileSync(path.join(cli, 'orgai.mjs'), '')
    const mod = pathToFileURL(path.join(SCRIPTS, 'write-install-info.mjs')).href
    const script = path.join(dir, 'run.mjs')
    fs.writeFileSync(
      script,
      [
        "import { execFileSync } from 'node:child_process'",
        `import { withInstallInfoCleanup, writeInstallInfo } from ${JSON.stringify(mod)}`,
        `const cli = ${JSON.stringify(cli)}`,
        'withInstallInfoCleanup(cli, () => {',
        "  writeInstallInfo(cli, { channel: 'app', version: '9.9.9' })",
        // the child says ready, so the signal surely lands while execFileSync blocks on it
        "  execFileSync(process.execPath, ['-e', \"process.stdout.write('ready\\\\n'); setTimeout(() => {}, 20000)\"], { stdio: 'inherit' })",
        '})'
      ].join('\n')
    )
    const child = spawn(process.execPath, [script], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('the script never got ready')), 10_000)
      child.stdout.on('data', (b) => {
        if (String(b).includes('ready')) {
          clearTimeout(t)
          resolve()
        }
      })
    })
    assert.equal(fs.existsSync(path.join(cli, 'install.json')), true)
    // A terminal's Ctrl+C sends SIGINT to the whole foreground group; SIGTERM to the group is the same path (a CI
    // cancel, `kill -TERM -<pgid>`). SIGTERM here because a test runner started without a terminal may hand its
    // children an ignored SIGINT, which would make this test pass with no listener at all.
    process.kill(-child.pid, 'SIGTERM')
    const ended = await new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
    assert.ok(ended.code !== 0 || ended.signal, `the script did not end normally: ${JSON.stringify(ended)}`)
    assert.equal(fs.existsSync(path.join(cli, 'install.json')), false, 'install.json was left behind')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
