import { describe, expect, it } from 'vitest'
import { diffSkillsProposal, skillRowVerb, skillRowView, type SkillCurrent, type SkillRowItem } from './skillProposal'

const current: SkillCurrent = {
  roles: [
    { id: 'r1', slug: 'orchestrator', name: 'Orchestrator', skills: ['s-mock', 's-notes'] },
    { id: 'r2', slug: 'implementer', name: 'Implementer', skills: ['s-notes'] },
    { id: 'r3', slug: 'reviewer', name: 'Reviewer' },
    { id: 'r4', slug: 'researcher', name: 'Researcher' }
  ],
  skills: [
    { id: 's-mock', name: 'mock-skill' },
    { id: 's-notes', name: 'release-notes', libraryId: 'lib-notes' },
    { id: 's-other', name: 'other' },
    { id: 's-more', name: 'more' },
    { id: 's-extra', name: 'extra' }
  ]
}
const item = (o: Partial<SkillRowItem> & { name: string }): SkillRowItem => ({ action: 'create', scope: 'project', draft: { name: o.name, body: 'Do the thing.' }, ...o })

describe('skillRowView', () => {
  it('create: New, who loads it', () => {
    const v = skillRowView(item({ name: 'fresh', roles: ['orchestrator', 'implementer'] }), current)
    expect(v).toMatchObject({ group: 'create', badge: { text: 'New', tone: 'success' }, line1: null, line2: 'Who loads it: Orchestrator, Implementer', showBody: true })
    expect(skillRowView(item({ name: 'fresh' }), current).line2).toBe('Who loads it: no role yet')
    expect(skillRowView(item({ name: 'fresh', scope: 'library' }), current).line2).toBeNull()
  })
  it('link: From library with sync note', () => {
    const v = skillRowView(item({ action: 'link', name: 'review-checklist', roles: ['reviewer'] }), current)
    expect(v.badge).toEqual({ text: 'From library', tone: 'info' })
    expect(v.line1).toBe('Use review-checklist from your library in this project')
    expect(v.line2).toBe('Who loads it: Reviewer')
    expect(v.note).toBe('Kept in sync with the library; edit it there.')
    expect(v.showBody).toBe(false)
  })
  it('grant: adds, removes, keeps; no instructions', () => {
    const v = skillRowView(item({ action: 'grant', name: 'release-notes', roles: ['orchestrator', 'reviewer'] }), current)
    expect(v.badge).toEqual({ text: 'Access', tone: 'warning' })
    expect(v.line1).toBe('Change who loads release-notes')
    expect(v.line2).toBe('Adds: Reviewer. Removes: Implementer. Keeps: Orchestrator.')
    expect(v.note).toBe('Instructions unchanged.')
    expect(v.showBody).toBe(false)
  })
  it('update: was, show changes', () => {
    const v = skillRowView(item({ action: 'update', name: 'mock-skill', roles: ['researcher'] }), current)
    expect(v.badge).toEqual({ text: 'Changed', tone: 'warning' })
    expect(v.line1).toBe('Instructions changed')
    expect(v.line2).toBe('Who loads it: Researcher (was Orchestrator)')
    expect(v.showChanges).toBe(true)
    expect(skillRowView(item({ action: 'update', name: 'mock-skill', roles: ['orchestrator'] }), current).line2).toBe('Who loads it: Orchestrator')
    expect(skillRowView(item({ action: 'update', name: 'mock-skill' }), current).line2).toBe('Who loads it: Orchestrator')
  })
  it('grant: enabled and unchanged roles', () => {
    const off = skillRowView(item({ action: 'grant', name: 'mock-skill', enabled: false }), current)
    expect(off.stateLine).toBe('Turned off for now')
    expect(off.line2).toBe('Role access unchanged.')
    expect(skillRowView(item({ action: 'grant', name: 'mock-skill', enabled: true, roles: [] }), current)).toMatchObject({ stateLine: 'On', line2: 'Removes: Orchestrator.' })
    expect(skillRowView(item({ action: 'create', name: 'x' }), current).stateLine).toBeNull()
  })
  it('update with no body: instructions unchanged, no diff', () => {
    const v = skillRowView(item({ action: 'update', name: 'mock-skill', draft: { name: 'mock-skill', body: '' } }), current)
    expect(v).toMatchObject({ line1: 'Instructions unchanged', showBody: false, showChanges: false })
    expect(skillRowView(item({ action: 'update', name: 'mock-skill', draft: { name: 'mock-skill', body: 'new' } }), current).showChanges).toBe(true)
  })
  it('library update points to the library', () => {
    const v = skillRowView(item({ action: 'update', name: 'x', scope: 'library', draft: { name: 'x', body: 'b' } }), current)
    expect(v.note).toBe('Compare it in the Skill library.')
    expect(v.showChanges).toBe(false)
  })
  it('remove: who loses it, linked note, no instructions', () => {
    const v = skillRowView(item({ action: 'remove', name: 'release-notes' }), current)
    expect(v.badge).toEqual({ text: 'Remove', tone: 'danger' })
    expect(v.line1).toBe('Remove release-notes from this project')
    expect(v.line2).toBe('Orchestrator and Implementer will no longer load it.')
    expect(v.note).toBe('Unlinks it; the library entry stays.')
    expect(v.showBody).toBe(false)
    expect(skillRowView(item({ action: 'remove', name: 'other' }), current).line2).toBe('No role loads it now.')
  })
})

describe('diffSkillsProposal', () => {
  it('orders groups and summarises with unchanged skills', () => {
    const items = [
      item({ action: 'remove', name: 'other' }),
      item({ action: 'update', name: 'mock-skill', roles: ['researcher'] }),
      item({ action: 'grant', name: 'release-notes', roles: ['reviewer'] }),
      item({ action: 'link', name: 'lib-skill' }),
      item({ action: 'create', name: 'fresh' })
    ]
    const d = diffSkillsProposal(items, current)
    expect(d.rows.map((r) => r.view.group)).toEqual(['create', 'link', 'grant', 'update', 'remove'])
    expect(d.summary).toBe('1 new, 1 linked, 1 access change, 1 changed, 1 removed; 2 skills unchanged')
    expect(d.rows.map((r) => skillRowVerb(r.item, r.view))).toEqual(['new fresh', 'link lib-skill', 'access to release-notes', 'update mock-skill', 'remove other'])
  })
  it('omits the unchanged part for a library proposal', () => {
    const d = diffSkillsProposal([item({ name: 'x', scope: 'library' })], current)
    expect(d.summary).toBe('1 new')
    expect(d.untouched).toBeNull()
  })
})
