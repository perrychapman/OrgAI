import { describe, expect, it } from 'vitest'
import {
  EDIT_NOTICE_MS,
  NOTICE_LIMIT,
  addHelperText,
  addedText,
  clearNotice,
  duplicateNameText,
  nameTaken,
  nextExpiry,
  postNotice,
  pruneNotices,
  rankNotices,
  removeConfirmText,
  removedText,
  reparentedText,
  type NoticeKind,
  type TeamNotice
} from './teamNotices'

const note = (key: string, kind: NoticeKind, at: number, extra: Partial<TeamNotice> = {}): TeamNotice => ({ key, kind, text: key, at, ...extra })

describe('notice priority', () => {
  it('shows the highest priority and lists the rest in order behind it', () => {
    const list = [note('hint', 'hint', 1), note('saved', 'saved', 2), note('edit', 'edit', 3), note('session', 'session', 4), note('err', 'error', 5)]
    const { current, waiting } = rankNotices(list, 10)
    expect(current?.key).toBe('err')
    // The first-visit hint is never counted as waiting; edit and saved share a rank (newest first), above the session.
    expect(waiting.map((n) => n.key)).toEqual(['edit', 'saved', 'session'])
  })

  it('a saved confirmation posted after an undoable edit shows first (it would otherwise expire unseen)', () => {
    const { current, waiting } = rankNotices([note('added', 'edit', 1), note('tpl', 'saved', 2)], 3)
    expect(current?.key).toBe('tpl')
    expect(waiting.map((n) => n.key)).toEqual(['added'])
  })

  it('shows the hint only when nothing else is in the row, and never as "+1"', () => {
    const { current, waiting } = rankNotices([note('hint', 'hint', 9), note('edit', 'edit', 1)], 10)
    expect(current?.key).toBe('edit')
    expect(waiting).toEqual([])
    expect(rankNotices([note('hint', 'hint', 9)], 10)).toEqual({ current: expect.objectContaining({ key: 'hint' }), waiting: [] })
  })

  it('the newest wins between equal priorities', () => {
    const { current, waiting } = rankNotices([note('old', 'edit', 1), note('new', 'edit', 9)], 10)
    expect(current?.key).toBe('new')
    expect(waiting.map((n) => n.key)).toEqual(['old'])
  })

  it('is empty with nothing to say', () => {
    expect(rankNotices([], 0)).toEqual({ current: null, waiting: [] })
  })

  it('ignores a notice that has expired and lets the next one show', () => {
    const list = [note('edit', 'edit', 1, { expiresAt: 100 }), note('hint', 'hint', 0)]
    expect(rankNotices(list, 99).current?.key).toBe('edit')
    expect(rankNotices(list, 100).current?.key).toBe('hint')
    expect(rankNotices(list, 100).waiting).toEqual([])
  })
})

describe('posting, clearing and expiring', () => {
  it('posting the same key replaces the older message (a new edit supersedes the last one)', () => {
    const first = postNotice([], note('edit', 'edit', 1, { text: 'Added A under B.' }))
    const second = postNotice(first, note('edit', 'edit', 2, { text: 'Removed A.' }))
    expect(second).toHaveLength(1)
    expect(second[0].text).toBe('Removed A.')
  })

  it('clearing a key that is not there returns the same list', () => {
    const list = [note('a', 'edit', 1)]
    expect(clearNotice(list, 'zzz')).toBe(list)
    expect(clearNotice(list, 'a')).toEqual([])
  })

  it('prunes by time and returns the same array when nothing expired', () => {
    const list = [note('a', 'edit', 1, { expiresAt: 50 }), note('b', 'error', 1), note('c', 'saved', 1, { expiresAt: 80 })]
    expect(pruneNotices(list, 10)).toBe(list)
    expect(pruneNotices(list, 60).map((n) => n.key)).toEqual(['b', 'c'])
    expect(pruneNotices(list, 80).map((n) => n.key)).toEqual(['b'])
  })

  it('finds the soonest expiry still ahead, or null', () => {
    const list = [note('a', 'edit', 1, { expiresAt: 50 }), note('b', 'error', 1), note('c', 'saved', 1, { expiresAt: 80 })]
    expect(nextExpiry(list, 0)).toBe(50)
    expect(nextExpiry(list, 50)).toBe(80)
    expect(nextExpiry(list, 80)).toBeNull()
    expect(nextExpiry([note('b', 'error', 1)], 0)).toBeNull()
  })

  it('keeps the queue bounded, dropping the lowest priority and oldest first', () => {
    let list: TeamNotice[] = [note('hint', 'hint', 0), note('keep-error', 'error', 1)]
    for (let i = 0; i < NOTICE_LIMIT + 3; i++) list = postNotice(list, note(`saved-${i}`, 'saved', 10 + i))
    expect(list).toHaveLength(NOTICE_LIMIT)
    expect(list.some((n) => n.key === 'keep-error')).toBe(true)
    expect(list.some((n) => n.key === 'hint')).toBe(false)
    expect(list.some((n) => n.key === 'saved-0')).toBe(false)
    expect(list.some((n) => n.key === `saved-${NOTICE_LIMIT + 2}`)).toBe(true)
  })

  it('an edit offers Undo for twelve seconds', () => {
    expect(EDIT_NOTICE_MS).toBe(12_000)
  })
})

describe('the words', () => {
  it('Added names the manager, or the top of the team for the first role', () => {
    expect(addedText('New role', 'Reviewer')).toBe('Added New role under Reviewer.')
    expect(addedText('Lead', null)).toBe('Added Lead as the top of the team.')
  })

  it('Removed says where reports went, with the right plural', () => {
    expect(removedText('QA', 0, 'Orchestrator')).toBe('Removed QA.')
    expect(removedText('QA', 1, 'Orchestrator')).toBe('Removed QA. Its 1 report now reports to Orchestrator.')
    expect(removedText('QA', 3, 'Orchestrator')).toBe('Removed QA. Its 3 reports now report to Orchestrator.')
  })

  it('the remove confirm names the manager and agrees in number', () => {
    expect(removeConfirmText('QA', 1, 'Lead')).toEqual({ title: 'Remove QA?', body: 'Its 1 report moves up to Lead.', confirmLabel: 'Remove role' })
    expect(removeConfirmText('QA', 2, 'Lead').body).toBe('Its 2 reports move up to Lead.')
  })

  it('a re-parent says who it reports to now, then any delegation consequence', () => {
    expect(reparentedText('X', 'Manager')).toBe('X now reports to Manager.')
    expect(reparentedText('X', 'Manager', 'Orchestrator no longer delegates to X.')).toBe('X now reports to Manager. Orchestrator no longer delegates to X.')
  })

  it('the helper line is true before the action and never says subagent', () => {
    expect(addHelperText('Reviewer', true)).toBe('Reviewer will be able to delegate to it.')
    expect(addHelperText('Reviewer', false)).toBe('Reviewer will be able to hand work to other roles. You can change that on Reviewer.')
    const all = [addedText('A', 'B'), removedText('A', 2, 'B'), reparentedText('A', 'B'), addHelperText('B', false), duplicateNameText('A')].join(' ')
    expect(/subagent/i.test(all)).toBe(false)
  })

  it('names are compared case-insensitively and trimmed; empty is never "taken"', () => {
    const roles = [{ name: 'Reviewer' }, { name: ' Docs Writer ' }]
    expect(nameTaken(roles, 'reviewer')).toBe(true)
    expect(nameTaken(roles, '  DOCS writer')).toBe(true)
    expect(nameTaken(roles, 'Reviewer 2')).toBe(false)
    expect(nameTaken(roles, '   ')).toBe(false)
    expect(duplicateNameText('Reviewer')).toBe('There is already a role called Reviewer. Pick another name.')
  })
})
