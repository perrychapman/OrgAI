import { describe, expect, it } from 'vitest'
import type { EngagementNote, KnowledgeNode } from '@shared/types'
import type { KnowledgeItem } from './knowledge'
import { recordingNow, recordingText } from './knowledgeRecording'

const node = (id: string, source: KnowledgeNode['source'], retired = false): KnowledgeItem => ({ type: 'node', id, node: { id, kind: 'person', name: id, facts: [], source, createdAt: 1, updatedAt: 1, retired } as unknown as KnowledgeNode })
const agent = (runId: string) => ({ by: 'agent' as const, runId, role: 'Researcher', at: 1 })
const note = (id: string, runId: string): KnowledgeItem => ({ type: 'note', id, note: { id, title: id, excerpt: '', chars: 1, source: 'agent', recordedBy: { runId, role: 'Writer' }, createdAt: 1, updatedAt: 1 } as unknown as EngagementNote })

describe('recordingNow', () => {
  it('is empty when no run is working', () => {
    expect(recordingNow([node('a', agent('r1'))], [{ id: 'r1', status: 'finished' }, { id: 'r2', status: 'idle' }])).toEqual({ runs: 0, items: 0 })
    expect(recordingNow([], [])).toEqual({ runs: 0, items: 0 })
  })
  it('counts the live items that working runs recorded, notes included', () => {
    const items = [node('a', agent('r1')), node('b', agent('r1')), node('c', agent('r2')), node('d', { by: 'user', at: 1 }), node('e', agent('r1'), true), note('n', 'r1')]
    expect(recordingNow(items, [{ id: 'r1', status: 'running' }, { id: 'r2', status: 'finished' }])).toEqual({ runs: 1, items: 3 })
    expect(recordingNow(items, [{ id: 'r1', status: 'starting' }, { id: 'r2', status: 'running' }])).toEqual({ runs: 2, items: 4 })
  })
  it('says nothing for a run that recorded nothing yet beyond that it is working', () => {
    expect(recordingText({ runs: 0, items: 0 })).toBeNull()
    expect(recordingText({ runs: 1, items: 0 })).toBe('The team is working')
    expect(recordingText({ runs: 1, items: 6 })).toBe('The team is working · 6 recorded in the current run')
    expect(recordingText({ runs: 2, items: 3 })).toBe('The team is working · 3 recorded in the current runs')
  })
})
