/** /new and /ask run flags, /model, /resume-now and /cancel-resume (cli-parity 3.5). */
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionInfo, ProviderModel, RunSummary } from '../../shared/types'
import type { ModelCatalog } from '../modelSwitch'
import { findSlash, SLASH_COMMANDS } from './slashCommands'
import type { SlashContext, TuiSessionApi, TuiState } from './types'

const summary = (over: Partial<RunSummary> = {}): RunSummary =>
  ({ id: 'r1', projectId: 'p1', prompt: 'p', status: 'idle', startedAt: 1, kind: 'work', connection: 'anthropic', modelAdapter: 'claude', modelSelection: { model: 'opus', connection: 'anthropic' }, ...over }) as RunSummary

function stateWith(over: Partial<RunSummary> = {}, extra: Partial<TuiState> = {}): TuiState {
  return {
    connection: 'live',
    folder: '/w',
    project: { id: 'p1', name: 'P' } as TuiState['project'],
    runs: { r1: { summary: summary(over), agents: {}, transcript: [], partials: {}, cards: {} as TuiState['runs'][string]['cards'], recordLoaded: true } },
    runOrder: ['r1'],
    activeChain: ['r1'],
    activeRunId: 'r1',
    composeTarget: 'active',
    notices: [],
    resolved: [],
    cardSeq: 0,
    ...extra
  }
}

const m = (id: string, connection = 'anthropic', adapter = 'claude'): ProviderModel => ({ id, label: id, connection, family: 'claude', adapter, source: 'builtin' }) as ProviderModel
const catalog: ModelCatalog = {
  connections: [{ connection: { id: 'anthropic', tierModels: { fast: 'haiku', deep: 'opus' } }, status: { state: 'connected' } } as unknown as ConnectionInfo],
  models: [m('opus'), m('haiku'), m('gpt', 'openai', 'codex')],
  failed: []
}

function fakeCtx(state: TuiState, extra: Partial<SlashContext> = {}) {
  const session = {
    modelCatalog: vi.fn(async () => catalog),
    switchModel: vi.fn(async (sel: ProviderModel) => ({ kind: 'applied', run: summary({ modelSelection: { model: sel.id, connection: sel.connection } }), stopped: false })),
    resumeNow: vi.fn(async () => summary({ id: 'r2', status: 'starting' })),
    cancelAutoResume: vi.fn(async () => undefined)
  }
  const ctx: SlashContext = {
    session: session as unknown as TuiSessionApi,
    state: () => state,
    notify: vi.fn(),
    setFocus: vi.fn(),
    togglePane: vi.fn(),
    newRun: vi.fn(async () => {}),
    switchRun: vi.fn(async () => {}),
    confirm: vi.fn(async () => true),
    openText: vi.fn(async () => {}),
    quit: vi.fn(),
    ...extra
  }
  return { ctx, session }
}

const cmd = (name: string) => SLASH_COMMANDS.find((c) => c.name === name)!

describe('/new and /ask run flags', () => {
  it('pass the overrides with the prompt, or alone for the next prompt', async () => {
    const { ctx } = fakeCtx(stateWith())
    await cmd('new').run(ctx, '--goal speed --strict-delegation fix \x1b[31mit')
    expect(ctx.newRun).toHaveBeenLastCalledWith({ prompt: 'fix it', overrides: { goal: 'speed', strictDelegation: true } })
    await cmd('ask').run(ctx, '--permission-mode plan')
    expect(ctx.newRun).toHaveBeenLastCalledWith({ team: 'single', overrides: { permissionMode: 'plan' } })
    await cmd('new').run(ctx, 'plain prompt')
    expect(ctx.newRun).toHaveBeenLastCalledWith({ prompt: 'plain prompt' })
  })

  it('a bad value is one danger notice and starts nothing', async () => {
    const { ctx } = fakeCtx(stateWith())
    await cmd('new').run(ctx, '--goal fastest go')
    expect(ctx.newRun).not.toHaveBeenCalled()
    expect(ctx.notify).toHaveBeenCalledWith('--goal must be one of balanced, speed, cost.', 'danger')
  })
})

describe('/model', () => {
  it('a tier resolves through the run connection and switches; the handoff confirmation is the desktop wording', async () => {
    const { ctx, session } = fakeCtx(stateWith())
    await cmd('model').run(ctx, 'fast')
    expect(session.switchModel).toHaveBeenCalledWith(expect.objectContaining({ id: 'haiku', connection: 'anthropic' }), expect.any(Object))
    expect(ctx.notify).toHaveBeenLastCalledWith('Model changed to haiku via Anthropic.')
    const confirm = (session.switchModel.mock.calls[0] as unknown[])[1] as { confirm(): Promise<boolean> }
    await confirm.confirm()
    expect(ctx.confirm).toHaveBeenCalledWith(expect.stringContaining('End this session and switch model? Your conversation stays here.'))
  })

  it('without an argument offers a picker; Esc changes nothing; a pick switches', async () => {
    const pick = vi.fn(async () => undefined as string | undefined)
    const { ctx, session } = fakeCtx(stateWith(), { pick })
    await cmd('model').run(ctx, '')
    const [title, options] = pick.mock.calls[0] as unknown as [string, { value: string; label: string }[]]
    expect(title).toBe('Model (current: opus via Anthropic)')
    expect(options.map((o) => o.label)).toEqual(['haiku · Anthropic · fast', 'opus · Anthropic · deep · current', 'gpt · OpenAI · ends session'])
    expect(session.switchModel).not.toHaveBeenCalled()
    pick.mockResolvedValueOnce(options[2].value)
    session.switchModel.mockResolvedValueOnce({ kind: 'next', run: summary(), stopped: true })
    await cmd('model').run(ctx, '')
    expect(session.switchModel).toHaveBeenCalledWith(expect.objectContaining({ id: 'gpt', connection: 'openai' }), expect.any(Object))
    expect(ctx.notify).toHaveBeenLastCalledWith('Model selected for the next message: gpt via OpenAI.')
  })

  it('without a picker it opens the list; the current model and unknown ids only notify; host errors are one danger line', async () => {
    const { ctx, session } = fakeCtx(stateWith())
    await cmd('model').run(ctx, '')
    expect(ctx.openText).toHaveBeenCalledWith('Models', expect.stringContaining('Switch: /model <tier|model id>'))
    await cmd('model').run(ctx, 'deep')
    expect(ctx.notify).toHaveBeenLastCalledWith('Already on opus via Anthropic.')
    await cmd('model').run(ctx, 'nope')
    expect(ctx.notify).toHaveBeenLastCalledWith('Model nope is not available on a connected connection.', 'warn')
    session.switchModel.mockRejectedValueOnce(new Error('Answer the open decisions\nbefore changing models.'))
    await cmd('model').run(ctx, 'haiku')
    expect(ctx.notify).toHaveBeenLastCalledWith('Answer the open decisions before changing models.', 'danger')
  })

  it('needs a writable session; without a followed run it stages for the next one', () => {
    expect(findSlash('model', stateWith())).toBeDefined()
    expect(findSlash('model', stateWith({}, { activeRunId: undefined }))).toBeDefined()
    expect(findSlash('model', stateWith({}, { readOnlyReason: 'elsewhere' }))).toBeUndefined()
  })
})

describe('paused runs', () => {
  it('/resume-now and /cancel-resume are offered only on a paused run (cancel only while it would resume by itself)', async () => {
    expect(findSlash('resume-now', stateWith())).toBeUndefined()
    expect(cmd('resume-now').unavailableReason?.(stateWith())).toBe('This run is not paused.')
    const pausedAuto = stateWith({ status: 'paused', autoResume: true })
    expect(findSlash('resume-now', pausedAuto)).toBeDefined()
    expect(findSlash('cancel-resume', pausedAuto)).toBeDefined()
    const pausedManual = stateWith({ status: 'paused', autoResume: false })
    expect(findSlash('cancel-resume', pausedManual)).toBeUndefined()
    expect(cmd('cancel-resume').unavailableReason?.(pausedManual)).toBe('This run is not set to resume by itself.')

    const { ctx, session } = fakeCtx(pausedAuto)
    await cmd('resume-now').run(ctx, '')
    expect(session.resumeNow).toHaveBeenCalled()
    await cmd('cancel-resume').run(ctx, '')
    expect(session.cancelAutoResume).toHaveBeenCalled()
    expect(ctx.notify).toHaveBeenLastCalledWith('The run stays paused. /resume-now resumes it.')
    session.resumeNow.mockRejectedValueOnce(new Error('Run is not paused'))
    await cmd('resume-now').run(ctx, '')
    expect(ctx.notify).toHaveBeenLastCalledWith('Run is not paused', 'danger')
  })
})
