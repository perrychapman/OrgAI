import { useEffect, useState } from 'react'
import type { ProviderModel } from '@shared/types'
import { MODEL_TIER_OPTIONS } from '@shared/types'
import { settingTier } from '@shared/defaults'
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

/**
 * Options for an app-wide model setting: the tiers first (they resolve per project), then the default connection's
 * catalog with recommended models marked. A saved value that is neither stays selectable as written. 'inherit' is
 * offered only when allowed.
 */
export function modelSettingGroups(value: string, catalog: readonly ProviderModel[] | undefined, allowInherit: boolean): ModelSettingGroup[] {
  const groups: ModelSettingGroup[] = [
    { label: 'Tiers', options: MODEL_TIER_OPTIONS.map((o) => ({ value: o.value, label: `${o.label} tier (resolves per project)` })) }
  ]
  if (allowInherit) groups.unshift({ label: 'Inherit', options: [{ value: 'inherit', label: 'Inherit from parent' }] })
  const models = catalog ?? []
  if (models.length) {
    groups.push({ label: 'Models', options: models.map((m) => ({ value: m.id, label: `${m.label || m.id}${m.recommended ? ' (recommended)' : ''}` })) })
  }
  const known = value === 'inherit' || MODEL_TIER_OPTIONS.some((o) => o.value === value) || models.some((m) => m.id === value)
  if (!known && value) groups.push({ label: 'Saved', options: [{ value, label: modelDisplayName(value, models) }] })
  return groups
}

/** The hint under a tier setting; undefined for a model id. */
export function modelSettingHint(value: string): string | undefined {
  return MODEL_TIER_OPTIONS.find((o) => o.value === value)?.hint
}

type AssistantKey = 'setupModel' | 'mcpAssistModel'

/** The saved model setting of a built-in assistant ('' until settings load), kept current across saves. */
export function useAssistantModel(key: AssistantKey): string {
  const [value, setValue] = useState('')
  useEffect(() => {
    let live = true
    void window.orgai.settings.get().then((s) => {
      if (live && s[key]) setValue(s[key])
    }, () => undefined)
    const off = window.orgai.onSettingsChanged((s) => {
      if (s[key]) setValue(s[key])
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
