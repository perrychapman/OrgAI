/**
 * `orgai outputs` (cli-parity 3.6): the project's run outputs (files agents produced or registered) over the
 * outputs:* channels.
 *
 *   list [--run <run>]                         read: outputs:list (the project's, or one run's)
 *   show <output>                              read: metadata, plus outputs:preview text for text-like kinds, else the path
 *   revise <output> "<instruction>" [--run <run> | --new]   operate: outputs:revise, the whole current version
 *   note <output> "<text>" [--version <n>]     operate: outputs:noteAdd, anchored to the whole version
 *
 * `<output>` is an id (or a prefix of one, at least 6 characters), a file name, a path relative to the project, or a
 * title. Opening, revealing, saving as, forgetting, deleting and editing stay in the desktop app (desktop-only or
 * configure channels). Revise goes to the run that made the output when it is live or continuable (outputs:reviseOptions),
 * else a new run; --run names a run, --new asks for a new one. The host's refusal sentence is printed as written.
 */
import { OUTPUT_NOTE_TEXT_MAX, OUTPUT_REVISE_TEXT_MAX, type OutputNote, type OutputPreview, type OutputReviseOptions, type OutputReviseResult, type OutputReviseTarget, type RunOutput } from '../../shared/types'
import { formatDateTime } from '../../shared/view/dates'
import { runIndexMap, runTag } from '../../shared/view/runLabels'
import { parseFlags } from '../flags'
import { hostCall, hostError, requireProject, runSubcommands, withHost } from '../manage'
import { bytesText, outputSummary, outputsOfRun, previewLines, previewPlainText } from '../outputsText'
import { emit, safeLine, styleFor, table, termWidth, type Json } from '../output'
import { liveSource, resolveRunFromSource } from '../runRef'
import { CliError, EXIT, type CliContext, type CommandFn, type HostClient } from '../types'
import { OPERATE, READ } from './connections'

const USAGE = 'outputs <list|show|revise|note> [options]'
const ID_PREFIX_MIN = 6

const usage = (m: string): CliError => new CliError(m, EXIT.usage)

function unexpected(positionals: string[], from: number): void {
  if (positionals.length > from) throw usage(`Unexpected argument "${safeLine(positionals[from]).slice(0, 40)}".`)
}

/** The output `ref` names among `outputs`: id, id prefix, file name, relative path or title (case-insensitive for the last three). */
export function findOutput(outputs: readonly RunOutput[], ref: string): RunOutput {
  const raw = (ref ?? '').trim()
  if (!raw) throw usage('Name an output: its id, file name or title (orgai outputs list).')
  const lower = raw.toLowerCase()
  const tiers: RunOutput[][] = [
    outputs.filter((o) => o.id === raw),
    raw.length >= ID_PREFIX_MIN ? outputs.filter((o) => o.id.startsWith(raw)) : [],
    outputs.filter((o) => o.fileName.toLowerCase() === lower || o.relPath.toLowerCase() === lower),
    outputs.filter((o) => o.title.trim().toLowerCase() === lower)
  ]
  for (const hits of tiers) {
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) throw usage(`"${safeLine(raw).slice(0, 60)}" matches ${hits.length} outputs (${hits.slice(0, 4).map((o) => o.id).join(', ')}). Use the id from \`orgai outputs list\`.`)
  }
  throw usage(`No output "${safeLine(raw).slice(0, 60)}" in this project. List them with: orgai outputs list`)
}

async function listOutputs(client: HostClient, projectId: string): Promise<RunOutput[]> {
  const list = await hostCall<RunOutput[]>(client, 'outputs:list', [projectId])
  return Array.isArray(list) ? list : []
}

/** The run `ref` names (host lookup) with its project id and tag. */
async function resolveRun(ctx: CliContext, client: HostClient, ref: string): Promise<{ runId: string; projectId: string; tag: string }> {
  const r = await resolveRunFromSource(ctx, liveSource(client), ref).catch((e: unknown) => {
    throw e instanceof CliError ? e : hostError(e)
  })
  const summary = r.runs.find((x) => x.id === r.runId)
  const projectId = summary?.projectId ?? r.resolution.project?.id
  if (!projectId) throw usage(`Run ${safeLine(r.runId)} has no project.`)
  const list = r.runs.filter((x) => x.projectId === projectId)
  return { runId: r.runId, projectId, tag: runTag(runIndexMap(list).get(r.runId)) }
}

const outputJson = (o: RunOutput): Json => ({
  id: o.id,
  title: o.title,
  kind: o.kind,
  fileName: o.fileName,
  relPath: o.relPath,
  path: o.path,
  bytes: o.bytes,
  source: o.source,
  runId: o.runId,
  ...(o.role ? { role: o.role } : {}),
  version: o.version ?? 1,
  versionCount: o.versionCount ?? 1,
  openNotes: o.openNoteCount ?? 0,
  createdAt: o.createdAt,
  ...(o.updatedAt ? { updatedAt: o.updatedAt } : {}),
  ...(o.description ? { description: o.description } : {}),
  ...(o.missing ? { missing: true } : {})
})

// ---------- list ----------

const runList = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, { run: { type: 'string' } })
  unexpected(positionals, 0)
  return withHost(ctx, READ, async (client) => {
    let projectId: string
    let runId: string | undefined
    let runTagText: string | undefined
    if (values.run !== undefined) {
      const r = await resolveRun(ctx, client, values.run)
      projectId = r.projectId
      runId = r.runId
      runTagText = r.tag
    } else projectId = (await requireProject(ctx, client)).id
    const all = await listOutputs(client, projectId)
    const shown = runId ? outputsOfRun(all, runId) : all
    emit(ctx, { projectId, ...(runId ? { runId } : {}), outputs: shown.map(outputJson) }, () => {
      if (shown.length === 0) return runId ? `Run ${safeLine(runTagText)} produced no outputs.` : 'No outputs yet.'
      return table(
        [{ header: 'ID', min: 8 }, { header: 'TITLE', flex: true, min: 10, ellipsis: 'end' }, { header: 'KIND', min: 4 }, { header: 'VER', min: 3, align: 'right' }, { header: 'SIZE', min: 6, align: 'right' }, { header: 'NOTES', min: 5, align: 'right' }, { header: 'PATH', flex: true, min: 10, ellipsis: 'middle' }],
        shown.map((o) => [o.id, safeLine(o.title), o.kind, `v${o.version ?? 1}`, o.missing ? 'missing' : bytesText(o.bytes), String(o.openNoteCount ?? 0), safeLine(o.relPath)]),
        termWidth(ctx),
        styleFor(ctx)
      )
    })
    return EXIT.ok
  })
}

// ---------- show ----------

const runShow = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { positionals } = parseFlags(args, {})
  if (positionals.length !== 1) throw usage('Use: orgai outputs show <output>')
  unexpected(positionals, 1)
  return withHost(ctx, READ, async (client) => {
    const project = await requireProject(ctx, client)
    const o = findOutput(await listOutputs(client, project.id), positionals[0])
    let preview: OutputPreview | undefined
    if (!o.missing) preview = await hostCall<OutputPreview>(client, 'outputs:preview', [{ projectId: project.id, outputId: o.id }]).catch(() => undefined)
    const text = preview ? previewPlainText(preview) : undefined
    const shownText = text === undefined ? undefined : previewLines(text)
    emit(
      ctx,
      {
        output: outputJson(o),
        preview: preview ? { kind: preview.kind, ...(text !== undefined ? { text: shownText ? shownText.lines.join('\n') : text, truncated: shownText?.truncated ?? false } : {}), ...(preview.kind === 'none' ? { reason: preview.reason } : {}) } : null
      },
      () => {
        const st = styleFor(ctx)
        const lines = [st.bold(outputSummary(o)), `  path: ${safeLine(o.path)}`]
        lines.push(`  made by: ${o.role ? safeLine(o.role) : 'a run'} (run ${safeLine(o.runId)}) · ${o.source} · created ${formatDateTime(o.createdAt)}${o.updatedAt ? `, updated ${formatDateTime(o.updatedAt)}` : ''}`)
        if (o.versionCount && o.versionCount > 1) lines.push(`  versions: ${o.versionCount} kept`)
        if (o.description) lines.push(`  ${safeLine(o.description)}`)
        if (o.missing) lines.push(st.yellow('  The file is missing from disk.'))
        else if (shownText) {
          lines.push('', st.bold('Preview:'), ...shownText.lines.map((l) => `  ${l}`))
          if (shownText.truncated) lines.push(st.dim(`  (shortened; open ${safeLine(o.relPath)} for the whole file)`))
        } else lines.push('', st.dim(`No text preview for ${o.kind}${preview?.kind === 'none' ? ` (${safeLine(preview.reason)})` : ''}. Open the file at the path above.`))
        return lines
      }
    )
    return EXIT.ok
  })
}

// ---------- revise ----------

/** Where a revise goes by default: the run that made the output when it can take it, else a new run. */
export function defaultTarget(options: OutputReviseOptions): OutputReviseTarget | undefined {
  const run = options.runs.find((r) => r.state === 'live' || r.state === 'continuable')
  if (run) return { type: 'run', runId: run.runId }
  return options.newRunAllowed ? { type: 'new' } : undefined
}

const runRevise = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, { run: { type: 'string' }, new: { type: 'boolean' } })
  if (positionals.length !== 2) throw usage('Use: orgai outputs revise <output> "<instruction>" [--run <run> | --new]')
  const instruction = positionals[1].trim()
  if (!instruction) throw usage('Say what to change: orgai outputs revise <output> "<instruction>".')
  if (instruction.length > OUTPUT_REVISE_TEXT_MAX) throw usage(`The instruction is at most ${OUTPUT_REVISE_TEXT_MAX} characters.`)
  if (values.run !== undefined && values.new) throw usage('Use --run or --new, not both.')
  return withHost(ctx, OPERATE, async (client) => {
    const project = await requireProject(ctx, client)
    const o = findOutput(await listOutputs(client, project.id), positionals[0])
    let target: OutputReviseTarget | undefined
    if (values.run !== undefined) target = { type: 'run', runId: (await resolveRun(ctx, client, values.run)).runId }
    else if (values.new) target = { type: 'new' }
    else target = defaultTarget(await hostCall<OutputReviseOptions>(client, 'outputs:reviseOptions', [{ projectId: project.id, outputId: o.id }]))
    if (!target) throw new CliError('No run can take this revision right now (the run that made it is waiting on you, or new runs are not allowed). Answer its card, or name a run with --run.', EXIT.failure)
    const result = await hostCall<OutputReviseResult>(client, 'outputs:revise', [{ projectId: project.id, outputId: o.id, version: o.version ?? 1, scope: 'whole', instruction, target }])
    if ('refused' in result) throw new CliError(safeLine(result.refused), EXIT.failure)
    const how = result.mode === 'sent' ? 'Sent to the running run' : result.mode === 'continued' ? 'Continued the ended run' : 'Started a new run'
    emit(ctx, { outputId: o.id, requestId: result.requestId, runId: result.runId, mode: result.mode }, () => `${how} ${safeLine(result.runId)} to revise ${safeLine(o.title)}. Follow it with: orgai resume ${safeLine(result.runId)}`)
    return EXIT.ok
  })
}

// ---------- note ----------

const runNote = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, { version: { type: 'string' } })
  if (positionals.length !== 2) throw usage('Use: orgai outputs note <output> "<text>" [--version <n>]')
  const text = positionals[1].trim()
  if (!text) throw usage('Write the note: orgai outputs note <output> "<text>".')
  if (text.length > OUTPUT_NOTE_TEXT_MAX) throw usage(`A note is at most ${OUTPUT_NOTE_TEXT_MAX} characters.`)
  const version = values.version === undefined ? undefined : /^[1-9]\d{0,5}$/.test(values.version) ? Number(values.version) : NaN
  if (Number.isNaN(version)) throw usage('--version takes a whole number from 1.')
  return withHost(ctx, OPERATE, async (client) => {
    const project = await requireProject(ctx, client)
    const o = findOutput(await listOutputs(client, project.id), positionals[0])
    const note = await hostCall<OutputNote>(client, 'outputs:noteAdd', [{ projectId: project.id, outputId: o.id, version: version ?? o.version ?? 1, anchor: { type: 'whole' }, text }])
    emit(ctx, { outputId: o.id, note: { id: note.id, version: note.version, status: note.status, text: note.text } }, () => `Added a note to ${safeLine(o.title)} v${note.version}. It stays with the output for you and the team to read.`)
    return EXIT.ok
  })
}

/** Bare `orgai outputs` (or leading flags) lists. */
export const runOutputs: CommandFn = (ctx, args) => (args.length === 0 || args[0].startsWith('-') ? runList(ctx, args) : runSubcommands(ctx, args, { list: runList, show: runShow, revise: runRevise, note: runNote }, USAGE))
