import { describe, expect, it } from 'vitest'
import type { McpProposalServer, McpServerSpec, McpServersProposalPayload } from '@shared/types'
import {
  proposalEffectCopy,
  secretsHelp,
  toggleLine,
  newEffectLine,
  mcpSummaryLine,
  targetText,
  codeLoadingEnv,
  mcpFieldChanges,
  mcpServerHidden,
  proposalTarget,
  uniqueSecretSlots,
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
  it('words the effect by proposer and drops unknown values', () => {
    expect(proposalEffectCopy('now')).toBe('Takes effect now.')
    expect(proposalEffectCopy('next-run')).toBe('Takes effect from the next run. This run keeps what it has.')
    expect(proposalEffectCopy('after-turn')).toBe("Takes effect after the orchestrator's current turn. Reports already running keep what they have.")
    expect(proposalEffectCopy('after-turn', 'assistant')).toContain("the assistant's current turn")
    expect(proposalEffectCopy('after-turn', 'architect')).toContain("the Architect's current turn")
    expect(proposalEffectCopy(undefined)).toBeNull()
    expect(proposalEffectCopy('bogus' as never)).toBeNull()
  })
  it('names where to set secrets later by scope', () => {
    expect(secretsHelp('project')).toContain('Project settings > Tools')
    expect(secretsHelp('library')).toContain('App settings > Connectors')
    expect(secretsHelp('project')).toContain('A server with an empty secret does not start.')
  })
  it('the apply note does not say secrets are entered separately when fields are inline', () => {
    expect(mcpApplyNote('project', true)).toContain('Secrets you leave empty can be set later.')
    expect(mcpApplyNote('project', true)).not.toContain('separately')
  })
  it('classifies an enabled difference as a toggle and words it', () => {
    const cur = spec({ id: 'a', name: 'pg', enabled: false, command: undefined, args: undefined })
    const on = { ...base, enabled: true } as McpProposalServer
    expect(classifyUpsert(on, [cur], 'project')).toMatchObject({ change: 'toggle' })
    // Main saves `enabled !== false`: an omitted flag switches a disabled server on, so it reads as a toggle.
    const omitted = { ...base, enabled: undefined } as unknown as McpProposalServer
    expect(classifyUpsert(omitted, [cur], 'project').change).toBe('toggle')
    expect(toggleLine(omitted, cur)).toBe('Switches pg on. It runs code on this machine from the next run.')
    expect(classifyUpsert(omitted, [{ ...cur, enabled: true }], 'project').change).not.toBe('toggle')
    expect(toggleLine(on, cur)).toBe('Switches pg on. It runs code on this machine from the next run.')
    const remote = spec({ id: 'a', transport: 'http', url: 'https://h.example.com/mcp', enabled: false, command: undefined, args: undefined })
    expect(toggleLine({ ...base, transport: 'http', url: 'https://h.example.com/mcp', enabled: true } as McpProposalServer, remote)).toBe('Switches pg on. It connects to h.example.com from the next run.')
    expect(toggleLine({ ...base, enabled: false } as McpProposalServer, spec({ id: 'a', enabled: true }))).toBe('Switches pg off.')
    expect(toggleLine(on, spec({ id: 'a', enabled: true }))).toBeNull()
  })
  it('counts switches in the summary and fold verbs', () => {
    const payload = { rationale: '', upsert: [{ ...base, enabled: true }, { ...base, id: 'b', name: 'fs', enabled: false }] } as unknown as McpServersProposalPayload
    const cur = [spec({ id: 'a', name: 'pg', enabled: false, command: undefined, args: undefined }), spec({ id: 'b', name: 'fs', enabled: true, command: undefined, args: undefined })]
    const d = diffMcpProposal(payload, cur, roles)
    expect(d.rows.map((r) => r.change)).toEqual(['toggle', 'toggle'])
    expect(d.summary).toBe('1 switched on, 1 switched off')
    expect(d.rows.map(mcpRowVerb)).toEqual(['switch on pg', 'switch off fs'])
    expect(mcpSummaryLine({ new: 0, link: 0, access: 0, update: 0, removal: 0, on: 2 }, null)).toBe('2 switched on')
  })
  it('a new server added switched off says it does not start', () => {
    expect(newEffectLine({ ...base, enabled: false } as McpProposalServer)).toBe('Added switched off; it does not start until you switch it on.')
    expect(newEffectLine(base)).toBe('Runs code on this machine')
  })
  it('quotes arguments with hidden or non-ASCII characters', () => {
    const t = targetText({ transport: 'stdio', command: 'npx', args: ['a\u200bb', 'caf\u00e9', 'plain'] })
    expect(t).toBe('npx "a\u200bb" "caf\u00e9" plain')
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

describe('full target', () => {
  it('stdio: env pairs, then command and args, quoted like reviewTarget', () => {
    const s = { ...base, command: 'npx', args: ['-y', 'a b', ''], env: { ZED: '1', NODE_OPTIONS: '--require /tmp/x.js' }, secretEnv: ['TOKEN'] } as McpProposalServer
    expect(proposalTarget(s)).toBe('NODE_OPTIONS="--require /tmp/x.js" ZED=1 npx -y "a b" ""')
    expect(proposalTarget(s)).not.toContain('TOKEN')
  })
  it('remote: the URL plus headers', () => {
    const s = { ...base, transport: 'http', url: 'https://x.example.com/mcp', headers: { 'X-Mode': 'ro' } } as McpProposalServer
    expect(proposalTarget(s)).toBe('https://x.example.com/mcp -H "X-Mode: ro"')
  })
  it('escapes hidden characters and flags them', () => {
    const s = { ...base, command: 'node', args: ['a‮b'] } as McpProposalServer
    expect(proposalTarget(s)).toBe(String.raw`node "a\u202eb"`)
    expect(mcpServerHidden(s)).toBe(true)
    expect(mcpServerHidden(base)).toBe(false)
    expect(mcpServerHidden({ ...base, name: 'p​g' })).toBe(true)
  })
  it('a link row falls back to the library entry', () => {
    const link = { ...base, libraryId: 'l', command: undefined, args: undefined } as McpProposalServer
    expect(proposalTarget(link, spec({ command: 'npx', args: ['y'], env: { A: 'b' } }))).toBe('A=b npx y')
  })
  it('flags code-loading environment names, case-insensitively', () => {
    expect(codeLoadingEnv({ env: { node_options: 'x', FOO: '1', HTTPS_PROXY: 'p', PYTHONPATH: 'q', LD_PRELOAD: 'z' }, secretEnv: ['npm_config_registry', 'TOKEN'] })).toEqual(['node_options', 'HTTPS_PROXY', 'PYTHONPATH', 'LD_PRELOAD', 'npm_config_registry'])
    expect(codeLoadingEnv({ env: { FOO: '1' } })).toEqual([])
  })
  it('lists changed fields before and after', () => {
    const cur = spec({ command: 'npx', args: ['a'], env: { A: '1', B: '2' }, secretEnv: ['T'] })
    const next = { ...cur, args: ['c'], env: { A: '9', NODE_OPTIONS: 'x' }, secretEnv: ['T', 'U'] } as McpProposalServer
    expect(mcpFieldChanges(next, cur)).toEqual(['Args: a -> c', 'Environment: +NODE_OPTIONS, -B, A changed', 'Secret environment: +U'])
    const remote = { ...cur, transport: 'http', command: undefined, args: undefined, url: 'https://b.example.com' } as McpProposalServer
    expect(mcpFieldChanges(remote, { ...cur, transport: 'http', command: undefined, args: undefined, url: 'https://a.example.com' } as McpServerSpec)).toEqual(['URL: https://a.example.com -> https://b.example.com'])
  })
})

describe('secret slots', () => {
  it('drops duplicate slots and clamps names', () => {
    const secrets = [
      { serverId: 'a', kind: 'env', name: 'TOKEN' },
      { serverId: 'a', kind: 'env', name: 'TOKEN' },
      { serverId: 'a', kind: 'header', name: 'TOKEN' },
      { serverId: 'a|env', kind: 'env', name: 'X' }
    ] as never
    expect(uniqueSecretSlots({ secrets }).map((x) => x.index)).toEqual([0, 2, 3])
    expect(secretsLine({ upsert: [], rationale: '', secrets })).toBe('You will set 3 secrets after approving: TOKEN, TOKEN, X')
    expect(secretsLine({ upsert: [], rationale: '', secrets: [{ serverId: 'a', kind: 'env', name: 'N'.repeat(100) }] as never })?.length).toBeLessThan(100)
  })
})
