import { describe, expect, it } from 'vitest'
import type { CapabilityItem } from '@shared/types'
import { chooserDesc, chooserName, localSkillCandidates, nextTabId, skillEmptyCopy } from './chooser'

const ids = ['a', 'b', 'c']
describe('nextTabId', () => {
  it('moves and wraps', () => {
    expect(nextTabId(ids, 'a', 'ArrowRight')).toBe('b')
    expect(nextTabId(ids, 'c', 'ArrowDown')).toBe('a')
    expect(nextTabId(ids, 'a', 'ArrowLeft')).toBe('c')
    expect(nextTabId(ids, 'b', 'Home')).toBe('a')
    expect(nextTabId(ids, 'a', 'End')).toBe('c')
    expect(nextTabId(ids, 'a', 'x')).toBeNull()
  })
})
describe('localSkillCandidates', () => {
  it('keeps local, applicable skills only', () => {
    const base = { kind: 'skill', origin: 'local', name: 'n', description: '', flags: [], needsSecrets: [], source: 'claude-skills', sourceLabel: 's' }
    const items = [
      { ...base, id: '1' },
      { ...base, id: '2', origin: 'repo' },
      { ...base, id: '3', inProject: { kind: 'skill', id: 'x', grantedTo: [], enabled: true } },
      { ...base, id: '4', blockedReason: 'bad' },
      { ...base, id: '5', kind: 'mcp' }
    ] as unknown as CapabilityItem[]
    expect(localSkillCandidates(items).map((i) => i.id)).toEqual(['1'])
  })
})
describe('skillEmptyCopy', () => {
  it('names the cause', () => {
    expect(skillEmptyCopy('project', 0)).toBe('This project has no skills yet.')
    expect(skillEmptyCopy('project', 3)).toBe('All of them are on this role.')
  })
})

describe('chooser text clamps', () => {
  it('clamps the name to 80 and the description to 200 characters', () => {
    expect(chooserName('a'.repeat(200))).toHaveLength(80)
    expect(chooserDesc('b'.repeat(500))).toHaveLength(200)
    expect(chooserName('short')).toBe('short')
  })
  it('flattens control characters and whitespace', () => {
    expect(chooserDesc('one\n\ttwo   three\u0000x')).toBe('one two three x')
    expect(chooserName(undefined)).toBe('')
  })
})
