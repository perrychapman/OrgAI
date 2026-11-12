import { describe, expect, it } from 'vitest'
import type { ScheduleProposalItem } from '@shared/types'
import { anyUnattended, existingName, scheduleItemView } from './scheduleProposal'

const projects = [{ id: 'p1', name: 'Notes API' }]
const create: ScheduleProposalItem = {
  action: 'create',
  summary: 'Adds a nightly review.',
  nextRuns: [Date.UTC(2030, 0, 1, 8), Date.UTC(2030, 0, 2, 8)],
  schedule: { name: 'Nightly review', prompt: 'Review new pull requests.', target: { kind: 'team', projectId: 'p1' }, timing: { kind: 'daily', time: '08:00' }, budgetUsd: 5 }
}

describe('scheduleItemView', () => {
  it('lists the fields of a create item in words', () => {
    const v = scheduleItemView(create, undefined, projects)
    expect(v.actionText).toBe('New schedule')
    expect(v.name).toBe('Nightly review')
    expect(v.rows.map((r) => r.key)).toEqual(['prompt', 'target', 'timing', 'next', 'missed', 'model', 'permission', 'budget'])
    expect(v.rows.find((r) => r.key === 'model')?.value).toBe("The project's model")
    expect(v.rows.find((r) => r.key === 'target')?.value).toBe('Team run on Notes API')
    expect(v.rows.find((r) => r.key === 'permission')?.value).toBe("The project's mode")
    expect(v.rows.find((r) => r.key === 'budget')?.value).toBe('$5.00 per run')
    expect(v.rows.find((r) => r.key === 'missed')?.value).toBe('Run once when OrgAI is next open')
    expect((v.rows.find((r) => r.key === 'next')?.value as string[]).length).toBe(2)
    expect(v.unattended).toBe(true)
    expect(v.hidden).toBe(false)
  })
  it('shows a Chat target with its full folder, model and Chat defaults', () => {
    const v = scheduleItemView({ ...create, schedule: { ...create.schedule!, target: { kind: 'ask', folder: 'C:/work/reports' }, modelSelection: { model: 'm-1', connection: 'default' }, budgetUsd: undefined } }, undefined, projects)
    expect(v.rows.find((r) => r.key === 'folder')?.value).toBe('C:/work/reports')
    expect(v.rows.find((r) => r.key === 'model')?.value).toMatch(/^m-1 \(/)
    expect(v.rows.find((r) => r.key === 'permission')?.value).toBe('Chat default')
    expect(v.rows.find((r) => r.key === 'budget')?.value).toBe('No cap of its own')
  })
  it('names the permission mode and the missed policy', () => {
    const v = scheduleItemView({ ...create, schedule: { ...create.schedule!, permissionMode: 'plan', missed: 'skip' } }, undefined, projects)
    expect(v.rows.find((r) => r.key === 'permission')?.value).not.toBe("The project's mode")
    expect(v.rows.find((r) => r.key === 'missed')?.value).toBe('Skip missed runs')
  })
  it('names an existing schedule for pause, remove and resume', () => {
    const existing = [{ id: 's1', name: 'Docs sync' }]
    const pause = scheduleItemView({ action: 'pause', scheduleId: 's1', summary: 'Pauses it.', nextRuns: [] }, existing, projects)
    expect(pause.name).toBe('Docs sync')
    expect(pause.rows).toEqual([])
    expect(pause.unattended).toBe(false)
    const resume = scheduleItemView({ action: 'resume', scheduleId: 's1', summary: 'Resumes it.', nextRuns: [Date.UTC(2030, 0, 1, 8)] }, existing, projects)
    expect(resume.rows.map((r) => r.key)).toEqual(['next'])
    expect(resume.unattended).toBe(true)
  })
  it('keeps the summary only when the existing schedule is unknown', () => {
    const v = scheduleItemView({ action: 'remove', scheduleId: 'gone', summary: 'Deletes it.', nextRuns: [] }, undefined, projects)
    expect(v.name).toBeNull()
    expect(v.summary).toBe('Deletes it.')
    expect(existingName({ action: 'remove', scheduleId: 'gone', summary: '', nextRuns: [] }, [])).toBeNull()
  })
  it('flags hidden characters in agent text', () => {
    const v = scheduleItemView({ ...create, schedule: { ...create.schedule!, prompt: 'Review a‮b' } }, undefined, projects)
    expect(v.hidden).toBe(true)
  })
})

describe('anyUnattended', () => {
  it('is false for pause and remove only', () => {
    expect(anyUnattended([{ action: 'pause', scheduleId: 'a', summary: '', nextRuns: [] }, { action: 'remove', scheduleId: 'b', summary: '', nextRuns: [] }])).toBe(false)
    expect(anyUnattended([create])).toBe(true)
  })
})
