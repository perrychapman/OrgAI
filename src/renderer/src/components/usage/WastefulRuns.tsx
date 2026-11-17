import type { ReactElement } from 'react'
import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react'
import { formatDateTime } from '../../lib/dates'
import { effectiveWastefulSort, WASTEFUL_MORE, WASTEFUL_SHOWN, WASTEFUL_SORT_LABELS, wastefulRuns } from '../../lib/usageEfficiency'
import { rowCostInput, rowKindWord, rowName, rowStatusWord } from '../../lib/usageRuns'
import { useAppStore } from '../../store/useAppStore'
import { CostText } from './RankedBars'
import type { UsagePanelProps, WastefulSort } from './panelProps'
import { RunDetailRow, RunToggle, TableWrap } from './usageTableParts'
import '../../styles/usage-runs.css'

/** Status dot colour per word (the word is also the dot's accessible name and title, never colour alone). */
const TONE: Record<string, string> = { Finished: 'ok', Failed: 'bad', Running: 'live', 'Needs you': 'live' }

export interface WastefulRunsProps extends UsagePanelProps {
  sort: WastefulSort
  onSort: (sort: WastefulSort) => void
  /** Bumped when an efficiency instrument picked the sort: focus the section heading (h2, tabindex -1). */
  focusSeq: number
}

const SORTS: WastefulSort[] = ['no-result', 'cost', 'cache', 'retries', 'nudges', 'idle']

export default function WastefulRuns({ data, sort, onSort, focusSeq }: WastefulRunsProps): ReactElement {
  const openRun = useAppStore((s) => s.openUsageRun)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const selectId = useId()
  const [expanded, setExpanded] = useState(false)
  // Run details: `open` is what is expanded, `touched` keeps a closed detail row mounted so it can glide shut.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set())
  const toggle = (id: string): void => {
    setOpen((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
    setTouched((s) => (s.has(id) ? s : new Set(s).add(id)))
  }

  // An efficiency instrument picked the sort: the heading takes focus (not on first mount).
  const seen = useRef(focusSeq)
  useEffect(() => {
    if (focusSeq !== seen.current) {
      seen.current = focusSeq
      headingRef.current?.focus()
    }
  }, [focusSeq])

  // "Show N more" takes the button away: focus the first newly shown row's open button, else the heading (never body).
  const sectionRef = useRef<HTMLElement>(null)
  const focusAfterMore = useRef<string | null>(null)
  useEffect(() => {
    const id = focusAfterMore.current
    if (!id) return
    focusAfterMore.current = null
    const row = sectionRef.current?.querySelector<HTMLElement>(`[data-testid="usage-wasteful-row"][data-run="${CSS.escape(id)}"]`)
    ;(row?.querySelector<HTMLElement>('.usage-run-open') ?? headingRef.current)?.focus()
  }, [expanded])

  const effective = effectiveWastefulSort(sort, data.rows)
  const entries = useMemo(() => wastefulRuns(data.rows, effective), [data.rows, effective])
  const shown = entries.slice(0, expanded ? WASTEFUL_MORE : WASTEFUL_SHOWN)
  const more = Math.min(entries.length, WASTEFUL_MORE) - shown.length
  const options = effective === 'cost' && sort === 'no-result' ? SORTS.filter((s) => s !== 'no-result') : SORTS
  const anyUnknown = shown.some((e) => e.unknownCost)

  return (
    <section ref={sectionRef} className="usage-panel" id="usage-wasteful" aria-labelledby="usage-wasteful-h" data-testid="usage-wasteful">
      <div className="usage-panel-head">
        <h2 id="usage-wasteful-h" tabIndex={-1} ref={headingRef}>
          Runs worth a look
        </h2>
        <p className="usage-panel-summary usage-wasteful-note" data-testid="usage-wasteful-note">
          These are where spend and results diverge most. A long run that did its job can also appear.
        </p>
        <div className="usage-panel-controls">
          <label htmlFor={selectId} className="usage-ctl-label">
            Sort by
          </label>
          <select id={selectId} className="select" data-testid="usage-wasteful-sort" value={effective} onChange={(e) => onSort(e.target.value as WastefulSort)}>
            {options.map((s) => (
              <option key={s} value={s}>
                {WASTEFUL_SORT_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
      </div>
      {entries.length === 0 ? (
        <p className="usage-note" data-testid="usage-wasteful-empty">
          Nothing stands out in this period.
        </p>
      ) : (
        <>
          <TableWrap label="Runs worth a look">
            <table className="usage-tbl usage-wasteful-table">
              <caption className="sr-only">Runs worth a look, sorted by {WASTEFUL_SORT_LABELS[effective].toLowerCase()}</caption>
              <thead>
                <tr>
                  <th scope="col" className="sticky">
                    Run
                  </th>
                  <th scope="col">When</th>
                  <th scope="col" className="num">
                    Cost
                  </th>
                  <th scope="col">Why listed</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e) => {
                  const r = e.row
                  const name = rowName(r)
                  const status = rowStatusWord(r)
                  const nr = r.usage.noResultCostUsd
                  const isOpen = open.has(r.runId)
                  const detailId = `${uid}-detail-${r.runId}`
                  return (
                    <Fragment key={r.runId}>
                    <tr data-testid="usage-wasteful-row" data-run={r.runId} data-project={r.projectId}>
                      <th scope="row" className="sticky usage-run-cell">
                        <RunToggle open={isOpen} detailId={detailId} mounted={touched.has(r.runId)} onToggle={() => toggle(r.runId)} />
                        {r.projectRemoved ? (
                          <span className="usage-run-name" title={name}>
                            {name}
                          </span>
                        ) : (
                          <button type="button" className="usage-run-open" data-testid="usage-run-open" title={`Open ${name}`} onClick={() => void openRun(r.projectId, r.runId)}>
                            {name}
                          </button>
                        )}
                        <span className="usage-status-dot" data-tone={TONE[status.word] ?? 'idle'} role="img" aria-label={`Status: ${status.word}`} title={status.note ? `${status.word}. ${status.note}` : status.word} />
                        <span className="usage-tag usage-run-kind">{rowKindWord(r)}</span>
                        {e.noResult && <span className="usage-tag" data-testid="usage-no-result-tag">No result</span>}
                        <span className="usage-cell-sub">{r.projectRemoved ? `${r.projectName}. Project removed` : r.projectName}</span>
                      </th>
                      <td className="nowrap">{formatDateTime(r.startedAt)}</td>
                      <td className="num">
                        <CostText value={rowCostInput(r)} />
                        {effective === 'no-result' && nr !== undefined && (
                          <span className="usage-cell-sub">
                            no result: <CostText value={{ costUsd: nr, costSource: nr === null ? 'unknown' : 'computed', ...(r.usage.noResultCostPartial ? { costPartial: true } : {}), sourceMixed: true }} />
                          </span>
                        )}
                      </td>
                      <td className="usage-why" title={e.why}>
                        <span className="usage-why-clip">{e.why}</span>
                      </td>
                    </tr>
                    {touched.has(r.runId) && <RunDetailRow id={detailId} colSpan={4} open={isOpen} row={r} why={e.why} />}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </TableWrap>
          {anyUnknown && <p className="usage-note">Runs with an unknown cost come after the others, ordered by tokens.</p>}
          {more > 0 && (
            <button type="button" className="btn ghost sm usage-more-btn" data-testid="usage-wasteful-more" onClick={() => {
                focusAfterMore.current = entries[WASTEFUL_SHOWN]?.row.runId ?? null
                setExpanded(true)
              }}>
              Show {more} more
            </button>
          )}
        </>
      )}
    </section>
  )
}
