import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { Briefcase } from 'lucide-react'
import { isVirtualProjectId, type UsageProjectRollup } from '@shared/types'
import { formatTokens } from '../../lib/cost'
import { useAppStore } from '../../store/useAppStore'
import {
  barFraction,
  cacheHit,
  clipMiddle,
  percentText,
  perRunCost,
  projectKindWord,
  rankByCost,
  rollupCost,
  runsText,
  sharePercent,
  tokenSum
} from '../../lib/usageCharts'
import type { UsagePanelProps } from './panelProps'
import { Icon } from '../ui/Icon'
import { ChartTable } from './ChartTable'
import { CostText, RankedBars, RowMenu, useWidePage, type MenuEntry, type RankedItem } from './RankedBars'
import '../../styles/usage-charts.css'

const SERIES_VAR = ['--chart-s1', '--chart-s2', '--chart-s3', '--chart-s4', '--chart-s5']

/** Opens the project (or assistant) in the app; a removed project has nowhere to go. */
async function openTarget(p: UsageProjectRollup, then?: 'history'): Promise<void> {
  const s = useAppStore.getState()
  if (p.projectRemoved) return
  if (isVirtualProjectId(p.projectId)) await s.openAssistant(p.projectId)
  else await s.openProject(p.projectId)
  if (then === 'history') useAppStore.getState().setView('history')
}

export default function ProjectsPanel({ data, filters, series, onNarrow }: UsagePanelProps): ReactElement {
  const wide = useWidePage()
  const limit = wide ? 7 : 5
  const [showAll, setShowAll] = useState(false)
  const [menu, setMenu] = useState<{ project: UsageProjectRollup; anchor: HTMLElement } | null>(null)

  const ranked = useMemo(() => rankByCost(data.projects, (p) => ({ costUsd: p.costUsd, tokens: tokenSum(p.tokens) })), [data.projects])
  const shown = showAll ? ranked : ranked.slice(0, limit)
  const maxCost = ranked.reduce((m, p) => Math.max(m, p.costUsd ?? 0), 0)
  const byId = new Map(ranked.map((p) => [p.projectId, p]))

  const items: RankedItem[] = shown.map((p) => {
    const cost = rollupCost(p)
    const unknown = p.costUsd === null
    const idx = series.get(p.projectId)
    return {
      id: p.projectId,
      data: { id: p.projectId },
      mark: p.projectKind === 'engagement' ? <Icon icon={Briefcase} size="xs" label="Engagement" /> : undefined,
      name: p.projectName,
      shown: clipMiddle(p.projectName, 26),
      sub: p.projectRemoved ? 'Project removed' : (p.client ?? undefined),
      fraction: unknown ? 0 : barFraction(p.costUsd ?? 0, maxCost),
      state: unknown ? 'unknown' : p.costUnknownRuns > 0 ? 'partial' : 'known',
      fill: idx !== undefined ? `var(${SERIES_VAR[idx]})` : 'var(--chart-other)',
      cost,
      detail: runsText(p.runs),
      selected: filters.projectIds.includes(p.projectId),
      srText: `, ${formatTokens(tokenSum(p.tokens))} tokens`
    }
  })

  const top = ranked.find((p) => p.costUsd !== null)
  const totalKnown = ranked.reduce((n, p) => n + (p.costUsd ?? 0), 0)
  const summary = (() => {
    if (ranked.length === 0) return 'No projects have runs in this period.'
    if (!top || totalKnown <= 0) return `${ranked.length === 1 ? 'This project has' : `${ranked.length} projects have`} spent tokens, but no cost is known.`
    const anyUnknown = ranked.some((p) => p.costUnknownRuns > 0)
    if (ranked.length === 1) return `All of this period's estimated cost is in ${top.projectName}.`
    return `${top.projectName} is ${sharePercent(top.costUsd ?? 0, totalKnown)}% of this period's estimated cost${anyUnknown ? ', counting only runs with a known price' : ''}.`
  })()

  const entries = (p: UsageProjectRollup): MenuEntry[] => [
    { id: 'narrow', label: 'Narrow to this project', testId: 'usage-project-narrow', onSelect: () => onNarrow({ projectId: p.projectId }) },
    { id: 'open', label: 'Open project', testId: 'usage-project-open', disabled: !!p.projectRemoved, onSelect: () => void openTarget(p) },
    { id: 'history', label: 'Open History', testId: 'usage-project-history', disabled: !!p.projectRemoved, onSelect: () => void openTarget(p, 'history') }
  ]

  const rows = ranked.map((p) => ({
    key: p.projectId,
    data: { id: p.projectId },
    cells: [
      p.projectName,
      projectKindWord(p.projectKind),
      p.runs,
      formatTokens(tokenSum(p.tokens)),
      <CostText key="c" value={rollupCost(p)} />,
      <CostText key="r" value={perRunCost(rollupCost(p), p.runs)} />,
      percentText(cacheHit(p.tokens))
    ]
  }))

  return (
    <section className="usage-panel" aria-labelledby="usage-projects-h" data-testid="usage-projects-panel">
      <div className="usage-panel-head">
        <h2 id="usage-projects-h" tabIndex={-1}>
          By project
        </h2>
        <p className="usage-panel-summary">{summary}</p>
      </div>
      {items.length > 0 ? (
        <RankedBars
          label="Projects by estimated cost"
          items={items}
          rowTestId="usage-project-row"
          onActivate={(it) => onNarrow({ projectId: it.id })}
          onMenu={(it, anchor) => {
            const p = byId.get(it.id)
            if (p) setMenu({ project: p, anchor })
          }}
          moreLabel={(it) => `More for ${it.name}`}
        />
      ) : (
        <p className="uc-empty">No runs in this period.</p>
      )}
      {ranked.length > limit && (
        <button type="button" className="link-btn uc-more" data-testid="usage-projects-more" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show fewer' : `Show ${ranked.length - limit} more`}
        </button>
      )}
      {menu && <RowMenu anchor={menu.anchor} entries={entries(menu.project)} label={`${menu.project.projectName}: actions`} testId="usage-project-more" onClose={() => setMenu(null)} />}
      <ChartTable
        testId="usage-projects-table"
        caption="Usage by project"
        columns={[
          { key: 'project', label: 'Project' },
          { key: 'kind', label: 'Kind' },
          { key: 'runs', label: 'Runs', numeric: true },
          { key: 'tokens', label: 'Tokens', numeric: true },
          { key: 'cost', label: 'Cost', numeric: true },
          { key: 'perRun', label: 'Cost per run', numeric: true },
          { key: 'cache', label: 'Cache hit', numeric: true }
        ]}
        rows={rows}
        empty="No runs in this period."
      />
    </section>
  )
}
