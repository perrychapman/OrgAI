/**
 * `orgai notes` (cli-spec 6.3, Wave 5): an engagement's context notes and its engagement plan (the document). Code
 * projects have neither: exit 2.
 *
 *   notes list [--retired] | notes show <id-or-title>                                       read
 *   notes add --title <t> (--text <t> | --file <path|->)                                   configure
 *   notes edit <id-or-title> [--title <t>] [--text <t> | --file <path|->] [--retire|--restore] [--expected-updated-at <ms>]
 *   notes remove <id-or-title> [--yes]                                                      configure
 *   notes plan [show] | notes plan set (--text <t> | --file <path|->) [--expected-updated-at <ms>]
 *
 * Revisions: `plan set` sends the document's updatedAt as expectedUpdatedAt (the read's, or --expected-updated-at), so
 * the host refuses a save over a newer document (exit 1, like the app's stale banner). `notes edit` sends the note's
 * updatedAt (the read's, or --expected-updated-at) as projects:saveNote expectedUpdatedAt; the host compares it with
 * the stored note in the same synchronous step as the write and refuses with 'stale_revision':
 * "The note changed since you read it." (exit 1).
 * Caps are checked before anything is sent (exit 2).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  ENGAGEMENT_DOCUMENT_MAX_CHARS,
  ENGAGEMENT_NOTE_MAX_CHARS,
  ENGAGEMENT_NOTE_TITLE_MAX_CHARS,
  type EngagementDocumentInfo,
  type EngagementNote,
  type EngagementNoteContent,
  type EngagementNoteSaveInput,
  type Project
} from '../../shared/types'
import { formatDateTime } from '../../shared/view/dates'
import { parseFlags } from '../flags'
import { confirm, hostCall, hostError, readStdinText, requireEngagement, requireProject, runSubcommands, withHost } from '../manage'
import { emit, printText, safe, safeLine, styleFor, table, termWidth, type Json } from '../output'
import { CliError, EXIT, type CliContext, type CommandFn, type HostCallError, type HostClient } from '../types'
import { CONFIGURE, READ, refusable } from './connections'

const USAGE = 'notes <list|show|add|edit|remove|plan> [options]'
export const NOTE_STALE_MESSAGE = 'The note changed since you read it. Read it again (orgai notes show) and redo your edit.'
const WHAT = 'context notes'

function unexpected(positionals: string[], from = 0): void {
  if (positionals.length > from) throw new CliError(`Unexpected argument "${safeLine(positionals[from]).slice(0, 40)}".`, EXIT.usage)
}

async function engagement(ctx: CliContext, client: HostClient, what = WHAT): Promise<Project> {
  const project = await requireProject(ctx, client)
  requireEngagement(project, what)
  return project
}

/** A revision flag: a non-negative whole number of epoch ms. */
function revisionArg(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  if (!/^\d{1,16}$/.test(raw)) throw new CliError('--expected-updated-at takes the updatedAt (epoch ms) you read, e.g. from --output-format json.', EXIT.usage)
  return Number(raw)
}

/**
 * Text from exactly one of --text or --file (a path, or - for stdin), at most `maxChars` characters (else exit 2,
 * before anything is sent). undefined when neither is given and `required` is false.
 */
export async function textInput(ctx: CliContext, values: { text?: string; file?: string }, opts: { maxChars: number; label: string; required: boolean }): Promise<string | undefined> {
  const { text, file } = values
  if (text !== undefined && file !== undefined) throw new CliError('Give --text or --file, not both.', EXIT.usage)
  if (text === undefined && file === undefined) {
    if (opts.required) throw new CliError(`Give ${opts.label} with --text <text> or --file <path|->.`, EXIT.usage)
    return undefined
  }
  const tooLong = (n: number): CliError => new CliError(`${opts.label[0].toUpperCase()}${opts.label.slice(1)} is longer than ${opts.maxChars.toLocaleString('en-US')} characters (${n.toLocaleString('en-US')}). Shorten it; nothing was sent.`, EXIT.usage)
  // A UTF-8 character takes at most 4 bytes.
  const maxBytes = opts.maxChars * 4
  let value: string
  if (text !== undefined) value = text
  else if (file === '-') {
    if (ctx.io.stdinIsTTY) throw new CliError('--file - reads stdin, but stdin is a terminal; pipe the text in.', EXIT.usage)
    value = await readStdinText(maxBytes, `${opts.label[0].toUpperCase()}${opts.label.slice(1)} on stdin`)
  } else {
    const p = path.resolve(ctx.cwd, file!)
    let size: number
    try {
      const st = fs.statSync(p)
      if (!st.isFile()) throw new CliError(`${safeLine(p)} is not a file.`, EXIT.usage)
      size = st.size
    } catch (e) {
      if (e instanceof CliError) throw e
      throw new CliError(`Could not read ${safeLine(p)}: ${safeLine((e as Error).message)}`, EXIT.usage)
    }
    if (size > maxBytes) throw tooLong(size)
    value = fs.readFileSync(p, 'utf8')
  }
  if (value.length > opts.maxChars) throw tooLong(value.length)
  return value
}

function titleArg(raw: string): string {
  const t = raw.trim()
  if (!t) throw new CliError('Give the note a title.', EXIT.usage)
  if (t.length > ENGAGEMENT_NOTE_TITLE_MAX_CHARS) throw new CliError(`The title is longer than ${ENGAGEMENT_NOTE_TITLE_MAX_CHARS} characters.`, EXIT.usage)
  return t
}

/** A note by id, else by title (case-insensitive; more than one match is exit 2). */
export function resolveNote(notes: readonly EngagementNote[], ref: string): EngagementNote {
  const byId = notes.find((n) => n.id === ref)
  if (byId) return byId
  const key = ref.trim().toLowerCase()
  const hits = notes.filter((n) => n.title.trim().toLowerCase() === key)
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) throw new CliError(`${hits.length} notes are titled "${safeLine(ref).slice(0, 60)}"; use the id (${hits.map((n) => n.id).join(', ')}).`, EXIT.usage)
  throw new CliError(`No note "${safeLine(ref).slice(0, 60)}". List them with \`orgai notes list\`.`, EXIT.usage)
}

async function listNotes(client: HostClient, projectId: string): Promise<EngagementNote[]> {
  const list = await hostCall<EngagementNote[]>(client, 'projects:listNotes', [projectId])
  return (Array.isArray(list) ? list : []).slice().sort((a, b) => a.createdAt - b.createdAt)
}

const noteJson = (n: EngagementNote): Json => ({
  id: n.id,
  title: n.title,
  excerpt: n.excerpt,
  createdAt: n.createdAt,
  updatedAt: n.updatedAt,
  chars: n.chars,
  source: n.source ?? 'user',
  ...(n.recordedBy ? { recordedBy: n.recordedBy } : {}),
  ...(n.updatedBy ? { updatedBy: n.updatedBy } : {}),
  retired: n.retired === true
})

const byLine = (n: EngagementNote): string => ((n.source ?? 'user') === 'agent' ? `${safeLine(n.recordedBy?.role ?? 'An agent')}` : 'You')

// ---------- list / show ----------

const runList = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, { retired: { type: 'boolean' } })
  unexpected(positionals)
  return withHost(ctx, READ, async (client) => {
    const project = await engagement(ctx, client)
    const all = await listNotes(client, project.id)
    const notes = values.retired ? all : all.filter((n) => !n.retired)
    emit(ctx, { project: { id: project.id, name: project.name }, notes: notes.map(noteJson), hiddenRetired: all.length - notes.length }, () => {
      if (notes.length === 0) return all.length ? `No notes shown; ${all.length} retired (pass --retired).` : `No context notes in ${safeLine(project.name)}.`
      const st = styleFor(ctx)
      const lines = table(
        [{ header: 'ID', min: 6 }, { header: 'TITLE', flex: true, min: 10 }, { header: 'BY', min: 3 }, { header: 'UPDATED', min: 8 }],
        notes.map((n) => [n.id, `${safeLine(n.title)}${n.retired ? ' (retired)' : ''}`, byLine(n), formatDateTime(n.updatedAt)]),
        termWidth(ctx),
        st
      )
      if (all.length > notes.length) lines.push(st.dim(`${all.length - notes.length} retired not shown (--retired).`))
      return lines
    })
    return EXIT.ok
  })
}

const runShow = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { positionals } = parseFlags(args, {})
  unexpected(positionals, 1)
  const ref = positionals[0]
  if (ref === undefined) throw new CliError('Name the note: orgai notes show <id-or-title>.', EXIT.usage)
  return withHost(ctx, READ, async (client) => {
    const project = await engagement(ctx, client)
    const n = resolveNote(await listNotes(client, project.id), ref)
    const note = await hostCall<EngagementNoteContent>(client, 'projects:getNote', [{ projectId: project.id, noteId: n.id }])
    emit(ctx, { note: { ...noteJson(note), text: note.text } }, () => [
      `${safeLine(note.title)}${note.retired ? ' (retired)' : ''}`,
      `${byLine(note)} · ${formatDateTime(note.updatedAt)} · ${note.id}`,
      '',
      safe(note.text)
    ])
    return EXIT.ok
  })
}

// ---------- add / edit / remove ----------

const TEXT_FLAGS = { text: { type: 'string' }, file: { type: 'string' } } as const

const runAdd = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, { title: { type: 'string' }, ...TEXT_FLAGS })
  unexpected(positionals)
  if (values.title === undefined) throw new CliError('Give the note a title with --title.', EXIT.usage)
  const title = titleArg(values.title)
  const text = (await textInput(ctx, values, { maxChars: ENGAGEMENT_NOTE_MAX_CHARS, label: 'the note', required: true }))!
  return withHost(ctx, CONFIGURE, async (client) => {
    const project = await engagement(ctx, client)
    const input: EngagementNoteSaveInput = { projectId: project.id, title, text }
    const note = await refusable<EngagementNote>(client, 'projects:saveNote', [input])
    emit(ctx, { note: noteJson(note) }, () => `Saved note ${safeLine(note.title)} (${note.id}).`)
    return EXIT.ok
  })
}

const runEdit = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, { title: { type: 'string' }, ...TEXT_FLAGS, retire: { type: 'boolean' }, restore: { type: 'boolean' }, 'expected-updated-at': { type: 'string' } })
  unexpected(positionals, 1)
  const ref = positionals[0]
  if (ref === undefined) throw new CliError('Name the note: orgai notes edit <id-or-title> ...', EXIT.usage)
  if (values.retire && values.restore) throw new CliError('Give --retire or --restore, not both.', EXIT.usage)
  const expected = revisionArg(values['expected-updated-at'])
  const title = values.title === undefined ? undefined : titleArg(values.title)
  const text = await textInput(ctx, values, { maxChars: ENGAGEMENT_NOTE_MAX_CHARS, label: 'the note', required: false })
  if (title === undefined && text === undefined && !values.retire && !values.restore) throw new CliError('Nothing to change: give --title, --text, --file, --retire or --restore.', EXIT.usage)
  return withHost(ctx, CONFIGURE, async (client) => {
    const project = await engagement(ctx, client)
    const n = resolveNote(await listNotes(client, project.id), ref)
    // The read supplies the unchanged fields; the host's expectedUpdatedAt check makes the save a compare-and-set.
    const latest = await hostCall<EngagementNoteContent>(client, 'projects:getNote', [{ projectId: project.id, noteId: n.id }])
    const base = expected ?? latest.updatedAt
    if (latest.updatedAt !== base) throw new CliError(NOTE_STALE_MESSAGE, EXIT.failure)
    const input: EngagementNoteSaveInput = {
      projectId: project.id,
      noteId: n.id,
      title: title ?? latest.title,
      text: text ?? latest.text,
      ...(values.retire ? { retired: true } : values.restore ? { retired: false } : {}),
      expectedUpdatedAt: base
    }
    let note: EngagementNote
    try {
      note = await client.call<EngagementNote>('projects:saveNote', [input])
    } catch (e) {
      if ((e as Partial<HostCallError> | undefined)?.data?.code === 'stale_revision') throw new CliError(NOTE_STALE_MESSAGE, EXIT.failure)
      const err = hostError(e)
      throw err.exitCode === EXIT.usage ? new CliError(err.message, EXIT.failure) : err
    }
    emit(ctx, { note: noteJson(note), previousUpdatedAt: base }, () => `Saved note ${safeLine(note.title)} (${note.id}).`)
    return EXIT.ok
  })
}

const runRemove = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, { yes: { type: 'boolean', short: 'y' } })
  unexpected(positionals, 1)
  const ref = positionals[0]
  if (ref === undefined) throw new CliError('Name the note: orgai notes remove <id-or-title>.', EXIT.usage)
  return withHost(ctx, CONFIGURE, async (client) => {
    const project = await engagement(ctx, client)
    const n = resolveNote(await listNotes(client, project.id), ref)
    if (!(await confirm(ctx, `Remove the note "${safeLine(n.title)}"?`, !!values.yes))) {
      printText(ctx, 'Nothing changed.')
      return EXIT.failure
    }
    const rest = await hostCall<EngagementNote[]>(client, 'projects:removeNote', [{ projectId: project.id, noteId: n.id }])
    emit(ctx, { removed: n.id, notes: (Array.isArray(rest) ? rest : []).length }, () => `Removed note ${safeLine(n.title)}.`)
    return EXIT.ok
  })
}

// ---------- plan ----------

const docJson = (d: EngagementDocumentInfo): Json => ({ text: d.text, ...(d.updatedAt ? { updatedAt: d.updatedAt } : {}), ...(d.updatedBy ? { updatedBy: d.updatedBy } : {}) })

const runPlanShow = async (ctx: CliContext, args: string[]): Promise<number> => {
  unexpected(parseFlags(args, {}).positionals)
  return withHost(ctx, READ, async (client) => {
    const project = await engagement(ctx, client, 'the engagement plan')
    const doc = await hostCall<EngagementDocumentInfo>(client, 'projects:engagementDocument', [project.id])
    emit(ctx, { project: { id: project.id, name: project.name }, plan: docJson(doc) }, () => {
      if (!doc.text && !doc.updatedAt) return `${safeLine(project.name)} has no engagement plan yet. Write one with \`orgai notes plan set --file <path>\`.`
      return [`Engagement plan of ${safeLine(project.name)}${doc.updatedAt ? `, saved ${formatDateTime(doc.updatedAt)} by ${doc.updatedBy === 'setup' ? 'setup' : 'you'}` : ''}`, '', safe(doc.text)]
    })
    return EXIT.ok
  })
}

const runPlanSet = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values, positionals } = parseFlags(args, { ...TEXT_FLAGS, 'expected-updated-at': { type: 'string' } })
  unexpected(positionals)
  const expected = revisionArg(values['expected-updated-at'])
  const text = (await textInput(ctx, values, { maxChars: ENGAGEMENT_DOCUMENT_MAX_CHARS, label: 'the engagement plan', required: true }))!
  return withHost(ctx, CONFIGURE, async (client) => {
    const project = await engagement(ctx, client, 'the engagement plan')
    const base = expected ?? (await hostCall<EngagementDocumentInfo>(client, 'projects:engagementDocument', [project.id])).updatedAt ?? 0
    const doc = await refusable<EngagementDocumentInfo>(client, 'projects:updateEngagementDocument', [{ projectId: project.id, text, expectedUpdatedAt: base }])
    emit(ctx, { plan: { ...(doc.updatedAt ? { updatedAt: doc.updatedAt } : {}), chars: doc.text.length }, previousUpdatedAt: base }, () => `Saved the engagement plan (${doc.text.length.toLocaleString('en-US')} characters).`)
    return EXIT.ok
  })
}

const runPlan = (ctx: CliContext, args: string[]): Promise<number> => {
  const [sub, ...rest] = args
  if (sub === undefined || sub.startsWith('-')) return runPlanShow(ctx, args)
  if (sub === 'show') return runPlanShow(ctx, rest)
  if (sub === 'set') return runPlanSet(ctx, rest)
  throw new CliError(`Unknown subcommand 'plan ${safeLine(sub).slice(0, 64)}'. Usage: orgai notes plan [show|set] [options]`, EXIT.usage)
}

export const runNotes: CommandFn = (ctx, args) => runSubcommands(ctx, args, { list: runList, show: runShow, add: runAdd, edit: runEdit, remove: runRemove, plan: runPlan }, USAGE)
