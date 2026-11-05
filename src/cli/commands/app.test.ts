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
      { method: 'waitForReady', args: { timeoutMs: 10_000, hostKinds: ['desktop', 'headless-host'] } }
    ])
  })

  it('refuses (exit 6) when a --host inproc host owns the data folder, without spawning (review M)', async () => {
    const inproc = { ...ready, hostKind: 'inproc' as const, pid: 55 }
    const f = fakeContext({ launcher: { current: () => inproc, waitForReady: async () => inproc } })
    await expect(runApp(f.ctx, [])).rejects.toMatchObject({ exitCode: EXIT.hostBusy, message: expect.stringContaining('--host inproc (pid 55)') })
    expect(f.launcherCalls).toEqual([])
    // One that took the folder while the app was starting: the timeout names it.
    let owner: typeof inproc | null = null
    const g = fakeContext({ launcher: { current: () => owner, waitForReady: async () => ((owner = inproc), null) } })
    await expect(runApp(g.ctx, [])).rejects.toMatchObject({ exitCode: EXIT.hostBusy })
  })

  it('a spawned app that cannot start is exit 1 with its reason (review M)', async () => {
    const f = fakeContext({ launcher: { waitForReady: async () => Promise.reject(new Error('spawn /nope ENOENT')) } })
    await expect(runApp(f.ctx, [])).rejects.toMatchObject({ exitCode: EXIT.failure, message: 'Could not start OrgAI: spawn /nope ENOENT' })
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
