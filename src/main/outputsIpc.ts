/**
 * The desktop-only outputs channels (types.ts "Run outputs"): outputs:open (shell.openPath), outputs:reveal
 * (shell.showItemInFolder) and outputs:saveAs (a save dialog parented to the calling window, then a copy). They need the
 * OS shell and native dialogs, so no socket serves them (host registry: desktop_only). Every call re-checks the entry
 * through OutputsServiceApi.checkedPath (index entry, containment, regular file, no link, not a reference folder or
 * the data folder). open and reveal never reject: a refusal comes back as its sentence. saveAs rejects with the
 * sentence; a cancelled dialog answers { cancelled: true }.
 */
import { copyFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { isVirtualProjectId, OUTPUTS_IPC } from '@shared/types'
import type { OutputSaveAsResult, Project } from '@shared/types'
import { outputArgs } from './host/args'
import { log } from './log'
import type { OutputScope, OutputsServiceApi } from './outputs/api'
import { NOT_OPENABLE_MESSAGE, isOpenablePath } from './outputs/paths'
import { outputScopeOf } from './runtime/runManager'

export interface OutputsIpcDeps {
  /** Absent = every channel answers "Outputs are not available.". */
  outputs?: OutputsServiceApi
  projects: { get(id: string): Project | null }
  dataDir?: string
}

const NOT_AVAILABLE = 'Outputs are not available.'

function messageOf(e: unknown): string {
  return e instanceof Error && e.message ? e.message : 'OrgAI could not open that output.'
}

/** The checked absolute path of an output, or a thrown sentence. */
function checked(deps: OutputsIpcDeps, raw: unknown): { path: string; scope: OutputScope; outputId: string } {
  const ref = outputArgs.ref(raw)
  if (isVirtualProjectId(ref.projectId)) throw new Error('Assistants have no outputs.')
  if (!deps.outputs) throw new Error(NOT_AVAILABLE)
  const project = deps.projects.get(ref.projectId)
  if (!project) throw new Error('Project not found')
  const scope = outputScopeOf(project, deps.dataDir)
  return { path: deps.outputs.checkedPath(scope, ref.outputId), scope, outputId: ref.outputId }
}

export function registerOutputsIpc(deps: OutputsIpcDeps): void {
  ipcMain.handle(OUTPUTS_IPC.outputsOpen, async (_e, raw: unknown): Promise<string> => {
    try {
      const c = checked(deps, raw)
      // Open only launches document / image / text types (paths.ts OPENABLE_EXTENSIONS), judged on the real file; the
      // service's own check and this one both run, the latter right before the OS call.
      const path = deps.outputs?.openablePath ? deps.outputs.openablePath(c.scope, c.outputId) : c.path
      if (!isOpenablePath(path)) throw new Error(NOT_OPENABLE_MESSAGE)
      return await shell.openPath(path)
    } catch (e) {
      log.warn('outputs:open refused:', messageOf(e))
      return messageOf(e)
    }
  })
  ipcMain.handle(OUTPUTS_IPC.outputsReveal, (_e, raw: unknown): string => {
    try {
      shell.showItemInFolder(checked(deps, raw).path)
      return ''
    } catch (e) {
      log.warn('outputs:reveal refused:', messageOf(e))
      return messageOf(e)
    }
  })
  ipcMain.handle(OUTPUTS_IPC.outputsSaveAs, async (e, raw: unknown): Promise<OutputSaveAsResult> => {
    const first = checked(deps, raw)
    const entry = deps.outputs?.get(outputArgs.ref(raw).projectId, first.outputId)
    const options = { defaultPath: entry?.fileName || basename(first.path) }
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { cancelled: true }
    // The file may have changed while the dialog was open: check again right before the copy.
    const again = checked(deps, raw)
    await copyFile(again.path, result.filePath)
    return { path: result.filePath }
  })
}
