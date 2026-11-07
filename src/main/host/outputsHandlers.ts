/**
 * The outputs:* channels the host dispatcher serves (types.ts "Run outputs", OUTPUTS_IPC) over an injected
 * OutputsServiceApi: list / preview / deletePreview / versions / readSource / thumb / compare / notes / revisions /
 * reviseOptions (read), forget / delete / saveEdit / restore / update (configure), noteAdd / noteUpdate / noteRemove /
 * revise / watch / unwatch (operate). The folder scope is read from the stored project at call time (outputScopeFor).
 * Virtual project ids have no outputs: reads answer empty or 'none', writes reject "Assistants have no outputs.".
 * Every write pushes outputs:changed on the host's event bus with the right `what`. open / reveal / saveAs / saveImage
 * are desktop only (src/main/outputsIpc.ts). Electron-free; relative imports only (noElectronImport.test.ts).
 */
import { isVirtualProjectId, OUTPUTS_IPC } from '../../shared/types'
import type {
  OutputDeletePreview,
  OutputDiff,
  OutputNote,
  OutputPreview,
  OutputRef,
  OutputRestoreResult,
  OutputReviseOptions,
  OutputReviseResult,
  OutputRevisionRequest,
  OutputSaveEditResult,
  OutputSourceResult,
  OutputThumb,
  OutputVersion,
  OutputWatchResult,
  OutputsChangedEvent,
  Project,
  RunOutput
} from '../../shared/types'
import type { OutputScope, OutputsServiceApi } from '../outputs/api'
import { reviseOptions, reviseOutput } from '../outputs/revise'
import type { ReviseRunsApi } from '../outputs/revise'
import type { OutputWatcher } from '../outputs/watch'
import { outputScopeOf } from '../runtime/runManager'
import { outputArgs } from './args'
import type { HostEventBus } from './events'
import type { InvokeContext } from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HandleFn = (channel: string, fn: (ctx: any, ...args: any[]) => unknown) => void

export interface OutputsHandlerDeps {
  /** Absent = reads answer empty / 'none', writes reject "Outputs are not available.". */
  outputs?: OutputsServiceApi
  /** The stored projects (get only). */
  projects: { get(id: string): Project | null }
  events: HostEventBus
  dataDir?: string
  /** RunManager, for outputs:revise and outputs:reviseOptions. Absent = no options and a revise is refused. */
  runs?: ReviseRunsApi
  /** The watcher behind outputs:watch / unwatch; absent = a watch is refused. */
  watcher?: OutputWatcher
}

const NOT_AVAILABLE = 'Outputs are not available.'
const NO_ASSISTANT_OUTPUTS = 'Assistants have no outputs.'

/** Scope of a stored project, or a thrown sentence. */
export function outputScopeFor(deps: Pick<OutputsHandlerDeps, 'projects' | 'dataDir'>, projectId: string): OutputScope {
  const project = deps.projects.get(projectId)
  if (!project) throw new Error('Project not found')
  return outputScopeOf(project, deps.dataDir)
}

/** Who owns a watch: a window (its web contents id) or a socket client (its pid, as far as the context tells). */
export function watchOwnerOf(ctx: Pick<InvokeContext, 'surface' | 'senderId' | 'pid' | 'clientKind'>): string {
  if (ctx.surface === 'desktop') return `window:${ctx.senderId ?? 0}`
  return `${ctx.surface}:${ctx.pid ?? ctx.clientKind ?? 'client'}`
}

export function registerOutputsHandlers(handle: HandleFn, deps: OutputsHandlerDeps): void {
  const { outputs, events } = deps
  const push = (projectId: string, ids: string[], what: OutputsChangedEvent['what']): void => {
    try {
      events.emit(OUTPUTS_IPC.outputsChanged, { projectId, ids, what })
    } catch {
      // A broken listener never fails the call (the bus logs it).
    }
  }
  /** The service, or a thrown sentence, for a write on a stored project (virtual ids reject). */
  const writable = (projectId: string): OutputsServiceApi => {
    if (isVirtualProjectId(projectId)) throw new Error(NO_ASSISTANT_OUTPUTS)
    if (!outputs) throw new Error(NOT_AVAILABLE)
    if (!deps.projects.get(projectId)) throw new Error('Project not found')
    return outputs
  }
  /** Reads: the service, or null for a virtual project / no service (the caller answers empty). */
  const readable = (projectId: string): OutputsServiceApi | null => {
    if (isVirtualProjectId(projectId) || !outputs) return null
    if (!deps.projects.get(projectId)) throw new Error('Project not found')
    return outputs
  }

  // ---- reads ----
  handle(OUTPUTS_IPC.outputsList, (_e: unknown, id: unknown): RunOutput[] => {
    const projectId = outputArgs.projectId(id)
    return readable(projectId)?.list(projectId) ?? []
  })
  handle(OUTPUTS_IPC.outputsPreview, async (_e: unknown, input: unknown): Promise<OutputPreview> => {
    const i = outputArgs.preview(input)
    if (isVirtualProjectId(i.projectId)) return { kind: 'none', reason: NO_ASSISTANT_OUTPUTS }
    if (!outputs) return { kind: 'none', reason: NOT_AVAILABLE }
    deps.watcher?.noteOpened(i)
    return outputs.preview(outputScopeFor(deps, i.projectId), i.outputId, i.version)
  })
  handle(OUTPUTS_IPC.outputsDeletePreview, (_e: unknown, input: unknown): OutputDeletePreview => {
    const ref = outputArgs.ref(input)
    return writable(ref.projectId).deletePreview(outputScopeFor(deps, ref.projectId), ref.outputId)
  })
  handle(OUTPUTS_IPC.outputsVersions, (_e: unknown, input: unknown): OutputVersion[] => {
    const ref = outputArgs.ref(input)
    return readable(ref.projectId)?.versions(ref.projectId, ref.outputId) ?? []
  })
  handle(OUTPUTS_IPC.outputsReadSource, async (_e: unknown, input: unknown): Promise<OutputSourceResult> => {
    const i = outputArgs.versionRef(input)
    const service = readable(i.projectId)
    if (!service) return { refused: isVirtualProjectId(i.projectId) ? NO_ASSISTANT_OUTPUTS : NOT_AVAILABLE }
    return service.readSource(outputScopeFor(deps, i.projectId), i.outputId, i.version)
  })
  handle(OUTPUTS_IPC.outputsThumb, async (_e: unknown, input: unknown): Promise<OutputThumb> => {
    const i = outputArgs.versionRef(input)
    const service = readable(i.projectId)
    if (!service) return { kind: 'none' }
    return service.thumb(outputScopeFor(deps, i.projectId), i.outputId, i.version)
  })
  handle(OUTPUTS_IPC.outputsCompare, async (_e: unknown, input: unknown): Promise<OutputDiff> => {
    const i = outputArgs.compare(input)
    const service = readable(i.projectId)
    if (!service) return { kind: 'none', reason: isVirtualProjectId(i.projectId) ? NO_ASSISTANT_OUTPUTS : NOT_AVAILABLE }
    return service.compare(outputScopeFor(deps, i.projectId), { outputId: i.outputId, a: i.a, b: i.b })
  })
  handle(OUTPUTS_IPC.outputsNotes, (_e: unknown, input: unknown): OutputNote[] => {
    const ref = outputArgs.ref(input)
    return readable(ref.projectId)?.notes(ref.projectId, ref.outputId) ?? []
  })
  handle(OUTPUTS_IPC.outputsRevisions, (_e: unknown, input: unknown): OutputRevisionRequest[] => {
    const ref = outputArgs.ref(input)
    return readable(ref.projectId)?.revisions(ref.projectId, ref.outputId) ?? []
  })
  handle(OUTPUTS_IPC.outputsReviseOptions, (_e: unknown, input: unknown): OutputReviseOptions => {
    const ref = outputArgs.ref(input)
    const service = readable(ref.projectId)
    const project = deps.projects.get(ref.projectId)
    if (!service || !deps.runs || !project) return { runs: [], newRunAllowed: false }
    const output = service.get(ref.projectId, ref.outputId)
    if (!output) throw new Error('Output not found')
    return reviseOptions(project, output, deps.runs)
  })

  // ---- configure: remove and edit ----
  handle(OUTPUTS_IPC.outputsForget, (_e: unknown, input: unknown): RunOutput[] => {
    const ref: OutputRef = outputArgs.ref(input)
    const list = writable(ref.projectId).forget(ref.projectId, ref.outputId)
    deps.watcher?.release(ref)
    push(ref.projectId, [ref.outputId], 'removed')
    return list
  })
  handle(OUTPUTS_IPC.outputsDelete, async (_e: unknown, input: unknown): Promise<RunOutput[]> => {
    const i = outputArgs.delete(input)
    const service = writable(i.projectId)
    const list = await service.delete(outputScopeFor(deps, i.projectId), {
      outputId: i.outputId,
      ...(i.expectedVersionCount !== undefined ? { expectedVersionCount: i.expectedVersionCount } : {})
    })
    deps.watcher?.release(i)
    push(i.projectId, [i.outputId], 'removed')
    return list
  })
  handle(OUTPUTS_IPC.outputsSaveEdit, async (_e: unknown, input: unknown): Promise<OutputSaveEditResult> => {
    const i = outputArgs.saveEdit(input)
    const result = await writable(i.projectId).saveEdit(outputScopeFor(deps, i.projectId), {
      outputId: i.outputId,
      baseVersion: i.baseVersion,
      text: i.text,
      ...(i.forceNew !== undefined ? { forceNew: i.forceNew } : {})
    })
    if ('ok' in result) push(i.projectId, [i.outputId], 'version')
    return result
  })
  handle(OUTPUTS_IPC.outputsRestore, async (_e: unknown, input: unknown): Promise<OutputRestoreResult> => {
    const i = outputArgs.versionRef(input)
    const result = await writable(i.projectId).restore(outputScopeFor(deps, i.projectId), i.outputId, i.version)
    if ('ok' in result) push(i.projectId, [i.outputId], 'version')
    return result
  })
  handle(OUTPUTS_IPC.outputsUpdate, (_e: unknown, input: unknown): RunOutput => {
    const i = outputArgs.update(input)
    const { projectId, ...rest } = i
    const out = writable(projectId).update(projectId, rest)
    push(projectId, [i.outputId], 'updated')
    return out
  })

  // ---- operate: notes, revise, watch ----
  handle(OUTPUTS_IPC.outputsNoteAdd, (_e: unknown, input: unknown): OutputNote => {
    const i = outputArgs.noteAdd(input)
    const { projectId, ...rest } = i
    const note = writable(projectId).noteAdd(projectId, rest)
    push(projectId, [i.outputId], 'notes')
    return note
  })
  handle(OUTPUTS_IPC.outputsNoteUpdate, (_e: unknown, input: unknown): OutputNote => {
    const i = outputArgs.noteUpdate(input)
    const { projectId, ...rest } = i
    const note = writable(projectId).noteUpdate(projectId, rest)
    push(projectId, [i.outputId], 'notes')
    return note
  })
  handle(OUTPUTS_IPC.outputsNoteRemove, (_e: unknown, input: unknown): OutputNote[] => {
    const i = outputArgs.noteRemove(input)
    const list = writable(i.projectId).noteRemove(i.projectId, i.outputId, i.noteId)
    push(i.projectId, [i.outputId], 'notes')
    return list
  })
  handle(OUTPUTS_IPC.outputsRevise, async (_e: unknown, input: unknown): Promise<OutputReviseResult> => {
    const i = outputArgs.revise(input)
    if (isVirtualProjectId(i.projectId)) throw new Error(NO_ASSISTANT_OUTPUTS)
    if (!outputs || !deps.runs) return { refused: NOT_AVAILABLE }
    const project = deps.projects.get(i.projectId)
    if (!project) throw new Error('Project not found')
    const result = await reviseOutput({ outputs, runs: deps.runs, project }, i)
    if (!('refused' in result)) {
      push(i.projectId, [i.outputId], 'revision')
      if (i.scope === 'notes') push(i.projectId, [i.outputId], 'notes')
    }
    return result
  })
  handle(OUTPUTS_IPC.outputsWatch, (ctx: InvokeContext, input: unknown): OutputWatchResult => {
    const ref = outputArgs.ref(input)
    if (isVirtualProjectId(ref.projectId)) return { refused: NO_ASSISTANT_OUTPUTS }
    if (!outputs || !deps.watcher) return { refused: NOT_AVAILABLE }
    return deps.watcher.watch(watchOwnerOf(ctx), ref)
  })
  handle(OUTPUTS_IPC.outputsUnwatch, (ctx: InvokeContext, input: unknown): OutputWatchResult => {
    const ref = outputArgs.ref(input)
    deps.watcher?.unwatch(watchOwnerOf(ctx), ref)
    return { watched: false }
  })
}
