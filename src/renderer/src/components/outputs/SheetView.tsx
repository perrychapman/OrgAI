import type { KeyboardEvent, ReactElement } from 'react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { OutputNote, SheetPreview } from '@shared/types'
import { Tabs, tabDomId, panelDomId } from '../ui/Tabs'
import { columnLetter, formulaText, isNumericCell, sheetCellText } from '../../lib/outputPreview'
import { cellsAnchor, cellsDescription, inRange, normalizeRange, type CellRange } from '../../lib/outputNotes'
import { useOutputDetail } from './outputDetailContext'
import { findNoted, useScrollToShown, useViewedNotes } from './NoteMarks'

const CELLS_PER_NOTE_MAX = 4000

export interface NotedCell {
  state: 'open' | 'resolved'
  ids: string[]
  text: string
}

/** Cells of one sheet that carry notes (the viewed version's), keyed "r,c". Ranges past a sane size are cut. */
export function notedCells(notes: readonly OutputNote[], sheet: string): Map<string, NotedCell> {
  const out = new Map<string, NotedCell>()
  for (const n of notes) {
    const a = n.anchor
    if (a.type !== 'cells' || a.sheet !== sheet) continue
    let count = 0
    for (let r = a.r1; r <= a.r2 && count < CELLS_PER_NOTE_MAX; r++) {
      for (let c = a.c1; c <= a.c2 && count < CELLS_PER_NOTE_MAX; c++, count++) {
        const key = `${r},${c}`
        const prev = out.get(key)
        const open = n.status !== 'resolved'
        if (prev) {
          prev.ids.push(n.id)
          prev.text += ` ${n.text}`
          if (open) prev.state = 'open'
        } else out.set(key, { state: open ? 'open' : 'resolved', ids: [n.id], text: n.text })
      }
    }
  }
  return out
}

/**
 * Cell selection for a grid (a sheet or a csv): click, Shift+click, Shift+arrows (plain arrows move once a cell is chosen,
 * Esc clears). The range goes to ctx.setSelection as a `cells` anchor; noted cells come back for the corner marks.
 */
export function useGridNotes(sheetName: string, rowCount: number, colCount: number, textAt: (r: number, c: number) => string) {
  const ctx = useOutputDetail()
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const textRef = useRef(textAt)
  textRef.current = textAt
  const notes = useViewedNotes()
  const noted = useMemo(() => notedCells(notes, sheetName), [notes, sheetName])
  const [cur, setCur] = useState<{ r: number; c: number } | null>(null)
  const [anc, setAnc] = useState<{ r: number; c: number } | null>(null)
  const range: CellRange | null = cur && anc ? normalizeRange(anc, cur) : null
  const key = range ? `${range.r1},${range.c1},${range.r2},${range.c2}` : ''
  const pushed = useRef(false)
  const prevSel = useRef(ctx?.selection ?? null)

  useEffect(() => {
    const c = ctxRef.current
    if (!c) return
    if (range) {
      pushed.current = true
      c.setSelection({ anchor: cellsAnchor(sheetName, range, textRef.current(range.r1, range.c1)), description: cellsDescription(sheetName, range) })
    } else if (pushed.current) {
      pushed.current = false
      if (c.selection?.anchor.type === 'cells') c.setSelection(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, sheetName])

  // The composer clears the selection after a note is added: the grid lets go of its range too.
  const sel = ctx?.selection ?? null
  useEffect(() => {
    if (prevSel.current !== null && sel === null && pushed.current) {
      pushed.current = false
      setCur(null)
      setAnc(null)
    }
    prevSel.current = sel
  }, [sel])

  const choose = useCallback((r: number, c: number, extend: boolean): void => {
    setCur({ r, c })
    setAnc((a) => (extend && a ? a : { r, c }))
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return
    if (e.key === 'Escape' && cur) {
      e.preventDefault()
      e.stopPropagation()
      setCur(null)
      setAnc(null)
      return
    }
    const d = e.key === 'ArrowLeft' ? [0, -1] : e.key === 'ArrowRight' ? [0, 1] : e.key === 'ArrowUp' ? [-1, 0] : e.key === 'ArrowDown' ? [1, 0] : null
    if (!d || rowCount === 0 || colCount === 0 || (!cur && !e.shiftKey)) return
    e.preventDefault()
    const base = cur ?? { r: 0, c: 0 }
    const next = { r: Math.max(0, Math.min(rowCount - 1, base.r + d[0])), c: Math.max(0, Math.min(colCount - 1, base.c + d[1])) }
    setCur(next)
    setAnc(e.shiftKey ? (anc ?? base) : next)
  }

  return { range, noted, choose, onKeyDown }
}

function SheetTable({ sheet }: { sheet: SheetPreview }): ReactElement {
  const cols = sheet.rows.reduce((n, r) => Math.max(n, r.length), 0)
  const hasFormulaText = sheet.rows.some((row) => row.some((cell) => sheetCellText(cell).startsWith('=')))
  const grid = useGridNotes(sheet.name, sheet.rows.length, cols, (r, c) => sheetCellText(sheet.rows[r]?.[c]))
  const scroller = useRef<HTMLDivElement>(null)
  useScrollToShown(scroller, findNoted, grid.noted)
  return (
    <>
      {hasFormulaText ? (
        <p className="output-preview-note" data-testid="output-sheet-formula-note">
          Shown as text. OrgAI does not calculate formulas.
        </p>
      ) : null}
      <div ref={scroller} className="output-scroll output-sheet-region" role="region" aria-label={`${sheet.name} cells`} tabIndex={0} data-testid="output-sheet-region" onKeyDown={grid.onKeyDown}>
        <table className="output-sheet-table" data-testid="output-sheet-table" role="grid" aria-readonly="true" aria-multiselectable="true">
          <caption className="sr-only">{sheet.name}</caption>
          <thead>
            <tr>
              <td className="output-sheet-corner" aria-hidden="true" />
              {Array.from({ length: cols }, (_, c) => (
                <th key={c} scope="col">
                  {columnLetter(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((row, r) => (
              <tr key={r}>
                <th scope="row">{r + 1}</th>
                {Array.from({ length: cols }, (_, c) => {
                  const cell = row[c]
                  const text = sheetCellText(cell)
                  const nc = grid.noted.get(`${r},${c}`)
                  return (
                    <td
                      key={c}
                      data-num={isNumericCell(cell) ? '' : undefined}
                      title={cell?.f ? formulaText(cell.f) : undefined}
                      aria-selected={grid.range ? inRange(grid.range, r, c) : false}
                      data-note-state={nc?.state}
                      data-notes={nc?.ids.join(' ')}
                      aria-description={nc ? `Note: ${nc.text}` : undefined}
                      onMouseDown={(e) => {
                        if (e.shiftKey) e.preventDefault()
                      }}
                      onClick={(e) => {
                        if (window.getSelection()?.toString()) return
                        grid.choose(r, c, e.shiftKey)
                      }}
                    >
                      {text}
                      {cell?.f ? <span className="sr-only"> formula {formulaText(cell.f)}</span> : null}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sheet.truncatedRows ? (
        <p className="output-preview-note" data-testid="output-sheet-more-rows">
          More rows not shown.
        </p>
      ) : null}
      {sheet.truncatedCols ? (
        <p className="output-preview-note" data-testid="output-sheet-more-cols">
          {sheet.truncatedCols} more {sheet.truncatedCols === 1 ? 'column' : 'columns'} not shown.
        </p>
      ) : null}
    </>
  )
}

/** A workbook as real tables, one tab per sheet. */
export default function SheetView({ sheets, truncatedSheets }: { sheets: SheetPreview[]; truncatedSheets?: number }): ReactElement {
  const prefix = `output-sheets-${useId().replace(/:/g, '')}`
  const [picked, setPicked] = useState(0)
  const index = Math.min(picked, Math.max(0, sheets.length - 1))
  const sheet = sheets[index]
  const tabIds = sheets.map((_, i) => String(i))
  return (
    <div className="output-sheets" data-testid="output-sheets">
      {sheets.length > 1 && (
        <Tabs
          tabs={sheets.map((s, i) => ({ id: tabIds[i], label: s.name || `Sheet ${i + 1}`, testId: 'output-sheet-tab' }))}
          value={tabIds[index]}
          onChange={(id) => setPicked(Number(id))}
          label="Sheets"
          idPrefix={prefix}
          compact
        />
      )}
      {sheet ? (
        sheets.length > 1 ? (
          <div role="tabpanel" id={panelDomId(prefix, tabIds[index])} aria-labelledby={tabDomId(prefix, tabIds[index])} className="output-sheet-panel">
            <SheetTable key={index} sheet={sheet} />
          </div>
        ) : (
          <div className="output-sheet-panel">
            <SheetTable sheet={sheet} />
          </div>
        )
      ) : (
        <p className="output-preview-note">This workbook has no sheets.</p>
      )}
      {truncatedSheets ? (
        <p className="output-preview-note" data-testid="output-sheets-more">
          {truncatedSheets} more {truncatedSheets === 1 ? 'sheet' : 'sheets'} not shown.
        </p>
      ) : null}
    </div>
  )
}
