import { describe, expect, it } from 'vitest'
import type { PendingCards } from '../../shared/types'
import { FakeHostClient, fakeContext, project, summary } from '../testing/fakeContext'
import { EXIT } from '../types'
import { NO_LIVE_DECISIONS, runInbox } from './inbox'

const p1 = project('p1', '/work/app', { name: 'App' })
const p2 = project('p2', '/work/other', { name: 'Other' })
const empty: PendingCards = { permissions: [], questions: [], proposals: [], ruleRequests: [], mergeReviews: [], mcpInstalls: [] }

function liveHost() {
  const r1 = summary('run_a', { projectId: 'p1', status: 'running', startedAt: 10 })
  const r2 = summary('run_b', { projectId: 'p2', status: 'idle', startedAt: 20 })
  const cards: Record<string, PendingCards> = {
    run_a: {
      ...empty,
      permissions: [{ id: 'perm1', runId: 'run_a', agentId: 'root', toolName: 'Bash', input: { command: 'npm test' }, summary: '' }],
      questions: [{ id: 'q1', runId: 'run_a', agentId: 'root', question: 'Which database?', options: [], allowMultiple: false, allowFreeText: true, createdAt: Date.now() - 120_000 }]
    },
    run_b: { ...empty, mergeReviews: [{ id: 'm1', runId: 'run_b', agentId: 'w', agentName: 'impl-1', branch: 'b', path: '/p', changedFiles: [], stat: '', patch: '', createdAt: 1 }] }
  }
  return new FakeHostClient({
    'projects:list': () => [p1, p2],
    'runs:listLive': () => [r1, r2],
    'runs:list': (p) => ((p as string[])[0] === 'p1' ? [r1] : [r2]),
    'runs:pendingCards': (p) => cards[(p as string[])[0]] ?? empty
  })
}

describe('orgai inbox', () => {
  it('lists the cwd project decisions with kind, ask, location, request id and age', async () => {
    const f = fakeContext({ cwd: '/work/app', connect: [liveHost()] })
    expect(await runInbox(f.ctx, [])).toBe(EXIT.ok)
    const out = f.out()
    expect(out).toContain('Question: Which database?')
    expect(out).toContain('App R1')
    expect(out).toContain('q1')
    expect(out).toContain('2m ago')
    expect(out).toContain('perm1')
    expect(out).not.toContain('impl-1')
    expect(out).toContain('orgai decide <requestId> <action>')
  })

  it('--all-projects and JSON', async () => {
    const f = fakeContext({ cwd: '/work/app', connect: [liveHost()], globals: { outputFormat: 'json' } })
    await runInbox(f.ctx, ['--all-projects'])
    const j = JSON.parse(f.out())
    expect(j.liveInboxAvailable).toBe(true)
    expect(j.items.map((i: { requestId: string }) => i.requestId)).toEqual(['q1', 'perm1', 'm1'])
    expect(j.items[2]).toMatchObject({ kind: 'merge', projectName: 'Other', runTag: 'R1', label: "Merge: review impl-1's changes" })
  })

  it('hostless or disabled: no live decisions, exit 0', async () => {
    const f = fakeContext({ store: { projects: [p1] } })
    expect(await runInbox(f.ctx, [])).toBe(EXIT.ok)
    expect(f.out()).toBe(`${NO_LIVE_DECISIONS}\n`)
    const g = fakeContext({ connect: [{ ok: false, reason: 'disabled', message: 'Terminal access is off.' }], globals: { outputFormat: 'json' } })
    expect(await runInbox(g.ctx, [])).toBe(EXIT.ok)
    expect(JSON.parse(g.out())).toMatchObject({ liveInboxAvailable: false, items: [] })
  })
})
