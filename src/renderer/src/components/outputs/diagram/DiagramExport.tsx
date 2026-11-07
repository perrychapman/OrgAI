// Export of a drawing as an image (docs/design/outputs-2.md section 8.7). The pure parts are in lib/diagramExport.ts.
import type { ReactElement } from 'react'
import { useCallback, useRef, useState } from 'react'
import { Copy, Download, FileImage, Image as ImageIcon } from 'lucide-react'
import {
  COPY_FAILED,
  COPY_REFUSED,
  EXPORT_FAILED,
  EXPORT_KEY,
  SVG_NS,
  XMLNS_NS,
  backgroundRect,
  downloadName,
  exportNotice,
  exportSize,
  parseExportOptions,
  standaloneAttrs,
  stripMaxWidth,
  svgToDataUrl,
  type ExportOptions,
  type ExportSize
} from '../../../lib/diagramExport'
import { svgNaturalSize } from '../../../lib/outputZoom'
import type { Size } from '../../../lib/diagramView'
import { Icon } from '../../ui/Icon'
import { Popover } from '../../ui/Popover'
import { SegmentedControl } from '../../ui/SegmentedControl'

export interface ExportBuild {
  /** A standalone svg document. */
  svg: string
  natural: Size
}

export interface ExportApi {
  options: ExportOptions
  setOptions: (patch: Partial<ExportOptions>) => void
  busy: boolean
  /** True when the theme option applies (a diagram, not an SVG file). */
  showTheme: boolean
  copyPng: () => void
  savePng: () => void
  saveSvg: () => void
  copySvg: () => void
}

/** The checked root as a standalone svg document: xmlns, width and height from the viewBox, optional white rectangle behind. */
export function serializeStandalone(root: Element, background: 'white' | 'transparent', withRect: boolean): ExportBuild {
  const clone = root.cloneNode(true) as Element
  const viewBox = clone.getAttribute('viewBox')
  const natural = svgNaturalSize(viewBox, clone.getAttribute('width'), clone.getAttribute('height')) ?? { w: 800, h: 600 }
  for (const [name, value] of Object.entries(standaloneAttrs(natural))) {
    if (name.startsWith('xmlns')) clone.setAttributeNS(XMLNS_NS, name, value)
    else clone.setAttribute(name, value)
  }
  const style = stripMaxWidth(clone.getAttribute('style'))
  if (style) clone.setAttribute('style', style)
  else clone.removeAttribute('style')
  if (withRect && background === 'white') {
    const rect = clone.ownerDocument.createElementNS(SVG_NS, 'rect')
    for (const [name, value] of Object.entries(backgroundRect(viewBox, natural))) rect.setAttribute(name, value)
    clone.insertBefore(rect, clone.firstChild)
  }
  return { svg: new XMLSerializer().serializeToString(clone), natural }
}

async function toPng(svg: string, size: ExportSize, background: 'white' | 'transparent'): Promise<Blob> {
  const img = new Image()
  img.src = svgToDataUrl(svg)
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no canvas')
  if (background === 'white') {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, size.width, size.height)
  }
  ctx.drawImage(img, 0, 0, size.width, size.height)
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('no image'))), 'image/png'))
}

/** A Blob download through an anchor (the browser saves it; there is no path to report). */
function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

function loadOptions(): ExportOptions {
  try {
    return parseExportOptions(localStorage.getItem(EXPORT_KEY))
  } catch {
    return parseExportOptions(null)
  }
}

/**
 * Save and copy actions for one drawing. `build(options, withRect)` returns the svg to export for those options (a diagram
 * redraws in Mermaid's default theme there); `notify` shows and speaks every result.
 */
export function useDiagramExport({
  title,
  build,
  notify,
  showTheme,
  svgSource
}: {
  title: string
  build: (o: ExportOptions, withRect: boolean) => Promise<ExportBuild | null>
  notify: (text: string) => void
  showTheme: boolean
  /** For an SVG output: the file's own text, saved and copied as it is. */
  svgSource?: string
}): ExportApi {
  const [options, setAll] = useState<ExportOptions>(loadOptions)
  const [busy, setBusy] = useState(false)
  const optionsRef = useRef(options)
  optionsRef.current = options
  const setOptions = useCallback((patch: Partial<ExportOptions>): void => {
    setAll((o) => {
      const next = { ...o, ...patch }
      try {
        localStorage.setItem(EXPORT_KEY, JSON.stringify(next))
      } catch {
        // Not saved; the choice still holds for this window.
      }
      return next
    })
  }, [])

  const png = useCallback(async (): Promise<{ blob: Promise<Blob>; size: ExportSize } | null> => {
    const o = optionsRef.current
    const built = await build(o, false)
    if (!built) return null
    const size = exportSize(built.natural, o.scale)
    return { blob: toPng(built.svg, size, o.background), size }
  }, [build])

  const guard = useCallback(
    async (fn: () => Promise<void>, failure: string): Promise<void> => {
      setBusy(true)
      try {
        await fn()
      } catch {
        notify(failure)
      } finally {
        setBusy(false)
      }
    },
    [notify]
  )

  const copyPng = useCallback(
    () =>
      void guard(async () => {
        const made = await png()
        if (!made) throw new Error('no drawing')
        // The clipboard takes the promise, so the permission check happens inside the user's click.
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': made.blob })])
        } catch {
          notify(COPY_REFUSED)
          return
        }
        notify(exportNotice(optionsRef.current.scale, made.size, true))
      }, EXPORT_FAILED),
    [guard, png, notify]
  )
  const savePng = useCallback(
    () =>
      void guard(async () => {
        const made = await png()
        if (!made) throw new Error('no drawing')
        download(await made.blob, downloadName(title, 'png'))
        notify(exportNotice(optionsRef.current.scale, made.size, false))
      }, EXPORT_FAILED),
    [guard, png, notify, title]
  )
  const saveSvg = useCallback(
    () =>
      void guard(async () => {
        const text = svgSource ?? (await build(optionsRef.current, true))?.svg
        if (!text) throw new Error('no drawing')
        download(new Blob([text], { type: 'image/svg+xml' }), downloadName(title, 'svg'))
        notify('Your browser is saving the file.')
      }, EXPORT_FAILED),
    [guard, build, notify, title, svgSource]
  )
  const copySvg = useCallback(
    () =>
      void guard(async () => {
        const text = svgSource ?? (await build(optionsRef.current, true))?.svg
        if (!text) throw new Error('no drawing')
        try {
          await navigator.clipboard.writeText(text)
        } catch {
          notify(COPY_FAILED)
          return
        }
        notify('Copied the SVG.')
      }, EXPORT_FAILED),
    [guard, build, notify, svgSource]
  )
  return { options, setOptions, busy, showTheme, copyPng, savePng, saveSvg, copySvg }
}

const THEME_OPTIONS = [
  { value: 'light' as const, label: 'Light (for documents and decks)' },
  { value: 'shown' as const, label: 'As shown' }
]
const BACKGROUND_OPTIONS = [
  { value: 'white' as const, label: 'White' },
  { value: 'transparent' as const, label: 'Transparent' }
]
const SCALE_OPTIONS = [
  { value: '1', label: '1x' },
  { value: '2', label: '2x' },
  { value: '3', label: '3x' }
]

/** The Export popover: options at the top, then the four actions. */
export function ExportPopover({ api }: { api: ExportApi }): ReactElement {
  return (
    <Popover
      trigger={
        <>
          <Icon icon={Download} size="sm" />
          Export
        </>
      }
      triggerClassName="btn ghost sm"
      triggerTitle="Save or copy the drawing as an image"
      triggerTestId="diagram-export"
      label="Export"
      role="dialog"
      placement="bottom-end"
      className="diagram-export-panel"
      testId="diagram-export-panel"
    >
      {({ close }) => (
        <div className="diagram-export">
          {api.showTheme && (
            <div className="diagram-export-field">
              <span className="diagram-export-label">Theme</span>
              <SegmentedControl label="Theme" value={api.options.theme} options={THEME_OPTIONS} onChange={(theme) => api.setOptions({ theme })} />
            </div>
          )}
          <div className="diagram-export-field">
            <span className="diagram-export-label">Background</span>
            <SegmentedControl label="Background" value={api.options.background} options={BACKGROUND_OPTIONS} onChange={(background) => api.setOptions({ background })} />
          </div>
          <div className="diagram-export-field">
            <span className="diagram-export-label">PNG size</span>
            <SegmentedControl label="PNG size" value={String(api.options.scale)} options={SCALE_OPTIONS} onChange={(v) => api.setOptions({ scale: Number(v) as 1 | 2 | 3 })} />
          </div>
          <div className="diagram-export-actions">
            <ActionItem testId="diagram-copy-png" icon={ImageIcon} label="Copy as image" onClick={() => { close(); api.copyPng() }} />
            <ActionItem testId="diagram-save-png" icon={FileImage} label="Save as PNG" onClick={() => { close(); api.savePng() }} />
            <ActionItem testId="diagram-save-svg" icon={FileImage} label="Save as SVG" onClick={() => { close(); api.saveSvg() }} />
            <ActionItem testId="diagram-copy-svg" icon={Copy} label="Copy SVG" onClick={() => { close(); api.copySvg() }} />
          </div>
        </div>
      )}
    </Popover>
  )
}

function ActionItem({ testId, icon, label, onClick }: { testId: string; icon: typeof Copy; label: string; onClick: () => void }): ReactElement {
  return (
    <button type="button" className="output-menuitem" data-testid={testId} onClick={onClick}>
      <Icon icon={icon} size="sm" />
      {label}
    </button>
  )
}

/** The same options and actions as menu items, for the More menu of a narrow viewer. Radio items keep the menu open. */
export function ExportMenuItems({ api, close }: { api: ExportApi; close: () => void }): ReactElement {
  const radio = <T extends string>(group: string, value: T, options: { value: T; label: string }[], set: (v: T) => void): ReactElement => (
    <div role="group" aria-label={group} className="diagram-menu-group">
      <span className="diagram-export-label" aria-hidden="true">
        {group}
      </span>
      {options.map((o) => (
        <button key={o.value} type="button" role="menuitemradio" aria-checked={value === o.value} className="output-menuitem diagram-menu-radio" onClick={() => set(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
  return (
    <>
      {api.showTheme && radio('Theme', api.options.theme, THEME_OPTIONS, (theme) => api.setOptions({ theme }))}
      {radio('Background', api.options.background, BACKGROUND_OPTIONS, (background) => api.setOptions({ background }))}
      {radio('PNG size', String(api.options.scale), SCALE_OPTIONS, (v) => api.setOptions({ scale: Number(v) as 1 | 2 | 3 }))}
      <MenuAction testId="diagram-copy-png" icon={ImageIcon} label="Copy as image" onClick={() => { close(); api.copyPng() }} />
      <MenuAction testId="diagram-save-png" icon={FileImage} label="Save as PNG" onClick={() => { close(); api.savePng() }} />
      <MenuAction testId="diagram-save-svg" icon={FileImage} label="Save as SVG" onClick={() => { close(); api.saveSvg() }} />
      <MenuAction testId="diagram-copy-svg" icon={Copy} label="Copy SVG" onClick={() => { close(); api.copySvg() }} />
    </>
  )
}

export function MenuAction({ testId, icon, label, onClick, checked }: { testId: string; icon?: typeof Copy; label: string; onClick: () => void; checked?: boolean }): ReactElement {
  return (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
      aria-checked={checked}
      className="output-menuitem"
      data-testid={testId}
      onClick={onClick}
    >
      {icon && <Icon icon={icon} size="sm" />}
      {label}
    </button>
  )
}
