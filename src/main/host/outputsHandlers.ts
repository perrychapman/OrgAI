/**
 * outputs:list / preview / forget / delete (types.ts "Run outputs"), served by the host dispatcher over an injected
 * OutputsServiceApi. The folder scope is read from the stored project at call time (outputScopeOf). Virtual project
 * ids have no outputs: list answers [] and preview 'none'; forget and delete reject. forget and delete push
 * outputs:changed ('removed') on the host's event bus. open / reveal / saveAs are desktop only (src/main/outputsIpc.ts).
 * Electron-free; relative imports only (noElectronImport.test.ts).
 */
import { isVirtualProjectId, OUTPUTS_IPC } from '../../shared/types'
import type { OutputPreview, OutputRef, Project, RunOutput } from '../../shared/types'
import type { OutputScope, OutputsServiceApi } from '../outputs/api'
import { outputScopeOf } from '../runtime/runManager'
import { outputArgs } from './args'
import type { HostEventBus } from './events'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HandleFn = (channel: string, fn: (ctx: any, ...args: any[]) => unknown) => void

export interface OutputsHandlerDeps {
  /** Absent = list [], preview 'none', forget / delete reject "Outputs are not available.". */
  outputs?: OutputsServiceApi
  /** The stored projects (get only). */
  projects: { get(id: string): Project | null }
  events: HostEventBus
  dataDir?: string
}

const NOT_AVAILABLE = 'Outputs are not available.'

/** Scope of a stored project, or a thrown sentence. */
export function outputScopeFor(deps: Pick<OutputsHandlerDeps, 'projects' | 'dataDir'>, projectId: string): OutputScope {
  const project = deps.projects.get(projectId)
  if (!project) throw new Error('Project not found')
  return outputScopeOf(project, deps.dataDir)
}

export function registerOutputsHandlers(handle: HandleFn, deps: OutputsHandlerDeps): void {
  const { outputs, events } = deps
  const changed = (ref: OutputRef): void => {
    try {
      events.emit(OUTPUTS_IPC.outputsChanged, { projectId: ref.projectId, ids: [ref.outputId], what: 'removed' })
    } catch {
      // A broken listener never fails the call (the bus logs it).
    }
  }
  handle(OUTPUTS_IPC.outputsList, (_e: unknown,id: unknown): RunOutput[] => {
    const projectId = outputArgs.projectId(id)
    if (isVirtualProjectId(projectId) || !outputs) return []
    if (!deps.projects.get(projectId)) throw new Error('Project not found')
    return outputs.list(projectId)
  })
  handle(OUTPUTS_IPC.outputsPreview, async (_e: unknown,input: unknown): Promise<OutputPreview> => {
    const ref = outputArgs.ref(input)
    if (isVirtualProjectId(ref.projectId)) return { kind: 'none', reason: 'Assistants have no outputs.' }
    if (!outputs) return { kind: 'none', reason: NOT_AVAILABLE }
    return outputs.preview(outputScopeFor(deps, ref.projectId), ref.outputId)
  })
  handle(OUTPUTS_IPC.outputsForget, (_e: unknown,input: unknown): RunOutput[] => {
    const ref = outputArgs.ref(input)
    if (isVirtualProjectId(ref.projectId)) throw new Error('Assistants have no outputs.')
    if (!outputs) throw new Error(NOT_AVAILABLE)
    if (!deps.projects.get(ref.projectId)) throw new Error('Project not found')
    const list = outputs.forget(ref.projectId, ref.outputId)
    changed(ref)
    return list
  })
  handle(OUTPUTS_IPC.outputsDelete, (_e: unknown,input: unknown): RunOutput[] => {
    const ref = outputArgs.ref(input)
    if (isVirtualProjectId(ref.projectId)) throw new Error('Assistants have no outputs.')
    if (!outputs) throw new Error(NOT_AVAILABLE)
    const list = outputs.delete(outputScopeFor(deps, ref.projectId), ref.outputId)
    changed(ref)
    return list
  })
}
