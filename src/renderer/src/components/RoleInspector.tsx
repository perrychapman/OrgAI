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
  slugPatch,
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
  /** Inline explanation of a side effect of the last change ("Implementer can now create subagents"). */
  notice?: string | null
  onNotice?: (text: string | null) => void
  /** Remove goes through the view's confirm dialog and undo row. */
  onRemove: () => void
  /** Escape inside the inspector hands focus back to the node. */
  onEscape?: () => void
  /** Hands a scope to the Team assistant from an empty capability group. */
  onAskAssistant?: (scope: CapabilityKind) => void
  /** Adds a new role under this one. */
  onAddReport?: () => void
}

export default function RoleInspector({ project, role, notice, onNotice, onRemove, onEscape, onAskAssistant, onAddReport }: Props): ReactElement {
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
    onNotice?.(moveNotice(before, setReportsTo(before, role.id, reportsTo), role.id))
  }

  // Review H1 / M3: a Name or Slug edit is computed against the role as it was when the edit began, and settled once
  // when it ends (blur, switching role, closing the inspector). See renamePatch and settleRename in lib/roleOps.
  const renameStart = useRef<(RenameStart & { roleId: string; projectId: string }) | null>(null)
  const shownRoleId = useRef(role.id)
  const noticeRef = useRef(onNotice)
  useEffect(() => {
    shownRoleId.current = role.id
    noticeRef.current = onNotice
  })
  /** Takes the start snapshot on focus, or on the first keystroke when no focus event came (autofocus, scripted input). */
  const beginRename = (): RenameStart => {
    if (!renameStart.current || renameStart.current.roleId !== role.id || renameStart.current.projectId !== project.id) {
      renameStart.current = { roleId: role.id, projectId: project.id, slug: role.slug, mcpServers: role.mcpServers ? [...role.mcpServers] : undefined }
    }
    return renameStart.current
  }
  const endRename = useRef<() => void>(() => undefined)
  endRename.current = (): void => {
    const s = renameStart.current
    renameStart.current = null
    if (!s) return
    const projectOf = (): Project | undefined => useAppStore.getState().projects.find((p) => p.id === s.projectId)
    void settleRename(s.roleId, s.slug, {
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
      if (!res.error || shownRoleId.current !== s.roleId) return
      noticeRef.current?.(
        res.error === 'save'
          ? `The project could not be saved, so connections still name the old slug "${s.slug}". This role keeps its connections.`
          : `${res.left === 1 ? '1 connection still names' : `${res.left} connections still name`} the old slug "${s.slug}": a role given that slug later would get ${res.left === 1 ? 'it' : 'them'}. Removing ${res.left === 1 ? 'it' : 'them'} from this role and granting again cleans that up.`
      )
    })
  }
  // Switching role or closing the inspector ends an edit that had no blur.
  useEffect(() => () => endRename.current(), [role.id])

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
        {notice && <Banner tone="info" onDismiss={() => onNotice?.(null)}>{notice}</Banner>}

        <div className="field">
          <label htmlFor="role-name-input">Name</label>
          <Input
            id="role-name-input"
            value={role.name}
            onFocus={() => void beginRename()}
            onBlur={() => endRename.current()}
            onChange={(v) => patch(renamePatch(project, beginRename(), v))}
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
              value={role.slug}
              mono
              onFocus={() => void beginRename()}
              onBlur={() => endRename.current()}
              onChange={(v) => patch(slugPatch(project, beginRename(), slugify(v)))}
            />
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
