// The diagram viewer (docs/design/outputs-2.md section 8): a pan/zoom surface over a CHECKED Mermaid drawing, with source and split
// views, an overview, light drawing and export. Every drawing comes from useDiagramDraw (safeMermaidSvg) and is put on screen with
// document.importNode into a shadow root; no markup string is ever parsed or inserted here.
import type { ReactElement } from 'react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Button } from '../../ui/Button'
import {
  COPY_FAILED,
  SOURCE_COPIED,
  exportTheme,
  viewerTheme,
  type ExportOptions
} from '../../../lib/diagramExport'
import {
  DRAW_GUARD_BYTES,
  GUARD_TEXT,
  SHAPE_SELECTOR,
  biggerThanViewport,
  byteLength,
  diagramText,
  hintText,
  isLargeDiagram,
  largeNote,
  type ViewKey
} from '../../../lib/diagramView'
import { svgNaturalSize } from '../../../lib/outputZoom'
import { useOutputView, usePreviewStatus } from '../previewStatus'
import { DiagramError } from './DiagramError'
import { serializeStandalone, useDiagramExport, type ExportBuild } from './DiagramExport'
import { DiagramOverview } from './DiagramOverview'
import { DiagramSourcePane, type SourceHandle } from './DiagramSourcePane'
import { DiagramToolbar, type DiagramMode } from './DiagramToolbar'
import { PanZoomSurface, ShadowSvg } from './PanZoomSurface'
import { drawDiagram, useDiagramDraw } from './useDiagramDraw'
import { usePanZoom } from './usePanZoom'

export const OVERVIEW_KEY = 'orgai.diagramOverview'
const REDRAW_DELAY_MS = 400
const NOTICE_MS = 8000
/** Container width where Split puts the editor beside the viewport. */
const SPLIT_ROW_PX = 900
/** Under this container width everything after the zoom group moves into More. */
const NARROW_PX = 560

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

function readOverviewPref(): boolean | null {
  try {
    const v = localStorage.getItem(OVERVIEW_KEY)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

/** Width of an element, followed through resizes. */
function useWidth(): [(el: HTMLDivElement | null) => void, number] {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!el) return undefined
    const read = (): void => setWidth(Math.round(el.clientWidth))
    read()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return [setEl, width]
}

export interface DiagramViewerProps {
  /** The Mermaid source of the output. */
  text: string
  title: string
  /** The preview was cut at its size cap: the diagram is never drawn. */
  truncated?: boolean
}

/** A Mermaid diagram drawn in the window with pan, zoom and its source one switch away. Never throws. */
export default function DiagramViewer({ text, title, truncated }: DiagramViewerProps): ReactElement {
  const { context, onOpenLarge, full, onToggleFull } = useOutputView()
  const appTheme = useTheme()
  const [light, setLight] = useState(false)
  const mTheme = viewerTheme(appTheme, light)

  // ---- source: a scratch copy that redraws 400 ms after typing stops ----
  const [source, setSource] = useState(text)
  const [applied, setApplied] = useState(text)
  useEffect(() => {
    setSource(text)
    setApplied(text)
  }, [text])
  useEffect(() => {
    if (source === applied) return undefined
    const t = setTimeout(() => setApplied(source), REDRAW_DELAY_MS)
    return () => clearTimeout(t)
  }, [source, applied])

  const [drawAnyway, setDrawAnyway] = useState(false)
  const guarded = byteLength(applied) > DRAW_GUARD_BYTES && !drawAnyway
  const enabled = !truncated && !guarded
  const { drawn: drawnNow, good } = useDiagramDraw(applied, mTheme, enabled)
  const state: 'drawing' | 'ok' | 'error' | 'refused' | 'guard' | 'truncated' = truncated ? 'truncated' : guarded ? 'guard' : drawnNow.state
  usePreviewStatus(state === 'drawing' ? 'Drawing the diagram…' : '')

  // ---- one live region and one visible notice ----
  const [live, setLive] = useState('')
  const [notice, setNotice] = useState('')
  const speakTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const speak = useCallback((t: string): void => {
    // Clear first so the same sentence twice is heard twice.
    setLive('')
    if (speakTimer.current) clearTimeout(speakTimer.current)
    speakTimer.current = setTimeout(() => setLive(t), 60)
  }, [])
  const notify = useCallback(
    (t: string): void => {
      setNotice(t)
      speak(t)
      if (noticeTimer.current) clearTimeout(noticeTimer.current)
      noticeTimer.current = setTimeout(() => setNotice(''), NOTICE_MS)
    },
    [speak]
  )
  useEffect(
    () => () => {
      if (speakTimer.current) clearTimeout(speakTimer.current)
      if (noticeTimer.current) clearTimeout(noticeTimer.current)
    },
    []
  )

  // ---- the drawing's facts ----
  const natural = useMemo(() => (good ? svgNaturalSize(good.getAttribute('viewBox'), good.getAttribute('width'), good.getAttribute('height')) : null), [good])
  const facts = useMemo(() => {
    if (!good) return { shapes: 0, labels: [] as string[], aria: title }
    const els = Array.from(good.querySelectorAll(SHAPE_SELECTOR))
    const t = good.querySelector('title')?.textContent?.trim()
    return { shapes: els.length, labels: els.map((e) => e.textContent ?? ''), aria: t ? `${title}. ${t}` : title }
  }, [good, title])
  const hiddenText = diagramText(facts.labels, facts.shapes)

  // ---- layout and mode ----
  const [widthRef, width] = useWidth()
  const narrow = width > 0 && width < NARROW_PX
  const sourceRef = useRef<SourceHandle>(null)
  const [mode, setMode] = useState<DiagramMode>('diagram')
  const first = useRef(true)
  useEffect(() => {
    if (state === 'drawing') return
    if (!first.current) return
    first.current = false
    // Opening an erroring diagram shows its source beside it when there is room, else instead of it.
    if (state === 'error' || state === 'refused') setMode(width >= SPLIT_ROW_PX ? 'split' : 'source')
  }, [state, width])
  const view: DiagramMode = mode === 'diagram' && (state === 'guard' || state === 'truncated') ? 'source' : mode
  const showViewport = view !== 'source'
  const showSource = view !== 'diagram'
  const rowLayout = view === 'split' && width >= SPLIT_ROW_PX

  const focusSource = useCallback((): void => {
    requestAnimationFrame(() => sourceRef.current?.focus())
  }, [])

  // ---- pan and zoom ----
  const [overviewPref, setOverviewPref] = useState<boolean | null>(readOverviewPref)
  const onCommandRef = useRef<(k: ViewKey) => void>(() => undefined)
  const pz = usePanZoom(natural, { wheel: context === 'dialog' ? 'zoom' : 'modifier', onSpeak: speak, onCommand: (k) => onCommandRef.current(k) })
  const large = good !== null && isLargeDiagram(facts.shapes, pz.fitK)
  const bigger = natural !== null && biggerThanViewport(natural, pz.box, pz.view.k)
  const overviewOn = good !== null && showViewport && (overviewPref ?? (context === 'dialog' && large && bigger))
  const toggleOverview = useCallback((): void => {
    const next = !overviewOn
    setOverviewPref(next)
    try {
      localStorage.setItem(OVERVIEW_KEY, next ? '1' : '0')
    } catch {
      // Not saved; the choice holds for this window.
    }
  }, [overviewOn])
  onCommandRef.current = (k) => {
    if (k.type === 'overview') toggleOverview()
    else if (k.type === 'source') {
      if (mode === 'diagram') setMode('source')
      focusSource()
    } else if (k.type === 'full') onToggleFull?.()
  }

  // ---- export ----
  const goodText = useRef(text)
  useEffect(() => {
    if (drawnNow.state === 'ok') goodText.current = applied
  }, [drawnNow, applied])
  const build = useCallback(
    async (o: ExportOptions, withRect: boolean): Promise<ExportBuild | null> => {
      // Exports redraw in Mermaid's default theme (through the same checked path) unless "As shown" was picked.
      const want = exportTheme(o.theme, mTheme)
      let root: Element | null = null
      if (want === mTheme) root = good
      else {
        const d = await drawDiagram(goodText.current, want)
        root = d.state === 'ok' ? d.root : null
      }
      return root ? serializeStandalone(root, o.background, withRect) : null
    },
    [good, mTheme]
  )
  const exportApi = useDiagramExport({ title, build, notify, showTheme: true })
  const copySource = useCallback((): void => {
    navigator.clipboard.writeText(source).then(
      () => notify(SOURCE_COPIED),
      () => notify(COPY_FAILED)
    )
  }, [source, notify])

  const goToLine = (line: number): void => {
    if (mode === 'diagram') setMode('source')
    requestAnimationFrame(() => sourceRef.current?.selectLine(line))
  }

  const textId = useId()
  const errorMessage = drawnNow.state === 'error' ? drawnNow.message : ''
  const showError = state === 'error' || state === 'refused'

  return (
    <div
      ref={widthRef}
      className="diagram-viewer"
      data-testid="output-mermaid"
      data-state={state}
      data-view={view}
      data-context={context}
      data-layout={rowLayout ? 'row' : 'column'}
    >
      <DiagramToolbar
        mode={view}
        onMode={setMode}
        pz={pz}
        hasDrawing={good !== null}
        overview={overviewOn}
        onOverview={toggleOverview}
        light={light}
        onLight={setLight}
        exportApi={exportApi}
        onCopySource={copySource}
        narrow={narrow}
        context={context}
        onOpenLarge={onOpenLarge}
        full={full}
        onToggleFull={onToggleFull}
      />
      {notice && (
        <p className="diagram-notice" data-testid="diagram-notice">
          {notice}
        </p>
      )}
      {large && showViewport && (
        <p className="diagram-large-note" role="note" data-testid="diagram-large-note">
          {largeNote(facts.shapes)}
          {context === 'detail' && onOpenLarge && (
            <Button size="sm" testId="diagram-large-open" onClick={onOpenLarge}>
              Open large
            </Button>
          )}
        </p>
      )}
      {state === 'guard' && (
        <p className="diagram-guard" data-testid="diagram-guard">
          {GUARD_TEXT}
          <Button size="sm" testId="diagram-draw-anyway" onClick={() => setDrawAnyway(true)}>
            Draw it anyway
          </Button>
        </p>
      )}
      {state === 'truncated' && (
        <p className="output-preview-note" data-testid="output-text-truncated">
          The preview stops here. Open the file to read the rest.
        </p>
      )}
      {showError && <DiagramError kind={state === 'refused' ? 'refused' : 'error'} message={errorMessage} onGoToLine={goToLine} />}
      <div className="diagram-body" data-layout={rowLayout ? 'row' : 'column'} data-view={view}>
        {showViewport && (
          <div className="diagram-pane diagram-pane-view">
            {good ? (
              <>
                {state === 'error' && (
                  <p className="diagram-stale-badge" data-testid="diagram-stale-badge">
                    Showing the last drawing that worked
                  </p>
                )}
                <PanZoomSurface
                  pz={pz}
                  title={title}
                  kind="diagram"
                  hint={hintText(context)}
                  describedBy={textId}
                  stale={state === 'error'}
                  paper={light}
                  data={{ shapes: facts.shapes }}
                  overlay={overviewOn ? <DiagramOverview pz={pz} root={good} /> : null}
                >
                  <ShadowSvg root={good} size={natural} testId="output-mermaid-svg" label={facts.aria} />
                </PanZoomSurface>
                <p id={textId} className="sr-only" data-testid="output-diagram-text">
                  {hiddenText}
                </p>
              </>
            ) : (
              <p className="output-preview-note diagram-empty">{state === 'drawing' ? 'Drawing the diagram…' : 'There is no drawing to show.'}</p>
            )}
          </div>
        )}
        {showSource && (
          <div className="diagram-pane diagram-pane-source">
            <DiagramSourcePane ref={sourceRef} value={source} original={text} onChange={setSource} />
          </div>
        )}
      </div>
      <p className="sr-only" role="status" data-testid="output-live">
        {live}
      </p>
    </div>
  )
}

