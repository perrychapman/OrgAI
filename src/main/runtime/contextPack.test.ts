import { execFileSync } from 'node:child_process'
import { closeSync, constants, linkSync, mkdirSync, mkdtempSync, openSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_HOOK_CONTEXT_INLINE_MAX,
  CONTEXT_PACK_FILE_MAX_CHARS,
  CONTEXT_PACK_HEADING,
  CONTEXT_PACK_MAX_FILES,
  CONTEXT_PACK_TOTAL_MAX_CHARS,
  briefFiles,
  contextPackOpenFlags,
  handlePointsAt,
  neutralizeClosingTags,
  protectedFileKeys,
  buildContextPack,
  contextPackBlock,
  contextPackRefusal,
  contextPackResultLine,
  contextPackRoots,
  withContextPack,
  type ContextPackOptions
} from './contextPack'
import { controlProtectedPaths } from './selfControlGate'

// The race tests swap a file between the checks and the open: openSync runs `hooks.beforeOpen` first (unset otherwise);
// `hooks.beforeRealpath` runs before each realpathSync.native, `hooks.beforeStat` before each statSync (both persist
// until unset), and `hooks.readlink` answers readlinkSync of a /proc/self/fd path (the Linux handle check).
const hooks = vi.hoisted(() => ({
  beforeOpen: undefined as ((path: string) => void) | undefined,
  beforeRealpath: undefined as ((path: string) => void) | undefined,
  beforeStat: undefined as ((path: string) => void) | undefined,
  readlink: undefined as ((path: string) => string) | undefined
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const openSync = ((...args: Parameters<typeof actual.openSync>) => {
    const hook = hooks.beforeOpen
    hooks.beforeOpen = undefined
    hook?.(String(args[0]))
    return actual.openSync(...args)
  }) as typeof actual.openSync
  const native = ((...args: Parameters<typeof actual.realpathSync.native>) => {
    hooks.beforeRealpath?.(String(args[0]))
    return actual.realpathSync.native(...args)
  }) as typeof actual.realpathSync.native
  const realpathSync = Object.assign((...args: Parameters<typeof actual.realpathSync>) => actual.realpathSync(...args), { native }) as typeof actual.realpathSync
  const statSync = ((...args: Parameters<typeof actual.statSync>) => {
    hooks.beforeStat?.(String(args[0]))
    return actual.statSync(...args)
  }) as typeof actual.statSync
  const readlinkSync = ((...args: Parameters<typeof actual.readlinkSync>) => {
    if (hooks.readlink && String(args[0]).startsWith('/proc/self/fd/')) return hooks.readlink(String(args[0]))
    return actual.readlinkSync(...args)
  }) as typeof actual.readlinkSync
  const over = { openSync, realpathSync, statSync, readlinkSync }
  return { ...actual, ...over, default: { ...actual, ...over } }
})

const posix = process.platform !== 'win32'

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
  afterEach(() => {
    hooks.beforeOpen = undefined
    hooks.beforeRealpath = undefined
    hooks.beforeStat = undefined
    hooks.readlink = undefined
    rmSync(base, { recursive: true, force: true })
  })

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
    // Entries past the limit collapse into one line, however many there are.
    const many = buildContextPack(Array.from({ length: CONTEXT_PACK_MAX_FILES + 500 }, () => 'src/a.ts'), opts())
    expect(many.files).toHaveLength(1)
    expect(many.skipped).toHaveLength(CONTEXT_PACK_MAX_FILES - 1 + 1)
    expect(many.skipped.at(-1)).toEqual({ path: 'and 500 more', reason: 'not considered, over the 8-file limit' })
  })

  it('no existence oracle: an outside path reads the same whether it exists or not, also behind a linked folder', () => {
    symlinkSync(outside, join(proj, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    const pack = buildContextPack([join(outside, 'secret.txt'), join(outside, 'missing.txt'), '/no/such/dir/x', '../outside/secret.txt', '../outside/missing.txt', 'linked/secret.txt', 'linked/missing.txt', 'linked/no/x'], opts())
    expect(pack.files).toEqual([])
    expect(new Set(pack.skipped.map((s) => s.reason))).toEqual(new Set(['outside the folders the report may read']))
    expect(pack.skipped).toHaveLength(8)
  })

  it.skipIf(!posix)('a file swapped for a link to an outside file between the checks and the open is skipped', () => {
    writeFileSync(join(proj, 'swap.txt'), 'inside')
    hooks.beforeOpen = (path) => {
      unlinkSync(path)
      symlinkSync(join(outside, 'secret.txt'), path)
    }
    const pack = buildContextPack(['swap.txt'], opts())
    expect(pack.files).toEqual([])
    expect(pack.skipped).toEqual([{ path: 'swap.txt', reason: 'unreadable' }])
  })

  it.skipIf(!posix)('a file swapped for a link to a control file is skipped', () => {
    const data = join(base, 'data')
    mkdirSync(data)
    writeFileSync(join(data, 'secrets.json'), '{"key":"s3cret"}')
    writeFileSync(join(proj, 'swap.json'), '{}')
    hooks.beforeOpen = (path) => {
      unlinkSync(path)
      symlinkSync(join(data, 'secrets.json'), path)
    }
    const pack = buildContextPack(['swap.json'], opts({ protectedPaths: controlProtectedPaths(data) }))
    expect(pack.files).toEqual([])
    expect(pack.skipped).toEqual([{ path: 'swap.json', reason: 'unreadable' }])
    expect(contextPackBlock(pack)).not.toContain('s3cret')
  })

  it.skipIf(!posix)('a parent folder swapped for a link between the checks and the open is skipped', () => {
    mkdirSync(join(proj, 'dir'))
    writeFileSync(join(proj, 'dir', 'secret.txt'), 'inside')
    hooks.beforeOpen = () => {
      rmSync(join(proj, 'dir'), { recursive: true })
      symlinkSync(outside, join(proj, 'dir'), 'dir')
    }
    const pack = buildContextPack(['dir/secret.txt'], opts())
    expect(pack.files).toEqual([])
    expect(pack.skipped).toEqual([{ path: 'dir/secret.txt', reason: 'unreadable' }])
  })

  it.skipIf(!posix)('a file swapped for a FIFO is skipped at once, never blocking', () => {
    writeFileSync(join(proj, 'pipe.txt'), 'inside')
    hooks.beforeOpen = (path) => {
      unlinkSync(path)
      execFileSync('mkfifo', [path])
    }
    const started = Date.now()
    const pack = buildContextPack(['pipe.txt'], opts())
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(pack.files).toEqual([])
    expect(pack.skipped).toEqual([{ path: 'pipe.txt', reason: 'not a file' }])
  }, 5_000)

  it('a hard link to a control file is refused, also to one inside a protected folder', () => {
    const data = join(base, 'data')
    mkdirSync(join(data, 'codex'), { recursive: true })
    writeFileSync(join(data, 'secrets.json'), '{"key":"s3cret"}')
    writeFileSync(join(data, 'codex', 'auth.json'), '{"token":"t0ken"}')
    linkSync(join(data, 'secrets.json'), join(proj, 'notes.json'))
    linkSync(join(data, 'codex', 'auth.json'), join(proj, 'auth-copy.json'))
    const pack = buildContextPack(['notes.json', 'auth-copy.json', 'src/a.ts'], opts({ protectedPaths: controlProtectedPaths(data) }))
    expect(pack.skipped).toEqual([
      { path: 'notes.json', reason: "OrgAI's control files are never shared" },
      { path: 'auth-copy.json', reason: "OrgAI's control files are never shared" }
    ])
    expect(pack.files.map((f) => f.path)).toEqual(['src/a.ts'])
  })

  it.skipIf(!posix)('A: a parent swapped three times (link at the open, folder at the re-resolve, link at the stat) never inlines the outside control file', () => {
    // The reviewer's case: <data>/codex/auth.json (one link, so no hard-link walk was ever done before this pass).
    const data = join(base, 'data')
    mkdirSync(join(data, 'codex'), { recursive: true })
    writeFileSync(join(data, 'codex', 'auth.json'), '{"token":"t0ken"}')
    mkdirSync(join(proj, 'dir'))
    writeFileSync(join(proj, 'dir', 'auth.json'), '{}')
    const toLink = (): void => {
      rmSync(join(proj, 'dir'), { recursive: true, force: true })
      symlinkSync(join(data, 'codex'), join(proj, 'dir'), 'dir')
    }
    const toFolder = (): void => {
      rmSync(join(proj, 'dir'), { recursive: true, force: true })
      mkdirSync(join(proj, 'dir'))
      writeFileSync(join(proj, 'dir', 'auth.json'), '{}')
    }
    // The open sees a link; the re-resolve after it sees a real folder again; the stat after that a link again.
    hooks.beforeOpen = () => {
      toLink()
      hooks.beforeRealpath = () => {
        hooks.beforeRealpath = undefined
        toFolder()
        hooks.beforeStat = () => {
          hooks.beforeStat = undefined
          toLink()
        }
      }
    }
    const pack = buildContextPack(['dir/auth.json'], opts({ protectedPaths: controlProtectedPaths(data) }))
    expect(pack.files).toEqual([])
    expect(pack.skipped).toHaveLength(1)
    // macOS: the open refuses the linked component (O_NOFOLLOW_ANY); Linux: /proc/self/fd names another file; the
    // protected set refuses it everywhere.
    expect(['unreadable', "OrgAI's control files are never shared"]).toContain(pack.skipped[0]!.reason)
    expect(contextPackBlock(pack)).not.toContain('t0ken')
  })

  it.skipIf(process.platform !== 'darwin')('A (macOS): the open refuses a link in any component of the checked path', () => {
    mkdirSync(join(proj, 'dir'))
    writeFileSync(join(proj, 'dir', 'x.txt'), 'inside')
    writeFileSync(join(outside, 'x.txt'), 'not yours')
    // A parent swapped for a link between the checks and the open; the re-resolve and the stat see the folder again.
    hooks.beforeOpen = () => {
      renameSync(join(proj, 'dir'), join(proj, 'dir-real'))
      symlinkSync(outside, join(proj, 'dir'), 'dir')
      hooks.beforeRealpath = () => {
        hooks.beforeRealpath = undefined
        unlinkSync(join(proj, 'dir'))
        renameSync(join(proj, 'dir-real'), join(proj, 'dir'))
      }
    }
    const pack = buildContextPack(['dir/x.txt'], opts())
    expect(pack.skipped).toEqual([{ path: 'dir/x.txt', reason: 'unreadable' }])
    expect(contextPackOpenFlags('darwin') & 0x20000000).toBe(0x20000000)
    expect(contextPackOpenFlags('darwin') & constants.O_NOFOLLOW).toBe(0)
    expect(contextPackOpenFlags('linux') & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW)
    expect(contextPackOpenFlags('linux') & 0x20000000).toBe(0)
  })

  it('A: O_NOCTTY on every platform that defines it; on Linux the handle must point at the checked real path', () => {
    for (const pl of ['darwin', 'linux', 'win32'] as const) expect(contextPackOpenFlags(pl) & (constants.O_NOCTTY ?? 0)).toBe(constants.O_NOCTTY ?? 0)
    const fd = openSync(join(proj, 'src', 'a.ts'), 'r')
    try {
      hooks.readlink = () => '/real/path'
      expect(handlePointsAt(fd, '/real/path', 'linux')).toBe(true)
      expect(handlePointsAt(fd, '/other/path', 'linux')).toBe(false)
      hooks.readlink = () => {
        throw new Error('no /proc')
      }
      // Fails closed without /proc.
      expect(handlePointsAt(fd, '/real/path', 'linux')).toBe(false)
      // No handle path check on Windows (the dev and ino comparisons decide); macOS checked at the open.
      expect(handlePointsAt(fd, '/other/path', 'win32')).toBe(true)
      expect(handlePointsAt(fd, '/other/path', 'darwin')).toBe(true)
    } finally {
      closeSync(fd)
    }
  })

  it('A: the handle is compared with the protected set whatever its link count (a control file moved in between the checks and the open)', () => {
    const data = join(base, 'data')
    mkdirSync(join(data, 'codex'), { recursive: true })
    writeFileSync(join(data, 'codex', 'auth.json'), '{"token":"t0ken"}')
    writeFileSync(join(proj, 'moved.json'), '{}')
    hooks.beforeOpen = (path) => {
      // One link only: the protected set (collected before the first file) still knows its dev and ino.
      renameSync(join(data, 'codex', 'auth.json'), path)
    }
    const pack = buildContextPack(['moved.json'], opts({ protectedPaths: controlProtectedPaths(data) }))
    expect(pack.skipped).toEqual([{ path: 'moved.json', reason: "OrgAI's control files are never shared" }])
  })

  it('B: a hard link to a file the gate protects by name prefix (vault.json*, secrets.json.reset-*, .corrupt-*, .tmp) is refused', () => {
    const data = join(base, 'data')
    mkdirSync(join(data, 'run'), { recursive: true })
    writeFileSync(join(data, 'secrets.json'), '{}')
    const names = ['vault.json', 'vault.json.tmp', 'secrets.json.reset-1700000000', 'secrets.json.corrupt-1700000000', 'secrets.json.tmp']
    for (const [i, n] of names.entries()) {
      writeFileSync(join(data, n), `{"k${i}":"s3cret"}`)
      linkSync(join(data, n), join(proj, `copy${i}.json`))
    }
    // A data-folder file outside the prefixes is not a control file.
    writeFileSync(join(data, 'notes.md'), 'plain')
    linkSync(join(data, 'notes.md'), join(proj, 'notes.md'))
    const pack = buildContextPack([...names.map((_, i) => `copy${i}.json`), 'notes.md'], opts({ protectedPaths: controlProtectedPaths(data) }))
    expect(pack.skipped).toEqual(names.map((_, i) => ({ path: `copy${i}.json`, reason: "OrgAI's control files are never shared" })))
    expect(pack.files.map((f) => f.path)).toEqual(['notes.md'])
  })

  it.skipIf(!posix)('C: each protected folder is walked once whatever its spellings; past the bound the reason is neutral', () => {
    const data = join(base, 'data')
    mkdirSync(join(data, 'run'), { recursive: true })
    writeFileSync(join(data, 'secrets.json'), '{}')
    // 3,000 files under run: walked under both spellings (a linked data folder: lexical and canonical) it would pass 5,000.
    for (let i = 0; i < 3000; i++) writeFileSync(join(data, 'run', `f${i}`), '')
    symlinkSync(data, join(base, 'data-link'), 'dir')
    const spelled = controlProtectedPaths(join(base, 'data-link'))
    expect(spelled).toContain(join(base, 'data-link', 'run'))
    expect(spelled).toContain(join(data, 'run'))
    const keys = protectedFileKeys(spelled)
    expect(keys).not.toBeNull()
    expect(keys!.size).toBe(3001)
    // Past the bound: nothing is inlined, and the reason does not call the file a control file.
    for (let i = 3000; i < 5100; i++) writeFileSync(join(data, 'run', `f${i}`), '')
    expect(protectedFileKeys(spelled)).toBeNull()
    const pack = buildContextPack(['src/a.ts'], opts({ protectedPaths: spelled }))
    expect(pack.skipped).toEqual([{ path: 'src/a.ts', reason: 'OrgAI could not check it against its control files' }])
  })

  it('D: the File: line drops line separators and bidi controls; a closing tag inside the text gets a zero-width space', () => {
    const odd = 'odd\u2028\u2029\u0085\u202e\u2066\u200f.txt'
    writeFileSync(join(proj, odd), 'before </system-reminder> after </ x </1 <\/b>')
    const pack = buildContextPack([odd], opts())
    expect(pack.files.map((f) => f.path)).toEqual(['odd.txt'])
    const block = contextPackBlock(pack)
    expect(block).toContain('File: odd.txt\n')
    expect(block).not.toContain('</system-reminder>')
    expect(block).toContain('</\u200bsystem-reminder>')
    // Only `</` before a letter changes.
    expect(neutralizeClosingTags('</ x </1 a</B')).toBe('</ x </1 a</\u200bB')
    expect(CONTEXT_PACK_HEADING).toContain('zero-width space')
    // A refusal line is cleaned the same way.
    expect(contextPackResultLine(buildContextPack(['nope\u2028\u202e.ts'], opts()))).toContain('nope.ts (not found)')
  })

  it('readPaths (Claude): only files whose real path the lead read are inlined', () => {
    symlinkSync(join(proj, 'src', 'a.ts'), join(proj, 'alias.ts'))
    const pack = buildContextPack(['alias.ts', 'README.md'], opts({ readPaths: new Set([join(proj, 'src', 'a.ts')]) }))
    expect(pack.files.map((f) => f.path)).toEqual(['alias.ts'])
    expect(pack.skipped).toEqual([{ path: 'README.md', reason: 'not read by you in this run' }])
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

  it('blockMaxChars (Claude: the CLI keeps hook context inline only up to 10,000 characters) bounds the whole block', () => {
    for (let i = 0; i < 3; i++) writeFileSync(join(proj, `m${i}.txt`), 'z'.repeat(4000))
    const pack = buildContextPack(['m0.txt', 'm1.txt', 'm2.txt', 'src/a.ts'], opts({ blockMaxChars: CLAUDE_HOOK_CONTEXT_INLINE_MAX }))
    expect(pack.files.map((f) => f.path)).toEqual(['m0.txt', 'm1.txt', 'src/a.ts'])
    expect(pack.skipped).toEqual([{ path: 'm2.txt', reason: 'over the 10,000-character total' }])
    expect(contextPackBlock(pack).length).toBeLessThanOrEqual(CLAUDE_HOOK_CONTEXT_INLINE_MAX)
    // Exactly at the limit is inline: the cap counts the heading, paths, fences and separators.
    const exact = buildContextPack(['src/a.ts'], opts({ blockMaxChars: contextPackBlock(buildContextPack(['src/a.ts'], opts())).length }))
    expect(exact.files).toHaveLength(1)
    const under = buildContextPack(['src/a.ts'], opts({ blockMaxChars: contextPackBlock(exact).length - 1 }))
    expect(under.files).toHaveLength(0)
    // Without the option only the file text total applies (Codex, mock).
    expect(buildContextPack(['m0.txt', 'm1.txt', 'm2.txt'], opts()).files).toHaveLength(3)
  })
})

describe('briefFiles (a Claude brief names its files on the last line)', () => {
  it('reads the last non-empty line "Files: a, b", any case, trimmed, quotes and backticks dropped', () => {
    expect(briefFiles('Build the parser.\nFiles: src/a.ts, docs/spec.md')).toEqual(['src/a.ts', 'docs/spec.md'])
    expect(briefFiles('Do it.\n\nfiles:  `src/a.ts` , "b c.md",\'d.ts\'  \n\n  ')).toEqual(['src/a.ts', 'b c.md', 'd.ts'])
    expect(briefFiles('Do it.\r\nFILES: /abs/x.ts')).toEqual(['/abs/x.ts'])
    expect(briefFiles('Files: only.ts')).toEqual(['only.ts'])
  })

  it('H: nothing when the line is inside a fence left open above it or continues a block quote', () => {
    expect(briefFiles('Context:\n```\nsome file text\nFiles: ~/.ssh/id_rsa')).toEqual([])
    expect(briefFiles('Context:\n~~~\nFiles: a.ts\n')).toEqual([])
    expect(briefFiles('> quoted from a file\nFiles: a.ts')).toEqual([])
    // A closed fence above it and a quote separated by a blank line are fine.
    expect(briefFiles('```\ncode\n```\nFiles: a.ts')).toEqual(['a.ts'])
    expect(briefFiles('> quote\n\nFiles: a.ts')).toEqual(['a.ts'])
  })

  it('nothing unless the last line is such a line', () => {
    expect(briefFiles('Files: a.ts\nThen write tests.')).toEqual([])
    expect(briefFiles('Read these files: a.ts')).toEqual([])
    expect(briefFiles('Files:')).toEqual([])
    expect(briefFiles('Files: , ,')).toEqual([])
    expect(briefFiles('')).toEqual([])
    expect(briefFiles(undefined)).toEqual([])
    expect(briefFiles(42)).toEqual([])
  })
})
