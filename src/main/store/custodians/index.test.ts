import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DpapiCustodian, KeyFileCustodian, KeychainCustodian, SecretServiceCustodian, chooseCustodyScheme, createCustodianFactory, custodianFor, platformCustodyScheme } from './index'

const dirs = { dataDir: '/u/data', userDataDir: '/u' }

describe('custodian factory (cli-standalone.md 5.3 choice of scheme)', () => {
  it('maps platforms to their OS scheme', () => {
    expect(platformCustodyScheme('darwin')).toBe('keychain')
    expect(platformCustodyScheme('win32')).toBe('dpapi-user')
    expect(platformCustodyScheme('linux')).toBe('secret-service')
    expect(platformCustodyScheme('freebsd')).toBeNull()
  })

  it('always opens a vault with its recorded scheme', () => {
    expect(chooseCustodyScheme({ recorded: { scheme: 'keychain' }, platform: 'linux', env: { ORGAI_VAULT_KEY_FILE: '/k' } })).toBe('keychain')
    expect(chooseCustodyScheme({ recorded: 'key-file', platform: 'darwin', env: {} })).toBe('key-file')
  })

  it('uses a key file for a new vault when one is configured or asked for, else the platform scheme', () => {
    expect(chooseCustodyScheme({ platform: 'darwin', env: { ORGAI_VAULT_KEY_FILE: '/k' } })).toBe('key-file')
    expect(chooseCustodyScheme({ platform: 'darwin', env: { ORGAI_VAULT_KEY_FILE: '  ' } })).toBe('keychain')
    expect(chooseCustodyScheme({ platform: 'win32', env: {}, keyFileRequested: true })).toBe('key-file')
    expect(chooseCustodyScheme({ platform: 'linux', env: {} })).toBe('secret-service')
    expect(chooseCustodyScheme({ platform: 'freebsd', env: {} })).toBeNull()
  })

  it('builds one custodian per scheme', () => {
    const f = createCustodianFactory({ ...dirs, env: {}, platform: 'darwin' })
    expect(f('keychain')).toBeInstanceOf(KeychainCustodian)
    expect(f('dpapi-user')).toBeInstanceOf(DpapiCustodian)
    expect(f('secret-service')).toBeInstanceOf(SecretServiceCustodian)
    expect(f('key-file')).toBeInstanceOf(KeyFileCustodian)
    for (const s of ['keychain', 'dpapi-user', 'secret-service', 'key-file'] as const) expect(f(s).scheme).toBe(s)
  })

  it('custodianFor picks the recorded custody (and its key file) or the scheme for a new vault', () => {
    const recorded = custodianFor({ ...dirs, env: {}, platform: 'darwin', recorded: { scheme: 'key-file', keyFile: '/keys/a' } })
    expect(recorded).toBeInstanceOf(KeyFileCustodian)
    expect((recorded as KeyFileCustodian).configuredPath()).toBe('/keys/a')
    expect(custodianFor({ ...dirs, env: {}, platform: 'darwin', keyFile: '/keys/b' })).toBeInstanceOf(KeyFileCustodian)
    expect(custodianFor({ ...dirs, env: {}, platform: 'linux' })).toBeInstanceOf(SecretServiceCustodian)
    expect(custodianFor({ ...dirs, env: {}, platform: 'aix' })).toBeNull()
  })

  it('tells a key-file custodian that a vault exists, so a gone key file probes as missing (review round 1)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orgai-factory-'))
    try {
      const gone = join(root, 'gone.key')
      const d = { dataDir: join(root, 'u', 'data'), userDataDir: join(root, 'u') }
      const existing = custodianFor({ ...d, env: { ORGAI_VAULT_KEY_FILE: gone }, recorded: { scheme: 'key-file', keyFile: join(root, 'old.key') } })
      await expect(existing!.probe()).resolves.toMatchObject({ ok: false, kind: 'missing' })
      const viaFactory = createCustodianFactory({ ...d, env: { ORGAI_VAULT_KEY_FILE: gone }, vaultExists: true })('key-file')
      await expect(viaFactory.probe()).resolves.toMatchObject({ ok: false, kind: 'missing' })
      const fresh = custodianFor({ ...d, env: { ORGAI_VAULT_KEY_FILE: gone } })
      await expect(fresh!.probe()).resolves.toEqual({ ok: true })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
