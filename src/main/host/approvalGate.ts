/**
 * Approvals at the terminal (cli-parity 3.4; docs/agent-notes/cli-host.md "Approvals at the terminal"): the host side
 * of the two socket-only channels approvals:offer and approvals:answer (scope 'attested_approve'). Electron-free,
 * relative imports only. The desktop keeps its own desktop-only channels (teamFiles:approve and friends,
 * projects:setFolderConfigTrust in ipc.ts); nothing here is reachable from a window.
 *
 * This removes the scripted ways to approve and raises the cost of the others; it is not a boundary against code that
 * already runs as the user (see the agent note's residual risks). The host decides, from what it can check itself:
 * - who: the call comes over the socket from the orgai process's own connection (`owner`, the in-memory owner proof)
 *   as the terminal UI ('tui'; exec and the management commands never are) holding 'attested_approve';
 * - when: no run of the project is alive in this host (its agents share the terminal and could type into it);
 * - where: the item is read first (reading may run git), then the terminal is attested (terminalAttestation.ts,
 *   coResident included); again after the key press, at the answer;
 * - what: one live offer at a time, bound to the connection, the item (kind, project) and the digest of the content it
 *   returns for the terminal to show (TeamFilesStatus.digest, FolderConfigReview.digest; for undo also the undo
 *   record's time); a digest sent with the offer (what the list showed) must still match. It expires after
 *   APPROVAL_OFFER_TTL_MS and is spent by any answer except a mistyped code, which may be retried
 *   APPROVAL_MAX_ATTEMPTS times in all;
 * - how: approve, undo, allow and commit need the 4-letter code the offer showed, typed back; reject and deny need the
 *   attested key press.
 * The digest is compared again, synchronously, right before the service call (which compares it once more for approve
 * and reject): files that changed since the offer refuse with stale_target_digest and the terminal shows them again.
 */
import { randomBytes, randomInt } from 'node:crypto'
import { isSafeId } from '../../shared/defaults'
import { APPROVAL_CODE_ACTIONS, APPROVAL_WRONG_CODE_MESSAGE, isVirtualProjectId } from '../../shared/types'
import type {
  ApprovalAction,
  ApprovalAnswerInput,
  ApprovalAnswerResult,
  ApprovalKind,
  ApprovalOffer,
  ApprovalOfferInput,
  FolderConfigReview,
  Project,
  RunSummary,
  TeamFileChange,
  TeamFilesStatus
} from '../../shared/types'
import { applyFolderConfigTrust, folderConfigReview } from '../runtime/folderConfigTrust'
import { projectRulesFile } from '../store/projectData'
import type { TeamFilesService } from '../teamFiles/service'
import { HostRpcFailure } from './registry'
import type { AttestTerminalFn } from './terminalAttestation'
import type { InvokeContext } from './types'

/** How long an offer may be answered. */
export const APPROVAL_OFFER_TTL_MS = 3 * 60_000
/** Code attempts one offer allows; then it is gone. */
export const APPROVAL_MAX_ATTEMPTS = 3
/** Letters the code uses: no I, O, L, B, S, G, Z, Q, U (easily confused). */
export const APPROVAL_CODE_ALPHABET = 'ACDEFHJKMNPRTVWXY'
export const APPROVAL_CODE_LENGTH = 4

const DIGEST_RE = /^[0-9a-f]{64}$/
const OFFER_ID_RE = /^[0-9a-f]{32}$/
const KINDS: readonly ApprovalKind[] = ['teamFiles', 'folderTrust']
const ACTIONS: readonly ApprovalAction[] = ['approve', 'reject', 'undo', 'commit', 'allow', 'deny']

export const APPROVAL_GONE_MESSAGE = 'This approval is no longer open. Open it again.'
export const APPROVAL_EXPIRED_MESSAGE = 'This approval code expired. Open it again for a new code.'
export { APPROVAL_WRONG_CODE_MESSAGE }
export const APPROVAL_SPENT_MESSAGE = 'The code did not match too many times; nothing was changed. Open the approval again for a new code.'
export const APPROVAL_STALE_MESSAGE = 'This changed since you looked. Review it again.'
export const APPROVAL_TERMINAL_ONLY_MESSAGE = "Approvals are answered only in the orgai terminal UI ('/approvals')."

export type ApprovalTeamFiles = Pick<TeamFilesService, 'check' | 'withGit' | 'approve' | 'reject' | 'undo' | 'commit'> & Partial<Pick<TeamFilesService, 'undoChanges'>>

export interface ApprovalGateDeps {
  teamFiles?: ApprovalTeamFiles
  projects: { get(id: string): Project | null | undefined; update(id: string, fn: (p: Project) => Project): Project }
  /** The data folder (projectRulesFile: where a gated project's saved rules live); read when used. */
  dataDir: () => string
  /** Absent: every call is refused (a host that cannot attest a terminal, e.g. the desktop). */
  attest?: AttestTerminalFn
  /** The host's live runs (RunManager.liveRuns): an offer is refused while one of the project is alive. */
  liveRuns?: () => readonly Pick<RunSummary, 'projectId' | 'title' | 'id'>[]
  now?: () => number
  /** Tests: a fixed code. */
  makeCode?: () => string
}

/** What an offer binds and allows, read from the item now, with the content it binds (the terminal shows exactly that). */
interface OfferItem {
  digest: string
  undoAt?: string
  actions: ApprovalAction[]
  blockedReason?: string
  teamFiles?: TeamFilesStatus
  folderConfig?: FolderConfigReview
  undoChanges?: TeamFileChange[]
}

interface Offer {
  id: string
  connectionId: string
  kind: ApprovalKind
  projectId: string
  digest: string
  /** teamFiles undo: the undo record the terminal showed. */
  undoAt?: string
  actions: ApprovalAction[]
  code: string
  expiresAt: number
  attempts: number
}

/** ApprovalOfferInput rebuilt (unknown fields dropped). Throws bad_request. */
export function approvalOfferArgs(raw: unknown): ApprovalOfferInput {
  const i = isObj(raw) ? raw : {}
  if (!KINDS.includes(i.kind as ApprovalKind)) throw new HostRpcFailure('bad_request', "kind must be 'teamFiles' or 'folderTrust'.")
  if (!isSafeId(i.projectId) || isVirtualProjectId(i.projectId)) throw new HostRpcFailure('bad_request', 'Project not found')
  if (i.digest !== undefined && (typeof i.digest !== 'string' || !DIGEST_RE.test(i.digest))) throw new HostRpcFailure('bad_request', 'The digest of what you saw is not valid; review it again.')
  return { kind: i.kind as ApprovalKind, projectId: i.projectId, ...(typeof i.digest === 'string' ? { digest: i.digest } : {}) }
}

/** ApprovalAnswerInput rebuilt. Throws bad_request. */
export function approvalAnswerArgs(raw: unknown): ApprovalAnswerInput {
  const i = isObj(raw) ? raw : {}
  if (typeof i.offerId !== 'string' || !OFFER_ID_RE.test(i.offerId)) throw new HostRpcFailure('bad_request', APPROVAL_GONE_MESSAGE)
  if (!ACTIONS.includes(i.action as ApprovalAction)) throw new HostRpcFailure('bad_request', 'Unknown approval action.')
  if (i.code !== undefined && (typeof i.code !== 'string' || i.code.length > 16)) throw new HostRpcFailure('bad_request', APPROVAL_WRONG_CODE_MESSAGE)
  return { offerId: i.offerId, action: i.action as ApprovalAction, ...(typeof i.code === 'string' ? { code: i.code } : {}) }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

export function newApprovalCode(): string {
  let s = ''
  for (let k = 0; k < APPROVAL_CODE_LENGTH; k++) s += APPROVAL_CODE_ALPHABET[randomInt(APPROVAL_CODE_ALPHABET.length)]
  return s
}

/** The code as typed, folded: capitals, no spaces or dashes. */
export function foldCode(typed: string): string {
  return typed.replace(/[\s-]/g, '').toUpperCase()
}

/** Equal-length strings compared without an early exit. */
function sameCode(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let k = 0; k < a.length; k++) diff |= a.charCodeAt(k) ^ b.charCodeAt(k)
  return diff === 0
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

export class ApprovalGate {
  /** The one live offer. */
  private current: Offer | undefined

  constructor(private readonly deps: ApprovalGateDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** The caller checks of both channels: the terminal UI's own socket connection, nothing else. */
  private who(ctx: InvokeContext): string {
    if (ctx.surface !== 'socket' || ctx.owner !== true || ctx.clientKind !== 'tui' || !ctx.connectionId) {
      throw new HostRpcFailure('scope_denied', APPROVAL_TERMINAL_ONLY_MESSAGE)
    }
    if (!ctx.grantedScopes?.includes('attested_approve')) throw new HostRpcFailure('scope_denied', APPROVAL_TERMINAL_ONLY_MESSAGE)
    return ctx.connectionId
  }

  private async attest(): Promise<void> {
    const attest = this.deps.attest
    if (!attest) throw new HostRpcFailure('scope_denied', 'This OrgAI cannot check a terminal, so it takes no approvals from one.')
    let r
    try {
      r = await attest({ coResident: true })
    } catch {
      r = { ok: false as const, code: 'process_table_unavailable' as const, reason: 'OrgAI could not check this terminal; try again.' }
    }
    if (!r.ok) throw new HostRpcFailure('scope_denied', r.reason)
  }

  /** Refused while a run of the project is alive in this host: its agents share the terminal. */
  private noLiveRun(projectId: string): void {
    let live: readonly Pick<RunSummary, 'projectId' | 'title' | 'id'>[] = []
    try {
      const got = this.deps.liveRuns?.()
      live = Array.isArray(got) ? got : []
    } catch {
      live = []
    }
    const run = live.find((r) => r.projectId === projectId)
    if (run) throw new HostRpcFailure('scope_denied', `A run of this project is still going${run.title ? ` ("${run.title.slice(0, 60)}")` : ''}; stop it first (/stop), then approve.`)
  }

  /** approvals:offer. */
  async offer(ctx: InvokeContext, raw: unknown): Promise<ApprovalOffer> {
    const connectionId = this.who(ctx)
    const input = approvalOfferArgs(raw)
    this.noLiveRun(input.projectId)
    // The item first (reading it may run git in the project), then the terminal: a helper that git started and that
    // still holds the terminal is seen by the check.
    const item: OfferItem = input.kind === 'teamFiles' ? await this.teamFilesItem(input.projectId) : this.folderTrustItem(input.projectId)
    // The digest of what the terminal listed, when it sent one; the offer carries the content it binds either way.
    if (input.digest !== undefined && item.digest !== input.digest) throw new HostRpcFailure('stale_target_digest', APPROVAL_STALE_MESSAGE)
    await this.attest()
    const offer: Offer = {
      id: randomBytes(16).toString('hex'),
      connectionId,
      kind: input.kind,
      projectId: input.projectId,
      digest: item.digest,
      ...(item.undoAt ? { undoAt: item.undoAt } : {}),
      actions: item.actions,
      code: (this.deps.makeCode ?? newApprovalCode)(),
      expiresAt: this.now() + APPROVAL_OFFER_TTL_MS,
      attempts: 0
    }
    // One live offer: a new one replaces any other.
    this.current = offer
    return {
      offerId: offer.id,
      kind: offer.kind,
      projectId: offer.projectId,
      digest: offer.digest,
      actions: [...offer.actions],
      codeActions: offer.actions.filter((a) => APPROVAL_CODE_ACTIONS.includes(a)),
      code: offer.code,
      expiresAt: offer.expiresAt,
      ...(item.blockedReason ? { blockedReason: item.blockedReason } : {}),
      ...(item.teamFiles ? { teamFiles: item.teamFiles } : {}),
      ...(item.folderConfig ? { folderConfig: item.folderConfig } : {}),
      ...(item.undoChanges?.length ? { undoChanges: item.undoChanges } : {})
    }
  }

  /** approvals:answer. */
  async answer(ctx: InvokeContext, raw: unknown): Promise<ApprovalAnswerResult> {
    const connectionId = this.who(ctx)
    const input = approvalAnswerArgs(raw)
    const offer = this.current
    if (!offer || offer.id !== input.offerId || offer.connectionId !== connectionId) throw new HostRpcFailure('stale_revision', APPROVAL_GONE_MESSAGE)
    const spend = (): void => {
      if (this.current === offer) this.current = undefined
    }
    if (this.now() >= offer.expiresAt) {
      spend()
      throw new HostRpcFailure('stale_revision', APPROVAL_EXPIRED_MESSAGE)
    }
    if (!offer.actions.includes(input.action)) {
      spend()
      throw new HostRpcFailure('bad_request', `"${input.action}" is not open for this item.`)
    }
    if (APPROVAL_CODE_ACTIONS.includes(input.action) && !sameCode(foldCode(input.code ?? ''), offer.code)) {
      offer.attempts += 1
      if (offer.attempts >= APPROVAL_MAX_ATTEMPTS) {
        spend()
        throw new HostRpcFailure('stale_revision', APPROVAL_SPENT_MESSAGE)
      }
      const left = APPROVAL_MAX_ATTEMPTS - offer.attempts
      throw new HostRpcFailure('bad_request', `${APPROVAL_WRONG_CODE_MESSAGE} ${left} ${left === 1 ? 'try' : 'tries'} left.`)
    }
    // Spent from here, whatever happens next.
    spend()
    this.noLiveRun(offer.projectId)
    // After the key press: the terminal again (an agent that started since the offer, a process that joined it).
    await this.attest()
    return offer.kind === 'teamFiles' ? this.applyTeamFiles(offer, input.action) : this.applyFolderTrust(offer, input.action)
  }

  // ---------- team files ----------

  private svc(): ApprovalTeamFiles {
    if (!this.deps.teamFiles) throw new HostRpcFailure('bad_request', 'Team files are not available in this host.')
    return this.deps.teamFiles
  }

  private async teamFilesItem(projectId: string): Promise<OfferItem> {
    const svc = this.svc()
    let status: TeamFilesStatus
    try {
      status = await svc.withGit(svc.check(projectId, { firstWrite: false }))
    } catch (e) {
      throw new HostRpcFailure('bad_request', e instanceof Error ? e.message : 'Project not found')
    }
    if (status.state === 'off') throw new HostRpcFailure('bad_request', 'This project does not use team files.')
    if (!status.digest) throw new HostRpcFailure('bad_request', `Fix the problem in ${status.problems[0]?.file ?? '.orgai/team.json'} first.`)
    const actions: ApprovalAction[] = []
    let blockedReason: string | undefined
    // 'rejected' keeps its changes listed: the user may still approve them (a change of mind), not reject them again.
    if (status.state === 'pending' || status.state === 'rejected') {
      if (status.problems.length) blockedReason = `Fix the problem in ${status.problems[0].file} first.`
      else if ((status.omittedChanges ?? 0) > 0) blockedReason = 'Too many changes to review at once.'
      else actions.push('approve')
      if (status.state === 'pending') actions.push('reject')
    } else if (status.state === 'problem') {
      blockedReason = `Fix the problem in ${status.problems[0]?.file ?? '.orgai/team.json'} first.`
    }
    if (status.undo) actions.push('undo')
    if (status.isGitRepo && status.uncommitted) actions.push('commit')
    const undoChanges = status.undo ? (svc.undoChanges?.(projectId) ?? []) : []
    return {
      digest: status.digest,
      ...(status.undo ? { undoAt: status.undo.at } : {}),
      actions,
      ...(blockedReason ? { blockedReason } : {}),
      teamFiles: status,
      ...(undoChanges.length ? { undoChanges } : {})
    }
  }

  private async applyTeamFiles(offer: Offer, action: ApprovalAction): Promise<ApprovalAnswerResult> {
    const svc = this.svc()
    const { projectId } = offer
    // Synchronous from here to the service call: nothing can change the files' digest in between on this thread.
    const now = svc.check(projectId, { firstWrite: false })
    if (now.digest !== offer.digest || (action === 'undo' && now.undo?.at !== offer.undoAt)) {
      throw new HostRpcFailure('stale_target_digest', APPROVAL_STALE_MESSAGE)
    }
    const name = now.projectName
    const base = { kind: 'teamFiles' as const, action, projectId }
    switch (action) {
      case 'approve': {
        const n = now.changes.filter((c) => c.needsApproval).length
        const r = svc.approve({ projectId, digest: offer.digest })
        return { ...base, message: `Approved ${plural(n, 'change', 'changes')} to the team of ${name}.`, teamFiles: await svc.withGit(r.status) }
      }
      case 'reject': {
        const r = svc.reject({ projectId, digest: offer.digest })
        return { ...base, message: `Rejected the team files of ${name}; runs keep the last approved team until the files change.`, teamFiles: await svc.withGit(r.status) }
      }
      case 'undo': {
        const r = svc.undo({ projectId })
        return { ...base, message: r.status.lastUndo?.label ? `${r.status.lastUndo.label}.` : 'Undone.', teamFiles: await svc.withGit(r.status) }
      }
      case 'commit': {
        const r = await svc.commit({ projectId })
        if (!r.ok) throw new HostRpcFailure('bad_request', r.message)
        return { ...base, message: r.message, teamFiles: r.status, committed: r.committed }
      }
      default:
        throw new HostRpcFailure('bad_request', `"${action}" is not a team files action.`)
    }
  }

  // ---------- folder config trust ----------

  private project(projectId: string): Project {
    const p = this.deps.projects.get(projectId)
    if (!p) throw new HostRpcFailure('bad_request', 'Project not found')
    return p
  }

  private folderTrustItem(projectId: string): OfferItem {
    const review: FolderConfigReview = folderConfigReview(this.project(projectId))
    if (review.state === 'none') throw new HostRpcFailure('bad_request', 'This project has no folder config to review.')
    const actions: ApprovalAction[] = []
    let blockedReason: string | undefined
    if (review.state !== 'trusted') {
      if (review.unreviewable) blockedReason = review.unreviewable
      else actions.push('allow')
    }
    if (review.state === 'trusted' || review.state === 'changed') actions.push('deny')
    return { digest: review.digest, actions, ...(blockedReason ? { blockedReason } : {}), folderConfig: review }
  }

  private applyFolderTrust(offer: Offer, action: ApprovalAction): ApprovalAnswerResult {
    if (action !== 'allow' && action !== 'deny') throw new HostRpcFailure('bad_request', `"${action}" is not a folder trust action.`)
    const project = this.project(offer.projectId)
    if (folderConfigReview(project).digest !== offer.digest) throw new HostRpcFailure('stale_target_digest', APPROVAL_STALE_MESSAGE)
    let saved: Project
    try {
      // applyFolderConfigTrust re-reads the folder and refuses a digest other than the one shown.
      saved = this.deps.projects.update(offer.projectId, (p) =>
        applyFolderConfigTrust(p, { trust: action === 'allow', digest: offer.digest }, { rulesFile: projectRulesFile(p, this.deps.dataDir()) })
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'The folder config could not be changed.'
      throw new HostRpcFailure(/changed since/.test(msg) ? 'stale_target_digest' : 'bad_request', msg)
    }
    const message = action === 'allow' ? `Agents of ${saved.name} now load this folder's own config.` : `Agents of ${saved.name} ignore this folder's own config.`
    return { kind: 'folderTrust', action, projectId: offer.projectId, message, folderConfig: folderConfigReview(saved) }
  }
}
