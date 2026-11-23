import { describe, expect, it } from 'vitest'
import type { Proposal } from '@shared/types'
import { PROPOSAL_NEXT_COPY, orgChartEffectCopy, proposalNextAnnouncement, proposalNextFor, proposalNextLead, rosterNextFor, secretsNextFor } from './proposalNext'

const skills = (scopes: ('library' | 'project')[]): Proposal =>
  ({ id: 'p', kind: 'skills', title: 't', payload: { items: scopes.map((scope) => ({ scope, draft: { name: 'x' } })) } }) as unknown as Proposal
const mcp = (scope?: 'library'): Proposal => ({ id: 'p', kind: 'mcpServers', title: 't', payload: { servers: [], ...(scope ? { scope } : {}) } }) as unknown as Proposal

describe('org chart roster notes', () => {
  const org = (effect?: Proposal['effect']): Proposal => ({ id: 'p', kind: 'orgChart', title: 't', ...(effect ? { effect } : {}), payload: { roles: [], rationale: '' } }) as unknown as Proposal
  const roster = (over: object = {}): { behavior: 'approve'; roster: never } => ({ behavior: 'approve', roster: { added: ['a'], changed: [], removed: [], deferred: [], ...over } as never })
  it('says when the run can use the new roles, per effect', () => {
    expect(orgChartEffectCopy('now')).toContain('can use the new roles now')
    expect(orgChartEffectCopy('after-turn')).toContain('once no agent is working and the session restarts')
    expect(orgChartEffectCopy('after-turn')).toContain('Removed roles stop being available immediately')
    expect(orgChartEffectCopy('now')).toContain('Removed roles stop being available immediately')
    expect(orgChartEffectCopy('next-run')).toBeNull()
    expect(orgChartEffectCopy(undefined)).toBeNull()
  })
  it('has no note when nothing reached the run, or for another kind', () => {
    expect(rosterNextFor(org('now'), { behavior: 'approve' }, 'p1')).toBeNull()
    expect(rosterNextFor(org('now'), roster({ added: [] }), 'p1')).toBeNull()
    expect(rosterNextFor(mcp(), roster(), 'p1')).toBeNull()
    expect(rosterNextFor(org('now'), { behavior: 'decline' }, 'p1')).toBeNull()
  })
  it('words the note by timing and counts deferred roles', () => {
    const now = rosterNextFor(org('now'), roster(), 'p1')
    expect(now && proposalNextLead(now)).toBe('Org chart saved. This run can use the new roles now. Removed roles stop being available immediately.')
    const later = rosterNextFor(org('after-turn'), roster({ deferred: [{ id: 'x', name: 'X', reason: 'r' }] }), 'p1')
    expect(later && proposalNextLead(later)).toBe('Org chart saved. New and changed roles can be used once no agent is working and the session restarts. Removed roles stop being available immediately. 1 role waits for the next run:')
    const only = rosterNextFor(org('now'), roster({ added: [], deferred: [{ id: 'x', name: 'X', reason: 'r' }, { id: 'y', name: 'Y', reason: 's' }] }), 'p1')
    expect(only && proposalNextLead(only)).toBe('Org chart saved. 2 roles wait for the next run:')
  })
})

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
  it('has no link for app settings or a target project settings proposal', () => {
    expect(proposalNextFor({ id: 'p', kind: 'appSettings', title: 't', payload: { changes: [], rationale: '' } } as unknown as Proposal, 'quick')).toBeNull()
    expect(proposalNextFor({ id: 'p', kind: 'settings', title: 't', target: { projectId: 'a', projectName: 'A' }, payload: {} } as unknown as Proposal, 'quick')).toBeNull()
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

describe('proposalNextAnnouncement', () => {
  it('says nothing without a note, the lead sentence for every other kind', () => {
    expect(proposalNextAnnouncement(undefined)).toBe('')
    expect(proposalNextAnnouncement(null)).toBe('')
    for (const kind of ['skillsLibrary', 'skillsProject', 'connectors', 'mcpProject'] as const) {
      expect(proposalNextAnnouncement({ kind, projectId: 'a' })).toBe(PROPOSAL_NEXT_COPY[kind].lead)
    }
    expect(proposalNextAnnouncement({ kind: 'mcpSecrets', projectId: 'a', names: ['gh'] })).toBe('gh needs a secret before it can start.')
  })
  it('adds the roles that wait for an org chart, clamped', () => {
    const roster = { applied: true, when: 'now' as const, deferred: [{ name: 'Writer', reason: 'x'.repeat(300) }] }
    const text = proposalNextAnnouncement({ kind: 'orgRoster', projectId: 'a', roster })
    expect(text.startsWith(proposalNextLead({ kind: 'orgRoster', projectId: 'a', roster }))).toBe(true)
    expect(text).toContain('Writer: ' + 'x'.repeat(199) + '…')
  })
})

describe('proposalNextLead', () => {
  it('uses the fixed copy for the other kinds and a clamped, pluralised sentence for secrets', () => {
    expect(proposalNextLead({ kind: 'connectors', projectId: 'a' })).toBe(PROPOSAL_NEXT_COPY.connectors.lead)
    expect(proposalNextLead({ kind: 'mcpSecrets', projectId: 'a', names: ['gh'] })).toBe('gh needs a secret before it can start.')
    expect(proposalNextLead({ kind: 'mcpSecrets', projectId: 'a', names: ['a', 'b', 'c', 'd', 'e'] })).toBe('a, b, c and 2 more need a secret before they can start.')
    expect(proposalNextLead({ kind: 'mcpSecrets', projectId: 'a', names: ['x'.repeat(100)] })).toContain('x'.repeat(39) + '…')
    // bidi and control characters never reach the sentence
    expect(proposalNextLead({ kind: 'mcpSecrets', projectId: 'a', names: ['g‮hx'] })).toBe('g h x needs a secret before it can start.')
  })
})
