import type { ReactElement } from 'react'
import { useId, useState } from 'react'
import type { SheetPreview } from '@shared/types'
import { Tabs, tabDomId, panelDomId } from '../ui/Tabs'
import { columnLetter, formulaText, isNumericCell, sheetCellText } from '../../lib/outputPreview'

function SheetTable({ sheet }: { sheet: SheetPreview }): ReactElement {
  const cols = sheet.rows.reduce((n, r) => Math.max(n, r.length), 0)
  return (
    <>
      <div className="output-scroll output-sheet-region" role="region" aria-label={`${sheet.name} cells`} tabIndex={0} data-testid="output-sheet-region">
        <table className="output-sheet-table" data-testid="output-sheet-table">
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
                  return (
                    <td key={c} data-num={isNumericCell(cell) ? '' : undefined} title={cell?.f ? formulaText(cell.f) : undefined}>
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
