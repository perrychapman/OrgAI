/**
 * Small tolerant TOML reader for agent definition files (untrusted input, never evaluated).
 * Supports strings (basic, literal, multi-line), numbers, booleans, arrays, inline tables, `[table]` and
 * `[a.b]` headers, `[[array.of.tables]]` and comments. Never throws.
 */

const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const MAX_DEPTH = 16

class TomlError extends Error {}

class Reader {
  pos = 0
  constructor(readonly s: string) {}

  eof(): boolean {
    return this.pos >= this.s.length
  }
  peek(n = 1): string {
    return this.s.slice(this.pos, this.pos + n)
  }
  /** Spaces and tabs only. */
  skipInline(): void {
    while (this.pos < this.s.length && (this.s[this.pos] === ' ' || this.s[this.pos] === '\t')) this.pos++
  }
  skipComment(): void {
    if (this.s[this.pos] === '#') while (this.pos < this.s.length && this.s[this.pos] !== '\n') this.pos++
  }
  /** Whitespace, newlines and comments. */
  skipAll(): void {
    for (;;) {
      this.skipInline()
      this.skipComment()
      if (this.s[this.pos] === '\n') this.pos++
      else return
    }
  }
  skipLine(): void {
    while (this.pos < this.s.length && this.s[this.pos] !== '\n') this.pos++
  }
}

function basicEscapes(raw: string, multiline: boolean): string {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (c !== '\\') { out += c; continue }
    const n = raw[++i]
    switch (n) {
      case 'n': out += '\n'; break
      case 't': out += '\t'; break
      case 'r': out += '\r'; break
      case 'b': out += '\b'; break
      case 'f': out += '\f'; break
      case '"': out += '"'; break
      case '\\': out += '\\'; break
      case 'u':
      case 'U': {
        const len = n === 'u' ? 4 : 8
        const h = raw.slice(i + 1, i + 1 + len)
        if (!/^[0-9a-fA-F]+$/.test(h) || h.length !== len) throw new TomlError('bad unicode escape')
        const cp = parseInt(h, 16)
        if (cp > 0x10ffff) throw new TomlError('bad unicode escape')
        out += String.fromCodePoint(cp)
        i += len
        break
      }
      default:
        if (multiline && n !== undefined && /[ \t\n]/.test(n)) {
          // line-ending backslash: trim whitespace up to the next non-whitespace char
          let j = i
          while (j < raw.length && /[ \t\n]/.test(raw[j])) j++
          i = j - 1
        } else throw new TomlError(`bad escape \\${n ?? ''}`)
    }
  }
  return out
}

function readString(r: Reader): string {
  const q = r.s[r.pos]
  const triple = r.peek(3) === q.repeat(3)
  if (triple) {
    r.pos += 3
    if (r.s[r.pos] === '\r' && r.s[r.pos + 1] === '\n') r.pos += 2
    else if (r.s[r.pos] === '\n') r.pos++
    let i = r.pos
    for (;;) {
      if (i >= r.s.length) throw new TomlError('unterminated multi-line string')
      if (q === '"' && r.s[i] === '\\') { i += 2; continue }
      if (r.s.startsWith(q.repeat(3), i)) {
        // up to two extra quotes may belong to the content
        let extra = 0
        while (extra < 2 && r.s[i + 3 + extra] === q) extra++
        const raw = r.s.slice(r.pos, i + extra)
        r.pos = i + 3 + extra
        return q === '"' ? basicEscapes(raw, true) : raw
      }
      i++
    }
  }
  r.pos++
  let i = r.pos
  for (;;) {
    if (i >= r.s.length || r.s[i] === '\n') throw new TomlError('unterminated string')
    if (q === '"' && r.s[i] === '\\') { i += 2; continue }
    if (r.s[i] === q) break
    i++
  }
  const raw = r.s.slice(r.pos, i)
  r.pos = i + 1
  return q === '"' ? basicEscapes(raw, false) : raw
}

function readKeyPath(r: Reader, stop: RegExp): string[] {
  const parts: string[] = []
  for (;;) {
    r.skipInline()
    const c = r.s[r.pos]
    let part: string
    if (c === '"' || c === "'") part = readString(r)
    else {
      const m = /^[A-Za-z0-9_-]+/.exec(r.s.slice(r.pos, r.pos + 200))
      if (!m) throw new TomlError('bad key')
      part = m[0]
      r.pos += part.length
    }
    if (BAD_KEYS.has(part)) throw new TomlError(`key "${part}" is not allowed`)
    parts.push(part)
    r.skipInline()
    if (r.s[r.pos] === '.') { r.pos++; continue }
    if (stop.test(r.s[r.pos] ?? '')) return parts
    throw new TomlError('bad key')
  }
}

function readValue(r: Reader, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new TomlError('too deeply nested')
  r.skipInline()
  const c = r.s[r.pos]
  if (c === '"' || c === "'") return readString(r)
  if (c === '[') {
    r.pos++
    const arr: unknown[] = []
    for (;;) {
      r.skipAll()
      if (r.s[r.pos] === ']') { r.pos++; return arr }
      if (r.eof()) throw new TomlError('unterminated array')
      arr.push(readValue(r, depth + 1))
      r.skipAll()
      if (r.s[r.pos] === ',') { r.pos++; continue }
      if (r.s[r.pos] === ']') { r.pos++; return arr }
      throw new TomlError('bad array')
    }
  }
  if (c === '{') {
    r.pos++
    const obj: Record<string, unknown> = {}
    for (;;) {
      r.skipInline()
      if (r.s[r.pos] === '}') { r.pos++; return obj }
      const path = readKeyPath(r, /=/)
      r.pos++ // =
      setPath(obj, path, readValue(r, depth + 1))
      r.skipInline()
      if (r.s[r.pos] === ',') { r.pos++; continue }
      if (r.s[r.pos] === '}') { r.pos++; return obj }
      throw new TomlError('bad inline table')
    }
  }
  const m = /^[^\s,\]}#]+/.exec(r.s.slice(r.pos, r.pos + 200))
  if (!m) throw new TomlError('missing value')
  const tok = m[0]
  r.pos += tok.length
  if (tok === 'true') return true
  if (tok === 'false') return false
  const num = tok.replace(/_/g, '')
  if (/^[-+]?\d+$/.test(num)) return Number(num)
  if (/^[-+]?(\d+\.\d+|\d+)([eE][-+]?\d+)?$/.test(num)) return Number(num)
  if (/^[-+]?(inf|nan)$/.test(num)) return num.includes('nan') ? NaN : num.startsWith('-') ? -Infinity : Infinity
  if (/^\d{4}-\d\d-\d\d/.test(tok)) return tok // dates stay strings
  throw new TomlError(`unsupported value "${tok.slice(0, 20)}"`)
}

function setPath(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let cur = obj
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i]
    let next = cur[k]
    if (next === undefined) {
      next = {}
      cur[k] = next
    } else if (Array.isArray(next) && next.length && typeof next[next.length - 1] === 'object') {
      next = next[next.length - 1]
    }
    if (typeof next !== 'object' || next === null || Array.isArray(next)) throw new TomlError(`key "${k}" is already a value`)
    cur = next as Record<string, unknown>
  }
  const last = path[path.length - 1]
  if (Object.prototype.hasOwnProperty.call(cur, last)) throw new TomlError(`duplicate key "${last}"`)
  cur[last] = value
}

export function parseToml(text: string): { data: Record<string, unknown>; error?: string } {
  const data: Record<string, unknown> = {}
  let error: string | undefined
  try {
    const r = new Reader(text.replace(/^﻿/, '').replace(/\r\n?/g, '\n'))
    let table: Record<string, unknown> = data
    while (!r.eof()) {
      r.skipAll()
      if (r.eof()) break
      const lineStart = r.pos
      try {
        if (r.s[r.pos] === '[') {
          const isArr = r.s[r.pos + 1] === '['
          r.pos += isArr ? 2 : 1
          const path = readKeyPath(r, /\]/)
          r.pos += isArr ? 2 : 1
          if (isArr && r.s[r.pos - 1] !== ']') throw new TomlError('bad table header')
          let cur = data
          for (let i = 0; i < path.length; i++) {
            const k = path[i]
            const lastPart = i === path.length - 1
            let next = cur[k]
            if (lastPart && isArr) {
              if (next === undefined) { next = []; cur[k] = next }
              if (!Array.isArray(next)) throw new TomlError(`"${k}" is not an array of tables`)
              const item: Record<string, unknown> = {}
              next.push(item)
              cur = item
              continue
            }
            if (next === undefined) { next = {}; cur[k] = next }
            else if (Array.isArray(next) && next.length) next = next[next.length - 1]
            if (typeof next !== 'object' || next === null || Array.isArray(next)) throw new TomlError(`"${k}" is not a table`)
            cur = next as Record<string, unknown>
          }
          table = cur
        } else {
          const path = readKeyPath(r, /=/)
          r.pos++ // =
          const value = readValue(r, 0)
          setPath(table, path, value)
        }
        r.skipInline()
        r.skipComment()
        if (!r.eof() && r.s[r.pos] !== '\n') throw new TomlError('unexpected text after value')
      } catch (err) {
        const line = r.s.slice(0, lineStart).split('\n').length
        if (!error) error = `line ${line}: ${err instanceof Error ? err.message : 'invalid TOML'}`
        r.pos = lineStart
        r.skipLine()
      }
    }
  } catch (err) {
    error = error ?? (err instanceof Error ? err.message : 'invalid TOML')
  }
  return error ? { data, error } : { data }
}
