import type { ReactElement } from 'react'
import { useId } from 'react'
import type { Project } from '@shared/types'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { SettingRow } from '../ui/SettingRow'
import { Textarea } from '../ui/Textarea'
import { SettingsCard } from './SettingsCard'
import { SettingsSection } from './SettingsSection'

/** General pane (config-review spec 4.1): name, working directory (picked, never typed) and the project brief. */
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
            <div className="project-path-row">
              <code className="project-path" data-testid="project-path" title={project.path}>
                {project.path}
              </code>
              <Button
                onClick={async () => {
                  const dir = await window.orgai.projects.pickDirectory()
                  if (dir) patch({ path: dir })
                }}
              >
                Change folder
              </Button>
            </div>
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
