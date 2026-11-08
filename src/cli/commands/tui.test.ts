import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, ProjectPathCheck, RunSummary } from '../../shared/types'
import { FakeHostClient, fakeContext, fakeInproc, project, summary, type FakeContextOptions } from '../testing/fakeContext'
import type { TuiHostConnection, TuiLaunch } from '../tui/types'
import { EXIT, type CliContext } from '../types'

const tui = vi.hoisted(() => ({
  calls: [] as { launch: TuiLaunch; flags: { inline: boolean; screenReader: boolean }; prepared?: TuiLaunch; error?: unknown }[],
  conn: undefined as unknown
}))

vi.mock('../tui/index', () => ({
  runTui: async (_ctx: unknown, launch: TuiLaunch, flags: { inline: boolean; screenReader: boolean }, opts?: { prepare?(c: unknown): Promise<TuiLaunch> }) => {
    const entry: (typeof tui.calls)[number] = { launch, flags }
    tui.calls.push(entry)
    if (opts?.prepare) entry.prepared = await opts.prepare(tui.conn)
    return 0
  }
}))

const { defaultTuiPrintsHelp, runDefaultTui, runResumeTui, runTuiCommand, PROMPT_HINT } = await import('./tui')

const P1 = project('p1', '/work')

function fakeConn(answers: { projects?: Project[]; runs?: RunSummary[] } = {}): TuiHostConnection {
  const client = new FakeHostClient({
    'projects:list': () => answers.projects ?? [P1],
    'runs:list': () => answers.runs ?? [],
    'runs:get': () => null
  })
  return {
    client,
    hello: client.hello,
    inproc: fakeInproc(),
    projects: async () => answers.projects ?? [P1],
    checkPath: async () => ({ exists: true, isDirectory: true, isGitRepo: true, suggestedName: 'work', empty: false }) as ProjectPathCheck,
    createProject: async () => P1,
    startSetup: async () => summary('run_setup1'),
    close: async () => undefined
  }
}

function ttyCtx(o: FakeContextOptions & { tty?: boolean } = {}) {
  const f = fakeContext({ stdinIsTTY: o.tty ?? true, ...o })
  ;(f.ctx.io.stdout as { isTTY?: boolean }).isTTY = o.tty ?? true
  return f
}

const managed = (ctx: CliContext): void => {
  const orig = ctx.resolveProject
  ctx.resolveProject = (projects) => ({ ...orig(projects), managedWorktree: { mainCheckout: '/repo' } })
}

beforeEach(() => {
  tui.calls.length = 0
  tui.conn = fakeConn()
})

describe('bare orgai / orgai <prompt>', () => {
  it('without a terminal and without a prompt prints the help (exit 0) and never starts the TUI', async () => {
    const f = ttyCtx({ tty: false })
    expect(await runDefaultTui(f.ctx, [], { help: () => 'HELP TEXT' })).toBe(EXIT.ok)
    expect(f.out()).toContain('HELP TEXT')
    expect(tui.calls).toEqual([])
    expect(f.connectCalls).toEqual([])
  })

  it('defaultTuiPrintsHelp: only without a terminal on both ends and without a prompt', () => {
    const io = (stdin: boolean, stdout: boolean) => ({ stdinIsTTY: stdin, stdout: { write: () => true, isTTY: stdout } as never })
    expect(defaultTuiPrintsHelp(io(false, false), [])).toBe(true)
    expect(defaultTuiPrintsHelp(io(true, false), ['--inline'])).toBe(true)
    expect(defaultTuiPrintsHelp(io(false, true), ['--', 'fix the bug'])).toBe(false)
    expect(defaultTuiPrintsHelp(io(true, true), [])).toBe(false)
    expect(() => defaultTuiPrintsHelp(io(false, false), ['--team', 'x'])).toThrow()
  })

  it('a prompt without a terminal is a usage error pointing at exec', async () => {
    const f = ttyCtx({ tty: false })
    await expect(runDefaultTui(f.ctx, ['--', 'fix', 'the', 'bug'])).rejects.toMatchObject({ exitCode: EXIT.usage, message: expect.stringContaining('orgai exec') })
  })

  it('`orgai -- fix the bug` and `orgai "fix the bug"` launch with that prompt in the folder project', async () => {
    const f = ttyCtx()
    expect(await runDefaultTui(f.ctx, ['--', 'fix', 'the', 'bug'])).toBe(0)
    expect(await runDefaultTui(f.ctx, ['--inline', '--team', 'single', 'fix the bug'])).toBe(0)
    expect(tui.calls[0].prepared).toEqual({ project: P1, prompt: 'fix the bug' })
    expect(tui.calls[1].prepared).toEqual({ project: P1, prompt: 'fix the bug', team: 'single' })
    expect(tui.calls[1].flags).toEqual({ inline: true, screenReader: false })
  })

  it('one bare word without -- is a usage error with the hint; --team needs a prompt', async () => {
    const f = ttyCtx()
    await expect(runDefaultTui(f.ctx, ['fix'])).rejects.toMatchObject({ exitCode: EXIT.usage, message: expect.stringContaining(PROMPT_HINT) })
    await expect(runDefaultTui(f.ctx, ['--team', 'single'])).rejects.toMatchObject({ exitCode: EXIT.usage })
    await expect(runDefaultTui(f.ctx, ['--team', 'x', '--', 'a'])).rejects.toMatchObject({ exitCode: EXIT.usage })
    expect(await runDefaultTui(f.ctx, ['--', 'fix'])).toBe(0)
  })

  it('an unregistered folder opens onboarding', async () => {
    const f = ttyCtx({ cwd: '/elsewhere' })
    tui.conn = fakeConn({ projects: [P1] })
    expect(await runDefaultTui(f.ctx, ['--ax-screen-reader'])).toBe(0)
    expect(tui.calls[0].prepared).toEqual({ onboarding: { folder: '/elsewhere' } })
    expect(tui.calls[0].flags).toEqual({ inline: false, screenReader: true })
  })

  it('refuses in a managed agent worktree with exit 2 naming the main checkout, before any host', async () => {
    const f = ttyCtx()
    managed(f.ctx)
    await expect(runDefaultTui(f.ctx, [])).rejects.toMatchObject({ exitCode: EXIT.usage, message: expect.stringContaining('/repo') })
    await expect(runDefaultTui(f.ctx, ['--', 'do it'])).rejects.toMatchObject({ exitCode: EXIT.usage })
    expect(tui.calls).toEqual([])
    expect(f.connectCalls).toEqual([])
  })
})

describe('orgai tui', () => {
  const runs = [summary('run_bbbbbb02', { startedAt: 200 }), summary('run_aaaaaa01', { startedAt: 100 })]

  it('tui --run resolves refs against this process\'s host', async () => {
    tui.conn = fakeConn({ runs })
    const f = ttyCtx()
    expect(await runTuiCommand(f.ctx, ['--run', 'R1'])).toBe(0)
    expect(await runTuiCommand(f.ctx, ['--run', 'run_bbbbbb02', '--inline'])).toBe(0)
    expect(tui.calls[0].prepared).toEqual({ runId: 'run_aaaaaa01', project: P1 })
    expect(tui.calls[1].prepared).toEqual({ runId: 'run_bbbbbb02', project: P1 })
    expect(tui.calls[1].flags.inline).toBe(true)
  })

  it('tui <run> opens a saved run like --run; both together are refused', async () => {
    tui.conn = fakeConn({ runs })
    const f = ttyCtx()
    expect(await runTuiCommand(f.ctx, ['R1'])).toBe(0)
    expect(tui.calls[0].prepared).toEqual({ runId: 'run_aaaaaa01', project: P1 })
    await expect(runTuiCommand(f.ctx, ['R1', '--run', 'R1'])).rejects.toMatchObject({ exitCode: EXIT.usage })
    await expect(runTuiCommand(f.ctx, ['R1', 'R2'])).rejects.toMatchObject({ exitCode: EXIT.usage })
  })
  it('a bad ref is a usage error', async () => {
    tui.conn = fakeConn({ runs })
    const f = ttyCtx()
    await expect(runTuiCommand(f.ctx, ['--run', 'R9'])).rejects.toMatchObject({ exitCode: EXIT.usage })
    await expect(runTuiCommand(f.ctx, ['extra'])).rejects.toMatchObject({ exitCode: EXIT.usage })
  })

  it('needs a terminal', async () => {
    const f = ttyCtx({ tty: false })
    await expect(runTuiCommand(f.ctx, ['--run', 'R1'])).rejects.toMatchObject({ exitCode: EXIT.usage, message: expect.stringContaining('needs a terminal') })
    await expect(runTuiCommand(f.ctx, [])).rejects.toMatchObject({ exitCode: EXIT.usage })
  })

  it('in a managed worktree tui --run opens read-only; bare tui refuses', async () => {
    tui.conn = fakeConn({ runs })
    const f = ttyCtx()
    managed(f.ctx)
    expect(await runTuiCommand(f.ctx, ['--run', 'R2'])).toBe(0)
    for (const c of tui.calls) {
      expect(c.prepared?.runId).toBe('run_bbbbbb02')
      expect(c.prepared?.readOnlyReason).toBe('This folder is an agent worktree; continue runs from the main checkout: /repo')
    }
    await expect(runTuiCommand(f.ctx, [])).rejects.toMatchObject({ exitCode: EXIT.usage })
  })
})

describe('orgai resume (terminal UI)', () => {
  it('opens the TUI on the ref with the resume text, or on the newest ended run', async () => {
    tui.conn = fakeConn({ runs: [summary('run_live0003', { startedAt: 300, status: 'running' }), summary('run_end00002', { startedAt: 200 }), summary('run_end00001', { startedAt: 100 })] })
    const f = ttyCtx()
    expect(await runResumeTui(f.ctx, ['R1', '--prompt', 'more'])).toBe(0)
    expect(await runResumeTui(f.ctx, [])).toBe(0)
    expect(tui.calls[0].prepared).toEqual({ runId: 'run_end00001', project: P1, resumeText: 'more' })
    expect(tui.calls[1].prepared).toEqual({ runId: 'run_end00002', project: P1 })
  })

  it('refuses stdin, an empty prompt, no ended run and a managed worktree', async () => {
    const f = ttyCtx()
    await expect(runResumeTui(f.ctx, ['-'])).rejects.toMatchObject({ exitCode: EXIT.usage, message: expect.stringContaining('--exec') })
    await expect(runResumeTui(f.ctx, ['--prompt', ' '])).rejects.toMatchObject({ exitCode: EXIT.usage })
    await expect(runResumeTui(f.ctx, ['--prompt', '-'])).rejects.toMatchObject({ exitCode: EXIT.usage, message: expect.stringContaining('--exec') })
    await expect(runResumeTui(f.ctx, ['R1', '--prompt=-'])).rejects.toMatchObject({ exitCode: EXIT.usage, message: expect.stringContaining('--exec') })
    tui.conn = fakeConn({ runs: [summary('run_live0003', { status: 'running' })] })
    await expect(runResumeTui(f.ctx, [])).rejects.toMatchObject({ exitCode: EXIT.usage, message: 'This project has no ended run to resume.' })
    const g = ttyCtx()
    managed(g.ctx)
    await expect(runResumeTui(g.ctx, ['R1'])).rejects.toMatchObject({ exitCode: EXIT.usage, message: expect.stringContaining('/repo') })
  })
})
