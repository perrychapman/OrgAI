/**
 * Text renderers shared by the read commands (runs list / show, status). Everything here builds on the
 * shared view models (src/shared/view): status words come only from statusText, names from runName, costs from
 * costView, decision rows from waitingItems. Untrusted strings pass through safe / safeLine before any styling.
 */
import { RUN_KIND_LABELS, type AgentInstance, type ImageAttachment, type PendingCards, type ProjectKind, type RunPlan, type RunRecord, type RunSummary, type TranscriptEntry } from '../shared/types'
import { costView, formatTokens, runCostInput, agentCostInput } from '../shared/view/cost'
import { formatDateTime } from '../shared/view/dates'
import { AGENT_LABEL_MAX, agentLabel as sharedAgentLabel } from '../shared/view/agentTree'
import { waitingItems, type WaitingItem } from '../shared/view/needsYou'
import { runName } from '../shared/view/runLabels'
import { runStatus, settleEndedAgents, statusOfRun, statusText, type RunStatusView } from '../shared/view/runStatus'
import { bareToolName, humanizeToolResult, humanizeToolUse } from '../shared/view/transcriptRows'
import { safe, safeLine, styleStatus, type Style } from './output'

// ---------- Run facts ----------

/** "Chat" for a quick run, "Ask" for a single-agent run, else RUN_KIND_LABELS ("Run", "Setup", ...). */
export function kindLabel(s: Pick<RunSummary, 'kind' | 'quick' | 'team'>): string {
  if (s.quick) return 'Chat'
  if (s.team === 'single') return 'Ask'
  return RUN_KIND_LABELS[s.kind] ?? String(s.kind)
}

/** The run's status view (statusOfRun): `waiting` when it has open decisions. */
export function statusViewOf(
  run: { summary: RunSummary; plan?: RunPlan; agents?: Record<string, AgentInstance> },
  waiting = false,
  project?: { autoContinue?: boolean; maxAutoContinues?: number }
): RunStatusView {
  return statusOfRun({ summary: run.summary, plan: run.plan, agents: run.agents }, project, waiting)
}

/** The one status word or phrase a run shows (statusText). */
export function statusWordOf(
  run: { summary: RunSummary; plan?: RunPlan; agents?: Record<string, AgentInstance> },
  waiting = false,
  project?: { autoContinue?: boolean; maxAutoContinues?: number }
): string {
  return statusText(statusViewOf(run, waiting, project))
}

/** The status words a --status filter may name (lowercase): every StatusWord plus "ended when orgai closed". */
export const STATUS_FILTER_WORDS: readonly string[] = ['running', 'needs you', 'idle', 'paused', 'finished', 'stopped', 'ended when orgai closed', 'failed']

/** True when the run's view matches a --status word (case-insensitive; 'stopped' also matches ended-with-app runs). */
export function matchesStatus(view: RunStatusView, word: string): boolean {
  const w = word.trim().toLowerCase()
  return statusText(view).toLowerCase() === w || view.word.toLowerCase() === w
}

/** The run's cost text (costView: unknown is "unknown", never $0; nothing spent is "—"). */
export const costText = (s: Pick<RunSummary, 'totalCostUsd' | 'usage'>): string => costView(runCostInput(s)).text

/** Status text for a summary alone (run.status updates in watch). */
export function statusWordOfSummary(s: RunSummary): string {
  return statusText(runStatus(s.status, { endedBy: s.endedBy === 'user' || s.endedBy === 'app' ? s.endedBy : undefined, endedWithApp: s.endedWithApp }))
}

// ---------- Agents ----------

/**
 * How the app names an agent. The rule (handle when clean, else the role name, cut at AGENT_LABEL_MAX) is the shared
 * view-model's `agentLabel`; this wrapper only makes it terminal-safe (sanitized, one line) and names a missing agent.
 */
export function agentLabel(a: Pick<AgentInstance, 'name' | 'handle'> | undefined): string {
  if (!a) return 'An agent'
  const text = safeLine(sharedAgentLabel(a)) || 'An agent'
  const cs = [...text]
  return cs.length > AGENT_LABEL_MAX ? `${cs.slice(0, AGENT_LABEL_MAX - 1).join('')}…` : text
}

/** "worker-1 (Implementer)" when the handle differs from the role name, else the name alone. */
export function agentLabelWithRole(a: Pick<AgentInstance, 'name' | 'handle'>): string {
  const label = agentLabel(a)
  const role = safeLine(a.name)
  return role && role !== label ? `${label} (${role})` : label
}

/** The agent tree as indented lines (root first, then reports by start order). */
export function agentTreeLines(summary: RunSummary, agents: Record<string, AgentInstance>, st: Style): string[] {
  const settled = settleEndedAgents(summary, agents)
  const list = Object.values(settled)
  const children = new Map<string | null, AgentInstance[]>()
  const ids = new Set(list.map((a) => a.id))
  for (const a of list) {
    const parent = a.parentId !== null && ids.has(a.parentId) ? a.parentId : null
    const key = a.parentId === null ? null : parent
    const arr = children.get(key) ?? []
    arr.push(a)
    children.set(key, arr)
  }
  for (const arr of children.values()) arr.sort((x, y) => x.startedAt - y.startedAt || x.id.localeCompare(y.id))
  const out: string[] = []
  const seen = new Set<string>()
  const walk = (a: AgentInstance, depth: number): void => {
    if (seen.has(a.id) || depth > 50) return
    seen.add(a.id)
    const cost = costView(agentCostInput(a))
    const facts = [safeLine(a.activity), cost.empty ? '' : cost.text].filter(Boolean).join(' · ')
    out.push(`${'  '.repeat(depth + 1)}${depth > 0 ? '└ ' : ''}${st.bold(agentLabelWithRole(a))}${facts ? st.dim(` · ${facts}`) : ''}`)
    for (const c of children.get(a.id) ?? []) walk(c, depth + 1)
  }
  for (const root of children.get(null) ?? []) walk(root, 0)
  // Anything left (a parent cycle): list flat.
  for (const a of list) if (!seen.has(a.id)) walk(a, 0)
  return out
}

// ---------- Plan ----------

const STEP_MARK: Record<string, string> = { done: '[x]', in_progress: '[>]', blocked: '[!]', skipped: '[-]', pending: '[ ]' }

export function planLines(plan: RunPlan, st: Style): string[] {
  const done = plan.steps.filter((s) => s.status === 'done').length
  const head = `${st.bold('Plan:')} ${safeLine(plan.goal)} ${st.dim(`(${plan.status}, ${done} of ${plan.steps.length} done)`)}`
  const lines = [head]
  for (const s of plan.steps) {
    const owner = s.owner ? st.dim(` · ${safeLine(s.owner)}`) : ''
    const noteText = s.note ? st.dim(` · ${safeLine(s.note)}`) : ''
    lines.push(`  ${STEP_MARK[s.status] ?? '[ ]'} ${safeLine(s.title)}${owner}${noteText}`)
  }
  if (plan.status === 'blocked' && plan.blockedReason) lines.push(`  ${st.yellow('Blocked:')} ${safeLine(plan.blockedReason)}`)
  if (plan.summary) lines.push(`  ${st.dim('Summary:')} ${safeLine(plan.summary)}`)
  return lines
}

/** One line for a plan.updated event in watch. */
export function planUpdateLine(plan: RunPlan): string {
  const done = plan.steps.filter((s) => s.status === 'done').length
  const current = plan.steps.find((s) => s.status === 'in_progress')
  const word = plan.status === 'done' ? 'complete' : plan.status === 'blocked' ? 'blocked' : `${done} of ${plan.steps.length} steps done`
  return `Plan ${word}${current && plan.status === 'active' ? `; now: ${safeLine(current.title)}` : ''}`
}

// ---------- Images ----------

/** Bytes behind a base64 string. */
export function base64Bytes(data: string): number {
  if (!data) return 0
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((data.length * 3) / 4) - pad)
}

type ImageLike = Pick<ImageAttachment, 'mediaType'> & { data?: string; byteLength?: number; omittedBase64?: true }

/** "[image image/png 1234 bytes]": images are listed, never printed. */
export function imageLabel(img: ImageLike): string {
  const n = typeof img.byteLength === 'number' ? img.byteLength : img.data ? base64Bytes(img.data) : undefined
  return n === undefined ? `[image ${safeLine(img.mediaType)}]` : `[image ${safeLine(img.mediaType)} ${n} bytes]`
}

/** A record for JSON output: every image's base64 replaced by `{ mediaType, byteLength, omittedBase64: true }`. */
export function recordWithoutImages(rec: RunRecord): RunRecord {
  let changed = false
  const transcript = rec.transcript.map((e) => {
    if (e.block.kind !== 'user' || !e.block.images?.length) return e
    changed = true
    const images = e.block.images.map((img) => {
      const i = img as ImageLike
      return { mediaType: img.mediaType, byteLength: typeof i.byteLength === 'number' ? i.byteLength : base64Bytes(img.data ?? ''), omittedBase64: true as const }
    })
    return { ...e, block: { ...e.block, images: images as unknown as ImageAttachment[] } }
  })
  return changed ? { ...rec, transcript } : rec
}

// ---------- Transcript ----------

export interface TranscriptLineOpts {
  st: Style
  /** Agent name lookup. */
  agentName(agentId: string): string
  /** Tool name of a tool_use id, for result summaries. */
  toolName?(toolUseId: string): string | undefined
  /** Prefix (e.g. the run tag in watch). */
  prefix?: string
  /** Show tool results (one line each). Default false. */
  results?: boolean
  /** Show thinking blocks. Default false. */
  thinking?: boolean
}

const TEXT_MAX = 2000

/** Indent continuation lines so multi-line text stays under its speaker. */
function indentBody(text: string, indent: string): string {
  const cut = [...text].length > TEXT_MAX ? `${[...text].slice(0, TEXT_MAX - 1).join('')}…` : text
  return cut
    .split('\n')
    .map((l, i) => (i === 0 ? l : indent + l))
    .join('\n')
}

/**
 * One transcript entry as text, or null when it shows nothing (thinking, empty results, results when off). Text is
 * the agent's words, a tool call is one summarized line, a harness row is quiet (dim), and a user message lists its
 * images as "[image <mediaType> <n> bytes]".
 */
export function transcriptLine(e: TranscriptEntry, o: TranscriptLineOpts): string | null {
  const { st } = o
  const pre = o.prefix ? `${o.prefix} ` : ''
  const who = o.agentName(e.agentId)
  const b = e.block
  switch (b.kind) {
    case 'text': {
      const text = safe(b.text).trim()
      if (!text) return null
      if (e.source === 'harness') return st.dim(`${pre}· ${safeLine(b.text)}`)
      return `${pre}${st.bold(`${who}:`)} ${indentBody(text, '  ')}`
    }
    case 'thinking':
      return o.thinking && b.text.trim() ? st.dim(`${pre}${who} (thinking): ${safeLine(b.text)}`) : null
    case 'tool_use': {
      const row = humanizeToolUse(b.name, b.input)
      return `${pre}${st.dim(`${who} →`)} ${safeLine(row.label)}`
    }
    case 'tool_result': {
      if (!o.results && !b.isError) return null
      const row = humanizeToolResult(o.toolName?.(b.toolUseId), b.content, b.isError)
      if (!row) return null
      const line = `${pre}${who} ← ${safeLine(row.label)}`
      return b.isError || row.failed ? st.red(line) : st.dim(line)
    }
    case 'user': {
      const text = safe(b.text).trim()
      const imgs = (b.images ?? []).map((i) => imageLabel(i as ImageLike))
      const body = [text ? indentBody(text, '  ') : '', ...imgs].filter(Boolean).join(' ')
      if (e.source === 'harness') return st.dim(`${pre}· ${safeLine(b.text)}${imgs.length ? ` ${imgs.join(' ')}` : ''}`)
      return `${pre}${st.bold('You:')} ${body || st.dim('(empty message)')}`
    }
    case 'system':
      return b.text.trim() ? st.dim(`${pre}· ${safeLine(b.text)}`) : null
  }
}

/** Tool names by tool_use id, for result summaries. */
export function toolNamesOf(transcript: readonly TranscriptEntry[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const e of transcript) if (e.block.kind === 'tool_use') m.set(e.block.id, bareToolName(e.block.name))
  return m
}

/** Rendered lines of a transcript (null rows dropped). */
export function transcriptLines(transcript: readonly TranscriptEntry[], agents: Record<string, AgentInstance>, st: Style, extra: Partial<TranscriptLineOpts> = {}): string[] {
  const tools = toolNamesOf(transcript)
  const out: string[] = []
  for (const e of transcript) {
    const line = transcriptLine(e, { st, agentName: (id) => agentLabel(agents[id]), toolName: (id) => tools.get(id), ...extra })
    if (line !== null) out.push(line)
  }
  return out
}

/** The last `n` showable rows of a transcript. */
export function tailRows(transcript: readonly TranscriptEntry[], agents: Record<string, AgentInstance>, st: Style, n: number, extra: Partial<TranscriptLineOpts> = {}): { lines: string[]; total: number } {
  const all = transcriptLines(transcript, agents, st, extra)
  return { lines: n > 0 ? all.slice(-n) : all, total: all.length }
}

// ---------- Decisions ----------

/** waitingItems for a live run's pending cards (agents named from `agents` when known). */
export function pendingItems(
  summary: RunSummary,
  cards: Partial<PendingCards> | undefined,
  agents: Record<string, Pick<AgentInstance, 'name'>> = {},
  projectKind?: ProjectKind
): WaitingItem[] {
  const c = cards ?? {}
  return waitingItems(
    {
      summary,
      agents: agents as Record<string, { name: string }>,
      permissions: c.permissions,
      proposals: c.proposals,
      questions: c.questions,
      ruleRequests: c.ruleRequests,
      mergeReviews: c.mergeReviews,
      mcpInstalls: c.mcpInstalls
    },
    projectKind
  )
}

/** When a card was created (epoch ms), when its type carries it. */
export function cardCreatedAt(cards: Partial<PendingCards> | undefined, id: string): number | undefined {
  const c = cards ?? {}
  for (const list of [c.questions, c.proposals, c.ruleRequests, c.mergeReviews, c.mcpInstalls] as ({ id: string; createdAt?: number }[] | undefined)[]) {
    const hit = list?.find((x) => x.id === id)
    if (hit && typeof hit.createdAt === 'number') return hit.createdAt
  }
  return undefined
}

/** The total open decisions over these runs' cards. */
export function decisionTotal(rows: readonly { summary: RunSummary; cards?: Partial<PendingCards> }[]): number {
  return rows.reduce((n, r) => n + pendingItems(r.summary, r.cards).length, 0)
}

// ---------- Summary block ----------

export interface SummaryBlockOpts {
  st: Style
  tag: string
  projectName?: string
  projectPath?: string
  chain?: { index: number; count: number; previousTag?: string }
  waiting?: boolean
  record?: RunRecord
}

/** The runs show header: tag, status, name, then facts. */
export function summaryLines(s: RunSummary, o: SummaryBlockOpts): string[] {
  const { st } = o
  const view = statusViewOf({ summary: s, plan: o.record?.plan, agents: o.record?.agents }, o.waiting ?? false)
  const word = statusText(view)
  const lines = [`${st.bold(o.tag)}  ${styleStatus(st, word)}  ${st.bold(safeLine(runName(s)))}`]
  lines.push(`  ${st.dim('Id:')} ${safeLine(s.id)}`)
  if (o.projectName) lines.push(`  ${st.dim('Project:')} ${safeLine(o.projectName)}${o.projectPath ? st.dim(` (${safeLine(o.projectPath)})`) : ''}`)
  const when = [`Started ${formatDateTime(s.startedAt)}`, s.endedAt ? `ended ${formatDateTime(s.endedAt)}` : ''].filter(Boolean).join(', ')
  lines.push(`  ${st.dim('Kind:')} ${kindLabel(s)} · ${when}`)
  if (o.chain && o.chain.count > 1) {
    lines.push(`  ${st.dim('Chain:')} session ${o.chain.index} of ${o.chain.count}${o.chain.previousTag ? ` (continues ${o.chain.previousTag})` : ''}`)
  }
  if (view.note && view.note !== word) lines.push(`  ${st.dim('Note:')} ${view.note}`)
  if (s.status === 'paused') {
    if (s.pauseReason) lines.push(`  ${st.dim('Paused:')} ${safeLine(s.pauseReason)}`)
    if (s.pausedUntil) lines.push(`  ${st.dim(s.autoResume ? 'Resumes:' : 'Can resume:')} ${formatDateTime(s.pausedUntil)}`)
  }
  if (s.error) lines.push(`  ${st.red('Error:')} ${safeLine(s.error)}`)
  const cost = costView(runCostInput(s))
  const tokens = Object.values(o.record?.agents ?? {}).reduce((acc, a) => ({ i: acc.i + (a.inputTokens || 0), o: acc.o + (a.outputTokens || 0) }), { i: 0, o: 0 })
  const tokenText = tokens.i || tokens.o ? ` · ${formatTokens(tokens.i)} in, ${formatTokens(tokens.o)} out` : ''
  lines.push(`  ${st.dim('Cost:')} ${cost.text}${tokenText}`)
  const prompt = safeLine(s.prompt)
  if (prompt && prompt !== safeLine(runName(s))) lines.push(`  ${st.dim('Prompt:')} ${prompt.length > 300 ? `${prompt.slice(0, 299)}…` : prompt}`)
  return lines
}
