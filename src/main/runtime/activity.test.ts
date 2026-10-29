import { describe, expect, it } from 'vitest'
import { PROPOSAL_TOOLS } from '@shared/setup'
import { describeTool, harnessToolActivity } from './activity'

describe('describeTool', () => {
  it.each([
    ['Read', { file_path: '/repo/src/app.ts' }, 'Reading app.ts'],
    ['Edit', { file_path: 'src/lib/app.ts' }, 'Editing app.ts'],
    ['Write', { file_path: 'README.md' }, 'Writing README.md'],
    ['NotebookEdit', { notebook_path: '/n/a.ipynb' }, 'Editing notebook a.ipynb'],
    ['Bash', { command: 'npm   run\n  build' }, '$ npm run build'],
    ['Grep', { pattern: 'TODO' }, 'Searching for "TODO"'],
    ['Glob', { pattern: 'src/**/*.ts' }, 'Finding src/**/*.ts'],
    ['WebSearch', { query: 'zod v4' }, 'Searching the web: zod v4'],
    ['WebFetch', { url: 'https://example.com' }, 'Fetching https://example.com'],
    ['Agent', { subagent_type: 'engineer' }, 'Delegating to engineer'],
    ['Task', {}, 'Delegating to a subagent'],
    ['TodoWrite', {}, 'Updating task list'],
    ['mcp__other__thing', {}, 'Using mcp__other__thing']
  ])('%s', (name, input, expected) => {
    expect(describeTool(name, input)).toBe(expected)
  })

  it('truncates long shell commands to 70 characters', () => {
    const text = describeTool('Bash', { command: 'x'.repeat(200) })
    expect(text).toBe(`$ ${'x'.repeat(70)}`)
  })

  it('tolerates missing input', () => {
    expect(describeTool('Read', undefined)).toBe('Reading ')
    expect(describeTool('Bash', null)).toBe('$ ')
  })

  it('labels harness tools by bare name', () => {
    expect(describeTool(PROPOSAL_TOOLS.architecture, {}, { harness: true })).toBe('Proposing the architecture…')
    expect(describeTool(PROPOSAL_TOOLS.question, {}, { harness: true })).toBe('Asking you a question…')
    expect(describeTool('integrate_worktrees', {}, { harness: true })).toBe('Talking to the harness')
    expect(harnessToolActivity(PROPOSAL_TOOLS.complete)).toBe('Wrapping up setup…')
  })

  it('does not treat a bare non-harness call as a harness tool', () => {
    expect(describeTool(PROPOSAL_TOOLS.architecture, {})).toBe('Using propose_architecture')
  })
})
