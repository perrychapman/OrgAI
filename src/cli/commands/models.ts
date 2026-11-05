/**
 * `orgai models` (cli-spec 6.3, Wave 5): the model catalog, prices and role remaps.
 *
 *   list [--connection <id>]                   read: id, connection, tier mapping, price per million tokens
 *   refresh [--connection <id>]                operate: re-discover the catalog
 *   prices [--model <id>] [--connection <id>]  read: override, proxy and builtin price rows
 *   remap [--to <connection>] [--apply] [--yes] read preview; configure with --apply (asks first)
 *
 * Every price goes through the shared cost view (src/shared/view/cost.ts): an unknown price reads "unknown", never $0.
 */
import { MODEL_TIERS, type ConnectionInfo, type ModelPrice, type ModelPriceInfo, type ModelTier, type Project, type ProviderModel, type RemapModelsInput, type RemapModelsOutput, type RemapResult } from '../../shared/types'
import { projectConnection } from '../../shared/defaults'
import { costView } from '../../shared/view/cost'
import { parseFlags } from '../flags'
import { confirm, hostCall, requireProject, runSubcommands, withHost } from '../manage'
import { emit, printText, safeLine, styleFor, table, termWidth, type Json } from '../output'
import { CliError, EXIT, type CliContext, type CommandFn, type HostClient } from '../types'
import { CONFIGURE, CONNECTION_LABELS, OPERATE, READ, connectionArg } from './connections'

const USAGE = 'models <list|refresh|prices|remap> [options]'

function noPositionals(positionals: string[]): void {
  if (positionals.length > 0) throw new CliError(`Unexpected argument "${safeLine(positionals[0]).slice(0, 40)}".`, EXIT.usage)
}

/** USD per million tokens of a per-token price through costView; undefined (no price) is "unknown", never $0. */
export function perMTokText(perToken: number | undefined | null): string {
  if (typeof perToken !== 'number' || !Number.isFinite(perToken)) return costView({ costUsd: null, costSource: 'unknown' }).text
  return costView({ costUsd: perToken * 1_000_000, costSource: 'computed' }).text
}

/** "$3.00 / $15.00" (input / output per MTok) or "unknown". */
export function priceText(price: ModelPrice | undefined): string {
  if (!price) return perMTokText(undefined)
  return `${perMTokText(price.inputPerToken)} / ${perMTokText(price.outputPerToken)}`
}

const SOURCE_RANK: Record<ModelPriceInfo['source'], number> = { override: 0, proxy: 1, builtin: 2 }

/** The price a model would be charged at, as far as the listed rows say: its own proxy price, else override > proxy > builtin rows (connection-scoped first). */
export function priceForModel(m: Pick<ProviderModel, 'id' | 'connection' | 'price'>, rows: readonly ModelPriceInfo[]): { price?: ModelPrice; source?: string } {
  const hits = rows
    .filter((r) => r.model === m.id && (r.connection === undefined || r.connection === m.connection))
    .sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || (a.connection ? 0 : 1) - (b.connection ? 0 : 1))
  if (hits[0]?.source === 'override') return { price: hits[0].price, source: 'override' }
  if (m.price) return { price: m.price, source: 'proxy' }
  return hits[0] ? { price: hits[0].price, source: hits[0].source } : {}
}

/** The tiers a connection maps to this model id. */
export function tiersOf(modelId: string, tierModels: Partial<Record<ModelTier, string>> | undefined): ModelTier[] {
  return MODEL_TIERS.filter((t) => tierModels?.[t] === modelId)
}

function connectionFlag(raw: string | undefined): { connection?: ProviderModel['connection'] } {
  return raw === undefined ? {} : { connection: connectionArg(raw) }
}

const queryParams = (q: Json): unknown[] => (Object.keys(q).length ? [q] : [])

// ---------- list / refresh ----------

const runList = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, { connection: { type: 'string' } })
  noPositionals(positionals)
  const q = connectionFlag(values.connection)
  return withHost(ctx, READ, async (client) => {
    const models = await hostCall<ProviderModel[]>(client, 'models:list', queryParams(q))
    const infos = await client.call<ConnectionInfo[]>('connections:list', []).catch(() => [] as ConnectionInfo[])
    const prices = await client.call<ModelPriceInfo[]>('models:prices', queryParams(q)).catch(() => [] as ModelPriceInfo[])
    const tierMap = new Map((Array.isArray(infos) ? infos : []).map((i) => [i.connection.id, i.connection.tierModels]))
    const rows = (Array.isArray(models) ? models : []).map((m) => {
      const p = priceForModel(m, Array.isArray(prices) ? prices : [])
      return { model: m, tiers: tiersOf(m.id, tierMap.get(m.connection)), ...p }
    })
    emit(
      ctx,
      {
        models: rows.map((r) => ({
          id: r.model.id,
          label: r.model.label,
          connection: r.model.connection,
          family: r.model.family,
          adapter: r.model.adapter,
          source: r.model.source,
          tiers: r.tiers,
          ...(r.model.tier ? { suggestedTier: r.model.tier } : {}),
          ...(r.model.contextWindow ? { contextWindow: r.model.contextWindow } : {}),
          price: r.price ? { ...r.price, source: r.source } : null
        }))
      },
      () => {
        if (rows.length === 0) return 'No models listed.'
        const st = styleFor(ctx)
        return table(
          [{ header: 'MODEL', flex: true, min: 10, ellipsis: 'middle' }, { header: 'CONNECTION', min: 7 }, { header: 'TIERS', min: 5 }, { header: 'PRICE IN / OUT PER MTOK', min: 10 }],
          rows.map((r) => [safeLine(r.model.id), r.model.connection, r.tiers.join(', '), priceText(r.price)]),
          termWidth(ctx),
          st
        )
      }
    )
    return EXIT.ok
  })
}

const runRefresh = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, { connection: { type: 'string' } })
  noPositionals(positionals)
  const q = connectionFlag(values.connection)
  return withHost(ctx, OPERATE, async (client) => {
    const models = await hostCall<ProviderModel[]>(client, 'models:refresh', queryParams(q), { timeoutMs: 120_000 })
    const list = Array.isArray(models) ? models : []
    const counts: Record<string, number> = {}
    for (const m of list) counts[m.connection] = (counts[m.connection] ?? 0) + 1
    emit(ctx, { counts, models: list.map((m) => m.id) }, () =>
      Object.keys(counts).length === 0 ? 'No models listed.' : Object.entries(counts).map(([c, n]) => `${CONNECTION_LABELS[c as keyof typeof CONNECTION_LABELS] ?? safeLine(c)}: ${n} model${n === 1 ? '' : 's'}`)
    )
    return EXIT.ok
  })
}

// ---------- prices ----------

const runPrices = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, { connection: { type: 'string' }, model: { type: 'string' } })
  noPositionals(positionals)
  const q = connectionFlag(values.connection)
  return withHost(ctx, READ, async (client) => {
    const all = await hostCall<ModelPriceInfo[]>(client, 'models:prices', queryParams(q))
    const rows = (Array.isArray(all) ? all : []).filter((r) => values.model === undefined || r.model === values.model)
    const overrides = rows.filter((r) => r.source === 'override').length
    emit(
      ctx,
      {
        prices: rows.map((r) => ({
          model: r.model,
          connection: r.connection ?? null,
          source: r.source,
          ...r.price,
          perMTok: { input: perMTokText(r.price.inputPerToken), output: perMTokText(r.price.outputPerToken), cacheRead: perMTokText(r.price.cacheReadPerToken ?? r.price.inputPerToken), cacheWrite: perMTokText(r.price.cacheCreationPerToken ?? r.price.inputPerToken) }
        })),
        overrides
      },
      () => {
        if (rows.length === 0) return values.model !== undefined ? `No price is known for ${safeLine(values.model)}; its cost reads unknown.` : 'No model prices are known.'
        const st = styleFor(ctx)
        const lines = table(
          [{ header: 'MODEL', flex: true, min: 10, ellipsis: 'middle' }, { header: 'CONNECTION', min: 4 }, { header: 'SOURCE', min: 6 }, { header: 'INPUT', min: 5 }, { header: 'OUTPUT', min: 5 }, { header: 'CACHE READ', min: 5 }, { header: 'CACHE WRITE', min: 5 }],
          rows.map((r) => [
            safeLine(r.model),
            r.connection ?? 'all',
            r.source,
            perMTokText(r.price.inputPerToken),
            perMTokText(r.price.outputPerToken),
            perMTokText(r.price.cacheReadPerToken ?? r.price.inputPerToken),
            perMTokText(r.price.cacheCreationPerToken ?? r.price.inputPerToken)
          ]),
          termWidth(ctx),
          st
        )
        lines.push(st.dim(`USD per million tokens.${overrides === 0 ? ' No price overrides are set.' : ''}`))
        return lines
      }
    )
    return EXIT.ok
  })
}

// ---------- remap ----------

function changeLines(result: RemapResult, project: Project): string[] {
  if (result.changes.length === 0) return [`Nothing to remap in ${safeLine(project.name)} on ${CONNECTION_LABELS[result.connection]}.`]
  return [
    `${result.changes.length} role model${result.changes.length === 1 ? '' : 's'} in ${safeLine(project.name)} on ${CONNECTION_LABELS[result.connection]}:`,
    ...result.changes.map((c) => `  ${safeLine(project.roles.find((r) => r.id === c.roleId)?.name ?? c.roleId)}: ${safeLine(c.from)} -> ${safeLine(c.to)}`)
  ]
}

const changesJson = (r: RemapResult, project: Project): Json[] => r.changes.map((c) => ({ ...c, roleName: project.roles.find((x) => x.id === c.roleId)?.name ?? null }))

const runRemap = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, { to: { type: 'string' }, apply: { type: 'boolean' }, yes: { type: 'boolean', short: 'y' } })
  noPositionals(positionals)
  const to = values.to === undefined ? undefined : connectionArg(values.to)
  if (values.yes && !values.apply) throw new CliError('--yes confirms --apply; without --apply nothing is changed.', EXIT.usage)
  return withHost(ctx, values.apply ? CONFIGURE : READ, async (client: HostClient) => {
    const project = await requireProject(ctx, client)
    const input: RemapModelsInput = { projectId: project.id, ...(to ? { connection: to } : {}) }
    const preview = await hostCall<RemapResult>(client, 'projects:previewRemap', [input])
    if (!values.apply) {
      emit(ctx, { projectId: project.id, connection: preview.connection, reason: preview.reason, applied: false, changes: changesJson(preview, project) }, () => [
        ...changeLines(preview, project),
        ...(preview.changes.length || (to && to !== projectConnection(project)) ? ['Run again with --apply to save.'] : [])
      ])
      return EXIT.ok
    }
    const switching = !!to && to !== projectConnection(project)
    if (preview.changes.length === 0 && !switching) {
      emit(ctx, { projectId: project.id, connection: preview.connection, reason: preview.reason, applied: false, changes: [] }, () => changeLines(preview, project))
      return EXIT.ok
    }
    printText(ctx, changeLines(preview, project))
    const question = switching ? `Move ${safeLine(project.name)} to ${CONNECTION_LABELS[to]} and save these models?` : `Save these models in ${safeLine(project.name)}?`
    if (!(await confirm(ctx, question, !!values.yes))) {
      printText(ctx, 'Nothing changed.')
      return EXIT.failure
    }
    const out = await hostCall<RemapModelsOutput>(client, 'projects:remapModels', [input])
    emit(ctx, { projectId: project.id, connection: out.result.connection, reason: out.result.reason, applied: true, changes: changesJson(out.result, out.project) }, () => `Saved: ${out.result.changes.length} role model${out.result.changes.length === 1 ? '' : 's'} changed.`)
    return EXIT.ok
  })
}

export const runModels: CommandFn = (ctx, args) => runSubcommands(ctx, args, { list: runList, refresh: runRefresh, prices: runPrices, remap: runRemap }, USAGE)
