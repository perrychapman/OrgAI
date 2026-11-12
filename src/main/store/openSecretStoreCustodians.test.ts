/**
 * Wave 7 integration: openSecretStore's default custodian factory is the REAL one (src/main/store/custodians), with no
 * fake anywhere. Only the key-file scheme is driven (a file in a temp folder outside the data folder): the OS schemes
 * would write real keychain / DPAPI / Secret Service items, which no test may do.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { privateTempDir } from '../testSupport/privateTempDir'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openSecretStore } from './secrets'
import { noCipher, fakeCipher } from './vaultTesting'
import { VAULT_KEY_FILE_ENV, type VaultFile } from './vaultTypes'

let root: string
let keyDir: string
let dataDir: string
let keyFile: string

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'vault-real-')))
  keyDir = privateTempDir('vault-real-key-')
  chmodSync(keyDir, 0o700)
  dataDir = join(root, 'data')
  mkdirSync(dataDir)
  keyFile = join(keyDir, 'vault.key')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(keyDir, { recursive: true, force: true })
})

const env = (): NodeJS.ProcessEnv => ({ [VAULT_KEY_FILE_ENV]: keyFile })
const open = (hostKind: 'inproc' | 'desktop', extra: Record<string, unknown> = {}) =>
  openSecretStore({ dataDir, userDataDir: root, hostKind, product: 'desktop', cipher: hostKind === 'desktop' ? fakeCipher() : noCipher, env: env(), log: () => undefined, retryMs: 0, ...extra })
const vaultJson = (): VaultFile => JSON.parse(readFileSync(join(dataDir, 'vault.json'), 'utf8')) as VaultFile

describe('openSecretStore with its default (real) custodians', () => {
  it('a background host creates a key-file vault on the first value and a later host reads it back', async () => {
    const node = await open('inproc')
    expect(node.state()).toBe('absent')
    expect(existsSync(keyFile)).toBe(false)
    await node.prepareWrite()
    node.set('litellm.apiKey', 'sk-real')
    expect(node.state()).toBe('open')
    expect(vaultJson().custody).toMatchObject({ scheme: 'key-file' })
    expect(readFileSync(join(dataDir, 'vault.json'), 'utf8')).not.toContain('sk-real')
    if (process.platform !== 'win32') expect(statSync(keyFile).mode & 0o077).toBe(0)

    const again = await open('inproc')
    expect(again.state()).toBe('open')
    expect(again.get('litellm.apiKey')).toBe('sk-real')
    node.dispose()
    again.dispose()
  })

  it('an app host creates the vault at once; the key file is the recorded path when the environment no longer names it', async () => {
    const app = await open('desktop')
    expect(app.state()).toBe('open')
    app.set('mcplib:x', 'v1')
    app.dispose()
    const later = await open('inproc', { env: {} })
    expect(later.state()).toBe('open')
    expect(later.get('mcplib:x')).toBe('v1')
    later.dispose()
  })

  it('secrets init --key-file creates a new key file on a background host (the request reaches the custodian)', async () => {
    const asked = join(keyDir, 'asked.key')
    const node = await open('inproc', { env: {} })
    const r = await node.initVault({ keyFile: asked })
    expect(r.action).toBe('created')
    expect(existsSync(asked)).toBe(true)
    expect(vaultJson().custody).toMatchObject({ scheme: 'key-file', keyFile: asked })
    node.dispose()
  })

  it('a key file inside the data folder is refused', async () => {
    const node = await open('inproc', { env: { [VAULT_KEY_FILE_ENV]: join(dataDir, 'k') } })
    await expect(node.prepareWrite()).rejects.toThrow()
    expect(existsSync(join(dataDir, 'vault.json'))).toBe(false)
    node.dispose()
  })
})
