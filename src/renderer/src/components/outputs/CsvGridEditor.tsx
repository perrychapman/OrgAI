// The CSV cell grid (docs/design/outputs-2.md section 9, "CSV cell grid"): a keyboard-first role=grid with one Tab stop and a roving
// active cell, one reused input for editing, a range with Shift+arrows, add / delete row and column, a header switch and a
// bounded undo. Rows are windowed. The text is the source of truth: every change serializes back through lib/csvGrid.ts.
import type { KeyboardEvent, ReactElement } from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../ui/Button'
import { Switch } from '../ui/Switch'
import {
  CSV_FORMULA_NOTE,
  addColAt,
  addRowAt,
  cellName,
  columnName,
  deleteColAt,
  deleteRowAt,
  describeRange,
  hasFormulaCells,
  normalizeRange,
  notOfferedLine,
  parseCsv,
  rangeName,
  serializeCsv,
  setCell,
  undoBack,
  undoForward,
  undoPush,
  undoStart,
  type CsvModel,
  type UndoStack
} from '../../lib/csvGrid'
import { useOutputDetail } from './outputDetailContext'
import { TextAreaEditor } from './TextEditor'

/** One row's height in px; windowing and keyboard scrolling rely on it (set in outputs-edit.css as --grid-row-h). */
export const GRID_ROW_PX = 30
const WINDOW_MAX_ROWS = 200
const WINDOW_BUFFER = 10

interface Pos {
  r: number
  c: number
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

export interface CsvGridProps {
  text: string
  onChange(text: string): void
  title: string
  onAsText(): void
}

/** The grid itself. Mounts from `text` once; the caller remounts it (key) when the text is replaced from outside. */
export function CsvGrid({ text, onChange, title, onAsText }: CsvGridProps): ReactElement {
  const ctx = useOutputDetail()
  const parsed = useMemo(() => parseCsv(text), []) // eslint-disable-line react-hooks/exhaustive-deps
  const shape = useRef<Pick<CsvModel, 'eol' | 'trailingNewline'>>(parsed.ok ? { eol: parsed.model.eol, trailingNewline: parsed.model.trailingNewline } : { eol: '\n', trailingNewline: true })
  const [stack, setStack] = useState<UndoStack<string[][]>>(() => undoStart(parsed.ok ? parsed.model.rows : [['']]))
  const rows = stack.present
  const nRows = rows.length
  const nCols = rows[0]?.length ?? 1

  const [active, setActive] = useState<Pos>({ r: 0, c: 0 })
  const [anchor, setAnchor] = useState<Pos | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [header, setHeader] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(400)
  // The grid takes focus when it opens (the editor's focus rule).
  const wantFocus = useRef(true)
  const editingRef = useRef(editing)
  editingRef.current = editing

  const headRows = header ? 2 : 1
  const headH = headRows * GRID_ROW_PX
  const bodyStart = header ? 1 : 0

  useEffect(() => {
    const el = scroller.current
    if (!el) return undefined
    const read = (): void => setViewH(el.clientHeight || 400)
    read()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const commitRows = useCallback(
    (next: string[][]): void => {
      setStack((s) => undoPush(s, next))
      onChange(serializeCsv({ rows: next, ...shape.current }))
    },
    [onChange]
  )

  // ---- moving ----
  const scrollToRow = useCallback(
    (r: number): void => {
      const el = scroller.current
      if (!el) return
      const i = r - bodyStart
      if (i < 0) return
      let top = el.scrollTop
      if (i * GRID_ROW_PX < top) top = i * GRID_ROW_PX
      else if ((i + 1) * GRID_ROW_PX + headH > top + el.clientHeight) top = (i + 1) * GRID_ROW_PX + headH - el.clientHeight
      if (top !== el.scrollTop) {
        el.scrollTop = top
        setScrollTop(el.scrollTop)
      }
    },
    [bodyStart, headH]
  )
  const moveTo = useCallback(
    (p: Pos, extend: boolean): void => {
      const next = { r: clamp(p.r, 0, nRows - 1), c: clamp(p.c, 0, nCols - 1) }
      setAnchor((a) => (extend ? (a ?? active) : null))
      setActive(next)
      scrollToRow(next.r)
      wantFocus.current = true
    },
    [active, nRows, nCols, scrollToRow]
  )

  useLayoutEffect(() => {
    if (!wantFocus.current || editing !== null) return
    wantFocus.current = false
    scroller.current?.querySelector<HTMLElement>(`[data-r="${active.r}"][data-c="${active.c}"]`)?.focus({ preventScroll: true })
  })
  useEffect(() => {
    const el = inputRef.current
    if (editing === null || !el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [editing === null]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- editing ----
  const startEdit = (initial?: string): void => {
    setEditing(initial ?? rows[active.r][active.c])
  }
  const finishEdit = (commit: boolean, move?: Pos): void => {
    const value = editingRef.current
    if (value === null) return
    editingRef.current = null
    setEditing(null)
    wantFocus.current = true
    if (commit && value !== rows[active.r]?.[active.c]) commitRows(setCell(rows, active.r, active.c, value))
    if (move) moveTo(move, false)
  }

  // ---- range, selection report ----
  const range = normalizeRange(anchor ?? active, active)
  const multi = anchor !== null && (range.r1 !== range.r2 || range.c1 !== range.c2)
  const rangeKey = `${range.r1},${range.c1},${range.r2},${range.c2}`
  const setSelection = ctx?.setSelection
  useEffect(() => {
    if (!setSelection) return
    const quote = (rows[range.r1]?.[range.c1] ?? '').slice(0, 80)
    setSelection({ anchor: { type: 'cells', sheet: '', r1: range.r1, c1: range.c1, r2: range.r2, c2: range.c2, quote: quote || undefined }, description: describeRange(range) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setSelection, rangeKey])
  useEffect(() => () => setSelection?.(null), [setSelection])

  // ---- tools ----
  const announce = ctx?.announce
  const addRow = (): void => {
    const next = addRowAt(rows, active.r + 1)
    if (!next) return announce?.('This grid has the most rows it can have.')
    commitRows(next)
    moveTo({ r: active.r + 1, c: active.c }, false)
    announce?.(`Added row ${active.r + 2}.`)
  }
  const addCol = (): void => {
    const next = addColAt(rows, active.c + 1)
    if (!next) return announce?.('This grid has the most columns it can have.')
    commitRows(next)
    moveTo({ r: active.r, c: active.c + 1 }, false)
    announce?.(`Added column ${columnName(active.c + 1)}.`)
  }
  const delRow = (): void => {
    const next = deleteRowAt(rows, active.r)
    if (!next) return announce?.('The last row cannot be deleted.')
    commitRows(next)
    setAnchor(null)
    setActive({ r: Math.min(active.r, next.length - 1), c: active.c })
    announce?.(`Deleted row ${active.r + 1}. Undo brings it back.`)
    wantFocus.current = true
  }
  const delCol = (): void => {
    const next = deleteColAt(rows, active.c)
    if (!next) return announce?.('The last column cannot be deleted.')
    commitRows(next)
    setAnchor(null)
    setActive({ r: active.r, c: Math.min(active.c, (next[0]?.length ?? 1) - 1) })
    announce?.(`Deleted column ${columnName(active.c)}. Undo brings it back.`)
    wantFocus.current = true
  }
  const undo = (): void => {
    const s = undoBack(stack)
    if (s === stack) return
    setStack(s)
    onChange(serializeCsv({ rows: s.present, ...shape.current }))
    setActive((a) => ({ r: clamp(a.r, 0, s.present.length - 1), c: clamp(a.c, 0, (s.present[0]?.length ?? 1) - 1) }))
    announce?.('Undid the last change.')
  }
  const redo = (): void => {
    const s = undoForward(stack)
    if (s === stack) return
    setStack(s)
    onChange(serializeCsv({ rows: s.present, ...shape.current }))
    announce?.('Redid the change.')
  }
  const clearRange = (): void => {
    let next = rows
    for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) next = setCell(next, r, c, '')
    if (next !== rows) commitRows(next)
  }

  // ---- keys on the grid (the input handles its own) ----
  const onGridKey = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement) return
    const mod = e.ctrlKey || e.metaKey
    const page = Math.max(1, Math.floor((viewH - headH) / GRID_ROW_PX) - 1)
    const go = (r: number, c: number): void => {
      e.preventDefault()
      moveTo({ r, c }, e.shiftKey)
    }
    switch (e.key) {
      case 'ArrowDown':
        return go(active.r + 1, active.c)
      case 'ArrowUp':
        return go(active.r - 1, active.c)
      case 'ArrowRight':
        return go(active.r, active.c + 1)
      case 'ArrowLeft':
        return go(active.r, active.c - 1)
      case 'Home':
        return mod ? go(0, 0) : go(active.r, 0)
      case 'End':
        return mod ? go(nRows - 1, nCols - 1) : go(active.r, nCols - 1)
      case 'PageDown':
        return go(active.r + page, active.c)
      case 'PageUp':
        return go(active.r - page, active.c)
      case 'Enter':
      case 'F2':
        e.preventDefault()
        return startEdit()
      case 'Delete':
      case 'Backspace':
        e.preventDefault()
        return clearRange()
      default:
    }
    if (mod && !e.altKey && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      return e.shiftKey ? redo() : undo()
    }
    if (mod && !e.altKey && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      return redo()
    }
    if (e.key.length === 1 && !mod && !e.altKey) {
      e.preventDefault()
      startEdit(e.key)
    }
  }
  const onInputKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      finishEdit(true, { r: active.r + (e.shiftKey ? -1 : 1), c: active.c })
    } else if (e.key === 'Tab') {
      e.preventDefault()
      e.stopPropagation()
      finishEdit(true, { r: active.r, c: active.c + (e.shiftKey ? -1 : 1) })
    } else if (e.key === 'Escape') {
      // Esc closes the edit only; the dialog or panel around the grid keeps its own Esc.
      e.preventDefault()
      e.stopPropagation()
      finishEdit(false)
    }
  }

  // ---- windowing ----
  const bodyCount = nRows - bodyStart
  const first = clamp(Math.floor(scrollTop / GRID_ROW_PX) - WINDOW_BUFFER, 0, Math.max(0, bodyCount))
  const visible = Math.min(WINDOW_MAX_ROWS, Math.ceil(viewH / GRID_ROW_PX) + 2 * WINDOW_BUFFER)
  const last = Math.min(bodyCount, first + visible)
  const body: number[] = []
  for (let i = first; i < last; i++) body.push(i + bodyStart)
  const colIndexes = useMemo(() => Array.from({ length: nCols }, (_, i) => i), [nCols])

  const inRange = (r: number, c: number): boolean => r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2

  const cell = (r: number, c: number, tag: 'td' | 'th'): ReactElement => {
    const isActive = active.r === r && active.c === c
    const isEditing = isActive && editing !== null
    const Tag = tag
    return (
      <Tag
        key={c}
        role={tag === 'th' ? 'columnheader' : 'gridcell'}
        className="output-grid-cell"
        data-r={r}
        data-c={c}
        data-active={isActive ? 'true' : undefined}
        data-selected={multi && inRange(r, c) ? 'true' : undefined}
        aria-colindex={c + 2}
        aria-selected={multi ? inRange(r, c) : undefined}
        tabIndex={isActive && !isEditing ? 0 : -1}
        onMouseDown={(e) => {
          if (editingRef.current !== null && !(isActive && isEditing)) finishEdit(true)
          if (isActive && isEditing) return
          setAnchor((a) => (e.shiftKey ? (a ?? active) : null))
          setActive({ r, c })
        }}
        onMouseEnter={(e) => {
          if (e.buttons === 1 && editingRef.current === null) {
            setAnchor((a) => a ?? active)
            setActive({ r, c })
          }
        }}
        onDoubleClick={() => {
          setActive({ r, c })
          setEditing(rows[r][c])
        }}
      >
        {isEditing ? (
          <input
            ref={inputRef}
            className="output-grid-input"
            data-testid="output-grid-input"
            aria-label={`Edit ${cellName(r, c)}`}
            value={editing ?? ''}
            spellCheck={false}
            onChange={(e) => setEditing(e.target.value)}
            onKeyDown={onInputKey}
            onBlur={() => {
              if (editingRef.current !== null) finishEdit(true)
            }}
          />
        ) : (
          <span className="output-grid-text">{rows[r][c]}</span>
        )}
      </Tag>
    )
  }

  const row = (r: number, tag: 'td' | 'th'): ReactElement => (
    <tr key={r} aria-rowindex={r + 2} data-row={r} data-header={header && r === 0 ? 'true' : undefined}>
      <th scope="row" role="rowheader" className="output-grid-gutter">
        {r + 1}
      </th>
      {colIndexes.map((c) => cell(r, c, tag))}
    </tr>
  )

  return (
    <div className="output-grid" data-testid="output-grid">
      <div className="output-edit-tools output-grid-tools" role="group" aria-label="Grid tools" data-testid="output-grid-tools">
        <Button size="sm" testId="output-grid-add-row" onClick={addRow}>
          Add row
        </Button>
        <Button size="sm" testId="output-grid-add-col" onClick={addCol}>
          Add column
        </Button>
        <Button size="sm" testId="output-grid-del-row" inert={nRows <= 1} onClick={delRow}>
          Delete row
        </Button>
        <Button size="sm" testId="output-grid-del-col" inert={nCols <= 1} onClick={delCol}>
          Delete column
        </Button>
        <span className="output-grid-switch">
          <Switch checked={header} onChange={setHeader} label="First row is a header" testId="output-grid-header" />
          <span aria-hidden="true">First row is a header</span>
        </span>
        <Button size="sm" variant="ghost" testId="output-grid-undo" inert={stack.past.length === 0} title="Undo (Ctrl+Z)" onClick={undo}>
          Undo
        </Button>
        <Button size="sm" variant="ghost" testId="output-grid-redo" inert={stack.future.length === 0} title="Redo (Ctrl+Y)" onClick={redo}>
          Redo
        </Button>
        <Button size="sm" variant="ghost" testId="output-csv-as-text" onClick={onAsText}>
          Edit as text
        </Button>
      </div>
      <div
        ref={scroller}
        className="output-grid-scroll"
        data-testid="output-grid-scroll"
        // The scroll region is the Tab stop only while the active cell is scrolled out of the window.
        tabIndex={active.r >= bodyStart && (active.r - bodyStart < first || active.r - bodyStart >= last) ? 0 : -1}
        onFocus={(e) => {
          if (e.target === e.currentTarget) {
            scrollToRow(active.r)
            wantFocus.current = true
            setActive({ ...active })
          }
        }}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onKeyDown={onGridKey}
      >
        <table
          className="output-grid-table"
          role="grid"
          data-testid="output-grid-editor"
          aria-label={`${title} cells`}
          aria-rowcount={nRows + 1}
          aria-colcount={nCols + 1}
          aria-multiselectable="true"
          data-header={header ? 'true' : undefined}
          data-rows={nRows}
          data-cols={nCols}
        >
          <thead>
            <tr aria-rowindex={1} className="output-grid-letters">
              <th scope="col" role="columnheader" aria-colindex={1} className="output-grid-corner">
                <span className="sr-only">Row</span>
              </th>
              {colIndexes.map((c) => (
                <th key={c} scope="col" role="columnheader" aria-colindex={c + 2} className="output-grid-letter">
                  {columnName(c)}
                </th>
              ))}
            </tr>
            {header && row(0, 'th')}
          </thead>
          <tbody>
            {first > 0 && (
              <tr aria-hidden="true" className="output-grid-spacer" style={{ height: first * GRID_ROW_PX }}>
                <td colSpan={nCols + 1} />
              </tr>
            )}
            {body.map((r) => row(r, 'td'))}
            {last < bodyCount && (
              <tr aria-hidden="true" className="output-grid-spacer" style={{ height: (bodyCount - last) * GRID_ROW_PX }}>
                <td colSpan={nCols + 1} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="output-edit-status" data-testid="output-grid-status">
        {`${rangeName(range)} · ${nRows.toLocaleString('en-US')} rows, ${nCols} columns`}
      </p>
      {hasFormulaCells({ rows, ...shape.current }) && (
        <p className="output-edit-note" data-testid="output-grid-formula-note">
          {CSV_FORMULA_NOTE}
        </p>
      )}
    </div>
  )
}

/** The CSV editor: the grid when the file allows it, else (or on request) the text with its reason. */
export default function CsvEditor({ value, onChange, title }: { value: string; onChange(text: string): void; title: string }): ReactElement {
  const initial = useMemo(() => parseCsv(value), []) // eslint-disable-line react-hooks/exhaustive-deps
  const [asText, setAsText] = useState(!initial.ok)
  const [refusal, setRefusal] = useState(initial.ok ? '' : notOfferedLine(initial.reason))
  const [gridKey, setGridKey] = useState(0)
  const toGrid = (): void => {
    const p = parseCsv(value)
    if (!p.ok) {
      setRefusal(notOfferedLine(p.reason))
      return
    }
    setRefusal('')
    setGridKey((k) => k + 1)
    setAsText(false)
  }
  if (asText) {
    return (
      <div className="output-edit-csv-text">
        <div className="output-edit-tools" role="group" aria-label="CSV tools">
          {refusal && (
            <p className="output-edit-note" data-testid="output-csv-text-line">
              {refusal}
            </p>
          )}
          {initial.ok || parseCsv(value).ok ? (
            <Button size="sm" testId="output-csv-as-grid" onClick={toGrid}>
              Edit as grid
            </Button>
          ) : null}
        </div>
        <TextAreaEditor value={value} onChange={onChange} label={`${title} CSV text`} autoFocus />
      </div>
    )
  }
  return <CsvGrid key={gridKey} text={value} onChange={onChange} title={title} onAsText={() => setAsText(true)} />
}
