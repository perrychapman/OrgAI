import type { ReactElement } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ClipboardCheck,
  Download,
  Ellipsis,
  ExternalLink,
  Library,
  LoaderCircle,
  Pencil,
  Plus,
  Sparkles,
  TriangleAlert,
  Trash2,
  Unlink,
  Upload
} from 'lucide-react'
import type { Project, SkillInfo } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { cleanIpcError } from '../../lib/ipcError'
import { requestSkillLibrary } from '../../lib/settingsTarget'
import {
  loadableByNoRole,
  projectProvenance,
  promotedNotice,
  removeConfirmCopy,
  skillAddedNotice,
  skillElevatedHint,
  type SkillAddVerb
} from '../../lib/skills'
import { Badge } from '../ui/Badge'
import { Banner } from '../ui/Banner'
import { Button } from '../ui/Button'
import { useConfirm } from '../ui/ConfirmDialog'
import { Icon } from '../ui/Icon'
import { Popover } from '../ui/Popover'
import { Switch } from '../ui/Switch'
import { CatalogGroup } from '../team/CatalogGroup'
import { UsedBy } from '../team/CatalogUsedBy'
import AddSkillFromLibraryDialog from './AddSkillFromLibraryDialog'
import SkillEvaluationPanel, { useSkillEvaluation } from './SkillEvaluationPanel'
import SkillForm from './SkillForm'
import SkillImportControls from './SkillImportControls'
import { SkillRoleAccess } from './SkillRoleAccess'
import { useProjectSkills, type ProjectSkills } from './useSkills'

type Modal = { kind: 'form'; editing?: SkillInfo } | { kind: 'link' } | null

/** A notice above the skill list. It stays until dismissed or replaced. */
interface SkillNotice {
  id: number
  tone: 'success' | 'warning' | 'info'
  title: string
  body?: string
  /** The skill a no-roles warning is about; the notice goes once a role holds it. */
  skillId?: string
  /** Optional action button. */
  action?: { label: string; testId: string; run: () => void }
}

/** A request addressed to one row: scroll to it and flash it, or open its Roles control. */
interface RowRequest {
  skillId: string
  n: number
}

const SCRIPT_EXT = /\.(sh|bash|zsh|ps1|bat|cmd|py|rb|pl|js|mjs|cjs|ts)$/i

/** Files of a skill that look like scripts (a scripts/ folder or an executable extension). */
function scriptFiles(info: SkillInfo): string[] {
  return info.spec.files.map((f) => f.path).filter((p) => /^scripts\//i.test(p) || (SCRIPT_EXT.test(p) && p !== 'SKILL.md'))
}

const reducedMotion = (): boolean =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true || document.documentElement.getAttribute('data-reduce-motion') === 'on'

/**
 * Team > Catalog > Skills: the project's skills, how to add them and the past-run suggestions. All skill text is
 * untrusted and rendered as plain text. `onSelectRole` makes the "Used by" chips select that role on the canvas.
 */
export default function SkillsSection({ project, onSelectRole }: { project: Project; onSelectRole?: (roleId: string) => void }): ReactElement {
  const skillsApi = useProjectSkills(project.id)
  const evaluation = useSkillEvaluation(project.id)
  const setView = useAppStore((s) => s.setView)
  const [askBusy, setAskBusy] = useState(false)
  const [askError, setAskError] = useState<string | null>(null)
  const [modal, setModal] = useState<Modal>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [notice, setNotice] = useState<SkillNotice | null>(null)
  const [flash, setFlash] = useState<RowRequest | null>(null)
  const [rolesRequest, setRolesRequest] = useState<RowRequest | null>(null)
  const seq = useRef(0)
  const { skills, loading, error } = skillsApi

  // A no-roles warning is stale as soon as a role can load that skill.
  useEffect(() => {
    const id = notice?.skillId
    if (id && skills.some((s) => s.spec.id === id && s.grantedTo.length > 0)) setNotice(null)
  }, [notice, skills])

  const openLibrary = useCallback((): void => {
    setModal(null)
    requestSkillLibrary()
    setView('appSettings')
  }, [setView])

  const showSkill = useCallback((skillId: string): void => setFlash({ skillId, n: ++seq.current }), [])
  const chooseRoles = useCallback((skillId: string): void => {
    setFlash({ skillId, n: ++seq.current })
    setRolesRequest({ skillId, n: ++seq.current })
  }, [])

  /** The success notice after a skill was added. With no roles chosen it says no agent loads it and offers "Choose roles". */
  const announceAdded = (name: string, verb: SkillAddVerb, roleCount: number, skillId: string | null): void => {
    const n = skillAddedNotice(name, verb, roleCount)
    setNotice({
      id: ++seq.current,
      tone: n.tone,
      title: n.title,
      body: n.body,
      skillId: skillId && roleCount === 0 ? skillId : undefined,
      action:
        skillId && roleCount === 0
          ? {
              label: 'Choose roles',
              testId: 'skill-notice-choose-roles',
              run: () => chooseRoles(skillId)
            }
          : undefined
    })
    if (skillId) showSkill(skillId)
  }

  const editSkill = (info: SkillInfo): void => {
    if (info.spec.libraryId) openLibrary()
    else setModal({ kind: 'form', editing: info })
  }

  // One Add button (header, or in the empty state): the three ways to add sit in its menu with the library link.
  const addMenu = (
    <Popover
      trigger={
        <>
          <Icon icon={Plus} size="sm" />
          Add a skill
          <Icon icon={ChevronDown} size="sm" />
        </>
      }
      triggerClassName={`btn${skills.length === 0 ? ' primary' : ''}`}
      triggerTestId="catalog-skills-add"
      label="Add a skill"
      role="group"
      placement="bottom-end"
      className="mcp-other-menu"
    >
      {({ close }) => (
        <div className="mcp-other-list">
          <Button
            variant="ghost"
            icon={Library}
            testId="skill-add-library"
            onClick={() => {
              close()
              setModal({ kind: 'link' })
            }}
          >
            Add from library
          </Button>
          <Button
            variant="ghost"
            icon={Plus}
            testId="skill-new"
            onClick={() => {
              close()
              setModal({ kind: 'form' })
            }}
          >
            New skill
          </Button>
          <Button
            variant="ghost"
            icon={Download}
            testId="skill-import"
            onClick={() => {
              close()
              setImportOpen(true)
            }}
          >
            Import skills
          </Button>
          <Button variant="ghost" icon={ExternalLink} testId="skill-manage-library" onClick={openLibrary}>
            Manage library
          </Button>
        </div>
      )}
    </Popover>
  )
  const askAssistant = async (): Promise<void> => {
    setAskBusy(true)
    setAskError(null)
    try {
      await useAppStore.getState().startSkillAssist({ scope: 'project', projectId: project.id })
    } catch (e) {
      setAskError(cleanIpcError(e, 'Could not start the Skill assistant.'))
    } finally {
      setAskBusy(false)
    }
  }
  const askButton = (
    <Button icon={Sparkles} testId="skill-ask-assistant" loading={askBusy} onClick={() => void askAssistant()}>
      Ask the Skill assistant
    </Button>
  )
  const evaluateButton = (
    <span aria-busy={evaluation.evaluating}>
      <Button
        size="sm"
        variant="ghost"
        icon={evaluation.evaluating ? LoaderCircle : ClipboardCheck}
        testId="skill-evaluate"
        className={evaluation.evaluating ? 'is-busy' : undefined}
        onClick={() => {
          if (!evaluation.evaluating) void evaluation.run()
        }}
      >
        {evaluation.evaluating ? 'Evaluating skills' : 'Evaluate skills'}
      </Button>
    </span>
  )

  return (
    <CatalogGroup
      id="catalog-section-skills"
      title="Skills"
      count={loading ? undefined : skills.length}
      description="Instructions an agent loads on demand when a task matches. You choose which roles may load each one."
      actions={
        loading ? undefined : (
          <>
            {askButton}
            {skills.length === 0 ? undefined : addMenu}
          </>
        )
      }
      testId="catalog-skills"
    >
      <div className="mcp-body" data-testid="skills-section">
        {askError && (
          <div role="alert">
            <Banner tone="danger" title="Could not start the Skill assistant" onDismiss={() => setAskError(null)}>
              {askError}
            </Banner>
          </div>
        )}
        {notice && (
          <Banner
            tone={notice.tone}
            title={notice.title}
            testId="skill-notice"
            onDismiss={() => setNotice(null)}
            actions={
              notice.action && (
                <Button size="sm" testId={notice.action.testId} onClick={notice.action.run}>
                  {notice.action.label}
                </Button>
              )
            }
          >
            {notice.body}
          </Banner>
        )}
        <SkillImportControls project={project} skillsApi={skillsApi} open={importOpen} onOpenChange={setImportOpen} />
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
            {addMenu}
          </div>
        ) : (
          <ul className="card-block mcp-list" aria-label="Skills">
            {skills.map((info) => (
              <SkillRow
                key={info.spec.id}
                info={info}
                project={project}
                skillsApi={skillsApi}
                onSelectRole={onSelectRole}
                flash={flash?.skillId === info.spec.id ? flash : null}
                rolesRequest={rolesRequest?.skillId === info.spec.id ? rolesRequest : null}
                onEdit={() => editSkill(info)}
                onChooseRoles={() => chooseRoles(info.spec.id)}
                onPromoted={(name) =>
                  setNotice({
                    id: ++seq.current,
                    tone: 'info',
                    title: promotedNotice(name),
                    action: {
                      label: 'Edit in library',
                      testId: 'skill-notice-edit-library',
                      run: openLibrary
                    }
                  })
                }
              />
            ))}
          </ul>
        )}

        <SkillEvaluationPanel
          project={project}
          skillsApi={skillsApi}
          evaluation={evaluation}
          onEditSkill={editSkill}
          onShowSkill={showSkill}
          onApplied={(a) => announceAdded(a.name, 'added', a.roleCount, a.skillId)}
          actions={evaluateButton}
        />

        {modal?.kind === 'form' && (
          <SkillForm
            key={modal.editing?.spec.id ?? 'new'}
            project={project}
            skillsApi={skillsApi}
            editing={modal.editing}
            onSaved={(s) => {
              if (s.created) announceAdded(s.name, 'created', s.roleCount, s.skillId)
            }}
            onClose={() => setModal(null)}
          />
        )}
        {modal?.kind === 'link' && (
          <AddSkillFromLibraryDialog
            project={project}
            skillsApi={skillsApi}
            onLinked={(l) => {
              if (l.names.length > 0) announceAdded(l.names.length === 1 ? l.names[0] : `${l.names.length} skills`, 'added', l.roleCount, l.skillIds[0] ?? null)
            }}
            onClose={() => setModal(null)}
            onOpenLibrary={openLibrary}
          />
        )}
      </div>
    </CatalogGroup>
  )
}

function SkillRow({
  info,
  project,
  skillsApi,
  onSelectRole,
  flash,
  rolesRequest,
  onEdit,
  onChooseRoles,
  onPromoted
}: {
  info: SkillInfo
  project: Project
  skillsApi: ProjectSkills
  onSelectRole?: (roleId: string) => void
  flash: RowRequest | null
  rolesRequest: RowRequest | null
  onEdit: () => void
  onChooseRoles: () => void
  onPromoted: (name: string) => void
}): ReactElement {
  const { spec } = info
  const linked = !!spec.libraryId
  const [error, setError] = useState<string | null>(null)
  const [rolesOpen, setRolesOpen] = useState(false)
  const [flashing, setFlashing] = useState(false)
  const row = useRef<HTMLLIElement>(null)
  const { confirm, dialog } = useConfirm()
  const hint = skillElevatedHint(scriptFiles(info))
  const noRole = loadableByNoRole(info, project.roles)

  // Scroll to the row and flash it for a moment (no flash, no smooth scroll under reduced motion).
  useEffect(() => {
    if (!flash) return undefined
    row.current?.scrollIntoView({
      block: 'nearest',
      behavior: reducedMotion() ? 'auto' : 'smooth'
    })
    if (reducedMotion()) return undefined
    setFlashing(true)
    const t = window.setTimeout(() => setFlashing(false), 1800)
    return () => window.clearTimeout(t)
  }, [flash])
  useEffect(() => {
    if (!rolesRequest) return
    setRolesOpen(true)
    row.current?.querySelector<HTMLElement>('[data-testid=skill-roles]')?.focus()
  }, [rolesRequest])

  const mutate = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setError(null)
    try {
      await fn()
      return true
    } catch (e) {
      setError((e as Error).message)
      return false
    }
  }

  const remove = async (): Promise<void> => {
    const roleNames = info.grantedTo.map((id) => project.roles.find((r) => r.id === id)?.name).filter((n): n is string => !!n)
    const copy = removeConfirmCopy(info, roleNames, linked ? 'unlink' : 'delete')
    if (
      await confirm({
        title: copy.title,
        body: <p>{copy.body}</p>,
        confirmLabel: copy.confirmLabel,
        danger: true
      })
    ) {
      await mutate(() => skillsApi.remove(spec.id))
    }
  }

  return (
    <li
      ref={row}
      className={`mcp-row skill-row${spec.enabled && !info.libraryMissing ? '' : ' off'}${info.libraryMissing || hint || noRole ? ' warn' : ''}${flashing ? ' is-flash' : ''}`}
      data-testid="skill-row"
      data-name={spec.name}
      data-id={spec.id}
    >
      <div className="mcp-row-main skill-row-main">
        <Switch
          checked={spec.enabled}
          label={`Enable ${spec.name}`}
          testId="skill-enabled"
          onChange={(enabled) => void mutate(() => skillsApi.update({ skillId: spec.id, enabled }))}
        />
        <div className="mcp-row-id">
          <span className="mcp-name mono">{spec.name}</span>
          <span className="skill-desc" title={spec.description}>
            {spec.description}
          </span>
        </div>
        <div className="mcp-row-meta">
          {linked ? (
            <Badge tone="accent" icon={Library} testId="skill-library-badge" title="Defined in your skill library">
              {projectProvenance(spec)}
            </Badge>
          ) : (
            <Badge>{projectProvenance(spec)}</Badge>
          )}
          {noRole && (
            <Badge tone="attention" icon={TriangleAlert} testId="skill-no-roles" title="This skill is on, but no role of this project may load it">
              No role can load this
            </Badge>
          )}
        </div>
        <div className="mcp-row-actions">
          <Button
            size="sm"
            icon={linked ? ExternalLink : Pencil}
            testId="skill-edit"
            ariaLabel={linked ? `Edit ${spec.name} in the library` : `Edit ${spec.name}`}
            title={linked ? 'Linked skills are edited in the skill library' : undefined}
            onClick={onEdit}
          >
            Edit
          </Button>
          <Popover
            trigger={<Icon icon={Ellipsis} size="sm" />}
            triggerClassName="icon-btn size-sm"
            triggerLabel={`More actions for ${spec.name}`}
            triggerTitle={`More actions for ${spec.name}`}
            label={`Actions for ${spec.name}`}
            role="group"
            placement="bottom-end"
            className="mcp-other-menu"
          >
            {({ close }) => (
              <div className="mcp-other-list">
                {!linked && (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={Upload}
                    testId="skill-promote"
                    title="Move this skill into your skill library and link it here"
                    onClick={() => {
                      close()
                      void mutate(() => skillsApi.promote(spec.id)).then((ok) => {
                        if (ok) onPromoted(spec.name)
                      })
                    }}
                  >
                    Promote to library
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  icon={linked ? Unlink : Trash2}
                  testId="skill-remove"
                  onClick={() => {
                    close()
                    void remove()
                  }}
                >
                  {linked ? 'Unlink...' : 'Delete skill...'}
                </Button>
              </div>
            )}
          </Popover>
        </div>
      </div>
      <div className="skill-row-roles">
        <UsedBy roles={project.roles.filter((r) => info.grantedTo.includes(r.id))} onSelectRole={onSelectRole} />
        <SkillRoleAccess
          skillName={spec.name}
          roles={project.roles}
          grantedTo={info.grantedTo}
          open={rolesOpen}
          onOpenChange={setRolesOpen}
          onChange={(roleIds) => void mutate(() => skillsApi.update({ skillId: spec.id, roleIds }))}
        />
        {noRole && project.roles.length > 0 && !rolesOpen && (
          <Button size="sm" variant="ghost" testId="skill-choose-roles" ariaLabel={`Choose roles for ${spec.name}`} onClick={onChooseRoles}>
            Choose roles
          </Button>
        )}
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
      {error && (
        <p className="invalid-text mcp-row-error" role="alert">
          {error}
        </p>
      )}
      {dialog}
    </li>
  )
}
