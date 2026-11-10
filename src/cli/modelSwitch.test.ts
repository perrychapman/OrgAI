import { describe, expect, it, vi } from 'vitest'
import type { ConnectionInfo, PendingCards, ProviderModel, RunRecord, RunSummary, SwitchRunModelResult } from '../shared/types'
import { loadModelCatalog, modelChoices, pickModel, switchRunModel, tierRows, type HostCall } from './modelSwitch'

const m = (id: string, connection = 'anthropic', adapter: 'claude' | 'codex' = 'claude'): ProviderModel =>
  ({ id, label: id === 'opus' ? 'Opus' : id, connection, family: 'claude', adapter, source: 'builtin' }) as ProviderModel
const info = (id: string, state: string, tierModels: Record<string, string> = {}): ConnectionInfo =>
  ({ connection: { id, tierModels }, status: { state }, modelCount: 0 }) as unknown as ConnectionInfo
const noCards = (): PendingCards => ({ permissions: [], questions: [], proposals: [], ruleRequests: [], mergeReviews: [], mcpInstalls: [] })
const run = (extra: Partial<RunSummary> = {}): RunSummary =>
  ({ id: 'r1', projectId: 'p1', status: 'idle', connection: 'anthropic', modelAdapter: 'claude', modelSelection: { model: 'opus', connection: 'anthropic' }, startedAt: 1, ...extra }) as RunSummary

function fakeCall(answers: Record<string, (params: unknown[]) => unknown>): HostCall & { calls: string[] } {
  const calls: string[] = []
  const fn = (async (method: string, params: unknown[]) => {
    calls.push(method)
    const a = answers[method]
    if (!a) throw new Error(`no answer for ${method}`)
    return a(params)
  }) as HostCall & { calls: string[] }
  fn.calls = calls
  return fn
}

describe('loadModelCatalog', () => {
  it('lists the connected connections only and names the ones that failed', async () => {
    const call = fakeCall({
      'connections:list': () => [info('anthropic', 'connected', { deep: 'opus' }), info('openai', 'connected'), info('proxy-12345678', 'error')],
      'models:list': (p) => {
        const c = (p[0] as { connection: string }).connection
        if (c === 'openai') throw new Error('offline')
        return [m('opus'), m('haiku')]
      }
    })
    const cat = await loadModelCatalog(call)
    expect(cat.models.map((x) => x.id)).toEqual(['opus', 'haiku'])
    expect(cat.failed).toEqual(['openai'])
    expect(tierRows(run(), cat)).toEqual([{ tier: 'deep', model: 'opus' }])
  })
})

describe('modelChoices', () => {
  it('puts the run connection first, marks the current choice and the handoff ones', () => {
    const cat = { connections: [info('anthropic', 'connected', { deep: 'opus' })], models: [m('gpt', 'openai', 'codex'), m('opus'), m('opus'), m('haiku')], failed: [] }
    const rows = modelChoices(run(), cat)
    expect(rows.map((r) => [r.connection, r.id, r.current, r.handoff, r.tiers])).toEqual([
      ['anthropic', 'haiku', false, false, []],
      ['anthropic', 'opus', true, false, ['deep']],
      ['openai', 'gpt', false, true, []]
    ])
    // An ended session never needs a handoff: the selection waits for the next message.
    expect(modelChoices(run({ status: 'finished' }), cat).some((r) => r.handoff)).toBe(false)
    expect(pickModel(run(), cat, 'deep')).toEqual({ model: cat.models[1], tier: 'deep' })
    expect(pickModel(run({ connection: undefined, modelSelection: undefined }), cat, 'deep')).toEqual({ error: expect.stringContaining('no connection') })
  })
})

describe('switchRunModel', () => {
  function host(rec: RunRecord, result: (sel: unknown) => SwitchRunModelResult) {
    let current = rec
    const call = fakeCall({
      'runs:get': () => current,
      'runs:pendingCards': () => noCards(),
      'runs:listLive': () => [],
      'runs:interrupt': () => {
        current = { ...current, summary: { ...current.summary, status: 'idle' } }
      },
      'runs:stop': () => {
        current = { ...current, summary: { ...current.summary, status: 'finished' } }
      },
      'runs:switchModel': (p) => result(p[0])
    })
    return call
  }
  const rec = (s: RunSummary): RunRecord => ({ summary: s, agents: {}, transcript: [], logs: [] })

  it('interrupts a running session once, then applies', async () => {
    const call = host(rec(run({ status: 'running' })), () => ({ run: run({ modelSelection: { model: 'haiku', connection: 'anthropic' } }), applied: true }))
    const out = await switchRunModel(call, 'r1', m('haiku'), { confirm: vi.fn(async () => true), pause: async () => undefined })
    expect(out.kind).toBe('applied')
    expect(call.calls.filter((c) => c === 'runs:interrupt')).toHaveLength(1)
    expect(call.calls).not.toContain('runs:stop')
  })

  it('asks before a handoff, stops once, and saves the selection for the next message', async () => {
    const confirm = vi.fn(async () => true)
    const call = host(rec(run()), (sel) => ({ run: run({ status: 'finished', modelSelection: sel as RunSummary['modelSelection'] }), applied: false, reason: 'Model will be used when the run continues.' }))
    const out = await switchRunModel(call, 'r1', m('gpt', 'openai', 'codex'), { confirm, pause: async () => undefined })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ kind: 'next', stopped: true })
    expect(call.calls.filter((c) => c === 'runs:stop')).toHaveLength(1)
  })

  it('a declined handoff changes nothing', async () => {
    const call = host(rec(run()), () => ({ run: run(), applied: true }))
    const out = await switchRunModel(call, 'r1', m('gpt', 'openai', 'codex'), { confirm: async () => false, pause: async () => undefined })
    expect(out.kind).toBe('cancelled')
    expect(call.calls).not.toContain('runs:stop')
    expect(call.calls).not.toContain('runs:switchModel')
  })

  it('retries with a confirmed handoff when the host asks for one; other refusals throw the host reason', async () => {
    let n = 0
    const confirm = vi.fn(async () => true)
    const call = host(rec(run()), (sel) =>
      ++n === 1
        ? { run: run(), applied: false, reason: 'End this session, then select the model and send a message to continue with a transcript handoff.' }
        : { run: run({ status: 'finished', modelSelection: sel as RunSummary['modelSelection'] }), applied: false }
    )
    expect((await switchRunModel(call, 'r1', m('haiku'), { confirm, pause: async () => undefined })).kind).toBe('next')
    expect(confirm).toHaveBeenCalledTimes(1)

    const refused = host(rec(run()), () => ({ run: run(), applied: false, reason: 'The conversation budget is spent; switching models does not reset it.' }))
    await expect(switchRunModel(refused, 'r1', m('haiku'), { confirm, pause: async () => undefined })).rejects.toThrow('The conversation budget is spent')
  })

  it('refuses while decisions are open, before any interrupt', async () => {
    const call = fakeCall({
      'runs:get': () => rec(run({ status: 'running' })),
      'runs:pendingCards': () => ({ ...noCards(), permissions: [{}] }),
      'runs:listLive': () => []
    })
    await expect(switchRunModel(call, 'r1', m('haiku'), { confirm: async () => true })).rejects.toThrow('Answer the open decisions')
    expect(call.calls).not.toContain('runs:interrupt')
  })
})
