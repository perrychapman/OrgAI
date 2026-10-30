import { describe, expect, it } from 'vitest'
import { autoContinueLine, bareToolName, humanizeToolResult, humanizeToolUse, resultSummary } from './transcriptRows'

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
    expect(humanizeToolResult('Bash', '  
', false)).toBeNull()
    expect(humanizeToolResult('Bash', '', true)?.label).toBe('Failed: The tool failed')
  })
  it('leaves other tools alone', () => {
    expect(humanizeToolResult('Bash', 'ok', false)).toEqual({ label: 'ok', full: null })
    expect(humanizeToolResult(undefined, 'a
b', false)).toEqual({ label: 'a', full: 'a
b' })
  })
})
