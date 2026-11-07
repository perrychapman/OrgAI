import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OutputDiff, OutputThumb } from '@shared/types'
import { OUTPUT_EDIT_MAX_BYTES, OUTPUT_NOTES_MAX } from '@shared/types'
import type { OutputsServiceApi, OutputScope } from './api'
import { newNoteId, newRevisionId, writeNotes } from './notes'
import { createOutputsService } from './service'

const fmt = vi.hoisted(() => ({
  text: undefined as undefined | ((p: string, k: string) => Promise<unknown>),
  thumb: undefined as undefined | ((p: string, k: string) => Promise<unknown>),
  compare: undefined as undefined | ((a: string, b: string, k: string) => Promise<unknown>)
}))
vi.mock('./formats', async (orig) => {
  const real = await orig<typeof import('./formats')>()
  return {
    ...real,
    textForAgent: (...a: [string, never]) => (fmt.text ? fmt.text(...a) : real.textForAgent(...a)),
    thumbForFile: (...a: [string, never]) => (fmt.thumb ? fmt.thumb(...a) : real.thumbForFile(...a)),
    compareFiles: (...a: [string, string, never]) => (fmt.compare ? fmt.compare(...a) : real.compareFiles(...a))
  }
})

let root: string
let project: string
let data: string
let svc: OutputsServiceApi
let scope: OutputScope
let clock: number
const src = { runId: 'run_a', agentId: 'agent_1', role: 'Analyst' }
const md = (title: string, over = {}) => ({ kind: 'markdown' as const, title, content: `# ${title}`, fileName: 'doc.md', ...over })
const vdir = (id: string) => join(data, 'projects', 'p1', 'outputs', id)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orgai-outuser-'))
  project = join(root, 'proj')
  data = join(root, 'data')
  mkdirSync(project)
  mkdirSync(data)
  clock = 1000
  svc = createOutputsService(data, { now: () => (clock += 10) })
  scope = { projectId: 'p1', projectPath: project, allowedDirectories: [], referenceDirectories: [] }
})
afterEach(() => {
  fmt.text = fmt.thumb = fmt.compare = undefined
  rmSync(root, { recursive: true, force: true })
})

describe('readSource and saveEdit', () => {
  it('reads the current file from disk and an older version from its snapshot, editable kinds only', async () => {
    const a = (await svc.produce(scope, md('Doc'), src)).output
    await svc.produce(scope, md('Doc', { content: 'second' }), src)
    const cur = await svc.readSource(scope, a.id, 2)
    expect(cur).toMatchObject({ text: 'second' })
    expect((cur as { digest: string }).digest).toMatch(/^[0-9a-f]{64}$/)
    expect(await svc.readSource(scope, a.id, 1)).toMatchObject({ text: '# Doc' })
    expect(await svc.readSource(scope, a.id, 9)).toEqual({ refused: 'That version is not stored.' })
    const d = (await svc.produce(scope, { kind: 'docx', title: 'W', content: '# x' }, src)).output
    expect(await svc.readSource(scope, d.id, 1)).toEqual({ refused: 'That kind of file cannot be edited here.' })
    await expect(svc.readSource(scope, 'out_0000000000000000', 1)).rejects.toThrow(/not in this project/)
  })
  it('refuses a file over the edit cap and a non-UTF-8 file', async () => {
    writeFileSync(join(project, 'big.txt'), Buffer.alloc(OUTPUT_EDIT_MAX_BYTES + 1, 97))
    writeFileSync(join(project, 'bin.txt'), Buffer.from([0xff, 0xfe, 0xfd]))
    const big = (await svc.register(scope, { path: 'big.txt', title: 'Big' }, src)).output
    const bin = (await svc.register(scope, { path: 'bin.txt', title: 'Bin' }, src)).output
    expect(await svc.readSource(scope, big.id, 1)).toMatchObject({ refused: expect.stringMatching(/too large/) })
    expect(await svc.readSource(scope, bin.id, 1)).toMatchObject({ refused: expect.stringMatching(/as text/) })
  })
  it('saves the user text as a new edit version and rewrites the file', async () => {
    const a = (await svc.produce(scope, md('Doc'), src)).output
    const r = await svc.saveEdit(scope, { outputId: a.id, baseVersion: 1, text: '# Edited' })
    expect(r).toMatchObject({ ok: true, version: 2 })
    expect(readFileSync(a.path, 'utf8')).toBe('# Edited')
    expect(svc.get('p1', a.id)).toMatchObject({ version: 2, current: { source: 'edit' }, bytes: 8 })
    expect(svc.versions('p1', a.id).map((v) => v.source)).toEqual(['edit', 'agent'])
    expect(readFileSync(join(vdir(a.id), 'v2.md'), 'utf8')).toBe('# Edited')
  })
  it('answers stale when the base is not current, and forceNew saves anyway', async () => {
    const a = (await svc.produce(scope, md('Doc'), src)).output
    await svc.produce(scope, md('Doc', { content: 'agent v2' }), src)
    expect(await svc.saveEdit(scope, { outputId: a.id, baseVersion: 1, text: 'mine' })).toEqual({ stale: true, currentVersion: 2 })
    expect(readFileSync(a.path, 'utf8')).toBe('agent v2')
    expect(await svc.saveEdit(scope, { outputId: a.id, baseVersion: 1, text: 'mine', forceNew: true })).toMatchObject({ ok: true, version: 3 })
    expect(readFileSync(a.path, 'utf8')).toBe('mine')
  })
  it('captures an uncaptured disk change as external first (stale without forceNew, both versions with it)', async () => {
    const a = (await svc.produce(scope, md('Doc'), src)).output
    writeFileSync(a.path, 'typed in another editor')
    expect(await svc.saveEdit(scope, { outputId: a.id, baseVersion: 1, text: 'mine' })).toEqual({ stale: true, currentVersion: 2 })
    expect(svc.versions('p1', a.id).map((v) => v.source)).toEqual(['external', 'agent'])
    expect(await svc.saveEdit(scope, { outputId: a.id, baseVersion: 2, text: 'mine' })).toMatchObject({ ok: true, version: 3 })
    expect(readFileSync(join(vdir(a.id), 'v2.md'), 'utf8')).toBe('typed in another editor')
  })
  it('refuses active svg, invalid json, bad mermaid, NUL text, oversized text and other kinds', async () => {
    const s = (await svc.produce(scope, { kind: 'svg', title: 'S', content: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>' }, src)).output
    expect(await svc.saveEdit(scope, { outputId: s.id, baseVersion: 1, text: '<svg><script>alert(1)</script></svg>' })).toEqual({ refused: 'This drawing contains active content.' })
    const j = (await svc.produce(scope, { kind: 'json', title: 'J', content: '{}' }, src)).output
    expect(await svc.saveEdit(scope, { outputId: j.id, baseVersion: 1, text: '{' })).toMatchObject({ refused: expect.stringMatching(/not valid/) })
    expect(await svc.saveEdit(scope, { outputId: j.id, baseVersion: 1, text: '{"a":1}' })).toMatchObject({ ok: true })
    const m = (await svc.produce(scope, { kind: 'mermaid', title: 'M', content: 'flowchart TD\n A-->B' }, src)).output
    expect(await svc.saveEdit(scope, { outputId: m.id, baseVersion: 1, text: 'not a diagram' })).toMatchObject({ refused: expect.stringMatching(/Mermaid/) })
    const t = (await svc.produce(scope, { kind: 'text', title: 'T', content: 'x' }, src)).output
    expect(await svc.saveEdit(scope, { outputId: t.id, baseVersion: 1, text: 'a\u0000b' })).toMatchObject({ refused: expect.stringMatching(/NUL/) })
    expect(await svc.saveEdit(scope, { outputId: t.id, baseVersion: 1, text: 'x'.repeat(OUTPUT_EDIT_MAX_BYTES + 1) })).toMatchObject({ refused: expect.stringMatching(/too large/) })
    expect(await svc.saveEdit(scope, { outputId: t.id, baseVersion: 1, text: 5 as never })).toMatchObject({ refused: expect.any(String) })
    const x = (await svc.produce(scope, { kind: 'xlsx', title: 'X', content: { sheets: [{ name: 'a', rows: [[1]] }] } }, src)).output
    expect(await svc.saveEdit(scope, { outputId: x.id, baseVersion: 1, text: 'x' })).toEqual({ refused: 'That kind of file cannot be edited here.' })
    // a file body may hold what a title may not
    expect(await svc.saveEdit(scope, { outputId: t.id, baseVersion: 1, text: 'tab\there​' })).toMatchObject({ ok: true })
  })
  it('refuses with a sentence when the file moved behind a link', async () => {
    const a = (await svc.produce(scope, md('Doc'), src)).output
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    rmSync(join(project, 'outputs'), { recursive: true })
    symlinkSync(elsewhere, join(project, 'outputs'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await svc.saveEdit(scope, { outputId: a.id, baseVersion: 1, text: 'x' })).toEqual({ refused: 'OrgAI cannot write to that folder.' })
    expect(existsSync(join(elsewhere, 'doc.md'))).toBe(false)
  })
})

describe('restore', () => {
  it('writes the old bytes as a new restore version', async () => {
    const a = (await svc.produce(scope, md('Doc'), src)).output
    await svc.produce(scope, md('Doc', { content: 'second' }), src)
    const r = await svc.restore(scope, a.id, 1)
    expect(r).toMatchObject({ ok: true, version: 3 })
    expect(readFileSync(a.path, 'utf8')).toBe('# Doc')
    const v = svc.versions('p1', a.id)[0]
    expect(v).toMatchObject({ n: 3, source: 'restore', restoredFrom: 1 })
    expect(svc.get('p1', a.id)?.current?.source).toBe('restore')
  })
  it('recreates a missing file', async () => {
    const a = (await svc.produce(scope, md('Doc'), src)).output
    await svc.produce(scope, md('Doc', { content: 'second' }), src)
    unlinkSync(a.path)
    const r = await svc.restore(scope, a.id, 1)
    expect(r).toMatchObject({ ok: true })
    expect(readFileSync(a.path, 'utf8')).toBe('# Doc')
    expect(svc.get('p1', a.id)?.missing).toBeUndefined()
  })
  it('snapshots an uncaptured disk change as external before restoring', async () => {
    const a = (await svc.produce(scope, md('Doc'), src)).output
    await svc.produce(scope, md('Doc', { content: 'second' }), src)
    writeFileSync(a.path, 'outside edit')
    const r = await svc.restore(scope, a.id, 1)
    expect(r).toMatchObject({ ok: true, version: 4 })
    expect(svc.versions('p1', a.id).map((v) => v.source)).toEqual(['restore', 'external', 'agent', 'agent'])
    expect(readFileSync(join(vdir(a.id), 'v3.md'), 'utf8')).toBe('outside edit')
  })
  it('refuses the unchanged current version, an unknown one, a damaged snapshot and an unwritable folder', async () => {
    const a = (await svc.produce(scope, md('Doc'), src)).output
    expect(await svc.restore(scope, a.id, 1)).toEqual({ refused: 'That is already the current version.' })
    expect(await svc.restore(scope, a.id, 7)).toEqual({ refused: 'That version is not stored.' })
    await svc.produce(scope, md('Doc', { content: 'second' }), src)
    writeFileSync(join(vdir(a.id), 'v1.md'), 'tampered')
    expect(await svc.restore(scope, a.id, 1)).toEqual({ refused: "That version's stored copy is damaged." })
    expect(readFileSync(a.path, 'utf8')).toBe('second')
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    rmSync(join(project, 'outputs'), { recursive: true })
    symlinkSync(elsewhere, join(project, 'outputs'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await svc.restore(scope, a.id, 2)).toEqual({ refused: 'OrgAI cannot write to that folder.' })
  })
})

describe('update, statCurrent, captureExternal', () => {
  it('renames, describes, clears, labels versions and refuses bad input', async () => {
    const a = (await svc.produce(scope, md('Doc', { description: 'd' }), src)).output
    const u = svc.update('p1', { outputId: a.id, title: 'New title', description: '' })
    expect(u.title).toBe('New title')
    expect(u.description).toBeUndefined()
    expect(svc.get('p1', a.id)?.description).toBeUndefined()
    expect(svc.versions('p1', a.id)[0].title).toBe('Doc')
    svc.update('p1', { outputId: a.id, versionLabel: { n: 1, label: ' Final ' } })
    expect(svc.versions('p1', a.id)[0].label).toBe('Final')
    svc.update('p1', { outputId: a.id, versionLabel: { n: 1, label: '' } })
    expect(svc.versions('p1', a.id)[0].label).toBeUndefined()
    expect(svc.get('p1', a.id)?.version).toBe(1)
    expect(() => svc.update('p1', { outputId: a.id, title: '' })).toThrow(/empty/)
    expect(() => svc.update('p1', { outputId: a.id, versionLabel: { n: 1, label: 'a\nb' } })).toThrow(/hidden/)
    expect(() => svc.update('p1', { outputId: a.id, versionLabel: { n: 1, label: 'x'.repeat(61) } })).toThrow(/longer/)
    expect(() => svc.update('p1', { outputId: a.id, versionLabel: { n: 9, label: 'x' } })).toThrow(/not stored/)
    expect(() => svc.update('p1', { outputId: 'out_0000000000000000', title: 'x' })).toThrow(/not in this project/)
  })
  it('statCurrent answers size and mtime, null for missing, links and unknown ids', async () => {
    const a = (await svc.produce(scope, md('Doc'), src)).output
    expect(svc.statCurrent(scope, a.id)).toMatchObject({ size: 5 })
    expect(svc.statCurrent(scope, 'out_0000000000000000')).toBeNull()
    unlinkSync(a.path)
    expect(svc.statCurrent(scope, a.id)).toBeNull()
  })
  it('captureExternal adds one external version when the content changed, none otherwise, and never throws', async () => {
    const changes: string[] = []
    const s = createOutputsService(data, { now: () => (clock += 10), onChange: (_p, ids, what) => changes.push(`${what}:${ids.join()}`) })
    const a = (await s.produce(scope, md('Doc'), src)).output
    expect(await s.captureExternal(scope, a.id)).toBeNull()
    writeFileSync(a.path, 'changed outside')
    const r = await s.captureExternal(scope, a.id)
    expect(r).toMatchObject({ version: 2, current: { source: 'external' }, bytes: 15 })
    expect(changes).toEqual([`version:${a.id}`])
    expect(await s.captureExternal(scope, a.id)).toBeNull()
    // touched but same content: no version
    writeFileSync(a.path, 'changed outside')
    expect(await s.captureExternal(scope, a.id)).toBeNull()
    expect(s.versions('p1', a.id)).toHaveLength(2)
    unlinkSync(a.path)
    expect(await s.captureExternal(scope, a.id)).toBeNull()
    expect(await s.captureExternal(scope, 'out_0000000000000000')).toBeNull()
  })
  it('a save by OrgAI itself is not captured again as external', async () => {
    const a = (await svc.produce(scope, md('Doc'), src)).output
    await svc.saveEdit(scope, { outputId: a.id, baseVersion: 1, text: 'mine' })
    expect(await svc.captureExternal(scope, a.id)).toBeNull()
    expect(svc.versions('p1', a.id)).toHaveLength(2)
  })
})

describe('notes', () => {
  it('adds, updates, resolves, removes and keeps openNoteCount in step', async () => {
    const a = (await svc.produce(scope, md('Doc'), src)).output
    const n1 = svc.noteAdd('p1', { outputId: a.id, version: 1, anchor: { type: 'text', start: 0, end: 3, quote: '# D' }, text: 'Reword' })
    const n2 = svc.noteAdd('p1', { outputId: a.id, version: 1, anchor: { type: 'whole' }, text: 'Overall' })
    expect(svc.get('p1', a.id)?.openNoteCount).toBe(2)
    expect(svc.noteUpdate('p1', { outputId: a.id, noteId: n1.id, status: 'resolved' })).toMatchObject({ status: 'resolved' })
    expect(svc.get('p1', a.id)?.openNoteCount).toBe(1)
    expect(svc.versions('p1', a.id)[0]).toMatchObject({ noteCount: 2, openNoteCount: 1 })
    expect(svc.notes('p1', a.id).map((n) => n.id)).toEqual([n1.id, n2.id])
    expect(svc.noteRemove('p1', a.id, n2.id).map((n) => n.id)).toEqual([n1.id])
    expect(svc.get('p1', a.id)?.openNoteCount).toBe(0)
  })
  it('refuses hidden characters, a missing version, hostile anchors, pdf and other kinds, and the cap', async () => {
    const a = (await svc.produce(scope, md('Doc'), src)).output
    const add = (over = {}) => svc.noteAdd('p1', { outputId: a.id, version: 1, anchor: { type: 'whole' }, text: 'x', ...over })
    expect(() => add({ text: 'a‮b' })).toThrow(/hidden/)
    expect(() => add({ version: 5 })).toThrow(/not stored/)
    expect(() => add({ anchor: { type: 'text', start: 3, end: 1, quote: '' } })).toThrow(/not valid/)
    writeFileSync(join(project, 'a.pdf'), '%PDF')
    writeFileSync(join(project, 'a.bin'), 'x')
    const p = (await svc.register(scope, { path: 'a.pdf', title: 'P' }, src)).output
    const o = (await svc.register(scope, { path: 'a.bin', title: 'O' }, src)).output
    expect(() => svc.noteAdd('p1', { outputId: p.id, version: 1, anchor: { type: 'whole' }, text: 'x' })).toThrow(/not available/)
    expect(() => svc.noteAdd('p1', { outputId: o.id, version: 1, anchor: { type: 'whole' }, text: 'x' })).toThrow(/not available/)
    expect(() => svc.noteUpdate('p1', { outputId: a.id, noteId: 'note_ffffffffffffffff', text: 'x' })).toThrow(/not on this output/)
    writeNotes(data, 'p1', a.id, Array.from({ length: OUTPUT_NOTES_MAX }, () => ({ id: newNoteId(), outputId: a.id, version: 1, anchor: { type: 'whole' as const }, text: 't', status: 'open' as const, createdAt: 1 })))
    expect(() => add()).toThrow(/already has/)
  })
  it('an unreadable notes.json refuses writes and is not overwritten', async () => {
    const a = (await svc.produce(scope, md('Doc'), src)).output
    svc.noteAdd('p1', { outputId: a.id, version: 1, anchor: { type: 'whole' }, text: 'x' })
    const file = join(vdir(a.id), 'notes.json')
    writeFileSync(file, '{ broken')
    expect(svc.notes('p1', a.id)).toEqual([])
    expect(() => svc.noteAdd('p1', { outputId: a.id, version: 1, anchor: { type: 'whole' }, text: 'y' })).toThrow(/could not be read/)
    expect(readFileSync(file, 'utf8')).toBe('{ broken')
  })
})

describe('revision requests', () => {
  const request = (outputId: string, over = {}) => ({ id: newRevisionId(), outputId, version: 1, runId: 'run_a', mode: 'sent' as const, scope: 'notes' as const, createdAt: 5, ...over })
  it('records a request, marks its notes sent, lists newest first', async () => {
    const a = (await svc.produce(scope, md('Doc'), src)).output
    const n = svc.noteAdd('p1', { outputId: a.id, version: 1, anchor: { type: 'whole' }, text: 'x' })
    const r = svc.recordRevision('p1', request(a.id, { noteIds: [n.id] }))
    expect(svc.notes('p1', a.id)[0]).toMatchObject({ status: 'sent', sentIn: r.id })
    expect(svc.get('p1', a.id)?.openNoteCount).toBe(0)
    const r2 = svc.recordRevision('p1', request(a.id, { createdAt: 9, scope: 'whole' }))
    expect(svc.revisions('p1', a.id).map((x) => x.id)).toEqual([r2.id, r.id])
    expect(() => svc.recordRevision('p1', request(a.id, { id: 'nope' }))).toThrow(/id is not valid/)
    expect(() => svc.recordRevision('p1', request('out_0000000000000000'))).toThrow(/not in this project/)
  })
  it('a version by the run the newest open request went to answers it', async () => {
    const a = (await svc.produce(scope, md('Doc'), src)).output
    const r = svc.recordRevision('p1', request(a.id, { runId: 'run_b' }))
    // another run does not answer it
    const other = await svc.produce(scope, md('Doc', { content: 'other' }), { runId: 'run_c' })
    expect(other.answered).toBeUndefined()
    const w = await svc.produce(scope, md('Doc', { content: 'revised' }), { runId: 'run_b', agentId: 'ag' })
    expect(w.answered).toBe(r.id)
    expect(svc.versions('p1', a.id)[0].answers).toBe(r.id)
    expect(svc.revisions('p1', a.id)[0].answeredBy).toBe(3)
    // answered once only
    const again = await svc.produce(scope, md('Doc', { content: 'revised again' }), { runId: 'run_b' })
    expect(again.answered).toBeUndefined()
  })
  it('a register by that run answers too, and runEnded marks unanswered requests', async () => {
    writeFileSync(join(project, 'a.md'), 'one')
    const a = (await svc.register(scope, { path: 'a.md', title: 'A' }, src)).output
    const r = svc.recordRevision('p1', request(a.id, { runId: 'run_b' }))
    writeFileSync(join(project, 'a.md'), 'two')
    const w = await svc.register(scope, { path: 'a.md', title: 'A' }, { runId: 'run_b' })
    expect(w.answered).toBe(r.id)
    const open = svc.recordRevision('p1', request(a.id, { runId: 'run_d', createdAt: 20 }))
    const ended: string[] = []
    const s2 = createOutputsService(data, { onChange: (_p, ids, what) => ended.push(`${what}:${ids.join()}`) })
    expect(s2.runEnded('p1', 'run_zzz')).toEqual([])
    expect(s2.runEnded('p1', 'run_d')).toEqual([a.id])
    expect(ended).toEqual([`revision:${a.id}`])
    const list = s2.revisions('p1', a.id)
    expect(list.find((x) => x.id === open.id)?.endedAt).toBeTruthy()
    expect(list.find((x) => x.id === r.id)?.endedAt).toBeUndefined()
    expect(s2.runEnded('p1', 'run_d')).toEqual([])
  })
})

describe('readForAgent', () => {
  it('lists newest first with open note counts and more', async () => {
    for (let i = 0; i < 52; i++) await svc.produce(scope, md(`D${i}`, { fileName: `d${i}.md` }), src)
    const first = svc.list('p1')[0]
    svc.noteAdd('p1', { outputId: first.id, version: 1, anchor: { type: 'whole' }, text: 'x' })
    const r = await svc.readForAgent(scope, { action: 'list' })
    if (r.action !== 'list') throw new Error('shape')
    expect(r.items).toHaveLength(50)
    expect(r.more).toBe(2)
    expect(r.items[0]).toMatchObject({ id: first.id, kind: 'markdown', version: 1, openNotes: 1, relPath: expect.stringMatching(/^outputs\/d/) })
  })
  it('reads current text from the checked file and an older version from its snapshot', async () => {
    const seen: string[] = []
    fmt.text = async (p) => {
      seen.push(p)
      return { text: readFileSync(p, 'utf8'), truncated: false }
    }
    const a = (await svc.produce(scope, md('Doc'), src)).output
    await svc.produce(scope, md('Doc', { content: 'second' }), src)
    const cur = await svc.readForAgent(scope, { action: 'read', outputId: a.id })
    expect(cur).toMatchObject({ action: 'read', version: 2, text: 'second', truncated: false, kind: 'markdown' })
    const old = await svc.readForAgent(scope, { action: 'read', outputId: a.id, version: 1 })
    expect(old).toMatchObject({ version: 1, text: '# Doc' })
    expect(seen[0]).toBe(a.path)
    expect(seen[1]).toBe(join(vdir(a.id), 'v1.md'))
    await expect(svc.readForAgent(scope, { action: 'read', outputId: a.id, version: 8 })).rejects.toThrow(/not stored/)
  })
  it('throws the formats refusal and the unknown-id sentence', async () => {
    fmt.text = async () => ({ refused: 'OrgAI cannot read this kind of file as text.' })
    writeFileSync(join(project, 'a.pdf'), '%PDF')
    const p = (await svc.register(scope, { path: 'a.pdf', title: 'P' }, src)).output
    await expect(svc.readForAgent(scope, { action: 'read', outputId: p.id })).rejects.toThrow('OrgAI cannot read this kind of file as text.')
    await expect(svc.readForAgent(scope, { action: 'read', outputId: 'out_0000000000000000' })).rejects.toThrow("That output is not in this project's list.")
    await expect(svc.readForAgent(scope, { action: 'notes' })).rejects.toThrow(/not in this project/)
  })
  it('answers open and sent notes with their version numbers', async () => {
    const a = (await svc.produce(scope, md('Doc'), src)).output
    await svc.produce(scope, md('Doc', { content: 'second' }), src)
    const n1 = svc.noteAdd('p1', { outputId: a.id, version: 1, anchor: { type: 'whole' }, text: 'old note' })
    const n2 = svc.noteAdd('p1', { outputId: a.id, version: 2, anchor: { type: 'slide', slide: 1 }, text: 'open note' })
    const n3 = svc.noteAdd('p1', { outputId: a.id, version: 2, anchor: { type: 'whole' }, text: 'resolved note' })
    svc.noteUpdate('p1', { outputId: a.id, noteId: n3.id, status: 'resolved' })
    svc.recordRevision('p1', { id: newRevisionId(), outputId: a.id, version: 2, runId: 'r', mode: 'sent', scope: 'notes', noteIds: [n2.id], createdAt: 1 })
    const all = await svc.readForAgent(scope, { action: 'notes', outputId: a.id })
    if (all.action !== 'notes') throw new Error('shape')
    expect(all.version).toBe(2)
    expect(all.notes.map((n) => [n.id, n.version, n.status])).toEqual([[n1.id, 1, 'open'], [n2.id, 2, 'sent']])
    const v2 = await svc.readForAgent(scope, { action: 'notes', outputId: a.id, version: 2 })
    if (v2.action !== 'notes') throw new Error('shape')
    expect(v2.notes.map((n) => n.id)).toEqual([n2.id])
  })
})

describe('older version previews, thumbs and compare', () => {
  it('previews an older version from its snapshot and says so when it is gone', async () => {
    const a = (await svc.produce(scope, md('Doc'), src)).output
    await svc.produce(scope, md('Doc', { content: 'second' }), src)
    expect(await svc.preview(scope, a.id, 1)).toEqual({ kind: 'text', text: '# Doc' })
    expect(await svc.preview(scope, a.id, 2)).toEqual({ kind: 'text', text: 'second' })
    expect(await svc.preview(scope, a.id)).toEqual({ kind: 'text', text: 'second' })
    expect((await svc.preview(scope, a.id, 9)).kind).toBe('none')
    unlinkSync(join(vdir(a.id), 'v1.md'))
    expect(await svc.preview(scope, a.id, 1)).toEqual({ kind: 'none', reason: 'That version is no longer stored.' })
  })
  it('thumb and compare hand the right paths to the format layer and never throw', async () => {
    const a = (await svc.produce(scope, md('Doc'), src)).output
    await svc.produce(scope, md('Doc', { content: 'second' }), src)
    const calls: string[][] = []
    fmt.thumb = async (p, k): Promise<OutputThumb> => {
      calls.push([p, k])
      return { kind: 'lines', lines: ['x'] }
    }
    fmt.compare = async (x, y, k): Promise<OutputDiff> => {
      calls.push([x, y, k])
      return { kind: 'none', reason: 'stub' }
    }
    expect(await svc.thumb(scope, a.id, 1)).toEqual({ kind: 'lines', lines: ['x'] })
    expect(await svc.compare(scope, { outputId: a.id, a: 1, b: 2 })).toEqual({ kind: 'none', reason: 'stub' })
    expect(calls).toEqual([[join(vdir(a.id), 'v1.md'), 'markdown'], [join(vdir(a.id), 'v1.md'), a.path, 'markdown']])
    expect(await svc.thumb(scope, a.id, 9)).toEqual({ kind: 'none' })
    expect(await svc.thumb(scope, 'out_0000000000000000', 1)).toEqual({ kind: 'none' })
    expect(await svc.compare(scope, { outputId: a.id, a: 1, b: 9 })).toMatchObject({ kind: 'none' })
    fmt.thumb = async () => {
      throw new Error('boom')
    }
    expect(await svc.thumb(scope, a.id, 1)).toEqual({ kind: 'none' })
  })
})
