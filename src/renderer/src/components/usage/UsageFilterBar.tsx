import type { ReactElement, Ref } from 'react'
import { useId, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { UsageOverviewConnection } from '@shared/types'
import { SegmentedControl } from '../ui/SegmentedControl'
import { Popover } from '../ui/Popover'
import { Checkbox } from '../ui/Checkbox'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Icon } from '../ui/Icon'
import { Cost } from '../ui/Cost'
import { connectionLabel } from '../../lib/connectionLabel'
import {
  USAGE_KINDS,
  USAGE_KIND_LABELS,
  bucketRefusal,
  effectiveBucket,
  monthKey,
  periodLabel,
  periodSpan,
  pickMonths,
  usageMonthOptions,
  type UsageBucket,
  type UsageFilters,
  type UsageKind,
  type UsagePeriod
} from '../../lib/usageOverview'
import {
  SEARCH_FROM_PROJECTS,
  filterOptions,
  kindsButtonText,
  projectsButtonText,
  showConnectionSelect,
  toggleSelection,
  type ProjectOptionGroup
} from '../../lib/usagePage'

type PeriodChoice = '7' | '30' | 'this-month' | 'last-month' | 'months'

const PERIOD_OPTIONS: { value: PeriodChoice; label: string }[] = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: 'this-month', label: 'This month' },
  { value: 'last-month', label: 'Last month' },
  { value: 'months', label: 'Months...' }
]

const periodChoice = (p: UsagePeriod): PeriodChoice => (p.kind === 'days' ? (String(p.days) as PeriodChoice) : p.kind === 'months' ? 'months' : p.kind)

const BUCKETS: { value: UsageBucket; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' }
]

/** Group by: the SegmentedControl markup with an inert (aria-disabled, titled) choice the span refuses (3.2). */
function BucketControl({ value, days, onChange }: { value: UsageBucket; days: number; onChange: (b: UsageBucket) => void }): ReactElement {
  const name = useId()
  return (
    <div className="seg" role="radiogroup" aria-label="Group by" data-testid="usage-bucket">
      {BUCKETS.map((b) => {
        const why = bucketRefusal(b.value, days)
        const reasonId = `${name}-${b.value}`
        return (
          <label key={b.value} className={`seg-item${value === b.value ? ' on' : ''}${why ? ' is-inert' : ''}`} title={why ?? undefined}>
            <input
              type="radio"
              name={name}
              value={b.value}
              checked={value === b.value}
              aria-disabled={why ? 'true' : undefined}
              aria-describedby={why ? reasonId : undefined}
              onChange={() => {
                if (!why) onChange(b.value)
              }}
            />
            {b.label}
            {why && (
              <span id={reasonId} className="sr-only">
                {why}
              </span>
            )}
          </label>
        )
      })}
    </div>
  )
}

/** The Projects checklist: a "no ids = all" selection, search from 8 projects, Select all / Clear (3.3). */
export function ProjectsPicker({
  groups,
  filters,
  onChange
}: {
  groups: ProjectOptionGroup[]
  filters: UsageFilters
  onChange: (ids: string[]) => void
}): ReactElement {
  const all = groups.flatMap((g) => g.options.map((o) => o.id))
  const [query, setQuery] = useState('')
  // "Clear" unchecks every row while the filter stays "all projects" until one is picked.
  const [cleared, setCleared] = useState(false)
  const checked = (id: string): boolean => (filters.projectIds.length === 0 ? !cleared : filters.projectIds.includes(id))
  return (
    <div className="usage-picker" data-testid="usage-projects-picker">
      {all.length >= SEARCH_FROM_PROJECTS && (
        <Input type="search" value={query} onChange={setQuery} aria-label="Search projects" placeholder="Search projects" data-testid="usage-projects-search" />
      )}
      <div className="usage-picker-actions">
        <Button
          variant="ghost"
          size="sm"
          testId="usage-projects-all"
          onClick={() => {
            setCleared(false)
            onChange([])
          }}
        >
          Select all
        </Button>
        <Button variant="ghost" size="sm" testId="usage-projects-clear" onClick={() => setCleared(true)}>
          Clear
        </Button>
      </div>
      {cleared && filters.projectIds.length === 0 && <p className="usage-picker-hint">Nothing is picked, so every project still counts.</p>}
      {groups.map((g) => {
        const options = filterOptions(g.options, query)
        if (options.length === 0) return null
        return (
          <fieldset key={g.key} className="usage-picker-group">
            <legend>{g.label}</legend>
            {options.map((o) => (
              <div key={o.id} className="usage-opt" data-testid="usage-project-option" data-id={o.id} data-dim={o.runs === 0 ? '' : undefined}>
                <Checkbox
                  checked={checked(o.id)}
                  onChange={(on) => {
                    const fromCleared = cleared && filters.projectIds.length === 0
                    setCleared(false)
                    if (fromCleared) onChange(on && all.length > 1 ? [o.id] : [])
                    else onChange(toggleSelection(filters.projectIds, all, o.id, on))
                  }}
                  label={
                    <span className="usage-opt-row">
                      <span className="usage-opt-name">{o.name}</span>
                      <span className="usage-opt-cost">{o.cost && o.runs > 0 ? <Cost value={o.cost} precision="page" /> : <span className="usage-opt-none">No runs</span>}</span>
                    </span>
                  }
                />
              </div>
            ))}
          </fieldset>
        )
      })}
    </div>
  )
}

/** The Kinds checklist (3.4). */
export function KindsPicker({ filters, onChange }: { filters: UsageFilters; onChange: (kinds: UsageKind[]) => void }): ReactElement {
  return (
    <fieldset className="usage-picker-group" data-testid="usage-kinds-picker">
      <legend className="sr-only">Run kinds</legend>
      {USAGE_KINDS.map((k) => (
        <div key={k} className="usage-opt" data-testid="usage-kind-option" data-kind={k}>
          <Checkbox
            checked={filters.kinds.length === 0 || filters.kinds.includes(k)}
            onChange={(on) => onChange(toggleSelection(filters.kinds, USAGE_KINDS, k, on))}
            label={USAGE_KIND_LABELS[k]}
          />
        </div>
      ))}
    </fieldset>
  )
}

function ConnectionSelect({
  filters,
  connections,
  onChange
}: {
  filters: UsageFilters
  connections: readonly UsageOverviewConnection[]
  onChange: (id: string | null) => void
}): ReactElement | null {
  const id = useId()
  if (!showConnectionSelect(connections, filters.connection)) return null
  const ids = connections.map((c) => c.connection).filter((c): c is string => c !== null)
  if (filters.connection && !ids.includes(filters.connection)) ids.push(filters.connection)
  return (
    <div className="usage-field">
      <label className="usage-field-label" htmlFor={id}>
        Connection
      </label>
      <select id={id} className="select" data-testid="usage-connection" value={filters.connection ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">All connections</option>
        {ids.map((c) => (
          <option key={c} value={c}>
            {connectionLabel(c)}
          </option>
        ))}
      </select>
    </div>
  )
}

function PopoverTrigger({ children }: { children: string }): ReactElement {
  return (
    <>
      <span className="usage-trigger-text">{children}</span>
      <Icon icon={ChevronDown} size="sm" />
    </>
  )
}

export interface UsageFilterBarProps {
  filters: UsageFilters
  /** The view applies, persists and announces the change. `moved` is a sentence to announce (To month moved up). */
  onChange: (next: UsageFilters, moved?: string) => void
  now: number
  /** Under 880 px of page: Projects, Kinds and Connection fold into one "More filters" popover. */
  compact: boolean
  groups: ProjectOptionGroup[]
  connections: readonly UsageOverviewConnection[]
  projectName: (id: string) => string
  /** The scope line again, as sr-only text, so it is known after scrolling. */
  scope: string
  barRef: Ref<HTMLDivElement>
}

/** The sticky filter bar (docs/design/usage-app.md 3). Row one: period, months and group by; row two: the rest. */
export default function UsageFilterBar({ filters, onChange, now, compact, groups, connections, projectName, scope, barRef }: UsageFilterBarProps): ReactElement {
  const span = periodSpan(filters.period, now)
  const bucket = effectiveBucket(filters, now)
  const months = usageMonthOptions(now)
  const period = filters.period
  const set = (patch: Partial<UsageFilters>, moved?: string): void => onChange({ ...filters, ...patch }, moved)
  const showConnection = showConnectionSelect(connections, filters.connection)
  const narrowedMore = filters.projectIds.length + (filters.kinds.length > 0 ? 1 : 0) + (filters.connection ? 1 : 0)

  const pickPeriod = (v: PeriodChoice): void => {
    if (v === '7') set({ period: { kind: 'days', days: 7 }, bucketPick: null })
    else if (v === '30') set({ period: { kind: 'days', days: 30 }, bucketPick: null })
    else if (v === 'this-month') set({ period: { kind: 'this-month' }, bucketPick: null })
    else if (v === 'last-month') set({ period: { kind: 'last-month' }, bucketPick: null })
    else {
      const last = months[1]?.value ?? monthKey(now)
      set({ period: { kind: 'months', from: last, to: last }, bucketPick: null })
    }
  }
  const pickMonth = (which: 'from' | 'to', month: string): void => {
    const r = pickMonths(period, which, month, now)
    set({ period: r.period, bucketPick: null }, r.moved)
  }

  const projectsPicker = <ProjectsPicker groups={groups} filters={filters} onChange={(projectIds) => set({ projectIds })} />
  const kindsPicker = <KindsPicker filters={filters} onChange={(kinds) => set({ kinds })} />

  return (
    <div className="usage-filters" data-testid="usage-filters" ref={barRef} role="group" aria-label="Usage filters">
      <p className="sr-only">{scope}</p>
      <div className="usage-filters-row">
        <div className="usage-field">
          <span className="usage-field-label">Period</span>
          <div data-testid="usage-period">
            <SegmentedControl<PeriodChoice> label="Period" value={periodChoice(period)} options={PERIOD_OPTIONS} onChange={pickPeriod} />
          </div>
        </div>
        {period.kind === 'months' && (
          <div className="usage-months">
            <label className="usage-field-label" htmlFor="usage-month">
              From
            </label>
            <select id="usage-month" className="select" data-testid="usage-month" value={period.from} onChange={(e) => pickMonth('from', e.target.value)}>
              {months.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <label className="usage-field-label" htmlFor="usage-month-to">
              to
            </label>
            <select id="usage-month-to" className="select" data-testid="usage-month-to" value={period.to} onChange={(e) => pickMonth('to', e.target.value)}>
              {months.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="usage-field">
          <span className="usage-field-label">Group by</span>
          <BucketControl value={bucket} days={span.days} onChange={(b) => set({ bucket: b })} />
        </div>
        <p className="usage-period-label" data-testid="usage-period-label">
          {periodLabel(period, now)}
        </p>
      </div>
      <div className="usage-filters-row">
        {compact ? (
          <Popover
            trigger={<PopoverTrigger>{narrowedMore > 0 ? `More filters (${narrowedMore})` : 'More filters'}</PopoverTrigger>}
            triggerClassName="btn sm"
            triggerTestId="usage-filters-more"
            label="More filters"
            className="usage-more-panel"
            testId="usage-filters-more-panel"
          >
            <div className="usage-more">
              <section>
                <h3 className="usage-more-h">Projects</h3>
                {projectsPicker}
              </section>
              <section>
                <h3 className="usage-more-h">Kinds</h3>
                {kindsPicker}
              </section>
              {showConnection && (
                <ConnectionSelect filters={filters} connections={connections} onChange={(connection) => set({ connection })} />
              )}
            </div>
          </Popover>
        ) : (
          <>
            <Popover
              trigger={<PopoverTrigger>{projectsButtonText(filters, projectName)}</PopoverTrigger>}
              triggerClassName="btn sm"
              triggerTestId="usage-projects"
              triggerTitle="Projects"
              label="Projects"
              className="usage-picker-panel"
              testId="usage-projects-panel"
            >
              {projectsPicker}
            </Popover>
            <Popover
              trigger={<PopoverTrigger>{kindsButtonText(filters)}</PopoverTrigger>}
              triggerClassName="btn sm"
              triggerTestId="usage-kinds"
              triggerTitle="Kinds"
              label="Kinds"
              className="usage-picker-panel"
              testId="usage-kinds-panel"
            >
              {kindsPicker}
            </Popover>
            <ConnectionSelect filters={filters} connections={connections} onChange={(connection) => set({ connection })} />
          </>
        )}
      </div>
    </div>
  )
}
