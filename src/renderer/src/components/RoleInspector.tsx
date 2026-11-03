import type { KeyboardEvent, ReactElement } from 'react'
import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { Project, Role } from '@shared/types'
import { projectConnection } from '@shared/defaults'
import RoleModelPicker from './RoleModelPicker'
import RoleCapabilities from './team/RoleCapabilities'
import type { CapabilityKind } from './team/CapabilityBlock'
import { ROLE_COLORS, slugify } from '@shared/defaults'
import { useAppStore } from '../store/useAppStore'
import { Banner } from './ui/Banner'
import { Button } from './ui/Button'
import { Checkbox } from './ui/Checkbox'
import { Input } from './ui/Input'
import { Textarea } from './ui/Textarea'
import { initials } from '../lib/layout'
import { setReportsTo, wouldCycle } from '../lib/roleOps'
import { roleModelSummary } from '../lib/roleModels'

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
}

export default function RoleInspector({ project, role, notice, onNotice, onRemove, onEscape, onAskAssistant }: Props): ReactElement {
  const updateRoles = useAppStore((s) => s.updateRoles)
  const tierModels = useAppStore((s) => s.connections?.find((c) => c.connection.id === projectConnection(project))?.connection.tierModels)
  const others = project.roles.filter((r) => r.id !== role.id)
  const isRoot = role.reportsTo === null
  const id = (name: string): string => `role-${name}`
  // On a short or narrow window Identity and Model start folded behind a one-line summary; "What it can use" comes first.
  const [roomy] = useState(() => window.innerHeight >= 800 && window.innerWidth >= 1280)

  const patch = (p: Partial<Role>): void =>
    updateRoles(project.id, (roles) => roles.map((r) => (r.id === role.id ? { ...r, ...p } : r)))

  const toggleSpawnable = (rid: string): void => {
    const spawnable = role.spawnable.includes(rid) ? role.spawnable.filter((x) => x !== rid) : [...role.spawnable, rid]
    patch({ spawnable, canSpawn: spawnable.length > 0 ? true : role.canSpawn })
  }

  const changeParent = (value: string): void => {
    const reportsTo = value || null
    const parent = project.roles.find((r) => r.id === reportsTo)
    updateRoles(project.id, (roles) => setReportsTo(roles, role.id, reportsTo))
    onNotice?.(parent && !parent.canSpawn ? `${parent.name} can now create subagents, because ${role.name} reports to it.` : null)
  }

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
        {!isRoot && (
          <Button size="sm" variant="danger" icon={Trash2} onClick={onRemove}>
            Remove
          </Button>
        )}
      </div>
      <div className="side-body stack-3" onKeyDown={onKeyDown}>
        {notice && <Banner tone="info" onDismiss={() => onNotice?.(null)}>{notice}</Banner>}

        <div className="field">
          <label htmlFor="role-name-input">Name</label>
          <Input id="role-name-input" value={role.name} onChange={(v) => patch({ name: v, slug: slugify(v) })} />
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
            <Input id={id('slug')} value={role.slug} mono onChange={(v) => patch({ slug: slugify(v) })} />
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
              <option value="">Nobody (root orchestrator)</option>
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
            <span className="role-fold-summary muted">{roleModelSummary(role, tierModels ?? {})}</span>
          </summary>
          <RoleModelPicker project={project} role={role} />
        </details>

        <section className="stack-2" aria-labelledby={id('delegation')}>
          <h3 className="side-section-title" id={id('delegation')}>
            Delegation
          </h3>
          <Checkbox checked={role.canSpawn} onChange={(v) => patch({ canSpawn: v })} label="May create subagents" />
          {role.canSpawn && (
            <div className="check-grid">
              {others.length === 0 && <span className="hint">Add more roles to delegate to.</span>}
              {others.map((r) => (
                <Checkbox
                  key={r.id}
                  checked={role.spawnable.includes(r.id)}
                  onChange={() => toggleSpawnable(r.id)}
                  label={
                    <span className="row gap-2">
                      <span className="avatar xs" style={{ ['--role' as string]: r.color }} aria-hidden="true" />
                      {r.name}
                    </span>
                  }
                />
              ))}
            </div>
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
