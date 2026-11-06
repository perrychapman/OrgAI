/**
 * The /usage text (ux-review-tui-org.md F11): the app's Usage tab as plain text for the pager. Totals, then By agent and
 * By role tables, the whole followed chain summed. Pure over TuiState; numbers come from RunSummary.usage and
 * AgentInstance.usage, words and rounding from the shared view helpers, so an unknown cost reads "unknown" (never $0)
 * and a partly priced one "$0.40+". Names are sanitized (one line each).
 */
import type { AgentInstance, RoleUsage, RunUsage, TokenUsage } from '../../shared/types'
import { agentRows, formatHitRate, runSignals, timeRows, type AgentRow } from '../../shared/view/usageView'
import { costView, formatDuration, formatTokens, runCostInput, sumCosts, type CostInput } from '../../shared/view/cost'
import { safeLine } from '../output'
import { textWidth } from './panes/text'
import { chainRuns, runTagOf } from './selectors'
import type { TuiRun, TuiState } from './types'

const addTokens = (a: TokenUsage, b: TokenUsage): TokenUsage => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite })
const ZERO: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const promptOf = (t: TokenUsage): number => t.input + t.cacheRead + t.cacheWrite

/** Left-aligned cells padded to the column widths; the last cell is not padded. */
function table(head: string[], rows: string[][], rightFrom = 1): string[] {
  const widths = head.map((h, i) => Math.max(textWidth(h), ...rows.map((r) => textWidth(r[i] ?? ''))))
  const padEnd = (c: string, w: number): string => c + ' '.repeat(Math.max(0, w - textWidth(c)))
  const padStart = (c: string, w: number): string => ' '.repeat(Math.max(0, w - textWidth(c))) + c
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => (i === 0 ? padEnd(c, widths[i]) : i >= rightFrom ? padStart(c, widths[i]) : padEnd(c, widths[i])))
      .join('  ')
      .trimEnd()
  return [line(head), ...rows.map(line)]
}

const costText = (c: CostInput): string => {
  const v = costView(c)
  return v.empty ? '-' : v.text
}

interface RoleAcc {
  name: string
  slug: string
  agents: number
  tokens: TokenUsage
  turns: number
  toolCalls: number
  costs: CostInput[]
}

function rolesOf(runs: readonly TuiRun[]): RoleAcc[] {
  const by = new Map<string, RoleAcc>()
  const take = (slug: string, name: string, agents: number, tokens: TokenUsage, turns: number, toolCalls: number, cost: CostInput): void => {
    const key = slug || name
    const acc = by.get(key) ?? { name, slug, agents: 0, tokens: ZERO, turns: 0, toolCalls: 0, costs: [] }
    acc.agents += agents
    acc.tokens = addTokens(acc.tokens, tokens)
    acc.turns += turns
    acc.toolCalls += toolCalls
    acc.costs.push(cost)
    by.set(key, acc)
  }
  for (const run of runs) {
    const u: RunUsage | undefined = run.summary.usage
    if (u && Array.isArray(u.roles) && u.roles.length > 0) {
      for (const r of u.roles as RoleUsage[]) take(r.roleSlug, safeLine(r.roleName || r.roleSlug), r.agents, r.tokens, r.turns, r.toolCalls, r)
    } else {
      for (const a of Object.values(run.agents)) {
        const row = agentRows([a])[0]
        take(a.roleSlug, safeLine(a.name), 1, row.tokens, row.turns, row.toolCalls, row.cost)
      }
    }
  }
  return [...by.values()].sort((a, b) => promptOf(b.tokens) + b.tokens.output - (promptOf(a.tokens) + a.tokens.output) || a.name.localeCompare(b.name))
}

/** The usage text for the followed chain. Empty-run cases answer with one sentence. */
export function usageText(s: TuiState): string {
  const runs = chainRuns(s)
  if (runs.length === 0) return 'No run is open. Follow a run first (/run R1).'
  const newest = runs[runs.length - 1]
  const summaries = runs.map((r) => r.summary)
  const withUsage = summaries.filter((x) => x.usage)
  const out: string[] = []
  const head = `Usage for ${runTagOf(s, newest.summary.id)}${runs.length > 1 ? ` and the ${runs.length - 1} run${runs.length === 2 ? '' : 's'} before it (one conversation)` : ''}`
  out.push(head, '')

  const cost = costView(runs.length > 1 ? sumCosts(summaries.map((x) => runCostInput(x))) : runCostInput(newest.summary))
  const tokens = withUsage.reduce((t, x) => addTokens(t, x.usage!.tokens), ZERO)
  const agentList: AgentInstance[] = runs.flatMap((r) => Object.values(r.agents))
  const rows: AgentRow[] = agentRows(agentList)
  const sumTokens = withUsage.length > 0 ? tokens : rows.reduce((t, r) => addTokens(t, r.tokens), ZERO)
  const turns = withUsage.length > 0 ? withUsage.reduce((n, x) => n + x.usage!.turns, 0) : rows.reduce((n, r) => n + r.turns, 0)
  const toolCalls = withUsage.length > 0 ? withUsage.reduce((n, x) => n + x.usage!.toolCalls, 0) : rows.reduce((n, r) => n + r.toolCalls, 0)
  const wallMs = withUsage.reduce((n, x) => n + x.usage!.wallMs, 0)

  out.push(`Cost        ${cost.text}${cost.kind === 'unknown' ? ' (no price known for the models used)' : cost.kind === 'partial' ? ' (a lower bound: some models have no price)' : ''}`)
  if (wallMs > 0) out.push(`Wall time   ${formatDuration(wallMs)}`)
  out.push(`Tokens      ${formatTokens(promptOf(sumTokens))} in / ${formatTokens(sumTokens.output)} out  (cache read ${formatTokens(sumTokens.cacheRead)}, cache write ${formatTokens(sumTokens.cacheWrite)}, cache hit ${formatHitRate(sumTokens)})`)
  out.push(`Work        ${turns} turn${turns === 1 ? '' : 's'}, ${toolCalls} tool call${toolCalls === 1 ? '' : 's'}, ${agentList.length} agent${agentList.length === 1 ? '' : 's'}`)
  for (const u of withUsage.map((x) => x.usage!)) for (const t of timeRows(u).filter((r) => r.id !== 'wall')) out.push(`${t.label.padEnd(11)} ${t.text}`)
  if (withUsage.length === 0) out.push('', 'This run has no usage numbers yet (they arrive with the first model response).')

  const unpriced = [...new Set(withUsage.flatMap((x) => x.usage!.models.filter((m) => m.costUsd === null || m.priceSource === 'unknown').map((m) => safeLine(m.model))))].filter(Boolean)
  if (unpriced.length > 0) out.push(`No price for ${unpriced.slice(0, 6).join(', ')}${unpriced.length > 6 ? ', ...' : ''}; set one in the desktop app (App settings > Connections > Model prices).`)

  const flat = newest.summary.usage
  if (flat && runs.length === 1) {
    const notes = runSignals(flat, rows).map(safeLine)
    if (notes.length > 0) out.push('', 'Notes', ...notes.map((n) => `  ${n}`))
  }

  if (rows.length > 0) {
    out.push('', 'By agent')
    const body = rows.map((r) => [
      safeLine(r.label) + (r.sub && r.sub !== r.label ? ` (${safeLine(r.sub)})` : '') + (r.approximate ? ' ~' : ''),
      `${formatTokens(promptOf(r.tokens))} in`,
      `${formatTokens(r.tokens.output)} out`,
      costText(r.cost),
      String(r.turns),
      String(r.toolCalls)
    ])
    out.push(...table(['Agent', 'In', 'Out', 'Cost', 'Turns', 'Tools'], body).map((l) => `  ${l}`))
    if (rows.some((r) => r.approximate)) out.push('  ~ approximate: recorded before usage tracking, or no usage reported yet.')
  }

  const roles = rolesOf(runs)
  if (roles.length > 0) {
    out.push('', 'By role')
    const body = roles.map((r) => [r.name, String(r.agents), `${formatTokens(promptOf(r.tokens))} in`, `${formatTokens(r.tokens.output)} out`, costText(sumCosts(r.costs)), String(r.turns), String(r.toolCalls)])
    out.push(...table(['Role', 'Agents', 'In', 'Out', 'Cost', 'Turns', 'Tools'], body).map((l) => `  ${l}`))
  }
  return out.join('\n')
}
