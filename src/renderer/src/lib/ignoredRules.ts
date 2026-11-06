/**
 * Saved rules OrgAI ignores (permissions:ignored). Pure helpers for the "Not used" group of the saved rules panel.
 */

import type { IgnoredPermissionRule } from '@shared/types'
import { hasHidden, showHidden } from './hiddenChars'

export const IGNORED_TITLE = 'Not used'
export const IGNORED_NOTE = 'OrgAI no longer uses rules this broad or unreadable. They stay in the file until you remove them.'
export const IGNORED_CUT_TEXT = 'This rule is too long to remove here. Edit the rules file to remove it.'
export const IGNORED_REMOVED = 'Removed the rule.'

/** The list as a safe array: anything that is not an array of rule objects with text becomes []. */
export function cleanIgnored(list: unknown): IgnoredPermissionRule[] {
  if (!Array.isArray(list)) return []
  return list.filter((i): i is IgnoredPermissionRule => !!i && typeof i === 'object' && typeof (i as IgnoredPermissionRule).rule === 'string' && typeof (i as IgnoredPermissionRule).reason === 'string')
}

/** A cut rule cannot be removed through permissions:remove. */
export function ignoredRemovable(item: IgnoredPermissionRule): boolean {
  return item.cut !== true
}

/** The rule as shown: hidden characters become visible escapes, a cut rule ends in an ellipsis. */
export function ignoredDisplay(item: IgnoredPermissionRule): string {
  const text = hasHidden(item.rule) ? showHidden(item.rule) : item.rule
  return item.cut ? `${text}…` : text
}

export function ignoredRemoveLabel(item: IgnoredPermissionRule, busy: boolean): string {
  const shown = ignoredDisplay(item)
  return busy ? `Removing unused rule ${shown}` : `Remove unused rule ${shown}`
}
