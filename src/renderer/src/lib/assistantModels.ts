import { useEffect, useState } from 'react'
import type { ConnectionId, ConnectionInfo, ProviderModel } from '@shared/types'
import { MODEL_TIER_OPTIONS } from '@shared/types'
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

const CONNECTION_NAMES: Record<ConnectionId, string> = { anthropic: 'Anthropic', openai: 'OpenAI', litellm: 'LiteLLM' }

/** The usable connections (Anthropic always, the others when enabled), in a stable order, with their loaded catalogs. */
export function modelSources(
  connections: readonly ConnectionInfo[] | null | undefined,
  models: Partial<Record<ConnectionId, ProviderModel[]>>
): ModelSource[] {
  const list = connections ?? []
  return (['anthropic', 'openai', 'litellm'] as ConnectionId[]).flatMap((id): ModelSource[] => {
    const c = list.find((x) => x.connection.id === id)?.connection
    if (id !== 'anthropic' && !c?.enabled) return []
    return [{ id, name: CONNECTION_NAMES[id], tierModels: c?.tierModels ?? {}, catalog: models[id] }]
  })
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
  const withCatalog = sources.filter((s) => (s.catalog ?? []).some((m) => m.connection === s.id))
  const exact: ModelSettingOption[] = []
  for (const src of withCatalog) {
    for (const m of (src.catalog ?? []).filter((x) => x.connection === src.id)) {
      exact.push({ value: m.id, label: `${m.label || m.id}${m.recommended ? ' (recommended)' : ''}${withCatalog.length > 1 ? ` · ${src.name}` : ''}` })
    }
  }
  const all = sources.flatMap((s) => s.catalog ?? [])
  const known = value === 'inherit' || MODEL_TIER_OPTIONS.some((o) => o.value === value) || all.some((m) => m.id === value)
  if (!known && value) exact.push({ value, label: modelDisplayName(value, all) })
  if (exact.length) groups.push({ label: 'Exact model', options: exact })
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
