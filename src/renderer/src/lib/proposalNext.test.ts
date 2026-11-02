import { describe, expect, it } from 'vitest'
import type { Proposal } from '@shared/types'
import { PROPOSAL_NEXT_COPY, proposalNextFor, proposalNextLead, secretsNextFor } from './proposalNext'

const skills = (scopes: ('library' | 'project')[]): Proposal =>
  ({ id: 'p', kind: 'skills', title: 't', payload: { items: scopes.map((scope) => ({ scope, draft: { name: 'x' } })) } }) as unknown as Proposal
const mcp = (scope?: 'library'): Proposal => ({ id: 'p', kind: 'mcpServers', title: 't', payload: { servers: [], ...(scope ? { scope } : {}) } }) as unknown as Proposal

describe('proposalNextFor', () => {
  it('points library skills at the Skill library and any project skill at the project', () => {
    expect(proposalNextFor(skills(['library']), 'a')?.kind).toBe('skillsLibrary')
    expect(proposalNextFor(skills(['library', 'project']), 'a')?.kind).toBe('skillsProject')
  })
  it('points MCP proposals at Connectors or the project by scope', () => {
    expect(proposalNextFor(mcp('library'), 'harness')?.kind).toBe('connectors')
    expect(proposalNextFor(mcp(), 'a')?.kind).toBe('mcpProject')
  })
  it('has no link for other kinds', () => {
    expect(proposalNextFor({ id: 'p', kind: 'settings', title: 't', payload: {} } as unknown as Proposal, 'a')).toBeNull()
  })
  it('treats an empty skills proposal as project scope and carries the project id', () => {
    expect(proposalNextFor(skills([]), 'p1')).toEqual({ kind: 'skillsProject', projectId: 'p1' })
  })
  it('has copy with a test id for every kind', () => {
    for (const k of ['skillsLibrary', 'skillsProject', 'connectors', 'mcpProject'] as const) expect(PROPOSAL_NEXT_COPY[k].testId).toMatch(/^proposal-next-/)
  })
})

describe('secretsNextFor', () => {
  it('names the servers waiting on a secret for a project proposal', () => {
    expect(secretsNextFor(mcp(), { behavior: 'approve', waitingForSecrets: ['gh'] }, 'p1')).toEqual({ kind: 'mcpSecrets', projectId: 'p1', names: ['gh'] })
  })
  it('has nothing for no waiting names, a decline, a library proposal or a skills proposal', () => {
    expect(secretsNextFor(mcp(), { behavior: 'approve' }, 'p1')).toBeNull()
    expect(secretsNextFor(mcp(), { behavior: 'approve', waitingForSecrets: [] }, 'p1')).toBeNull()
    expect(secretsNextFor(mcp(), { behavior: 'decline' }, 'p1')).toBeNull()
    expect(secretsNextFor(mcp('library'), { behavior: 'approve', waitingForSecrets: ['gh'] }, 'p1')).toBeNull()
    expect(secretsNextFor(skills(['project']), { behavior: 'approve', waitingForSecrets: ['gh'] }, 'p1')).toBeNull()
  })
})

describe('proposalNextLead', () => {
  it('uses the fixed copy for the other kinds and a clamped, pluralised sentence for secrets', () => {
    expect(proposalNextLead({ kind: 'connectors', projectId: 'a' })).toBe(PROPOSAL_NEXT_COPY.connectors.lead)
    expect(proposalNextLead({ kind: 'mcpSecrets', projectId: 'a', names: ['gh'] })).toBe('gh needs a secret before it can start.')
    expect(proposalNextLead({ kind: 'mcpSecrets', projectId: 'a', names: ['a', 'b', 'c', 'd', 'e'] })).toBe('a, b, c and 2 more need a secret before they can start.')
    expect(proposalNextLead({ kind: 'mcpSecrets', projectId: 'a', names: ['x'.repeat(100)] })).toContain('x'.repeat(39) + '…')
  })
})
