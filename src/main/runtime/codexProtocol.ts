import { z } from 'zod'
import type { ImageAttachment, PermissionMode } from '@shared/types'
import type { HarnessTool } from './harnessTools'
import type { ResolvedMcpServer, RunConnection } from './types'

/**
 * Every Codex app-server method name, notification and request shape the adapter uses, in one place,
 * with defensive parsers (a field the server leaves out or renames degrades to a default, never a crash).
 *
 * Source of truth: `codex app-server generate-ts --experimental` of @openai/codex 0.166.0 (token-free).
 * VERIFIED against that schema: names and field shapes below. UNVERIFIED (needs a model turn, see
 * scripts/smoke-codex.mjs): the order and exact content of notifications during a real turn.
 */

// ---------- method names ----------

export const METHOD = {
  threadStart: 'thread/start',
  threadResume: 'thread/resume',
  turnStart: 'turn/start',
  turnSteer: 'turn/steer',
  turnInterrupt: 'turn/interrupt',
  threadUnsubscribe: 'thread/unsubscribe',
  mcpReload: 'config/mcpServer/reload',
  mcpStatusList: 'mcpServerStatus/list',
  configValueWrite: 'config/value/write',
  rateLimitsRead: 'account/rateLimits/read'
} as const

/** Server -> client requests. */
export const SERVER_REQUEST = {
  commandApproval: 'item/commandExecution/requestApproval',
  fileApproval: 'item/fileChange/requestApproval',
  permissionsApproval: 'item/permissions/requestApproval',
  toolCall: 'item/tool/call',
  userInput: 'item/tool/requestUserInput',
  mcpElicitation: 'mcpServer/elicitation/request',
  /** Legacy v1 approvals; answered with a denial in case a server still sends them. */
  legacyApplyPatch: 'applyPatchApproval',
  legacyExec: 'execCommandApproval'
} as const

// ---------- small guards ----------

export type Json = unknown
export type Rec = Record<string, unknown>

export function isRec(v: unknown): v is Rec {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}
export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}
export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

// ---------- items ----------

/** A ThreadItem: always has a type and an id; every other field is read defensively through the helpers. */
export interface CodexItem extends Rec {
  type: string
  id: string
}

export function parseItem(v: unknown): CodexItem | null {
  if (!isRec(v)) return null
  const type = str(v.type)
  const id = str(v.id)
  if (!type || !id) return null
  return v as CodexItem
}

// ---------- notifications ----------

export type CodexNotification =
  | { kind: 'itemStarted'; threadId: string; turnId: string; item: CodexItem }
  | { kind: 'itemCompleted'; threadId: string; turnId: string; item: CodexItem }
  | { kind: 'agentMessageDelta'; threadId: string; itemId: string; delta: string }
  | { kind: 'reasoningDelta'; threadId: string; itemId: string; delta: string }
  | { kind: 'turnStarted'; threadId: string; turnId: string }
  | { kind: 'turnCompleted'; threadId: string; turnId: string; status: string; error?: CodexTurnError }
  | { kind: 'tokenUsage'; threadId: string; input: number; output: number; cachedInput: number; contextWindow?: number }
  | { kind: 'error'; threadId: string; turnId?: string; willRetry: boolean; error: CodexTurnError }
  | { kind: 'plan'; threadId: string; explanation?: string; steps: { step: string; status: string }[] }
  | { kind: 'warning'; threadId?: string; message: string }
  | { kind: 'mcpStatus'; name: string; status: string; error?: string }

export interface CodexTurnError {
  message: string
  /** The codexErrorInfo variant name (e.g. 'usageLimitExceeded'), when present. */
  info?: string
  httpStatus?: number
  details?: string
}

export function parseTurnError(v: unknown): CodexTurnError | undefined {
  if (!isRec(v)) return undefined
  const message = str(v.message) ?? 'Codex reported an error'
  let info: string | undefined
  let httpStatus: number | undefined
  const raw = v.codexErrorInfo
  if (typeof raw === 'string') info = raw
  else if (isRec(raw)) {
    info = Object.keys(raw)[0]
    const inner = info ? raw[info] : undefined
    if (isRec(inner)) httpStatus = num(inner.httpStatusCode)
  }
  return { message, ...(info ? { info } : {}), ...(httpStatus !== undefined ? { httpStatus } : {}), ...(str(v.additionalDetails) ? { details: str(v.additionalDetails) } : {}) }
}

/** Parse a server notification; null for the many we do not use. */
export function parseNotification(method: string, params: unknown): CodexNotification | null {
  if (!isRec(params)) return null
  const threadId = str(params.threadId)
  switch (method) {
    case 'item/started':
    case 'item/completed': {
      const item = parseItem(params.item)
      if (!item || !threadId) return null
      return { kind: method === 'item/started' ? 'itemStarted' : 'itemCompleted', threadId, turnId: str(params.turnId) ?? '', item }
    }
    case 'item/agentMessage/delta': {
      const itemId = str(params.itemId)
      return threadId && itemId ? { kind: 'agentMessageDelta', threadId, itemId, delta: str(params.delta) ?? '' } : null
    }
    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/textDelta': {
      const itemId = str(params.itemId)
      return threadId && itemId ? { kind: 'reasoningDelta', threadId, itemId, delta: str(params.delta) ?? '' } : null
    }
    case 'turn/started': {
      const turn = isRec(params.turn) ? params.turn : {}
      return threadId ? { kind: 'turnStarted', threadId, turnId: str(turn.id) ?? str(params.turnId) ?? '' } : null
    }
    case 'turn/completed': {
      const turn = isRec(params.turn) ? params.turn : {}
      if (!threadId) return null
      const error = parseTurnError(turn.error)
      return { kind: 'turnCompleted', threadId, turnId: str(turn.id) ?? '', status: str(turn.status) ?? 'completed', ...(error ? { error } : {}) }
    }
    case 'thread/tokenUsage/updated': {
      const usage = isRec(params.tokenUsage) ? params.tokenUsage : {}
      const total = isRec(usage.total) ? usage.total : {}
      if (!threadId) return null
      const contextWindow = num(usage.modelContextWindow)
      return {
        kind: 'tokenUsage',
        threadId,
        input: num(total.inputTokens) ?? 0,
        output: num(total.outputTokens) ?? 0,
        cachedInput: num(total.cachedInputTokens) ?? 0,
        ...(contextWindow !== undefined ? { contextWindow } : {})
      }
    }
    case 'error': {
      const error = parseTurnError(params.error)
      if (!error || !threadId) return null
      return { kind: 'error', threadId, ...(str(params.turnId) ? { turnId: str(params.turnId) } : {}), willRetry: params.willRetry === true, error }
    }
    case 'turn/plan/updated': {
      if (!threadId) return null
      const steps = arr(params.plan).flatMap((s) => (isRec(s) && str(s.step) ? [{ step: str(s.step) as string, status: str(s.status) ?? 'pending' }] : []))
      return { kind: 'plan', threadId, ...(str(params.explanation) ? { explanation: str(params.explanation) } : {}), steps }
    }
    case 'warning':
      return { kind: 'warning', ...(threadId ? { threadId } : {}), message: str(params.message) ?? 'Codex warning' }
    case 'mcpServer/startupStatus/updated': {
      const name = str(params.name)
      return name ? { kind: 'mcpStatus', name, status: str(params.status) ?? 'unknown', ...(str(params.error) ? { error: str(params.error) } : {}) } : null
    }
    default:
      return null
  }
}

// ---------- server requests ----------

export interface CommandApproval {
  threadId: string
  itemId: string
  command: string
  cwd?: string
  reason?: string
}
export function parseCommandApproval(params: unknown): CommandApproval | null {
  if (!isRec(params)) return null
  const threadId = str(params.threadId)
  const itemId = str(params.itemId)
  if (!threadId || !itemId) return null
  return { threadId, itemId, command: str(params.command) ?? '', ...(str(params.cwd) ? { cwd: str(params.cwd) } : {}), ...(str(params.reason) ? { reason: str(params.reason) } : {}) }
}

export interface FileApproval {
  threadId: string
  itemId: string
  reason?: string
  grantRoot?: string
}
export function parseFileApproval(params: unknown): FileApproval | null {
  if (!isRec(params)) return null
  const threadId = str(params.threadId)
  const itemId = str(params.itemId)
  if (!threadId || !itemId) return null
  return { threadId, itemId, ...(str(params.reason) ? { reason: str(params.reason) } : {}), ...(str(params.grantRoot) ? { grantRoot: str(params.grantRoot) } : {}) }
}

export interface PermissionsApproval {
  threadId: string
  itemId: string
  reason?: string
  /** The requested profile with null members dropped, ready to echo back as the granted profile. */
  requested: Rec
}
export function parsePermissionsApproval(params: unknown): PermissionsApproval | null {
  if (!isRec(params)) return null
  const threadId = str(params.threadId)
  const itemId = str(params.itemId)
  if (!threadId || !itemId) return null
  const requested: Rec = {}
  if (isRec(params.permissions)) for (const [k, v] of Object.entries(params.permissions)) if (v !== null && v !== undefined) requested[k] = v
  return { threadId, itemId, ...(str(params.reason) ? { reason: str(params.reason) } : {}), requested }
}

export interface DynamicToolCall {
  threadId: string
  turnId: string
  callId: string
  namespace?: string
  tool: string
  arguments: unknown
}
export function parseToolCall(params: unknown): DynamicToolCall | null {
  if (!isRec(params)) return null
  const threadId = str(params.threadId)
  const tool = str(params.tool)
  if (!threadId || !tool) return null
  return { threadId, turnId: str(params.turnId) ?? '', callId: str(params.callId) ?? '', ...(str(params.namespace) ? { namespace: str(params.namespace) } : {}), tool, arguments: params.arguments ?? {} }
}

/** DynamicToolCallResponse: one text item plus a success flag. */
export function toolResponse(text: string, success: boolean): { contentItems: { type: 'inputText'; text: string }[]; success: boolean } {
  return { contentItems: [{ type: 'inputText', text }], success }
}

export interface UserInputQuestion {
  id: string
  header: string
  question: string
  isOther: boolean
  options: { label: string; description?: string }[]
}
export function parseUserInputQuestions(params: unknown): { threadId: string; questions: UserInputQuestion[] } | null {
  if (!isRec(params)) return null
  const threadId = str(params.threadId)
  if (!threadId) return null
  const questions = arr(params.questions).flatMap((q): UserInputQuestion[] => {
    if (!isRec(q) || !str(q.id)) return []
    const options = arr(q.options).flatMap((o) => (isRec(o) && str(o.label) ? [{ label: str(o.label) as string, ...(str(o.description) ? { description: str(o.description) } : {}) }] : []))
    return [{ id: str(q.id) as string, header: str(q.header) ?? '', question: str(q.question) ?? '', isOther: q.isOther === true, options }]
  })
  return { threadId, questions }
}

// ---------- thread / turn results ----------

export function parseThreadResult(v: unknown): { threadId: string; model?: string; cwd?: string } | null {
  if (!isRec(v) || !isRec(v.thread)) return null
  const threadId = str(v.thread.id)
  if (!threadId) return null
  return { threadId, ...(str(v.model) ? { model: str(v.model) } : {}), ...(str(v.cwd) ? { cwd: str(v.cwd) } : {}) }
}

export function parseTurnId(v: unknown): string | undefined {
  return isRec(v) && isRec(v.turn) ? str(v.turn.id) : isRec(v) ? str(v.turnId) : undefined
}

// ---------- user input ----------

export type UserInput = { type: 'text'; text: string; text_elements: unknown[] } | { type: 'image'; url: string }

/** Input items for a turn: images first (as data: URLs), then the text. */
export function userInput(text: string, images?: ImageAttachment[]): UserInput[] {
  const items: UserInput[] = (images ?? []).filter((i) => i.data).map((i) => ({ type: 'image' as const, url: `data:${i.mediaType};base64,${i.data}` }))
  if (text || items.length === 0) items.push({ type: 'text', text, text_elements: [] })
  return items
}

// ---------- permission modes ----------

export type ApprovalPolicy = 'untrusted' | 'on-request' | 'never'
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export interface PolicyChoice {
  approvalPolicy: ApprovalPolicy
  sandbox: SandboxMode
  /** 'auto': Codex's own reviewer subagent approves or denies each request (ThreadStartParams.approvalsReviewer, UNSTABLE). */
  approvalsReviewer?: 'auto_review'
  /** acceptEdits: the harness accepts file-change approvals itself and only asks for commands. */
  autoAcceptEdits: boolean
  /** dontAsk / plan: any approval request that still arrives is declined. */
  denyApprovals: boolean
}

/**
 * Map the project's permission mode onto Codex's approval policy and sandbox.
 *   auto              on-request + workspace-write, Codex's auto_review reviewer decides, asks only when unsure
 *   acceptEdits       untrusted + workspace-write; the harness accepts file edits, commands ask
 *   default           untrusted + workspace-write; everything not known-safe asks
 *   dontAsk           never + workspace-write; whatever the sandbox refuses stays refused (approvals declined)
 *   plan              never + read-only
 *   bypassPermissions never + danger-full-access
 * A role without any writing tool (`writes` false) and every setup-like run get read-only, unless the mode is stricter.
 */
export function policyFor(mode: PermissionMode, opts: { writes: boolean; setupLike: boolean }): PolicyChoice {
  let choice: PolicyChoice
  switch (mode) {
    case 'auto':
      choice = { approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'auto_review', autoAcceptEdits: false, denyApprovals: false }
      break
    case 'acceptEdits':
      choice = { approvalPolicy: 'untrusted', sandbox: 'workspace-write', autoAcceptEdits: true, denyApprovals: false }
      break
    case 'dontAsk':
      choice = { approvalPolicy: 'never', sandbox: 'workspace-write', autoAcceptEdits: false, denyApprovals: true }
      break
    case 'plan':
      choice = { approvalPolicy: 'never', sandbox: 'read-only', autoAcceptEdits: false, denyApprovals: true }
      break
    case 'bypassPermissions':
      choice = { approvalPolicy: 'never', sandbox: 'danger-full-access', autoAcceptEdits: false, denyApprovals: false }
      break
    default:
      choice = { approvalPolicy: 'untrusted', sandbox: 'workspace-write', autoAcceptEdits: false, denyApprovals: false }
  }
  if (opts.setupLike) {
    // Like the Claude adapter, setup never edits files, so a plan-only project setting must not block reads and an
    // unattended project keeps its reviewer for the Architect's shell work.
    choice = { ...choice, sandbox: 'read-only', ...(mode === 'plan' ? { approvalPolicy: 'untrusted' as const, denyApprovals: false } : {}) }
  } else if (!opts.writes && choice.sandbox !== 'read-only') {
    choice = { ...choice, sandbox: 'read-only' }
  }
  return choice
}

// ---------- saved allow rules ----------

// The matcher is vendor-neutral and shared with the Claude adapter's PreToolUse hook.
export { matchesBashRule, unwrapShellCommand } from './ruleMatch'

// ---------- dynamic tools ----------

/** Codex has its own tool named update_plan; the harness's plan tool of the same name is exposed under another name. */
export const CODEX_TOOL_RENAMES: Record<string, string> = { update_plan: 'orgai_update_plan' }
const REVERSE_RENAMES = Object.fromEntries(Object.entries(CODEX_TOOL_RENAMES).map(([k, v]) => [v, k]))

export function codexToolName(harnessName: string): string {
  return CODEX_TOOL_RENAMES[harnessName] ?? harnessName
}
export function harnessToolName(codexName: string): string {
  return REVERSE_RENAMES[codexName] ?? codexName
}

export interface DynamicToolSpec {
  type: 'function'
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** JSON Schema for a zod object, in the shape function tools take. */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>
  delete out.$schema
  if (out.type === 'object' && out.properties === undefined) out.properties = {}
  return out
}

export function dynamicToolSpec(tool: Pick<HarnessTool, 'name' | 'description' | 'inputSchema'>): DynamicToolSpec {
  return { type: 'function', name: codexToolName(tool.name), description: tool.description, inputSchema: jsonSchemaOf(tool.inputSchema) }
}

// ---------- launch configuration ----------

/** TOML basic string (JSON string syntax is a valid TOML basic string). */
export function tomlString(s: string): string {
  return JSON.stringify(s)
}
export function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)
}
function tomlArray(items: string[]): string {
  return `[${items.map(tomlString).join(', ')}]`
}
function tomlTable(entries: Record<string, string>): string {
  return `{ ${Object.entries(entries)
    .map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`)
    .join(', ')} }`
}

export const API_KEY_ENV = 'ORGAI_CODEX_API_KEY'
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'

export interface LaunchConfig {
  /** `-c key=value` overrides for `codex app-server`. May contain no secrets except for the documented collision fallback. */
  config: string[]
  /** Extra child environment: CODEX_HOME, the API key and forwarded MCP secrets. Never log. */
  env: Record<string, string>
  /** A secret-free description for the run log. */
  summary: string[]
  /** Servers that could not be configured, with the reason. */
  skipped: { name: string; reason: string }[]
}

/**
 * `-c` overrides and child environment for one app-server process.
 *
 * API key (codexAuth 'apiKey'): a custom provider `orgai` with env_key ORGAI_CODEX_API_KEY, so the key travels in
 * the child environment, never in argv. ChatGPT login (codexAuth 'chatgpt' or unset): nothing; the login lives in CODEX_HOME.
 *
 * MCP servers (keys checked as present in the codex 0.166.0 binary's RawMcpServerConfig: command, args, env,
 * env_vars, cwd, http_headers, env_http_headers, url, bearer_token, bearer_token_env_var, startup_timeout_sec,
 * tool_timeout_sec, required; semantics UNVERIFIED without a model turn):
 *   stdio  command + args + env (non-secret values); secret env names are forwarded with env_vars from the
 *          app-server's own environment (same name), so values are not in argv.
 *   http   url + http_headers (non-secret); each secret header becomes env_http_headers { Header = "ORGAI_MCP_<n>_H<k>" }.
 *          An Authorization header of the form "Bearer x" is passed as bearer_token_env_var instead.
 * Two stdio servers needing the same secret name with different values cannot both use env_vars; the later one
 * gets the value inline in `env` (visible in the process arguments) and the summary says so.
 */
export function buildLaunchConfig(connection: RunConnection | undefined, servers: ResolvedMcpServer[]): LaunchConfig {
  const config: string[] = []
  const env: Record<string, string> = { ...(connection?.env ?? {}) }
  const summary: string[] = []
  const skipped: LaunchConfig['skipped'] = []

  if (connection?.codexAuth === 'apiKey' && connection.apiKey) {
    const base = connection.openaiBaseUrl?.trim() || DEFAULT_OPENAI_BASE_URL
    config.push(
      `model_provider=${tomlString('orgai')}`,
      `model_providers.orgai.name=${tomlString('OrgAI')}`,
      `model_providers.orgai.base_url=${tomlString(base)}`,
      `model_providers.orgai.env_key=${tomlString(API_KEY_ENV)}`,
      `model_providers.orgai.wire_api=${tomlString('responses')}`
    )
    env[API_KEY_ENV] = connection.apiKey
    summary.push(`provider orgai -> ${base} (API key from the environment)`)
  } else {
    summary.push('ChatGPT login from CODEX_HOME')
  }

  const forwarded = new Map<string, string>() // env var name -> value already forwarded for another server
  servers.forEach((srv, n) => {
    const { spec } = srv
    if (!spec.enabled) return
    const base = `mcp_servers.${tomlKey(spec.name)}`
    if (spec.transport === 'stdio') {
      if (!spec.command) {
        skipped.push({ name: spec.name, reason: 'no command' })
        return
      }
      config.push(`${base}.command=${tomlString(spec.command)}`)
      if (spec.args?.length) config.push(`${base}.args=${tomlArray(spec.args)}`)
      const secretNames = new Set(spec.secretEnv ?? [])
      const plain: Record<string, string> = {}
      const forward: string[] = []
      const inlineSecrets: string[] = []
      for (const [k, v] of Object.entries(srv.env)) {
        if (!secretNames.has(k)) plain[k] = v
        else if (!forwarded.has(k) || forwarded.get(k) === v) {
          forwarded.set(k, v)
          env[k] = v
          forward.push(k)
        } else {
          plain[k] = v
          inlineSecrets.push(k)
        }
      }
      if (Object.keys(plain).length) config.push(`${base}.env=${tomlTable(plain)}`)
      if (forward.length) config.push(`${base}.env_vars=${tomlArray(forward)}`)
      summary.push(
        `mcp ${spec.name}: stdio ${spec.command}${forward.length ? ` (secrets forwarded: ${forward.join(', ')})` : ''}${inlineSecrets.length ? ` (WARNING ${inlineSecrets.join(', ')} passed inline: name clash with another server)` : ''}`
      )
    } else {
      if (!spec.url) {
        skipped.push({ name: spec.name, reason: 'no url' })
        return
      }
      config.push(`${base}.url=${tomlString(spec.url)}`)
      const secretNames = new Set(spec.secretHeaders ?? [])
      // A header is plain only when it is declared in spec.headers with this exact value. Everything else (stored
      // secrets, the OAuth access token resolve() injects as Authorization) goes through the environment, never argv.
      const declared = spec.headers ?? {}
      const plain: Record<string, string> = {}
      const fromEnv: Record<string, string> = {}
      let k = 0
      for (const [h, v] of Object.entries(srv.headers)) {
        if (!secretNames.has(h) && declared[h] === v) {
          plain[h] = v
          continue
        }
        const m = /^bearer\s+(.+)$/i.exec(v)
        const envName = `ORGAI_MCP_${n}_H${k++}`
        if (h.toLowerCase() === 'authorization' && m) {
          env[envName] = m[1]
          config.push(`${base}.bearer_token_env_var=${tomlString(envName)}`)
        } else {
          env[envName] = v
          fromEnv[h] = envName
        }
      }
      if (Object.keys(plain).length) config.push(`${base}.http_headers=${tomlTable(plain)}`)
      if (Object.keys(fromEnv).length) config.push(`${base}.env_http_headers=${tomlTable(fromEnv)}`)
      summary.push(`mcp ${spec.name}: ${spec.transport} ${spec.url}`)
    }
  })
  return { config, env, summary, skipped }
}

/** The prefix an agent uses for a server's tools. Codex names MCP tools mcp__<server>__<tool> (same convention as Claude Code; UNVERIFIED). */
export function mcpToolPrefix(serverName: string): string {
  return `mcp__${serverName}__`
}

// ---------- rate limits ----------

/**
 * When the exhausted usage window resets (epoch ms), from an `account/rateLimits/read` result
 * ({ rateLimits, rateLimitsByLimitId }; windows are { usedPercent, resetsAt (epoch seconds) }).
 * undefined when no window is at 100 percent or no reset time is given.
 */
export function untilFromRateLimits(v: unknown): number | undefined {
  if (!isRec(v)) return undefined
  const snapshots: Rec[] = []
  if (isRec(v.rateLimits)) snapshots.push(v.rateLimits)
  if (isRec(v.rateLimitsByLimitId)) for (const s of Object.values(v.rateLimitsByLimitId)) if (isRec(s)) snapshots.push(s)
  const resets = snapshots
    .flatMap((s) => [s.primary, s.secondary])
    .filter(isRec)
    .filter((w) => (num(w.usedPercent) ?? 0) >= 100 && num(w.resetsAt) !== undefined)
    .map((w) => num(w.resetsAt) as number)
  if (!resets.length) return undefined
  const latest = Math.max(...resets)
  return latest < 1e11 ? latest * 1000 : latest
}
