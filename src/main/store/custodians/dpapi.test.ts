import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { dpapiEntropy } from '../vaultTypes'
import { DPAPI_ARGS, DPAPI_CLM_REASON, DpapiCustodian, dpapiProtectScript, dpapiUnprotectScript } from './dpapi'
import { fakeSpawner, type FakeAnswer } from './fakeSpawner'

const ID = '0123456789abcdef0123456789abcdef'
const env = { SystemRoot: 'D:\\WINDOWS', PATH: 'C:\\bin', NODE_OPTIONS: '--x', ORGAI_SECRET_A: 'v', USERPROFILE: 'C:\\Users\\me' }
const PS = 'D:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

/**
 * A fake PowerShell whose "protection" is reversing the bytes (only the plumbing is under test). Create draws its own
 * key, as the real script does with RandomNumberGenerator, and records it in `drawn`.
 */
function fakePs(override?: (stdin: string) => FakeAnswer | undefined) {
  const drawn: Buffer[] = []
  const f = fakeSpawner(({ stdin }) => {
    const o = override?.(stdin)
    if (o) return o
    if (stdin.includes('ProtectedData]::Protect(')) {
      const k = randomBytes(32)
      drawn.push(Buffer.from(k))
      return { code: 0, stdout: `OK:${Buffer.from(k).reverse().toString('base64')}:${k.toString('base64')}\r\n` }
    }
    if (!stdin.includes('FromBase64String')) return { code: 0, stdout: 'OK\r\n' }
    const m = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(stdin)!
    const data = Buffer.from(m[1]!, 'base64').reverse()
    return { code: 0, stdout: `OK:${data.toString('base64')}\r\n` }
  })
  return { ...f, drawn }
}

describe('DpapiCustodian (cli-standalone.md 5.3, Windows)', () => {
  it('probes LanguageMode and Add-Type with one absolute powershell.exe reading the script on stdin', async () => {
    const f = fakePs()
    const c = new DpapiCustodian({ spawner: f.spawner, env, platform: 'win32' })
    await expect(c.probe()).resolves.toEqual({ ok: true })
    const call = f.calls[0]!
    expect(call.file).toBe(PS)
    expect(call.args).toEqual([...DPAPI_ARGS])
    expect(call.args).toEqual(['-NoProfile', '-NonInteractive', '-Command', '-'])
    expect(call.stdin).toContain('$ExecutionContext.SessionState.LanguageMode')
    expect(call.stdin).toContain("'FullLanguage'")
    expect(call.stdin).toContain('Add-Type -AssemblyName System.Security')
    expect(call.stdin.endsWith('\r\n')).toBe(true)
    expect(call.options.env).toEqual({ SystemRoot: 'D:\\WINDOWS', Path: 'C:\\bin', USERPROFILE: 'C:\\Users\\me' })
  })

  it.each([
    [{ code: 3, stdout: 'LANG:ConstrainedLanguage\r\n' }, 'denied'],
    [{ code: 4, stdout: 'ADDTYPE\r\n' }, 'denied'],
    [{ code: 1, stdout: '' }, 'denied'],
    [{ hang: true }, 'timeout'],
    [{ spawnError: 'ENOENT' }, 'unavailable']
  ] as Array<[FakeAnswer, string]>)('classifies a probe answer %j as %s', async (answer, kind) => {
    const f = fakePs(() => answer)
    const p = await new DpapiCustodian({ spawner: f.spawner, env, platform: 'win32', timeoutMs: 30 }).probe()
    expect(p).toMatchObject({ ok: false, kind })
  })

  it('names Constrained Language Mode when it denies', async () => {
    const f = fakePs(() => ({ code: 3, stdout: 'LANG:ConstrainedLanguage\r\n' }))
    const p = await new DpapiCustodian({ spawner: f.spawner, env, platform: 'win32' }).probe()
    expect(p).toEqual({ ok: false, kind: 'denied', reason: DPAPI_CLM_REASON })
    expect(DPAPI_CLM_REASON).toContain('Constrained Language Mode')
  })

  it('creates with Protect(key, entropy, CurrentUser) and returns the blob for custody.wrapped', async () => {
    const f = fakePs()
    const c = new DpapiCustodian({ spawner: f.spawner, env, platform: 'win32' })
    const { dek, wrapped } = await c.create(ID)
    expect(dek.length).toBe(32)
    expect(dek.equals(f.drawn[0]!)).toBe(true)
    expect(wrapped).toBe(Buffer.from(dek).reverse().toString('base64'))
    const s = f.calls[0]!.stdin
    expect(s).toContain('ProtectedData]::Protect(')
    expect(s).toContain('DataProtectionScope]::CurrentUser')
    expect(s).toContain('RandomNumberGenerator]::Create()')
    expect(s).toContain(`'${dpapiEntropy(ID)}'`)
    expect(s).toContain(`'orgai.vault/1:${ID}'`)
  })

  it('never puts the data key in script text, and writes it only through [Console]::Out (review round 1 blocker)', async () => {
    const f = fakePs()
    const c = new DpapiCustodian({ spawner: f.spawner, env, platform: 'win32' })
    const { dek, wrapped } = await c.create(ID)
    await c.open(ID, { scheme: 'dpapi-user', wrapped: wrapped! })
    for (const call of f.calls) {
      for (const text of [call.stdin, call.args.join(' ')]) {
        expect(text).not.toContain(dek.toString('base64'))
        expect(text).not.toContain(dek.toString('hex'))
      }
    }
    // The create script is the same whatever key it makes: nothing in it depends on a value but the vault id.
    expect(f.calls[0]!.stdin).toBe(dpapiProtectScript(ID))
    expect(f.calls[0]!.stdin).not.toContain('FromBase64String')
    for (const script of [dpapiProtectScript(ID), dpapiUnprotectScript('AAAA', ID)]) {
      // A key leaves PowerShell only through [Console]::Out.Write, never Write-Output (formatting, transcription).
      expect(script).not.toMatch(/Write-Output \('OK:/)
      expect(script).toContain("[Console]::Out.Write('OK:' + [Convert]::ToBase64String(")
    }
  })

  it.each([
    ['no key', 'OK:AAAA\r\n'],
    ['a short key', `OK:AAAA:${Buffer.alloc(16).toString('base64')}\r\n`],
    ['an extra field', `OK:AAAA:${Buffer.alloc(32).toString('base64')}:x\r\n`],
    ['a blob that is not base64', `OK:A*AA:${Buffer.alloc(32).toString('base64')}\r\n`]
  ])('refuses a create answer with %s', async (_label, stdout) => {
    const f = fakePs(() => ({ code: 0, stdout }))
    await expect(new DpapiCustodian({ spawner: f.spawner, env, platform: 'win32' }).create(ID)).rejects.toMatchObject({ kind: 'denied' })
  })

  it('opens with Unprotect and the same entropy', async () => {
    const f = fakePs()
    const c = new DpapiCustodian({ spawner: f.spawner, env, platform: 'win32' })
    const { dek, wrapped } = await c.create(ID)
    const got = await c.open(ID, { scheme: 'dpapi-user', wrapped: wrapped! })
    expect(got.equals(dek)).toBe(true)
    expect(f.calls[1]!.stdin).toContain('ProtectedData]::Unprotect(')
    expect(f.calls[1]!.stdin).toContain(`'${dpapiEntropy(ID)}'`)
  })

  it('maps a CryptographicException on open to missing (another user or machine)', async () => {
    const f = fakePs(() => ({ code: 0, stdout: 'ERR:crypto\r\n' }))
    await expect(new DpapiCustodian({ spawner: f.spawner, env, platform: 'win32' }).open(ID, { scheme: 'dpapi-user', wrapped: 'AAAA' })).rejects.toMatchObject({
      kind: 'missing'
    })
  })

  it('refuses a wrapped blob that is not strict base64 without running PowerShell', async () => {
    const f = fakePs()
    const c = new DpapiCustodian({ spawner: f.spawner, env, platform: 'win32' })
    await expect(c.open(ID, { scheme: 'dpapi-user', wrapped: "AA'); Remove-Item x; ('" })).rejects.toMatchObject({ kind: 'missing' })
    await expect(c.open(ID, { scheme: 'dpapi-user' })).rejects.toMatchObject({ kind: 'missing' })
    expect(f.calls).toHaveLength(0)
  })

  it('refuses an unwrapped key of the wrong size', async () => {
    const f = fakePs(() => ({ code: 0, stdout: `OK:${Buffer.alloc(16).toString('base64')}\r\n` }))
    await expect(new DpapiCustodian({ spawner: f.spawner, env, platform: 'win32' }).open(ID, { scheme: 'dpapi-user', wrapped: 'AAAA' })).rejects.toMatchObject({
      kind: 'denied'
    })
  })

  it('is not available off Windows', async () => {
    const f = fakePs()
    const c = new DpapiCustodian({ spawner: f.spawner, env, platform: 'darwin' })
    await expect(c.probe()).resolves.toMatchObject({ ok: false, kind: 'unavailable' })
    await expect(c.open(ID, { scheme: 'dpapi-user', wrapped: 'AAAA' })).rejects.toMatchObject({ kind: 'missing' })
    expect(f.calls).toHaveLength(0)
  })
})
