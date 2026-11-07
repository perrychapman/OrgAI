import { useEffect, useState } from 'react'
import type { ConnectionId, ConnectionInfo, ProviderModel } from '@shared/types'
import { MODEL_TIER_OPTIONS, isProxyConnection } from '@shared/types'
import { connectionKindLabel, connectionLabel } from './connectionLabel'
import { mixedFamilies, withFamily } from './modelFamily'
import { modelForTier, settingTier } from '@shared/defaults'
import type { TierContext } from '@shared/defaults'
import { useAppStore } from '../store/useAppStore'

/** Display name of a model setting: "Deep tier" for a tier (or a legacy alias), the catalog label for a model id, else the id. */
export function modelDisplayName(value: string, catalog?: readonly ProviderModel[]): string {
  const tier = settingTier(value)
  if (tier) return `${MODEL_TIER_OPTIONS.find((o) => o.value === tier)?.label ?? tier} tier`
  return catalog?.find((m) => m.id === value)?.label ?? value
}

export interface ModelSettingOption {
  value: string
  label: string
  disabled?: boolean
}
export interface ModelSettingGroup {
  label: string
  options: ModelSettingOption[]
}

/** One connection a model setting can resolve on: its tier mapping and discovered catalog. */
export interface ModelSource {
  id: ConnectionId
  name: string
  tierModels: TierContext['tierModels']
  catalog?: readonly ProviderModel[]
}

/** The name of a connection record: a proxy's own name, else the built-in's. */
function sourceName(c: ConnectionInfo['connection']): string {
  return isProxyConnection(c) ? c.name : connectionKindLabel(c)
}

/**
 * The usable connections in list order (Anthropic always, every other one when enabled: OpenAI and each proxy), with
 * their loaded catalogs.
 */
export function modelSources(
  connections: readonly ConnectionInfo[] | null | undefined,
  models: Partial<Record<ConnectionId, ProviderModel[]>>
): ModelSource[] {
  const out: ModelSource[] = (connections ?? [])
    .filter((x) => x.connection.id === 'anthropic' || x.connection.enabled)
    .map((x) => ({ id: x.connection.id, name: sourceName(x.connection), tierModels: x.connection.tierModels ?? {}, catalog: models[x.connection.id] }))
  if (!out.some((s) => s.id === 'anthropic')) out.unshift({ id: 'anthropic', name: 'Anthropic', tierModels: {}, catalog: models.anthropic })
  return out
}

/**
 * Options for an app-wide model setting: the four tiers first, each labelled with the model it resolves to on
 * `resolveOn` (the effective default connection) when given ("Everyday tier (sonnet)"), then one "Exact model" group of
 * concrete ids (the connection's name is added only when several connections offer models). A saved value that is none
 * of these stays selectable as written. 'inherit' is offered only when allowed.
 */
export function modelSettingGroups(value: string, sources: readonly ModelSource[], allowInherit: boolean, resolveOn?: ModelSource): ModelSettingGroup[] {
  const tierLabel = (tier: (typeof MODEL_TIER_OPTIONS)[number]): string => {
    const base = `${tier.label} tier`
    const hit = resolveOn ? modelForTier(tier.value, { connection: resolveOn.id, tierModels: resolveOn.tierModels, catalog: resolveOn.catalog }) : undefined
    return hit?.model ? `${base} (${hit.model})` : base
  }
  const groups: ModelSettingGroup[] = [{ label: 'Tiers', options: MODEL_TIER_OPTIONS.map((o) => ({ value: o.value, label: tierLabel(o) })) }]
  if (allowInherit) groups.unshift({ label: 'Inherit', options: [{ value: 'inherit', label: 'Inherit from parent' }] })
  // One group per connection, named by the connection; a model's family shows only where that connection mixes them.
  const seen = new Set<string>()
  for (const src of sources) {
    const own = (src.catalog ?? []).filter((x) => x.connection === src.id)
    if (!own.length) continue
    const mixed = mixedFamilies(own)
    // A setting stores a bare model id, so a second connection serving the same id cannot be told apart: the id is listed
    // once, under the first connection that offers it (selecting it runs it wherever the project's connection serves it).
    // A connection whose ids were all listed already gets no group (never an empty optgroup).
    const options = own
      .filter((m) => !seen.has(m.id) && (seen.add(m.id), true))
      .map((m) => ({ value: m.id, label: withFamily(`${m.label || m.id}${m.recommended ? ' (recommended)' : ''}`, m.family, mixed) }))
    if (options.length) groups.push({ label: src.name, options })
  }
  const all = sources.flatMap((s) => s.catalog ?? [])
  const known = value === 'inherit' || MODEL_TIER_OPTIONS.some((o) => o.value === value) || all.some((m) => m.id === value)
  if (!known && value) groups.push({ label: 'Saved value', options: [{ value, label: modelDisplayName(value, all) }] })
  return groups
}

/**
 * The row description for a model setting. A tier: what it resolves to on each usable connection
 * ("Deep → Anthropic: opus · OpenAI: gpt-5.1"). A concrete model: the connections that offer it.
 */
export function modelSettingDescription(value: string, sources: readonly ModelSource[]): string | undefined {
  const tier = settingTier(value)
  if (tier) {
    const name = MODEL_TIER_OPTIONS.find((o) => o.value === tier)?.label ?? tier
    if (!sources.length) return `${name} tier, resolved per project.`
    const parts = sources.map((s) => {
      const hit = modelForTier(tier, { connection: s.id, tierModels: s.tierModels, catalog: s.catalog })
      return `${s.name}: ${hit?.model ?? 'not mapped'}`
    })
    return `${name} → ${parts.join(' · ')}`
  }
  if (!value || value === 'inherit') return undefined
  const offered = sources.filter((s) => (s.catalog ?? []).some((m) => m.connection === s.id && m.id === value))
  return offered.length ? `${offered.map((s) => s.name).join(' or ')} only.` : 'Not in any connection catalog; used as written where a project can run it.'
}

/** The hint under a tier setting; undefined for a model id. */
export function modelSettingHint(value: string): string | undefined {
  const tier = settingTier(value)
  return MODEL_TIER_OPTIONS.find((o) => o.value === tier)?.hint
}

type AssistantKey = 'setupModel' | 'mcpAssistModel' | 'skillAssistModel' | 'quickRunModel'

/** Shown when the saved settings lack the key (an older main process). */
export const ASSISTANT_MODEL_FALLBACK: Record<AssistantKey, string> = { setupModel: 'deep', mcpAssistModel: 'deep', skillAssistModel: 'deep', quickRunModel: 'everyday' }

/** The saved model setting of a built-in assistant ('' until settings load), kept current across saves. */
export function useAssistantModel(key: AssistantKey): string {
  const [value, setValue] = useState('')
  useEffect(() => {
    let live = true
    void window.orgai.settings.get().then((s) => {
      if (live) setValue(s[key] || ASSISTANT_MODEL_FALLBACK[key])
    }, () => undefined)
    const off = window.orgai.onSettingsChanged((s) => {
      setValue(s[key] || ASSISTANT_MODEL_FALLBACK[key])
    })
    return () => {
      live = false
      off()
    }
  }, [key])
  return value
}

/** Display name of an assistant's setting, resolved against the default connection's catalog when it is loaded. */
export function useAssistantModelName(key: AssistantKey): string {
  const value = useAssistantModel(key)
  const conn = useAppStore((s) => s.defaultConnection)
  const catalog = useAppStore((s) => s.models[conn ?? 'anthropic'])
  return value ? modelDisplayName(value, catalog) : 'the configured model'
}

/**
 * "Everyday tier (sonnet)": an assistant's model setting with the model it resolves to on `on` (the effective default
 * connection, which Chat and the MCP and Skill assistants run on). A concrete id keeps its catalog label. Pure.
 */
export function assistantModelLabel(value: string, on?: Pick<ModelSource, 'id' | 'tierModels' | 'catalog'>): string {
  if (!value) return 'the configured model'
  const tier = settingTier(value)
  const base = modelDisplayName(value, on?.catalog)
  if (!tier || !on) return base
  const hit = modelForTier(tier, { connection: on.id, tierModels: on.tierModels, catalog: on.catalog })
  return hit?.model ? `${base} (${hit.model})` : base
}

/** "Runs on Everyday tier (sonnet) via Anthropic" (no full stop): one wording for every assistant model line (N5). */
export function runsOnText(label: string, connectionName?: string): string {
  return `Runs on ${label}${connectionName ? ` via ${connectionName}` : ''}`
}

/** An assistant's model on the effective default connection: its label with the resolved model, and the connection name. */
export function useAssistantRunsOn(key: AssistantKey): { label: string; connection?: string; text: string } {
  const value = useAssistantModel(key)
  const conn = useAppStore((s) => s.defaultConnection)
  const tierModels = useAppStore((s) => (conn ? s.connections?.find((c) => c.connection.id === conn)?.connection.tierModels : undefined))
  const catalog = useAppStore((s) => (conn ? s.models[conn] : undefined))
  const label = assistantModelLabel(value, conn ? { id: conn, tierModels: tierModels ?? {}, catalog } : undefined)
  const connection = conn ? connectionLabel(conn) : undefined
  return { label, connection, text: runsOnText(label, connection) }
}
