import type { ReactElement } from 'react'
import { useState } from 'react'
import { ClipboardCheck, Ellipsis, ExternalLink, Library, Pencil, Plus, Sparkles, TriangleAlert, Trash2, Unlink, Upload } from 'lucide-react'
import type { Project, SkillInfo } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { requestSkillLibrary } from '../../lib/settingsTarget'
import { removeConfirmCopy, skillElevatedHint, sourceLabel } from '../../lib/skills'
import { Badge } from '../ui/Badge'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { useConfirm } from '../ui/ConfirmDialog'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import { Switch } from '../ui/Switch'
import { SettingsSection } from '../settings/SettingsSection'
import AddSkillFromLibraryDialog from './AddSkillFromLibraryDialog'
import SkillEvaluationPanel, { useSkillEvaluation } from './SkillEvaluationPanel'
import SkillForm from './SkillForm'
import SkillImportControls from './SkillImportControls'
import { SkillRoleAccess } from './SkillRoleAccess'
import { useProjectSkills, type ProjectSkills } from './useSkills'

/** Section id of the App settings skill library; the page falls back to its first pane when it does not know the id. */

type Modal = { kind: 'form'; editing?: SkillInfo } | { kind: 'link' } | null

const SCRIPT_EXT = /\.(sh|bash|zsh|ps1|bat|cmd|py|rb|pl|js|mjs|cjs|ts)$/i

/** Files of a skill that look like scripts (a scripts/ folder or an executable extension). */
function scriptFiles(info: SkillInfo): string[] {
  return info.spec.files.map((f) => f.path).filter((p) => /^scripts\//i.test(p) || (SCRIPT_EXT.test(p) && p !== 'SKILL.md'))
}

/** Project Settings > Tools > Skills. All skill text is untrusted and rendered as plain text. */
export default function SkillsSection({ project }: { project: Project }): ReactElement {
  const skillsApi = useProjectSkills(project.id)
  const evaluation = useSkillEvaluation(project.id)
  const setView = useAppStore((s) => s.setView)
  const [modal, setModal] = useState<Modal>(null)
  const { skills, loading, error } = skillsApi

  const openLibrary = (): void => {
    setModal(null)
    requestSkillLibrary()
    setView('appSettings')
  }

  const actions = (
    <>
      <Button variant="primary" icon={Library} testId="skill-add-library" onClick={() => setModal({ kind: 'link' })}>
        Add from library
      </Button>
      <Button icon={Plus} testId="skill-new" onClick={() => setModal({ kind: 'form' })}>
        New skill
      </Button>
      <Button icon={ClipboardCheck} testId="skill-evaluate" loading={evaluation.evaluating} onClick={() => void evaluation.run()}>
        Evaluate skills
      </Button>
    </>
  )

  return (
    <SettingsSection
      id="settings-section-skills"
      title="Skills"
      description="Instructions an agent loads on demand when a task matches. You choose which roles may load each one."
      actions={actions}
      testId="skills-section"
    >
      <div className="mcp-body">
        <SkillImportControls project={project} skillsApi={skillsApi} />
        {error && (
          <Banner
            tone="danger"
            title="Skills problem"
            actions={
              <Button size="sm" onClick={() => void skillsApi.reload()}>
                Retry
              </Button>
            }
          >
            {error}
          </Banner>
        )}
        {loading ? (
          <div className="card-block mcp-list" aria-busy="true" aria-label="Loading skills">
            {[0, 1].map((i) => (
              <div key={i} className="card-sec">
                <div className="skeleton mcp-sk" />
              </div>
            ))}
          </div>
        ) : skills.length === 0 ? (
          <div className="card-block mcp-empty" data-testid="skills-empty">
            <Icon icon={Sparkles} size="lg" />
            <strong>No skills yet</strong>
            <p className="muted">Write one, add one from the library, or import the skills in your repository.</p>
          </div>
        ) : (
          <ul className="card-block mcp-list" aria-label="Skills">
            {skills.map((info) => (
              <SkillRow key={info.spec.id} info={info} project={project} skillsApi={skillsApi} onEdit={() => setModal({ kind: 'form', editing: info })} onOpenLibrary={openLibrary} />
            ))}
          </ul>
        )}

        <SkillEvaluationPanel project={project} skillsApi={skillsApi} evaluation={evaluation} />

        {modal?.kind === 'form' && (
          <SkillForm key={modal.editing?.spec.id ?? 'new'} project={project} skillsApi={skillsApi} editing={modal.editing} onClose={() => setModal(null)} />
        )}
        {modal?.kind === 'link' && <AddSkillFromLibraryDialog project={project} skillsApi={skillsApi} onClose={() => setModal(null)} onOpenLibrary={openLibrary} />}
      </div>
    </SettingsSection>
  )
}

function SkillRow({
  info,
  project,
  skillsApi,
  onEdit,
  onOpenLibrary
}: {
  info: SkillInfo
  project: Project
  skillsApi: ProjectSkills
  onEdit: () => void
  onOpenLibrary: () => void
}): ReactElement {
  const { spec } = info
  const linked = !!spec.libraryId
  const [menu, setMenu] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { confirm, dialog } = useConfirm()
  const hint = skillElevatedHint(scriptFiles(info))

  const mutate = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const remove = async (): Promise<void> => {
    const roleNames = info.grantedTo.map((id) => project.roles.find((r) => r.id === id)?.name).filter((n): n is string => !!n)
    const copy = removeConfirmCopy(info, roleNames, linked ? 'unlink' : 'delete')
    if (await confirm({ title: copy.title, body: <p>{copy.body}</p>, confirmLabel: copy.confirmLabel, danger: true })) {
      await mutate(() => skillsApi.remove(spec.id))
    }
  }

  return (
    <li
      className={`mcp-row skill-row${spec.enabled && !info.libraryMissing ? '' : ' off'}${info.libraryMissing || hint ? ' warn' : ''}`}
      data-testid="skill-row"
      data-name={spec.name}
      data-id={spec.id}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && menu) {
          setMenu(false)
          e.currentTarget.querySelector<HTMLElement>('.mcp-row-actions [aria-expanded]')?.focus()
        }
      }}
    >
      <div className="mcp-row-main skill-row-main">
        <Switch checked={spec.enabled} label={`Enable ${spec.name}`} testId="skill-enabled" onChange={(enabled) => void mutate(() => skillsApi.update({ skillId: spec.id, enabled }))} />
        <div className="mcp-row-id">
          <span className="mcp-name mono">{spec.name}</span>
          <span className="skill-desc" title={spec.description}>
            {spec.description}
          </span>
        </div>
        <div className="mcp-row-meta">
          {!linked && <Badge>{sourceLabel(spec.source)}</Badge>}
          {linked && (
            <Badge tone="accent" icon={Library} testId="skill-library-badge" title="Defined in your skill library">
              From library
            </Badge>
          )}
        </div>
        <div className="mcp-row-actions">
          {!linked && (
            <Button size="sm" icon={Pencil} ariaLabel={`Edit ${spec.name}`} onClick={onEdit}>
              Edit
            </Button>
          )}
          <IconButton icon={Ellipsis} label={`More actions for ${spec.name}`} size="sm" expanded={menu} onClick={() => setMenu((m) => !m)} />
        </div>
      </div>
      <div className="skill-row-roles">
        <SkillRoleAccess
          skillName={spec.name}
          roles={project.roles}
          grantedTo={info.grantedTo}
          onChange={(roleIds) => void mutate(() => skillsApi.update({ skillId: spec.id, roleIds }))}
        />
      </div>
      {info.libraryMissing && (
        <p className="mcp-row-note warn" role="status" data-testid="skill-library-missing">
          <Icon icon={TriangleAlert} size="sm" />
          <span>Its library entry was removed. Agents will not get this skill. Unlink it, or add it back to the library.</span>
        </p>
      )}
      {hint && (
        <p className="mcp-row-note warn" data-testid="skill-elevated">
          <Icon icon={TriangleAlert} size="sm" />
          <span>{hint}</span>
        </p>
      )}
      {menu && (
        <div className="mcp-menu" role="group" aria-label={`Actions for ${spec.name}`}>
          {linked ? (
            <>
              <Button
                size="sm"
                icon={ExternalLink}
                onClick={() => {
                  setMenu(false)
                  onOpenLibrary()
                }}
              >
                Edit in library
              </Button>
              <Button
                size="sm"
                variant="danger"
                icon={Unlink}
                testId="skill-remove"
                onClick={() => {
                  setMenu(false)
                  void remove()
                }}
              >
                Unlink...
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                icon={Pencil}
                onClick={() => {
                  setMenu(false)
                  onEdit()
                }}
              >
                Edit
              </Button>
              <Button
                size="sm"
                icon={Upload}
                testId="skill-promote"
                title="Move this skill into your skill library and link it here"
                onClick={() => {
                  setMenu(false)
                  void mutate(() => skillsApi.promote(spec.id))
                }}
              >
                Promote to library
              </Button>
              <Button
                size="sm"
                variant="danger"
                icon={Trash2}
                testId="skill-remove"
                onClick={() => {
                  setMenu(false)
                  void remove()
                }}
              >
                Delete skill...
              </Button>
            </>
          )}
        </div>
      )}
      {error && (
        <p className="invalid-text mcp-row-error" role="alert">
          {error}
        </p>
      )}
      {dialog}
    </li>
  )
}
