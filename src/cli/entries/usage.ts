/** `orgai usage` (cli-spec 6.3, Wave 5). Pure data. */
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'usage',
  summary: 'Usage and cost',
  usage: 'usage [show|csv|refresh] [options]',
  subcommands: ['show', 'csv', 'refresh'],
  flags: [
    { name: 'range', takesValue: true, values: ['day', 'week', 'month', 'all'], summary: 'Runs started today, this week, this month or ever (default all)' },
    { name: 'month', takesValue: true, summary: 'Runs started in this month (YYYY-MM)' },
    { name: 'limit', takesValue: true, summary: 'At most this many runs, newest first (1-2000)' },
    { name: 'all-projects', takesValue: false, summary: 'Every project, not just the current one' },
    { name: 'out', short: 'o', takesValue: true, summary: 'csv: write to this file instead of stdout' },
    { name: 'force', takesValue: false, summary: 'csv --out: replace an existing file' }
  ],
  available: true
}
