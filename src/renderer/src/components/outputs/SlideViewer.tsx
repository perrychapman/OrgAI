// The deck viewer: strip + stage (docs/design/outputs-2.md 13.1). The stage is fit-to-pane on both surfaces (no Ctrl+wheel
// zoom yet: usePanZoom is built around a free-pan drawing, a slide is always shown whole).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactElement } from 'react'
import { ChevronLeft, ChevronRight, MessageSquarePlus } from 'lucide-react'
import type { SlideBox, SlidePreview } from '@shared/types'
import { IconButton } from '../ui/IconButton'
import { Button } from '../ui/Button'
import {
  FIDELITY_NOTE,
  labelsInBox,
  openNotesBySlide,
  slideCounter,
  slideKey,
  truncatedSlidesLine
} from '../../lib/slideStage'
import { useOutputDetail } from './outputDetailContext'
import { useOutputView } from './previewStatus'
import RegionLayer, { useRegionKeys } from './RegionLayer'
import SlideStage from './SlideStage'
import SlideStrip from './SlideStrip'
import '../../styles/outputs-slides.css'

export interface SlideViewerProps {
  size: { w: number; h: number }
  slides: SlidePreview[]
  truncatedSlides?: number
  title: string
}

const WHOLE: SlideBox = { x: 0, y: 0, w: 1, h: 1 }

export default function SlideViewer({ size, slides, truncatedSlides }: SlideViewerProps): ReactElement {
  const ctx = useOutputDetail()
  const view = useOutputView()
  const surface = ctx?.surface ?? (view.context === 'dialog' ? 'viewer' : 'detail')
  const [index, setIndex] = useState(0)
  const [wide, setWide] = useState(true)
  const [notesOpen, setNotesOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const count = slides.length
  const at = Math.min(index, Math.max(count - 1, 0))
  const slide = slides[at]

  // The container query's answer, also needed for the strip's orientation.
  useEffect(() => {
    const el = root.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setWide(el.clientWidth >= 700))
    ro.observe(el)
    setWide(el.clientWidth >= 700)
    return () => ro.disconnect()
  }, [count])

  const notes = ctx?.notes ?? null
  const version = ctx?.version ?? 0
  const openNotes = useMemo(() => openNotesBySlide(notes, version), [notes, version])

  const labelsIn = useCallback((box: SlideBox): string[] => (slide ? labelsInBox(slide, box) : []), [slide])
  const regionKeys = useRegionKeys({ slide: slide?.n, labelsIn })

  // A whole-slide selection so a note can attach when no region is drawn. Region drawing replaces it.
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const slideNo = slide?.n
  useEffect(() => {
    if (!slideNo) return
    ctxRef.current?.setSelection({ anchor: { type: 'slide', slide: slideNo }, description: `Slide ${slideNo}` })
  }, [slideNo])
  useEffect(
    () => () => {
      const sel = ctxRef.current?.selection
      if (sel && sel.anchor.type === 'slide') ctxRef.current?.setSelection(null)
    },
    []
  )

  // Show in output: bring a note's slide into view.
  const shown = ctx?.shownNote ?? null
  useEffect(() => {
    if (!shown) return
    const n = ctxRef.current?.notes?.find((x) => x.id === shown)
    const a = n?.anchor
    const target = a?.type === 'slide' ? a.slide : a?.type === 'region' ? a.slide : undefined
    if (!target) return
    const i = slides.findIndex((s) => s.n === target)
    if (i >= 0) setIndex(i)
  }, [shown, slides])

  const go = (i: number): void => setIndex(Math.min(Math.max(i, 0), Math.max(count - 1, 0)))

  const onStageKey = (e: KeyboardEvent): void => {
    if (regionKeys(e, WHOLE)) return
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const next = slideKey(e.key, at, count, false)
    if (next === null) return
    e.preventDefault()
    go(next)
  }

  if (count === 0 || !slide) {
    return (
      <div className="output-slides" data-testid="output-slides" data-state="empty" data-surface={surface} ref={root}>
        <p className="output-preview-note">This deck has no slides.</p>
      </div>
    )
  }

  const truncated = truncatedSlidesLine(truncatedSlides)
  const notesId = 'slide-notes-body'
  const slideLabel = slide.title ? `${slideCounter(slide.n, count)}: ${slide.title}` : slideCounter(slide.n, count)

  return (
    <div className="output-slides" data-testid="output-slides" data-state="ready" data-surface={surface} data-wide={wide ? 'true' : 'false'} ref={root}>
     <div className="slide-layout">
      <div className="slide-main">
        <div
          className="slide-stage"
          data-testid="slide-stage"
          role="group"
          aria-roledescription="slide"
          aria-label={slideLabel}
          tabIndex={0}
          onKeyDown={onStageKey}
        >
          <SlideStage slide={slide} size={size}>
            <div className="slide-region-host">
              <RegionLayer slide={slide.n} naturalW={size.w} naturalH={size.h} labelsIn={labelsIn} />
            </div>
          </SlideStage>
        </div>
        <div className="slide-bar">
          <IconButton icon={ChevronLeft} label="Previous slide" size="sm" disabled={at === 0} onClick={() => go(at - 1)} testId="slide-prev" />
          <span className="slide-counter" role="status" data-testid="slide-counter">
            {slideCounter(slide.n, count)}
          </span>
          <IconButton icon={ChevronRight} label="Next slide" size="sm" disabled={at >= count - 1} onClick={() => go(at + 1)} testId="slide-next" />
          <span className="slide-bar-gap" />
          {ctx ? (
            <Button
              size="sm"
              icon={MessageSquarePlus}
              testId="slide-revise"
              onClick={() =>
                ctx.openRevise({
                  scope: 'selection',
                  selection: { anchor: { type: 'slide', slide: slide.n }, description: `Slide ${slide.n}` }
                })
              }
            >
              Revise this slide
            </Button>
          ) : null}
        </div>
        <div className="slide-notes" data-testid="slide-notes" data-open={notesOpen ? 'true' : 'false'}>
          <button
            type="button"
            className="slide-notes-toggle"
            aria-expanded={notesOpen}
            aria-controls={notesId}
            onClick={() => setNotesOpen((o) => !o)}
          >
            Speaker notes
          </button>
          {notesOpen ? (
            <p id={notesId} className="slide-notes-body" data-testid="slide-notes-body">
              {slide.notes?.trim() ? slide.notes : 'This slide has no speaker notes.'}
            </p>
          ) : null}
        </div>
        <p className="output-preview-note slide-fidelity" data-testid="slide-fidelity">
          {FIDELITY_NOTE}
        </p>
        {truncated ? (
          <p className="output-preview-note" data-testid="slide-truncated">
            {truncated}
          </p>
        ) : null}
      </div>
      <SlideStrip slides={slides} size={size} index={at} onSelect={go} openNotes={openNotes} vertical={wide} focusOnMount={surface === 'viewer'} />
     </div>
    </div>
  )
}
