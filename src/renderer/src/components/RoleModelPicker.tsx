import type { ReactElement } from 'react'
import { useEffect, useMemo } from 'react'
import type { Effort, ModelTier, Project, Role } from '@shared/types'
import { MODEL_TIER_OPTIONS } from '@shared/types'
import { adapterForProject, projectConnection } from '@shared/defaults'
import { useAppStore } from '../store/useAppStore'
import { Button } from './ui/Button'
import { ModelSelect, type ModelGroup } from './ui/ModelSelect'
import { CONNECTION_NAME } from '../lib/settingsCopy'
import { roleTier } from '../lib/remap'
import { APP_SETTINGS_SECTIONS, requestAppSettingsSection } from '../lib/settingsTarget'
import { TIER_LABEL, applyExactModel, applyModelChoice, effortView, exactModelGroups, exactModelValue, roleModelChoice, tierOptionLabel } from '../lib/roleModels'

/** Resolve the tier a role effectively has: its own, or through ancestors when it inherits. */
function resolveTier(project: Project, role: Role): { tier?: ModelTier; model?: string } {
  let cur: Role | undefined = role
  const seen = new Set<string>()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    if (cur.model !== 'inherit') return { tier: roleTier(cur), model: cur.model }
    cur = project.roles.find((r) => r.id === cur!.reportsTo)
  }
  return {}
}

/**
 * The role's model controls (the fold title in RoleInspector names them, so the select's own label is visually hidden):
 * one Model select (Inherit or a tier, labelled "Everyday (sonnet)") and, behind
 * "Advanced", the exact model and the effort. Nothing at rest shows a concrete id without a tier word.
 */
export default function RoleModelPicker({ project, role }: { project: Project; role: Role }): ReactElement {
  const updateRoles = useAppStore((s) => s.updateRoles)
  const setView = useAppStore((s) => s.setView)
  const connection = projectConnection(project)
  const info = useAppStore((s) => s.connections?.find((c) => c.connection.id === connection))
  const connectionsLoaded = useAppStore((s) => s.connections !== null)
  const catalog = useAppStore((s) => s.models[connection])
  const error = useAppStore((s) => s.modelsError[connection])
  const loadModels = useAppStore((s) => s.loadModels)
  const loadConnections = useAppStore((s) => s.loadConnections)
  const isRoot = role.reportsTo === null

  useEffect(() => {
    if (!connectionsLoaded) void loadConnections()
  }, [connectionsLoaded, loadConnections])
  useEffect(() => {
    if (!catalog) void loadModels(connection)
  }, [catalog, connection, loadModels])

  const tierModels = useMemo(() => info?.connection.tierModels ?? {}, [info])
  const connected = info?.status.state === 'connected'
  const adapter = adapterForProject(project, catalog ?? []).adapter

  const choice = roleModelChoice(role, tierModels)
  const groups: ModelGroup[] = useMemo(() => {
    const tierOptions = MODEL_TIER_OPTIONS.filter((o) => tierModels[o.value]).map((o) => ({ value: o.value as string, label: tierOptionLabel(o.value, tierModels) }))
    const rows = [{ value: 'inherit', label: isRoot ? 'Use the connection default' : 'Inherit from parent' }, ...tierOptions]
    if (choice === 'custom') rows.push({ value: 'custom', label: 'Custom (set under Advanced)' })
    return [{ options: rows }]
  }, [tierModels, isRoot, choice])

  const resolved = resolveTier(project, role)
  const description =
    role.model === 'inherit'
      ? `Uses ${resolved.tier ? TIER_LABEL[resolved.tier] : 'the connection default'}${resolved.tier && tierModels[resolved.tier] ? ` (${tierModels[resolved.tier]})` : ''} from ${isRoot ? 'the connection' : 'its parent'}.`
      : undefined

  const write = (w: { model: string; tier: ModelTier | undefined }): void => {
    updateRoles(project.id, (roles) => roles.map((r) => (r.id === role.id ? { ...r, model: w.model, tier: w.tier } : r)))
  }
  const pick = (value: string): void => {
    const w = applyModelChoice(value, tierModels)
    if (w) write(w)
  }

  if (!connected && connectionsLoaded) {
    return (
      <div className="field role-model-field">
        <label htmlFor="role-model-disabled" className="sr-only">
          Model
        </label>
        <select id="role-model-disabled" className="select" disabled value={role.model} data-testid="role-model">
          <option value={role.model}>{role.model === 'inherit' ? 'Inherit' : 'Custom'}</option>
        </select>
        <span className="hint">Connect {CONNECTION_NAME[connection]} to choose a model.</span>
        <Button
          size="sm"
          onClick={() => {
            requestAppSettingsSection(APP_SETTINGS_SECTIONS.connections)
            setView('appSettings')
          }}
        >
          Open connections
        </Button>
      </div>
    )
  }

  const effort = effortView(role.effort, adapter)
  // Only a custom role shows a pinned id; tier and inherit roles read "Not set" (ux-review-config-2 N3).
  const exact = exactModelValue(role, tierModels)
  const stale = exact !== '' && !!catalog && !catalog.some((m) => m.id === exact)

  return (
    <div className="role-model-field stack-2">
      {error ? (
        <div className="field">
          <span className="hint invalid-text">Could not load models</span>
          <Button size="sm" variant="ghost" onClick={() => void loadModels(connection)}>
            Retry
          </Button>
        </div>
      ) : !catalog ? (
        <div className="skeleton" aria-busy="true" />
      ) : (
        <ModelSelect label="Model" hideLabel value={choice} groups={groups} description={description} onChange={pick} testId="role-model" />
      )}

      <details className="setting-row-more role-model-advanced" data-testid="role-model-advanced">
        <summary>Advanced</summary>
        <div className="setting-row-more-body stack-2">
          {catalog && (
            <ModelSelect
              label="Exact model"
              value={exact}
              groups={exactModelGroups(catalog, connection === 'litellm', exact)}
              invalid={stale}
              message={stale ? `Not available on ${CONNECTION_NAME[connection]}. Choose another model or Not set.` : undefined}
              description={connection === 'litellm' ? 'Any model the proxy serves.' : 'Pins this role to one model.'}
              onChange={(v) => write(applyExactModel(v, tierModels, role))}
              testId="role-exact-model"
            />
          )}
          <div className="field">
            <label htmlFor={`role-effort-${role.id}`}>Effort</label>
            <select
              id={`role-effort-${role.id}`}
              className="select"
              value={role.effort ?? ''}
              aria-describedby={effort.note ? `role-effort-note-${role.id}` : undefined}
              data-testid="role-effort"
              onChange={(e) => updateRoles(project.id, (roles) => roles.map((r) => (r.id === role.id ? { ...r, effort: (e.target.value || undefined) as Effort | undefined } : r)))}
            >
              {effort.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {effort.note && (
              <span className="hint" id={`role-effort-note-${role.id}`} data-testid="role-effort-unsupported">
                {effort.note}
              </span>
            )}
          </div>
        </div>
      </details>
    </div>
  )
}
