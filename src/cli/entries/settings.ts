/** `orgai settings` (cli-parity 3.2). Pure data; the key list lives in commands/settings.ts (SETTING_KEYS). */
import type { CommandEntry } from '../commandTable'

export const ENTRY: CommandEntry = {
  name: 'settings',
  summary: 'App settings that matter in a terminal (project defaults and models)',
  usage: 'settings [list] | settings get <key> | settings set <key> <value>',
  subcommands: ['list', 'get', 'set'],
  flags: [],
  available: true,
  notes: [
    'Keys: defaultPermissionMode, defaultMaxBudgetUsd, defaultKeepRuns, defaultIsolateWriters, defaultAutoContinue, defaultMaxAutoContinues, defaultRootModel, defaultReportModel, setupModel, mcpAssistModel, skillAssistModel, quickRunModel, opusGuardThreshold, communityPrices, notifications. `orgai settings list` shows each one\'s type and meaning.',
    'Model keys take a tier (top, deep, everyday, fast) or a model id an enabled connection lists. Booleans take on or off; defaultMaxBudgetUsd takes none to remove the cap.'
  ]
}
