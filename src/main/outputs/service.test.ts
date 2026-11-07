import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OutputsServiceApi, OutputScope } from './api'
import { createOutputsService } from './service'

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
  it('uses a name from the title and suffixes collisions', async () => {
    const a = await svc.produce(scope, md('Same'), src)
    const b = await svc.produce(scope, md('Same'), src)
    expect([a.output.fileName, b.output.fileName]).toEqual(['Same.md', 'Same (2).md'])
  })
  it('overwrites only its own produced file when asked', async () => {
    const a = await svc.produce(scope, md('Doc', { fileName: 'd.md' }), src)
    const b = await svc.produce(scope, md('Doc v2', { fileName: 'd.md', overwrite: true, content: 'new' }), src)
    expect(b.created).toBe(false)
    expect(b.output.id).toBe(a.output.id)
    expect(b.output.createdAt).toBe(a.output.createdAt)
    expect(b.output.updatedAt).toBeGreaterThanOrEqual(a.output.createdAt)
    expect(b.output.title).toBe('Doc v2')
    expect(readFileSync(join(project, 'outputs', 'd.md'), 'utf8')).toBe('new')
    expect(svc.list('p1')).toHaveLength(1)
    // another run does not overwrite it, it gets a suffix
    const c = await svc.produce(scope, md('Other', { fileName: 'd.md', overwrite: true }), { runId: 'run_b' })
    expect(c.created).toBe(true)
    expect(c.output.fileName).toBe('d (2).md')
    expect(readFileSync(join(project, 'outputs', 'd.md'), 'utf8')).toBe('new')
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
    await expect(svc.produce(scope, md('x'), src)).rejects.toThrow(/link/)
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
    const again = await svc.register(scope, { path: join(project, 'report.csv'), title: 'Report v2', kind: 'text', description: 'd' }, { runId: 'run_b' })
    expect(again.created).toBe(false)
    expect(again.output).toMatchObject({ id: r.output.id, title: 'Report v2', kind: 'text', runId: 'run_a', source: 'registered', createdAt: r.output.createdAt, description: 'd' })
    expect(again.output.updatedAt).toBeTruthy()
    expect(svc.list('p1')).toHaveLength(1)
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
      expect(() => svc.checkedPath(scope, a.output.id)).toThrow(/link/)
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
  it('delete removes a produced file and its entry; a missing file just drops the entry', async () => {
    const a = await svc.produce(scope, md('A'), src)
    const b = await svc.produce(scope, md('B'), src)
    expect(svc.delete(scope, a.output.id).map((o) => o.id)).toEqual([b.output.id])
    expect(existsSync(a.output.path)).toBe(false)
    unlinkSync(b.output.path)
    expect(svc.delete(scope, b.output.id)).toEqual([])
  })
  it('delete refuses a registered file outside outputs/ and keeps both file and entry', async () => {
    writeFileSync(join(project, 'mine.md'), 'x')
    const r = await svc.register(scope, { path: 'mine.md', title: 'Mine' }, src)
    expect(() => svc.delete(scope, r.output.id)).toThrow(/outputs folder/)
    expect(existsSync(join(project, 'mine.md'))).toBe(true)
    expect(svc.list('p1')).toHaveLength(1)
  })
  it('delete refuses when outputs/ became a link', async () => {
    const a = await svc.produce(scope, md('A'), src)
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'A.md'), 'precious')
    rmSync(join(project, 'outputs'), { recursive: true })
    symlinkSync(elsewhere, join(project, 'outputs'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => svc.delete(scope, a.output.id)).toThrow()
    expect(readFileSync(join(elsewhere, 'A.md'), 'utf8')).toBe('precious')
  })
  it('unknown ids and projects', () => {
    expect(() => svc.delete(scope, 'out_0000000000000000')).toThrow(/not in this project/)
    expect(svc.list('nope')).toEqual([])
    expect(svc.list('../x')).toEqual([])
  })
})
