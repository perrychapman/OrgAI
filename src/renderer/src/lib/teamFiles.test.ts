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
  teamFilesChip,
  teamFilesPopoverSentence,
  commitConfirmText,
  COMMIT_CONFIRM_LIST_MAX,
  COMMIT_CONFIRM_NOTE,
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
    expect(l).toMatchObject({ tone: 'attention', text: 'Team files: not committed yet', action: 'commit' })
    // A fresh project's files are new, not edited: the line never says "changed".
    expect(l?.text).not.toMatch(/changed/i)
    expect(l?.title).toContain('.orgai/team.json')
    expect(JSON.stringify(l)).not.toMatch(/push/i)
    expect(teamFilesLine(status({ uncommitted: true, isGitRepo: false }))?.action).toBeUndefined()
  })
  it('the commit confirmation names the files, caps the list and says when the count is a lower bound', () => {
    const one = commitConfirmText({ uncommittedFiles: ['.orgai/team.json'] }, 200)
    expect(one).toEqual({
      title: 'Commit 1 team file?',
      lead: 'This makes one commit in your repository with these files:',
      files: ['.orgai/team.json'],
      more: 0,
      warnings: [],
      moreWarnings: 0,
      confirmLabel: 'Commit 1 file'
    })
    const many = Array.from({ length: 15 }, (_, i) => `.orgai/agents/r${i}.md`)
    const m = commitConfirmText({ uncommittedFiles: many }, 200)
    expect(m).toMatchObject({ title: 'Commit 15 team files?', confirmLabel: 'Commit 15 files' })
    expect(m.files).toHaveLength(COMMIT_CONFIRM_LIST_MAX)
    expect(COMMIT_CONFIRM_LIST_MAX).toBe(8)
    expect(m.more).toBe(15 - COMMIT_CONFIRM_LIST_MAX)
    expect(commitConfirmText({ uncommittedFiles: many }, 15)).toMatchObject({ title: 'Commit at least 15 team files?', confirmLabel: 'Commit team files' })
    expect(commitConfirmText({ uncommittedFiles: [] }, 200)).toMatchObject({ title: 'Commit team files?', files: [], more: 0 })
    // Review M2: the footnote promises what main does (re-reads git at commit time), not "only these files".
    expect(COMMIT_CONFIRM_NOTE).toBe(
      'OrgAI commits the team files git reports as changed when you confirm, and only team files. Anything else you staged stays staged. Nothing is pushed.'
    )
    expect(COMMIT_CONFIRM_NOTE).not.toMatch(/Only these files/)
  })
  it('QA S2: the confirmation repeats the warnings; without warnings it lists none', () => {
    const files = ['.orgai/team.json', '.orgai/agents/dev.md']
    const plain = commitConfirmText({ uncommittedFiles: files, warnings: [] }, 200)
    expect(plain.warnings).toEqual([])
    expect(plain.confirmLabel).toBe('Commit 2 files')
    const warned = commitConfirmText(
      { uncommittedFiles: files, warnings: [{ file: '.orgai/agents/dev.md', message: 'It has text that looks like a key. Keys must not be committed.' }] },
      200
    )
    expect(warned.warnings).toEqual([{ file: '.orgai/agents/dev.md', message: 'It has text that looks like a key. Keys must not be committed.' }])
    expect(warned.confirmLabel).toBe('Commit 2 files')
    const many = Array.from({ length: 15 }, (_, i) => ({ file: `.orgai/agents/r${i}.md`, message: 'm' }))
    const capped = commitConfirmText({ uncommittedFiles: [], warnings: many }, 200)
    expect(capped.warnings).toHaveLength(COMMIT_CONFIRM_LIST_MAX)
    expect(capped.moreWarnings).toBe(15 - COMMIT_CONFIRM_LIST_MAX)
  })
  it('the chip never shouts on an untouched project and follows the 1.4 table', () => {
    expect(teamFilesChip(undefined)).toBeNull()
    expect(teamFilesChip(status())).toEqual({ text: 'Team files: saved', tone: 'quiet', icon: 'file-check' })
    expect(teamFilesChip(status({ uncommitted: true, uncommittedFiles: ['a'] }))).toEqual({ text: 'Team files: not committed', tone: 'neutral', icon: 'file-text' })
    expect(teamFilesChip(status({ uncommitted: true, isGitRepo: false }))).toMatchObject({ text: 'Team files: saved', tone: 'quiet' })
    expect(teamFilesChip(status({ state: 'pending', changes: [change(), change({ id: 'b' })] }))).toEqual({ text: 'Team files: 2 to approve', tone: 'accent', icon: 'file-warning' })
    expect(teamFilesChip(status({ state: 'problem' }))).toMatchObject({ text: 'Team files: problem', tone: 'danger', icon: 'alert' })
    expect(teamFilesChip(status({ state: 'rejected' }))).toMatchObject({ text: 'Team files: differ', tone: 'quiet' })
    expect(teamFilesChip(status({ state: 'off', offReason: 'removed' }))).toMatchObject({ text: 'Team files: off', tone: 'attention', icon: 'file-x' })
    expect(teamFilesChip(status({ state: 'off', offReason: 'shared-folder' }))).toMatchObject({ tone: 'quiet' })
    expect(teamFilesChip(status({ state: 'off', offReason: 'engagement' }))).toBeNull()
    expect(teamFilesChip(status({ state: 'off', offReason: 'virtual' }))).toBeNull()
  })
  it('the popover sentence per state', () => {
    expect(teamFilesPopoverSentence(status({ uncommitted: true, uncommittedFiles: ['a', 'b', 'c'] }))).toBe('3 files are not in git yet.')
    expect(teamFilesPopoverSentence(status({ uncommitted: true, uncommittedFiles: ['a'] }))).toBe('1 file is not in git yet.')
    expect(teamFilesPopoverSentence(status())).toBe('Everything is saved and committed.')
    expect(teamFilesPopoverSentence(status({ isGitRepo: false }))).toBe('Saved in .orgai/ in this folder.')
    expect(teamFilesPopoverSentence(status({ state: 'pending', changes: [change()] }))).toBe('1 change needs your approval.')
    expect(teamFilesPopoverSentence(status({ state: 'problem' }))).toBeNull()
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
