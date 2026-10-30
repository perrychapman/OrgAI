/**
 * Minimal, tolerant YAML subset for agent definition files (untrusted input, never evaluated).
 * Supports scalars, quoted strings, flow lists/maps, block lists, nested maps, lists of maps, `|` and `>` block
 * scalars and comments. Anything else becomes an error string; nothing here throws.
 */

export type FmValue = string | number | boolean | null | FmValue[] | { [key: string]: FmValue }

export interface FrontmatterResult {
  data: Record<string, FmValue>
  body: string
  error?: string
}

const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const MAX_DEPTH = 24
/** Longest line kept, in characters; longer lines are cut (with an error string) so no line costs much to scan. */
export const MAX_LINE_CHARS = 4000
/** Scalars longer than this are never read as numbers (no real number is this long). */
const MAX_NUMBER_CHARS = 64
/** Linear: no ambiguous split between digit runs, so a long digit run that ends in a non-digit cannot backtrack. */
const NUMBER = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/

interface Line {
  indent: number
  text: string
  raw: string
}

function normalize(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
}

/** Index of the `#` that starts a comment (preceded by whitespace or at the start, outside quotes), or -1. */
function commentIndex(s: string): number {
  let quote: string | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (quote === '"' && c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if ((c === '"' || c === "'") && (i === 0 || /[\s[{,:]/.test(s[i - 1]))) quote = c
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return i
  }
  return -1
}

/** Index of the `:` that ends a key (followed by space or end, outside quotes), or -1. */
function colonIndex(s: string): number {
  let quote: string | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (quote === '"' && c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if ((c === '"' || c === "'") && i === 0) quote = c
    else if (c === ':' && (i === s.length - 1 || s[i + 1] === ' ')) return i
  }
  return -1
}

function unquoteDouble(inner: string): string {
  let out = ''
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (c !== '\\') {
      out += c
      continue
    }
    const n = inner[++i]
    switch (n) {
      case 'n': out += '\n'; break
      case 't': out += '\t'; break
      case 'r': out += '\r'; break
      case '0': out += '\0'; break
      case '"': out += '"'; break
      case '\\': out += '\\'; break
      case '/': out += '/'; break
      case ' ': out += ' '; break
      case 'x': {
        const h = inner.slice(i + 1, i + 3)
        if (/^[0-9a-fA-F]{2}$/.test(h)) { out += String.fromCharCode(parseInt(h, 16)); i += 2 } else out += 'x'
        break
      }
      case 'u': {
        const h = inner.slice(i + 1, i + 5)
        if (/^[0-9a-fA-F]{4}$/.test(h)) { out += String.fromCharCode(parseInt(h, 16)); i += 4 } else out += 'u'
        break
      }
      default: out += n ?? ''
    }
  }
  return out
}

/** Splits a flow collection body on top-level commas. */
function splitFlow(inner: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let cur = ''
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (quote) {
      cur += c
      if (quote === '"' && c === '\\') cur += inner[++i] ?? ''
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue }
    if (c === '[' || c === '{') depth++
    if (c === ']' || c === '}') depth--
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue }
    cur += c
  }
  if (cur.trim()) parts.push(cur)
  return parts.map((p) => p.trim()).filter((p) => p !== '')
}

function parseScalar(s: string, depth = 0): FmValue {
  const t = s.trim()
  if (t === '') return null
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) return unquoteDouble(t.slice(1, -1))
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1).replace(/''/g, "'")
  if (depth < MAX_DEPTH && t.startsWith('[') && t.endsWith(']')) return splitFlow(t.slice(1, -1)).map((p) => parseScalar(p, depth + 1))
  if (depth < MAX_DEPTH && t.startsWith('{') && t.endsWith('}')) {
    const out: Record<string, FmValue> = {}
    for (const part of splitFlow(t.slice(1, -1))) {
      const ci = colonIndex(part)
      if (ci < 0) continue
      const key = String(parseScalar(part.slice(0, ci), depth + 1) ?? '')
      if (!BAD_KEYS.has(key)) out[key] = parseScalar(part.slice(ci + 1), depth + 1)
    }
    return out
  }
  if (t === '~' || /^null$/i.test(t)) return null
  if (/^(true|yes)$/i.test(t) && t.toLowerCase() === 'true') return true
  if (/^false$/i.test(t)) return false
  if (t.length <= MAX_NUMBER_CHARS && NUMBER.test(t)) {
    const n = Number(t)
    if (Number.isFinite(n)) return n
  }
  return t
}

class Parser {
  lines: Line[] = []
  rawLines: string[]
  error?: string
  constructor(src: string[]) {
    this.rawLines = src
    for (let n = 0; n < src.length; n++) {
      let raw = src[n]
      if (raw.length > MAX_LINE_CHARS) {
        this.fail(`line ${n + 1} is longer than ${MAX_LINE_CHARS} characters; it was cut`)
        raw = raw.slice(0, MAX_LINE_CHARS)
      }
      if (/^\s*$/.test(raw)) { this.lines.push({ indent: -1, text: '', raw }); continue }
      const indent = raw.length - raw.trimStart().length
      let text = raw.trim()
      if (text.startsWith('#')) { this.lines.push({ indent: -1, text: '', raw }); continue }
      if (/^\t/.test(raw) && !this.error) this.error = 'tab indentation is not supported'
      const ci = commentIndex(text)
      if (ci >= 0) text = text.slice(0, ci).trimEnd()
      this.lines.push({ indent, text, raw })
    }
  }

  private fail(msg: string): void {
    if (!this.error) this.error = msg
  }

  /** Next index at or after i that holds content. */
  skip(i: number): number {
    while (i < this.lines.length && this.lines[i].indent < 0) i++
    return i
  }

  parseBlock(start: number, indent: number, depth: number): { value: FmValue; next: number } {
    const i = this.skip(start)
    if (i >= this.lines.length || depth > MAX_DEPTH) return { value: null, next: i }
    const t = this.lines[i].text
    if (t === '-' || t.startsWith('- ')) return this.parseList(i, indent, depth)
    return this.parseMap(i, indent, depth)
  }

  /** Block scalar lines (`|` / `>`) that are indented deeper than `parentIndent`, starting after line `at`. */
  private blockScalar(at: number, parentIndent: number, style: string): { value: string; next: number } {
    const chomp = style.includes('-') ? 'strip' : style.includes('+') ? 'keep' : 'clip'
    const folded = style.startsWith('>')
    let j = at + 1
    const collected: string[] = []
    let blockIndent = -1
    while (j < this.lines.length) {
      const l = this.lines[j]
      if (/^\s*$/.test(l.raw)) { collected.push(''); j++; continue }
      const ind = l.raw.length - l.raw.trimStart().length
      if (ind <= parentIndent) break
      if (blockIndent < 0) blockIndent = ind
      collected.push(l.raw.slice(Math.min(blockIndent, ind)))
      j++
    }
    // Trailing blank lines belong to the next content, not the scalar (kept only for `+`).
    let trailing = 0
    while (collected.length && collected[collected.length - 1] === '') { collected.pop(); trailing++ }
    let text: string
    if (folded) {
      text = ''
      for (let k = 0; k < collected.length; k++) {
        const cur = collected[k]
        if (k === 0) { text = cur; continue }
        const prev = collected[k - 1]
        if (cur === '') text += '\n'
        else if (prev === '') text += cur
        else if (cur.startsWith(' ') || prev.startsWith(' ')) text += '\n' + cur
        else text += ' ' + cur
      }
    } else text = collected.join('\n')
    if (collected.length) {
      if (chomp === 'clip') text += '\n'
      else if (chomp === 'keep') text += '\n'.repeat(1 + trailing)
    }
    return { value: text, next: j }
  }

  parseMap(start: number, indent: number, depth: number): { value: FmValue; next: number } {
    const out: Record<string, FmValue> = {}
    let i = start
    while (true) {
      i = this.skip(i)
      if (i >= this.lines.length) break
      const l = this.lines[i]
      if (l.indent < indent) break
      if (l.indent > indent) { this.fail(`unexpected indentation at line ${i + 1}`); i++; continue }
      if (l.text === '-' || l.text.startsWith('- ')) break
      const ci = colonIndex(l.text)
      if (ci < 0) { this.fail(`line ${i + 1} is not "key: value"`); i++; continue }
      const keyRaw = parseScalar(l.text.slice(0, ci))
      const key = String(keyRaw ?? '')
      const rest = l.text.slice(ci + 1).trim()
      let value: FmValue
      if (/^[|>][+-]?\d?[+-]?$/.test(rest)) {
        const r = this.blockScalar(i, indent, rest)
        value = r.value
        i = r.next
      } else if (rest === '') {
        const n = this.skip(i + 1)
        const nl = this.lines[n]
        if (n < this.lines.length && (nl.indent > indent || (nl.indent === indent && (nl.text === '-' || nl.text.startsWith('- '))))) {
          const r = this.parseBlock(n, nl.indent, depth + 1)
          value = r.value
          i = r.next
        } else {
          value = null
          i++
        }
      } else {
        if (/^[&*!]/.test(rest)) this.fail(`YAML anchors, aliases and tags are not supported (line ${i + 1})`)
        value = parseScalar(rest)
        i++
        // plain multi-line scalar continuation
        if (typeof value === 'string' && !/^["'[{]/.test(rest)) {
          while (i < this.lines.length) {
            const n = this.lines[i]
            if (n.indent <= indent && n.indent >= 0) break
            if (n.indent < 0) {
              const after = this.skip(i)
              if (after >= this.lines.length || this.lines[after].indent <= indent) break
              i++
              continue
            }
            value += ' ' + n.text
            i++
          }
        }
      }
      if (!BAD_KEYS.has(key)) out[key] = value
    }
    return { value: out, next: i }
  }

  parseList(start: number, indent: number, depth: number): { value: FmValue; next: number } {
    const out: FmValue[] = []
    let i = start
    while (true) {
      i = this.skip(i)
      if (i >= this.lines.length) break
      const l = this.lines[i]
      if (l.indent < indent) break
      if (l.indent > indent) { this.fail(`unexpected indentation at line ${i + 1}`); i++; continue }
      if (!(l.text === '-' || l.text.startsWith('- '))) break
      const rest = l.text.slice(1).trim()
      if (rest === '') {
        const n = this.skip(i + 1)
        if (n < this.lines.length && this.lines[n].indent > indent) {
          const r = this.parseBlock(n, this.lines[n].indent, depth + 1)
          out.push(r.value)
          i = r.next
        } else {
          out.push(null)
          i++
        }
        continue
      }
      const offset = l.text.length - l.text.slice(1).trimStart().length
      const nested = rest === '-' || rest.startsWith('- ')
      const looksMap = !/^["'[{]/.test(rest) ? colonIndex(rest) >= 0 : colonIndex(rest) > 0 && /^["']/.test(rest)
      if (nested || looksMap) {
        // Re-read this line as a block starting at the item's content column.
        this.lines[i] = { indent: indent + offset, text: rest, raw: l.raw }
        const r = this.parseBlock(i, indent + offset, depth + 1)
        out.push(r.value)
        i = r.next
      } else {
        out.push(parseScalar(rest))
        i++
      }
    }
    return { value: out, next: i }
  }
}

/** Parses a whole YAML document (the supported subset). Never throws. */
export function parseYamlDoc(text: string): { data: FmValue; error?: string } {
  try {
    const p = new Parser(normalize(text).split('\n'))
    const first = p.skip(0)
    if (first >= p.lines.length) return { data: {} }
    const r = p.parseBlock(first, p.lines[first].indent, 0)
    return p.error ? { data: r.value, error: p.error } : { data: r.value }
  } catch (err) {
    return { data: {}, error: err instanceof Error ? err.message : 'could not parse YAML' }
  }
}

/** Splits `---` frontmatter from the body and parses it. Never throws. */
export function parseFrontmatter(text: string): FrontmatterResult {
  try {
    const src = normalize(text)
    const lines = src.split('\n')
    if (lines[0].trimEnd() !== '---') return { data: {}, body: src.trim() }
    let end = -1
    for (let i = 1; i < lines.length; i++) {
      const t = lines[i].trimEnd()
      if (t === '---' || t === '...') { end = i; break }
    }
    if (end < 0) return { data: {}, body: src.trim(), error: 'frontmatter is not closed with ---' }
    const body = lines.slice(end + 1).join('\n').trim()
    const doc = parseYamlDoc(lines.slice(1, end).join('\n'))
    const data = doc.data && typeof doc.data === 'object' && !Array.isArray(doc.data) ? (doc.data as Record<string, FmValue>) : {}
    if (!doc.error && doc.data !== null && (typeof doc.data !== 'object' || Array.isArray(doc.data))) {
      return { data: {}, body, error: 'frontmatter is not a key: value map' }
    }
    return doc.error ? { data, body, error: doc.error } : { data, body }
  } catch (err) {
    return { data: {}, body: '', error: err instanceof Error ? err.message : 'could not parse frontmatter' }
  }
}
