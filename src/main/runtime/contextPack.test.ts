import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CONTEXT_PACK_FILE_MAX_CHARS,
  CONTEXT_PACK_HEADING,
  CONTEXT_PACK_MAX_FILES,
  CONTEXT_PACK_TOTAL_MAX_CHARS,
  buildContextPack,
  contextPackBlock,
  contextPackRefusal,
  contextPackResultLine,
  contextPackRoots,
  withContextPack,
  type ContextPackOptions
} from './contextPack'
import { controlProtectedPaths } from './selfControlGate'

describe('context pack', () => {
  let base = ''
  let proj = ''
  let outside = ''
  beforeEach(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-pack-')))
    proj = join(base, 'proj')
    outside = join(base, 'outside')
    mkdirSync(join(proj, 'src'), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(proj, 'src', 'a.ts'), 'export const a = 1\n')
    writeFileSync(join(proj, 'README.md'), 'Hello ``` fenced ```` text')
    writeFileSync(join(outside, 'secret.txt'), 'not yours')
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  const opts = (over: Partial<ContextPackOptions> = {}): ContextPackOptions => ({ callerCwd: proj, readRoots: [proj], protectedPaths: [], ...over })

  it('inlines project files under the heading, each fenced with its path, relative paths from the lead\'s folder', () => {
    const pack = buildContextPack(['src/a.ts', join(proj, 'README.md')], opts())
    expect(pack.skipped).toEqual([])
    expect(pack.files.map((f) => f.path)).toEqual(['src/a.ts', join(proj, 'README.md')])
    const block = contextPackBlock(pack)
    expect(block.startsWith(CONTEXT_PACK_HEADING)).toBe(true)
    expect(block).toContain('File: src/a.ts\n```\nexport const a = 1\n```')
    // A fence longer than any backtick run in the file.
    expect(block).toContain('`````\nHello ``` fenced ```` text\n`````')
    expect(withContextPack('Brief', pack)).toBe(`Brief\n\n${block}`)
    expect(contextPackResultLine(pack)).toBe(`Inlined 2 files into its brief: src/a.ts, ${join(proj, 'README.md')}.`)
  })

  it('no files: nothing changes and the result gets no line', () => {
    for (const files of [undefined, [], 'x']) {
      const pack = buildContextPack(files, opts())
      expect(withContextPack('Brief', pack)).toBe('Brief')
      expect(contextPackResultLine(pack)).toBe('')
    }
  })

  it('refuses a path outside the folders the report may read, and a link that leads outside', () => {
    symlinkSync(join(outside, 'secret.txt'), join(proj, 'link.txt'))
    const pack = buildContextPack([join(outside, 'secret.txt'), '../outside/secret.txt', 'link.txt'], opts())
    expect(pack.files).toEqual([])
    expect(pack.skipped.map((s) => s.reason)).toEqual(['outside the folders the report may read', 'outside the folders the report may read', 'outside the folders the report may read'])
    expect(contextPackResultLine(pack)).toContain('link.txt (outside the folders the report may read)')
  })

  it('a reference or allowed folder counts as readable (contextPackRoots)', () => {
    const roots = contextPackRoots({ project: { path: proj }, referenceDirectories: () => [outside], allowedDirectories: () => { throw new Error('x') } }, [proj, undefined])
    expect(roots).toEqual([proj, outside])
    const pack = buildContextPack([join(outside, 'secret.txt')], opts({ readRoots: roots }))
    expect(pack.files.map((f) => f.text)).toEqual(['not yours'])
  })

  it('refuses OrgAI control files through the self-control gate, also through a link, and everything when the paths are unavailable', () => {
    const data = join(proj, 'data')
    mkdirSync(join(data, 'run'), { recursive: true })
    writeFileSync(join(data, 'secrets.json'), '{}')
    writeFileSync(join(data, 'vault.json.tmp'), '{}')
    writeFileSync(join(data, 'run', 'daemon.secret'), 'x')
    symlinkSync(join(data, 'secrets.json'), join(proj, 'innocent.json'))
    const protectedPaths = controlProtectedPaths(data)
    const pack = buildContextPack(['data/secrets.json', 'data/run/daemon.secret', 'data/vault.json.tmp', 'innocent.json', 'src/a.ts'], opts({ protectedPaths }))
    expect(pack.skipped.map((s) => s.reason)).toEqual(Array(4).fill("OrgAI's control files are never shared"))
    expect(pack.files.map((f) => f.path)).toEqual(['src/a.ts'])
    const none = buildContextPack(['src/a.ts'], opts({ pathsUnavailable: true }))
    expect(none.files).toEqual([])
    expect(none.skipped[0]!.reason).toBe('OrgAI could not check it against its control files')
  })

  it('text files only: NUL bytes and invalid UTF-8 are refused; folders and missing files too', () => {
    writeFileSync(join(proj, 'bin.dat'), Buffer.from([0x41, 0x00, 0x42]))
    writeFileSync(join(proj, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]))
    const pack = buildContextPack(['bin.dat', 'latin1.txt', 'src', 'nope.ts', '', 42], opts())
    expect(pack.skipped).toEqual([
      { path: 'bin.dat', reason: 'not a text file' },
      { path: 'latin1.txt', reason: 'not a text file' },
      { path: 'src', reason: 'not a file' },
      { path: 'nope.ts', reason: 'not found' },
      { path: '(empty)', reason: 'not a file path' },
      { path: '42', reason: 'not a file path' }
    ])
  })

  it('caps: per file, total and file count; duplicates are skipped', () => {
    writeFileSync(join(proj, 'big.txt'), 'x'.repeat(CONTEXT_PACK_FILE_MAX_CHARS + 1))
    for (let i = 0; i < 3; i++) writeFileSync(join(proj, `part${i}.txt`), 'y'.repeat(CONTEXT_PACK_FILE_MAX_CHARS))
    const pack = buildContextPack(['big.txt', 'part0.txt', 'part1.txt', 'part2.txt', './part0.txt'], opts())
    expect(pack.files.map((f) => f.path)).toEqual(['part0.txt', 'part1.txt'])
    expect(pack.skipped).toEqual([
      { path: 'big.txt', reason: 'longer than 24,000 characters' },
      { path: 'part2.txt', reason: 'over the 60,000-character total' },
      { path: './part0.txt', reason: 'listed twice' }
    ])
    expect(pack.files.reduce((n, f) => n + f.text.length, 0)).toBeLessThanOrEqual(CONTEXT_PACK_TOTAL_MAX_CHARS)
    const many = buildContextPack(Array.from({ length: CONTEXT_PACK_MAX_FILES + 2 }, () => 'src/a.ts'), opts())
    expect(many.files).toHaveLength(1)
    expect(many.skipped.filter((s) => s.reason === 'over the 8-file limit')).toHaveLength(2)
  })

  it('a trust-restricted or setup-like run gets no pack, and says why per file', () => {
    expect(contextPackRefusal({ quick: { team: 'single' } as never }, false)).toContain('not trusted')
    expect(contextPackRefusal({ buildWorkspace: '/x' }, false)).toContain('not trusted')
    expect(contextPackRefusal({}, true)).toContain('setup')
    expect(contextPackRefusal({}, false)).toBeUndefined()
    const pack = buildContextPack(['src/a.ts'], opts({ refuseAll: contextPackRefusal({ buildWorkspace: '/x' }, false) }))
    expect(pack.files).toEqual([])
    expect(contextPackResultLine(pack)).toContain('src/a.ts (this run\'s folder is not trusted')
  })
})
