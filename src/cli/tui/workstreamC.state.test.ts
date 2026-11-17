import { describe, expect, it } from 'vitest'
import type { AgentInstance, RunEvent, RunOutput, RunSummary, TranscriptEntry } from '../../shared/types'
import { summary } from '../testing/fakeContext'
import { TOOL_DETAIL_MAX, transcriptRows } from './selectors'
import { applyEvent, createInitialState, setActiveRun, upsertRunSummary } from './state'
import type { TuiState } from './types'

let seq = 0
const ev = (event: RunEvent) => ({ seq: ++seq, event })
const entry = (id: string, block: TranscriptEntry['block'], agentId = 'root'): TranscriptEntry => ({ id, agentId, at: 1, block })
const root: AgentInstance = { id: 'root', roleId: null, roleSlug: 'root', name: 'Orchestrator', parentId: null, spawnToolUseId: null, state: 'thinking', activity: '', inputTokens: 0, outputTokens: 0, costUsd: 0, startedAt: 1 }

function base(): TuiState {
  let s = createInitialState('/work')
  s = upsertRunSummary(s, summary('r1', { projectId: 'p1', status: 'running' }) as RunSummary)
  s = setActiveRun(s, 'r1')
  return applyEvent(s, ev({ type: 'agent.upsert', runId: 'r1', agent: root }))
}

describe('selectors row cache', () => {
  it('reuses the exact same row object for an unchanged entry across streaming frames', () => {
    let s = base()
    s = applyEvent(s, ev({ type: 'transcript', runId: 'r1', entry: entry('e1', { kind: 'text', text: 'hello' }) }))
    const first = transcriptRows(s).rows[0]
    s = applyEvent(s, ev({ type: 'agent.partial', runId: 'r1', agentId: 'root', text: 'streaming' }))
    s = applyEvent(s, ev({ type: 'transcript', runId: 'r1', entry: entry('e2', { kind: 'text', text: 'more' }) }))
    const rows = transcriptRows(s).rows
    expect(rows[0]).toBe(first)
    expect(rows).toHaveLength(2)
  })

  it('rebuilds the row when the agent label changes', () => {
    let s = base()
    s = applyEvent(s, ev({ type: 'transcript', runId: 'r1', entry: entry('e1', { kind: 'text', text: 'hello' }) }))
    const first = transcriptRows(s).rows[0]
    s = applyEvent(s, ev({ type: 'agent.upsert', runId: 'r1', agent: { ...root, name: 'Renamed lead' } }))
    const next = transcriptRows(s).rows[0]
    expect(next).not.toBe(first)
  })

  it('caps a tool_use detail at 4,000 characters', () => {
    let s = base()
    const command = 'echo ' + 'x'.repeat(10_000)
    s = applyEvent(s, ev({ type: 'transcript', runId: 'r1', entry: entry('t1', { kind: 'tool_use', id: 'u1', name: 'Bash', input: { command } }) }))
    const row = transcriptRows(s).rows[0]
    expect(row.kind).toBe('tool')
    expect(row.detail!.length).toBeLessThan(command.length)
    expect(row.detail!.length).toBeLessThanOrEqual(TOOL_DETAIL_MAX + 40)
    expect(row.detail).toContain('truncated')
  })
})

describe('applyEvent fast paths and new events', () => {
  it('agent.partial and run.usage do not touch runOrder or the chain', () => {
    const s = base()
    const p = applyEvent(s, ev({ type: 'agent.partial', runId: 'r1', agentId: 'root', text: 'abc' }))
    expect(p.runOrder).toBe(s.runOrder)
    expect(p.activeChain).toBe(s.activeChain)
    expect(p.runs.r1.partials.root).toBe('abc')
    const u = applyEvent(p, ev({ type: 'run.usage', runId: 'r1', usage: { costUsd: 0.5, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } as never }))
    expect(u.runOrder).toBe(p.runOrder)
    expect(u.activeChain).toBe(p.activeChain)
    expect(u.runs.r1.summary.totalCostUsd).toBe(0.5)
  })

  it('appends many transcript entries without duplicating ids and keeps dedupe after a cap-sized stream', () => {
    let s = base()
    for (let i = 0; i < 50; i++) s = applyEvent(s, ev({ type: 'transcript', runId: 'r1', entry: entry(`e${i}`, { kind: 'text', text: `t${i}` }) }))
    const again = applyEvent(s, ev({ type: 'transcript', runId: 'r1', entry: entry('e10', { kind: 'text', text: 'dup' }) }))
    expect(again.runs.r1.transcript).toHaveLength(50)
    expect(again.runs.r1.transcript.filter((e) => e.id === 'e10')).toHaveLength(1)
  })

  it('applies run.model and run.permissionMode to the summary', () => {
    let s = base()
    s = applyEvent(s, ev({ type: 'run.model', runId: 'r1', selection: { model: 'opus', connection: 'anthropic' } }))
    expect(s.runs.r1.summary.modelSelection).toEqual({ model: 'opus', connection: 'anthropic' })
    s = applyEvent(s, ev({ type: 'run.permissionMode', runId: 'r1', permissionMode: 'plan', permissionModeChosen: true }))
    expect(s.runs.r1.summary.permissionMode).toBe('plan')
    expect(s.runs.r1.summary.permissionModeChosen).toBe(true)
    s = applyEvent(s, ev({ type: 'run.permissionMode', runId: 'r1', permissionMode: 'default', sessionPermissionMode: 'acceptEdits' }))
    expect(s.runs.r1.summary.permissionModeChosen).toBeUndefined()
    expect(s.runs.r1.summary.sessionPermissionMode).toBe('acceptEdits')
  })

  it('output.created and output.versioned raise a notice', () => {
    const output = { id: 'o1', title: 'Report', fileName: 'report.md' } as RunOutput
    let s = applyEvent(base(), ev({ type: 'output.created', runId: 'r1', output }))
    expect(s.notices.at(-1)?.text).toBe('Output created: Report')
    s = applyEvent(s, ev({ type: 'output.versioned', runId: 'r1', output }))
    expect(s.notices.at(-1)?.text).toBe('Output updated: Report')
  })
})
