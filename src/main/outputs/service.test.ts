import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OutputPreview } from '@shared/types'
import { OUTPUT_VERSIONS_MAX } from '@shared/types'
import type { OutputsServiceApi, OutputScope } from './api'
import { createOutputsService } from './service'

const previewHook = vi.hoisted(() => ({ fn: undefined as undefined | ((...a: unknown[]) => Promise<unknown>) }))
vi.mock('./preview', async (orig) => {
  const real = await orig<typeof import('./preview')>()
  return { ...real, previewFile: (...a: Parameters<typeof real.previewFile>) => (previewHook.fn ? previewHook.fn(...a) : real.previewFile(...a)) }
})

let root: string
let project: string
let data: string
let svc: OutputsServiceApi
let scope: OutputScope
const src = { runId: 'run_a', agentId: 'agent_1', role: 'Analyst' }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orgai-outsvc-'))
  project = join(root, 'proj')
  data = join(root, 'data')
  mkdirSync(project)
  mkdirSync(data)
  svc = createOutputsService(data)
  scope = { projectId: 'p1', projectPath: project, allowedDirectories: [], referenceDirectories: [] }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const md = (title: string, over = {}) => ({ kind: 'markdown' as const, title, content: `# ${title}`, ...over })

describe('produce', () => {
  it('writes the file, indexes it and lists it', async () => {
    const r = await svc.produce(scope, md('Q3 plan', { fileName: 'plans/q3', description: 'The plan.' }), src)
    expect(r.created).toBe(true)
    expect(r.output).toMatchObject({ projectId: 'p1', runId: 'run_a', agentId: 'agent_1', role: 'Analyst', kind: 'markdown', title: 'Q3 plan', fileName: 'q3.md', relPath: 'outputs/plans/q3.md', source: 'produced', description: 'The plan.' })
    expect(r.output.id).toMatch(/^out_[0-9a-f]{16}$/)
    expect(readFileSync(join(project, 'outputs', 'plans', 'q3.md'), 'utf8')).toBe('# Q3 plan')
    expect(r.output.bytes).toBe(9)
    expect(svc.list('p1').map((o) => o.id)).toEqual([r.output.id])
    expect(svc.get('p1', r.output.id)?.title).toBe('Q3 plan')
    expect(svc.get('p1', 'out_0000000000000000')).toBeUndefined()
  })
  it('uses a name from the title; the same name again is the same output, separate takes a suffix', async () => {
    const a = await svc.produce(scope, md('Same'), src)
    const b = await svc.produce(scope, md('Same'), src)
    expect(b).toMatchObject({ created: false, versioned: false })
    expect(b.output.id).toBe(a.output.id)
    const c = await svc.produce(scope, md('Same', { separate: true }), src)
    expect([a.output.fileName, c.output.fileName]).toEqual(['Same.md', 'Same (2).md'])
    expect(c.created).toBe(true)
    expect(svc.list('p1')).toHaveLength(2)
  })
  it('a second produce of the same file, from any run, is a new version (no suffix)', async () => {
    const a = await svc.produce(scope, md('Doc', { fileName: 'd.md' }), src)
    expect(a.output).toMatchObject({ version: 1, versionCount: 1 })
    const b = await svc.produce(scope, md('Doc v2', { fileName: 'd.md', overwrite: true, content: 'new' }), src)
    expect(b).toMatchObject({ created: false, versioned: true, previous: { n: 1, source: 'agent' } })
    expect(b.output.id).toBe(a.output.id)
    expect(b.output.createdAt).toBe(a.output.createdAt)
    expect(b.output).toMatchObject({ title: 'Doc v2', version: 2, versionCount: 2, bytes: 3, current: { source: 'agent', runId: 'run_a' } })
    expect(readFileSync(join(project, 'outputs', 'd.md'), 'utf8')).toBe('new')
    expect(svc.list('p1')).toHaveLength(1)
    const c = await svc.produce(scope, md('Other', { fileName: 'd.md' , content: 'third' }), { runId: 'run_b', role: 'Editor' })
    expect(c).toMatchObject({ created: false, versioned: true })
    expect(c.output).toMatchObject({ version: 3, runId: 'run_a', current: { runId: 'run_b', role: 'Editor' } })
    const vs = svc.versions('p1', a.output.id)
    expect(vs.map((v) => v.n)).toEqual([3, 2, 1])
    expect(vs.map((v) => v.title)).toEqual(['Other', 'Doc v2', 'Doc'])
    expect(vs.map((v) => v.source)).toEqual(['agent', 'agent', 'agent'])
    expect(readFileSync(join(data, 'projects', 'p1', 'outputs', a.output.id, 'v1.md'), 'utf8')).toBe('# Doc')
    expect(readFileSync(join(data, 'projects', 'p1', 'outputs', a.output.id, 'v2.md'), 'utf8')).toBe('new')
  })
  it('the same content again adds no version but may retitle', async () => {
    const a = await svc.produce(scope, md('Doc', { fileName: 'd.md' }), src)
    const b = await svc.produce(scope, md('Doc renamed', { fileName: 'd.md', content: '# Doc', description: 'now described' }), src)
    expect(b).toMatchObject({ created: false, versioned: false })
    expect(b.output).toMatchObject({ id: a.output.id, version: 1, versionCount: 1, title: 'Doc renamed', description: 'now described' })
  })
  it('two concurrent produces of one file make v2 and v3 in call order', async () => {
    await svc.produce(scope, md('Doc', { fileName: 'd.md' }), src)
    const [x, y] = await Promise.all([svc.produce(scope, md('A', { fileName: 'd.md', content: 'first' }), src), svc.produce(scope, md('B', { fileName: 'd.md', content: 'second' }), src)])
    expect(x.output.version).toBe(2)
    expect(y.output.version).toBe(3)
    const id = x.output.id
    expect(readFileSync(join(data, 'projects', 'p1', 'outputs', id, 'v2.md'), 'utf8')).toBe('first')
    expect(readFileSync(join(project, 'outputs', 'd.md'), 'utf8')).toBe('second')
  })
  it('a file that vanished but is still indexed gets its next version (no new output)', async () => {
    const a = await svc.produce(scope, md('Doc', { fileName: 'd.md' }), src)
    unlinkSync(a.output.path)
    const b = await svc.produce(scope, md('Doc', { fileName: 'd.md', content: 'back' }), src)
    expect(b).toMatchObject({ created: false, versioned: true })
    expect(b.output.id).toBe(a.output.id)
    expect(readFileSync(a.output.path, 'utf8')).toBe('back')
  })
  it('a produce over an uncaptured outside edit captures it as an external version first', async () => {
    const a = await svc.produce(scope, md('Doc', { fileName: 'd.md' }), src)
    writeFileSync(a.output.path, 'user typed this')
    const b = await svc.produce(scope, md('Doc', { fileName: 'd.md', content: 'agent text' }), src)
    expect(b.previous).toMatchObject({ n: 2, source: 'external' })
    const vs = svc.versions('p1', a.output.id)
    expect(vs.map((v) => v.source)).toEqual(['agent', 'external', 'agent'])
    expect(readFileSync(join(data, 'projects', 'p1', 'outputs', a.output.id, 'v2.md'), 'utf8')).toBe('user typed this')
  })
  it('never overwrites a file with no index entry', async () => {
    mkdirSync(join(project, 'outputs'))
    writeFileSync(join(project, 'outputs', 'mine.md'), 'user file')
    const r = await svc.produce(scope, md('x', { fileName: 'mine.md', overwrite: true }), src)
    expect(r.output.fileName).toBe('mine (2).md')
    expect(readFileSync(join(project, 'outputs', 'mine.md'), 'utf8')).toBe('user file')
  })
  it('renders docx and xlsx', async () => {
    const d = await svc.produce(scope, { kind: 'docx', title: 'Doc', content: '# Hi\n\ntext' }, src)
    expect(d.output.fileName).toBe('Doc.docx')
    const x = await svc.produce(scope, { kind: 'xlsx', title: 'Sheet', content: { sheets: [{ name: 'a', rows: [[1, 'two']] }] } }, src)
    expect(x.output.fileName).toBe('Sheet.xlsx')
    const p = await svc.preview(scope, x.output.id)
    expect(p.kind).toBe('sheets')
    const pd = await svc.preview(scope, d.output.id)
    expect(pd.kind).toBe('document')
  })
  it('refuses bad titles, descriptions, names and content with plain sentences', async () => {
    await expect(svc.produce(scope, md(''), src)).rejects.toThrow(/empty/)
    await expect(svc.produce(scope, md('   '), src)).rejects.toThrow(/empty/)
    await expect(svc.produce(scope, md('a\nb'), src)).rejects.toThrow(/hidden/)
    await expect(svc.produce(scope, md('a\u202eb'), src)).rejects.toThrow(/hidden/)
    await expect(svc.produce(scope, md('x'.repeat(121)), src)).rejects.toThrow(/longer/)
    await expect(svc.produce(scope, md('ok', { description: 'x'.repeat(501) }), src)).rejects.toThrow(/longer/)
    await expect(svc.produce(scope, md('ok', { description: 'a\u202eb' }), src)).rejects.toThrow(/hidden/)
    await expect(svc.produce(scope, md('ok', { fileName: '../x' }), src)).rejects.toThrow()
    await expect(svc.produce(scope, md('ok', { fileName: 'C:\\x' }), src)).rejects.toThrow()
    await expect(svc.produce(scope, { kind: 'json', title: 'j', content: '{' }, src)).rejects.toThrow(/not valid/)
    await expect(svc.produce(scope, { kind: 'svg', title: 's', content: '<svg><script/></svg>' }, src)).rejects.toThrow(/script/)
    expect(svc.list('p1')).toEqual([])
    expect(existsSync(join(project, 'outputs'))).toBe(false)
  })
  it('accepts a multi-line description', async () => {
    expect((await svc.produce(scope, md('ok', { description: 'line one\nline two' }), src)).output.description).toBe('line one\nline two')
  })
  it('refuses a link at outputs/ and writes nothing through it', async () => {
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(project, 'outputs'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(svc.produce(scope, md('x'), src)).rejects.toThrow(/link|outside/)
    expect(existsSync(join(elsewhere, 'x.md'))).toBe(false)
  })
  it('survives a restart of the service', async () => {
    const a = await svc.produce(scope, md('Keep'), src)
    expect(createOutputsService(data).list('p1').map((o) => o.id)).toEqual([a.output.id])
  })
})

describe('register', () => {
  it('registers a file in the project, kind from the extension', async () => {
    writeFileSync(join(project, 'report.csv'), 'a,b')
    const r = await svc.register(scope, { path: 'report.csv', title: 'Report' }, src)
    expect(r.created).toBe(true)
    expect(r.output).toMatchObject({ kind: 'csv', fileName: 'report.csv', relPath: 'report.csv', bytes: 3, source: 'registered', runId: 'run_a' })
    const again = await svc.register(scope, { path: join(project, 'report.csv'), title: 'Report v2', kind: 'csv', description: 'd' }, src)
    expect(again.created).toBe(false)
    expect(again.output).toMatchObject({ id: r.output.id, title: 'Report v2', kind: 'csv', runId: 'run_a', source: 'registered', createdAt: r.output.createdAt, description: 'd' })
    expect(again).toMatchObject({ versioned: false })
    expect(again.output).toMatchObject({ version: 1, versionCount: 1 })
    expect(svc.list('p1')).toHaveLength(1)
  })
  it('a registered file whose content changed adds a version; unchanged adds none', async () => {
    writeFileSync(join(project, 'a.md'), 'one')
    const r = await svc.register(scope, { path: 'a.md', title: 'A' }, src)
    writeFileSync(join(project, 'a.md'), 'two!')
    const r2 = await svc.register(scope, { path: 'a.md', title: 'A again' }, { runId: 'run_b', role: 'Writer' })
    expect(r2).toMatchObject({ created: false, versioned: true, previous: { n: 1, source: 'agent' } })
    expect(r2.output).toMatchObject({ id: r.output.id, version: 2, bytes: 4, title: 'A again', runId: 'run_a', current: { runId: 'run_b', role: 'Writer' } })
    const r3 = await svc.register(scope, { path: 'a.md', title: 'A third' }, { runId: 'run_b' })
    expect(r3).toMatchObject({ created: false, versioned: false })
    expect(r3.output).toMatchObject({ version: 2, title: 'A third' })
    expect(svc.versions('p1', r.output.id).map((v) => v.n)).toEqual([2, 1])
  })
  it('registering a path the produce tool wrote joins that output', async () => {
    const p = await svc.produce(scope, md('Doc', { fileName: 'd.md' }), src)
    writeFileSync(p.output.path, 'edited by agent b')
    const r = await svc.register(scope, { path: join(project, 'outputs', 'd.md'), title: 'Doc' }, { runId: 'run_b' })
    expect(r.output.id).toBe(p.output.id)
    expect(r.versioned).toBe(true)
    expect(r.output.source).toBe('produced')
  })
  it('refuses a .pptm with a plain sentence', async () => {
    writeFileSync(join(project, 'deck.pptm'), 'x')
    await expect(svc.register(scope, { path: 'deck.pptm', title: 'Deck' }, src)).rejects.toThrow(/\.pptm/)
    expect(svc.list('p1')).toEqual([])
  })
  it('refuses an explicit kind that disagrees with the real extension (a .bat is never a docx)', async () => {
    writeFileSync(join(project, 'report.bat'), 'calc')
    writeFileSync(join(project, 'a.csv'), 'x')
    await expect(svc.register(scope, { path: 'report.bat', title: 'Quarterly report', kind: 'docx' }, src)).rejects.toThrow(/extension/)
    await expect(svc.register(scope, { path: 'a.csv', title: 'A', kind: 'text' }, src)).rejects.toThrow(/csv/)
    // an unknown extension is 'other'; claiming anything else is refused, 'other' or no kind is fine
    await expect(svc.register(scope, { path: 'report.bat', title: 'R', kind: 'pdf' }, src)).rejects.toThrow()
    expect((await svc.register(scope, { path: 'report.bat', title: 'R', kind: 'other' }, src)).output.kind).toBe('other')
    expect(svc.list('p1')).toHaveLength(1)
  })
  it('a register of a known path from another run no longer refuses (it joins the output)', async () => {
    writeFileSync(join(project, 'a.md'), 'x')
    const r = await svc.register(scope, { path: 'a.md', title: 'A' }, src)
    const again = await svc.register(scope, { path: 'a.md', title: 'Other run' }, { runId: 'run_b' })
    expect(again.created).toBe(false)
    expect(again.output.id).toBe(r.output.id)
    expect(svc.list('p1')).toHaveLength(1)
  })
  it('refuses dot files, dot folders and .orgai/ (plain sentence)', async () => {
    mkdirSync(join(project, '.claude'))
    mkdirSync(join(project, '.orgai'))
    mkdirSync(join(project, 'sub', '.vscode'), { recursive: true })
    writeFileSync(join(project, '.env'), 'K=1')
    writeFileSync(join(project, '.mcp.json'), '{}')
    writeFileSync(join(project, '.claude', 'settings.json'), '{}')
    writeFileSync(join(project, '.orgai', 'org.json'), '{}')
    writeFileSync(join(project, 'sub', '.vscode', 'x.json'), '{}')
    for (const p of ['.env', '.mcp.json', '.claude/settings.json', '.orgai/org.json', 'sub/.vscode/x.json', '.ENV']) {
      await expect(svc.register(scope, { path: p, title: 'X' }, src)).rejects.toThrow(/starts with a dot|exist/)
    }
    await expect(svc.register(scope, { path: '.env', title: 'X' }, src)).rejects.toThrow(/starts with a dot/)
    expect(svc.list('p1')).toEqual([])
  })
  it('a refusal for a path outside the scope never says whether it exists', async () => {
    writeFileSync(join(root, 'real.md'), 'x')
    const a = await svc.register(scope, { path: join(root, 'real.md'), title: 'A' }, src).catch((e: Error) => e.message)
    const b = await svc.register(scope, { path: join(root, 'nope.md'), title: 'A' }, src).catch((e: Error) => e.message)
    expect(a).toBe(b)
    expect(a).toMatch(/outside/)
  })
  it('openablePath answers only allowlisted real extensions; checkedPath still serves reveal / save', async () => {
    for (const f of ['ok.docx', 'ok.DOCX', 'x.lnk', 'x.bat', 'x.BaT', 'x.exe', 'x.hta', 'x.js', 'x.url', 'x.msi', 'x.scr', 'x.cpl', 'x.docm', 'report.docx.bat', 'noext']) writeFileSync(join(project, f), 'x')
    const reg = async (f: string) => (await svc.register(scope, { path: f, title: f }, src)).output
    for (const f of ['ok.docx', 'ok.DOCX']) expect(svc.openablePath!(scope, (await reg(f)).id)).toMatch(/ok\.docx$/i)
    for (const f of ['x.lnk', 'x.bat', 'x.BaT', 'x.exe', 'x.hta', 'x.js', 'x.url', 'x.msi', 'x.scr', 'x.cpl', 'x.docm', 'report.docx.bat', 'noext']) {
      const o = await reg(f)
      expect(() => svc.openablePath!(scope, o.id)).toThrow('OrgAI does not open this kind of file. Use Show in folder instead.')
      expect(svc.checkedPath(scope, o.id)).toBeTruthy()
    }
  })
  it('openablePath judges the real file, not the stored kind', async () => {
    const r = await svc.produce(scope, md('Doc', { fileName: 'd.md' }), src)
    expect(svc.openablePath!(scope, r.output.id)).toMatch(/d\.md$/)
  })
  it('registers a file in an allowed folder with an absolute relPath', async () => {
    const extra = join(root, 'extra')
    mkdirSync(extra)
    writeFileSync(join(extra, 'n.md'), 'x')
    const r = await svc.register({ ...scope, allowedDirectories: [extra] }, { path: join(extra, 'n.md'), title: 'N' }, src)
    expect(r.output.relPath).toBe(r.output.path)
  })
  it('refuses unknown kinds, outside paths, links, directories, reference and data folders and .git', async () => {
    writeFileSync(join(project, 'a.md'), 'x')
    await expect(svc.register(scope, { path: 'a.md', title: 'A', kind: 'exe' as never }, src)).rejects.toThrow(/kind/)
    writeFileSync(join(root, 'outside.md'), 'x')
    await expect(svc.register(scope, { path: join(root, 'outside.md'), title: 'O' }, src)).rejects.toThrow(/outside/)
    await expect(svc.register(scope, { path: '../outside.md', title: 'O' }, src)).rejects.toThrow(/outside/)
    mkdirSync(join(project, 'dir'))
    await expect(svc.register(scope, { path: 'dir', title: 'D' }, src)).rejects.toThrow(/regular file/)
    mkdirSync(join(project, 'ref'))
    writeFileSync(join(project, 'ref', 'r.md'), 'x')
    await expect(svc.register({ ...scope, referenceDirectories: [join(project, 'ref')] }, { path: 'ref/r.md', title: 'R' }, src)).rejects.toThrow(/reference/)
    mkdirSync(join(project, '.git'))
    writeFileSync(join(project, '.git', 'HEAD'), 'x')
    await expect(svc.register(scope, { path: '.git/HEAD', title: 'G' }, src)).rejects.toThrow(/\.git/)
    const inner = createOutputsService(join(project, 'dd'))
    writeFileSync(join(project, 'dd.md'), 'x')
    mkdirSync(join(project, 'dd'))
    writeFileSync(join(project, 'dd', 's.json'), 'x')
    await expect(inner.register(scope, { path: 'dd/s.json', title: 'S' }, src)).rejects.toThrow(/data folder/)
    expect(svc.list('p1')).toEqual([])
  })
})

describe('list, preview, checkedPath', () => {
  it('lists newest first and marks a vanished file missing', async () => {
    const a = await svc.produce(scope, md('A'), src)
    await new Promise((r) => setTimeout(r, 5))
    const b = await svc.produce(scope, md('B'), src)
    expect(svc.list('p1').map((o) => o.id)).toEqual([b.output.id, a.output.id])
    unlinkSync(a.output.path)
    const l = svc.list('p1')
    expect(l[0].missing).toBeUndefined()
    expect(l[1].missing).toBe(true)
    expect(svc.get('p1', a.output.id)?.missing).toBe(true)
    // the entry is kept
    expect(svc.list('p1')).toHaveLength(2)
  })
  it('preview answers none for a vanished or moved file and throws for an unknown id', async () => {
    const a = await svc.produce(scope, md('A'), src)
    expect(await svc.preview(scope, a.output.id)).toEqual({ kind: 'text', text: '# A' })
    unlinkSync(a.output.path)
    expect((await svc.preview(scope, a.output.id)).kind).toBe('none')
    await expect(svc.preview(scope, 'out_0000000000000000')).rejects.toThrow(/not in this project/)
  })
  it('checkedPath re-checks every call', async () => {
    const a = await svc.produce(scope, md('A'), src)
    expect(svc.checkedPath(scope, a.output.id)).toBe(a.output.path)
    // the same entry under a scope that no longer contains the file
    const other = { ...scope, projectPath: join(root, 'other') }
    mkdirSync(other.projectPath)
    expect(() => svc.checkedPath(other, a.output.id)).toThrow(/outside/)
    // the file is swapped for a link
    unlinkSync(a.output.path)
    const target = join(root, 'secret.md')
    writeFileSync(target, 'secret')
    try {
      symlinkSync(target, a.output.path, 'file')
      expect(() => svc.checkedPath(scope, a.output.id)).toThrow(/link|outside/)
      expect((await svc.preview(scope, a.output.id)).kind).toBe('none')
    } catch (e) {
      if (!/EPERM|operation not permitted/i.test(String(e))) throw e
    }
    expect(() => svc.checkedPath(scope, 'out_ffffffffffffffff')).toThrow(/not in this project/)
  })
})

describe('forget and delete', () => {
  it('forget drops the entry and keeps the file', async () => {
    const a = await svc.produce(scope, md('A'), src)
    const left = svc.forget('p1', a.output.id)
    expect(left).toEqual([])
    expect(existsSync(a.output.path)).toBe(true)
    expect(() => svc.forget('p1', a.output.id)).toThrow(/not in this project/)
  })
  it('forget also removes the output data folder (snapshots, notes, revisions)', async () => {
    const a = await svc.produce(scope, md('A'), src)
    svc.noteAdd('p1', { outputId: a.output.id, version: 1, anchor: { type: 'whole' }, text: 'n' })
    const dir = join(data, 'projects', 'p1', 'outputs', a.output.id)
    expect(existsSync(join(dir, 'v1.md'))).toBe(true)
    expect(existsSync(join(dir, 'notes.json'))).toBe(true)
    svc.forget('p1', a.output.id)
    expect(existsSync(dir)).toBe(false)
  })
  it('delete removes a one-version produced file without expectedVersionCount; a missing file just drops the entry', async () => {
    const a = await svc.produce(scope, md('A'), src)
    const b = await svc.produce(scope, md('B'), src)
    const dir = join(data, 'projects', 'p1', 'outputs', a.output.id)
    expect((await svc.delete(scope, { outputId: a.output.id })).map((o) => o.id)).toEqual([b.output.id])
    expect(existsSync(a.output.path)).toBe(false)
    expect(existsSync(dir)).toBe(false)
    unlinkSync(b.output.path)
    expect(await svc.delete(scope, { outputId: b.output.id })).toEqual([])
  })
  it('delete needs expectedVersionCount for a registered or multi-version output and refuses a mismatch', async () => {
    writeFileSync(join(project, 'mine.md'), 'x')
    const r = await svc.register(scope, { path: 'mine.md', title: 'Mine' }, src)
    await expect(svc.delete(scope, { outputId: r.output.id })).rejects.toThrow('This output changed. Check it and delete again.')
    await expect(svc.delete(scope, { outputId: r.output.id, expectedVersionCount: 2 })).rejects.toThrow('This output changed. Check it and delete again.')
    expect(existsSync(join(project, 'mine.md'))).toBe(true)
    const p = await svc.produce(scope, md('P', { fileName: 'p.md' }), src)
    await svc.produce(scope, md('P', { fileName: 'p.md', content: 'v2' }), src)
    await expect(svc.delete(scope, { outputId: p.output.id })).rejects.toThrow(/changed/)
    expect(svc.deletePreview(scope, p.output.id)).toMatchObject({ versions: 2, outsideOutputsFolder: false, trash: false, missing: false, relPath: 'outputs/p.md' })
    expect((await svc.delete(scope, { outputId: p.output.id, expectedVersionCount: 2 })).map((o) => o.id)).toEqual([r.output.id])
  })
  it('a registered file outside outputs/ goes through the injected trash, and its data folder is removed', async () => {
    const trashed: string[] = []
    const t = createOutputsService(data, { trash: async (p) => { trashed.push(p) } })
    writeFileSync(join(project, 'mine.md'), 'x')
    const r = await t.register(scope, { path: 'mine.md', title: 'Mine' }, src)
    expect(t.deletePreview(scope, r.output.id)).toMatchObject({ outsideOutputsFolder: true, trash: true, versions: 1 })
    await t.delete(scope, { outputId: r.output.id, expectedVersionCount: 1 })
    expect(trashed).toEqual([r.output.path])
    expect(t.list('p1')).toEqual([])
    expect(existsSync(join(data, 'projects', 'p1', 'outputs', r.output.id))).toBe(false)
  })
  it('falls back to unlink when the trash throws, and without a trash', async () => {
    const t = createOutputsService(data, { trash: async () => { throw new Error('no trash here') } })
    writeFileSync(join(project, 'a.md'), 'x')
    const r = await t.register(scope, { path: 'a.md', title: 'A' }, src)
    await t.delete(scope, { outputId: r.output.id, expectedVersionCount: 1 })
    expect(existsSync(join(project, 'a.md'))).toBe(false)
    writeFileSync(join(project, 'b.md'), 'x')
    const r2 = await svc.register(scope, { path: 'b.md', title: 'B' }, src)
    await svc.delete(scope, { outputId: r2.output.id, expectedVersionCount: 1 })
    expect(existsSync(join(project, 'b.md'))).toBe(false)
  })
  it('delete refuses a planted link at the path and keeps the target', async () => {
    const a = await svc.produce(scope, md('A'), src)
    const secret = join(root, 'secret.md')
    writeFileSync(secret, 'precious')
    unlinkSync(a.output.path)
    try {
      symlinkSync(secret, a.output.path, 'file')
    } catch {
      return
    }
    await expect(svc.delete(scope, { outputId: a.output.id })).rejects.toThrow(/link/)
    expect(readFileSync(secret, 'utf8')).toBe('precious')
    expect(svc.list('p1')).toHaveLength(1)
  })
  it('delete refuses when outputs/ became a link out of the project', async () => {
    const a = await svc.produce(scope, md('A'), src)
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'A.md'), 'precious')
    rmSync(join(project, 'outputs'), { recursive: true })
    symlinkSync(elsewhere, join(project, 'outputs'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(svc.delete(scope, { outputId: a.output.id })).rejects.toThrow()
    expect(readFileSync(join(elsewhere, 'A.md'), 'utf8')).toBe('precious')
  })
  it('delete refuses a directory at the path', async () => {
    const a = await svc.produce(scope, md('A'), src)
    unlinkSync(a.output.path)
    mkdirSync(a.output.path)
    await expect(svc.delete(scope, { outputId: a.output.id })).rejects.toThrow(/regular file/)
    expect(existsSync(a.output.path)).toBe(true)
  })
  it('unknown ids and projects', async () => {
    await expect(svc.delete(scope, { outputId: 'out_0000000000000000' })).rejects.toThrow(/not in this project/)
    expect(svc.list('nope')).toEqual([])
    expect(svc.list('../x')).toEqual([])
  })
})

describe('index format 1 and lazy v1', () => {
  it('loads a format 1 index as version 1 and snapshots v1 when the next version is written', async () => {
    const a = await svc.produce(scope, md('Doc', { fileName: 'd.md' }), src)
    // rewrite the index as format 1 and drop the snapshots
    const file = join(data, 'projects', 'p1', 'outputs.json')
    const j = JSON.parse(readFileSync(file, 'utf8'))
    const o = j.outputs[0]
    const old = { version: 1, outputs: [{ id: o.id, runId: o.runId, kind: o.kind, title: o.title, fileName: o.fileName, path: o.path, relPath: o.relPath, bytes: o.bytes, createdAt: o.createdAt, source: o.source }] }
    writeFileSync(file, JSON.stringify(old))
    rmSync(join(data, 'projects', 'p1', 'outputs', a.output.id), { recursive: true, force: true })
    const fresh = createOutputsService(data)
    expect(fresh.get('p1', a.output.id)).toMatchObject({ version: 1, versionCount: 1 })
    expect(fresh.versions('p1', a.output.id)).toHaveLength(1)
    const b = await fresh.produce(scope, md('Doc', { fileName: 'd.md', content: 'second' }), src)
    expect(b.output).toMatchObject({ version: 2, versionCount: 2 })
    expect(readFileSync(join(data, 'projects', 'p1', 'outputs', a.output.id, 'v1.md'), 'utf8')).toBe('# Doc')
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(2)
  })
  it('a format 1 entry whose file changed size cannot recover v1: the next version is v2 alone', async () => {
    const a = await svc.produce(scope, md('Doc', { fileName: 'd.md' }), src)
    const file = join(data, 'projects', 'p1', 'outputs.json')
    const o = JSON.parse(readFileSync(file, 'utf8')).outputs[0]
    writeFileSync(file, JSON.stringify({ version: 1, outputs: [{ id: o.id, runId: o.runId, kind: o.kind, title: o.title, fileName: o.fileName, path: o.path, relPath: o.relPath, bytes: o.bytes, createdAt: o.createdAt, source: o.source }] }))
    rmSync(join(data, 'projects', 'p1', 'outputs', a.output.id), { recursive: true, force: true })
    writeFileSync(a.output.path, 'changed outside, longer')
    writeFileSync(join(project, 'noise.md'), 'x')
    const fresh = createOutputsService(data)
    const r = await fresh.register(scope, { path: a.output.path, title: 'Doc' }, { runId: 'run_z' })
    expect(r).toMatchObject({ created: false, versioned: true })
    expect(r.output).toMatchObject({ version: 2, versionCount: 1 })
  })
})

describe('version caps through the service', () => {
  it('prunes the oldest droppable version past OUTPUT_VERSIONS_MAX and keeps v1, current and named ones', async () => {
    const a = await svc.produce(scope, md('Doc', { fileName: 'd.md', content: 'c1' }), src)
    svc.update('p1', { outputId: a.output.id, versionLabel: { n: 1, label: 'Original' } })
    for (let i = 2; i <= OUTPUT_VERSIONS_MAX + 3; i++) await svc.produce(scope, md('Doc', { fileName: 'd.md', content: `c${i}` }), src)
    const out = svc.get('p1', a.output.id)!
    expect(out).toMatchObject({ version: OUTPUT_VERSIONS_MAX + 3, versionCount: OUTPUT_VERSIONS_MAX, versionsPruned: true })
    const ns = svc.versions('p1', a.output.id).map((v) => v.n)
    expect(ns).toContain(1)
    expect(ns).toContain(OUTPUT_VERSIONS_MAX + 3)
    expect(ns).not.toContain(2)
    expect(existsSync(join(data, 'projects', 'p1', 'outputs', a.output.id, 'v2.md'))).toBe(false)
    expect(existsSync(join(data, 'projects', 'p1', 'outputs', a.output.id, 'v1.md'))).toBe(true)
  }, 60000)
})

describe('version storage cap (M4)', () => {
  it('refuses produce, register and saveEdit with the full sentence and writes nothing', async () => {
    const small = createOutputsService(data, { versionsBytesMax: 60 })
    const full = "OrgAI's version storage for this project is full. Delete or remove outputs to make room."
    const a = await small.produce(scope, md('A', { fileName: 'a.md', content: 'x'.repeat(30) }), src)
    await small.produce(scope, md('B', { fileName: 'b.md', content: 'y'.repeat(30) }), src)
    await expect(small.produce(scope, md('C', { fileName: 'c.md', content: 'z'.repeat(30) }), src)).rejects.toThrow(full)
    expect(existsSync(join(project, 'outputs', 'c.md'))).toBe(false)
    writeFileSync(join(project, 'mine.md'), 'q'.repeat(30))
    await expect(small.register(scope, { path: 'mine.md', title: 'Mine' }, src)).rejects.toThrow(full)
    expect(small.list('p1')).toHaveLength(2)
    const r = await small.saveEdit(scope, { outputId: a.output.id, text: 'e'.repeat(30), baseVersion: 1 })
    expect(r).toEqual({ refused: full })
    expect(readFileSync(join(project, 'outputs', 'a.md'), 'utf8')).toBe('x'.repeat(30))
    // an existing output cannot get a new produced version either, and its file stays as it was
    await expect(small.produce(scope, md('A', { fileName: 'a.md', content: 'n'.repeat(30) }), src)).rejects.toThrow(full)
    expect(readFileSync(join(project, 'outputs', 'a.md'), 'utf8')).toBe('x'.repeat(30))
  })
})

describe('delete captures an unseen outside change (L3)', () => {
  it('delete records the outside change as an external version, throws CHANGED and keeps the file', async () => {
    const a = await svc.produce(scope, md('A', { fileName: 'a.md', content: 'one' }), src)
    writeFileSync(a.output.path, 'edited outside')
    await expect(svc.delete(scope, { outputId: a.output.id })).rejects.toThrow('This output changed. Check it and delete again.')
    expect(existsSync(a.output.path)).toBe(true)
    expect(svc.versions('p1', a.output.id).map((v) => v.source)).toEqual(['external', 'agent'])
    expect(await svc.delete(scope, { outputId: a.output.id, expectedVersionCount: 2 })).toEqual([])
    expect(existsSync(a.output.path)).toBe(false)
  })
  it('deletePreview captures first, then reports the counts', async () => {
    const a = await svc.produce(scope, md('A', { fileName: 'a.md', content: 'one' }), src)
    writeFileSync(a.output.path, 'edited outside')
    expect(svc.deletePreview(scope, a.output.id)).toMatchObject({ versions: 2 })
    expect(svc.get('p1', a.output.id)?.version).toBe(2)
  })
})

describe('hard links (L5)', () => {
  it('register refuses a file that has another hard link', async () => {
    writeFileSync(join(project, 'a.md'), 'x')
    linkSync(join(project, 'a.md'), join(root, 'elsewhere.md'))
    await expect(svc.register(scope, { path: 'a.md', title: 'A' }, src)).rejects.toThrow(/hard link/)
  })
})

describe('preview queue (L2)', () => {
  afterEach(() => {
    previewHook.fn = undefined
  })
  it('runs previews one at a time, survives a rejection, and answers none past 8 pending', async () => {
    const order: string[] = []
    let n = 0
    const gates: Array<() => void> = []
    previewHook.fn = async (): Promise<OutputPreview> => {
      const i = n++
      order.push(`start${i}`)
      if (i === 0) throw new Error('boom')
      await new Promise<void>((res) => gates.push(res))
      order.push(`end${i}`)
      return { kind: 'none', reason: `ran ${i}` }
    }
    const o = (await svc.produce(scope, md('Q'), src)).output
    const calls = Array.from({ length: 8 }, () => svc.preview(scope, o.id))
    const ninth = await svc.preview(scope, o.id)
    expect(ninth).toEqual({ kind: 'none', reason: 'Too many previews are loading. Try again in a moment.' })
    const settled = calls.map((c) => c.then((v) => v, (e: Error) => `err:${e.message}`))
    for (let i = 0; i < 7; i++) {
      await vi.waitFor(() => expect(gates.length).toBe(i + 1))
      expect(order.filter((x) => x.startsWith('start')).length).toBe(i + 2)
      gates[i]()
    }
    const results = await Promise.all(settled)
    expect(results[0]).toBe('err:boom')
    expect(order.slice(0, 5)).toEqual(['start0', 'start1', 'end1', 'start2', 'end2'])
    // the queue is free again
    previewHook.fn = async () => ({ kind: 'none', reason: 'after' })
    expect(await svc.preview(scope, o.id)).toEqual({ kind: 'none', reason: 'after' })
  })
})
