/**
 * ORGAI_UPDATE_MOCK's scripted updater (renderer e2e only; index.ts uses it only when the app is NOT packaged). No
 * network, no files, no installer: every answer is canned and the download is a few timer steps. Modes:
 * src/shared/types.ts UPDATE_MOCK_MODES.
 */
import { UPDATE_MOCK_VERSION, type UpdateMockMode } from '@shared/types'
import type { TimerApi, UpdaterCheckResult, UpdaterLike, UpdaterProgressInfo } from './updater'

export const MOCK_RELEASE_NOTES =
  '<h2>OrgAI 99.0.0</h2><ul><li>A mock release for tests.</li><li>Notes arrive as HTML &amp; are shown as text.</li></ul>'
export const MOCK_DOWNLOAD_STEP_MS = 150
export const MOCK_TOTAL_BYTES = 100 * 1024 * 1024

export function createMockUpdater(mode: UpdateMockMode, timers?: TimerApi): UpdaterLike {
  const t: TimerApi = timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }
  const progress: Array<(p: UpdaterProgressInfo) => void> = []
  const wait = (ms: number): Promise<void> => new Promise((resolve) => t.setTimeout(resolve, ms))
  return {
    async checkForUpdates(): Promise<UpdaterCheckResult | null> {
      await wait(MOCK_DOWNLOAD_STEP_MS)
      if (mode === 'error') throw new Error('net::ERR_INTERNET_DISCONNECTED (mock)')
      if (mode === 'up-to-date') return { isUpdateAvailable: false, updateInfo: { version: '0.0.0' } }
      return { isUpdateAvailable: true, updateInfo: { version: UPDATE_MOCK_VERSION, releaseNotes: MOCK_RELEASE_NOTES } }
    },
    async downloadUpdate(): Promise<unknown> {
      for (const percent of [10, 35, 60, 85]) {
        await wait(MOCK_DOWNLOAD_STEP_MS)
        for (const cb of progress) cb({ percent, transferred: Math.round((MOCK_TOTAL_BYTES * percent) / 100), total: MOCK_TOTAL_BYTES })
        if (mode === 'download-error' && percent >= 60) throw new Error('ECONNRESET (mock)')
      }
      await wait(MOCK_DOWNLOAD_STEP_MS)
      for (const cb of progress) cb({ percent: 100, transferred: MOCK_TOTAL_BYTES, total: MOCK_TOTAL_BYTES })
      return []
    },
    install(): boolean {
      return false
    },
    onProgress(cb): void {
      progress.push(cb)
    }
  }
}
