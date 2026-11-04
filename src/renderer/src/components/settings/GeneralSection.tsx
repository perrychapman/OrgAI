import type { ReactElement } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import type { Project } from '@shared/types'
import { PROJECT_CLIENT_MAX_CHARS } from '@shared/types'
import { projectKindOf } from '@shared/defaults'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { SettingRow } from '../ui/SettingRow'
import { Textarea } from '../ui/Textarea'
import { projectKindLine } from '../../lib/settingsCopy'
import { useAppStore } from '../../store/useAppStore'
import { SettingsCard } from './SettingsCard'
import { SettingsSection } from './SettingsSection'

/**
 * "Client or case" (engagements). Typing saves through the pane's debounced path; leaving the field saves at once and
 * shows the value main returns (trimmed, hidden characters dropped). Empty clears it.
 */
function ClientField({ id, project, patch }: { id: string; project: Project; patch: (p: Partial<Project>) => void }): ReactElement {
  const [draft, setDraft] = useState(project.client ?? '')
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const focused = useRef(false)
  const msgId = `${id}-msg`
  // Follow the stored value (a settings proposal can change it) unless the user is typing.
  useEffect(() => {
    if (!focused.current) setDraft(project.client ?? '')
  }, [project.id, project.client])
  return (
    <>
      <Input
        id={id}
        aria-label="Client or case"
        aria-describedby={error || note ? msgId : undefined}
        invalid={!!error}
        maxLength={PROJECT_CLIENT_MAX_CHARS}
        value={draft}
        data-testid="project-client-input"
        onFocus={() => {
          focused.current = true
        }}
        onChange={(v) => {
          setDraft(v)
          setError(null)
          setNote(null)
          patch({ client: v === '' ? undefined : v })
        }}
        onBlur={() => {
          focused.current = false
          const st = useAppStore.getState()
          const current = st.projects.find((p) => p.id === project.id) ?? project
          const value = draft.trim()
          if (value === (current.client ?? '')) {
            setDraft(value)
            return
          }
          const updated: Project = { ...current, client: value === '' ? undefined : value }
          // Replace any pending debounced save with this snapshot first, so an older one cannot land after it.
          st.updateProject(updated)
          st.saveProjectNow(updated)
            .then((saved) => {
              const kept = saved.client ?? ''
              setDraft(kept)
              setError(null)
              if (kept === value) setNote(null)
              else setNote(kept ? `OrgAI kept: ${kept}` : 'OrgAI could not keep that name (hidden characters).')
            })
            .catch((e: unknown) => {
              setNote(null)
              setError(`Could not save: ${e instanceof Error ? e.message : 'try again'}`)
            })
        }}
      />
      {error ? (
        <span id={msgId} className="field-msg error" role="alert" data-testid="project-client-error">
          {error}
        </span>
      ) : note ? (
        <span id={msgId} className="field-msg" role="status" data-testid="project-client-note">
          {note}
        </span>
      ) : null}
    </>
  )
}

/** General pane (config-review spec 4.1): name, working directory (picked, never typed) and the project brief. */
export function GeneralSection({ project, patch }: { project: Project; patch: (p: Partial<Project>) => void }): ReactElement {
  const uid = useId()
  const kind = projectKindOf(project)
  return (
    <SettingsSection id="settings-section-general" title="General">
      <SettingsCard>
        <p className="settings-card-note project-kind-line" data-testid="project-kind-line" data-kind={kind}>
          {projectKindLine(kind)}
        </p>
        <SettingRow
          title="Name"
          width="select"
          control={<Input id={`${uid}-name`} aria-label="Name" value={project.name} onChange={(v) => patch({ name: v })} />}
        />
        {kind === 'engagement' && (
          <SettingRow
            title="Client or case"
            width="select"
            control={<ClientField id={`${uid}-client`} project={project} patch={patch} />}
          />
        )}
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
