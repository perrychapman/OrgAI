import type { ReactElement } from 'react'
import { useEffect, useMemo, useState } from 'react'
import type { Effort, ModelTier, Project, Role } from '@shared/types'
import { MODEL_TIER_OPTIONS } from '@shared/types'
import { adapterForProject, adapterOnConnection, modelFamily, projectConnection, roleConnection, roleTierContext } from '@shared/defaults'
import { useAppStore } from '../store/useAppStore'
import { Button } from './ui/Button'
import { ModelSelect, type ModelGroup } from './ui/ModelSelect'
import { connectionLabel, isProxyId } from '../lib/connectionLabel'
import { roleTier } from '../lib/remap'
import { connectionsViewOf, isPinned, isWriterRole, ownConnection, rootRunsOnLine, roleProblems, runsOnDefaultText, runsOnHintText, runsOnOptions, showRunsOn } from '../lib/roleConnection'
import { useFrameAnnounce } from './layout/CanvasFrame'
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
  // Everything below follows the ROLE's connection: its own when pinned, else the project's (the root is always the project's).
  const base = projectConnection(project)
  const connection = roleConnection(role, project)
  const proxy = isProxyId(connection)
  const list = useAppStore((s) => s.connections)
  const info = list?.find((c) => c.connection.id === connection)
  const connectionsLoaded = list !== null
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

  const view = useMemo(() => connectionsViewOf(list), [list])
  const tierModels = useMemo(() => roleTierContext(role, project, view, catalog).tierModels, [role, project, view, catalog])
  const connected = info?.status.state === 'connected'
  const resolved = resolveTier(project, role)
  const effectiveModel = role.model === 'inherit' ? resolved.model : role.model
  const family = effectiveModel ? (catalog?.find((m) => m.id === effectiveModel)?.family ?? modelFamily(effectiveModel)) : undefined
  const adapter = isRoot ? adapterForProject(project, catalog ?? []).adapter : adapterOnConnection(connection, family)

  const runsOn = showRunsOn(role, project, list)
  const pinned = isPinned(role, project)
  const problem = roleProblems(project, list).find((p) => p.roleId === role.id)
  // What a Runs on change did to the model, said once under the select (only for the role it was made on).
  const [movedNote, setMovedNote] = useState<{ roleId: string; text: string } | null>(null)
  const moved = movedNote?.roleId === role.id ? movedNote.text : null
  const writer = isWriterRole(role)
  // A change of Runs on is said through the frame's polite announcer; outside a frame a local status region says it.
  const frameAnnounce = useFrameAnnounce()
  const [said, setSaid] = useState('')
  const say = (text: string): void => {
    if (frameAnnounce) frameAnnounce(text)
    else setSaid(text)
  }
  const runsOnSelect = runsOn ? (
    <div className="field role-runs-on">
      <label htmlFor={`role-runs-on-${role.id}`}>Runs on</label>
      <select
        id={`role-runs-on-${role.id}`}
        className="select"
        data-testid="role-runs-on"
        value={ownConnection(role) ?? ''}
        aria-describedby={problem || pinned || moved ? `role-runs-on-hint-${role.id}` : undefined}
        aria-invalid={problem ? true : undefined}
        onChange={(e) => {
          const v = e.target.value
          const next = v === '' ? undefined : v
          let note: string | null = null
          updateRoles(project.id, (roles) =>
            roles.map((r) => {
              if (r.id !== role.id) return r
              const moved = { ...r, connection: next }
              if (next === undefined) delete moved.connection
              if (r.model === 'inherit') return moved
              // A tier role follows its tier onto the new connection. A custom id the new connection does not serve (or
              // a tier it does not map) falls back like Exact model's "Not set": the saved tier, else Everyday, else the
              // first mapped tier, so a role never keeps a model its new connection cannot run (review M2).
              const target = roleConnection(moved, project)
              const targetCatalog = useAppStore.getState().models[target]
              const targetTiers = roleTierContext(moved, project, view, targetCatalog).tierModels
              const choice = roleModelChoice(r, tierModels)
              const served = choice === 'custom' && !!targetCatalog?.some((m) => m.id === r.model)
              const unknownCatalog = choice === 'custom' && !targetCatalog
              if (served || unknownCatalog) return moved
              const tier = choice === 'custom' || choice === 'inherit' ? undefined : choice
              const w = tier && targetTiers[tier] ? { model: targetTiers[tier]!, tier } : applyExactModel('', targetTiers, r)
              if (w.model !== r.model) {
                note = w.model === 'inherit' ? `Model set to inherit: ${connectionLabel(target)} maps no tier yet.` : `Model set to ${w.tier ? TIER_LABEL[w.tier] : w.model} (${w.model}) on ${connectionLabel(target)}.`
              }
              return { ...moved, model: w.model, tier: w.tier }
            })
          )
          setMovedNote(note ? { roleId: role.id, text: note } : null)
          const after = roleConnection(next === undefined ? { ...role, connection: undefined } : { ...role, connection: next }, project)
          say(`${after !== base ? runsOnHintText(after, writer) : runsOnDefaultText(base)}${note ? ` ${note}` : ''}`)
        }}
      >
        {runsOnOptions(role, project, list).map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      {problem ? (
        <span className="hint invalid-text" id={`role-runs-on-hint-${role.id}`} data-testid="role-runs-on-problem">
          {problem.text}
        </span>
      ) : pinned || moved ? (
        <span className="hint" id={`role-runs-on-hint-${role.id}`} data-testid="role-runs-on-hint">
          {pinned ? runsOnHintText(connection, writer) : ''}
          {moved ? `${pinned ? ' ' : ''}${moved}` : ''}
        </span>
      ) : null}
      {!frameAnnounce && (
        <span className="sr-only" role="status" aria-live="polite" data-testid="role-runs-on-status">
          {said}
        </span>
      )}
    </div>
  ) : null
  const rootLine = isRoot ? (
    <p className="hint" data-testid="role-runs-on-root">
      {rootRunsOnLine(base)}
    </p>
  ) : null

  const choice = roleModelChoice(role, tierModels)
  const groups: ModelGroup[] = useMemo(() => {
    const tierOptions = MODEL_TIER_OPTIONS.filter((o) => tierModels[o.value]).map((o) => ({ value: o.value as string, label: tierOptionLabel(o.value, tierModels) }))
    const rows = [{ value: 'inherit', label: isRoot ? 'Use the connection default' : 'Inherit from parent' }, ...tierOptions]
    if (choice === 'custom') rows.push({ value: 'custom', label: proxy ? 'Exact model (set below)' : 'Custom (set under Advanced)' })
    return [{ options: rows }]
  }, [tierModels, isRoot, choice, proxy])

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
      <div className="role-model-field stack-2">
        {runsOnSelect}
        {rootLine}
        <div className="field">
        <label htmlFor={`role-model-disabled-${role.id}`} className="sr-only">
          Model
        </label>
        <select id={`role-model-disabled-${role.id}`} className="select" disabled value={role.model} data-testid="role-model">
          <option value={role.model}>{role.model === 'inherit' ? 'Inherit' : 'Custom'}</option>
        </select>
        {!info ? (
          <span className="hint">Choose another Runs on to pick a model.</span>
        ) : (
          <>
        <span className="hint">Connect {connectionLabel(connection)} to choose a model.</span>
        <Button
          size="sm"
          onClick={() => {
            requestAppSettingsSection(APP_SETTINGS_SECTIONS.connections)
            setView('appSettings')
          }}
        >
          Open connections
        </Button>
          </>
        )}
        </div>
      </div>
    )
  }

  const effort = effortView(role.effort, adapter, connectionLabel(connection))
  // Only a custom role shows a pinned id; tier and inherit roles read "Not set" (ux-review-config-2 N3).
  const exact = exactModelValue(role, tierModels)
  const stale = exact !== '' && !!catalog && !catalog.some((m) => m.id === exact)

  const name = connectionLabel(connection)
  const exactSelect = catalog ? (
    <ModelSelect
      label="Exact model"
      value={exact}
      groups={exactModelGroups(catalog, proxy, exact)}
      invalid={stale}
      message={stale ? `Not available on ${name}. Choose another model or Not set.` : undefined}
      description={proxy ? `Any model ${name} serves.` : 'Pins this role to one model.'}
      onChange={(v) => write(applyExactModel(v, tierModels, role))}
      testId="role-exact-model"
    />
  ) : null

  return (
    <div className="role-model-field stack-2">
      {runsOnSelect}
      {rootLine}
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

      {proxy && exactSelect}
      <details className="setting-row-more role-model-advanced" data-testid="role-model-advanced">
        <summary>Advanced</summary>
        <div className="setting-row-more-body stack-2">
          {!proxy && exactSelect}
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
