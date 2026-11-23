// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROLE_COLORS } from '@shared/defaults'

/**
 * Role avatars (chart node and panel header) keep a share of the role colour and shade the rest, with white initials
 * (`--text-on-accent` is #ffffff in both themes). This measures the share written in the CSS, in OKLab like color-mix,
 * against WCAG 4.5:1 on every palette colour and on pure white (the worst custom colour).
 */
const lin = (c: number): number => {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}
function toLab(hex: string): [number, number, number] {
  const [R, G, B] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16)))
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B)
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B)
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}
function luminanceOfLab([L, a, b]: [number, number, number]): number {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const clamp = (x: number): number => Math.max(0, Math.min(1, x))
  const R = clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)
  const G = clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)
  const B = clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  return 0.2126 * R + 0.7152 * G + 0.0722 * B
}
/** Contrast of white text on the colour mixed `share` (0..1) with black in OKLab. */
function whiteOn(hex: string, share: number): number {
  const [L, a, b] = toLab(hex)
  return 1.05 / (luminanceOfLab([L * share, a * share, b * share]) + 0.05)
}

const css = (name: string): string => readFileSync(resolve(__dirname, '../styles', name), 'utf8')

describe('role avatar contrast', () => {
  it('both stylesheets use the same share', () => {
    const shares = [css('editor.css'), css('roleEditor.css')].map((c) => /color-mix\(in oklab, var\(--role\) (\d+)%, var\(--role-shade/.exec(c)?.[1])
    expect(shares[0]).toBeDefined()
    expect(shares[1]).toBe(shares[0])
  })
  it('keeps white initials at 4.5:1 or more on every role colour and on white', () => {
    const share = Number(/color-mix\(in oklab, var\(--role\) (\d+)%, var\(--role-shade/.exec(css('editor.css'))?.[1]) / 100
    for (const hex of [...ROLE_COLORS, '#ffffff', '#ffff00']) expect(whiteOn(hex, share), hex).toBeGreaterThanOrEqual(4.5)
  })
})
