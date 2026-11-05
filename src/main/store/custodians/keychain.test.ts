import { describe, expect, it } from 'vitest'
import { CustodyError } from '../vaultTypes'
import { fakeSpawner, type FakeAnswer } from './fakeSpawner'
import { KEYCHAIN_LOCKED_REASON, KeychainCustodian, SECURITY_PATH, addGenericPasswordLine, parseDefaultKeychain, securityInteractiveArg } from './keychain'

const ID = '0123456789abcdef0123456789abcdef'
const LOGIN = '/Users/me/Library/Keychains/login.keychain-db'
const env = { HOME: '/Users/me', PATH: '/usr/bin', NODE_OPTIONS: '--x', ORGAI_VAULT_KEY_FILE: '/k' }

/** A fake `security` with an in-memory keychain. */
function fakeSecurity(opts: { items?: Map<string, string>; override?: (args: string[], stdin: string) => FakeAnswer | undefined } = {}) {
  const items = opts.items ?? new Map<string, string>()
  return {
    items,
    ...fakeSpawner(({ args, stdin }) => {
      const o = opts.override?.(args, stdin)
      if (o) return o
      const acct = args[args.indexOf('-a') + 1] ?? ''
      if (args[0] === 'default-keychain') return { code: 0, stdout: `    "${LOGIN}"\n` }
      if (args[0] === 'show-keychain-info') return { code: 0, stdout: 'Keychain "login.keychain-db" no-timeout\n' }
      if (args[0] === 'find-generic-password') {
        const v = items.get(acct)
        if (v === undefined) return { code: 44, stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n' }
        return args.includes('-w') ? { code: 0, stdout: `${v}\n` } : { code: 0, stdout: 'keychain: "login"\nattributes:\n' }
      }
      if (args[0] === 'delete-generic-password') {
        if (!items.delete(acct)) return { code: 44, stderr: 'could not be found' }
        return { code: 0 }
      }
      if (args[0] === '-i') {
        const m = /^add-generic-password -s "OrgAI Vault" -a "([0-9a-f]{32})" -w "([A-Za-z0-9+/=]+)"\n$/.exec(stdin)
        if (!m) return { code: 0, stderr: 'parse error' }
        if (items.has(m[1]!)) return { code: 0, stderr: 'security: SecKeychainItemCreateFromContent: The specified item already exists in the keychain.' }
        items.set(m[1]!, m[2]!)
        return { code: 0 }
      }
      return { code: 1 }
    })
  }
}

describe('KeychainCustodian (cli-standalone.md 5.3, macOS)', () => {
  it('probes with show-keychain-info through /usr/bin/security and the keychain allowlist', async () => {
    const f = fakeSecurity()
    const c = new KeychainCustodian({ spawner: f.spawner, env, platform: 'darwin' })
    await expect(c.probe()).resolves.toEqual({ ok: true })
    for (const call of f.calls) expect(call.file).toBe(SECURITY_PATH)
    // The default keychain by path: a bare show-keychain-info asks about a NULL keychain (review round 1).
    expect(f.calls.map((x) => x.args)).toEqual([['default-keychain'], ['show-keychain-info', LOGIN]])
    expect(f.calls[0]!.options.env).toEqual({ HOME: '/Users/me', PATH: '/usr/bin' })
  })

  it('reports the default keychain locked when show-keychain-info on its path says so', async () => {
    const f = fakeSecurity({
      override: (args) => (args[0] === 'show-keychain-info' && args[1] === LOGIN ? { code: 36, stderr: 'security: SecKeychainCopySettings: User interaction is not allowed.' } : undefined)
    })
    await expect(new KeychainCustodian({ spawner: f.spawner, env, platform: 'darwin' }).probe()).resolves.toMatchObject({ ok: false, kind: 'locked' })
  })

  it('is unavailable when default-keychain names no single path, and never asks show-keychain-info without one', async () => {
    for (const stdout of ['', 'garbage\n', `    "${LOGIN}"\n    "/other.keychain-db"\n`, '    "relative.keychain"\n']) {
      const f = fakeSecurity({ override: (args) => (args[0] === 'default-keychain' ? { code: 0, stdout } : undefined) })
      await expect(new KeychainCustodian({ spawner: f.spawner, env, platform: 'darwin' }).probe()).resolves.toMatchObject({ ok: false, kind: 'unavailable' })
      expect(f.calls.some((x) => x.args[0] === 'show-keychain-info')).toBe(false)
    }
  })

  it('parses security default-keychain output', () => {
    expect(parseDefaultKeychain(`    "${LOGIN}"\n`)).toBe(LOGIN)
    expect(parseDefaultKeychain('    "/Users/a b/Library/Keychains/login.keychain-db"\n')).toBe('/Users/a b/Library/Keychains/login.keychain-db')
    expect(parseDefaultKeychain('    "<NULL>"\n')).toBeUndefined()
    expect(parseDefaultKeychain('')).toBeUndefined()
  })

  it.each([
    [{ code: 36, stderr: 'security: SecKeychainCopySettings: User interaction is not allowed.' }, 'locked'],
    [{ code: 51 }, 'locked'],
    [{ code: 128 }, 'locked'],
    [{ hang: true }, 'locked'],
    [{ spawnError: 'ENOENT' }, 'unavailable'],
    [{ code: 50, stderr: 'A default keychain could not be found.' }, 'unavailable']
  ] as Array<[FakeAnswer, string]>)('classifies a probe answer %j as %s', async (answer, kind) => {
    const f = fakeSecurity({ override: () => answer })
    const c = new KeychainCustodian({ spawner: f.spawner, env, platform: 'darwin', timeoutMs: 30 })
    const p = await c.probe()
    expect(p).toMatchObject({ ok: false, kind })
    if (kind === 'locked') expect((p as { reason: string }).reason).toContain(KEYCHAIN_LOCKED_REASON)
  })

  it('creates through security -i -q with the key on stdin only, then reads it back', async () => {
    const f = fakeSecurity()
    const c = new KeychainCustodian({ spawner: f.spawner, env, platform: 'darwin' })
    const { dek, wrapped } = await c.create(ID)
    expect(dek.length).toBe(32)
    expect(wrapped).toBeUndefined()
    const b64 = dek.toString('base64')
    expect(f.items.get(ID)).toBe(b64)
    const add = f.calls.find((x) => x.args[0] === '-i')!
    expect(add.args).toEqual(['-i', '-q'])
    expect(add.stdin).toBe(`add-generic-password -s "OrgAI Vault" -a "${ID}" -w "${b64}"\n`)
    expect(add.stdin).not.toContain(' -U')
    for (const call of f.calls) expect(call.args.join(' ')).not.toContain(b64)
    // Exists check, add, read back.
    expect(f.calls.map((x) => x.args[0])).toEqual(['find-generic-password', '-i', 'find-generic-password'])
    expect(f.calls[0]!.args).not.toContain('-w')
  })

  it('refuses to create when an item for the vault id exists, and never adds', async () => {
    const f = fakeSecurity({ items: new Map([[ID, Buffer.alloc(32, 1).toString('base64')]]) })
    const c = new KeychainCustodian({ spawner: f.spawner, env, platform: 'darwin' })
    await expect(c.create(ID)).rejects.toMatchObject({ kind: 'denied', reason: expect.stringContaining('already exists') })
    expect(f.calls.some((x) => x.args[0] === '-i')).toBe(false)
  })

  it('fails create when the add reports a duplicate or the read back differs', async () => {
    const dup = fakeSecurity({ override: (args) => (args[0] === '-i' ? { code: 0, stderr: 'The specified item already exists in the keychain.' } : undefined) })
    await expect(new KeychainCustodian({ spawner: dup.spawner, env, platform: 'darwin' }).create(ID)).rejects.toMatchObject({ kind: 'denied' })

    const items = new Map<string, string>()
    const other = fakeSecurity({
      items,
      override: (args) => {
        if (args[0] === '-i') {
          items.set(ID, Buffer.alloc(32, 9).toString('base64'))
          return { code: 0 }
        }
        return undefined
      }
    })
    await expect(new KeychainCustodian({ spawner: other.spawner, env, platform: 'darwin' }).create(ID)).rejects.toMatchObject({ kind: 'denied' })

    const lost = fakeSecurity({ override: (args) => (args[0] === '-i' ? { code: 0 } : undefined) })
    await expect(new KeychainCustodian({ spawner: lost.spawner, env, platform: 'darwin' }).create(ID)).rejects.toMatchObject({ kind: 'unavailable' })
  })

  it('opens with find-generic-password -s "OrgAI Vault" -a <id> -w', async () => {
    const key = Buffer.alloc(32, 3)
    const f = fakeSecurity({ items: new Map([[ID, key.toString('base64')]]) })
    const c = new KeychainCustodian({ spawner: f.spawner, env, platform: 'darwin' })
    const got = await c.open(ID, { scheme: 'keychain' })
    expect(got.equals(key)).toBe(true)
    expect(f.calls[0]!.args).toEqual(['find-generic-password', '-s', 'OrgAI Vault', '-a', ID, '-w'])
  })

  it('maps open failures: 44 missing; 36, user cancel and timeout locked (never missing); junk denied', async () => {
    const open = async (answer: FakeAnswer): Promise<CustodyError> => {
      const f = fakeSecurity({ override: () => answer })
      const c = new KeychainCustodian({ spawner: f.spawner, env, platform: 'darwin', timeoutMs: 30 })
      return c.open(ID, { scheme: 'keychain' }).then(
        () => {
          throw new Error('opened')
        },
        (e: CustodyError) => e
      )
    }
    expect((await open({ code: 44 })).kind).toBe('missing')
    expect((await open({ code: 36 })).kind).toBe('locked')
    expect((await open({ code: 128, stderr: 'User canceled the operation.' })).kind).toBe('locked')
    expect((await open({ hang: true })).kind).toBe('locked')
    expect((await open({ code: 0, stdout: 'not-a-key\n' })).kind).toBe('denied')
    expect(await open({ code: 44 })).toBeInstanceOf(CustodyError)
  })

  it('refuses a bad vault id and other platforms without spawning', async () => {
    const f = fakeSecurity()
    await expect(new KeychainCustodian({ spawner: f.spawner, env, platform: 'darwin' }).open('../x', { scheme: 'keychain' })).rejects.toMatchObject({ kind: 'denied' })
    const linux = new KeychainCustodian({ spawner: f.spawner, env, platform: 'linux' })
    await expect(linux.probe()).resolves.toMatchObject({ ok: false, kind: 'unavailable' })
    await expect(linux.open(ID, { scheme: 'keychain' })).rejects.toMatchObject({ kind: 'missing' })
    expect(f.calls).toHaveLength(0)
  })

  it('removes an item and treats a missing one as removed', async () => {
    const f = fakeSecurity({ items: new Map([[ID, 'x']]) })
    const c = new KeychainCustodian({ spawner: f.spawner, env, platform: 'darwin' })
    await c.removeItem(ID, { scheme: 'keychain' })
    await c.removeItem(ID, { scheme: 'keychain' })
    expect(f.items.size).toBe(0)
  })

  it('quotes security -i arguments from a safe alphabet only', () => {
    expect(securityInteractiveArg('OrgAI Vault')).toBe('"OrgAI Vault"')
    expect(() => securityInteractiveArg('a"b')).toThrow(CustodyError)
    expect(() => securityInteractiveArg('a\\b')).toThrow(CustodyError)
    expect(() => securityInteractiveArg('a\nb')).toThrow(CustodyError)
    expect(addGenericPasswordLine(ID, 'AB+/=')).toBe(`add-generic-password -s "OrgAI Vault" -a "${ID}" -w "AB+/="\n`)
  })
})
