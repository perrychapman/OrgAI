import { describe, expect, it } from 'vitest'
import type { FolderConfigReview, TeamFilesStatus } from '../../shared/types'
import { approvalItems, approvalsText, waitingNotice } from './approvals'

const status = (over: Partial<TeamFilesStatus> = {}): TeamFilesStatus => ({
  projectId: 'p1',
  projectName: 'App',
  state: 'pending',
  digest: 'ab'.repeat(32),
  isGitRepo: false,
  uncommitted: false,
  uncommittedFiles: [],
  changes: [
    { id: 'c0', kind: 'role', name: 'Lead', file: '.orgai/team.json', action: 'changed', summary: 'Lead may use the deep tier.', needsApproval: true, reason: 'May spend more' },
    { id: 'c1', kind: 'role', name: 'Reviewer', file: '.orgai/agents/reviewer.md', action: 'changed', summary: 'Reviewer gains Bash.', needsApproval: true, reason: 'New tools' }
  ],
  applied: [],
  problems: [],
  notes: [],
  warnings: [],
  ...over
})

const fc = (state: FolderConfigReview['state']): FolderConfigReview => ({ projectId: 'p3', state, digest: 'cd'.repeat(32), files: [], commands: [], env: [], allowRules: [], mcpServers: [], otherSettings: [], truncated: false })

describe('read-only /approvals', () => {
  it('lists pending team files of every project, then this project folder config when it is not allowed', () => {
    const items = approvalItems([status(), status({ projectId: 'p2', projectName: 'Other', state: 'problem', changes: [] }), status({ projectId: 'p4', state: 'in-sync', changes: [] })], { id: 'p3', name: 'Here', folderConfig: fc('changed') })
    expect(items.map((i) => [i.kind, i.projectId, i.label])).toEqual([
      ['teamFiles', 'p1', 'Team files of App: 2 changes wait for approval'],
      ['teamFiles', 'p2', 'Team files of Other: a file has a problem'],
      ['folderTrust', 'p3', 'Folder config of Here: changed since it was allowed']
    ])
    expect(approvalItems([], { id: 'p3', name: 'Here', folderConfig: fc('trusted') })).toEqual([])
    expect(approvalItems([], { id: 'p3', name: 'Here', folderConfig: fc('none') })).toEqual([])
  })

  it('the text shows the gate summary with "May spend more" first, what undo brings back, and ends with where and why', () => {
    const undone = status({
      undo: { at: 't', label: 'Undo approving 1 change', files: ['.orgai/agents/reviewer.md'] },
      undoChanges: [{ id: 'u1', kind: 'role', name: 'Reviewer', file: '.orgai/agents/reviewer.md', action: 'changed', summary: 'Reviewer loses Write.', needsApproval: true, toolsBefore: ['Read', 'Write'], toolsAfter: ['Read'] }]
    })
    const text = approvalsText(approvalItems([undone]))
    expect(text).toContain('1. May spend more: Lead may use the deep tier.')
    expect(text).toContain('2. Reviewer gains Bash. (New tools)')
    expect(text).toContain('Undo brings back:')
    expect(text).toContain('- Reviewer loses Write.')
    const last = text.split('\n').pop()
    expect(last).toBe('Approving is not available in the terminal yet: a terminal cannot yet prove that a person, not an agent, is answering.')
    // Nothing in it offers a key to decide.
    expect(text).not.toMatch(/type .* to approve|press a/i)
  })

  it('the notice on open', () => {
    expect(waitingNotice(approvalItems([status()], { id: 'p3', name: 'Here', folderConfig: fc('untrusted') }))).toBe(
      "Waiting for approval: team files of 1 project and this folder's own config. Type /approvals to read them."
    )
    expect(waitingNotice([])).toBeUndefined()
  })
})
