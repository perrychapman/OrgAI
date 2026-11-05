import { describe, expect, it } from 'vitest'
import type { TeamFileChange, TeamFilesStatus } from '@shared/types'
import {
  PROBLEM_NEXT,
  statusKey,
  teamPointerText,
  undoIsApplied,
  undoNoticeLead,
  appliedSummaries,
  approveBlockedReason,
  approvalCount,
  cardTitle,
  cardVisible,
  APPROVE_UNLOCKED_TEXT,
  changeHasHidden,
  dismissedUndoAt,
  elevatedLine,
  importSourcesFor,
  isStaleDecision,
  listFiles,
  reachLine,
  rememberDismissedUndo,
  secretsLine,
  teamAttentionItems,
  teamFilesLine,
  toolsAddedLine,
  undoRewritesLine,
  undoneLine
} from './teamFiles'
import { hasHidden } from './hiddenChars'

function change(p: Partial<TeamFileChange> = {}): TeamFileChange {
  return { id: 'role:a:tools', kind: 'role', name: 'Reviewer', file: '.orgai/agents/reviewer.md', action: 'changed', summary: 'Reviewer gains Bash.', needsApproval: true, ...p }
}

function status(p: Partial<TeamFilesStatus> = {}): TeamFilesStatus {
  return {
    projectId: 'p1',
    projectName: 'Alpha',
    state: 'in-sync',
    isGitRepo: true,
    uncommitted: false,
    uncommittedFiles: [],
    changes: [],
    applied: [],
    problems: [],
    notes: [],
    warnings: [],
    ...p
  }
}

describe('teamFilesLine', () => {
  it('in sync says where the files are', () => {
    expect(teamFilesLine(status())).toMatchObject({ tone: 'quiet', text: 'Team files: in sync', detail: '.orgai/ in this repository.' })
    expect(teamFilesLine(status({ isGitRepo: false }))?.detail).toBe('.orgai/ in this folder.')
  })
  it('uncommitted offers Commit only inside git, and never says push', () => {
    const l = teamFilesLine(status({ uncommitted: true, uncommittedFiles: ['.orgai/team.json'] }))
    expect(l).toMatchObject({ tone: 'attention', text: 'Team files changed, not committed', action: 'commit' })
    expect(l?.title).toContain('.orgai/team.json')
    expect(JSON.stringify(l)).not.toMatch(/push/i)
    expect(teamFilesLine(status({ uncommitted: true, isGitRepo: false }))?.action).toBeUndefined()
  })
  it('pending counts approvals plus the omitted ones', () => {
    const s = status({ state: 'pending', changes: [change(), change({ id: 'b' }), change({ id: 'c', needsApproval: false })], omittedChanges: 2 })
    expect(approvalCount(s)).toBe(4)
    expect(teamFilesLine(s)).toMatchObject({ text: 'Team files: 4 changes need your approval', action: 'review' })
    expect(teamFilesLine(status({ state: 'pending', changes: [change()] }))?.text).toBe('Team files: 1 change needs your approval')
  })
  it('a problem names the file and keeps the team in use', () => {
    const l = teamFilesLine(status({ state: 'problem', problems: [{ file: '.orgai/team.json', message: 'It has merge conflict markers.' }] }))
    expect(l).toMatchObject({ tone: 'danger', text: 'Team files: .orgai/team.json cannot be read' })
    expect(l?.detail).toContain('merge conflict markers')
    expect(l?.action).toBeUndefined()
    expect(teamFilesLine(status({ state: 'problem', problems: [{ file: 'a', message: 'm' }], changes: [change()] }))?.action).toBe('review')
  })
  it('rejected states the plain fact', () => {
    const l = teamFilesLine(status({ state: 'rejected' }))
    expect(l?.text).toBe('Team files: differ from the team in use')
    expect(l?.detail).toContain('last approved team')
    expect(l?.detail).toContain('asks again when the files change')
  })
  it('off depends on the reason', () => {
    expect(teamFilesLine(status({ state: 'off', offReason: 'engagement' }))).toBeNull()
    expect(teamFilesLine(status({ state: 'off', offReason: 'virtual' }))).toBeNull()
    expect(teamFilesLine(status({ state: 'off', offReason: 'removed' }))).toMatchObject({ action: 'enable' })
    expect(teamFilesLine(status({ state: 'off', offReason: 'shared-folder', sharedWith: { projectId: 'p2', projectName: 'Beta' } }))?.detail).toBe(
      "The team files of this folder belong to Beta; this project keeps its team in OrgAI's data folder."
    )
    expect(teamFilesLine(status({ state: 'off', offReason: 'no-folder' }))?.action).toBeUndefined()
    expect(teamFilesLine(status({ state: 'off', offReason: 'not-written' }))?.action).toBeUndefined()
  })
})

describe('approval card helpers', () => {
  it('shows for pending, and for a problem that lists changes', () => {
    expect(cardVisible(undefined)).toBe(false)
    expect(cardVisible(status({ state: 'pending' }))).toBe(true)
    expect(cardVisible(status({ state: 'problem' }))).toBe(false)
    expect(cardVisible(status({ state: 'problem', changes: [change()] }))).toBe(true)
    expect(cardVisible(status({ state: 'rejected', changes: [change()] }))).toBe(false)
  })
  it('blocks Approve with a reason, never Reject', () => {
    expect(approveBlockedReason(status({ state: 'pending', digest: 'd' }))).toBeNull()
    expect(approveBlockedReason(status({ state: 'pending', digest: 'd', omittedChanges: 3 }))).toBe('3 more changes are not listed. Too many changes to review at once.')
    expect(approveBlockedReason(status({ state: 'pending', digest: 'd', omittedChanges: 1 }))).toBe('1 more change is not listed. Too many changes to review at once.')
    expect(approveBlockedReason(status({ state: 'problem', digest: 'd', problems: [{ file: 'x.md', message: 'm' }] }))).toContain('x.md cannot be read')
    expect(approveBlockedReason(status({ state: 'pending' }))).not.toBeNull()
  })
  it('titles count the omitted changes', () => {
    expect(cardTitle(status({ changes: [change(), change({ id: 'b' })], omittedChanges: 3 }))).toBe('Team files: 5 changes to review')
  })
  it('stale decisions are recognised', () => {
    expect(isStaleDecision(new Error("Error invoking remote method 'teamFiles:approve': Error: The files changed. Review them again."))).toBe(true)
    expect(isStaleDecision(new Error('disk full'))).toBe(false)
  })
})

describe('change wording', () => {
  it('tools, elevated, secrets and reach', () => {
    expect(toolsAddedLine(change({ toolsAdded: ['Bash', 'Write'] }))).toBe('New tools: Bash, Write.')
    expect(toolsAddedLine(change())).toBeNull()
    expect(elevatedLine(change({ elevatedAdded: ['Bash', 'canSpawn'] }))).toBe('Can now run commands and start other agents.')
    expect(elevatedLine(change({ elevatedAdded: ['Bash', 'Edit', 'canSpawn'] }))).toBe('Can now run commands, edit files and start other agents.')
    expect(secretsLine(change({ kind: 'mcp', secretNames: ['GITHUB_TOKEN'] }))).toBe('Needs this value on this computer: GITHUB_TOKEN.')
    expect(reachLine(change({ kind: 'mcp' }))).toBe('Every role can use it.')
    expect(reachLine(change({ kind: 'mcp', reachesRoles: ['reviewer', 'dev'] }))).toBe('Limited to: reviewer, dev.')
    expect(reachLine(change({ kind: 'role' }))).toBeNull()
    expect(reachLine(change({ kind: 'mcp', action: 'removed' }))).toBeNull()
  })
  it('flags hidden characters anywhere in a change, including the full target', () => {
    expect(changeHasHidden(change(), hasHidden)).toBe(false)
    expect(changeHasHidden(change({ kind: 'mcp', target: 'npx‮ server' }), hasHidden)).toBe(true)
    expect(changeHasHidden(change({ after: 'ok​prompt' }), hasHidden)).toBe(true)
    expect(changeHasHidden(change({ toolsBefore: ['Read', 'Ba‮sh'] }), hasHidden)).toBe(true)
    expect(changeHasHidden(change({ toolsAfter: ['Wri​te'] }), hasHidden)).toBe(true)
    expect(changeHasHidden(change({ elevatedAdded: ['Ba‮sh'] }), hasHidden)).toBe(true)
    expect(changeHasHidden(change({ toolsBefore: ['Read'], toolsAfter: ['Read', 'Bash'], elevatedAdded: ['Bash'] }), hasHidden)).toBe(false)
  })
  it('says once that Approve is available', () => {
    expect(APPROVE_UNLOCKED_TEXT).toBe('You have seen every change. Approve is available.')
  })
})

describe('applied notice', () => {
  it('names the changes and what Undo rewrites', () => {
    const s = status({ applied: [change({ summary: 'A.' }), change({ id: 'b', summary: 'B.' }), change({ id: 'c', summary: 'C.' }), change({ id: 'd', summary: 'D.' }), change({ id: 'e', summary: 'E.' })] })
    expect(appliedSummaries(s)).toEqual(['A.', 'B.', 'C.', 'D.', 'and 1 more.'])
    expect(undoRewritesLine(['.orgai/team.json', '.orgai/agents/a.md'])).toBe('Undo rewrites .orgai/team.json, .orgai/agents/a.md. They then show as uncommitted.')
    expect(undoneLine(['.orgai/team.json'])).toBe('Undone. Rewrote .orgai/team.json. They now show as uncommitted.')
    expect(listFiles(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more')
  })
  it('remembers a dismissal by change time', () => {
    const mem = new Map<string, string>()
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) }
    expect(dismissedUndoAt(storage, 'p1')).toBeNull()
    rememberDismissedUndo(storage, 'p1', '2026-11-05T10:00:00Z')
    expect(dismissedUndoAt(storage, 'p1')).toBe('2026-11-05T10:00:00Z')
    expect(dismissedUndoAt(storage, 'p2')).toBeNull()
  })
})

describe('import sources', () => {
  it('drops .orgai agents while team files are on', () => {
    const sources = [{ source: 'orgai' }, { source: 'claude' }]
    expect(importSourcesFor(sources, true)).toEqual([{ source: 'claude' }])
    expect(importSourcesFor(sources, false)).toHaveLength(2)
  })
})

describe('teamAttentionItems', () => {
  it('still lists pending and problem projects by name', () => {
    const items = teamAttentionItems([status({ projectName: 'Zed', projectId: 'z', state: 'pending', changes: [change()] }), status({ projectName: 'Alpha', state: 'problem', problems: [{ file: 'f', message: 'm' }] })])
    expect(items.map((i) => i.projectName)).toEqual(['Alpha', 'Zed'])
  })
  it('shows hidden characters escaped in the label and the project name', () => {
    const [item] = teamAttentionItems([status({ projectName: 'P‮Q', state: 'problem', problems: [{ file: 'a‮b.md', message: 'm' }] })])
    expect(item.label).toBe('Team files: a\\u202eb.md cannot be read')
    expect(item.projectName).toBe('P\\u202eQ')
  })
})

describe('status messages and the Live pointer', () => {
  it('statusKey changes with state, digest and commit state, not with identical pushes', () => {
    const a = status({ state: 'pending', digest: 'd1', changes: [change()] })
    expect(statusKey(a)).toBe(statusKey(status({ state: 'pending', digest: 'd1', changes: [change()] })))
    expect(statusKey(a)).not.toBe(statusKey(status({ state: 'pending', digest: 'd2', changes: [change()] })))
    expect(statusKey(a)).not.toBe(statusKey(status({ state: 'in-sync' })))
    expect(statusKey(undefined)).toBe('')
  })
  it('a problem line names a next step', () => {
    const l = teamFilesLine(status({ state: 'problem', problems: [{ file: 'f.md', message: 'It has merge conflict markers.' }] }))
    expect(l?.detail).toContain('It has merge conflict markers.')
    expect(l?.detail).toContain(PROBLEM_NEXT)
  })
  it('the undo lead follows the undo, not the older applied batch', () => {
    const s = status({ undo: { at: 't', label: 'Undo approving 1 change', files: ['.orgai/agents/lead.md'] }, applied: [change()] })
    expect(undoNoticeLead(s)).toBe('Approved 1 change.')
    expect(undoIsApplied(s)).toBe(false)
    const t = status({ undo: { at: 't', label: 'Undo the 1 change applied from the files', files: ['x'] }, applied: [change()] })
    expect(undoIsApplied(t)).toBe(true)
    expect(undoNoticeLead(t)).toBe('1 change applied from the team files.')
  })
  it('the pointer speaks only while something waits', () => {
    expect(teamPointerText(status({ state: 'in-sync' }))).toBeNull()
    expect(teamPointerText(status({ state: 'pending', changes: [change()] }))).toContain('needs your approval')
    expect(teamPointerText(status({ state: 'problem' }))).toContain('cannot be read')
  })
})
