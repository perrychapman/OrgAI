import { describe, expect, it } from 'vitest'
import type { McpServerSpec, Proposal, Role } from '@shared/types'
import { foldList, proposalFoldSummary, proposerName, revisePlaceholder, type ProposalContext } from './proposalSummary'

const srv = (id: string, name: string, extra: Partial<McpServerSpec> = {}): McpServerSpec => ({ id, name, transport: 'stdio', command: 'npx', args: ['x'], enabled: true, source: 'user', addedAt: '', ...extra }) as McpServerSpec
const ctx: ProposalContext = {
  roles: [{ id: 'r', slug: 'reviewer', name: 'Reviewer' }] as Role[],
  mcpServers: [srv('n', 'notes', { roles: ['reviewer'] }), srv('o', 'old-fs')],
  skills: { roles: [], skills: [{ id: 's', name: 'mock-skill' }] }
}
const base = { id: 'p', runId: 'r', agentId: 'a', title: 'A title', createdAt: 0 }

describe('proposalFoldSummary', () => {
  it('lists MCP verbs', () => {
    const p = {
      ...base,
      kind: 'mcpServers',
      payload: { upsert: [srv('g', 'github-issues'), srv('l', 'mock-fs', { libraryId: 'lib' }), srv('n', 'notes', { roles: ['x'] })], remove: ['o'], rationale: '' }
    } as Proposal
    expect(proposalFoldSummary(p, ctx)).toBe('add github-issues, link mock-fs, change access to notes and 1 more')
  })
  it('lists a short MCP summary', () => {
    const p = { ...base, kind: 'mcpServers', payload: { upsert: [srv('g', 'github-issues')], remove: ['o'], rationale: '' } } as Proposal
    expect(proposalFoldSummary(p, ctx)).toBe('add github-issues, remove old-fs')
  })
  it('lists skills', () => {
    const p = {
      ...base,
      kind: 'skills',
      payload: { rationale: '', items: [{ action: 'update', scope: 'project', draft: { name: 'mock-skill', description: '', body: '' } }, { action: 'create', scope: 'project', draft: { name: 'release-notes', description: '', body: '' } }] }
    } as Proposal
    expect(proposalFoldSummary(p, ctx)).toBe('new release-notes, update mock-skill')
  })
  it('settings uses the clipped title, architecture too', () => {
    expect(proposalFoldSummary({ ...base, kind: 'settings', payload: { rationale: '' } } as Proposal, ctx)).toBe('A title')
    expect(proposalFoldSummary({ ...base, title: ' ', kind: 'settings', payload: { rationale: '' } } as Proposal, ctx)).toBeUndefined()
  })
  it('foldList names at most three', () => {
    expect(foldList(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more')
    expect(foldList(['a', 'b'])).toBe('a, b')
  })
})

describe('proposer', () => {
  it('names the proposer by run kind', () => {
    expect(proposerName({ kind: 'setup' })).toBe('The Architect')
    expect(proposerName({ kind: 'mcp-assist' })).toBe('The assistant')
    expect(proposerName({ kind: 'skill-assist' })).toBe('The assistant')
    expect(proposerName({ kind: 'work', quick: { folder: '', team: 'single' } as never })).toBe('The assistant')
    expect(proposerName({ kind: 'work' })).toBe('The orchestrator')
    expect(proposerName(undefined)).toBe('The orchestrator')
    expect(revisePlaceholder('The assistant')).toBe('What should change? The assistant revises and proposes again.')
  })
})
