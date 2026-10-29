import { vi } from 'vitest'
import type { Project, Role, RunEvent, RunPlan, RunSummary } from '@shared/types'
import type { RuntimeContext } from './types'

/** Test-only fixtures for the runtime modules. Not imported by app code. */

export function role(over: Partial<Role> & { id: string; slug: string }): Role {
  return {
    name: over.slug,
    description: `${over.slug} description`,
    responsibilities: [],
    prompt: `You are ${over.slug}.`,
    tools: ['Read'],
    model: 'sonnet',
    canSpawn: false,
    spawnable: [],
    reportsTo: null,
    position: { x: 0, y: 0 },
    color: '#fff',
    ...over
  }
}

/** Lead (root) -> engineer (writes) + reviewer (read-only). */
export function orgChart(): Role[] {
  return [
    role({ id: 'r-lead', slug: 'lead', name: 'Lead', canSpawn: true, spawnable: ['r-eng', 'r-rev'] }),
    role({ id: 'r-eng', slug: 'engineer', name: 'Engineer', tools: ['Read', 'Edit', 'Write'], reportsTo: 'r-lead' }),
    role({ id: 'r-rev', slug: 'reviewer', name: 'Reviewer', tools: ['Read', 'Grep'], reportsTo: 'r-lead' })
  ]
}

export function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Test project',
    path: '/repo',
    brief: '',
    provider: { id: 'mock', label: 'Mock', auth: { kind: 'subscription' } },
    permissionMode: 'default',
    maxSubagentDepth: 2,
    maxConcurrentSubagents: 3,
    roles: orgChart(),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over
  }
}

export function runSummary(over: Partial<RunSummary> = {}): RunSummary {
  return { id: 'run-1', projectId: 'p1', kind: 'work', prompt: 'Do it', status: 'starting', startedAt: 0, totalCostUsd: 0, ...over }
}

/** A RuntimeContext whose round-trips are vi.fn()s; events land in `events`. */
export function fakeCtx(over: Partial<RuntimeContext> = {}): RuntimeContext & { events: RunEvent[] } {
  const events: RunEvent[] = []
  const p = over.project ?? project()
  let plan: RunPlan | undefined
  return {
    run: runSummary(),
    project: p,
    roles: p.roles,
    prompt: 'Do it',
    emit: (e) => events.push(e),
    requestPermission: vi.fn(async () => ({ behavior: 'allow' as const })),
    requestProposal: vi.fn(async () => ({ behavior: 'approve' as const })),
    requestMergeReview: vi.fn(async () => ({ behavior: 'merge' as const })),
    completeSetup: vi.fn(async () => {}),
    requestQuestion: vi.fn(async () => ({ selected: [] })),
    noteArchitectureUpdated: vi.fn(async () => {}),
    rateLimited: vi.fn(),
    getPlan: () => plan,
    updatePlan: vi.fn(async (next: RunPlan) => {
      plan = next
    }),
    pendingInteractions: () => 0,
    ...over,
    events
  }
}
