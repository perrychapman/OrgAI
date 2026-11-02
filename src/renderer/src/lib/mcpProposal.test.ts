import { describe, expect, it } from 'vitest'
import type { McpProposalServer, McpServerSpec, McpServersProposalPayload } from '@shared/types'
import {
  PROPOSAL_EFFECT_COPY,
  classifyUpsert,
  diffMcpProposal,
  effectLine,
  mcpApplyNote,
  mcpRowVerb,
  proposalCommand,
  removalLabels,
  secretsLine,
  upsertAction,
  whoCanUse,
  whoCanUseChange
} from './mcpProposal'

const base = { id: 'a', name: 'pg', transport: 'stdio', enabled: true, addedAt: '' } as unknown as McpProposalServer
const roles = [
  { slug: 'orchestrator', name: 'Orchestrator' },
  { slug: 'implementer', name: 'Implementer' },
  { slug: 'reviewer', name: 'Reviewer' }
]
const spec = (o: Partial<McpServerSpec>): McpServerSpec => ({ id: 'x', name: 'x', transport: 'stdio', command: 'npx', args: ['-y', 'x@1.0.0'], enabled: true, source: 'user', addedAt: '', ...o }) as McpServerSpec

describe('mcpProposal', () => {
  it('words the action by scope', () => {
    expect(upsertAction(base, 'library')).toBe('Add pg to your library')
    expect(upsertAction({ ...base, libraryId: 'l' }, 'project')).toBe('Link pg from your library')
    expect(upsertAction(base, 'project')).toBe('Add pg to the library and this project')
  })
  it('describes effects', () => {
    expect(effectLine(base)).toBe('Runs code on this machine')
    expect(effectLine({ ...base, transport: 'http', url: 'https://x.example.com/mcp' })).toBe('Connects to remote host x.example.com')
  })
  it('library scope omits who-can-use and says library', () => {
    expect(whoCanUse(base, [], 'library')).toBeNull()
    expect(mcpApplyNote('library')).toContain('MCP library (available to every project)')
  })
  it('shows role names, never slugs, and drops unknown slugs', () => {
    expect(whoCanUse({ ...base, roles: ['orchestrator', 'implementer'] }, roles)).toBe('Orchestrator, Implementer')
    expect(whoCanUse({ ...base, roles: ['ghost'] }, roles)).toBeNull()
    expect(whoCanUse({ ...base, roles: [] }, roles)).toBe('No role yet')
  })
  it('roles, secrets', () => {
    expect(whoCanUse(base)).toBe('Every role')
    const secrets = [{ serverId: 'a', kind: 'env', name: 'TOKEN' }] as never
    expect(secretsLine({ upsert: [], rationale: '', secrets })).toBe('You will set 1 secret after approving: TOKEN')
  })
  it('shows before and after access', () => {
    const cur = spec({ roles: ['orchestrator', 'implementer'] })
    expect(whoCanUseChange({ ...base, roles: ['reviewer'] }, cur, roles)).toBe('Reviewer (was Orchestrator, Implementer)')
    expect(whoCanUseChange({ ...base, roles: ['reviewer'] }, spec({}), roles)).toBe('Reviewer (was Every role)')
    expect(whoCanUseChange({ ...base, roles: ['reviewer'] }, undefined, roles)).toBe('Reviewer')
  })
  it('a link row shows the library entry command', () => {
    const link = { ...base, libraryId: 'lib1', command: undefined, args: undefined } as McpProposalServer
    expect(proposalCommand(link)).toBeNull()
    expect(proposalCommand(link, spec({ command: 'npx', args: ['-y', 'y'] }))).toBe('npx -y y')
    expect(proposalCommand({ ...base, command: 'npx', args: ['z'] } as McpProposalServer)).toBe('npx z')
  })
  it('exports the effect copy', () => {
    expect(PROPOSAL_EFFECT_COPY.now).toBe('Takes effect now.')
    expect(PROPOSAL_EFFECT_COPY.nextRun).toBe('Applies to future runs. This run keeps its roles.')
    expect(PROPOSAL_EFFECT_COPY.turn).toBe("Takes effect after the orchestrator's current turn. Reports already running keep what they have.")
  })
})

describe('removalLabels', () => {
  const cur = [spec({ id: 'm1', name: 'mock-fs', roles: ['implementer'], libraryId: 'lib' }), spec({ id: 'm2', name: 'notes' })]
  it('names a project removal, its roles and the library entry', () => {
    const [r] = removalLabels({ remove: ['m1'] }, cur, roles, 'project')
    expect(r.title).toBe('Remove mock-fs from this project')
    expect(r.detail).toBe('Implementer can no longer use it.')
    expect(r.note).toBe('The library entry stays.')
  })
  it('says every role when roles are undefined and none when empty', () => {
    expect(removalLabels({ remove: ['m2'] }, cur, roles, 'project')[0].detail).toBe('Every role loses it.')
    expect(removalLabels({ remove: ['m1'] }, [spec({ id: 'm1', name: 'q', roles: [] })], roles, 'project')[0].detail).toBe('No role uses it now.')
  })
  it('library scope and unknown ids', () => {
    expect(removalLabels({ remove: ['m2'] }, cur, roles, 'library')[0].title).toBe('Remove notes from your library')
    expect(removalLabels({ remove: ['mcp_0123456789abcdefghijklmnop'] }, cur, roles, 'project')[0].title).toBe('Remove a server that is not in this project (mcp_0123456789abcdefghi…)')
  })
})

describe('diffMcpProposal', () => {
  const proj = [
    spec({ id: 'gh', name: 'github-issues', roles: ['orchestrator', 'implementer'] }),
    spec({ id: 'fs', name: 'mock-fs', roles: ['implementer'], libraryId: 'lib-fs' }),
    spec({ id: 'k1', name: 'keep-1' }),
    spec({ id: 'k2', name: 'keep-2' })
  ]
  it('shot 21: narrows github-issues to the reviewer and removes mock-fs', () => {
    const payload: McpServersProposalPayload = { upsert: [{ ...proj[0], roles: ['reviewer'] }], remove: ['fs'], rationale: '' }
    const d = diffMcpProposal(payload, proj, roles)
    expect(d.rows.map((r) => r.change)).toEqual(['access'])
    expect(d.removals[0].title).toBe('Remove mock-fs from this project')
    expect(d.summary).toBe('1 access change, 1 removal; 2 servers unchanged')
    expect(d.untouched).toEqual(['keep-1', 'keep-2'])
  })
  it('classifies new, link, changed spec and same', () => {
    const newS = spec({ id: 'n', name: 'brand-new' })
    const link = spec({ id: 'tmp', name: 'review', libraryId: 'lib-review' })
    const changed = { ...proj[2], args: ['-y', 'x@2.0.0'] }
    const same = { ...proj[3] }
    const d = diffMcpProposal({ upsert: [same, changed, link, newS], rationale: '' }, proj, roles)
    expect(d.rows.map((r) => `${r.server.name}:${r.change}`)).toEqual(['brand-new:new', 'review:link', 'keep-1:update'])
    expect(d.same).toEqual(['keep-2'])
    expect(d.summary).toBe('1 new, 1 linked, 1 changed; 3 servers unchanged')
  })
  it('matches a link by libraryId and ignores a linked snapshot', () => {
    const link = { ...proj[1], id: 'other', command: 'different', roles: ['implementer'] }
    expect(classifyUpsert(link, proj, 'project').change).toBe('same')
    expect(classifyUpsert({ ...link, roles: ['reviewer'] }, proj, 'project')).toMatchObject({ change: 'access' })
  })
  it('library scope ignores roles', () => {
    const d = diffMcpProposal({ scope: 'library', upsert: [{ ...proj[0], roles: ['x'] }], rationale: '' }, proj, roles)
    expect(d.rows).toEqual([])
    expect(d.summary).toBe('4 servers unchanged')
  })
  it('names the verbs for the fold summary', () => {
    const d = diffMcpProposal({ upsert: [{ ...proj[0], roles: ['reviewer'] }, spec({ id: 'n', name: 'notes' })], rationale: '' }, proj, roles)
    expect(d.rows.map(mcpRowVerb)).toEqual(['add notes', 'change access to github-issues'])
  })
  it('says no changes for an identical proposal with no current list', () => {
    expect(diffMcpProposal({ upsert: [], rationale: '' }, null, roles).summary).toBe('No changes')
  })
})
