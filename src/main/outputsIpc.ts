/**
 * The desktop-only outputs channels (types.ts "Run outputs"): outputs:open (shell.openPath; also extends a watch),
 * outputs:reveal (shell.showItemInFolder), outputs:saveAs (a save dialog parented to the calling window, then a copy)
 * and outputs:saveImage (an exported diagram picture: PNG or SVG bytes from the renderer, saved through the same kind of
 * dialog). They need the OS shell and native dialogs, so no socket serves them (host registry: desktop_only). Every call
 * re-checks the entry through OutputsServiceApi.checkedPath (index entry, containment, regular file, no link, not a
 * reference folder or the data folder). open and reveal never reject: a refusal comes back as its sentence. saveAs and
 * saveImage reject with the sentence; a cancelled dialog answers { cancelled: true }. The destination path of a save
 * comes only from the native dialog, never from the renderer.
 */
import { randomBytes } from 'node:crypto'
import { copyFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { BrowserWindow, dialog, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { isVirtualProjectId, OUTPUTS_IPC, OUTPUT_EXPORT_IMAGE_MAX_BYTES } from '@shared/types'
import type { OutputSaveAsResult, OutputSaveImageInput, Project } from '@shared/types'
import { outputArgs } from './host/args'
import { log } from './log'
import type { OutputScope, OutputsServiceApi } from './outputs/api'
import { NOT_OPENABLE_MESSAGE, isOpenablePath } from './outputs/paths'
import { svgProblem } from './outputs/writers'
import type { OutputWatcher } from './outputs/watch'
import { outputScopeOf } from './runtime/runManager'

export interface OutputsIpcDeps {
  /** Absent = every channel answers "Outputs are not available.". */
  outputs?: OutputsServiceApi
  projects: { get(id: string): Project | null }
  dataDir?: string
  /** ipc.ts handleReadOnly: refuses a channel DESKTOP_CHANNEL_MUTATES does not list as read-only. */
  handleReadOnly: (channel: string, fn: (e: IpcMainInvokeEvent, ...args: never[]) => unknown) => void
  /** outputs:open extends an active watch on the file (outputs/watch.ts). */
  watcher?: OutputWatcher
}

const NOT_AVAILABLE = 'Outputs are not available.'
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

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

/**
 * The bytes of an exported picture, or a thrown sentence: strict base64 (no whitespace, no URL-safe alphabet, correct
 * padding), at most OUTPUT_EXPORT_IMAGE_MAX_BYTES decoded; a PNG must start with the PNG signature; an SVG must be
 * strict UTF-8 text that passes the same active-content rules as the preview gate (writers.ts svgProblem).
 */
export function decodeExportImage(input: Pick<OutputSaveImageInput, 'mime' | 'dataBase64'>): Buffer {
  const b64 = input.dataBase64
  if (!b64 || b64.length % 4 !== 0 || !BASE64_RE.test(b64)) throw new Error('The picture is not valid.')
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  const size = (b64.length / 4) * 3 - padding
  if (size > OUTPUT_EXPORT_IMAGE_MAX_BYTES) throw new Error('The picture is too large to save.')
  const bytes = Buffer.from(b64, 'base64')
  if (bytes.length !== size || bytes.length === 0) throw new Error('The picture is not valid.')
  if (input.mime === 'image/png') {
    if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error('That is not a PNG picture.')
    return bytes
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('The drawing is not valid text.')
  }
  const problem = svgProblem(text)
  if (problem) throw new Error(`This drawing contains active content or is not a plain SVG: ${problem}`)
  return bytes
}

const RESERVED_NAME_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i

/** A base name (no folders, no extension) from the renderer's suggestion, then the right extension. Never a path. */
export function exportImageName(suggested: string, mime: OutputSaveImageInput['mime'], fallback: string): string {
  const ext = mime === 'image/png' ? '.png' : '.svg'
  const clean = (s: string): string => {
    const last = s.split(/[\\/]/).pop() ?? ''
    // Control characters and the characters Windows refuses; a trailing dot or space is refused too.
    let base = Array.from(last)
      .filter((ch) => ch.codePointAt(0)! >= 32 && ch.codePointAt(0)! !== 127 && !'<>:"|?*'.includes(ch))
      .join('')
    base = base.replace(/\.(png|svg|jpe?g|gif|webp)$/i, '').replace(/[ .]+$/, '').replace(/^[ .]+/, '').trim()
    return base.slice(0, 100)
  }
  let base = clean(suggested) || clean(fallback) || 'diagram'
  if (RESERVED_NAME_RE.test(base)) base = `_${base}`
  return `${base}${ext}`
}

export function registerOutputsIpc(deps: OutputsIpcDeps): void {
  const handle = deps.handleReadOnly
  handle(OUTPUTS_IPC.outputsOpen, async (_e, raw: unknown): Promise<string> => {
    try {
      const c = checked(deps, raw)
      // Open only launches document / image / text types (paths.ts OPENABLE_EXTENSIONS), judged on the real file; the
      // service's own check and this one both run, the latter right before the OS call.
      const path = deps.outputs?.openablePath ? deps.outputs.openablePath(c.scope, c.outputId) : c.path
      if (!isOpenablePath(path)) throw new Error(NOT_OPENABLE_MESSAGE)
      // Opening hands the file to another app: keep watching it for the user's edits a while longer.
      deps.watcher?.touch({ projectId: c.scope.projectId, outputId: c.outputId })
      return await shell.openPath(path)
    } catch (e) {
      log.warn('outputs:open refused:', messageOf(e))
      return messageOf(e)
    }
  })
  handle(OUTPUTS_IPC.outputsReveal, (_e, raw: unknown): string => {
    try {
      shell.showItemInFolder(checked(deps, raw).path)
      return ''
    } catch (e) {
      log.warn('outputs:reveal refused:', messageOf(e))
      return messageOf(e)
    }
  })
  handle(OUTPUTS_IPC.outputsSaveAs, async (e, raw: unknown): Promise<OutputSaveAsResult> => {
    const first = checked(deps, raw)
    const entry = deps.outputs?.get(outputArgs.ref(raw).projectId, first.outputId)
    const options = { defaultPath: entry?.fileName || basename(first.path) }
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { cancelled: true }
    // The file may have changed while the dialog was open: check again right before the copy.
    const again = checked(deps, raw)
    // Copy beside the destination, then rename over it: a quit mid-copy never leaves a partial destination.
    const temp = join(dirname(result.filePath), `${basename(result.filePath)}.${randomBytes(6).toString('hex')}.part`)
    try {
      await copyFile(again.path, temp)
      await rename(temp, result.filePath)
    } catch (err) {
      await rm(temp, { force: true }).catch(() => {})
      throw err
    }
    return { path: result.filePath }
  })
  handle(OUTPUTS_IPC.outputsSaveImage, async (e, raw: unknown): Promise<OutputSaveAsResult> => {
    const input = outputArgs.saveImage(raw)
    if (isVirtualProjectId(input.projectId)) throw new Error('Assistants have no outputs.')
    if (!deps.outputs) throw new Error(NOT_AVAILABLE)
    if (!deps.projects.get(input.projectId)) throw new Error('Project not found')
    // The output must exist in the project (the picture is of one of its diagrams); the bytes are checked before any dialog.
    const entry = deps.outputs.get(input.projectId, input.outputId)
    if (!entry) throw new Error('Output not found')
    const bytes = decodeExportImage(input)
    const ext = input.mime === 'image/png' ? 'png' : 'svg'
    const defaultPath = exportImageName(input.suggestedName, input.mime, entry.title || entry.fileName)
    const options = { defaultPath, filters: [{ name: ext === 'png' ? 'PNG picture' : 'SVG drawing', extensions: [ext] }] }
    const win = BrowserWindow.fromWebContents(e.sender)
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { cancelled: true }
    // The destination is the dialog's, never the renderer's. Temp file beside it, then rename.
    const dest = result.filePath
    const temp = join(dirname(dest), `${basename(dest)}.${randomBytes(6).toString('hex')}.part`)
    try {
      await writeFile(temp, bytes, { flag: 'wx' })
      await rename(temp, dest)
    } catch (err) {
      await rm(temp, { force: true }).catch(() => {})
      throw err
    }
    return { path: dest }
  })
}
