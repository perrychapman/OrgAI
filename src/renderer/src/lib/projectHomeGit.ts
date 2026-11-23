import { formatUsdCompact } from '@shared/view/cost'
import type { Schedule } from '@shared/types'
import { relativeTime } from '@shared/view/runChains'
import { plural, type LineTone } from './projectHome'

/**
 * The git side of the code Home: the repo strip, the health lines and "merged lately". The shape below is what this
 * file needs; `normalizeGit` maps the main process's answer onto it and drops anything it cannot trust, so a missing
 * or odd field leaves its line out instead of showing a wrong one. Pure.
 */

export interface HomeCommit {
  subject: string
  at: number
  added: number
  removed: number
}

export interface HomeGit {
  /** The checked out branch ('' when detached or unknown). */
  branch?: string
  defaultBranch?: string
  /** The newest commit on the default branch ("last merge"). */
  lastMergeAt?: number
  /** Files with uncommitted changes in the working tree. */
  dirtyFiles?: number
  /** Branches not merged into the default branch, and when the oldest one's tip was committed. */
  unmerged?: { count: number; oldestAt?: number }
  ahead?: number
  behind?: number
  /** Recent commits on the default branch, newest first. */
  commits?: HomeCommit[]
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** Maps an unknown answer onto HomeGit; null when it holds nothing usable (the git sections are then left out). */
export function normalizeGit(raw: unknown): HomeGit | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.available === false) return null
  const out: HomeGit = {}
  const branch = str(r.branch)
  if (branch) out.branch = branch
  const def = str(r.defaultBranch)
  if (def) out.defaultBranch = def
  const lastAt = num((r.lastCommit as Record<string, unknown> | undefined)?.at) ?? num(r.lastMergeAt)
  if (lastAt !== undefined) out.lastMergeAt = lastAt
  const dirty = num(r.dirtyFiles) ?? num(r.dirty)
  if (dirty !== undefined) out.dirtyFiles = dirty
  const un = r.unmerged as Record<string, unknown> | undefined
  const unCount = num(un?.count)
  if (unCount !== undefined) {
    const oldest = num(un?.oldestAt)
    out.unmerged = { count: unCount, ...(oldest !== undefined ? { oldestAt: oldest } : {}) }
  }
  const ahead = num(r.ahead)
  const behind = num(r.behind)
  if (ahead !== undefined) out.ahead = ahead
  if (behind !== undefined) out.behind = behind
  if (Array.isArray(r.commits)) {
    const commits: HomeCommit[] = []
    for (const c of r.commits) {
      const cr = c as Record<string, unknown>
      const subject = str(cr?.subject)
      const at = num(cr?.at)
      if (!subject || at === undefined) continue
      commits.push({ subject, at, added: num(cr.added) ?? num(cr.insertions) ?? 0, removed: num(cr.removed) ?? num(cr.deletions) ?? 0 })
    }
    out.commits = commits
  }
  return Object.keys(out).length > 0 ? out : null
}

// ---------- Repo strip ----------

export interface StripItem {
  key: string
  label: string
  value: string
  /** 'accent' | 'ok' | 'working' | 'muted': the square before the label. */
  mark: 'accent' | 'ok' | 'working' | 'muted'
  title?: string
}

/** The mono strip under the topbar: branch, last merge, open branches, folder. The folder is always known. */
export function repoStrip(git: HomeGit | null | undefined, folder: string, now: number): StripItem[] {
  const items: StripItem[] = []
  if (git?.branch) items.push({ key: 'branch', label: 'branch', value: git.branch, mark: 'accent' })
  if (git?.lastMergeAt !== undefined) items.push({ key: 'merge', label: 'last merge', value: relativeTime(git.lastMergeAt, now), mark: 'ok' })
  if (git?.unmerged) items.push({ key: 'branches', label: 'open branches', value: String(git.unmerged.count), mark: 'working' })
  items.push({ key: 'folder', label: 'folder', value: folder, mark: 'muted', title: folder })
  return items
}

// ---------- Health ----------

export interface HealthLine {
  key: string
  label: string
  value: string
  tone: LineTone
}

/** Whole days between two instants, at least 0. */
function ageDays(at: number, now: number): number {
  return Math.max(0, Math.floor((now - at) / 86_400_000))
}

/** "oldest 2 days" / "oldest today". */
export function oldestText(at: number, now: number): string {
  const d = ageDays(at, now)
  return d === 0 ? 'oldest today' : `oldest ${plural(d, 'day')}`
}

/** Only real lines: git facts the repository answered, then the schedules' newest outcomes. Empty = the section is left out. */
export function healthLines(git: HomeGit | null | undefined, schedules: readonly Pick<Schedule, 'id' | 'name' | 'lastEntry' | 'consecutiveFailures' | 'state'>[], now: number): HealthLine[] {
  const lines: HealthLine[] = []
  if (git?.unmerged) {
    const { count, oldestAt } = git.unmerged
    lines.push({
      key: 'unmerged',
      label: 'Unmerged branches',
      value: count === 0 ? 'none' : `${count}${oldestAt !== undefined ? `, ${oldestText(oldestAt, now)}` : ''}`,
      tone: count === 0 ? 'ok' : ageDays(oldestAt ?? now, now) >= 7 ? 'warn' : 'muted'
    })
  }
  if (git?.dirtyFiles !== undefined) {
    lines.push({ key: 'dirty', label: 'Changes not committed', value: git.dirtyFiles === 0 ? 'none' : plural(git.dirtyFiles, 'file'), tone: git.dirtyFiles === 0 ? 'ok' : 'warn' })
  }
  if (git?.ahead !== undefined || git?.behind !== undefined) {
    const ahead = git.ahead ?? 0
    const behind = git.behind ?? 0
    lines.push({
      key: 'sync',
      label: git.defaultBranch ? `${git.defaultBranch} and its remote` : 'Branch and its remote',
      value: ahead === 0 && behind === 0 ? 'in step' : [ahead > 0 ? `${ahead} ahead` : '', behind > 0 ? `${behind} behind` : ''].filter(Boolean).join(', '),
      tone: behind > 0 ? 'warn' : 'ok'
    })
  }
  for (const s of schedules) {
    const e = s.lastEntry
    if (!e) continue
    const bad = e.result === 'failed' || e.outcome === 'error'
    const warn = e.result === 'skipped' || e.outcome === 'needs-you'
    lines.push({
      key: `sch:${s.id}`,
      label: s.name,
      value: bad ? 'failed' : warn ? (e.result === 'skipped' ? 'skipped' : 'needs you') : e.outcome === 'finished' ? 'finished' : e.outcome === 'stopped' ? 'stopped' : 'started',
      tone: bad ? 'bad' : warn ? 'warn' : e.outcome === 'finished' ? 'ok' : 'muted'
    })
  }
  return lines
}

// ---------- Nightly bar ----------

export interface NightlyBar {
  /** Height in percent of the track, 18 to 100. */
  height: number
  tone: 'ok' | 'bad' | 'warn'
  label: string
}

export interface OutcomeIn {
  at: number
  outcome?: 'finished' | 'error' | 'stopped' | 'needs-you'
  result?: 'started' | 'skipped' | 'failed'
  costUsd?: number | null
}

/** Most bars drawn. */
export const NIGHTLY_MAX = 14

/**
 * One bar per handled slot of a schedule, oldest left, from its real history (failed or error = tall red; skipped and
 * needs-you = amber; finished = green, its height the cost when known and otherwise a fixed low bar). Fewer than 3 entries
 * is not a pattern: returns null and the bar is left out.
 */
export function nightlyBars(entries: readonly OutcomeIn[], now: number, max = NIGHTLY_MAX): NightlyBar[] | null {
  const recent = [...entries].sort((a, b) => b.at - a.at).slice(0, max).reverse()
  if (recent.length < 3) return null
  const costs = recent.map((e) => (typeof e.costUsd === 'number' ? e.costUsd : 0))
  const top = Math.max(...costs)
  return recent.map((e, i) => {
    const bad = e.result === 'failed' || e.outcome === 'error'
    const warn = e.result === 'skipped' || e.outcome === 'needs-you'
    const tone = bad ? 'bad' : warn ? 'warn' : 'ok'
    const height = bad ? 100 : warn ? 60 : top > 0 && costs[i] > 0 ? Math.round(30 + (costs[i] / top) * 40) : 40
    const word = bad ? 'failed' : warn ? (e.result === 'skipped' ? 'skipped' : 'needs you') : e.outcome === 'finished' ? 'finished' : 'started'
    const cost = typeof e.costUsd === 'number' ? `, ${formatUsdCompact(e.costUsd)}` : ''
    return { height, tone, label: `${relativeTime(e.at, now)}: ${word}${cost}` }
  })
}

/** The text alternative of the nightly bar: "Last 14 runs: 12 finished, 2 failed". */
export function nightlySummary(bars: readonly NightlyBar[]): string {
  const n = (t: NightlyBar['tone']): number => bars.filter((b) => b.tone === t).length
  const parts = [`${n('ok')} fine`, n('bad') ? `${n('bad')} failed` : '', n('warn') ? `${n('warn')} skipped or needing you` : ''].filter(Boolean)
  return `Last ${bars.length} runs: ${parts.join(', ')}`
}

// ---------- Merged lately ----------

export interface MergedRow {
  key: string
  subject: string
  added: number
  removed: number
  when: string
}

/** Short age for a narrow column: "now", "5 m", "2 h", "3 d", "2 w". */
export function shortAge(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h`
  const d = Math.round(h / 24)
  return d < 14 ? `${d} d` : `${Math.round(d / 7)} w`
}

export const MERGED_MAX = 5

export function mergedRows(git: HomeGit | null | undefined, now: number, max = MERGED_MAX): MergedRow[] {
  return (git?.commits ?? []).slice(0, max).map((c, i) => ({ key: `${i}:${c.at}`, subject: c.subject, added: c.added, removed: c.removed, when: shortAge(c.at, now) }))
}
