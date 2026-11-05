/** Slash command registry (W4-T4). Stub until W4-T4 lands. */
import type { SlashCommand, TuiState } from './types'

export const SLASH_COMMANDS: readonly SlashCommand[] = []

export function matchSlash(query: string, s: TuiState): SlashCommand[] {
  void [query, s]
  throw new Error('not implemented (Wave 4)')
}

export function parseSlash(line: string): { name: string; args: string } | null {
  void line
  throw new Error('not implemented (Wave 4)')
}
