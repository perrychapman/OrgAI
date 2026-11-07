import { describe, expect, it } from 'vitest'
import { record, summary } from '../testing/fakeContext'
import { applyEvent, applyRecord, applySnapshot, createInitialState, setActiveRun } from './state'
import { teamMessageRows, withTeamMilestones } from './collaboration'

const rec = record(summary('run', { status: 'running' }))
const base = () => setActiveRun(applyRecord({ ...createInitialState('/work'), hostInstanceId: 'host-a' }, rec), 'run')
const event = { type: 'agent.message' as const, runId: 'run', from: 'root', to: null, toHandle: 'reviewer', text: '\x1b[31mReady\x1b[0m\nfor review', at: 100 }

describe('collaboration views', () => {
  it('sanitizes previews, bounds them, and does not duplicate replayed messages', () => {
    let state = applyEvent(base(), { seq: 1, event })
    state = applyEvent(state, { seq: 1, event })
    const rows = teamMessageRows(state)
    expect(rows).toHaveLength(1)
    expect(rows[0].toLabel).toBe('reviewer')
    expect(rows[0].text).not.toMatch(/[\x1b\n]/)
    state = applyEvent(state, { seq: 2, event: { ...event, at: 101, text: 'x'.repeat(400) } })
    expect(teamMessageRows(state).at(-1)?.text).toHaveLength(200)
  })

  it('keeps previews during same-session record refresh and clears them for a new host', () => {
    const state = applyEvent(base(), { seq: 1, event })
    expect(teamMessageRows(applyRecord(state, rec))).toHaveLength(1)
    const refreshed = applySnapshot(state, {
      mode: 'snapshot', hostInstanceId: 'host-b', seq: 1, filterKey: 'all',
      snapshot: { liveRuns: [rec.summary], recentEndedRuns: [], pendingCards: {}, activeRun: rec }
    })
    expect(teamMessageRows(refreshed)).toEqual([])
    expect(teamMessageRows(base())).toEqual([])
  })

  it('uses recorded timestamps for sparse join and completion milestones', () => {
    const state = base()
    state.runs.run = { ...state.runs.run, agents: {
      ...state.runs.run.agents,
      reviewer: { ...rec.agents.root, id: 'reviewer', name: 'Reviewer', parentId: 'root', state: 'done', startedAt: 10, endedAt: 30 }
    } }
    const rows = withTeamMilestones(state, [{ key: 'answer', runId: 'run', kind: 'text', text: 'Reviewing', at: 20 }])
    expect(rows.map(r => r.at)).toEqual([10, 20, 30])
    expect(rows[0].text).toContain('joined')
    expect(rows[2].text).toContain('finished')
    expect(withTeamMilestones(state, [{ key: 'answer', runId: 'run', kind: 'text', text: 'Reviewing', at: 20 }])).toEqual(rows)
  })
})
