import type { ReactElement, ReactNode } from 'react'
import { useMemo, useRef } from 'react'
import type { DocumentBlock, DocumentRun } from '@shared/types'
import { spoofHost } from '../Markdown'
import { isSafeImageDataUrl, safeDocHref } from '../../lib/outputPreview'
import { anchorDescription, blockPartOffsets, blockText, docItems, docItemsRange, quoteOf, segmentsOf, type TextRange } from '../../lib/outputNotes'
import { NoteMark, findNoted, useScrollToShown, useTextSelection, useViewedNotes } from './NoteMarks'
import { useBlockCursor } from './useBlockCursor'

/** A heading's level shifted down so the document never competes with the detail's own headings: h1 -> h4, capped at h6. */
export function docHeadingTag(level: number): 'h4' | 'h5' | 'h6' {
  const n = Math.min(Math.max(Math.round(level) + 3, 4), 6)
  return `h${n}` as 'h4' | 'h5' | 'h6'
}

/** The runs of one part of a block; `base` is where the part starts in blockText and `ranges` are the block's note ranges. */
function Runs({ runs, base = 0, ranges }: { runs: readonly DocumentRun[]; base?: number; ranges?: readonly TextRange[] }): ReactElement {
  let at = base
  return (
    <>
      {runs.map((r, i) => {
        const from = at
        at += r.text.length
        let node: ReactNode = r.text
        const hit = ranges?.filter((x) => x.start < at && x.end > from)
        if (hit && hit.length) {
          const local = hit.map((x) => ({ ...x, start: Math.max(0, x.start - from), end: Math.min(r.text.length, x.end - from) }))
          node = segmentsOf(r.text.length, local).map((s) => {
            const piece = r.text.slice(s.start, s.end)
            return s.notes.length ? (
              <NoteMark key={s.start} notes={s.notes}>
                {piece}
              </NoteMark>
            ) : (
              piece
            )
          })
        }
        if (r.code) node = <code>{node}</code>
        if (r.strike) node = <s>{node}</s>
        if (r.underline) node = <u>{node}</u>
        if (r.italic) node = <em>{node}</em>
        if (r.bold) node = <strong>{node}</strong>
        const href = r.href ? safeDocHref(r.href) : null
        if (href) {
          node = (
            <a href={href} title={href} target="_blank" rel="noreferrer noopener">
              {node}
              {spoofHost(href, r.text) && <span className="md-link-host" data-nooff=""> ({spoofHost(href, r.text)})</span>}
            </a>
          )
        }
        return <span key={i}>{node}</span>
      })}
    </>
  )
}

function Block({ block, ranges }: { block: DocumentBlock; ranges: readonly TextRange[] }): ReactElement | null {
  switch (block.type) {
    case 'heading': {
      const Tag = docHeadingTag(block.level)
      return (
        <Tag className="output-doc-heading">
          <Runs runs={block.runs} ranges={ranges} />
        </Tag>
      )
    }
    case 'paragraph':
      return (
        <p>
          <Runs runs={block.runs} ranges={ranges} />
        </p>
      )
    case 'list': {
      const Tag = block.ordered ? 'ol' : 'ul'
      const offs = blockPartOffsets(block)
      return (
        <Tag>
          {block.items.map((item, i) => (
            <li key={i} data-doc-item="">
              <Runs runs={item} base={offs[i]} ranges={ranges} />
            </li>
          ))}
        </Tag>
      )
    }
    case 'table': {
      const head = Math.max(0, Math.min(block.headerRows ?? 0, block.rows.length))
      const offs = blockPartOffsets(block)
      const rowStart: number[] = []
      let n = 0
      for (const row of block.rows) {
        rowStart.push(n)
        n += row.length
      }
      const cell = (row: DocumentRun[][], r: number, th: boolean): ReactElement[] =>
        row.map((c, j) =>
          th ? (
            <th key={j} scope="col" data-doc-item="">
              <Runs runs={c} base={offs[rowStart[r] + j]} ranges={ranges} />
            </th>
          ) : (
            <td key={`${r}-${j}`} data-doc-item="">
              <Runs runs={c} base={offs[rowStart[r] + j]} ranges={ranges} />
            </td>
          )
        )
      return (
        <div className="output-doc-table-wrap">
          <table className="output-doc-table">
            {head > 0 && (
              <thead>
                {block.rows.slice(0, head).map((row, r) => (
                  <tr key={r}>{cell(row, r, true)}</tr>
                ))}
              </thead>
            )}
            <tbody>
              {block.rows.slice(head).map((row, r) => (
                <tr key={r}>{cell(row, head + r, false)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
    case 'image':
      return isSafeImageDataUrl(block.dataUrl) ? <img className="output-doc-image" src={block.dataUrl} alt={block.alt} /> : null
    case 'code': {
      const segs = ranges.length ? segmentsOf(block.text.length, ranges) : null
      return (
        <pre className="output-doc-code">
          <code>
            {segs
              ? segs.map((s) => (s.notes.length ? <NoteMark key={s.start} notes={s.notes}>{block.text.slice(s.start, s.end)}</NoteMark> : block.text.slice(s.start, s.end)))
              : block.text}
          </code>
        </pre>
      )
    }
    case 'rule':
      return <hr />
    case 'pageBreak':
      return (
        <div className="output-doc-pagebreak" role="separator" aria-label="Page break" data-testid="output-doc-pagebreak">
          <span aria-hidden="true">Page break</span>
        </div>
      )
    default:
      return null
  }
}

/** Offset of a DOM point inside one block's text, counting the separators blockText puts between items, cells and rows. */
function blockOffsetIn(el: Element, node: Node, offset: number): number {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  const boundary = node.nodeType === Node.TEXT_NODE ? null : document.createRange()
  boundary?.setStart(node, offset)
  let pos = 0
  let rows = 0
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (boundary && boundary.comparePoint(n, 0) >= 0) return pos
    if (n.nodeType === Node.ELEMENT_NODE) {
      const e = n as Element
      if (e.hasAttribute('data-nooff')) {
        // Skip the helper's own text: jump past it.
        continue
      }
      if (e.tagName === 'LI' && e.previousElementSibling) pos += 1
      else if (e.tagName === 'TR' && rows++ > 0) pos += 1
      else if ((e.tagName === 'TD' || e.tagName === 'TH') && e.previousElementSibling) pos += 1
      continue
    }
    const t = n as Text
    if (t.parentElement?.closest('[data-nooff]')) continue
    if (t === node) return pos + Math.min(offset, t.data.length)
    pos += t.data.length
  }
  return pos
}

function blockOf(node: Node, root: Element): Element | null {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  const b = el?.closest('[data-block]') ?? null
  return b && root.contains(b) ? b : null
}

/** A simplified Word-style preview built from blocks (never HTML). */
export default function DocumentView({ blocks, truncated, title }: { blocks: DocumentBlock[]; truncated?: boolean; title: string }): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const items = useMemo(() => docItems(blocks), [blocks])
  const cursor = useBlockCursor({ rootRef: ref, itemSelector: '[data-doc-item]', resetKey: blocks,
    canExtend: (a, b) => items[a]?.block === items[b]?.block,
    select: (lo, hi) => {
      const r = docItemsRange(items, lo, hi)
      const anchor = r ? { type: 'block' as const, ...r, quote: quoteOf(blockText(blocks[r.index]).slice(r.start, r.end)) } : null
      return { selection: anchor ? { anchor, description: anchorDescription(anchor) } : null, sentence: `${items[lo]?.label ?? 'Block'} selected` }
    }
  })
  const notes = useViewedNotes()
  const byBlock = useMemo(() => {
    const m = new Map<number, TextRange[]>()
    for (const n of notes) {
      const a = n.anchor
      if (a.type !== 'block' || a.index < 0 || a.index >= blocks.length) continue
      const len = blockText(blocks[a.index]).length
      const start = Math.max(0, Math.min(len, a.start))
      const end = Math.max(0, Math.min(len, a.end))
      if (end <= start) continue
      const list = m.get(a.index) ?? []
      list.push({ start, end, id: n.id, status: n.status })
      m.set(a.index, list)
    }
    return m
  }, [notes, blocks])

  useTextSelection(ref, (root) => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return null
    const r = sel.getRangeAt(0)
    const startEl = blockOf(r.startContainer, root) ?? blockOf(r.endContainer, root)
    if (!startEl) return null
    const index = Number(startEl.getAttribute('data-block'))
    const block = blocks[index]
    if (!block || block.type === 'image' || block.type === 'rule' || block.type === 'pageBreak') return null
    const text = blockText(block)
    const inStart = blockOf(r.startContainer, root) === startEl
    const endEl = blockOf(r.endContainer, root)
    const start = inStart ? blockOffsetIn(startEl, r.startContainer, r.startOffset) : 0
    const end = endEl === startEl ? blockOffsetIn(startEl, r.endContainer, r.endOffset) : text.length
    if (end <= start) return null
    const anchor = { type: 'block' as const, index, start, end, quote: quoteOf(text.slice(start, end)) }
    return { anchor, description: anchorDescription(anchor) }
  })
  useScrollToShown(ref, findNoted, byBlock)

  return (
    <div className="output-doc" data-testid="output-doc">
      <p className="output-preview-lead">Simplified preview. Open the file for the exact layout.</p>
      <div ref={ref} className="output-scroll output-doc-body" role="group" aria-label={`${title} text`} tabIndex={0} onKeyDown={cursor.onKeyDown}>
        {blocks.map((b, i) => (
          <div key={i} className="output-doc-block" data-block={i} data-doc-item={b.type === 'heading' || b.type === 'paragraph' || b.type === 'code' ? '' : undefined}>
            <Block block={b} ranges={byBlock.get(i) ?? []} />
          </div>
        ))}
        {truncated && (
          <p className="output-preview-note" data-testid="output-doc-truncated">
            The preview stops here. Open the file to read the rest.
          </p>
        )}
      </div>
    </div>
  )
}
