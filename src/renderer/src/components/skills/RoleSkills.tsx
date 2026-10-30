import type { ReactElement } from 'react'
import { useId, useState } from 'react'
import { ChevronDown, ChevronRight, TriangleAlert } from 'lucide-react'
import type { Project, Role } from '@shared/types'
import { skillElevatedHint, skillScriptPaths, sourceLabel } from '../../lib/skills'
import { Badge } from '../ui/Badge'
import { Checkbox } from '../ui/Checkbox'
import { Icon } from '../ui/Icon'

/**
 * Skills a role may load: a collapsed disclosure over the project's skills as checkboxes. Grants are written to
 * Role.skills through the inspector's normal role edit. Skill names and descriptions are plain text, never markup.
 */
export default function RoleSkills({ project, role, onChange }: { project: Project; role: Role; onChange: (skills: string[]) => void }): ReactElement {
  const [open, setOpen] = useState(false)
  const panel = useId()
  const skills = project.skills ?? []
  const granted = new Set(role.skills ?? [])
  const count = skills.filter((s) => granted.has(s.id)).length
  const toggle = (skillId: string): void => {
    const next = granted.has(skillId) ? (role.skills ?? []).filter((x) => x !== skillId) : [...(role.skills ?? []), skillId]
    onChange(next)
  }
  return (
    <section className="stack-2 role-skills" data-testid="role-skills">
      <button type="button" className="role-skills-toggle" aria-expanded={open} aria-controls={open ? panel : undefined} onClick={() => setOpen((o) => !o)}>
        <Icon icon={open ? ChevronDown : ChevronRight} size="sm" />
        <span className="side-section-title">Skills</span>
        <span className="muted">
          {'·'} {count} of {skills.length}
        </span>
      </button>
      {open &&
        (skills.length === 0 ? (
          <p id={panel} className="hint">
            No skills in this project yet. Add them in Project settings &gt; Tools.
          </p>
        ) : (
          <ul id={panel} className="role-skills-list" aria-label={`Skills for ${role.name}`}>
            {skills.map((s) => {
              const hint = skillElevatedHint(skillScriptPaths(s.files))
              return (
                <li key={s.id} className="role-skill" data-testid="role-skill" data-name={s.name}>
                  <Checkbox
                    checked={granted.has(s.id)}
                    disabled={!s.enabled && !granted.has(s.id)}
                    onChange={() => toggle(s.id)}
                    label={s.name}
                    description={s.description}
                    title={s.enabled ? undefined : 'This skill is off in the project, so runs do not get it.'}
                  />
                  <span className="role-skill-tags">
                    <Badge>{sourceLabel(s.source)}</Badge>
                    {s.libraryId && <Badge tone="info">From library</Badge>}
                    {!s.enabled && <Badge>Off</Badge>}
                    {hint && (
                      <Badge tone="attention" icon={TriangleAlert}>
                        {hint}
                      </Badge>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
        ))}
    </section>
  )
}
