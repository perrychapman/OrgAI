import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunPlan, RunStaffing } from '@shared/types'

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

describe('store: run staffing', () => {
  beforeEach(() => {
    useAppStore.setState({ runs: { r1: structuredClone(live) } as never, historyByProject: {}, unreadByRun: {} })
  })

  it('stores the latest staffing.updated on the run like plan.updated, and nothing else changes', () => {
    const staffing: RunStaffing = { goal: 'cost', assignments: [{ roleId: 'r-eng', model: 'haiku', tier: 'fast', effort: 'low', source: 'role', at: 1 }] }
    useAppStore.getState().handleEvent({ type: 'staffing.updated', runId: 'r1', staffing })
    const run = useAppStore.getState().runs.r1
    expect(run.staffing).toEqual(staffing)
    expect({ ...run, staffing: undefined }).toEqual({ ...live, staffing: undefined })
    const next: RunStaffing = { goal: 'speed', assignments: [] }
    useAppStore.getState().handleEvent({ type: 'staffing.updated', runId: 'r1', staffing: next })
    expect(useAppStore.getState().runs.r1.staffing).toEqual(next)
    const plan: RunPlan = { goal: 'g', steps: [{ id: 'p1', title: 'One', status: 'pending', after: [] }], status: 'active', autoContinues: 0, updatedAt: 1 }
    useAppStore.getState().handleEvent({ type: 'plan.updated', runId: 'r1', plan })
    expect(useAppStore.getState().runs.r1.plan).toEqual(plan)
    expect(useAppStore.getState().runs.r1.staffing).toEqual(next)
  })
})
