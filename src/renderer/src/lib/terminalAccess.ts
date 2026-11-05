import type { AppSettings } from '@shared/types'

/**
 * What terminal clients may do once Terminal access is on (review H2): AppSettings.terminalAccessLevel, 'operate' by
 * default (start, follow, steer and answer runs) or 'full' (also change settings, connections, connectors and
 * permission rules). Main enforces it at host.hello; this file only reads and labels it.
 */
export type TerminalAccessLevel = 'operate' | 'full'

export const DEFAULT_TERMINAL_ACCESS_LEVEL: TerminalAccessLevel = 'operate'

export const TERMINAL_ACCESS_LEVEL_OPTIONS: { value: TerminalAccessLevel; label: string }[] = [
  { value: 'operate', label: 'Run and answer runs' },
  { value: 'full', label: 'Full control' }
]

/** One line under the choice, per level. */
export const TERMINAL_ACCESS_LEVEL_HINT: Record<TerminalAccessLevel, string> = {
  operate: 'Terminals can start, follow and stop runs and answer their decisions, but not change settings.',
  full: 'Terminals can also change settings, connections, connectors and permission rules.'
}

/** The stored level; anything but 'full' reads as the default. */
export function terminalAccessLevelOf(settings: Partial<AppSettings> | null | undefined): TerminalAccessLevel {
  const raw = (settings as { terminalAccessLevel?: unknown } | null | undefined)?.terminalAccessLevel
  return raw === 'full' ? 'full' : DEFAULT_TERMINAL_ACCESS_LEVEL
}

export function isTerminalAccessLevel(v: string): v is TerminalAccessLevel {
  return v === 'operate' || v === 'full'
}

/** A settings patch that sets the level. Typed loosely so it compiles before and after the shared field lands. */
export function terminalAccessLevelPatch(level: TerminalAccessLevel): Partial<AppSettings> {
  return { terminalAccessLevel: level } as unknown as Partial<AppSettings>
}
