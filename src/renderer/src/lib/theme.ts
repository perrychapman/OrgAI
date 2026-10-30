import type { AppearanceSettings, AppSettingsInfo, ThemeMode } from '@shared/types'
import { DEFAULT_APPEARANCE } from '@shared/defaults'

/**
 * Applies AppearanceSettings to <html>. What it sets (consumed by CSS and by canvas views through useCssVar):
 *   data-theme            'dark' | 'light' (system is resolved here with matchMedia)
 *   --accent (+ hover/active/text/on-accent) inline, only when the accent differs from the default (the designed token values stay otherwise)
 *   data-reduce-motion    'on' when AppearanceSettings.reduceMotion is 'on' (absent otherwise); global.css honours it like prefers-reduced-motion
 *   data-canvas-pattern   'dots' | 'grid' | 'none'
 *   data-canvas-tint      'on' | 'off'    (off sets --canvas-wash-opacity to 0 in tokens.css)
 *   data-canvas-edges     'curved' | 'orthogonal' | 'straight'
 *   data-canvas-minimap   'on' | 'off'
 *   --canvas-pattern-kind / --canvas-edge-style / --canvas-minimap  the same values as CSS custom properties for useCssVar
 * With pattern 'none', tokens.css also makes --canvas-pattern transparent so existing grids vanish without code changes.
 */

export function isHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value.trim())
}

/** '#RGB' or '#RRGGBB' with or without the hash to lowercase '#rrggbb', or null when it is not a color. */
export function normalizeHex(value: string): string | null {
  let v = value.trim().replace(/^#/, '').toLowerCase()
  if (/^[0-9a-f]{3}$/.test(v)) v = v.replace(/./g, (c) => c + c)
  return /^[0-9a-f]{6}$/.test(v) ? `#${v}` : null
}

export function resolveTheme(mode: ThemeMode, prefersDark: boolean): 'dark' | 'light' {
  return mode === 'system' ? (prefersDark ? 'dark' : 'light') : mode
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const lin = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
}

/** Text color that reads on the accent: white unless the accent is light. */
export function onAccent(hex: string): string {
  return luminance(hex) > 0.4 ? '#0b0d12' : '#ffffff'
}

const ACCENT_VARS = ['--accent', '--accent-hover', '--accent-active', '--accent-text', '--text-on-accent'] as const

/** Inline accent overrides derived from one color, per resolved theme. Empty for the default accent. */
export function accentVars(accent: string, theme: 'dark' | 'light'): Record<string, string> {
  const hex = normalizeHex(accent)
  if (!hex || hex === DEFAULT_APPEARANCE.accent) return {}
  return {
    '--accent': hex,
    '--accent-hover': 'color-mix(in oklab, var(--accent) 88%, black)',
    '--accent-active': 'color-mix(in oklab, var(--accent) 76%, black)',
    '--accent-text': theme === 'dark' ? 'color-mix(in oklab, var(--accent) 60%, white)' : 'color-mix(in oklab, var(--accent) 78%, black)',
    '--text-on-accent': onAccent(hex)
  }
}

export function applyAppearance(a: AppearanceSettings, prefersDark: boolean, root: HTMLElement = document.documentElement): void {
  const theme = resolveTheme(a.theme, prefersDark)
  root.dataset.theme = theme
  for (const name of ACCENT_VARS) root.style.removeProperty(name)
  for (const [k, v] of Object.entries(accentVars(a.accent, theme))) root.style.setProperty(k, v)
  if (a.reduceMotion === 'on') root.dataset.reduceMotion = 'on'
  else delete root.dataset.reduceMotion
  const c = a.canvas
  root.dataset.canvasPattern = c.pattern
  root.dataset.canvasTint = c.tint ? 'on' : 'off'
  root.dataset.canvasEdges = c.edges
  root.dataset.canvasMinimap = c.minimap ? 'on' : 'off'
  root.style.setProperty('--canvas-pattern-kind', c.pattern)
  root.style.setProperty('--canvas-edge-style', c.edges)
  root.style.setProperty('--canvas-minimap', c.minimap ? '1' : '0')
}

let current: AppearanceSettings = DEFAULT_APPEARANCE
let query: MediaQueryList | null = null

function reapply(): void {
  applyAppearance(current, query?.matches ?? true)
}

/** Apply new appearance settings now (the settings view calls this for instant preview). */
export function setAppearance(a: AppearanceSettings): void {
  current = a
  reapply()
}

/**
 * Startup hook for main.tsx: applies the saved appearance, follows the OS when the theme is 'system' and
 * re-applies on every settings:changed push. Returns a cleanup function.
 */
export function initTheme(): () => void {
  query = window.matchMedia('(prefers-color-scheme: dark)')
  query.addEventListener('change', reapply)
  reapply()
  const off = window.orgai.onSettingsChanged((s: AppSettingsInfo) => setAppearance(s.appearance ?? DEFAULT_APPEARANCE))
  void window.orgai.settings
    .get()
    .then((s) => setAppearance(s.appearance ?? DEFAULT_APPEARANCE))
    .catch(() => undefined)
  return () => {
    query?.removeEventListener('change', reapply)
    off()
  }
}
