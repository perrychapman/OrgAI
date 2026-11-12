/**
 * `orgai models` (cli-spec 6.3, Wave 5): the model catalog, prices and role remaps.
 *
 *   list [--connection <id>]                   read: id, connection, tier mapping, source, context window, price per million tokens
 *   resolve [--project <id>]                   read: each tier and each role of the project: model, fallback, source, context
 *   refresh [--connection <id>]                operate: re-discover the catalog
 *   prices [--model <id>] [--connection <id>]  read: override, proxy and builtin price rows
 *   prices set|unset <model> ...               configure: price overrides (AppSettings.modelPrices)
 *   remap [--to <connection>] [--apply] [--yes] read preview; configure with --apply (asks first)
 *
 * Every price goes through the shared cost view (src/shared/view/cost.ts): an unknown price reads "unknown", never $0.
 */
import { MODEL_TIERS, type AppSettings, type ConnectionId, type ConnectionInfo, type ModelPriceOverride, type ModelPrice, type ModelPriceInfo, type ModelTier, type Project, type ProviderModel, type RemapModelsInput, type RemapModelsOutput, type RemapResult } from '../../shared/types'
import { MODEL_PRICE_ID_MAX_CHARS, MODEL_PRICE_MAX_PER_TOKEN, MODEL_PRICE_OVERRIDES_MAX, modelForTier, projectConnection, roleConnection } from '../../shared/defaults'
import { costView } from '../../shared/view/cost'
import { parseFlags } from '../flags'
import { confirm, hostCall, requireProject, runSubcommands, withHost } from '../manage'
import { emit, printText, safeLine, styleFor, table, termWidth, type Json } from '../output'
import { CliError, EXIT, type CliContext, type CommandFn, type HostClient } from '../types'
import { CONFIGURE, OPERATE, READ, connectionArg, labelOfId } from './connections'

const USAGE = 'models <list|resolve|refresh|prices|remap> [options]'

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

/** "200k", "1M" or "unknown": a context window in tokens (never 0 for unknown). */
export function contextText(tokens: number | undefined): string {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return 'unknown'
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(2))}M`
  return `${Math.round(tokens / 1000)}k`
}

/** Connection display names (proxies by their own name) from connections:list; built-in labels otherwise. */
export function nameFrom(infos: unknown): (id: string) => string {
  const names: Record<string, string> = {}
  for (const i of Array.isArray(infos) ? (infos as ConnectionInfo[]) : []) {
    const c = i?.connection as { id?: string; name?: unknown } | undefined
    if (c?.id && typeof c.name === 'string' && c.name.trim()) names[c.id] = safeLine(c.name)
  }
  return (id) => labelOfId(id, names)
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
    const label = nameFrom(infos)
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
          [{ header: 'MODEL', flex: true, min: 10, ellipsis: 'middle' }, { header: 'CONNECTION', min: 7 }, { header: 'TIERS', min: 5 }, { header: 'SOURCE', min: 6 }, { header: 'CONTEXT', min: 6, align: 'right' }, { header: 'PRICE IN / OUT PER MTOK', min: 10 }],
          rows.map((r) => [safeLine(r.model.id), label(r.model.connection), r.tiers.join(', '), r.model.source, contextText(r.model.contextWindow), priceText(r.price)]),
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
      Object.keys(counts).length === 0 ? 'No models listed.' : Object.entries(counts).map(([c, n]) => `${labelOfId(c)}: ${n} model${n === 1 ? '' : 's'}`)
    )
    return EXIT.ok
  })
}

// ---------- prices ----------

const runPricesList = async (ctx: CliContext, args: string[]): Promise<number> => {
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


/** One per-MTok flag as a per-token price; undefined when absent. Plain non-negative numbers only, capped like the app's own form. */
export function parsePerMTok(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined
  const t = raw.trim()
  if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) throw new CliError(`--${flag} takes a plain non-negative number of USD per million tokens, like 3 or 0.30 (got "${safeLine(raw).slice(0, 40)}").`, EXIT.usage)
  const perToken = Number((Number(t) / 1_000_000).toPrecision(12))
  if (!Number.isFinite(perToken) || perToken > MODEL_PRICE_MAX_PER_TOKEN) throw new CliError(`--${flag} is at most $${MODEL_PRICE_MAX_PER_TOKEN * 1_000_000} per million tokens.`, EXIT.usage)
  return perToken
}

/** The host's matching rule for overrides: case-insensitive, a date stamp and a [1m] suffix ignored. */
export function overrideKey(model: string, connection?: ConnectionId): string {
  return `${connection ?? ''}|${model.trim().toLowerCase().replace(/\[1m\]$/, '').replace(/-\d{8}$/, '')}`
}

function modelArg(positionals: string[], verb: string): string {
  if (positionals.length === 0) throw new CliError(`Name the model: models prices ${verb} <model> ...`, EXIT.usage)
  if (positionals.length > 1) throw new CliError(`Unexpected argument "${safeLine(positionals[1]).slice(0, 40)}".`, EXIT.usage)
  const model = positionals[0].trim()
  if (!model) throw new CliError(`Name the model: models prices ${verb} <model> ...`, EXIT.usage)
  if (model.length > MODEL_PRICE_ID_MAX_CHARS) throw new CliError(`A model id is at most ${MODEL_PRICE_ID_MAX_CHARS} characters.`, EXIT.usage)
  return model
}

const scopeText = (c: ConnectionId | undefined): string => (c ? `on ${labelOfId(c)}` : 'on every connection')

const runPricesSet = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, { input: { type: 'string' }, output: { type: 'string' }, 'cache-read': { type: 'string' }, 'cache-write': { type: 'string' }, connection: { type: 'string' } })
  const model = modelArg(positionals, 'set')
  const input = parsePerMTok(values.input, 'input')
  const output = parsePerMTok(values.output, 'output')
  if (input === undefined || output === undefined) throw new CliError('Give both --input and --output (USD per million tokens; 0 if free).', EXIT.usage)
  const cacheRead = parsePerMTok(values['cache-read'], 'cache-read')
  const cacheWrite = parsePerMTok(values['cache-write'], 'cache-write')
  const connection = connectionFlag(values.connection).connection
  const price: ModelPrice = { inputPerToken: input, outputPerToken: output, ...(cacheRead !== undefined ? { cacheReadPerToken: cacheRead } : {}), ...(cacheWrite !== undefined ? { cacheCreationPerToken: cacheWrite } : {}) }
  const next: ModelPriceOverride = { model, ...(connection ? { connection } : {}), price }
  return withHost(ctx, CONFIGURE, async (client) => {
    const settings = await hostCall<AppSettings>(client, 'settings:get', [])
    const current = Array.isArray(settings?.modelPrices) ? settings.modelPrices : []
    const key = overrideKey(model, connection)
    const replaced = current.some((o) => overrideKey(o.model, o.connection) === key)
    const rest = current.filter((o) => overrideKey(o.model, o.connection) !== key)
    if (rest.length >= MODEL_PRICE_OVERRIDES_MAX) throw new CliError(`At most ${MODEL_PRICE_OVERRIDES_MAX} price overrides. Remove one first (orgai models prices unset <model>).`, EXIT.failure)
    await hostCall(client, 'settings:set', [{ modelPrices: [...rest, next] }])
    emit(ctx, { model, connection: connection ?? null, replaced, price }, () => `${replaced ? 'Updated' : 'Set'} the price of ${safeLine(model)} ${scopeText(connection)}: ${priceText(price)} per million tokens (input / output).`)
    return EXIT.ok
  })
}

const runPricesUnset = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, { connection: { type: 'string' } })
  const model = modelArg(positionals, 'unset')
  const connection = connectionFlag(values.connection).connection
  return withHost(ctx, CONFIGURE, async (client) => {
    const settings = await hostCall<AppSettings>(client, 'settings:get', [])
    const current = Array.isArray(settings?.modelPrices) ? settings.modelPrices : []
    const key = overrideKey(model, connection)
    const rest = current.filter((o) => overrideKey(o.model, o.connection) !== key)
    if (rest.length === current.length) {
      emit(ctx, { model, connection: connection ?? null, removed: false }, () => `No price override for ${safeLine(model)} ${scopeText(connection)} (see \`orgai models prices\`); nothing changed.`)
      return EXIT.failure
    }
    await hostCall(client, 'settings:set', [{ modelPrices: rest }])
    emit(ctx, { model, connection: connection ?? null, removed: true }, () => `Removed the price override for ${safeLine(model)} ${scopeText(connection)}; its cost comes from the proxy or built-in table again.`)
    return EXIT.ok
  })
}

const runPrices = (ctx: CliContext, args: string[]): Promise<number> => {
  if (args[0] === 'set') return runPricesSet(ctx, args.slice(1))
  if (args[0] === 'unset') return runPricesUnset(ctx, args.slice(1))
  return runPricesList(ctx, args)
}

// ---------- resolve ----------

export interface ResolvedModel {
  /** The concrete model id, or null when nothing maps. */
  model: string | null
  connection: ConnectionId
  /** The tier whose mapping supplied the model, when it is not the requested one (the neighbouring tier taken). */
  fallbackTier?: ModelTier
  /** 'mapped' = the connection's tierModels entry; 'catalog' = the catalog's suggestion for that tier. */
  via?: 'mapped' | 'catalog'
  source?: ProviderModel['source'] | 'unlisted'
  contextWindow?: number
}

/** A tier on a connection, through the host's own modelForTier (tierModels, else the catalog's suggestion, nearest tier first). */
export function resolveTier(tier: ModelTier, connection: ConnectionId, tierModels: Partial<Record<ModelTier, string>>, catalog: readonly ProviderModel[]): ResolvedModel {
  const hit = modelForTier(tier, { connection, tierModels, catalog })
  if (!hit) return { model: null, connection }
  return { ...describe(hit.model, connection, catalog), ...(hit.tier !== tier ? { fallbackTier: hit.tier } : {}), via: tierModels[hit.tier]?.trim() ? 'mapped' : 'catalog' }
}

function describe(model: string, connection: ConnectionId, catalog: readonly ProviderModel[]): ResolvedModel {
  const entry = catalog.find((m) => m.connection === connection && m.id === model)
  return { model, connection, source: entry?.source ?? 'unlisted', ...(entry?.contextWindow ? { contextWindow: entry.contextWindow } : {}) }
}

/** A role's model on its own connection: its tier through resolveTier, else its concrete id ('inherit' stays as it is). */
export function resolveRole(role: Project['roles'][number], project: Project, tierModelsOf: (c: ConnectionId) => Partial<Record<ModelTier, string>>, catalog: readonly ProviderModel[]): ResolvedModel & { tier?: ModelTier } {
  const connection = roleConnection(role, project)
  const tier = role.tier
  if (tier && role.model !== 'inherit') return { ...resolveTier(tier, connection, tierModelsOf(connection), catalog), tier }
  return role.model === 'inherit' ? { model: 'inherit', connection } : { ...describe(role.model, connection, catalog) }
}

const fallbackText = (r: ResolvedModel): string => (r.fallbackTier ? `${r.fallbackTier} (unmapped)` : r.model === null ? '' : 'none')

const runResolve = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { positionals } = parseFlags(args, {})
  noPositionals(positionals)
  return withHost(ctx, READ, async (client) => {
    const project = await requireProject(ctx, client)
    const infos = await hostCall<ConnectionInfo[]>(client, 'connections:list', [])
    const catalog = await hostCall<ProviderModel[]>(client, 'models:list', [])
    const cat = Array.isArray(catalog) ? catalog : []
    const tierMaps = new Map((Array.isArray(infos) ? infos : []).map((i) => [i.connection.id, i.connection.tierModels as Partial<Record<ModelTier, string>>]))
    const tierModelsOf = (c: ConnectionId): Partial<Record<ModelTier, string>> => tierMaps.get(c) ?? {}
    const connection = projectConnection(project)
    const tiers = MODEL_TIERS.map((tier) => ({ tier, ...resolveTier(tier, connection, tierModelsOf(connection), cat) }))
    const roles = project.roles.map((role) => ({ roleId: role.id, name: role.name, ...resolveRole(role, project, tierModelsOf, cat) }))
    const clean = <T extends object>(o: T): Json => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Json
    emit(ctx, { projectId: project.id, connection, tiers: tiers.map((t) => clean({ ...t, model: t.model })), roles: roles.map((r) => clean({ ...r, model: r.model })) }, () => {
      const st = styleFor(ctx)
      const w = termWidth(ctx)
      const label = nameFrom(infos)
      const model = (r: ResolvedModel): string => (r.model === null ? 'unmapped' : safeLine(r.model))
      return [
        st.bold(`Tiers on ${label(connection)}`),
        ...table(
          [{ header: 'TIER', min: 4 }, { header: 'MODEL', flex: true, min: 10, ellipsis: 'middle' }, { header: 'FALLBACK', min: 8 }, { header: 'SOURCE', min: 6 }, { header: 'CONTEXT', min: 6, align: 'right' }],
          tiers.map((t) => [t.tier, model(t), fallbackText(t), t.source ?? '', t.model === null ? '' : contextText(t.contextWindow)]),
          w,
          st
        ),
        '',
        st.bold(`Roles of ${safeLine(project.name)}`),
        ...(roles.length === 0
          ? ['No roles.']
          : table(
              [{ header: 'ROLE', flex: true, min: 8, ellipsis: 'end' }, { header: 'CONNECTION', min: 7 }, { header: 'TIER', min: 4 }, { header: 'MODEL', flex: true, min: 10, ellipsis: 'middle' }, { header: 'FALLBACK', min: 8 }, { header: 'SOURCE', min: 6 }, { header: 'CONTEXT', min: 6, align: 'right' }],
              roles.map((r) => [safeLine(r.name), label(r.connection), r.tier ?? '', model(r), fallbackText(r), r.source ?? '', r.model === null || r.model === 'inherit' ? '' : contextText(r.contextWindow)]),
              w,
              st
            ))
      ]
    })
    return EXIT.ok
  })
}

// ---------- remap ----------

function changeLines(result: RemapResult, project: Project): string[] {
  if (result.changes.length === 0) return [`Nothing to remap in ${safeLine(project.name)} on ${labelOfId(result.connection)}.`]
  return [
    `${result.changes.length} role model${result.changes.length === 1 ? '' : 's'} in ${safeLine(project.name)} on ${labelOfId(result.connection)}:`,
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
    const question = switching ? `Move ${safeLine(project.name)} to ${labelOfId(to)} and save these models?` : `Save these models in ${safeLine(project.name)}?`
    if (!(await confirm(ctx, question, !!values.yes))) {
      printText(ctx, 'Nothing changed.')
      return EXIT.failure
    }
    const out = await hostCall<RemapModelsOutput>(client, 'projects:remapModels', [input])
    emit(ctx, { projectId: project.id, connection: out.result.connection, reason: out.result.reason, applied: true, changes: changesJson(out.result, out.project) }, () => `Saved: ${out.result.changes.length} role model${out.result.changes.length === 1 ? '' : 's'} changed.`)
    return EXIT.ok
  })
}

export const runModels: CommandFn = (ctx, args) => runSubcommands(ctx, args, { list: runList, resolve: runResolve, refresh: runRefresh, prices: runPrices, remap: runRemap }, USAGE)
