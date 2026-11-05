/**
 * `orgai kit` (cli-spec 6.3(4), Wave 5): practice kits over the socket (cli-spec 3.6 item 2).
 *
 * - `kit export <file>`: kit:exportBundle returns the file's bytes as base64; the CLI writes them through a temp file in
 *   the same folder and a rename (never over an existing file without --force). A missing '.orgai-kit.json' suffix is
 *   added.
 * - `kit import <file>`: kit:previewBundle shows every item (new / same / different / refused, the full commands and
 *   addresses, scripts, secret slots, template roles and elevated tools), the choices are built from --action and
 *   --item, the user confirms on /dev/tty unless --yes (which skips only the prompt), and kit:applyBundle runs with the
 *   preview's `digest` and `targetDigest`: the host refuses a changed file and, under its library mutex,
 *   stale_target_digest when the destination moved since the preview. Exit 1 when the target moved, an item failed or the
 *   kit holds any refused item (cli-spec 6.3(4): refused items are skipped by default, but the import is then partial).
 *
 * Kits never carry secret values; only secret slot names are printed. Every name, command and URL from a kit file is
 * untrusted and sanitized before printing.
 */
import { randomBytes } from 'node:crypto'
import { link, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import {
  KIT_MAX_BYTES,
  type HostScope,
  type KitAction,
  type KitApplyResult,
  type KitBundleExportInput,
  type KitBundleExportResult,
  type KitImportChoice,
  type KitImportPreview,
  type KitPreviewItem,
  type KitSelection
} from '../../shared/types'
import { parseFlags } from '../flags'
import { confirm, hostCall, runSubcommands, withHost, type SubcommandFn } from '../manage'
import { emit, plural, printText, safeLine, styleFor, type Json } from '../output'
import { CliError, EXIT, type CliContext, type CommandFn, type HostCallError } from '../types'
import { changeError, hostChange } from './skills'

export const KIT_USAGE =
  'kit export <file> [--skills <id,...> | --all-skills] [--servers <id,...> | --all-servers] [--presets <id,...> | --all-presets] [--templates <id,...> | --all-templates] [--all] [--force] | kit import <file> [--action add|replace|copy|skip] [--item <key-or-name>=<action>]... [--yes]'

export const KIT_SUFFIX = '.orgai-kit.json'
export const STALE_TARGET_CLI_MESSAGE = 'The library changed since the preview (an item you chose to replace was edited); run the import again.'

const CONFIGURE: HostScope[] = ['read', 'configure']
/** Kit frames may be tens of MB of base64. */
const BULK_TIMEOUT_MS = 10 * 60_000
const ACTIONS: readonly KitAction[] = ['add', 'replace', 'copy', 'skip']

const usage = (m: string): CliError => new CliError(m, EXIT.usage)

/** Replaceable in tests: the file system calls of export. */
export const kitFs = { link, readFile, rename, stat, unlink, writeFile }

// ---------- export ----------

function selection(ids: string | undefined, all: boolean | undefined, flag: string): KitSelection | undefined {
  if (ids !== undefined && all) throw usage(`Give --${flag} or --all-${flag}, not both.`)
  if (all) return 'all'
  if (ids === undefined) return undefined
  const list = ids.split(',').map((s) => s.trim()).filter(Boolean)
  if (list.length === 0) throw usage(`--${flag} needs at least one id.`)
  return list
}

/** The target path with the '.orgai-kit.json' suffix (added when missing). */
export function kitTarget(file: string, cwd: string): string {
  const abs = resolve(cwd, file)
  return abs.endsWith(KIT_SUFFIX) ? abs : `${abs}${KIT_SUFFIX}`
}

const exists = async (p: string): Promise<boolean> =>
  kitFs.stat(p).then(
    () => true,
    () => false
  )

/**
 * Write `data` at `target` through a temp file in the same folder: without `force` the temp file is hard-linked into
 * place (fails if the target exists, so nothing is ever clobbered), else renamed over it.
 */
export async function writeAtomically(target: string, data: Buffer, force: boolean): Promise<void> {
  const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`)
  await kitFs.writeFile(tmp, data, { flag: 'wx', mode: 0o600 })
  try {
    if (force) {
      await kitFs.rename(tmp, target)
      return
    }
    try {
      await kitFs.link(tmp, target)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new CliError(`${safeLine(target)} already exists. Pass --force to replace it.`, EXIT.failure)
      // A file system without hard links: check, then rename (best effort).
      if (await exists(target)) throw new CliError(`${safeLine(target)} already exists. Pass --force to replace it.`, EXIT.failure)
      await kitFs.rename(tmp, target)
      return
    }
    await kitFs.unlink(tmp).catch(() => undefined)
  } catch (e) {
    await kitFs.unlink(tmp).catch(() => undefined)
    throw e
  }
}

const exportCmd: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, {
    skills: { type: 'string' },
    'all-skills': { type: 'boolean' },
    servers: { type: 'string' },
    'all-servers': { type: 'boolean' },
    presets: { type: 'string' },
    'all-presets': { type: 'boolean' },
    templates: { type: 'string' },
    'all-templates': { type: 'boolean' },
    all: { type: 'boolean' },
    force: { type: 'boolean' }
  })
  if (positionals.length !== 1) throw usage(positionals.length ? `Unexpected argument "${safeLine(positionals[1]).slice(0, 64)}".` : 'kit export needs the file to write.')
  const include: KitBundleExportInput['include'] = {}
  const sk = values.all ? 'all' : selection(values.skills, values['all-skills'], 'skills')
  const sv = values.all ? 'all' : selection(values.servers, values['all-servers'], 'servers')
  const pr = values.all ? 'all' : selection(values.presets, values['all-presets'], 'presets')
  const tp = values.all ? 'all' : selection(values.templates, values['all-templates'], 'templates')
  if (sk) include.skills = sk
  if (sv) include.mcpServers = sv
  if (pr) include.connectorPresets = pr
  if (tp) include.templates = tp
  if (!sk && !sv && !pr && !tp) throw usage('Choose what to export: --all, or --skills / --servers / --presets / --templates (ids) or their --all-* forms.')
  const target = kitTarget(positionals[0], ctx.cwd)
  const force = !!values.force
  if (!force && (await exists(target))) throw new CliError(`${safeLine(target)} already exists. Pass --force to replace it.`, EXIT.failure)
  return withHost(ctx, CONFIGURE, async (client) => {
    const r = await hostChange<KitBundleExportResult>(client, 'kit:exportBundle', [{ include, fileName: basename(target) }], { timeoutMs: BULK_TIMEOUT_MS })
    const data = Buffer.from(r.rawBytesBase64, 'base64')
    await writeAtomically(target, data, force)
    emit(ctx, { path: target, bytes: data.length, counts: r.counts as unknown as Json, notes: r.notes }, () => [
      `Wrote ${safeLine(target)} (${data.length} bytes): ${plural(r.counts.skills, 'skill')}, ${plural(r.counts.mcpServers, 'server')}, ${plural(r.counts.connectorPresets, 'preset')}, ${plural(r.counts.templates, 'template')}.`,
      ...r.notes.map((n) => styleFor(ctx).dim(safeLine(n)))
    ])
    return EXIT.ok
  })
}

// ---------- import ----------

function actionArg(raw: string, where: string): KitAction {
  if (!(ACTIONS as readonly string[]).includes(raw)) throw usage(`${where} must be one of ${ACTIONS.join(', ')}.`)
  return raw as KitAction
}

/** --item <key-or-name>=<action> pairs, resolved to preview keys. Unknown or ambiguous items are exit 2. */
export function itemOverrides(preview: KitImportPreview, items: readonly string[] | undefined): Map<string, KitAction> {
  const out = new Map<string, KitAction>()
  for (const raw of items ?? []) {
    const eq = raw.lastIndexOf('=')
    if (eq <= 0) throw usage(`--item needs <key-or-name>=<action>, not "${safeLine(raw).slice(0, 64)}".`)
    const ref = raw.slice(0, eq)
    const action = actionArg(raw.slice(eq + 1), `The action of --item ${safeLine(ref).slice(0, 64)}`)
    const byKey = preview.items.find((i) => i.key === ref)
    const byName = preview.items.filter((i) => i.name === ref || `${i.kind}:${i.name}` === ref)
    const item = byKey ?? (byName.length === 1 ? byName[0] : undefined)
    if (!item) throw usage(byName.length > 1 ? `"${safeLine(ref).slice(0, 64)}" names ${byName.length} items; use the key (${byName.map((i) => i.key).join(', ')}).` : `No item "${safeLine(ref).slice(0, 64)}" in the kit.`)
    out.set(item.key, action)
  }
  return out
}

/**
 * One action per item: an --item override wins; else refused and same items skip, new items take --action when it is
 * add or skip (replace / copy mean "add" for a new item), and different items take --action when it is replace, copy
 * or skip. A different item without one of those is exit 2: it needs an explicit choice.
 */
export function kitChoices(preview: KitImportPreview, defaultAction: KitAction | undefined, overrides: Map<string, KitAction>): KitImportChoice[] {
  const undecided: KitPreviewItem[] = []
  const choices = preview.items.map((i): KitImportChoice => {
    const o = overrides.get(i.key)
    if (o) return { key: i.key, action: o }
    if (i.status === 'refused' || i.status === 'same') return { key: i.key, action: 'skip' }
    if (i.status === 'new') return { key: i.key, action: defaultAction === 'skip' ? 'skip' : 'add' }
    if (defaultAction === 'replace' || defaultAction === 'copy' || defaultAction === 'skip') return { key: i.key, action: defaultAction }
    undecided.push(i)
    return { key: i.key, action: 'skip' }
  })
  if (undecided.length) {
    throw usage(
      `${plural(undecided.length, 'item')} differ from yours and need a choice: ${undecided.map((i) => `${i.kind} ${safeLine(i.name)} (${i.key})`).join(', ')}. Pass --action replace|copy|skip or --item <key>=<action>.`
    )
  }
  return choices
}

function itemLines(ctx: CliContext, i: KitPreviewItem, action: KitAction): string[] {
  const st = styleFor(ctx)
  const status = i.status === 'refused' ? st.red('refused') : i.status === 'different' ? st.yellow('different') : i.status === 'new' ? st.green('new') : st.dim('same')
  const lines = [`${status}  ${i.kind} ${safeLine(i.name)}  ${st.dim(i.key)}  -> ${action}`]
  const sub = (s: string): void => {
    lines.push(`    ${s}`)
  }
  if (i.description) sub(safeLine(i.description))
  if (i.conflict) sub(st.yellow(safeLine(i.conflict)))
  if (i.refusal) sub(st.red(`Refused: ${safeLine(i.refusal)}`))
  if (i.status === 'different' && !i.canReplace) sub('Yours cannot be replaced from a kit (copy or skip it).')
  if (i.command) sub(`Runs / connects: ${safeLine(i.command)}`)
  if (i.secretSlots?.length) sub(`Secrets to set after importing: ${i.secretSlots.map(safeLine).join(', ')}${i.perProjectSecrets ? ' (per project)' : ''}`)
  if (i.files?.length) sub(`Files: ${i.files.map(safeLine).join(', ')}`)
  if (i.scripts?.length) sub(st.yellow(`Includes scripts; agents may be asked to run them: ${i.scripts.map(safeLine).join(', ')}`))
  for (const r of i.roles ?? []) {
    sub(`Role ${safeLine(r.name)} (${safeLine(r.slug)})${r.elevatedTools.length ? `: ${st.yellow(`can use ${r.elevatedTools.join(', ')}`)}` : ''}`)
    sub(`  Prompt: ${safeLine(r.prompt)}`)
  }
  if (!i.roles?.length && i.roleNames?.length) sub(`Roles: ${i.roleNames.map(safeLine).join(', ')}`)
  for (const n of i.notes) sub(st.dim(safeLine(n)))
  return lines
}

const isCode = (e: unknown, code: string): boolean => (e as Partial<HostCallError> | undefined)?.data?.code === code

const importCmd: SubcommandFn = async (ctx, args) => {
  const { values, positionals } = parseFlags(args, { action: { type: 'string' }, item: { type: 'string', multiple: true }, yes: { type: 'boolean', short: 'y' } })
  if (positionals.length !== 1) throw usage(positionals.length ? `Unexpected argument "${safeLine(positionals[1]).slice(0, 64)}".` : 'kit import needs the kit file.')
  const defaultAction = values.action === undefined ? undefined : actionArg(values.action, '--action')
  const file = resolve(ctx.cwd, positionals[0])
  let bytes: Buffer
  try {
    const st = await kitFs.stat(file)
    if (!st.isFile()) throw usage(`${safeLine(file)} is not a file.`)
    if (st.size > KIT_MAX_BYTES) throw usage(`${safeLine(file)} is larger than ${KIT_MAX_BYTES / 1024 / 1024} MB.`)
    bytes = await kitFs.readFile(file)
  } catch (e) {
    if (e instanceof CliError) throw e
    throw usage(`Cannot read ${safeLine(file)}.`)
  }
  if (bytes.length > KIT_MAX_BYTES) throw usage(`${safeLine(file)} is larger than ${KIT_MAX_BYTES / 1024 / 1024} MB.`)
  const rawBytesBase64 = bytes.toString('base64')
  return withHost(ctx, CONFIGURE, async (client) => {
    const preview = await hostCall<KitImportPreview>(client, 'kit:previewBundle', [{ fileName: basename(file), rawBytesBase64 }], { timeoutMs: BULK_TIMEOUT_MS })
    const choices = kitChoices(preview, defaultAction, itemOverrides(preview, values.item))
    const actionOf = (key: string): KitAction => choices.find((c) => c.key === key)?.action ?? 'skip'
    const refusedItems = preview.items.filter((i) => i.status === 'refused')
    const refusedChosen = refusedItems.filter((i) => actionOf(i.key) !== 'skip')
    const refusedJson = (list: KitPreviewItem[]): Json[] => list.map((i) => ({ key: i.key, name: i.name, reason: i.refusal ?? 'Refused.' }))
    const applying = choices.filter((c) => c.action !== 'skip')
    const previewJson: Json = { fileName: preview.fileName, digest: preview.digest, targetDigest: preview.targetDigest ?? null, items: preview.items as unknown as Json[], notes: preview.notes, choices }
    printText(ctx, [
      `${safeLine(preview.fileName)}: ${plural(preview.items.length, 'item')}${preview.appVersion ? `, exported by OrgAI ${safeLine(preview.appVersion)}` : ''}${preview.exportedAt ? ` on ${safeLine(preview.exportedAt)}` : ''}.`,
      ...preview.items.flatMap((i) => itemLines(ctx, i, actionOf(i.key))),
      ...preview.notes.map((n) => styleFor(ctx).dim(safeLine(n)))
    ])
    if (applying.length === 0) {
      emit(ctx, { preview: previewJson, applied: false, ok: refusedItems.length === 0, refused: refusedJson(refusedItems) }, () =>
        refusedItems.length ? `Nothing to import; ${plural(refusedItems.length, 'item')} refused.` : 'Nothing to import.'
      )
      return refusedItems.length ? EXIT.failure : EXIT.ok
    }
    if (preview.targetDigest === undefined) throw new CliError('The OrgAI host did not return a target digest for this kit; update OrgAI.', EXIT.failure)
    if (!(await confirm(ctx, `Import ${plural(applying.length, 'item')} from ${safeLine(preview.fileName)}?`, !!values.yes))) {
      emit(ctx, { preview: previewJson, applied: false, cancelled: true }, () => 'Cancelled.')
      return EXIT.failure
    }
    let result: KitApplyResult
    try {
      result = await client.call<KitApplyResult>('kit:applyBundle', [{ rawBytesBase64, digest: preview.digest, targetDigest: preview.targetDigest, choices }], { timeoutMs: BULK_TIMEOUT_MS })
    } catch (e) {
      if (isCode(e, 'stale_target_digest')) {
        emit(ctx, { preview: previewJson, applied: false, error: { code: 'stale_target_digest', message: STALE_TARGET_CLI_MESSAGE } }, () => [])
        throw new CliError(STALE_TARGET_CLI_MESSAGE, EXIT.failure)
      }
      throw changeError(e)
    }
    const failed = result.failed
    const ok = failed.length === 0 && refusedItems.length === 0
    const json = { preview: previewJson, applied: true, ok, result: result as unknown as Json, refused: refusedJson(refusedItems), refusedChosen: refusedJson(refusedChosen) }
    emit(ctx, json, () => {
      const st = styleFor(ctx)
      const lines = [`Imported: ${result.added} added, ${result.replaced} replaced, ${result.copied} copied, ${result.skipped} skipped.`]
      for (const f of failed) lines.push(st.red(`Failed: ${safeLine(f.name)} (${safeLine(f.key)}): ${safeLine(f.reason)}`))
      const notImported = refusedItems.filter((i) => !failed.some((f) => f.key === i.key))
      if (notImported.length) lines.push(st.red(`Refused, not imported: ${notImported.map((i) => `${safeLine(i.name)} (${safeLine(i.key)})`).join(', ')}`))
      for (const n of result.needsSecrets) {
        const slots = [...n.env, ...n.headers].map(safeLine)
        lines.push(`${safeLine(n.name)} needs ${slots.join(', ')}${n.perProject ? ' (per project)' : ''}: set ${slots.length === 1 ? 'it' : 'them'} with \`orgai mcp library set-secret ${safeLine(n.name)} <NAME>\`.`)
      }
      for (const n of result.notes) lines.push(st.dim(safeLine(n)))
      return lines
    })
    return ok ? EXIT.ok : EXIT.failure
  })
}

export const runKit: CommandFn = (ctx, args) => runSubcommands(ctx, args, { export: exportCmd, import: importCmd }, KIT_USAGE)

