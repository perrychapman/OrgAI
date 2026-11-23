import type { PermissionMode } from '@shared/types'
import { PERMISSION_MODE_SHORT } from './settingsCopy'
import { PERMISSION_MODE_TRADEOFF } from './permissionCopy'

/**
 * One plain name per permission mode, for every screen in the renderer that names a mode in a card, step or chip
 * (UI overhaul decision 8). The title is what the user reads first; `engine` is the exact mode name (the name the CLI,
 * the Settings select and older run records use) and is shown only as secondary text. The description is the shared
 * one-line trade-off (permissionCopy), which is checked against both providers; this file renames and never re-describes.
 */
export const PERMISSION_TITLE: Record<PermissionMode, string> = {
  default: 'Ask before risky actions',
  acceptEdits: 'Edit freely, ask for commands',
  auto: 'Go ahead within the rules',
  dontAsk: 'Never ask',
  plan: 'Plan only',
  bypassPermissions: 'Skip all checks'
}

/** The mode the Permissions page and first launch mark "Recommended": the app's default for a new code project. */
export const RECOMMENDED_PERMISSION_MODE: PermissionMode = 'auto'

export interface PermissionWords {
  title: string
  description: string
  /** The exact mode name, as secondary text. */
  engine: string
}

export function permissionWords(mode: PermissionMode): PermissionWords {
  return { title: PERMISSION_TITLE[mode], description: PERMISSION_MODE_TRADEOFF[mode], engine: PERMISSION_MODE_SHORT[mode] }
}

export function permissionTitle(mode: PermissionMode): string {
  return PERMISSION_TITLE[mode]
}
