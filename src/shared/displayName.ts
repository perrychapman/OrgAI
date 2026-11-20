import { hasHidden } from './view/hiddenChars'

/** Longest display name, in code points. */
export const DISPLAY_NAME_MAX_CHARS = 40

/**
 * AppSettings.displayName from untrusted data. Trims and collapses whitespace runs to one space. Returns undefined
 * (the name is unset, never repaired or clipped) for a non-string, an empty result, more than 40 code points, or any
 * control, bidi, zero-width or other hidden character (the check shared/view/hiddenChars.ts `hasHidden`, the one
 * the to-do cleaner in shared/todos.ts uses).
 */
export function cleanDisplayName(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined
  if (hasHidden(input)) return undefined
  const name = input.trim().replace(/\s+/g, ' ')
  if (!name) return undefined
  if ([...name].length > DISPLAY_NAME_MAX_CHARS) return undefined
  return name
}
