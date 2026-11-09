import { basename } from 'node:path'
import type { TranscriptContentPart, TranscriptMedia } from '@shared/types'
import { normalizeTranscriptContent, normalizeTranscriptMedia } from './transcriptMedia'
import { describeTool } from './activity'
import {
  harnessToolName,
  isRec,
  num,
  parseNotification,
  str,
  type CodexItem,
  type CodexNotification,
  type CodexTurnError
} from './codexProtocol'

/**
 * Pure mapping of Codex app-server notifications to harness updates. The session (codex.ts) applies the
 * updates to AgentInstances and RunEvents; nothing here emits or touches the process, so the mapping is
 * unit-tested from fixture JSONL (fixtures/codex-*.jsonl, one `{ "method", "params" }` per line).
 *
 * Codex item -> harness tool name (so activity.ts phrases and the renderer's tool rendering fit):
 *   commandExecution -> Bash {command, cwd}        fileChange -> Edit (Write when every change is an add)
 *   mcpToolCall      -> mcp__<server>__<tool>      webSearch  -> WebSearch {query}
 *   dynamicToolCall  -> harness tools as mcp__orgai__<name>; spawn_report -> Agent, message_agent -> SendMessage,
 *                       list_team -> ListAgents (the pre-rename names map the same way) (inputs renamed to the Claude shapes)
 * Ignored: plan, contextCompaction, hookPrompt and the rest. Codex's own multi-agent items
 * (collabAgentToolCall, subAgentActivity) are logged: those agents are not governed by the org chart.
 */

export const ORGAI_TOOL_PREFIX = 'mcp__orgai__'
/** Tool names (as the model calls them) the harness network adds besides the harness tools. */
export const NETWORK_TOOLS = { spawn: 'spawn_report', message: 'message_agent', list: 'list_team' } as const

/** Names before the rename (they collided with Codex's built-in multi-agent tools). Threads saved earlier still use them. */
const LEGACY_NETWORK_TOOLS: Record<string, string> = { spawn_agent: NETWORK_TOOLS.spawn, send_message: NETWORK_TOOLS.message, list_agents: NETWORK_TOOLS.list }

/** The canonical network tool name for a new or pre-rename name, or null when it is not a network tool. */
export function canonicalNetworkTool(name: string): string | null {
  if (name === NETWORK_TOOLS.spawn || name === NETWORK_TOOLS.message || name === NETWORK_TOOLS.list) return name
  return LEGACY_NETWORK_TOOLS[name] ?? null
}

export const NATIVE_AGENTS_UNAVAILABLE = "Codex's built-in multi-agent tools are not available in OrgAI."

export type TurnStatus = 'completed' | 'interrupted' | 'failed'

export type CodexUpdate =
  | { type: 'text'; threadId: string; itemId: string; text: string }
  /** Accumulated text of the agent message being streamed; '' clears it. */
  | { type: 'partial'; threadId: string; text: string }
  | { type: 'thinking'; threadId: string; text: string }
  | { type: 'toolUse'; threadId: string; id: string; name: string; input: unknown; activity: string; state: 'tool' | 'waiting' }
  | { type: 'media'; threadId: string; media: TranscriptMedia }
  | { type: 'toolResult'; threadId: string; toolUseId: string; content: string; parts?: TranscriptContentPart[]; isError: boolean }
  | { type: 'tokens'; threadId: string; input: number; output: number; cachedInput: number }
  | { type: 'turnStarted'; threadId: string; turnId: string }
  | { type: 'turnCompleted'; threadId: string; turnId: string; status: TurnStatus; result?: string; error?: CodexTurnError }
  | { type: 'error'; threadId: string; message: string; willRetry: boolean; usageLimit: boolean }
  | { type: 'log'; level: 'info' | 'warn'; message: string }
  /** Codex's built-in multi-agent item started (once per item id). The adapter interrupts the turn. */
  | { type: 'nativeSpawn'; threadId: string; tool: string; itemId: string }

export interface MapperOptions {
  /** True for a model-visible harness tool name that waits on the user (isBlockingHarnessTool on the bare name). */
  isBlockingTool?(codexToolName: string): boolean
  /** Model-visible names of the harness tools of this run (the network tools are recognised separately). */
  harnessToolNames?: Iterable<string>
}

const RESULT_CHARS = 4000

function clip(s: string, n = RESULT_CHARS): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/** Plain text of a DynamicToolCallOutputContentItem[] / MCP content array. */
export function contentText(items: unknown): string {
  if (!Array.isArray(items)) return ''
  return items
    .map((c) => {
      if (typeof c === 'string') return c
      if (!isRec(c)) return ''
      if (typeof c.text === 'string') return c.text
      if (c.type === 'inputImage' || c.type === 'image') return '[image]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

export class CodexEventMapper {
  /** itemId -> text streamed so far (agent messages). */
  private streaming = new Map<string, string>()
  private reasoning = new Map<string, string>()
  /** threadId -> last agent message of the current turn, and the one marked final_answer. */
  private lastText = new Map<string, string>()
  private finalText = new Map<string, string>()
  private items = new Map<string, CodexItem>()
  private harness: Set<string>
  /** Native multi-agent item ids already reported (started then completed of one id counts once). */
  private nativeSeen = new Set<string>()

  constructor(private opts: MapperOptions = {}) {
    this.harness = new Set(opts.harnessToolNames ?? [])
  }

  /** The most recent item with this id (started or completed), for approval cards that only carry the item id. */
  item(itemId: string): CodexItem | undefined {
    return this.items.get(itemId)
  }

  /** The agent's last reply in the current turn (final_answer phase preferred). */
  resultOf(threadId: string): string | undefined {
    return this.finalText.get(threadId) ?? this.lastText.get(threadId)
  }

  /** Map one raw notification. */
  handle(method: string, params: unknown): CodexUpdate[] {
    const n = parseNotification(method, params)
    return n ? this.map(n) : []
  }

  map(n: CodexNotification): CodexUpdate[] {
    switch (n.kind) {
      case 'turnStarted':
        this.lastText.delete(n.threadId)
        this.finalText.delete(n.threadId)
        return [{ type: 'turnStarted', threadId: n.threadId, turnId: n.turnId }]
      case 'turnCompleted': {
        const status: TurnStatus = n.status === 'interrupted' ? 'interrupted' : n.status === 'failed' ? 'failed' : 'completed'
        const result = this.resultOf(n.threadId)
        return [{ type: 'partial', threadId: n.threadId, text: '' }, { type: 'turnCompleted', threadId: n.threadId, turnId: n.turnId, status, ...(result ? { result } : {}), ...(n.error ? { error: n.error } : {}) }]
      }
      case 'tokenUsage':
        return [{ type: 'tokens', threadId: n.threadId, input: n.input, output: n.output, cachedInput: n.cachedInput }]
      case 'agentMessageDelta': {
        const text = (this.streaming.get(n.itemId) ?? '') + n.delta
        this.streaming.set(n.itemId, text)
        return [{ type: 'partial', threadId: n.threadId, text }]
      }
      case 'reasoningDelta':
        this.reasoning.set(n.itemId, (this.reasoning.get(n.itemId) ?? '') + n.delta)
        return []
      case 'error': {
        const usageLimit = n.error.info === 'usageLimitExceeded' || (n.error.info === 'rateLimitExceeded' && !n.willRetry)
        return [{ type: 'error', threadId: n.threadId, message: n.error.message, willRetry: n.willRetry, usageLimit }]
      }
      case 'warning':
        return [{ type: 'log', level: 'warn', message: n.message }]
      case 'mcpStatus':
        return n.status === 'failed' || n.error ? [{ type: 'log', level: 'warn', message: `MCP server ${n.name}: ${n.error ?? n.status}` }] : []
      case 'plan':
        return [] // Codex's own plan tool; the run plan comes from the harness plan tools.
      case 'itemStarted':
        return this.itemStarted(n.threadId, n.item)
      case 'itemCompleted':
        return this.itemCompleted(n.threadId, n.item)
    }
  }

  // ---------- items ----------

  private itemStarted(threadId: string, item: CodexItem): UpdateList {
    this.items.set(item.id, item)
    const tool = this.toolOf(item)
    if (!tool) return this.otherItem(threadId, item)
    return [{ type: 'toolUse', threadId, id: item.id, name: tool.name, input: tool.input, activity: tool.activity, state: tool.blocking ? 'waiting' : 'tool' }]
  }

  private itemCompleted(threadId: string, item: CodexItem): UpdateList {
    this.items.set(item.id, item)
    switch (item.type) {
      case 'agentMessage': {
        const text = (str(item.text) ?? this.streaming.get(item.id) ?? '').trim()
        this.streaming.delete(item.id)
        const out: UpdateList = [{ type: 'partial', threadId, text: '' }]
        if (text) {
          out.push({ type: 'text', threadId, itemId: item.id, text })
          this.lastText.set(threadId, text)
          if (item.phase === 'final_answer') this.finalText.set(threadId, text)
        }
        return out
      }
      case 'reasoning': {
        const parts = [...strings(item.summary), ...(strings(item.summary).length ? [] : strings(item.content))]
        const text = (parts.join('\n\n') || this.reasoning.get(item.id) || '').trim()
        this.reasoning.delete(item.id)
        return text ? [{ type: 'thinking', threadId, text }] : []
      }
      case 'commandExecution':
        return [{ type: 'toolResult', threadId, toolUseId: item.id, content: commandResult(item), isError: commandFailed(item) }]
      case 'fileChange':
        return [{ type: 'toolResult', threadId, toolUseId: item.id, content: fileChangeResult(item), isError: item.status === 'failed' || item.status === 'declined' }]
      case 'mcpToolCall': {
        const error = isRec(item.error) ? str(item.error.message) : undefined
        const result = isRec(item.result) && item.result.content != null ? normalizeTranscriptContent(item.result.content) : { content: '' }
        if (!result.parts?.some(p => p.type === 'media')) delete result.parts
        if (!result.content && !result.parts && isRec(item.result) && item.result.structuredContent) result.content = clip(safeJson(item.result.structuredContent))
        return [{ type: 'toolResult', threadId, toolUseId: item.id, ...(error ? { content: clip(error) } : result), isError: !!error || item.status === 'failed' }]
      }
      case 'imageView':
        // Native imageView carries a local path, not returned image bytes. Never read that path.
        return [{ type: 'media', threadId, media: normalizeTranscriptMedia(item) }]
      case 'dynamicToolCall':
        return [{ type: 'toolResult', threadId, toolUseId: item.id, content: clip(contentText(item.contentItems)), isError: item.success === false || item.status === 'failed' }]
      case 'webSearch':
        return [{ type: 'toolResult', threadId, toolUseId: item.id, content: '', isError: false }]
      default:
        return this.otherItem(threadId, item, true)
    }
  }

  private otherItem(threadId: string, item: CodexItem, completed = false): UpdateList {
    if (item.type !== 'collabAgentToolCall' && item.type !== 'subAgentActivity') return []
    const tool = str(item.tool) ?? item.type
    if (completed) {
      return [{ type: 'log', level: 'warn', message: `Codex used its built-in multi-agent feature (${tool}); those agents are not governed by the org chart.` }]
    }
    if (this.nativeSeen.has(item.id)) return []
    this.nativeSeen.add(item.id)
    return [
      { type: 'toolUse', threadId, id: item.id, name: `codex:${tool}`, input: item.arguments ?? {}, activity: 'Used native multi-agent tools', state: 'tool' },
      { type: 'toolResult', threadId, toolUseId: item.id, content: NATIVE_AGENTS_UNAVAILABLE, isError: true },
      { type: 'nativeSpawn', threadId, tool, itemId: item.id }
    ]
  }

  /** Harness tool name and input for an item that is a tool call, or null. */
  private toolOf(item: CodexItem): { name: string; input: unknown; activity: string; blocking: boolean } | null {
    switch (item.type) {
      case 'commandExecution': {
        const input = { command: str(item.command) ?? '', ...(str(item.cwd) ? { cwd: str(item.cwd) } : {}) }
        return { name: 'Bash', input, activity: describeTool('Bash', input), blocking: false }
      }
      case 'fileChange': {
        const changes = fileChanges(item)
        const allAdds = changes.length > 0 && changes.every((c) => c.kind === 'add')
        const first = changes[0]?.path ?? ''
        const input = { file_path: first, changes }
        const name = allAdds ? 'Write' : 'Edit'
        const activity = changes.length > 1 ? `${allAdds ? 'Writing' : 'Editing'} ${changes.length} files` : describeTool(name, input)
        return { name, input, activity, blocking: false }
      }
      case 'mcpToolCall': {
        const server = str(item.server) ?? 'mcp'
        const name = `mcp__${server}__${str(item.tool) ?? 'tool'}`
        return { name, input: item.arguments ?? {}, activity: describeTool(name, item.arguments), blocking: false }
      }
      case 'webSearch': {
        const action = isRec(item.action) ? item.action : {}
        const query = str(item.query) ?? str(action.query) ?? strings(action.queries)[0] ?? ''
        return { name: 'WebSearch', input: { query }, activity: describeTool('WebSearch', { query }), blocking: false }
      }
      case 'dynamicToolCall':
        return this.dynamicTool(str(item.tool) ?? '', item.arguments)
      default:
        return null
    }
  }

  private dynamicTool(codexName: string, args: unknown): { name: string; input: unknown; activity: string; blocking: boolean } {
    const a = isRec(args) ? args : {}
    const canonical = canonicalNetworkTool(codexName)
    if (canonical === NETWORK_TOOLS.spawn) {
      const input = { subagent_type: str(a.role) ?? '', description: (str(a.brief) ?? '').slice(0, 120), prompt: str(a.brief) ?? '', ...(str(a.name) ? { name: str(a.name) } : {}) }
      return { name: 'Agent', input, activity: describeTool('Agent', input), blocking: false }
    }
    if (canonical === NETWORK_TOOLS.message) {
      const input = { to: str(a.to) ?? '', message: str(a.message) ?? '' }
      return { name: 'SendMessage', input, activity: describeTool('SendMessage', input), blocking: false }
    }
    if (canonical === NETWORK_TOOLS.list) return { name: 'ListAgents', input: {}, activity: describeTool('ListAgents', {}), blocking: false }
    const bare = harnessToolName(codexName)
    if (this.harness.has(codexName) || this.harness.has(bare)) {
      return { name: `${ORGAI_TOOL_PREFIX}${bare}`, input: args ?? {}, activity: describeTool(bare, args, { harness: true }), blocking: this.opts.isBlockingTool?.(codexName) ?? false }
    }
    return { name: codexName, input: args ?? {}, activity: describeTool(codexName, args), blocking: false }
  }
}

type UpdateList = CodexUpdate[]

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return ''
  }
}

export interface FileChangeSummary {
  path: string
  kind: 'add' | 'update' | 'delete'
  /**
   * Where an update moves the file (Codex 0.166 `kind: { type: 'update', move_path: <dest> }`, shape from the schema
   * and fixtures/codex-turn-tools.jsonl; a live move was never observed). Absent when there is no move (null or no
   * field). A move field that is present but not a non-empty string becomes '' so every check fails closed: callers
   * must treat any `movePath` key, '' included, as a second write target they cannot clear.
   */
  movePath?: string
}

/** The move destination of one raw change: undefined for no move, '' for a malformed one (fail closed). */
function moveDestination(c: Record<string, unknown>): string | undefined {
  const kind = isRec(c.kind) ? c.kind : undefined
  const raw = kind && 'move_path' in kind ? kind.move_path : kind && 'movePath' in kind ? kind.movePath : 'move_path' in c ? c.move_path : c.movePath
  if (raw === undefined || raw === null) return undefined
  return typeof raw === 'string' && raw.trim() !== '' ? raw : ''
}

/**
 * One summary per raw change, in order. A change with no usable path (not an object, or `path` missing, empty or not a
 * string) is kept with path '' (review NL2): an approval covers the whole item, so dropping it would let the other
 * changes be accepted on its behalf; '' fails every check and shows on the card.
 */
export function fileChanges(item: CodexItem): FileChangeSummary[] {
  if (!Array.isArray(item.changes)) return []
  return item.changes.map((c): FileChangeSummary => {
    if (!isRec(c)) return { path: '', kind: 'update' }
    const kind = isRec(c.kind) ? str(c.kind.type) : str(c.kind)
    const movePath = moveDestination(c)
    return { path: str(c.path) ?? '', kind: kind === 'add' || kind === 'delete' ? kind : 'update', ...(movePath !== undefined ? { movePath } : {}) }
  })
}

/** Every path a change list writes: each source path plus each move destination ('' for a malformed one). */
export function fileChangeTargets(changes: readonly FileChangeSummary[]): string[] {
  return changes.flatMap((c) => (c.movePath !== undefined ? [c.path, c.movePath] : [c.path]))
}

function commandFailed(item: CodexItem): boolean {
  const code = num(item.exitCode)
  return item.status === 'failed' || item.status === 'declined' || (code !== undefined && code !== 0)
}

function commandResult(item: CodexItem): string {
  if (item.status === 'declined') return 'The command was declined and did not run.'
  const out = str(item.aggregatedOutput) ?? ''
  const code = num(item.exitCode)
  return clip(code !== undefined && code !== 0 ? `${out}${out && !out.endsWith('\n') ? '\n' : ''}[exit code ${code}]` : out)
}

function fileChangeResult(item: CodexItem): string {
  const changes = fileChanges(item)
  if (item.status === 'declined') return 'The change was declined and not applied.'
  if (!changes.length) return str(item.status) ?? ''
  return changes.map((c) => `${c.kind} ${basename(c.path)}${c.movePath !== undefined ? ` -> ${c.movePath ? basename(c.movePath) : '(unknown)'}` : ''}`).join('\n')
}

/** Parse fixture JSONL (one `{method, params}` per line) into raw notifications. */
export function parseJsonl(text: string): { method: string; params: unknown }[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { method: string; params: unknown })
}

/**
 * Throttled live text: at most one `emit` per `intervalMs` per agent, flushing the latest text. '' clears at once.
 */
export class ThrottledPartial {
  private state = new Map<string, { text: string; lastEmit: number; shown: boolean; timer?: ReturnType<typeof setTimeout> }>()
  constructor(
    private emit: (agentId: string, text: string) => void,
    private intervalMs = 120
  ) {}

  set(agentId: string, text: string): void {
    if (!text) return this.clear(agentId)
    const s = this.state.get(agentId) ?? { text: '', lastEmit: 0, shown: false }
    s.text = text
    this.state.set(agentId, s)
    const wait = s.lastEmit + this.intervalMs - Date.now()
    if (wait <= 0) this.flush(agentId, s)
    else if (!s.timer) {
      s.timer = setTimeout(() => {
        s.timer = undefined
        if (this.state.get(agentId) === s) this.flush(agentId, s)
      }, wait)
    }
  }

  clear(agentId: string): void {
    const s = this.state.get(agentId)
    if (!s) return
    if (s.timer) clearTimeout(s.timer)
    this.state.delete(agentId)
    if (s.shown) this.emit(agentId, '')
  }

  clearAll(): void {
    for (const id of [...this.state.keys()]) this.clear(id)
  }

  private flush(agentId: string, s: { text: string; lastEmit: number; shown: boolean; timer?: ReturnType<typeof setTimeout> }): void {
    s.lastEmit = Date.now()
    s.shown = true
    this.emit(agentId, s.text)
  }
}
