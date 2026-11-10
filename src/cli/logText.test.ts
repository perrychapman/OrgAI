import { describe, expect, it } from 'vitest'
import { filterLogs, logLine, logsOverlayText, logTime } from './logText'

const logs = [
  { at: 1_700_000_000_000, level: 'info' as const, message: 'Models: orchestrator on sonnet' },
  { at: 1_700_000_001_000, level: 'warn' as const, message: 'Slow\x1b[31m tool\nresult' },
  { at: 1_700_000_002_000, level: 'error' as const, message: 'Boom' }
]

describe('logText', () => {
  it('filters by level word', () => {
    expect(filterLogs(logs, 'warn').map((l) => l.level)).toEqual(['warn', 'error'])
    expect(filterLogs(logs, 'info').map((l) => l.level)).toEqual(['info'])
    expect(filterLogs(logs, 'all')).toHaveLength(3)
  })
  it('cleans a line to time, level and one line of message', () => {
    expect(logLine(logs[1])).toBe(`${logTime(logs[1].at)}  WARN   Slow tool result`)
    expect(logLine(logs[2])).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d {2}ERROR {2}Boom$/)
  })
  it('the overlay text counts what is shown and says how to widen it', () => {
    const t = logsOverlayText(logs, 'warn')
    expect(t).toContain('Warnings and errors: 2 of 3 (/logs info shows info lines, /logs all everything)')
    expect(t).not.toContain('Models:')
    expect(logsOverlayText(undefined, 'all')).toContain('Nothing logged.')
  })
})
