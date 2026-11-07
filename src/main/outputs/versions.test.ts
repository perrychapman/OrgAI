import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OutputVersionMeta, StoredOutput } from './store'
import { ensureOutputDataDir, outputDataDir, pruneVersions, readSnapshot, removeOutputData, removeSnapshot, sha256, snapshotExt, snapshotPath, writeSnapshot } from './versions'

let data: string
beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'orgai-outver-'))
})
afterEach(() => rmSync(data, { recursive: true, force: true }))

const OID = 'out_0123456789abcdef'

describe('snapshots', () => {
  it('writes atomically under the generated name, reads back, removes', () => {
    const p = writeSnapshot(data, 'p1', OID, 1, 'md', Buffer.from('hello'))
    expect(p).toBe(join(data, 'projects', 'p1', 'outputs', OID, 'v1.md'))
    expect(readSnapshot(data, 'p1', OID, 1, 'md')?.toString()).toBe('hello')
    expect(readdirSync(outputDataDir(data, 'p1', OID)).filter((n) => n.endsWith('.tmp'))).toEqual([])
    writeSnapshot(data, 'p1', OID, 1, 'md', Buffer.from('again'))
    expect(readSnapshot(data, 'p1', OID, 1, 'md')?.toString()).toBe('again')
    removeSnapshot(data, 'p1', OID, 1, 'md')
    expect(readSnapshot(data, 'p1', OID, 1, 'md')).toBeNull()
  })
  it('refuses malformed ids, versions and extensions before any join', () => {
    expect(() => outputDataDir(data, 'p1', '../x')).toThrow()
    expect(() => outputDataDir(data, 'p1', 'out_ZZZ')).toThrow()
    expect(() => snapshotPath(data, 'p1', OID, 0, 'md')).toThrow()
    expect(() => snapshotPath(data, 'p1', OID, 1, '../md')).toThrow()
    expect(() => snapshotPath(data, '../p', OID, 1, 'md')).toThrow()
  })
  it('hashes and picks plain extensions', () => {
    expect(sha256(Buffer.from('a'))).toBe('ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb')
    expect(snapshotExt('/x/Report.DOCX')).toBe('docx')
    expect(snapshotExt('/x/noext')).toBe('bin')
    expect(snapshotExt('/x/a.verylongextension')).toBe('bin')
  })
  it('refuses a link in the data folder chain', () => {
    const elsewhere = join(data, '..', `${join(data).split(/[\\/]/).pop()}-else`)
    mkdirSync(elsewhere)
    try {
      mkdirSync(join(data, 'projects', 'p1'), { recursive: true })
      try {
        symlinkSync(elsewhere, join(data, 'projects', 'p1', 'outputs'), process.platform === 'win32' ? 'junction' : 'dir')
      } catch {
        return
      }
      expect(() => ensureOutputDataDir(data, 'p1', OID)).toThrow(/plain folder/)
      expect(() => writeSnapshot(data, 'p1', OID, 1, 'md', Buffer.from('x'))).toThrow()
      expect(readdirSync(elsewhere)).toEqual([])
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })
  it('removeOutputData removes the folder and never follows a link', () => {
    writeSnapshot(data, 'p1', OID, 1, 'md', Buffer.from('x'))
    writeFileSync(join(outputDataDir(data, 'p1', OID), 'notes.json'), '{}')
    removeOutputData(data, 'p1', OID)
    expect(existsSync(outputDataDir(data, 'p1', OID))).toBe(false)
    removeOutputData(data, 'p1', OID)
    // a link in place of the folder is unlinked, its target kept
    const elsewhere = join(data, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'keep.txt'), 'keep')
    mkdirSync(join(data, 'projects', 'p1', 'outputs'), { recursive: true })
    try {
      symlinkSync(elsewhere, outputDataDir(data, 'p1', OID), process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      return
    }
    removeOutputData(data, 'p1', OID)
    expect(readFileSync(join(elsewhere, 'keep.txt'), 'utf8')).toBe('keep')
  })
})

const meta = (n: number, over: Partial<OutputVersionMeta> = {}): OutputVersionMeta => ({ n, source: 'agent', createdAt: n, title: `T${n}`, bytes: 10, digest: 'a'.repeat(64), ext: 'md', ...over })
const out = (id: string, versions: OutputVersionMeta[]): StoredOutput =>
  ({ id, projectId: 'p1', runId: 'r', kind: 'markdown', title: 't', fileName: 'f.md', path: '/x/f.md', relPath: 'f.md', bytes: 1, createdAt: 1, source: 'produced', versions }) as StoredOutput

describe('pruneVersions', () => {
  it('drops the oldest version past the per-output cap but keeps v1, the current and a named one', () => {
    const o = out('out_1', [meta(1), meta(2), meta(3, { label: 'Final' }), meta(4), meta(5), meta(6)])
    const dropped = pruneVersions([o], { versionsMax: 4 })
    expect(dropped.map((d) => d.n)).toEqual([2, 4])
    expect(o.versions.map((v) => v.n)).toEqual([1, 3, 5, 6])
    expect(o.versionsPruned).toBe(true)
  })
  it('stops when nothing is droppable', () => {
    const o = out('out_1', [meta(1), meta(2, { label: 'a' }), meta(3)])
    expect(pruneVersions([o], { versionsMax: 1 })).toEqual([])
    expect(o.versions).toHaveLength(3)
  })
  it('applies the byte cap oldest first across outputs', () => {
    const a = out('out_a', [meta(1, { createdAt: 1 }), meta(2, { createdAt: 5 }), meta(3, { createdAt: 9 })])
    const b = out('out_b', [meta(1, { createdAt: 2 }), meta(2, { createdAt: 3 }), meta(3, { createdAt: 4 })])
    const dropped = pruneVersions([a, b], { bytesMax: 40 })
    expect(dropped.map((d) => `${d.outputId}:${d.n}`)).toEqual(['out_b:2', 'out_a:2'])
    expect(a.versionsPruned && b.versionsPruned).toBe(true)
    expect(a.versions.map((v) => v.n)).toEqual([1, 3])
  })
  it('leaves everything when under both caps', () => {
    const o = out('out_1', [meta(1), meta(2)])
    expect(pruneVersions([o])).toEqual([])
    expect(o.versionsPruned).toBeUndefined()
  })
})
