/** The session's run-control calls (cli-parity 3.5): overrides on start / continue / quick, resume actions, model switch. */
import { describe, expect, it } from 'vitest'
import type { ConnectionInfo, HostScope, PendingCards, RunsSubscribeInput, RunsSubscribeResult, RunSummary } from '../../shared/types'
import { FakeHostClient, fakeContext, project, record, summary } from '../testing/fakeContext'
import { connectTuiHost, openTuiSession } from './session'

const P = project('p1', '/work', { name: 'Shop', permissionMode: 'default' })
const SCOPES: HostScope[] = ['read', 'operate', 'decide']
const noCards = (): PendingCards => ({ permissions: [], questions: [], proposals: [], ruleRequests: [], mergeReviews: [], mcpInstalls: [] })

function host(list: RunSummary[], answers: Record<string, (p: unknown) => unknown> = {}, scopes: HostScope[] = SCOPES) {
  let seq = 10
  return new FakeHostClient(
    {
      'runs:subscribe': (p): RunsSubscribeResult => {
        const active = list.find((r) => r.id === (p as RunsSubscribeInput[])[0].includeActiveRunRecord)
        return {
          mode: 'snapshot',
          hostInstanceId: 'aaaaaaaaaaaa',
          seq: ++seq,
          filterKey: `fk${seq}`,
          snapshot: { liveRuns: list.filter((r) => r.status !== 'finished'), recentEndedRuns: [], pendingCards: {}, ...(active ? { activeRun: record(active) } : {}) }
        }
      },
      'runs:list': () => [...list],
      'projects:list': () => [P],
      'runs:get': (p) => {
        const s = list.find((r) => r.id === (p as string[])[0])
        return s ? record(s) : null
      },
      ...answers
    },
    { hello: { grantedScopes: scopes } }
  )
}

async function open(clients: FakeHostClient[], runId?: string) {
  const f = fakeContext({ connect: clients })
  const conn = await connectTuiHost(f.ctx)
  const session = await openTuiSession(conn, { folder: '/work', project: P, ...(runId ? { runId } : {}) }, { schedule: () => undefined })
  return { f, session }
}

describe('run options from the TUI', () => {
  it('start, continue and quick send the overrides; widening ones go through a configure connection', async () => {
    const r1 = summary('r1', { status: 'finished', startedAt: 1, sessionId: 'sess' })
    const r2 = summary('r2', { status: 'starting', startedAt: 5, resumedFrom: 'r1' })
    const r3 = summary('r3', { status: 'starting', startedAt: 9 })
    const list = [r1]
    const h = host(list, { 'runs:continue': () => r2, 'runs:start': () => r3 })
    const conf = new FakeHostClient({ 'runs:start': () => r3 }, { hello: { grantedScopes: [...SCOPES, 'configure'] } })
    const { session, f } = await open([h, conf], 'r1')
    list.push(r2, r3)

    await session.submitPrompt('more', { overrides: { goal: 'cost' } })
    expect(h.callsOf('runs:continue')).toEqual([[{ runId: 'r1', text: 'more', overrides: { goal: 'cost' } }]])

    session.setComposeTarget('new')
    await session.submitPrompt('fresh', { team: 'single', overrides: { strictDelegation: true, permissionMode: 'plan' } })
    expect(h.callsOf('runs:start')).toEqual([[{ projectId: 'p1', prompt: 'fresh', team: 'single', overrides: { strictDelegation: true, permissionMode: 'plan' } }]])

    // bypassPermissions widens a 'default' project: exec asks for 'configure', so does the TUI (one call, then closed).
    session.setComposeTarget('new')
    await session.submitPrompt('wide', { overrides: { permissionMode: 'bypassPermissions' } })
    expect(conf.callsOf('runs:start')).toEqual([[{ projectId: 'p1', prompt: 'wide', overrides: { permissionMode: 'bypassPermissions' } }]])
    expect(conf.closed).toBe(true)
    expect(f.connectCalls[1].scopes).toEqual([...SCOPES, 'configure'])
  })

  it('startQuick passes the overrides; none means no overrides key', async () => {
    const q = summary('q1', { status: 'starting', projectId: 'quick' })
    const h = host([q], { 'runs:startQuick': () => q })
    const { session } = await open([h])
    await session.startQuick({ prompt: 'hi', allowEdits: false, overrides: { goal: 'speed' } })
    await session.startQuick({ prompt: 'again', allowEdits: false })
    expect(h.callsOf('runs:startQuick')).toEqual([
      [{ prompt: 'hi', folder: '/work', team: 'single', allowEdits: false, overrides: { goal: 'speed' } }],
      [{ prompt: 'again', folder: '/work', team: 'single', allowEdits: false }]
    ])
  })
})

describe('paused runs and the model switch', () => {
  it('resumeNow follows the resumed run; cancelAutoResume calls the host for the followed run', async () => {
    const p1 = summary('p1run', { status: 'paused', autoResume: true, startedAt: 1 })
    const next = summary('p2run', { status: 'starting', startedAt: 5, resumedFrom: 'p1run' })
    const list = [p1]
    const h = host(list, { 'runs:resumeNow': () => next, 'runs:cancelAutoResume': () => undefined })
    const { session } = await open([h], 'p1run')
    await session.cancelAutoResume()
    expect(h.callsOf('runs:cancelAutoResume')).toEqual([['p1run']])
    list.push(next)
    const r = await session.resumeNow()
    expect(r.id).toBe('p2run')
    expect(h.callsOf('runs:resumeNow')).toEqual([['p1run']])
    expect(session.getState().activeRunId).toBe('p2run')
    expect(session.getState().activeChain).toEqual(['p1run', 'p2run'])
  })

  it('modelCatalog and switchModel go through the shared guard and update the summary', async () => {
    const r1 = summary('r1', { status: 'finished', connection: 'anthropic', modelSelection: { model: 'opus', connection: 'anthropic' } })
    const h = host([r1], {
      'connections:list': () => [{ connection: { id: 'anthropic', tierModels: {} }, status: { state: 'connected' } } as unknown as ConnectionInfo],
      'models:list': () => [{ id: 'haiku', label: 'Haiku', connection: 'anthropic', adapter: 'claude' }],
      'runs:pendingCards': () => noCards(),
      'runs:listLive': () => [],
      'runs:switchModel': (p) => {
        const sel = (p as { model: string; connection: string }[])[0]
        return { run: { ...r1, modelSelection: { model: sel.model, connection: sel.connection } }, applied: false }
      }
    })
    const { session } = await open([h], 'r1')
    const cat = await session.modelCatalog()
    expect(cat.models.map((m) => m.id)).toEqual(['haiku'])
    const out = await session.switchModel(cat.models[0], { confirm: async () => true })
    expect(out.kind).toBe('next')
    expect(session.getState().runs.r1.summary.modelSelection).toEqual({ model: 'haiku', connection: 'anthropic' })
  })
})
