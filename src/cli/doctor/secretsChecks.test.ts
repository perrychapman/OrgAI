import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SecretsStatusResult } from '../../shared/types'
import { CLI_VAULT_MESSAGES as VAULT_MESSAGES } from '../../main/store/vaultTypes'
import { fakeContext, FakeHostClient, rpcError } from '../testing/fakeContext'
import { hostSecretsChecks, offlineSecretsChecks, pendingLegacyCount, secretsChecks } from './secretsChecks'

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

describe('doctor: secure storage through the host', () => {
  it('an open vault with a reachable key store is all ok', () => {
    const c = byId(hostSecretsChecks(status({ probe: { ok: true } })))
    expect(c.vault).toMatchObject({ status: 'ok', detail: 'Open (macOS keychain); 2 secrets in it' })
    expect(c['vault-key-store']).toMatchObject({ status: 'ok' })
    expect(c['legacy-secrets']).toMatchObject({ status: 'ok', detail: "secrets.json (an older copy): 1 key" })
  })

  it('locked, pending, unreadable, legacy removals and orphans warn; corrupt fails; never a value', () => {
    const locked = byId(
      hostSecretsChecks(
        status({
          state: 'locked',
          reason: 'Secure storage is locked: unlock it',
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
    expect(locked.vault).toMatchObject({ status: 'warn', detail: 'locked (macOS keychain): Secure storage is locked: unlock it' })
    expect(locked['vault-key-store']).toMatchObject({ status: 'warn', detail: 'macOS keychain: locked: Run security unlock-keychain' })
    expect(locked['vault-pending']).toMatchObject({ status: 'warn', detail: `2 secrets not readable by the orgai command. ${VAULT_MESSAGES.pendingLegacy}` })
    expect(locked['vault-unreadable']).toMatchObject({ status: 'warn' })
    expect(locked['vault-removed']).toMatchObject({ status: 'warn', detail: expect.stringContaining('1 removed by an older OrgAI') })
    expect(locked['vault-orphans']).toMatchObject({ status: 'warn' })
    expect(locked['legacy-secrets']).toMatchObject({ status: 'warn' })
    expect(byId(hostSecretsChecks(status({ state: 'corrupt', reason: VAULT_MESSAGES.corrupt }))).vault).toMatchObject({ status: 'fail', detail: VAULT_MESSAGES.corrupt })
  })

  it("'absent' is fine on a background host (created lazily) but warns on an app host, where creation failed (5.6)", () => {
    // A Node or inproc host: the first saved secret creates it.
    expect(byId(hostSecretsChecks(status({ state: 'absent', counts: { vault: 0, legacy: 0, unreadable: 0, overlay: 0 } }))).vault).toMatchObject({
      status: 'ok',
      detail: 'Not created yet (macOS keychain); the first saved secret creates it'
    })
    // An app host (it writes the app's copy back): the vault should exist since boot, so the app runs legacy-only.
    const app = byId(
      hostSecretsChecks(
        status({ state: 'absent', scheme: 'secret-service', canWriteBack: true, probe: { ok: false, kind: 'unavailable', reason: 'No Secret Service is running (install gnome-keyring)' } })
      )
    )
    expect(app.vault).toMatchObject({ status: 'warn', detail: expect.stringContaining('No Secret Service is running (install gnome-keyring)') })
    expect(app.vault.detail).toContain('`orgai secrets init`')
    expect(app['vault-key-store']).toMatchObject({ status: 'warn' })
    // A reason from the store wins over the probe; without either the check still warns.
    expect(byId(hostSecretsChecks(status({ state: 'absent', canWriteBack: true, reason: 'The disk is full' }))).vault).toMatchObject({ status: 'warn', detail: expect.stringContaining('The disk is full') })
    expect(byId(hostSecretsChecks(status({ state: 'absent', canWriteBack: true }))).vault.status).toBe('warn')
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

const CT = { iv: Buffer.alloc(12, 1).toString('base64'), ct: Buffer.from('cipher').toString('base64'), tag: Buffer.alloc(16, 2).toString('base64') }
const ENTRY = { ...CT, at: 1, lc: true }

describe('doctor: secure storage without a host (metadata only)', () => {
  it('no files: nothing created yet, no legacy copy', () => {
    expect(offlineSecretsChecks(dir).map((c) => [c.id, c.status, c.detail])).toEqual([
      ['vault', 'ok', 'Not created yet; the first saved secret creates it'],
      ['legacy-secrets', 'ok', "secrets.json (an older copy): none"]
    ])
  })

  it('a valid vault is counted from its metadata; a damaged one fails; a damaged secrets.json warns', () => {
    const vault = {
      format: 'orgai.vault/1',
      vaultId: '0123456789abcdef0123456789abcdef',
      custody: { scheme: 'key-file', keyFile: '/k' },
      check: CT,
      entries: { a: ENTRY, b: ENTRY },
      tombstones: { c: { at: 1, by: 'legacy' } },
      legacy: {},
      legacyRetired: null
    }
    writeFileSync(join(dir, 'vault.json'), JSON.stringify(vault))
    writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ version: 1, secrets: { x: 'Y2lwaGVy', y: 'Y2lwaGVy' } }))
    const c = byId(offlineSecretsChecks(dir))
    expect(c.vault).toMatchObject({ status: 'ok', detail: 'Present (key file): 2 secrets, 1 removed secret kept; not opened (no host is running)' })
    expect(c['legacy-secrets'].detail).toBe("secrets.json (an older copy): 2 keys")
    writeFileSync(join(dir, 'vault.json'), '{nope')
    writeFileSync(join(dir, 'secrets.json'), '[]')
    const d = byId(offlineSecretsChecks(dir))
    expect(d.vault).toMatchObject({ status: 'fail', detail: VAULT_MESSAGES.corrupt })
    expect(d['legacy-secrets'].status).toBe('warn')
  })

  const sha = (v: string): string => createHash('sha256').update(v, 'utf8').digest('hex')
  const vaultWith = (over: Record<string, unknown>) => ({
    format: 'orgai.vault/1',
    vaultId: '0123456789abcdef0123456789abcdef',
    custody: { scheme: 'keychain' },
    check: CT,
    entries: {},
    tombstones: {},
    legacy: {},
    legacyRetired: null,
    ...over
  })

  it('counts pending-legacy secrets from hashes alone, with the open-the-app hint (5.4, 5.5 rows 3 and 4)', () => {
    // No vault: every key in secrets.json is pending on a Node or inproc host.
    writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ version: 1, secrets: { a: 'QQ==', b: 'Qg==', c: 'Qw==', d: 'RA==' } }))
    expect(byId(offlineSecretsChecks(dir))['vault-pending']).toMatchObject({ status: 'warn', detail: `4 secrets not readable by the orgai command. ${VAULT_MESSAGES.pendingLegacy}` })
    // A vault: a = baseline (reconciled), b = changed since, c = never reconciled, d = a vault delete of exactly that value.
    writeFileSync(
      join(dir, 'vault.json'),
      JSON.stringify(vaultWith({ entries: { a: ENTRY, b: ENTRY }, legacy: { a: sha('QQ=='), b: sha('old'), d: sha('RA==') }, tombstones: { d: { at: 1, by: 'vault', legacyHash: sha('RA==') } } }))
    )
    const c = byId(offlineSecretsChecks(dir))
    expect(c['vault-pending']).toMatchObject({ status: 'warn', detail: `2 secrets not readable by the orgai command. ${VAULT_MESSAGES.pendingLegacy}` })
    expect(JSON.stringify(offlineSecretsChecks(dir))).not.toContain('QQ==')
    // Everything reconciled: no pending line.
    writeFileSync(join(dir, 'secrets.json'), JSON.stringify({ version: 1, secrets: { a: 'QQ==' } }))
    expect(byId(offlineSecretsChecks(dir))['vault-pending']).toBeUndefined()
    // After retirement the retired baseline is the only one (round 6 item 1).
    writeFileSync(join(dir, 'vault.json'), JSON.stringify(vaultWith({ legacy: { a: sha('QQ==') }, legacyRetired: { at: 1, digest: 'a'.repeat(64), keys: { a: sha('other') } } })))
    expect(byId(offlineSecretsChecks(dir))['vault-pending']).toMatchObject({ detail: expect.stringMatching(/^1 secret not readable/) })
    // A damaged vault reads nothing from the legacy copy: no pending count.
    writeFileSync(join(dir, 'vault.json'), '{nope')
    expect(byId(offlineSecretsChecks(dir))['vault-pending']).toBeUndefined()
  })

  it('pendingLegacyCount follows the reconcile rows', () => {
    const view = { entries: new Set(['a']), baseline: { a: sha('A') }, tombstones: {} }
    expect(pendingLegacyCount({ a: 'A' }, view)).toBe(0)
    expect(pendingLegacyCount({ a: 'A2' }, view)).toBe(1)
    expect(pendingLegacyCount({ z: 'Z' }, view)).toBe(1)
    expect(pendingLegacyCount({ z: 'Z' }, { ...view, tombstones: { z: { by: 'vault', legacyHash: sha('Z') } } })).toBe(0)
    expect(pendingLegacyCount({ z: 'Z' }, { ...view, tombstones: { z: { by: 'vault', legacyHash: sha('other') } } })).toBe(1)
    expect(pendingLegacyCount({ a: 'A', b: 'B' }, null)).toBe(2)
  })

  it('reports secrets an older OrgAI removed (the 5.5 notice) from the tombstones', () => {
    writeFileSync(join(dir, 'vault.json'), JSON.stringify(vaultWith({ tombstones: { k1: { at: 1, by: 'legacy' }, k2: { at: 1, by: 'legacy' }, k3: { at: 1, by: 'vault' } } })))
    expect(byId(offlineSecretsChecks(dir))['vault-removed']).toMatchObject({ status: 'warn', detail: expect.stringContaining(VAULT_MESSAGES.legacyRemovedNotice(2)) })
  })

  it('without a client the group reads the files', async () => {
    const f = fakeContext({ paths: { userDataDir: dir, dataDir: dir } })
    expect((await secretsChecks({ ctx: f.ctx })).map((c) => c.id)).toEqual(['vault', 'legacy-secrets'])
  })
})
