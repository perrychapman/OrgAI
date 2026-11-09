/**
 * The delegation ledger (docs/design/delegation-enforcement.md 4.3, 5.2): owns a DelegationLedgerState and applies the
 * decisions of delegation.ts. RunManager holds one per run and implements RuntimeContext.delegation on top of it.
 * No I/O, no Electron.
 */
import type { AgentInstance, DelegationAgentState, DelegationLedgerState, DelegationReceipt, DelegationVerdict, RunSummary } from '@shared/types'
import {
  attempt,
  correctionText,
  failureLine,
  hasValidReceipt,
  missingReports,
  receiptLine,
  subtreeFailed,
  waitText,
  whyText,
  type RoleLabel
} from './delegation'

export type CompletionAction = 'allow' | 'wait' | 'correct' | 'fail' | 'none'

export interface CompletionResult {
  action: CompletionAction
  /** Correction / wait text to send the agent. */
  text?: string
  verdict?: DelegationVerdict
}

export interface DelegationLedgerOptions {
  /** Names for the texts; not persisted. Defaults: the role id and agent id. */
  roleLabel?: (roleId: string) => RoleLabel
  handle?: (agentId: string) => string
  /** The spawn tool named in the correction ("spawn_report"). */
  spawnTool?: string
  now?: () => number
}

export class DelegationLedger {
  private state: DelegationLedgerState
  private readonly opts: DelegationLedgerOptions

  constructor(init: { obligations: Record<string, string[]>; strict: boolean; problems?: string[] } | { state: DelegationLedgerState }, opts: DelegationLedgerOptions = {}) {
    this.opts = opts
    this.state =
      'state' in init
        ? structuredClone(init.state)
        : { strict: init.strict, obligations: structuredClone(init.obligations), problems: [...(init.problems ?? [])], agents: {}, receipts: [] }
  }

  private label(roleId: string): RoleLabel {
    return this.opts.roleLabel?.(roleId) ?? { slug: roleId, name: roleId }
  }
  private handle(agentId: string): string {
    return this.opts.handle?.(agentId) ?? agentId
  }
  private register(agentId: string, roleId: string, parentId?: string): DelegationAgentState {
    const existing = this.state.agents[agentId]
    if (existing) return existing
    const a: DelegationAgentState = {
      roleId,
      ...(parentId ? { parentId } : {}),
      required: [...(this.state.obligations[roleId] ?? [])],
      phase: 'working',
      corrections: 0,
      missing: [],
      nativeStrikes: 0
    }
    this.state.agents[agentId] = a
    return a
  }

  /** Registers the root agent (no parent). */
  noteRoot(agentId: string, roleId: string): void {
    this.register(agentId, roleId)
  }

  noteSpawn(childId: string, parentId: string, roleId: string): void {
    this.register(childId, roleId, parentId)
    const parent = this.state.agents[parentId]
    if (parent && (parent.phase === 'waiting' || parent.phase === 'correcting')) parent.phase = 'working'
  }

  /** An agent tries to finish (spec 4.4). Writes the receipt on allow / fail. */
  completion(agentId: string, opts: { canCorrect: boolean; canWait: boolean; reportText: string }): CompletionResult {
    const a = this.state.agents[agentId]
    if (!a) return { action: 'allow', verdict: 'adaptive' }
    if (a.phase === 'ended') return { action: 'none' }
    if (a.phase === 'done') return { action: a.verdict === 'failed' ? 'fail' : 'allow', verdict: a.verdict }
    const r = attempt(agentId, this.state, opts)
    const missing = r.missing.map((m) => ({ roleId: m.roleId, why: m.why }))
    const roleName = this.label(a.roleId).name
    const labels = missing.map((m) => ({ slug: this.label(m.roleId).slug, why: m.why }))
    if (r.action === 'wait') {
      a.phase = 'waiting'
      a.missing = missing
      return { action: 'wait', text: waitText({ roleName, missing: labels }) }
    }
    if (r.action === 'correct') {
      a.phase = 'correcting'
      a.corrections = 1
      a.missing = missing
      return {
        action: 'correct',
        text: correctionText({
          roleName,
          required: a.required.map((id) => this.label(id)),
          missing: labels,
          spawnTool: this.opts.spawnTool ?? 'spawn_report'
        })
      }
    }
    a.phase = 'done'
    a.verdict = r.verdict
    a.missing = r.action === 'fail' ? missing : []
    if (a.parentId) {
      const receipt: DelegationReceipt = {
        childId: agentId,
        parentId: a.parentId,
        roleId: a.roleId,
        completedAt: (this.opts.now ?? Date.now)(),
        verdict: r.verdict ?? 'adaptive',
        reportChars: opts.reportText.trim().length,
        delivered: false
      }
      this.state.receipts.push(receipt)
    }
    return { action: r.action, verdict: r.verdict }
  }

  /** The agent ended (interrupted, failed, removed) without completing. A finished agent keeps its verdict. */
  ended(agentId: string): void {
    const a = this.state.agents[agentId]
    if (a && a.phase !== 'done') a.phase = 'ended'
  }

  /** The adapter confirmed the child's report reached its parent. */
  delivered(childId: string): void {
    for (let i = this.state.receipts.length - 1; i >= 0; i--) {
      if (this.state.receipts[i].childId === childId) {
        this.state.receipts[i].delivered = true
        return
      }
    }
  }

  /** The harness receipt (+ failure line) to place before the child's report. undefined when the child has no obligations. */
  receiptText(childId: string): string | undefined {
    const a = this.state.agents[childId]
    if (!a || a.required.length === 0) return undefined
    const handle = this.handle(childId)
    const roleName = this.label(a.roleId).name
    const required = a.required.map((roleId) => {
      const slug = this.label(roleId).slug
      if (hasValidReceipt(this.state, childId, roleId)) {
        const receipt = [...this.state.receipts].reverse().find((r) => r.parentId === childId && r.roleId === roleId && r.delivered)
        return { slug, childHandle: this.handle(receipt?.childId ?? roleId) }
      }
      const why = missingReports(childId, this.state).find((m) => m.roleId === roleId)?.why ?? 'never-spawned'
      return { slug, why }
    })
    let text = receiptLine({ handle, roleName, required })
    if (a.verdict === 'failed') {
      const missing = a.missing.map((m) => ({ slug: this.label(m.roleId).slug, why: m.why }))
      text = `${failureLine({ handle, roleName, missing })}\n${text}`
    }
    return text
  }

  /** A native (non-harness) spawn attempt by the agent. Returns its strike count. */
  nativeStrike(agentId: string): number {
    const a = this.state.agents[agentId]
    if (!a) return 0
    a.nativeStrikes += 1
    return a.nativeStrikes
  }

  setProblems(problems: string[]): void {
    this.state.problems = [...problems]
  }

  /** The verdict of the agent that has no parent. */
  rootVerdict(): DelegationVerdict | undefined {
    return Object.values(this.state.agents).find((a) => !a.parentId)?.verdict
  }

  /** The state to persist (a structured-clone-safe copy). */
  snapshot(): DelegationLedgerState {
    return structuredClone(this.state)
  }

  /** RunSummary.delegation and the per-agent display fields (the run.delegation event payload). */
  summary(): { summary: NonNullable<RunSummary['delegation']>; agents: Record<string, NonNullable<AgentInstance['delegation']>> } {
    const agents: Record<string, NonNullable<AgentInstance['delegation']>> = {}
    let failed = 0
    let corrected = 0
    let nativeSpawns = 0
    for (const [id, a] of Object.entries(this.state.agents)) {
      if (a.verdict === 'failed') failed++
      if (a.corrections === 1) corrected++
      nativeSpawns += a.nativeStrikes
      if (a.required.length === 0 && a.nativeStrikes === 0 && a.corrections === 0) continue
      agents[id] = {
        ...(a.verdict ? { verdict: a.verdict } : {}),
        missing: a.missing.map((m) => `${this.label(m.roleId).slug}: ${whyText(m.why)}`),
        corrected: a.corrections === 1,
        nativeSpawns: a.nativeStrikes
      }
    }
    const rootVerdict = this.rootVerdict()
    const failedSubtree = subtreeFailed(this.state)
    return { summary: { failed, corrected, nativeSpawns, ...(rootVerdict ? { rootVerdict } : {}), ...(failedSubtree ? { subtreeFailed: true } : {}) }, agents }
  }
}
