import type { ReactElement } from 'react'
import { useId } from 'react'
import type { Project } from '@shared/types'
import { runMessagingOn } from '@shared/defaults'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { SettingRow } from '../ui/SettingRow'
import { Switch } from '../ui/Switch'
import { Textarea } from '../ui/Textarea'
import { SettingsSection } from './SettingsSection'

export function GeneralSection({ project, patch }: { project: Project; patch: (p: Partial<Project>) => void }): ReactElement {
  const uid = useId()
  return (
    <SettingsSection id="settings-section-general" title="General">
      <div className="field">
        <label htmlFor={`${uid}-name`}>Name</label>
        <Input id={`${uid}-name`} value={project.name} onChange={(v) => patch({ name: v })} />
      </div>
      <div className="field">
        <label htmlFor={`${uid}-path`}>Working directory</label>
        <div className="row gap-2">
          <div className="grow">
            <Input id={`${uid}-path`} mono value={project.path} onChange={(v) => patch({ path: v })} />
          </div>
          <Button
            onClick={async () => {
              const dir = await window.orgai.projects.pickDirectory()
              if (dir) patch({ path: dir })
            }}
          >
            Browse
          </Button>
        </div>
      </div>
      <div className="field">
        <label htmlFor={`${uid}-brief`}>Project brief</label>
        <Textarea id={`${uid}-brief`} rows={5} value={project.brief} onChange={(v) => patch({ brief: v })} aria-describedby={`${uid}-brief-hint`} />
        <span className="hint" id={`${uid}-brief-hint`}>
          Appended to every role&apos;s system prompt and used by the org chart drafter.
        </span>
      </div>
      <SettingRow
        title="Let runs message each other"
        description="Orchestrators of this project's runs can read each other's prompts and exchange short notes. Off by default; messages between projects need it on in both."
        control={<Switch checked={runMessagingOn(project)} label="Let runs message each other" onChange={(next) => patch({ runMessaging: next })} />}
      />
    </SettingsSection>
  )
}
