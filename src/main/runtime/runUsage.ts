import type { AgentInstance, AgentUsage, RunRecord, RunSummary, RunUsage, TokenUsage, UsageStats, UsageStatsQuery } from '@shared/types'
import { emptyTokens } from '@shared/defaults'

/**
 * Vendor-neutral usage metrics: the adapter-facing tally helpers (below, used by claude.ts, codex.ts and mock.ts),
 * plus run aggregation, legacy-record normalization and trend queries (RunManager, RunStore, runs:usageStats).
 * Never imports an SDK. Pricing lives in pricing.ts.
 */

// ---------- adapter-facing helpers (contract: stable signatures) ----------

/** A fresh, zeroed AgentUsage. */
export function emptyAgentUsage(): AgentUsage {
  return { tokens: emptyTokens(), models: [], costUsd: null, costSource: 'none', turns: 0, toolCalls: 0, retries: 0 }
}

/** a + b, field by field (a new object). */
export function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite }
}

/** The agent's usage, created (empty) when missing. */
export function usageOf(agent: AgentInstance): AgentUsage {
  if (!agent.usage) agent.usage = emptyAgentUsage()
  return agent.usage
}

/**
 * Replace one model's cumulative token counts (and the provider's cost for them, when it reported one > 0) on an
 * agent's usage, then recompute usage.tokens and the legacy AgentInstance.inputTokens / outputTokens. Adapters call it
 * with running totals per model (Claude: summed over distinct message ids; Codex: the thread's cumulative usage).
 * Cost fields are left for RunManager to price.
 */
export function setModelTokens(agent: AgentInstance, model: string, tokens: TokenUsage, providerCostUsd?: number): void {
  const usage = usageOf(agent)
  const name = model || 'unknown'
  let entry = usage.models.find((m) => m.model === name)
  if (!entry) {
    entry = { model: name, tokens: emptyTokens(), costUsd: null, priceSource: 'unknown' }
    usage.models.push(entry)
  }
  entry.tokens = { ...tokens }
  if (providerCostUsd !== undefined && Number.isFinite(providerCostUsd) && providerCostUsd > 0) entry.providerCostUsd = providerCostUsd
  else delete entry.providerCostUsd
  usage.tokens = usage.models.reduce((acc, m) => addTokens(acc, m.tokens), emptyTokens())
  agent.inputTokens = usage.tokens.input + usage.tokens.cacheRead + usage.tokens.cacheWrite
  agent.outputTokens = usage.tokens.output
}

/** Count one model response (turn), tool call or API retry on an agent. */
export function countUsage(agent: AgentInstance, kind: 'turns' | 'toolCalls' | 'retries', n = 1): void {
  const usage = usageOf(agent)
  usage[kind] += n
}

// ---------- RunManager / RunStore side (implemented by the Runtime Engineer) ----------

/** Extra run-level inputs RunManager tracks itself. */
export interface RunUsageInputs {
  /** The adapter's last run.cost (provider total, resume base already subtracted). */
  providerTotalUsd?: number
  /** RunPlan.autoContinues of this run. */
  nudges: number
  waitingMs: number
  limitHoldMs: number
  idleMs: number
  now: number
}

/** Aggregate a run's (already priced) agents into RunUsage. */
export function computeRunUsage(_summary: RunSummary, _agents: readonly AgentInstance[], _inputs: RunUsageInputs): RunUsage {
  throw new Error('computeRunUsage: not implemented')
}

/** Fill AgentInstance.usage and RunSummary.usage on a record saved before usage tracking (legacy: true). */
export function normalizeRunRecord(_record: RunRecord): RunRecord {
  throw new Error('normalizeRunRecord: not implemented')
}

/** runs:usageStats over persisted summaries (each with usage filled). */
export function buildUsageStats(_summaries: readonly RunSummary[], _query: UsageStatsQuery, _now: number): UsageStats {
  throw new Error('buildUsageStats: not implemented')
}
