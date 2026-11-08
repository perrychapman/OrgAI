// Compare for Excel workbooks and CSV files: per-sheet tabs and a grid of the newer version with changed cells outlined and
// marked, removed rows put back, "+" / "-" in the row header. docs/design/outputs-2.md 12.2.
import type { ReactElement } from 'react'
import { useMemo, useRef, useState } from 'react'
import type { OutputDiff, RunOutput, SheetCell } from '@shared/types'
import { Switch } from '../ui/Switch'
import { Tabs } from '../ui/Tabs'
import { columnLetter } from '../../lib/outputPreview'
import { cellChangeText, gridChangeRows, gridOfCsv, mergeGrid, sheetNote, sheetStatusWord, visibleGridRows, type GridCell, type GridRow } from '../../lib/outputDiff'
import { ChangeNavBar, previewTextOf, useChangeNav, useVersionPreview, type VersionPreviewState } from './CompareParts'
import '../../styles/outputs-compare.css'

type CellsDiff = Extract<OutputDiff, { kind: 'cells' }>

export interface CompareCellsProps {
  output: RunOutput
  a: number
  b: number
  diff: CellsDiff
  announce(text: string): void
}

/** The rows of a named sheet of one version (xlsx sheets, or the one csv grid). */
function sheetRows(output: RunOutput, p: VersionPreviewState, name: string): SheetCell[][] | null {
  if (p.state !== 'ready') return null
  if (output.kind === 'csv') {
    const t = previewTextOf(p)
    return t === null ? null : gridOfCsv(t)
  }
  if (p.preview.kind !== 'sheets') return null
  return p.preview.sheets.find((s) => s.name === name)?.rows ?? []
}

const OP_GLYPH = { add: '+', del: '-', chg: '~' } as const
const OP_WORD = { add: 'added', del: 'removed', chg: 'changed' } as const

function Cell({ cell }: { cell: GridCell }): ReactElement {
  if (!cell.op) return <td>{cell.text}</td>
  const text = cellChangeText({ op: cell.op, was: cell.was ?? '', now: cell.text })
  return (
    <td className="compare-cell" data-op={cell.op} title={text} aria-description={text}>
      <span className="compare-cell-mark" aria-hidden="true">{OP_GLYPH[cell.op]}</span>
      <span className={cell.op === 'del' ? 'compare-cell-was' : undefined}>{cell.op === 'del' ? cell.was || cell.text : cell.text}</span>
      <span className="sr-only"> ({OP_WORD[cell.op]})</span>
    </td>
  )
}

function Row({ row, width, current, first }: { row: GridRow; width: number; current: boolean; first: number | undefined }): ReactElement {
  const word = row.op === 'add' ? 'Added row' : row.op === 'del' ? 'Removed row' : ''
  const cells: GridCell[] = row.cells.slice()
  while (cells.length < width) cells.push({ text: '' })
  return (
    <tr className="compare-grid-row" data-op={row.op} data-changed={row.changed ? 'true' : undefined} data-current={current ? 'true' : undefined} data-change-first={first}>
      <th scope="row" className="compare-rowhead">
        <span className="compare-glyph" aria-hidden="true">{row.op === 'add' ? '+' : row.op === 'del' ? '-' : ' '}</span>
        {word && <span className="sr-only">{word} </span>}
        {row.n}
      </th>
      {cells.map((c, i) => (
        <Cell key={i} cell={c} />
      ))}
    </tr>
  )
}

export default function CompareCells({ output, a, b, diff, announce }: CompareCellsProps): ReactElement {
  const firstChanged = Math.max(0, diff.sheets.findIndex((s) => s.status !== 'same'))
  const [sheetIdx, setSheetIdx] = useState(firstChanged)
  const [only, setOnly] = useState(true)
  const body = useRef<HTMLDivElement>(null)
  const sheet = diff.sheets[Math.min(sheetIdx, diff.sheets.length - 1)]
  const aPrev = useVersionPreview(output, a)
  const bPrev = useVersionPreview(output, b)
  const failed = aPrev.state === 'error' || bPrev.state === 'error'
  const aRows = sheet ? sheetRows(output, aPrev, sheet.name) : null
  const bRows = sheet ? sheetRows(output, bPrev, sheet.name) : null
  const grid = useMemo(() => (sheet && aRows && bRows && sheet.status !== 'added' && sheet.status !== 'removed' ? mergeGrid(sheet, aRows, bRows) : null), [sheet, aRows, bRows])
  const shown = useMemo(() => (grid ? visibleGridRows(grid, only) : null), [grid, only])
  const changeRows = useMemo(() => (shown ? gridChangeRows(shown) : []), [shown])
  const nav = useChangeNav(changeRows.length, body, announce)
  const width = useMemo(() => Math.max(0, ...(shown ?? []).map((r) => r.cells.length)), [shown])
  const note = sheet ? sheetNote(sheet) : null
  const tabName = (n: string): string => n || 'Data'
  return (
    <div className="compare-pane" data-testid="output-compare-cells" onKeyDown={nav.onKeyDown}>
      {diff.sheets.length > 1 && (
        <Tabs
          label="Sheets"
          idPrefix="output-compare-sheet"
          controls={false}
          compact
          value={String(sheetIdx)}
          onChange={(id) => setSheetIdx(Number(id))}
          tabs={diff.sheets.map((s, i) => {
            const word = sheetStatusWord(s)
            return { id: String(i), label: word ? `${tabName(s.name)} (${word})` : tabName(s.name), testId: 'output-compare-sheet-tab' }
          })}
        />
      )}
      <div className="compare-bar">
        <label className="compare-switch">
          <Switch checked={only} onChange={setOnly} label="Only rows with changes" testId="output-compare-only-changes" />
          <span aria-hidden="true">Only rows with changes</span>
        </label>
        <ChangeNavBar count={changeRows.length} nav={nav} />
      </div>
      {sheet?.truncated && <p className="compare-note">Only the first changes are shown. Open the file to see the rest.</p>}
      <div ref={body} className="compare-body compare-body-grid" data-testid="output-compare-body" role="region" tabIndex={0} aria-label={`Changes between version ${a} and version ${b}${sheet && diff.sheets.length > 1 ? ` on ${tabName(sheet.name)}` : ''}`}>
        {failed ? (
          <p className="compare-note">Could not load these versions to show their changes.</p>
        ) : note ? (
          <p className="compare-note">{note}</p>
        ) : !shown ? (
          <p className="compare-note">Loading...</p>
        ) : shown.length === 0 ? (
          <p className="compare-note">No changes.</p>
        ) : (
          <table className="compare-grid" data-testid="output-compare-grid">
            <thead>
              <tr>
                <th scope="col" className="compare-corner">
                  <span className="sr-only">Row</span>
                </th>
                {Array.from({ length: width }, (_, c) => (
                  <th key={c} scope="col">{columnLetter(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => {
                const idx = changeRows.indexOf(i)
                return <Row key={`${r.op}${r.n}`} row={r} width={width} current={idx >= 0 && idx === nav.index} first={idx >= 0 ? idx : undefined} />
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
