import { describe, expect, it } from 'vitest'
import { projectStatus } from './projectStatus'

describe('projectStatus', () => {
  it('is quiet for a project with no runs', () => {
    expect(projectStatus({ open: 0, needsYou: 0 })).toMatchObject({ dot: '', subtitle: '', needsLabel: '' })
  })
  it('shows a running dot and the open count', () => {
    expect(projectStatus({ open: 2, needsYou: 0 })).toMatchObject({ dot: 'is-running', subtitle: '2 open' })
  })
  it('warns when something needs you', () => {
    const s = projectStatus({ open: 2, needsYou: 2 })
    expect(s.dot).toBe('warn')
    expect(s.subtitle).toBe('2 open · 2 needs you')
    expect(s.needsLabel).toBe('2 need you')
    expect(projectStatus({ open: 1, needsYou: 1 }).needsLabel).toBe('1 needs you')
  })
  it('reports the last run when nothing is open', () => {
    const now = 10_000_000
    const s = projectStatus({ open: 0, needsYou: 0, newest: { startedAt: now - 2 * 3600_000, status: { word: 'Finished' } }, now })
    expect(s.subtitle).toMatch(/^Last run .* · Finished$/)
  })
})
