// Pure parts of saving and copying a diagram or SVG as an image (docs/design/outputs-2.md section 8.7).
// The DOM work (drawing a canvas, the clipboard, the download) lives in components/outputs/diagram/DiagramExport.tsx.

import type { Size } from './diagramView'

export const EXPORT_KEY = 'orgai.diagramExport'
export const SVG_NS = 'http://www.w3.org/2000/svg'
export const XMLNS_NS = 'http://www.w3.org/2000/xmlns/'
/** A PNG side is at most this many px, and the whole image at most this many pixels. */
export const MAX_SIDE = 8192
export const MAX_PIXELS = 64_000_000

export type ExportTheme = 'light' | 'shown'
export type ExportBackground = 'white' | 'transparent'
export type ExportScale = 1 | 2 | 3
export interface ExportOptions {
  theme: ExportTheme
  background: ExportBackground
  scale: ExportScale
}

export const DEFAULT_EXPORT: ExportOptions = { theme: 'light', background: 'white', scale: 2 }

/** The saved options; anything missing or unknown falls back to the default for that field. */
export function parseExportOptions(raw: string | null): ExportOptions {
  if (!raw) return { ...DEFAULT_EXPORT }
  let o: unknown
  try {
    o = JSON.parse(raw)
  } catch {
    return { ...DEFAULT_EXPORT }
  }
  const r = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>
  return {
    theme: r.theme === 'shown' || r.theme === 'light' ? r.theme : DEFAULT_EXPORT.theme,
    background: r.background === 'transparent' || r.background === 'white' ? r.background : DEFAULT_EXPORT.background,
    scale: r.scale === 1 || r.scale === 2 || r.scale === 3 ? r.scale : DEFAULT_EXPORT.scale
  }
}

export interface ExportSize {
  width: number
  height: number
  /** The scale used: the requested one, or the largest allowed when the picture is too big. */
  scale: number
  reduced: boolean
}

/** The PNG size for a drawing of `natural` px at `scale`, dropping the scale until both caps hold. */
export function exportSize(natural: Size, scale: number): ExportSize {
  const w = Math.max(1, natural.w)
  const h = Math.max(1, natural.h)
  const fits = (s: number): boolean => w * s <= MAX_SIDE && h * s <= MAX_SIDE && w * s * h * s <= MAX_PIXELS
  if (fits(scale)) return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), scale, reduced: false }
  const s = Math.min(scale, MAX_SIDE / w, MAX_SIDE / h, Math.sqrt(MAX_PIXELS / (w * h)))
  // Floor everywhere so rounding never lands past a cap.
  const width = Math.max(1, Math.floor(w * s))
  const height = Math.max(1, Math.floor(h * s))
  return { width, height, scale: Math.floor(s * 100) / 100, reduced: true }
}

/** "2", "1.4" */
export function scaleLabel(scale: number): string {
  return String(Math.round(scale * 100) / 100)
}

export const SAVE_NOTICE = 'Your browser is saving the file.'
export const COPY_REFUSED = 'Your computer would not copy the image. Save it instead.'
export const COPY_FAILED = 'Your computer would not copy that. Save it instead.'
export const EXPORT_FAILED = 'OrgAI could not make the image.'
export const SOURCE_COPIED = 'Copied the source.'

/** The notice after saving a PNG (or copying one): a plain line, or the "saved smaller" line when the caps cut it. */
export function exportNotice(requested: number, size: ExportSize, copied: boolean): string {
  void requested
  if (size.reduced) {
    return copied
      ? `Copied at ${scaleLabel(size.scale)}x. The diagram is large, so it was copied smaller.`
      : `Saved at ${scaleLabel(size.scale)}x. The diagram is large, so it was saved smaller.`
  }
  return copied ? 'Copied the image.' : SAVE_NOTICE
}

/** The viewBox "minX minY w h" as numbers, or null. */
export function viewBoxOf(viewBox: string | null): { x: number; y: number; w: number; h: number } | null {
  const v = (viewBox ?? '').trim().split(/[\s,]+/).map(Number)
  if (v.length !== 4 || !v.every(Number.isFinite) || v[2] <= 0 || v[3] <= 0) return null
  return { x: v[0], y: v[1], w: v[2], h: v[3] }
}

/** The attributes a standalone SVG file needs on its root so other programs open it. */
export function standaloneAttrs(natural: Size): Record<string, string> {
  return {
    xmlns: SVG_NS,
    'xmlns:xlink': 'http://www.w3.org/1999/xlink',
    width: String(Math.max(1, Math.round(natural.w))),
    height: String(Math.max(1, Math.round(natural.h)))
  }
}

/** Mermaid writes `max-width: Npx` in the root's inline style; a file opened elsewhere must not be capped by it. */
export function stripMaxWidth(style: string | null): string | null {
  if (!style) return null
  const next = style
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p && !/^max-width\s*:/i.test(p))
    .join('; ')
  return next || null
}

/** Attributes of the white rectangle behind an export with a white background, from the viewBox. */
export function backgroundRect(viewBox: string | null, natural: Size): Record<string, string> {
  const vb = viewBoxOf(viewBox) ?? { x: 0, y: 0, w: natural.w, h: natural.h }
  return { x: String(vb.x), y: String(vb.y), width: String(vb.w), height: String(vb.h), fill: '#ffffff' }
}

/** An SVG text as a data URL for an <img> (no script runs in an image, nothing loads). */
export function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** A file name from a title: no path characters, control or hidden characters, at most 80 chars, never empty. */
export function downloadName(title: string, ext: string): string {
  let base = ''
  for (const ch of title) {
    const c = ch.codePointAt(0) ?? 0
    const hidden = c <= 0x1f || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x2064) || c === 0x2028 || c === 0x2029 || c === 0xfeff
    base += hidden || '<>:"/\\|?*'.includes(ch) ? ' ' : ch
  }
  base = base.replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '').slice(0, 80).trim()
  if (!base) base = 'diagram'
  return `${base}.${ext.replace(/^\./, '')}`
}

/** Bytes as base64 for outputs:saveImage (chunked, so a large picture never overflows the argument limit). */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(bin)
}

/** A text (an SVG file) as UTF-8 base64. */
export function textToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text))
}

/** What outputs:saveImage's answer says to the user: where it went, or that nothing was written. */
export function savedImageNotice(result: { path: string } | { cancelled: true }, extra = ''): string {
  if ('path' in result) return `Saved a copy to ${result.path}.${extra ? ` ${extra}` : ''}`
  return 'Nothing was saved.'
}

export type MermaidTheme = 'default' | 'dark'

/** The Mermaid theme for the viewer: the app's, unless the user asked for a light drawing. */
export function viewerTheme(app: 'light' | 'dark', light: boolean): MermaidTheme {
  return light || app === 'light' ? 'default' : 'dark'
}

/** The Mermaid theme an export is redrawn in: always `default` unless the user picked "As shown". */
export function exportTheme(option: ExportTheme, shown: MermaidTheme): MermaidTheme {
  return option === 'shown' ? shown : 'default'
}

/** The Mermaid configuration for every drawing: strict, labels as SVG text (the gate refuses foreignObject). */
export function mermaidConfig(theme: MermaidTheme): {
  startOnLoad: false
  securityLevel: 'strict'
  htmlLabels: false
  flowchart: { htmlLabels: false }
  theme: MermaidTheme
} {
  return { startOnLoad: false, securityLevel: 'strict', htmlLabels: false, flowchart: { htmlLabels: false }, theme }
}
