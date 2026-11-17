import { describe, expect, it } from 'vitest'
import type { McpServerSpec, Proposal, Role } from '@shared/types'
import { HIDDEN_PREFIX, foldList, proposalFoldSummary, proposerName, revisePlaceholder, type ProposalContext } from './proposalSummary'

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
  it('flags hidden characters in the summary', () => {
    const p = { ...base, kind: 'mcpServers', payload: { upsert: [srv('g', 'github-issues', { args: ['a‮b'] })], rationale: '' } } as Proposal
    expect(proposalFoldSummary(p, ctx)).toBe(HIDDEN_PREFIX + 'add github-issues')
  })
  it('names switches', () => {
    const p = { ...base, kind: 'mcpServers', payload: { upsert: [srv('g', 'github-issues', { enabled: false })], rationale: '' } } as Proposal
    const on = { ...ctx, mcpServers: [srv('g', 'github-issues')] }
    expect(proposalFoldSummary(p, on)).toBe('switch off github-issues')
  })
  it('lists skills', () => {
    const p = {
      ...base,
      kind: 'skills',
      payload: { rationale: '', items: [{ action: 'update', scope: 'project', draft: { name: 'mock-skill', description: '', body: '' } }, { action: 'create', scope: 'project', draft: { name: 'release-notes', description: '', body: '' } }] }
    } as Proposal
    expect(proposalFoldSummary(p, ctx)).toBe('new release-notes, update mock-skill')
  })
  it('lists schedule changes by name', () => {
    const sched = { name: 'Nightly review', prompt: 'x', target: { kind: 'ask' }, timing: { kind: 'daily', time: '08:00' } }
    const p = {
      ...base,
      kind: 'schedules',
      payload: {
        rationale: '',
        items: [
          { action: 'create', schedule: sched, summary: '', nextRuns: [] },
          { action: 'pause', scheduleId: 's1', summary: '', nextRuns: [] },
          { action: 'remove', scheduleId: 'gone', summary: '', nextRuns: [] }
        ]
      }
    } as Proposal
    expect(proposalFoldSummary(p, { ...ctx, scheduleNames: (id) => (id === 's1' ? 'Docs sync' : undefined) })).toBe('new Nightly review, pause Docs sync, delete a schedule')
    expect(proposalFoldSummary(p, ctx)).toBe('new Nightly review, pause a schedule, delete a schedule')
  })
  it('flags hidden characters in a schedule name', () => {
    const p = {
      ...base,
      kind: 'schedules',
      payload: { rationale: '', items: [{ action: 'create', schedule: { name: 'Nightly‮ review', prompt: 'x', target: { kind: 'ask' }, timing: { kind: 'daily', time: '08:00' } }, summary: '', nextRuns: [] }] }
    } as Proposal
    expect(proposalFoldSummary(p, ctx)?.startsWith(HIDDEN_PREFIX)).toBe(true)
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

describe('self-help proposals', () => {
  const change = (field: string, label: string) => ({ field, label, from: 'a', to: 'b' })
  it('names the count and fields of an app settings proposal', () => {
    const one = { ...base, kind: 'appSettings', payload: { changes: [change('appearance.theme', 'Theme')], rationale: '' } } as Proposal
    expect(proposalFoldSummary(one, ctx)).toBe('1 app setting · App settings')
    const many = {
      ...base,
      kind: 'appSettings',
      payload: { changes: [change('appearance.theme', 'Theme'), change('appearance.canvas.pattern', 'Canvas backdrop'), change('notifications', 'Notifications'), change('communityPrices', 'Community model prices'), change('defaultKeepRuns', 'Runs kept')], rationale: '' }
    } as Proposal
    expect(proposalFoldSummary(many, ctx)).toBe('5 app settings · App settings')
  })
  it('names the fields of a target settings proposal', () => {
    const p = { ...base, kind: 'settings', target: { projectId: 'p', projectName: 'Notes' }, payload: { rationale: '', maxBudgetUsd: 5, permissionMode: 'default', brief: 'x' } } as Proposal
    expect(proposalFoldSummary(p, ctx)).toBe('3 settings · Notes')
  })
  it('keeps the title for a setup settings proposal', () => {
    const p = { ...base, kind: 'settings', payload: { rationale: '', maxBudgetUsd: 5 } } as Proposal
    expect(proposalFoldSummary(p, ctx)).toBe('A title')
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
