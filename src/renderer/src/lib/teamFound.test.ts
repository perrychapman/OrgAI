import { describe, expect, it } from 'vitest'
import type { TeamFileChange, TeamFilesFound } from '@shared/types'
import { approvalChanges, changeForServer, teamFoundAnnouncement, teamFoundBlocker, teamFoundCounts } from './teamFound'

const base: TeamFilesFound = { digest: 'd1', roleCount: 1, roles: [], skills: [], mcpServers: [], changes: [], problems: [], warnings: [] }
const change = (over: Partial<TeamFileChange>): TeamFileChange => ({ id: 'x', kind: 'role', name: 'r', file: 'f', action: 'added', summary: 's', needsApproval: false, ...over })

describe('teamFoundCounts', () => {
  it('counts what is there', () => {
    expect(teamFoundCounts(base)).toBe('1 role')
    const f = { ...base, roleCount: 4, skills: [{ name: 'a', description: '', scripts: [] }], mcpServers: [{ name: 's', target: 't', secretNames: [] }, { name: 'u', target: 't', secretNames: [] }] }
    expect(teamFoundCounts(f)).toBe('4 roles, 1 skill and 2 connected services')
  })
})

describe('teamFoundBlocker', () => {
  it('is null for a clean team', () => expect(teamFoundBlocker(base)).toBeNull())
  it('names the files of problems', () => {
    expect(teamFoundBlocker({ ...base, digest: undefined, problems: [{ file: '.orgai/team.json', message: 'x' }] })).toContain('.orgai/team.json')
  })
  it('refuses omitted changes and a missing digest', () => {
    expect(teamFoundBlocker({ ...base, omittedChanges: 3 })).toContain('3 more changes')
    expect(teamFoundBlocker({ ...base, digest: undefined })).toContain('could not be read')
  })
  it('caps the file list', () => {
    const problems = ['a', 'b', 'c', 'd', 'e'].map((file) => ({ file, message: '' }))
    expect(teamFoundBlocker({ ...base, problems })).toContain('a, b, c and 2 more')
  })
})

describe('helpers', () => {
  it('filters approval changes and finds a server change', () => {
    const cs = [change({ id: '1', needsApproval: true }), change({ id: '2' }), change({ id: '3', kind: 'mcp', name: 'gh' })]
    expect(approvalChanges({ changes: cs }).map((c) => c.id)).toEqual(['1'])
    expect(changeForServer(cs, 'gh')?.id).toBe('3')
    expect(changeForServer(cs, 'zz')).toBeUndefined()
  })
  it('announces by state', () => {
    expect(teamFoundAnnouncement(base, 'Acme', null)).toContain('Acme already holds it')
    expect(teamFoundAnnouncement(base, null, 'Creating is paused.')).toContain('Creating is paused.')
    expect(teamFoundAnnouncement(base, null, null)).toContain('Review it')
  })
})
