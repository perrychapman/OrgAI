import type { ReactElement } from 'react'
import { useId } from 'react'
import type { Project } from '@shared/types'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { SettingRow } from '../ui/SettingRow'
import { Textarea } from '../ui/Textarea'
import { SettingsCard } from './SettingsCard'
import { SettingsSection } from './SettingsSection'

export function GeneralSection({ project, patch }: { project: Project; patch: (p: Partial<Project>) => void }): ReactElement {
  const uid = useId()
  return (
    <SettingsSection id="settings-section-general" title="General">
      <SettingsCard>
        <SettingRow
          title="Name"
          width="select"
          control={<Input id={`${uid}-name`} aria-label="Name" value={project.name} onChange={(v) => patch({ name: v })} />}
        />
        <SettingRow
          title="Working directory"
          width="full"
          control={
            <>
              <Input id={`${uid}-path`} aria-label="Working directory" mono value={project.path} onChange={(v) => patch({ path: v })} />
              <Button
                onClick={async () => {
                  const dir = await window.orgai.projects.pickDirectory()
                  if (dir) patch({ path: dir })
                }}
              >
                Browse
              </Button>
            </>
          }
        />
        <SettingRow
          title="Project brief"
          width="full"
          hint="Added to every role's prompt and used by the drafter."
          control={<Textarea id={`${uid}-brief`} aria-label="Project brief" rows={4} value={project.brief} onChange={(v) => patch({ brief: v })} />}
        />
      </SettingsCard>
    </SettingsSection>
  )
}
