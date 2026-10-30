import type { KeyboardEvent, ReactElement } from 'react'
import { Trash2 } from 'lucide-react'
import type { Effort, Project, Role, ToolName } from '@shared/types'
import { TOOL_CATALOG, TOOL_HINTS } from '@shared/types'
import RoleModelPicker from './RoleModelPicker'
import { ROLE_COLORS, slugify } from '@shared/defaults'
import { useAppStore } from '../store/useAppStore'
import { Banner } from './ui/Banner'
import { Button } from './ui/Button'
import { Checkbox } from './ui/Checkbox'
import { Input } from './ui/Input'
import { Textarea } from './ui/Textarea'
import { initials } from '../lib/layout'
import { setReportsTo, wouldCycle } from '../lib/roleOps'

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
}

export default function RoleInspector({ project, role, notice, onNotice, onRemove, onEscape }: Props): ReactElement {
  const updateRoles = useAppStore((s) => s.updateRoles)
  const others = project.roles.filter((r) => r.id !== role.id)
  const isRoot = role.reportsTo === null
  const id = (name: string): string => `role-${name}`

  const patch = (p: Partial<Role>): void =>
    updateRoles(project.id, (roles) => roles.map((r) => (r.id === role.id ? { ...r, ...p } : r)))

  const toggleTool = (t: ToolName): void => {
    const tools = role.tools.includes(t) ? role.tools.filter((x) => x !== t) : [...role.tools, t]
    patch({ tools })
  }

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

        <section className="stack-2" aria-labelledby={id('identity')}>
          <h3 className="side-section-title" id={id('identity')}>
            Identity
          </h3>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="role-name-input">Name</label>
              <Input id="role-name-input" value={role.name} onChange={(v) => patch({ name: v, slug: slugify(v) })} />
            </div>
            <div className="field">
              <label htmlFor={id('slug')}>Slug (subagent type)</label>
              <Input id={id('slug')} value={role.slug} mono onChange={(v) => patch({ slug: slugify(v) })} />
            </div>
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
            <div className="row wrap gap-2" role="group" aria-label="Role color">
              {ROLE_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="swatch"
                  style={{ ['--role' as string]: c }}
                  aria-pressed={role.color === c}
                  aria-label={`Color ${c}`}
                  title={c}
                  onClick={() => patch({ color: c })}
                />
              ))}
            </div>
          </div>
        </section>

        <section className="stack-2" aria-labelledby={id('model')}>
          <h3 className="side-section-title" id={id('model')}>
            Model
          </h3>
          <RoleModelPicker project={project} role={role} />
          <div className="field">
            <label htmlFor={id('effort')}>Effort</label>
            <select
              id={id('effort')}
              className="select"
              value={role.effort ?? ''}
              onChange={(e) => patch({ effort: (e.target.value || undefined) as Effort | undefined })}
            >
              <option value="">Default</option>
              {(['low', 'medium', 'high', 'xhigh', 'max'] as Effort[]).map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        </section>

        <section className="stack-2" aria-labelledby={id('tools')}>
          <h3 className="side-section-title" id={id('tools')}>
            Tools
          </h3>
          <div className="check-grid">
            {TOOL_CATALOG.map((t) => (
              <Checkbox key={t} checked={role.tools.includes(t)} onChange={() => toggleTool(t)} label={t} title={TOOL_HINTS[t]} />
            ))}
          </div>
        </section>

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
