import { describe, expect, it } from 'vitest'
import type { ApprovalOffer, FolderConfigReview, TeamFilesStatus } from '../../shared/types'
import { approvalFooter, approvalItems, approvalKey, loadingView, offerView, refusedView, waitingNotice, type ApprovalItem, type ApprovalView } from './approvals'
import type { InputEvent, KeyEvent } from './types'

const key = (ch: string): InputEvent => ({ type: 'key', name: 'char', ch, ctrl: false, alt: false, shift: false, raw: ch })
const named = (name: KeyEvent['name']): InputEvent => ({ type: 'key', name, ctrl: false, alt: false, shift: false, raw: '' })

const status = (over: Partial<TeamFilesStatus> = {}): TeamFilesStatus => ({
  projectId: 'p1',
  projectName: 'App',
  state: 'pending',
  digest: 'ab'.repeat(32),
  isGitRepo: false,
  uncommitted: false,
  uncommittedFiles: [],
  changes: [{ id: 'c1', kind: 'role', name: 'Reviewer', file: '.orgai/agents/reviewer.md', action: 'changed', summary: 'Reviewer gains Bash.', needsApproval: true, reason: 'New tools' }],
  applied: [],
  problems: [],
  notes: [],
  warnings: [],
  ...over
})

const ITEM: ApprovalItem = { kind: 'teamFiles', projectId: 'p1', projectName: 'App', digest: 'ab'.repeat(32), label: 'Team files of App: 1 change to approve' }

const offer = (over: Partial<ApprovalOffer> = {}): ApprovalOffer => ({
  offerId: 'f'.repeat(32),
  kind: 'teamFiles',
  projectId: 'p1',
  digest: 'ab'.repeat(32),
  actions: ['approve', 'reject'],
  codeActions: ['approve'],
  code: 'KMNP',
  expiresAt: 1,
  teamFiles: status(),
  ...over
})

/** Feed keys; collects the effects. */
function press(v: ApprovalView, keys: InputEvent[], room = 100): { view: ApprovalView; effects: unknown[] } {
  const effects: unknown[] = []
  for (const k of keys) {
    const r = approvalKey(v, k, room)
    v = r.view
    if (r.effect) effects.push(r.effect)
  }
  return { view: v, effects }
}

describe('the /approvals list', () => {
  it('pending team files of every project, then the current project for undo / commit, then its folder config', () => {
    const fc = { state: 'untrusted', digest: 'cd'.repeat(32) } as FolderConfigReview
    const items = approvalItems([status(), status({ projectId: 'p2', projectName: 'Other', state: 'problem', digest: undefined, changes: [] })], { id: 'p3', name: 'Here', code: true, folderConfig: fc })
    expect(items.map((i) => [i.kind, i.projectId, i.digest?.slice(0, 2)])).toEqual([
      ['teamFiles', 'p1', 'ab'],
      ['teamFiles', 'p2', undefined],
      ['teamFiles', 'p3', undefined],
      ['folderTrust', 'p3', 'cd']
    ])
    expect(items[0].label).toBe('Team files of App: 1 change to approve')
    expect(items[1].label).toBe('Team files of Other: a file has a problem')
    // An engagement has no team files; a folder without config adds nothing; a listed project is not repeated.
    expect(approvalItems([status()], { id: 'p1', name: 'App', code: true, folderConfig: { state: 'none' } as FolderConfigReview })).toHaveLength(1)
    expect(approvalItems([], { id: 'e1', name: 'Acme', code: false })).toEqual([])
  })

  it('the notice on open', () => {
    expect(waitingNotice([status()], { state: 'changed' } as FolderConfigReview)).toBe("Waiting for your approval: team files of 1 project and this folder's own config. Type /approvals.")
    expect(waitingNotice([], { state: 'trusted' } as FolderConfigReview)).toBeUndefined()
  })
})

describe('the overlay keys', () => {
  it('approve: a, then the code typed (case folded), then Enter sends the answer with the code', () => {
    const v = offerView(ITEM, offer())
    expect(approvalFooter(v)).toBe('a approve · r reject · Up / Down scroll · Esc closes')
    const r = press(v, [key('a'), key('k'), key('m'), named('backspace'), key('m'), key('n'), key('p')])
    expect(r.view.phase).toBe('code')
    expect(r.view.typed).toBe('KMNP')
    expect(approvalFooter(r.view)).toContain('Type KMNP to approve')
    const sent = press(r.view, [named('enter')])
    expect(sent.effects).toEqual([{ kind: 'answer', action: 'approve', code: 'KMNP' }])
    expect(sent.view.phase).toBe('busy')
  })

  it('a paste never types the code; Esc steps back, then closes', () => {
    const v = press(offerView(ITEM, offer()), [key('a')]).view
    const pasted = press(v, [{ type: 'paste', text: 'KMNP' }])
    expect(pasted.view.typed).toBe('')
    expect(pasted.view.message?.text).toMatch(/pasting is not accepted/)
    const back = press(pasted.view, [named('escape')])
    expect(back.view.phase).toBe('choose')
    expect(press(back.view, [named('escape')]).effects).toEqual([{ kind: 'close' }])
  })

  it('approve stays inert until the change list was scrolled to its end (nobody approves what they cannot see)', () => {
    const v = offerView(ITEM, offer())
    const room = 3
    const blocked = approvalKey(v, key('a'), room)
    expect(blocked.view.phase).toBe('choose')
    expect(blocked.view.message?.text).toBe('Scroll to the end of the changes to approve.')
    const scrolled = approvalKey(v, named('end'), room).view
    expect(scrolled.seenEnd).toBe(true)
    expect(approvalKey(scrolled, key('a'), room).view.phase).toBe('code')
  })

  it('reject asks y / n and needs no code; an action the offer lacks does nothing', () => {
    const v = offerView(ITEM, offer())
    expect(press(v, [key('r'), key('n')]).view.phase).toBe('choose')
    expect(press(v, [key('r'), key('y')]).effects).toEqual([{ kind: 'answer', action: 'reject' }])
    expect(press(v, [key('u'), key('c'), key('d')]).view.phase).toBe('choose')
  })

  it('folder config: a allows (with the code), d denies (y)', () => {
    const fcItem: ApprovalItem = { kind: 'folderTrust', projectId: 'p1', projectName: 'App', label: 'Folder config of App: changed' }
    const fc = { projectId: 'p1', state: 'changed', digest: 'cd'.repeat(32), files: [], commands: [], env: [], allowRules: [], mcpServers: [], otherSettings: [], truncated: false } as FolderConfigReview
    const v = offerView(fcItem, offer({ kind: 'folderTrust', actions: ['allow', 'deny'], codeActions: ['allow'], teamFiles: undefined, folderConfig: fc }))
    expect(v.lines[0]).toContain('Folder config of App: changed since you allowed it')
    expect(press(v, [key('a'), key('K'), key('M'), key('N'), key('P'), named('enter')]).effects).toEqual([{ kind: 'answer', action: 'allow', code: 'KMNP' }])
    expect(press(v, [key('d'), key('y')]).effects).toEqual([{ kind: 'answer', action: 'deny' }])
  })

  it('loading, busy and refused views take no action keys', () => {
    expect(press(loadingView(ITEM), [key('a'), key('r')]).view.phase).toBe('loading')
    const refused = refusedView(ITEM, 'This orgai was started from inside an agent (claude, pid 7).')
    expect(refused.lines.join('\n')).toContain('inside an agent')
    expect(press(refused, [key('a')]).effects).toEqual([])
    expect(press(refused, [named('escape')]).effects).toEqual([{ kind: 'close' }])
  })

  it('an offer with nothing to do says so; a blocked approve names why', () => {
    const v = offerView(ITEM, offer({ actions: ['reject'], codeActions: [], blockedReason: 'Too many changes to review at once.' }))
    expect(v.lines.join('\n')).toContain('Cannot approve: Too many changes to review at once.')
    expect(offerView(ITEM, offer({ actions: [], codeActions: [] })).lines.join('\n')).toContain('Nothing to approve')
  })
})
