/** Bidi, zero-width and control characters (other than tab and newline) that can disguise a command. */
export const HIDDEN_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏؜﻿‪-‮⁦-⁩]/
const HIDDEN_ALL = new RegExp(HIDDEN_CHARS.source, 'g')

/** True when `s` holds a hidden character. */
export function hasHidden(s: string | undefined | null): boolean {
  return typeof s === 'string' && HIDDEN_CHARS.test(s)
}

/** Replaces hidden characters with visible \\uXXXX escapes. */
export function showHidden(s: string): string {
  return s.replace(HIDDEN_ALL, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}
