import type { KeyboardEvent, ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Eye, Trash2 } from 'lucide-react'
import type { Project, Role } from '@shared/types'
import RoleModelPicker from './RoleModelPicker'
import RoleCapabilities from './team/RoleCapabilities'
import RoleStaffingControls from './team/RoleStaffingControls'
import RoleDelegation from './team/RoleDelegation'
import RoleModelSentence from './team/RoleModelSentence'
import type { CapabilityKind } from './team/CapabilityBlock'
import { ROLE_COLORS, slugify } from '@shared/defaults'
import { useAppStore } from '../store/useAppStore'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Textarea } from './ui/Textarea'
import { initials } from '../lib/layout'
import { parentOptions, renamePatch, setReportsTo, settleRename, renameSnapshot, slugFieldEdit, type RenameStart } from '../lib/roleOps'

/** The description a new role is seeded with (TeamView, the CLI). The editor shows it as a placeholder and treats it as empty. */
const SEEDED_DESCRIPTION = 'Describe when a manager should delegate to this role.'

interface Props {
  project: Project
  role: Role
  /**
   * Reports to changed in this editor (phase 2: no inline banner). `before` is the team just before the change; the view
   * shows "{Role} now reports to {Manager}." with Undo in the notice row.
   */
  onReportsToChanged?: (roleId: string, before: Role[]) => void
  /** A rename cleanup that failed (whether or not this inspector still shows that role): the view's notice row shows it. */
  onSettleError?: (text: string) => void
  /** Remove goes through the view's confirm dialog and undo row. */
  onRemove: () => void
  /** Escape inside the inspector hands focus back to the node. */
  onEscape?: () => void
  /** Kept for the capability groups; ignored until the Suggestions drawer takes over (phase 3). */
  onAskAssistant?: (scope: CapabilityKind) => void
  /** Opens the Add role popover with this role as the parent (the delegation section's empty state). */
  onAddReport?: () => void
}

const sameIds = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => {
  const x = a ?? []
  const y = b ?? []
  return x.length === y.length && x.every((v, i) => v === y[i])
}

export default function RoleInspector({ project, role, onReportsToChanged, onSettleError, onRemove, onEscape, onAskAssistant, onAddReport }: Props): ReactElement {
  const updateRoles = useAppStore((s) => s.updateRoles)
  const replaceProject = useAppStore((s) => s.replaceProject)
  const isRoot = role.reportsTo === null
  const id = (name: string): string => `role-${name}`
  // On a short or narrow window "Model and effort" stays folded behind its one-line sentence; every other section is open.
  const [roomy] = useState(() => window.innerHeight >= 800 && window.innerWidth >= 1280)

  const patch = (p: Partial<Role>): void =>
    updateRoles(project.id, (roles) => roles.map((r) => (r.id === role.id ? { ...r, ...p } : r)))

  const changeParent = (value: string): void => {
    const reportsTo = value || null
    const before = useAppStore.getState().projects.find((p) => p.id === project.id)?.roles ?? project.roles
    if (before.find((r) => r.id === role.id)?.reportsTo === reportsTo) return
    updateRoles(project.id, (roles) => setReportsTo(roles, role.id, reportsTo))
    onReportsToChanged?.(role.id, before)
  }

  // Review H1 / M3: a Name or Slug edit is computed against the role as it was when the edit began, and settled once
  // when it ends (blur, switching role or project, closing the inspector). See renamePatch and settleRename in lib/roleOps.
  // `wrote` is the Role.mcpServers this edit last put in the store; anything else there means a change from outside.
  const renameStart = useRef<(RenameStart & { projectId: string; wrote: string[] | undefined }) | null>(null)
  // `project/role` the inspector shows now; null once it closed.
  const shownKey = useRef<string | null>(`${project.id}/${role.id}`)
  const settleErrorRef = useRef(onSettleError)
  useEffect(() => {
    shownKey.current = `${project.id}/${role.id}`
    settleErrorRef.current = onSettleError
  })
  /**
   * Takes the start snapshot on focus, or on the first keystroke when no focus event came (autofocus, scripted input).
   * An open edit of another role or project, or one whose grants changed from outside (review L), is settled first and
   * a fresh snapshot taken, so a grant revoked elsewhere does not come back with the next keystroke.
   */
  const beginRename = (): RenameStart => {
    const open = renameStart.current
    // Security recheck (Medium): a re-snapshot of the same role and project keeps the slug the edit started from, so an
    // in-between slug never becomes the "own" slug that reservedSlugs exempts.
    if (open && (open.id !== role.id || open.projectId !== project.id || !sameIds(open.wrote, role.mcpServers))) endRename.current()
    if (!renameStart.current) {
      const start = renameSnapshot(open ? { ...open } : null, role, project.id)
      renameStart.current = { ...start, wrote: start.mcpServers }
    }
    return renameStart.current
  }
  /** Applies a rename patch and remembers the grants it wrote. */
  const renameApply = (start: RenameStart, p: Partial<Role>): void => {
    if (renameStart.current === start && 'mcpServers' in p) renameStart.current.wrote = p.mcpServers
    patch(p)
  }
  // A Slug value another role holds: shown with a field error, never applied (recheck M).
  const [slugDraft, setSlugDraft] = useState<{ roleId: string; text: string; error: string } | null>(null)
  const slugError = slugDraft && slugDraft.roleId === role.id ? slugDraft : null
  const endRename = useRef<() => void>(() => undefined)
  endRename.current = (): void => {
    const s = renameStart.current
    renameStart.current = null
    if (!s) return
    const projectOf = (): Project | undefined => useAppStore.getState().projects.find((p) => p.id === s.projectId)
    void settleRename(s.id, s.slug, {
      current: projectOf,
      // Awaited before any upsert: the save carries the id grants that keep the renamed role's access. Its result is not
      // put back in the store, so an edit typed meanwhile is not overwritten (the debounced save writes that edit).
      save: (p) => useAppStore.getState().trackSave(() => window.orgai.projects.save(p)),
      // Re-read after the save: main may already have dropped the old slug itself, and the spec sent must be current.
      servers: async () => (await window.orgai.mcp.list(s.projectId)).map((i) => i.spec),
      upsert: (spec) => window.orgai.mcp.upsert({ projectId: s.projectId, spec }),
      // Only the server list comes from main's answer; the roles stay the store's, which may be newer than main's copy.
      applied: (r) => {
        const cur = projectOf()
        if (cur) replaceProject({ ...cur, mcpServers: r.project.mcpServers })
      }
    }).then((res) => {
      if (!res.error) return
      const shown = shownKey.current === `${s.projectId}/${s.id}`
      // Named when the user has moved on, since the text then shows in the Team view rather than in this role's inspector.
      const who = shown ? 'This role' : (projectOf()?.roles.find((r) => r.id === s.id)?.name ?? 'The renamed role')
      const text =
        res.error === 'save'
          ? `The project could not be saved, so connections still name the old slug "${s.slug}". ${who} keeps its connections.`
          : `${res.left === 1 ? '1 connection still names' : `${res.left} connections still name`} the old slug "${s.slug}": a role given that slug later would get ${res.left === 1 ? 'it' : 'them'}. Removing ${res.left === 1 ? 'it' : 'them'} from ${shown ? 'this role' : who} and granting again cleans that up.`
      // One place for the failure, whether or not the user switched role (or project): the view's notice row (review L).
      settleErrorRef.current?.(text)
    })
  }
  // Switching role or project, or closing the inspector, ends an edit that had no blur.
  // The render after a switch sets shownKey again; after a close nothing does, so a late failure goes to the Team view.
  useEffect(
    () => () => {
      shownKey.current = null
      endRename.current()
    },
    [role.id, project.id]
  )

  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === 'Escape' && !e.defaultPrevented && onEscape) {
      e.stopPropagation()
      onEscape()
    }
  }

  // The seeded sentence is a hint, not a description: shown as the placeholder and counted as empty.
  const seeded = role.description === SEEDED_DESCRIPTION
  const parents = isRoot ? [] : parentOptions(project.roles, role.id)

  return (
    <>
      <div className="side-header" onKeyDown={onKeyDown}>
        <div className="avatar sm" style={{ ['--role' as string]: role.color }} aria-hidden="true">
          {initials(role.name)}
        </div>
        <h2>{role.name || 'Role'}</h2>
        <div className="grow" />
        {!isRoot && (
          <div className="role-header-actions">
            <Button size="sm" variant="danger" icon={Trash2} onClick={onRemove}>
              Remove
            </Button>
          </div>
        )}
      </div>
      <div className="side-body stack-3 role-editor" onKeyDown={onKeyDown}>
        <section className="stack-2" aria-labelledby={id('who-title')} data-testid="role-section-who">
          <h3 className="side-section-title" id={id('who-title')}>
            Who it is
          </h3>
          <div className="field">
            <label htmlFor="role-name-input">Name</label>
            <Input
              id="role-name-input"
              value={role.name}
              onFocus={() => void beginRename()}
              onBlur={() => endRename.current()}
              onChange={(v) => {
                const start = beginRename()
                renameApply(start, renamePatch(project, start, v))
              }}
            />
          </div>
          <div className="field">
            <label htmlFor={id('description')}>What is this role for?</label>
            <Textarea
              id={id('description')}
              value={seeded ? '' : role.description}
              placeholder={SEEDED_DESCRIPTION}
              aria-describedby={id('description-help')}
              onChange={(v) => patch({ description: v })}
            />
            <span className="re-hint" id={id('description-help')}>
              Managers read this to decide when to hand work to it.
            </span>
          </div>
          <div className="field">
            {isRoot ? (
              <>
                <span className="field-label">Reports to</span>
                <p className="re-static" data-testid="role-reports-to-root">
                  Top of the team. It does not report to anyone.
                </p>
              </>
            ) : (
              <>
                <label htmlFor={id('reports-to')}>Reports to</label>
                <select id={id('reports-to')} className="select" data-testid="role-reports-to" value={role.reportsTo ?? ''} onChange={(e) => changeParent(e.target.value)}>
                  {parents.map((o) => (
                    <option key={o.id} value={o.id} disabled={o.disabled}>
                      {`${'  '.repeat(o.depth)}${o.name}`}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>
          <div className="field">
            <span className="field-label">Color</span>
            {/* One Tab stop; arrows move the choice (a radio group). */}
            <div
              className="row wrap gap-2"
              role="radiogroup"
              aria-label="Role color"
              onKeyDown={(e) => {
                const i = ROLE_COLORS.indexOf(role.color as (typeof ROLE_COLORS)[number])
                const to = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (i + 1) % ROLE_COLORS.length : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (i - 1 + ROLE_COLORS.length) % ROLE_COLORS.length : -1
                if (to < 0) return
                e.preventDefault()
                patch({ color: ROLE_COLORS[to] })
                window.requestAnimationFrame(() => e.currentTarget.querySelectorAll<HTMLElement>('.swatch')[to]?.focus())
              }}
            >
              {ROLE_COLORS.map((c, i) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  className="swatch"
                  style={{ ['--role' as string]: c }}
                  aria-checked={role.color === c}
                  tabIndex={role.color === c || (i === 0 && !ROLE_COLORS.includes(role.color as (typeof ROLE_COLORS)[number])) ? 0 : -1}
                  aria-label={`Color ${c}`}
                  title={c}
                  onClick={() => patch({ color: c })}
                />
              ))}
            </div>
          </div>
          <details className="re-fold" data-testid="role-details-fold">
            <summary>Details</summary>
            <div className="field re-fold-body">
              <label htmlFor={id('slug')}>ID used in team files</label>
              <Input
                id={id('slug')}
                value={slugError ? slugError.text : role.slug}
                mono
                invalid={!!slugError}
                aria-describedby={slugError ? `${id('slug-help')} ${id('slug-error')}` : id('slug-help')}
                onFocus={() => void beginRename()}
                onBlur={() => {
                  setSlugDraft(null)
                  endRename.current()
                }}
                onChange={(v) => {
                  const start = beginRename()
                  const edit = slugFieldEdit(project, start, v)
                  if ('error' in edit) {
                    setSlugDraft({ roleId: role.id, text: slugify(v), error: edit.error })
                    return
                  }
                  setSlugDraft(null)
                  renameApply(start, edit.patch)
                }}
              />
              <span className="re-hint" id={id('slug-help')}>
                Used in .orgai/ files and when a manager starts this role. It follows the name unless you edit it.
              </span>
              {slugError && (
                <span className="field-error" id={id('slug-error')} role="alert" data-testid="role-slug-error">
                  {slugError.error}
                </span>
              )}
            </div>
          </details>
        </section>

        <section className="stack-2" aria-labelledby={id('does-title')} data-testid="role-section-does">
          <h3 className="side-section-title" id={id('does-title')}>
            What it does
          </h3>
          <div className="field">
            <label htmlFor={id('responsibilities')}>Responsibilities</label>
            <Textarea
              id={id('responsibilities')}
              value={role.responsibilities.join('\n')}
              onChange={(v) =>
                patch({ responsibilities: v.split('\n').map((s) => s.replace(/^[-•]\s*/, '')).filter((s) => s.trim()) })
              }
              placeholder="One per line"
            />
          </div>
          <div className="field">
            <label htmlFor={id('prompt')}>Instructions</label>
            <Textarea id={id('prompt')} mono rows={8} value={role.prompt} aria-describedby={id('prompt-help')} onChange={(v) => patch({ prompt: v })} />
            <span className="re-hint" id={id('prompt-help')}>
              Responsibilities, the roles it can delegate to and the project brief are added when it runs.
            </span>
          </div>
          {/* Placeholder until main can hand the assembled prompt over (docs/design/team-tab-overhaul.md 1.13). Stays focusable so its reason is read. */}
          <div className="re-preview">
            <Button size="sm" icon={Eye} inert ariaDescribedBy={id('preview-note')} testId="role-preview-prompt">
              Preview final prompt
            </Button>
            <span className="re-preview-note" id={id('preview-note')}>
              Not available yet.
            </span>
          </div>
        </section>

        <RoleCapabilities project={project} role={role} onChange={patch} onAskAssistant={onAskAssistant} />

        <section className="stack-2" aria-labelledby={id('delegate-title')} data-testid="role-section-delegate">
          <h3 className="side-section-title" id={id('delegate-title')}>
            Who it can delegate to
          </h3>
          <RoleDelegation roles={project.roles} role={role} onChange={patch} onAddReport={onAddReport} headingId={id('delegate-title')} />
        </section>

        {/* Folded behind its sentence on a short window: the summary holds the title and the sentence, so closed it still says what the role runs on. */}
        <details className="re-model stack-2" open={roomy} data-testid="role-section-model">
          <summary>
            <h3 className="side-section-title" id={id('model-title')}>
              Model and effort
            </h3>
            <RoleModelSentence project={project} role={role} />
          </summary>
          <div className="stack-2 re-model-body">
            <RoleModelPicker project={project} role={role} />
            <details className="re-fold" data-testid="role-staffing-fold">
              <summary>Staffing details</summary>
              <div className="re-fold-body">
                <RoleStaffingControls project={project} role={role} />
              </div>
            </details>
          </div>
        </details>
      </div>
    </>
  )
}
