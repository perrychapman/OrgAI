import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeHostClient, fakeContext } from '../testing/fakeContext'
import { EXIT } from '../types'
import { doctorProbes, runDoctor } from './doctor'

const realProbes = { ...doctorProbes }
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-doctor-'))
  doctorProbes.gitVersion = async () => 'git version 2.50.0'
  doctorProbes.nodeVersion = () => '22.11.0'
})
afterEach(() => {
  Object.assign(doctorProbes, realProbes)
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
  it('all ok with a live host: exit 0, JSON checks, no secrets', async () => {
    const data = liveDataDir()
    const h = new FakeHostClient({
      'auth:status': () => ({ loggedIn: true, mode: 'subscription', method: 'claude.ai' }),
      'connections:list': () => [{ connection: { id: 'anthropic', enabled: true, tierModels: {}, auth: { mode: 'apiKey', apiKey: 'sk-secret' } }, status: { state: 'connected' }, modelCount: 3, isDefault: true }]
    })
    const f = fakeContext({ paths: { userDataDir: dir, dataDir: data }, connect: [h], globals: { outputFormat: 'json' }, env: { ORGAI_MOCK: '1' } })
    expect(await runDoctor(f.ctx, [])).toBe(EXIT.ok)
    const j = JSON.parse(f.out())
    expect(j.ok).toBe(true)
    const ids = j.checks.map((c: { id: string }) => c.id)
    expect(ids).toEqual(['node', 'data-dir', 'run-dir', 'daemon-json', 'socket', 'terminal-access', 'version', 'launcher', 'git', 'mock', 'auth', 'connections'])
    expect(j.checks.every((c: { status: string }) => c.status !== 'fail')).toBe(true)
    expect(j.checks.find((c: { id: string }) => c.id === 'connections').detail).toBe('Anthropic connected (default)')
    expect(f.out()).not.toContain('sk-secret')
  })

  it('a failing check is exit 1 (old Node, run/ open to others)', async () => {
    const data = liveDataDir()
    doctorProbes.nodeVersion = () => '20.1.0'
    if (process.platform !== 'win32') chmodSync(join(data, 'run'), 0o755)
    const f = fakeContext({ paths: { userDataDir: dir, dataDir: data }, connect: [{ ok: false, reason: 'disabled', message: 'Terminal access is off.' }] })
    expect(await runDoctor(f.ctx, [])).toBe(EXIT.failure)
    const out = f.out()
    expect(out).toMatch(/^fail {2}node/m)
    if (process.platform !== 'win32') expect(out).toMatch(/^fail {2}run-dir .*mode 755/m)
    expect(out).toMatch(/^warn {2}terminal-access +Terminal access is off\./m)
    expect(out).toContain('Some checks failed.')
  })

  it('no host is not a failure', async () => {
    const f = fakeContext({ paths: { userDataDir: dir, dataDir: join(dir, 'data') } })
    expect(await runDoctor(f.ctx, [])).toBe(EXIT.ok)
    expect(f.out()).toMatch(/^ok {4}socket +Skipped: no host is running/m)
    expect(f.connectCalls).toHaveLength(0)
  })
})
