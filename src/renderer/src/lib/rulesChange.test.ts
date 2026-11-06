import { describe, expect, it } from 'vitest'
import type { RunEvent } from '@shared/types'
import { rulesChangedProject } from './rulesChange'

const of = (id: string): string | undefined => (id === 'r1' ? 'p1' : undefined)
const resolved = (over: Record<string, unknown>): RunEvent => ({ type: 'rules.resolved', runId: 'r1', requestId: 'q', decision: { behavior: 'grant', scope: 'project' }, ...over }) as unknown as RunEvent

describe('rulesChangedProject', () => {
  it('bumps for a project-scope grant', () => {
    expect(rulesChangedProject(resolved({}), of)).toBe('p1')
  })
  it('ignores run scope, deny, cancelled and unknown runs', () => {
    expect(rulesChangedProject(resolved({ decision: { behavior: 'grant', scope: 'run' } }), of)).toBeNull()
    expect(rulesChangedProject(resolved({ decision: { behavior: 'deny', scope: 'project' } }), of)).toBeNull()
    expect(rulesChangedProject(resolved({ cancelled: true }), of)).toBeNull()
    expect(rulesChangedProject(resolved({ runId: 'nope' }), of)).toBeNull()
  })
  it('bumps for permission.resolved with savedToProject only', () => {
    const perm = (over: Record<string, unknown>): RunEvent => ({ type: 'permission.resolved', runId: 'r1', requestId: 'q', ...over }) as unknown as RunEvent
    expect(rulesChangedProject(perm({ savedToProject: true }), of)).toBe('p1')
    expect(rulesChangedProject(perm({}), of)).toBeNull()
    expect(rulesChangedProject(perm({ savedToProject: true, cancelled: true }), of)).toBeNull()
    expect(rulesChangedProject(perm({ savedToProject: true, runId: 'nope' }), of)).toBeNull()
  })
  it('bumps for project.updated', () => {
    expect(rulesChangedProject({ type: 'project.updated', project: { id: 'p2' } } as unknown as RunEvent, of)).toBe('p2')
  })
  it('ignores other events', () => {
    expect(rulesChangedProject({ type: 'run.cost', runId: 'r1', totalCostUsd: 1 } as unknown as RunEvent, of)).toBeNull()
  })
})
