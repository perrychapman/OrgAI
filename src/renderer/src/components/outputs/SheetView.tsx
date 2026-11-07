import type { ReactElement } from 'react'
import { useState } from 'react'
import type { RunOutput, SheetPreview } from '@shared/types'
import { columnLetter, sheetCellText } from '../../lib/outputPreview'
import { Tabs, tabDomId, panelDomId } from '../ui/Tabs'

function SheetTable({ sheet }: { sheet: SheetPreview }): ReactElement {
  const cols = sheet.rows.reduce((m, r) => Math.max(m, r.length), 0)
  const moreCols = sheet.truncatedCols && sheet.truncatedCols > 0 ? sheet.truncatedCols : 0
  return (
    <>
      <div className="output-sheet-scroll" role="region" aria-label={`${sheet.name} cells`} tabIndex={0}>
        <table className="output-sheet-table" data-testid="output-sheet-table">
          <caption className="sr-only">{sheet.name}</caption>
          <thead>
            <tr>
              <td className="output-sheet-corner" />
              {Array.from({ length: cols }, (_, c) => (
                <th key={c} scope="col">
                  {columnLetter(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((r, i) => (
              <tr key={i}>
                <th scope="row">{i + 1}</th>
                {Array.from({ length: cols }, (_, c) => {
                  const cell = r[c]
                  if (!cell) return <td key={c} />
                  const numeric = typeof cell.v === 'number'
                  return (
                    <td key={c} className={numeric ? 'num' : undefined} title={cell.f ? `=${cell.f.replace(/^=/, '')}` : undefined}>
                      {sheetCellText(cell)}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sheet.truncatedRows !== undefined && sheet.truncatedRows > 0 && (
        <p className="output-preview-note" data-testid="output-sheet-more-rows">
          More rows not shown.
        </p>
      )}
      {moreCols > 0 && (
        <p className="output-preview-note" data-testid="output-sheet-more-cols">
          {moreCols} more {moreCols === 1 ? 'column' : 'columns'} not shown.
        </p>
      )}
    </>
  )
}

export default function SheetView({
  preview,
  output
}: {
  preview: { sheets: SheetPreview[]; truncatedSheets?: number }
  output: RunOutput
}): ReactElement {
  const [picked, setPicked] = useState(0)
  const idx = picked < preview.sheets.length ? picked : 0
  const sheet = preview.sheets[idx]
  const prefix = `output-sheets-${output.id}`
  const more = preview.truncatedSheets && preview.truncatedSheets > 0 ? preview.truncatedSheets : 0
  return (
    <div className="output-sheets" data-testid="output-sheets">
      {preview.sheets.length > 1 && (
        <Tabs
          compact
          label="Sheets"
          idPrefix={prefix}
          value={String(idx)}
          onChange={(id) => setPicked(Number(id))}
          tabs={preview.sheets.map((s, i) => ({ id: String(i), label: s.name || `Sheet ${i + 1}`, testId: 'output-sheet-tab' }))}
        />
      )}
      {sheet ? (
        preview.sheets.length > 1 ? (
          <div role="tabpanel" id={panelDomId(prefix, String(idx))} aria-labelledby={tabDomId(prefix, String(idx))} className="output-sheet-panel">
            <SheetTable sheet={sheet} />
          </div>
        ) : (
          <SheetTable sheet={sheet} />
        )
      ) : (
        <p className="output-preview-note">This workbook has no sheets.</p>
      )}
      {more > 0 && (
        <p className="output-preview-note" data-testid="output-sheets-more">
          {more} more {more === 1 ? 'sheet' : 'sheets'} not shown.
        </p>
      )}
    </div>
  )
}
