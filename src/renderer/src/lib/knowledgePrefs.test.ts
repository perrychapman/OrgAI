import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearKnowledgePrefs, layoutKey } from './knowledgePrefs'

describe('clearKnowledgePrefs', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('removes the project\'s view, switches and layout, and only those', () => {
    const data = new Map<string, string>([
      ['orgai.knowledgeView.p1', 'graph'],
      ['orgai.knowledgeRetired.p1', 'on'],
      ['orgai.knowledgeInferred.p1', 'on'],
      [layoutKey('p1'), '{}'],
      ['orgai.knowledgeInferred.p2', 'on'],
      [layoutKey('p2'), '{}']
    ])
    vi.stubGlobal('localStorage', { removeItem: (k: string) => data.delete(k) })
    clearKnowledgePrefs('p1')
    expect([...data.keys()].sort()).toEqual(['orgai.knowledgeInferred.p2', layoutKey('p2')].sort())
  })
  it('does not throw when storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      removeItem: () => {
        throw new Error('blocked')
      }
    })
    expect(() => clearKnowledgePrefs('p1')).not.toThrow()
  })
})
