import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunRosterChange, RunRosterRole } from '@shared/types'

vi.stubGlobal('window', {
  orgai: {},
  dispatchEvent: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  location: { hash: '' }
})
vi.stubGlobal('Event', class {})

const { useAppStore } = await import('./useAppStore')

const live = {
  summary: { id: 'r1', projectId: 'p1', kind: 'work', prompt: 'go', status: 'running', startedAt: 1, totalCostUsd: 0 },
  agents: {},
  transcript: [],
  permissions: [],
  proposals: [],
  questions: [],
  ruleRequests: [],
  mergeReviews: [],
  logs: [],
  partial: {},
  messages: [],
  mcpInstalls: [],
  mcpResolved: {}
}

const role = (id: string, extra: Partial<RunRosterRole> = {}): RunRosterRole => ({ id, slug: id, name: id, color: '#123456', reportsTo: null, ...extra })
const change: RunRosterChange = { added: ['b'], changed: [], removed: [], deferred: [] }

describe('store: run roster', () => {
  beforeEach(() => {
    useAppStore.setState({ runs: { r1: structuredClone(live) } as never, historyByProject: {}, unreadByRun: {}, proposalNextByRun: {} })
  })

  it('replaces the run roster with each run.roster event and touches nothing else', () => {
    const first = [role('a'), role('b', { added: true })]
    useAppStore.getState().handleEvent({ type: 'run.roster', runId: 'r1', roster: first, change })
    expect(useAppStore.getState().runs.r1.roster).toEqual(first)
    const second = [role('a'), role('b', { removed: true })]
    useAppStore.getState().handleEvent({ type: 'run.roster', runId: 'r1', roster: second, change: { ...change, added: [], removed: ['b'] } })
    const run = useAppStore.getState().runs.r1
    expect(run.roster).toEqual(second)
    expect({ ...run, roster: undefined }).toEqual({ ...live, roster: undefined })
  })

  it('notes what an approved org chart took live, with the deferred roles and their reasons', () => {
    const proposal = { id: 'p1', kind: 'orgChart', title: 't', effect: 'now', payload: { roles: [], rationale: '' } }
    useAppStore.setState({ runs: { r1: { ...structuredClone(live), proposals: [proposal] } } as never })
    useAppStore.getState().handleEvent({
      type: 'proposal.resolved',
      runId: 'r1',
      proposalId: 'p1',
      decision: { behavior: 'approve', roster: { added: ['b'], changed: [], removed: [], deferred: [{ id: 'c', name: 'Far', reason: 'Runs on another provider.' }] } }
    } as never)
    expect(useAppStore.getState().proposalNextByRun.r1).toEqual({
      kind: 'orgRoster',
      projectId: 'p1',
      roster: { applied: true, when: 'now', deferred: [{ name: 'Far', reason: 'Runs on another provider.' }] }
    })
  })
})
