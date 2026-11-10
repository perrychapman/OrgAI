/**
 * The terminal UI's /approvals (cli-parity 3.4): the list of what waits for a person, and the approval overlay's pure
 * state and keys. The host decides (approvals:offer / approvals:answer, host/approvalGate.ts): it attests this terminal,
 * binds every offer to this connection and the digest of the content it returns, and wants the code it showed typed
 * back for approve, undo, allow and commit. The overlay shows only the content an offer returned, never an older list.
 *
 * Keys, in the overlay only: a approve (team files) or allow (folder config), r reject, u undo, c commit, d deny; then
 * the code and Enter for approve / undo / allow / commit, y for reject and deny; Esc steps back, then closes. A paste is ignored: the
 * code is typed. Approve and allow stay inert until the change list was scrolled to its end (or fits), as on the desktop.
 *
 * Pure: no ink, no host.
 */
import { APPROVAL_CODE_ACTIONS } from '../../shared/types'
import type { ApprovalAction, ApprovalAnswerResult, ApprovalKind, ApprovalOffer, FolderConfigReview, TeamFilesStatus } from '../../shared/types'
import { folderTrustLines, pendingChanges, teamFilesDetailLines, visibleLine } from '../approvalText'
import type { InputEvent } from './types'

/** One thing /approvals can open. `digest` is what the list showed (absent: the host binds what it reads now). */
export interface ApprovalItem {
  kind: ApprovalKind
  projectId: string
  projectName: string
  digest?: string
  label: string
}

/** The session calls /approvals uses (TuiSessionApi.approvals). */
export interface ApprovalsApi {
  /** Why this connection may not approve at all (no 'attested_approve'), else undefined. */
  withheld(): string | undefined
  list(): Promise<ApprovalItem[]>
  /** The notice on open (waitingNotice), undefined when nothing waits. */
  waiting(): Promise<string | undefined>
  offer(item: ApprovalItem): Promise<ApprovalOffer>
  answer(offerId: string, action: ApprovalAction, code?: string): Promise<ApprovalAnswerResult>
}

/** The /approvals list from the host's reads: pending team files of every project, then the current project's own. */
export function approvalItems(attention: readonly TeamFilesStatus[], current?: { id: string; name: string; code: boolean; folderConfig?: FolderConfigReview }): ApprovalItem[] {
  const out: ApprovalItem[] = []
  for (const s of attention) {
    if (s.state !== 'pending' && s.state !== 'problem') continue
    const n = pendingChanges(s).length
    const what = s.state === 'problem' ? 'a file has a problem' : `${n} change${n === 1 ? '' : 's'} to approve`
    out.push({ kind: 'teamFiles', projectId: s.projectId, projectName: s.projectName, ...(s.digest ? { digest: s.digest } : {}), label: `Team files of ${visibleLine(s.projectName)}: ${what}` })
  }
  if (current?.code && !out.some((i) => i.kind === 'teamFiles' && i.projectId === current.id)) {
    out.push({ kind: 'teamFiles', projectId: current.id, projectName: current.name, label: `Team files of ${visibleLine(current.name)} (undo, commit)` })
  }
  const fc = current?.folderConfig
  if (current && fc && fc.state !== 'none') {
    const what = fc.state === 'trusted' ? 'allowed' : fc.state === 'changed' ? 'changed since allowed' : 'not allowed'
    out.push({ kind: 'folderTrust', projectId: current.id, projectName: current.name, digest: fc.digest, label: `Folder config of ${visibleLine(current.name)}: ${what}` })
  }
  return out
}

/** The notice the terminal UI shows on open while something waits for a person here; undefined when nothing does. */
export function waitingNotice(attention: readonly TeamFilesStatus[], folderConfig?: FolderConfigReview): string | undefined {
  const team = attention.filter((s) => s.state === 'pending' || s.state === 'problem').length
  const trust = folderConfig && (folderConfig.state === 'untrusted' || folderConfig.state === 'changed') ? 1 : 0
  const parts = [...(team ? [`team files of ${team} project${team === 1 ? '' : 's'}`] : []), ...(trust ? ["this folder's own config"] : [])]
  return parts.length ? `Waiting for your approval: ${parts.join(' and ')}. Type /approvals.` : undefined
}

export type ApprovalPhase = 'loading' | 'choose' | 'code' | 'confirm' | 'busy' | 'refused'

export interface ApprovalView {
  item: ApprovalItem
  phase: ApprovalPhase
  offer?: ApprovalOffer
  lines: string[]
  offset: number
  /** The body was scrolled to its end, or fits (set by the renderer through `fits`). */
  seenEnd: boolean
  /** The action waiting for its code or its y. */
  pending?: ApprovalAction
  typed: string
  message?: { text: string; tone: 'ok' | 'warn' | 'danger' | 'dim' }
}

export type ApprovalEffect = { kind: 'close' } | { kind: 'answer'; action: ApprovalAction; code?: string }

/** The key that starts each action, per kind. */
export const ACTION_KEYS: Readonly<Record<ApprovalKind, Readonly<Partial<Record<string, ApprovalAction>>>>> = {
  teamFiles: { a: 'approve', r: 'reject', u: 'undo', c: 'commit' },
  folderTrust: { a: 'allow', d: 'deny' }
}

const ACTION_WORD: Record<ApprovalAction, string> = { approve: 'approve', reject: 'reject', undo: 'undo', commit: 'commit', allow: 'allow', deny: 'deny' }

export function loadingView(item: ApprovalItem): ApprovalView {
  return { item, phase: 'loading', lines: ['Checking this terminal and reading the latest content...'], offset: 0, seenEnd: false, typed: '' }
}

/** The view of a fresh offer (its own content, never the list's). */
export function offerView(item: ApprovalItem, offer: ApprovalOffer, message?: ApprovalView['message']): ApprovalView {
  const lines = offer.teamFiles ? teamFilesDetailLines(offer.teamFiles, offer.undoChanges) : offer.folderConfig ? folderTrustLines(offer.folderConfig, item.projectName) : ['Nothing to show.']
  if (offer.blockedReason) lines.push('', `Cannot ${offer.kind === 'folderTrust' ? 'allow' : 'approve'}: ${visibleLine(offer.blockedReason)}`)
  if (!offer.actions.length) lines.push('', 'Nothing to approve, reject, undo or commit here right now.')
  return { item, phase: 'choose', offer, lines, offset: 0, seenEnd: false, typed: '', ...(message ? { message } : {}) }
}

export function refusedView(item: ApprovalItem, reason: string): ApprovalView {
  return {
    item,
    phase: 'refused',
    lines: ['Not approved:', `  ${visibleLine(reason)}`, '', 'Run orgai yourself in a plain terminal window you opened (not tmux or screen, not from an agent, a script or a pipe), with no run of the project going, then type /approvals.'],
    offset: 0,
    seenEnd: true,
    typed: ''
  }
}

/** The footer for the current phase (keys, the code to type). */
export function approvalFooter(v: ApprovalView): string {
  const o = v.offer
  switch (v.phase) {
    case 'loading':
    case 'busy':
      return 'Working...'
    case 'refused':
      return 'Esc closes'
    case 'code':
      return `Type ${o?.code ?? ''} to ${ACTION_WORD[v.pending ?? 'approve']}, then Enter · Esc goes back · typed: ${v.typed || '_'}`
    case 'confirm':
      return `${ACTION_WORD[v.pending ?? 'reject']}? y yes · n no`
    default: {
      if (!o) return 'Esc closes'
      const keys = Object.entries(ACTION_KEYS[o.kind])
        .filter(([, a]) => a && o.actions.includes(a))
        .map(([k, a]) => `${k} ${ACTION_WORD[a as ApprovalAction]}`)
      return [...keys, 'Up / Down scroll', 'Esc closes'].join(' · ')
    }
  }
}

const printable = (e: InputEvent): string | undefined => (e.type === 'key' && e.name === 'char' && !e.ctrl && !e.alt && e.ch && e.ch.length === 1 ? e.ch : undefined)
const isKey = (e: InputEvent, name: string): boolean => e.type === 'key' && e.name === name

/**
 * One key in the overlay. `room` is the body rows on screen and `total` the body's rows once wrapped (scrolling and
 * `seenEnd`). Returns the next view and what the shell must do (close, or send an answer). A paste never types anything.
 */
export function approvalKey(v: ApprovalView, e: InputEvent, room: number, total = v.lines.length): { view: ApprovalView; effect?: ApprovalEffect } {
  if (e.type === 'paste') return { view: v.phase === 'code' ? { ...v, message: { text: 'Type the code; pasting is not accepted here.', tone: 'warn' } } : v }
  const ch = printable(e)
  const ctrlC = e.type === 'key' && e.name === 'char' && e.ctrl && e.ch === 'c'
  if (v.phase === 'code') {
    if (isKey(e, 'escape') || ctrlC) return { view: { ...v, phase: 'choose', typed: '', pending: undefined } }
    if (isKey(e, 'backspace')) return { view: { ...v, typed: v.typed.slice(0, -1) } }
    if (isKey(e, 'enter')) {
      if (!v.typed) return { view: v }
      return { view: { ...v, phase: 'busy' }, effect: { kind: 'answer', action: v.pending ?? 'approve', code: v.typed } }
    }
    if (ch && /^[A-Za-z]$/.test(ch) && v.typed.length < 8) return { view: { ...v, typed: v.typed + ch.toUpperCase() } }
    return { view: v }
  }
  if (v.phase === 'confirm') {
    if (ch?.toLowerCase() === 'y') return { view: { ...v, phase: 'busy' }, effect: { kind: 'answer', action: v.pending ?? 'reject' } }
    if (ch?.toLowerCase() === 'n' || isKey(e, 'escape') || ctrlC) return { view: { ...v, phase: 'choose', pending: undefined } }
    return { view: v }
  }
  if (isKey(e, 'escape') || ctrlC || ch === 'q') return { view: v, effect: { kind: 'close' } }
  if (v.phase === 'loading' || v.phase === 'busy') return { view: v }
  // Scrolling (choose and refused).
  const max = Math.max(0, total - room)
  const scrolled = (offset: number): ApprovalView => {
    const o = Math.max(0, Math.min(max, offset))
    return { ...v, offset: o, seenEnd: v.seenEnd || o >= max }
  }
  if (isKey(e, 'down') || ch === 'j') return { view: scrolled(v.offset + 1) }
  if (isKey(e, 'up') || ch === 'k') return { view: scrolled(v.offset - 1) }
  if (isKey(e, 'pagedown') || ch === ' ') return { view: scrolled(v.offset + Math.max(1, room - 1)) }
  if (isKey(e, 'pageup')) return { view: scrolled(v.offset - Math.max(1, room - 1)) }
  if (isKey(e, 'home') || ch === 'g') return { view: scrolled(0) }
  if (isKey(e, 'end') || ch === 'G') return { view: scrolled(max) }
  if (v.phase !== 'choose' || !v.offer || !ch) return { view: v }
  const action = ACTION_KEYS[v.offer.kind][ch.toLowerCase()]
  if (!action || !v.offer.actions.includes(action)) return { view: v }
  const seen = v.seenEnd || total <= room
  if (APPROVAL_CODE_ACTIONS.includes(action)) {
    if (!seen && (action === 'approve' || action === 'allow')) {
      return { view: { ...v, message: { text: `Scroll to the end of the changes to ${ACTION_WORD[action]}.`, tone: 'warn' } } }
    }
    return { view: { ...v, phase: 'code', pending: action, typed: '', message: undefined } }
  }
  return { view: { ...v, phase: 'confirm', pending: action, message: undefined } }
}
