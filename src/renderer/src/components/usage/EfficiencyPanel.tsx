import type { CSSProperties, ReactElement } from 'react'
import { useId, useMemo, useRef, useState } from 'react'
import { connectionLabel } from '../../lib/connectionLabel'
import {
  efficiencyByProject,
  efficiencyMeasures,
  sortEfficiencyRows,
  sortedByText,
  type EfficiencyColumn,
  type EfficiencyMeasure,
  type SortDir
} from '../../lib/usageEfficiency'
import { useRovingFocus } from '../connectors/useRovingFocus'
import DefinedTerm from './DefinedTerm'
import type { UsagePanelProps, WastefulSort } from './panelProps'
import { SortTh, TableWrap } from './usageTableParts'

export interface EfficiencyPanelProps extends UsagePanelProps {
  /** A measure's value was pressed: sort "Runs worth a look" by `sort` and move focus to its heading (6.5). */
  onPickSignal: (sort: WastefulSort) => void
  /** Reading-order slot (0-5) in the page's arrival stagger. */
  band?: number
}

const COLUMNS: { col: EfficiencyColumn; label: string; num: boolean }[] = [
  { col: 'project', label: 'Project', num: false },
  { col: 'runs', label: 'Runs', num: true },
  { col: 'cost', label: 'Cost per run', num: true },
  { col: 'cache', label: 'Cache hit', num: true },
  { col: 'tokens-per-turn', label: 'Tokens per turn', num: true },
  { col: 'retries', label: 'Retries per 100 turns', num: true },
  { col: 'no-result', label: 'No-result share', num: true },
  { col: 'idle', label: 'Idle share', num: true }
]

function Measure({ m, index, onPick }: { m: EfficiencyMeasure; index: number; onPick: (m: EfficiencyMeasure) => void }): ReactElement {
  const id = useId()
  return (
    <li className="usage-eff-item" data-testid="usage-eff-item" data-signal={m.key} data-value={m.value ?? ''}>
      <span id={`${id}-n`} className="usage-eff-label">
        <DefinedTerm text={m.definition} align={index >= 2 ? 'end' : 'start'} testId="usage-eff-term">
          {m.label}
        </DefinedTerm>
      </span>
      {m.value === null ? (
        <span className="usage-eff-value usage-eff-none" data-testid="usage-eff-value" data-enough="false">
          Not enough runs yet
        </span>
      ) : m.sort ? (
        <button
          type="button"
          className="usage-eff-value"
          data-testid="usage-eff-value"
          aria-labelledby={`${id}-n ${id}-v`}
          aria-describedby={`${id}-d`}
          onClick={() => onPick(m)}
        >
          <span id={`${id}-v`}>{m.value}</span>
        </button>
      ) : (
        <span className="usage-eff-value" data-testid="usage-eff-value" data-static="true">
          {m.value}
        </span>
      )}
      <p id={`${id}-d`} className="usage-eff-read" data-testid="usage-eff-reading" title={m.basis}>
        {m.reading}
      </p>
    </li>
  )
}

/** Efficiency: exactly four measures, each with a value and a plain reading; the other signals are reasons in Runs worth a look. */
export default function EfficiencyPanel({ data, onPickSignal, announce, arriving, band = 2 }: EfficiencyPanelProps): ReactElement {
  const opts = useMemo(() => ({ connectionName: (id: string) => connectionLabel(id), trend: data.trend }), [data.trend])
  const measures = useMemo(() => efficiencyMeasures(data.rows), [data.rows])
  const byProject = useMemo(() => efficiencyByProject(data.rows, opts), [data.rows, opts])
  const [sort, setSort] = useState<{ col: EfficiencyColumn; dir: SortDir }>({ col: 'runs', dir: 'desc' })
  const table = useMemo(() => sortEfficiencyRows(byProject, sort.col, sort.dir), [byProject, sort])

  const groupRef = useRef<HTMLUListElement>(null)
  const roving = useRovingFocus(groupRef, '.usage-term, button.usage-eff-value')

  const pick = (m: EfficiencyMeasure): void => {
    if (!m.sort) return
    onPickSignal(m.sort)
    announce(sortedByText(m.sort))
  }
  const onSort = (col: EfficiencyColumn): void => setSort((s) => (s.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: col === 'project' ? 'asc' : 'desc' }))

  return (
    <section
      className={`usage-panel${arriving ? ' motion-arrive-band' : ''}`}
      id="usage-efficiency"
      aria-labelledby="usage-efficiency-h"
      data-testid="usage-efficiency"
      style={{ '--i': band } as CSSProperties}
    >
      <div className="usage-panel-head">
        <h2 id="usage-efficiency-h" tabIndex={-1}>
          Efficiency
        </h2>
      </div>
      {data.rows.length === 0 ? (
        <p className="usage-note">No runs in this view.</p>
      ) : (
        <ul
          ref={groupRef}
          className="usage-eff-grid"
          data-testid="usage-eff-main"
          aria-label="Efficiency measures. Arrow keys move between them; press a value to sort Runs worth a look by it."
          onKeyDown={roving.onKeyDown}
          onFocus={roving.onFocus}
        >
          {measures.map((m, i) => (
            <Measure key={m.key} m={m} index={i} onPick={pick} />
          ))}
        </ul>
      )}
      {byProject.length > 0 && (
        <details className="usage-table-details" data-testid="usage-eff-table-details">
          <summary>Show as table</summary>
          <TableWrap label="Efficiency by project">
            <table className="usage-tbl" data-testid="usage-eff-table">
              <caption>Efficiency by project</caption>
              <thead>
                <tr>
                  {COLUMNS.map((c) => (
                    <SortTh key={c.col} label={c.label} col={c.col} active={sort.col} dir={sort.dir} onSort={onSort} num={c.num} sticky={c.col === 'project'} />
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.map((r) => (
                  <tr key={r.projectId} data-project={r.projectId}>
                    <th scope="row" className="sticky" title={r.project}>
                      <span className="usage-clip">{r.project}</span>
                      {r.removed && <span className="usage-cell-sub">Project removed</span>}
                    </th>
                    <td className="num">{r.cells.runs}</td>
                    <td className="num">{r.cells.cost}</td>
                    <td className="num">{r.cells.cache}</td>
                    <td className="num">{r.cells['tokens-per-turn']}</td>
                    <td className="num">{r.cells.retries}</td>
                    <td className="num">{r.cells['no-result']}</td>
                    <td className="num">{r.cells.idle}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </details>
      )}
    </section>
  )
}
