import { describe, expect, it } from 'vitest'
import { newRunLead, projectKindCopy, projectNoun, settingsApplyNoteFor } from './projectKindCopy'

describe('projectKindCopy', () => {
  it('keeps the code words', () => {
    const c = projectKindCopy('code')
    expect(c.architecture.stack).toBe('Stack')
    expect(c.architecture.risks).toBe('Risks and gaps')
    expect(c.architectureApplyNote).toContain('.orgai/ARCHITECTURE.md')
  })
  it('uses neutral engagement words', () => {
    const c = projectKindCopy('engagement')
    expect(c.architecture.modules).toBe('Workstreams')
    expect(c.architectureTitle).toBe('Approve engagement plan')
    expect(c.architectureApplyNote).toBe('Approving saves the engagement plan in OrgAI. Nothing is written to your folder.')
  })
  it('leads the engagement new-run page only', () => {
    expect(newRunLead('code', 'Lead')).toBeNull()
    expect(newRunLead('engagement', 'Lead')).toMatch(/^Give Lead a task\./)
  })
  it('says where allowed commands are saved by rules location', () => {
    expect(settingsApplyNoteFor('code', 'folder')).toContain('.claude/settings.local.json')
    expect(settingsApplyNoteFor('code', 'app')).toContain('saves any allowed commands in OrgAI, not in your folder.')
    expect(settingsApplyNoteFor('code', 'app')).not.toContain('settings.local')
    expect(settingsApplyNoteFor('engagement', 'app')).not.toContain('settings.local')
  })
  it('names the project per kind', () => {
    expect(projectNoun('engagement')).toBe('engagement')
    expect(projectNoun('code')).toBe('project')
  })
})
