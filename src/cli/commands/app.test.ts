import { describe, expect, it } from 'vitest'
import { fakeContext, project, summary } from '../testing/fakeContext'
import { EXIT } from '../types'
import { runApp } from './app'

const ready = { hostInstanceId: 'aaaaaaaaaaaa', pid: 1, endpoint: '/x', state: 'ready' as const, startedAt: 1, hostKind: 'desktop' as const }

describe('orgai app', () => {
  it('spawns a desktop window and waits for a ready host', async () => {
    const f = fakeContext({ launcher: { waitForReady: async () => ready } })
    expect(await runApp(f.ctx, [])).toBe(EXIT.ok)
    expect(f.launcherCalls).toEqual([
      { method: 'resolve', args: undefined },
      { method: 'spawn', args: { headless: false } },
      { method: 'waitForReady', args: { timeoutMs: 10_000 } }
    ])
  })

  it('--run resolves R# and passes the run id', async () => {
    const p1 = project('p1', '/work/app')
    const f = fakeContext({ cwd: '/work/app', store: { projects: [p1], runs: [summary('run_first1', { startedAt: 1 }), summary('run_secnd2', { startedAt: 2 })] }, launcher: { waitForReady: async () => ready } })
    expect(await runApp(f.ctx, ['--run', 'R2'])).toBe(EXIT.ok)
    expect(f.launcherCalls[1]).toEqual({ method: 'spawn', args: { headless: false, run: 'run_secnd2' } })
    expect(f.err()).toBe('')
  })

  it('a launcher error or a timeout is exit 1', async () => {
    const f = fakeContext({ launcher: { resolve: () => ({ error: 'OrgAI app not found.' }) } })
    await expect(runApp(f.ctx, [])).rejects.toMatchObject({ exitCode: EXIT.failure, message: 'OrgAI app not found.' })
    expect(f.launcherCalls.map((c) => c.method)).toEqual(['resolve'])
    const g = fakeContext()
    await expect(runApp(g.ctx, [])).rejects.toMatchObject({ exitCode: EXIT.failure })
  })
})
