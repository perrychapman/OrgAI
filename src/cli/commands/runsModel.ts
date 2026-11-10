/**
 * `orgai runs model <run> [<tier|model id>] [--connection <id>] [--yes]` (cli-parity 3.5, B8).
 *
 * - Without a value: the run's current model selection (model and connection), its connection's tier mapping and every
 *   model the host would accept (the connected connections' catalogs, as the desktop picker lists them); read scope.
 * - With a value: a tier (top, deep, everyday, fast; through the run's connection's mapping) or a model id (the run's
 *   connection first, else the one connection that has it; --connection restricts it), then `runs:switchModel` behind
 *   the desktop's guard (shared/liveModelSwitch.ts via ../modelSwitch.ts); operate scope. A switch that needs a
 *   transcript handoff (another connection or adapter while the session is open) asks first (y/N on the terminal, or
 *   --yes). An ended session keeps the selection for its next message (`orgai resume`).
 * - Host errors are printed as the host wrote them, on one line (safeLine).
 */
import { MODEL_HANDOFF_BODY, MODEL_HANDOFF_TITLE } from '../../shared/liveModelSwitch'
import type { RunRecord, RunSummary } from '../../shared/types'
import { runIndexMap, runTag } from '../../shared/view/runLabels'
import { parseFlags } from '../flags'
import { confirm, hostCall, hostError, withHost } from '../manage'
import { loadModelCatalog, modelChoices, pickModel, runModelConnection, switchRunModel, tierRows, type HostCall } from '../modelSwitch'
import { emit, safeLine, styleFor, table, termWidth, type Json } from '../output'
import { liveSource, resolveRunFromSource } from '../runRef'
import { CliError, EXIT, type CliContext, type HostClient } from '../types'
import { connectionArg, labelOfId } from './connections'

export const RUNS_MODEL_USAGE = 'Use: orgai runs model <runId-or-R#> [<tier|model id>] [--connection <id>] [--yes]'

const callOf = (client: HostClient): HostCall => (method, params) => hostCall(client, method, params)

async function resolveRun(ctx: CliContext, client: HostClient, ref: string): Promise<{ run: RunSummary; tag: string }> {
  const r = await resolveRunFromSource(ctx, liveSource(client), ref).catch((e: unknown) => {
    throw hostError(e)
  })
  const rec = await hostCall<RunRecord | null>(client, 'runs:get', [r.runId])
  if (!rec?.summary) throw new CliError(`Run ${safeLine(r.runId)} is not available.`, EXIT.failure)
  const list = r.runs.filter((x) => x.projectId === rec.summary.projectId)
  return { run: rec.summary, tag: runTag(runIndexMap(list.some((x) => x.id === rec.summary.id) ? list : [...list, rec.summary]).get(rec.summary.id)) }
}

const selectionText = (run: RunSummary): string =>
  run.modelSelection ? `${safeLine(run.modelSelection.model)} via ${labelOfId(run.modelSelection.connection)}` : 'not recorded'

export async function runRunsModel(ctx: CliContext, args: string[]): Promise<number> {
  const { values, positionals } = parseFlags(args, { connection: { type: 'string' }, yes: { type: 'boolean', short: 'y' } })
  if (positionals.length < 1 || positionals.length > 2) throw new CliError(RUNS_MODEL_USAGE, EXIT.usage)
  const [ref, value] = positionals
  const only = values.connection !== undefined ? connectionArg(values.connection) : undefined
  if (value === undefined) {
    if (only) throw new CliError('--connection applies when you name a model.', EXIT.usage)
    if (values.yes) throw new CliError('--yes applies when you name a model.', EXIT.usage)
    return withHost(ctx, ['read'], (client) => show(ctx, client, ref))
  }
  return withHost(ctx, ['read', 'operate'], (client) => change(ctx, client, ref, value, only, values.yes === true))
}

async function show(ctx: CliContext, client: HostClient, ref: string): Promise<number> {
  const { run, tag } = await resolveRun(ctx, client, ref)
  const catalog = await loadModelCatalog(callOf(client))
  const choices = modelChoices(run, catalog)
  const tiers = tierRows(run, catalog)
  const value: Json = {
    runId: run.id,
    tag,
    status: run.status,
    current: run.modelSelection ? { model: run.modelSelection.model, connection: run.modelSelection.connection } : null,
    connection: runModelConnection(run) ?? null,
    tiers,
    choices,
    ...(catalog.failed.length ? { unavailableConnections: catalog.failed } : {})
  }
  emit(ctx, value, () => {
    const st = styleFor(ctx)
    const lines = [`${tag} model: ${selectionText(run)}`]
    if (tiers.length) lines.push(st.dim(`Tiers on ${labelOfId(runModelConnection(run) ?? '')}: ${tiers.map((t) => `${t.tier} ${safeLine(t.model)}`).join(', ')}`))
    if (catalog.failed.length) lines.push(st.yellow(`Could not load models from ${catalog.failed.map((c) => labelOfId(c)).join(', ')}.`))
    if (!choices.length) {
      lines.push('No models available on connected connections. Connect one with `orgai connections`.')
      return lines
    }
    lines.push(
      ...table(
        [
          { header: 'MODEL', min: 8 },
          { header: 'NAME', flex: true, min: 6 },
          { header: 'CONNECTION', min: 6 },
          { header: 'TIERS', min: 5 },
          { header: 'NOTE', min: 4 }
        ],
        choices.map((c) => [safeLine(c.id), safeLine(c.label), labelOfId(c.connection), c.tiers.join(', '), c.current ? 'current' : c.handoff ? 'ends session' : '']),
        termWidth(ctx),
        st
      )
    )
    lines.push(st.dim(`Switch: orgai runs model ${tag} <tier|model id>`))
    return lines
  })
  return EXIT.ok
}

async function change(ctx: CliContext, client: HostClient, ref: string, value: string, only: string | undefined, yes: boolean): Promise<number> {
  const { run, tag } = await resolveRun(ctx, client, ref)
  const call = callOf(client)
  const catalog = await loadModelCatalog(call)
  const picked = pickModel(run, catalog, value, only)
  if ('error' in picked) throw new CliError(safeLine(picked.error), EXIT.usage)
  const selected = picked.model
  let outcome
  try {
    outcome = await switchRunModel(call, run.id, selected, {
      confirm: () => confirm(ctx, `${MODEL_HANDOFF_TITLE} ${MODEL_HANDOFF_BODY}`, yes)
    })
  } catch (e) {
    if (e instanceof CliError) throw e
    throw new CliError(safeLine(e instanceof Error ? e.message : String(e)) || 'The model could not be changed.', EXIT.failure)
  }
  const label = `${safeLine(selected.id)} via ${labelOfId(selected.connection)}`
  const result: Json = {
    runId: outcome.run.id,
    tag,
    outcome: outcome.kind,
    applied: outcome.kind === 'applied',
    selection: { model: selected.id, connection: selected.connection },
    ...(picked.tier ? { tier: picked.tier } : {}),
    sessionEnded: outcome.stopped,
    run: outcome.run
  }
  emit(ctx, result, () => {
    if (outcome.kind === 'cancelled') return ['Cancelled. The model is unchanged.']
    if (outcome.kind === 'applied') return [`${tag} model changed to ${label}.`]
    return [`${tag} will use ${label} when it continues${outcome.stopped ? ' (the session ended for the handoff)' : ''}. Continue it with: orgai resume ${tag}`]
  })
  // A declined confirmation is a failure, as the other commands' (kit import).
  return outcome.kind === 'cancelled' ? EXIT.failure : EXIT.ok
}
