import type { AppSettings, TerminalAccessLevel } from '@shared/types'

export type { TerminalAccessLevel }

/**
 * What terminal clients may do once Terminal access is on (review H2): AppSettings.terminalAccessLevel, 'operate' by
 * default (the 'read' and 'operate' scopes: start, follow, send to, interrupt and stop runs) or 'full' (also 'decide':
 * answer decision cards, and 'configure': settings, connections, connectors, permission rules). Main enforces it at
 * host.hello (socketServer.ts scopesForAccessLevel); this file only reads and labels it.
 */

export const DEFAULT_TERMINAL_ACCESS_LEVEL: TerminalAccessLevel = 'operate'

export const TERMINAL_ACCESS_LEVEL_OPTIONS: { value: TerminalAccessLevel; label: string }[] = [
  { value: 'operate', label: 'Start and follow runs' },
  { value: 'full', label: 'Full control' }
]

/** One line under the choice, per level. */
export const TERMINAL_ACCESS_LEVEL_HINT: Record<TerminalAccessLevel, string> = {
  operate: 'Terminals can start, follow, message and stop runs, but not answer decisions or change settings.',
  full: 'Terminals can also answer decisions and change settings, connections, connectors and permission rules.'
}

/** The stored level; anything but 'full' reads as the default. */
export function terminalAccessLevelOf(settings: Partial<AppSettings> | null | undefined): TerminalAccessLevel {
  const raw: unknown = settings?.terminalAccessLevel
  return raw === 'full' ? 'full' : DEFAULT_TERMINAL_ACCESS_LEVEL
}

export function isTerminalAccessLevel(v: string): v is TerminalAccessLevel {
  return v === 'operate' || v === 'full'
}

/** A settings patch that sets the level. */
export function terminalAccessLevelPatch(level: TerminalAccessLevel): Partial<AppSettings> {
  return { terminalAccessLevel: level }
}
