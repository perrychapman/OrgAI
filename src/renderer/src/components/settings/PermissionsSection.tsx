import type { ReactElement } from 'react'
import { useId } from 'react'
import type { PermissionMode, Project } from '@shared/types'
import { PERMISSION_MODE_OPTIONS } from '@shared/types'
import PermissionRulesPanel from '../PermissionRulesPanel'
import { Select } from '../ui/Select'
import { SettingsSection } from './SettingsSection'

/** Short names for the select; the full wording from PERMISSION_MODE_OPTIONS is the description shown below it. */
const SHORT: Record<PermissionMode, string> = {
  auto: 'Unattended',
  acceptEdits: 'Auto-accept edits',
  default: 'Ask for risky actions',
  dontAsk: 'Never ask',
  plan: 'Plan only',
  bypassPermissions: 'Bypass all prompts'
}

export function PermissionsSection({ project, patch }: { project: Project; patch: (p: Partial<Project>) => void }): ReactElement {
  const id = useId()
  const current = PERMISSION_MODE_OPTIONS.find((o) => o.value === project.permissionMode)
  return (
    <SettingsSection id="settings-section-permissions" title="Permissions" description="What agents may do without asking you first.">
      <div className="field">
        <label htmlFor={`${id}-mode`}>Permission mode</label>
        <Select
          id={`${id}-mode`}
          value={project.permissionMode}
          options={PERMISSION_MODE_OPTIONS.map((o) => ({ value: o.value, label: SHORT[o.value] ?? o.label }))}
          onChange={(v) => patch({ permissionMode: v as PermissionMode })}
        />
        <span className="hint">
          {current?.label}.{' '}
          {project.permissionMode === 'auto'
            ? 'Unattended mode still asks when the classifier is unsure; saved rules below never ask.'
            : 'Prompts appear as approval cards in the live view.'}
        </span>
      </div>
      <PermissionRulesPanel project={project} />
    </SettingsSection>
  )
}
