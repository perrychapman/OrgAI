import type { ReactElement } from 'react'
import { useState } from 'react'
import type { Project } from '@shared/types'
import { usedByLine, sourceLabel } from '../../lib/skills'
import { Badge } from '../ui/Badge'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { SkillRoleChecklist } from './SkillRoleAccess'
import { useSkillLibrary } from './useSkillLibrary'
import type { ProjectSkills } from './useSkills'

/** Add from library: link one entry this project does not use yet. Roles are optional; none is selected by default. */
export default function AddSkillFromLibraryDialog({
  project,
  skillsApi,
  onClose,
  onOpenLibrary
}: {
  project: Project
  skillsApi: ProjectSkills
  onClose: () => void
  onOpenLibrary: () => void
}): ReactElement {
  const { library, error: loadError, refresh } = useSkillLibrary()
  const linked = new Set(skillsApi.skills.map((s) => s.spec.libraryId).filter(Boolean))
  const taken = new Set(skillsApi.skills.map((s) => s.spec.name))
  const all = library ?? []
  const available = all.filter((l) => !linked.has(l.entry.id))
  const [pick, setPick] = useState<string | null>(null)
  const [roles, setRoles] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const picked = available.find((l) => l.entry.id === pick)
  const canAdd = !!picked && !taken.has(picked.entry.name)

  const add = async (): Promise<void> => {
    if (!picked) return
    setBusy(true)
    setError(null)
    try {
      await skillsApi.linkLibrary(picked.entry.id, roles)
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={busy ? () => undefined : onClose}
      title="Add a skill from the library"
      description="Edits in the library reach every project that links it."
      size="lg"
      testId="skill-link-dialog"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!canAdd} testId="skill-link-confirm" onClick={() => void add()}>
            Add to project
          </Button>
        </>
      }
    >
      {(error || loadError) && (
        <Banner
          tone="danger"
          title={error ? 'Could not add the skill' : 'Could not load the library'}
          actions={
            !error && (
              <Button size="sm" onClick={refresh}>
                Retry
              </Button>
            )
          }
        >
          {error ?? loadError}
        </Banner>
      )}
      {library === null && !loadError ? (
        <p className="muted" role="status">
          Loading the library
        </p>
      ) : available.length === 0 && !loadError ? (
        <div className="stack-2">
          <p className="muted">
            {all.length === 0 ? 'The skill library is empty.' : 'Every library skill is already in this project.'} Add skills to the library in App settings
            &gt; Skill library.
          </p>
          <div>
            <Button size="sm" onClick={onOpenLibrary}>
              Open App settings
            </Button>
          </div>
        </div>
      ) : (
        available.length > 0 && (
          <>
            <fieldset className="mcp-vars">
              <legend>Library skill</legend>
              <ul className="mcp-pick-list">
                {available.map((l, i) => {
                  const clash = taken.has(l.entry.name)
                  const id = `skill-pick-${l.entry.id}`
                  return (
                    <li key={l.entry.id} className="mcp-pick">
                      <input
                        type="radio"
                        id={id}
                        name="skill-link-pick"
                        checked={pick === l.entry.id}
                        disabled={clash}
                        data-autofocus={i === 0 ? '' : undefined}
                        data-testid="skill-pick"
                        data-name={l.entry.name}
                        onChange={() => setPick(l.entry.id)}
                      />
                      <label htmlFor={id}>
                        <span className="mcp-name">{l.entry.name}</span>
                        <span className="skill-desc">{l.entry.description}</span>
                        <span className="mcp-row-meta">
                          <Badge>{sourceLabel(l.entry.source)}</Badge>
                          <span className="muted">{usedByLine(l.usedBy)}</span>
                          {clash && <Badge tone="danger">Name already used in this project</Badge>}
                        </span>
                      </label>
                    </li>
                  )
                })}
              </ul>
            </fieldset>
            {picked && (
              <fieldset className="mcp-vars">
                <legend>Who can load it? (optional)</legend>
                <SkillRoleChecklist roles={project.roles} value={roles} onChange={setRoles} label="Role access" />
                {roles.length === 0 && project.roles.length > 0 && <span className="hint">No role gets it yet. You can grant it later.</span>}
              </fieldset>
            )}
          </>
        )
      )}
    </Dialog>
  )
}
