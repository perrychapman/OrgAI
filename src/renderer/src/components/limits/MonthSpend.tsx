import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import type { Project } from '@shared/types'
import { formatUsd } from '../../lib/cost'
import { defaultUsageFilters } from '../../lib/usageOverview'
import { useAppStore } from '../../store/useAppStore'
import { Button } from '../ui/Button'

interface Spend {
  runs: number
  costUsd: number | null
  partial: boolean
  unknownRuns: number
}

/** Local start of the current calendar month (epoch ms). */
function monthStart(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime()
}

/**
 * The Spending limits hero (ui-overhaul Limits board): what this project spent this calendar month, from the same
 * usage overview the Usage page reads (main's priced run records; unknown cost is said, never shown as $0), and a way
 * to the Usage page filtered to the project. No meter: a monthly limit is not a project setting.
 */
export function MonthSpend({ project }: { project: Project }): ReactElement | null {
  const [spend, setSpend] = useState<Spend | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    window.orgai.runs
      .usageOverview({ since: monthStart(new Date()), projectIds: [project.id], limit: 1, bucket: 'month' })
      .then((o) => {
        if (!live) return
        const p = o.projects.find((x) => x.projectId === project.id)
        setSpend(p ? { runs: p.runs, costUsd: p.costUsd, partial: !!p.costPartial, unknownRuns: p.costUnknownRuns } : { runs: 0, costUsd: 0, partial: false, unknownRuns: 0 })
      })
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [project.id])

  const open = (): void => {
    const st = useAppStore.getState()
    st.setUsageFilters({ ...defaultUsageFilters(), period: { kind: 'this-month' }, projectIds: [project.id] })
    st.setView('usage')
  }

  if (failed) return null
  const month = new Date().toLocaleDateString(undefined, { month: 'long' })
  let title = 'Loading this month…'
  let line = ''
  if (spend) {
    if (spend.runs === 0) {
      title = `Nothing spent in ${month} yet`
      line = 'No runs in this project this month.'
    } else {
      const cost = spend.costUsd === null ? 'Cost unknown' : `${spend.partial ? 'At least ' : ''}${formatUsd(spend.costUsd)}`
      title = `${cost} in ${month}`
      line = `${spend.runs} ${spend.runs === 1 ? 'run' : 'runs'} so far${spend.unknownRuns > 0 ? `, ${spend.unknownRuns} without a known price` : ''}.`
    }
  }
  return (
    <div className="settings-card month-spend" data-testid="limits-month-spend" aria-busy={spend === null}>
      <div className="month-spend-row">
        <div className="month-spend-text">
          <div className="month-spend-title">{title}</div>
          {line && <div className="month-spend-line">{line}</div>}
          {project.maxBudgetUsd !== undefined && <div className="month-spend-line">Each run stops at {formatUsd(project.maxBudgetUsd)}.</div>}
        </div>
        <Button size="sm" testId="limits-see-usage" onClick={open}>
          See where it went
        </Button>
      </div>
    </div>
  )
}
