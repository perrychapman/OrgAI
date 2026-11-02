import { describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '@shared/types'
import { autoContinueLine, bareToolName, FEED_MAX_ITEMS, humanizeToolResult, humanizeToolUse, mergeChainFeed, omittedLabel, resultSummary } from './transcriptRows'

describe('mergeChainFeed', () => {
  const entry = (id: string, block: TranscriptEntry['block'], source?: 'harness'): TranscriptEntry => ({ id, agentId: 'root', at: 1, block, ...(source ? { source } : {}) }) as TranscriptEntry
  const note = (id: string): TranscriptEntry => entry(id, { kind: 'system', text: 'Continued from run run_1' }, 'harness')
  const m = (id: string, startedAt: number, resumedFrom: string | undefined, entries: TranscriptEntry[]) => ({
    summary: { id, startedAt, status: 'finished' as const, ...(resumedFrom ? { resumedFrom } : {}), endedAt: startedAt + 1000 },
    entries
  })

  const texts = (prefix: string, n: number): TranscriptEntry[] => Array.from({ length: n }, (_, i) => entry(`${prefix}${i}`, { kind: 'text', text: `${prefix}${i}` }))

  it('caps the merged feed at the newest items and leads with how many entries were cut', () => {
    const feed = mergeChainFeed([m('run_1', 0, undefined, texts('a', 8)), m('run_2', 10, 'run_1', texts('b', 3))], 6)
    expect(feed).toHaveLength(7)
    expect(feed[0]).toEqual({ kind: 'omitted', count: 6 })
    // Newest 6 of [a0..a7, divider, b0..b2]: a6, a7, divider, b0, b1, b2.
    expect(feed.slice(1).map((f) => (f.kind === 'entry' ? f.entry.id : f.kind))).toEqual(['run_1:a6', 'run_1:a7', 'divider', 'b0', 'b1', 'b2'])
  })

  it('keeps the newest member divider when the newest member alone fills the cap', () => {
    const feed = mergeChainFeed([m('run_1', 0, undefined, texts('a', 2)), m('run_2', 10, 'run_1', texts('b', 10))], 4)
    expect(feed[0]).toEqual({ kind: 'omitted', count: 9 })
    expect(feed.slice(1).map((f) => (f.kind === 'entry' ? f.entry.id : f.kind === 'divider' ? `divider:${f.divider.runId}` : f.kind))).toEqual(['divider:run_2', 'b7', 'b8', 'b9'])
  })

  it('leaves a feed under the cap untouched and defaults to FEED_MAX_ITEMS', () => {
    expect(mergeChainFeed([m('run_1', 0, undefined, texts('a', 3))], 3).map((f) => f.kind)).toEqual(['entry', 'entry', 'entry'])
    const big = mergeChainFeed([m('run_1', 0, undefined, texts('a', FEED_MAX_ITEMS + 5))])
    expect(big).toHaveLength(FEED_MAX_ITEMS + 1)
    expect(big[0]).toEqual({ kind: 'omitted', count: 5 })
    expect(omittedLabel(1)).toBe('1 earlier entry not shown')
    expect(omittedLabel(1234)).toBe('1,234 earlier entries not shown')
  })

  it('puts one divider before each continuation and prefixes older entry ids', () => {
    const feed = mergeChainFeed([
      m('run_1', 0, undefined, [entry('e1', { kind: 'text', text: 'first' })]),
      m('run_2', 60_000 * 5, 'run_1', [note('n1'), entry('e1', { kind: 'text', text: 'second' })])
    ])
    expect(feed.map((f) => f.kind)).toEqual(['entry', 'divider', 'entry'])
    const ids = feed.flatMap((f) => (f.kind === 'entry' ? [f.entry.id] : []))
    expect(ids).toEqual(['run_1:e1', 'e1'])
    const div = feed[1]
    expect(div.kind === 'divider' && div.divider.label).toMatch(/^Continued /)
    expect(div.kind === 'divider' && div.divider.runId).toBe('run_2')
  })

  it('prefixes tool_use ids and tool_result toolUseIds of earlier members so pairs still match', () => {
    const feed = mergeChainFeed([
      m('run_1', 0, undefined, [entry('e1', { kind: 'tool_use', id: 't1', name: 'Read', input: {} }), entry('e2', { kind: 'tool_result', toolUseId: 't1', content: 'x', isError: false })]),
      m('run_2', 10, 'run_1', [entry('e1', { kind: 'tool_use', id: 't1', name: 'Read', input: {} })])
    ])
    const blocks = feed.flatMap((f) => (f.kind === 'entry' ? [f.entry.block] : []))
    expect(blocks[0].kind === 'tool_use' && blocks[0].id).toBe('run_1:t1')
    expect(blocks[1].kind === 'tool_result' && blocks[1].toolUseId).toBe('run_1:t1')
    expect(blocks[2].kind === 'tool_use' && blocks[2].id).toBe('t1')
  })

  it('drops the continuation notice only at a resumed member start and only for the harness system shape', () => {
    const feed = mergeChainFeed([
      m('run_1', 0, undefined, [note('keep-first-member')]),
      m('run_2', 10, 'run_1', [
        entry('a', { kind: 'text', text: 'a' }),
        entry('b', { kind: 'text', text: 'b' }),
        entry('c', { kind: 'text', text: 'c' }),
        note('late'),
        entry('x', { kind: 'system', text: 'Continued from run run_9' })
      ])
    ])
    const ids = feed.flatMap((f) => (f.kind === 'entry' ? [f.entry.id] : []))
    expect(ids).toContain('run_1:keep-first-member')
    expect(ids).toContain('late')
    expect(ids).toContain('x')
    const early = mergeChainFeed([m('run_1', 0, undefined, []), m('run_2', 10, 'run_1', [note('n'), entry('x', { kind: 'system', text: 'Continued from run run_1' })])])
    expect(early.flatMap((f) => (f.kind === 'entry' ? [f.entry.id] : []))).toEqual(['x'])
  })

  it('says Continued after OrgAI closed when the earlier session was cut', () => {
    const cut = { summary: { id: 'run_1', startedAt: 0, status: 'finished' as const, endedBy: 'app' as const }, entries: [] }
    const feed = mergeChainFeed([cut, m('run_2', 5, 'run_1', [])])
    const d = feed[0]
    expect(d.kind === 'divider' && d.divider.label).toBe('Continued after OrgAI closed')
  })
})

describe('humanizeToolUse', () => {
  it('names the harness tools in plain words', () => {
    expect(humanizeToolUse('mcp__orgai__ask_user', { question: 'Which DB?' }).label).toBe('Asked you: Which DB?')
    expect(humanizeToolUse('mcp__orgai__set_plan', { steps: [{}, {}, {}] }).label).toBe('Planned 3 steps')
    expect(humanizeToolUse('mcp__orgai__update_plan', {}).label).toBe('Updated the plan')
    expect(humanizeToolUse('mcp__orgai__request_permission_rules', {}).label).toBe('Asked for a permission rule')
    expect(humanizeToolUse('mcp__orgai__propose_mcp_servers', { servers: [1, 2] }).label).toBe('Proposed MCP servers (2)')
  })
  it('collapses the cross-run tools', () => {
    expect(humanizeToolUse('mcp__orgai__message_run', { runId: 'R2', message: 'hi' }).label).toBe('Sent a note to run R2')
    expect(humanizeToolUse('mcp__orgai__message_run', {}).label).toBe('Sent a note to another run')
    expect(humanizeToolUse('mcp__orgai__list_runs', {}).label).toBe('Listed runs')
  })
  it('describes file and shell tools', () => {
    expect(humanizeToolUse('Edit', { file_path: 'src/x.ts' }).label).toBe('Edited src/x.ts')
    expect(humanizeToolUse('Bash', { command: 'npm test' }).label).toBe('Ran `npm test`')
  })
  it('falls back to a readable label and keeps raw details', () => {
    const r = humanizeToolUse('mcp__foo__do_the_thing', { a: 1 })
    expect(r.label).toBe('Used do the thing')
    expect(r.details).toContain('"a": 1')
  })
})

describe('helpers', () => {
  it('strips the mcp prefix', () => expect(bareToolName('mcp__orgai__ask_user')).toBe('ask_user'))
  it('summarizes results', () => {
    expect(resultSummary('\n\nhello\nworld', false)).toBe('hello')
    expect(resultSummary('', true)).toBe('The tool failed')
  })
  it('words the auto-continue pill', () => {
    expect(autoContinueLine(true, 2, 40).pill).toBe('Auto-continued 2 times (limit 40)')
    expect(autoContinueLine(true, 1, 40).pill).toBe('Auto-continued 1 time (limit 40)')
    expect(autoContinueLine(false, 0, 40).pill).toBe('Auto-continue off')
  })
})

describe('humanizeToolResult', () => {
  it('shows harness results as short outcomes with the full text behind a disclosure', () => {
    const r = humanizeToolResult('mcp__orgai__request_permission_rules', 'APPROVED. Continue with the task now.', false)
    expect(r).toEqual({ label: 'Approved', full: 'APPROVED. Continue with the task now.' })
    expect(humanizeToolResult('mcp__orgai__complete_plan', 'Plan marked complete. Give the user your final report.', false)?.label).toBe('Plan marked complete')
    expect(humanizeToolResult('mcp__orgai__set_plan', 'Plan saved with 3 steps.', false)?.label).toBe('Plan saved')
    expect(humanizeToolResult('mcp__orgai__ask_user', 'Use postgres', false)?.label).toBe('Answered')
  })
  it('drops empty output but never an error', () => {
    expect(humanizeToolResult('Bash', '', false)).toBeNull()
    expect(humanizeToolResult('Bash', '  \n', false)).toBeNull()
    expect(humanizeToolResult('Bash', '', true)?.label).toBe('Failed: The tool failed')
  })
  it('leaves other tools alone', () => {
    expect(humanizeToolResult('Bash', 'ok', false)).toEqual({ label: 'ok', full: null })
    expect(humanizeToolResult(undefined, 'a\nb', false)).toEqual({ label: 'a', full: 'a\nb' })
  })
})
