import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OUTPUTS_MAX } from '@shared/types'
import { createOutputStore, outputsFile } from './store'

let data: string
beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'orgai-outstore-'))
})
afterEach(() => rmSync(data, { recursive: true, force: true }))

const entry = (n: number, over = {}) => ({
  runId: 'run_1',
  kind: 'markdown' as const,
  title: `T${n}`,
  fileName: `f${n}.md`,
  path: resolve(data, 'p', `f${n}.md`),
  relPath: `outputs/f${n}.md`,
  bytes: 3,
  createdAt: n,
  source: 'produced' as const,
  ...over
})

describe('output store', () => {
  it('adds, gets, finds by path, updates, removes', () => {
    const s = createOutputStore(data)
    const a = s.add('p1', entry(1))
    expect(a.id).toMatch(/^out_[0-9a-f]{16}$/)
    expect(s.get('p1', a.id)?.title).toBe('T1')
    expect(s.byPath('p1', entry(1).path)?.id).toBe(a.id)
    if (process.platform === 'win32') expect(s.byPath('p1', entry(1).path.toUpperCase())?.id).toBe(a.id)
    expect(s.update('p1', a.id, { title: 'New', updatedAt: 9 })?.title).toBe('New')
    expect(s.get('p1', a.id)?.updatedAt).toBe(9)
    expect(s.remove('p1', a.id)).toBe(true)
    expect(s.remove('p1', a.id)).toBe(false)
    expect(s.list('p1')).toEqual([])
  })
  it('drops junk entries on read but keeps the good ones', () => {
    const s = createOutputStore(data)
    const a = s.add('p1', entry(1))
    const file = outputsFile(data, 'p1')
    const j = JSON.parse(readFileSync(file, 'utf8'))
    j.outputs.push({ id: 'bad' }, { ...a, id: 'out_0123456789abcdef', kind: 'exe' }, { ...a, id: 'out_0123456789abcdee', path: 'rel.md' }, { ...a, id: 'out_0123456789abcded', bytes: -1 }, { ...a, id: 'out_0123456789abcdec', title: 'a‮b' }, 7, null)
    writeFileSync(file, JSON.stringify(j))
    expect(s.list('p1').map((o) => o.id)).toEqual([a.id])
  })
  it('an unreadable index reads empty and refuses writes without overwriting', () => {
    const s = createOutputStore(data)
    mkdirSync(join(data, 'projects', 'p1'), { recursive: true })
    const file = outputsFile(data, 'p1')
    writeFileSync(file, '{ not json')
    expect(s.list('p1')).toEqual([])
    expect(() => s.add('p1', entry(1))).toThrow(/could not be read/)
    expect(readFileSync(file, 'utf8')).toBe('{ not json')
    writeFileSync(file, JSON.stringify({ version: 2, outputs: [] }))
    expect(() => s.add('p1', entry(1))).toThrow(/could not be read/)
  })
  it('forgets the oldest past OUTPUTS_MAX', () => {
    const s = createOutputStore(data)
    const file = outputsFile(data, 'p1')
    s.add('p1', entry(1))
    const j = JSON.parse(readFileSync(file, 'utf8'))
    for (let n = 2; n <= OUTPUTS_MAX; n++) j.outputs.push({ ...j.outputs[0], id: `out_${n.toString(16).padStart(16, '0')}`, createdAt: n })
    writeFileSync(file, JSON.stringify(j))
    expect(s.list('p1').length).toBe(OUTPUTS_MAX)
    s.add('p1', entry(5000))
    const after = s.list('p1')
    expect(after.length).toBe(OUTPUTS_MAX)
    expect(after.some((o) => o.createdAt === 1)).toBe(false)
    expect(after.some((o) => o.createdAt === 5000)).toBe(true)
  })
  it('rejects an unsafe project id', () => {
    const s = createOutputStore(data)
    expect(s.list('../x')).toEqual([])
    expect(() => s.add('../x', entry(1))).toThrow()
  })
})
