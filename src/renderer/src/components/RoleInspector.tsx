import type { ReactElement } from 'react'
import type { Effort, Project, Role, ToolName } from '@shared/types'
import { CLAUDE_MODEL_OPTIONS, TOOL_CATALOG } from '@shared/types'
import { ROLE_COLORS, slugify } from '@shared/defaults'
import { useAppStore } from '../store/useAppStore'

interface Props {
  project: Project
  role: Role
}

export default function RoleInspector({ project, role }: Props): ReactElement {
  const updateRoles = useAppStore((s) => s.updateRoles)
  const selectRole = useAppStore((s) => s.selectRole)
  const others = project.roles.filter((r) => r.id !== role.id)
  const isRoot = role.reportsTo === null

  const patch = (p: Partial<Role>): void =>
    updateRoles(project.id, (roles) => roles.map((r) => (r.id === role.id ? { ...r, ...p } : r)))

  const toggleTool = (t: ToolName): void => {
    const tools = role.tools.includes(t) ? role.tools.filter((x) => x !== t) : [...role.tools, t]
    patch({ tools })
  }

  const toggleSpawnable = (id: string): void => {
    const spawnable = role.spawnable.includes(id) ? role.spawnable.filter((x) => x !== id) : [...role.spawnable, id]
    patch({ spawnable, canSpawn: spawnable.length > 0 ? true : role.canSpawn })
  }

  const remove = (): void => {
    if (!confirm(`Remove role "${role.name}"?`)) return
    updateRoles(project.id, (roles) =>
      roles
        .filter((r) => r.id !== role.id)
        .map((r) => ({
          ...r,
          reportsTo: r.reportsTo === role.id ? role.reportsTo : r.reportsTo,
          spawnable: r.spawnable.filter((id) => id !== role.id)
        }))
    )
    selectRole(null)
  }

  return (
    <>
      <div className="side-header">
        <div className="avatar" style={{ ['--role' as string]: role.color, width: 26, height: 26, fontSize: 10 }}>
          {role.name.slice(0, 2).toUpperCase()}
        </div>
        <h2>{role.name || 'Role'}</h2>
        <div style={{ flex: 1 }} />
        {!isRoot && (
          <button className="btn ghost sm danger" onClick={remove}>
            Remove
          </button>
        )}
      </div>
      <div className="side-body">
        <div className="grid-2">
          <div className="field">
            <label>Name</label>
            <input
              className="input"
              value={role.name}
              onChange={(e) => patch({ name: e.target.value, slug: slugify(e.target.value) })}
            />
          </div>
          <div className="field">
            <label>Slug (subagent type)</label>
            <input className="input" value={role.slug} onChange={(e) => patch({ slug: slugify(e.target.value) })} />
          </div>
        </div>

        <div className="field">
          <label>When should a manager delegate to this role?</label>
          <textarea className="textarea" value={role.description} onChange={(e) => patch({ description: e.target.value })} />
        </div>

        <div className="grid-2">
          <div className="field">
            <label>Model</label>
            <select className="select" value={role.model} onChange={(e) => patch({ model: e.target.value })}>
              {CLAUDE_MODEL_OPTIONS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <span className="hint">{CLAUDE_MODEL_OPTIONS.find((m) => m.value === role.model)?.hint}</span>
          </div>
          <div className="field">
            <label>Effort</label>
            <select
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
        </div>

        <div className="field">
          <label>Reports to</label>
          <select
            className="select"
            value={role.reportsTo ?? ''}
            onChange={(e) => {
              const reportsTo = e.target.value || null
              updateRoles(project.id, (roles) =>
                roles.map((r) => {
                  if (r.id === role.id) return { ...r, reportsTo }
                  if (r.id === reportsTo) return { ...r, canSpawn: true, spawnable: [...new Set([...r.spawnable, role.id])] }
                  return { ...r, spawnable: r.spawnable.filter((id) => id !== role.id) }
                })
              )
            }}
          >
            <option value="">Nobody (root orchestrator)</option>
            {others.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>

        <div className="side-section-title">Tools</div>
        <div className="row wrap">
          {TOOL_CATALOG.map((t) => (
            <label key={t} className={`check ${role.tools.includes(t) ? 'on' : ''}`}>
              <input type="checkbox" checked={role.tools.includes(t)} onChange={() => toggleTool(t)} />
              {t}
            </label>
          ))}
        </div>

        <div className="side-section-title">Delegation</div>
        <label className={`check ${role.canSpawn ? 'on' : ''}`} style={{ marginBottom: 8 }}>
          <input type="checkbox" checked={role.canSpawn} onChange={(e) => patch({ canSpawn: e.target.checked })} />
          May create subagents
        </label>
        {role.canSpawn && (
          <div className="row wrap">
            {others.length === 0 && <span className="hint">Add more roles to delegate to.</span>}
            {others.map((r) => (
              <label key={r.id} className={`check ${role.spawnable.includes(r.id) ? 'on' : ''}`}>
                <input type="checkbox" checked={role.spawnable.includes(r.id)} onChange={() => toggleSpawnable(r.id)} />
                <span className="avatar" style={{ ['--role' as string]: r.color, width: 14, height: 14, fontSize: 7 }} />
                {r.name}
              </label>
            ))}
          </div>
        )}

        <div className="side-section-title">Responsibilities</div>
        <div className="field">
          <textarea
            className="textarea"
            value={role.responsibilities.join('\n')}
            onChange={(e) => patch({ responsibilities: e.target.value.split('\n').map((s) => s.replace(/^[-•]\s*/, '')).filter((s) => s.trim()) })}
            placeholder={'One per line'}
          />
        </div>

        <div className="side-section-title">System prompt</div>
        <div className="field">
          <textarea className="textarea mono" style={{ minHeight: 160 }} value={role.prompt} onChange={(e) => patch({ prompt: e.target.value })} />
          <span className="hint">Responsibilities, the list of reports and the project brief are appended automatically at run time.</span>
        </div>

        <div className="side-section-title">Color</div>
        <div className="row wrap">
          {ROLE_COLORS.map((c) => (
            <button
              key={c}
              className="avatar"
              style={{ ['--role' as string]: c, width: 22, height: 22, border: role.color === c ? '2px solid #fff' : '2px solid transparent', cursor: 'pointer' }}
              onClick={() => patch({ color: c })}
            />
          ))}
        </div>
      </div>
    </>
  )
}
