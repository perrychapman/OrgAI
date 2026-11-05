import { kindColor } from '../../lib/knowledge'

/** A colour as numbers, so the canvas can mix and fade it without parsing strings per frame. */
export interface Rgb {
  r: number
  g: number
  b: number
}

export const rgbCss = (c: Rgb, a = 1): string => (a >= 1 ? `rgb(${c.r} ${c.g} ${c.b})` : `rgb(${c.r} ${c.g} ${c.b} / ${a})`)
export const rgbHex = (c: Rgb): string => `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`

export const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => ({
  r: Math.round(a.r + (b.r - a.r) * t),
  g: Math.round(a.g + (b.g - a.g) * t),
  b: Math.round(a.b + (b.b - a.b) * t)
})

/** WCAG relative luminance and contrast ratio. */
export function luminance(c: Rgb): number {
  const f = (v: number): number => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
}
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** The theme as the canvas uses it, read from the tokens (docs/design/knowledge-graph-2.md section 1.4 and 5). */
export interface NeuralTheme {
  field: Rgb
  glow: Rgb
  synapse: Rgb
  synapseOpacity: number
  active: Rgb
  inferred: Rgb
  pulse: Rgb
  haloOpacity: number
  /** 'lighter' on dark, 'source-over' on light. */
  composite: GlobalCompositeOperation
  dim: number
  textPrimary: Rgb
  textSecondary: Rgb
  font: string
  /** Additive blending means the dark look: glowing somas. */
  dark: boolean
  /** Resolved node colour of a kind (the slot mixed with the node ink), cached per theme read. */
  node(kind: string): Rgb
}

let scratch: CanvasRenderingContext2D | null = null

/** Any CSS colour (color-mix included) to numbers through a 1x1 canvas, so no string format has to be parsed. */
export function parseCssColor(css: string): Rgb {
  if (!scratch) {
    const c = document.createElement('canvas')
    c.width = 1
    c.height = 1
    scratch = c.getContext('2d', { willReadFrequently: true })
  }
  const ctx = scratch
  if (!ctx) return { r: 128, g: 128, b: 128 }
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillStyle = '#808080'
  ctx.fillStyle = css
  ctx.fillRect(0, 0, 1, 1)
  const d = ctx.getImageData(0, 0, 1, 1).data
  return { r: d[0], g: d[1], b: d[2] }
}

/**
 * Reads the tokens from `root` through a probe element's computed colour: color-mix and var() resolve in the element's
 * own cascade, so a theme, accent or system-theme change reads the same way. Called at mount and on each `data-theme` change.
 */
export function readNeuralTheme(root: HTMLElement): NeuralTheme {
  const colour = (css: string): Rgb => {
    const probe = document.createElement('span')
    probe.setAttribute('aria-hidden', 'true')
    probe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none'
    root.appendChild(probe)
    probe.style.color = css
    const out = parseCssColor(getComputedStyle(probe).color)
    probe.remove()
    return out
  }
  const token = (name: string, fallback: string): string => getComputedStyle(root).getPropertyValue(name).trim() || fallback
  const num = (name: string, fallback: number): number => {
    const v = Number.parseFloat(token(name, String(fallback)))
    return Number.isFinite(v) ? v : fallback
  }
  const composite = token('--neural-composite', 'source-over') === 'lighter' ? 'lighter' : 'source-over'
  const cache = new Map<string, Rgb>()
  const theme: NeuralTheme = {
    field: colour('var(--neural-field)'),
    glow: colour('var(--neural-field-glow)'),
    synapse: colour('var(--neural-synapse)'),
    synapseOpacity: num('--neural-synapse-opacity', 0.35),
    active: colour('var(--neural-synapse-active)'),
    inferred: colour('var(--neural-synapse-inferred)'),
    pulse: colour('var(--neural-pulse)'),
    haloOpacity: num('--neural-halo-opacity', 0.3),
    composite,
    dim: num('--neural-dim-opacity', 0.25),
    textPrimary: colour('var(--text-primary)'),
    textSecondary: colour('var(--text-secondary)'),
    font: getComputedStyle(root).fontFamily || 'system-ui, sans-serif',
    dark: composite === 'lighter',
    node(kind: string): Rgb {
      const hit = cache.get(kind)
      if (hit) return hit
      const c = colour(`color-mix(in srgb, ${kindColor(kind)} var(--neural-node-mix), var(--neural-node-ink))`)
      cache.set(kind, c)
      return c
    }
  }
  return theme
}
