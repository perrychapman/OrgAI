import type { ReactElement } from 'react'
import { useId } from 'react'
import type { PermissionMode, Project } from '@shared/types'
import { DEFAULT_MAX_AUTO_CONTINUES, PERMISSION_MODE_OPTIONS } from '@shared/types'
import { MAX_AUTO_CONTINUES_LIMIT, runMessagingOn } from '@shared/defaults'
import PermissionRulesPanel from '../PermissionRulesPanel'
import { Select } from '../ui/Select'
import { SettingRow, settingDescId } from '../ui/SettingRow'
import { Switch } from '../ui/Switch'
import { SETTINGS_COPY } from '../../lib/settingsCopy'
import { ClampedNumber } from './ClampedNumber'
import { SettingsCard } from './SettingsCard'
import { SettingsSection } from './SettingsSection'

/** Short names for the select; the full wording from PERMISSION_MODE_OPTIONS is the one line shown for the selected mode. */
const SHORT: Record<PermissionMode, string> = {
  auto: 'Unattended',
  acceptEdits: 'Auto-accept edits',
  default: 'Ask for risky actions',
  dontAsk: 'Never ask',
  plan: 'Plan only',
  bypassPermissions: 'Bypass all prompts'
}

/** Agents pane: what agents may do unasked, the saved rules, and how unattended runs behave. */
export function AgentsSection({ project, patch }: { project: Project; patch: (p: Partial<Project>) => void }): ReactElement {
  const id = useId()
  const current = PERMISSION_MODE_OPTIONS.find((o) => o.value === project.permissionMode)
  const copy = SETTINGS_COPY
  const autoOn = project.autoContinue !== false
  const isolated = project.isolateWriters !== false
  const row = (name: string): string => `${id}-${name}`
  return (
    <>
      <SettingsSection id="settings-section-permissions" title="Permissions">
        <SettingsCard>
          <SettingRow
            id={row('mode-row')}
            title={copy.permissionMode.label}
            description={current?.label.replace(/^[^:]*: /, '')}
            width="select"
            more={copy.permissionMode.more}
            control={
              <Select
                id={row('mode')}
                label={copy.permissionMode.label}
                describedBy={settingDescId(row('mode-row'))}
                value={project.permissionMode}
                options={PERMISSION_MODE_OPTIONS.map((o) => ({ value: o.value, label: SHORT[o.value] ?? o.label }))}
                onChange={(v) => patch({ permissionMode: v as PermissionMode })}
              />
            }
          />
        </SettingsCard>
      </SettingsSection>

      <PermissionRulesPanel project={project} />

      <SettingsSection id="settings-section-behaviour" title="Behaviour">
        <SettingsCard>
          <SettingRow
            id={row('auto-row')}
            title={copy.autoContinue.label}
            description={copy.autoContinue.description}
            control={<Switch checked={autoOn} label={copy.autoContinue.label} describedBy={settingDescId(row('auto-row'))} onChange={(v) => patch({ autoContinue: v })} />}
          />
          <SettingRow
            title={copy.maxAutoContinues.label}
            width="number"
            control={
              <ClampedNumber
                label={copy.maxAutoContinues.label}
                min={0}
                max={MAX_AUTO_CONTINUES_LIMIT}
                disabled={!autoOn}
                value={project.maxAutoContinues ?? DEFAULT_MAX_AUTO_CONTINUES}
                onCommit={(n) => patch({ maxAutoContinues: n })}
              />
            }
          />
          <SettingRow
            id={row('iso-row')}
            title={copy.isolateWriters.label}
            description={copy.isolateWriters.description}
            more={copy.isolateWriters.more}
            control={<Switch checked={isolated} label={copy.isolateWriters.label} describedBy={settingDescId(row('iso-row'))} onChange={(v) => patch({ isolateWriters: v })} />}
          />
          <SettingRow
            id={row('review-row')}
            title="Review each report's changes before merge"
            description="You merge, hold or discard each diff."
            control={
              <Switch
                checked={!!project.reviewMerges}
                disabled={!isolated}
                label="Review each report's changes before merge"
                describedBy={settingDescId(row('review-row'))}
                onChange={(v) => patch({ reviewMerges: v })}
              />
            }
          />
          <SettingRow
            id={row('msg-row')}
            title="Let runs message each other"
            description="Orchestrators can exchange short notes."
            more="Orchestrators of this project's runs can read each other's prompts and exchange short notes. Off by default; messages between projects need it on in both."
            control={<Switch checked={runMessagingOn(project)} label="Let runs message each other" describedBy={settingDescId(row('msg-row'))} onChange={(next) => patch({ runMessaging: next })} />}
          />
        </SettingsCard>
      </SettingsSection>
    </>
  )
}
