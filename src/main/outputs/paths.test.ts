import { execFileSync } from 'node:child_process'
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OPENABLE_EXTENSIONS, checkDeletableFile, checkFileNameSegments, checkRegisteredPath, checkWritablePath, isOpenablePath, readRegularCapped, resolveProducedTarget, slugFromTitle, withKindExtension, writeFileAtomic, writeProduced } from './paths'
import type { PathScope } from './paths'

let root: string
let project: string
let data: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orgai-outpaths-'))
  project = join(root, 'proj')
  data = join(root, 'data')
  mkdirSync(project)
  mkdirSync(data)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const scope = (extra: Partial<PathScope> = {}): PathScope => ({ projectPath: project, allowedDirectories: [], referenceDirectories: [], ...extra })
const resolveT = (fileName: string | undefined, over: Partial<Parameters<typeof resolveProducedTarget>[0]> = {}) =>
  resolveProducedTarget({ scope: scope(), dataDir: data, kind: 'markdown', title: 'My Title', fileName, known: () => false, ...over })
const link = (target: string, at: string): void => symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir')

describe('names', () => {
  it('slugs a title', () => {
    expect(slugFromTitle('Q3 Plán: the "big" one!')).toBe('Q3-Plan-the-big-one')
    expect(slugFromTitle('???')).toBe('output')
    expect(slugFromTitle('a'.repeat(200)).length).toBe(80)
  })
  it('forces the extension', () => {
    expect(withKindExtension('a.txt', 'docx')).toBe('a.docx')
    expect(withKindExtension('a.DOCX', 'docx')).toBe('a.DOCX')
    expect(withKindExtension('a', 'mermaid')).toBe('a.mmd')
    expect(withKindExtension('.hidden', 'csv')).toBe('.hidden.csv')
  })
  it.each([
    '/abs.md', '\\\\host\\share\\a.md', '//host/s/a.md', '\\\\?\\C:\\a.md', 'C:foo.md', 'C:\\a.md', '../a.md', 'a/../b.md', 'a//b.md', './a.md',
    '.git/x.md', 'a/.GIT/x.md', 'a<b.md', 'a:b.md', 'a"b.md', 'a|b.md', 'a?b.md', 'a*b.md', 'a./b.md', 'a /b.md', 'x.md.', 'CON', 'con.txt', 'a/NUL.md',
    'LPT1', 'com9.x', 'a\u202eb.md', 'a\u0000b.md', '', '   ', 'x'.repeat(1025)
  ])('refuses %j', (name) => {
    expect(() => checkFileNameSegments(name)).toThrow()
  })
  it('accepts sub-folders with either separator', () => {
    expect(checkFileNameSegments('plans\\q3/final.docx')).toEqual(['plans', 'q3', 'final.docx'])
  })
})

describe('produced target', () => {
  it('creates outputs/ and sub-folders', () => {
    const t = resolveT('plans/q3')
    expect(t.fileName).toBe('q3.md')
    expect(t.file).toBe(join(project, 'outputs', 'plans', 'q3.md'))
    writeProduced(t, Buffer.from('hi'))
    expect(readFileSync(t.file, 'utf8')).toBe('hi')
  })
  it('uses the title slug when no file name is given', () => {
    expect(resolveT(undefined).fileName).toBe('My-Title.md')
  })
  it('suffixes an existing file that is not indexed, and one that is when separate', () => {
    const a = resolveT('r.md')
    writeProduced(a, Buffer.from('1'))
    expect(resolveT('r.md', { known: () => true, separate: true }).fileName).toBe('r (2).md')
    const b = resolveT('r.md')
    expect(b.fileName).toBe('r (2).md')
    expect(b.renamed).toBe(true)
    writeProduced(b, Buffer.from('2'))
    expect(readFileSync(a.file, 'utf8')).toBe('1')
    expect(resolveT('r.md').fileName).toBe('r (3).md')
  })
  it('replaces an indexed file (any run), through temp + rename', () => {
    const a = resolveT('r.md')
    writeProduced(a, Buffer.from('1'))
    const b = resolveT('r.md', { known: (p: string) => p === a.file })
    expect(b.overwrite).toBe(true)
    writeProduced(b, Buffer.from('22'))
    expect(readFileSync(a.file, 'utf8')).toBe('22')
  })
  it('refuses after 999 collisions', () => {
    const dir = join(project, 'outputs')
    mkdirSync(dir)
    writeFileSync(join(dir, 'x.md'), '')
    for (let n = 2; n <= 999; n++) writeFileSync(join(dir, `x (${n}).md`), '')
    expect(() => resolveT('x.md')).toThrow(/Too many/)
  })
  it('refuses a missing project folder', () => {
    expect(() => resolveT('a.md', { scope: scope({ projectPath: join(root, 'nope') }) })).toThrow(/does not exist/)
  })
  it('refuses a link at outputs/ (junction or dir symlink)', () => {
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    link(elsewhere, join(project, 'outputs'))
    expect(() => resolveT('a.md')).toThrow(/is a link/)
    expect(existsSync(join(elsewhere, 'a.md'))).toBe(false)
  })
  it('refuses a link on a sub-folder', () => {
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    mkdirSync(join(project, 'outputs'))
    link(elsewhere, join(project, 'outputs', 'sub'))
    expect(() => resolveT('sub/a.md')).toThrow(/is a link/)
  })
  it('does not write through a planted symlink file at the target', () => {
    const secret = join(root, 'secret.txt')
    writeFileSync(secret, 'keep')
    mkdirSync(join(project, 'outputs'))
    try {
      symlinkSync(secret, join(project, 'outputs', 'p.md'), 'file')
    } catch {
      return // no symlink privilege on this machine
    }
    const t = resolveT('p.md', { known: () => true })
    expect(t.fileName).toBe('p (2).md')
    writeProduced(t, Buffer.from('new'))
    expect(readFileSync(secret, 'utf8')).toBe('keep')
  })
  it('refuses a reference folder inside the project and the data dir inside the project', () => {
    const ref = join(project, 'ref')
    mkdirSync(ref)
    expect(() => resolveT('a.md', { scope: scope({ referenceDirectories: [join(project, 'outputs')] }) })).toThrow(/reference/)
    const d2 = join(project, 'outputs', 'inner')
    expect(() => resolveT('inner/a.md', { dataDir: d2 })).toThrow(/data folder/)
    expect(() => resolveT('a.md', { scope: scope({ referenceDirectories: [join(project, 'outputs', 'sub')] }) })).not.toThrow()
  })
  it('compares case-variant spellings on win32', () => {
    if (process.platform !== 'win32') return
    expect(() => resolveT('a.md', { scope: scope({ referenceDirectories: [join(project, 'OUTPUTS')] }) })).toThrow(/reference/)
  })
})

describe('registered path', () => {
  it('accepts a regular file in the project, relative or absolute', () => {
    writeFileSync(join(project, 'a.md'), 'x')
    const r = checkRegisteredPath('a.md', scope(), data)
    expect(r.relPath).toBe('a.md')
    expect(r.bytes).toBe(1)
    expect(checkRegisteredPath(join(project, 'a.md'), scope(), data).relPath).toBe('a.md')
  })
  it('accepts a file in an allowed folder and reports an absolute relPath', () => {
    const extra = join(root, 'extra')
    mkdirSync(extra)
    writeFileSync(join(extra, 'b.md'), 'x')
    const r = checkRegisteredPath(join(extra, 'b.md'), scope({ allowedDirectories: [extra] }), data)
    expect(r.relPath).toBe(r.path)
    expect(() => checkRegisteredPath(join(extra, 'b.md'), scope(), data)).toThrow(/outside/)
  })
  it('refuses missing, directories, bad strings and .. escapes', () => {
    writeFileSync(join(root, 'out.md'), 'x')
    mkdirSync(join(project, 'd'))
    expect(() => checkRegisteredPath('nope.md', scope(), data)).toThrow(/does not exist/)
    expect(() => checkRegisteredPath('d', scope(), data)).toThrow(/regular file/)
    expect(() => checkRegisteredPath('../out.md', scope(), data)).toThrow(/outside/)
    expect(() => checkRegisteredPath('a\u202e.md', scope(), data)).toThrow(/hidden/)
    expect(() => checkRegisteredPath(42, scope(), data)).toThrow()
    expect(() => checkRegisteredPath('x'.repeat(1025), scope(), data)).toThrow(/longer/)
    if (process.platform === 'win32') expect(() => checkRegisteredPath('\\\\host\\share\\a.md', scope(), data)).toThrow(/Network/)
  })
  it('refuses a file reached through a junction out of the project', () => {
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'e.md'), 'x')
    link(elsewhere, join(project, 'jump'))
    expect(() => checkRegisteredPath('jump/e.md', scope(), data)).toThrow(/outside/)
  })
  it('refuses a symlink file', () => {
    writeFileSync(join(project, 'real.md'), 'x')
    try {
      symlinkSync(join(project, 'real.md'), join(project, 'l.md'), 'file')
    } catch {
      return
    }
    expect(() => checkRegisteredPath('l.md', scope(), data)).toThrow(/link/)
  })
  it('refuses reference folders, the data folder and .git', () => {
    mkdirSync(join(project, 'ref'))
    writeFileSync(join(project, 'ref', 'r.md'), 'x')
    expect(() => checkRegisteredPath('ref/r.md', scope({ referenceDirectories: [join(project, 'ref')] }), data)).toThrow(/reference/)
    const d = join(project, 'dd')
    mkdirSync(d)
    writeFileSync(join(d, 's.json'), 'x')
    expect(() => checkRegisteredPath('dd/s.json', scope(), d)).toThrow(/data folder/)
    mkdirSync(join(project, '.git'))
    writeFileSync(join(project, '.git', 'config'), 'x')
    expect(() => checkRegisteredPath('.git/config', scope(), data)).toThrow(/\.git/)
    if (process.platform === 'win32') expect(() => checkRegisteredPath('REF/r.md', scope({ referenceDirectories: [join(project, 'ref')] }), data)).toThrow(/reference/)
  })
})

describe('open allowlist, reserved names, streams', () => {
  it.each([['a.docx', true], ['a.DOCX', true], ['a.Md', true], ['a.mmd', true], ['a.lnk', false], ['a.bat', false], ['a.BaT', false], ['a.exe', false], ['report.docx.bat', false], ['a.docx.', false], ['a.docx ', false], ['noext', false], ['a.docm', false], ['a.svg', false], ['a.SVG', false], ['a.mermaid', true]])('isOpenablePath(%j) = %s', (f, ok) => {
    expect(isOpenablePath(f)).toBe(ok)
  })
  it('lists exactly the document, image and text types', () => {
    expect([...OPENABLE_EXTENSIONS].sort()).toEqual(['csv', 'docx', 'gif', 'jpeg', 'jpg', 'json', 'markdown', 'md', 'mermaid', 'mmd', 'pdf', 'png', 'pptx', 'txt', 'webp', 'xlsx'])
  })
  it.each(['COM¹', 'com².txt', 'LPT³.md', 'CONIN$', 'conout$.txt', 'a/Com1.md', 'a/.GIT/b.md', 'a/.Git'])('refuses produced name %j', (name) => {
    expect(() => checkFileNameSegments(name)).toThrow()
  })
  it('refuses an NTFS alternate data stream on win32', () => {
    if (process.platform !== 'win32') return
    writeFileSync(join(project, 'a.txt'), 'x')
    expect(() => checkRegisteredPath('a.txt:x.exe', scope(), data)).toThrow(/alternate data stream/)
    expect(() => checkRegisteredPath(join(project, 'a.txt:hidden'), scope(), data)).toThrow(/alternate data stream/)
  })
  it('checks containment before existence: same sentence for a missing and an existing outside file', () => {
    writeFileSync(join(root, 'o.md'), 'x')
    const msg = (p: string): string => { try { checkRegisteredPath(p, scope(), data); return '' } catch (e) { return (e as Error).message } }
    expect(msg(join(root, 'o.md'))).toBe(msg(join(root, 'missing.md')))
    expect(msg(join(root, 'o.md'))).toMatch(/outside/)
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    link(elsewhere, join(project, 'jump'))
    expect(msg('jump/nope.md')).toMatch(/outside/)
  })
  it('strictNames refuses dot segments; the default does not (so a stored dot-named output still opens)', () => {
    mkdirSync(join(project, '.claude'))
    writeFileSync(join(project, '.claude', 's.json'), 'x')
    writeFileSync(join(project, '.env'), 'x')
    expect(() => checkRegisteredPath('.claude/s.json', scope(), data, { strictNames: true })).toThrow(/starts with a dot/)
    expect(() => checkRegisteredPath('.env', scope(), data, { strictNames: true })).toThrow(/starts with a dot/)
    expect(checkRegisteredPath('.env', scope(), data).bytes).toBe(1)
  })
  it('refuses a .GIT folder in any case', () => {
    mkdirSync(join(project, '.GIT'))
    writeFileSync(join(project, '.GIT', 'config'), 'x')
    expect(() => checkRegisteredPath('.GIT/config', scope(), data)).toThrow(/\.git/)
  })
})

describe('deletable path', () => {
  it('allows a regular file inside the project (any folder), null when gone', () => {
    const t = resolveT('a.md')
    writeProduced(t, Buffer.from('x'))
    expect(checkDeletableFile(t.file, scope(), data)).toBeTruthy()
    expect(checkDeletableFile(join(project, 'outputs', 'gone.md'), scope(), data)).toBeNull()
    writeFileSync(join(project, 'plain.md'), 'x')
    expect(checkDeletableFile(join(project, 'plain.md'), scope(), data)).toBeTruthy()
  })
  it('refuses a directory, a file outside the scope, the data folder and .git', () => {
    mkdirSync(join(project, 'dir'))
    expect(() => checkDeletableFile(join(project, 'dir'), scope(), data)).toThrow(/regular file/)
    writeFileSync(join(root, 'outside.md'), 'x')
    expect(() => checkDeletableFile(join(root, 'outside.md'), scope(), data)).toThrow(/outside/)
    writeFileSync(join(data, 's.json'), 'x')
    expect(() => checkDeletableFile(join(data, 's.json'), scope(), data)).toThrow()
    mkdirSync(join(project, '.git'))
    writeFileSync(join(project, '.git', 'HEAD'), 'x')
    expect(() => checkDeletableFile(join(project, '.git', 'HEAD'), scope(), data)).toThrow(/\.git/)
  })
  it('refuses when a folder on the way became a link out of the project', () => {
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'k.md'), 'x')
    link(elsewhere, join(project, 'outputs'))
    expect(() => checkDeletableFile(join(project, 'outputs', 'k.md'), scope(), data)).toThrow()
  })
  it('refuses a symlink file at the path', () => {
    const secret = join(root, 'secret.md')
    writeFileSync(secret, 'x')
    try {
      symlinkSync(secret, join(project, 'l.md'), 'file')
    } catch {
      return
    }
    expect(() => checkDeletableFile(join(project, 'l.md'), scope(), data)).toThrow(/link/)
  })
})

describe('writable path and atomic write', () => {
  it('accepts an existing file and a vanished file in a plain folder', () => {
    writeFileSync(join(project, 'a.md'), 'x')
    expect(checkWritablePath(join(project, 'a.md'), scope(), data)).toBeTruthy()
    expect(checkWritablePath(join(project, 'gone.md'), scope(), data)).toMatch(/gone\.md$/)
  })
  it('refuses a vanished file whose folder is gone, a link, outside or under .git', () => {
    expect(() => checkWritablePath(join(project, 'nodir', 'x.md'), scope(), data)).toThrow(/gone|link/)
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    link(elsewhere, join(project, 'lnk'))
    expect(() => checkWritablePath(join(project, 'lnk', 'x.md'), scope(), data)).toThrow()
    expect(() => checkWritablePath(join(root, 'x.md'), scope(), data)).toThrow(/outside/)
    mkdirSync(join(project, '.git'))
    expect(() => checkWritablePath(join(project, '.git', 'x.md'), scope(), data)).toThrow(/\.git/)
  })
  it('writeFileAtomic replaces a file, creates one, leaves no temp and refuses a symlink', () => {
    const f = join(project, 'w.md')
    writeFileAtomic(f, Buffer.from('1'))
    writeFileAtomic(f, Buffer.from('22'))
    expect(readFileSync(f, 'utf8')).toBe('22')
    expect(readdirSync(project).filter((n) => n.endsWith('.tmp'))).toEqual([])
    const secret = join(root, 'secret.md')
    writeFileSync(secret, 'keep')
    try {
      symlinkSync(secret, join(project, 'l.md'), 'file')
    } catch {
      return
    }
    expect(() => writeFileAtomic(join(project, 'l.md'), Buffer.from('bad'))).toThrow(/regular file/)
    expect(readFileSync(secret, 'utf8')).toBe('keep')
  })
  it.skipIf(process.platform === 'win32')('writeFileAtomic keeps the old file mode (L5)', () => {
    const f = join(project, 'mode.md')
    writeFileSync(f, 'a', { mode: 0o600 })
    chmodSync(f, 0o600)
    writeFileAtomic(f, Buffer.from('bb'))
    expect(statSync(f).mode & 0o777).toBe(0o600)
  })
})

describe('hard links (L5)', () => {
  it('registered, deletable and writable checks and writeFileAtomic refuse a file with two links', () => {
    const f = join(project, 'a.md')
    writeFileSync(f, 'x')
    const outside = join(root, 'outside.md')
    linkSync(f, outside)
    expect(() => checkRegisteredPath(f, scope(), data)).toThrow(/hard link/)
    expect(() => checkDeletableFile(f, scope(), data)).toThrow(/hard link/)
    expect(() => checkWritablePath(f, scope(), data)).toThrow(/hard link/)
    expect(() => writeFileAtomic(f, Buffer.from('y'))).toThrow(/hard link/)
    expect(readFileSync(outside, 'utf8')).toBe('x')
  })
})

describe('readRegularCapped (M3)', () => {
  it('reads a regular file and returns its bytes', () => {
    const f = join(project, 'r.md')
    writeFileSync(f, 'hello')
    expect(readRegularCapped(f, 100).toString()).toBe('hello')
    const c = checkRegisteredPath(f, scope(), data)
    expect(readRegularCapped(f, 100, c).toString()).toBe('hello')
  })
  it('refuses a file over the cap, a mismatching identity, a hard link and a folder', () => {
    const f = join(project, 'big.md')
    writeFileSync(f, 'x'.repeat(50))
    expect(() => readRegularCapped(f, 10)).toThrow(/larger than/)
    const c = checkRegisteredPath(f, scope(), data)
    expect(() => readRegularCapped(f, 100, { dev: c.dev, ino: -1 })).toThrow(/changed while/)
    expect(() => readRegularCapped(f, 100, { dev: -1, ino: c.ino })).toThrow(/changed while/)
    expect(() => readRegularCapped(project, 100)).toThrow()
    linkSync(f, join(root, 'twin.md'))
    expect(() => readRegularCapped(f, 100)).toThrow(/hard link/)
  })
  it.skipIf(process.platform === 'win32')('does not block on a FIFO swapped in for the file', () => {
    const f = join(project, 'fifo.md')
    try {
      execFileSync('mkfifo', [f])
    } catch {
      return
    }
    expect(() => readRegularCapped(f, 100)).toThrow()
  })
  it.skipIf(process.platform === 'win32')('does not follow a symlink', () => {
    const real = join(root, 'real.md')
    writeFileSync(real, 'secret')
    symlinkSync(real, join(project, 'l2.md'), 'file')
    expect(() => readRegularCapped(join(project, 'l2.md'), 100)).toThrow()
  })
})
