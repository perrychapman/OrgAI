import type { AppInfo, AppSettings, AppSettingsInfo, ThemeMode } from '@shared/types'
import { THEME_BACKGROUND } from '@shared/defaults'

/** The parts of Electron's `app` that `app:info` reads; a plain object in tests. */
export interface AppLike {
  getVersion(): string
  getPath(name: 'userData'): string
  isPackaged: boolean
}

/**
 * Builds the `app:info` answer. `adapterIds` are the keys of the adapters map RunManager received, so `mockAdapter`
 * reflects what is actually registered rather than re-reading ORGAI_MOCK.
 */
export function buildAppInfo(app: AppLike, input: { platform: string; logsDir: string; adapterIds: readonly string[] }): AppInfo {
  return {
    version: app.getVersion(),
    platform: String(input.platform),
    dataDir: app.getPath('userData'),
    logsDir: input.logsDir,
    mockAdapter: input.adapterIds.includes('mock'),
    packaged: Boolean(app.isPackaged)
  }
}

/** What settings:get, settings:set and settings:changed send: the stored settings plus read-only install facts. */
export function buildSettingsInfo(settings: AppSettings, facts: { dataDir: string; appVersion: string }): AppSettingsInfo {
  return { ...settings, dataDir: facts.dataDir, appVersion: facts.appVersion }
}

/** Drop the read-only AppSettingsInfo fields a renderer may echo back to settings:set. */
export function stripSettingsInfo(next: AppSettings | AppSettingsInfo): AppSettings {
  const { dataDir: _dataDir, appVersion: _appVersion, ...rest } = next as AppSettingsInfo
  return rest
}

/**
 * The window background before the renderer paints, so a light theme does not flash dark. `systemDark` is
 * nativeTheme.shouldUseDarkColors, consulted only for 'system'.
 */
export function windowBackground(theme: ThemeMode, systemDark: boolean): string {
  const dark = theme === 'dark' || (theme === 'system' && systemDark)
  return dark ? THEME_BACKGROUND.dark : THEME_BACKGROUND.light
}
