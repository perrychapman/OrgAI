import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readOnlySnapshot } from './readOnlyStore'

let dataDir: string
const ID = 'abcdef012345'

beforeEach(() => {
  dataDir = join(mkdtempSync(join(tmpdir(), 'ros-')), 'data')
  mkdirSync(join(dataDir, 'runs'), { recursive: true })
})
afterEach(() => rmSync(join(dataDir, '..'), { recursive: true, force: true }))

const summary = (id: string, status: string, startedAt: number): Record<string, unknown> => ({ id, projectId: 'p1', status, startedAt, kind: 'work', prompt: 'x' })

function seed(): { index: string; record: string } {
  const index = JSON.stringify({ version: 1, runs: [summary('r1', 'running', 1), summary('r2', 'finished', 2), null, { junk: true }] })
  writeFileSync(join(dataDir, 'runs.json'), index)
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({ version: 2, projects: [{ id: 'p1', name: 'One', path: '/x', updatedAt: '2026' }] }))
  const record = JSON.stringify({
    summary: summary('r1', 'running', 1),
    agents: {},
    transcript: [{ id: 't1', block: { kind: 'user', text: 'hi', images: [{ mediaType: 'image/png', data: '', ref: `${'a'.repeat(64)}.png` }] } }],
    logs: []
  })
  writeFileSync(join(dataDir, 'runs', 'r1.json'), record)
  return { index, record }
}

function daemon(state: string): void {
  mkdirSync(join(dataDir, 'run'), { recursive: true })
  writeFileSync(
    join(dataDir, 'run', 'daemon.json'),
    JSON.stringify({ hostInstanceId: ID, pid: 4242, endpoint: '/nowhere.sock', state, startedAt: 1, hostKind: 'desktop' })
  )
}

describe('ReadOnlyStoreReader', () => {
  it('with a dead host, normalizes a running run in memory and leaves the files alone', async () => {
    const { index, record } = seed()
    daemon('ready')
    const snap = await readOnlySnapshot({ dataDir, isLive: () => false, now: () => 1000 })
    expect(snap.hostState).toBe('stopped')
    expect(snap.liveInboxAvailable).toBe(false)
    expect(snap.runs.map((r) => r.id)).toEqual(['r2', 'r1'])
    const r1 = snap.runs.find((r) => r.id === 'r1')!
    expect(r1).toMatchObject({ status: 'finished', endedBy: 'app', endedWithApp: true, endedWhile: 'working', endedAt: 1000 })
    expect(snap.projects.map((p) => p.id)).toEqual(['p1'])
    const rec = snap.readRecord('r1')!
    expect(rec.summary.status).toBe('finished')
    const img = (rec.transcript[0].block as { images: { data: string; ref?: string }[] }).images[0]
    expect(img).toMatchObject({ data: '', ref: `${'a'.repeat(64)}.png` })
    expect(readFileSync(join(dataDir, 'runs.json'), 'utf8')).toBe(index)
    expect(readFileSync(join(dataDir, 'runs', 'r1.json'), 'utf8')).toBe(record)
    expect(existsSync(join(dataDir, 'run', 'startup.mkdir'))).toBe(false)
  })

  it('a live starting host is polled, then reported starting without normalizing', async () => {
    seed()
    daemon('starting')
    let t = 0
    const snap = await readOnlySnapshot({ dataDir, isLive: () => true, now: () => t, sleep: async (ms) => void (t += ms) })
    expect(t).toBeGreaterThanOrEqual(2000)
    expect(snap.hostState).toBe('starting')
    expect(snap.runs.find((r) => r.id === 'r1')!.status).toBe('running')
    expect(snap.readRecord('r1')!.summary.status).toBe('running')
  })

  it('a starting host that becomes ready mid-poll reports ready', async () => {
    seed()
    daemon('starting')
    let t = 0
    const snap = await readOnlySnapshot({
      dataDir,
      isLive: () => true,
      now: () => t,
      sleep: async (ms) => {
        t += ms
        if (t >= 300) daemon('ready')
      }
    })
    expect(snap.hostState).toBe('ready')
    expect(t).toBeLessThan(2000)
  })

  it('a live startup.mkdir owner without daemon.json counts as starting', async () => {
    seed()
    mkdirSync(join(dataDir, 'run', 'startup.mkdir'), { recursive: true })
    writeFileSync(join(dataDir, 'run', 'startup.mkdir', 'owner.json'), JSON.stringify({ pid: 99, createdAt: 1 }))
    let t = 0
    const snap = await readOnlySnapshot({ dataDir, isLive: () => true, now: () => t, sleep: async (ms) => void (t += ms) })
    expect(snap.hostState).toBe('starting')
    expect(readdirSync(join(dataDir, 'run', 'startup.mkdir'))).toEqual(['owner.json'])
  })

  it('a live ready host does not normalize', async () => {
    seed()
    daemon('ready')
    const snap = await readOnlySnapshot({ dataDir, isLive: () => true })
    expect(snap.hostState).toBe('ready')
    expect(snap.daemon?.hostInstanceId).toBe(ID)
    expect(snap.runs.find((r) => r.id === 'r1')!.status).toBe('running')
  })

  it('missing files give empty lists; bad ids and missing records give null', async () => {
    const snap = await readOnlySnapshot({ dataDir, isLive: () => false })
    expect(snap).toMatchObject({ hostState: 'stopped', projects: [], runs: [] })
    expect(snap.daemon).toBeUndefined()
    expect(snap.readRecord('nope')).toBeNull()
    expect(snap.readRecord('../runs')).toBeNull()
    expect(existsSync(join(dataDir, 'run'))).toBe(false)
  })
})
