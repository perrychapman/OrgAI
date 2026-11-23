import type { AgentInstance, EngagementDocumentInfo, McpServerSpec, Project, RunOutput, RunPlan, RunSummary } from '@shared/types'
import { formatDate } from '@shared/view/dates'
import { costView, runCostInput, sumCosts } from '@shared/view/cost'
import { relativeTime } from '@shared/view/runChains'
import { runName } from '@shared/view/runLabels'
import { itemCreatedAt, itemKind, itemName, itemRetired, kindCounts, kindLabel, type KnowledgeItem } from '@shared/view/knowledge'
import { plural } from './projectHome'
import { planProgress, planProgressText } from './dashboardBand'

/**
 * Pure derivations for the engagement Home (docs/design/ui-overhaul/project/EngagementHome.dc.html). The board's
 * wording stays neutral on purpose (no stages, client, sponsor or deliverable vocabulary, no role-specific layout):
 * every line here is built from what the engagement really holds, and an empty source gives an empty result so the
 * view leaves the section out.
 */

// ---------- Purpose ----------

/** The most characters of the engagement document the purpose block shows; the rest is "Read the full description". */
export const PURPOSE_MAX_CHARS = 420

export interface Purpose {
  /** Plain paragraph text (markdown marks removed), cut at a word. */
  text: string
  /** The document is longer than `text`. */
  cut: boolean
}

/**
 * The description to show: the first paragraph(s) of the engagement document with headings, list marks, emphasis and
 * links reduced to plain text. null when the document is empty (the block then says how to add one).
 */
export function purposeOf(doc: Pick<EngagementDocumentInfo, 'text'> | null | undefined, max = PURPOSE_MAX_CHARS): Purpose | null {
  const raw = doc?.text ?? ''
  const paragraphs = raw
    .split(/\r?\n\s*\r?\n/)
    .map((p) => plainText(p))
    .filter((p) => p.length > 0)
  if (paragraphs.length === 0) return null
  // The first paragraph is often the title line; skip a heading-only first block when a real paragraph follows.
  const firstBlockIsHeading = /^\s*#{1,6}\s/.test(raw.trimStart()) && !/\n/.test(raw.trimStart().split(/\r?\n\s*\r?\n/)[0] ?? '')
  const body = firstBlockIsHeading && paragraphs.length > 1 ? paragraphs.slice(1) : paragraphs
  const joined = body.join(' ')
  if (joined.length <= max) return { text: joined, cut: false }
  const head = joined.slice(0, max)
  const at = head.lastIndexOf(' ')
  return { text: `${(at > max * 0.6 ? head.slice(0, at) : head).trimEnd()}…`, cut: true }
}

function plainText(block: string): string {
  return block
    .split(/\r?\n/)
    .map((l) =>
      l
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
        .replace(/^\s*>\s?/, '')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_`~]+/g, '')
        .trim()
    )
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------- Facts ----------

export interface Fact {
  label: string
  value: string
}

export interface FactsIn {
  project: Pick<Project, 'client' | 'createdAt'>
  runs: readonly Pick<RunSummary, 'startedAt' | 'endedAt' | 'kind' | 'totalCostUsd' | 'usage'>[]
  outputs: readonly Pick<RunOutput, 'createdAt' | 'updatedAt'>[]
  now: number
}

/** The facts list: only lines with real data. "For" the client, "Started", "Runs", "Files", "Last activity". */
export function engagementFacts(input: FactsIn): Fact[] {
  const facts: Fact[] = []
  const client = input.project.client?.trim()
  if (client) facts.push({ label: 'For', value: client })
  const created = Date.parse(input.project.createdAt)
  if (Number.isFinite(created)) facts.push({ label: 'Started', value: formatDate(created) })
  const work = input.runs.filter((r) => r.kind === 'work')
  if (work.length > 0) facts.push({ label: 'Runs', value: String(work.length) })
  if (input.outputs.length > 0) facts.push({ label: 'Files', value: String(input.outputs.length) })
  const times = [...input.runs.map((r) => r.endedAt ?? r.startedAt), ...input.outputs.map((o) => o.updatedAt ?? o.createdAt)].filter((t) => Number.isFinite(t) && t > 0)
  if (times.length > 0) facts.push({ label: 'Last activity', value: relativeTime(Math.max(...times), input.now) })
  const spent = costView(sumCosts(input.runs.map((r) => runCostInput(r))), { compact: true })
  if (!spent.empty) facts.push({ label: 'Spent', value: `${spent.text} so far` })
  return facts
}

// ---------- Recent work ----------

export interface RecentRunIn {
  summary: Pick<RunSummary, 'id' | 'status' | 'kind' | 'team' | 'title' | 'prompt' | 'startedAt' | 'endedAt' | 'totalCostUsd' | 'usage' | 'endedBy' | 'endedWithApp'>
  agents?: Record<string, Pick<AgentInstance, 'parentId' | 'id'>>
  plan?: Pick<RunPlan, 'status' | 'steps' | 'summary'>
  decisions: number
}

export type RecentTone = 'working' | 'waiting' | 'ok' | 'bad' | 'muted'

export interface RecentRun {
  id: string
  title: string
  result: string
  who: string
  when: string
  tone: RecentTone
}

/** Work and ask runs only (setup and assistant sessions are not "work"), newest first, at most `max`. */
export function recentRuns(runs: readonly RecentRunIn[], now: number, max = 4): RecentRun[] {
  return runs
    .filter((r) => r.summary.kind === 'work')
    .sort((a, b) => b.summary.startedAt - a.summary.startedAt)
    .slice(0, max)
    .map((r) => {
      const s = r.summary
      const plan = planProgress(r.plan)
      const open = s.status === 'starting' || s.status === 'running' || s.status === 'stopping'
      const idle = s.status === 'idle'
      const tone: RecentTone = r.decisions > 0 ? 'waiting' : open ? 'working' : s.status === 'error' ? 'bad' : s.status === 'paused' || idle ? 'muted' : s.endedBy === 'user' || s.endedWithApp ? 'muted' : 'ok'
      const word =
        r.decisions > 0
          ? `Waiting on you (${r.decisions})`
          : open
            ? 'Running'
            : idle
              ? 'Open, waiting for your next message'
              : s.status === 'error'
                ? 'Failed'
                : s.status === 'paused'
                  ? 'Paused'
                  : s.endedBy === 'user'
                    ? 'Stopped'
                    : s.team === 'single'
                      ? 'Answered'
                      : 'Finished'
      const bits = [word]
      if (plan && open) bits[0] = `${word} · ${plan.current ? `step ${plan.current.index} of ${plan.total}` : planProgressText(plan)}`
      const cost = costView(runCostInput(s), { compact: true })
      if (!open && !cost.empty && cost.kind !== 'unknown') bits.push(cost.text)
      const agentCount = r.agents ? Object.values(r.agents).filter((a) => a.parentId !== null && a.id !== 'root').length + 1 : 0
      return {
        id: s.id,
        title: runName(s),
        result: bits.join(' · '),
        who: s.team === 'single' ? 'Ask' : agentCount > 1 ? plural(agentCount, 'agent') : '',
        when: open ? 'now' : relativeTime(s.endedAt ?? s.startedAt, now),
        tone
      }
    })
}

// ---------- Files ----------

export interface LatestFile {
  id: string
  name: string
  kind: string
  note: string
}

/** The kind chip's word for an output kind ("Document", "Sheet", "Slides"; anything else is shown as it is, capitalised). */
const OUTPUT_KIND_WORD: Readonly<Record<string, string>> = { docx: 'Document', md: 'Document', txt: 'Text', xlsx: 'Sheet', csv: 'Sheet', pptx: 'Slides', pdf: 'PDF', png: 'Image', svg: 'Image', html: 'Page', json: 'Data' }

export function outputKindWord(kind: string): string {
  return OUTPUT_KIND_WORD[kind] ?? (kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : 'File')
}

/** The most recently changed files (not missing ones), newest first. */
export function latestFiles(outputs: readonly RunOutput[], now: number, max = 4): LatestFile[] {
  return outputs
    .filter((o) => !o.missing)
    .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
    .slice(0, max)
    .map((o) => ({
      id: o.id,
      name: o.title || o.fileName,
      kind: outputKindWord(o.kind),
      note: `${o.version && o.version > 0 ? `Version ${o.version} · ` : ''}${relativeTime(o.updatedAt ?? o.createdAt, now)}`
    }))
}

// ---------- Knowledge ----------

export interface KnowledgeHome {
  count: number
  addedThisWeek: number
  kinds: { kind: string; label: string; count: number }[]
  latest: { id: string; name: string; kindLabel: string; when: string }[]
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** Items and notes of the engagement as a summary; null when there is nothing (the section then offers to add something). */
export function knowledgeHome(items: readonly KnowledgeItem[], now: number): KnowledgeHome | null {
  const live = items.filter((i) => !itemRetired(i))
  if (live.length === 0) return null
  const latest = [...live].sort((a, b) => itemCreatedAt(b) - itemCreatedAt(a)).slice(0, 3)
  return {
    count: live.length,
    addedThisWeek: live.filter((i) => now - itemCreatedAt(i) < WEEK_MS && itemCreatedAt(i) <= now).length,
    kinds: kindCounts(live, false),
    latest: latest.map((i) => ({ id: i.id, name: itemName(i), kindLabel: kindLabel(itemKind(i)), when: relativeTime(itemCreatedAt(i), now) }))
  }
}

// ---------- Connections and folders ----------

export type ConnectionTone = 'ok' | 'warn' | 'muted'

export interface ConnectionRow {
  id: string
  name: string
  initial: string
  /** What is known without starting the server: sign-in state, a missing secret, off, or on. */
  status: string
  tone: ConnectionTone
}

type ServerIn = {
  spec: Pick<McpServerSpec, 'id' | 'name' | 'enabled'>
  missingSecrets?: readonly string[]
  auth?: { state: string }
  libraryMissing?: true
}

/** The status words for one server. Never claims "Connected": the server is only started inside a run or by Test. */
export function connectionStatus(s: ServerIn): { status: string; tone: ConnectionTone } {
  if (!s.spec.enabled) return { status: 'Off', tone: 'muted' }
  if (s.libraryMissing) return { status: 'Removed from the library', tone: 'warn' }
  if ((s.missingSecrets?.length ?? 0) > 0) return { status: 'Needs a key or token', tone: 'warn' }
  const auth = s.auth?.state
  if (auth === 'notAuthorized' || auth === 'expired') return { status: 'Needs you to sign in', tone: 'warn' }
  if (auth === 'error') return { status: 'Sign-in failed', tone: 'warn' }
  return { status: auth === 'authorized' ? 'Signed in' : 'Ready', tone: 'ok' }
}

/** The project's tools and services (`mcp.list`), enabled and needing attention first. */
export function connectionRows(servers: readonly ServerIn[] | undefined): ConnectionRow[] {
  const rank = (t: ConnectionTone): number => (t === 'warn' ? 0 : t === 'ok' ? 1 : 2)
  return (servers ?? [])
    .map((s) => ({ id: s.spec.id, name: s.spec.name, initial: (s.spec.name.trim().charAt(0) || '?').toUpperCase(), ...connectionStatus(s) }))
    .sort((a, b) => rank(a.tone) - rank(b.tone) || a.name.localeCompare(b.name))
}

export interface FolderRow {
  path: string
  name: string
  mode: 'Read only' | 'Team writes here'
  writes: boolean
}

/** The last path segment ("C:\\Docs\\Source documents" -> "Source documents"); the whole path when it has none. */
export function folderName(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

/** The working folder (the team writes there), the extra folders it may edit, then the reference folders (read only). */
export function folderRows(project: Pick<Project, 'path' | 'allowedDirectories' | 'referenceDirectories'>): FolderRow[] {
  const rows: FolderRow[] = []
  const add = (path: string, writes: boolean): void => {
    if (!path || rows.some((r) => r.path === path)) return
    rows.push({ path, name: folderName(path), mode: writes ? 'Team writes here' : 'Read only', writes })
  }
  add(project.path, true)
  for (const p of project.allowedDirectories ?? []) add(p, true)
  for (const p of project.referenceDirectories ?? []) add(p, false)
  return rows
}
