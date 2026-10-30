import { describe, expect, it } from 'vitest'
import type { McpProposalServer } from '@shared/types'
import { mcpApplyNote, effectLine, removalLabels, secretsLine, upsertAction, whoCanUse } from './mcpProposal'

const base = { id: 'a', name: 'pg', transport: 'stdio', enabled: true, addedAt: '' } as unknown as McpProposalServer

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
  it('drops role slugs that are not in the project', () => {
    expect(whoCanUse({ ...base, roles: ['architect', 'dev'] }, ['dev'])).toBe('dev')
    expect(whoCanUse({ ...base, roles: ['architect'] }, ['dev'])).toBeNull()
  })
  it('roles, removals, secrets', () => {
    expect(whoCanUse(base)).toBe('Every role')
    expect(removalLabels({ upsert: [base], remove: ['a', 'z'], rationale: '' })).toEqual(['Remove pg', 'Remove z'])
    const secrets = [{ serverId: 'a', kind: 'env', name: 'TOKEN' }] as never
    expect(secretsLine({ upsert: [], rationale: '', secrets })).toBe('You will set 1 secret after approving: TOKEN')
  })
})
