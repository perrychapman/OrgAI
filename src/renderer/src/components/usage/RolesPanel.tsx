import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type { UsageOverviewRole } from '@shared/types'
import { formatTokens } from '../../lib/cost'
import { barFraction, clipMiddle, rankByCost, rollupCost, sharePercent, tokenSum } from '../../lib/usageCharts'
import type { UsagePanelProps } from './panelProps'
import { ChartTable } from './ChartTable'
import { CostText, RankedBars, useWidePage, type RankedItem } from './RankedBars'
import '../../styles/usage-charts.css'

const MODEL_COST_TITLE = 'Model cost per role is not recorded'
const roleKey =(r: UsageOverviewRole): string => r.roleId ?? r.roleSlug
const idOf = (r: UsageOverviewRole): string => `${r.projectId}\u0000${roleKey(r)}`

export default function RolesPanel({ data, filters, onNarrow }: UsagePanelProps): ReactElement {
  const wide = useWidePage()
  const limit = wide ? 7 : 5
  const [showAll, setShowAll] = useState(false)

  // One project in scope (filtered or the only one with runs): its name is no information, so it drops.
  const oneProject = filters.projectIds.length === 1 || new Set(data.roles.map((r) => r.projectId)).size <= 1
  const nameOf = (r: UsageOverviewRole): string => (oneProject ? r.roleName : `${r.projectName} / ${r.roleName}`)

  const ranked = useMemo(() => rankByCost(data.roles, (r) => ({ costUsd: r.costUsd, tokens: tokenSum(r.tokens) })), [data.roles])
  const shown = showAll ? ranked : ranked.slice(0, limit)
  const maxCost = ranked.reduce((n, r) => Math.max(n, r.costUsd ?? 0), 0)
  const byId = new Map(ranked.map((r) => [idOf(r), r]))

  const items: RankedItem[] = shown.map((r) => ({
    id: idOf(r),
    data: { project: r.projectId, role: roleKey(r) },
    name: `${r.projectName} / ${r.roleName}`,
    shown: clipMiddle(nameOf(r), 30),
    sub: oneProject ? undefined : r.projectName,
    fraction: r.costUsd === null ? 0 : barFraction(r.costUsd, maxCost),
    state: r.costUsd === null ? 'unknown' : r.costUnknownRuns > 0 ? 'partial' : 'known',
    fill: 'var(--text-secondary)',
    cost: rollupCost(r),
    costTitle: filters.model ? MODEL_COST_TITLE : undefined,
    detail: `${formatTokens(tokenSum(r.tokens))} tokens`,
    note: r.retries > 0 ? `${r.retries} ${r.retries === 1 ? 'retry' : 'retries'}` : undefined,
    selected: !!filters.role && filters.role.projectId === r.projectId && filters.role.roleKey === roleKey(r)
  }))

  const top = ranked.find((r) => r.costUsd !== null)
  const knownTotal = ranked.reduce((n, r) => n + (r.costUsd ?? 0), 0)
  const summary = (() => {
    if (ranked.length === 0) return 'No agents ran in this period.'
    if (filters.model) return `${ranked.length} ${ranked.length === 1 ? 'role' : 'roles'} used this model. Model cost per role is not recorded.`
    if (!top || knownTotal <= 0) return 'Agents spent tokens, but no cost is known.'
    return `${nameOf(top)} is ${sharePercent(top.costUsd ?? 0, knownTotal)}% of the estimated cost.`
  })()

  const rows = ranked.map((r) => ({
    key: idOf(r),
    data: { project: r.projectId, role: roleKey(r) },
    cells: [r.roleName, r.projectName, r.runs, r.agents, formatTokens(tokenSum(r.tokens)), <CostText key="c" value={rollupCost(r)} title={filters.model ? MODEL_COST_TITLE : undefined} />, r.retries]
  }))

  return (
    <section className="usage-panel" aria-labelledby="usage-roles-h" data-testid="usage-roles">
      <div className="usage-panel-head">
        <h2 id="usage-roles-h" tabIndex={-1}>
          By role
        </h2>
        <p className="usage-panel-summary">{summary}</p>
      </div>
      {items.length > 0 ? (
        <RankedBars
          label={filters.model ? 'Roles that used this model, by tokens' : 'Roles by estimated cost'}
          items={items}
          rowTestId="usage-role-row"
          onActivate={(it) => {
            const r = byId.get(it.id)
            if (r) onNarrow({ role: { projectId: r.projectId, roleKey: roleKey(r), label: `${r.projectName} / ${r.roleName}` } })
          }}
        />
      ) : (
        <p className="uc-empty">No runs in this period.</p>
      )}
      {ranked.length > limit && (
        <button type="button" className="link-btn uc-more" data-testid="usage-roles-more" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show fewer' : `Show ${ranked.length - limit} more`}
        </button>
      )}
      <ChartTable
        testId="usage-roles-table"
        caption="Usage by role"
        columns={[
          { key: 'role', label: 'Role' },
          { key: 'project', label: 'Project' },
          { key: 'runs', label: 'Runs', numeric: true },
          { key: 'agents', label: 'Agents', numeric: true },
          { key: 'tokens', label: 'Tokens', numeric: true },
          { key: 'cost', label: 'Cost', numeric: true },
          { key: 'retries', label: 'Retries', numeric: true }
        ]}
        rows={rows}
        empty="No runs in this period."
      />
    </section>
  )
}
