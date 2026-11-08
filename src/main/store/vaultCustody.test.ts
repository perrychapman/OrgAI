/**
 * Product-scoped vault custody (standalone spec 3.2): the CLI and the desktop app use different key item names and key
 * file variables, and neither reads or touches the other's.
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { chooseCustodyScheme, createCustodian, createCustodianFactory, DpapiCustodian, KeyFileCustodian, SecretServiceCustodian } from './custodians'
import { fakeSpawner, type FakeAnswer } from './custodians/fakeSpawner'
import { dpapiProtectScript, dpapiUnprotectScript } from './custodians/dpapi'
import { openSecretStore } from './secrets'
import { noCipher } from './vaultTesting'
import { CustodyError, dpapiEntropy, vaultNames, type VaultCustody } from './vaultTypes'

const ID = '0123456789abcdef0123456789abcdef'
const ID2 = 'fedcba9876543210fedcba9876543210'
const LOGIN = '/Users/me/Library/Keychains/login.keychain-db'
const macEnv = { HOME: '/Users/me', PATH: '/usr/bin' }
const CUSTODY: VaultCustody = { scheme: 'keychain' } as VaultCustody

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'vcust-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A fake `security` with an in-memory keychain keyed by service and account, shared by both products. */
function sharedKeychain(items = new Map<string, string>()) {
  const make = () =>
    fakeSpawner(({ file, args, stdin }) => {
      // A key file's folder and file have no ACL entries (the macOS check of the key file custodian).
      if (file.endsWith('/ls')) return { code: 0, stdout: 'drwx------  2 me  staff  64 Nov  8 03:00 .\n' }
      const service = args[args.indexOf('-s') + 1] ?? ''
      const acct = args[args.indexOf('-a') + 1] ?? ''
      const key = `${service}\u0000${acct}`
      if (args[0] === 'default-keychain') return { code: 0, stdout: `    "${LOGIN}"\n` }
      if (args[0] === 'show-keychain-info') return { code: 0, stdout: 'ok\n' }
      if (args[0] === 'find-generic-password') {
        const v = items.get(key)
        if (v === undefined) return { code: 44, stderr: 'The specified item could not be found in the keychain.' }
        return args.includes('-w') ? { code: 0, stdout: `${v}\n` } : { code: 0, stdout: 'attributes:\n' }
      }
      if (args[0] === 'delete-generic-password') return items.delete(key) ? { code: 0 } : { code: 44, stderr: 'could not be found' }
      if (args[0] === '-i') {
        const m = /^add-generic-password -s "([^"]+)" -a "([0-9a-f]{32})" -w "([A-Za-z0-9+/=]+)"\n$/.exec(stdin)
        if (!m) return { code: 0, stderr: 'parse error' }
        items.set(`${m[1]}\u0000${m[2]}`, m[3]!)
        return { code: 0 }
      }
      return { code: 1 }
    })
  return { items, make }
}

describe('vaultNames', () => {
  it('the CLI has its own service, attributes, label, DPAPI entropy and variables; the desktop keeps its old ones', () => {
    expect(vaultNames('desktop')).toMatchObject({ keyFileEnv: 'ORGAI_VAULT_KEY_FILE', noOsKeystoreEnv: 'ORGAI_VAULT_NO_OS_KEYSTORE', keychainService: 'OrgAI Vault', secretServiceAttribute: 'orgai', secretServiceLabel: 'OrgAI vault' })
    expect(vaultNames('cli')).toMatchObject({ keyFileEnv: 'ORGAI_CLI_VAULT_KEY_FILE', noOsKeystoreEnv: 'ORGAI_CLI_VAULT_NO_OS_KEYSTORE', keychainService: 'OrgAI CLI Vault', secretServiceAttribute: 'orgai-cli', secretServiceLabel: 'OrgAI CLI vault' })
    expect(dpapiEntropy(ID)).toBe(`orgai.vault/1:${ID}`)
    expect(dpapiEntropy(ID, 'cli')).toBe(`orgai-cli.vault/1:${ID}`)
    expect(vaultNames()).toBe(vaultNames('desktop'))
  })
})

describe('keychain custody per product', () => {
  it('each product writes and finds its own item; the other cannot open it, and removing one leaves the other', async () => {
    const kc = sharedKeychain()
    const fs = kc.make()
    const cli = createCustodian('keychain', { dataDir: '/d', userDataDir: '/u', product: 'cli', spawner: fs.spawner, env: macEnv, platform: 'darwin' })
    const app = createCustodian('keychain', { dataDir: '/d', userDataDir: '/u', product: 'desktop', spawner: fs.spawner, env: macEnv, platform: 'darwin' })
    const cliKey = (await cli.create(ID)).dek
    const appKey = (await app.create(ID)).dek
    expect([...kc.items.keys()].sort()).toEqual([`OrgAI CLI Vault\u0000${ID}`, `OrgAI Vault\u0000${ID}`])
    expect((await cli.open(ID, CUSTODY)).equals(cliKey)).toBe(true)
    expect((await app.open(ID, CUSTODY)).equals(appKey)).toBe(true)
    // An item only the desktop made is invisible to the CLI under the same vault id, and the other way round.
    await app.create(ID2)
    await expect(cli.open(ID2, CUSTODY)).rejects.toMatchObject({ kind: 'missing' })
    await cli.removeItem(ID, CUSTODY)
    expect(kc.items.has(`OrgAI CLI Vault\u0000${ID}`)).toBe(false)
    expect(kc.items.has(`OrgAI Vault\u0000${ID}`)).toBe(true)
  })

  it('the CLI wording names its own variable and item, never the app variable', async () => {
    const f = fakeSpawner(() => ({ code: 44, stderr: 'The specified item could not be found in the keychain.' }))
    const cli = createCustodian('keychain', { dataDir: '/d', userDataDir: '/u', product: 'cli', spawner: f.spawner, env: macEnv, platform: 'darwin' })
    const err = (await cli.open(ID, CUSTODY).catch((e: unknown) => e)) as CustodyError
    expect(err.reason).toContain('OrgAI CLI Vault item')
    expect(err.reason).not.toMatch(/ORGAI_VAULT_/)
  })
})

describe('Secret Service custody per product', () => {
  const env = { HOME: '/home/me', PATH: '/usr/bin', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }
  const run = async (product: 'cli' | 'desktop') => {
    const items = new Set<string>()
    const f = fakeSpawner(({ args }): FakeAnswer => {
      if (args[0] === 'lookup') return items.has(args.join(' ')) ? { code: 0, stdout: 'x' } : { code: 1 }
      if (args[0] === 'store') return { code: 0 }
      return { code: 0 }
    })
    const c = new SecretServiceCustodian({ spawner: f.spawner, env, platform: 'linux', isFile: (p) => p === '/usr/bin/secret-tool', product })
    await c.create(ID).catch(() => undefined)
    return f.calls.map((x) => x.args)
  }

  it('the CLI stores under `service orgai-cli vault <id>` with label "OrgAI CLI vault"; the desktop is unchanged', async () => {
    const cli = await run('cli')
    expect(cli.find((a) => a[0] === 'store')).toEqual(['store', '--label=OrgAI CLI vault', 'service', 'orgai-cli', 'vault', ID])
    const app = await run('desktop')
    expect(app.find((a) => a[0] === 'store')).toEqual(['store', '--label=OrgAI vault', 'service', 'orgai', 'vault', ID])
  })
})

describe('DPAPI custody per product', () => {
  it('the CLI wraps with its own entropy label; the desktop script is unchanged', () => {
    expect(dpapiProtectScript(ID, 'cli')).toContain(`'orgai-cli.vault/1:${ID}'`)
    expect(dpapiProtectScript(ID)).toContain(`'orgai.vault/1:${ID}'`)
    expect(dpapiUnprotectScript('AAAA', ID, 'cli')).toContain(`'orgai-cli.vault/1:${ID}'`)
    expect(dpapiUnprotectScript('AAAA', ID, 'cli')).not.toContain(`'orgai.vault/1:${ID}'`)
  })

  it('the custodian passes its product to the script', async () => {
    const f = fakeSpawner(() => ({ code: 0, stdout: 'ERR:other\n' }))
    const c = new DpapiCustodian({ spawner: f.spawner, env: { SystemRoot: 'C:\\Windows' }, platform: 'win32', product: 'cli' })
    await c.create(ID).catch(() => undefined)
    expect(f.calls[0]!.stdin).toContain(`orgai-cli.vault/1:${ID}`)
  })
})

describe('key file variables stay separate', () => {
  it('the scheme choice reads only the product variable', () => {
    const appVar = { ORGAI_VAULT_KEY_FILE: '/k' }
    const cliVar = { ORGAI_CLI_VAULT_KEY_FILE: '/k' }
    expect(chooseCustodyScheme({ env: appVar, product: 'desktop', platform: 'darwin' })).toBe('key-file')
    expect(chooseCustodyScheme({ env: appVar, product: 'cli', platform: 'darwin' })).toBe('keychain')
    expect(chooseCustodyScheme({ env: cliVar, product: 'cli', platform: 'darwin' })).toBe('key-file')
    expect(chooseCustodyScheme({ env: cliVar, product: 'desktop', platform: 'darwin' })).toBe('keychain')
  })

  it('a key file custodian uses only its own product variable', () => {
    const mk = (product: 'cli' | 'desktop', env: Record<string, string>) => new KeyFileCustodian({ dataDir: '/d/data', userDataDir: '/d', product, env, platform: 'linux' })
    expect(mk('cli', { ORGAI_CLI_VAULT_KEY_FILE: '/keys/cli' }).configuredPath()).toBe('/keys/cli')
    expect(mk('cli', { ORGAI_VAULT_KEY_FILE: '/keys/app' }).configuredPath()).toBeUndefined()
    expect(mk('desktop', { ORGAI_VAULT_KEY_FILE: '/keys/app' }).configuredPath()).toBe('/keys/app')
    expect(mk('desktop', { ORGAI_CLI_VAULT_KEY_FILE: '/keys/cli' }).configuredPath()).toBeUndefined()
  })

  it('the CLI key file is refused inside the desktop default folder and when it is the desktop variable\'s file', async () => {
    const mk = (env: Record<string, string>, keyFile: string) =>
      new KeyFileCustodian({ dataDir: '/home/me/cli/data', userDataDir: '/home/me/cli', product: 'cli', env: { HOME: '/home/me', ...env }, platform: 'linux', keyFile })
    const inApp = mk({}, '/home/me/.config/OrgAI/vault.key')
    await expect(inApp.create(ID)).rejects.toMatchObject({ kind: 'denied', message: expect.stringContaining("app's data folder") })
    const same = mk({ ORGAI_VAULT_KEY_FILE: '/keys/app.key' }, '/keys/app.key')
    await expect(same.create(ID)).rejects.toMatchObject({ kind: 'denied', message: expect.stringContaining('share one key') })
    // The desktop itself may use its own default folder, and a different file is fine for the CLI.
    const ok = mk({ ORGAI_VAULT_KEY_FILE: '/keys/app.key' }, '/keys/cli.key')
    await expect(ok.create(ID)).rejects.not.toMatchObject({ kind: 'denied' })
  })

  it('the desktop key file is refused when it is the file the CLI variable names', async () => {
    const mk = (env: Record<string, string>, keyFile: string) =>
      new KeyFileCustodian({ dataDir: '/home/me/app/data', userDataDir: '/home/me/app', product: 'desktop', env: { HOME: '/home/me', ...env }, platform: 'linux', keyFile })
    const same = mk({ ORGAI_CLI_VAULT_KEY_FILE: '/keys/cli.key' }, '/keys/cli.key')
    await expect(same.create(ID)).rejects.toMatchObject({ kind: 'denied', message: expect.stringContaining('share one key') })
    const ok = mk({ ORGAI_CLI_VAULT_KEY_FILE: '/keys/cli.key' }, '/keys/app.key')
    await expect(ok.create(ID)).rejects.not.toMatchObject({ kind: 'denied' })
  })

  it('the factory ignores a key file named by the other product', () => {
    const factory = createCustodianFactory({ dataDir: '/d/data', userDataDir: '/d', product: 'cli', env: { ORGAI_VAULT_KEY_FILE: '/keys/app' }, platform: 'linux' })
    const c = factory('key-file', {}) as KeyFileCustodian
    expect(c.configuredPath()).toBeUndefined()
  })

  it('a CLI store does not create a key-file vault from the app variable, and names its own variable when no store works', async () => {
    const root = tmp()
    const store = await openSecretStore({ dataDir: join(root, 'data'), userDataDir: root, hostKind: 'inproc', product: 'cli', cipher: noCipher, env: { ORGAI_VAULT_KEY_FILE: join(root, 'k') }, platform: 'aix', log: () => undefined, retryMs: 0 })
    await expect(store.prepareWrite()).rejects.toThrow(/ORGAI_CLI_VAULT_KEY_FILE/)
    store.dispose()
  })
})

type Product = 'cli' | 'desktop'
const SERVICE: Record<Product, string> = { cli: 'OrgAI CLI Vault', desktop: 'OrgAI Vault' }

/** Two stores on one shared fake keychain, one per product, each with its own spawner so the calls can be told apart. */
async function bothProducts() {
  const kc = sharedKeychain()
  const spawners = { cli: kc.make(), desktop: kc.make() }
  const dirs2 = { cli: tmp(), desktop: tmp() }
  const open = (product: Product) => {
    const dir = dirs2[product]
    const dataDir = join(dir, 'data')
    return openSecretStore({
      dataDir,
      userDataDir: dir,
      hostKind: 'inproc',
      product,
      cipher: noCipher,
      platform: 'darwin',
      env: macEnv,
      custodian: createCustodianFactory({ dataDir, userDataDir: dir, product, spawner: spawners[product].spawner, env: macEnv, platform: 'darwin' }),
      log: () => undefined,
      retryMs: 0
    })
  }
  const itemsOf = (product: Product): string[] => [...kc.items.entries()].filter(([k]) => k.startsWith(`${SERVICE[product]}\u0000`)).map(([k, v]) => `${k}=${v}`)
  const callsMention = (product: Product, other: Product): boolean =>
    spawners[product].calls.some((c) => `${c.args.join(' ')} ${c.stdin}`.replace(SERVICE.cli, '').includes(SERVICE.desktop) && other === 'desktop') ||
    spawners[product].calls.some((c) => `${c.args.join(' ')} ${c.stdin}`.includes(SERVICE.cli) && other === 'cli')
  return { open, itemsOf, callsMention, dirs: dirs2 }
}

describe('reset and rotation in one product leave the other untouched', () => {
  for (const [actor, other] of [['cli', 'desktop'], ['desktop', 'cli']] as const) {
    it(`a ${actor} reset never touches the ${other} item or value, and ${actor} only ever names its own service`, async () => {
      const w = await bothProducts()
      const a = await w.open(actor)
      const b = await w.open(other)
      await a.prepareWrite()
      a.set('k', `${actor}-value`)
      await b.prepareWrite()
      b.set('k', `${other}-value`)
      const otherItems = w.itemsOf(other)
      expect(otherItems).toHaveLength(1)
      expect(w.itemsOf(actor)).toHaveLength(1)

      await a.resetVault({ confirm: true })
      await a.prepareWrite()
      a.set('k', `${actor}-value-2`)

      // The other vault and its item are as they were; the reset created a second item of the actor, never touched the other's.
      expect(w.itemsOf(other)).toEqual(otherItems)
      expect(b.get('k')).toBe(`${other}-value`)
      expect(a.get('k')).toBe(`${actor}-value-2`)
      expect(w.callsMention(actor, other)).toBe(false)
      a.dispose()
      b.dispose()
    })

    it(`rotating the ${actor} key (reset, then a new key file imported) leaves the ${other} item and value alone`, async () => {
      const w = await bothProducts()
      const a = await w.open(actor)
      const b = await w.open(other)
      await a.prepareWrite()
      a.set('k', 'before')
      await b.prepareWrite()
      b.set('k', `${other}-value`)
      const otherItems = w.itemsOf(other)
      const keyDir = tmp()
      const first = join(keyDir, 'first.key')
      const second = join(keyDir, 'second.key')
      writeFileSync(second, randomBytes(32), { mode: 0o600 })

      await a.resetVault({ confirm: true })
      expect((await a.initVault({ keyFile: first })).action).toBe('created')
      a.set('k', 'with-first-key')
      await a.resetVault({ confirm: true })
      expect((await a.initVault({ keyFile: second, importKeyFile: true })).action).toBe('created')
      a.set('k', 'with-second-key')
      expect(a.currentCustody()).toMatchObject({ scheme: 'key-file', keyFile: expect.stringMatching(/second\.key$/) })

      expect(w.itemsOf(other)).toEqual(otherItems)
      expect(b.get('k')).toBe(`${other}-value`)
      expect(b.currentCustody()).toMatchObject({ scheme: 'keychain' })
      expect(w.callsMention(actor, other)).toBe(false)
      a.dispose()
      b.dispose()
    })
  }
})
