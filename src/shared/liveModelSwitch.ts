/**
 * The live model switch's guard and choice logic, shared by the desktop (renderer/src/lib/liveModelSwitch.ts,
 * LiveModelSwitch.tsx) and the terminal (`orgai runs model`, the TUI's /model). Pure apart from the injected
 * ModelSwitchApi: every surface runs the same safe-boundary checks before `runs:switchModel`.
 */
import { modelForTier } from './defaults'
import { isModelTier, MODEL_TIERS } from './types'
import type { ConnectionId, ModelTier, PendingCards, ProviderModel, RunRecord, RunSummary, SwitchRunModelResult } from './types'

export const modelKey = (connection: ConnectionId, model: string): string => JSON.stringify([connection, model])

export function filterLiveModels(models: readonly ProviderModel[], query: string, name: (id: ConnectionId) => string): ProviderModel[] {
  const seen = new Set<string>()
  const term = query.trim().toLocaleLowerCase()
  return models.filter((model) => {
    const key = modelKey(model.connection, model.id)
    if (seen.has(key)) return false
    seen.add(key)
    return `${model.label} ${model.id} ${name(model.connection)} ${model.connection}`.toLocaleLowerCase().includes(term)
  }).sort((a, b) => name(a.connection).localeCompare(name(b.connection)) || a.connection.localeCompare(b.connection) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
}

export function needsModelHandoff(run: RunSummary, model: ProviderModel): boolean {
  return model.connection !== run.connection || !!(run.modelAdapter && run.modelAdapter !== 'mock' && model.adapter !== run.modelAdapter)
}

export const modelSessionEnded = (run: RunSummary): boolean => ['finished', 'error', 'paused'].includes(run.status)

/** Check before interrupting: interrupt can also stop reports, so a later switch refusal is too late. */
export function modelSwitchBlock(record: RunRecord, cards: PendingCards): string | null {
  if (Object.values(cards).some((items) => items.length > 0)) return 'Answer the open decisions before changing models.'
  if (!modelSessionEnded(record.summary) && Object.values(record.agents).some((agent) => agent.parentId !== null && !['done', 'error'].includes(agent.state))) return 'Wait for the active reports to finish before changing models.'
  if (['starting', 'stopping'].includes(record.summary.status)) return 'Wait for the session to finish changing state, then try again.'
  return null
}

/** One bounded wait after the user's interrupt/stop. Never repeat either mutation. */
export async function waitForModelBoundary(read: () => Promise<RunRecord | null>, ended: boolean, pause: () => Promise<void>, attempts = 100): Promise<RunRecord> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const record = await read()
    if (!record) throw new Error('This conversation is no longer available.')
    if (ended ? modelSessionEnded(record.summary) : record.summary.status === 'idle') return record
    if (!ended && modelSessionEnded(record.summary)) throw new Error('The session ended. Select the model for your next message.')
    await pause()
  }
  throw new Error('The session has not reached a safe boundary yet. Your selection is kept; try again when it is ready.')
}

export interface ModelSwitchApi {
  read(): Promise<RunRecord | null>
  cards(): Promise<PendingCards>
  live(): Promise<RunSummary[]>
  interrupt(): Promise<void>
  stop(): Promise<void>
  switch(): Promise<SwitchRunModelResult>
}

/** Mutations occur once each, after a fresh safe-boundary check. A retry is always a new user action. */
export async function performModelSwitch(input: {
  run: RunSummary; selected: ProviderModel; handoff: boolean; api: ModelSwitchApi
  confirm(): Promise<boolean>; valid(): boolean; pause(): Promise<void>; stopped(): void
}): Promise<SwitchRunModelResult | null> {
  const { api, run } = input
  const assertValid = (): void => { if (!input.valid()) throw new Error('Model change cancelled. Review your selection before trying again.') }
  let signature: string | undefined
  const fresh = async (): Promise<RunRecord> => {
    assertValid()
    const [record, cards, live] = await Promise.all([api.read(), api.cards(), api.live()])
    assertValid()
    if (!record) throw new Error('This conversation is no longer available.')
    if (live.some((item) => item.resumedFrom === run.id)) throw new Error('This conversation continued in another session. Open the latest session to change its model.')
    const blocked = modelSwitchBlock(record, cards)
    if (blocked) throw new Error(blocked)
    const next = JSON.stringify([record.summary.modelSelection, record.transcript.filter((item) => item.block.kind === 'user').map((item) => [item.id, item.at])])
    if (signature !== undefined && signature !== next) throw new Error('The conversation changed elsewhere. Review the current selection before trying again.')
    signature = next
    return record
  }
  let record = await fresh()
  if (record.summary.status !== run.status) throw new Error('The session state changed. Review the action before trying again.')
  const handoff = !modelSessionEnded(record.summary) && (input.handoff || needsModelHandoff(record.summary, input.selected))
  if (handoff) {
    if (!await input.confirm()) return null
    record = await fresh()
    if (record.summary.status !== run.status) throw new Error('The session state changed while confirming. Review the action before trying again.')
    assertValid()
    await api.stop()
    input.stopped()
    record = await waitForModelBoundary(async () => { assertValid(); return api.read() }, true, input.pause)
  } else if (record.summary.status === 'running') {
    assertValid()
    await api.interrupt()
    record = await waitForModelBoundary(async () => { assertValid(); return api.read() }, false, input.pause)
  }
  record = await fresh()
  if (!modelSessionEnded(record.summary) && record.summary.status !== 'idle') throw new Error('Wait for an idle session before changing models.')
  assertValid()
  return api.switch()
}

/**
 * How a switch result reads for the user: 'applied' (the run uses it now), 'next' (saved for the next message of an
 * ended session) or 'refused' (with the host's reason). `wantsHandoff` is set when the host asks for a transcript
 * handoff (the caller may retry with `handoff: true` after confirming).
 */
export function modelSwitchOutcome(result: SwitchRunModelResult, runId: string, selected: Pick<ProviderModel, 'id' | 'connection'>): { kind: 'applied' | 'next' | 'refused' | 'moved'; reason?: string; wantsHandoff?: boolean } {
  if (result.run.id !== runId) return { kind: 'moved', reason: result.reason || 'This conversation continued elsewhere. Open its latest session before changing models.' }
  if (result.applied) return { kind: 'applied' }
  if (modelSessionEnded(result.run) && result.run.modelSelection?.model === selected.id && result.run.modelSelection.connection === selected.connection) return { kind: 'next' }
  return { kind: 'refused', reason: result.reason || 'The model could not be changed.', ...(result.reason?.includes('transcript handoff') ? { wantsHandoff: true } : {}) }
}

/** The confirmation the desktop shows before a handoff switch (the terminal shows the same words). */
export const MODEL_HANDOFF_TITLE = 'End this session and switch model?'
export const MODEL_HANDOFF_BODY = 'Your conversation stays here. The new session receives a transcript handoff that may omit older or oversized text. Provider session memory and session-only permissions do not transfer. Your draft stays unsent. Send when you are ready to continue.'

/** The picker stores concrete ids; do not collapse identical ids across connections. */
export function liveModelOptions(models: readonly ProviderModel[], connection: ConnectionId): { value: string; label: string }[] {
  const seen = new Set<string>()
  return models.filter((model) => model.connection === connection && !seen.has(model.id) && !!seen.add(model.id))
    .map((model) => ({ value: model.id, label: model.label && model.label !== model.id ? `${model.label} (${model.id})` : model.id }))
}

/** The tiers a connection's mapping (tierModels) points at this model id. */
export function tiersOfModel(modelId: string, tierModels: Partial<Record<ModelTier, string>> | undefined): ModelTier[] {
  return MODEL_TIERS.filter((t) => tierModels?.[t] === modelId)
}

/**
 * The catalog model a terminal choice names: a tier (through the connection's tier mapping, as modelForTier resolves
 * it), else an exact model id on `connection` (the run's), else an exact id on exactly one other connection.
 * `connection` given explicitly restricts the search to it. Returns an error sentence when nothing (or more than one
 * connection) matches.
 */
export function resolveModelChoice(
  value: string,
  input: { catalog: readonly ProviderModel[]; connection: ConnectionId; tierModels?: Partial<Record<ModelTier, string>>; only?: ConnectionId }
): { model: ProviderModel; tier?: ModelTier } | { error: string } {
  const want = value.trim()
  if (!want) return { error: 'Name a tier or a model id.' }
  const home = input.only ?? input.connection
  const lower = want.toLowerCase()
  if (isModelTier(lower)) {
    const catalog = input.catalog.filter((m) => m.connection === home)
    const hit = modelForTier(lower, { connection: home, tierModels: input.tierModels ?? {}, catalog })
    const model = hit ? catalog.find((m) => m.id === hit.model) : undefined
    if (!hit || !model) return { error: `No model on ${home} is mapped to the ${lower} tier${hit ? ` (${hit.model} is not in its catalog)` : ''}.` }
    return { model, tier: hit.tier }
  }
  const own = input.catalog.find((m) => m.connection === home && m.id === want)
  if (own) return { model: own }
  if (input.only) return { error: `Model ${want} is not available on ${home}.` }
  const others = [...new Map(input.catalog.filter((m) => m.id === want).map((m) => [m.connection, m])).values()]
  if (others.length === 1) return { model: others[0] }
  if (others.length > 1) return { error: `Model ${want} is on several connections (${others.map((m) => m.connection).join(', ')}); name one with --connection.` }
  return { error: `Model ${want} is not available on a connected connection.` }
}
