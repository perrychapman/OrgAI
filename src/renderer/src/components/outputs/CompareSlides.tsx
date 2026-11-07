// Compare for decks: a filmstrip of aligned pairs with status words and a two-up stage for the selected pair
// (docs/design/outputs-2.md 12.2 Slides). Fetches both versions' previews itself.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactElement } from 'react'
import type { OutputDiff, OutputPreview, RunOutput, SlidePreview } from '@shared/types'
import { Button } from '../ui/Button'
import { Switch } from '../ui/Switch'
import { PAIR_GLYPH, PAIR_WORD, compareSummary, pairName, slideKey, visiblePairs } from '../../lib/slideStage'
import SlideStage from './SlideStage'
import '../../styles/outputs-slides.css'

export interface CompareSlidesProps {
  output: RunOutput
  a: number
  b: number
  diff: Extract<OutputDiff, { kind: 'slides' }>
  /** Speak a summary once through the surface's output-live. */
  announce(text: string): void
}

interface Deck {
  size: { w: number; h: number }
  slides: SlidePreview[]
}
type Loaded = { state: 'loading' } | { state: 'error' } | { state: 'ready'; a: Deck; b: Deck }

const deckOf = (p: OutputPreview): Deck | null => (p.kind === 'slides' ? { size: p.size, slides: p.slides } : null)

export default function CompareSlides({ output, a, b, diff, announce }: CompareSlidesProps): ReactElement {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [showSame, setShowSame] = useState(false)
  const [sel, setSel] = useState(0)
  const strip = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    setLoaded({ state: 'loading' })
    const get = (version: number): Promise<OutputPreview> => window.orgai.outputs.preview({ projectId: output.projectId, outputId: output.id, version })
    Promise.all([get(a), get(b)])
      .then(([pa, pb]) => {
        if (!live) return
        const da = deckOf(pa)
        const db = deckOf(pb)
        setLoaded(da && db ? { state: 'ready', a: da, b: db } : { state: 'error' })
      })
      .catch(() => live && setLoaded({ state: 'error' }))
    return () => {
      live = false
    }
  }, [output.projectId, output.id, a, b, attempt])

  const summary = useMemo(() => compareSummary(diff.pairs, diff.truncated), [diff])
  const announced = useRef('')
  useEffect(() => {
    const key = `${a}:${b}:${summary}`
    if (announced.current === key) return
    announced.current = key
    announce(summary)
  }, [a, b, summary, announce])

  const pairs = useMemo(() => visiblePairs(diff.pairs, showSame), [diff, showSame])
  const at = Math.min(sel, Math.max(pairs.length - 1, 0))
  const pair = pairs[at]

  if (loaded.state === 'loading') {
    return (
      <div className="slide-compare" data-testid="slide-compare" data-state="loading">
        <p className="output-preview-note">Comparing...</p>
      </div>
    )
  }
  if (loaded.state === 'error') {
    return (
      <div className="slide-compare" data-testid="slide-compare" data-state="error">
        <p className="output-preview-note output-preview-problem" role="alert">Could not compare these versions.</p>
        <div>
          <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
        </div>
      </div>
    )
  }

  const { a: deckA, b: deckB } = loaded
  const slideA = pair?.a !== undefined ? deckA.slides.find((s) => s.n === pair.a) : undefined
  const slideB = pair?.b !== undefined ? deckB.slides.find((s) => s.n === pair.b) : undefined

  const onKey = (e: KeyboardEvent): void => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const next = slideKey(e.key, at, pairs.length, true)
    if (next === null) return
    e.preventDefault()
    setSel(next)
    strip.current?.querySelector<HTMLElement>(`[data-i="${next}"]`)?.focus()
  }

  const side = (label: 'A' | 'B', version: number, slide: SlidePreview | undefined, size: Deck['size']): ReactElement => (
    <figure className="slide-compare-side" data-testid={`slide-compare-${label.toLowerCase()}`}>
      <figcaption>
        {label} · version {version}
      </figcaption>
      {slide ? (
        <div className="slide-compare-fit">
          <SlideStage slide={slide} size={size} />
        </div>
      ) : (
        <p className="slide-compare-missing">Not in version {version}</p>
      )}
    </figure>
  )

  return (
    <div className="slide-compare" data-testid="slide-compare" data-state="ready">
      <div className="slide-compare-head">
        <p className="output-preview-note" data-testid="slide-compare-summary">{summary}</p>
        <label className="slide-compare-switch">
          <Switch checked={showSame} onChange={(v) => { setShowSame(v); setSel(0) }} label="Show unchanged slides" testId="slide-compare-show-same" />
          <span aria-hidden="true">Show unchanged slides</span>
        </label>
      </div>
      {pairs.length === 0 ? (
        <p className="output-preview-note" data-testid="slide-compare-none">No slides changed between these versions.</p>
      ) : (
        <>
          <div ref={strip} className="slide-filmstrip" role="listbox" aria-label="Slide pairs" aria-orientation="vertical" data-testid="slide-filmstrip" onKeyDown={onKey}>
            {pairs.map((p, i) => {
              const thumbSlide = p.b !== undefined ? deckB.slides.find((s) => s.n === p.b) : deckA.slides.find((s) => s.n === p.a)
              const thumbSize = p.b !== undefined ? deckB.size : deckA.size
              return (
                <div
                  key={`${p.a ?? '-'}:${p.b ?? '-'}`}
                  role="option"
                  className="slide-pair"
                  data-testid="slide-pair"
                  data-status={p.status}
                  data-i={i}
                  aria-selected={i === at}
                  tabIndex={i === at ? 0 : -1}
                  aria-label={pairName(p, deckA.slides.find((s) => s.n === p.a)?.title, deckB.slides.find((s) => s.n === p.b)?.title)}
                  onClick={() => setSel(i)}
                >
                  {thumbSlide ? <SlideStage slide={thumbSlide} size={thumbSize} thumbnail /> : null}
                  <span className="slide-pair-status" aria-hidden="true">
                    <span className="slide-pair-glyph">{PAIR_GLYPH[p.status]}</span> {PAIR_WORD[p.status]}
                  </span>
                </div>
              )
            })}
          </div>
          <div className="slide-compare-body" data-testid="slide-compare-body">
            {side('A', a, slideA, deckA.size)}
            {side('B', b, slideB, deckB.size)}
          </div>
        </>
      )}
      {diff.truncated ? <p className="output-preview-note">Only the first slides were compared.</p> : null}
    </div>
  )
}
