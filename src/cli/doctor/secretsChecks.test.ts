import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SecretsStatusResult } from '../../shared/types'
import { VAULT_MESSAGES } from '../../main/store/vaultTypes'
import { fakeContext, FakeHostClient, rpcError } from '../testing/fakeContext'
import { hostSecretsChecks, offlineSecretsChecks, secretsChecks } from './secretsChecks'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-doctor-secrets-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const status = (over: Partial<SecretsStatusResult> = {}): SecretsStatusResult => ({
  state: 'open',
  scheme: 'keychain',
  counts: { vault: 2, legacy: 1, unreadable: 0, overlay: 0 },
  pendingLegacy: 0,
  softDeletes: [],
  orphanedKeys: 0,
  orphanedVaults: [],
  legacyFile: 'ok',
  canWriteBack: false,
  ...over
})

const byId = (checks: { id: string; status: string; detail: string }[]) => Object.fromEntries(checks.map((c) => [c.id, c]))

describe('doctor: the secret vault through the host', () => {
  it('an open vault with a reachable key store is all ok', () => {
    const c = byId(hostSecretsChecks(status({ probe: { ok: true } })))
    expect(c.vault).toMatchObject({ status: 'ok', detail: 'Open (macOS keychain); 2 secrets in it' })
    expect(c['vault-key-store']).toMatchObject({ status: 'ok' })
    expect(c['legacy-secrets']).toMatchObject({ status: 'ok', detail: "secrets.json (the app's copy): 1 key" })
  })

  it('locked, pending, unreadable, legacy removals and orphans warn; corrupt fails; never a value', () => {
    const locked = byId(
      hostSecretsChecks(
        status({
          state: 'locked',
          reason: 'The secret vault is locked: unlock it',
          probe: { ok: false, kind: 'locked', reason: 'Run security unlock-keychain' },
          counts: { vault: 2, legacy: 3, unreadable: 3, overlay: 0 },
          pendingLegacy: 2,
          softDeletes: [{ key: 'k', by: 'legacy', at: 1, restorable: 'here' }],
          orphanedKeys: 1,
          orphanedVaults: [{ vaultId: 'v', scheme: 'keychain', file: 'vault.json.reset-1' }],
          legacyFile: 'corrupt'
        })
      )
    )
    expect(locked.vault).toMatchObject({ status: 'warn', detail: 'locked (macOS keychain): The secret vault is locked: unlock it' })
    expect(locked['vault-key-store']).toMatchObject({ status: 'warn', detail: 'macOS keychain: locked: Run security unlock-keychain' })
    expect(locked['vault-pending']).toMatchObject({ status: 'warn', detail: `2 secrets not shared with the orgai command yet. ${VAULT_MESSAGES.pendingLegacy}` })
    expect(locked['vault-unreadable']).toMatchObject({ status: 'warn' })
    expect(locked['vault-removed']).toMatchObject({ status: 'warn', detail: expect.stringContaining('1 removed by an older OrgAI') })
    expect(locked['vault-orphans']).toMatchObject({ status: 'warn' })
    expect(locked['legacy-secrets']).toMatchObject({ status: 'warn' })
    expect(byId(hostSecretsChecks(status({ state: 'corrupt', reason: VAULT_MESSAGES.corrupt }))).vault).toMatchObject({ status: 'fail', detail: VAULT_MESSAGES.corrupt })
  })

  it('asks the host with a probe, and falls back to the files when the host does not answer', async () => {
    const ok = new FakeHostClient({ 'secrets:status': () => status() })
    const f = fakeContext({ paths: { userDataDir: dir, dataDir: dir } })
    expect((await secretsChecks({ ctx: f.ctx, client: ok })).map((c) => c.id)).toEqual(['vault', 'legacy-secrets'])
    expect(ok.callsOf('secrets:status')).toEqual([[{ probe: true }]])
    const old = new FakeHostClient({
      'secrets:status': () => {
        throw rpcError({ code: 'unknown_channel', message: 'Unknown channel: secrets:status' })
      }
    })
    const checks = await secretsChecks({ ctx: f.ctx, client: old })
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ['vault-host', 'warn'],
      ['vault', 'ok'],
      ['legacy-secrets', 'ok']
    ])
  })
})

describe('doctor: the secret vault without a host (metadata only)', () => {
  it('no files: nothing created yet, no legacy copy', () => {
    expect(offlineSecretsChecks(dir).map((c) => [c.id, c.status, c.detail])).toEqual([
      ['vault', 'ok', 'Not created yet; the first saved secret (or the app) creates it'],
      ['legacy-secrets', 'ok', "secrets.json (the app's copy): none"]
    ])
  })

  it('a valid vault is counted from its metadata; a damaged one fails; a damaged secrets.json warns', () => {
    const vault = {
      format: 'orgai.vault/1',
      vaultId: '0123456789abcdef0123456789abcdef',
      custody: { scheme: 'key-file', keyFile: '/k' },
      check: { iv: 'a', ct: 'b', tag: 'c' },
      entries: { a: {}, b: {} },
      tombstones: { c: {} },
      legacy: {},
      legacyRetired: null
    }
    writeFileSync(join(dir, 'vault.json'), JSON.stringify(vault))
    writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ version: 1, secrets: { x: 'Y2lwaGVy', y: 'Y2lwaGVy' } }))
    const c = byId(offlineSecretsChecks(dir))
    expect(c.vault).toMatchObject({ status: 'ok', detail: 'Present (key file): 2 secrets, 1 removed secret kept; not opened (no host is running)' })
    expect(c['legacy-secrets'].detail).toBe("secrets.json (the app's copy): 2 keys")
    writeFileSync(join(dir, 'vault.json'), '{nope')
    writeFileSync(join(dir, 'secrets.json'), '[]')
    const d = byId(offlineSecretsChecks(dir))
    expect(d.vault).toMatchObject({ status: 'fail', detail: VAULT_MESSAGES.corrupt })
    expect(d['legacy-secrets'].status).toBe('warn')
  })

  it('without a client the group reads the files', async () => {
    const f = fakeContext({ paths: { userDataDir: dir, dataDir: dir } })
    expect((await secretsChecks({ ctx: f.ctx })).map((c) => c.id)).toEqual(['vault', 'legacy-secrets'])
  })
})
