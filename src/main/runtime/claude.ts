import { closeSync, existsSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { validModelId } from '../connections/codexAccount'
import {
  createSdkMcpServer,
  query,
  tool,
  type AgentDefinition,
  type HookCallback,
  type HookJSONOutput,
  type McpSdkServerConfigWithInstance,
  type McpServerConfig,
  type SdkPluginConfig,
  type ModelUsage,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  type PreToolUseHookInput,
  type PostToolUseHookInput,
  type SubagentStartHookInput,
  type SubagentStopHookInput,
  type SDKMessage,
  type SDKUserMessage,
  type Query
} from '@anthropic-ai/claude-agent-sdk'
import type { AgentInstance, ImageAttachment, McpServerSpec, PluginSpec, Project, RunSummary, Role, RunEvent, TranscriptBlock, UsageStatus, WorktreeInfo } from '@shared/types'
import type { PermissionDecision, PermissionSuggestion, ProviderAuth } from '@shared/types'
import { SPAWN_TOOL } from '@shared/types'
import { ANTHROPIC_BUILTIN_MODELS, effectiveSubagentLimits, isolateWritersOn, mcpServersForRole, newId, planGuardEngaged, planGuardOf, projectKindOf, settingTier, tierForModel } from '@shared/defaults'
import { ROOT_AGENT_ID, isSetupLikeRun, type AdapterModelInfo, type RunSkill, type CompletionInput, type RunConnection, type ResolvedMcpServer, type RuntimeAdapter, type PeerMessage, type RuntimeContext, type RuntimeSession } from './types'
import { isTrustRestrictedRun, isWorkspaceConfigPath } from '../quick/scratch'
import { hiddenCharIn } from '../capabilities/sanitize'
import { allowRuleStrings, applyAllowScope, chooseSuggestions, listRules, suggestionLabels, type AllowScopePersist, type SuggestOptions } from './permissionRules'
import { isGitRepo } from './worktrees'
import { costOf, rateFor, ratesFromModelUsage, sumByModel, weighted, type CostRates, type TokenMix } from './claudeCost'
import { costFromPrice, priceFor } from './pricing'
import { countUsage, setModelTokens } from './runUsage'
import { PartialText } from './claudePartial'
import { buildSkillPlugin, livePluginNames, pluginStale, skillGate, type SkillPlugin } from './claudeSkills'
import { SETUP_TOOLS_INSTRUCTIONS, datum, harnessToolsFor, isBlockingHarnessTool, type ConfigChange, type ConfigChangeResult, type HarnessTool, type HarnessToolAudience, type McpAttachResult } from './harnessTools'
import { agentInstalledServers, isMcpGated, mcpCallDenial, rolesGrantedServer, withoutServerRules } from './mcpGrants'
import {
  REFERENCE_EDIT_TOOLS,
  commandReferenceTouch,
  editTargetOf,
  referenceCommandMessage,
  referenceEditDenial,
  referenceFolderOf,
  referenceRefusalEntry,
  referenceTouchOf
} from './referenceDirectories'
import { SHELL_TOOLS, isUnsafeSegment, matchOptionsFor, matchingRule, programRunsProgram, ruleCoversButRefused, splitCommand, unwrapShellCommand, type MatchOptions } from './ruleMatch'
import { ContinuationDriver, stepActivity } from './continuation'
import { LIST_AGENTS_TOOL, MESSAGE_TOOL, buildRolePrompt, peerMessageText, canWrite, composeFirstMessage, isArchitectureFile } from './prompts'
import { HandleNamer, mapSendMessage, messageTranscriptText, spawnHandle } from './network'
import { authFailureMessage, describeTool, isAuthFailure, scrubAuthDetail } from './activity'
import { isolateClaudeEnv, scrubControlEnv } from './childEnv'
import { SELF_CONTROL_REFUSAL_TEXT, checkSelfControlDenial, selfControlLogLine } from './selfControlGate'
import { WorktreeIntegrator } from './integration'
import { resolveParent } from './agentTree'
import {
  mapRateLimitEvent,
  mapUsageResponse,
  mergeUsage,
  shareUsed,
  shouldSteerToEveryday,
  trackShare,
  windowShareExceeded,
  type AuthMode,
  type RateLimitInfoLike,
  type ShareTracker,
  type UsageResponseLike
} from './usage'

/** How often a live session asks for plan usage. */
const USAGE_POLL_MS = 60_000
const USAGE_METHOD = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET'
const DEFAULT_OPUS_GUARD = 80

type UserContent = SDKUserMessage['message']['content']

/**
 * Content for a user turn. Plain string when there are no images; otherwise image blocks first, then the
 * text block (left out when the text is empty).
 */
export function userContent(text: string, images?: ImageAttachment[]): UserContent {
  if (!images?.length) return text
  const blocks: Exclude<UserContent, string> = images.map((i) => ({
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: i.mediaType, data: i.data }
  }))
  if (text) blocks.push({ type: 'text', text })
  return blocks
}

/** The transcript block for a user message; `images` is left off when there are none. */
function userBlock(text: string, images?: ImageAttachment[]): TranscriptBlock {
  return images?.length ? { kind: 'user', text, images } : { kind: 'user', text }
}

/** Whether a model setting (tier name, alias or concrete id) is on the deep or top tier, or is one of the connection's deep/top models. */
export function isDeepOrTopModel(model: string | undefined, tierModels: RunConnection['tierModels']): boolean {
  const m = model?.trim()
  if (!m) return false
  const tier = settingTier(m) ?? tierForModel(m)
  if (tier === 'deep' || tier === 'top') return true
  return m === tierModels?.deep?.trim() || m === tierModels?.top?.trim()
}

/** The model a steered spawn runs on: the connection's everyday model, else the anthropic builtin everyday entry. */
export function everydayReplacement(tierModels: RunConnection['tierModels']): string | undefined {
  return tierModels?.everyday?.trim() || ANTHROPIC_BUILTIN_MODELS.find((m) => m.tier === 'everyday')?.id
}

/** Map a supportedModels() response (untrusted) to AdapterModelInfo rows. */
export function mapSupportedModels(raw: unknown): AdapterModelInfo[] {
  if (!Array.isArray(raw)) return []
  const out: AdapterModelInfo[] = []
  const seen = new Set<string>()
  for (const row of raw) {
    if (out.length >= 200) break
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    if (typeof r.value !== 'string') continue
    const id = r.value.trim()
    if (!validModelId(id) || id.toLowerCase() === 'default' || seen.has(id)) continue
    seen.add(id)
    const info: AdapterModelInfo = { id }
    if (typeof r.displayName === 'string' && r.displayName.trim()) info.label = r.displayName.trim().slice(0, 300)
    if (typeof r.description === 'string' && r.description.trim()) info.description = r.description.trim().slice(0, 300)
    if (typeof r.resolvedModel === 'string' && validModelId(r.resolvedModel.trim())) info.resolvedModel = r.resolvedModel.trim()
    out.push(info)
  }
  return out
}

/**
 * The Claude adapter: maps Claude Agent SDK messages and hooks onto normalized RunEvents. Everything
 * that is not SDK mechanics lives in the shared runtime modules: harness tools (harnessTools.ts),
 * role prompts (prompts.ts), activity strings (activity.ts), worktree integration (integration.ts)
 * and permission scopes (permissionRules.ts).
 */

/**
 * Inside a packaged Electron app the SDK resolves its native CLI to a path inside app.asar, which
 * cannot be spawned. electron-builder unpacks that binary beside the archive (app.asar.unpacked),
 * so point the SDK there. Outside a package this returns undefined and the SDK's default is used.
 */
function packagedClaudeExecutable(): string | undefined {
  try {
    const req = createRequire(import.meta.url)
    const pkgJson = req.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`)
    if (!pkgJson.includes('app.asar')) return undefined
    const dir = dirname(pkgJson).replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked')
    const bin = join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude')
    return existsSync(bin) ? bin : undefined
  } catch {
    return undefined
  }
}
const CLAUDE_EXECUTABLE = packagedClaudeExecutable()
const EXECUTABLE_OPTION = CLAUDE_EXECUTABLE ? { pathToClaudeCodeExecutable: CLAUDE_EXECUTABLE } : {}

const ROOT_ID = ROOT_AGENT_ID
/** MCP server name for the harness's own tools; tool names surface as mcp__orgai__<name>. */
const ORGAI_MCP = 'orgai'
const ORGAI_TOOL_PREFIX = `mcp__${ORGAI_MCP}__`

/** Activity string for an SDK tool name; harness tools lose their MCP prefix first. */
function describe(name: string, input: unknown): string {
  if (name.startsWith(ORGAI_TOOL_PREFIX)) return describeTool(name.slice(ORGAI_TOOL_PREFIX.length), input, { harness: true })
  return describeTool(name, input)
}

/** A push-based async iterable used as the SDK's streaming prompt input. */
class PushStream<T> implements AsyncIterable<T> {
  private queue: T[] = []
  private waiters: ((r: IteratorResult<T>) => void)[] = []
  private closed = false

  push(value: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.queue.push(value)
  }

  end(): void {
    this.closed = true
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true })
  }

  /** Take every value pushed but not yet read (a restart moves them to the next query's stream). */
  drain(): T[] {
    return this.queue.splice(0)
  }

  /** The values pushed but not yet read, left in place. */
  peek(): T[] {
    return [...this.queue]
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.queue.length) return Promise.resolve({ value: this.queue.shift() as T, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      }
    }
  }
}

/**
 * Server-level tool rule for an MCP server inside an AgentDefinition.tools whitelist. Verified for a main-thread agent
 * in scripts/smoke-mcp-midrun.mjs ('mcp__alpha' admits mcp__alpha__ping; 'mcp__*' admits nothing and makes a
 * subagent spawn fail with "unrecognized [mcp__*]"). Whitelists are fixed for the query: a server attached later
 * reaches a whitelisted agent only after the query is re-created (ClaudeSession.maybeRestartForMcp).
 */
export function mcpToolRule(serverName: string): string {
  return `mcp__${serverName}`
}

/** Wait after the orchestrator's turn ends before an MCP restart, so a report hand-back the SDK is about to resume with goes first. */
export const MCP_RESTART_DELAY_MS = 1500
/** How long addMcpServer polls mcpServerStatus for the new server's tool names. */
const MCP_STATUS_WAIT_MS = 5000
/** If the old query has not ended this long after its input closed for a restart, it is closed. */
const MCP_RESTART_CLOSE_MS = 15_000
/** A run whose restarted query cannot start at all is paused this long, then RunManager resumes it. */
export const MCP_RESTART_PAUSE_MS = 5 * 60 * 1000
/** Smallest budget a restarted query is given; below that nothing is left and the restart is skipped. */
export const MCP_RESTART_MIN_BUDGET_USD = 0.01
/** Tool names an MCP server reports that the harness repeats to the orchestrator: plain identifiers only. */
const MCP_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/
/** At most this many tool names per server in the attach notice. */
export const MCP_NOTICE_TOOL_CAP = 20

/** The query an MCP restart starts once the current one has ended. */
interface NextQuery {
  options: Options
  /** Servers it attaches (announced once it runs). */
  servers: string[]
  /** Tool names per server reported before the restart (the notice's fallback). */
  tools: Map<string, string[]>
  /** Set when these servers were left out after failed starts: the orchestrator is told they could not be attached. */
  dropped?: string[]
  /**
   * The skill plugin this query loads (a config change rebuilt it): installed as the session's plugin when the query
   * starts; the one it replaces is removed only after a query's init. undefined = the current plugin; null = none.
   */
  plugin?: SkillPlugin | null
  /** The plugin in use before this restart rebuilt it (a fallback after failed starts returns to it). */
  prevPlugin?: SkillPlugin | null
  /** Set when the restart applies an approved config change (propose_mcp_servers / propose_skills): what the notice names. */
  config?: RestartConfig
  /** Set when a rebuilt skill plugin was left out after failed starts: the orchestrator is told the skill changes wait. */
  droppedSkills?: boolean
}

/** The parts of approved config changes a restart brings into the session (ConfigChange, after the adapter sorted it). */
interface RestartConfig {
  /** Existing servers whose roles changed so some role's whitelist grows. */
  regranted: string[]
  /** Servers removed or turned off (already denied by the gate; named in the notice). */
  removed: string[]
  /** The skills or skill grants changed. */
  skills: boolean
}

/** One skill in the config notice: its qualified name and the roles granted it. */
type SkillNoticeEntry = { name: string; roles: Pick<Role, 'name' | 'slug'>[] }

/** Per role slug: the tools and MCP servers its AgentDefinition whitelists (fixed for the life of a query). */
export type GrantSnapshot = Map<string, { tools: Set<string>; mcp: Set<string> }>

/** The whitelists of a query's agent definitions. Pure. */
export function grantSnapshot(agents: Record<string, AgentDefinition>): GrantSnapshot {
  const out: GrantSnapshot = new Map()
  for (const [slug, def] of Object.entries(agents)) {
    const mcp = (def.mcpServers ?? []).map((s) => (typeof s === 'string' ? s : Object.keys(s).join(',')))
    out.set(slug, { tools: new Set(def.tools ?? []), mcp: new Set(mcp) })
  }
  return out
}

/**
 * True when `after` lets some role use a tool or MCP server that `before` did not: only a re-created query can give
 * it (whitelists are exact and fixed per query). Losses never count, the PreToolUse gates enforce them at the next
 * call. A missing `before` counts as gained. Pure.
 */
export function grantsGained(before: GrantSnapshot | undefined, after: GrantSnapshot): boolean {
  if (!before) return true
  for (const [slug, now] of after) {
    const was = before.get(slug)
    if (!was) return true
    for (const t of now.tools) if (!was.tools.has(t)) return true
    for (const m of now.mcp) if (!was.mcp.has(m)) return true
  }
  return false
}

/** What decides whether an upserted server was (re)defined: everything that changes what runs or where it connects. */
export function mcpDefinitionKey(spec: McpServerSpec): string {
  const sorted = (r?: Record<string, string>) => Object.entries(r ?? {}).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify([
    spec.transport,
    spec.command ?? null,
    spec.args ?? [],
    spec.url ?? null,
    sorted(spec.env),
    sorted(spec.headers),
    [...(spec.secretEnv ?? [])].sort(),
    [...(spec.secretHeaders ?? [])].sort(),
    spec.libraryId ?? null
  ])
}

/** What decides whether a session may be re-created now to attach MCP servers. */
export interface McpRestartState {
  /** The run is ending, stopped or failed. */
  stopping: boolean
  /** Interrupted (or stopped by the window cap) and waiting for the user. */
  held: boolean
  /** The provider rejected a request on a usage limit. */
  limited: boolean
  /** The orchestrator's turn has ended. */
  rootIdle: boolean
  /** Reports still running. */
  liveReports: number
  /** Open decision cards. */
  pendingInteractions: number
  /** Background tasks that are not subagents (background Bash, monitors, MCP tasks) still running; a restart would kill them. */
  backgroundTasks: number
}

/** Why an MCP restart must wait (or never happen), or undefined when it may go ahead now. Pure. */
export function mcpRestartBlocker(s: McpRestartState): string | undefined {
  if (s.stopping) return 'the run is ending'
  if (s.held) return 'the run is held for the user'
  if (s.limited) return 'the run is at a usage limit'
  if (!s.rootIdle) return 'the orchestrator is mid-turn'
  if (s.liveReports > 0) return 'reports are still running'
  if (s.pendingInteractions > 0) return 'a decision card is open'
  if (s.backgroundTasks > 0) return 'background tasks are still running'
  return undefined
}

/** Tool names reported by an MCP server (untrusted) that may be repeated to the orchestrator: plain identifiers, at most 64 chars. */
export function safeMcpToolNames(names: readonly unknown[]): string[] {
  return names.filter((t): t is string => typeof t === 'string' && MCP_TOOL_NAME.test(t))
}

/**
 * The harness message that tells the orchestrator which MCP servers are attached, with their full tool names and the
 * roles granted them. Tool names come from the server (untrusted): only plain identifiers are listed, at most
 * MCP_NOTICE_TOOL_CAP per server, and every name (server, tools, roles) goes through datum().
 */
export function mcpAttachedNotice(servers: { name: string; tools: string[]; roles?: Pick<Role, 'name' | 'slug'>[] }[]): string {
  const parts = servers.map((s) => {
    const name = datum(s.name, 64)
    const prefix = `mcp__${name}__`
    const safe = safeMcpToolNames(s.tools)
    // datum keeps the whole name (the pattern allows 64 chars, so a 60-char cut would name a tool that does not exist).
    const listed = safe.slice(0, MCP_NOTICE_TOOL_CAP).map((t) => prefix + datum(t, 64)).join(', ')
    const more = safe.length > MCP_NOTICE_TOOL_CAP ? `, and ${safe.length - MCP_NOTICE_TOOL_CAP} more` : ''
    const tools = safe.length ? `Its tools: ${listed}${more}.` : `Its tool names start with ${prefix}.`
    // roles undefined: the grants could not be read (announceAttached failed); the PreToolUse gate still enforces them.
    const roles = !s.roles
      ? 'Only roles the org chart grants it may call it.'
      : s.roles.length
        ? `Roles that may use it: ${s.roles.map((r) => `${datum(r.name, 60)} (${datum(r.slug, 60)})`).join(', ')}.`
        : 'No role in the org chart is granted it, so no agent can call it in this run.'
    return `The MCP server ${name} is attached now. ${tools} ${roles}`
  })
  return `[OrgAI harness] ${parts.join(' ')} Calls to it may still ask the user for permission under the project's permission mode. Reports you spawn from now on get it if their role is granted it.`
}

/**
 * The harness message after a restart that applied an approved config change: the attached or re-granted servers (as
 * mcpAttachedNotice), the servers removed or turned off, and the skills now in the session. `skills` undefined = no
 * skill change; null = the skills changed but the list could not be read. Every name goes through datum(); at most
 * MCP_NOTICE_TOOL_CAP skills are listed.
 */
export function configChangeNotice(c: {
  servers: Parameters<typeof mcpAttachedNotice>[0]
  removed: string[]
  skills?: { name: string; roles: Pick<Role, 'name' | 'slug'>[] }[] | null
}): string {
  let text = c.servers.length ? mcpAttachedNotice(c.servers) : '[OrgAI harness] The configuration change approved this run is in effect now.'
  if (c.removed.length) {
    const one = c.removed.length === 1
    text += ` The MCP server${one ? '' : 's'} ${c.removed.map((n) => datum(n, 64)).join(', ')} ${one ? 'was' : 'were'} removed or turned off: ${one ? 'its' : 'their'} tools are no longer available.`
  }
  if (c.skills === null) text += ' The project\'s skills changed and are loaded in this session now; load one with the Skill tool and its full name.'
  else if (c.skills && !c.skills.length) text += ' No skills are granted in this session now.'
  else if (c.skills) {
    const listed = c.skills.slice(0, MCP_NOTICE_TOOL_CAP).map((s) => {
      const roles = s.roles.length ? s.roles.map((r) => `${datum(r.name, 60)} (${datum(r.slug, 60)})`).join(', ') : 'no role'
      return `${datum(s.name, 140)} for ${roles}`
    })
    const more = c.skills.length > MCP_NOTICE_TOOL_CAP ? `, and ${c.skills.length - MCP_NOTICE_TOOL_CAP} more` : ''
    text += ` Skills in this session now: ${listed.join('; ')}${more}. Agents load one with the Skill tool and its full name, prefix included.`
  }
  return text
}

/** Names of the MCP servers a role may use (mcpServersForRole), root included. */
export function agentMcpServerNames(project: Pick<Project, 'mcpServers'>, role: Pick<Role, 'slug' | 'mcpServers'>): string[] {
  return mcpServersForRole(project, role).map((s) => s.name)
}

/** SDK server configs for the resolved MCP servers, keyed by spec.name. Entries missing their command or url are skipped. */
export function toClaudeMcpServers(resolved: ResolvedMcpServer[]): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {}
  for (const r of resolved) {
    const { spec } = r
    if (spec.transport === 'stdio') {
      if (!spec.command) continue
      out[spec.name] = {
        type: 'stdio',
        command: spec.command,
        ...(spec.args?.length ? { args: [...spec.args] } : {}),
        ...(Object.keys(scrubControlEnv(r.env)).length ? { env: scrubControlEnv(r.env) } : {})
      }
    } else {
      if (!spec.url) continue
      out[spec.name] = {
        type: spec.transport,
        url: spec.url,
        ...(Object.keys(r.headers).length ? { headers: { ...r.headers } } : {})
      }
    }
  }
  return out
}

/** Enabled project plugins as SDK plugin configs. Note: strictMcpConfig also stops plugin-declared MCP servers from loading. */
export function toClaudePlugins(plugins: PluginSpec[] | undefined): SdkPluginConfig[] {
  return (plugins ?? []).filter((p) => p.enabled).map((p) => ({ type: 'local' as const, path: p.path }))
}

/** Secret values to keep out of logs: resolved MCP secrets plus the connection's tokens and key. */
export function collectSecrets(resolved: ResolvedMcpServer[], connection: RuntimeContext['connection']): string[] {
  const out = new Set<string>()
  for (const r of resolved) {
    for (const n of r.spec.secretEnv ?? []) if (r.env[n]) out.add(r.env[n])
    for (const n of r.spec.secretHeaders ?? []) if (r.headers[n]) out.add(r.headers[n])
    // Headers resolve() added (the OAuth bearer) are secrets too, though no secretHeaders entry names them.
    for (const [n, v] of Object.entries(r.headers)) if (v && r.spec.headers?.[n] !== v) out.add(v)
  }
  for (const [k, v] of Object.entries(connection?.env ?? {})) if (v && /TOKEN|KEY|SECRET|PASSWORD/i.test(k)) out.add(v)
  if (connection?.apiKey) out.add(connection.apiKey)
  return [...out].filter((v) => v.length >= 4)
}

/** Replace every secret value in a log line. Longest first so a secret containing another is fully hidden. */
export function redactSecrets(text: string, secrets: Iterable<string>): string {
  let out = text
  for (const v of [...secrets].sort((a, b) => b.length - a.length)) if (v) out = out.split(v).join('***')
  return out
}

/** True when the run reaches its models through a non-anthropic connection (LiteLLM). */
export function usesProxy(ctx: Pick<RuntimeContext, 'connection'>): boolean {
  return !!ctx.connection && ctx.connection.connection !== 'anthropic'
}

/**
 * Links an external signal to a fresh AbortController. Throws 'Completion cancelled' if the signal is already
 * aborted. `dispose` removes the listener.
 */
export function linkAbortSignal(signal: AbortSignal): { controller: AbortController; dispose: () => void } {
  if (signal.aborted) throw new Error('Completion cancelled')
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  return { controller, dispose: () => signal.removeEventListener('abort', onAbort) }
}

export function completionEnv(connection: RunConnection | undefined, base: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  // No connection (drafts): isolated from routing vars, but the legacy inherited key still works.
  if (!connection) return isolateClaudeEnv(base, { keepApiKey: true })
  // The anthropic API key arrives through connection.env; nothing inherited authenticates.
  return { ...isolateClaudeEnv(base, { proxy: connection.connection !== 'anthropic', keepApiKey: false }), ...scrubControlEnv(connection.env ?? {}) }
}

/**
 * Child-process environment: the isolated base (no inherited routing, model or gateway vars, no stray API key),
 * OrgAI's settings, the project's API key on the anthropic path, then the connection's env. A non-anthropic
 * connection authenticates with its own token only.
 */
export function buildEnv(ctx: RuntimeContext, base: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const { project } = ctx
  const proxy = usesProxy(ctx)
  // Explicit project limits win; otherwise derived from the roles this run actually has (setup runs: the Architect's).
  const limits = effectiveSubagentLimits({ ...project, roles: ctx.roles })
  const env: Record<string, string | undefined> = {
    ...isolateClaudeEnv(base, { proxy, keepApiKey: false }),
    CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: String(limits.depth),
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(limits.concurrency),
    // Only org-chart roles may be spawned; drop the SDK's built-in general-purpose default.
    CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1'
  }
  // Bundled skills (and any not granted) must not be offered; set after isolation, which strips CLAUDE_CODE_DISABLE_*.
  // The verified route is the env var (disableBundledSkills is a Settings field, not an Options field).
  if (!isSetupLikeRun(ctx.run.kind)) env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS = '1'
  if (!proxy && project.provider.auth.kind === 'apiKey') {
    const key = base[project.provider.auth.envVar]
    if (key) env.ANTHROPIC_API_KEY = key
  }
  // OrgAI's control variables stay out even when the connection names one (cli-spec 3.4(3)).
  if (ctx.connection?.env) Object.assign(env, scrubControlEnv(ctx.connection.env))
  return env
}

/** Provider auth-failure text safe for the transcript and log: exact secrets redacted, then key-like tokens masked. */
export function authFailureDetail(raw: string, secrets: Iterable<string>): string {
  return scrubAuthDetail(redactSecrets(raw, secrets))
}

/**
 * SDK assistant error codes that mean the credentials are the problem (re-login or fix the key). Only these let
 * the loose text match in isAuthFailure apply. oauth_org_not_allowed is included (the login is rejected for this
 * organization). account_on_hold, verification_required and billing_error are account states, not credentials, and
 * rate_limit, overloaded and the rest are transient or unrelated, so they never end a run as an auth failure.
 */
export const AUTH_ERROR_CODES: ReadonlySet<string> = new Set(['authentication_failed', 'oauth_org_not_allowed', 'cloud_credential_error'])

/**
 * The raw text of an authentication failure in an SDK message, or null when the message is not one. An
 * assistant message with error 'authentication_failed', short CLI auth wording, or a result with is_error.
 * The matcher and wording live in activity.ts.
 */
export function authFailureFrom(msg: SDKMessage): string | null {
  if (msg.type === 'assistant') {
    const text = msg.message.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim()
    return isAuthFailure({ errorCode: msg.error, text, isError: !!msg.error && AUTH_ERROR_CODES.has(msg.error) }) ? text : null
  }
  if (msg.type === 'result' && msg.subtype === 'success') {
    return isAuthFailure({ text: msg.result, isError: msg.is_error }) ? msg.result : null
  }
  return null
}

/**
 * The AgentDefinitions for a run. The root gets every harness tool, a canSpawn role the 'spawners' ones; each
 * role gets a server-level rule and an mcpServers entry for every MCP server granted to it.
 */
export function buildAgents(
  ctx: RuntimeContext,
  harness: Pick<HarnessTool, 'name' | 'audience'>[],
  isolation: boolean,
  mcpSpecs: Pick<Project, 'mcpServers'> = ctx.project,
  /** Run skills actually loaded in the run plugin, keyed by qualified name ("<plugin>:<name>"; empty = none). */
  skills: Map<string, RunSkill> = new Map()
): Record<string, AgentDefinition> {
  const isSetup = isSetupLikeRun(ctx.run.kind)
  const engagementDocument = ctx.engagementDocument?.()
  const agents: Record<string, AgentDefinition> = {}
  for (const role of ctx.roles) {
    const tools: string[] = [...role.tools]
    const isRoot = role.reportsTo === null
    for (const t of harness) if (isRoot || t.audience === 'all' || (role.canSpawn && t.audience === 'spawners')) tools.push(`${ORGAI_TOOL_PREFIX}${t.name}`)
    if (role.canSpawn) tools.push(SPAWN_TOOL)
    // A lead addresses its running reports by handle, so it always gets the messaging tools on work runs.
    if (role.canSpawn && !isSetup) for (const t of [MESSAGE_TOOL, LIST_AGENTS_TOOL]) if (!tools.includes(t)) tools.push(t)
    const mcp = agentMcpServerNames(mcpSpecs, role)
    for (const name of mcp) if (!tools.includes(mcpToolRule(name))) tools.push(mcpToolRule(name))
    // Roles with a grant get the native Skill tool; the PreToolUse gate limits it to their own orgai:<name> skills.
    // AgentDefinition.skills is deliberately not set: it preloads full skill content on every spawn and grants nothing.
    const granted = isSetup ? [] : [...skills.entries()].filter(([, s]) => s.roleIds.includes(role.id))
    if (granted.length && !tools.includes('Skill')) tools.push('Skill')
    const def: AgentDefinition = {
      description: role.description,
      prompt: buildRolePrompt(role, ctx.roles, ctx.project, {
        isSetup,
        isolation,
        ...(ctx.run.quick ? { quick: ctx.run.quick } : {}),
        // Single-agent work runs ('single'): the prompt drops delegation and plan wording.
        ...(ctx.run.team ? { team: ctx.run.team } : {}),
        // The run's allowed directories, so agents know where a plain `cd` and edits need no approval.
        ...(ctx.allowedDirectories?.().length ? { allowedDirectories: ctx.allowedDirectories() } : {}),
        // Read-only reference folders, so agents read them and never try to change them.
        ...(ctx.referenceDirectories?.().length ? { referenceDirectories: ctx.referenceDirectories() } : {}),
        // Engagements: the approved engagement document, read now (a restart rebuilds agents and re-reads it).
        ...(engagementDocument ? { engagementDocument } : {}),
        ...(granted.length ? { skills: granted.map(([q, s]) => ({ name: q, description: s.description })), skillTool: 'Skill' as const } : {})
      }),
      tools,
      model: role.model && validModelId(role.model) ? role.model : 'inherit'
    }
    if (mcp.length) def.mcpServers = mcp
    if (role.effort) def.effort = role.effort
    agents[role.slug] = def
  }
  return agents
}

/** True for a setup-like run whose root role was given write tools (allowBuild MCP assistant). */
function setupRunCanWrite(ctx: RuntimeContext): boolean {
  if (!isSetupLikeRun(ctx.run.kind)) return false
  const root = ctx.roles.find((r) => r.reportsTo === null) ?? ctx.roles[0]
  return !!root && root.tools.some((t) => t === 'Edit' || t === 'Write' || t === 'Bash' || t === 'NotebookEdit')
}

/**
 * Permission mode of a run. Setup-like runs normally never edit and run in acceptEdits (or auto); a setup-like run whose
 * role holds Edit/Write/Bash (allowBuild MCP assistant) and every quick run keep the project's mode ('default'), so each
 * call asks. Nothing here upgrades a quick or build run to auto or acceptEdits.
 */
export function claudePermissionMode(ctx: RuntimeContext): Options['permissionMode'] {
  const mode = ctx.project.permissionMode
  const askOnly = (): Options['permissionMode'] => (mode === 'auto' || mode === 'acceptEdits' || mode === 'bypassPermissions' ? 'default' : mode)
  if (isTrustRestrictedRun(ctx.run)) return askOnly()
  if (isSetupLikeRun(ctx.run.kind)) return setupRunCanWrite(ctx) ? askOnly() : mode === 'auto' ? 'auto' : 'acceptEdits'
  return mode
}

export function claudeAllowsBypass(ctx: RuntimeContext): boolean {
  return !isSetupLikeRun(ctx.run.kind) && !isTrustRestrictedRun(ctx.run) && ctx.project.permissionMode === 'bypassPermissions'
}

/**
 * Whether the CLI loads the working folder's `.claude/settings.json` (settingSources ['project']). Not for a quick run's
 * folder or a build session's scratch dir (trust-restricted), and not for any run of an engagement: its folder is
 * often a client share, so its hooks, rules and MCP servers must not load (OrgAI keeps an engagement's rules in its
 * own data folder, ctx.savedRules). Every reader of that file (claudeSettingSources, cliProjectSettings) uses this.
 */
export function projectSettingsLoad(ctx: Pick<RuntimeContext, 'run' | 'project'>): boolean {
  return !isTrustRestrictedRun(ctx.run) && projectKindOf(ctx.project) !== 'engagement'
}

/** settingSources for a run: ['project'] only when projectSettingsLoad (never for a restricted run or an engagement). */
export function claudeSettingSources(ctx: RuntimeContext): Options['settingSources'] {
  return projectSettingsLoad(ctx) ? ['project'] : []
}

/**
 * Saved "always allow" rules: ctx.savedRules() (wherever the project keeps them; OrgAI's data folder for engagements),
 * else the project folder's file; none for a trust-restricted run (its grants come from allowedRules()).
 */
export function claudeSavedRules(ctx: RuntimeContext): string[] {
  if (isTrustRestrictedRun(ctx.run)) return []
  return ctx.savedRules ? ctx.savedRules() : listRules(ctx.project.path)
}

/**
 * The saved rules handed to the CLI as `options.allowedTools`: every shell rule (`Bash`, `Bash(...)`, `PowerShell`,
 * `PowerShell(...)`) is left out, because the PreToolUse hook evaluates those itself through ruleMatch.ts and the CLI's
 * own prefix match would approve commands the harness refuses (`npm test --script-shell=calc` under
 * `Bash(npm test:*)`, reviewer-4 H-A). Rules the harness cannot evaluate (other tools, content rules) are kept. Pure.
 */
export function cliAllowedTools(rules: readonly string[]): string[] {
  return rules.filter((r) => !isShellRule(r))
}

function isShellRule(rule: string): boolean {
  const r = rule.trim()
  for (const tool of SHELL_TOOLS) if (r === tool || r.startsWith(`${tool}(`)) return true
  return false
}

/** Largest `<project>/.claude/settings.json` the PreToolUse hook reads (review M3); a bigger file counts as unreadable. */
export const CLI_SETTINGS_MAX_BYTES = 256 * 1024

/**
 * `permissions.allow` of `<project>/.claude/settings.json`, which settingSources ['project'] makes the CLI load and
 * match on its own (wrapper and env stripping, mid wildcards, no-space prefixes: shapes ruleMatch.ts does not model).
 * `failed` means the file exists but OrgAI could not read it (not a regular file, a symlink or FIFO, over
 * CLI_SETTINGS_MAX_BYTES, unreadable, not a JSON object): the hook then treats it as holding unknown shell rules.
 */
export interface CliProjectSettings {
  rules: string[]
  failed: boolean
}

const NO_CLI_SETTINGS: CliProjectSettings = { rules: [], failed: false }
const CLI_SETTINGS_FAILED: CliProjectSettings = { rules: [], failed: true }
const cliSettingsCache = new Map<string, { mtimeMs: number; size: number; result: CliProjectSettings }>()

/**
 * Reads `<project>/.claude/settings.json` for the PreToolUse ask check, never as an allow source. The file is untrusted
 * and read synchronously on the main process: lstat first (a symlink, FIFO or directory is refused without opening it),
 * at most CLI_SETTINGS_MAX_BYTES, a leading BOM stripped, cached by path + mtimeMs + size. A missing file (or project
 * path) is no rules. When the CLI does not load the file (projectSettingsLoad false: a trust-restricted run or an
 * engagement, settingSources []) it holds no rules the CLI could apply, so it is not read and forces no 'ask'.
 */
export function cliProjectSettings(ctx: Pick<RuntimeContext, 'run' | 'project'>): CliProjectSettings {
  if (!projectSettingsLoad(ctx) || !ctx.project.path) return NO_CLI_SETTINGS
  const file = join(ctx.project.path, '.claude', 'settings.json')
  let st
  try {
    st = lstatSync(file)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? NO_CLI_SETTINGS : CLI_SETTINGS_FAILED
  }
  if (!st.isFile() || st.size > CLI_SETTINGS_MAX_BYTES) return CLI_SETTINGS_FAILED
  const cached = cliSettingsCache.get(file)
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.result
  const result = readCliSettings(file, st)
  if (cliSettingsCache.size >= 200) cliSettingsCache.clear()
  cliSettingsCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, result })
  return result
}

function readCliSettings(file: string, st: { ino: number; dev: number }): CliProjectSettings {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    // The path may have been swapped between lstat and open: the opened file must be the same regular file.
    const fst = fstatSync(fd)
    if (!fst.isFile() || fst.size > CLI_SETTINGS_MAX_BYTES || fst.ino !== st.ino || fst.dev !== st.dev) return CLI_SETTINGS_FAILED
    const buf = Buffer.alloc(CLI_SETTINGS_MAX_BYTES + 1)
    let len = 0
    for (;;) {
      const n = readSync(fd, buf, len, buf.length - len, null)
      if (n <= 0) break
      len += n
      if (len > CLI_SETTINGS_MAX_BYTES) return CLI_SETTINGS_FAILED
    }
    const text = buf.subarray(0, len).toString('utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return CLI_SETTINGS_FAILED
    const allow = (parsed as { permissions?: { allow?: unknown } }).permissions?.allow
    return { rules: Array.isArray(allow) ? allow.filter((r): r is string => typeof r === 'string') : [], failed: false }
  } catch {
    return CLI_SETTINGS_FAILED
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** The settings.json allow rules only (none when unreadable); see cliProjectSettings. */
export function cliProjectSettingsRules(ctx: Pick<RuntimeContext, 'run' | 'project'>): string[] {
  return cliProjectSettings(ctx).rules
}

/** A rule for this shell tool: bare `Bash` / `PowerShell` or `Tool(...)`. */
function isRuleForTool(rule: string, toolName: string): boolean {
  const r = rule.trim()
  return r === toolName || r.startsWith(`${toolName}(`)
}

/** A rule as it may appear in a reason or a log line: bounded and quoting-safe (review L1). */
function ruleForDisplay(rule: string): string {
  return datum(rule.trim(), 120)
}

/**
 * The PreToolUse 'ask' reason for a shell call that no rule allowed but whose command (or one of its segments) a rule's
 * text appears to cover (ruleMatch.ts `ruleCoversButRefused`): "OrgAI: <rule> does not cover this command (<why>);
 * asking", naming the first such rule. Undefined when no rule covers it. Callers pass rules without hidden characters.
 * Pure.
 */
export function refusedShellReason(toolName: string, input: unknown, rules: readonly string[], opts?: MatchOptions): string | undefined {
  if (!SHELL_TOOLS.has(toolName) || !ruleCoversButRefused(toolName, input, rules, opts)) return undefined
  const rule = rules.find((r) => ruleCoversButRefused(toolName, input, [r], opts)) ?? rules.find((r) => r.trim().startsWith(`${toolName}(`)) ?? toolName
  const command = String((input as { command?: unknown }).command ?? '')
  // The why comes from the segments the rule covers but refuses on their own; none means the rule's segment is fine
  // and some other segment has no rule.
  const shell = toolName === 'PowerShell' ? 'powershell' : 'bash'
  const segments = splitCommand(unwrapShellCommand(command))
    .map((s) => s.trim())
    .filter((s) => s && ruleCoversButRefused(toolName, { command: s }, [rule], opts))
  const why = segments.some((s) => programRunsProgram(s))
    ? 'it can run another program'
    : segments.some((s) => isUnsafeSegment(s, shell))
      ? 'it uses shell syntax or an expansion OrgAI does not approve'
      : 'another part of the command is not covered'
  return `OrgAI: ${ruleForDisplay(rule)} does not cover this command (${why}); asking`
}

/** Reason when settings.json exists but could not be read: every shell call the hook did not allow is asked (M3). */
export const CLI_SETTINGS_UNREADABLE_REASON = "OrgAI could not read this project's .claude/settings.json; asking"

/**
 * The PreToolUse 'ask' reason for a shell call the hook did not allow, from the rules the CLI itself holds: only
 * `<project>/.claude/settings.json` (review M2; settings.local.json is not loaded under settingSources ['project'], and
 * run and session grants never reach the CLI as shell rules). Review M1: the CLI's matcher honours shapes ruleMatch.ts
 * does not model (wrapper and env stripping, `Bash(npm test*)`, `Bash(git * main)`, bare `Bash`), so any rule for the
 * called tool makes every such call ask, unless ruleMatch itself accepts the command under one of those `Tool(...)`
 * rules (the CLI's approval is then one OrgAI would give too, so undefined: the call goes on). An unreadable file asks
 * for every call (M3). Undefined when the file holds no rule for the tool. A rule with a hidden character counts but is
 * never named or matched (L1). Pure apart from its input.
 */
export function cliShellAskReason(toolName: string, input: unknown, settings: CliProjectSettings, opts?: MatchOptions): string | undefined {
  if (!SHELL_TOOLS.has(toolName)) return undefined
  if (settings.failed) return CLI_SETTINGS_UNREADABLE_REASON
  const forTool = settings.rules.filter((r) => isRuleForTool(r, toolName))
  if (!forTool.length) return undefined
  const clean = forTool.filter((r) => !hiddenCharIn(r))
  const scoped = clean.filter((r) => r.trim().startsWith(`${toolName}(`))
  if (scoped.length && matchingRule(toolName, input, scoped, opts) !== undefined) return undefined
  const specific = refusedShellReason(toolName, input, scoped, opts)
  if (specific) return specific
  const named = clean[0]
  return named
    ? `OrgAI: this project's .claude/settings.json allows ${ruleForDisplay(named)}, which OrgAI cannot check for this command; asking`
    : `OrgAI: this project's .claude/settings.json has a ${toolName} rule OrgAI cannot check for this command; asking`
}

/**
 * Options.additionalDirectories for a run: RuntimeContext.allowedDirectories() plus referenceDirectories() read now,
 * deduped (both absent on trust-restricted runs = none; a restricted run gets none here either way). The CLI treats
 * them like the cwd for read-only `cd` and acceptEdits (docs; unverified live); reference folders are kept read-only
 * by the PreToolUse reference gate, which runs before any allow path, acceptEdits included.
 */
export function claudeAdditionalDirectories(ctx: Pick<RuntimeContext, 'allowedDirectories' | 'referenceDirectories' | 'run'>): string[] {
  if (isTrustRestrictedRun(ctx.run)) return []
  const out: string[] = []
  for (const d of [...(ctx.allowedDirectories?.() ?? []), ...(ctx.referenceDirectories?.() ?? [])]) {
    if (typeof d === 'string' && d.length > 0 && !out.includes(d)) out.push(d)
  }
  return out
}

/**
 * What a 'project' scope may persist besides rules: the ctx hooks bound to ctx, each left out when absent. Restricted
 * runs never get there (quickSafeDecision turns project into session) and RunManager leaves the hooks out on them.
 */
export function allowScopePersist(ctx: RuntimeContext): AllowScopePersist {
  return {
    ...(ctx.allowDirectories ? { allowDirectories: (dirs: string[]) => ctx.allowDirectories!(dirs) } : {}),
    ...(ctx.acceptEditsForProject ? { acceptEditsForProject: () => ctx.acceptEditsForProject!() } : {}),
    ...(ctx.saveProjectRules ? { saveProjectRules: (rules: string[]) => ctx.saveProjectRules!(rules) } : {})
  }
}

/**
 * Card suggestions for a run: a trust-restricted run (quick run, build session) never gets a setMode suggestion, so
 * "allow for session" cannot switch it to acceptEdits and it stays ask-only.
 */
export function restrictedSafeSuggestions(ctx: Pick<RuntimeContext, 'run'>, suggestions: PermissionSuggestion[]): PermissionSuggestion[] {
  return isTrustRestrictedRun(ctx.run) ? suggestions.filter((s) => s.type !== 'setMode') : suggestions
}

/**
 * MCP servers whose tool cards may offer the server-level rule `mcp__<server>` (SuggestOptions.userMcpServers): the
 * run's enabled servers by the name in their tool prefix (the mcpServers record key), minus every server an agent
 * installed this run (review M3: those keep exact tool rules) and never the harness's own `orgai`.
 */
export function userMcpServerNames(live: readonly McpServerSpec[], agentInstalled: ReadonlySet<string>): string[] {
  const out = new Set<string>()
  for (const s of live) if (s.enabled && s.name !== ORGAI_MCP && !agentInstalled.has(s.name)) out.add(s.name)
  return [...out]
}

/** A quick or build run's "project" scope becomes "session": nothing is ever written into the user's folder. */
export function quickSafeDecision(
  ctx: RuntimeContext,
  decision: Extract<PermissionDecision, { behavior: 'allow' }>
): Extract<PermissionDecision, { behavior: 'allow' }> {
  return isTrustRestrictedRun(ctx.run) && decision.scope === 'project' ? { ...decision, scope: 'session' } : decision
}

const BUILD_CONFIG_WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
export const BUILD_CONFIG_DENY = 'Build sessions cannot write OrgAI or Claude settings under .claude/ in the workspace.'

/** Deny reason when a build session's file tool targets <workspace>/.claude (a missing path is denied too); undefined otherwise. */
export function buildConfigWriteDenial(run: Pick<RunSummary, 'buildWorkspace'>, toolName: string, toolInput: unknown): string | undefined {
  const ws = run.buildWorkspace
  if (!ws || !BUILD_CONFIG_WRITE_TOOLS.has(toolName)) return undefined
  const i = (toolInput ?? {}) as Record<string, unknown>
  const target = toolName === 'NotebookEdit' ? (i.notebook_path ?? i.file_path) : (i.file_path ?? i.notebook_path)
  return isWorkspaceConfigPath(ws, target) || typeof target !== 'string' || !target ? BUILD_CONFIG_DENY : undefined
}

/**
 * Who called a harness tool. PreToolUse sees every call with its tool_use_id and agent_id (absent for the
 * root); the MCP handler may only see the tool name, so calls are matched by tool_use_id when the handler's
 * request metadata carries it, otherwise first-in-first-out per tool name.
 */
export class HarnessCallerTracker {
  private byToolUse = new Map<string, string | undefined>()
  private queues = new Map<string, Array<{ toolUseId?: string; agentId?: string }>>()

  /** Record a PreToolUse sighting. agentId is the SDK agent id (undefined for the root). */
  record(toolName: string, toolUseId: string | undefined, agentId: string | undefined): void {
    if (toolUseId) this.byToolUse.set(toolUseId, agentId)
    this.queues.set(toolName, [...(this.queues.get(toolName) ?? []), { toolUseId, agentId }])
  }

  /** Resolve and consume the caller; undefined means the root (or unknown). Never throws. */
  resolve(toolName: string, meta?: unknown): string | undefined {
    try {
      const id = toolUseIdFromMeta(meta)
      const queue = this.queues.get(toolName) ?? []
      if (id && this.byToolUse.has(id)) {
        const agentId = this.byToolUse.get(id)
        this.byToolUse.delete(id)
        const i = queue.findIndex((e) => e.toolUseId === id)
        if (i >= 0) queue.splice(i, 1)
        return agentId
      }
      const next = queue.shift()
      if (next?.toolUseId) this.byToolUse.delete(next.toolUseId)
      return next?.agentId
    } catch {
      return undefined
    }
  }
}

/** Pull a tool_use id out of MCP request _meta (key name unverified at runtime). */
export function toolUseIdFromMeta(meta: unknown): string | undefined {
  if (!meta || typeof meta !== 'object') return undefined
  const m = meta as Record<string, unknown>
  for (const key of ['claudecode/toolUseId', 'toolUseId', 'tool_use_id']) {
    const v = m[key]
    if (typeof v === 'string' && v) return v
  }
  return undefined
}

/** The in-process harness server inside built options (mcpServers.orgai). */
function harnessServerOf(options: Options): McpSdkServerConfigWithInstance | undefined {
  const s = options.mcpServers?.[ORGAI_MCP]
  return s && s.type === 'sdk' ? (s as McpSdkServerConfigWithInstance) : undefined
}

/** The harness's tools as an in-process MCP server; the model sees them as mcp__orgai__<name>. */
function buildHarnessServer(tools: HarnessTool[], callers: HarnessCallerTracker, instructions?: string): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: ORGAI_MCP,
    version: '1.0.0',
    ...(instructions ? { instructions } : {}),
    tools: tools.map((t) =>
      tool(t.name, t.description, t.inputSchema.shape, async (args, extra) => {
        const agentId = callers.resolve(ORGAI_TOOL_PREFIX + t.name, (extra as { _meta?: unknown } | undefined)?._meta)
        return { content: [{ type: 'text' as const, text: await t.call(args, agentId ? { agentId } : undefined) }] }
      })
    )
  })
}

/** Appended to the deny text an agent gets for an edit under a reference folder (referenceFolderMessage stays as is). */
export const REFERENCE_COPY_HINT = '; write a copy in the working folder instead'

function permissionKey(toolName: string, input: unknown): string {
  try {
    return `${toolName}\u0000${JSON.stringify(input ?? {})}`
  } catch {
    return toolName
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

export class ClaudeSession implements RuntimeSession {
  readonly finished: Promise<void>
  private input = new PushStream<SDKUserMessage>()
  private abort = new AbortController()
  private q!: Query
  private agents = new Map<string, AgentInstance>()
  /** tool_use id -> agent that issued it */
  private toolUseIssuer = new Map<string, string>()
  /** Agent tool_use id -> spawned task/agent id */
  private taskByToolUse = new Map<string, string>()
  /** tool name -> last agent seen requesting it (permission attribution fallback) */
  private lastToolAgent = new Map<string, string>()
  /**
   * tool name + input -> agents that issued exactly that call and have not been through
   * canUseTool yet. PreToolUse fires before the permission check and carries agent_id;
   * canUseTool carries neither an agent nor a tool_use id, so the call is matched by content.
   */
  private pendingPermissionIssuers = new Map<string, string[]>()
  private harnessCallers = new HarnessCallerTracker()
  private rolesBySlug: Map<string, Role>
  private root: Role
  private isSetup: boolean
  /** Writing reports get their own git worktree. Only for work runs inside a git repository. */
  private isolation: boolean
  /** Agent tool_use ids that were given isolation:"worktree" -> the spawning agent's id (ROOT_ID for the orchestrator). */
  private isolatedSpawns = new Map<string, string>()
  /** Commits and merges isolated reports' branches; tells the orchestrator through notifyOrchestrator. */
  private integrator: WorktreeIntegrator
  private sessionLogged = false
  /** The in-process harness MCP server; kept so setMcpServers can send it again. */
  private harnessServer?: McpSdkServerConfigWithInstance
  /** Secret values (MCP env/headers, connection tokens) redacted from logged lines. Never emitted. */
  private secrets = new Set<string>()
  /** Generates report handles (implementer-1, implementer-2) for spawns that did not name themselves. */
  private handles = new HandleNamer()
  /** Agent tool_use id -> the handle the report was spawned with; stored on the agent at task_started. */
  private spawnHandles = new Map<string, string>()
  /** agent id -> message id -> latest usage, so streamed and re-sent messages are counted once. */
  private usageByMessage = new Map<string, Map<string, { input: number; output: number; model?: string; mix: TokenMix }>>()
  /** Per-model USD rates from the latest result message; applied to new tokens until the next result. */
  private costRates: CostRates | null = null
  private lastPricedTotal = -1
  /** Streamed text per agent, throttled into agent.partial events. */
  private partial = new PartialText((agentId, text) => this.emit({ type: 'agent.partial', runId: this.ctx.run.id, agentId, text }))
  private seenBlocks = new Set<string>()
  private seenToolUses = new Set<string>()
  /** `agentId:messageId` pairs already counted as a turn. */
  private turnIds = new Set<string>()
  /** Resumed sessions only: tool results already shown, in case the SDK replays history. */
  private seenToolResults = new Set<string>()
  /** Resumed sessions only: subtracted from the SDK's cumulative cost; null until the first result. */
  private resumeCostBase: number | null = null
  // ---------- subscription usage ----------
  private authMode: AuthMode
  /** The automatic plan guard's one "now active" log line was written (planGuardArmed). */
  private planGuardAutoLogged = false
  private usage: UsageStatus | null = null
  private usageTimer: ReturnType<typeof setInterval> | null = null
  private usageUnavailableLogged = false
  /** This run's share of the five-hour window, for project.maxWindowShare. */
  private share: ShareTracker | null = null
  private capTripped = false
  /** Why the window cap stopped the run; sent to the orchestrator with the user's next message. */
  private pendingCapNote: string | null = null
  /** Set once the provider rejected a request on a usage limit. */
  private limited = false
  private ending = false
  /** The CLI refused the credentials; the run ends 'error' with a readable message. */
  private authFailed = false
  /** Unattended execution: re-engages the orchestrator when a turn ends with plan steps left. */
  private continuation: ContinuationDriver
  /** The run-scoped orgai skills plugin of the current query (work runs with granted skills). */
  private skillPlugin?: SkillPlugin
  /**
   * Every skill plugin this session built. A config change may rebuild the plugin for a restart: the replaced one is
   * removed once a query using another has sent its init (retirePlugins), and all of them at stop and teardown.
   */
  private plugins = new Set<SkillPlugin>()
  /** A plugin maybeRestartForMcp built and has not handed to a next query or dropped yet. */
  private pluginInFlight?: SkillPlugin
  /** Approved config changes waiting for a restart (pendingMcp holds the servers whose tools are announced). */
  private pendingConfig: RestartConfig & { due: boolean } = { due: false, regranted: [], removed: [], skills: false }
  /** Counts configChanged calls, so a restart built before a later change leaves that change pending. */
  private configGen = 0
  /** Server name -> mcpDefinitionKey as this session last saw it: a new or changed definition counts as installed this run. */
  private knownDefs = new Map<string, string>()
  /** The whitelists of the running query, and of the live config as of the latest config change. */
  private queryGrants?: GrantSnapshot
  private liveGrants?: GrantSnapshot
  /** Built options -> their whitelists, read when that query starts. */
  private optionGrants = new WeakMap<Options, GrantSnapshot>()
  /** Skill tool_use ids the gate allowed, until PostToolUse confirms the call ran (then skill.used is emitted). */
  private gatedSkillCalls = new Map<string, { agentId: string; skill: RunSkill }>()
  /** The harness tools of this run, bound once (prepare()); a restart re-serves the same tools. */
  private harnessTools: HarnessTool[] = []
  /** Harness tool name -> audience, for the PreToolUse MCP gate. */
  private harnessAudiences = new Map<string, HarnessToolAudience>()
  /** The SDK session id from init; a restart resumes it. */
  private sessionId?: string
  /** Interrupted by the user (until their next message). An MCP restart never fires while held. */
  private held = false
  /** MCP servers attached with setMcpServers whose tools reach the agents only after a restart: name -> tool names. */
  private pendingMcp = new Map<string, string[]>()
  private restarting = false
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private restartCloseTimer: ReturnType<typeof setTimeout> | null = null
  /** Options of the query that replaces the current one once it has ended (an MCP restart). */
  private nextQuery?: NextQuery
  /** Queries re-created for MCP restarts so far. */
  private restarts = 0
  /** The latest restart's servers and their tool names (a retried restart announces them again). */
  private lastRestart: Omit<NextQuery, 'options' | 'dropped' | 'droppedSkills'> = { servers: [], tools: new Map() }
  /** The latest restart (or its fallback) came from a config change: the pause wording names that. */
  private restartForConfig = false
  /** Restarted queries that failed before their init since the last one that started (reset at init). */
  private restartFailures = 0
  /** Servers left out of every later query after a restart with them could not start. */
  private droppedMcp = new Set<string>()
  /** The latest successful turn end was held back from the continuation driver because an MCP restart was due. */
  private turnEndDeferred = false
  /** Every server attached mid-run through addMcpServer (agent installs): server-level rules never approve them. */
  private attachedMcp = new Set<string>()
  /**
   * Allow rules granted from a card for the rest of this session (session and project scope). Non-shell ones also go to
   * the CLI as updatedPermissions (shell rules never do, review H1), but the PreToolUse hook matches them itself (ruleMatch.ts), so a per-segment shell grant or
   * a server-level `mcp__<server>` grant holds whatever the CLI's own matcher does, and survives a restarted query.
   */
  private sessionRules = new Set<string>()
  /**
   * tool_use id (and permissionKey + agent as the fallback) -> the reference folder touch the PreToolUse hook found for
   * a shell call it asked about (null folder: the list could not be read), so canUseTool's card names the folder even
   * when the hook's cwd differs from the fallback cwd canUseTool has. Taken by canUseTool, dropped at PostToolUse
   * (review L6: identical calls from different agents never take each other's finding). At most 100 entries.
   */
  private referenceTouches = new Map<string, { folder: string | null; alt?: string; id?: string }>()
  /** permissionKey -> edit calls the PreToolUse hook refused under a reference folder (their refusal row is written). */
  private refusedEdits = new Map<string, number>()
  /** Open non-subagent tasks (task_started with another task_type) until their notification: restart blockers. */
  private backgroundTasks = new Set<string>()
  /**
   * Harness messages pushed to the input, by kind. When an interrupt holds the run across a restart, unread plan nudges
   * are dropped and other unread harness notices wait for the user's next message (dropHeldHarnessMessages).
   */
  private harnessMessages = new WeakMap<SDKUserMessage, { nudge: boolean; text: string; restart?: boolean }>()
  /** Attach notices that arrived while the run was held: prepended to the user's next message. */
  private heldNotices: string[] = []
  /** The session ended paused (a restarted query could not start); emitEnd is skipped. */
  private pausedEnd = false
  /** The current query has emitted its init message. */
  private queryInitSeen = false
  /**
   * Every message the current query may have read before its init (review N2): what was queued when it started plus
   * everything pushed since. A restarted query that dies before init may have read some of them; recoverRestart
   * re-pushes them into the fresh stream. Cleared at init, so nothing is delivered twice.
   */
  private preInit: SDKUserMessage[] = []
  /** Cost of this run reported by earlier queries of the session (restarts), and the SDK total last seen. */
  private priorQueriesCost = 0
  private lastRunCost = 0
  private lastSdkTotal = 0
  private prevQuerySdkTotal = 0

  constructor(private ctx: RuntimeContext) {
    const root = ctx.roles.find((r) => r.reportsTo === null) ?? ctx.roles[0]
    if (!root) throw new Error('Project has no roles')
    this.root = root
    this.isSetup = isSetupLikeRun(ctx.run.kind)
    this.isolation = !this.isSetup && isolateWritersOn(ctx.project) && isGitRepo(ctx.project.path)
    this.rolesBySlug = new Map(ctx.roles.map((r) => [r.slug, r]))
    // A proxy connection (LiteLLM) has no subscription plan windows: treat it like an API key.
    this.authMode = usesProxy(ctx) || ctx.project.provider.auth.kind === 'apiKey' ? 'apiKey' : 'unknown'
    this.integrator = new WorktreeIntegrator(ctx, {
      agent: (id) => this.agents.get(id),
      setWorktree: (id, info) => {
        const a = this.agents.get(id)
        if (!a) return
        a.worktree = info
        this.upsert(a)
      },
      notify: (text) => this.notifyOrchestrator(text)
    })
    this.continuation = new ContinuationDriver({
      kind: ctx.run.kind,
      projectKind: projectKindOf(ctx.project),
      autoContinue: ctx.autoContinue,
      maxAutoContinues: ctx.maxAutoContinues,
      delayMs: ctx.continuationDelayMs,
      getPlan: () => ctx.getPlan(),
      updatePlan: (plan) => ctx.updatePlan(plan),
      liveReports: () => [...this.agents.values()].filter((a) => a.id !== ROOT_ID && a.state !== 'done' && a.state !== 'error').length,
      pendingInteractions: () => ctx.pendingInteractions(),
      rateLimited: () => this.limited,
      // A window-cap stop waits for the user like an interrupt does.
      stopping: () => this.ending || this.capTripped || this.abort.signal.aborted,
      orchestratorBusy: () => {
        const root = this.agents.get(ROOT_ID)
        return !!root && root.state !== 'idle' && root.state !== 'done'
      },
      nudge: (text, activity, summary) => {
        this.notifyOrchestrator(text, activity, { summary, nudge: true })
        this.emit({ type: 'run.status', runId: this.ctx.run.id, status: 'running' })
      },
      log: (level, message) => this.log(level, message),
      tellUser: (text) => this.transcript(ROOT_ID, { kind: 'system', text }, { source: 'harness' })
    })
    this.finished = this.run()
  }

  // ---------- public API ----------

  async send(text: string, images?: ImageAttachment[]): Promise<void> {
    this.continuation.userMessage()
    this.held = false
    // After a window-cap stop, the orchestrator learns why with the user's next message, and the cap
    // measures afresh from here.
    // Attach notices that arrived while the run was held come with it too.
    const notes = [this.pendingCapNote, ...this.heldNotices.splice(0)].filter((n): n is string => !!n)
    const note = notes.length ? notes.join('\n\n') : null
    this.pendingCapNote = null
    if (this.capTripped) {
      this.capTripped = false
      this.share = null
    }
    const composed = note ? (text ? `${note}\n\n---\n${text}` : note) : text
    this.pushInput({
      type: 'user',
      message: { role: 'user', content: userContent(composed, images) },
      parent_tool_use_id: null
    })
    this.transcript(ROOT_ID, userBlock(text, images))
    this.setState(ROOT_ID, 'thinking', 'Thinking…')
  }

  async interrupt(): Promise<void> {
    // An interrupted turn waits for the user; no automatic continue (and no MCP restart) until they reply.
    this.continuation.hold()
    this.held = true
    try {
      await this.q?.interrupt()
    } catch (e) {
      this.log('warn', `Interrupt failed: ${(e as Error).message}`)
    }
  }

  /** A message from another run's orchestrator. RunManager writes the transcript block, so none is written here. */
  async receive(message: PeerMessage): Promise<void> {
    if (this.abort.signal.aborted) return
    this.notifyOrchestrator(peerMessageText(message), 'Reading a message from another run…', { transcript: false })
  }

  async stop(): Promise<void> {
    this.continuation.dispose()
    this.clearRestartTimers()
    this.stopUsagePolling()
    this.input.end()
    this.abort.abort()
    this.cleanupPlugins()
  }

  // ---------- internals ----------

  private emit(e: RunEvent): void {
    this.ctx.emit(e)
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.emit({ type: 'log', runId: this.ctx.run.id, level, message })
  }

  private transcript(agentId: string, block: TranscriptBlock, opts?: { source?: 'harness' }): void {
    this.emit({
      type: 'transcript',
      runId: this.ctx.run.id,
      entry: { id: newId('t'), agentId, at: Date.now(), block, ...(opts?.source ? { source: opts.source } : {}) }
    })
  }

  private upsert(agent: AgentInstance): void {
    this.agents.set(agent.id, agent)
    this.emit({ type: 'agent.upsert', runId: this.ctx.run.id, agent: { ...agent, ...(agent.usage ? { usage: structuredClone(agent.usage) } : {}) } })
  }

  private ensureAgent(id: string, init?: Partial<AgentInstance>): AgentInstance {
    let a = this.agents.get(id)
    if (!a) {
      const slug = init?.roleSlug ?? 'general-purpose'
      const role = this.rolesBySlug.get(slug)
      a = {
        id,
        roleId: role?.id ?? null,
        roleSlug: slug,
        name: role?.name ?? slug,
        parentId: id === ROOT_ID ? null : ROOT_ID,
        spawnToolUseId: null,
        state: 'starting',
        activity: 'Starting…',
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        startedAt: Date.now(),
        ...init
      }
      this.upsert(a)
    }
    return a
  }

  private setState(id: string, state: AgentInstance['state'], activity?: string): void {
    const a = this.ensureAgent(id)
    a.state = state
    if (activity !== undefined) a.activity = activity
    if (state === 'done' || state === 'error') a.endedAt = Date.now()
    this.upsert(a)
  }

  /**
   * Split the run's cost across agents: per-model rates come from the result's cumulative modelUsage,
   * each agent pays for its own token mix at those rates. Emits agent.upsert for every agent whose cost moved.
   */
  private apportionCost(modelUsage: Record<string, ModelUsage> | undefined): void {
    const rates = ratesFromModelUsage(modelUsage)
    if (!rates) return
    this.costRates = rates
    for (const [agentId, perAgent] of this.usageByMessage) {
      const a = this.agents.get(agentId)
      if (!a) continue
      const cost = this.agentCost(perAgent.values())
      const before = JSON.stringify(a.usage?.models.map((m) => m.providerCostUsd))
      this.syncModelUsage(a, perAgent)
      if (Math.abs(cost - a.costUsd) < 1e-9 && before === JSON.stringify(a.usage?.models.map((m) => m.providerCostUsd))) continue
      a.costUsd = cost
      this.upsert(a)
    }
  }

  /**
   * Report the agent's per-model token sums. providerCostUsd is only the CLI/SDK-derived cost (costRates); a model
   * priced from LiteLLM's catalog gets none, RunManager prices it from RunConnection.pricing.
   */
  private syncModelUsage(a: AgentInstance, perAgent: Map<string, { model?: string; mix: TokenMix }>): void {
    const pricing = this.litellmPricing()
    for (const [model, e] of sumByModel(perAgent.values(), this.costRates, a.model)) {
      const cost = pricing && priceFor(pricing, model) ? undefined : e.costUsd ?? undefined
      setModelTokens(a, model, { input: e.mix.input, output: e.mix.output, cacheRead: e.mix.cacheRead, cacheWrite: e.mix.cacheCreation }, cost)
    }
  }

  /** Per-token prices when this run goes through LiteLLM with a priced catalog, else undefined. */
  private litellmPricing() {
    const c = this.ctx.connection
    return c?.connection === 'litellm' ? c.pricing : undefined
  }

  /**
   * Cost of an agent's messages. With LiteLLM pricing each message is priced from its model's per-token price;
   * a model without a price falls back to the CLI-derived rates, else 0. Otherwise the CLI rates apply.
   */
  private agentCost(messages: Iterable<{ model?: string; mix: TokenMix }>): number {
    const pricing = this.litellmPricing()
    if (!pricing) return this.costRates ? costOf(messages, this.costRates) : 0
    let usd = 0
    for (const m of messages) {
      const price = priceFor(pricing, m.model)
      if (price) usd += costFromPrice(m.mix, price)
      else if (this.costRates) usd += weighted(m.mix) * rateFor(this.costRates, m.model)
    }
    return usd
  }

  /** LiteLLM with pricing: the run total is the sum of this run's agent costs. Emits run.cost when it moves. */
  private emitPricedTotal(): number {
    let total = 0
    for (const perAgent of this.usageByMessage.values()) total += this.agentCost(perAgent.values())
    if (Math.abs(total - this.lastPricedTotal) > 1e-12) {
      this.lastPricedTotal = total
      this.emit({ type: 'run.cost', runId: this.ctx.run.id, totalCostUsd: total })
    }
    return total
  }

  /** Queue a harness message for the orchestrator; it starts a new turn if the orchestrator is idle. */
  private notifyOrchestrator(
    text: string,
    activity = 'Integrating a report…',
    opts: { transcript?: boolean; summary?: string; nudge?: boolean; restart?: boolean } = {}
  ): void {
    const message: SDKUserMessage = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }
    this.harnessMessages.set(message, { nudge: !!opts.nudge, text, ...(opts.restart ? { restart: true } : {}) })
    this.pushInput(message)
    if (opts.transcript !== false) {
      this.transcript(ROOT_ID, { kind: 'system', text: opts.summary ?? text, ...(opts.summary ? { detail: text } : {}) }, { source: 'harness' })
    }
    const root = this.agents.get(ROOT_ID)
    if (root && (root.state === 'idle' || root.state === 'done')) this.setState(ROOT_ID, 'thinking', activity)
  }

  /** Push to the current input stream; before the query's init the message is also kept for a restart replay (N2). */
  private pushInput(message: SDKUserMessage): void {
    this.input.push(message)
    if (!this.queryInitSeen) this.preInit.push(message)
  }

  /** An agent called SendMessage: draw it on the canvas and keep a copy in the sender's transcript. */
  private onAgentMessage(fromId: string, toolInput: Record<string, unknown>): void {
    const m = mapSendMessage(fromId, toolInput, this.agents.values())
    if (!m) return
    this.emit({ type: 'agent.message', runId: this.ctx.run.id, ...m })
    this.transcript(fromId, { kind: 'system', text: messageTranscriptText(m) })
  }

  /** Pop the issuer of a pending call. With an agent id, removes that agent's entry; otherwise the oldest. */
  private takeIssuer(key: string, agentId?: string): string | undefined {
    const queue = this.pendingPermissionIssuers.get(key)
    if (!queue?.length) return undefined
    const idx = agentId ? queue.indexOf(agentId) : 0
    if (idx === -1) return undefined
    const [issuer] = queue.splice(idx, 1)
    if (!queue.length) this.pendingPermissionIssuers.delete(key)
    return issuer
  }

  private resolveAgentId(msg: { agent_id?: string; parent_tool_use_id: string | null }): string {
    if (msg.agent_id) return msg.agent_id
    if (msg.parent_tool_use_id) return this.taskByToolUse.get(msg.parent_tool_use_id) ?? ROOT_ID
    return ROOT_ID
  }

  // ---------- subscription usage ----------

  private startUsagePolling(): void {
    if (this.usageTimer) return
    if (this.authMode === 'apiKey') {
      // API keys have no plan windows; say so once so the meter can show it.
      if (!this.usage) this.applyUsage(mapUsageResponse(null, 'apiKey'))
      return
    }
    void this.pollUsage()
    this.usageTimer = setInterval(() => void this.pollUsage(), USAGE_POLL_MS)
  }

  private stopUsagePolling(): void {
    if (this.usageTimer) clearInterval(this.usageTimer)
    this.usageTimer = null
  }

  /** Ask the SDK for plan usage. The method is experimental: missing or failing means "unavailable", never a run error. */
  private async pollUsage(): Promise<void> {
    let resp: UsageResponseLike | null = null
    try {
      const fn = (this.q as unknown as Record<string, unknown> | undefined)?.[USAGE_METHOD]
      if (typeof fn !== 'function') throw new Error('this SDK has no usage method')
      resp = (await (fn as (o: { skipBehaviors: boolean }) => Promise<unknown>).call(this.q, { skipBehaviors: true })) as UsageResponseLike
    } catch (e) {
      if (!this.usageUnavailableLogged) {
        this.usageUnavailableLogged = true
        this.log('info', `Plan usage is unavailable: ${(e as Error).message}`)
      }
    }
    if (this.ending && !this.usageTimer) return
    const report = mapUsageResponse(resp, this.authMode)
    if (report.available && this.authMode === 'unknown') this.authMode = 'subscription'
    this.applyUsage(mergeUsage(this.usage, report))
  }

  private applyUsage(usage: UsageStatus): void {
    this.usage = usage
    this.emit({ type: 'usage.status', runId: this.ctx.run.id, usage })
    this.checkWindowShare()
    this.planGuardArmed()
  }

  /**
   * Whether the plan guard may steer spawns in this run: never on setup runs, proxies or API keys; otherwise
   * planGuardOf / planGuardEngaged over the latest usage report (probe merged with rate_limit_event). Under 'auto'
   * the first time it engages writes one run log line.
   */
  private planGuardArmed(): boolean {
    if (this.isSetup || usesProxy(this.ctx) || this.authMode === 'apiKey') return false
    const mode = planGuardOf(this.ctx.project)
    if (!planGuardEngaged(mode, this.usage)) return false
    if (mode === 'auto' && !this.planGuardAutoLogged) {
      this.planGuardAutoLogged = true
      const threshold = this.ctx.opusGuardThreshold ?? DEFAULT_OPUS_GUARD
      this.log('info', `Plan guard is automatic and now active: this plan reports a weekly limit, so new deep and top reports move to the everyday tier at ${threshold}% of it.`)
    }
    return true
  }

  /** project.maxWindowShare: interrupt the run once it has used that many points of the five-hour window. */
  private checkWindowShare(): void {
    const cap = this.ctx.project.maxWindowShare
    const util = this.usage?.windows.fiveHour?.utilization
    if (this.isSetup || !cap || typeof util !== 'number') return
    this.share = trackShare(this.share, util)
    if (this.capTripped || !windowShareExceeded(0, shareUsed(this.share), cap)) return
    this.capTripped = true
    const used = Math.round(shareUsed(this.share))
    this.log('warn', `This run used ${used}% of the five-hour usage window (cap ${cap}%); interrupting it.`)
    void this.interrupt()
    const note =
      `[OrgAI harness] The run was interrupted because it used ${used}% of the plan's five-hour usage window, ` +
      `above the project's cap of ${cap}%. Reports in flight may have been cut off. Pick up from where things stand, ` +
      'and keep the remaining work lean.'
    this.pendingCapNote = note
    this.transcript(ROOT_ID, { kind: 'system', text: note }, { source: 'harness' })
    this.setState(ROOT_ID, 'idle', `Stopped: used ${used}% of the five-hour window`)
    this.emit({ type: 'run.status', runId: this.ctx.run.id, status: 'idle' })
  }

  /** The provider rejected a request on a usage limit. The session ends at the next result and the run pauses. */
  private onRateLimited(until: number | undefined, window: string | undefined): void {
    if (this.authMode === 'apiKey') return
    if (!this.limited) {
      this.limited = true
      const when = until ? new Date(until).toLocaleString() : 'unknown'
      this.log('warn', `Usage limit reached${window ? ` (${window.replace(/_/g, ' ')} window)` : ''}; resets ${when}. The run pauses and continues then.`)
    }
    this.ctx.rateLimited({ ...(until ? { until } : {}), ...(window ? { window } : {}) })
  }

  /** The everyday model to spawn this report on instead of its deep/top one while the weekly window is near its limit, if any. */
  private steerToEveryday(target: Role | undefined, toolInput: Record<string, unknown>): { from: string; to: string } | undefined {
    if (!this.planGuardArmed()) return undefined
    const explicit = typeof toolInput.model === 'string' && validModelId(toolInput.model) ? toolInput.model : undefined
    let model = explicit ?? (target?.model && validModelId(target.model) ? target.model : 'inherit')
    if (model === 'inherit') model = this.root.model && this.root.model !== 'inherit' ? this.root.model : (this.agents.get(ROOT_ID)?.model ?? '')
    const tierModels = this.ctx.connection?.tierModels
    const deep = target?.tier === 'deep' || target?.tier === 'top' || isDeepOrTopModel(model, tierModels)
    if (!deep || !shouldSteerToEveryday(this.usage, this.ctx.opusGuardThreshold ?? DEFAULT_OPUS_GUARD)) return undefined
    const to = everydayReplacement(tierModels)
    if (!to || to === model) return undefined
    return { from: model || 'its configured model', to }
  }

  /** The run's reference folders now (live): undefined when the run has no list, 'unreadable' when reading it throws. */
  private referenceList(): string[] | 'unreadable' | undefined {
    if (!this.ctx.referenceDirectories) return undefined
    try {
      return this.ctx.referenceDirectories().filter((r) => typeof r === 'string' && r.length > 0)
    } catch (e) {
      this.log('warn', `Could not read the run's reference folders: ${(e as Error).message}`)
      return 'unreadable'
    }
  }

  /**
   * matchOptionsFor(ctx) now, or null when a folder list (allowed, reference, protected) cannot be read (review L1):
   * the hook then asks for a shell call and gives other tools no rule allow, and canUseTool's card has no suggestions
   * (shell: an allow grants this call only). Never a rejected promise.
   */
  private safeMatchOptions(toolName: string): MatchOptions | null {
    try {
      return matchOptionsFor(this.ctx)
    } catch (e) {
      this.log('warn', `Could not read the run's folders for ${toolName}, so it needs your approval: ${(e as Error).message}`)
      return null
    }
  }

  /**
   * Where the hook stashes a reference finding: the tool_use id when the SDK gives one (canUseTool's
   * permOptions.toolUseID is the same id; sdk.d.ts 0.3.312 CanUseTool options, typings only), else the call's
   * permissionKey plus the agent.
   */
  private referenceTouchKey(permKey: string, agentId: string): string {
    return `key\u0000${permKey}\u0000${agentId}`
  }

  /** Stash a hook finding for canUseTool, under the tool_use id and the key + agent fallback (newest 100 calls kept). */
  private stashReferenceTouch(toolUseId: string | undefined, permKey: string, agentId: string, folder: string | null): void {
    const alt = this.referenceTouchKey(permKey, agentId)
    const id = typeof toolUseId === 'string' && toolUseId ? `id\u0000${toolUseId}` : undefined
    for (const k of [id, alt]) {
      if (!k) continue
      this.referenceTouches.delete(k)
      while (this.referenceTouches.size >= 100) this.referenceTouches.delete(this.referenceTouches.keys().next().value!)
      this.referenceTouches.set(k, { folder, ...(k === id ? { alt } : id ? { id } : {}) })
    }
  }

  /** Take (and drop) the stashed finding for a call: by tool_use id when given, else by key + agent. */
  private takeReferenceTouch(toolUseId: string | undefined, permKey: string, agentId: string): { folder: string | null } | undefined {
    const k = typeof toolUseId === 'string' && toolUseId ? `id\u0000${toolUseId}` : this.referenceTouchKey(permKey, agentId)
    const hit = this.referenceTouches.get(k)
    if (!hit) return undefined
    this.referenceTouches.delete(k)
    if (hit.alt) this.referenceTouches.delete(hit.alt)
    if (hit.id) this.referenceTouches.delete(hit.id)
    return { folder: hit.folder }
  }

  /** The working folder of an agent when the provider does not say: its worktree, else the project folder. */
  private agentCwd(agentId: string): string {
    return this.integrator.worktreeOf(agentId)?.path ?? this.ctx.project.path
  }

  /** Set once the "self-control gate skipped" line was logged for this run. */
  private selfControlSkipLogged = false

  /**
   * The pre-mode self-control gate (selfControlGate.ts, cli-spec 3.4(1)): the gate's denial (SELF_CONTROL_DENIAL_MESSAGE,
   * or SELF_CONTROL_UNCHECKED_MESSAGE for a command too long to check) when this call runs the orgai command or opens
   * OrgAI's control files, else null. On a hit it logs a warning and writes one harness
   * row on the calling agent. An empty or unreadable protected list skips the gate (logged once per run).
   */
  private selfControlDenial(agentId: string, toolName: string, toolInput: unknown, cwd: string): string | null {
    let paths: string[] | undefined
    try {
      paths = this.ctx.controlProtectedPaths?.()
    } catch {
      paths = undefined
    }
    // A context without the hook (tests, drafts) skips the path check quietly.
    if (this.ctx.controlProtectedPaths && (!Array.isArray(paths) || !paths.length)) {
      if (!this.selfControlSkipLogged) {
        this.selfControlSkipLogged = true
        this.log('warn', 'OrgAI control paths are unavailable for this run; the self-control gate checks only for the orgai command')
      }
    }
    const denial = checkSelfControlDenial(toolName, toolInput, {
      protectedPaths: Array.isArray(paths) ? paths : [],
      cwd,
      shell: toolName === 'PowerShell' ? 'powershell' : 'bash'
    })
    if (!denial) return null
    this.log('warn', selfControlLogLine(toolName, this.agents.get(agentId)?.name ?? agentId))
    this.transcript(agentId, { kind: 'system', text: SELF_CONTROL_REFUSAL_TEXT }, { source: 'harness' })
    return denial
  }

  /**
   * referenceDirectories.ts referenceEditDenial for an edit tool call, with the deny text the agent gets (plus
   * REFERENCE_COPY_HINT) and the harness transcript row (referenceRefusalEntry). An unreadable list refuses an edit tool.
   */
  private referenceEditRefusal(toolName: string, toolInput: unknown, cwd: string): { reason: string; entry: { text: string; detail: string } } | null {
    if (!REFERENCE_EDIT_TOOLS.has(toolName)) return null
    const refs = this.referenceList()
    if (refs === undefined) return null
    if (refs === 'unreadable') {
      return { reason: 'OrgAI could not check the reference folders, so this edit was refused. Try again shortly.', entry: referenceRefusalEntry(undefined, 'a reference folder') }
    }
    const denial = referenceEditDenial(toolName, toolInput, refs, cwd)
    if (!denial) return null
    const target = editTargetOf(toolName, toolInput)
    const hit = referenceFolderOf(target, refs, cwd)
    return { reason: `${denial}${REFERENCE_COPY_HINT}`, entry: referenceRefusalEntry(hit ? target : undefined, hit ?? refs[0] ?? 'a reference folder') }
  }

  /** The one harness row for a refused edit under a reference folder, on the calling agent. */
  private referenceRefusalRow(agentId: string, entry: { text: string; detail: string }): void {
    this.transcript(agentId, { kind: 'system', ...entry }, { source: 'harness' })
  }

  /**
   * The reference folder a shell call touches from `cwd` (commandReferenceTouch), `{ folder: null }` when the list cannot
   * be read (the call is asked), null when it touches none or the run has no reference folders.
   */
  private shellReferenceTouch(toolName: string, toolInput: Record<string, unknown>, cwd: string): { folder: string | null; how?: 'names' | 'runs-in' } | null {
    if (!SHELL_TOOLS.has(toolName)) return null
    const refs = this.referenceList()
    if (refs === undefined) return null
    if (refs === 'unreadable') return { folder: null }
    if (!refs.length || typeof toolInput.command !== 'string') return null
    return commandReferenceTouch(toolInput.command, cwd, refs, { shell: toolName === 'PowerShell' ? 'powershell' : 'bash' })
  }

  /**
   * For canUseTool's card: the reference folder a shell, Read, Glob or Grep call touches. The hook's finding for this
   * call (its cwd is the real one) wins; otherwise recomputed from the agent's worktree or the project folder.
   * `{ folder: null }`: the list could not be read. null: no reference folder involved.
   */
  private cardReferenceTouch(
    call: { key: string; agentId: string; toolUseId?: string },
    toolName: string,
    input: Record<string, unknown>,
    cwd: string
  ): { folder: string | null } | null {
    const stashed = this.takeReferenceTouch(call.toolUseId, call.key, call.agentId)
    if (stashed) return stashed
    if (!SHELL_TOOLS.has(toolName) && toolName !== 'Read' && toolName !== 'Glob' && toolName !== 'Grep') return null
    const refs = this.referenceList()
    if (refs === undefined || (Array.isArray(refs) && !refs.length)) return null
    if (refs === 'unreadable') return { folder: null }
    const folder = referenceTouchOf(toolName, input, refs, cwd, { shell: toolName === 'PowerShell' ? 'powershell' : 'bash' })
    return folder ? { folder } : null
  }

  private buildHooks(): Options['hooks'] {
    const hookAllow = (reason: string): HookJSONOutput => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: reason }
    })
    const preToolUse: HookCallback = async (raw) => {
      const input = raw as PreToolUseHookInput
      const agentId = input.agent_id ?? ROOT_ID
      // Self-control gate first (cli-spec 3.4(1)): the orgai command and OrgAI's control files are denied before every
      // other check, rule, hook-allow path and permission mode (bypassPermissions included).
      const selfCwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : this.agentCwd(agentId)
      const selfDenial = this.selfControlDenial(agentId, input.tool_name, input.tool_input, selfCwd)
      if (selfDenial) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: selfDenial } }
      // Build sessions never write their own .claude settings (hooks, rules): denied before any allow rule or hook-allow path.
      const configDenial = buildConfigWriteDenial(this.ctx.run, input.tool_name, input.tool_input)
      if (configDenial) {
        this.log('warn', `Blocked ${input.tool_name} by ${this.agents.get(agentId)?.name ?? agentId}: ${configDenial}`)
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: configDenial } }
      }
      // Reference folders are read-only: edit tools under one (or naming no path while any exist) are denied before
      // any allow path (saved rules, acceptEdits, auto). The list is live, read at call time; relative paths resolve
      // against the calling agent's cwd (a worktree for isolated agents), else the project folder.
      // The refusal also writes one harness row on the calling agent ("Refused: <file> is in a reference folder (read
      // only)"), counted per call so canUseTool's backstop never writes it twice.
      const hookCwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : this.agentCwd(agentId)
      const editRefusal = this.referenceEditRefusal(input.tool_name, input.tool_input, hookCwd)
      if (editRefusal) {
        this.log('warn', `Blocked ${input.tool_name} by ${this.agents.get(agentId)?.name ?? agentId}: ${editRefusal.reason}`)
        const refusedKey = permissionKey(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>)
        // A hook deny normally never reaches canUseTool, so entries are kept only for the newest calls.
        if (this.refusedEdits.size >= 100) this.refusedEdits.delete(this.refusedEdits.keys().next().value!)
        this.refusedEdits.set(refusedKey, (this.refusedEdits.get(refusedKey) ?? 0) + 1)
        this.referenceRefusalRow(agentId, editRefusal.entry)
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: editRefusal.reason } }
      }
      // Per-role MCP grants on every MCP call, from the LIVE server list (run-scoped installs and the install card's
      // roles included), before any rule or hook-allow path. Whitelists alone do not restrict: def.mcpServers grants
      // nothing exclusive (scripts/smoke-mcp-midrun.mjs c), and a restart widens definitions. The MCP resource tools
      // are gated on input.server. Only MCP calls read the live list; if it cannot be read the call is denied.
      const mcpDenial = isMcpGated(input.tool_name) ? this.mcpGateDenial(input) : undefined
      if (mcpDenial) {
        this.log('warn', `Blocked ${input.tool_name} by ${this.agents.get(agentId)?.name ?? agentId}: ${mcpDenial}`)
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: mcpDenial } }
      }
      // The Skill gate comes first: no saved rule, auto-allow or later path may let an ungranted skill through.
      // It reads the LIVE grants (ctx.skills()), so an ungrant or a removal approved mid-run applies at the next call.
      if (input.tool_name === 'Skill') {
        let names: Map<string, RunSkill>
        try {
          names = this.skillNamesFor(this.skillPlugin)
        } catch (e) {
          const reason = 'OrgAI could not check which skills this agent may use, so the call was refused. Try again shortly.'
          this.log('warn', `Could not read the run's skills for a Skill call: ${(e as Error).message}`)
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
        }
        const verdict = skillGate(input.tool_input, this.callerRole(input)?.id ?? '', names)
        if (!verdict.allow) {
          this.log('warn', `Blocked Skill call by ${this.agents.get(agentId)?.name ?? agentId}: ${verdict.reason}`)
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: verdict.reason } }
        }
        // skill.used is emitted from PostToolUse for this tool_use id, i.e. only once the call actually ran.
        this.gatedSkillCalls.set(input.tool_use_id, { agentId, skill: verdict.skill })
      }
      this.lastToolAgent.set(input.tool_name, agentId)
      if (input.tool_name.startsWith(ORGAI_TOOL_PREFIX)) this.harnessCallers.record(input.tool_name, input.tool_use_id, input.agent_id)
      const toolInput = (input.tool_input ?? {}) as Record<string, unknown>
      const key = permissionKey(input.tool_name, toolInput)
      this.pendingPermissionIssuers.set(key, [...(this.pendingPermissionIssuers.get(key) ?? []), agentId])

      if (input.tool_name === SPAWN_TOOL || input.tool_name === 'Task') {
        const parentSlug = input.agent_type ?? this.root.slug
        const parentRole = this.rolesBySlug.get(parentSlug)
        const requested = String(toolInput.subagent_type ?? '')
        const allowedSlugs = parentRole
          ? this.ctx.roles.filter((r) => parentRole.spawnable.includes(r.id)).map((r) => r.slug)
          : []
        const allowed = !!parentRole && parentRole.canSpawn && allowedSlugs.includes(requested)
        if (!allowed) {
          const reason = parentRole?.canSpawn
            ? `The org chart does not let ${parentSlug} spawn "${requested || '(unspecified)'}". Allowed subagent_type values: ${allowedSlugs.join(', ') || 'none'}.`
            : `The org chart does not let ${parentSlug} spawn subagents. Do the work yourself.`
          this.log('warn', `Blocked spawn: ${parentSlug} -> ${requested || '(unspecified)'}`)
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: reason
            }
          }
        }
        this.setState(agentId, 'delegating', describe(input.tool_name, toolInput))
        // Writing reports get their own worktree when their parent is the orchestrator or is itself
        // isolated (nested isolation). A nested spawn runs from the parent's worktree, so Claude Code
        // cuts the child's branch from the parent's branch; the integrator merges it back into the
        // parent's worktree (see worktrees.ts). Writers under a non-isolated parent share its checkout.
        const target = this.rolesBySlug.get(requested)
        const parentIsolated = !input.agent_id || !!this.integrator.worktreeOf(input.agent_id)
        const updates: Record<string, unknown> = {}
        // A model-chosen model must be a plain model id; anything else is dropped so the role's own model applies.
        let dropModel = false
        if ('model' in toolInput && !(typeof toolInput.model === 'string' && validModelId(toolInput.model))) {
          dropModel = true
          this.log('warn', `Dropped an invalid model on a spawn of ${requested}.`)
        }
        // Every report gets a handle so peers and its lead can reach it with SendMessage({to: handle}).
        const { handle, generated } = spawnHandle(this.handles, requested, toolInput.name)
        this.spawnHandles.set(input.tool_use_id, handle)
        if (generated) updates.name = handle
        if (this.isolation && parentIsolated && target && canWrite(target) && !toolInput.isolation) {
          this.isolatedSpawns.set(input.tool_use_id, agentId)
          updates.isolation = 'worktree'
        }
        // Near the weekly limit, new deep/top reports run on the everyday tier (plan guard: planGuardOf / planGuardEngaged).
        const steer = this.steerToEveryday(target, toolInput)
        if (steer && validModelId(steer.to)) {
          updates.model = steer.to
          dropModel = false
          this.log('info', `Spawning ${target?.name ?? requested} on the everyday tier (${steer.to}) instead of ${steer.from}: the weekly usage window is near its limit.`)
        }
        if (!Object.keys(updates).length && !dropModel) return {}
        const updated: Record<string, unknown> = { ...toolInput, ...updates }
        if (dropModel) delete updated.model
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            updatedInput: updated
          }
        }
      }

      // The first tool call from an isolated agent reveals its real worktree path.
      this.integrator.reportCwd(agentId, input.cwd)

      if (input.tool_name === MESSAGE_TOOL) this.onAgentMessage(agentId, toolInput)

      // Proposal tools block on the user, so the node shows "waiting" until they decide; plan tools return at once.
      const harness = input.tool_name.startsWith(ORGAI_TOOL_PREFIX)
      const state = harness && isBlockingHarnessTool(input.tool_name.slice(ORGAI_TOOL_PREFIX.length)) ? 'waiting' : 'tool'
      this.setState(agentId, state, describe(input.tool_name, toolInput))
      // A hook 'allow' bypasses the permission system (mode, classifier and canUseTool alike; verified in
      // scripts/smoke-permission-hook.mjs). The harness's own tools carry their approval inside their round-trip,
      // and rules granted while the run is live (request_permission_rules, the rules panel) apply without a restart.
      if (harness) return hookAllow('OrgAI harness tool')
      // Reference folders (H1): a shell command that runs inside one or names a path at, under or above one never takes
      // an allow path (saved, run or session rules, the CLI's settings rules, acceptEdits / auto pre-approval): it is
      // asked, and canUseTool's card names the folder with no suggestions. The cwd is the hook's (the CLI's current
      // folder for this agent), else the agent's worktree, else the project. An unreadable list asks too.
      if (SHELL_TOOLS.has(input.tool_name)) {
        const touch = this.shellReferenceTouch(input.tool_name, toolInput, hookCwd)
        if (touch) {
          this.stashReferenceTouch(input.tool_use_id, key, agentId, touch.folder)
          const reason = touch.folder
            ? referenceCommandMessage(touch.folder, touch.how ?? 'names')
            : 'OrgAI could not check the reference folders, so this command needs your approval.'
          this.log('info', `Asking about ${input.tool_name} by ${this.agents.get(agentId)?.name ?? agentId}: ${reason}`)
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } }
        }
      }
      const baseOpts = this.safeMatchOptions(input.tool_name)
      if (!baseOpts) {
        // The folder lists could not be read (review L1): a shell call is asked (its card names no folder and an allow
        // grants this call only, like an unreadable reference list); other tools get no rule allow and go to the
        // normal permission flow.
        if (!SHELL_TOOLS.has(input.tool_name)) return {}
        this.stashReferenceTouch(input.tool_use_id, key, agentId, null)
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'OrgAI could not check the run\'s folders, so this command needs your approval.' } }
      }
      const matchOpts: MatchOptions = { ...baseOpts, effectiveCwd: hookCwd }
      // Matched even with no rules: a command made only of `cd` segments into the project or an allowed directory
      // runs nothing and needs no rule (ruleMatch.ts FREE_CD_LABEL).
      // Allow sources: RunManager's allowedRules (saved settings.local.json rules plus run grants; the run's grants only
      // on a trust-restricted run) and this session's card grants. Saved rules are read directly only when a context has
      // no allowedRules (review L4). Shell rules never reach the CLI (cliAllowedTools, toSdkSessionUpdates), so this is
      // their only allow path.
      const rules = [...new Set([...(this.ctx.allowedRules ? this.ctx.allowedRules() : claudeSavedRules(this.ctx)), ...this.sessionRules])]
      // A server an agent installed this run is never approved wholesale by a server-level rule (M3): its calls
      // ask per call unless an exact tool rule covers them.
      const usable = rules.length && input.tool_name.startsWith('mcp__') ? withoutServerRules(rules, this.agentInstalledMcp()) : rules
      const hit = matchingRule(input.tool_name, toolInput, usable, matchOpts)
      if (hit) return hookAllow(`OrgAI: allowed by saved rule ${hit}`)
      // Reviewer-4 H-A and its follow-up review (H1, M1-M3): the only shell allow rules the CLI still holds are those of
      // <project>/.claude/settings.json, and its matcher approves shapes ruleMatch refuses (`timeout 5 npm test
      // --script-shell=calc` under `Bash(npm test:*)`). When that file has a rule for this tool (or cannot be read), a
      // call the hook did not allow is asked, never left to the CLI's own match. A refused command under a saved, run or
      // session rule gets {}: the mode, the classifier and canUseTool decide, since the CLI holds none of those.
      // Per the Claude Code hooks docs, PreToolUse 'ask' prompts the user; that 'ask' beats a settings allow rule is
      // UNVERIFIED live (scripts/smoke-permission-hook.mjs could check it; it spends tokens and needs the user's consent).
      if (SHELL_TOOLS.has(input.tool_name)) {
        const reason = cliShellAskReason(input.tool_name, toolInput, cliProjectSettings(this.ctx), matchOpts)
        if (reason) {
          this.log('info', reason)
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } }
        }
      }
      return {}
    }

    const postToolUse: HookCallback = async (raw) => {
      const input = raw as PostToolUseHookInput
      const agentId = input.agent_id ?? ROOT_ID
      const gated = this.gatedSkillCalls.get(input.tool_use_id)
      if (gated) {
        this.gatedSkillCalls.delete(input.tool_use_id)
        this.emit({ type: 'skill.used', runId: this.ctx.run.id, agentId: gated.agentId, skillId: gated.skill.id, name: gated.skill.name, at: Date.now() })
      }
      // Calls that never needed a permission prompt still leave an issuer queued; drop it now.
      const doneKey = permissionKey(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>)
      this.takeIssuer(doneKey, agentId)
      this.takeReferenceTouch(input.tool_use_id, doneKey, agentId)
      this.takeReferenceTouch(undefined, doneKey, agentId)
      const archPath = this.ctx.project.setup?.architecturePath
      if (!this.isSetup && archPath && (input.tool_name === 'Edit' || input.tool_name === 'Write')) {
        const filePath = ((input.tool_input ?? {}) as Record<string, unknown>).file_path
        if (isArchitectureFile(filePath, archPath)) {
          this.log('info', `${this.agents.get(agentId)?.name ?? agentId} updated ${archPath}`)
          void this.ctx.noteArchitectureUpdated().catch((e) => this.log('warn', `Could not record the architecture update: ${(e as Error).message}`))
        }
      }
      const a = this.agents.get(agentId)
      // Between tool calls the orchestrator's node shows the plan step it is on.
      const activity = (agentId === ROOT_ID && !this.isSetup ? stepActivity(this.ctx.getPlan()) : undefined) ?? 'Thinking…'
      if (a && a.state !== 'done' && a.state !== 'error') this.setState(agentId, 'thinking', activity)
      return {}
    }

    // Note: the toolUseID passed to SubagentStart is a hook invocation id, not the Agent
    // tool_use id. The parent link comes from the task_started system message, which
    // arrives first and carries task_id (= agent_id), tool_use_id and subagent_type.
    const subagentStart: HookCallback = async (raw) => {
      const input = raw as SubagentStartHookInput
      const role = this.rolesBySlug.get(input.agent_type)
      const existing = this.agents.get(input.agent_id)
      this.upsert({
        ...(existing ?? this.ensureAgent(input.agent_id, { roleSlug: input.agent_type, parentId: ROOT_ID })),
        roleId: role?.id ?? null,
        roleSlug: input.agent_type,
        name: role?.name ?? input.agent_type,
        state: 'thinking',
        activity: existing?.activity && existing.activity !== 'Starting…' ? existing.activity : 'Reading the brief…'
      })
      return {}
    }

    const subagentStop: HookCallback = async (raw) => {
      const input = raw as SubagentStopHookInput
      const a = this.ensureAgent(input.agent_id, { roleSlug: input.agent_type })
      a.result = input.last_assistant_message
      a.state = 'done'
      a.activity = 'Reported back'
      a.endedAt = Date.now()
      this.partial.clear(a.id, true)
      this.upsert(a)
      void this.integrator.onSubagentFinished(a.id)
      return {}
    }

    const stop: HookCallback = async () => {
      this.setState(ROOT_ID, 'idle', 'Waiting for you')
      return {}
    }

    return {
      PreToolUse: [{ hooks: [preToolUse] }],
      PostToolUse: [{ hooks: [postToolUse] }],
      SubagentStart: [{ hooks: [subagentStart] }],
      SubagentStop: [{ hooks: [subagentStop] }],
      Stop: [{ hooks: [stop] }]
    }
  }

  /**
   * The SDK's total_cost_usd is cumulative for the query() and, on resume, may start from the
   * total the resumed transcript saved. Report only this run's spend. If the first result is below
   * the earlier run's cost, the SDK evidently did not carry the old total, so nothing is subtracted.
   */
  private runCost(sdkTotal: number): number {
    if (this.resumeCostBase === null) {
      // A restarted query resumes this run's own session: whether its total carries the earlier query's is unverified,
      // so the earlier total is subtracted only when the new one is at least that large.
      const base = this.restarts > 0 ? this.prevQuerySdkTotal : this.ctx.resumeSessionId ? (this.ctx.resumeBaseCostUsd ?? 0) : 0
      this.resumeCostBase = sdkTotal >= base ? base : 0
    }
    this.lastSdkTotal = sdkTotal
    this.lastRunCost = this.priorQueriesCost + Math.max(0, sdkTotal - this.resumeCostBase)
    return this.lastRunCost
  }

  private noteSecrets(resolved: ResolvedMcpServer[]): void {
    for (const s of collectSecrets(resolved, this.ctx.connection)) this.secrets.add(s)
  }

  /** Every server of the session: the harness's own plus the resolved MCP servers. */
  private mcpRecord(resolved: ResolvedMcpServer[], harnessServer = this.harnessServer): Record<string, McpServerConfig> {
    const record: Record<string, McpServerConfig> = toClaudeMcpServers(resolved)
    if (harnessServer) record[ORGAI_MCP] = harnessServer
    return record
  }

  /** The run's MCP servers with secrets, minus any a restarted query could not start with (droppedMcp). */
  private async resolvedServers(): Promise<ResolvedMcpServer[]> {
    const all = (await this.ctx.resolvedMcpServers?.()) ?? []
    return this.droppedMcp.size ? all.filter((r) => !this.droppedMcp.has(r.spec.name)) : all
  }

  /** The run's MCP servers as they are now (project servers plus run-scoped installs, with the card's roles). */
  private liveMcpServers(): McpServerSpec[] {
    return this.ctx.mcpServers ? this.ctx.mcpServers() : (this.ctx.project.mcpServers ?? [])
  }

  /**
   * The role of the agent behind a hook call, for the MCP gate and the Skill gate alike: the root when there is no
   * agent_id; else the hook's own agent_type; else the role recorded for that agent id (task_started / SubagentStart).
   * agent_type comes first because the CLI states it on this very call for the agent making it, and it is the
   * subagent_type the spawn gate approved. The record is second-hand: ensureAgent() creates an entry with the guessed
   * slug 'general-purpose' when a message arrives before task_started, so it may be a guess until task_started lands
   * (stream messages and hook calls are not ordered against each other). Neither value comes from the model.
   */
  private callerRole(input: { agent_id?: string; agent_type?: string }): Role | undefined {
    if (!input.agent_id) return this.root
    const byType = input.agent_type ? this.rolesBySlug.get(input.agent_type) : undefined
    if (byType) return byType
    const roleId = this.agents.get(input.agent_id)?.roleId
    return roleId ? this.ctx.roles.find((r) => r.id === roleId) : undefined
  }

  /** The MCP gate for one call (mcp__ tools and the resource tools). Fails closed if the live server list cannot be read. */
  private mcpGateDenial(input: PreToolUseHookInput): string | undefined {
    try {
      return mcpCallDenial(input.tool_name, { role: this.callerRole(input), isRoot: !input.agent_id }, this.liveMcpServers(), this.harnessAudiences, input.tool_input)
    } catch (e) {
      this.log('warn', `Could not read the run's MCP servers for ${input.tool_name}: ${(e as Error).message}`)
      return 'OrgAI could not check which MCP servers this agent may use, so the call was refused. Try again shortly.'
    }
  }

  /** Match options plus the user's MCP servers (server-level card rules) for chooseSuggestions. */
  private suggestOptions(toolName: string, effectiveCwd?: string): SuggestOptions | null {
    const base = this.safeMatchOptions(toolName)
    if (!base) return null
    let live: McpServerSpec[] = []
    try {
      live = this.liveMcpServers()
    } catch {
      /* no server-level offers */
    }
    return { ...base, ...(effectiveCwd ? { effectiveCwd } : {}), userMcpServers: userMcpServerNames(live, this.agentInstalledMcp()) }
  }

  /** Servers agents installed during this run (attached mid-run, or run-scoped 'agent' installs): no server-level rule approves them. */
  private agentInstalledMcp(): Set<string> {
    let live: McpServerSpec[] = []
    try {
      live = this.liveMcpServers()
    } catch {
      /* the attached set alone */
    }
    return agentInstalledServers(live, this.ctx.project.mcpServers, this.attachedMcp)
  }

  /**
   * An install was approved mid-run. setMcpServers attaches the server to the live session at once (connection
   * errors surface here, and mcpServerStatus names its tools), but AgentDefinition.tools whitelists are exact and
   * fixed for the query (scripts/smoke-mcp-midrun.mjs a, b), so no whitelisted agent can call the tools yet. The
   * session is therefore re-created with resume and widened definitions once the orchestrator's turn has ended and
   * no report is running (maybeRestartForMcp), and the orchestrator is told then: availability 'after-idle'.
   */
  private async addMcpServer(spec: McpServerSpec): Promise<McpAttachResult> {
    // Every server an agent asked for counts as installed this run, attached or not (server-level rules skip it).
    this.attachedMcp.add(spec.name)
    this.knownDefs.set(spec.name, mcpDefinitionKey(spec))
    const resolved = await this.resolvedServers()
    this.noteSecrets(resolved)
    if (!resolved.some((r) => r.spec.name === spec.name)) throw new Error(`MCP server "${spec.name}" is not configured for this run.`)
    if (!this.q) throw new Error('The session is not running yet.')
    let result
    try {
      result = await this.q.setMcpServers(this.mcpRecord(resolved))
    } catch (e) {
      throw new Error(redactSecrets((e as Error).message ?? String(e), this.secrets))
    }
    const error = result.errors?.[spec.name]
    if (error) throw new Error(redactSecrets(error, this.secrets))
    const tools = await this.serverTools(spec.name, MCP_STATUS_WAIT_MS)
    this.pendingMcp.set(spec.name, tools)
    this.log('info', `MCP server ${spec.name} is connected; the agents get its tools once the orchestrator's turn ends and no report is running (the session is resumed with the new tools).`)
    return { prefix: `mcp__${spec.name}__`, availability: 'after-idle', ...(tools.length ? { tools } : {}) }
  }

  /**
   * An approved propose_mcp_servers / propose_skills changed this run's project; ctx already returns the new config.
   * - MCP: setMcpServers with the live resolved list at once (an added or redefined server connects, a removed one is
   *   dropped from the session's dynamic servers), and the tool names of new servers are read when cheap. A removed
   *   server leaves every attach record (pendingMcp, a pending regrant, the latest restart, droppedMcp, attachedMcp), so
   *   no restart or fallback brings it back. A new or redefined server counts as installed this run (no saved
   *   server-level rule approves it, as for request_mcp_install).
   * - Skills: the Skill gate reads the live grants on every call, so an ungrant or a removal needs nothing more. A skill
   *   the run plugin does not hold (or whose files changed) needs a rebuilt plugin, i.e. a restart.
   * - Whitelists: the live agent definitions are compared with the running query's (grantsGained). A role that gains a
   *   tool rule, an MCP server or the Skill tool needs the query re-created at idle (the same restart as addMcpServer:
   *   idle detection, the withheld turn end, the budget floor, retries, fallback and pause).
   * Answers 'after-idle' when this change gains something only a restart gives (the orchestrator is told when it is in
   * effect), else 'now': removals, ungrants, turning a server off, a redefinition whose name every granted role already
   * whitelists, and a skill grant the plugin and the role's Skill tool already cover (the gate allows it at once; the
   * role's prompt lists it from the next restart or run). Rejects (the tool then says "from the next run") when the
   * session is not running or the live config cannot be read.
   */
  private async configChanged(change: ConfigChange): Promise<ConfigChangeResult> {
    if (this.isSetup) throw new Error('Setup-like runs do not take project config changes.')
    if (!this.q) throw new Error('The session is not running yet.')
    this.configGen += 1
    const upserted = [...new Set(change.mcp?.upserted ?? [])]
    const removedNames = [...new Set(change.mcp?.removed ?? [])]
    const live = this.liveMcpServers()
    const byName = new Map(live.map((s) => [s.name, s]))
    const lost: string[] = []
    const fresh: string[] = []
    const regranted: string[] = []
    for (const name of removedNames) {
      this.forgetServer(name)
      lost.push(name)
    }
    for (const name of upserted) {
      const spec = byName.get(name)
      // Not in the run's list (e.g. a secret slot is still empty, so it never starts): treated like a removal.
      if (!spec) {
        this.forgetServer(name)
        lost.push(name)
        continue
      }
      // The user approved this definition: a server an earlier failed restart left out gets another try.
      this.droppedMcp.delete(name)
      const key = mcpDefinitionKey(spec)
      const known = this.knownDefs.get(name)
      this.knownDefs.set(name, key)
      if (!spec.enabled) {
        this.pendingMcp.delete(name)
        this.pendingConfig.regranted = this.pendingConfig.regranted.filter((n) => n !== name)
        lost.push(name)
        continue
      }
      if (known !== key) {
        this.attachedMcp.add(name)
        fresh.push(name)
      } else regranted.push(name)
    }

    const tools: Record<string, string[]> = {}
    if (upserted.length || removedNames.length) await this.syncMcpServers(fresh, tools)

    // Whitelists and the skill plugin: what only a re-created query can bring.
    const skillsPending = !!change.skills || this.pendingConfig.skills
    const stale = skillsPending && pluginStale(this.skillPlugin, this.ctx.skills?.() ?? [])
    const now = this.grantsNow()
    const gainedNow = grantsGained(this.liveGrants, now) || (!!change.skills && stale)
    const needRestart = grantsGained(this.queryGrants, now) || stale
    this.liveGrants = now
    if (needRestart) {
      this.pendingConfig.due = true
      for (const n of fresh) this.pendingMcp.set(n, tools[n] ?? [])
      for (const n of regranted) if (!this.pendingConfig.regranted.includes(n)) this.pendingConfig.regranted.push(n)
      for (const n of lost) if (!this.pendingConfig.removed.includes(n)) this.pendingConfig.removed.push(n)
      if (change.skills) this.pendingConfig.skills = true
      this.log('info', 'A configuration change was approved; the agents get it once the orchestrator\'s turn ends and no report is running (the session is resumed with the new config).')
      // Normally the orchestrator is mid-turn (it called the proposal tool); if it is already idle, check now.
      if (!mcpRestartBlocker(this.restartState())) this.scheduleMcpRestart()
    } else {
      // Nothing a restart would add: an earlier pending config restart is not needed any more.
      this.pendingConfig = { due: false, regranted: [], removed: [], skills: false }
      if (!this.restartDue()) this.releaseTurnEnd()
    }
    return { availability: gainedNow ? 'after-idle' : 'now', ...(Object.keys(tools).length ? { tools } : {}) }
  }

  /**
   * Send the live resolved server list to the running query (setMcpServers), then read the tool names of `fresh`
   * servers into `tools`. A failure is logged (redacted) and never thrown: the next restart builds from the live list.
   * Skipped while a restart is under way (the old query is closing; the change is applied by a later restart).
   */
  private async syncMcpServers(fresh: string[], tools: Record<string, string[]>): Promise<void> {
    const resolved = await this.resolvedServers()
    this.noteSecrets(resolved)
    if (this.restarting || this.nextQuery) {
      this.log('info', 'A restart is under way; the MCP change reaches the session with a later restart.')
      return
    }
    let errors: Record<string, string> = {}
    try {
      const result = await this.q.setMcpServers(this.mcpRecord(resolved))
      errors = result.errors ?? {}
    } catch (e) {
      this.log('warn', `Could not update the session's MCP servers now (${redactSecrets((e as Error)?.message ?? String(e), this.secrets)}); the change applies when the session is re-created.`)
      return
    }
    for (const [name, err] of Object.entries(errors)) {
      if (fresh.includes(name)) this.log('warn', `MCP server ${name} did not connect: ${redactSecrets(String(err), this.secrets)}`)
    }
    const names = fresh.filter((n) => !errors[n] && resolved.some((r) => r.spec.name === n))
    const lists = await Promise.all(names.map((n) => this.serverTools(n, MCP_STATUS_WAIT_MS)))
    names.forEach((n, i) => {
      if (lists[i]!.length) tools[n] = lists[i]!
    })
  }

  /** A server left the project: drop it from every attach record so no restart, fallback or rule path brings it back. */
  private forgetServer(name: string): void {
    this.pendingMcp.delete(name)
    this.pendingConfig.regranted = this.pendingConfig.regranted.filter((n) => n !== name)
    this.lastRestart = {
      ...this.lastRestart,
      servers: this.lastRestart.servers.filter((n) => n !== name),
      tools: new Map([...this.lastRestart.tools].filter(([n]) => n !== name))
    }
    this.droppedMcp.delete(name)
    this.attachedMcp.delete(name)
    this.knownDefs.delete(name)
  }

  /** The whitelists the live config gives (live servers minus droppedMcp, the plugin's skills with live grants). */
  private grantsNow(plugin = this.skillPlugin): GrantSnapshot {
    const servers = this.liveMcpServers().filter((s) => !this.droppedMcp.has(s.name))
    return grantSnapshot(buildAgents(this.ctx, this.harnessTools, this.isolation, { mcpServers: servers }, this.skillNamesFor(plugin)))
  }

  /** A plugin's skills with the live grants (livePluginNames). Throws when ctx.skills() does. */
  private skillNamesFor(plugin: SkillPlugin | undefined): Map<string, RunSkill> {
    if (!plugin) return new Map()
    return this.ctx.skills ? livePluginNames(plugin, this.ctx.skills()) : new Map(plugin.names)
  }

  /** A restart is due: servers to attach (addMcpServer or a config change) or a config change that needs one. */
  private restartDue(): boolean {
    return this.pendingMcp.size > 0 || this.pendingConfig.due
  }

  /** Remove every plugin except the current query's (after its init) or all of them (stop, teardown). */
  private retirePlugins(): void {
    // The old query re-emits init on later turns: a plugin built for a restart that has not started yet stays.
    const keep = new Set([this.skillPlugin, this.pluginInFlight, this.nextQuery?.plugin])
    for (const p of this.plugins) {
      if (keep.has(p)) continue
      p.cleanup()
      this.plugins.delete(p)
    }
  }

  private cleanupPlugins(): void {
    for (const p of this.plugins) p.cleanup()
    this.skillPlugin?.cleanup()
  }

  /** Tool names (no prefix) a connected server reports through mcpServerStatus, polled for up to `waitMs`; [] when unknown. */
  private async serverTools(name: string, waitMs: number, q: Query | undefined = this.q): Promise<string[]> {
    if (!q || typeof q.mcpServerStatus !== 'function') return []
    const until = Date.now() + waitMs
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const status = await Promise.race([
          q.mcpServerStatus(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('mcpServerStatus timed out')), Math.max(250, until - Date.now()))
          })
        ])
        const s = status.find((x) => x.name === name)
        // Tool names are the server's (untrusted): only plain identifiers are kept (review M1).
        if (s?.status === 'connected') return safeMcpToolNames((s.tools ?? []).map((t) => t.name)).slice(0, 200)
        if (s?.status === 'failed' || s?.status === 'needs-auth' || s?.status === 'disabled') return []
      } catch {
        return []
      } finally {
        clearTimeout(timer)
      }
      if (Date.now() >= until || this.abort.signal.aborted) return []
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  private restartState(): McpRestartState {
    const root = this.agents.get(ROOT_ID)
    return {
      stopping: this.ending || this.authFailed || this.abort.signal.aborted,
      held: this.held || this.capTripped,
      limited: this.limited,
      rootIdle: !!root && root.state === 'idle',
      liveReports: [...this.agents.values()].filter((a) => a.id !== ROOT_ID && a.state !== 'done' && a.state !== 'error').length,
      pendingInteractions: this.ctx.pendingInteractions(),
      backgroundTasks: this.backgroundTasks.size
    }
  }

  private clearRestartTimers(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer)
    if (this.restartCloseTimer) clearTimeout(this.restartCloseTimer)
    this.restartTimer = null
    this.restartCloseTimer = null
  }

  /**
   * A successful turn ended. With an MCP restart due and nothing blocking it, the continuation driver does not hear
   * of this turn end (its nudge would wake the orchestrator and starve the restart, review H1): the attach notice
   * re-engages the orchestrator instead, and the turn after it nudges normally. If the restart then does not happen,
   * the held turn end is handed to the driver (releaseTurnEnd), so the run never stalls.
   */
  private onTurnEnded(): void {
    if (this.restartDue() && !mcpRestartBlocker(this.restartState())) {
      this.turnEndDeferred = true
      return
    }
    this.turnEndDeferred = false
    this.continuation.turnEnded()
  }

  /** A non-subagent task ended; the last one to end lets a waiting MCP restart go ahead. */
  private backgroundTaskEnded(taskId: string): void {
    if (!this.backgroundTasks.delete(taskId)) return
    if (!this.backgroundTasks.size && this.restartDue()) this.scheduleMcpRestart()
  }

  /** Give the continuation driver the turn end held back for a restart that did not happen. */
  private releaseTurnEnd(): void {
    if (!this.turnEndDeferred) return
    this.turnEndDeferred = false
    this.continuation.turnEnded()
  }

  /** Check for an MCP restart shortly after a turn ends (a report hand-back the SDK resumes with goes first). */
  private scheduleMcpRestart(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.maybeRestartForMcp()
        .then((started) => {
          if (!started) this.releaseTurnEnd()
        })
        .catch((e) => {
          this.log('warn', `MCP restart check failed: ${redactSecrets((e as Error).message ?? String(e), this.secrets)}`)
          this.releaseTurnEnd()
        })
    }, MCP_RESTART_DELAY_MS)
  }

  /**
   * The budget a restarted query may spend: the project's maxBudgetUsd minus what this run has cost so far (each query
   * would otherwise get the whole budget again, review M2). undefined = no budget set; null = nothing is left.
   */
  private restartBudget(): number | undefined | null {
    const max = this.ctx.project.maxBudgetUsd
    if (!max || this.isSetup) return undefined
    const left = max - Math.max(0, this.lastRunCost, this.lastPricedTotal)
    // Below the minimum counts as nothing left: rounding it up would overshoot the budget (review N7).
    if (!(left >= MCP_RESTART_MIN_BUDGET_USD)) return null
    return left
  }

  /**
   * Re-create the query so the attached MCP servers reach every granted role: same session (resume), definitions
   * rebuilt from the live ctx.mcpServers(), hooks, harness tools, skills plugin, worktree state and agents kept. Only
   * when mcpRestartBlocker allows it; otherwise the next turn end tries again. If the new options cannot be built or
   * no budget is left, the old query keeps running with a run warning and the orchestrator is told the server waits
   * for the next run. Resolves true when the restart was set in motion.
   */
  private async maybeRestartForMcp(): Promise<boolean> {
    if (!this.restartDue() || this.restarting || this.nextQuery || !this.sessionId) return false
    if (mcpRestartBlocker(this.restartState())) return false
    const budget = this.restartBudget()
    if (budget === null) {
      this.giveUpPendingMcp('this run has used its budget')
      return false
    }
    this.restarting = true
    // What this restart covers; anything a config change adds while the options are built stays pending (next restart).
    const pending = new Map(this.pendingMcp)
    const gen = this.configGen
    const config: RestartConfig | undefined = this.pendingConfig.due
      ? { regranted: [...this.pendingConfig.regranted], removed: [...this.pendingConfig.removed], skills: this.pendingConfig.skills }
      : undefined
    let plugin: SkillPlugin | null | undefined
    let built: Options
    try {
      // A skill change the run plugin does not cover: a fresh plugin from the live skills. The old one stays until a
      // query using the new one has started (retirePlugins at init), so a fallback can still load it.
      if (config?.skills) {
        const live = this.ctx.skills?.() ?? []
        if (pluginStale(this.skillPlugin, live)) plugin = this.newSkillPlugin(live)
        this.pluginInFlight = plugin ?? undefined
      }
      built = await this.buildOptions(this.sessionId, { maxBudgetUsd: budget, plugin })
    } catch (e) {
      this.restarting = false
      this.pluginInFlight = undefined
      this.dropUnusedPlugin(plugin)
      this.giveUpPendingMcp(redactSecrets((e as Error).message ?? String(e), this.secrets))
      return false
    }
    // Something may have started meanwhile (a user message, a nudge, a report); the next turn end tries again.
    this.pluginInFlight = undefined
    if (mcpRestartBlocker(this.restartState()) || !this.restartDue()) {
      this.restarting = false
      this.dropUnusedPlugin(plugin)
      return false
    }
    // Off the pending list now (review L1): a result while the notice is prepared cannot start a second restart.
    const tools = pending
    const servers = [...tools.keys()]
    for (const [name, t] of pending) if (this.pendingMcp.get(name) === t) this.pendingMcp.delete(name)
    if (this.configGen === gen) this.pendingConfig = { due: false, regranted: [], removed: [], skills: false }
    this.restartForConfig = !!config
    this.nextQuery = {
      options: built,
      servers,
      tools,
      ...(plugin !== undefined ? { plugin, prevPlugin: this.skillPlugin ?? null } : {}),
      ...(config ? { config } : {})
    }
    this.restarting = false
    if (config) this.log('info', `Resuming the session to apply the approved configuration change${servers.length ? ` (MCP server${servers.length === 1 ? '' : 's'} ${servers.join(', ')})` : ''}.`)
    else this.log('info', `Resuming the session to attach the MCP server${servers.length === 1 ? '' : 's'} ${servers.join(', ')}.`)
    // Close the old query's input: it ends once the CLI exits; anything pushed but unread moves to the next query.
    this.swapInput()
    const oldQ = this.q
    this.restartCloseTimer = setTimeout(() => {
      this.restartCloseTimer = null
      if (this.q !== oldQ || !this.nextQuery) return
      this.log('warn', 'The previous query did not end after its input closed; closing it.')
      try {
        oldQ.close()
      } catch {
        /* already closed */
      }
    }, MCP_RESTART_CLOSE_MS)
    return true
  }

  /**
   * Give the next query a fresh input stream: messages pushed but unread move over, and the old stream ends, so a query
   * that is closing (or died with a read still pending) cannot swallow a message meant for its successor.
   */
  private swapInput(): void {
    const old = this.input
    this.input = new PushStream<SDKUserMessage>()
    for (const m of old.drain()) this.input.push(m)
    old.end()
  }

  /**
   * A restarted query died before its init (review N2): give the next one a fresh stream holding every message the dead
   * query may have read (preInit) plus anything still unread, each once. Attach / not-attached notices of the dead
   * query are left out: startRestartedQuery sends them again.
   */
  private replayInput(): void {
    const old = this.input
    const unread = old.drain()
    old.end()
    this.input = new PushStream<SDKUserMessage>()
    const replay = [...this.preInit, ...unread.filter((m) => !this.preInit.includes(m))]
    for (const m of replay) if (!this.harnessMessages.get(m)?.restart) this.input.push(m)
    this.preInit = []
  }

  /** A fresh run plugin from the live skills granted to some role; null when none is granted. Tracked for cleanup. */
  private newSkillPlugin(live: RunSkill[]): SkillPlugin | null {
    const granted = live.filter((s) => s.roleIds.length)
    if (!granted.length) return null
    const plugin = buildSkillPlugin(granted, this.ctx.run.id, (m) => this.log('warn', m))
    this.plugins.add(plugin)
    return plugin
  }

  /** A plugin built for a restart that did not happen: remove it (never the current one). */
  private dropUnusedPlugin(plugin: SkillPlugin | null | undefined): void {
    if (!plugin || plugin === this.skillPlugin) return
    plugin.cleanup()
    this.plugins.delete(plugin)
  }

  /** The pending servers and config changes cannot reach this session: warn, and tell the orchestrator they wait for the next run. */
  private giveUpPendingMcp(why: string): void {
    const names = [...this.pendingMcp.keys()]
    this.pendingMcp.clear()
    const config = this.pendingConfig
    this.pendingConfig = { due: false, regranted: [], removed: [], skills: false }
    const other = config.due ? { regranted: config.regranted.filter((n) => !names.includes(n)), skills: config.skills } : undefined
    if (!names.length && !other?.regranted.length && !other?.skills) return
    this.tellNotAttached(names, why, false, other)
  }

  /**
   * Warn and tell the orchestrator (or, while held, the user's next message) that servers could not be attached, or
   * that the role changes (`other.regranted`) and skill changes of an approved config change could not be applied.
   */
  private tellNotAttached(names: string[], why: string, restart = false, other?: { regranted: string[]; skills: boolean }): void {
    const plural = names.length === 1 ? '' : 's'
    const parts: string[] = []
    if (other?.regranted.length) parts.push(`the role changes for the MCP server${other.regranted.length === 1 ? '' : 's'} ${other.regranted.map((n) => datum(n, 64)).join(', ')}`)
    if (other?.skills) parts.push('the skill changes')
    const rest = parts.join(' and ')
    let text: string
    let summary: string
    if (names.length) {
      this.log('warn', `Could not attach the MCP server${plural} ${names.join(', ')} to this session: ${why}`)
      text = `[OrgAI harness] The MCP server${plural} ${names.map((n) => datum(n, 64)).join(', ')} could not be attached to this session (${datum(why, 300)}). It is available from the next run; continue without it.`
      if (rest) text += ` ${rest[0]!.toUpperCase()}${rest.slice(1)} approved this run could not be applied either; they apply from the next run.`
      summary = `Could not attach the MCP server${plural} ${names.join(', ')}`
    } else {
      this.log('warn', `Could not apply the approved configuration change to this session: ${why}`)
      text = `[OrgAI harness] ${rest[0]!.toUpperCase()}${rest.slice(1)} approved this run could not be applied to this session (${datum(why, 300)}). They apply from the next run; continue without them.`
      summary = 'Could not apply the configuration change to this session'
    }
    if (this.held || this.capTripped) this.holdNotice(text, summary)
    else this.notifyOrchestrator(text, 'Thinking…', { summary, restart })
  }

  /**
   * A restarted query failed before its init (review M4). First failure: resume once more with the same servers.
   * Second: resume without the newly attached servers (they may be what breaks the start; the orchestrator is told).
   * Third, or no budget left: no next query, and run() ends the session paused instead of failing the run.
   * Options that cannot be built count as a failed start too (review M2): each throw is one more failure, so this
   * gives up after at most three and never throws. `why` is the latest failure, already redacted.
   */
  private async recoverRestart(why: string): Promise<{ next?: NextQuery; why: string }> {
    for (;;) {
      this.restartFailures += 1
      const budget = this.restartBudget()
      if (budget === null || !this.sessionId) return { why }
      const { servers, tools, plugin, prevPlugin, config } = this.lastRestart
      // A rebuilt plugin is part of what may break the start: the fallback returns to the plugin it replaced.
      const rebuilt = plugin !== undefined
      let next: Omit<NextQuery, 'options'>
      if (this.restartFailures === 1) {
        this.log('warn', `The resumed session failed to start (${why}); trying once more.`)
        next = { servers, tools, ...(rebuilt ? { plugin, prevPlugin } : {}), ...(config ? { config } : {}) }
      } else if (this.restartFailures === 2 && (servers.length || rebuilt)) {
        for (const n of servers) this.droppedMcp.add(n)
        const left = [
          ...(servers.length ? [`the MCP server${servers.length === 1 ? '' : 's'} ${servers.join(', ')}`] : []),
          ...(rebuilt ? ['the rebuilt skills'] : [])
        ].join(' and ')
        this.log('warn', `The resumed session failed to start again (${why}); resuming without ${left}.`)
        next = { servers: [], tools: new Map(), dropped: servers, ...(rebuilt ? { plugin: prevPlugin ?? null, droppedSkills: true } : {}) }
      } else return { why }
      try {
        return { next: { ...next, options: await this.buildOptions(this.sessionId, { maxBudgetUsd: budget, plugin: next.plugin }) }, why }
      } catch (e) {
        why = redactSecrets((e as Error)?.message ?? String(e), this.secrets)
        this.log('warn', `Could not prepare the resumed session (${why}).`)
      }
    }
  }

  /**
   * User messages a dead restarted query may have read before its init, or that still wait unread (review M1): they
   * never reached a query that started. Harness messages (notices, nudges, peer messages) are left out.
   */
  private undeliveredUserMessages(): number {
    const pending = new Set([...this.preInit, ...this.input.peek()])
    let n = 0
    for (const m of pending) if (!this.harnessMessages.has(m)) n += 1
    return n
  }

  /**
   * Before a restarted query starts (review L7): if an interrupt landed in the restart window, unread plan nudges are
   * dropped and other unread harness notices (already in the transcript) wait for the user's next message, so the
   * new query does not start a turn the user stopped. User messages stay queued.
   */
  private dropHeldHarnessMessages(): void {
    if (!this.held && !this.capTripped) return
    const queued = this.input.drain()
    let dropped = 0
    for (const m of queued) {
      const h = this.harnessMessages.get(m)
      if (!h) this.input.push(m)
      else if (h.nudge) dropped += 1
      else this.heldNotices.push(h.text)
    }
    if (dropped) this.log('info', `Dropped ${dropped} queued plan nudge${dropped === 1 ? '' : 's'}: the run is held for the user.`)
  }

  /** Start the query that replaces the one an MCP restart ended, then tell the orchestrator what is attached. */
  private startRestartedQuery(next: NextQuery): void {
    this.dropHeldHarnessMessages()
    this.restarts += 1
    this.queryInitSeen = false
    // What the new query may read before its init: everything queued now plus what is pushed until then.
    this.preInit = this.input.peek()
    this.lastRestart = {
      servers: next.servers,
      tools: next.tools,
      ...(next.plugin !== undefined ? { plugin: next.plugin, prevPlugin: next.prevPlugin } : {}),
      ...(next.config ? { config: next.config } : {})
    }
    this.priorQueriesCost = this.lastRunCost
    this.prevQuerySdkTotal = this.lastSdkTotal
    this.resumeCostBase = null
    this.harnessServer = harnessServerOf(next.options)
    // The plugin this query loads becomes the session's (the gate's names); the replaced one is removed at its init.
    if (next.plugin !== undefined) this.skillPlugin = next.plugin ?? undefined
    this.queryGrants = this.optionGrants.get(next.options)
    this.liveGrants = this.queryGrants
    this.q = query({ prompt: this.input, options: next.options })
    const config = next.config
    if (next.dropped?.length || next.droppedSkills) {
      const why = `the resumed session would not start with ${(next.dropped?.length ?? 0) + (next.droppedSkills ? 1 : 0) === 1 ? 'it' : 'them'}`
      this.tellNotAttached(next.dropped ?? [], why, true, next.droppedSkills ? { regranted: [], skills: true } : undefined)
    } else if (next.servers.length || config) {
      const q = this.q
      // Never left unhandled (review N4): a failure still sends a notice with the known tool names and releases a
      // deferred turn end, so an unattended run does not stall.
      void this.announceAttached(next.servers, next.tools, q, config).catch((e) => {
        this.log('warn', `Could not read the attached MCP servers' grants: ${redactSecrets((e as Error)?.message ?? String(e), this.secrets)}`)
        try {
          const names = [...new Set([...next.servers, ...(config?.regranted ?? [])])]
          this.sendAttachNotice(q, names.map((name) => ({ name, tools: next.tools.get(name) ?? [] })), next.servers, config && { removed: config.removed, skills: config.skills ? null : undefined })
        } catch (e2) {
          this.log('warn', `Could not send the MCP attach notice: ${redactSecrets((e2 as Error)?.message ?? String(e2), this.secrets)}`)
        } finally {
          this.releaseTurnEnd()
        }
      })
    }
  }

  /** The run is held for the user: show a harness notice in the transcript and deliver it with the user's next message. */
  private holdNotice(text: string, summary: string): void {
    this.heldNotices.push(text)
    this.transcript(ROOT_ID, { kind: 'system', text: summary, detail: text }, { source: 'harness' })
  }

  /** After a restart: name the attached servers' tools (from the new query's mcpServerStatus) to the orchestrator. */
  private async announceAttached(servers: string[], known: Map<string, string[]>, q: Query, config?: RestartConfig): Promise<void> {
    const live = this.liveMcpServers()
    const liveNames = new Set(live.filter((s) => s.enabled).map((s) => s.name))
    // A config restart also names the re-granted servers; a server removed since is left out of the list.
    const names = [...new Set([...servers, ...(config?.regranted ?? [])])].filter((n) => !config || liveNames.has(n))
    const entries: { name: string; tools: string[]; roles: Role[] }[] = []
    for (const name of names) {
      const fresh = await this.serverTools(name, MCP_STATUS_WAIT_MS, q)
      entries.push({ name, tools: fresh.length ? fresh : (known.get(name) ?? []), roles: rolesGrantedServer(this.ctx.roles, live, name) })
    }
    let extra: { removed: string[]; skills?: SkillNoticeEntry[] | null } | undefined
    if (config) {
      let skills: SkillNoticeEntry[] | null | undefined
      if (config.skills) {
        try {
          skills = [...this.skillNamesFor(this.skillPlugin)]
            .filter(([, s]) => s.roleIds.length)
            .map(([name, s]) => ({ name, roles: this.ctx.roles.filter((r) => s.roleIds.includes(r.id)) }))
        } catch {
          skills = null
        }
      }
      extra = { removed: config.removed.filter((n) => !liveNames.has(n)), ...(skills !== undefined ? { skills } : {}) }
    }
    this.sendAttachNotice(q, entries, servers, extra)
  }

  /**
   * Deliver the attach notice for query q (dropped if q is no longer current); while held it waits for the user. With
   * `extra` (a config restart) the notice is configChangeNotice: removed servers and the skills in the session too.
   */
  private sendAttachNotice(
    q: Query,
    entries: Parameters<typeof mcpAttachedNotice>[0],
    servers: string[],
    extra?: { removed: string[]; skills?: SkillNoticeEntry[] | null }
  ): void {
    if (this.abort.signal.aborted || this.q !== q) return
    let text: string
    let summary: string
    if (extra) {
      text = configChangeNotice({ servers: entries, removed: extra.removed, ...(extra.skills !== undefined ? { skills: extra.skills } : {}) })
      const parts = [
        ...(entries.length ? [`MCP server${entries.length === 1 ? '' : 's'} ${entries.map((e) => e.name).join(', ')} attached`] : []),
        ...(extra.removed.length ? [`${extra.removed.join(', ')} removed`] : []),
        ...(extra.skills !== undefined ? ['skills updated'] : [])
      ]
      summary = `Configuration change in effect${parts.length ? `: ${parts.join('; ')}` : ''}`
    } else {
      text = mcpAttachedNotice(entries)
      summary = `MCP server${servers.length === 1 ? '' : 's'} ${servers.join(', ')} attached`
    }
    // Held by an interrupt meanwhile: no new turn now; the notice goes with the user's next message.
    if (this.held || this.capTripped) {
      this.holdNotice(text, summary)
      return
    }
    this.notifyOrchestrator(text, extra ? 'Using the new configuration…' : 'Using a new MCP server…', { summary, restart: true })
  }

  /** What lives for the whole run: the skills plugin and the bound harness tools. Called once, before the first query. */
  private prepare(): void {
    // Granted skills become a run-scoped plugin (orgai:<name>). Setup-like runs get none.
    if (!this.isSetup) {
      const granted = this.ctx.skills?.() ?? []
      if (granted.length) {
        this.skillPlugin = buildSkillPlugin(granted, this.ctx.run.id, (m) => this.log('warn', m))
        if (!this.skillPlugin.names.size) {
          this.skillPlugin.cleanup()
          this.skillPlugin = undefined
        } else this.plugins.add(this.skillPlugin)
      }
    }
    // The server definitions this session starts with; a config change that redefines one counts it as installed.
    try {
      for (const s of this.liveMcpServers()) this.knownDefs.set(s.name, mcpDefinitionKey(s))
    } catch {
      /* unknown: every upserted server then counts as new */
    }
    // The harness tools for this kind of run (setup / mcp-assist / work); the audience decides who sees which.
    this.harnessTools = harnessToolsFor(this.ctx, {
      integratePending: (wt) => this.integrator.integratePending(wt),
      onPlanUpdated: (plan) => {
        const root = this.agents.get(ROOT_ID)
        const activity = stepActivity(plan)
        if (root && activity && root.state !== 'done' && root.state !== 'error') this.setState(ROOT_ID, root.state, activity)
      },
      onDecided: () => {
        const a = this.agents.get(ROOT_ID)
        if (a && a.state === 'waiting') this.setState(ROOT_ID, 'thinking', 'Thinking…')
      },
      addMcpServer: (spec) => this.addMcpServer(spec),
      configChanged: (change) => this.configChanged(change)
    }, { nativeSkills: true })
    this.harnessAudiences = new Map(this.harnessTools.map((t) => [t.name, t.audience]))
  }

  /**
   * Query options. `resume` is the session to resume (an MCP restart); otherwise the run's own resumeSessionId.
   * A fresh in-process harness server is built each time (same bound tools, mcpServers.orgai); the caller installs
   * it as this.harnessServer when its query starts (harnessServerOf). Agent definitions come from the live server list.
   * `opts.maxBudgetUsd` replaces the project's budget (a restart passes what is left of it, restartBudget()).
   * `opts.plugin` is the skill plugin the query loads (a config restart's rebuilt one; null = none; undefined = the
   * session's current one). Its skills carry the live grants; a skill removed since it was copied is left out.
   */
  private async buildOptions(resume?: string, opts: { maxBudgetUsd?: number; plugin?: SkillPlugin | null } = {}): Promise<Options> {
    const { project } = this.ctx
    const env = buildEnv(this.ctx)
    const plugin = opts.plugin === undefined ? this.skillPlugin : (opts.plugin ?? undefined)
    const skillMap = this.skillNamesFor(plugin)
    const skillNames = [...skillMap.keys()]
    const tools = this.harnessTools
    const harnessServer = buildHarnessServer(tools, this.harnessCallers, this.isSetup ? SETUP_TOOLS_INSTRUCTIONS : undefined)

    // MCP servers: the project's (plus run-scoped installs) with secrets filled in, only these load (strictMcpConfig).
    // Servers a restarted query could not start with stay out of this session (recoverRestart).
    const resolved = (await this.resolvedServers())
    this.noteSecrets(resolved)
    const liveServers = this.liveMcpServers().filter((s) => !this.droppedMcp.has(s.name))

    const options: Options = {
      cwd: project.path,
      agents: buildAgents(this.ctx, tools, this.isolation, { mcpServers: liveServers }, skillMap),
      agent: this.root.slug,
      // Setup never edits files, so a plan-only project setting must not block the Architect's read tools.
      // An unattended ('auto') project keeps the classifier for the Architect's shell work too.
      permissionMode: claudePermissionMode(this.ctx),
      allowDangerouslySkipPermissions: claudeAllowsBypass(this.ctx),
      settingSources: claudeSettingSources(this.ctx),
      hooks: this.buildHooks(),
      // stream_event messages drive the live "agent.partial" text; transcripts still come from complete messages.
      includePartialMessages: true,
      // Subagent text and thinking are not forwarded by default; the nested transcripts need them.
      forwardSubagentText: true,
      abortController: this.abort,
      env,
      stderr: (data) => {
        const line = redactSecrets(data.trim(), this.secrets)
        if (line) this.log('warn', line)
      },
      canUseTool: async (toolName, input, permOptions) => {
        // The harness's own tools carry their approval inside the proposal round-trip.
        if (toolName.startsWith(ORGAI_TOOL_PREFIX)) return { behavior: 'allow', updatedInput: input }
        const key = permissionKey(toolName, input)
        const agentId = this.takeIssuer(key) ?? this.lastToolAgent.get(toolName) ?? ROOT_ID
        const cwd = this.agentCwd(agentId)
        // Backstop for the PreToolUse self-control gate (a call that reached canUseTool without the hook).
        const selfDenial = this.selfControlDenial(agentId, toolName, input, cwd)
        if (selfDenial) return { behavior: 'deny', message: selfDenial }
        // Backstop for the PreToolUse reference gate: never a card for an edit under a reference folder. The refusal row
        // is written here only when the hook did not already refuse (and write it for) this call.
        const edit = this.referenceEditRefusal(toolName, input, cwd)
        if (edit) {
          const refused = this.refusedEdits.get(key) ?? 0
          if (refused > 1) this.refusedEdits.set(key, refused - 1)
          else if (refused === 1) this.refusedEdits.delete(key)
          else this.referenceRefusalRow(agentId, edit.entry)
          return { behavior: 'deny', message: edit.reason }
        }
        // A shell, Read, Glob or Grep call touching a reference folder: the card names the folder, offers no rule
        // (RunManager narrows any allow to 'once'), and an allow grants this call only.
        // The hook's finding for this exact call: keyed by tool_use id (permOptions.toolUseID, 0.3.312 typings), else
        // permissionKey + agent (review L6).
        const toolUseId = typeof permOptions.toolUseID === 'string' && permOptions.toolUseID ? permOptions.toolUseID : undefined
        let ref = this.cardReferenceTouch({ key, agentId, ...(toolUseId ? { toolUseId } : {}) }, toolName, input, cwd)
        // Folder lists unreadable now (review L1): no suggestions; a shell call is asked like an unreadable reference
        // list (an allow grants this call only).
        const suggestOpts = ref ? null : this.suggestOptions(toolName, cwd)
        if (!ref && !suggestOpts && SHELL_TOOLS.has(toolName)) ref = { folder: null }
        this.setState(agentId, 'waiting', `Needs approval: ${describe(toolName, input)}`)
        // The SDK can forbid a "don't ask again" choice for asks whose rule would grant too much.
        // A trust-restricted run never gets a setMode suggestion (it stays ask-only after "allow for session").
        const suggestions = !suggestOpts
          ? []
          : restrictedSafeSuggestions(
              this.ctx,
              chooseSuggestions(
                toolName,
                input,
                permOptions.suggestions?.length ? fromSdkSuggestions(permOptions.suggestions) : undefined,
                !!permOptions.suppressAlwaysAllowRule,
                suggestOpts
              )
            )
        const decision = await this.ctx.requestPermission({
          agentId,
          toolName,
          input,
          summary: describe(toolName, input),
          ...(suggestions.length ? { suggestions, ruleLabels: suggestionLabels(suggestions) } : {}),
          ...(ref?.folder ? { referenceFolder: ref.folder } : {})
        })
        const a = this.agents.get(agentId)
        if (a && a.state === 'waiting') this.setState(agentId, 'tool', describe(toolName, input))
        if (decision.behavior === 'allow' && ref) return { behavior: 'allow', updatedInput: input }
        if (decision.behavior === 'allow') return this.allowWithScope(decision, suggestions, input, toolName)
        return { behavior: 'deny', message: decision.message }
      }
    }
    // Allowed and reference directories (live: folders granted during the run join the next build, a config restart
    // included). Reference folders are readable here and kept read-only by the PreToolUse reference gate.
    const dirs = claudeAdditionalDirectories(this.ctx)
    if (dirs.length) options.additionalDirectories = dirs
    if (CLAUDE_EXECUTABLE) options.pathToClaudeCodeExecutable = CLAUDE_EXECUTABLE
    options.mcpServers = this.mcpRecord(resolved, harnessServer)
    options.strictMcpConfig = true
    const plugins = toClaudePlugins(this.ctx.plugins?.())
    if (plugin && skillNames.length) {
      plugins.push({ type: 'local', path: plugin.path, skipMcpDiscovery: true })
      // Options.skills only adds Skill(<name>) allow rules (verified in sdk.mjs); the PreToolUse gate is the filter.
      options.skills = skillNames
      options.settings = { disableBundledSkills: true }
    }
    // Repo skills load under settingSources ['project']; never run their inline !`cmd` shell injection
    // (Settings.disableSkillShellExecution, present in sdk.d.ts and the bundled claude.exe).
    options.settings = { ...(options.settings as object | undefined), disableSkillShellExecution: true }
    if (plugins.length) options.plugins = plugins
    // "Always allow (project)" rules live in .claude/settings.local.json, which settingSources ['project'] does not load.
    // A quick run never reads the user's folder for rules: its grants arrive through allowedRules() (the PreToolUse hook).
    // A server an agent installed this run is never approved wholesale by a saved server-level rule (review M3).
    // Shell rules stay with the PreToolUse hook (ruleMatch.ts), never the CLI's prefix match (reviewer-4 H-A).
    const savedRules = cliAllowedTools(withoutServerRules(claudeSavedRules(this.ctx), this.agentInstalledMcp()))
    if (savedRules.length) options.allowedTools = savedRules
    if (this.root.model && this.root.model !== 'inherit') {
      if (validModelId(this.root.model)) options.model = this.root.model
      else this.log('warn', 'The root role has an invalid model id; using the CLI default.')
    }
    if (opts.maxBudgetUsd !== undefined) options.maxBudgetUsd = opts.maxBudgetUsd
    else if (project.maxBudgetUsd && !this.isSetup) options.maxBudgetUsd = project.maxBudgetUsd
    const resumeId = resume ?? this.ctx.resumeSessionId
    if (resumeId) options.resume = resumeId
    if (options.agents) this.optionGrants.set(options, grantSnapshot(options.agents))
    return options
  }

  /** Allow result for a decision; session and project scopes add the suggested rules for the rest of the session. */
  private allowWithScope(
    decision: Extract<PermissionDecision, { behavior: 'allow' }>,
    suggestions: PermissionSuggestion[],
    input: Record<string, unknown>,
    toolName: string
  ): PermissionResult {
    // Folder lists unreadable now (review L1): this call only, no rule kept.
    const opts = suggestions.length ? this.safeMatchOptions(toolName) : null
    if (!opts) return { behavior: 'allow', updatedInput: input }
    const granted = applyAllowScope(
      this.ctx.project.path,
      quickSafeDecision(this.ctx, decision),
      suggestions,
      (level, message) => this.log(level, message),
      allowScopePersist(this.ctx),
      { toolName, input, opts }
    )
    if (!granted) return { behavior: 'allow', updatedInput: input }
    for (const r of allowRuleStrings(granted)) this.sessionRules.add(r)
    // Shell rules stay in sessionRules (the hook's allow path, kept across a restarted query) and never reach the CLI (H1).
    const updates = toSdkSessionUpdates(granted)
    return {
      behavior: 'allow',
      updatedInput: input,
      ...(updates.length ? { updatedPermissions: updates } : {}),
      decisionClassification: 'user_permanent'
    }
  }

  private async run(): Promise<void> {
    const runId = this.ctx.run.id
    this.ensureAgent(ROOT_ID, {
      roleId: this.root.id,
      roleSlug: this.root.slug,
      name: this.root.name,
      parentId: null,
      state: 'thinking',
      activity: 'Reading your request…'
    })
    if (this.ctx.resumeSessionId) {
      this.transcript(ROOT_ID, { kind: 'system', text: `Continued from run ${this.ctx.run.resumedFrom ?? this.ctx.resumeSessionId}` }, { source: 'harness' })
    }
    this.transcript(ROOT_ID, userBlock(this.ctx.prompt, this.ctx.images))

    let firstMessage = composeFirstMessage(this.ctx.prompt, this.ctx.hiddenContext)

    try {
      if (this.isolation) {
        const leftover = await this.integrator.start()
        if (leftover) firstMessage += `\n\n---\n${leftover}`
      }
      this.input.push({
        type: 'user',
        message: { role: 'user', content: userContent(firstMessage, this.ctx.images) },
        parent_tool_use_id: null
      })
      this.prepare()
      const first = await this.buildOptions()
      this.harnessServer = harnessServerOf(first)
      this.queryGrants = this.optionGrants.get(first)
      this.liveGrants = this.queryGrants
      this.q = query({ prompt: this.input, options: first })
      for (;;) {
        try {
          for await (const msg of this.q) this.handle(msg)
        } catch (e) {
          if (this.abort.signal.aborted) throw e
          if (this.nextQuery) {
            // The old query was closed for an MCP restart; the next one takes over below.
          } else if (this.restarts > 0 && !this.queryInitSeen && this.sessionId) {
            // A restarted query failed before it started: never fail the run for it (review M4).
            const { next, why } = await this.recoverRestart(redactSecrets((e as Error).message ?? String(e), this.secrets))
            if (!next) {
              this.endPausedAfterRestart(why)
              break
            }
            this.replayInput()
            this.nextQuery = next
          } else throw e
        }
        const next = this.nextQuery
        this.nextQuery = undefined
        if (!next || this.abort.signal.aborted || this.ending) break
        this.clearRestartTimers()
        this.startRestartedQuery(next)
      }
      if (!this.pausedEnd) this.emitEnd()
    } catch (e) {
      if (this.abort.signal.aborted) {
        this.emitEnd()
      } else {
        const message = redactSecrets((e as Error).message ?? String(e), this.secrets)
        this.log('error', message)
        this.setState(ROOT_ID, 'error', message.slice(0, 80))
        this.emit({ type: 'run.status', runId, status: 'error', error: message })
      }
    } finally {
      this.ending = true
      this.continuation.dispose()
      this.stopUsagePolling()
      this.cleanupPlugins()
      this.partial.clearAll()
      for (const a of this.agents.values()) {
        if (a.state !== 'done' && a.state !== 'error') {
          a.state = 'done'
          a.endedAt = Date.now()
          this.upsert(a)
        }
      }
    }
  }

  /**
   * No restarted query could start (recoverRestart gave up): end the session paused, not failed. Unless the user held
   * the run (interrupt or window cap) or a message of theirs never reached a started query, RunManager resumes it at
   * pausedUntil (a fresh resume of the same session, without this run's run-scoped servers). Otherwise autoResume is
   * false with no pausedUntil and the run waits for the user. An undelivered message is never replayed (review M1):
   * the pause reason asks the user to send it again, so it cannot arrive twice and RESUME_TEXT never replaces it.
   */
  private endPausedAfterRestart(why: string): void {
    this.pausedEnd = true
    this.ending = true
    const undelivered = this.undeliveredUserMessages()
    // A run the user interrupted (or the window cap stopped) waits for the user, never auto-resumes (review N1).
    const autoResume = !(this.held || this.capTripped || undelivered > 0)
    const pausedUntil = autoResume ? Date.now() + MCP_RESTART_PAUSE_MS : undefined
    const base = this.restartForConfig ? 'The session could not be resumed after a configuration change.' : 'The session could not be resumed after attaching an MCP server.'
    const resend = undelivered
      ? ` ${undelivered === 1 ? 'Your last message was' : `Your last ${undelivered} messages were`} not delivered; send ${undelivered === 1 ? 'it' : 'them'} again to continue.`
      : ''
    const reason = base + resend
    const when = pausedUntil ? `it resumes at ${new Date(pausedUntil).toLocaleString()} or when you continue it` : 'it waits until you continue it'
    this.log('error', `${base} Pausing the run; ${when}. Last error: ${why}`)
    this.transcript(ROOT_ID, { kind: 'system', text: `${base} The run is paused.${resend}`, detail: why }, { source: 'harness' })
    this.setState(ROOT_ID, 'idle', 'Paused')
    this.emit({ type: 'run.status', runId: this.ctx.run.id, status: 'paused', ...(pausedUntil ? { pausedUntil } : {}), pauseReason: reason, autoResume })
  }

  /** The run's closing status: 'error' with the readable message after an auth failure, else 'finished'. */
  private emitEnd(): void {
    const runId = this.ctx.run.id
    if (this.authFailed) this.emit({ type: 'run.status', runId, status: 'error', error: authFailureMessage(this.ctx.connection?.connection) })
    else this.emit({ type: 'run.status', runId, status: 'finished' })
  }

  /** An agent's turn was an auth failure: say so once, mark the root and end the session. */
  private failAuth(raw: string): void {
    if (this.authFailed) return
    this.authFailed = true
    const message = authFailureMessage(this.ctx.connection?.connection)
    const detail = authFailureDetail(raw, this.secrets)
    this.transcript(ROOT_ID, { kind: 'system', text: message, ...(detail ? { detail } : {}) }, { source: 'harness' })
    this.log('error', `Authentication failed${detail ? `: ${detail}` : ''}`)
    this.partial.clearAll()
    this.setState(ROOT_ID, 'error', 'Connection refused')
    this.ending = true
    void this.stop()
  }

  private handle(msg: SDKMessage): void {
    if (this.authFailed) return
    const runId = this.ctx.run.id
    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init') {
          const root = this.ensureAgent(ROOT_ID)
          root.model = msg.model
          this.upsert(root)
          this.sessionId = msg.session_id
          this.queryInitSeen = true
          this.preInit = []
          // A restarted query that starts clears the failure count, so a later restart gets its own retries.
          this.restartFailures = 0
          // A query that started holds its own plugin: plugins it replaced (or a failed restart built) can go now.
          this.retirePlugins()
          this.emit({ type: 'run.status', runId, status: 'running', sessionId: msg.session_id })
          // The SDK re-emits init on every resumed turn (reports landing, harness messages); log it once.
          if (!this.sessionLogged) {
            this.sessionLogged = true
            this.log('info', `Session ${msg.session_id} started with Claude Code ${msg.claude_code_version} (${msg.model})`)
          }
          this.startUsagePolling()
        } else if (msg.subtype === 'task_started') {
          // Background shell commands and MCP calls are tasks too; only subagents belong on the chart. The others are
          // counted until they end, because an MCP restart would kill them (review M5). Ambient tasks (watchers,
          // housekeeping) are left out: the SDK says they are not activity, and some never end.
          if (msg.task_type && msg.task_type !== 'local_agent') {
            if (!msg.ambient && !msg.skip_transcript) this.backgroundTasks.add(msg.task_id)
            break
          }
          // A SendMessage to a finished subagent resumes it with parent_task_id = the messenger (possibly its own
          // descendant); resolveParent keeps an existing agent's parent so the tree can never gain a cycle.
          const candidate = msg.parent_task_id ?? (msg.tool_use_id ? this.toolUseIssuer.get(msg.tool_use_id) : undefined)
          const parentId = resolveParent(this.agents, msg.task_id, candidate, ROOT_ID)
          if (msg.tool_use_id) this.taskByToolUse.set(msg.tool_use_id, msg.task_id)
          const slug = msg.subagent_type ?? 'general-purpose'
          const role = this.rolesBySlug.get(slug)
          const existing = this.agents.get(msg.task_id)
          if (msg.description) this.integrator.noteBrief(msg.task_id, msg.description)
          const handle = (msg.tool_use_id ? this.spawnHandles.get(msg.tool_use_id) : undefined) ?? existing?.handle
          // Claude Code creates the worktree itself at a known path; the first tool call confirms the real cwd.
          // A nested spawn's worktree lands inside its parent's worktree; integration re-locates it with git either way.
          const spawner = msg.tool_use_id ? this.isolatedSpawns.get(msg.tool_use_id) : undefined
          const parentWt = spawner && spawner !== ROOT_ID ? this.integrator.worktreeOf(spawner) : undefined
          const worktree: WorktreeInfo | undefined =
            this.integrator.worktreeOf(msg.task_id) ??
            (spawner
              ? this.integrator.track(msg.task_id, {
                  path: join(parentWt?.path ?? this.ctx.project.path, '.claude', 'worktrees', `agent-${msg.task_id}`),
                  branch: `worktree-agent-${msg.task_id}`,
                  status: 'active',
                  ...(parentWt
                    ? { mergeTarget: 'parent' as const, parentAgentId: spawner, parentBranch: parentWt.branch }
                    : { mergeTarget: 'main' as const })
                })
              : undefined)
          this.upsert({
            ...(existing ?? this.ensureAgent(msg.task_id, { roleSlug: slug, parentId })),
            roleId: role?.id ?? null,
            roleSlug: slug,
            name: role?.name ?? slug,
            parentId,
            spawnToolUseId: msg.tool_use_id ?? null,
            activity: msg.description?.slice(0, 90) || existing?.activity || 'Starting…',
            ...(worktree ? { worktree } : {}),
            ...(handle ? { handle } : {})
          })
        } else if (msg.subtype === 'api_retry') {
          // SDKAPIRetryMessage carries no agent fields, so a retry counts against the root.
          const root = this.ensureAgent(ROOT_ID)
          countUsage(root, 'retries')
          this.upsert(root)
        } else if (msg.subtype === 'task_updated') {
          const st = msg.patch?.status
          if (st === 'completed' || st === 'failed' || st === 'killed') this.backgroundTaskEnded(msg.task_id)
        } else if (msg.subtype === 'task_notification') {
          this.backgroundTaskEnded(msg.task_id)
          const a = this.agents.get(msg.task_id)
          if (a) {
            a.state = msg.status === 'completed' ? 'done' : 'error'
            a.activity = msg.status === 'completed' ? 'Reported back' : `Task ${msg.status}`
            a.result = a.result ?? msg.summary
            a.endedAt = Date.now()
            this.upsert(a)
            void this.integrator.onSubagentFinished(a.id)
          }
        }
        break
      }
      case 'assistant': {
        const authRaw = authFailureFrom(msg)
        if (authRaw !== null) {
          this.failAuth(authRaw)
          break
        }
        const agentId = this.resolveAgentId(msg)
        const a = this.ensureAgent(agentId)
        const usage = msg.message.usage
        const messageId = msg.message.id || msg.uuid
        if (!this.turnIds.has(`${agentId}:${messageId}`)) {
          this.turnIds.add(`${agentId}:${messageId}`)
          countUsage(a, 'turns')
        }
        if (usage) {
          // Streaming emits one message per content block and the CLI may re-send a message after a
          // permission answer, all sharing message.id. Count each message id once, using its latest usage.
          const perAgent = this.usageByMessage.get(agentId) ?? new Map<string, { input: number; output: number; model?: string; mix: TokenMix }>()
          const mix: TokenMix = {
            input: usage.input_tokens ?? 0,
            output: usage.output_tokens ?? 0,
            cacheRead: usage.cache_read_input_tokens ?? 0,
            cacheCreation: usage.cache_creation_input_tokens ?? 0
          }
          perAgent.set(messageId, {
            input: mix.input + mix.cacheRead + mix.cacheCreation,
            output: mix.output,
            model: msg.message.model || perAgent.get(messageId)?.model || a.model,
            mix
          })
          this.usageByMessage.set(agentId, perAgent)
          let input = 0
          let output = 0
          for (const u of perAgent.values()) {
            input += u.input
            output += u.output
          }
          a.inputTokens = input
          a.outputTokens = output
          this.syncModelUsage(a, perAgent)
          // Live estimate at the last known per-model rates; the next result message reconciles it.
          if (this.litellmPricing()) {
            a.costUsd = this.agentCost(perAgent.values())
            this.emitPricedTotal()
          } else if (this.costRates) a.costUsd = costOf(perAgent.values(), this.costRates)
        }
        if (msg.message.model) a.model = msg.message.model
        // A background report can wake an idle orchestrator into a new turn.
        if (a.state === 'idle' || a.state === 'done') {
          a.state = 'thinking'
          a.activity = 'Thinking…'
          if (agentId === ROOT_ID) this.emit({ type: 'run.status', runId: this.ctx.run.id, status: 'running' })
        }
        for (const [index, block] of msg.message.content.entries()) {
          // A re-sent message repeats blocks already shown; skip anything seen under this message id.
          const blockKey = `${messageId}:${index}:${block.type}`
          if (this.seenBlocks.has(blockKey)) continue
          if (block.type === 'text' && block.text.trim()) {
            this.seenBlocks.add(blockKey)
            a.lastText = block.text.trim().slice(0, 200)
            this.transcript(agentId, { kind: 'text', text: block.text })
          } else if (block.type === 'thinking' && block.thinking?.trim()) {
            this.seenBlocks.add(blockKey)
            this.transcript(agentId, { kind: 'thinking', text: block.thinking })
          } else if (block.type === 'tool_use') {
            if (this.seenToolUses.has(block.id)) continue
            this.seenToolUses.add(block.id)
            countUsage(a, 'toolCalls')
            this.seenBlocks.add(blockKey)
            this.toolUseIssuer.set(block.id, agentId)
            this.transcript(agentId, { kind: 'tool_use', id: block.id, name: block.name, input: block.input })
          }
        }
        if (msg.error) this.log('warn', `Assistant message error: ${JSON.stringify(msg.error)}`)
        if (msg.error === 'rate_limit' && !this.limited) {
          // No rejected rate_limit_event came first; fall back to the last known reset of the limiting window.
          const w = this.usage?.windows.fiveHour
          const until = this.usage?.limitedUntil ?? (w && w.utilization !== null && w.utilization >= 100 ? w.resetsAt ?? undefined : undefined)
          this.onRateLimited(until, this.usage?.limitedWindow)
        }
        // The completed text block replaces whatever was streamed for it.
        if (msg.message.content.some((b) => b.type === 'text')) this.partial.clear(agentId)
        this.upsert(a)
        break
      }
      case 'stream_event': {
        this.partial.onEvent(this.resolveAgentId(msg), msg.event)
        break
      }
      case 'user': {
        const agentId = this.resolveAgentId(msg)
        const content = msg.message.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              // A resumed session (continued run or MCP restart) may replay history; show each result once.
              if ((this.ctx.resumeSessionId || this.restarts > 0) && this.seenToolResults.has(block.tool_use_id)) continue
              this.seenToolResults.add(block.tool_use_id)
              this.transcript(agentId, {
                kind: 'tool_result',
                toolUseId: block.tool_use_id,
                content: textOf(block.content).slice(0, 4000),
                isError: !!block.is_error
              })
            }
          }
        }
        break
      }
      case 'result': {
        const cliCost = this.runCost(msg.total_cost_usd)
        if (this.litellmPricing()) {
          // Pricing-derived total; the CLI total only stands in when pricing priced nothing.
          this.apportionCost(msg.modelUsage)
          const priced = this.emitPricedTotal()
          if (!(priced > 0) && cliCost > 0) {
            this.lastPricedTotal = cliCost
            this.emit({ type: 'run.cost', runId, totalCostUsd: cliCost })
          }
        } else {
          this.emit({ type: 'run.cost', runId, totalCostUsd: cliCost })
          this.apportionCost(msg.modelUsage)
        }
        this.partial.clear(ROOT_ID, true)
        const authRaw = authFailureFrom(msg)
        if (authRaw !== null) {
          this.failAuth(authRaw)
          break
        }
        const root = this.ensureAgent(ROOT_ID)
        if (msg.subtype === 'success') {
          root.result = msg.result
          root.state = 'idle'
          const reportsRunning = [...this.agents.values()].some(
            (x) => x.id !== ROOT_ID && x.state !== 'done' && x.state !== 'error'
          )
          root.activity = reportsRunning ? 'Waiting on reports…' : 'Waiting for you'
        } else {
          root.state = 'error'
          root.activity = msg.subtype.replace(/^error_/, '').replace(/_/g, ' ')
          this.log('error', `Run ended: ${msg.subtype}`)
        }
        this.upsert(root)
        this.emit({ type: 'run.status', runId, status: 'idle' })
        // Unattended execution: after a short delay (a report that just landed wakes the orchestrator
        // first), remind it of the plan's remaining steps. The driver re-checks every condition then.
        // With an MCP restart due, the restart's notice re-engages the orchestrator instead (onTurnEnded, review H1).
        if (msg.subtype === 'success' && !this.isSetup) this.onTurnEnded()
        // MCP servers approved this turn reach the agents through a restart once everything is idle.
        if (this.restartDue()) this.scheduleMcpRestart()
        if (this.limited && !this.ending) {
          // Every further request would be rejected too. End the session; the run manager pauses the
          // run and continues it when the window resets.
          this.ending = true
          this.log('info', 'Ending the session at the usage limit; it continues when the window resets.')
          void this.stop()
        }
        break
      }
      case 'rate_limit_event': {
        const info = msg.rate_limit_info as RateLimitInfoLike
        const next = mapRateLimitEvent(info, this.usage)
        if (this.authMode === 'apiKey') next.authMode = 'apiKey'
        else this.authMode = 'subscription'
        this.applyUsage(next)
        if (info.status === 'rejected') this.onRateLimited(next.limitedUntil, next.limitedWindow)
        break
      }
      default:
        break
    }
  }
}

export class ClaudeAdapter implements RuntimeAdapter {
  readonly id = 'claude' as const

  async start(ctx: RuntimeContext): Promise<RuntimeSession> {
    return new ClaudeSession(ctx)
  }

  /**
   * Plan usage without a run. A query whose input never yields still answers the usage control
   * request within a second of starting (verified in scripts/smoke-usage-probe.mjs), so this
   * spends nothing: no prompt is sent and the process is aborted right after the answer.
   */
  async probeUsage(auth: ProviderAuth): Promise<UsageStatus | null> {
    if (auth.kind === 'apiKey') return mapUsageResponse(null, 'apiKey')
    const abort = new AbortController()
    let release: ((r: IteratorResult<SDKUserMessage>) => void) | undefined
    const never: AsyncIterable<SDKUserMessage> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<SDKUserMessage>>((r) => (release = r)) })
    }
    const finish = (): void => {
      abort.abort()
      release?.({ value: undefined as never, done: true })
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const q = query({ prompt: never, options: probeQueryOptions(abort, isolateClaudeEnv(process.env)) })
      // Drain the stream in the background so the process keeps running until we abort it.
      const drain = (async () => {
        try {
          for await (const _ of q as AsyncIterable<unknown>) void _
        } catch {
          /* aborted */
        }
      })()
      const fn = (q as unknown as Record<string, unknown>)[USAGE_METHOD]
      if (typeof fn !== 'function') {
        finish()
        await drain
        return null
      }
      const resp = (await Promise.race([
        (fn as (o: { skipBehaviors: boolean }) => Promise<unknown>).call(q, { skipBehaviors: true }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('usage probe timed out')), 10_000)
        })
      ])) as UsageResponseLike
      finish()
      await drain
      return mapUsageResponse(resp, 'subscription')
    } catch {
      finish()
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * The models the CLI offers, without a run. supportedModels() returns the initialize response, so like
   * probeUsage it answers with no prompt and no model call. Null on any error or timeout; never throws.
   */
  async listModels(auth: ProviderAuth): Promise<AdapterModelInfo[] | null> {
    const abort = new AbortController()
    let release: ((r: IteratorResult<SDKUserMessage>) => void) | undefined
    const never: AsyncIterable<SDKUserMessage> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<SDKUserMessage>>((r) => (release = r)) })
    }
    const finish = (): void => {
      abort.abort()
      release?.({ value: undefined as never, done: true })
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const env: Record<string, string | undefined> = isolateClaudeEnv(process.env)
      if (auth.kind === 'apiKey') {
        const key = process.env[auth.envVar]
        if (key) env.ANTHROPIC_API_KEY = key
      }
      const q = query({ prompt: never, options: probeQueryOptions(abort, env) })
      const drain = (async () => {
        try {
          for await (const _ of q as AsyncIterable<unknown>) void _
        } catch {
          /* aborted */
        }
      })()
      const fn = (q as unknown as Record<string, unknown>).supportedModels
      if (typeof fn !== 'function') {
        finish()
        await drain
        return null
      }
      const resp = await Promise.race([
        (fn as () => Promise<unknown>).call(q),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('model list timed out')), 10_000)
        })
      ])
      clearTimeout(timer)
      finish()
      await drain
      return mapSupportedModels(resp)
    } catch {
      clearTimeout(timer)
      finish()
      return null
    }
  }

  async complete(input: CompletionInput): Promise<string> {
    const options = buildCompletionOptions(input)
    const link = input.signal ? linkAbortSignal(input.signal) : undefined
    if (link) options.abortController = link.controller
    let text = ''
    let reported = false
    try {
      for await (const msg of query({ prompt: input.prompt, options })) {
        if (msg.type === 'result' && !reported && input.onUsage) {
          reported = true
          const u = msg.usage
          input.onUsage({
            tokens: { input: u?.input_tokens ?? 0, output: u?.output_tokens ?? 0, cacheRead: u?.cache_read_input_tokens ?? 0, cacheWrite: u?.cache_creation_input_tokens ?? 0 },
            costUsd: msg.total_cost_usd,
            model: input.model
          })
        }
        if (msg.type === 'assistant') {
          for (const block of msg.message.content) if (block.type === 'text') text += block.text
        } else if (msg.type === 'result' && msg.subtype !== 'success') {
          throw new Error(`Completion failed: ${msg.subtype}`)
        }
        if (authFailureFrom(msg) !== null) throw new Error(authFailureMessage(input.connection?.connection))
      }
    } catch (err) {
      if (input.signal?.aborted) throw new Error('Completion cancelled')
      throw err
    } finally {
      link?.dispose()
    }
    if (input.signal?.aborted) throw new Error('Completion cancelled')
    if (isAuthFailure({ text })) throw new Error(authFailureMessage(input.connection?.connection))
    return text
  }
}

/** Options for the token-free discovery and usage probes. strictMcpConfig + empty mcpServers keep repo and user-scope MCP servers from starting. */
export function probeQueryOptions(abort: AbortController, env: Record<string, string | undefined>): Options {
  return { cwd: tmpdir(), settingSources: [], abortController: abort, tools: [], strictMcpConfig: true, mcpServers: {}, env, ...EXECUTABLE_OPTION }
}

/** Query options for one-shot completions. strictMcpConfig + empty mcpServers keep a cloned repo's .mcp.json from loading. */
export function buildCompletionOptions(input: CompletionInput): Options {
  const options: Options = {
    cwd: input.cwd,
    systemPrompt: { type: 'custom', prompt: input.system },
    tools: [],
    maxTurns: 1,
    settingSources: [],
    permissionMode: 'dontAsk',
    strictMcpConfig: true,
    mcpServers: {},
    ...EXECUTABLE_OPTION
  }
  if (input.model && validModelId(input.model)) options.model = input.model
  options.env = completionEnv(input.connection)
  return options
}

/** Copy SDK permission updates into the structured-clone-safe shared shape. */
function fromSdkSuggestions(updates: PermissionUpdate[]): PermissionSuggestion[] {
  return updates.map((u): PermissionSuggestion => {
    switch (u.type) {
      case 'addRules':
      case 'replaceRules':
      case 'removeRules':
        return {
          type: u.type,
          rules: u.rules.map((r) => (r.ruleContent ? { toolName: r.toolName, ruleContent: r.ruleContent } : { toolName: r.toolName })),
          behavior: u.behavior,
          destination: u.destination
        }
      case 'addDirectories':
      case 'removeDirectories':
        return { type: u.type, directories: [...u.directories], destination: u.destination }
      case 'setMode':
        return { type: 'setMode', mode: u.mode, destination: u.destination }
    }
  })
}

/**
 * Shared suggestions back to SDK updates, all scoped to this session (persistence is the harness's job). Allow rules for
 * Bash / PowerShell are left out of addRules / replaceRules (review H1): the CLI's matcher strips wrappers (timeout,
 * nice, nohup, ...) and leading env assignments, so a session `Bash(npm test:*)` would approve `timeout 5 npm test
 * --script-shell=calc`, which the PreToolUse hook (the only shell allow path, through sessionRules) refuses. A rules
 * update left empty is dropped. Pure.
 */
export function toSdkSessionUpdates(suggestions: PermissionSuggestion[]): PermissionUpdate[] {
  const out: PermissionUpdate[] = []
  for (const s of suggestions) {
    if (s.type === 'setMode') out.push({ type: 'setMode', mode: s.mode as SdkPermissionMode, destination: 'session' })
    else if ('directories' in s) out.push({ type: s.type, directories: [...s.directories], destination: 'session' })
    else {
      const dropShell = s.behavior === 'allow' && s.type !== 'removeRules'
      const rules = dropShell ? s.rules.filter((r) => cliAllowedTools([ruleText(r)]).length > 0) : s.rules
      if (dropShell && !rules.length) continue
      out.push({ type: s.type, rules: rules.map((r) => ({ ...r })), behavior: s.behavior, destination: 'session' })
    }
  }
  return out
}

function ruleText(r: { toolName: string; ruleContent?: string }): string {
  return r.ruleContent === undefined ? r.toolName : `${r.toolName}(${r.ruleContent})`
}

type SdkPermissionMode = Extract<PermissionUpdate, { type: 'setMode' }>['mode']
