import { describe, expect, it } from 'vitest'
import { autoContinueLine, bareToolName, humanizeToolUse, resultSummary } from './transcriptRows'

describe('humanizeToolUse', () => {
  it('names the harness tools in plain words', () => {
    expect(humanizeToolUse('mcp__orgai__ask_user', { question: 'Which DB?' }).label).toBe('Asked you: Which DB?')
    expect(humanizeToolUse('mcp__orgai__set_plan', { steps: [{}, {}, {}] }).label).toBe('Planned 3 steps')
    expect(humanizeToolUse('mcp__orgai__update_plan', {}).label).toBe('Updated the plan')
    expect(humanizeToolUse('mcp__orgai__request_permission_rules', {}).label).toBe('Asked for a permission rule')
    expect(humanizeToolUse('mcp__orgai__propose_mcp_servers', { servers: [1, 2] }).label).toBe('Proposed MCP servers (2)')
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
