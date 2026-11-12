import type { ReactElement } from 'react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type { OutputKind } from '@shared/types'
import { Markdown } from '../Markdown'
import { SegmentedControl } from '../ui/SegmentedControl'
import { parseCsv, prettyJson } from '../../lib/outputPreview'
import {
  anchorDescription,
  findQuote,
  lineSpans,
  spanRange,
  itemsSentence,
  renderedBlocksRange,
  mapEndByNonWhitespace,
  mapRenderedToSource,
  mapStartByNonWhitespace,
  quoteOf,
  textAnchorRange,
  textRanges,
  type TextRange
} from '../../lib/outputNotes'
import { scrollWithin } from '../../lib/scrollWithin'
import { useOutputDetail } from './outputDetailContext'
import { MarkedText, findNoted, selectedOffsets, useScrollToShown, useTextSelection, useViewedNotes } from './NoteMarks'
import { inRange } from '../../lib/outputNotes'
import { useGridNotes } from './SheetView'
import { useBlockCursor } from './useBlockCursor'

// Mermaid is large: its code loads only when a diagram is opened.
const MermaidView = lazy(() => import('./MermaidView'))

type MdView = 'rendered' | 'source'

/** The text anchor for a selection whose offsets are in the file text. */
function textSelection(raw: string, start: number, end: number): { anchor: { type: 'text'; start: number; end: number; quote: string }; description: string } {
  const anchor = { type: 'text' as const, start, end, quote: quoteOf(raw.slice(start, end)) }
  return { anchor, description: anchorDescription(anchor) }
}

/**
 * Plain text in a focusable region. `display` is what is drawn; `raw` is the file text the notes' offsets are in (they differ
 * only for pretty-printed JSON, where the two agree on every non-blank character).
 */
function Pre({ display, raw, title, testId, what }: { display: string; raw: string; title: string; testId: string; what: string }): ReactElement {
  const ref = useRef<HTMLPreElement>(null)
  const notes = useViewedNotes()
  const same = display === raw
  const lines = useMemo(() => lineSpans(display), [display])
  const cursor = useBlockCursor({ rootRef: ref, itemSelector: '[data-line]', resetKey: display, select: (lo, hi) => {
    const r = spanRange(lines, lo, hi)
    const start = r ? (same ? r.start : mapStartByNonWhitespace(display, raw, r.start)) : 0
    const end = r ? (same ? r.end : mapEndByNonWhitespace(display, raw, r.end)) : 0
    return { selection: end > start ? textSelection(raw, start, end) : null, sentence: itemsSentence('Line', 'Lines', lo, hi) }
  } })
  const ranges = useMemo<TextRange[]>(() => {
    const r = textRanges(notes, raw.length, textAnchorRange)
    if (same) return r
    return r
      .map((x) => ({ ...x, start: mapStartByNonWhitespace(raw, display, x.start), end: mapEndByNonWhitespace(raw, display, x.end) }))
      .filter((x) => x.end > x.start)
  }, [notes, raw, display, same])
  useTextSelection(ref, (root) => {
    const s = selectedOffsets(root)
    if (!s) return null
    const start = same ? s.start : mapStartByNonWhitespace(display, raw, s.start)
    const end = same ? s.end : mapEndByNonWhitespace(display, raw, s.end)
    return end > start ? textSelection(raw, start, end) : null
  })
  useScrollToShown(ref, findNoted, ranges)
  return (
    <pre ref={ref} className="output-scroll output-pre" data-testid={testId} role="group" aria-label={`${title} ${what}`} tabIndex={0} onKeyDown={cursor.onKeyDown}>
      {lines.map((line, i) => <span data-line="" key={i}><MarkedText text={display.slice(line.start, line.end)} ranges={ranges.filter((r) => r.start < line.end && r.end > line.start).map((r) => ({ ...r, start: Math.max(0, r.start - line.start), end: Math.min(line.end - line.start, r.end - line.start) }))} />{i < lines.length - 1 ? '\n' : ''}</span>)}
    </pre>
  )
}

function CsvTable({ rows, more, title }: { rows: string[][]; more: boolean; title: string }): ReactElement {
  const cols = rows.reduce((n, r) => Math.max(n, r.length), 0)
  const [head, ...body] = rows
  const grid = useGridNotes('', rows.length, cols, (r, c) => rows[r]?.[c] ?? '')
  const scroller = useRef<HTMLDivElement>(null)
  useScrollToShown(scroller, findNoted, grid.noted)
  const cell = (r: number, c: number): Record<string, unknown> => {
    const nc = grid.noted.get(`${r},${c}`)
    return {
      id: grid.cellId(r, c),
      'aria-selected': grid.range ? inRange(grid.range, r, c) : false,
      'data-note-state': nc?.state,
      'data-notes': nc?.ids.join(' '),
      'aria-description': nc ? `Note: ${nc.text}` : undefined,
      onMouseDown: (e: React.MouseEvent) => {
        if (e.shiftKey) e.preventDefault()
      },
      onClick: (e: React.MouseEvent) => {
        if (window.getSelection()?.toString()) return
        grid.choose(r, c, e.shiftKey)
      }
    }
  }
  return (
    <>
      <div ref={scroller} className="output-scroll output-sheet-region" role="group" aria-label={`${title} table`} tabIndex={0} onKeyDown={grid.onKeyDown} aria-activedescendant={grid.cur ? grid.cellId(grid.cur.r, grid.cur.c) : undefined}>
        <table className="output-sheet-table output-csv-table" data-testid="output-csv-table" role="grid" aria-readonly="true" aria-multiselectable="true">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr>
              {Array.from({ length: cols }, (_, c) => (
                <th key={c} scope="col" {...cell(0, c)}>
                  {head[c] ?? ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((r, i) => (
              <tr key={i}>
                {Array.from({ length: cols }, (_, c) => (
                  <td key={c} {...cell(i + 1, c)}>
                    {r[c] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more && (
        <p className="output-preview-note" data-testid="output-sheet-more-rows">
          More rows not shown.
        </p>
      )}
    </>
  )
}

/** Marks for the rendered Markdown without touching its tree: the CSS Highlight API over the notes' quotes. */
function useRenderedMarks(rootRef: React.RefObject<HTMLElement | null>, text: string): void {
  const notes = useViewedNotes()
  const shown = useOutputDetail()?.shownNote ?? null
  const byId = useRef(new Map<string, Range>())
  const scrolled = useRef<string | null>(null)
  useEffect(() => {
    byId.current = new Map()
    const root = rootRef.current
    const api = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
    const Hl = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight
    if (!root || !api || !Hl) return undefined
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const nodes: { t: Text; start: number }[] = []
    let all = ''
    for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
      nodes.push({ t, start: all.length })
      all += t.data
    }
    const point = (pos: number, end: boolean): [Text, number] | null => {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i]
        if (pos > n.start || (pos === n.start && !end)) return [n.t, Math.min(n.t.data.length, pos - n.start)]
        if (pos === n.start && end && i === 0) return [n.t, 0]
      }
      return null
    }
    const open: Range[] = []
    const done: Range[] = []
    for (const n of notes) {
      const a = n.anchor
      if (a.type !== 'text') continue
      const quote = text
        .slice(a.start, a.end)
        .replace(/[*_`#>[\]()]/g, '')
      const hit = findQuote(all, quote)
      if (!hit) continue
      const s = point(hit.start, false)
      const e = point(hit.end, true)
      if (!s || !e) continue
      const r = document.createRange()
      try {
        r.setStart(s[0], s[1])
        r.setEnd(e[0], e[1])
      } catch {
        continue
      }
      byId.current.set(n.id, r)
      ;(n.status === 'resolved' ? done : open).push(r)
    }
    if (!shown) scrolled.current = null
    else if (scrolled.current !== shown) {
      const target = byId.current.get(shown)
      if (target) {
        scrolled.current = shown
        scrollWithin(target.startContainer.parentElement, 'center')
      }
    }
    if (open.length) api.set('output-note-open', new Hl(...open))
    if (done.length) api.set('output-note-resolved', new Hl(...done))
    return () => {
      api.delete('output-note-open')
      api.delete('output-note-resolved')
    }
  }, [notes, text, rootRef, shown])
}

function RenderedMarkdown({ text, title }: { text: string; title: string }): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const selector = ':scope > .md > *'
  const cursor = useBlockCursor({ rootRef: ref, itemSelector: selector, resetKey: text, select: (lo, hi) => {
    const texts = Array.from(ref.current?.querySelectorAll<HTMLElement>(selector) ?? [], (el) => el.textContent ?? '')
    const r = renderedBlocksRange(text, texts, lo, hi)
    return { selection: r ? textSelection(text, r.start, r.end) : null, sentence: itemsSentence('Block', 'Blocks', lo, hi) }
  } })
  useRenderedMarks(ref, text)
  useTextSelection(ref, () => {
    const sel = window.getSelection()?.toString() ?? ''
    const r = mapRenderedToSource(text, sel)
    return r && r.end > r.start ? textSelection(text, r.start, r.end) : null
  })
  return (
    <div ref={ref} className="output-scroll output-md" data-testid="output-md-rendered" role="group" aria-label={`${title} text`} tabIndex={0} onKeyDown={cursor.onKeyDown}>
      <Markdown text={text} />
    </div>
  )
}

/** Markdown, CSV, JSON, plain text and Mermaid source, by the output's kind. */
export default function TextPreview({ kind, text, truncated, title }: { kind: OutputKind; text: string; truncated?: boolean; title: string }): ReactElement {
  const [mdView, setMdView] = useState<MdView>('rendered')
  const csv = useMemo(() => (kind === 'csv' ? parseCsv(text) : null), [kind, text])
  const json = useMemo(() => (kind === 'json' ? prettyJson(text) : null), [kind, text])

  if (kind === 'mermaid') {
    return (
      <Suspense
        fallback={
          <p className="output-preview-note" role="status">
            Loading preview…
          </p>
        }
      >
        <MermaidView text={text} title={title} truncated={truncated} />
      </Suspense>
    )
  }

  let body: ReactElement
  if (kind === 'markdown') {
    body = (
      <>
        <div className="output-toolbar" data-testid="output-md-view">
          <SegmentedControl<MdView>
            label="View"
            value={mdView}
            onChange={setMdView}
            options={[
              { value: 'rendered', label: 'Rendered' },
              { value: 'source', label: 'Source' }
            ]}
          />
        </div>
        {mdView === 'rendered' ? <RenderedMarkdown text={text} title={title} /> : <Pre display={text} raw={text} title={title} testId="output-source" what="source" />}
      </>
    )
  } else if (kind === 'csv' && csv) {
    body = <CsvTable rows={csv.rows} more={csv.more} title={title} />
  } else if (kind === 'json' && json !== null) {
    body = <Pre display={json} raw={text} title={title} testId="output-text" what="text" />
  } else {
    body = <Pre display={text} raw={text} title={title} testId="output-text" what="text" />
  }

  return (
    <div className="output-text" data-testid="output-text-view" data-kind={kind}>
      {body}
      {truncated && (
        <p className="output-preview-note" data-testid="output-text-truncated">
          The preview stops here. Open the file to read the rest.
        </p>
      )}
    </div>
  )
}
