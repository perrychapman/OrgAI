/**
 * Electron-free argument builders and pure helpers shared by the host dispatcher and ipc.ts (cli-spec Wave 1).
 * Relative imports only (noElectronImport.test.ts).
 */
import { existsSync } from 'node:fs'
import type { AppSettings, ConnectionId, Project, RunSummary } from '../../shared/types'
import { harnessProject as buildHarnessProject } from '../mcp/assist'
import { scratchDirFor } from '../quick/scratch'

/**
 * The project a harness-level run continues or auto-resumes in. A build session (summary.buildWorkspace) gets its
 * workspace back (harnessProject allowBuild) only when the recorded path is exactly a <data>/quick/quick_<id> scratch
 * dir that still exists; a forged or vanished path throws instead of running without the workspace. Exported for tests.
 */
export function harnessProjectFor(
  summary: Pick<RunSummary, 'buildWorkspace'>,
  settings: AppSettings,
  dataDir: string,
  mock: boolean,
  exists: (p: string) => boolean = existsSync
): Project {
  const ws = summary.buildWorkspace
  if (ws === undefined) return buildHarnessProject(settings, dataDir, { mock })
  const dir = scratchDirFor(dataDir, ws)
  if (!dir || !exists(dir)) throw new Error("This build session's workspace is gone; start a new one.")
  return buildHarnessProject(settings, dataDir, { mock, allowBuild: true, workspace: dir })
}

/**
 * The settings the renderer sees (settings:get / settings:set results, the settings:changed push): defaultConnection
 * is the effective default, never the stored value (defaultConnectionChosen still says whether the user picked it;
 * settings:set keeps the stored value whatever is echoed back). Pure; exported for tests and index.ts.
 */
export function withEffectiveDefault(s: AppSettings, effective: ConnectionId): AppSettings {
  return { ...s, defaultConnection: effective }
}
