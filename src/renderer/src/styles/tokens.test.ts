/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(__dirname, 'tokens.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** Returns the body of the first rule whose selector (whitespace-normalised) equals `selector`. */
function blockBody(source: string, selector: string): string {
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()
  let i = 0
  while (i < source.length) {
    const open = source.indexOf('{', i)
    if (open < 0) break
    const head = norm(source.slice(i, open))
    let depth = 1
    let j = open + 1
    while (j < source.length && depth > 0) {
      if (source[j] === '{') depth++
      else if (source[j] === '}') depth--
      j++
    }
    const body = source.slice(open + 1, j - 1)
    if (head === selector) return body
    i = j
  }
  throw new Error(`block not found: ${selector}`)
}

function props(body: string): string[] {
  const out = new Set<string>()
  for (const m of body.matchAll(/(^|[;\s])(--[a-z0-9-]+)\s*:/g)) out.add(m[2])
  return [...out].sort()
}

const dark = props(blockBody(css, ":root, :root[data-theme='dark']"))
const light = props(blockBody(css, ":root[data-theme='light']"))
const media = blockBody(css, '@media (prefers-color-scheme: light)')
const system = props(blockBody(media, ":root[data-theme='system']"))

describe('tokens.css', () => {
  it('defines a non-trivial theme token set', () => {
    expect(dark.length).toBeGreaterThan(40)
    expect(dark).toContain('--surface-0')
    expect(dark).toContain('--accent')
  })

  it('dark and light define the same custom properties', () => {
    expect(light.filter((p) => !dark.includes(p))).toEqual([])
    expect(dark.filter((p) => !light.includes(p))).toEqual([])
  })

  it('system (prefers light) matches the light set', () => {
    expect(system).toEqual(light)
  })

  it('sets color-scheme per theme', () => {
    expect(blockBody(css, ":root, :root[data-theme='dark']")).toMatch(/color-scheme:\s*dark/)
    expect(blockBody(css, ":root[data-theme='light']")).toMatch(/color-scheme:\s*light/)
    expect(blockBody(media, ":root[data-theme='system']")).toMatch(/color-scheme:\s*light/)
  })
})
