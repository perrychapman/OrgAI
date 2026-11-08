import { describe, expect, it, vi } from 'vitest'
import type { AgentInstance, RunSummary } from '../../shared/types'
import { findSlash, HELP_TEXT, matchSlash, parseSlash, resolveDiffTarget, runsTable, SLASH_COMMANDS, unavailableFor, unavailableMessage } from './slashCommands'
import type { SlashContext, TuiSessionApi, TuiState } from './types'

const summary = (id: string, over: Partial<RunSummary> = {}): RunSummary =>
  ({ id, projectId: 'p1', prompt: `prompt ${id}`, status: 'running', startedAt: 1, kind: 'work', ...over }) as RunSummary

function stateWith(over: Partial<TuiState> = {}, status: RunSummary['status'] = 'running', agents: Record<string, AgentInstance> = {}): TuiState {
  return {
    connection: 'live',
    folder: '/tmp/p',
    project: { id: 'p1', name: 'P' } as TuiState['project'],
    runs: {
      r1: {
        summary: summary('r1', { status }),
        agents,
        transcript: [],
        partials: {},
        cards: {} as TuiState['runs'][string]['cards'],
        recordLoaded: true
      }
    },
    runOrder: ['r1'],
    activeChain: ['r1'],
    activeRunId: 'r1',
    composeTarget: 'active',
    notices: [],
    resolved: [],
    cardSeq: 0,
    ...over
  }
}

function fakeCtx(state: TuiState = stateWith()) {
  const session = {
    interrupt: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    listRuns: vi.fn(async () => [summary('a', { startedAt: 2, title: 'Second\x1b[31m run' }), summary('b', { startedAt: 1, status: 'finished' })]),
    worktreeDiff: vi.fn(async () => ({ stat: ' a.ts | 1 +', patch: '+x\x1b]52;c;QQ==\x07\n' })),
  } as unknown as TuiSessionApi
  const ctx = {
    session,
    state: () => state,
    notify: vi.fn(),
    setFocus: vi.fn(),
    togglePane: vi.fn(),
    newRun: vi.fn(async () => {}),
    switchRun: vi.fn(async () => {}),
    confirm: vi.fn(async () => true),
    openText: vi.fn(async () => {}),
    quit: vi.fn()
  } satisfies SlashContext
  return { ctx, session: session as unknown as Record<string, ReturnType<typeof vi.fn>> }
}

const cmd = (name: string) => {
  const c = SLASH_COMMANDS.find((x) => x.name === name)
  if (!c) throw new Error(name)
  return c
}

describe('parseSlash', () => {
  it('splits name and args', () => {
    expect(parseSlash('/new fix the bug ')).toEqual({ name: 'new', args: 'fix the bug' })
    expect(parseSlash('  /RUNS')).toEqual({ name: 'runs', args: '' })
    expect(parseSlash('/new line one\nline two')).toEqual({ name: 'new', args: 'line one\nline two' })
    expect(parseSlash('hello')).toBeNull()
    expect(parseSlash('/')).toBeNull()
    expect(parseSlash('/\x1b[31m')).toBeNull()
  })
})

describe('matchSlash', () => {
  it('prefix-matches names and aliases, exact first, ties by name', () => {
    const s = stateWith()
    expect(matchSlash('/', s).length).toBe(SLASH_COMMANDS.filter((c) => !c.available || c.available(s)).length)
    expect(matchSlash('/r', s).map((c) => c.name)).toEqual(['run', 'runs'])
    expect(matchSlash('run', s).map((c) => c.name)).toEqual(['run', 'runs'])
    expect(matchSlash('/q', s)[0].name).toBe('quit')
    expect(matchSlash('/wt', s)[0].name).toBe('worktrees')
    expect(matchSlash('/new some prompt', s).map((c) => c.name)).toEqual(['new'])
    expect(matchSlash('/zzz', s)).toEqual([])
  })

  it('respects availability', () => {
    const ended = stateWith({}, 'finished')
    expect(matchSlash('/interrupt', ended)).toEqual([])
    expect(matchSlash('/stop', ended)).toEqual([])
    expect(matchSlash('/interrupt', stateWith())[0].name).toBe('interrupt')
    const ro = stateWith({ readOnlyReason: 'read only' })
    expect(matchSlash('/new', ro)).toEqual([])
    expect(matchSlash('/ask', stateWith({ project: undefined }))).toEqual([])
    expect(findSlash('exit', ro)?.name).toBe('quit')
  })
})

describe('unavailable commands (#29 M6) and the empty-query order (#30 L6)', () => {
  it('every command with available() gives a reason, and /retro names why', () => {
    const s = stateWith({}, 'running')
    for (const c of SLASH_COMMANDS.filter((x) => x.available)) expect(c.unavailableReason, c.name).toBeTypeOf('function')
    expect(unavailableMessage('retro', s)).toMatch(/^\/retro: .*not ended/)
    expect(unavailableMessage('retrospective', s)).toMatch(/^\/retro: /)
    expect(unavailableMessage('retro', stateWith({}, 'finished'))).toBeUndefined()
    expect(unavailableMessage('run', s)).toBeUndefined()
    expect(unavailableMessage('zzz', s)).toBeUndefined()
    expect(unavailableMessage('new', stateWith({ readOnlyReason: 'read only' }))).toBe('/new: Read-only: read only')
    expect(unavailableMessage('new', stateWith({ project: undefined }))).toBe('/new: Open a project folder first.')
    expect(unavailableFor(SLASH_COMMANDS, '/ret', s)?.cmd.name).toBe('retro')
  })

  it('an empty query lists help and new first, then alphabetical', () => {
    const names = matchSlash('/', stateWith()).map((c) => c.name)
    expect(names.slice(0, 2)).toEqual(['help', 'new'])
    const rest = names.slice(2)
    expect(rest).toEqual([...rest].sort())
    // A typed query keeps the old ranking.
    expect(matchSlash('/r', stateWith()).map((c) => c.name)).toEqual(['run', 'runs'])
  })

  it('/help leads with the commands, then the keys, and every command is listed', () => {
    expect(HELP_TEXT.indexOf('Commands')).toBe(0)
    expect(HELP_TEXT.indexOf('/help')).toBeLessThan(HELP_TEXT.indexOf('\nKeys\n'))
    for (const c of SLASH_COMMANDS) expect(HELP_TEXT).toContain(`/${c.name}`)
  })
})

describe('commands', () => {
  it('/new and /ask call newRun with the sanitized prompt', async () => {
    const { ctx } = fakeCtx()
    await cmd('new').run(ctx, ' fix \x1b[2Jit‮ ')
    expect(ctx.newRun).toHaveBeenCalledWith({ prompt: 'fix it' })
    await cmd('new').run(ctx, '')
    expect(ctx.newRun).toHaveBeenLastCalledWith({})
    await cmd('ask').run(ctx, 'why')
    expect(ctx.newRun).toHaveBeenLastCalledWith({ prompt: 'why', team: 'single' })
  })

  it('/runs opens a table with tags, status words and sanitized titles', async () => {
    const { ctx, session } = fakeCtx()
    await cmd('runs').run(ctx, '')
    expect(session.listRuns).toHaveBeenCalled()
    const [title, text] = (ctx.openText as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(title).toBe('Runs')
    const lines = (text as string).split('\n')
    expect(lines[1]).toMatch(/^R1\s+Finished\s+prompt b$/)
    expect(lines[2]).toMatch(/^R2\s+Running\s+Second run$/)
    expect(text).not.toContain('\x1b')
  })

  it('/run switches, and asks for a ref when empty', async () => {
    const { ctx } = fakeCtx()
    await cmd('run').run(ctx, ' R2 ')
    expect(ctx.switchRun).toHaveBeenCalledWith('R2')
    await cmd('run').run(ctx, '')
    expect(ctx.switchRun).toHaveBeenCalledTimes(1)
    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining('/run R2'), 'warn')
  })

  it('/interrupt, /stop (confirmed), /quit, /inbox and pane toggles', async () => {
    const { ctx, session } = fakeCtx()
    await cmd('interrupt').run(ctx, '')
    expect(session.interrupt).toHaveBeenCalled()
    await cmd('stop').run(ctx, '')
    expect(ctx.confirm).toHaveBeenCalledWith('End this session?')
    expect(session.stop).toHaveBeenCalledTimes(1)
    ;(ctx.confirm as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false)
    await cmd('stop').run(ctx, '')
    expect(session.stop).toHaveBeenCalledTimes(1)
    await cmd('inbox').run(ctx, '')
    expect(ctx.setFocus).toHaveBeenCalledWith('tray')
    await cmd('tree').run(ctx, '')
    await cmd('plan').run(ctx, '')
    await cmd('worktrees').run(ctx, '')
    expect((ctx.togglePane as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(['tree', 'plan', 'worktrees'])
    await cmd('quit').run(ctx, '')
    expect(ctx.quit).toHaveBeenCalled()
  })

  it('/help lists keys and commands', async () => {
    const { ctx } = fakeCtx()
    await cmd('help').run(ctx, '')
    const text = (ctx.openText as ReturnType<typeof vi.fn>).mock.calls[0][1] as string
    for (const s of ['Alt+D', 'F2', 'Ctrl+.', 'Shift+Tab', 'Esc', 'Ctrl+Z', '/diff', '/quit']) expect(text).toContain(s)
  })

  it('/diff resolves an agent to its branch and sanitizes the diff', async () => {
    const agents = {
      a1: { id: 'a1', name: 'Builder', handle: 'builder-1', worktree: { path: '/w', branch: 'worktree-agent-a1', status: 'changes' } }
    } as unknown as Record<string, AgentInstance>
    const { ctx, session } = fakeCtx(stateWith({}, 'running', agents))
    await cmd('diff').run(ctx, 'builder-1')
    expect(session.worktreeDiff).toHaveBeenCalledWith('worktree-agent-a1')
    const [title, body] = (ctx.openText as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(title).toBe('Diff worktree-agent-a1')
    expect(body).toBe(' a.ts | 1 +\n\n+x\n')
    await cmd('diff').run(ctx, '')
    expect(session.worktreeDiff).toHaveBeenLastCalledWith('worktree-agent-a1')
    await cmd('diff').run(ctx, 'feature/x')
    expect(session.worktreeDiff).toHaveBeenLastCalledWith('feature/x')
    await cmd('diff').run(ctx, '--output=/etc/x')
    expect(session.worktreeDiff).toHaveBeenCalledTimes(3)
    expect(ctx.notify).toHaveBeenLastCalledWith(expect.stringContaining('not an agent or branch'), 'warn')
  })

  it('a failing command becomes one sanitized danger notice', async () => {
    const { ctx, session } = fakeCtx()
    session.interrupt.mockRejectedValueOnce(new Error('Host \x1b]0;pwn\x07said no'))
    await expect(cmd('interrupt').run(ctx, '')).resolves.toBeUndefined()
    expect(ctx.notify).toHaveBeenCalledWith('Host said no', 'danger')
  })
})

describe('helpers', () => {
  it('runsTable handles no runs', () => {
    expect(runsTable([], 'p1')).toBe('No runs yet.')
  })

  it('resolveDiffTarget without worktrees', () => {
    expect(resolveDiffTarget(stateWith(), '')).toEqual({ error: 'No agent in this run has a worktree.' })
  })
})
