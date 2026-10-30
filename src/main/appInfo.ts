import type { AppInfo } from '@shared/types'

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
