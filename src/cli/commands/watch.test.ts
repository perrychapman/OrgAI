import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunEvent, RunRecord, RunsSubscribeResult, RunSummary, TranscriptEntry } from '../../shared/types'
import { resetSkewWarning } from '../runRef'
import { FakeHostClient, fakeContext, flush, noHost, project, record, summary } from '../testing/fakeContext'
import { EXIT } from '../types'
import { runWatch, watchTimers } from './watch'

const p1 = project('p1', '/work/app', { name: 'App' })
const text = (id: string, t: string, agentId = 'root'): TranscriptEntry => ({ id, agentId, at: 1, block: { kind: 'text', text: t } })

function snapshotOf(rec: RunRecord, seq = 10, extra: Partial<Extract<RunsSubscribeResult, { mode: 'snapshot' }>['snapshot']> = {}): RunsSubscribeResult {
  return { mode: 'snapshot', hostInstanceId: 'aaaaaaaaaaaa', seq, filterKey: 'fk1', snapshot: { liveRuns: [rec.summary], pendingCards: {}, activeRun: rec, recentEndedRuns: [], ...extra } }
}

function host(runs: RunSummary[], subscribe: (params: unknown) => unknown): FakeHostClient {
  return new FakeHostClient({ 'projects:list': () => [p1], 'runs:list': () => runs, 'runs:subscribe': subscribe })
}

const ev = (seq: number, event: RunEvent) => ({ seq, event })

const realTimers = { ...watchTimers }
beforeEach(() => {
  resetSkewWarning()
  watchTimers.sleep = () => Promise.resolve()
})
afterEach(() => Object.assign(watchTimers, realTimers))

describe('orgai watch', () => {
  it('prints the snapshot rows, then pushed events, and exits 0 when the run finishes', async () => {
    const s = summary('run_live01', { status: 'running', startedAt: 100, title: 'Fix tests' })
    const rec = record(s, { transcript: [text('e1', 'Looking at the tests')] })
    const h = host([s], () => snapshotOf(rec))
    const f = fakeContext({ cwd: '/work/app', connect: [h] })
    const done = runWatch(f.ctx, ['R1'])
    await flush()
    expect(h.callsOf('runs:subscribe')[0]).toEqual([{ runIds: ['run_live01'], followChains: true, includeActiveRunRecord: 'run_live01' }])
    h.push('runs:event', ev(11, { type: 'transcript', runId: s.id, entry: text('e2', 'Found it') }))
    h.push('runs:event', { atSeq: 11, event: { type: 'agent.partial', runId: s.id, agentId: 'root', text: 'partial words' } })
    h.push('runs:event', ev(12, { type: 'question.request', runId: s.id, question: { id: 'q1', runId: s.id, agentId: 'root', question: 'Which DB?', options: [], allowMultiple: false, allowFreeText: true, createdAt: 1 } }))
    h.push('runs:event', ev(13, { type: 'plan.updated', runId: s.id, plan: { goal: 'g', steps: [{ id: 'p1', title: 'One', status: 'done' }, { id: 'p2', title: 'Two', status: 'in_progress' }], status: 'active', autoContinues: 0, updatedAt: 1 } }))
    h.push('runs:event', ev(14, { type: 'run.status', runId: s.id, status: 'finished', endedBy: 'user' }))
    expect(await done).toBe(EXIT.ok)
    const out = f.out()
    expect(out).toContain('R1  Running  Fix tests')
    expect(out).toContain('R1 Orchestrator: Looking at the tests')
    expect(out).toContain('R1 Orchestrator: Found it')
    expect(out).not.toContain('partial words')
    expect(out).toContain('R1 Needs you: Question: Which DB? (request q1)')
    expect(out).toContain('R1 Plan 1 of 2 steps done; now: Two')
    expect(out).toContain('R1 Stopped')
    expect(h.closed).toBe(true)
  })

  it('exits 1 when the run fails', async () => {
    const s = summary('run_live01', { status: 'running' })
    const h = host([s], () => snapshotOf(record(s)))
    const f = fakeContext({ cwd: '/work/app', connect: [h] })
    const done = runWatch(f.ctx, ['run_live01'])
    await flush()
    h.push('runs:event', ev(11, { type: 'run.status', runId: s.id, status: 'error', error: 'boom' }))
    expect(await done).toBe(EXIT.failure)
    expect(f.out()).toContain('R1 Failed boom')
  })

  it('a paused run without auto-resume prints the reason and exits 0; with auto-resume it follows into the continued run', async () => {
    const s = summary('run_live01', { status: 'running', startedAt: 100 })
    const h = host([s], () => snapshotOf(record(s)))
    const f = fakeContext({ cwd: '/work/app', connect: [h] })
    const done = runWatch(f.ctx, ['R1'])
    await flush()
    h.push('runs:event', ev(11, { type: 'run.status', runId: s.id, status: 'paused', autoResume: true, pauseReason: 'Usage limit' }))
    await flush()
    // The host follows the chain: the successor's events arrive although we subscribed to R1 only.
    h.push('runs:event', ev(12, { type: 'run.status', runId: 'run_next02', status: 'starting' }))
    h.push('runs:event', ev(13, { type: 'transcript', runId: 'run_next02', entry: text('e9', 'Resumed') }))
    h.push('runs:event', ev(14, { type: 'run.status', runId: 'run_next02', status: 'paused', autoResume: false, pauseReason: 'Waiting for you to continue.' }))
    expect(await done).toBe(EXIT.ok)
    const out = f.out()
    expect(out).toContain('R1 Paused')
    expect(out).toContain('R2 Running')
    expect(out).toContain('R2 Orchestrator: Resumed')
    expect(out).toContain('R2 Waiting for you to continue.')
  })

  it('reconnects with sinceSeq after a close: replay without duplicates, then a snapshot resync', async () => {
    const s = summary('run_live01', { status: 'running' })
    const rec = record(s, { transcript: [text('e1', 'first')] })
    const h1 = host([s], () => snapshotOf(rec, 10))
    const h2 = host([s], () => ({
      mode: 'replay',
      hostInstanceId: 'aaaaaaaaaaaa',
      fromSeq: 11,
      toSeq: 13,
      filterKey: 'fk1',
      events: [ev(11, { type: 'transcript', runId: s.id, entry: text('e2', 'second') }), ev(12, { type: 'transcript', runId: s.id, entry: text('e3', 'third') })]
    }))
    const rec3 = record(s, { transcript: [text('e1', 'first'), text('e2', 'second'), text('e3', 'third'), text('e4', 'fourth')] })
    const h3 = host([s], () => snapshotOf(rec3, 50))
    const f = fakeContext({ cwd: '/work/app', connect: [h1, h2, h3] })
    const done = runWatch(f.ctx, ['R1'])
    await flush()
    h1.push('runs:event', ev(11, { type: 'transcript', runId: s.id, entry: text('e2', 'second') }))
    h1.hostClose(new Error('reset'))
    await flush()
    await flush()
    expect(h2.callsOf('runs:subscribe')[0]).toEqual([{ runIds: ['run_live01'], followChains: true, includeActiveRunRecord: 'run_live01', sinceSeq: 11, hostInstanceId: 'aaaaaaaaaaaa', filterKey: 'fk1' }])
    // A late duplicate push is ignored.
    h2.push('runs:event', ev(12, { type: 'transcript', runId: s.id, entry: text('e3', 'third') }))
    h2.hostClose()
    await flush()
    await flush()
    // The host lost our seq: it answers a snapshot; only the missed row prints.
    h3.push('runs:event', ev(51, { type: 'run.status', runId: s.id, status: 'finished' }))
    expect(await done).toBe(EXIT.ok)
    const out = f.out()
    for (const w of ['first', 'second', 'third', 'fourth']) expect(out.split(`Orchestrator: ${w}`).length - 1).toBe(1)
  })

  it('a close during a resubscribe starts no second reconnect loop and leaves no client open (review M)', async () => {
    const s = summary('run_live01', { status: 'running' })
    const h1 = host([s], () => snapshotOf(record(s), 10))
    // h2 drops while answering runs:subscribe: the call rejects and the close listeners fire at once.
    const h2: FakeHostClient = host([s], () => {
      h2.hostClose(new Error('draining'))
      throw new Error('The connection to the OrgAI host closed.')
    })
    const h3 = host([s], () => snapshotOf(record(s), 20))
    const f = fakeContext({ cwd: '/work/app', connect: [h1, h2, h3] })
    const done = runWatch(f.ctx, ['R1'])
    await flush()
    h1.hostClose(new Error('reset'))
    for (let i = 0; i < 6; i++) await flush()
    // One loop: h1 (first), then h2 and h3 by that loop; no extra connect from h2's close listener.
    expect(f.connectCalls).toHaveLength(3)
    expect(h2.closed).toBe(true)
    h3.push('runs:event', ev(21, { type: 'run.status', runId: s.id, status: 'finished' }))
    expect(await done).toBe(EXIT.ok)
    expect(f.connectCalls).toHaveLength(3)
    for (const h of [h1, h2, h3]) expect(h.closed).toBe(true)
  })

  it('a close during the first subscribe reports the error and starts no background loop', async () => {
    const s = summary('run_live01', { status: 'running' })
    const h1: FakeHostClient = host([s], () => {
      h1.hostClose(new Error('gone'))
      throw new Error('The connection to the OrgAI host closed.')
    })
    const f = fakeContext({ cwd: '/work/app', connect: [h1] })
    await expect(runWatch(f.ctx, ['R1'])).rejects.toThrow('closed')
    for (let i = 0; i < 4; i++) await flush()
    expect(f.connectCalls).toHaveLength(1)
  })

  it('SIGINT detaches with exit 0 and leaves the run alone', async () => {
    const s = summary('run_live01', { status: 'running' })
    const h = host([s], () => snapshotOf(record(s)))
    const f = fakeContext({ cwd: '/work/app', connect: [h] })
    const done = runWatch(f.ctx, ['R1'])
    await flush()
    f.signal('SIGINT')
    expect(await done).toBe(EXIT.ok)
    expect(f.err()).toBe('Detached; the run keeps going.\n')
    expect(h.calls.map((c) => c.method)).not.toContain('runs:stop')
    expect(h.closed).toBe(true)
    expect(f.signalListeners()).toBe(0)
  })

  it('stream-json: a snapshot line, durable events with seq, agent.partial with atSeq', async () => {
    const s = summary('run_live01', { status: 'running' })
    const img = { mediaType: 'image/png' as const, data: 'B'.repeat(800) }
    const rec = record(s, { transcript: [{ id: 'u', agentId: 'root', at: 1, block: { kind: 'user', text: 'see', images: [img] } }] })
    const h = host([s], () => snapshotOf(rec))
    const f = fakeContext({ cwd: '/work/app', connect: [h], globals: { outputFormat: 'stream-json' } })
    const done = runWatch(f.ctx, ['R1'])
    await flush()
    h.push('runs:event', { atSeq: 10, event: { type: 'agent.partial', runId: s.id, agentId: 'root', text: 'typing' } })
    h.push('runs:event', ev(11, { type: 'run.status', runId: s.id, status: 'finished' }))
    expect(await done).toBe(EXIT.ok)
    const lines = f.out().trimEnd().split('\n').map((l) => JSON.parse(l))
    expect(lines[0]).toMatchObject({ schemaVersion: 1, type: 'snapshot', seq: 10, filterKey: 'fk1' })
    expect(lines[0].snapshot.activeRun.transcript[0].block.images[0]).toEqual({ mediaType: 'image/png', byteLength: 600, omittedBase64: true })
    expect(lines[1]).toMatchObject({ type: 'event', atSeq: 10, event: { type: 'agent.partial', text: 'typing' } })
    expect(lines[2]).toMatchObject({ type: 'event', seq: 11, event: { type: 'run.status', status: 'finished' } })
  })

  it('a run already ended at subscribe time exits at once', async () => {
    const s = summary('run_old001', { status: 'error' })
    const h = host([s], () => snapshotOf(record(s), 5, { liveRuns: [], recentEndedRuns: [s] }))
    const f = fakeContext({ cwd: '/work/app', connect: [h] })
    expect(await runWatch(f.ctx, ['R1'])).toBe(EXIT.failure)
  })

  it('watches the chain newest member', async () => {
    const a = summary('run_aaaaaa', { startedAt: 100, sessionId: 's' })
    const b = summary('run_bbbbbb', { startedAt: 200, sessionId: 's', resumedFrom: 'run_aaaaaa', status: 'running' })
    const h = host([a, b], () => snapshotOf(record(b)))
    const f = fakeContext({ cwd: '/work/app', connect: [h] })
    const done = runWatch(f.ctx, ['R1'])
    await flush()
    expect(h.callsOf('runs:subscribe')[0]).toMatchObject([{ runIds: ['run_bbbbbb'], includeActiveRunRecord: 'run_bbbbbb' }])
    f.signal('SIGTERM')
    await done
  })

  it('no host: an ended run prints its saved final state (0); a run not ended is exit 1', async () => {
    const s = summary('run_old001', { status: 'finished', endedBy: 'app', endedWithApp: true, title: 'Old' })
    const f = fakeContext({ cwd: '/work/app', connect: [noHost()], store: { projects: [p1], runs: [s], records: { run_old001: record(s, { transcript: [text('e1', 'bye')] }) } } })
    expect(await runWatch(f.ctx, ['R1'])).toBe(EXIT.ok)
    expect(f.out()).toContain('R1  Ended when OrgAI closed  Old')
    expect(f.out()).toContain('R1 Orchestrator: bye')

    const live = summary('run_old001', { status: 'running' })
    const g = fakeContext({ cwd: '/work/app', connect: [{ ok: false, reason: 'starting', message: 'starting' }], store: { hostState: 'starting', projects: [p1], runs: [live], records: { run_old001: record(live) } } })
    await expect(runWatch(g.ctx, ['R1'])).rejects.toMatchObject({ exitCode: EXIT.failure })
    const n = fakeContext({ cwd: '/work/app', connect: [noHost()], store: { projects: [p1], runs: [live], records: { run_old001: record(live) } } })
    await expect(runWatch(n.ctx, ['R1'])).rejects.toMatchObject({ exitCode: EXIT.failure, message: 'No OrgAI host is running.' })
  })
})
