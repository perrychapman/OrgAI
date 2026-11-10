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
  buildContextPackFromTexts,
  completeReadText,
  CONTEXT_PACK_NOT_READ_IN_FULL,
  PROTECTED_SHALLOW_MAX,
  READ_TEXT_STORE_LIMITS,
  ReadTextStore,
  type ProtectedDeepCache,
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

  it.skipIf(!posix)('C: each protected folder is listed once whatever its spellings; past the bound the reason is neutral', () => {
    const data = join(base, 'data')
    mkdirSync(join(data, 'run'), { recursive: true })
    writeFileSync(join(data, 'secrets.json'), '{}')
    // 3,000 files under run: listed under both spellings (a linked data folder: lexical and canonical) it would pass 5,000.
    for (let i = 0; i < 3000; i++) writeFileSync(join(data, 'run', `f${i}`), '')
    symlinkSync(data, join(base, 'data-link'), 'dir')
    const spelled = controlProtectedPaths(join(base, 'data-link'))
    expect(spelled).toContain(join(base, 'data-link', 'run'))
    expect(spelled).toContain(join(data, 'run'))
    for (const deep of [false, true]) {
      const keys = protectedFileKeys(spelled, process.platform, deep, 5_000)
      expect(keys).not.toBeNull()
      expect(keys!.size).toBe(3001)
    }
    // Past the bound: nothing is inlined, and the reason does not call the file a control file.
    expect(protectedFileKeys(spelled, process.platform, false, 2_000)).toBeNull()
    for (let i = 3000; i < PROTECTED_SHALLOW_MAX + 10; i++) writeFileSync(join(data, 'run', `f${i}`), '')
    const pack = buildContextPack(['src/a.ts'], opts({ protectedPaths: spelled }))
    expect(pack.skipped).toEqual([{ path: 'src/a.ts', reason: 'OrgAI could not check it against its control files' }])
  }, 30_000)

  it.skipIf(!posix)('1: a protected folder with more than 5,000 entries below its top level leaves an ordinary single-link file inlined; a hard link into it is still refused', () => {
    const data = join(base, 'data')
    mkdirSync(join(data, 'codex', 'sessions', '2026', '11'), { recursive: true })
    writeFileSync(join(data, 'secrets.json'), '{}')
    writeFileSync(join(data, 'codex', 'auth.json'), '{"token":"t0ken"}')
    // A Codex home: a session file per thread, below the top level.
    for (let i = 0; i < 6_000; i++) writeFileSync(join(data, 'codex', 'sessions', '2026', '11', `rollout-${i}.jsonl`), '{}')
    const protectedPaths = controlProtectedPaths(data)
    // The shallow set is small: the top level only.
    expect(protectedFileKeys(protectedPaths, process.platform, false)!.size).toBeLessThan(10)
    // A hard link to a session file (two links: the deep walk runs) and an ordinary hard-linked project file.
    linkSync(join(data, 'codex', 'sessions', '2026', '11', 'rollout-17.jsonl'), join(proj, 'session.json'))
    writeFileSync(join(proj, 'shared.txt'), 'shared')
    linkSync(join(proj, 'shared.txt'), join(base, 'shared-elsewhere.txt'))
    const pack = buildContextPack(['src/a.ts', 'session.json', 'shared.txt'], opts({ protectedPaths }))
    expect(pack.files.map((f) => f.path)).toEqual(['src/a.ts', 'shared.txt'])
    expect(pack.skipped).toEqual([{ path: 'session.json', reason: "OrgAI's control files are never shared" }])
    // The top level stays in the set for every file: codex/auth.json moved in during a build is refused.
    writeFileSync(join(proj, 'moved.json'), '{}')
    hooks.beforeOpen = (path) => renameSync(join(data, 'codex', 'auth.json'), path)
    expect(buildContextPack(['moved.json'], opts({ protectedPaths })).skipped).toEqual([{ path: 'moved.json', reason: "OrgAI's control files are never shared" }])
  }, 30_000)

  it('1: without handle pinning (Windows rules) the deep set is checked for every file and walked once per run', () => {
    const data = join(base, 'data')
    mkdirSync(join(data, 'codex', 'sessions'), { recursive: true })
    writeFileSync(join(data, 'secrets.json'), '{}')
    writeFileSync(join(data, 'codex', 'sessions', 'rollout-1.jsonl'), '{"s":"s3cret"}')
    writeFileSync(join(proj, 'moved.jsonl'), '{}')
    const protectedPaths = controlProtectedPaths(data)
    const deepCache: ProtectedDeepCache = {}
    // A file deep in a protected folder, moved in between the checks and the open, with one link: only the deep set knows it.
    hooks.beforeOpen = (path) => renameSync(join(data, 'codex', 'sessions', 'rollout-1.jsonl'), path)
    const pack = buildContextPack(['moved.jsonl'], opts({ protectedPaths, deepCache, platform: 'win32' }))
    expect(pack.skipped).toEqual([{ path: 'moved.jsonl', reason: "OrgAI's control files are never shared" }])
    const walked = deepCache.keys
    expect(walked).toBeInstanceOf(Set)
    // The next pack of the run reuses the walk.
    expect(buildContextPack(['src/a.ts'], opts({ protectedPaths, deepCache, platform: 'win32' })).files).toHaveLength(1)
    expect(deepCache.keys).toBe(walked)
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
    // Only `</` before a letter (white space between allowed) changes.
    expect(neutralizeClosingTags('</ x </1 a</B </\n\tdiv </ ')).toBe('</\u200b x </1 a</\u200bB </\u200b\n\tdiv </ ')
    expect(CONTEXT_PACK_HEADING).toContain('zero-width space')
    // A refusal line is cleaned the same way.
    expect(contextPackResultLine(buildContextPack(['nope\u2028\u202e.ts'], opts()))).toContain('nope.ts (not found)')
  })

  it('2: from known texts (Claude): no file system read, only complete Reads, the same checks, caps and formatting', () => {
    const data = join(base, 'data')
    const protectedPaths = controlProtectedPaths(data)
    const store = new ReadTextStore()
    const a = join(proj, 'src', 'a.ts')
    store.record('lead', [a], { text: 'as the lead saw it </script>', real: a })
    // On disk it changed since: the pack holds what the lead's Read returned.
    writeFileSync(a, 'changed after the read')
    store.record('lead', [join(proj, 'big.txt')], { text: 'x'.repeat(CONTEXT_PACK_FILE_MAX_CHARS + 1), real: join(proj, 'big.txt') })
    store.record('lead', [join(outside, 'secret.txt')], { text: 'not yours', real: join(outside, 'secret.txt') })
    // A path inside the project whose real path (at the Read) was outside.
    store.record('lead', [join(proj, 'via-link.txt'), join(outside, 'x.txt')], { text: 'outside', real: join(outside, 'x.txt') })
    const pack = buildContextPackFromTexts(['src/a.ts', 'README.md', 'big.txt', join(outside, 'secret.txt'), 'via-link.txt', join(data, 'secrets.json'), './src/a.ts'], {
      callerCwd: proj,
      readRoots: [proj],
      protectedPaths,
      lookup: (abs) => store.get('lead', abs)
    })
    expect(pack.files).toEqual([{ path: 'src/a.ts', text: 'as the lead saw it </​script>' }])
    expect(pack.skipped).toEqual([
      { path: 'README.md', reason: CONTEXT_PACK_NOT_READ_IN_FULL },
      // Never kept: over the per-file cap.
      { path: 'big.txt', reason: CONTEXT_PACK_NOT_READ_IN_FULL },
      { path: join(outside, 'secret.txt'), reason: 'outside the folders the report may read' },
      { path: 'via-link.txt', reason: 'outside the folders the report may read' },
      { path: join(data, 'secrets.json'), reason: 'outside the folders the report may read' },
      { path: './src/a.ts', reason: 'listed twice' }
    ])
    // The gate on the path, with the data folder inside the project; unavailable paths and refuseAll as before.
    const inData = join(proj, 'data')
    const pp = controlProtectedPaths(inData)
    store.record('lead', [join(inData, 'secrets.json')], { text: '{"k":"s3cret"}', real: join(inData, 'secrets.json') })
    const base2 = { callerCwd: proj, readRoots: [proj], protectedPaths: pp, lookup: (x: string) => store.get('lead', x) }
    expect(buildContextPackFromTexts(['data/secrets.json'], base2).skipped).toEqual([{ path: 'data/secrets.json', reason: "OrgAI's control files are never shared" }])
    // A kept read whose recorded real path is a control file (a link flipped onto it) is refused by the gate too.
    store.record('lead', [join(proj, 'flip.txt'), join(inData, 'secrets.json')], { text: 'notes', real: join(inData, 'secrets.json') })
    expect(buildContextPackFromTexts(['flip.txt'], base2).skipped).toEqual([{ path: 'flip.txt', reason: "OrgAI's control files are never shared" }])
    expect(buildContextPackFromTexts(['src/a.ts'], { ...base2, pathsUnavailable: true }).skipped[0]!.reason).toBe('OrgAI could not check it against its control files')
    expect(buildContextPackFromTexts(['src/a.ts'], { ...base2, refuseAll: 'no' }).skipped).toEqual([{ path: 'src/a.ts', reason: 'no' }])
    // The block cap and the file count, as buildContextPack.
    for (let i = 0; i < 3; i++) store.record('lead', [join(proj, `m${i}.txt`)], { text: 'z'.repeat(4000), real: join(proj, `m${i}.txt`) })
    const capped = buildContextPackFromTexts(['m0.txt', 'm1.txt', 'm2.txt'], { ...base2, blockMaxChars: CLAUDE_HOOK_CONTEXT_INLINE_MAX })
    expect(capped.files.map((f) => f.path)).toEqual(['m0.txt', 'm1.txt'])
    expect(capped.skipped).toEqual([{ path: 'm2.txt', reason: 'over the 10,000-character total' }])
    const many = buildContextPackFromTexts(Array.from({ length: CONTEXT_PACK_MAX_FILES + 3 }, () => 'm0.txt'), base2)
    expect(many.skipped.at(-1)).toEqual({ path: 'and 3 more', reason: 'not considered, over the 8-file limit' })
  })

  it('2: completeReadText keeps only a whole-file text Read', () => {
    const file = (over: Record<string, unknown> = {}) => ({ type: 'text', file: { filePath: '/p/a.ts', content: 'a\nb\n', numLines: 3, startLine: 1, totalLines: 3, ...over } })
    expect(completeReadText(file())).toBe('a\nb\n')
    expect(completeReadText(file({ truncatedByTokenCap: false }))).toBe('a\nb\n')
    // Partial: a range, a token-cap page, fewer lines than the file has.
    expect(completeReadText(file({ startLine: 2, numLines: 2 }))).toBeUndefined()
    expect(completeReadText(file({ numLines: 2 }))).toBeUndefined()
    expect(completeReadText(file({ truncatedByTokenCap: true }))).toBeUndefined()
    // Not text, or a shape that cannot show it is complete.
    expect(completeReadText({ type: 'image', file: { base64: 'x' } })).toBeUndefined()
    expect(completeReadText({ type: 'text', file: { content: 'a' } })).toBeUndefined()
    expect(completeReadText('1\tconst a = 1')).toBeUndefined()
    expect(completeReadText(null)).toBeUndefined()
  })

  it('2: ReadTextStore bounds: per-file cap, entries and characters per agent (oldest dropped), agents; a new Read replaces the old', () => {
    const store = new ReadTextStore({ entries: 3, chars: 100, agents: 2 })
    store.record('a', ['/p/1', '/r/1'], { text: 'one', real: '/r/1' })
    expect(store.get('a', '/r/1')).toEqual({ text: 'one', real: '/r/1' })
    store.record('a', ['/p/1', '/r/1'], { text: 'uno', real: '/r/1' })
    expect(store.size('a')).toEqual({ entries: 1, chars: 3 })
    expect(store.get('a', '/p/1')!.text).toBe('uno')
    for (const n of [2, 3, 4]) store.record('a', [`/p/${n}`], { text: 'x', real: `/p/${n}` })
    expect(store.get('a', '/p/1')).toBeUndefined()
    expect(store.size('a').entries).toBe(3)
    store.record('a', ['/p/big'], { text: 'y'.repeat(99), real: '/p/big' })
    expect(store.size('a').chars).toBeLessThanOrEqual(100)
    expect(store.get('a', '/p/big')!.text).toHaveLength(99)
    // Over the per-file cap: never kept.
    const big = new ReadTextStore()
    big.record('a', ['/p/x'], { text: 'z'.repeat(CONTEXT_PACK_FILE_MAX_CHARS + 1), real: '/p/x' })
    expect(big.size('a').entries).toBe(0)
    expect(READ_TEXT_STORE_LIMITS).toEqual({ entries: 100, chars: 1_500_000, agents: 200 })
    // Agents: the least recently recorded is dropped; forget drops one.
    store.record('b', ['/p/b'], { text: 'b', real: '/p/b' })
    store.record('c', ['/p/c'], { text: 'c', real: '/p/c' })
    expect(store.size('a').entries).toBe(0)
    store.forget('c')
    expect(store.get('c', '/p/c')).toBeUndefined()
    expect(store.get('b', '/p/b')!.text).toBe('b')
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
    // ``` and ~~~ are different fences: one does not close the other.
    expect(briefFiles('```\n~~~\nFiles: a.ts')).toEqual([])
    expect(briefFiles('~~~\n```\nFiles: a.ts')).toEqual([])
    expect(briefFiles('````\n```\nFiles: a.ts')).toEqual([])
    expect(briefFiles('~~~\n```\n~~~\nFiles: a.ts')).toEqual(['a.ts'])
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
