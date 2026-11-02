import type { ReactElement } from 'react'
import { TriangleAlert, X } from 'lucide-react'
import type { Project, Role } from '@shared/types'
import { projectProvenance, skillElevatedHint, skillScriptPaths } from '../../lib/skills'
import { roleSkillSplit } from '../../lib/roleCapabilities'
import { Badge } from '../ui/Badge'
import { IconButton } from '../ui/IconButton'
import { AddButton, CapabilityGroup } from '../team/CapabilityBlock'

/**
 * The Skills group of "What it can use": the skills this role holds as rows, each with its source, an Off badge when
 * the project switched it off, the elevated-script hint and a remove control. Names and descriptions are plain text.
 */
export default function RoleSkills({
  project,
  role,
  onChange,
  onAdd,
  onAsk
}: {
  project: Project
  role: Role
  onChange: (skills: string[]) => void
  onAdd: () => void
  onAsk?: () => void
}): ReactElement {
  const { granted } = roleSkillSplit(project.skills ?? [], role)
  return (
    <CapabilityGroup
      id="role-skills"
      testId="role-skills"
      title="Skills"
      summary={granted.length === 0 ? undefined : `${granted.length} ${granted.length === 1 ? 'skill' : 'skills'}`}
      actions={<AddButton label={`Add a skill to ${role.name}`} testId="role-add-skill" onClick={onAdd} />}
      empty={
        granted.length === 0
          ? {
              text: 'No skills yet. A skill is a how-to this role can load when a task needs it.',
              primaryLabel: 'Add a skill',
              primaryTestId: 'role-add-skill',
              onPrimary: onAdd,
              onAsk
            }
          : undefined
      }
    >
      <ul className="role-cap-list" aria-label={`Skills for ${role.name}`}>
        {granted.map((s) => {
          const hint = skillElevatedHint(skillScriptPaths(s.files))
          return (
            <li key={s.id} className="role-cap-row role-cap-skill" tabIndex={-1} data-testid="role-skill" data-name={s.name} data-cap-id={s.id} data-library-id={s.libraryId}>
              <span className="role-cap-text">
                <span className="role-service-name">{s.name}</span>
                {s.description && <span className="role-cap-sub">{s.description}</span>}
                <span className="role-cap-tags">
                  <Badge tone={s.libraryId ? 'info' : 'neutral'}>{projectProvenance(s)}</Badge>
                  {!s.enabled && <Badge title="This skill is off in the project, so runs do not get it.">Off</Badge>}
                  {hint && (
                    <Badge tone="attention" icon={TriangleAlert} testId="skill-elevated">
                      {hint}
                    </Badge>
                  )}
                </span>
              </span>
              <IconButton
                icon={X}
                size="sm"
                label={`Remove ${s.name} from ${role.name}`}
                testId="role-skill-remove"
                onClick={() => onChange((role.skills ?? []).filter((x) => x !== s.id))}
              />
            </li>
          )
        })}
      </ul>
    </CapabilityGroup>
  )
}
