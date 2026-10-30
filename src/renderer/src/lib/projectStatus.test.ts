import { describe, expect, it } from 'vitest'
import { projectStatus } from './projectStatus'

describe('projectStatus', () => {
  it('is quiet for a project with no runs', () => {
    expect(projectStatus({ open: 0, decisions: 0 })).toMatchObject({ dot: '', subtitle: '', needsLabel: '' })
  })
  it('shows a running dot and the open count', () => {
    expect(projectStatus({ open: 2, decisions: 0 })).toMatchObject({ dot: 'is-running', subtitle: '2 open' })
  })
  it('counts decisions, not runs, when something needs you', () => {
    const s = projectStatus({ open: 1, decisions: 3 })
    expect(s.dot).toBe('warn')
    expect(s.decisions).toBe(3)
    expect(s.subtitle).toBe('3 decisions · 1 run')
    expect(s.needsLabel).toBe('3 need you')
    expect(projectStatus({ open: 2, decisions: 1 })).toMatchObject({ subtitle: '1 decision · 2 runs', needsLabel: '1 needs you' })
  })
  it('reports the last run when nothing is open', () => {
    const now = 10_000_000
    const s = projectStatus({ open: 0, decisions: 0, newest: { startedAt: now - 2 * 3600_000, status: { word: 'Finished' } }, now })
    expect(s.subtitle).toMatch(/^Last run .* · Finished$/)
  })
})
