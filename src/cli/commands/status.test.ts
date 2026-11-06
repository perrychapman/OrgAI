import { beforeEach, describe, expect, it } from 'vitest'
import { resetSkewWarning } from '../runRef'
import { FakeHostClient, fakeContext, hostStatus, project, summary } from '../testing/fakeContext'
import { CliError, CLI_JSON_SCHEMA_VERSION, EXIT } from '../types'
import { runStatus } from './status'

const p1 = project('p1', '/work/app', { name: 'App' })

function liveHost(extra: Record<string, (p: unknown) => unknown> = {}) {
  return new FakeHostClient(
    {
      'host.status': () => hostStatus({ activity: { ...hostStatus().activity, counts: { ...hostStatus().activity.counts, liveRuns: 1 }, total: 1, idle: false } }),
      'projects:list': () => [p1],
      'runs:list': () => [summary('r1', { startedAt: 100 }), summary('r2', { startedAt: 200, status: 'running', title: 'Fix tests' })],
      'runs:listLive': () => [summary('r2', { startedAt: 200, status: 'running', title: 'Fix tests' })],
      'runs:pendingCards': () => ({
        permissions: [{ id: 'req1', runId: 'r2', agentId: 'root', toolName: 'Bash', input: { command: 'npm test' }, summary: '' }],
        questions: [],
        proposals: [],
        ruleRequests: [],
        mergeReviews: [],
        mcpInstalls: []
      }),
      ...extra
    },
    { hello: { versionSkewWarning: 'OrgAI 9.9 is running; this CLI is 0.0.0-test.' } }
  )
}

beforeEach(() => resetSkewWarning())

describe('orgai status', () => {
  it('live host: host block, project, live runs and the Needs you count', async () => {
    const f = fakeContext({ cwd: '/work/app/src', connect: [liveHost()] })
    expect(await runStatus(f.ctx, [])).toBe(EXIT.ok)
    const out = f.out()
    expect(out).toContain('Host: ready (app)')
    expect(out).toContain('Activity: 1 live run')
    expect(out).toContain('Project: App')
    expect(out).toMatch(/R2 {2}Needs you {2}Fix tests · 2 decisions|R2 {2}Needs you {2}Fix tests · 1 decision/)
    expect(out).toContain('Needs you: 1 decision')
    expect(f.err()).toContain('OrgAI 9.9 is running')
    expect(f.err()).not.toContain('showing saved data')
  })

  it('hostless: the saved data with a stderr note', async () => {
    const f = fakeContext({ cwd: '/work/app', store: { projects: [p1], runs: [summary('r1', { endedBy: 'app', endedWithApp: true })] } })
    expect(await runStatus(f.ctx, [])).toBe(EXIT.ok)
    expect(f.err()).toBe('No OrgAI host is running; showing saved data.\n')
    expect(f.out()).toContain('Host: not running')
    expect(f.out()).toContain('R1  Ended when OrgAI closed')
    expect(f.out()).not.toContain('Live runs')
  })

  it('starting and disabled hosts use their own notes', async () => {
    const a = fakeContext({ connect: [{ ok: false, reason: 'starting', message: 'starting' }], store: { hostState: 'starting' } })
    await runStatus(a.ctx, [])
    expect(a.err()).toBe('OrgAI is starting; showing saved data.\n')
    const b = fakeContext({ connect: [{ ok: false, reason: 'disabled', message: 'Terminal access is off. Turn it on in OrgAI > App settings.' }], store: { hostState: 'ready' } })
    await runStatus(b.ctx, [])
    expect(b.err()).toBe('Terminal access is off. Turn it on in OrgAI > App settings.\n')
  })

  it('notes a managed worktree', async () => {
    const f = fakeContext({
      store: { projects: [p1] },
      resolveProject: () => ({ project: p1, via: 'cwd', managedWorktree: { mainCheckout: '/work/app' } })
    })
    await runStatus(f.ctx, [])
    expect(f.out()).toContain('Inside an agent worktree; its project is /work/app')
  })

  it('JSON shape, live and hostless', async () => {
    const live = fakeContext({ cwd: '/work/app', globals: { outputFormat: 'json' }, connect: [liveHost()] })
    await runStatus(live.ctx, [])
    const j = JSON.parse(live.out())
    expect(j.schemaVersion).toBe(CLI_JSON_SCHEMA_VERSION)
    expect(j.hostState).toBe('ready')
    expect(j.liveInboxAvailable).toBe(true)
    expect(j.host.hostKind).toBe('desktop')
    expect(j.project).toMatchObject({ id: 'p1', name: 'App', kind: 'code', path: '/work/app' })
    expect(j.needsYou).toBe(1)
    expect(j.liveRuns[0]).toMatchObject({ id: 'r2', tag: 'R2', needsYou: 1 })
    expect(j.latestRuns[0]).toMatchObject({ projectId: 'p1', tag: 'R2' })

    const off = fakeContext({ cwd: '/work/app', globals: { outputFormat: 'json' }, store: { projects: [p1], runs: [summary('r1')] } })
    await runStatus(off.ctx, [])
    const k = JSON.parse(off.out())
    expect(k).toMatchObject({ hostState: 'stopped', liveInboxAvailable: false, needsYou: null, liveRuns: [] })
    expect(k.hostUnavailable.reason).toBe('no_host')
    expect(off.err()).toBe('')
  })

  it('a bad --project is exit 2', async () => {
    const f = fakeContext({ globals: { project: 'nope' }, store: { projects: [p1] } })
    await expect(runStatus(f.ctx, [])).rejects.toMatchObject({ exitCode: EXIT.usage })
    await expect(runStatus(f.ctx, ['extra'])).rejects.toBeInstanceOf(CliError)
  })
})
