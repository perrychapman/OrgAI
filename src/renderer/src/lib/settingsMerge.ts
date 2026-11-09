import type { AppSettings, AppSettingsInfo } from '@shared/types'

/**
 * A queued App settings save after settings:changed arrived from elsewhere (another window, or main changing a
 * setting itself): the incoming settings with only the fields this view edited laid on top, so a debounced flush never
 * writes back a stale copy of a field it did not touch.
 */
export function mergePendingSettings(pending: AppSettings, incoming: AppSettingsInfo, edited: ReadonlySet<keyof AppSettings>): AppSettings {
  const { dataDir: _dataDir, appVersion: _appVersion, ...base } = incoming
  const out: AppSettings = { ...base }
  const target = out as unknown as Record<string, unknown>
  const source = pending as unknown as Record<string, unknown>
  for (const key of edited) target[key] = source[key]
  return out
}
