import { beforeEach, describe, expect, it } from 'vitest'
import { fakeContext, project, summary } from '../testing/fakeContext'
import { CliError, CLI_JSON_SCHEMA_VERSION, EXIT } from '../types'
import { runStatus } from './status'

const p1 = project('p1', '/work/app', { name: 'App' })

const owner = { hostInstanceId: 'aaaaaaaaaaaa', pid: 4242, endpoint: '/x', state: 'ready' as const, startedAt: Date.now() - 60_000, hostKind: 'inproc' as const, appVersion: '9.9', ownerCwd: '/work/other' }

describe('orgai status', () => {
  it('reads the files and never connects or starts a host', async () => {
    const f = fakeContext({ cwd: '/work/app', store: { projects: [p1], runs: [summary('r1', { endedBy: 'app', endedWithApp: true })] } })
    expect(await runStatus(f.ctx, [])).toBe(EXIT.ok)
    expect(f.err()).toBe('')
    expect(f.out()).toContain('Another orgai running: no')
    expect(f.out()).toContain('R1  Ended when OrgAI closed')
    expect(f.out()).not.toContain('Live runs')
    expect(f.connectCalls).toEqual([])
    expect(f.inprocCalls).toEqual([])
  })

  it('beside another orgai: says so, names its folder and pid, and prints the snapshot note', async () => {
    const f = fakeContext({ cwd: '/work/app', store: { projects: [p1], runs: [summary('r1')], hostState: 'ready', daemon: owner } })
    expect(await runStatus(f.ctx, [])).toBe(EXIT.ok)
    expect(f.err()).toBe('orgai is running in another terminal; this is a saved snapshot.\n')
    expect(f.out()).toContain('Another orgai running: yes (/work/other · orgai 9.9 · pid 4242')
    expect(f.connectCalls).toEqual([])
  })

  it('notes a managed worktree', async () => {
    const f = fakeContext({
      store: { projects: [p1] },
      resolveProject: () => ({ project: p1, via: 'cwd', managedWorktree: { mainCheckout: '/work/app' } })
    })
    await runStatus(f.ctx, [])
    expect(f.out()).toContain('Inside an agent worktree; its project is /work/app')
  })

  it('JSON shape, alone and beside another orgai', async () => {
    const off = fakeContext({ cwd: '/work/app', globals: { outputFormat: 'json' }, store: { projects: [p1], runs: [summary('r1')] } })
    await runStatus(off.ctx, [])
    const k = JSON.parse(off.out())
    expect(k.schemaVersion).toBe(CLI_JSON_SCHEMA_VERSION)
    expect(k).toMatchObject({ hostState: 'stopped', liveInboxAvailable: false })
    expect(k.project).toMatchObject({ id: 'p1', name: 'App', kind: 'code', path: '/work/app' })
    expect(k.latestRuns[0]).toMatchObject({ projectId: 'p1', tag: 'R1' })
    expect(off.err()).toBe('')

    const beside = fakeContext({ cwd: '/work/app', globals: { outputFormat: 'json' }, store: { projects: [p1], runs: [summary('r1')], hostState: 'ready', daemon: owner } })
    await runStatus(beside.ctx, [])
    const o = JSON.parse(beside.out())
    expect(o).toMatchObject({ hostState: 'ready', host: { pid: 4242, ownerCwd: '/work/other' } })
  })

  it('a bad --project is exit 2', async () => {
    const f = fakeContext({ globals: { project: 'nope' }, store: { projects: [p1] } })
    await expect(runStatus(f.ctx, [])).rejects.toMatchObject({ exitCode: EXIT.usage })
    await expect(runStatus(f.ctx, ['extra'])).rejects.toBeInstanceOf(CliError)
  })
})
