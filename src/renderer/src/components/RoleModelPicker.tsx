import type { ReactElement } from 'react'
import { useEffect, useMemo } from 'react'
import type { ModelTier, Project, ProviderModel, Role } from '@shared/types'
import { MODEL_TIER_OPTIONS } from '@shared/types'
import { projectConnection } from '@shared/defaults'
import { useAppStore } from '../store/useAppStore'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { ModelSelect, type ModelGroup } from './ui/ModelSelect'
import { formatContext, roleTier } from '../lib/remap'

const TIER_LABEL = Object.fromEntries(MODEL_TIER_OPTIONS.map((o) => [o.value, o.label])) as Record<ModelTier, string>

const CONN_NAME = { anthropic: 'Anthropic', openai: 'OpenAI', litellm: 'LiteLLM' }

/** Resolve the tier a role effectively has: its own, or through ancestors when it inherits. */
function resolveTier(project: Project, role: Role): { tier?: ModelTier; chain: string[] } {
  const chain: string[] = []
  let cur: Role | undefined = role
  const seen = new Set<string>()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    if (cur.model !== 'inherit') {
      const tier = roleTier(cur)
      chain.push(cur.model)
      return { tier, chain }
    }
    chain.push(cur.name)
    cur = project.roles.find((r) => r.id === cur!.reportsTo)
  }
  return { chain }
}

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

  const tierModels = info?.connection.tierModels ?? {}
  const connected = info?.status.state === 'connected'

  const { groups, known } = useMemo(() => {
    const models: ProviderModel[] = catalog ?? []
    const byId = new Map(models.map((m) => [m.id, m]))
    const used = new Set<string>()
    const tierGroups: ModelGroup[] = []
    for (const o of MODEL_TIER_OPTIONS) {
      const id = tierModels[o.value]
      if (!id || used.has(id)) continue
      used.add(id)
      tierGroups.push({ label: o.label, options: [{ value: id, label: `${id} · ${o.label}` }] })
    }
    const others = models.filter((m) => !used.has(m.id))
    const groups: ModelGroup[] = [
      { label: 'Inherit', options: [{ value: 'inherit', label: isRoot ? 'Use the connection default' : 'Inherit from parent' }] },
      ...tierGroups,
      ...(others.length ? [{ label: 'Other models', options: others.map((m) => ({ value: m.id, label: m.id })) }] : [])
    ]
    return { groups, known: byId }
  }, [catalog, tierModels, isRoot])

  const stale = role.model !== 'inherit' && !!catalog && !known.has(role.model)
  const finalGroups: ModelGroup[] = stale ? [{ options: [{ value: role.model, label: `${role.model} (unavailable)`, disabled: true }] }, ...groups] : groups

  const { tier, chain } = resolveTier(project, role)
  const tierText = tier ? `Tier: ${TIER_LABEL[tier]}` : 'Custom model'
  const selected = known.get(role.model)
  const description = selected
    ? [selected.hint, formatContext(selected.contextWindow) ? `context ${formatContext(selected.contextWindow)}` : ''].filter(Boolean).join(' · ')
    : role.model === 'inherit'
      ? `Resolves to ${chain[chain.length - 1] ?? 'the connection default'}${tier ? ` (${TIER_LABEL[tier]})` : ''}`
      : undefined

  const pick = (value: string): void => {
    const picked = MODEL_TIER_OPTIONS.find((o) => tierModels[o.value] === value)
    updateRoles(project.id, (roles) => roles.map((r) => (r.id === role.id ? { ...r, model: value, tier: value === 'inherit' ? undefined : picked?.value } : r)))
  }

  if (!connected && connectionsLoaded) {
    return (
      <div className="field role-model" data-testid="role-model">
        <div className="tier-badge-row">
          <label>Model</label>
          <Badge testId="role-tier-badge" title={chain.join(' -> ')}>
            {tierText}
          </Badge>
        </div>
        <select className="select" disabled aria-label="Model" value={role.model} data-testid="role-model-select">
          <option value={role.model}>{role.model}</option>
        </select>
        <span className="hint">Connect {CONN_NAME[connection]} to choose a model.</span>
        <Button size="sm" onClick={() => setView('appSettings')}>
          Open connections
        </Button>
      </div>
    )
  }

  return (
    <div className="field role-model" data-testid="role-model">
      <div className="tier-badge-row">
        <span className="hint">Model</span>
        <Badge testId="role-tier-badge" title={chain.join(' -> ')}>
          {tierText}
        </Badge>
      </div>
      {error ? (
        <>
          <span className="hint invalid-text">Could not load models</span>
          <Button size="sm" variant="ghost" onClick={() => void loadModels(connection)}>
            Retry
          </Button>
        </>
      ) : !catalog ? (
        <div className="skeleton" aria-busy="true" />
      ) : (
        <ModelSelect
          label="Model"
          hideLabel
          value={role.model}
          groups={finalGroups}
          invalid={stale}
          message={stale ? `Not available on ${CONN_NAME[connection]}. Choose another model or Inherit.` : undefined}
          description={description}
          onChange={pick}
          testId="role-model-select"
        />
      )}
    </div>
  )
}
