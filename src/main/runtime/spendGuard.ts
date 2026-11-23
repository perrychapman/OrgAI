import { RUN_ADD_BUDGET_MAX_USD, type ProjectSpend, type SpendWarning } from '@shared/types'

/**
 * UI overhaul spending limits (docs/design/ui-overhaul/impl-runtime.md): the pure decisions behind the project's daily /
 * monthly caps, the add-budget refusals and the spend warnings. No I/O: RunManager gathers the numbers (projectSpend,
 * the run's cost, AppSettings.spendWarnPercent) and acts on what these return. Every sentence here is OrgAI-written and
 * says what to change; nothing quotes a provider.
 */

export type CapScope = 'day' | 'month'

/** One daily / monthly cap that the project's spend has reached. */
export interface CapReached {
  scope: CapScope
  limitUsd: number
  spentUsd: number
  /** When the period ends and the spend counts from zero again, epoch ms. */
  resetsAt: number
}

/** The money text used in every sentence: "$5.00". */
export function money(usd: number): string {
  return `$${(Math.round(usd * 100) / 100).toFixed(2)}`
}

const SCOPE_WORD: Record<CapScope, string> = { day: 'daily', month: 'monthly' }

/** A cap value that counts: finite and above 0 (the contract's "finite > 0"). */
export function capValue(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
}

/** The caps `spend` carries with what is spent against each, day first. A period without a cap is absent. */
export function capPeriods(spend: ProjectSpend): CapReached[] {
  const out: CapReached[] = []
  const day = capValue(spend.maxDailyUsd)
  if (day !== undefined) out.push({ scope: 'day', limitUsd: day, spentUsd: spend.day.spentUsd, resetsAt: spend.day.until })
  const month = capValue(spend.maxMonthlyUsd)
  if (month !== undefined) out.push({ scope: 'month', limitUsd: month, spentUsd: spend.month.spentUsd, resetsAt: spend.month.until })
  return out
}

/** Caps already reached (spent at or over the limit), day first. */
export function capsReached(spend: ProjectSpend): CapReached[] {
  return capPeriods(spend).filter((c) => c.spentUsd >= c.limitUsd)
}

/** The refusal text for a reached cap: what happened, when it resets, what to change. */
export function capRefusal(c: CapReached): string {
  return `This project reached its ${SCOPE_WORD[c.scope]} spending limit of ${money(c.limitUsd)}. It counts from zero again when the ${c.scope} ends, or you can raise the limit in Settings.`
}

/** Why a run may not start (or continue) now under the project's caps, or null. The first reached cap, day before month. */
export function startRefusal(spend: ProjectSpend | undefined): string | null {
  if (!spend) return null
  const hit = capsReached(spend)[0]
  return hit ? capRefusal(hit) : null
}

/** What a live run does at a reached cap: Project.onSpendLimit, 'pause' unless the project says 'stop'. Headless exec runs always stop (no one can wait). */
export function spendLimitMode(onSpendLimit: unknown, exec: boolean): 'pause' | 'stop' {
  if (exec) return 'stop'
  return onSpendLimit === 'stop' ? 'stop' : 'pause'
}

/** The pause reason / log line when a live run reaches a cap. */
export function spendLimitReason(c: CapReached, mode: 'pause' | 'stop'): string {
  const lead = `This project reached its ${SCOPE_WORD[c.scope]} spending limit of ${money(c.limitUsd)} (${money(c.spentUsd)} spent).`
  return mode === 'pause'
    ? `${lead} The run is paused until the ${c.scope} resets. Continue it then, or raise the limit in Settings.`
    : `${lead} The run was stopped. Continue it after the ${c.scope} resets, or raise the limit in Settings.`
}

/**
 * Why `addUsd` may not be added to a run's budget, or null. The per-run cap (project.maxBudgetUsd) stays the ceiling and
 * so do what is left of the daily and monthly caps. `projectCapUsd` undefined = the project has no per-run cap.
 */
export function addBudgetRefusal(input: { addUsd: unknown; projectCapUsd?: number; spend?: ProjectSpend }): string | null {
  const { addUsd, projectCapUsd, spend } = input
  if (typeof addUsd !== 'number' || !Number.isFinite(addUsd) || addUsd <= 0) return 'Choose an amount above $0.'
  if (addUsd > RUN_ADD_BUDGET_MAX_USD) return `You can add at most ${money(RUN_ADD_BUDGET_MAX_USD)} at a time.`
  if (projectCapUsd !== undefined && addUsd > projectCapUsd) {
    return `That is more than this project allows for one run (${money(projectCapUsd)}). Raise the project's limit in Settings to go higher.`
  }
  for (const c of spend ? capPeriods(spend) : []) {
    const left = c.limitUsd - c.spentUsd
    if (left <= 0) return capRefusal(c)
    if (addUsd > left + 1e-9) {
      return `Only ${money(left)} is left of this project's ${SCOPE_WORD[c.scope]} spending limit. Raise the limit in Settings to add more.`
    }
  }
  return null
}

/**
 * A conversation chain (model handoff) keeps one total cap. Adding raises it for this chain by `addUsd`, still bounded by
 * the project's cap. Returns the new total, or the refusal when nothing would be left to spend.
 */
export function raiseConversationCap(input: { conversationUsd: number; addUsd: number; spentUsd: number; projectCapUsd?: number }): { totalUsd: number } | { refusal: string } {
  const total = Math.min(input.conversationUsd + input.addUsd, input.projectCapUsd ?? Infinity)
  if (!(total > input.spentUsd)) {
    return { refusal: `This conversation already used what the project allows (${money(input.projectCapUsd ?? input.conversationUsd)}). Raise the project's limit in Settings to go higher.` }
  }
  return { totalUsd: total }
}

// ---- Spend warnings ----

export type WarnScope = SpendWarning['scope']

/** One limit a run can be warned about. */
export interface WarnItem {
  scope: WarnScope
  limitUsd: number
  spentUsd: number
}

/** AppSettings.spendWarnPercent when it is on: a finite number from 50 to 99 (anything else is off). */
export function warnPercentOf(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 50 && v <= 99 ? v : undefined
}

/** Warnings that are due: each item whose spend is at `percent` of its limit and was not warned before ("already"). One per scope. */
export function dueWarnings(items: readonly WarnItem[], percent: number | undefined, already: ReadonlySet<WarnScope>, at: number): SpendWarning[] {
  if (percent === undefined) return []
  const out: SpendWarning[] = []
  const seen = new Set<WarnScope>()
  for (const i of items) {
    if (already.has(i.scope) || seen.has(i.scope)) continue
    if (!(i.limitUsd > 0) || !Number.isFinite(i.limitUsd) || !Number.isFinite(i.spentUsd)) continue
    if (i.spentUsd >= (i.limitUsd * percent) / 100) {
      seen.add(i.scope)
      out.push({ scope: i.scope, limitUsd: i.limitUsd, spentUsd: i.spentUsd, percent, at })
    }
  }
  return out
}

const WARN_WHAT: Record<WarnScope, string> = {
  run: "this run's spending limit",
  conversation: "this conversation's spending limit",
  day: "the project's daily spending limit",
  month: "the project's monthly spending limit"
}

/** The run log line for a warning. */
export function warnText(w: SpendWarning): string {
  return `You have used ${Math.round(w.percent)}% of ${WARN_WHAT[w.scope]} (${money(w.spentUsd)} of ${money(w.limitUsd)}).`
}
