/**
 * The run harness log (`RunRecord.logs`) as terminal text, for `orgai runs show --logs` and the TUI `/logs` list:
 * `YYYY-MM-DD HH:MM:SS  LEVEL  message`, one line per entry, the message cleaned (control sequences removed, whitespace
 * collapsed).
 */
import { safeLine } from './output'

export type RunLogEntry = { at: number; level: 'info' | 'warn' | 'error'; message: string }
export type LogLevelFilter = 'warn' | 'info' | 'all'

export const LOG_LEVEL_WORDS: readonly LogLevelFilter[] = ['warn', 'info', 'all']

const RANK = { info: 0, warn: 1, error: 2 } as const

/** `warn` (default): warnings and errors; `info`: info only; `all`: everything. */
export function filterLogs<T extends { level: RunLogEntry['level'] }>(logs: readonly T[], level: LogLevelFilter): T[] {
  if (level === 'all') return [...logs]
  if (level === 'info') return logs.filter((l) => l.level === 'info')
  return logs.filter((l) => RANK[l.level] >= RANK.warn)
}

const p2 = (n: number): string => String(n).padStart(2, '0')

export function logTime(at: number): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return '----------'
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
}

export function logLine(e: RunLogEntry): string {
  const msg = safeLine(String(e.message ?? ''))
  return `${logTime(e.at)}  ${String(e.level).toUpperCase().padEnd(5)}  ${msg}`
}

/** The /logs overlay body: a heading, then one line per entry (oldest first). */
export function logsOverlayText(logs: readonly RunLogEntry[] | undefined, level: LogLevelFilter): string {
  const all = logs ?? []
  const shown = filterLogs(all, level)
  const what = level === 'warn' ? 'Warnings and errors' : level === 'info' ? 'Info lines' : 'All log lines'
  const toggle = level === 'warn' ? '/logs info shows info lines, /logs all everything' : '/logs shows warnings and errors only'
  const head = `${what}: ${shown.length} of ${all.length} (${toggle})`
  return shown.length === 0 ? `${head}\n\nNothing logged.` : `${head}\n\n${shown.map(logLine).join('\n')}`
}
