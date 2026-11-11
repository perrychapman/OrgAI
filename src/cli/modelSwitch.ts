/**
 * The terminal's live model switch (`orgai runs model`, the TUI's /model; cli-parity 3.5): the catalog of the connected
 * connections, a tier or id resolved to one catalog model, and `runs:switchModel` behind the SAME guard the desktop
 * applies (shared/liveModelSwitch.ts performModelSwitch: no open decisions, no working reports, an interrupt to reach
 * idle, a confirmed stop for a handoff). Plain Node: no ink or react.
 */
import { MODEL_TIERS, type ConnectionId, type ConnectionInfo, type ModelTier, type PendingCards, type ProviderModel, type RunRecord, type RunSummary, type SwitchRunModelResult } from '../shared/types'
import { modelSwitchOutcome, needsModelHandoff, modelSessionEnded, performModelSwitch, resolveModelChoice, tiersOfModel } from '../shared/liveModelSwitch'

export type HostCall = <T>(method: string, params: unknown[]) => Promise<T>

export interface ModelCatalog {
  connections: ConnectionInfo[]
  /** Models of the connected connections (the desktop picker's list). */
  models: ProviderModel[]
  /** Connections whose catalog could not be loaded. */
  failed: ConnectionId[]
}

/** The catalog the desktop's picker shows: models of every connected connection. */
export async function loadModelCatalog(call: HostCall): Promise<ModelCatalog> {
  const raw = await call<ConnectionInfo[]>('connections:list', [])
  const connections = Array.isArray(raw) ? raw : []
  const connected = connections.filter((c) => c.status?.state === 'connected')
  const results = await Promise.allSettled(connected.map((c) => call<ProviderModel[]>('models:list', [{ connection: c.connection.id }])))
  const models = results.flatMap((r) => (r.status === 'fulfilled' && Array.isArray(r.value) ? r.value : []))
  const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [connected[i].connection.id] : []))
  return { connections, models, failed }
}

const BUILTIN_NAMES: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', litellm: 'LiteLLM' }

/** A connection's display name (a proxy by its own name), else the built-in label; the id itself when unknown. */
export function connectionName(catalog: Pick<ModelCatalog, 'connections'>, id: ConnectionId): string {
  const c = catalog.connections.find((x) => x.connection.id === id)?.connection as { name?: unknown } | undefined
  if (typeof c?.name === 'string' && c.name.trim()) return c.name.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  return BUILTIN_NAMES[id] ?? id
}

export const tierMapOf = (catalog: ModelCatalog, connection: ConnectionId): Partial<Record<ModelTier, string>> =>
  (catalog.connections.find((c) => c.connection.id === connection)?.connection.tierModels ?? {}) as Partial<Record<ModelTier, string>>

/** The connection a run's model choice is resolved on: its current selection's, else the run's own. */
export const runModelConnection = (run: RunSummary): ConnectionId | undefined => run.modelSelection?.connection ?? run.connection

export interface ModelChoiceRow {
  id: string
  label: string
  connection: ConnectionId
  adapter: string
  tiers: ModelTier[]
  current: boolean
  /** Switching to it ends the session first (a transcript handoff), as the desktop asks. */
  handoff: boolean
}

/** Every choice the host would accept for this run, its own connection first, then by connection and label. */
export function modelChoices(run: RunSummary, catalog: ModelCatalog): ModelChoiceRow[] {
  const home = runModelConnection(run)
  const seen = new Set<string>()
  const ended = modelSessionEnded(run)
  return catalog.models
    .filter((m) => {
      const key = `${m.connection}\u0000${m.id}`
      return seen.has(key) ? false : (seen.add(key), true)
    })
    .sort((a, b) => Number(b.connection === home) - Number(a.connection === home) || a.connection.localeCompare(b.connection) || (a.label || a.id).localeCompare(b.label || b.id))
    .map((m) => ({
      id: m.id,
      label: m.label || m.id,
      connection: m.connection,
      adapter: m.adapter,
      tiers: tiersOfModel(m.id, tierMapOf(catalog, m.connection)),
      current: run.modelSelection?.model === m.id && run.modelSelection.connection === m.connection,
      handoff: !ended && needsModelHandoff(run, m)
    }))
}

/** The tier mapping of the run's connection as `tier -> model id` (only mapped tiers). */
export function tierRows(run: RunSummary, catalog: ModelCatalog): { tier: ModelTier; model: string }[] {
  const home = runModelConnection(run)
  if (!home) return []
  const map = tierMapOf(catalog, home)
  return MODEL_TIERS.flatMap((tier) => (map[tier] ? [{ tier, model: map[tier] as string }] : []))
}

/** A tier or id to one catalog model (resolveModelChoice), on the run's connection unless `only` names one. */
export function pickModel(run: RunSummary, catalog: ModelCatalog, value: string, only?: ConnectionId): ReturnType<typeof resolveModelChoice> {
  const home = only ?? runModelConnection(run)
  if (!home) return { error: 'This run has no connection to resolve the model on.' }
  return resolveModelChoice(value, { catalog: catalog.models, connection: home, tierModels: tierMapOf(catalog, home), ...(only ? { only } : {}) })
}

export interface SwitchOutcome {
  kind: 'applied' | 'next' | 'cancelled'
  run: RunSummary
  /** The session was ended for the handoff (also on a later failure). */
  stopped: boolean
}

/**
 * Switch `runId` to `selected` through the shared guard. `confirm` is asked only for a handoff (another connection or
 * adapter while the session is open, or when the host asked for one). A refusal throws with the host's reason; when
 * the host asks for a handoff the switch is retried once with confirmation.
 */
export async function switchRunModel(
  call: HostCall,
  runId: string,
  selected: ProviderModel,
  opts: { confirm(): Promise<boolean>; pause?: () => Promise<void> }
): Promise<SwitchOutcome> {
  const pause = opts.pause ?? ((): Promise<void> => new Promise((r) => setTimeout(r, 100)))
  let stopped = false
  const attempt = async (handoff: boolean): Promise<SwitchOutcome | { retry: true }> => {
    const run = (await call<RunRecord | null>('runs:get', [runId]))?.summary
    if (!run) throw new Error('This conversation is no longer available.')
    const result = await performModelSwitch({
      run,
      selected,
      handoff,
      valid: () => true,
      pause,
      stopped: () => {
        stopped = true
      },
      confirm: () => opts.confirm(),
      api: {
        read: () => call<RunRecord | null>('runs:get', [runId]),
        cards: () => call<PendingCards>('runs:pendingCards', [runId]),
        live: async () => {
          const list = await call<RunSummary[]>('runs:listLive', [])
          return Array.isArray(list) ? list : []
        },
        interrupt: () => call<void>('runs:interrupt', [runId]),
        stop: () => call<void>('runs:stop', [runId]),
        switch: () => call<SwitchRunModelResult>('runs:switchModel', [{ runId, expectedRunId: runId, connection: selected.connection, model: selected.id }])
      }
    })
    if (!result) return { kind: 'cancelled', run, stopped }
    const out = modelSwitchOutcome(result, runId, selected)
    if (out.kind === 'applied' || out.kind === 'next') return { kind: out.kind, run: result.run, stopped }
    if (out.wantsHandoff && !handoff && !modelSessionEnded(result.run)) return { retry: true }
    throw new Error(`${stopped ? 'The session ended, but the model was not selected. ' : ''}${out.reason}`)
  }
  const first = await attempt(false)
  if (!('retry' in first)) return first
  const second = await attempt(true)
  if ('retry' in second) throw new Error('The model could not be changed.')
  return second
}
