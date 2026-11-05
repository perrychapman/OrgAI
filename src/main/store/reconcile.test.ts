import { describe, expect, it } from 'vitest'
import { baselineOf, legacyIsNewer, planReconcile, planRetirement, retirementBlocker, type LegacyView, type ReconcileCrypto } from './reconcile'
import { sha256Hex } from './vaultCrypto'
import { dict } from './vaultFile'
import { VAULT_TOMBSTONE_KEEP_MS, type VaultCipherText, type VaultEntry, type VaultFile, type VaultTombstone } from './vaultTypes'

/** Readable stand-ins: the vault "encrypts" to base64 of `V:<plain>`, safeStorage to `L:<plain>`. */
const seal = (plain: string): VaultCipherText => ({
  iv: Buffer.alloc(12).toString('base64'),
  ct: Buffer.from(`V:${plain}`).toString('base64'),
  tag: Buffer.alloc(16).toString('base64')
})
const unseal = (c: VaultCipherText): string => {
  const s = Buffer.from(c.ct, 'base64').toString('utf8')
  if (!s.startsWith('V:')) throw new Error('bad')
  return s.slice(2)
}
const crypto: ReconcileCrypto = {
  legacyDecrypt: (l) => {
    if (!l.startsWith('L:')) throw new Error('undecryptable')
    return l.slice(2)
  },
  legacyEncrypt: (p) => `L:${p}`,
  vaultDecrypt: (_k, c) => unseal(c),
  vaultEncrypt: (_k, p) => seal(p)
}
const entry = (plain: string, lc: boolean, at = 1): VaultEntry => ({ ...seal(plain), at, lc })
const h = (l: string): string => sha256Hex(l)

function vault(parts: { entries?: Record<string, VaultEntry>; tombstones?: Record<string, VaultTombstone>; legacy?: Record<string, string>; retired?: Record<string, string> } = {}): VaultFile {
  const fill = <T,>(r: Record<string, T> = {}): Record<string, T> => Object.assign(dict<T>(), r)
  return {
    format: 'orgai.vault/1',
    vaultId: 'ab'.repeat(16),
    custody: { scheme: 'keychain' },
    check: seal('check'),
    entries: fill(parts.entries),
    tombstones: fill(parts.tombstones),
    legacy: fill(parts.legacy),
    legacyRetired: parts.retired ? { at: 1, digest: 'd'.repeat(64), keys: fill(parts.retired) } : null
  }
}
const ok = (values: Record<string, string> = {}): LegacyView => ({ state: 'ok', values: Object.assign(dict<string>(), values) })
const base = { mode: 'full' as const, dualWrite: true, now: 1000 }

describe('planReconcile rows (cli-standalone.md 5.5)', () => {
  it('row 1: the exact legacy value a delete targeted is removed from secrets.json, then its baseline (any host, no key)', () => {
    for (const mode of ['full', 'metadata'] as const) {
      const v = vault({ tombstones: { K: { at: 1, by: 'vault', legacyHash: h('L:old'), prev: seal('old') } }, legacy: { K: h('L:old') } })
      const p = planReconcile({ ...base, mode, vault: v, legacy: ok({ K: 'L:old', other: 'L:o' }) })
      expect(p.completedDeletes).toEqual(['K'])
      expect({ ...p.legacy }).toEqual({ other: 'L:o' })
      expect(baselineOf(p.vault!, 'K')).toBeUndefined()
      // the tombstone and its kept value stay (undelete)
      expect(p.vault!.tombstones.K?.prev).toBeDefined()
    }
  })

  it('row 1 never matches an older app\'s later replacement (another hash): that is row 4, an import', () => {
    const v = vault({ tombstones: { K: { at: 1, by: 'vault', legacyHash: h('L:old') } } })
    const p = planReconcile({ ...base, vault: v, legacy: ok({ K: 'L:new' }), crypto })
    expect(p.completedDeletes).toEqual([])
    expect(p.imported).toEqual(['K'])
    expect(p.vault!.tombstones.K).toBeUndefined()
    expect(unseal(p.vault!.entries.K!)).toBe('new')
  })

  it('row 2: a delete interrupted after its second step drops the baseline (metadata mode too)', () => {
    for (const mode of ['full', 'metadata'] as const) {
      const v = vault({ tombstones: { K: { at: 1, by: 'vault' } }, legacy: { K: h('L:x') } })
      const p = planReconcile({ ...base, mode, vault: v, legacy: ok({}) })
      expect(p.completedDeletes).toEqual(['K'])
      expect(p.legacy).toBeUndefined()
      expect(p.vault!.legacy.K).toBeUndefined()
      expect(p.softDeleted).toEqual([])
    }
  })

  it('metadata mode runs rows 1 and 2 only', () => {
    const v = vault({ entries: { A: entry('a', true), B: entry('b', false) }, legacy: { A: h('L:a') } })
    const p = planReconcile({ ...base, mode: 'metadata', vault: v, legacy: ok({ C: 'L:c' }) })
    expect(p).toMatchObject({ imported: [], wroteBack: [], softDeleted: [] })
    expect(p.vault).toBeUndefined()
    expect(p.legacy).toBeUndefined()
  })

  it('row 3: never reconciled -> import on a host that can write back, pending-legacy elsewhere', () => {
    const v = vault()
    const p = planReconcile({ ...base, vault: v, legacy: ok({ K: 'L:v' }), crypto })
    expect(p.imported).toEqual(['K'])
    expect(p.vault!.entries.K).toMatchObject({ lc: true, at: 1000 })
    expect(p.vault!.legacy.K).toBe(h('L:v'))
    const other = planReconcile({ ...base, vault: v, legacy: ok({ K: 'L:v' }) })
    expect(other.vault).toBeUndefined()
    expect(legacyIsNewer(v, 'K', h('L:v'))).toBe(true)
  })

  it('row 4: an older app wrote K after the last reconcile -> import over E or T', () => {
    const v = vault({ entries: { K: entry('vault-old', true) }, legacy: { K: h('L:old') } })
    const p = planReconcile({ ...base, vault: v, legacy: ok({ K: 'L:newer' }), crypto })
    expect(unseal(p.vault!.entries.K!)).toBe('newer')
    expect(p.vault!.legacy.K).toBe(h('L:newer'))
    const t = vault({ tombstones: { K: { at: 1, by: 'legacy', prev: seal('x') } } })
    const p2 = planReconcile({ ...base, vault: t, legacy: ok({ K: 'L:back' }), crypto })
    expect(p2.vault!.tombstones.K).toBeUndefined()
    expect(unseal(p2.vault!.entries.K!)).toBe('back')
  })

  it('rows 3/4 skip one undecryptable value with a note and reconcile the rest', () => {
    const p = planReconcile({ ...base, vault: vault(), legacy: ok({ bad: 'garbage', good: 'L:g' }), crypto })
    expect(p.imported).toEqual(['good'])
    expect(p.skipped).toEqual([{ key: 'bad', reason: 'legacy-undecryptable' }])
    expect(p.vault!.legacy.bad).toBeUndefined()
  })

  it('row 5: the vault is newer -> write back during the dual-write window only, by a host that can', () => {
    const v = vault({ entries: { K: entry('rotated', false) }, legacy: { K: h('L:old') } })
    const p = planReconcile({ ...base, vault: v, legacy: ok({ K: 'L:old' }), crypto })
    expect(p.wroteBack).toEqual(['K'])
    expect(p.legacy!.K).toBe('L:rotated')
    expect(p.vault!.legacy.K).toBe(h('L:rotated'))
    expect(p.vault!.entries.K!.lc).toBe(true)
    expect(planReconcile({ ...base, dualWrite: false, vault: v, legacy: ok({ K: 'L:old' }), crypto }).vault).toBeUndefined()
    expect(planReconcile({ ...base, vault: v, legacy: ok({ K: 'L:old' }) }).vault).toBeUndefined()
  })

  it('row 6: written only through the vault -> write back (recreates a missing secrets.json)', () => {
    const v = vault({ entries: { K: entry('only-vault', false) } })
    const p = planReconcile({ ...base, vault: v, legacy: ok({}), crypto })
    expect(p.legacy!.K).toBe('L:only-vault')
    const missing = planReconcile({ ...base, vault: v, legacy: { state: 'missing', values: dict() }, crypto })
    expect({ ...missing.legacy }).toEqual({ K: 'L:only-vault' })
  })

  it('row 7: the legacy copy disappeared -> soft delete keeping E (no key needed), whatever the number', () => {
    const v = vault({ entries: { A: entry('a', true), B: entry('b', true), C: entry('c', true) }, legacy: { A: h('L:a'), B: h('L:b'), C: h('L:c') } })
    const p = planReconcile({ ...base, vault: v, legacy: ok({ B: 'L:b' }) })
    expect(p.softDeleted.sort()).toEqual(['A', 'C'])
    expect(p.vault!.entries.A).toBeUndefined()
    expect(p.vault!.tombstones.A).toMatchObject({ by: 'legacy', at: 1000 })
    expect(unseal(p.vault!.tombstones.A!.prev!)).toBe('a')
    expect(p.vault!.legacy.A).toBeUndefined()
    expect(p.vault!.entries.B).toBeDefined()
  })

  it('row 8 and a missing file: baselines dropped, lc false, never deletions', () => {
    const v = vault({ entries: { A: entry('a', true) }, legacy: { A: h('L:a') } })
    expect(planReconcile({ ...base, vault: v, legacy: ok({ A: 'L:a' }), crypto }).vault).toBeUndefined()
    const p = planReconcile({ ...base, vault: v, legacy: { state: 'missing', values: dict() } })
    expect(p.softDeleted).toEqual([])
    expect(p.vault!.legacy.A).toBeUndefined()
    expect(p.vault!.entries.A!.lc).toBe(false)
  })

  it('a corrupt secrets.json stops every row (only key-independent tombstone upkeep runs)', () => {
    const v = vault({ entries: { A: entry('a', true) }, legacy: { A: h('L:a') }, tombstones: { T: { at: 1, by: 'vault', legacyHash: h('L:t') } } })
    const p = planReconcile({ ...base, vault: v, legacy: { state: 'corrupt', values: dict() }, crypto })
    expect(p.vault).toBeUndefined()
    expect(p.legacy).toBeUndefined()
    expect(p.softDeleted).toEqual([])
  })
})

describe('tombstones (5.2, round 6 item 3)', () => {
  it('a by-vault value goes after 30 days; a legacy one never on a timer; empty ones go once K is absent', () => {
    const old = 1000 - VAULT_TOMBSTONE_KEEP_MS - 1
    const v = vault({
      tombstones: {
        expired: { at: old, by: 'vault', prev: seal('x') },
        fresh: { at: 999, by: 'vault', prev: seal('y') },
        legacyOld: { at: old, by: 'legacy', prev: seal('z') },
        stillInFile: { at: old, by: 'vault', legacyHash: h('L:s') }
      }
    })
    const p = planReconcile({ ...base, vault: v, legacy: ok({ stillInFile: 'L:s2' }) })
    expect(p.vault!.tombstones.expired).toBeUndefined()
    expect(p.vault!.tombstones.fresh?.prev).toBeDefined()
    expect(p.vault!.tombstones.legacyOld?.prev).toBeDefined()
  })

  it('a prevLegacy is never collected; an app host with the vault open re-stores it as prev', () => {
    const old = 1000 - VAULT_TOMBSTONE_KEEP_MS - 1
    const v = vault({ tombstones: { K: { at: old, by: 'vault', prevLegacy: 'L:only-copy', legacyHash: h('L:only-copy') } } })
    const node = planReconcile({ ...base, vault: v, legacy: ok({}) })
    expect(node.vault).toBeUndefined()
    const fresh = vault({ tombstones: { K: { at: 999, by: 'vault', prevLegacy: 'L:only-copy' } } })
    const app = planReconcile({ ...base, vault: fresh, legacy: ok({}), crypto })
    expect(app.vault!.tombstones.K!.prevLegacy).toBeUndefined()
    expect(unseal(app.vault!.tombstones.K!.prev!)).toBe('only-copy')
    // converted after 30 days: the normal rule applies at once (the delete's own time)
    const converted = planReconcile({ ...base, vault: v, legacy: ok({}), crypto })
    expect(converted.vault!.tombstones.K).toBeUndefined()
  })

  it('a tombstone stays while its key is still in secrets.json', () => {
    const v = vault({ tombstones: { K: { at: 1, by: 'vault' } } })
    // L present without a matching hash: row 4 imports over it on an app host; elsewhere the tombstone stays
    const p = planReconcile({ ...base, vault: v, legacy: ok({ K: 'L:k' }) })
    expect(p.vault).toBeUndefined()
  })
})

describe('after retirement (5.5 Retirement, round 6 item 1)', () => {
  const retiredVault = (extra: Parameters<typeof vault>[0] = {}): VaultFile =>
    vault({ entries: { A: entry('a', true), B: entry('b', true) }, retired: { A: h('L:a'), B: h('L:b') }, ...extra })

  it('residue (H = keys[K]) is ignored and deleted once every key is resolved', () => {
    const p = planReconcile({ ...base, vault: retiredVault(), legacy: ok({ A: 'L:a', B: 'L:b' }) })
    expect(p.unlinkLegacy).toBe(true)
    expect(p.imported).toEqual([])
  })

  it('a changed or new key is newer: an app imports it and records keys[K] in the same write; a Node host keeps the file', () => {
    const app = planReconcile({ ...base, vault: retiredVault(), legacy: ok({ A: 'L:a', B: 'L:b2', C: 'L:c' }), crypto })
    expect(app.imported.sort()).toEqual(['B', 'C'])
    expect(app.vault!.legacyRetired!.keys.B).toBe(h('L:b2'))
    expect(app.vault!.legacyRetired!.keys.C).toBe(h('L:c'))
    expect(app.vault!.legacy).toEqual({})
    expect(app.unlinkLegacy).toBe(true)
    const node = planReconcile({ ...base, vault: retiredVault(), legacy: ok({ A: 'L:a', B: 'L:b2' }) })
    expect(node.unlinkLegacy).toBe(false)
    expect(legacyIsNewer(retiredVault(), 'B', h('L:b2'))).toBe(true)
    expect(legacyIsNewer(retiredVault(), 'A', h('L:a'))).toBe(false)
  })

  it('tombstone matching runs before any post-retirement import and drops keys[K]', () => {
    const v = retiredVault({ entries: { B: entry('b', true) }, tombstones: { A: { at: 1, by: 'vault', legacyHash: h('L:a'), prev: seal('a') } } })
    delete v.legacyRetired!.keys.A
    const p = planReconcile({ ...base, vault: v, legacy: ok({ A: 'L:a', B: 'L:b' }), crypto })
    expect(p.imported).toEqual([])
    expect(p.completedDeletes).toEqual(['A'])
    expect(p.unlinkLegacy).toBe(true)
  })

  it('rows 5 to 7 are off after retirement', () => {
    const v = retiredVault({ entries: { A: entry('a', false), B: entry('b', true) } })
    const p = planReconcile({ ...base, vault: v, legacy: ok({ B: 'L:b' }), crypto })
    expect(p.wroteBack).toEqual([])
    expect(p.softDeleted).toEqual([])
  })
})

describe('retirement (5.5)', () => {
  it('waits until everything is reconciled, then records the digest and the per-key baseline and clears legacy', () => {
    const v = vault({ entries: { A: entry('a', true) }, legacy: { A: h('L:a') } })
    const legacy = ok({ A: 'L:a' })
    const opts = { open: true, canWriteBack: true }
    expect(retirementBlocker(v, legacy, opts)).toBeUndefined()
    expect(retirementBlocker(v, legacy, { open: false, canWriteBack: true })).toBeDefined()
    expect(retirementBlocker(v, ok({ A: 'L:a', B: 'L:pending' }), opts)).toMatch(/not reconciled/)
    expect(retirementBlocker(vault({ ...v, legacy: { A: h('L:a') }, tombstones: { X: { at: 1, by: 'legacy', prev: seal('x') } }, entries: { A: entry('a', true) } }), legacy, opts)).toMatch(/soft delete/)
    expect(retirementBlocker(v, { state: 'missing', values: dict() }, opts)).toBeDefined()
    const bytes = Buffer.from('{"version":1,"secrets":{"A":"L:a"}}')
    const next = planRetirement(v, { values: legacy.values, bytes }, 5)
    expect(next.legacyRetired).toEqual({ at: 5, digest: sha256Hex(bytes), keys: { A: h('L:a') } })
    expect(next.legacy).toEqual({})
    expect(v.legacyRetired).toBeNull()
  })
})
