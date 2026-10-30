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

/** Declared value of a custom property in a block body, following one level of var(--other). */
function value(body: string, name: string): string {
  const m = body.match(new RegExp(`(?:^|[;\\s])${name}\\s*:\\s*([^;]+);`))
  if (!m) throw new Error(`${name} not defined`)
  const ref = m[1].trim().match(/^var\((--[a-z0-9-]+)\)$/)
  return ref ? value(body, ref[1]) : m[1].trim()
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const darkBody = blockBody(css, ":root, :root[data-theme='dark']")
const lightBody = blockBody(css, ":root[data-theme='light']")
const systemBody = blockBody(media, ":root[data-theme='system']")

const NEW_THEME_TOKENS = ['--brand-ui-from', '--brand-ui-to', '--surface-0', '--surface-1', '--surface-2', '--surface-3', '--border-subtle', '--border-default', '--border-strong', '--border-input', '--text-tertiary', '--code-bg']

describe('brand tokens (ui-review-2.md C)', () => {
  it('every theme block defines the new tokens', () => {
    for (const set of [dark, light, system]) for (const t of NEW_THEME_TOKENS) expect(set).toContain(t)
  })

  it('keeps the THEME_BACKGROUND surface values', () => {
    expect(value(darkBody, '--surface-0')).toBe('#0b0d12')
    expect(value(lightBody, '--surface-0')).toBe('#f4f5f9')
    expect(value(systemBody, '--surface-0')).toBe('#f4f5f9')
  })

  it('defines the invariant brand tokens', () => {
    expect(css).toMatch(/--gradient-mark:\s*linear-gradient\(135deg,\s*#7c5cff,\s*#2bb0ff\)/)
    expect(css).toMatch(/--gradient-ui:\s*linear-gradient\(90deg,\s*var\(--brand-ui-from\),\s*var\(--brand-ui-to\)\)/)
    expect(css).toMatch(/--text-caption:\s*12px/)
    expect(css).toMatch(/--topbar-h:\s*48px/)
    expect(css).not.toMatch(/--weight-display/)
  })

  it('light and system share the themed gradient stops', () => {
    for (const body of [lightBody, systemBody]) {
      expect(value(body, '--brand-ui-from')).toBe('#6a4cf0')
      expect(value(body, '--brand-ui-to')).toBe('#1a86d9')
    }
  })

  for (const [name, body] of [['dark', darkBody], ['light', lightBody]] as const) {
    describe(`contrast, ${name}`, () => {
      const v = (t: string): string => value(body, t)
      const surfaces = ['--surface-0', '--surface-1', '--surface-2', '--surface-3']

      it('primary and secondary text pass 4.5 on every surface', () => {
        for (const s of surfaces) {
          expect(contrast(v('--text-primary'), v(s))).toBeGreaterThanOrEqual(4.5)
          expect(contrast(v('--text-secondary'), v(s))).toBeGreaterThanOrEqual(4.5)
        }
      })

      it('tertiary text passes 4.5 on surface-0 to surface-3 (dark) or on surface-0 and surface-2 (light)', () => {
        const list = name === 'dark' ? surfaces : ['--surface-0', '--surface-2']
        for (const s of list) expect(contrast(v('--text-tertiary'), v(s))).toBeGreaterThanOrEqual(4.5)
      })

      it('the focus ring (accent text) passes 3 on every surface', () => {
        for (const s of surfaces) expect(contrast(v('--accent-text'), v(s))).toBeGreaterThanOrEqual(3)
      })

      it('white on the accent set passes 4.5', () => {
        for (const t of ['--accent', '--accent-active']) expect(contrast('#ffffff', v(t))).toBeGreaterThanOrEqual(4.5)
      })

      it('gradient stops pass 3 against the page surface', () => {
        for (const t of ['--brand-ui-from', '--brand-ui-to']) expect(contrast(v(t), v('--surface-0'))).toBeGreaterThanOrEqual(3)
      })

      it('input borders pass 3 on the field and on surface-2', () => {
        expect(contrast(v('--border-input'), v('--field-bg'))).toBeGreaterThanOrEqual(3)
        expect(contrast(v('--border-input'), v('--surface-2'))).toBeGreaterThanOrEqual(3)
      })

      it('status text passes 4.5 on surface-2', () => {
        for (const t of ['--success-text', '--warning-text', '--danger-text', '--info-text']) {
          expect(contrast(v(t), v('--surface-2'))).toBeGreaterThanOrEqual(4.5)
        }
      })
    })
  }
})

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
