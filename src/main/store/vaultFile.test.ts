import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloneVault, parseVaultFile, readLegacyFile, readVaultFile, serializeLegacyFile, serializeVaultFile, validateVaultFile, validSecretKey } from './vaultFile'

const ct = { iv: Buffer.alloc(12, 1).toString('base64'), ct: Buffer.from('cipher').toString('base64'), tag: Buffer.alloc(16, 2).toString('base64') }
const H = 'a'.repeat(64)
const valid = {
  format: 'orgai.vault/1',
  vaultId: '0123456789abcdef0123456789abcdef',
  custody: { scheme: 'key-file', keyFile: '/keys/orgai.key' },
  check: ct,
  entries: { 'connection:litellm:apiKey': { ...ct, at: 1, lc: true } },
  tombstones: { 'mcp:p:s:env:X': { at: 2, by: 'vault', prev: ct, legacyHash: H }, 'mcp:p:s:env:Y': { at: 3, by: 'legacy', prevLegacy: 'djEw' } },
  legacy: { 'connection:litellm:apiKey': H },
  legacyRetired: null
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vfile-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('vault.json validation (cli-standalone.md 5.2)', () => {
  it('accepts the format and round-trips through serialisation', () => {
    const v = validateVaultFile(valid)
    expect(v).toBeDefined()
    const again = parseVaultFile(serializeVaultFile(v!))
    expect(again).toEqual(v)
    expect(validateVaultFile({ ...valid, legacyRetired: { at: 4, digest: H, keys: { a: H } } })?.legacyRetired?.keys.a).toBe(H)
    expect(validateVaultFile({ ...valid, custody: { scheme: 'dpapi-user', wrapped: 'AAAA' } })).toBeDefined()
    // unknown top-level fields are ignored, not kept
    expect(Object.keys(validateVaultFile({ ...valid, extra: 1 })!)).not.toContain('extra')
  })

  it.each([
    ['not an object', []],
    ['format', { ...valid, format: 'orgai.vault/2' }],
    ['vault id', { ...valid, vaultId: 'ABCDEF' }],
    ['scheme', { ...valid, custody: { scheme: 'plaintext' } }],
    ['dpapi without wrapped', { ...valid, custody: { scheme: 'dpapi-user' } }],
    ['wrapped not base64', { ...valid, custody: { scheme: 'dpapi-user', wrapped: '%%' } }],
    ['check missing', { ...valid, check: undefined }],
    ['iv length', { ...valid, check: { ...ct, iv: Buffer.alloc(16).toString('base64') } }],
    ['tag length', { ...valid, entries: { k: { ...ct, tag: Buffer.alloc(12).toString('base64'), at: 1, lc: true } } }],
    ['base64 shape', { ...valid, entries: { k: { ...ct, ct: 'a-b_', at: 1, lc: true } } }],
    ['lc type', { ...valid, entries: { k: { ...ct, at: 1, lc: 'yes' } } }],
    ['at type', { ...valid, entries: { k: { ...ct, at: -1, lc: true } } }],
    ['tombstone by', { ...valid, tombstones: { k: { at: 1, by: 'someone' } } }],
    ['tombstone hash', { ...valid, tombstones: { k: { at: 1, by: 'vault', legacyHash: 'xyz' } } }],
    ['legacy hash', { ...valid, legacy: { k: 'nothex' } }],
    ['legacy array', { ...valid, legacy: [] }],
    ['retired digest', { ...valid, legacyRetired: { at: 1, digest: 'd', keys: {} } }],
    ['retired missing', { ...valid, legacyRetired: undefined }],
    ['NUL key', { ...valid, entries: { 'a\u0000b': { ...ct, at: 1, lc: true } } }]
  ])('refuses %s (corrupt)', (_name, v) => {
    expect(validateVaultFile(v)).toBeUndefined()
  })

  it('treats __proto__ as an ordinary key and clones deeply', () => {
    const v = parseVaultFile(JSON.stringify({ ...valid, entries: JSON.parse(`{"__proto__": ${JSON.stringify({ ...ct, at: 1, lc: false })}}`) }))!
    expect(Object.keys(v.entries)).toEqual(['__proto__'])
    expect(Object.getPrototypeOf(v.entries)).toBeNull()
    const c = cloneVault(v)
    c.entries.__proto__!.lc = true
    expect(v.entries.__proto__!.lc).toBe(false)
    expect(validSecretKey('')).toBe(false)
  })

  it('reads absent, corrupt and valid files; a directory in its place is corrupt', () => {
    const p = join(dir, 'vault.json')
    expect(readVaultFile(p)).toEqual({ kind: 'absent' })
    writeFileSync(p, '{')
    expect(readVaultFile(p)).toEqual({ kind: 'corrupt' })
    writeFileSync(p, JSON.stringify(valid))
    expect(readVaultFile(p).kind).toBe('vault')
    rmSync(p)
    mkdirSync(p)
    expect(readVaultFile(p)).toEqual({ kind: 'corrupt' })
  })
})

describe('secrets.json states (cli-standalone.md 5.5 Legacy file states)', () => {
  it('ok, missing and corrupt; non-string values are ignored as the older app does', () => {
    const p = join(dir, 'secrets.json')
    expect(readLegacyFile(p)).toEqual({ state: 'missing' })
    writeFileSync(p, 'not json')
    expect(readLegacyFile(p)).toEqual({ state: 'corrupt' })
    writeFileSync(p, JSON.stringify({ version: 1, secrets: [] }))
    expect(readLegacyFile(p)).toEqual({ state: 'corrupt' })
    writeFileSync(p, JSON.stringify({ version: 1 }))
    expect(readLegacyFile(p)).toEqual({ state: 'corrupt' })
    const bytes = serializeLegacyFile({ a: 'x' })
    writeFileSync(p, JSON.stringify({ version: 1, secrets: { a: 'x', b: 2 } }))
    const r = readLegacyFile(p)
    expect(r.state).toBe('ok')
    if (r.state === 'ok') expect({ ...r.values }).toEqual({ a: 'x' })
    expect(JSON.parse(bytes.toString('utf8'))).toEqual({ version: 1, secrets: { a: 'x' } })
  })
})
