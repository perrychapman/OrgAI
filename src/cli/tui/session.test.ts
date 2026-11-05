import { describe, expect, it } from 'vitest'
import type { HostScope, PendingCards, RunsSubscribeInput, RunsSubscribeResult, RunSummary } from '../../shared/types'
import { FakeHostClient, fakeContext, fakeInproc, flush, project, record, rpcError, summary } from '../testing/fakeContext'
import { EXIT } from '../types'
import { DESKTOP_UNAVAILABLE_NOTICE, connectTuiHost, openTuiSession, TUI_DECIDE_TIMEOUT_MS } from './session'

const P = project('p1', '/work', { name: 'Shop' })
const SCOPES: HostScope[] = ['read', 'operate', 'decide']

function snapshot(seq: number, live: RunSummary[] = [], cards: Record<string, PendingCards> = {}, ended: RunSummary[] = []): RunsSubscribeResult {
  return { mode: 'snapshot', hostInstanceId: 'aaaaaaaaaaaa', seq, filterKey: `fk${seq}`, snapshot: { liveRuns: live, recentEndedRuns: ended, pendingCards: cards } }
}

const noCards = (): PendingCards => ({ permissions: [], questions: [], proposals: [], ruleRequests: [], mergeReviews: [], mcpInstalls: [] })

/** A host with scripted answers; runs:subscribe answers a snapshot of `live` (activeRun from `records`). */
function host(o: { live?: RunSummary[]; list?: RunSummary[]; cards?: Record<string, PendingCards>; answers?: Record<string, (p: unknown) => unknown>; hello?: object } = {}) {
  let seq = 10
  const live = o.live ?? []
  const list = o.list ?? live
  const h: FakeHostClient = new FakeHostClient(
    {
      'runs:subscribe': (params) => {
        const input = (params as RunsSubscribeInput[])[0]
        const res = snapshot(++seq, live, o.cards ?? {})
        const active = input.includeActiveRunRecord
        const s = list.find((r) => r.id === active)
        if (res.mode === 'snapshot' && s) res.snapshot.activeRun = record(s)
        return res
      },
      'runs:list': () => list,
      'projects:list': () => [P],
      'runs:get': (params) => {
        const id = (params as string[])[0]
        const s = list.find((r) => r.id === id)
        return s ? record(s) : null
      },
      ...o.answers
    },
    { hello: { grantedScopes: ['read', 'operate', 'decide'], ...o.hello } }
  )
  return h
}

async function open(h: FakeHostClient, opts: { project?: typeof P; runId?: string; readOnlyReason?: string } = {}, extra: { connect?: (FakeHostClient | { ok: false; reason: 'no_host'; message: string })[] } = {}) {
  const f = fakeContext({ connect: extra.connect ?? [h] })
  const conn = await connectTuiHost(f.ctx)
  const fired: number[] = []
  const queued: (() => void)[] = []
  const session = await openTuiSession(conn, { folder: '/work', ...opts }, { schedule: (fn) => void queued.push(fn) })
  session.subscribe(() => fired.push(1))
  return { f, conn, session, fired, queued, flushNotify: () => queued.splice(0).forEach((fn) => fn()) }
}

describe('connectTuiHost', () => {
  it('connects with read / operate / decide as a tui client and passes the skew warning to warn', async () => {
    const h = host({ hello: { versionSkewWarning: 'App 1.2, CLI 1.1\x1b[31m' } })
    const f = fakeContext({ connect: [h] })
    const warned: string[] = []
    const conn = await connectTuiHost(f.ctx, { warn: (m) => warned.push(m) })
    expect(f.connectCalls).toEqual([{ scopes: SCOPES, opts: { clientKind: 'tui', waitStartingMs: 2000 } }])
    expect(conn.client).toBe(h)
    expect(conn.started).toBe(false)
    expect(warned).toEqual(['App 1.2, CLI 1.1'])
    expect(await conn.projects()).toEqual([P])
    // The session turns the same warning into a notice.
    const session = await openTuiSession(conn, { folder: '/work' })
    expect(session.getState().notices.map((n) => n.text)).toEqual(['App 1.2, CLI 1.1'])
  })

  it('createProject reconnects with configure, then creates; refuses with exit 1 when not granted', async () => {
    const h1 = host()
    const h2 = new FakeHostClient({ 'projects:create': (p) => ({ ...P, name: (p as { name: string }[])[0].name }) }, { hello: { grantedScopes: [...SCOPES, 'configure'] } })
    const f = fakeContext({ connect: [h1, h2] })
    const conn = await connectTuiHost(f.ctx)
    const made = await conn.createProject({ name: 'New', path: '/work' } as never)
    expect(made.name).toBe('New')
    expect(f.connectCalls[1]).toEqual({ scopes: [...SCOPES, 'configure'], opts: { clientKind: 'tui', waitStartingMs: 2000 } })
    // The shared client stays open; the configure connection is closed after the call.
    expect(h1.closed).toBe(false)
    expect(h2.closed).toBe(true)
    expect(conn.client).toBe(h1)
    expect(h2.callsOf('projects:create')).toEqual([[{ name: 'New', path: '/work' }]])

    const g1 = host()
    const g2 = new FakeHostClient({ 'projects:create': () => P }, { hello: { grantedScopes: SCOPES } })
    const g = fakeContext({ connect: [g1, g2] })
    const c2 = await connectTuiHost(g.ctx)
    await expect(c2.createProject({ name: 'x', path: '/w' } as never)).rejects.toMatchObject({ exitCode: EXIT.failure, message: expect.stringContaining("'configure'") })
    expect(g2.callsOf('projects:create')).toEqual([])
  })

  it('startSetup, checkPath; close stops an inproc host only when asked', async () => {
    const h = host({ answers: { 'setup:start': () => summary('s1', { kind: 'setup' }), 'projects:checkPath': () => ({ ok: true }) } })
    const inproc = fakeInproc()
    const f = fakeContext({ globals: { host: 'inproc' }, connect: [h], inproc: async () => inproc })
    const conn = await connectTuiHost(f.ctx)
    expect(conn.inproc).toBe(inproc)
    expect((await conn.startSetup('p1')).id).toBe('s1')
    expect(h.callsOf('setup:start')).toEqual([[{ projectId: 'p1' }]])
    await conn.checkPath('/x')
    expect(h.callsOf('projects:checkPath')).toEqual([['/x']])
    await conn.close()
    expect(inproc.stops).toEqual([])
    await conn.close({ stopInproc: true })
    expect(inproc.stops).toEqual([true])
    expect(h.closed).toBe(true)
  })
})

describe('session switching (onboarding, another project)', () => {
  it('closing the old session leaves the shared connection and the new session live', async () => {
    const r1 = summary('r1', { status: 'running', startedAt: 1 })
    const h = host({ live: [r1], answers: { 'runs:send': () => undefined } })
    const { conn, session: first } = await open(h)
    const second = await openTuiSession(conn, { folder: '/work', project: P })
    await first.close()
    expect(h.closed).toBe(false)
    // The new session still hears the host and can still call it.
    const before = h.callsOf('runs:subscribe').length
    await second.resync()
    expect(h.callsOf('runs:subscribe').length).toBe(before + 1)
    expect((await second.listRuns()).map((r) => r.id)).toEqual(['r1'])
    await second.close()
    expect(h.closed).toBe(false)
    await conn.close()
    expect(h.closed).toBe(true)
  })
})

describe('onboarding with a session open', () => {
  it('createProject leaves the open session and the shared client alone: startSetup and the next session work', async () => {
    const h1 = host({ answers: { 'setup:start': () => summary('s1', { kind: 'setup', projectId: 'p1' }) } })
    const h2 = new FakeHostClient({ 'projects:create': () => P }, { hello: { grantedScopes: [...SCOPES, 'configure'] } })
    const f = fakeContext({ connect: [h1, h2] })
    const conn = await connectTuiHost(f.ctx)
    // Onboarding: a session with no project is open before the App renders.
    const onboarding = await openTuiSession(conn, { folder: '/work' })
    const made = await conn.createProject({ name: 'Shop', path: '/work' } as never)
    expect(made.id).toBe('p1')
    expect(h1.closed).toBe(false)
    expect((await conn.startSetup(made.id)).id).toBe('s1')
    // The default / import choice: a session on the new project, then the onboarding one closes.
    const next = await openTuiSession(conn, { folder: '/work', project: P })
    await onboarding.close()
    expect(h1.closed).toBe(false)
    const before = h1.callsOf('runs:subscribe').length
    await next.resync()
    expect(h1.callsOf('runs:subscribe').length).toBe(before + 1)
    await next.close()
    await conn.close()
    expect(h1.closed).toBe(true)
  })

  it('after a reconnect the new client is shared: switching sessions never closes it', async () => {
    const h1 = host()
    const r = host({ answers: { 'runs:send': () => undefined } })
    const f = fakeContext({ connect: [h1, r] })
    const conn = await connectTuiHost(f.ctx)
    let t = 0
    const first = await openTuiSession(conn, { folder: '/work', project: P }, { schedule: (fn) => fn(), timers: { sleep: async (ms) => void (t += ms), now: () => t } })
    h1.hostClose()
    for (let i = 0; i < 20; i++) await flush()
    expect(first.getState().connection).toBe('live')
    expect(conn.client).toBe(r)
    const second = await openTuiSession(conn, { folder: '/work', project: P })
    await first.close()
    expect(r.closed).toBe(false)
    const before = r.callsOf('runs:subscribe').length
    await second.resync()
    expect(r.callsOf('runs:subscribe').length).toBe(before + 1)
    await second.close()
    expect(r.closed).toBe(false)
    await conn.close()
    expect(r.closed).toBe(true)
  })
})

describe('openTuiSession', () => {
  it('subscribes to the project with followChains and no nonInteractive, then focuses the run that needs you', async () => {
    const r1 = summary('r1', { status: 'running', startedAt: 1 })
    const r2 = summary('r2', { status: 'running', startedAt: 2 })
    const cards = { r1: { ...noCards(), permissions: [{ id: 'pa', runId: 'r1', agentId: 'root', toolName: 'Bash', input: {}, summary: 's' }] }, r2: noCards() }
    const h = host({ live: [r1, r2], cards })
    const { session } = await open(h, { project: P })
    const subs = h.callsOf('runs:subscribe') as RunsSubscribeInput[][]
    expect(subs[0]).toEqual([{ projectIds: ['p1'], followChains: true }])
    // The focus resubscribes with the active record (resume fields included).
    expect(subs[1]).toEqual([{ projectIds: ['p1'], includeActiveRunRecord: 'r1', followChains: true, sinceSeq: 11, hostInstanceId: 'aaaaaaaaaaaa', filterKey: 'fk11' }])
    for (const [s] of subs) expect(s).not.toHaveProperty('nonInteractive')
    const st = session.getState()
    expect(st.activeRunId).toBe('r1')
    expect(st.runs.r1.recordLoaded).toBe(true)
    expect(st.connection).toBe('live')
    expect(st.runOrder).toEqual(['r1', 'r2'])
  })

  it('no live run: nothing focused, the composer starts a new run', async () => {
    const h = host({ list: [summary('old', { status: 'finished' })] })
    const { session } = await open(h, { project: P })
    expect(session.getState().activeRunId).toBeUndefined()
    expect(session.getState().composeTarget).toBe('new')
    expect(h.callsOf('runs:subscribe')).toHaveLength(1)
  })

  it('a named run focuses its chain newest member and loads up to 5 earlier members', async () => {
    const chain = Array.from({ length: 8 }, (_, i) =>
      summary(`c${i}`, { status: i === 7 ? 'idle' : 'finished', startedAt: 100 + i, sessionId: 'sess', ...(i > 0 ? { resumedFrom: `c${i - 1}` } : {}) })
    )
    const h = host({ live: [chain[7]], list: chain })
    const { session } = await open(h, { project: P, runId: 'c2' })
    const subs = h.callsOf('runs:subscribe') as RunsSubscribeInput[][]
    expect(subs[0][0]).toMatchObject({ projectIds: ['p1'], includeActiveRunRecord: 'c7', followChains: true })
    for (let i = 0; i < 4; i++) await flush()
    const st = session.getState()
    expect(st.activeRunId).toBe('c7')
    expect(st.activeChain).toEqual(chain.map((c) => c.id))
    expect((h.callsOf('runs:get') as string[][]).map((p) => p[0]).sort()).toEqual(['c2', 'c3', 'c4', 'c5', 'c6'])
    expect(st.runs.c2.recordLoaded).toBe(true)
    expect(st.runs.c1).toBeUndefined()
  })

  it('no project: subscribes to the focused run only (none: nothing)', async () => {
    const h = host()
    await open(h)
    expect(h.callsOf('runs:subscribe')[0]).toEqual([{ runIds: [], followChains: true }])
  })

  it('focusRun resubscribes with the new active record', async () => {
    const r1 = summary('r1', { status: 'running', startedAt: 1 })
    const r2 = summary('r2', { status: 'finished', startedAt: 2 })
    const h = host({ live: [r1], list: [r1, r2] })
    const { session } = await open(h, { project: P })
    await session.focusRun('r2')
    const subs = h.callsOf('runs:subscribe') as RunsSubscribeInput[][]
    expect(subs[subs.length - 1][0]).toMatchObject({ projectIds: ['p1'], includeActiveRunRecord: 'r2' })
    expect(session.getState().activeRunId).toBe('r2')
    expect(session.getState().runs.r2.recordLoaded).toBe(true)
  })

  it('submitPrompt: runs:send on an open run, runs:continue on an ended one (never exec), runs:start otherwise', async () => {
    const r1 = summary('r1', { status: 'idle', startedAt: 1, sessionId: 'sess' })
    const r2 = summary('r2', { status: 'starting', startedAt: 5, resumedFrom: 'r1', sessionId: 'sess' })
    const r3 = summary('r3', { status: 'starting', startedAt: 9 })
    const list = [r1]
    const h = host({
      live: [r1],
      list,
      answers: { 'runs:send': () => undefined, 'runs:continue': () => r2, 'runs:start': () => r3 }
    })
    const { session } = await open(h, { project: P })
    list.push(r2, r3)
    await expect(session.submitPrompt('   ')).rejects.toThrow('Type a message first.')
    expect(await session.submitPrompt('hello')).toBeUndefined()
    expect(h.callsOf('runs:send')).toEqual([[{ runId: 'r1', text: 'hello' }]])

    // The run ends; the composer continues it.
    h.push('runs:event', { seq: 50, event: { type: 'run.status', runId: 'r1', status: 'finished' } })
    const next = await session.submitPrompt('more')
    expect(next?.id).toBe('r2')
    expect(h.callsOf('runs:continue')).toEqual([[{ runId: 'r1', text: 'more' }]])
    expect(session.getState().activeChain).toEqual(['r1', 'r2'])
    expect(session.getState().activeRunId).toBe('r2')
    const subs = h.callsOf('runs:subscribe') as RunsSubscribeInput[][]
    expect(subs[subs.length - 1][0]).toMatchObject({ includeActiveRunRecord: 'r2' })

    session.setComposeTarget('new')
    const started = await session.submitPrompt('fresh', { team: 'single' })
    expect(started?.id).toBe('r3')
    expect(h.callsOf('runs:start')).toEqual([[{ projectId: 'p1', prompt: 'fresh', team: 'single' }]])
    expect(session.getState().activeRunId).toBe('r3')
    expect(session.getState().activeChain).toEqual(['r3'])
  })

  it('submitPrompt refuses in read-only mode', async () => {
    const { session } = await open(host(), { project: P, readOnlyReason: 'Another window decides here.' })
    await expect(session.submitPrompt('x')).rejects.toThrow('Another window decides here.')
  })

  it('startQuick sends the folder, team single by default and allowEdits', async () => {
    const q = summary('q1', { status: 'starting', projectId: 'quick' })
    const h = host({ list: [q], answers: { 'runs:startQuick': () => q } })
    const { session } = await open(h)
    await session.startQuick({ prompt: 'look', allowEdits: true })
    expect(h.callsOf('runs:startQuick')).toEqual([[{ prompt: 'look', folder: '/work', team: 'single', allowEdits: true }]])
    const subs = h.callsOf('runs:subscribe') as RunsSubscribeInput[][]
    expect(subs[subs.length - 1][0]).toMatchObject({ runIds: ['q1'], includeActiveRunRecord: 'q1' })
    // Without a project the composer starts a quick run too.
    await session.close()
  })

  it('interrupt and stop the active run', async () => {
    const r1 = summary('r1', { status: 'running' })
    const h = host({ live: [r1], answers: { 'runs:interrupt': () => undefined, 'runs:stop': () => undefined } })
    const { session } = await open(h, { project: P })
    await session.interrupt()
    await session.stop()
    expect(h.callsOf('runs:interrupt')).toEqual([['r1']])
    expect(h.callsOf('runs:stop')).toEqual([['r1']])
  })

  it('decide sends the payload with the long timeout and normalizes outcomes and errors', async () => {
    let answer: unknown = { status: 'already-resolved', requestId: '', decidedBy: { surface: 'desktop' } }
    const h = host({
      answers: {
        'runs:decide': () => answer,
        'setup:decide': () => {
          throw rpcError({ code: 'stale_revision', message: 'Changed\x1b[2J meanwhile' })
        }
      }
    })
    const timeouts: unknown[] = []
    const orig = h.call.bind(h)
    h.call = (async (m: string, p?: unknown, o?: { timeoutMs?: number }) => {
      if (m === 'runs:decide') timeouts.push(o?.timeoutMs)
      return orig(m, p as never)
    }) as typeof h.call
    const { session } = await open(h)
    const payload = { runId: 'r1', requestId: 'p1', expectedRevision: 1, decision: { behavior: 'allow', scope: 'once' } }
    expect(await session.decide({ channel: 'runs:decide', payload })).toEqual({ status: 'already-resolved', requestId: 'p1', decidedBy: { surface: 'desktop' } })
    expect(h.callsOf('runs:decide')).toEqual([[payload]])
    expect(timeouts).toEqual([TUI_DECIDE_TIMEOUT_MS])
    answer = undefined
    expect(await session.decide({ channel: 'runs:decide', payload })).toEqual({ status: 'applied', runId: 'r1', requestId: 'p1', effectiveDecision: 'allow' })
    await expect(session.decide({ channel: 'setup:decide', payload: { runId: 'r1', proposalId: 'x', decision: { behavior: 'approve' } } })).rejects.toThrow('Changed meanwhile')
  })

  it('openInDesktop: desktop_unavailable becomes a notice; worktreeDiff and listRuns', async () => {
    const r1 = summary('r1', { status: 'running' })
    const h = host({
      live: [r1],
      answers: {
        'window:openRun': () => {
          throw rpcError({ code: 'desktop_unavailable', message: 'no desktop' })
        },
        'maintenance:diff': () => ({ stat: '', patch: '' })
      }
    })
    const { session } = await open(h, { project: P })
    await session.openInDesktop()
    expect(h.callsOf('window:openRun')).toEqual([[{ projectId: 'p1', runId: 'r1' }]])
    expect(session.getState().notices.map((n) => n.text)).toEqual([DESKTOP_UNAVAILABLE_NOTICE])
    await session.worktreeDiff('wt-1')
    expect(h.callsOf('maintenance:diff')).toEqual([[{ projectId: 'p1', branch: 'wt-1' }]])
    expect((await session.listRuns()).map((r) => r.id)).toEqual(['r1'])
  })

  it('resync resubscribes with the resume fields (SIGCONT)', async () => {
    const h = host({ live: [summary('r1', { status: 'running' })] })
    const { session } = await open(h, { project: P })
    const before = h.callsOf('runs:subscribe').length
    await session.resync()
    const subs = h.callsOf('runs:subscribe') as RunsSubscribeInput[][]
    expect(subs).toHaveLength(before + 1)
    expect(subs[subs.length - 1][0]).toMatchObject({ sinceSeq: expect.any(Number), hostInstanceId: 'aaaaaaaaaaaa', includeActiveRunRecord: 'r1' })
  })

  it('pushed events apply; listeners are notified once per scheduled batch; notify adds a notice', async () => {
    const r1 = summary('r1', { status: 'running' })
    const h = host({ live: [r1] })
    const { session, fired, queued, flushNotify } = await open(h, { project: P })
    flushNotify()
    fired.length = 0
    h.push('runs:event', { seq: 100, event: { type: 'run.status', runId: 'r1', status: 'idle' } })
    h.push('runs:event', { seq: 101, event: { type: 'transcript', runId: 'r1', entry: { id: 'e1', agentId: 'root', at: 1, block: { kind: 'text', text: 'hi' } } } })
    session.notify('Saved.', 'ok')
    expect(queued).toHaveLength(1)
    expect(fired).toEqual([])
    flushNotify()
    expect(fired).toEqual([1])
    const st = session.getState()
    expect(st.runs.r1.summary.status).toBe('idle')
    expect(st.runs.r1.transcript.map((e) => e.id)).toEqual(['e1'])
    expect(st.notices.map((n) => [n.text, n.tone])).toEqual([['Saved.', 'ok']])
  })

  it('an event for an unseen run fetches its record; a continuation there is followed', async () => {
    const r1 = summary('r1', { status: 'finished', startedAt: 1, sessionId: 's' })
    const r2 = summary('r2', { status: 'starting', startedAt: 5, resumedFrom: 'r1', sessionId: 's' })
    const list = [r1]
    const h = host({ live: [], list })
    const { session } = await open(h, { project: P, runId: 'r1' })
    list.push(r2)
    h.push('runs:event', { seq: 200, event: { type: 'run.status', runId: 'r2', status: 'starting' } })
    for (let i = 0; i < 3; i++) await flush()
    expect(h.callsOf('runs:get')).toContainEqual(['r2'])
    expect(session.getState().activeChain).toEqual(['r1', 'r2'])
  })

  it('reconnecting and gone set the connection state with a notice', async () => {
    const h = host({ live: [summary('r1', { status: 'running' })] })
    const f = fakeContext({ connect: [h, { ok: false, reason: 'no_host', message: 'gone' }] })
    const conn = await connectTuiHost(f.ctx)
    let t = 0
    const session = await openTuiSession(conn, { folder: '/work', project: P }, { schedule: (fn) => fn(), timers: { sleep: async (ms) => void (t += ms), now: () => t } })
    const states: string[] = []
    session.subscribe(() => states.push(session.getState().connection))
    h.hostClose()
    for (let i = 0; i < 20; i++) await flush()
    expect(states[0]).toBe('reconnecting')
    expect(session.getState().connection).toBe('gone')
    expect(session.getState().notices.at(-1)?.tone).toBe('danger')
  })
})
