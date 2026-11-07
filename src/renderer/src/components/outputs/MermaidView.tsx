import type { ReactElement } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '../ui/Button'
import { svgNaturalSize } from '../../lib/outputZoom'
import { ZoomBar, useZoom } from './ZoomControl'
import { SegmentedControl } from '../ui/SegmentedControl'
import { safeMermaidSvg } from '../../lib/outputSvg'
import { usePreviewStatus } from './previewStatus'

type View = 'diagram' | 'source'
type Drawn = { state: 'drawing' } | { state: 'ok'; root: Element } | { state: 'error'; message: string } | { state: 'refused' }

/** The words OutputPreview's one status region speaks for each state of the drawing ('' when it is drawn). */
function statusFor(d: Drawn): string {
  if (d.state === 'drawing') return 'Drawing the diagram…'
  if (d.state === 'error') return `This diagram could not be drawn: ${d.message}.`
  if (d.state === 'refused') return REFUSED_TEXT
  return ''
}
const REFUSED_TEXT = 'OrgAI did not show this drawing because it contained active content.'

// Mermaid's own styles stay inside the shadow root; this one sizes the drawing (the zoom's pixel size, else its column).
function shadowStyle(size: { w: number; h: number } | null): string {
  // !important: Mermaid writes its own inline max-width on the root svg, which would otherwise cap an enlarged drawing.
  return size
    ? `svg { display: block !important; max-width: none !important; width: ${Math.round(size.w)}px !important; height: ${Math.round(size.h)}px !important; }`
    : 'svg { max-width: 100%; height: auto; }'
}

/** lib/theme.ts resolves System to 'dark' | 'light' and writes it as data-theme on <html>. */
function currentTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

function useTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState(currentTheme)
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(currentTheme()))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])
  return theme
}

let renderSeq = 0
// Mermaid keeps global state (initialize, a temp element per render), so renders run one at a time.
let queue: Promise<unknown> = Promise.resolve()

/** Plain sentence from a mermaid parse error (first line, no stack). */
function messageOf(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  const line = raw.split('\n').find((l) => l.trim()) ?? 'unknown error'
  return line.trim().replace(/[.:\s]+$/, '').slice(0, 200)
}

async function drawDiagram(text: string, theme: 'light' | 'dark'): Promise<Drawn> {
  const id = `output-mermaid-${++renderSeq}`
  try {
    const m = (await import('mermaid')).default
    m.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      // foreignObject labels are refused by the gate below, so labels are drawn as SVG text.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      theme: theme === 'light' ? 'default' : 'dark'
    })
    try {
      await m.parse(text)
    } catch (e) {
      return { state: 'error', message: messageOf(e) }
    }
    const { svg } = await m.render(id, text)
    const checked = safeMermaidSvg(svg)
    return checked.ok ? { state: 'ok', root: checked.root } : { state: 'refused' }
  } catch (e) {
    return { state: 'error', message: messageOf(e) }
  } finally {
    // A failed render can leave its temp element (and mermaid's wrapper) in <body>.
    document.getElementById(id)?.remove()
    document.getElementById(`d${id}`)?.remove()
  }
}

/** A Mermaid diagram drawn in the window, with its source one switch away. Never throws; a bad diagram shows its source. */
export default function MermaidView({ text, title, truncated }: { text: string; title: string; truncated?: boolean }): ReactElement {
  const theme = useTheme()
  const [view, setView] = useState<View>('diagram')
  const [drawn, setDrawn] = useState<Drawn>({ state: 'drawing' })
  const [copied, setCopied] = useState(false)
  const seq = useRef(0)

  useEffect(() => {
    const mine = ++seq.current
    setDrawn({ state: 'drawing' })
    const job = queue.then(() => drawDiagram(text, theme))
    queue = job.catch(() => undefined)
    void job.then((d) => {
      if (seq.current === mine) setDrawn(d)
    })
    return () => {
      seq.current++
    }
  }, [text, theme])

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])

  usePreviewStatus(statusFor(drawn))
  const showSource = view === 'source' || drawn.state === 'error' || drawn.state === 'refused'

  // The checked tree is imported into a shadow root: never re-parsed from text, and Mermaid's <style> and ids stay out of the app.
  const host = useRef<HTMLDivElement>(null)
  const okRoot = drawn.state === 'ok' ? drawn.root : null
  const natural = useMemo(() => (okRoot ? svgNaturalSize(okRoot.getAttribute('viewBox'), okRoot.getAttribute('width'), okRoot.getAttribute('height')) : null), [okRoot])
  const zoom = useZoom(natural)
  const styleEl = useRef<HTMLStyleElement | null>(null)
  const sizeW = zoom.size?.w
  const sizeH = zoom.size?.h
  useEffect(() => {
    const el = host.current
    if (!el || !okRoot) return
    const shadow = el.shadowRoot ?? el.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = shadowStyle(sizeW && sizeH ? { w: sizeW, h: sizeH } : null)
    styleEl.current = style
    shadow.replaceChildren(style, document.importNode(okRoot, true))
    // The size is applied by the effect below; a new drawing only rebuilds the tree.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [okRoot, showSource])
  useEffect(() => {
    if (styleEl.current) styleEl.current.textContent = shadowStyle(sizeW && sizeH ? { w: sizeW, h: sizeH } : null)
  }, [sizeW, sizeH, okRoot, showSource])

  const copy = (): void => {
    if (drawn.state !== 'ok') return
    void navigator.clipboard
      ?.writeText(new XMLSerializer().serializeToString(drawn.root))
      .then(() => setCopied(true))
      .catch(() => undefined)
  }

  return (
    <div className="output-mermaid" data-testid="output-mermaid" data-state={drawn.state}>
      <div className="output-toolbar">
        <div data-testid="output-mermaid-view">
          <SegmentedControl<View>
            label="View"
            value={showSource ? 'source' : 'diagram'}
            onChange={setView}
            options={[
              { value: 'diagram', label: 'Diagram' },
              { value: 'source', label: 'Source' }
            ]}
          />
        </div>
        {drawn.state === 'ok' && !showSource && <ZoomBar zoom={zoom} />}
        {drawn.state === 'ok' && (
          <Button size="sm" variant="ghost" icon={copied ? Check : Copy} onClick={copy} testId="output-mermaid-copy">
            Copy SVG
          </Button>
        )}
        <span className="output-quiet" role="status" data-testid="output-mermaid-copied">
          {copied ? 'Copied.' : ''}
        </span>
      </div>
      {drawn.state === 'error' && (
        <p className="output-preview-note output-preview-problem" data-testid="output-mermaid-error">
          This diagram could not be drawn: {drawn.message}.
        </p>
      )}
      {drawn.state === 'refused' && (
        <p className="output-preview-note output-preview-problem" data-testid="output-mermaid-refused">
          {REFUSED_TEXT}
        </p>
      )}
      {showSource ? (
        <pre className="output-scroll output-pre" data-testid="output-source" role="region" aria-label={`${title} source`} tabIndex={0}>
          {text}
        </pre>
      ) : drawn.state === 'drawing' ? (
        <p className="output-preview-note">Drawing the diagram…</p>
      ) : drawn.state === 'ok' ? (
        <div ref={zoom.regionRef} className="output-scroll output-mermaid-stage" role="region" aria-label={`${title} diagram`} aria-keyshortcuts="+ - 0" tabIndex={0} onKeyDown={zoom.onKeyDown}>
          {/* The checked tree (safeMermaidSvg: XML namespace, no script, foreignObject, comment, instruction, handler,
              outside link or resource attribute, after Mermaid's own 'strict' sanitizer) is imported as nodes into a
              shadow root by the effect above. No markup string is ever parsed here. */}
          <div ref={host} className="output-mermaid-svg" data-testid="output-mermaid-svg" role="img" aria-label={title} />
        </div>
      ) : null}
      {truncated && (
        <p className="output-preview-note" data-testid="output-text-truncated">
          The preview stops here. Open the file to read the rest.
        </p>
      )}
    </div>
  )
}
