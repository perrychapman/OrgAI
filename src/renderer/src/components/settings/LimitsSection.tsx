import type { ReactElement, ReactNode } from 'react'
import { useId } from 'react'
import type { Project } from '@shared/types'
import { DEFAULT_KEEP_RUNS } from '@shared/types'
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
import { SettingsGroup, SettingsSection } from './SettingsSection'

/** planGuardOf modes: Automatic (unset) engages on a plan with a weekly window or a warning status. */
const PLAN_GUARD_OPTIONS = [
  { value: 'auto', label: 'Automatic' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' }
]

/** Concurrency choices; a saved value outside the list is added. */
const CONCURRENCY_CHOICES = [1, 2, 4, 8, 12, 16, 24, 32]

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

  return (
    <>
      <SettingsSection id="settings-section-limits" title="Limits">
        {metered && <SettingsCard>{costRow()}</SettingsCard>}
        {metering === 'subscription' && (
          <p className="perm-plan-line" data-testid="plan-guard-line">
            {planGuardLine(planGuardOf(project), project.maxWindowShare)}
          </p>
        )}
      </SettingsSection>

      <SettingsAdvanced paneKey="project-limits">
        <SettingsGroup title="Runs and agents">
          <SettingsCard>
            {planRows}
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
        </SettingsGroup>
      </SettingsAdvanced>
    </>
  )
}
