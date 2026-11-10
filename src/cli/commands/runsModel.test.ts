import { afterEach, describe, expect, it } from 'vitest'
import type { ConnectionInfo, HostScope, PendingCards, ProviderModel, RunSummary } from '../../shared/types'
import { manageDeps } from '../manage'
import { FakeHostClient, fakeContext, project, record, rpcError, summary } from '../testing/fakeContext'
import { CliError, EXIT } from '../types'
import { runRuns } from './runs'

const ALL: { grantedScopes: HostScope[] } = { grantedScopes: ['read', 'operate', 'decide'] }
const P = project('p1', '/work', { name: 'App' })
const realDeps = { ...manageDeps }
afterEach(() => {
  Object.assign(manageDeps, realDeps)
})

const m = (id: string, connection = 'anthropic', adapter = 'claude', label = id): ProviderModel =>
  ({ id, label, connection, family: 'claude', adapter, source: 'builtin' }) as ProviderModel
const info = (id: string, tierModels: Record<string, string> = {}): ConnectionInfo =>
  ({ connection: { id, tierModels }, status: { state: 'connected' }, modelCount: 0 }) as unknown as ConnectionInfo
const noCards = (): PendingCards => ({ permissions: [], questions: [], proposals: [], ruleRequests: [], mergeReviews: [], mcpInstalls: [] })

function setup(run: RunSummary, opts: { format?: 'text' | 'json'; switchModel?: (p: unknown) => unknown; tty?: boolean } = {}) {
  let current = run
  const client = new FakeHostClient(
    {
      'projects:list': () => [P],
      'runs:list': () => [current],
      'runs:get': () => record(current),
      'runs:pendingCards': () => noCards(),
      'runs:listLive': () => [],
      'runs:stop': () => {
        current = { ...current, status: 'finished' }
      },
      'connections:list': () => [info('anthropic', { deep: 'claude-opus-5-5', fast: 'claude-haiku-5' }), info('openai')],
      'models:list': (p) =>
        (p as { connection: string }[])[0].connection === 'openai'
          ? [m('gpt-6', 'openai', 'codex')]
          : [m('claude-opus-5-5', 'anthropic', 'claude', 'Opus 5.5'), m('claude-haiku-5', 'anthropic', 'claude', 'Haiku 5')],
      'runs:switchModel':
        opts.switchModel ??
        ((p) => {
          const sel = (p as { model: string; connection: string }[])[0]
          current = { ...current, modelSelection: { model: sel.model, connection: sel.connection } }
          return { run: current, applied: false, reason: 'Model will be used when the run continues.' }
        })
    },
    { hello: ALL }
  )
  const f = fakeContext({ connect: [client], cwd: '/work', globals: { outputFormat: opts.format ?? 'text' }, stdinIsTTY: opts.tty ?? false })
  return { f, client }
}

const ended = summary('run_aaaaaa1', { status: 'finished', connection: 'anthropic', modelAdapter: 'claude', modelSelection: { model: 'claude-opus-5-5', connection: 'anthropic' } })

async function exitOf(p: Promise<number>): Promise<{ code: number; message?: string }> {
  try {
    return { code: await p }
  } catch (e) {
    if (e instanceof CliError) return { code: e.exitCode, message: e.message }
    throw e
  }
}

describe('orgai runs model', () => {
  it('without a value prints the current selection, the tiers and every choice (read scope only)', async () => {
    const { f, client } = setup(ended)
    expect(await runRuns(f.ctx, ['model', 'R1'])).toBe(0)
    const out = f.out()
    expect(out).toContain('R1 model: claude-opus-5-5 via Anthropic')
    expect(out).toContain('Tiers on Anthropic: deep claude-opus-5-5, fast claude-haiku-5')
    expect(out).toMatch(/claude-haiku-5\s+Haiku 5\s+Anthropic\s+fast/)
    expect(out).toMatch(/claude-opus-5-5\s+Opus 5.5\s+Anthropic\s+deep\s+current/)
    expect(out).toContain('gpt-6')
    expect(out).toContain('Switch: orgai runs model R1 <tier|model id>')
    expect(f.connectCalls[0].scopes).toEqual(['read'])
    expect(client.callsOf('runs:switchModel')).toEqual([])
  })

  it('json lists the choices with tiers and handoff flags', async () => {
    const live = { ...ended, status: 'idle' as const }
    const { f } = setup(live, { format: 'json' })
    expect(await runRuns(f.ctx, ['model', 'R1'])).toBe(0)
    const doc = JSON.parse(f.out())
    expect(doc).toMatchObject({ runId: 'run_aaaaaa1', tag: 'R1', current: { model: 'claude-opus-5-5', connection: 'anthropic' }, connection: 'anthropic' })
    expect(doc.choices).toContainEqual(expect.objectContaining({ id: 'gpt-6', connection: 'openai', handoff: true, current: false }))
    expect(doc.choices).toContainEqual(expect.objectContaining({ id: 'claude-haiku-5', tiers: ['fast'], handoff: false }))
  })

  it('a tier switches an ended run for its next message (operate scope)', async () => {
    const { f, client } = setup(ended)
    expect(await runRuns(f.ctx, ['model', 'R1', 'fast'])).toBe(0)
    expect(f.out()).toContain('R1 will use claude-haiku-5 via Anthropic when it continues. Continue it with: orgai resume R1')
    expect(client.callsOf('runs:switchModel')).toEqual([[{ runId: 'run_aaaaaa1', expectedRunId: 'run_aaaaaa1', connection: 'anthropic', model: 'claude-haiku-5' }]])
    expect(f.connectCalls[0].scopes).toEqual(['read', 'operate'])
  })

  it('an applied switch on an idle run, as json', async () => {
    const idle = { ...ended, status: 'idle' as const }
    const { f } = setup(idle, { format: 'json', switchModel: () => ({ run: { ...idle, modelSelection: { model: 'claude-haiku-5', connection: 'anthropic' } }, applied: true }) })
    expect(await runRuns(f.ctx, ['model', 'R1', 'claude-haiku-5'])).toBe(0)
    expect(JSON.parse(f.out())).toMatchObject({ outcome: 'applied', applied: true, selection: { model: 'claude-haiku-5', connection: 'anthropic' }, sessionEnded: false })
  })

  it('a handoff asks first: without a terminal it needs --yes; with --yes it ends the session and keeps the selection', async () => {
    const idle = { ...ended, status: 'idle' as const }
    const a = setup(idle)
    const r = await exitOf(runRuns(a.f.ctx, ['model', 'R1', 'gpt-6']))
    expect(r.code).toBe(EXIT.usage)
    expect(r.message).toContain('Pass --yes to confirm without a terminal.')
    expect(a.client.callsOf('runs:stop')).toEqual([])

    const b = setup(idle)
    expect(await runRuns(b.f.ctx, ['model', 'R1', 'gpt-6', '--yes'])).toBe(0)
    expect(b.client.callsOf('runs:stop')).toHaveLength(1)
    expect(b.f.out()).toContain('R1 will use gpt-6 via OpenAI when it continues (the session ended for the handoff).')

    const c = setup(idle, { tty: true })
    manageDeps.ttyConfirm = async () => false
    expect(await runRuns(c.f.ctx, ['model', 'R1', 'gpt-6'])).toBe(EXIT.failure)
    expect(c.f.out()).toContain('Cancelled. The model is unchanged.')
    expect(c.client.callsOf('runs:stop')).toEqual([])
  })

  it('shows the host refusal verbatim on one line; unknown choices and bad usage are exit 2', async () => {
    const idle = { ...ended, status: 'idle' as const }
    const { f } = setup(idle, { switchModel: () => ({ run: idle, applied: false, reason: 'This model has no known price,\n so the budget\x1b[31m cannot be enforced.' }) })
    const r = await exitOf(runRuns(f.ctx, ['model', 'R1', 'claude-haiku-5']))
    expect(r).toEqual({ code: EXIT.failure, message: 'This model has no known price, so the budget cannot be enforced.' })

    const thrown = setup(idle, {
      switchModel: () => {
        throw rpcError({ code: 'bad_request', message: 'Invalid model selection' })
      }
    })
    expect(await exitOf(runRuns(thrown.f.ctx, ['model', 'R1', 'claude-haiku-5']))).toEqual({ code: EXIT.usage, message: 'Invalid model selection' })

    const u = () => setup(idle).f.ctx
    expect(await exitOf(runRuns(u(), ['model', 'R1', 'nope']))).toMatchObject({ code: EXIT.usage, message: expect.stringContaining('not available') })
    expect(await exitOf(runRuns(u(), ['model']))).toMatchObject({ code: EXIT.usage, message: expect.stringContaining('orgai runs model') })
    expect(await exitOf(runRuns(u(), ['model', 'R1', '--yes']))).toMatchObject({ code: EXIT.usage })
    expect(await exitOf(runRuns(u(), ['model', 'R1', 'gpt-6', '--connection', 'anthropic']))).toMatchObject({ code: EXIT.usage, message: expect.stringContaining('not available on anthropic') })
  })
})
