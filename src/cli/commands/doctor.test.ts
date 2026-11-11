import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeContext } from '../testing/fakeContext'
import { EXIT } from '../types'
import { DAEMON_JSON_MAX_BYTES, PACKAGED_LAUNCHER_MARK, doctorProbes, installCheck, runDoctor, shimCheck } from './doctor'
import { runtimeCheckProbes } from '../doctor/runtimeChecks'

/** An old OrgAI app shim, written out here (the app no longer renders one). */
function renderCliShim(input: { platform: string; launcher: string; env?: Record<string, string> }): string {
  const note = 'orgai-shim v1: written by OrgAI (App settings > General > Advanced settings > Terminal). OrgAI updates or removes this file.'
  return input.platform === 'win32'
    ? ['@echo off', `rem ${note}`, 'setlocal', `"${input.launcher}" %*`, ''].join('\r\n')
    : `#!/bin/sh\n# ${note}\nexec '${input.launcher}' "$@"\n`
}

const realProbes = { ...doctorProbes }
const realRuntimeProbes = { ...runtimeCheckProbes }
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-doctor-'))
  doctorProbes.gitVersion = async () => 'git version 2.50.0'
  doctorProbes.connectionChecks = async () => []
  doctorProbes.nodeVersion = () => '22.11.0'
  // Never read the real home folder's shim.
  doctorProbes.homeDir = () => dir
  // Never look for or run a real claude / codex (runtimeChecks.test.ts covers the group).
  runtimeCheckProbes.claude = () => ({ ok: true, path: '/fake/claude', source: 'sdk' })
  runtimeCheckProbes.codexLookup = () => ({ binary: { path: '/fake/codex', source: 'package' } })
  runtimeCheckProbes.codexCheck = async (binary) => ({ ok: true, binary, version: '0.166.0' })
})
afterEach(() => {
  Object.assign(doctorProbes, realProbes)
  Object.assign(runtimeCheckProbes, realRuntimeProbes)
  rmSync(dir, { recursive: true, force: true })
})

function liveDataDir(): string {
  const data = join(dir, 'data')
  mkdirSync(join(data, 'run'), { recursive: true })
  if (process.platform !== 'win32') chmodSync(join(data, 'run'), 0o700)
  writeFileSync(join(data, 'run', 'daemon.json'), JSON.stringify({ hostInstanceId: 'aaaaaaaaaaaa', pid: process.pid, endpoint: '/x', state: 'ready', startedAt: 1, hostKind: 'desktop' }))
  return data
}

describe('orgai doctor', () => {
  it('appends the connection checks and fails on none of their warnings', async () => {
    doctorProbes.connectionChecks = async () => [{ id: 'models-anthropic', status: 'warn', detail: 'Anthropic: discovery failed. Fix: orgai models refresh --connection anthropic' }]
    const f = fakeContext({ paths: { userDataDir: dir, dataDir: liveDataDir() }, platform: process.platform, globals: { outputFormat: 'json' }, env: { ORGAI_MOCK: '1' } })
    expect(await runDoctor(f.ctx, [])).toBe(EXIT.ok)
    const checks = JSON.parse(f.out()).checks as { id: string; status: string }[]
    expect(checks[checks.length - 1]).toMatchObject({ id: 'models-anthropic', status: 'warn' })
  })

  it('the default probe skips (never starts a host) while another orgai owns the folder', async () => {
    const out = await realProbes.connectionChecks(fakeContext().ctx, true)
    expect(out).toHaveLength(1)
    expect(out[0].detail).toContain('another orgai owns this folder')
  })

  it('all ok: exit 0, JSON checks, never a host connection', async () => {
    const data = liveDataDir()
    // The run-dir check looks at POSIX mode bits unless the context platform is win32, so use the real platform here.
    const f = fakeContext({ paths: { userDataDir: dir, dataDir: data }, platform: process.platform, globals: { outputFormat: 'json' }, env: { ORGAI_MOCK: '1' } })
    expect(await runDoctor(f.ctx, [])).toBe(EXIT.ok)
    const j = JSON.parse(f.out())
    expect(j.ok).toBe(true)
    const ids = j.checks.map((c: { id: string }) => c.id)
    expect(ids).toEqual(['node', 'install', 'data-dir', 'product', 'run-dir', 'daemon-json', 'shim', 'git', 'mock', 'install-channel', 'orgai-on-path', 'node-certs', 'claude-runtime', 'codex-runtime', 'vault', 'vault-custody', 'legacy-secrets'])
    expect(j.checks.every((c: { status: string }) => c.status !== 'fail')).toBe(true)
    expect(j.checks.find((c: { id: string }) => c.id === 'daemon-json').detail).toMatch(/^Another orgai is running \(pid \d+/)
    expect(f.connectCalls).toHaveLength(0)
    expect(f.inprocCalls).toHaveLength(0)
  })

  it('a failing check is exit 1 (old Node, run/ open to others)', async () => {
    const data = liveDataDir()
    doctorProbes.nodeVersion = () => '20.1.0'
    if (process.platform !== 'win32') chmodSync(join(data, 'run'), 0o755)
    const f = fakeContext({ paths: { userDataDir: dir, dataDir: data }, })
    expect(await runDoctor(f.ctx, [])).toBe(EXIT.failure)
    const out = f.out()
    expect(out).toMatch(/^fail {2}node/m)
    if (process.platform !== 'win32') expect(out).toMatch(/^fail {2}run-dir .*mode 755/m)
    expect(out).toContain('Some checks failed.')
  })

  it('no other orgai is not a failure', async () => {
    const f = fakeContext({ paths: { userDataDir: dir, dataDir: join(dir, 'data') } })
    expect(await runDoctor(f.ctx, [])).toBe(EXIT.ok)
    expect(f.out()).toMatch(/^ok {4}daemon-json +No other orgai is running/m)
    expect(f.connectCalls).toHaveLength(0)
  })

  it('the product marker is reported: absent is ok, a desktop marker fails', async () => {
    const paths = { userDataDir: dir, dataDir: join(dir, 'data') }
    const fresh = fakeContext({ paths })
    expect(await runDoctor(fresh.ctx, [])).toBe(EXIT.ok)
    expect(fresh.out()).toMatch(/^ok {4}product +.* has no product marker yet/m)
    writeFileSync(join(dir, 'product.json'), JSON.stringify({ product: 'orgai-desktop', version: 1 }))
    const desktop = fakeContext({ paths })
    expect(await runDoctor(desktop.ctx, [])).toBe(EXIT.failure)
    expect(desktop.out()).toMatch(/^fail {2}product +.* is marked orgai-desktop/m)
  })

  it('never reads an oversized or odd daemon.json whole (review Low)', async () => {
    const data = liveDataDir()
    const daemon = join(data, 'run', 'daemon.json')
    writeFileSync(daemon, `{"pid":1,"hostInstanceId":"aaaaaaaaaaaa","pad":"${'x'.repeat(DAEMON_JSON_MAX_BYTES)}"}`)
    const f = fakeContext({ paths: { userDataDir: dir, dataDir: data } })
    expect(await runDoctor(f.ctx, [])).toBe(EXIT.failure)
    expect(f.out()).toMatch(/^fail {2}daemon-json +daemon\.json could not be read: it is larger than 64 KB/m)
    expect(f.connectCalls).toHaveLength(0)
    rmSync(daemon)
    mkdirSync(daemon)
    const g = fakeContext({ paths: { userDataDir: dir, dataDir: data } })
    expect(await runDoctor(g.ctx, [])).toBe(EXIT.failure)
    expect(g.out()).toMatch(/daemon\.json could not be read: it is not a regular file/)
  })
})

describe('orgai doctor: install and shim (cli-spec 7, Wave 6)', () => {
  const RES = '/Applications/OrgAI.app/Contents/Resources'
  const LAUNCHER = `${RES}/bin/orgai`
  // The checks run with an injected 'darwin' platform (POSIX path rules), so the fake home is a POSIX-style path:
  // forward slashes and no drive letter on Windows (the fake file system below is a Map, nothing touches the disk).
  const px = (p: string): string => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
  const HOME = () => px(dir)
  const join = (...parts: string[]): string => [...parts].join('/').replace(/\/+/g, '/')
  const SHIM = () => join(HOME(), '.local', 'bin', 'orgai')
  /** Fake file system for the shim reads: path -> text. */
  let files: Map<string, string>
  beforeEach(() => {
    files = new Map()
    doctorProbes.homeDir = HOME
    doctorProbes.readText = (p) => {
      const t = files.get(p)
      if (t === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
      return t
    }
    doctorProbes.exists = (p) => files.has(p) || p === LAUNCHER
    doctorProbes.realpath = (p) => p
  })
  const packaged = (): void => {
    doctorProbes.bundleDir = () => `${RES}/app.asar.unpacked/out/cli`
    doctorProbes.electronVersion = () => '45.1.0'
    doctorProbes.nodeVersion = () => '24.22.1'
  }
  const shimText = (launcher: string): string => renderCliShim({ platform: 'darwin', launcher })
  const pathEnv = (): NodeJS.ProcessEnv => ({ PATH: `/usr/bin:${join(HOME(), '.local', 'bin')}` })

  it('install: dev checkout and standalone bundle', () => {
    packaged()
    doctorProbes.bundleDir = realProbes.bundleDir
    const dev = installCheck()
    expect(dev.status).toBe('ok')
    expect(dev.detail).toMatch(/^Development checkout /)
    doctorProbes.bundleDir = () => join(HOME(), 'somewhere', 'cli')
    expect(installCheck()).toEqual({ id: 'install', status: 'ok', detail: `Standalone bundle ${join(HOME(), 'somewhere', 'cli')}` })
  })

  it('the node check passes on Electron 45 Node 24', async () => {
    packaged()
    const f = fakeContext({ paths: { userDataDir: dir, dataDir: join(dir, 'data') }, platform: 'darwin', env: pathEnv(), globals: { outputFormat: 'json' } })
    expect(await runDoctor(f.ctx, [])).toBe(EXIT.ok)
    const checks = JSON.parse(f.out()).checks as { id: string; status: string; detail: string }[]
    expect(checks.find((c) => c.id === 'node')).toEqual({ id: 'node', status: 'ok', detail: 'Node 24.22.1' })
  })

  it('shim: missing is ok (no old app command)', () => {
    packaged()
    expect(shimCheck('darwin', pathEnv())).toEqual({ id: 'shim', status: 'ok', detail: 'No old app command found (nothing to remove)' })
  })

  it('shim: a foreign file warns and names the path', () => {
    packaged()
    files.set(SHIM(), '#!/bin/sh\nexec /opt/other/orgai "$@"\n')
    const c = shimCheck('darwin', pathEnv())
    expect(c.status).toBe('warn')
    expect(c.detail).toContain(SHIM())
    expect(c.detail).toContain('not an OrgAI shim')
  })

  it("shim: this install's launcher on PATH is ok", () => {
    packaged()
    files.set(SHIM(), shimText(LAUNCHER))
    {
      const c = shimCheck('darwin', pathEnv())
      expect(c.status).toBe('warn')
      expect(c.detail).toContain('old OrgAI app command')
    }
  })

  it('shim: an old shim whose launcher is gone warns, one that exists is just reported', () => {
    packaged()
    const other = '/Users/me/Downloads/OrgAI.app/Contents/Resources/bin/orgai'
    files.set(other, '')
    files.set(SHIM(), shimText(other))
    const c = shimCheck('darwin', pathEnv())
    expect(c.status).toBe('warn')
    expect(c.detail).toContain('old OrgAI app command')
    files.set(SHIM(), shimText('/gone/OrgAI.app/Contents/Resources/bin/orgai'))
    const gone = shimCheck('darwin', pathEnv())
    expect(gone.status).toBe('warn')
    expect(gone.detail).toContain('is gone')
    expect(gone.detail).toContain('npm i -g orgai-cli')
  })

  it("shim: a symlink to this install's launcher is ok, to another one warns (review L)", () => {
    packaged()
    // An old packaged launcher (the app no longer ships one) carries the mark on a line of its own.
    const launcherText = `#!/bin/sh\n# ${PACKAGED_LAUNCHER_MARK} (cli-spec 7, Wave 6).\n`
    files.set(SHIM(), launcherText)
    doctorProbes.realpath = (p) => (p === SHIM() ? LAUNCHER : p)
    expect(shimCheck('darwin', pathEnv())).toMatchObject({ status: 'warn', detail: expect.stringContaining('(a link) is the old OrgAI app command') })
    const other = '/Users/me/Apps/OrgAI.app/Contents/Resources/bin/orgai'
    files.set(other, launcherText)
    doctorProbes.realpath = (p) => (p === SHIM() ? other : p)
    expect(shimCheck('darwin', pathEnv()).status).toBe('warn')
    // A link to some other program is still foreign.
    files.set(SHIM(), '#!/bin/sh\nexec /opt/x "$@"\n')
    doctorProbes.realpath = (p) => (p === SHIM() ? '/opt/x/orgai' : p)
    expect(shimCheck('darwin', pathEnv()).detail).toContain('not an OrgAI shim')
  })

  it('shim: a live shim warns, suggests removal and npm, and never advises adding it to PATH', () => {
    packaged()
    files.set(SHIM(), shimText(LAUNCHER))
    for (const env of [{ PATH: '/usr/bin:/bin' }, { PATH: `${join(HOME(), '.local', 'bin')}/` }]) {
      const c = shimCheck('darwin', env)
      expect(c.status).toBe('warn')
      expect(c.detail).toContain('remove it')
      expect(c.detail).toContain('npm i -g orgai-cli')
      expect(c.detail).not.toContain('export PATH')
    }
  })

  it('doctor lists the shim check and never writes the shim', async () => {
    packaged()
    const f = fakeContext({ paths: { userDataDir: dir, dataDir: join(dir, 'data') }, platform: 'darwin', env: { PATH: '/usr/bin' } })
    expect(await runDoctor(f.ctx, [])).toBe(EXIT.ok)
    expect(f.out()).toMatch(/^ok {4}install /m)
    expect(f.out()).toMatch(/^ok {4}shim +No old app command found/m)
    expect(files.size).toBe(0)
  })
})
