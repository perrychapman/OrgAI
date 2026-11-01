import { describe, expect, it } from 'vitest'
import { capabilityLabel, capabilityParts, normalizeView } from './teamView'

describe('normalizeView', () => {
  it('maps the old org tab to team and leaves others alone', () => {
    expect(normalizeView('org')).toBe('team')
    expect(normalizeView('run')).toBe('run')
    expect(normalizeView('team')).toBe('team')
  })
})

describe('capability line', () => {
  it('omits zero counts', () => {
    expect(capabilityParts({ tools: 3, connections: 0, skills: 2 }).map((p) => p.key)).toEqual(['tools', 'skills'])
  })
  it('speaks the full label with singular and plural nouns', () => {
    expect(capabilityLabel({ tools: 3, connections: 1, skills: 2 })).toBe('3 tools, 1 connection, 2 skills')
    expect(capabilityLabel({ tools: 1, connections: 0, skills: 0 })).toBe('1 tool')
    expect(capabilityLabel({ tools: 0, connections: 0, skills: 0 })).toBe('No tools')
  })
})
