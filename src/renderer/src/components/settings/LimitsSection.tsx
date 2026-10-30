import type { ReactElement } from 'react'
import { useEffect, useId, useState } from 'react'
import type { Project } from '@shared/types'
import { DEFAULT_KEEP_RUNS } from '@shared/types'
import { MAX_CONCURRENT_SUBAGENTS_LIMIT, MAX_SUBAGENT_DEPTH_LIMIT } from '@shared/defaults'
import { useAppStore } from '../../store/useAppStore'
import { APP_SETTINGS_SECTIONS, requestAppSettingsSection } from '../../lib/settingsTarget'
import { SETTINGS_COPY } from '../../lib/settingsCopy'
import { Input } from '../ui/Input'
import { SettingRow, settingDescId } from '../ui/SettingRow'
import { Switch } from '../ui/Switch'
import { ClampedNumber } from './ClampedNumber'
import { SettingsCard } from './SettingsCard'
import { SettingsSection } from './SettingsSection'

const SHARE_LABEL = 'Stop at a share of the five-hour window (%)'

/** Limits pane: cost cap, retention, subagent caps, the five-hour window cap and the Sonnet fallback. */
export function LimitsSection({ project, patch }: { project: Project; patch: (p: Partial<Project>) => void }): ReactElement {
  const uid = useId()
  const setView = useAppStore((s) => s.setView)
  const [opusGuard, setOpusGuard] = useState<number | null>(null)
  useEffect(() => {
    window.orgai.settings
      .get()
      .then((s) => setOpusGuard(s.opusGuardThreshold))
      .catch(() => setOpusGuard(null))
  }, [])
  const copy = SETTINGS_COPY
  const row = (name: string): string => `${uid}-${name}-row`
  const desc = (name: string): string => settingDescId(row(name))
  return (
    <SettingsSection id="settings-section-limits" title="Limits">
      <SettingsCard>
        <SettingRow
          id={row('cost')}
          title={copy.costCap.label}
          description={copy.costCap.description}
          more={copy.costCap.more}
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
          title="Max subagent depth"
          description="1 means reports cannot spawn subagents."
          width="number"
          control={
            <ClampedNumber
              id={`${uid}-depth`}
              label="Max subagent depth"
              describedBy={desc('depth')}
              min={1}
              max={MAX_SUBAGENT_DEPTH_LIMIT}
              value={project.maxSubagentDepth}
              onCommit={(n) => patch({ maxSubagentDepth: n })}
            />
          }
        />
        <SettingRow
          id={row('conc')}
          title="Max concurrent subagents"
          description="Reports that may run at once across the org."
          width="number"
          control={
            <ClampedNumber
              id={`${uid}-conc`}
              label="Max concurrent subagents"
              describedBy={desc('conc')}
              min={1}
              max={MAX_CONCURRENT_SUBAGENTS_LIMIT}
              value={project.maxConcurrentSubagents}
              onCommit={(n) => patch({ maxConcurrentSubagents: n })}
            />
          }
        />
        <SettingRow
          id={row('share')}
          title={SHARE_LABEL}
          description="Stops a run that uses more than this share."
          more="The run is interrupted and waits for you; the orchestrator is told why with your next message. Blank turns it off."
          width="number"
          control={
            <Input
              id={`${uid}-share`}
              aria-label={SHARE_LABEL}
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
        <SettingRow
          id={row('sonnet')}
          title={copy.preferSonnet.label}
          description={copy.preferSonnet.description}
          more={copy.preferSonnet.more}
          hint={
            <>
              Threshold: {opusGuard ?? 80}% ·{' '}
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  requestAppSettingsSection(APP_SETTINGS_SECTIONS.usage)
                  setView('appSettings')
                }}
              >
                Change in App settings
              </button>
            </>
          }
          control={<Switch checked={!!project.preferSonnetNearLimit} label={copy.preferSonnet.label} describedBy={desc('sonnet')} onChange={(v) => patch({ preferSonnetNearLimit: v })} />}
        />
      </SettingsCard>
    </SettingsSection>
  )
}
