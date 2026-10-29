import { describe, expect, it } from 'vitest'
import { architectRole } from '@shared/setup'
import { buildRolePrompt, canWrite, composeFirstMessage, isArchitectureFile } from './prompts'
import { orgChart, project } from './testHelpers'

const withArch = project({ brief: '  A todo app.  ', setup: { kind: 'existing', state: 'complete', architecturePath: '.orgai/ARCHITECTURE.md' } })

describe('buildRolePrompt', () => {
  const roles = orgChart()
  const [lead, eng, rev] = roles

  it('lists the reports the root may delegate to', () => {
    const text = buildRolePrompt(lead, roles, project(), { isSetup: false, isolation: false })
    expect(text.startsWith('You are lead.')).toBe(true)
    expect(text).toContain('You lead the following specialists.')
    expect(text).toContain('- engineer: engineer description')
    expect(text).toContain('- reviewer: reviewer description')
    expect(text).not.toContain('Parallel work is safe')
  })

  it('adds the orchestrator isolation paragraph only with isolation', () => {
    const text = buildRolePrompt(lead, roles, project(), { isSetup: false, isolation: true })
    expect(text).toContain('Parallel work is safe')
    expect(text).toContain('call integrate_worktrees to retry')
  })

  it('tells writing reports about their worktree, but not read-only ones', () => {
    expect(buildRolePrompt(eng, roles, project(), { isSetup: false, isolation: true })).toContain('You work in an isolated git worktree')
    expect(buildRolePrompt(rev, roles, project(), { isSetup: false, isolation: true })).not.toContain('isolated git worktree')
    expect(buildRolePrompt(eng, roles, project(), { isSetup: false, isolation: false })).not.toContain('isolated git worktree')
  })

  it('tells an isolated lead that its reports merge into its worktree and to verify', () => {
    const mid = { ...eng, id: 'r-mid', slug: 'midlead', canSpawn: true, spawnable: ['r-eng', 'r-rev'] }
    const chart = [lead, mid, eng, rev]
    const text = buildRolePrompt(mid, chart, project(), { isSetup: false, isolation: true })
    expect(text).toContain('You work in an isolated git worktree')
    expect(text).toContain('the harness merges its branch into your worktree automatically')
    expect(text).toContain('verify the combined result in your worktree')
    expect(buildRolePrompt(eng, roles, project(), { isSetup: false, isolation: true })).not.toContain('into your worktree automatically')
    expect(buildRolePrompt(mid, chart, project(), { isSetup: false, isolation: false })).not.toContain('into your worktree automatically')
  })

  it('gives leaf roles the no-reports instruction on work runs', () => {
    expect(buildRolePrompt(eng, roles, project(), { isSetup: false, isolation: false })).toContain('You have no reports.')
  })

  it('adds the architecture document, the drift line for the root, and the brief', () => {
    const root = buildRolePrompt(lead, roles, withArch, { isSetup: false, isolation: false })
    expect(root).toContain('The agreed architecture and conventions live in .orgai/ARCHITECTURE.md.')
    expect(root).toContain('update .orgai/ARCHITECTURE.md in the same run')
    expect(root.endsWith('About this project:\nA todo app.')).toBe(true)
    const report = buildRolePrompt(eng, roles, withArch, { isSetup: false, isolation: false })
    expect(report).toContain('The agreed architecture and conventions live in')
    expect(report).not.toContain('in the same run so it stays true')
  })

  it('keeps setup prompts free of work-run paragraphs', () => {
    const architect = architectRole()
    const text = buildRolePrompt(architect, [architect], withArch, { isSetup: true, isolation: false })
    expect(text).toContain('Your responsibilities:\n- Understand the project idea or the existing codebase')
    expect(text).not.toContain('You have no reports')
    expect(text).not.toContain('About this project')
    expect(text).not.toContain('ARCHITECTURE.md. Read it before')
  })

  it('separates paragraphs with blank lines', () => {
    const parts = buildRolePrompt(lead, roles, withArch, { isSetup: false, isolation: true }).split('\n\n')
    // prompt, reports, isolation, architecture, drift, org-change guidance, brief
    expect(parts).toHaveLength(7)
  })
})

describe('helpers', () => {
  it('canWrite looks for editing tools', () => {
    const [lead, eng] = orgChart()
    expect(canWrite(lead)).toBe(false)
    expect(canWrite(eng)).toBe(true)
  })

  it('composeFirstMessage appends hidden context', () => {
    expect(composeFirstMessage('Hi')).toBe('Hi')
    expect(composeFirstMessage('Hi', 'profile')).toBe('Hi\n\n---\nContext from the harness (not visible to the user):\nprofile')
  })

  it('isArchitectureFile matches in the main checkout and in worktrees', () => {
    expect(isArchitectureFile('.orgai/ARCHITECTURE.md', '.orgai/ARCHITECTURE.md')).toBe(true)
    expect(isArchitectureFile('C:\\repo\\.claude\\worktrees\\agent-1\\.orgai\\architecture.md', '.orgai/ARCHITECTURE.md')).toBe(true)
    expect(isArchitectureFile('/repo/docs/ARCHITECTURE.md', '.orgai/ARCHITECTURE.md')).toBe(false)
    expect(isArchitectureFile(undefined, '.orgai/ARCHITECTURE.md')).toBe(false)
  })
})
