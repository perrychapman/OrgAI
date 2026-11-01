import type { CapabilityItem } from '@shared/types'
import { clampText } from './capabilities'

/** The tab to move to for an arrow/Home/End key, wrapping at the ends. Null for any other key. */
export function nextTabId(ids: readonly string[], current: string, key: string): string | null {
  if (ids.length === 0) return null
  const i = Math.max(0, ids.indexOf(current))
  if (key === 'ArrowRight' || key === 'ArrowDown') return ids[(i + 1) % ids.length]
  if (key === 'ArrowLeft' || key === 'ArrowUp') return ids[(i - 1 + ids.length) % ids.length]
  if (key === 'Home') return ids[0]
  if (key === 'End') return ids[ids.length - 1]
  return null
}

/** Skills found on this computer (outside the repo) that can be applied and are not in the project yet. */
export function localSkillCandidates(items: readonly CapabilityItem[]): CapabilityItem[] {
  return items.filter((i) => i.kind === 'skill' && i.origin === 'local' && !i.inProject && !i.blockedReason)
}

/** Empty-list copy by cause: nothing exists at all, versus everything is already on the role. */
export function skillEmptyCopy(tab: 'project' | 'library' | 'local', total: number): string {
  if (tab === 'project') return total === 0 ? 'This project has no skills yet.' : 'All of them are on this role.'
  if (tab === 'library') return total === 0 ? 'Your skill library is empty.' : 'All of them are on this role or already in this project.'
  return total === 0 ? 'No skills found on this computer.' : 'All of them are on this role.'
}

export const CHOOSER_NAME_MAX = 80
export const CHOOSER_DESC_MAX = 200

/** Untrusted row text clamped for display: the name to 80 characters, the description (or location) to 200. */
export const chooserName = (s: string | undefined): string => clampText(s, CHOOSER_NAME_MAX)
export const chooserDesc = (s: string | undefined): string => clampText(s, CHOOSER_DESC_MAX)
