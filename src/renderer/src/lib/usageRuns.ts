/**
 * Row view-models of the Usage page's run tables (docs/design/usage-app.md 6.6 and 7.3): names, status words, cost
 * inputs, cache hit, models, sorting and the window that keeps a 2,000-row table cheap. Pure.
 */
import type { UsageOverviewRow } from '@shared/types'
import { formatDuration, type CostInput } from './cost'
import { displayRunName, runKindWord } from './orgChange'
import { runStatus, type StatusWord } from './runStatus'
import { totalTokens } from './trends'

/** The page's cost figure of a run (Cost precision="page"); legacy rows carry "~". */
export function rowCostInput(row: UsageOverviewRow): CostInput {
  const u = row.usage
  return {
    costUsd: u.costUsd,
    costSource: u.costSource,
    ...(u.costPartial ? { costPartial: true } : {}),
    ...(row.legacy || u.legacy ? { legacy: true } : {}),
    sourceMixed: true,
    models: u.models
  }
}

export const rowName = (row: UsageOverviewRow): string => displayRunName({ kind: row.kind, prompt: row.prompt, title: row.title })

export const rowKindWord = (row: UsageOverviewRow): string =>
  runKindWord({ kind: row.kind, quick: row.quick, prompt: row.prompt, ...(row.team ? { team: row.team } : {}) })

/** The status word of a row (lib/runStatus.ts: Running, Idle, Finished, Stopped, Failed ...). */
export function rowStatusWord(row: UsageOverviewRow): { word: StatusWord; note?: string } {
  const by = row.endedBy
  const v = runStatus(row.status, {
    ...(by === 'user' || by === 'app' ? { endedBy: by } : {}),
    ...(by === 'policy' || by === 'budget' ? { endedByHost: by } : {})
  })
  return { word: v.word, ...(v.note ? { note: v.note } : {}) }
}

/** Cache hit of one run: a percent, or an em dash with the reason (never 0% when the provider reports nothing). */
export function rowCacheHit(row: UsageOverviewRow): { text: string; title?: string; rate: number | null } {
  const t = row.usage.tokens
  if (row.legacy || row.usage.legacy) return { text: '—', title: 'Recorded before OrgAI measured usage', rate: null }
  if (t.cacheRead + t.cacheWrite <= 0) return { text: '—', title: 'Not reported', rate: null }
  const prompt = t.input + t.cacheRead + t.cacheWrite
  const rate = prompt > 0 ? t.cacheRead / prompt : 0
  return { text: `${Math.round(rate * 100)}%`, rate }
}

/** The run's models, most tokens first: "claude-sonnet-4-5 +2" (title lists them all). */
export function rowModels(row: UsageOverviewRow): { text: string; title: string } {
  const list = [...row.usage.models].sort((a, b) => totalTokens(b.tokens) - totalTokens(a.tokens)).map((m) => m.model)
  if (list.length === 0) return { text: '—', title: 'No model recorded' }
  return { text: list.length > 1 ? `${list[0]} +${list.length - 1}` : list[0]!, title: list.join(', ') }
}

export const rowTime = (row: UsageOverviewRow): string => (row.usage.wallMs > 0 ? formatDuration(row.usage.wallMs) : '—')

// ---------- sorting ----------

export type RunSortKey = 'run' | 'when' | 'cost' | 'tokens'
export type RunSortDir = 'asc' | 'desc'

/** First click direction per column: text ascending, figures and dates newest / largest first. */
export const RUN_SORT_FIRST: Record<RunSortKey, RunSortDir> = { run: 'asc', when: 'desc', cost: 'desc', tokens: 'desc' }

/** Sorted copy. Unknown cost always sorts after known ones, by tokens, in both directions. */
export function sortRunRows(rows: readonly UsageOverviewRow[], key: RunSortKey, dir: RunSortDir): UsageOverviewRow[] {
  const sign = dir === 'asc' ? 1 : -1
  const out = [...rows]
  out.sort((a, b) => {
    let c = 0
    switch (key) {
      case 'run':
        c = rowName(a).localeCompare(rowName(b))
        break
      case 'when':
        c = a.startedAt - b.startedAt
        break
      case 'tokens':
        c = totalTokens(a.usage.tokens) - totalTokens(b.usage.tokens)
        break
      case 'cost': {
        const x = a.usage.costUsd === null || a.usage.costSource === 'unknown' ? null : a.usage.costUsd
        const y = b.usage.costUsd === null || b.usage.costSource === 'unknown' ? null : b.usage.costUsd
        if (x === null || y === null) {
          if (x === y) return totalTokens(b.usage.tokens) - totalTokens(a.usage.tokens)
          return x === null ? 1 : -1
        }
        c = x - y
        break
      }
    }
    return c * sign || b.startedAt - a.startedAt
  })
  return out
}

// ---------- windowing (past WINDOW_AFTER rows) ----------

export const RUNS_SHOWN = 100
export const RUNS_WINDOW_AFTER = 300
export const RUN_ROW_PX = 44
export const RUNS_OVERSCAN = 12

export interface RunsWindow {
  start: number
  end: number
  /** Heights of the spacer rows above and below. */
  before: number
  after: number
}

/** The rows to render for a scroll position (fixed row height). */
export function runsWindow(total: number, scrollTop: number, viewport: number, rowPx = RUN_ROW_PX, overscan = RUNS_OVERSCAN): RunsWindow {
  const first = Math.max(0, Math.floor(scrollTop / rowPx) - overscan)
  const last = Math.min(total, Math.ceil((scrollTop + Math.max(viewport, rowPx)) / rowPx) + overscan)
  const start = Math.min(first, total)
  const end = Math.max(start, last)
  return { start, end, before: start * rowPx, after: Math.max(0, total - end) * rowPx }
}

/** Scroll position that brings row `index` into view with the least movement. */
export function runsScrollTopFor(index: number, current: number, viewport: number, rowPx = RUN_ROW_PX): number {
  const top = index * rowPx
  if (top < current) return top
  if (top + rowPx > current + viewport) return top + rowPx - viewport
  return current
}
