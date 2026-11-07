// The slide strip: a listbox of miniatures with one Tab stop (docs/design/outputs-2.md 13.1).
import { useEffect, useRef } from 'react'
import type { KeyboardEvent, ReactElement } from 'react'
import type { SlidePreview } from '@shared/types'
import { slideKey, thumbName } from '../../lib/slideStage'
import SlideStage from './SlideStage'

export interface SlideStripProps {
  slides: SlidePreview[]
  size: { w: number; h: number }
  /** 0-based selected index. */
  index: number
  onSelect(index: number): void
  /** Open notes per slide number. */
  openNotes?: Map<number, number>
  vertical: boolean
  /** Focus the selected thumb when mounted. */
  focusOnMount?: boolean
}

export default function SlideStrip({ slides, size, index, onSelect, openNotes, vertical, focusOnMount }: SlideStripProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const focusThumb = (i: number): void => {
    ref.current?.querySelector<HTMLElement>(`[data-n="${slides[i]?.n}"]`)?.focus()
  }
  useEffect(() => {
    if (focusOnMount) focusThumb(index)
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Keep the selected thumb in view (the strip scrolls, the page never does).
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-n="${slides[index]?.n}"]`)
    const box = ref.current
    if (!el || !box) return
    if (vertical) {
      if (el.offsetTop < box.scrollTop) box.scrollTop = el.offsetTop
      else if (el.offsetTop + el.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = el.offsetTop + el.offsetHeight - box.clientHeight
    } else {
      if (el.offsetLeft < box.scrollLeft) box.scrollLeft = el.offsetLeft
      else if (el.offsetLeft + el.offsetWidth > box.scrollLeft + box.clientWidth) box.scrollLeft = el.offsetLeft + el.offsetWidth - box.clientWidth
    }
  }, [index, vertical, slides])

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const next = slideKey(e.key, index, slides.length, vertical)
    if (next === null) return
    e.preventDefault()
    e.stopPropagation()
    if (next !== index) onSelect(next)
    focusThumb(next)
  }

  return (
    <div
      ref={ref}
      className="slide-strip"
      role="listbox"
      aria-label="Slides"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      data-testid="slide-strip"
      onKeyDown={onKeyDown}
    >
      {slides.map((s, i) => {
        const open = openNotes?.get(s.n) ?? 0
        return (
          <div
            key={s.n}
            role="option"
            className="slide-thumb"
            data-testid="slide-thumb"
            data-n={s.n}
            aria-selected={i === index}
            aria-label={thumbName(s, open)}
            tabIndex={i === index ? 0 : -1}
            data-autofocus={focusOnMount && i === index ? "" : undefined}
            onClick={() => onSelect(i)}
          >
            <span className="slide-thumb-num" aria-hidden="true">{s.n}</span>
            <SlideStage slide={s} size={size} thumbnail />
            {open > 0 ? (
              <span className="slide-thumb-pin" aria-hidden="true" title={`${open} open ${open === 1 ? 'note' : 'notes'}`}>
                {open}
              </span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
