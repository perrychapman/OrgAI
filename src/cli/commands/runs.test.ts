import { describe, expect, it } from 'vitest'
import type { RunRecord, TranscriptEntry } from '../../shared/types'
import { fakeContext, project, record, summary } from '../testing/fakeContext'
import { EXIT } from '../types'
import { runRuns } from './runs'

const p1 = project('p1', '/work/app', { name: 'App' })
const usageUnknown = { costUsd: null, costSource: 'unknown' } as never

const runs = [
  summary('run_one111', { startedAt: 1000, title: 'Oldest', endedBy: 'user' }),
  summary('run_two222', { startedAt: 2000, title: 'Cut by quit', endedBy: 'app', endedWithApp: true }),
  summary('run_three3', { startedAt: 3000, title: 'Unpriced', usage: usageUnknown }),
  summary('run_four44', { startedAt: 4000, title: 'Broken', status: 'error', error: 'boom' }),
  summary('run_five55', { startedAt: 5000, title: 'Continued', resumedFrom: 'run_four44', sessionId: 's1', totalCostUsd: 0.42 })
]
runs[3].sessionId = 's1'

const entry = (id: string, block: TranscriptEntry['block'], agentId = 'root', source?: 'harness'): TranscriptEntry => ({ id, agentId, at: 1, block, ...(source ? { source } : {}) })

describe('orgai runs list', () => {
  it('lists newest first with status words from statusText and unknown cost never $0', async () => {
    const f = fakeContext({ cwd: '/work/app', store: { projects: [p1], runs } })
    expect(await runRuns(f.ctx, ['list'])).toBe(EXIT.ok)
    const lines = f.out().trimEnd().split('\n')
    expect(lines[0]).toMatch(/^RUN\s+STATUS\s+NAME\s+KIND\s+STARTED\s+COST$/)
    expect(lines.slice(1).map((l) => l.slice(0, 3).trim())).toEqual(['R5', 'R4', 'R3', 'R2', 'R1'])
    expect(lines[1]).toContain('Finished')
    expect(lines[1]).toMatch(/\$0\.42$/)
    expect(lines[2]).toContain('Failed')
    expect(lines[3]).toMatch(/unknown$/)
    expect(lines[3]).not.toContain('$0')
    expect(lines[4]).toContain('Ended when OrgAI closed')
    expect(lines[5]).toContain('Stopped')
    expect(f.err()).toBe('')
  })

  it('--limit and --status', async () => {
    const f = fakeContext({ cwd: '/work/app', store: { projects: [p1], runs } })
    await runRuns(f.ctx, ['list', '--limit', '2'])
    expect(f.out().trimEnd().split('\n')).toHaveLength(4)
    expect(f.out()).toContain('3 more')
    const g = fakeContext({ cwd: '/work/app', store: { projects: [p1], runs } })
    await runRuns(g.ctx, ['list', '--status', 'stopped'])
    const body = g.out().trimEnd().split('\n').slice(1)
    expect(body).toHaveLength(2)
    await expect(runRuns(g.ctx, ['list', '--status', 'sleeping'])).rejects.toMatchObject({ exitCode: EXIT.usage })
    await expect(runRuns(g.ctx, ['list', '--limit', 'x'])).rejects.toMatchObject({ exitCode: EXIT.usage })
  })

  it('needs a project unless --all-projects', async () => {
    const f = fakeContext({ cwd: '/elsewhere', store: { projects: [p1], runs } })
    await expect(runRuns(f.ctx, ['list'])).rejects.toMatchObject({ exitCode: EXIT.usage })
    await runRuns(f.ctx, ['list', '--all-projects'])
    expect(f.out()).toMatch(/^PROJECT\s+RUN/)
  })

  it('beside another orgai it is a saved snapshot: a note, no connect, no host', async () => {
    const json = fakeContext({ cwd: '/work/app', globals: { outputFormat: 'json' }, store: { projects: [p1], runs, hostState: 'ready' } })
    await runRuns(json.ctx, ['list'])
    const j = JSON.parse(json.out())
    expect(j.hostState).toBe('ready')
    expect(j.liveInboxAvailable).toBe(false)
    const f = fakeContext({ cwd: '/work/app', store: { projects: [p1], runs, hostState: 'ready' } })
    await runRuns(f.ctx, ['list'])
    expect(f.err()).toBe('orgai is running in another terminal; this is a saved snapshot.\n')
    expect(f.connectCalls).toEqual([])
    expect(f.inprocCalls).toEqual([])
  })
})

describe('orgai runs show', () => {
  const big = 'A'.repeat(4000)
  const rec: RunRecord = record(runs[4], {
    transcript: [
      entry('e1', { kind: 'user', text: 'Look at this', images: [{ mediaType: 'image/png', data: big }] }),
      entry('e2', { kind: 'text', text: 'On it.' }),
      entry('e3', { kind: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }),
      entry('e4', { kind: 'tool_result', toolUseId: 't1', content: 'ok', isError: false }),
      entry('e5', { kind: 'system', text: 'Continued by the harness' }, 'root', 'harness'),
      entry('e6', { kind: 'text', text: 'Done \x1b]52;c;ZXZpbA==\x07 now' })
    ],
    plan: { goal: 'Fix it', steps: [{ id: 'p1', title: 'Find bug', status: 'done' }, { id: 'p2', title: 'Patch', status: 'in_progress' }], status: 'active', autoContinues: 0, updatedAt: 1 }
  })
  rec.agents.w1 = { ...rec.agents.root, id: 'w1', name: 'Implementer', handle: 'impl-1', parentId: 'root', roleSlug: 'impl', startedAt: 2 }

  it('shows summary, chain position, plan, agents and images as labels', async () => {
    const f = fakeContext({ cwd: '/work/app', store: { projects: [p1], runs, records: { run_five55: rec } } })
    expect(await runRuns(f.ctx, ['show', 'R5'])).toBe(EXIT.ok)
    const out = f.out()
    expect(out).toContain('R5  Finished  Continued')
    expect(out).toContain('Chain: session 2 of 2 (continues R4)')
    expect(out).toContain('[x] Find bug')
    expect(out).toContain('[>] Patch')
    expect(out).toContain('Orchestrator')
    expect(out).toContain('└ impl-1 (Implementer)')
    expect(out).toContain('You: Look at this [image image/png 3000 bytes]')
    expect(out).not.toContain(big)
    expect(out).toContain('Orchestrator → Ran')
    expect(out).toContain('· Continued by the harness')
    expect(out).toContain('Cost: $0.42')
  })

  it('--tail limits the rows; --transcript shows all', async () => {
    const f = fakeContext({ cwd: '/work/app', store: { projects: [p1], runs, records: { run_five55: rec } } })
    await runRuns(f.ctx, ['show', 'run_five55', '--tail', '2'])
    expect(f.out()).toContain('Transcript (last 2 of 5')
    expect(f.out()).not.toContain('Look at this')
    const g = fakeContext({ cwd: '/work/app', store: { projects: [p1], runs, records: { run_five55: rec } } })
    await runRuns(g.ctx, ['show', 'run_fiv', '--transcript'])
    expect(g.out()).toContain('Transcript:')
    expect(g.out()).toContain('Look at this')
  })

  it('JSON omits image bytes', async () => {
    const f = fakeContext({ cwd: '/work/app', globals: { outputFormat: 'json' }, store: { projects: [p1], runs, records: { run_five55: rec } } })
    await runRuns(f.ctx, ['show', 'R5', '--transcript'])
    const j = JSON.parse(f.out())
    expect(j.status).toBe('Finished')
    expect(j.chain).toMatchObject({ index: 2, count: 2 })
    expect(f.out()).not.toContain(big)
    expect(j.record.transcript[0].block.images[0]).toEqual({ mediaType: 'image/png', byteLength: 3000, omittedBase64: true })
  })

  it('unknown refs are exit 2', async () => {
    const f = fakeContext({ cwd: '/work/app', store: { projects: [p1], runs } })
    await expect(runRuns(f.ctx, ['show', 'R42'])).rejects.toMatchObject({ exitCode: EXIT.usage })
    await expect(runRuns(f.ctx, ['show'])).rejects.toMatchObject({ exitCode: EXIT.usage })
    await expect(runRuns(f.ctx, ['nope'])).rejects.toMatchObject({ exitCode: EXIT.usage })
  })
})

describe('orgai runs: removed live actions', () => {
  it('send, interrupt and stop are unknown now: live runs belong to the owning orgai', async () => {
    const f = fakeContext({ cwd: '/work/app', store: { projects: [p1], runs } })
    for (const argv of [['send', 'R1', 'x'], ['interrupt', 'R1'], ['stop', 'R1']]) {
      await expect(runRuns(f.ctx, argv)).rejects.toMatchObject({ exitCode: EXIT.usage })
    }
    expect(f.connectCalls).toEqual([])
    expect(f.inprocCalls).toEqual([])
  })
})
