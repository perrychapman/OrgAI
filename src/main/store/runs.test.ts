import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { ImageAttachment, RunRecord, RunSummary, RunUsage, TranscriptEntry } from '@shared/types'
import { RunStore, cleanRunOverrides, normalizeCrashedRunSummary } from './runs'

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'orgai-runs-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

function run(id: string, over: Partial<RunSummary> = {}): RunSummary {
  return { id, projectId: 'p1', kind: 'work', prompt: `prompt ${id}`, status: 'finished', startedAt: 1000, totalCostUsd: 0, ...over }
}

function record(summary: RunSummary, over: Partial<RunRecord> = {}): RunRecord {
  return { summary, agents: {}, transcript: [], logs: [], ...over }
}

const recordFiles = (): string[] => (existsSync(join(dataDir, 'runs')) ? readdirSync(join(dataDir, 'runs')).sort() : [])

describe('RunStore', () => {
  it('upserts and lists runs per project, newest first', () => {
    const s = new RunStore(dataDir)
    s.upsert(run('a', { startedAt: 1 }))
    s.upsert(run('b', { startedAt: 3 }))
    s.upsert(run('c', { startedAt: 2, projectId: 'p2' }))
    s.upsert(run('a', { startedAt: 1, prompt: 'updated' }))
    expect(s.list('p1').map((r) => r.id)).toEqual(['b', 'a'])
    expect(s.list('p1')[1].prompt).toBe('updated')
    expect(s.list('p2').map((r) => r.id)).toEqual(['c'])
    expect(s.list('nope')).toEqual([])
    expect(s.allProjectIds().sort()).toEqual(['p1', 'p1', 'p2'])
  })

  it('persists to runs.json and reloads', () => {
    const s = new RunStore(dataDir)
    s.upsert(run('a'))
    const onDisk = JSON.parse(readFileSync(join(dataDir, 'runs.json'), 'utf8'))
    expect(onDisk.version).toBe(1)
    expect(onDisk.runs).toHaveLength(1)
    expect(new RunStore(dataDir).list('p1').map((r) => r.id)).toEqual(['a'])
  })

  it('marks runs left live by a previous session as finished on load', () => {
    const s = new RunStore(dataDir)
    s.upsert(run('live', { status: 'running' }))
    s.upsert(run('bad', { status: 'error' }))
    s.upsert(run('done', { status: 'finished', sessionId: 'sess' }))
    const reloaded = new RunStore(dataDir).list('p1')
    const live = reloaded.find((r) => r.id === 'live')!
    expect(live.status).toBe('finished')
    expect(live.endedAt).toBeTypeOf('number')
    expect(live.endedWithApp).toBe(true)
    expect(live.endedBy).toBe('app')
    expect(reloaded.find((r) => r.id === 'done')!.endedBy).toBeUndefined()
    expect(reloaded.find((r) => r.id === 'bad')!.status).toBe('error')
    expect(reloaded.find((r) => r.id === 'bad')!.endedWithApp).toBeUndefined()
    expect(reloaded.find((r) => r.id === 'done')!.endedWithApp).toBeUndefined()
  })

  it('keeps a valid endedBy and drops junk values on load', () => {
    const s = new RunStore(dataDir)
    s.upsert(run('user', { status: 'finished', endedBy: 'user' }))
    s.upsert(run('app', { status: 'finished', endedBy: 'app', endedWithApp: true }))
    s.upsert(run('junk', { status: 'finished', endedBy: 'someone' as never }))
    s.upsert(run('obj', { status: 'error', endedBy: { x: 1 } as never }))
    const reloaded = new RunStore(dataDir)
    expect(reloaded.get('user')!.endedBy).toBe('user')
    expect(reloaded.get('app')!.endedBy).toBe('app')
    expect('endedBy' in reloaded.get('junk')!).toBe(false)
    expect('endedBy' in reloaded.get('obj')!).toBe(false)
  })

  it('keeps an End session under way as the user\'s end at boot', () => {
    const s = new RunStore(dataDir)
    s.upsert(run('stopping', { status: 'stopping', endedBy: 'user' }))
    s.upsert(run('idle-user', { status: 'idle', endedBy: 'user', endedWhile: 'waiting' }))
    const reloaded = new RunStore(dataDir)
    for (const id of ['stopping', 'idle-user']) {
      const r = reloaded.get(id)!
      expect(r).toMatchObject({ status: 'finished', endedBy: 'user' })
      expect(r.endedAt).toBeTypeOf('number')
      expect('endedWithApp' in r).toBe(false)
      expect('endedWhile' in r).toBe(false)
    }
  })

  it('normalizes endedWithApp: exactly true, only with endedBy app, and a legacy flag gets endedBy app', () => {
    const s = new RunStore(dataDir)
    s.upsert(run('legacy', { status: 'finished', endedWithApp: true }))
    s.upsert(run('user', { status: 'finished', endedBy: 'user', endedWithApp: true }))
    s.upsert(run('junk', { status: 'finished', endedBy: 'app', endedWithApp: 'yes' as never }))
    s.upsert(run('false', { status: 'finished', endedWithApp: false as never }))
    const reloaded = new RunStore(dataDir)
    expect(reloaded.get('legacy')).toMatchObject({ endedBy: 'app', endedWithApp: true })
    expect(reloaded.get('user')!.endedBy).toBe('user')
    expect('endedWithApp' in reloaded.get('user')!).toBe(false)
    expect('endedWithApp' in reloaded.get('junk')!).toBe(false)
    expect(reloaded.get('junk')!.endedBy).toBe('app')
    expect('endedWithApp' in reloaded.get('false')!).toBe(false)
    expect('endedBy' in reloaded.get('false')!).toBe(false)
  })

  it('drops index entries that are not objects with a string id instead of throwing', () => {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify({ version: 1, runs: [null, 3, 'x', [], { id: 7 }, run('ok', { status: 'running' })] }))
    const reloaded = new RunStore(dataDir)
    expect(reloaded.list('p1').map((r) => r.id)).toEqual(['ok'])
    expect(reloaded.get('ok')).toMatchObject({ status: 'finished', endedBy: 'app', endedWithApp: true, endedWhile: 'working' })
  })

  it('reads a runs.json of null or without a runs array as empty', () => {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(join(dataDir, 'runs.json'), 'null')
    expect(new RunStore(dataDir).list('p1')).toEqual([])
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify({ runs: { id: 'a' } }))
    expect(new RunStore(dataDir).list('p1')).toEqual([])
  })

  it('derives endedWhile from the status as saved and drops junk values', () => {
    const s = new RunStore(dataDir)
    s.upsert(run('idle', { status: 'idle' }))
    s.upsert(run('starting', { status: 'starting' }))
    s.upsert(run('running', { status: 'running' }))
    s.upsert(run('stopping', { status: 'stopping' }))
    s.upsert(run('paused', { status: 'paused', endedWhile: 'working' }))
    s.upsert(run('kept', { status: 'finished', endedBy: 'app', endedWithApp: true, endedWhile: 'waiting' }))
    s.upsert(run('junk', { status: 'finished', endedBy: 'app', endedWithApp: true, endedWhile: 'sleeping' as never }))
    s.upsert(run('user', { status: 'finished', endedBy: 'user', endedWhile: 'working' }))
    s.upsert(run('own', { status: 'finished', endedWhile: { x: 1 } as never }))
    const reloaded = new RunStore(dataDir)
    expect(reloaded.get('idle')!.endedWhile).toBe('waiting')
    for (const id of ['starting', 'running', 'stopping']) expect(reloaded.get(id)!.endedWhile).toBe('working')
    expect(reloaded.get('kept')!.endedWhile).toBe('waiting')
    for (const id of ['paused', 'junk', 'user', 'own']) expect(id + ':' + ('endedWhile' in reloaded.get(id)!)).toBe(id + ':false')
  })

  it('finishes a paused run on load but keeps when it could continue', () => {
    const s = new RunStore(dataDir)
    s.upsert(run('paused', { status: 'paused', pausedUntil: 5000, pauseReason: 'limit', autoResume: true }))
    const reloaded = new RunStore(dataDir).get('paused')!
    expect(reloaded).toMatchObject({ status: 'finished', pausedUntil: 5000, pauseReason: 'limit', endedWithApp: true, endedBy: 'app' })
    expect(reloaded.autoResume).toBeUndefined()
  })

  it('defaults a missing kind to work and survives a corrupt index', () => {
    writeFileSync(join(dataDir, 'runs.json'), JSON.stringify({ runs: [{ ...run('old'), kind: undefined }] }), 'utf8')
    expect(new RunStore(dataDir).list('p1')[0].kind).toBe('work')
    writeFileSync(join(dataDir, 'runs.json'), '{not json', 'utf8')
    expect(new RunStore(dataDir).list('p1')).toEqual([])
  })

  it('saves and reads records, with the index winning for status', () => {
    const s = new RunStore(dataDir)
    const summary = run('r1', { status: 'running' })
    s.upsert(summary)
    s.saveRecord(record(summary, { logs: [{ at: 1, level: 'info', message: 'hello' }] }))
    s.upsert({ ...summary, status: 'finished', endedAt: 5 })
    const got = s.getRecord('r1')!
    expect(got.summary.status).toBe('finished')
    expect(got.summary.endedAt).toBe(5)
    expect(got.logs[0].message).toBe('hello')
    expect(s.getRecord('missing')).toBeNull()
  })

  it('returns a record that is not in the index as stored', () => {
    const s = new RunStore(dataDir)
    s.saveRecord(record(run('loose', { status: 'running' })))
    expect(s.getRecord('loose')!.summary.status).toBe('running')
  })

  it('trims long logs and sanitizes record file names', () => {
    const s = new RunStore(dataDir)
    const logs = Array.from({ length: 450 }, (_, i) => ({ at: i, level: 'info' as const, message: `l${i}` }))
    s.saveRecord(record(run('a/b:c'), { logs }))
    expect(recordFiles()).toEqual(['a_b_c.json'])
    const got = s.getRecord('a/b:c')!
    expect(got.logs).toHaveLength(400)
    expect(got.logs[0].message).toBe('l50')
  })

  it('removes a project with its records', () => {
    const s = new RunStore(dataDir)
    s.upsert(run('a'))
    s.upsert(run('b', { projectId: 'p2' }))
    s.saveRecord(record(run('a')))
    s.saveRecord(record(run('b', { projectId: 'p2' })))
    expect(s.removeProject('p1')).toBe(1)
    expect(s.list('p1')).toEqual([])
    expect(recordFiles()).toEqual(['b.json'])
    expect(s.removeProject('p1')).toBe(0)
    expect(new RunStore(dataDir).list('p2')).toHaveLength(1)
  })

  it('prunes old finished runs per project, keeping live ones and at least one', () => {
    const s = new RunStore(dataDir)
    for (let i = 1; i <= 5; i++) {
      const r = run(`r${i}`, { startedAt: i, status: i === 1 ? 'running' : 'finished' })
      s.upsert(r)
      s.saveRecord(record(r))
    }
    s.upsert(run('q1', { projectId: 'p2', startedAt: 1 }))
    s.upsert(run('q2', { projectId: 'p2', startedAt: 2 }))
    const removed = s.prune((projectId) => (projectId === 'p1' ? 2 : 0))
    // p1 keeps r5, r4 and the live r1; p2 keeps at least one (q2).
    expect(removed).toBe(3)
    expect(s.list('p1').map((r) => r.id)).toEqual(['r5', 'r4', 'r1'])
    expect(s.list('p2').map((r) => r.id)).toEqual(['q2'])
    expect(recordFiles()).toEqual(['r1.json', 'r4.json', 'r5.json'])
    expect(s.prune(() => 10)).toBe(0)
  })

  it('sweeps record files nobody indexes', () => {
    const s = new RunStore(dataDir)
    expect(s.sweepOrphans()).toBe(0)
    s.upsert(run('kept'))
    s.saveRecord(record(run('kept')))
    s.saveRecord(record(run('orphan')))
    mkdirSync(join(dataDir, 'runs'), { recursive: true })
    writeFileSync(join(dataDir, 'runs', 'notes.txt'), 'not a record', 'utf8')
    expect(s.sweepOrphans()).toBe(1)
    expect(recordFiles()).toEqual(['kept.json', 'notes.txt'])
  })
})

describe('RunStore image store', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64')
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]).toString('base64')
  const sha = (b64: string): string => createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex')
  const imagesDir = (id: string): string => join(dataDir, 'runs', id, 'images')
  const userEntry = (id: string, images: ImageAttachment[]): TranscriptEntry => ({ id, agentId: 'root', at: 1, block: { kind: 'user', text: 'look', images } })
  const imagesOf = (r: RunRecord, i = 0): ImageAttachment[] => {
    const b = r.transcript[i].block
    return b.kind === 'user' ? (b.images ?? []) : []
  }

  it('writes images to disk once and persists refs without data, leaving the input untouched', () => {
    const s = new RunStore(dataDir)
    const png: ImageAttachment = { mediaType: 'image/png', data: PNG, name: 'a.png' }
    const rec = record(run('r1'), { transcript: [userEntry('e1', [png, { mediaType: 'image/jpeg', data: JPEG }]), userEntry('e2', [{ ...png }])] })
    s.saveRecord(rec)
    s.saveRecord(rec)
    expect(png.data).toBe(PNG)
    expect(png.ref).toBeUndefined()
    expect(readdirSync(imagesDir('r1')).sort()).toEqual([`${sha(PNG)}.png`, `${sha(JPEG)}.jpg`].sort())
    expect(readFileSync(join(imagesDir('r1'), `${sha(PNG)}.png`)).toString('base64')).toBe(PNG)
    const raw = readFileSync(join(dataDir, 'runs', 'r1.json'), 'utf8')
    expect(raw).not.toContain(PNG)
    expect(imagesOf(JSON.parse(raw) as RunRecord)).toEqual([
      { mediaType: 'image/png', data: '', name: 'a.png', ref: `${sha(PNG)}.png` },
      { mediaType: 'image/jpeg', data: '', ref: `${sha(JPEG)}.jpg` }
    ])
  })

  it('rehydrates data on load and drops refs; re-saving a loaded record keeps one file', () => {
    const s = new RunStore(dataDir)
    s.saveRecord(record(run('r1'), { transcript: [userEntry('e1', [{ mediaType: 'image/png', data: PNG, name: 'a.png' }])] }))
    const got = new RunStore(dataDir).getRecord('r1')!
    expect(imagesOf(got)).toEqual([{ mediaType: 'image/png', data: PNG, name: 'a.png' }])
    s.saveRecord(got)
    expect(readdirSync(imagesDir('r1'))).toEqual([`${sha(PNG)}.png`])
  })

  it('leaves data empty for a missing file or a ref that escapes the store', () => {
    const s = new RunStore(dataDir)
    s.saveRecord(record(run('r1'), { transcript: [userEntry('e1', [{ mediaType: 'image/png', data: PNG }])] }))
    rmSync(imagesDir('r1'), { recursive: true })
    writeFileSync(join(dataDir, 'secret.png'), 'x')
    const file = join(dataDir, 'runs', 'r1.json')
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as RunRecord
    imagesOf(onDisk).push({ mediaType: 'image/png', data: '', ref: '../../secret.png' })
    writeFileSync(file, JSON.stringify(onDisk))
    expect(imagesOf(s.getRecord('r1')!)).toEqual([
      { mediaType: 'image/png', data: '' },
      { mediaType: 'image/png', data: '' }
    ])
  })

  it('loads legacy records with inline data unchanged', () => {
    const legacy = record(run('old'), { transcript: [userEntry('e1', [{ mediaType: 'image/png', data: PNG }])] })
    mkdirSync(join(dataDir, 'runs'), { recursive: true })
    writeFileSync(join(dataDir, 'runs', 'old.json'), JSON.stringify(legacy))
    expect(imagesOf(new RunStore(dataDir).getRecord('old')!)).toEqual([{ mediaType: 'image/png', data: PNG }])
  })

  it('deletes the images directory with the run (remove, prune, project removal, orphan sweep)', () => {
    const s = new RunStore(dataDir)
    const withImage = (id: string, over: Partial<RunSummary> = {}): void => {
      const r = run(id, over)
      s.upsert(r)
      s.saveRecord(record(r, { transcript: [userEntry('e1', [{ mediaType: 'image/png', data: PNG }])] }))
    }
    withImage('gone')
    s.removeRecord('gone')
    expect(existsSync(join(dataDir, 'runs', 'gone'))).toBe(false)

    withImage('old', { startedAt: 1 })
    withImage('new', { startedAt: 5000 })
    expect(s.prune(() => 1)).toBe(2) // drops 'gone' (still indexed) and 'old'
    expect(existsSync(join(dataDir, 'runs', 'old'))).toBe(false)
    expect(existsSync(imagesDir('new'))).toBe(true)

    withImage('other', { projectId: 'p2' })
    s.removeProject('p2')
    expect(existsSync(join(dataDir, 'runs', 'other'))).toBe(false)

    s.saveRecord(record(run('orphan'), { transcript: [userEntry('e1', [{ mediaType: 'image/png', data: PNG }])] }))
    expect(s.sweepOrphans()).toBe(2) // orphan.json and orphan/
    expect(recordFiles()).toEqual(['new', 'new.json'])
  })
})

describe('RunStore usage', () => {
  it('keeps usage with the summary and fills several missing ones in one write', () => {
    const usage: RunUsage = { tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, costUsd: 1, costSource: 'computed', models: [], roles: [], wallMs: 1, turns: 0, toolCalls: 0, retries: 0, agents: 1, agentsWithoutResult: 0, noResultTokens: 0, nudges: 0, waitingMs: 0, limitHoldMs: 0, idleMs: 0, updatedAt: 1 }
    const store = new RunStore(dataDir)
    store.upsert(run('old'))
    store.upsert(run('new', { usage }))
    expect(new RunStore(dataDir).get('new')!.usage).toEqual(usage)
    expect(new RunStore(dataDir).get('old')!.usage).toBeUndefined()
    store.setUsage([{ id: 'old', usage: { ...usage, updatedAt: 9 } }, { id: 'new', usage: { ...usage, updatedAt: 9 } }, { id: 'ghost', usage }])
    const again = new RunStore(dataDir)
    expect(again.get('old')!.usage?.updatedAt).toBe(9)
    expect(again.get('new')!.usage?.updatedAt).toBe(1) // existing usage is kept
    expect(again.get('ghost')).toBeNull()
  })

  it('reports removed runs to onRunsRemoved on prune and removeProject, and survives a throwing hook', () => {
    const s = new RunStore(dataDir)
    const seen: string[][] = []
    s.onRunsRemoved = (removed) => seen.push(removed.map((r) => r.id))
    s.upsert(run('a', { projectId: 'quick', startedAt: 1 }))
    s.upsert(run('b', { projectId: 'quick', startedAt: 2 }))
    s.upsert(run('c', { projectId: 'p2' }))
    expect(s.prune(() => 1)).toBe(1)
    expect(seen).toEqual([['a']])
    s.removeProject('p2')
    expect(seen).toEqual([['a'], ['c']])
    s.onRunsRemoved = () => {
      throw new Error('boom')
    }
    expect(s.removeProject('quick')).toBe(1)
  })

  it('moves runs to another project and keeps virtual-project runs across a restart', () => {
    const s = new RunStore(dataDir)
    s.upsert(run('a', { projectId: 'quick', quick: { folder: '/x', team: 'single', allowEdits: false, gitRepo: false } }))
    s.upsert(run('b', { projectId: 'quick' }))
    s.saveRecord(record(run('a', { projectId: 'quick' })))
    expect(new RunStore(dataDir).list('quick').map((r) => r.id).sort()).toEqual(['a', 'b'])
    const moved = s.moveToProject(['a', 'ghost'], 'p9')
    expect(moved.map((r) => r.id)).toEqual(['a'])
    expect(s.list('p9').map((r) => r.id)).toEqual(['a'])
    expect(s.list('quick').map((r) => r.id)).toEqual(['b'])
    expect(s.getRecord('a')!.summary.projectId).toBe('p9')
    expect(new RunStore(dataDir).get('a')!.projectId).toBe('p9')
    expect(s.all().length).toBe(2)
    expect(s.get('a')!.quick).toBeUndefined() // a promoted run is a project run
  })
})

describe('RunStore exec fields (cli-spec Wave 0)', () => {
  const writeIndex = (runs: unknown[]): void => writeFileSync(join(dataDir, 'runs.json'), JSON.stringify({ version: 1, runs }), 'utf8')

  it('normalizes stored conversation budgets and model adapters', () => {
    const invalidBudgets: unknown[] = [0, -1, '5', null, {}, []]
    const invalidAdapters: unknown[] = ['other', 'Claude', '', 1, null, {}]
    writeIndex([
      ...[0.01, 100].map((budget, i) => run(`budget-${i}`, { conversationBudgetUsd: budget })),
      ...invalidBudgets.map((budget, i) => run(`bad-budget-${i}`, { conversationBudgetUsd: budget as number })),
      ...(['claude', 'codex', 'mock'] as const).map((adapter) => run(adapter, { modelAdapter: adapter })),
      ...invalidAdapters.map((adapter, i) => run(`bad-adapter-${i}`, { modelAdapter: adapter as never }))
    ])
    const s = new RunStore(dataDir)
    expect(s.get('budget-0')!.conversationBudgetUsd).toBe(0.01)
    expect(s.get('budget-1')!.conversationBudgetUsd).toBe(100)
    invalidBudgets.forEach((_, i) => expect('conversationBudgetUsd' in s.get(`bad-budget-${i}`)!).toBe(false))
    for (const adapter of ['claude', 'codex', 'mock']) expect(s.get(adapter)!.modelAdapter).toBe(adapter)
    invalidAdapters.forEach((_, i) => expect('modelAdapter' in s.get(`bad-adapter-${i}`)!).toBe(false))
    for (const budget of [NaN, Infinity, -Infinity]) {
      expect('conversationBudgetUsd' in normalizeCrashedRunSummary(run('nonfinite', { conversationBudgetUsd: budget }))).toBe(false)
    }
  })

  it('recovers a staged model selection for every supported run kind after reload', () => {
    const store = new RunStore(dataDir)
    const selection = { model: 'next-model', connection: 'custom-connection' }
    for (const kind of ['work', 'setup', 'mcp-assist', 'skill-assist'] as const) {
      store.upsert(run(kind, { kind, status: 'error', modelSelection: selection, modelAdapter: 'codex', conversationBudgetUsd: 2.5 }))
    }
    const reloaded = new RunStore(dataDir)
    for (const kind of ['work', 'setup', 'mcp-assist', 'skill-assist'] as const) {
      expect(reloaded.get(kind)).toMatchObject({ kind, status: 'error', modelSelection: selection, modelAdapter: 'codex', conversationBudgetUsd: 2.5 })
      expect(reloaded.get(kind)!.sessionId).toBeUndefined()
    }
  })

  it("keeps endedBy 'policy' and 'budget' across a reload, and a live one still finishes with it", () => {
    const s = new RunStore(dataDir)
    s.upsert(run('policy', { status: 'finished', endedBy: 'policy' }))
    s.upsert(run('budget', { status: 'error', endedBy: 'budget' }))
    s.upsert(run('live-policy', { status: 'running', endedBy: 'policy', endedWhile: 'working', endedWithApp: true }))
    s.upsert(run('stopping-budget', { status: 'stopping', endedBy: 'budget' }))
    const reloaded = new RunStore(dataDir)
    expect(reloaded.get('policy')!.endedBy).toBe('policy')
    expect(reloaded.get('budget')).toMatchObject({ status: 'error', endedBy: 'budget' })
    for (const id of ['live-policy', 'stopping-budget']) {
      const r = reloaded.get(id)!
      expect(r.status).toBe('finished')
      expect(r.endedAt).toBeTypeOf('number')
      expect('endedWithApp' in r).toBe(false)
      expect('endedWhile' in r).toBe(false)
    }
    expect(reloaded.get('live-policy')!.endedBy).toBe('policy')
    expect(reloaded.get('stopping-budget')!.endedBy).toBe('budget')
  })

  it('drops a junk endedBy', () => {
    writeIndex([run('a', { endedBy: 'robot' as never }), run('b', { endedBy: 7 as never }), run('c', { status: 'idle', endedBy: 'POLICY' as never })])
    const s = new RunStore(dataDir)
    expect('endedBy' in s.get('a')!).toBe(false)
    expect('endedBy' in s.get('b')!).toBe(false)
    // A live run with a junk endedBy is treated like any crashed run: OrgAI cut it.
    expect(s.get('c')).toMatchObject({ status: 'finished', endedBy: 'app', endedWithApp: true, endedWhile: 'waiting' })
  })

  it('keeps valid execOutcome values and drops junk', () => {
    writeIndex([
      run('ok', { execOutcome: 'completed' }),
      run('int', { execOutcome: 'interrupted' }),
      run('junk', { execOutcome: 'exploded' as never }),
      run('num', { execOutcome: 3 as never })
    ])
    const s = new RunStore(dataDir)
    expect(s.get('ok')!.execOutcome).toBe('completed')
    expect(s.get('int')!.execOutcome).toBe('interrupted')
    expect('execOutcome' in s.get('junk')!).toBe(false)
    expect('execOutcome' in s.get('num')!).toBe(false)
  })

  it('rebuilds overrides: unknown keys and bad types dropped, an empty result removed', () => {
    writeIndex([
      run('good', {
        overrides: {
          permissionMode: 'plan',
          autoContinue: false,
          maxAutoContinues: 10,
          maxBudgetUsd: 0,
          allowUnpricedBudget: true,
          allowUnmerged: false,
          allowPeerMessages: false,
          execMode: true,
          execChainId: 'chain-1',
          waitForReset: true,
          execStallTimeoutMs: 1000,
          decisionPolicy: { permission: 'wait', rules: 'fail', mcpInstall: 'deny', question: 'conservative', proposal: 'decline', merge: 'hold', maxAutoDenials: 2 },
          evil: 'x'
        } as never
      }),
      run('bad', {
        overrides: {
          permissionMode: 'yolo',
          autoContinue: 'yes',
          maxAutoContinues: 501,
          maxBudgetUsd: -1,
          execStallTimeoutMs: Number.POSITIVE_INFINITY,
          execChainId: 'x'.repeat(101),
          execMode: true,
          decisionPolicy: { permission: 'allow', question: 'fail', maxAutoDenials: 1.5, waitTimeoutMs: -3, humanGraceMs: 10 }
        } as never
      }),
      run('empty', { overrides: { nope: 1, permissionMode: 'everything' } as never }),
      run('array', { overrides: [] as never }),
      run('null', { overrides: null as never })
    ])
    const s = new RunStore(dataDir)
    expect(s.get('good')!.overrides).toEqual({
      permissionMode: 'plan',
      autoContinue: false,
      maxAutoContinues: 10,
      maxBudgetUsd: 0,
      allowUnpricedBudget: true,
      allowUnmerged: false,
      allowPeerMessages: false,
      execMode: true,
      execChainId: 'chain-1',
      waitForReset: true,
      execStallTimeoutMs: 1000,
      decisionPolicy: { permission: 'wait', rules: 'fail', mcpInstall: 'deny', question: 'conservative', proposal: 'decline', merge: 'hold', maxAutoDenials: 2 }
    })
    // Bad choice fields fall back to the conservative defaults; bad numbers are dropped.
    expect(s.get('bad')!.overrides).toEqual({
      execMode: true,
      decisionPolicy: { permission: 'deny', rules: 'deny', mcpInstall: 'deny', question: 'fail', proposal: 'decline', merge: 'hold', humanGraceMs: 10 }
    })
    for (const id of ['empty', 'array', 'null']) expect('overrides' in s.get(id)!).toBe(false)
    expect(cleanRunOverrides({ maxAutoContinues: 500 })).toEqual({ maxAutoContinues: 500 })
    expect(cleanRunOverrides({ maxAutoContinues: 2.5 })).toBeUndefined()
    expect(cleanRunOverrides({ decisionPolicy: { nope: true } })).toBeUndefined()
    // A stall timeout of 0 (or below) would re-arm the watchdog every tick: dropped, the default applies (review Low).
    expect(cleanRunOverrides({ execMode: true, execStallTimeoutMs: 0 })).toEqual({ execMode: true })
    expect(cleanRunOverrides({ execMode: true, execStallTimeoutMs: -5 })).toEqual({ execMode: true })
    expect(cleanRunOverrides({ execStallTimeoutMs: 1 })).toEqual({ execStallTimeoutMs: 1 })
  })

  it('normalizeCrashedRunSummary does not mutate its input and matches the constructor', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 777_000 })
    try {
      const inputs: RunSummary[] = []
      for (const status of ['starting', 'running', 'idle', 'paused', 'stopping', 'finished', 'error'] as const) {
        inputs.push(run(`${status}`, { status, autoResume: true, pausedUntil: 5 }))
        inputs.push(run(`${status}-user`, { status, endedBy: 'user', endedWhile: 'waiting' }))
        inputs.push(run(`${status}-policy`, { status, endedBy: 'policy', execOutcome: 'stalled' }))
      }
      const snapshot = JSON.parse(JSON.stringify(inputs)) as RunSummary[]
      const pure = inputs.map((r) => normalizeCrashedRunSummary(r, 777_000))
      expect(inputs).toEqual(snapshot)
      writeIndex(inputs)
      const s = new RunStore(dataDir)
      for (const r of pure) expect(s.get(r.id)).toEqual(r)
      // Spot checks of the rules themselves.
      const byId = Object.fromEntries(pure.map((r) => [r.id, r]))
      expect(byId.idle).toMatchObject({ status: 'finished', endedBy: 'app', endedWithApp: true, endedWhile: 'waiting', endedAt: 777_000 })
      expect(byId.running).toMatchObject({ endedBy: 'app', endedWhile: 'working' })
      expect(byId.paused).toMatchObject({ endedBy: 'app', endedWithApp: true, pausedUntil: 5 })
      expect('endedWhile' in byId.paused).toBe(false)
      expect('autoResume' in byId.paused).toBe(false)
      expect(byId['stopping-user']).toMatchObject({ status: 'finished', endedBy: 'user' })
      expect('endedWhile' in byId['stopping-user']).toBe(false)
      expect('endedWithApp' in byId['stopping-user']).toBe(false)
      expect(byId['running-policy']).toMatchObject({ status: 'finished', endedBy: 'policy', execOutcome: 'stalled' })
      expect(byId.finished.endedBy).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
