import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { trackedChildCount } from '../../host/shutdown'
import { fakeSpawner } from './fakeSpawner'
import { HELPER_STDOUT_MAX, decodeKeyBase64, isAbsoluteExecutable, isStrictBase64, isVaultId, runHelper } from './run'

describe('runHelper (cli-standalone.md 5.3 helper rules)', () => {
  it('spawns an absolute file with shell false, cwd tmpdir, the given env and stdin, and tracks the child meanwhile', async () => {
    let trackedDuring = -1
    const { spawner, calls } = fakeSpawner(({ stdin }) => {
      trackedDuring = trackedChildCount('custodian:test')
      return { code: 0, stdout: stdin.toUpperCase(), stderr: 'noise' }
    })
    const r = await runHelper('/usr/bin/tool', ['a', 'b'], { spawner, env: { HOME: '/h' }, stdin: 'hello', label: 'custodian:test', platform: 'darwin' })
    expect(r).toMatchObject({ code: 0, stderr: 'noise', timedOut: false, overflow: false })
    expect(r.stdout.toString()).toBe('HELLO')
    expect(calls[0]!.options).toEqual({ cwd: tmpdir(), env: { HOME: '/h' }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    expect(calls[0]!.args).toEqual(['a', 'b'])
    expect(trackedDuring).toBe(1)
    expect(trackedChildCount('custodian:test')).toBe(0)
  })

  it('never runs a bare or relative name', async () => {
    const { spawner, calls } = fakeSpawner(() => ({ code: 0 }))
    for (const [file, platform] of [
      ['security', 'darwin'],
      ['./security', 'linux'],
      ['powershell.exe', 'win32'],
      ['\\\\host\\share\\x.exe', 'win32']
    ] as const) {
      const r = await runHelper(file, [], { spawner, env: {}, label: 'custodian:test', platform })
      expect(r.spawnError?.code).toBe('ENOENT')
    }
    expect(calls).toHaveLength(0)
    expect(isAbsoluteExecutable('C:\\Windows\\System32\\whoami.exe', 'win32')).toBe(true)
  })

  it('kills a helper that does not answer in time', async () => {
    const { spawner, calls } = fakeSpawner(() => ({ hang: true }))
    const r = await runHelper('/usr/bin/tool', [], { spawner, env: {}, label: 'custodian:test', timeoutMs: 30, platform: 'darwin' })
    expect(r.timedOut).toBe(true)
    expect(r.code).toBeNull()
    expect(calls[0]!.killed).toBe(true)
    expect(trackedChildCount('custodian:test')).toBe(0)
  })

  it('kills a helper whose stdout runs past the cap', async () => {
    const { spawner, calls } = fakeSpawner(() => ({ code: 0, stdout: 'x'.repeat(HELPER_STDOUT_MAX + 10) }))
    const r = await runHelper('/usr/bin/tool', [], { spawner, env: {}, label: 'custodian:test', platform: 'darwin' })
    expect(r.overflow).toBe(true)
    expect(calls[0]!.killed).toBe(true)
  })

  it('reports a spawn error', async () => {
    const { spawner } = fakeSpawner(() => ({ spawnError: 'ENOENT' }))
    const r = await runHelper('/usr/bin/tool', [], { spawner, env: {}, label: 'custodian:test', platform: 'darwin' })
    expect(r.spawnError?.code).toBe('ENOENT')
  })

  it('checks ids and key encodings strictly', () => {
    expect(isVaultId('0123456789abcdef0123456789abcdef')).toBe(true)
    expect(isVaultId('0123456789abcdef0123456789abcde')).toBe(false)
    expect(isVaultId('0123456789abcdef0123456789abcdeg')).toBe(false)
    const k = Buffer.alloc(32, 7).toString('base64')
    expect(decodeKeyBase64(k)?.length).toBe(32)
    expect(decodeKeyBase64(`${k}\n`)).toBeUndefined()
    expect(decodeKeyBase64(Buffer.alloc(31).toString('base64'))).toBeUndefined()
    expect(isStrictBase64('AAAA')).toBe(true)
    expect(isStrictBase64("AA'A")).toBe(false)
    expect(isStrictBase64('AAA')).toBe(false)
  })
})
