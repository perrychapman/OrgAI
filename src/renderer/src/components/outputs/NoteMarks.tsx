// Marks of the viewed version's notes over text, and the selection plumbing the text views share (docs/design/outputs-2.md
// 11.2): `mark.output-note-mark[data-note][data-status]` (open: soft fill + solid underline; resolved: dotted underline),
// a screen-reader "Note:" prefix, never a tab stop. A click selects the note in the panel (ctx.showNote).
import type { ReactElement, ReactNode, RefObject } from 'react'
import { Fragment, useEffect, useMemo, useRef } from 'react'
import type { OutputNote } from '@shared/types'
import { markStatus, segmentsOf, type TextRange } from '../../lib/outputNotes'
import { scrollWithin } from '../../lib/scrollWithin'
import { notesOfVersion, useOutputDetail, type OutputSelection } from './outputDetailContext'

/** The viewed version's notes (empty outside a detail or viewer). */
export function useViewedNotes(): OutputNote[] {
  const ctx = useOutputDetail()
  const notes = ctx?.notes ?? null
  const version = ctx?.version ?? 0
  return useMemo(() => notesOfVersion(notes, version), [notes, version])
}

/** One mark element around `children` for the notes covering a span. */
export function NoteMark({ notes, children }: { notes: readonly TextRange[]; children: ReactNode }): ReactElement {
  const ctx = useOutputDetail()
  const first = notes[0]
  const shown = ctx?.shownNote !== null && ctx?.shownNote !== undefined && notes.some((n) => n.id === ctx.shownNote)
  return (
    <mark
      className="output-note-mark"
      data-testid="output-note-mark"
      data-note={first.id}
      data-notes={notes.map((n) => n.id).join(' ')}
      data-status={markStatus(notes)}
      data-shown={shown ? 'true' : undefined}
      onClick={() => ctx?.showNote(first.id)}
    >
      <span className="sr-only" data-nooff="">
        Note:{' '}
      </span>
      {children}
    </mark>
  )
}

/** Text with marks over `ranges` (offsets into `text`). The characters stay one run per span so offsets keep adding up. */
export function MarkedText({ text, ranges }: { text: string; ranges: readonly TextRange[] }): ReactElement {
  if (!ranges.length) return <>{text}</>
  return (
    <>
      {segmentsOf(text.length, ranges).map((s) =>
        s.notes.length ? (
          <NoteMark key={s.start} notes={s.notes}>
            {text.slice(s.start, s.end)}
          </NoteMark>
        ) : (
          <Fragment key={s.start}>{text.slice(s.start, s.end)}</Fragment>
        )
      )}
    </>
  )
}

/** Character offset of a DOM point inside `root`'s text, leaving out `[data-nooff]` helper text. */
export function textOffsetIn(root: Element, node: Node, offset: number): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let acc = 0
  let boundary: Range | null = null
  if (node.nodeType !== Node.TEXT_NODE) {
    boundary = document.createRange()
    boundary.setStart(node, offset)
  }
  for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
    if (t.parentElement?.closest('[data-nooff]')) continue
    if (boundary) {
      if (boundary.comparePoint(t, 0) >= 0) return acc
    } else if (t === node) {
      return acc + Math.min(offset, t.data.length)
    }
    acc += t.data.length
  }
  return acc
}

/** The whole text length of `root` (helper text left out). */
export function textLengthOf(root: Element): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let n = 0
  for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) if (!t.parentElement?.closest('[data-nooff]')) n += t.data.length
  return n
}

/** The selected range's two offsets in `root`, or null when nothing in it is selected. A range reaching outside ends at the root's edge. */
export function selectedOffsets(root: Element): { start: number; end: number; text: string } | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
  const r = sel.getRangeAt(0)
  const inStart = root.contains(r.startContainer)
  const inEnd = root.contains(r.endContainer)
  if (!inStart && !inEnd) return null
  const start = inStart ? textOffsetIn(root, r.startContainer, r.startOffset) : 0
  const end = inEnd ? textOffsetIn(root, r.endContainer, r.endOffset) : textLengthOf(root)
  return end > start ? { start, end, text: sel.toString() } : null
}

/**
 * Turns the user's text selection inside `rootRef` into ctx.setSelection (through `compute`). A collapse inside the root
 * clears a text selection; a selection elsewhere (the composer, the panel) leaves it alone.
 */
export function useTextSelection(rootRef: RefObject<Element | null>, compute: (root: Element) => OutputSelection | null, ownTypes: readonly string[] = ['text', 'block']): void {
  const ctx = useOutputDetail()
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const computeRef = useRef(compute)
  computeRef.current = compute
  const typesRef = useRef(ownTypes)
  typesRef.current = ownTypes
  useEffect(() => {
    const on = (): void => {
      const root = rootRef.current
      const c = ctxRef.current
      if (!root || !c) return
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) return
      const r = sel.getRangeAt(0)
      if (!root.contains(r.commonAncestorContainer) && !(root.contains(r.startContainer) || root.contains(r.endContainer))) return
      if (sel.isCollapsed) {
        if (c.selection && typesRef.current.includes(c.selection.anchor.type)) c.setSelection(null)
        return
      }
      const next = computeRef.current(root)
      if (next) c.setSelection(next)
    }
    document.addEventListener('selectionchange', on)
    return () => document.removeEventListener('selectionchange', on)
  }, [rootRef])
}

/**
 * When Show in output names a note, scrolls the element carrying it into view (once per request) and calls `then` with it.
 * `selector` finds the element for a note id within the root.
 */
export function useScrollToShown(rootRef: RefObject<Element | null>, find: (root: Element, id: string) => Element | null, ready: unknown): void {
  const ctx = useOutputDetail()
  const shown = ctx?.shownNote ?? null
  const done = useRef<string | null>(null)
  useEffect(() => {
    if (!shown) {
      done.current = null
      return
    }
    if (done.current === shown) return
    const root = rootRef.current
    const el = root ? find(root, shown) : null
    if (!el) return
    done.current = shown
    scrollWithin(el, 'center')
  }, [shown, ready, rootRef, find])
}

/** Finds a mark or marked cell for a note id: elements list their ids in data-notes (space separated). */
export function findNoted(root: Element, id: string): Element | null {
  for (const el of Array.from(root.querySelectorAll('[data-notes]'))) {
    if ((el.getAttribute('data-notes') ?? '').split(' ').includes(id)) return el
  }
  return null
}
