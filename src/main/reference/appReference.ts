/**
 * The reference service behind app_reference / app:reference: OrgAI answers questions about itself from its own
 * registries. A corpus of sections is built lazily from code tables (atlas, setting and menu docs, harness tool
 * catalog, host channel registry, CLI command table, connectors) plus bundled docs, indexed once, and searched with a
 * small ranked scorer. Nothing here reads user data or secrets; `status` is a snapshot of secret-free fields passed
 * in by the caller. Every value from a registry or doc leaves inside a fence (fencedBlock / fenceDatum).
 *
 * Section ids: `<kind>:<key>`: surface:<atlas id>, setting:<field> | setting:project.<field>, menu:<action>,
 * shortcut:<key>, tool:<name>, channel:<channel>, command:<name>, connector:<id>, doc:<file>#<heading-slug>.
 * Shortcut rows default to shared/view/shortcuts.ts SHORTCUTS (`shortcutRows`); `deps.shortcuts` overrides them (tests).
 * Electron-free (noElectronImport.test.ts).
 */
import { COMMANDS } from '../../cli/commandTable'
import {
  APP_REFERENCE_BUDGET_DEFAULT,
  APP_REFERENCE_BUDGET_MAX,
  APP_REFERENCE_BUDGET_MIN,
  APP_REFERENCE_ID_MAX_CHARS,
  APP_REFERENCE_QUERY_MAX_CHARS,
  APP_REFERENCE_READ_MAX_CHARS
} from '../../shared/types'
import type {
  HostKind,
  AppReferenceHit,
  AppReferenceQuery,
  AppReferenceResult,
  AppReferenceSectionKind,
  AppSettings,
  ConnectionInfo,
  CliShimStatus
} from '../../shared/types'
import { CONNECTORS, connectorEase } from '../../shared/connectors'
import { fenceDatum, fencedBlock, KNOWLEDGE_STOPWORDS, tokenizeKnowledge } from '../../shared/knowledgeIndex'
import { APP_SETTING_DOCS, ATLAS_SURFACES, MENU_ACTION_DOCS, PROJECT_SETTING_DOCS, atlasPath, isAtlasSurfaceId } from '../../shared/view/atlas'
import type { AtlasReach, AtlasSurfaceId } from '../../shared/view/atlas'
import { hiddenCharProblem } from '../capabilities/sanitize'
import { HOST_CHANNEL_REGISTRY } from '../host/registry'
import { harnessToolCatalog } from '../runtime/harnessTools'
import { bundledDocs } from './docs'
import { SHORTCUTS, type ShortcutDef } from '../../shared/view/shortcuts'

export interface ShortcutRow {
  /** Stable key, e.g. 'toggle-sidebar'. */
  key: string
  /** What it does. */
  label: string
  /** The keys, e.g. 'Ctrl/Cmd+B'. */
  keys: string
}

/** One searchable unit. `lines` are values from registries or docs (fenced on output); `heading` words weigh more. */
export interface RefSection {
  id: string
  kind: AppReferenceSectionKind
  title: string
  /** Extra title-weight words (breadcrumb path, aliases). */
  heading?: string
  lines: string[]
}

export const DOC_SECTION_MAX_CHARS = 6000
const SEARCH_EXCERPT_CHARS = 600
const MAX_TERMS = 16
const MIN_PREFIX_CHARS = 3
const MAX_PREFIX_TOKENS = 300

export interface CorpusInput {
  shortcuts?: readonly ShortcutRow[]
  /** file base name -> markdown. Default: the bundled docs. */
  docs?: Record<string, string>
}

const idPart = (s: string): string => s.replace(/[^A-Za-z0-9_.:#-]+/g, '-').replace(/^-+|-+$/g, '')
const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'section'

function reachText(r: AtlasReach): string {
  switch (r.via) {
    case 'sidebar':
      return `sidebar: ${r.label}`
    case 'menu':
      return `menu: ${MENU_ACTION_DOCS[r.action] ?? r.action}`
    case 'shortcut':
      return `shortcut: ${r.label}`
    case 'tab':
      return `tab: ${r.label}`
    case 'button':
      return `button: ${r.label} on ${atlasPath(r.on)}`
    case 'deepLink':
      return `link target: ${r.target}`
  }
}

/** Markdown -> sections split at #, ## and ### headings (headings inside code fences do not split). */
export function splitMarkdown(file: string, text: string): RefSection[] {
  const out: RefSection[] = []
  const seen = new Map<string, number>()
  const stack: string[] = []
  let cur: { title: string; path: string; body: string[] } | undefined
  let inFence = false
  const flush = (): void => {
    if (!cur) return
    const body = cur.body.join('\n').trim()
    if (!body && !cur.title) return
    const base = slug(cur.title)
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    let content = body
    if (content.length > DOC_SECTION_MAX_CHARS) content = `${content.slice(0, DOC_SECTION_MAX_CHARS)} (cut)`
    out.push({
      id: `doc:${idPart(file)}#${n === 1 ? base : `${base}-${n}`}`,
      kind: 'doc',
      title: cur.title,
      heading: `${file} ${cur.path}`,
      lines: content.split('\n')
    })
  }
  cur = { title: file, path: '', body: [] }
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    const m = !inFence ? /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line) : null
    if (m) {
      flush()
      const level = m[1].length
      stack.length = level - 1
      stack[level - 1] = m[2]
      cur = { title: m[2], path: stack.filter(Boolean).join(' '), body: [] }
    } else cur.body.push(line)
  }
  flush()
  return out.filter((s) => s.lines.some((l) => l.trim()))
}

/** The whole corpus (pure given its input and the code registries). */
export function buildReferenceCorpus(input: CorpusInput = {}): RefSection[] {
  const out: RefSection[] = []
  const ids = new Set<string>()
  const add = (s: RefSection): void => {
    if (ids.has(s.id)) return
    ids.add(s.id)
    out.push(s)
  }

  for (const s of ATLAS_SURFACES) {
    const lines = [
      `Path: ${s.path.join(' › ')}`,
      `Kind: ${s.kind}; scope: ${s.scope}`,
      s.summary,
      ...s.reach.map((r) => `How to reach: ${reachText(r)}`)
    ]
    for (const f of s.settings ?? []) {
      const doc = f.startsWith('project.')
        ? (PROJECT_SETTING_DOCS as Record<string, { summary: string } | undefined>)[f.slice(8)]
        : (APP_SETTING_DOCS as Record<string, { summary: string } | undefined>)[f]
      lines.push(`Setting ${f}${doc ? `: ${doc.summary}` : ''}`)
    }
    if (s.testIds?.length) lines.push(`Test ids: ${s.testIds.join(', ')}`)
    add({ id: `surface:${s.id}`, kind: 'surface', title: s.label, heading: s.path.join(' '), lines })
  }

  const settingSection = (key: string, prefix: string, d: { summary: string; surface: string; control: string; proposable?: true }): RefSection => {
    const where = d.surface !== 'none' && isAtlasSurfaceId(d.surface) ? atlasPath(d.surface as AtlasSurfaceId) : 'not shown on any screen'
    const name = `${prefix}${key}`
    return {
      id: `setting:${idPart(name)}`,
      kind: 'setting',
      title: name,
      heading: name.replace(/[._]/g, ' '),
      lines: [d.summary, `Where: ${where}`, `Control: ${d.control}${d.proposable ? '; an agent may propose it on a card' : ''}`]
    }
  }
  for (const [k, d] of Object.entries(APP_SETTING_DOCS)) add(settingSection(k, '', d))
  for (const [k, d] of Object.entries(PROJECT_SETTING_DOCS)) add(settingSection(k, 'project.', d))

  for (const [action, text] of Object.entries(MENU_ACTION_DOCS)) {
    add({ id: `menu:${idPart(action)}`, kind: 'menu', title: action, heading: action.replace(/-/g, ' '), lines: [String(text)] })
  }
  for (const sc of input.shortcuts ?? []) {
    add({ id: `shortcut:${idPart(sc.key)}`, kind: 'shortcut', title: sc.label, heading: `${sc.key} ${sc.keys}`, lines: [`${sc.label}: ${sc.keys}`] })
  }

  for (const t of harnessToolCatalog()) {
    add({
      id: `tool:${idPart(t.name)}`,
      kind: 'tool',
      title: t.name,
      heading: t.name.replace(/_/g, ' '),
      lines: [t.description, `Audience: ${t.audience}`, `Run kinds: ${t.runKinds.join(', ')}`, `Blocking: ${t.blocking ? 'yes' : 'no'}`]
    })
  }

  for (const [channel, e] of Object.entries(HOST_CHANNEL_REGISTRY)) {
    const how =
      e.direction === 'request' ? `request, scope ${e.scope}` : e.direction === 'push' ? `push, delivery ${e.delivery}` : 'protocol method'
    add({ id: `channel:${idPart(channel)}`, kind: 'channel', title: channel, heading: channel.replace(/[:.]/g, ' '), lines: [`Direction: ${how}`, `Source: ${e.source}`] })
  }

  for (const c of COMMANDS) {
    const lines = [c.summary, `Usage: orgai ${c.usage}`]
    if (c.subcommands?.length) lines.push(`Subcommands: ${c.subcommands.join(', ')}`)
    for (const f of c.flags) lines.push(`--${f.name}${f.short ? ` (-${f.short})` : ''}: ${f.summary}`)
    if (!c.available) lines.push('Not available yet.')
    add({ id: `command:${idPart(c.name)}`, kind: 'command', title: `orgai ${c.name}`, heading: c.name, lines })
  }

  for (const c of CONNECTORS) {
    add({
      id: `connector:${idPart(c.id)}`,
      kind: 'connector',
      title: c.name,
      heading: `${c.name} ${c.vendor} ${c.aliases?.join(' ') ?? ''}`,
      lines: [c.description, `Category: ${c.category}`, `Setup: ${connectorEase(c)}`, `Vendor: ${c.vendor}`]
    })
  }

  const docs = input.docs ?? bundledDocs()
  for (const [file, text] of Object.entries(docs)) for (const s of splitMarkdown(file, text)) add(s)
  return out
}

// ---------- index and scorer ----------

const W_TITLE = 10
const W_BODY = 1.5
const KIND_WEIGHT: Record<AppReferenceSectionKind, number> = {
  surface: 1.3, setting: 1.3, menu: 1.2, shortcut: 1.2, tool: 1, channel: 0.9, command: 1, connector: 1, doc: 1, status: 1
}

export interface ReferenceIndex {
  sections: RefSection[]
  byId: Map<string, number>
  postings: Map<string, [number, number][]>
  vocab: string[]
}

export function buildReferenceIndex(sections: RefSection[]): ReferenceIndex {
  const postings = new Map<string, [number, number][]>()
  const byId = new Map<string, number>()
  sections.forEach((s, i) => {
    byId.set(s.id, i)
    const best = new Map<string, number>()
    for (const t of tokenizeKnowledge(`${s.title} ${s.heading ?? ''} ${s.id}`)) best.set(t, W_TITLE)
    for (const t of tokenizeKnowledge(s.lines.join(' '))) if (!best.has(t)) best.set(t, W_BODY)
    for (const [t, w] of best) {
      if (KNOWLEDGE_STOPWORDS.has(t)) continue
      let p = postings.get(t)
      if (!p) postings.set(t, (p = []))
      p.push([i, w])
    }
  })
  return { sections, byId, postings, vocab: [...postings.keys()].sort() }
}

export function queryTerms(query: string): string[] {
  const seen = new Set<string>()
  for (const t of tokenizeKnowledge(query)) if (!KNOWLEDGE_STOPWORDS.has(t) && t.length > 0) seen.add(t)
  return [...seen].slice(0, MAX_TERMS)
}

/** Ranked section indexes with raw scores, best first. `only` limits the kinds. */
export function rankSections(index: ReferenceIndex, query: string, only?: ReadonlySet<AppReferenceSectionKind>): { i: number; score: number }[] {
  const terms = queryTerms(query)
  if (!terms.length) return []
  const score = new Map<number, number>()
  const hits = new Map<number, number>()
  for (const term of terms) {
    const perSection = new Map<number, number>()
    const take = (tok: string, factor: number): void => {
      for (const [i, w] of index.postings.get(tok) ?? []) {
        const v = w * factor
        if (v > (perSection.get(i) ?? 0)) perSection.set(i, v)
      }
    }
    take(term, 1)
    if (term.length >= MIN_PREFIX_CHARS) {
      let n = 0
      for (const v of index.vocab) {
        if (v > term && v.startsWith(term)) {
          take(v, 0.9)
          if (++n >= MAX_PREFIX_TOKENS) break
        }
      }
    }
    for (const [i, v] of perSection) {
      score.set(i, (score.get(i) ?? 0) + v)
      hits.set(i, (hits.get(i) ?? 0) + 1)
    }
  }
  const out: { i: number; score: number }[] = []
  for (const [i, s] of score) {
    const sec = index.sections[i]
    if (only && !only.has(sec.kind)) continue
    out.push({ i, score: s * KIND_WEIGHT[sec.kind] * (1 + (hits.get(i) ?? 0) / terms.length) })
  }
  out.sort((a, b) => b.score - a.score || index.sections[a.i].id.localeCompare(index.sections[b.i].id))
  return out
}

// ---------- rendering ----------

function clampBudget(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : APP_REFERENCE_BUDGET_DEFAULT
  return Math.min(APP_REFERENCE_BUDGET_MAX, Math.max(APP_REFERENCE_BUDGET_MIN, v))
}

function cutTo(s: string, max: number): string {
  if (s.length <= max) return s
  const c = s.slice(0, Math.max(0, max))
  const last = c.charCodeAt(c.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? c.slice(0, -1) : c
}

function sectionBlock(s: RefSection, maxChars: number, hint: boolean): string {
  const lines: string[] = [`title: ${fenceDatum(s.title, 120)}`]
  let used = 0
  for (const raw of s.lines) {
    const l = fenceDatum(raw, 400)
    if (!l) continue
    if (used + l.length > maxChars) {
      lines.push(`${l.slice(0, Math.max(0, maxChars - used))}…`)
      if (hint) lines.push(`(cut: read ${s.id} for all)`)
      break
    }
    lines.push(l)
    used += l.length
  }
  return fencedBlock(`[${s.id}] ${s.kind}`, lines)
}

function refusal(text: string): AppReferenceResult {
  return { text }
}

function checkText(field: string, v: unknown, max: number, required: boolean): string | null {
  if (v === undefined || v === null || v === '') return required ? `${field} is required for this action.` : null
  if (typeof v !== 'string') return `${field} must be text.`
  if (v.length > max) return `${field} is longer than ${max} characters; shorten it.`
  return hiddenCharProblem(field, v)
}

// ---------- the service ----------

export interface ReferenceStatusDeps {
  appVersion: string
  platform: string
  dataDir: string
  mock: boolean
  /** Terminal access means nothing on an in-process host (its only client is its own process): the status line leaves it out. */
  hostKind?: HostKind
  settings(): AppSettings
  connections(): ConnectionInfo[] | Promise<ConnectionInfo[]>
  projectCount(): number
  mcpLibraryCount(): number
  skillLibraryCount(): number
  cliShim?(): CliShimStatus | Promise<CliShimStatus>
}

/** The shared shortcut table (src/shared/view/shortcuts.ts, the source the renderer re-exports) as reference rows. */
export function shortcutRows(defs: readonly ShortcutDef[]): ShortcutRow[] {
  return defs.map((d) => ({
    key: d.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    label: d.note ? `${d.label} (${d.note})` : d.label,
    keys: d.combos.map((c) => c.map((k) => (k === 'Mod' ? 'Ctrl/Cmd' : k)).join('+')).join(' or ')
  }))
}

export interface AppReferenceDeps {
  status?: ReferenceStatusDeps
  /** Optional shortcut rows (wired by the host from shared/view/shortcuts.ts). */
  shortcuts?: readonly ShortcutRow[]
  /** Override the bundled docs (tests). */
  docs?: Record<string, string>
}

export interface AppReferenceService {
  query(q: AppReferenceQuery, opts: { status: boolean }): Promise<AppReferenceResult>
}

const SURFACE_KINDS: ReadonlySet<AppReferenceSectionKind> = new Set<AppReferenceSectionKind>(['surface', 'setting'])

export function createAppReference(deps: AppReferenceDeps = {}): AppReferenceService {
  let index: ReferenceIndex | undefined
  const idx = (): ReferenceIndex => (index ??= buildReferenceIndex(buildReferenceCorpus({ shortcuts: deps.shortcuts ?? shortcutRows(SHORTCUTS), docs: deps.docs })))

  function ranked(q: string, budget: number, only: ReadonlySet<AppReferenceSectionKind> | undefined, label: string): AppReferenceResult {
    const ix = idx()
    const list = rankSections(ix, q, only)
    if (!list.length) {
      return refusal(`No reference section matched ${fencedBlock('query:', [fenceDatum(q, 200)]).replace(/\n/g, ' ')}. Try other words, or use action 'locate' to find where a setting or screen lives.`)
    }
    const top = list[0].score
    const hits: AppReferenceHit[] = []
    const head = `${label} (${list.length} match${list.length === 1 ? '' : 'es'}); read one with action 'read' and its id:`
    const parts: string[] = [head]
    let len = head.length
    let shown = 0
    const footer = (from: number): string => {
      const rest = list.slice(from)
      if (!rest.length) return ''
      const names: string[] = []
      for (const r of rest.slice(0, 8)) names.push(ix.sections[r.i].id)
      return `\n${rest.length} more: ${names.join(', ')}${rest.length > 8 ? ', …' : ''}`
    }
    for (let n = 0; n < list.length; n++) {
      const s = ix.sections[list[n].i]
      const room = budget - len - footer(n + 1).length - 2
      if (room < 120 && n > 0) break
      const maxChars = Math.min(SEARCH_EXCERPT_CHARS, Math.max(60, room - 120))
      let block = sectionBlock(s, maxChars, true)
      if (len + block.length + 2 + footer(n + 1).length > budget) {
        if (n > 0) break
        block = cutTo(block, Math.max(0, budget - len - 2 - footer(n + 1).length))
      }
      parts.push(block)
      len += block.length + 2
      hits.push({ id: s.id, kind: s.kind, title: s.title, score: Math.max(0.0001, list[n].score / top) })
      shown = n + 1
    }
    let text = parts.join('\n\n') + footer(shown)
    if (text.length > budget) text = cutTo(text, budget)
    return { text, hits }
  }

  function locate(q: string, budget: number): AppReferenceResult {
    const ix = idx()
    const list = rankSections(ix, q, SURFACE_KINDS).slice(0, 12)
    if (!list.length) return refusal(`No screen or setting matched ${fenceDatum(q, 120) ? 'that' : 'it'}. Try other words, or use action 'search' to look through the whole reference.`)
    const top = list[0].score
    const lines: string[] = []
    const hits: AppReferenceHit[] = []
    for (const r of list) {
      const s = ix.sections[r.i]
      hits.push({ id: s.id, kind: s.kind, title: s.title, score: Math.max(0.0001, r.score / top) })
      if (s.kind === 'surface') {
        const id = s.id.slice('surface:'.length)
        const surf = ATLAS_SURFACES.find((x) => x.id === id)
        const where = surf ? surf.path.join(' › ') : s.title
        const how = surf ? surf.reach.map(reachText).join('; ') : ''
        const fields = surf?.settings?.length ? ` — fields: ${surf.settings.join(', ')}` : ''
        lines.push(`[${s.id}] ${where} (${how})${fields}`)
      } else {
        lines.push(`[${s.id}] ${s.title}: ${s.lines.join(' | ')}`)
      }
    }
    const rendered = lines.map((l) => {
      const m = /^\[([^\]]+)\] (.*)$/s.exec(l)
      return m ? `${m[1]} ${fenceDatum(m[2], 500)}` : fenceDatum(l, 500)
    })
    const head = 'Places that match, best first (values below are reference data):'
    const kept: string[] = []
    let len = head.length + 12
    for (const l of rendered) {
      if (len + l.length + 1 > budget) break
      kept.push(l)
      len += l.length + 1
    }
    if (!kept.length) kept.push(cutTo(rendered[0], Math.max(0, budget - len - 1)))
    const dropped = rendered.length - kept.length
    const body = fencedBlock(head, kept)
    let text = body
    if (dropped > 0) text += `\n${dropped} more: ${hits.slice(kept.length, kept.length + 8).map((h) => h.id).join(', ')}`
    if (text.length > budget) text = cutTo(text, budget)
    return { text, hits: hits.slice(0, Math.max(1, kept.length)) }
  }

  function read(id: string): AppReferenceResult {
    const ix = idx()
    const i = ix.byId.get(id)
    if (i === undefined) return refusal(`There is no reference section with that id. Find ids with action 'search' or 'locate'; each hit starts with its id in square brackets.`)
    const s = ix.sections[i]
    const lines = s.lines.map((l) => fenceDatum(l, 1200)).filter(Boolean)
    let text = fencedBlock(`[${s.id}] ${s.kind}`, [`title: ${fenceDatum(s.title, 120)}`, ...lines])
    if (text.length > APP_REFERENCE_READ_MAX_CHARS) {
      const note = `\n(cut at ${APP_REFERENCE_READ_MAX_CHARS} characters)`
      text = cutTo(text, APP_REFERENCE_READ_MAX_CHARS - note.length) + note
    }
    return { text, hits: [{ id: s.id, kind: s.kind, title: s.title, score: 1 }] }
  }

  async function status(): Promise<AppReferenceResult> {
    const d = deps.status
    if (!d) return refusal('Status is not available in this run.')
    const lines: string[] = [`version: ${fenceDatum(d.appVersion, 40)}`, `platform: ${fenceDatum(d.platform, 20)}`, `data folder: ${fenceDatum(d.dataDir, 300)}`, `mock adapter: ${d.mock ? 'on' : 'off'}`]
    let settings: AppSettings | undefined
    try {
      settings = d.settings()
    } catch {
      /* reported below */
    }
    try {
      for (const c of await d.connections()) {
        const name = (c.connection as { name?: string }).name ?? c.connection.id
        lines.push(`connection ${fenceDatum(c.connection.id, 60)} (${fenceDatum(name, 60)}): ${c.status.state}${c.isDefault ? ', default' : ''}`)
      }
    } catch {
      lines.push('connections: could not be read')
    }
    if (settings) {
      lines.push(`proxies: ${Array.isArray(settings.proxies) ? settings.proxies.length : 0}`)
      if (d.hostKind !== 'inproc') lines.push(`terminal access: ${settings.terminalServer === true ? 'on' : 'off'}, level ${fenceDatum(String(settings.terminalAccessLevel ?? 'operate'), 20)}`)
    }
    try {
      lines.push(`projects: ${d.projectCount()}`, `library MCP servers: ${d.mcpLibraryCount()}`, `skill library entries: ${d.skillLibraryCount()}`)
    } catch {
      lines.push('counts: could not be read')
    }
    if (d.cliShim) {
      try {
        lines.push(`command line shim: ${(await d.cliShim()).state}`)
      } catch {
        /* optional */
      }
    }
    return { text: fencedBlock('OrgAI status (a snapshot with no keys, tokens or addresses):', lines) }
  }

  return {
    async query(q, opts) {
      try {
        const action = (q as { action?: unknown }).action
        if (action === 'status') return opts.status ? await status() : refusal('Status is not available in this run.')
        if (action === 'read') {
          const p = checkText('id', q.id, APP_REFERENCE_ID_MAX_CHARS, true)
          return p ? refusal(p) : read(q.id as string)
        }
        if (action === 'search' || action === 'locate') {
          const p = checkText('query', q.query, APP_REFERENCE_QUERY_MAX_CHARS, true)
          if (p) return refusal(p)
          const budget = clampBudget(q.budget)
          return action === 'search' ? ranked(q.query as string, budget, undefined, 'Matches') : locate(q.query as string, budget)
        }
        return refusal("Unknown action. Use 'search', 'read', 'locate' or 'status'.")
      } catch (e) {
        return refusal(`The reference could not answer: ${fenceDatum((e as Error).message, 160)}`)
      }
    }
  }
}
