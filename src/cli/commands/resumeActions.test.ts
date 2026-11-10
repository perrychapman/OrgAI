import { describe, expect, it } from 'vitest'
import type { HostScope, RunSummary } from '../../shared/types'
import { FakeHostClient, fakeContext, project, record, rpcError, summary } from '../testing/fakeContext'
import { connectTuiHost } from '../tui/session'
import { CliError, EXIT } from '../types'
import { runResume } from './exec'
import { notPausedHint, prepareResumeNow } from './resumeActions'

const ALL: { grantedScopes: HostScope[] } = { grantedScopes: ['read', 'operate', 'decide'] }
const P = project('p1', '/work', { name: 'App' })

function setup(run: RunSummary, opts: { format?: 'text' | 'json'; answers?: Record<string, (p: unknown) => unknown> } = {}) {
  let current = run
  const client = new FakeHostClient(
    {
      'projects:list': () => [P],
      'runs:list': () => [current],
      'runs:get': () => record(current),
      'runs:cancelAutoResume': () => {
        current = { ...current, autoResume: false }
      },
      ...opts.answers
    },
    { hello: ALL }
  )
  const f = fakeContext({ connect: [client], cwd: '/work', globals: { outputFormat: opts.format ?? 'text' } })
  return { f, client }
}

async function exitOf(p: Promise<number>): Promise<{ code: number; message?: string }> {
  try {
    return { code: await p }
  } catch (e) {
    if (e instanceof CliError) return { code: e.exitCode, message: e.message }
    throw e
  }
}

const paused = summary('run_paused1', { status: 'paused', autoResume: true, pausedUntil: Date.now() + 60_000, pauseReason: 'Usage limit' })

describe('orgai resume --cancel-auto-resume', () => {
  it('keeps a paused run paused (operate scope), in text and json', async () => {
    const a = setup(paused)
    expect(await runResume(a.f.ctx, ['R1', '--cancel-auto-resume'])).toBe(0)
    expect(a.client.callsOf('runs:cancelAutoResume')).toEqual([['run_paused1']])
    expect(a.f.out()).toContain('R1 stays paused; it will not resume by itself. Resume it with: orgai resume R1 --now')
    expect(a.f.connectCalls[0].scopes).toEqual(['read', 'operate'])

    const b = setup({ ...paused, autoResume: false }, { format: 'json' })
    expect(await runResume(b.f.ctx, ['R1', '--cancel-auto-resume'])).toBe(0)
    expect(JSON.parse(b.f.out())).toMatchObject({ runId: 'run_paused1', tag: 'R1', autoResume: false, cancelled: false })
  })

  it('a run that is not paused is exit 1 with a hint to continue it', async () => {
    const { f, client } = setup(summary('run_done01', { status: 'finished' }))
    expect(await exitOf(runResume(f.ctx, ['R1', '--cancel-auto-resume']))).toEqual({
      code: EXIT.failure,
      message: 'Run is not paused. R1 is not paused any more (a pause lasts while the orgai that ran it is open). Continue it with: orgai resume R1'
    })
    expect(client.callsOf('runs:cancelAutoResume')).toEqual([])
  })

  it('usage: one run, no other flags, not together with --now', async () => {
    const ctx = () => setup(paused).f.ctx
    expect(await exitOf(runResume(ctx(), ['--cancel-auto-resume']))).toMatchObject({ code: EXIT.usage, message: 'Use: orgai resume <runId-or-R#> --cancel-auto-resume' })
    expect(await exitOf(runResume(ctx(), ['R1', '--cancel-auto-resume', '--exec']))).toMatchObject({ code: EXIT.usage, message: '--exec does not apply with --cancel-auto-resume.' })
    expect(await exitOf(runResume(ctx(), ['R1', '--cancel-auto-resume', '--prompt', 'x']))).toMatchObject({ code: EXIT.usage })
    expect(await exitOf(runResume(ctx(), ['R1', '--now', '--cancel-auto-resume']))).toMatchObject({ code: EXIT.usage, message: 'Use --now or --cancel-auto-resume, not both.' })
    expect(await exitOf(runResume(ctx(), ['R1', '--cancel-auto-resume', '--inline']))).toMatchObject({ code: EXIT.usage })
  })
})

describe('orgai resume --now', () => {
  it('needs a terminal (it follows the resumed run in the terminal UI)', async () => {
    const { f } = setup(paused)
    expect(await exitOf(runResume(f.ctx, ['R1', '--now']))).toMatchObject({ code: EXIT.usage, message: expect.stringContaining('needs a terminal') })
    expect(await exitOf(runResume(f.ctx, ['R1', '--now', '--max-budget', '1']))).toMatchObject({ code: EXIT.usage, message: '--max-budget does not apply with --now.' })
  })

  it('prepare resumes the run and follows the resumed one', async () => {
    const next = summary('run_next001', { status: 'starting', resumedFrom: 'run_paused1', startedAt: 2000 })
    const { f, client } = setup(paused, { answers: { 'runs:resumeNow': () => next } })
    const conn = await connectTuiHost(f.ctx)
    const launch = await prepareResumeNow(f.ctx, conn, 'R1')
    expect(client.callsOf('runs:resumeNow')).toEqual([['run_paused1']])
    expect(launch).toMatchObject({ runId: 'run_next001', project: { id: 'p1' } })
  })

  it("prints the host's refusal as written, with a hint when the run is not paused", async () => {
    const done = summary('run_done01', { status: 'finished' })
    const { f } = setup(done, {
      answers: {
        'runs:resumeNow': () => {
          throw rpcError({ code: 'internal', message: 'Run is not paused' } as never)
        }
      }
    })
    const conn = await connectTuiHost(f.ctx)
    await expect(prepareResumeNow(f.ctx, conn, 'R1')).rejects.toMatchObject({
      exitCode: EXIT.failure,
      message: 'Run is not paused. R1 is not paused any more (a pause lasts while the orgai that ran it is open). Continue it with: orgai resume R1'
    })
  })

  it('notPausedHint: nothing for a paused run, "still open" for a live one', () => {
    expect(notPausedHint({ status: 'paused' }, 'R2')).toBe('')
    expect(notPausedHint({ status: 'running' }, 'R2')).toBe(' R2 is not paused; it is still open.')
    expect(notPausedHint(undefined, 'R2')).toBe('')
  })
})
