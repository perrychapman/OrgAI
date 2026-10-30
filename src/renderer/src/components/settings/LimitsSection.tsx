import type { ReactElement } from 'react'
import { useEffect, useId, useState } from 'react'
import type { Project } from '@shared/types'
import { DEFAULT_KEEP_RUNS } from '@shared/types'
import { MAX_CONCURRENT_SUBAGENTS_LIMIT, MAX_SUBAGENT_DEPTH_LIMIT } from '@shared/defaults'
import { useAppStore } from '../../store/useAppStore'
import { APP_SETTINGS_SECTIONS, requestAppSettingsSection } from '../../lib/settingsTarget'
import { SETTINGS_COPY } from '../../lib/settingsCopy'
import { Input } from '../ui/Input'
import { SettingRow } from '../ui/SettingRow'
import { Switch } from '../ui/Switch'
import { SettingsCard } from './SettingsCard'
import { SettingsSection } from './SettingsSection'

/** Whole-number field that lets the user clear it while typing; commits valid values clamped to min..max and restores on blur. */
function ClampedNumber({ id, label, value, min, max, onCommit }: { id: string; label: string; value: number; min: number; max: number; onCommit: (n: number) => void }): ReactElement {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <Input
      id={id}
      aria-label={label}
      type="number"
      min={min}
      max={max}
      value={draft ?? String(value)}
      onChange={(v) => {
        setDraft(v)
        const n = Number(v)
        if (v !== '' && Number.isFinite(n)) onCommit(Math.min(max, Math.max(min, Math.floor(n))))
      }}
      onBlur={() => setDraft(null)}
    />
  )
}

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
  return (
    <SettingsSection id="settings-section-limits" title="Limits">
      <SettingsCard>
        <SettingRow
          title={copy.costCap.label}
          description={copy.costCap.description}
          more={copy.costCap.more}
          width="number"
          control={
            <Input
              id={`${uid}-cost`}
              aria-label={copy.costCap.label}
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
          title={copy.keepRuns.label}
          description={copy.keepRuns.description}
          more={copy.keepRuns.more}
          width="number"
          control={<ClampedNumber id={`${uid}-keep`} label={copy.keepRuns.label} min={1} max={5000} value={project.keepRuns ?? DEFAULT_KEEP_RUNS} onCommit={(n) => patch({ keepRuns: n })} />}
        />
        <SettingRow
          title="Max subagent depth"
          description="1 means reports cannot spawn subagents."
          width="number"
          control={<ClampedNumber id={`${uid}-depth`} label="Max subagent depth" min={1} max={MAX_SUBAGENT_DEPTH_LIMIT} value={project.maxSubagentDepth} onCommit={(n) => patch({ maxSubagentDepth: n })} />}
        />
        <SettingRow
          title="Max concurrent subagents"
          description="Reports that may run at once across the org."
          width="number"
          control={
            <ClampedNumber
              id={`${uid}-conc`}
              label="Max concurrent subagents"
              min={1}
              max={MAX_CONCURRENT_SUBAGENTS_LIMIT}
              value={project.maxConcurrentSubagents}
              onCommit={(n) => patch({ maxConcurrentSubagents: n })}
            />
          }
        />
        <SettingRow
          title="Stop at a share of the five-hour window (%)"
          description="Stops a run that uses more than this share."
          more="The run is interrupted and waits for you; the orchestrator is told why with your next message. Blank turns it off."
          width="number"
          control={
            <Input
              id={`${uid}-share`}
              aria-label="Stop when one run uses more than this percent of the five-hour window"
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
          control={<Switch checked={!!project.preferSonnetNearLimit} label={copy.preferSonnet.label} onChange={(v) => patch({ preferSonnetNearLimit: v })} />}
        />
      </SettingsCard>
    </SettingsSection>
  )
}
