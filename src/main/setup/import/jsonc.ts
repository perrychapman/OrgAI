/** JSON with comments and trailing commas (opencode.jsonc, .roomodes). Never throws. */
export function parseJsonc(text: string): { value?: unknown; error?: string } {
  try {
    const s = text.replace(/^﻿/, '')
    let out = ''
    let i = 0
    while (i < s.length) {
      const c = s[i]
      if (c === '"') {
        let j = i + 1
        while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1
        out += s.slice(i, j + 1)
        i = j + 1
      } else if (c === '/' && s[i + 1] === '/') {
        while (i < s.length && s[i] !== '\n') i++
      } else if (c === '/' && s[i + 1] === '*') {
        const end = s.indexOf('*/', i + 2)
        if (end < 0) return { error: 'unterminated comment' }
        i = end + 2
      } else if (c === ',') {
        // trailing comma: next significant char (skipping whitespace and comments) is ] or }
        let j = i + 1
        for (;;) {
          while (j < s.length && /\s/.test(s[j])) j++
          if (s[j] === '/' && s[j + 1] === '/') { while (j < s.length && s[j] !== '\n') j++ }
          else if (s[j] === '/' && s[j + 1] === '*') { const e = s.indexOf('*/', j + 2); j = e < 0 ? s.length : e + 2 }
          else break
        }
        if (s[j] !== ']' && s[j] !== '}') out += c
        i++
      } else {
        out += c
        i++
      }
    }
    return { value: JSON.parse(out) }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'invalid JSON' }
  }
}
