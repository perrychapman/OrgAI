/**
 * Required delegation (docs/design/delegation-enforcement.md 4.4, 4.5, 5.3, 5.8): pure decisions over a DelegationLedgerState.
 * No I/O, no Electron. DelegationLedger (delegationLedger.ts) owns the state; adapters ask through RuntimeContext.delegation.
 */
import { cleanRequiredReports } from '@shared/defaults'
import type { DelegationLedgerState, DelegationReceipt, DelegationVerdict, Role } from '@shared/types'

export type MissingWhy = 'never-spawned' | 'running' | 'ended-without-report' | 'not-delivered' | 'report-failed'

export interface MissingReport {
  roleId: string
  why: MissingWhy
}

export type AttemptAction = 'allow' | 'wait' | 'correct' | 'fail'

export interface AttemptResult {
  action: AttemptAction
  /** 'adaptive' / 'ok' on allow, 'failed' on fail; none while the agent may still be waiting or corrected. */
  verdict?: DelegationVerdict
  missing: MissingReport[]
}

/** Agent phases that mean the child may still hand a report back. */
const RUNNING_PHASES: ReadonlySet<string> = new Set(['working', 'waiting', 'correcting'])

/**
 * The roles' obligations: role id -> role ids it must delegate to. Strict: every role that can spawn requires its whole
 * spawnable list. Otherwise Role.requiredReports (cleaned). Roles without obligations are absent. A role never requires itself.
 */
export function obligationsFor(roles: readonly Role[], strict: boolean): Record<string, string[]> {
  const known = new Set(roles.map((r) => r.id))
  const out: Record<string, string[]> = {}
  for (const role of roles) {
    let list: string[] | undefined
    if (strict) {
      if (role.canSpawn) {
        const ids = [...new Set(role.spawnable ?? [])].filter((id) => id !== role.id && known.has(id))
        list = ids.length > 0 ? ids : undefined
      }
    } else list = cleanRequiredReports(role)?.filter((id) => known.has(id))
    if (list && list.length > 0) out[role.id] = list
  }
  return out
}

/** A receipt that counts: delivered, not failed, with a non-empty report. */
export function isValidReceipt(r: DelegationReceipt | undefined): boolean {
  return !!r && r.delivered && r.verdict !== 'failed' && r.reportChars > 0
}

/** The latest DELIVERED receipt for (parent, role), whatever its verdict. */
function latestDelivered(receipts: readonly DelegationReceipt[], parentId: string, roleId: string): DelegationReceipt | undefined {
  for (let i = receipts.length - 1; i >= 0; i--) {
    const r = receipts[i]
    if (r.parentId === parentId && r.roleId === roleId && r.delivered) return r
  }
  return undefined
}

/** Does (parent, role) have a valid receipt (spec 4.3)? */
export function hasValidReceipt(ledger: Pick<DelegationLedgerState, 'receipts'>, parentId: string, roleId: string): boolean {
  return isValidReceipt(latestDelivered(ledger.receipts, parentId, roleId))
}

/** The missing required reports of an agent (empty = every one is satisfied or nothing is required). */
export function missingReports(agentId: string, ledger: DelegationLedgerState): MissingReport[] {
  const agent = ledger.agents[agentId]
  if (!agent) return []
  const missing: MissingReport[] = []
  for (const roleId of agent.required) {
    if (hasValidReceipt(ledger, agentId, roleId)) continue
    const children = Object.entries(ledger.agents).filter(([, a]) => a.parentId === agentId && a.roleId === roleId)
    if (children.some(([, a]) => RUNNING_PHASES.has(a.phase))) {
      missing.push({ roleId, why: 'running' })
      continue
    }
    let last: DelegationReceipt | undefined
    for (const r of ledger.receipts) if (r.parentId === agentId && r.roleId === roleId) last = r
    if (!last) missing.push({ roleId, why: children.length > 0 ? 'ended-without-report' : 'never-spawned' })
    else if (!last.delivered) missing.push({ roleId, why: 'not-delivered' })
    else missing.push({ roleId, why: 'report-failed' })
  }
  return missing
}

/** The completion decision (spec 4.4). Pure: the caller applies the consequences (corrections, phase, receipt). */
export function attempt(agentId: string, ledger: DelegationLedgerState, opts: { canCorrect: boolean; canWait: boolean }): AttemptResult {
  const agent = ledger.agents[agentId]
  if (!agent || agent.required.length === 0) return { action: 'allow', verdict: 'adaptive', missing: [] }
  const missing = missingReports(agentId, ledger)
  if (opts.canWait && missing.some((m) => m.why === 'running')) return { action: 'wait', missing }
  if (missing.length === 0) return { action: 'allow', verdict: 'ok', missing }
  if (agent.corrections === 1 || !opts.canCorrect) return { action: 'fail', verdict: 'failed', missing }
  return { action: 'correct', missing }
}

/** Preflight (spec 4.5): obligations that cannot be met under the limits. Empty = fine. */
export function delegationPreflight(
  roles: readonly Role[],
  obligations: Record<string, string[]>,
  limits: { depth: number; concurrency: number },
  adapter: 'claude' | 'codex' | 'mock',
  bridgedRoleIds: readonly string[]
): string[] {
  const problems: string[] = []
  const byId = new Map(roles.map((r) => [r.id, r]))
  const name = (id: string): string => byId.get(id)?.name ?? id
  const root = roles.find((r) => r.reportsTo === null)

  // Depth: shortest spawnable hop distance d from the root to a role with obligations; its reports sit at d + 1.
  if (root) {
    const dist = new Map<string, number>([[root.id, 0]])
    const queue = [root.id]
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]
      for (const next of byId.get(id)?.spawnable ?? []) {
        if (byId.has(next) && !dist.has(next)) {
          dist.set(next, (dist.get(id) ?? 0) + 1)
          queue.push(next)
        }
      }
    }
    for (const id of Object.keys(obligations)) {
      const d = dist.get(id)
      if (d !== undefined && d + 1 > limits.depth) {
        problems.push(`${name(id)} must delegate to ${obligations[id].map(name).join(', ')}, which would sit ${d + 1} levels deep; the subagent depth limit is ${limits.depth}.`)
      }
    }
  }

  // Concurrency: the longest chain of required reports (non-root agents).
  const memo = new Map<string, number>()
  const chain = (id: string, seen: Set<string>): number => {
    const cached = memo.get(id)
    if (cached !== undefined) return cached
    let best = 0
    for (const next of obligations[id] ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      best = Math.max(best, 1 + chain(next, seen))
      seen.delete(next)
    }
    memo.set(id, best)
    return best
  }
  let longest = 0
  for (const id of Object.keys(obligations)) longest = Math.max(longest, chain(id, new Set([id])) + (id === root?.id ? 0 : 1))
  if (longest > 0) {
    if (adapter === 'codex') {
      if (limits.concurrency < Math.min(longest, 2)) {
        problems.push(`The required delegation chain needs ${Math.min(longest, 2)} concurrent subagents on Codex; the limit is ${limits.concurrency}.`)
      }
    } else if (limits.concurrency < longest) {
      problems.push(`The required delegation chain is ${longest} agents long and its reports run in the foreground; the concurrent subagent limit is ${limits.concurrency}.`)
    }
  }

  const bridged = new Set(bridgedRoleIds)
  for (const [id, required] of Object.entries(obligations)) {
    for (const r of required) {
      if (bridged.has(r)) problems.push(`${name(id)} must delegate to ${name(r)}, which runs on another connection; required reports into bridged roles are not supported in v1.`)
    }
  }
  return problems
}

/**
 * Did a required delegation fail anywhere (spec 5.8)? An agent with obligations whose verdict is `failed`, or that ended
 * without completing, unless a later valid receipt for the same (parent, role) replaced it.
 */
export function subtreeFailed(ledger: DelegationLedgerState): boolean {
  for (const [id, a] of Object.entries(ledger.agents)) {
    if (a.required.length === 0) continue
    const failed = a.verdict === 'failed' || (a.phase === 'ended' && a.verdict === undefined)
    if (!failed) continue
    if (a.parentId) {
      let ownIndex = -1
      let latestIndex = -1
      ledger.receipts.forEach((r, i) => {
        if (r.childId === id) ownIndex = i
        if (r.parentId === a.parentId && r.roleId === a.roleId && r.delivered) latestIndex = i
      })
      if (latestIndex > ownIndex && isValidReceipt(ledger.receipts[latestIndex])) continue
    }
    return true
  }
  return false
}

// ---------- Texts (spec 5.3) ----------

export interface RoleLabel {
  slug: string
  name: string
}

const WHY_TEXT: Record<MissingWhy, string> = {
  'never-spawned': 'never spawned',
  running: 'is still running',
  'ended-without-report': 'ended without a report',
  'not-delivered': 'finished but its report was not delivered',
  'report-failed': 'returned a failed or empty report'
}

export function whyText(why: string): string {
  return (WHY_TEXT as Record<string, string>)[why] ?? why
}

function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

const tick = (s: string): string => `\`${s}\``

/** The one bounded correction sent when an agent tries to finish without its required reports. */
export function correctionText(i: { roleName: string; required: readonly RoleLabel[]; missing: readonly { slug: string; why: string }[]; spawnTool: string }): string {
  const req = joinAnd(i.required.map((r) => `${r.name} (${tick(r.slug)})`))
  const miss = i.missing.map((m) => `${tick(m.slug)} ${whyText(m.why)}`).join('; ')
  return (
    `Harness: you cannot finish yet. Your role (${i.roleName}) must delegate to ${req} and receive their reports. ` +
    `The run has no such record under you: ${miss}. Spawn them now with ${i.spawnTool}, wait for every report, then finish. ` +
    `Do not describe work the harness has no record of. This is the only reminder: if you finish again without them, ` +
    `your report goes to your lead marked as failing the required delegation.`
  )
}

/** Sent instead of a correction while a required child is still running (no budget used). */
export function waitText(i: { roleName: string; missing: readonly { slug: string; why: string }[] }): string {
  const miss = i.missing.map((m) => `${tick(m.slug)} ${whyText(m.why)}`).join('; ')
  return `Harness: you cannot finish yet. As ${i.roleName} you are still waiting on required reports: ${miss}. Wait for them, then finish.`
}

/** The receipt line placed before a delivered report from a role with required reports. */
export function receiptLine(i: { handle: string; roleName: string; required: readonly { slug: string; childHandle?: string; why?: string }[] }): string {
  const parts = i.required.map((r) => (r.childHandle ? `${r.slug} ✔ ${r.childHandle}` : `${r.slug} ✗ ${whyText(r.why ?? 'never-spawned')}`))
  return `Harness receipt for ${i.handle} (${i.roleName}): required ${parts.join(', ')}. Trust this record over the report's own account of what it delegated.`
}

/** The line placed before the report of an agent that failed its required delegation. */
export function failureLine(i: { handle: string; roleName: string; missing: readonly { slug: string; why: string }[] }): string {
  const miss = i.missing.map((m) => `${m.slug} ${whyText(m.why)}`).join(', ')
  return `Harness: ${i.handle} (${i.roleName}) FAILED its required delegation: ${miss}. Its report below is unsupported on those points.`
}
