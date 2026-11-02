/**
 * Control, invisible and bidi characters that can disguise text (tab and newline are allowed). Mirrors the HIDDEN class
 * in src/main/capabilities/sanitize.ts: C0/C1 controls, soft hyphen, combining grapheme joiner, Arabic letter mark,
 * Hangul fillers, Mongolian vowel separator, zero-width, bidi, word joiner and invisible operators, BOM, tag characters.
 */
export const HIDDEN_CLASS =
  '[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u00ad\\u034f\\u061c\\u115f\\u1160\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\u3164\\ufeff\\uffa0\\u{e0000}-\\u{e007f}]'
export const HIDDEN_CHARS = new RegExp(HIDDEN_CLASS, 'u')
const HIDDEN_ALL = new RegExp(HIDDEN_CLASS, 'gu')
/** Every control character too, including tab and newline (labels and titles are one line). */
export const HIDDEN_OR_CONTROL_RUN = new RegExp(`[\\u0000-\\u001f]|${HIDDEN_CLASS}`, 'gu')

/** True when `s` holds a hidden character. */
export function hasHidden(s: string | undefined | null): boolean {
  return typeof s === 'string' && HIDDEN_CHARS.test(s)
}

/** Replaces hidden characters with visible \\uXXXX (or \\u{XXXXX} above the BMP) escapes. */
export function showHidden(s: string): string {
  return s.replace(HIDDEN_ALL, (c) => {
    const cp = c.codePointAt(0) ?? 0
    return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, '0')}`
  })
}
