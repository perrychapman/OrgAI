import type { KeyboardEvent, ReactElement } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Trash2, UserPlus } from 'lucide-react'
import type { Project, Role } from '@shared/types'
import { projectConnection, roleConnection } from '@shared/defaults'
import RoleModelPicker from './RoleModelPicker'
import RoleCapabilities from './team/RoleCapabilities'
import RoleStaffingControls from './team/RoleStaffingControls'
import type { CapabilityKind } from './team/CapabilityBlock'
import { ROLE_COLORS, slugify } from '@shared/defaults'
import { useAppStore } from '../store/useAppStore'
import { Banner } from './ui/Banner'
import { Button } from './ui/Button'
import { Checkbox } from './ui/Checkbox'
import { Input } from './ui/Input'
import { Textarea } from './ui/Textarea'
import { initials } from '../lib/layout'
import { delegationChoices } from '../lib/delegation'
import {
  moveNotice,
  renamePatch,
  setReportsTo,
  settleRename,
  renameSnapshot,
  slugFieldEdit,
  withRequiredReport,
  withSpawnableToggled,
  wouldCycle,
  type RenameStart
} from '../lib/roleOps'
import { roleModelSummary } from '../lib/roleModels'
import { modelFoldSummary } from '../lib/roleConnection'

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
  /** Hands a scope to the Team assistant from an empty capability group. */
  onAskAssistant?: (scope: CapabilityKind) => void
  /** Adds a new role under this one. */
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
  const tierModels = useAppStore((s) => s.connections?.find((c) => c.connection.id === roleConnection(role, project))?.connection.tierModels)
  const others = project.roles.filter((r) => r.id !== role.id)
  const isRoot = role.reportsTo === null
  const id = (name: string): string => `role-${name}`
  // On a short or narrow window Identity and Model start folded behind a one-line summary; "What it can use" comes first.
  const [roomy] = useState(() => window.innerHeight >= 800 && window.innerWidth >= 1280)

  const patch = (p: Partial<Role>): void =>
    updateRoles(project.id, (roles) => roles.map((r) => (r.id === role.id ? { ...r, ...p } : r)))

  const toggleSpawnable = (rid: string): void => patch(withSpawnableToggled(role, rid))

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

  const choices = delegationChoices(project.roles, role)
  const delegateRow = (r: Role): ReactElement => (
    <div key={r.id} className="delegate-row">
      <Checkbox
        checked={role.spawnable.includes(r.id)}
        onChange={() => toggleSpawnable(r.id)}
        testId={`role-delegate-${r.slug}`}
        title={r.name}
        label={
          <span className="delegate-name">
            <span className="avatar xs" style={{ ['--role' as string]: r.color }} aria-hidden="true" />
            <span className="delegate-name-text">{r.name}</span>
          </span>
        }
      />
      <Checkbox
        checked={(role.requiredReports ?? []).includes(r.id)}
        onChange={(v) => patch(withRequiredReport(role, r.id, v))}
        disabled={!role.spawnable.includes(r.id)}
        title="The harness requires this report to be delegated to every time this role finishes"
        testId={`role-required-report-${r.slug}`}
        label={
          <>
            Required<span className="sr-only">: {r.name}</span>
          </>
        }
      />
    </div>
  )

  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === 'Escape' && !e.defaultPrevented && onEscape) {
      e.stopPropagation()
      onEscape()
    }
  }

  return (
    <>
      <div className="side-header" onKeyDown={onKeyDown}>
        <div className="avatar sm" style={{ ['--role' as string]: role.color }} aria-hidden="true">
          {initials(role.name)}
        </div>
        <h2>{role.name || 'Role'}</h2>
        <div className="grow" />
        <div className="role-header-actions">
          {onAddReport && (
            <Button size="sm" icon={UserPlus} onClick={onAddReport} testId="role-add-report">
              Add a report
            </Button>
          )}
          {!isRoot && (
            <Button size="sm" variant="danger" icon={Trash2} onClick={onRemove}>
              Remove
            </Button>
          )}
        </div>
      </div>
      <div className="side-body stack-3" onKeyDown={onKeyDown}>

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

        <RoleCapabilities project={project} role={role} onChange={patch} onAskAssistant={onAskAssistant} />

        <details className="role-fold stack-2" open={roomy} data-testid="role-identity-fold">
          <summary className="side-section-title" id={id('identity')}>
            Identity
            <span className="role-fold-summary muted">
              {role.slug || 'no slug'} · {role.reportsTo ? (project.roles.find((r) => r.id === role.reportsTo)?.name ?? 'unknown') : 'root'}
            </span>
          </summary>
          <div className="field">
            <label htmlFor={id('slug')}>Slug (subagent type)</label>
            <Input
              id={id('slug')}
              value={slugError ? slugError.text : role.slug}
              mono
              invalid={!!slugError}
              aria-describedby={slugError ? id('slug-error') : undefined}
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
            {slugError && (
              <span className="field-error" id={id('slug-error')} role="alert" data-testid="role-slug-error">
                {slugError.error}
              </span>
            )}
          </div>
          <div className="field">
            <label htmlFor={id('description')}>When should a manager delegate to this role?</label>
            <Textarea id={id('description')} value={role.description} onChange={(v) => patch({ description: v })} />
          </div>
          <div className="field">
            <label htmlFor={id('reports-to')}>Reports to</label>
            <select
              id={id('reports-to')}
              className="select"
              value={role.reportsTo ?? ''}
              onChange={(e) => changeParent(e.target.value)}
            >
              {/* Review L2: only the root reports to nobody; another role cannot be made a second root here. */}
              {isRoot && <option value="">Nobody (root orchestrator)</option>}
              {others.map((r) => (
                <option key={r.id} value={r.id} disabled={wouldCycle(project.roles, role.id, r.id)}>
                  {r.name}
                </option>
              ))}
            </select>
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
        </details>

        <details className="role-fold stack-2" open={roomy} data-testid="role-model-fold">
          <summary className="side-section-title" id={id('model')}>
            Model
            <span className="role-fold-summary muted">{modelFoldSummary(roleModelSummary(role, tierModels ?? {}), roleConnection(role, project), projectConnection(project))}</span>
          </summary>
          <RoleModelPicker project={project} role={role} />
          <RoleStaffingControls project={project} role={role} />
        </details>

        <section className="stack-2" aria-labelledby={id('delegation')}>
          <h3 className="side-section-title" id={id('delegation')}>
            Delegation
          </h3>
          <Checkbox checked={role.canSpawn} onChange={(v) => patch({ canSpawn: v })} label="May create subagents" />
          {role.canSpawn && (
            <>
              <span className="hint">Required: this role must hand work to that report before it finishes.</span>
              {others.length === 0 && <span className="hint">Add more roles to delegate to.</span>}
              {choices.direct.length > 0 && (
                <div className="stack-1" role="group" aria-labelledby={id('delegate-direct')}>
                  {/* QA P4: the first group is named, as "Other roles" below is. */}
                  <span className="field-label" id={id('delegate-direct')}>
                    Direct reports
                  </span>
                  <div className="delegate-list">{choices.direct.map(delegateRow)}</div>
                </div>
              )}
              {choices.other.length > 0 && (
                <details className="delegate-other" open={choices.other.some((r) => role.spawnable.includes(r.id))} data-testid="role-delegate-other">
                  <summary>
                    Other roles <span className="muted">({choices.other.length})</span>
                  </summary>
                  <div className="delegate-list">{choices.other.map(delegateRow)}</div>
                </details>
              )}
            </>
          )}
        </section>

        <section className="stack-2" aria-labelledby={id('instructions')}>
          <h3 className="side-section-title" id={id('instructions')}>
            Instructions
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
            <label htmlFor={id('prompt')}>System prompt</label>
            <Textarea id={id('prompt')} mono rows={8} value={role.prompt} onChange={(v) => patch({ prompt: v })} />
            <span className="hint">Responsibilities, the list of reports and the project brief are appended automatically at run time.</span>
          </div>
        </section>
      </div>
    </>
  )
}
