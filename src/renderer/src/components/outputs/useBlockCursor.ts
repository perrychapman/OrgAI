// A keyboard cursor over the lines or blocks of a text region (docs/design/outputs-2.md 11.2). Chromium gives a non-editable
// region no caret, so Shift+arrows cannot select text there; this hook is the keyboard path: Up / Down / PageUp / PageDown /
// Home / End move an active item, Shift extends a range, Esc lets go. The region stays one Tab stop and names the active item
// through aria-activedescendant; items carry `data-cursor="active" | "in"` (styled in outputs-notes.css with a fill, a leading
// bar and a ring, so the range never rests on colour alone). Every move sets ctx.setSelection and speaks one short sentence
// (debounced). The DOM is touched imperatively: the items belong to React (lines) or to Markdown, and only attributes are added.
import type { KeyboardEvent, RefObject } from 'react'
import { useCallback, useEffect, useId, useRef } from 'react'
import { moveCursor } from '../../lib/outputNotes'
import { scrollWithin } from '../../lib/scrollWithin'
import { useOutputDetail, type OutputSelection } from './outputDetailContext'

export const CURSOR_ANNOUNCE_MS = 300
const PAGE_ITEMS = 10

export interface BlockCursorOptions {
  rootRef: RefObject<HTMLElement | null>
  /** CSS selector of the items inside the root, in reading order. */
  itemSelector: string
  /** The selection and the sentence to speak for items lo..hi (0-based, lo <= hi). */
  select(lo: number, hi: number): { selection: OutputSelection | null; sentence: string }
  /** Whether Shift+arrow may extend the range from item `anchor` to item `next` (default: always). */
  canExtend?(anchor: number, next: number): boolean
  /** The cursor lets go when this changes (the text or the blocks were replaced). */
  resetKey: unknown
}

const OWN_TYPES = ['text', 'block']

export function useBlockCursor(opts: BlockCursorOptions): { onKeyDown(e: KeyboardEvent<HTMLElement>): void } {
  const ctx = useOutputDetail()
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const optsRef = useRef(opts)
  optsRef.current = opts
  const idBase = `cur-${useId().replace(/:/g, '')}`
  const state = useRef<{ cur: number; anc: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pushed = useRef(false)
  const prevSel = useRef(ctx?.selection ?? null)

  const items = (): HTMLElement[] => {
    const root = optsRef.current.rootRef.current
    return root ? Array.from(root.querySelectorAll<HTMLElement>(optsRef.current.itemSelector)) : []
  }

  /** Remove the cursor's marks from the DOM and forget it (does not touch ctx.selection). */
  const clearMarks = useCallback((): void => {
    const root = optsRef.current.rootRef.current
    state.current = null
    pushed.current = false
    if (timer.current) clearTimeout(timer.current)
    if (!root) return
    root.removeAttribute('aria-activedescendant')
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-cursor]'))) el.removeAttribute('data-cursor')
  }, [])

  const paint = (list: HTMLElement[], lo: number, hi: number, cur: number): void => {
    const root = optsRef.current.rootRef.current
    list.forEach((el, i) => {
      if (!el.id || el.id.startsWith(idBase)) el.id = `${idBase}-${i}`
      if (i === cur) el.setAttribute('data-cursor', 'active')
      else if (i >= lo && i <= hi) el.setAttribute('data-cursor', 'in')
      else el.removeAttribute('data-cursor')
    })
    if (root && list[cur]) root.setAttribute('aria-activedescendant', list[cur].id)
  }

  const speak = (text: string): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => ctxRef.current?.announce(text), CURSOR_ANNOUNCE_MS)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return
    const c = ctxRef.current
    if (e.key === 'Escape') {
      if (!state.current) return
      e.preventDefault()
      e.stopPropagation()
      const had = pushed.current
      clearMarks()
      if (had && c?.selection && OWN_TYPES.includes(c.selection.anchor.type)) c.setSelection(null)
      return
    }
    const list = items()
    if (!list.length || !c) return
    const next = moveCursor(e.key, state.current?.cur ?? null, list.length, PAGE_ITEMS)
    if (next === null) return
    e.preventDefault()
    const prev = state.current
    const extend = e.shiftKey && prev !== null && (optsRef.current.canExtend?.(prev.anc, next) ?? true)
    const anc = extend && prev ? prev.anc : next
    state.current = { cur: next, anc }
    const lo = Math.min(anc, next)
    const hi = Math.max(anc, next)
    paint(list, lo, hi, next)
    scrollWithin(list[next], 'nearest')
    // A mouse selection left in the region would be re-read on the next selectionchange: drop it.
    window.getSelection()?.removeAllRanges()
    const { selection, sentence } = optsRef.current.select(lo, hi)
    if (selection) {
      pushed.current = true
      c.setSelection(selection)
    } else {
      pushed.current = false
      if (c.selection && OWN_TYPES.includes(c.selection.anchor.type)) c.setSelection(null)
    }
    speak(selection ? sentence : `${sentence.replace(/ selected$/, '')}, nothing to select`)
  }

  // A mouse selection in the region takes over from the cursor.
  useEffect(() => {
    const on = (): void => {
      const root = optsRef.current.rootRef.current
      if (!root || !state.current) return
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return
      if (root.contains(sel.anchorNode) || root.contains(sel.focusNode)) clearMarks()
    }
    document.addEventListener('selectionchange', on)
    return () => document.removeEventListener('selectionchange', on)
  }, [clearMarks])

  // The composer clears the selection after a note is added: the cursor lets go too.
  const sel = ctx?.selection ?? null
  useEffect(() => {
    if (prevSel.current !== null && sel === null && state.current && pushed.current) clearMarks()
    prevSel.current = sel
  }, [sel, clearMarks])

  // New text or blocks: nothing the cursor pointed at is still there.
  useEffect(() => {
    clearMarks()
    return clearMarks
  }, [opts.resetKey, clearMarks])

  return { onKeyDown }
}
