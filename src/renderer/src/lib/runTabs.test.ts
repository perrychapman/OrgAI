import { describe, expect, it } from 'vitest'
import type { QuickRunInfo } from '@shared/types'
import { resolveRunTab, runTabIds, showsKnowledgeTab, showsOutputsTab, showsPlanTab } from './runTabs'

const quick: QuickRunInfo = { folder: 'C:\\work', team: 'single', allowEdits: false, gitRepo: false }

describe('run tabs', () => {
  it('lists the tabs in their fixed order', () => {
    expect(runTabIds({ plan: true, outputs: true, knowledge: true })).toEqual(['transcript', 'plan', 'usage', 'outputs', 'knowledge', 'logs'])
    expect(runTabIds({ plan: false, outputs: false, knowledge: false })).toEqual(['transcript', 'usage', 'logs'])
  })
  it('Plan: every work run (a Chat too), other kinds only with a plan', () => {
    expect(showsPlanTab({ kind: 'work', hasPlan: false })).toBe(true)
    expect(showsPlanTab({ kind: 'mcp-assist', hasPlan: false })).toBe(false)
    expect(showsPlanTab({ kind: 'skill-assist', hasPlan: true })).toBe(true)
    expect(showsPlanTab({ kind: 'setup', hasPlan: false })).toBe(false)
  })
  it('Outputs and Knowledge: never for a Chat or the assistants', () => {
    expect(showsOutputsTab({ kind: 'work', projectId: 'p1' })).toBe(true)
    expect(showsOutputsTab({ kind: 'work', quick, projectId: 'quick' })).toBe(false)
    expect(showsOutputsTab({ kind: 'mcp-assist', projectId: 'harness' })).toBe(false)
    expect(showsOutputsTab({ kind: 'skill-assist', projectId: 'p1' })).toBe(false)
    expect(showsOutputsTab(undefined)).toBe(false)
    expect(showsKnowledgeTab({ kind: 'work', projectId: 'p1' }, 'engagement')).toBe(true)
    expect(showsKnowledgeTab({ kind: 'work', projectId: 'p1' }, 'code')).toBe(false)
    expect(showsKnowledgeTab({ kind: 'work', quick, projectId: 'quick' }, 'engagement')).toBe(false)
    expect(showsKnowledgeTab({ kind: 'skill-assist', projectId: 'p1' }, 'engagement')).toBe(false)
  })
  it('a stored tab the run does not have falls back to the transcript', () => {
    const chat = runTabIds({ plan: true, outputs: false, knowledge: false })
    expect(resolveRunTab('usage', chat)).toBe('usage')
    expect(resolveRunTab('outputs', chat)).toBe('transcript')
    expect(resolveRunTab('knowledge', chat)).toBe('transcript')
    expect(resolveRunTab(undefined, chat)).toBe('transcript')
    expect(resolveRunTab('plan', runTabIds({ plan: false, outputs: false, knowledge: false }))).toBe('transcript')
  })
})
