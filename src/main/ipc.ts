/**
 * The Electron adapter over the host dispatcher (cli-spec Wave 1). Every request handler lives in host/dispatcher.ts;
 * this module registers them with ipcMain, keeps the 11 desktop-only channels (native dialogs, picked paths, the
 * menu, the OS shell, the notifications mirror) and forwards the host's push bus to windows when it made the bus
 * itself. The pure argument builders live in host/args.ts and are re-exported here for the existing tests.
 */
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { CliShimResult, CliShimStatus, FocusRunTarget, KitApplyResult, KitExportResult, KitImportPreview, SkillLibraryFolderInput, SkillLibraryInfo } from '@shared/types'
import { HOST_IPC, HOST_METHODS, IPC, KIT_IPC } from '@shared/types'
import { applyArgs as kitApplyArgs, exportArgs as kitExportArgs, type KitService } from './kit/service'
import { PickedPaths, kitExportTarget } from './kit/pickedPaths'
import { isInsideEither, samePath } from './quick/scratch'
import { existsSync, lstatSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { hiddenCharProblem } from './capabilities/sanitize'
import { cleanMenuState, setMenuState } from './appMenu'
import { log, logPath, logsDir } from './log'
import { obj } from './host/args'
import { HostDispatcher } from './host/dispatcher'
import type { HostDispatchEnv, HostServices } from './host/types'
import { CLI_SHIM_UNAVAILABLE, type CliShimService } from './host/shimInstaller'

/**
 * What registerIpc serves: the host services (host/types.ts HostServices; the shared field docs live there) plus the
 * Electron-only window opener. `usage` registers usage:refresh; `events` given means the caller forwards the bus to
 * windows; `dispatcher` given is used instead of a new one (its services win over these).
 */
export interface IpcServices extends Omit<HostServices, 'desktop'> {
  /**
   * window:openRun after validation: focus the window already scoped to this run, or open a new one at
   * `#/run/<projectId>/<runId>` (index.ts window factory).
   */
  openRunWindow(target: FocusRunTarget): void
  /** The host dispatcher to serve; absent = registerIpc builds one over these services. */
  dispatcher?: HostDispatcher
  /** The orgai command shim (cli-spec 7(3)); absent = app:cliShim* answer CLI_SHIM_UNAVAILABLE. */
  cliShim?: CliShimService
}

export { harnessProjectFor, withEffectiveDefault } from './host/args'
export {
  ASSIST_INSTRUCTION_MAX_CHARS,
  CONNECTION_SECRET_MAX_CHARS,
  CONNECTOR_TOKEN_MAX_CHARS,
  OVERRIDES_MAX_KEYS,
  PERMISSION_RULE_MAX_CHARS,
  PROPOSAL_SECRETS_MAX,
  capabilityArgs,
  checkQuickContinue,
  connectionIdArg,
  connectionSecretArgs,
  connectorArgs,
  effectiveRemoveRuns,
  knowledgeArgs,
  mcpAssistArgs,
  mcpCopyArgs,
  mcpLibrarySecretArgs,
  mcpOverridesArgs,
  mcpSecretArgs,
  modelsQueryArg,
  permissionAddRefusal,
  permissionRuleArgs,
  presetRemoveArgs,
  projectRemoveArgs,
  proposalDecideArgs,
  quickArgs,
  removalFacts,
  settingsSetArgs,
  skillAssistArgs,
  templateEngagementArgs
} from './host/args'
export type { RemovalDeps } from './host/args'

/** The channels only the Electron shell serves (cli-spec 3.3(3) `request: desktop_only`); refused over the socket. */
export const DESKTOP_ONLY_CHANNELS: readonly string[] = [
  IPC.projectsPickDir,
  IPC.skillLibraryAddFromFolder,
  KIT_IPC.kitPickExportPath,
  KIT_IPC.kitPickImportPath,
  KIT_IPC.kitExport,
  KIT_IPC.kitPreviewImport,
  KIT_IPC.kitApplyImport,
  IPC.menuSetState,
  IPC.appOpenPath,
  IPC.appOpenLogs,
  IPC.appSetNotifications,
  IPC.appCliShimStatus,
  IPC.appInstallCliShim,
  IPC.appUninstallCliShim
]

/** Served over the socket only: HOST_IPC channels and host.* methods never get an ipcMain handler. */
const SOCKET_ONLY: ReadonlySet<string> = new Set<string>([...Object.values(HOST_IPC), ...Object.values(HOST_METHODS)])

export function registerIpc(services: IpcServices): void {
  const { projects, settings, skills, kit } = services
  const env: HostDispatchEnv = services.env ?? { app, platform: process.platform, logsDir }
  const dispatcher = services.dispatcher ?? new HostDispatcher({ ...services, env, desktop: { openRunWindow: services.openRunWindow } })

  // Window forwarding: only for a bus registerIpc made itself. A caller that passes `events` forwards it (index.ts).
  if (!services.events && !services.dispatcher) {
    dispatcher.events.on((channel, payload) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(channel, payload)
      }
    })
  }

  for (const channel of dispatcher.channels()) {
    if (SOCKET_ONLY.has(channel)) continue
    // Compatibility: usage:refresh only with a usage monitor (the dispatcher answers null without one).
    if (channel === IPC.usageRefresh && !services.usage && !services.dispatcher) continue
    ipcMain.handle(channel, (e: IpcMainInvokeEvent, ...args: unknown[]) => dispatcher.invoke(channel, args, { surface: 'desktop', senderId: e?.sender?.id }))
  }

  // ---- Desktop-only channels ----
  ipcMain.handle(IPC.projectsPickDir, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    const picked = result.canceled ? null : result.filePaths[0] ?? null
    if (picked) rememberPickedFolder(e.sender, picked)
    return picked
  })
  ipcMain.handle(IPC.skillLibraryAddFromFolder, (e, input: unknown): SkillLibraryInfo[] => {
    const i = obj<SkillLibraryFolderInput>(input)
    if (typeof i.path !== 'string' || !i.path) throw new Error('Choose a skill folder.')
    if (!pickedFolders.take(e.sender.id, i.path)) throw new Error('Choose the skill folder with the folder picker first.')
    return skills.libraryAddFromFolder({ path: i.path })
  })
  // Deprecated (phase 1 removes NotificationsToggle): a mirror of AppSettings.notifications, the only source the
  // notifier reads.
  ipcMain.handle(IPC.appSetNotifications, (_e, enabled: boolean): void => {
    settings.set({ ...settings.get(), notifications: !!enabled })
  })
  // Returns shell.openPath's contract: an error message, or '' on success. Never throws to the renderer.
  ipcMain.handle(IPC.appOpenPath, async (_e, path: unknown): Promise<string> => {
    try {
      const list = projects.list()
      const refusal = openPathRefusal(path, {
        dataDir: settings.dataDir,
        projectPaths: list.map((p) => p.path),
        allowedDirectories: list.flatMap((p) => p.allowedDirectories ?? []),
        stat: lstatDirectory
      })
      if (refusal) {
        log.warn('app:openPath refused:', refusal)
        return refusal
      }
      return await shell.openPath(path as string)
    } catch (err) {
      log.warn('app:openPath failed:', err instanceof Error ? err.message : String(err))
      return 'OrgAI could not open that folder.'
    }
  })
  ipcMain.handle(IPC.appOpenLogs, async () => {
    logPath() // creates the folder if nothing has been logged yet
    const error = await shell.openPath(logsDir())
    if (error) log.warn(`Could not open logs folder: ${error}`)
  })
  // What the renderer shows, for enabling application menu items. Booleans only; nothing is echoed back.
  ipcMain.handle(IPC.menuSetState, (e, input: unknown): void => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win && !win.isDestroyed()) setMenuState(win, cleanMenuState(input))
  })
  registerCliShimIpc(services.cliShim)
  if (kit) registerKitIpc(kit)
}

// ---- orgai command shim (cli-spec 7(3)); desktop only, never throws to the renderer ----

function cliShimStatusOf(shim: CliShimService | undefined): CliShimStatus {
  try {
    return shim?.status() ?? CLI_SHIM_UNAVAILABLE
  } catch (err) {
    log.warn('app:cliShimStatus failed:', err instanceof Error ? err.message : String(err))
    return CLI_SHIM_UNAVAILABLE
  }
}

function registerCliShimIpc(shim: CliShimService | undefined): void {
  const unavailable = (): CliShimResult => ({ ok: false, message: CLI_SHIM_UNAVAILABLE.reason ?? '', status: CLI_SHIM_UNAVAILABLE })
  const change = (what: 'install' | 'uninstall') => async (): Promise<CliShimResult> => {
    if (!shim) return unavailable()
    try {
      return await shim[what]()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn(`app:${what}CliShim failed:`, message)
      return { ok: false, message: `OrgAI could not change the orgai command: ${message}`, status: cliShimStatusOf(shim) }
    }
  }
  ipcMain.handle(IPC.appCliShimStatus, (): CliShimStatus => cliShimStatusOf(shim))
  ipcMain.handle(IPC.appInstallCliShim, change('install'))
  ipcMain.handle(IPC.appUninstallCliShim, change('uninstall'))
}

// ---- Practice kit ----

const kitExportPicks = new PickedPaths()
const kitImportPicks = new PickedPaths()
const kitTrackedSenders = new Set<number>()
function rememberKitPath(picks: PickedPaths, sender: WebContents, path: string): void {
  picks.remember(sender.id, path)
  if (kitTrackedSenders.has(sender.id)) return
  kitTrackedSenders.add(sender.id)
  const id = sender.id
  sender.once('destroyed', () => {
    kitExportPicks.forget(id)
    kitImportPicks.forget(id)
    kitTrackedSenders.delete(id)
  })
}

/**
 * kit:* channels. The save and open dialogs are main's own; kit:export, kit:previewImport and kit:applyImport accept
 * only a path the same renderer picked (an export path is consumed by a successful export). Inputs are rebuilt field by
 * field (`exportArgs`, `applyArgs`).
 */
function registerKitIpc(kit: KitService): void {
  const pickedPath = (input: unknown): string => {
    const p = input && typeof input === 'object' && !Array.isArray(input) ? (input as { path?: unknown }).path : undefined
    if (typeof p !== 'string' || !p || p.length > 4096) throw new Error('Choose a kit file.')
    return p
  }
  ipcMain.handle(KIT_IPC.kitPickExportPath, async (e): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const options = { title: 'Save a practice kit', defaultPath: 'practice.orgai-kit.json', filters: [{ name: 'OrgAI kit', extensions: ['json'] }] }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    const path = kitExportTarget(result.filePath, existsSync)
    rememberKitPath(kitExportPicks, e.sender, path)
    return path
  })
  ipcMain.handle(KIT_IPC.kitPickImportPath, async (e): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const options = { title: 'Import a practice kit', properties: ['openFile' as const], filters: [{ name: 'OrgAI kit', extensions: ['json'] }] }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    const path = result.canceled ? null : result.filePaths[0] ?? null
    if (path) rememberKitPath(kitImportPicks, e.sender, path)
    return path
  })
  ipcMain.handle(KIT_IPC.kitExport, (e, input: unknown): KitExportResult => {
    const i = kitExportArgs(input)
    if (!kitExportPicks.has(e.sender.id, i.path)) throw new Error('Choose where to save the kit with the Save dialog first.')
    const out = kit.export(i)
    kitExportPicks.take(e.sender.id, i.path)
    return out
  })
  ipcMain.handle(KIT_IPC.kitPreviewImport, (e, input: unknown): KitImportPreview => {
    const path = pickedPath(input)
    if (!kitImportPicks.has(e.sender.id, path)) throw new Error('Choose the kit file with the file dialog first.')
    return kit.previewImport({ path })
  })
  ipcMain.handle(KIT_IPC.kitApplyImport, (e, input: unknown): KitApplyResult => {
    const i = kitApplyArgs(input)
    if (!kitImportPicks.has(e.sender.id, i.path)) throw new Error('Choose the kit file with the file dialog first.')
    return kit.applyImport(i)
  })
}

/**
 * Folders the user chose in the main-process folder dialog (projects:pickDirectory), per renderer (`WebContents.id`),
 * newest last, at most PICKED_FOLDERS_PER_SENDER each. skillLibrary:addFromFolder accepts only a folder the same
 * renderer picked, and only once (`take` removes it), so a compromised renderer cannot copy an arbitrary folder (or a
 * UNC share) into the library and read it back, nor reuse a folder another window picked. Pure; exported for tests.
 */
export const PICKED_FOLDERS_PER_SENDER = 20
export class PickedFolders {
  private bySender = new Map<number, string[]>()
  remember(senderId: number, path: string): void {
    const list = (this.bySender.get(senderId) ?? []).filter((p) => p !== path)
    list.push(path)
    if (list.length > PICKED_FOLDERS_PER_SENDER) list.shift()
    this.bySender.set(senderId, list)
  }
  /** True (and forgotten) when `senderId` picked `path`; false otherwise. One-shot. */
  take(senderId: number, path: string): boolean {
    const list = this.bySender.get(senderId)
    const i = list ? list.indexOf(path) : -1
    if (!list || i === -1) return false
    list.splice(i, 1)
    if (list.length === 0) this.bySender.delete(senderId)
    return true
  }
  /** Drop everything a renderer picked (its WebContents was destroyed). */
  forget(senderId: number): void {
    this.bySender.delete(senderId)
  }
}
const pickedFolders = new PickedFolders()
const trackedSenders = new Set<number>()
function rememberPickedFolder(sender: WebContents, path: string): void {
  pickedFolders.remember(sender.id, path)
  if (trackedSenders.has(sender.id)) return
  trackedSenders.add(sender.id)
  const id = sender.id
  sender.once('destroyed', () => {
    pickedFolders.forget(id)
    trackedSenders.delete(id)
  })
}

export const OPEN_PATH_MAX_CHARS = 1024
export const OPEN_PATH_REFUSAL = "OrgAI only opens project folders, allowed folders and its own data folder."

/** lstat as a directory probe: a symlink or a file is not a directory; null when missing or unreadable. */
export function lstatDirectory(p: string): { isDirectory: boolean } | null {
  try {
    return { isDirectory: lstatSync(p).isDirectory() }
  } catch {
    return null
  }
}

/**
 * app:openPath guard (pure apart from the injected stat and path canonicalization): a refusal message, or null when
 * `path` may be handed to the OS. Only an existing real directory that is a stored project's folder, an entry of a
 * project's allowedDirectories, or the data folder / inside it, compared on lexical and real spellings.
 */
export function openPathRefusal(
  path: unknown,
  ctx: { dataDir: string; projectPaths: string[]; allowedDirectories: string[]; stat: (p: string) => { isDirectory: boolean } | null }
): string | null {
  if (typeof path !== 'string' || path.length === 0) return 'No folder was given.'
  if (path.length > OPEN_PATH_MAX_CHARS) return 'That path is too long.'
  if (path.includes('\0') || hiddenCharProblem('path', path)) return 'That path has hidden characters.'
  if (/^[\\/]{2}/.test(path)) return 'OrgAI does not open network or device paths.'
  const absolute = process.platform === 'win32' ? /^[a-zA-Z]:[\\/]/.test(path) : isAbsolute(path)
  if (!absolute) return 'That path is not absolute.'
  const st = ctx.stat(path)
  if (!st) return 'That folder does not exist.'
  if (!st.isDirectory) return 'OrgAI only opens folders.'
  try {
    const known = [...ctx.projectPaths, ...ctx.allowedDirectories].some((p) => typeof p === 'string' && p !== '' && samePath(p, path))
    if (known || isInsideEither(ctx.dataDir, path)) return null
  } catch {
    // fall through: fail closed
  }
  return OPEN_PATH_REFUSAL
}

