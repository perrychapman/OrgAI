import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunRecord, RunSummary } from '@shared/types'
import { RunStore } from './runs'

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
    const reloaded = new RunStore(dataDir).list('p1')
    const live = reloaded.find((r) => r.id === 'live')!
    expect(live.status).toBe('finished')
    expect(live.endedAt).toBeTypeOf('number')
    expect(reloaded.find((r) => r.id === 'bad')!.status).toBe('error')
  })

  it('finishes a paused run on load but keeps when it could continue', () => {
    const s = new RunStore(dataDir)
    s.upsert(run('paused', { status: 'paused', pausedUntil: 5000, pauseReason: 'limit', autoResume: true }))
    const reloaded = new RunStore(dataDir).get('paused')!
    expect(reloaded).toMatchObject({ status: 'finished', pausedUntil: 5000, pauseReason: 'limit' })
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
