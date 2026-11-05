import { describe, expect, it } from 'vitest'
import type { TeamFileChange, TeamFilesFound } from '@shared/types'
import { approvalChanges, changeForServer, foundSummary, repeatedReasons, setSettings, teamFoundAnnouncement, teamFoundBlocker, teamFoundCounts } from './teamFound'

describe('found team wording', () => {
  it('words settings as what the files set, not as changes', () => {
    expect(foundSummary({ kind: 'settings', summary: 'The project brief changed.' })).toBe('The files set the project brief.')
    expect(foundSummary({ kind: 'settings', summary: 'Permission mode changes from not set to default.' })).toBe('Permission mode is set to default.')
    expect(foundSummary({ kind: 'role', summary: 'Dev gains Bash.' })).toBe('Dev gains Bash.')
  })
  it('names a repeated reason once', () => {
    expect(repeatedReasons([{ reason: 'A' }, { reason: 'A' }, { reason: 'B' }, {}])).toEqual(['A'])
  })
  it('leaves out settings that are not set and counts them', () => {
    const r = setSettings([{ label: 'Mode', value: 'default' }, { label: 'Depth', value: 'not set' }, { label: 'Limit', value: 'Not set' }])
    expect(r.shown).toEqual([{ label: 'Mode', value: 'default' }])
    expect(r.unset).toBe(2)
  })
})

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
    // Repeated names match by target, never by name alone.
    const dup = [change({ id: '4', kind: 'mcp', name: 'gh', target: 'a' }), change({ id: '5', kind: 'mcp', name: 'gh', target: 'b' })]
    expect(changeForServer(dup, 'gh', 'b', 2)?.id).toBe('5')
    expect(changeForServer(dup, 'gh', 'c', 2)).toBeUndefined()
    expect(changeForServer(dup, 'gh')).toBeUndefined()
    expect(changeForServer(cs, 'gh', 'x', 2)).toBeUndefined()
  })
  it('announces by state', () => {
    expect(teamFoundAnnouncement(base, 'Acme', null)).toContain('Acme already holds it')
    expect(teamFoundAnnouncement(base, null, 'Creating is paused.')).toContain('Creating is paused.')
    expect(teamFoundAnnouncement(base, null, null)).toContain('Review it')
  })
})
