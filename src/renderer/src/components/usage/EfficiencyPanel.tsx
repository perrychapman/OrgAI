import type { ReactElement } from 'react'
import { useId, useMemo, useRef, useState } from 'react'
import { Info } from 'lucide-react'
import { connectionLabel } from '../../lib/connectionLabel'
import { TRUNCATED_LIMIT_LABEL } from '../../lib/usagePage'
import {
  efficiencyByProject,
  efficiencyItems,
  efficiencySummary,
  minutesText,
  percentText,
  sortEfficiencyRows,
  sortedByText,
  type EfficiencyColumn,
  type EfficiencyDraw,
  type EfficiencyItem,
  type SortDir
} from '../../lib/usageEfficiency'
import { overlapText, reportTimingSummary, TIMING_DEFINITIONS } from '../../lib/usageStaffing'
import { useRovingFocus } from '../connectors/useRovingFocus'
import { Icon } from '../ui/Icon'
import { Popover } from '../ui/Popover'
import type { UsagePanelProps, WastefulSort } from './panelProps'
import { SortTh, TableWrap } from './usageTableParts'

export interface EfficiencyPanelProps extends UsagePanelProps {
  /** An instrument's value was pressed: sort "Runs worth a look" by `sort` and move focus to its heading (6.5). */
  onPickSignal: (sort: WastefulSort) => void
}

const SPARK_SLOTS = 14
const pct =(f: number): string => `${Math.max(0, Math.min(1, f)) * 100}%`

/** The drawn element under a value: aria-hidden, the words beside it carry every figure (micro-visualisation rules). */
function Drawn({ draw }: { draw: EfficiencyDraw }): ReactElement | null {
  switch (draw.kind) {
    case 'rail':
      return (
        <svg className="usage-eff-svg" width="100%" height="8" aria-hidden="true" focusable="false" data-draw="rail">
          <rect className="usage-eff-track" width="100%" height="8" rx="2" />
          {draw.fraction !== null && draw.fraction > 0 && <rect className="usage-eff-fill" width={pct(Math.max(draw.fraction, 0.01))} height="8" rx="2" />}
        </svg>
      )
    case 'segments': {
      const w = Math.max(0, draw.waiting)
      const i = Math.max(0, draw.idle)
      const l = Math.max(0, draw.limit)
      const scale = Math.max(1, w + i + l)
      return (
        <svg className="usage-eff-svg" width="100%" height="8" aria-hidden="true" focusable="false" data-draw="segments">
          <rect className="usage-eff-track" width="100%" height="8" rx="2" />
          {w > 0 && <rect className="usage-eff-seg-waiting" x="0" width={pct(w / scale)} height="8" />}
          {i > 0 && <rect className="usage-eff-seg-idle" x={pct(w / scale)} width={pct(i / scale)} height="8" />}
          {l > 0 && <rect className="usage-eff-seg-limit" x={pct((w + i) / scale)} width={pct(l / scale)} height="8" />}
        </svg>
      )
    }
    case 'range': {
      const span = draw.max - draw.min
      const at = (v: number): string => (span <= 0 ? '50%' : `${6 + ((v - draw.min) / span) * 88}%`)
      return (
        <svg className="usage-eff-svg" width="100%" height="12" aria-hidden="true" focusable="false" data-draw="range">
          <line className="usage-eff-range" x1="6%" x2="94%" y1="6" y2="6" />
          <line className="usage-eff-cap" x1="6%" x2="6%" y1="2" y2="10" />
          <line className="usage-eff-cap" x1="94%" x2="94%" y1="2" y2="10" />
          <rect className="usage-eff-median" x={at(draw.median)} y="0" width="2" height="12" style={{ transform: 'translateX(-1px)' }} />
        </svg>
      )
    }
    case 'spark': {
      const n = draw.values.length
      if (n === 0) return null
      const max = Math.max(...draw.values, 1)
      // Fourteen fixed slots, newest on the right, so one or two buckets never draw as a slab.
      const slots = Math.max(SPARK_SLOTS, n)
      return (
        <svg className="usage-eff-svg" width="100%" height="24" aria-hidden="true" focusable="false" data-draw="spark">
          <line className="usage-eff-base" x1="0" x2="100%" y1="23.5" y2="23.5" />
          {draw.values.map((v, i) => {
            const h = Math.max(1, (v / max) * 22)
            return <rect key={i} className="usage-eff-bar" x={`${((slots - n + i) / slots) * 100 + 100 / slots / 5}%`} width={`${(100 / slots) * 0.6}%`} y={23 - h} height={h} rx="1" />
          })}
        </svg>
      )
    }
    case 'dots': {
      if (draw.team === null || draw.ask === null) return null
      const max = Math.max(draw.team, draw.ask, 1e-9)
      const at = (v: number): string => `${4 + (v / max) * 92}%`
      return (
        <svg className="usage-eff-svg" width="100%" height="12" aria-hidden="true" focusable="false" data-draw="dots">
          <line className="usage-eff-range" x1="4%" x2="96%" y1="6" y2="6" />
          <circle className="usage-eff-dot-team" cx={at(draw.team)} cy="6" r="4" />
          <circle className="usage-eff-dot-ask" cx={at(draw.ask)} cy="6" r="4" />
        </svg>
      )
    }
    default:
      return null
  }
}

function Instrument({ item, onPick }: { item: EfficiencyItem; onPick: (item: EfficiencyItem) => void }): ReactElement {
  const id = useId()
  return (
    <dl className="usage-eff-item" data-testid="usage-eff-item" data-signal={item.signal} data-value={item.value}>
      <div className="usage-eff-name">
        <dt id={`${id}-n`}>{item.name}</dt>
        <Popover
          trigger={<Icon icon={Info} size="sm" />}
          triggerLabel={`What ${item.name} means`}
          triggerClassName="icon-btn size-sm usage-eff-info"
          triggerTestId="usage-eff-info"
          label={`${item.name}: definition`}
          className="usage-eff-pop"
          placement="bottom-start"
        >
          <p className="usage-eff-def">{item.definition}</p>
        </Popover>
      </div>
      <dd className="usage-eff-valuewrap">
        <button
          type="button"
          className="usage-eff-value"
          data-testid="usage-eff-value"
          aria-labelledby={`${id}-n ${id}-v`}
          aria-describedby={`${id}-d`}
          title={`${item.basis} Press to sort Runs worth a look by this.`}
          onClick={() => onPick(item)}
        >
          <span id={`${id}-v`}>{item.value}</span>
        </button>
      </dd>
      <dd className="usage-eff-draw">
        <Drawn draw={item.draw} />
      </dd>
      <dd id={`${id}-d`} className="usage-eff-detail">
        {item.detail}
      </dd>
    </dl>
  )
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

export default function EfficiencyPanel({ data, overview, onPickSignal, announce }: EfficiencyPanelProps): ReactElement {
  const opts = useMemo(() => ({ connectionName: (id: string) => connectionLabel(id), trend: data.trend }), [data.trend])
  const items = useMemo(() => efficiencyItems(data.rows, opts), [data.rows, opts])
  const baseSummary = useMemo(() => efficiencySummary(data.rows, opts), [data.rows, opts])
  // Efficiency is read from the returned rows only; say so when main cut the list (the banner already says it for folded figures).
  const summary = overview.truncated && !data.folded ? `${baseSummary} From the newest ${TRUNCATED_LIMIT_LABEL} runs.` : baseSummary
  const timing = useMemo(() => reportTimingSummary(data.rows), [data.rows])
  const byProject = useMemo(() => efficiencyByProject(data.rows, opts), [data.rows, opts])
  const [sort, setSort] = useState<{ col: EfficiencyColumn; dir: SortDir }>({ col: 'runs', dir: 'desc' })
  const table = useMemo(() => sortEfficiencyRows(byProject, sort.col, sort.dir), [byProject, sort])

  const groupRef = useRef<HTMLDivElement>(null)
  const roving = useRovingFocus(groupRef, '.usage-eff-info, .usage-eff-value')

  const pick = (item: EfficiencyItem): void => {
    onPickSignal(item.sort)
    announce(sortedByText(item.sort))
  }
  const onSort = (col: EfficiencyColumn): void => setSort((s) => (s.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: col === 'project' ? 'asc' : 'desc' }))

  return (
    <section className="usage-panel" id="usage-efficiency" aria-labelledby="usage-efficiency-h" data-testid="usage-efficiency">
      <div className="usage-panel-head">
        <h2 id="usage-efficiency-h" tabIndex={-1}>
          Efficiency
        </h2>
        <p className="usage-panel-summary" data-testid="usage-efficiency-summary">
          {summary}
        </p>
      </div>
      {data.rows.length === 0 ? (
        <p className="usage-note">No runs in this view.</p>
      ) : (
        <div ref={groupRef} className="usage-eff-grid" role="group" aria-label="Efficiency measures. Arrow keys move between them; press a value to sort Runs worth a look by it." onKeyDown={roving.onKeyDown} onFocus={roving.onFocus}>
          {items.map((item) => (
            <Instrument key={item.signal} item={item} onPick={pick} />
          ))}
        </div>
      )}
      {timing.runs > 0 && (
        <div className="usage-eff-grid" role="group" aria-label="Team timing" data-testid="usage-timing">
          {[
            { id: 'first-spawn', name: 'Time to first spawn', value: timing.firstSpawnMs === null ? '—' : minutesText(timing.firstSpawnMs), def: TIMING_DEFINITIONS.firstSpawn },
            { id: 'overlap', name: 'Overlap', value: overlapText(timing.overlap), def: TIMING_DEFINITIONS.overlap },
            { id: 'tail', name: 'Tail', value: timing.tailShare === null ? '—' : percentText(timing.tailShare), def: TIMING_DEFINITIONS.tail }
          ].map((t) => (
            <dl key={t.id} className="usage-eff-item" data-testid="usage-timing-item" data-signal={t.id} data-value={t.value}>
              <div className="usage-eff-name">
                <dt>{t.name}</dt>
              </div>
              <dd className="usage-eff-valuewrap">
                <span className="usage-eff-value" data-testid="usage-timing-value">
                  {t.value}
                </span>
              </dd>
              <dd className="usage-eff-detail">
                {t.def} Median over {timing.runs.toLocaleString()} {timing.runs === 1 ? 'run' : 'runs'} with reports.
              </dd>
            </dl>
          ))}
        </div>
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
