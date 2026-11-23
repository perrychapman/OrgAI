import type { ReactElement, ReactNode } from 'react'
import { useEffect, useId, useState } from 'react'
import type { Project, ProjectSpend, ProjectSpendPeriod } from '@shared/types'
import { DEFAULT_KEEP_RUNS, PROJECT_MAX_AGENTS_PER_RUN_LIMIT } from '@shared/types'
import { formatUsd } from '../../lib/cost'
import { Switch } from '../ui/Switch'
import { SegmentedControl } from '../ui/SegmentedControl'
import { MAX_SUBAGENT_DEPTH_LIMIT, effectiveSubagentLimits, planGuardOf } from '@shared/defaults'
import { useAppStore } from '../../store/useAppStore'
import { projectMetering } from '../../lib/limits'
import { SETTINGS_COPY, planGuardLine } from '../../lib/settingsCopy'
import { Input } from '../ui/Input'
import { SettingRow, settingDescId } from '../ui/SettingRow'
import { Select } from '../ui/Select'
import { ClampedNumber } from './ClampedNumber'
import { SettingsAdvanced } from './SettingsAdvanced'
import { SettingsCard } from './SettingsCard'
import { StaffingSettings } from './StaffingSettings'
import { MonthSpend } from '../limits/MonthSpend'
import { SettingsGroup, SettingsSection } from './SettingsSection'

/** planGuardOf modes: Automatic (unset) engages on a plan with a weekly window or a warning status. */
const PLAN_GUARD_OPTIONS = [
  { value: 'auto', label: 'Automatic' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' }
]

/** Concurrency choices; a saved value outside the list is added. */
const CONCURRENCY_CHOICES = [1, 2, 4, 8, 12, 16, 24, 32]

/**
 * A dollar amount typed freely and saved on blur or Enter (so "0.5" can be typed): empty, zero or not a number = no
 * limit (undefined).
 */
function UsdInput({ id, label, describedBy, testId, value, onCommit }: { id: string; label: string; describedBy: string; testId: string; value: number | undefined; onCommit: (v: number | undefined) => void }): ReactElement {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (): void => {
    if (draft === null) return
    const n = Number(draft)
    const next = draft.trim() && Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : undefined
    if (next !== value) onCommit(next)
    setDraft(null)
  }
  return (
    <Input
      id={id}
      aria-label={label}
      aria-describedby={describedBy}
      data-testid={testId}
      type="number"
      min={0}
      step={0.5}
      value={draft ?? (value ?? '')}
      placeholder="No limit"
      onChange={setDraft}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
    />
  )
}

/**
 * Day / month caps and the spend warning. Main measures project spend (runInsights.projectSpend) and enforces the caps
 * (runtime/spendGuard.ts: no start at a cap, a live run pauses or stops per onSpendLimit), so the rows are live.
 */
const PERIOD_CAPS_LIVE = true

/** "Spent so far: $1.20" for a period; runs without a known price are said, never counted as $0. */
function spentText(p: ProjectSpendPeriod | undefined, failed: boolean): string {
  if (failed) return 'Spend so far is not available.'
  if (!p) return 'Measuring spend so far…'
  const unknown = p.unknownRuns > 0 ? ` ${p.unknownRuns} ${p.unknownRuns === 1 ? 'run has' : 'runs have'} no known price and ${p.unknownRuns === 1 ? 'is' : 'are'} not counted.` : ''
  if (p.spentUsd <= 0 && p.unknownRuns > 0) return `Spend so far is unknown.${unknown}`
  return `Spent so far: ${p.unknownRuns > 0 ? 'at least ' : ''}${formatUsd(p.spentUsd)}.${unknown}`
}

/**
 * "Most agents in one run" (Project.maxAgentsPerRun): off = no total cap. Main counts per run session, so a continued
 * run starts a fresh count; the copy says so.
 */
function AgentsPerRunRow({ project, patch, rowId }: { project: Project; patch: (p: Partial<Project>) => void; rowId: string }): ReactElement {
  const on = project.maxAgentsPerRun !== undefined
  return (
    <>
      <SettingRow
        id={rowId}
        title="Limit how many agents one run starts"
        description="Counts every agent a run starts, not the first one. Counted per run session: continuing an ended run starts a new count. Off means no total limit."
        control={
          <Switch
            checked={on}
            label="Limit how many agents one run starts"
            testId="agents-per-run-switch"
            describedBy={settingDescId(rowId)}
            onChange={(v) => patch({ maxAgentsPerRun: v ? 20 : undefined })}
          />
        }
      />
      {on && (
        <SettingRow
          id={`${rowId}-n`}
          title="Most agents in one run"
          description={`From 1 to ${PROJECT_MAX_AGENTS_PER_RUN_LIMIT}. A run that reaches it cannot start more agents.`}
          width="number"
          control={
            <ClampedNumber
              id={`${rowId}-input`}
              label="Most agents in one run"
              describedBy={settingDescId(`${rowId}-n`)}
              min={1}
              max={PROJECT_MAX_AGENTS_PER_RUN_LIMIT}
              value={project.maxAgentsPerRun ?? 20}
              onCommit={(n) => patch({ maxAgentsPerRun: n })}
            />
          }
        />
      )}
    </>
  )
}

const WARN_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: '50', label: '50% of a limit' },
  { value: '80', label: '80% of a limit' },
  { value: '90', label: '90% of a limit' }
]

/**
 * "Warn me at" (AppSettings.spendWarnPercent, app-wide): read and written through settings directly, since this pane
 * belongs to a project. One notice per run and limit once spending reaches the share.
 */
function SpendWarnRow(): ReactElement {
  const [value, setValue] = useState<number | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    window.orgai.settings
      .get()
      .then((s) => live && setValue(s.spendWarnPercent ?? null))
      .catch(() => live && setValue(null))
    const off = window.orgai.onSettingsChanged((s) => setValue(s.spendWarnPercent ?? null))
    return () => {
      live = false
      off()
    }
  }, [])
  const save = async (v: string): Promise<void> => {
    const pct = v === 'off' ? null : Number(v)
    const before = value
    setValue(pct)
    setError(null)
    try {
      const s = await window.orgai.settings.get()
      const { dataDir: _d, appVersion: _v, ...settings } = s
      await useAppStore.getState().trackSave(() => window.orgai.settings.set({ ...settings, spendWarnPercent: pct }))
    } catch (e) {
      setValue(before)
      setError((e as Error).message)
    }
  }
  const options = value != null && !WARN_OPTIONS.some((o) => o.value === String(value)) ? [...WARN_OPTIONS, { value: String(value), label: `${value}% of a limit` }] : WARN_OPTIONS
  return (
    <SettingRow
      id="spend-warn-row"
      title="Warn me at"
      description={error ?? 'A notice in the run when spending reaches this share of a limit. Applies to every project.'}
      width="select"
      control={
        <Select
          label="Warn me at"
          describedBy={settingDescId('spend-warn-row')}
          value={value == null ? 'off' : String(value)}
          options={options}
          disabled={value === undefined}
          onChange={(v) => void save(v)}
        />
      }
    />
  )
}

/** Limits pane (config-review spec 4.3): a cost cap on metered projects or the plan guard line on a plan; the rest is Advanced. */
export function LimitsSection({ project, patch }: { project: Project; patch: (p: Partial<Project>) => void }): ReactElement {
  const uid = useId()
  const connections = useAppStore((s) => s.connections)
  const metering = projectMetering(project, connections)
  const metered = metering === 'metered'
  const copy = SETTINGS_COPY
  const row = (name: string): string => `${uid}-${name}-row`
  const desc = (name: string): string => settingDescId(row(name))

  const limits = effectiveSubagentLimits(project)
  const auto = effectiveSubagentLimits({ roles: project.roles })
  const depthOptions = [
    { value: 'auto', label: `Automatic (${auto.depth} from the chart)` },
    ...Array.from({ length: MAX_SUBAGENT_DEPTH_LIMIT }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))
  ]
  const concurrencyValues = limits.explicit.concurrency && !CONCURRENCY_CHOICES.includes(limits.concurrency) ? [...CONCURRENCY_CHOICES, limits.concurrency].sort((a, b) => a - b) : CONCURRENCY_CHOICES
  const concurrencyOptions = [{ value: 'auto', label: `Automatic (${auto.concurrency})` }, ...concurrencyValues.map((n) => ({ value: String(n), label: String(n) }))]

  const [spend, setSpend] = useState<ProjectSpend | null>(null)
  const [spendFailed, setSpendFailed] = useState(false)
  useEffect(() => {
    let live = true
    setSpend(null)
    setSpendFailed(false)
    window.orgai.runInsights
      .projectSpend(project.id)
      .then((v) => live && setSpend(v))
      .catch(() => live && setSpendFailed(true))
    return () => {
      live = false
    }
  }, [project.id, project.maxDailyUsd, project.maxMonthlyUsd])

  const costRow = (): ReactElement => (
    <SettingRow
      id={row('cost')}
      title={copy.costCap.label}
      description={copy.costCap.description}
      width="number"
      control={
        <Input
          id={`${uid}-cost`}
          aria-label={copy.costCap.label}
          aria-describedby={desc('cost')}
          type="number"
          min={0}
          step={0.5}
          value={project.maxBudgetUsd ?? ''}
          placeholder="No cap"
          onChange={(v) => patch({ maxBudgetUsd: v ? Number(v) : undefined })}
        />
      }
    />
  )

  const planRows: ReactNode = metered ? null : (
    <>
      <SettingRow
        id={row('guard')}
        title={copy.planGuard.label}
        description={copy.planGuard.description}
        width="select"
        control={
          <Select
            label={copy.planGuard.label}
            describedBy={desc('guard')}
            value={planGuardOf(project)}
            options={PLAN_GUARD_OPTIONS}
            onChange={(v) => {
              // Automatic clears both the field and its legacy mirror (reconcileNearLimitProject keeps them unset).
              const value = v === 'on' ? true : v === 'off' ? false : undefined
              patch({ preferEverydayNearLimit: value, preferSonnetNearLimit: value })
            }}
          />
        }
      />
      <SettingRow
        id={row('share')}
        title={copy.windowShare.label}
        description={copy.windowShare.description}
        width="number"
        control={
          <Input
            id={`${uid}-share`}
            aria-label={copy.windowShare.label}
            aria-describedby={desc('share')}
            type="number"
            min={1}
            max={100}
            placeholder="Off"
            value={project.maxWindowShare ?? ''}
            onChange={(e) => {
              const v = Number(e)
              patch({ maxWindowShare: e && Number.isFinite(v) && v > 0 ? Math.min(100, v) : undefined })
            }}
          />
        }
      />
      {costRow()}
    </>
  )

  // Day and month caps, what a live run does at a cap, and the app-wide warning: at rest for metered projects, in
  // Advanced on a plan sign-in (where spend is an estimate, not a bill). RunManager enforces them (spendGuard.ts).
  const periodCard = (
    <SettingsCard>
      {(
        [
          ['maxDailyUsd', 'One day', 'day'],
          ['maxMonthlyUsd', 'One month', 'month']
        ] as const
      ).map(([key, title, word]) => (
        <SettingRow
          key={key}
          id={row(key)}
          title={title}
          description={`Runs do not start, and live runs ${project.onSpendLimit === 'stop' ? 'stop' : 'pause'}, once this ${word}'s estimated spend reaches it. Counts runs and schedules. ${spentText(spend?.[word], spendFailed)}`}
          width="number"
          control={
            <UsdInput
              id={`${uid}-${key}`}
              label={`Spending limit for ${title.toLowerCase()}`}
              describedBy={desc(key)}
              testId={`limit-${word}-input`}
              value={project[key]}
              onCommit={(v) => patch({ [key]: v })}
            />
          }
        />
      ))}
      <SettingRow
        title="When a limit is reached"
        description="Either way nothing is lost and you can continue. A paused run waits until the period resets or you raise the limit."
        width="select"
        control={
          <SegmentedControl
            label="When a limit is reached"
            value={project.onSpendLimit ?? 'pause'}
            options={[
              { value: 'pause', label: 'Pause and ask me' },
              { value: 'stop', label: 'Stop the run' }
            ]}
            onChange={(onSpendLimit) => patch({ onSpendLimit })}
          />
        }
      />
      <SpendWarnRow />
    </SettingsCard>
  )

  return (
    <>
      <SettingsSection id="settings-section-limits" title="Spending limits">
        <MonthSpend project={project} />
        {metered && <SettingsCard>{costRow()}</SettingsCard>}
        {metering === 'subscription' && (
          <p className="perm-plan-line" data-testid="plan-guard-line">
            {planGuardLine(planGuardOf(project), project.maxWindowShare)}
          </p>
        )}
      </SettingsSection>

      {PERIOD_CAPS_LIVE && metered && (
        <SettingsSection id="settings-section-period-limits" title="Per day and per month" description="Counts every run and schedule in this project." testId="period-limits-section">
          {periodCard}
        </SettingsSection>
      )}

      <SettingsSection id="settings-section-run-size" title="How big a run can get">
        <SettingsCard>
          <SettingRow
            id={row('depth')}
            title={copy.maxSubagentDepth.label}
            description={copy.maxSubagentDepth.description}
            width="select"
            control={
              <Select
                id={`${uid}-depth`}
                label={copy.maxSubagentDepth.label}
                describedBy={desc('depth')}
                value={limits.explicit.depth ? String(limits.depth) : 'auto'}
                options={depthOptions}
                onChange={(v) => patch({ maxSubagentDepth: v === 'auto' ? undefined : Number(v) })}
              />
            }
          />
          <SettingRow
            id={row('conc')}
            title={copy.maxConcurrentSubagents.label}
            description={copy.maxConcurrentSubagents.description}
            width="select"
            control={
              <Select
                id={`${uid}-conc`}
                label={copy.maxConcurrentSubagents.label}
                describedBy={desc('conc')}
                value={limits.explicit.concurrency ? String(limits.concurrency) : 'auto'}
                options={concurrencyOptions}
                onChange={(v) => patch({ maxConcurrentSubagents: v === 'auto' ? undefined : Number(v) })}
              />
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsAdvanced paneKey="project-limits">
        {PERIOD_CAPS_LIVE && !metered && <SettingsGroup title="Per day and per month">{periodCard}</SettingsGroup>}
        <StaffingSettings project={project} patch={patch} />
        <SettingsGroup title="Runs and agents">
          <SettingsCard>
            {planRows}
            <AgentsPerRunRow project={project} patch={patch} rowId={row('agents')} />
            <SettingRow
              id={row('stronger')}
              title="Ask before using a more capable model"
              description="Today this only applies when you retry a failed agent and the retry would run it on a stronger model than its role normally uses. You are asked first, and if you say no it keeps the usual one."
              control={
                <Switch
                  checked={project.askBeforeStrongerModel === true}
                  label="Ask before using a more capable model"
                  testId="ask-stronger-switch"
                  describedBy={desc('stronger')}
                  onChange={(v) => patch({ askBeforeStrongerModel: v ? true : undefined })}
                />
              }
            />
            <SettingRow
              id={row('keep')}
              title={copy.keepRuns.label}
              description={copy.keepRuns.description}
              width="number"
              control={
                <ClampedNumber
                  id={`${uid}-keep`}
                  label={copy.keepRuns.label}
                  describedBy={desc('keep')}
                  min={1}
                  max={5000}
                  value={project.keepRuns ?? DEFAULT_KEEP_RUNS}
                  onCommit={(n) => patch({ keepRuns: n })}
                />
              }
            />
          </SettingsCard>
        </SettingsGroup>
      </SettingsAdvanced>
    </>
  )
}
