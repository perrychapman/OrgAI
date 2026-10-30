import type { ReactElement } from 'react'
import { useState } from 'react'
import { BookOpen } from 'lucide-react'
import type { Project } from '@shared/types'
import { usedByLine, sourceLabel } from '../../lib/skills'
import { Badge } from '../ui/Badge'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { SkillRolePicker } from './SkillRoleAccess'
import { useSkillLibrary } from './useSkillLibrary'
import type { ProjectSkills } from './useSkills'

export interface SkillsLinked {
  /** Project skill ids that were linked, in order. */
  skillIds: string[]
  names: string[]
  roleCount: number
}

/** Add from library: link one or more entries this project does not use yet. The role picker is inline; nothing is selected by default. */
export default function AddSkillFromLibraryDialog({
  project,
  skillsApi,
  onLinked,
  onClose,
  onOpenLibrary
}: {
  project: Project
  skillsApi: ProjectSkills
  onLinked?: (linked: SkillsLinked) => void
  onClose: () => void
  /** Open App settings on the Skill library pane. */
  onOpenLibrary: () => void
}): ReactElement {
  const { library, error: loadError, refresh } = useSkillLibrary()
  const linked = new Set(skillsApi.skills.map((s) => s.spec.libraryId).filter(Boolean))
  const taken = new Set(skillsApi.skills.map((s) => s.spec.name))
  const all = library ?? []
  const available = all.filter((l) => !linked.has(l.entry.id))
  const [picks, setPicks] = useState<string[]>([])
  const [roles, setRoles] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const picked = available.filter((l) => picks.includes(l.entry.id) && !taken.has(l.entry.name))
  const canAdd = picked.length > 0

  const toggle = (id: string): void => setPicks((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))

  const add = async (): Promise<void> => {
    if (!canAdd) return
    setBusy(true)
    setError(null)
    const done: SkillsLinked = {
      skillIds: [],
      names: [],
      roleCount: roles.length
    }
    for (const l of picked) {
      try {
        const result = await skillsApi.linkLibrary(l.entry.id, roles)
        done.names.push(l.entry.name)
        const id = result.skills.find((s) => s.spec.libraryId === l.entry.id)?.spec.id
        if (id) done.skillIds.push(id)
      } catch (e) {
        setError(
          `${(e as Error).message}${done.names.length > 0 ? ` ${done.names.join(', ')} ${done.names.length === 1 ? 'was' : 'were'} added before that.` : ''}`
        )
        setPicks((p) => p.filter((x) => !picked.slice(0, done.names.length).some((d) => d.entry.id === x)))
        if (done.names.length > 0) onLinked?.(done)
        setBusy(false)
        return
      }
    }
    onLinked?.(done)
    onClose()
  }

  return (
    <Dialog
      open
      onClose={busy ? () => undefined : onClose}
      title="Add skills from the library"
      description="Edits in the library reach every project that links it."
      size="lg"
      testId="skill-link-dialog"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!canAdd} testId="skill-link-confirm" onClick={() => void add()}>
            {picked.length > 1 ? `Add ${picked.length} skills to project` : 'Add to project'}
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
        <div className="stack-2" data-testid="skill-link-empty">
          <p className="muted">
            {all.length === 0 ? 'The skill library is empty.' : 'Every library skill is already in this project.'} Skills you add to the library show up here.
          </p>
          <div>
            <Button size="sm" icon={BookOpen} testId="skill-link-open-library" onClick={onOpenLibrary}>
              Open the skill library
            </Button>
          </div>
        </div>
      ) : (
        available.length > 0 && (
          <>
            <fieldset className="mcp-vars">
              <legend>Library skills</legend>
              <ul className="mcp-pick-list">
                {available.map((l, i) => {
                  const clash = taken.has(l.entry.name)
                  const id = `skill-pick-${l.entry.id}`
                  return (
                    <li key={l.entry.id} className="mcp-pick">
                      <input
                        type="checkbox"
                        id={id}
                        checked={picks.includes(l.entry.id) && !clash}
                        disabled={clash}
                        data-autofocus={i === 0 ? '' : undefined}
                        data-testid="skill-pick"
                        data-name={l.entry.name}
                        onChange={() => toggle(l.entry.id)}
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
            <SkillRolePicker roles={project.roles} value={roles} onChange={setRoles} label="Role access" />
          </>
        )
      )}
    </Dialog>
  )
}
