/**
 * Bridged reports (multi-provider org charts, phase 1). A bridged role runs on another connection or adapter than the
 * run's root, so it cannot share the root's process. `BridgedSessions` (one per ActiveRun) starts such a role as a CHILD
 * RuntimeSession on its own adapter and RunConnection, shows its agents in the parent run as ordinary agent.upsert
 * events and resolves `spawn` with the child root's final text.
 *
 * Id scheme: the child's root becomes a fresh `ag_...` agent under the delegating agent; every other child agent id is
 * `${rootId}:${childId}` (handle prefixed `${handle}.`). Cards raised by the child go through the parent's hooks with
 * the agent ids remapped, so they sit in the parent's pending maps.
 *
 * Completion: the child root's turn ended (run.status 'idle') and the session's settlement says rootIdle && quiescent
 * (a session without settlement() counts as settled). Never rejects for a child failure: `ok: false` with a text.
 * Nothing here logs or forwards a RunConnection; secret values of every RunConnection of the run are redacted from the
 * events and display texts the wrapper forwards (transcript, partials, messages, logs, agents; card summary, question,
 * option descriptions and reasons). Card fields decisions depend on (tool input, rules, option labels, MCP specs) are
 * forwarded exactly.
 */
import type { AgentInstance, BridgedRoleChoice, ConnectionId, ProviderId, Project, Role, RunEvent, RunSummary, TranscriptEntry } from '@shared/types'
import { BRIDGE_RESULT_MAX_CHARS } from '@shared/types'
import { effectiveSubagentLimits, newId } from '@shared/defaults'
import { HandleNamer, spawnHandle } from './network'
import { settleAgent, isLiveAgent, type RunOutcome } from './activity'
import {
  ROOT_AGENT_ID,
  type BridgeSpawnInput,
  type BridgeSpawnResult,
  type BridgedRole,
  type KnowledgeCaller,
  type RunConnection,
  type RuntimeAdapter,
  type RuntimeContext,
  type RuntimeSession
} from './types'

/** How long stopAll waits for one child's session to end. */
export const BRIDGE_STOP_TIMEOUT_MS = 5000
/** Re-check interval while a child's root is idle but its session is not quiescent yet. */
export const BRIDGE_POLL_MS = 500

export interface BridgedSessionsDeps {
  adapters: Partial<Record<ProviderId, RuntimeAdapter>>
  /** The run's own RuntimeContext, read at call time (roles, project and hooks may change during the run). */
  parent: () => RuntimeContext
  /** The run's bridged roles (AdapterChoice.bridged). */
  bridged: readonly BridgedRoleChoice[]
  /** RunConnection per `${connection}|${adapter}` (bridgeKey). Holds secrets: never emitted or logged. */
  connections: ReadonlyMap<string, RunConnection>
  /** Every RunConnection of the run that is not in `connections` (the root's), for redaction only. */
  extraConnections?: readonly RunConnection[]
  /** The run's own emit path; bridged events are routed through it with the remapped ids. */
  emit: (e: RunEvent) => void
  /** The run's agents right now (native and bridged). */
  agents: () => AgentInstance[]
  connectionName: (id: ConnectionId) => string
  log?: { info(m: string): void; warn(m: string): void }
}

/** Key of a RunConnection in BridgedSessionsDeps.connections. */
export const bridgeKey = (connection: ConnectionId, adapter: ProviderId): string => `${connection}|${adapter}`

interface Child {
  agentId: string
  handle: string
  role: Role
  choice: BridgedRoleChoice
  parentAgentId: string
  /** Latest remapped agents of this child, by remapped id. */
  agents: Map<string, AgentInstance>
  session?: RuntimeSession
  idle: boolean
  lastText: string
  done: boolean
  poll?: ReturnType<typeof setTimeout>
  resolve: (r: BridgeSpawnResult) => void
  stopped?: Promise<void>
  /** The adapter.start call while it is pending (never rejects). */
  opening?: Promise<void>
}

/** Env names whose values are always secrets, whatever characters they have. */
const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL/i
const MIN_SECRET_CHARS = 8

/**
 * The secret values of RunConnections. RunConnection.apiKey is always a secret, and so is every env value whose NAME looks
 * like one (with or without / and \). Other env values count unless they parse as http(s) URLs; a URL's userinfo
 * (user:pass) is a secret. Header-like values also add the part after "Bearer " and after "name:". Longest first.
 */
export function connectionSecrets(list: Iterable<RunConnection>): string[] {
  const out = new Set<string>()
  const add = (s: string | undefined): void => {
    if (typeof s === 'string' && s.length >= MIN_SECRET_CHARS) out.add(s)
  }
  const addValue = (v: string): void => {
    add(v)
    const bearer = /^\s*bearer\s+(.+)$/i.exec(v)
    if (bearer) add(bearer[1]!.trim())
    const named = /^\s*[A-Za-z][\w-]*\s*:\s*(.+)$/.exec(v)
    if (named) {
      add(named[1]!.trim())
      const inner = /^bearer\s+(.+)$/i.exec(named[1]!.trim())
      if (inner) add(inner[1]!.trim())
    }
  }
  const addUserinfo = (v: string): boolean => {
    let u: URL
    try {
      u = new URL(v)
    } catch {
      return false
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    if (u.username || u.password) {
      let user = u.username
      let pass = u.password
      try {
        user = decodeURIComponent(user)
        pass = decodeURIComponent(pass)
      } catch {
        // keep the raw spelling
      }
      add(pass)
      add(u.password)
      add(user && pass ? `${user}:${pass}` : user)
      add(u.username && u.password ? `${u.username}:${u.password}` : u.username)
    }
    return true
  }
  for (const c of list) {
    add(c.apiKey)
    for (const [k, v] of Object.entries(c.env ?? {})) {
      if (typeof v !== 'string') continue
      if (SECRET_ENV_NAME.test(k)) {
        addValue(v)
        addUserinfo(v)
        continue
      }
      if (addUserinfo(v)) continue
      // Routing names (not secret-named) are not secrets; secret-named ones were handled above.
      if (/^(CODEX_HOME|.*_MODEL|.*_REGION|.*_ORG(ANIZATION)?(_ID)?)$/i.test(k)) continue
      addValue(v)
    }
  }
  return [...out].sort((a, b) => b.length - a.length)
}

/** Replace every secret in a string. */
export function redactText(text: string, secrets: readonly string[]): string {
  if (typeof text !== 'string') return text
  let out = text
  for (const s of secrets) if (s && out.includes(s)) out = out.split(s).join('[redacted]')
  return out
}

function redactDeep<T>(v: T, secrets: readonly string[]): T {
  if (!secrets.length) return v
  if (typeof v === 'string') return redactText(v, secrets) as T
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, secrets)) as T
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = redactDeep(x, secrets)
    return o as T
  }
  return v
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Cut `text` to `max` characters, ending in a "[cut]" note when it was longer. */
export function cutResult(text: string, max = BRIDGE_RESULT_MAX_CHARS): string {
  if (text.length <= max) return text
  const note = '\n[cut]'
  return text.slice(0, Math.max(0, max - note.length)) + note
}

export class BridgedSessions {
  private children = new Map<string, Child>()

  constructor(private deps: BridgedSessionsDeps) {}

  activeCount(): number {
    let n = 0
    for (const c of this.children.values()) if (!c.done) n++
    return n
  }

  hasActive(): boolean {
    return this.activeCount() > 0
  }

  /** The bridged roles as RuntimeContext.bridge.roles() lists them (roles that no longer exist in the chart are skipped). */
  roles(): BridgedRole[] {
    const roles = this.deps.parent().roles
    const out: BridgedRole[] = []
    for (const b of this.deps.bridged) {
      const r = roles.find((x) => x.id === b.roleId)
      if (!r) continue
      out.push({ roleId: r.id, slug: r.slug, name: r.name, connection: b.connection, connectionName: this.deps.connectionName(b.connection), adapter: b.adapter })
    }
    return out
  }

  private secrets(): string[] {
    return connectionSecrets([...this.deps.connections.values(), ...(this.deps.extraConnections ?? [])])
  }

  // ---------- spawn ----------

  async spawn(input: BridgeSpawnInput): Promise<BridgeSpawnResult> {
    const parent = this.deps.parent()
    const want = String(input.role ?? '').trim()
    const choice = this.deps.bridged.find((b) => {
      const r = parent.roles.find((x) => x.id === b.roleId)
      return !!r && (r.id === want || r.slug === want)
    })
    const role = choice ? parent.roles.find((x) => x.id === choice.roleId) : undefined
    if (!choice || !role) throw new Error(`${want || 'That role'} does not run on another connection.`)
    const conn = this.deps.connections.get(bridgeKey(choice.connection, choice.adapter))
    const adapter = this.deps.adapters[choice.adapter]
    if (!conn || !adapter) throw new Error(`${role.name} cannot start: no runtime for ${this.deps.connectionName(choice.connection)}.`)

    const agents = this.deps.agents()
    const rootRole = parent.roles.find((r) => r.reportsTo === null)
    const parentAgent = input.parentAgentId ? agents.find((a) => a.id === input.parentAgentId) : undefined
    if (!input.parentAgentId && !input.parentRoleId) {
      // Unknown caller: it counts as the root only while no non-root agent that may delegate is live.
      const anyLiveSpawner = agents.some((a) => {
        if (a.id === ROOT_AGENT_ID || !isLiveAgent(a)) return false
        const r = a.roleId ? parent.roles.find((x) => x.id === a.roleId) : undefined
        return !!r?.canSpawn
      })
      if (anyLiveSpawner) throw new Error('OrgAI could not tell which agent called delegate_agent; call it again when your reports are done.')
    }
    const callerRole =
      (input.parentRoleId ? parent.roles.find((r) => r.id === input.parentRoleId) : undefined) ??
      (parentAgent?.roleId ? parent.roles.find((r) => r.id === parentAgent.roleId) : undefined) ??
      rootRole
    if (!callerRole || !callerRole.canSpawn || !callerRole.spawnable.includes(role.id)) {
      throw new Error(`Role ${callerRole?.name ?? 'unknown'} may not delegate to ${role.name}.`)
    }
    const limits = effectiveSubagentLimits({ ...parent.project, roles: parent.roles })
    const parentAgentId = parentAgent?.id ?? ROOT_AGENT_ID
    const byId = new Map(agents.map((a) => [a.id, a]))
    let depth = 0
    for (let cur: AgentInstance | undefined = byId.get(parentAgentId), guard = 0; cur && cur.id !== ROOT_AGENT_ID && guard < 50; guard++) {
      depth++
      cur = cur.parentId ? byId.get(cur.parentId) : undefined
    }
    if (depth + 1 > limits.depth) throw new Error(`Delegating to ${role.name} would nest reports ${depth + 1} deep; the limit is ${limits.depth}.`)
    const live = agents.filter((a) => a.id !== ROOT_AGENT_ID && isLiveAgent(a)).length
    if (live >= limits.concurrency) throw new Error(`${live} reports are already working; the limit is ${limits.concurrency}. Wait for one to finish.`)

    const namer = new HandleNamer()
    const taken = new Set<string>()
    for (const a of agents) {
      if (a.handle) {
        namer.reserve(a.handle)
        taken.add(a.handle.toLowerCase())
      }
    }
    const requested = typeof input.name === 'string' && input.name.trim() && !taken.has(input.name.trim().toLowerCase()) ? input.name : undefined
    const { handle } = spawnHandle(namer, role.slug, requested)
    const agentId = newId('ag')

    // The child's own adapter reads limits from its project and chart: hand it what is left of the run's budget.
    const childDepthBudget = limits.depth - (depth + 1)
    const childLimits = { depth: Math.max(1, childDepthBudget), concurrency: Math.max(1, limits.concurrency - live - 1) }
    const childRoles = this.childRoles(role, choice, parent.roles, childDepthBudget <= 0)
    const child: Child = {
      agentId,
      handle,
      role,
      choice,
      parentAgentId,
      agents: new Map(),
      idle: false,
      lastText: '',
      done: false,
      resolve: () => {}
    }
    const result = new Promise<BridgeSpawnResult>((resolve) => {
      child.resolve = resolve
    })
    this.children.set(agentId, child)

    const ctx = this.childContext(child, conn, childRoles, input, childLimits)
    // The agent exists on the canvas at once, before the child's first turn.
    const now = Date.now()
    const first: AgentInstance = {
      id: agentId,
      roleId: role.id,
      roleSlug: role.slug,
      name: role.name,
      parentId: parentAgentId,
      spawnToolUseId: input.toolUseId ?? null,
      state: 'starting',
      activity: (input.description || '').trim() || `Starting on ${this.deps.connectionName(choice.connection)}`,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      startedAt: now,
      handle,
      connection: choice.connection
    }
    child.agents.set(agentId, first)
    this.deps.emit({ type: 'agent.upsert', runId: parent.run.id, agent: redactDeep(first, this.secrets()) })
    try {
      input.onStarted?.({ agentId, handle })
    } catch (e) {
      this.deps.log?.warn(`Bridged report ${handle}: onStarted threw: ${errorText(e)}`)
    }
    this.deps.parent().noteActivity?.('subagent')

    void this.run(child, adapter, ctx)
    return result
  }

  /** The child's roles: the bridged role (as root) plus roles reachable through its spawnable chain on the same (connection, adapter). */
  private childRoles(role: Role, choice: BridgedRoleChoice, all: Role[], noSpawn = false): Role[] {
    const samePair = new Set(this.deps.bridged.filter((b) => b.connection === choice.connection && b.adapter === choice.adapter).map((b) => b.roleId))
    const reachable = new Map<string, Role>()
    const queue = [...role.spawnable]
    while (queue.length) {
      const id = queue.shift()!
      if (reachable.has(id) || id === role.id || !samePair.has(id)) continue
      const r = all.find((x) => x.id === id)
      if (!r) continue
      reachable.set(id, r)
      queue.push(...r.spawnable)
    }
    // No depth left: nobody in the child may delegate, so only the root role is kept.
    if (noSpawn) reachable.clear()
    const ids = new Set([role.id, ...reachable.keys()])
    const copy = (r: Role, root: boolean): Role => {
      const spawnable = noSpawn ? [] : r.spawnable.filter((id) => ids.has(id))
      return { ...r, spawnable, canSpawn: r.canSpawn && spawnable.length > 0, reportsTo: root ? null : r.reportsTo && ids.has(r.reportsTo) ? r.reportsTo : role.id }
    }
    return [copy(role, true), ...[...reachable.values()].map((r) => copy(r, false))]
  }

  private mapId(child: Child, childId: string): string {
    return childId === ROOT_AGENT_ID ? child.agentId : `${child.agentId}:${childId}`
  }

  private childContext(child: Child, conn: RunConnection, roles: Role[], input: BridgeSpawnInput, limits: { depth: number; concurrency: number }): RuntimeContext {
    const parentNow = (): RuntimeContext => this.deps.parent()
    const p0 = parentNow()
    const agent = (id: string | undefined): string | undefined => (id === undefined ? undefined : this.mapId(child, id))
    const withAgent = <T extends { agentId?: string }>(req: T): T => (typeof req.agentId === 'string' ? { ...req, agentId: this.mapId(child, req.agentId) } : req)
    const caller = (c: KnowledgeCaller): KnowledgeCaller => (c.agentId === undefined ? c : { ...c, agentId: this.mapId(child, c.agentId) })
    const refuse = (what: string): void => {
      this.deps.log?.warn(`Bridged report ${child.handle}: ${what} is not available to a bridged report.`)
    }
    const project: Project = {
      ...p0.project,
      roles,
      isolateWriters: false,
      maxSubagentDepth: limits.depth,
      maxConcurrentSubagents: limits.concurrency,
      provider: { ...p0.project.provider, id: child.choice.adapter }
    }
    const run: RunSummary = { ...p0.run, connection: child.choice.connection }
    const ctx: RuntimeContext = {
      run,
      project,
      roles,
      prompt: input.brief,
      emit: (e) => this.childEvent(child, e),
      connection: conn,
      autoContinue: false,
      maxAutoContinues: 0,
      bridgedChild: { agentId: child.agentId, parentAgentId: child.parentAgentId, roleId: child.role.id },
      // Cards: only display text is redacted (summary, question, option descriptions, reasons). Tool input, rules, option
      // labels and the MCP spec stay exact because decisions and rule matching depend on them.
      requestPermission: (req) => {
        const s = this.secrets()
        return parentNow().requestPermission(withAgent({ ...req, summary: redactText(req.summary, s) }))
      },
      requestQuestion: (req) => {
        const s = this.secrets()
        return parentNow().requestQuestion(
          withAgent({ ...req, question: redactText(req.question, s), options: (Array.isArray(req.options) ? req.options : []).map((o) => (o.description === undefined ? o : { ...o, description: redactText(o.description, s) })) })
        )
      },
      requestProposal: async () => {
        refuse('Proposals')
        return { behavior: 'decline', note: 'A bridged report cannot propose changes. Tell the agent that delegated to you what you need.' }
      },
      requestMergeReview: async () => {
        refuse('Merge review')
        return { behavior: 'hold' }
      },
      completeSetup: async () => refuse('Setup'),
      noteArchitectureUpdated: async () => {},
      getPlan: () => undefined,
      updatePlan: async () => {},
      rateLimited: (info) => {
        this.deps.emit({
          type: 'log',
          runId: p0.run.id,
          level: 'warn',
          message: `${child.handle} on ${this.deps.connectionName(child.choice.connection)} hit a usage limit${info.window ? ` (${info.window})` : ''}. The run itself keeps going.`
        })
      },
      pendingInteractions: () => parentNow().pendingInteractions(),
      noteActivity: (r) => parentNow().noteActivity?.(r)
    }
    // Pass-through hooks, read from the parent at call time. Only those the parent has are bound.
    const pass = <K extends keyof RuntimeContext>(key: K): void => {
      if (typeof p0[key] === 'function') (ctx as unknown as Record<string, unknown>)[key] = (...a: unknown[]) => (parentNow()[key] as unknown as (...x: unknown[]) => unknown)?.(...a)
    }
    if (p0.requestPermissionRules) ctx.requestPermissionRules = (req) => parentNow().requestPermissionRules!(withAgent({ ...req, reason: redactText(req.reason, this.secrets()) }))
    if (p0.requestMcpInstall) ctx.requestMcpInstall = (req) => parentNow().requestMcpInstall!(withAgent({ ...req, reason: redactText(req.reason, this.secrets()) }))
    for (const k of [
      'searchMcpRegistry',
      'mcpServers',
      'mcpLibrary',
      'resolveMcpSecrets',
      'resolvedMcpServers',
      'plugins',
      'skills',
      'allowedRules',
      'savedRules',
      'saveProjectRules',
      'allowedDirectories',
      'referenceDirectories',
      'allowDirectories',
      'acceptEditsForProject',
      'protectedDirectories',
      'controlProtectedPaths',
      'folderConfigLoads',
      'engagementDocument',
      'knowledgeBrief',
      'agentConnection'
    ] as const) {
      pass(k)
    }
    if (p0.opusGuardThreshold !== undefined) ctx.opusGuardThreshold = p0.opusGuardThreshold
    if (p0.engagementNotes) {
      ctx.engagementNotes = {
        list: () => parentNow().engagementNotes!.list(),
        read: (id) => parentNow().engagementNotes!.read(id),
        save: (i, c) => parentNow().engagementNotes!.save(i, caller(c))
      }
    }
    if (p0.knowledge) {
      ctx.knowledge = {
        graph: () => parentNow().knowledge!.graph(),
        upsertNode: (i, c) => parentNow().knowledge!.upsertNode(i, caller(c)),
        link: (i, c) => parentNow().knowledge!.link(i, caller(c)),
        retire: (i, c) => parentNow().knowledge!.retire(i, caller(c))
      }
    }
    if (p0.knowledgeRecall) ctx.knowledgeRecall = (i, c) => parentNow().knowledgeRecall!(i, caller(c))
    if (p0.knowledgeContext) ctx.knowledgeContext = (text, o) => parentNow().knowledgeContext!(text, o.agentId === undefined ? o : { ...o, agentId: agent(o.agentId) })
    return ctx
  }

  // ---------- the child's events ----------

  private childEvent(child: Child, e: RunEvent): void {
    if (child.done) return
    const parent = this.deps.parent()
    const secrets = this.secrets()
    parent.noteActivity?.('subagent')
    switch (e.type) {
      case 'run.status': {
        if (e.status === 'idle') {
          child.idle = true
          this.maybeComplete(child)
        } else if (e.status === 'running') {
          child.idle = false
        } else if (e.status === 'error') {
          this.finish(child, false, `Bridged report failed: ${redactText(e.error || 'the session ended with an error', secrets)}`)
        } else if (e.status === 'paused') {
          this.finish(child, false, `Bridged report failed: it paused${e.pauseReason ? ` (${redactText(e.pauseReason, secrets)})` : ' on a usage limit'}.`)
        } else if (e.status === 'finished') {
          if (child.lastText) this.finish(child, true, child.lastText)
          else this.finish(child, false, 'Bridged report failed: the session ended without a report.')
        }
        return
      }
      case 'agent.upsert': {
        const a = e.agent
        const isRoot = a.id === ROOT_AGENT_ID
        const mapped: AgentInstance = {
          ...a,
          id: this.mapId(child, a.id),
          parentId: isRoot ? child.parentAgentId : a.parentId ? this.mapId(child, a.parentId) : child.agentId,
          ...(a.handle ? { handle: `${child.handle}.${a.handle}` } : {}),
          connection: child.choice.connection,
          ...(isRoot ? { roleId: child.role.id, roleSlug: child.role.slug, name: child.role.name, handle: child.handle, spawnToolUseId: child.agents.get(child.agentId)?.spawnToolUseId ?? null } : {})
        }
        child.agents.set(mapped.id, mapped)
        this.deps.emit({ type: 'agent.upsert', runId: parent.run.id, agent: redactDeep(mapped, secrets) })
        if (isRoot && mapped.result && !child.lastText) child.lastText = mapped.result
        return
      }
      case 'agent.remove':
        child.agents.delete(this.mapId(child, e.agentId))
        this.deps.emit({ ...e, agentId: this.mapId(child, e.agentId) })
        return
      case 'transcript': {
        const entry: TranscriptEntry = { ...e.entry, agentId: this.mapId(child, e.entry.agentId) }
        if (e.entry.agentId === ROOT_AGENT_ID && e.entry.block.kind === 'text' && e.entry.source !== 'harness' && e.entry.block.text.trim()) child.lastText = e.entry.block.text
        this.deps.emit({ type: 'transcript', runId: parent.run.id, entry: redactDeep(entry, secrets) })
        return
      }
      case 'agent.partial':
        this.deps.emit({ ...e, agentId: this.mapId(child, e.agentId), text: redactText(e.text, secrets) })
        return
      case 'agent.message':
        this.deps.emit({ ...e, from: this.mapId(child, e.from), to: e.to === null ? null : this.mapId(child, e.to), text: redactText(e.text, secrets) })
        return
      case 'skill.used':
        this.deps.emit({ ...e, agentId: this.mapId(child, e.agentId) })
        return
      case 'knowledge.recalled':
        this.deps.emit({ ...e, agentId: this.mapId(child, e.agentId) })
        return
      case 'log':
        this.deps.emit({ ...e, message: redactText(e.message, secrets) })
        return
      default:
        // run.title / run.finalized / run.usage / run.cost / plan.updated / run.message / usage.status / project.updated and
        // every card event: the parent owns them, a child's copy is dropped.
        return
    }
  }

  // ---------- start, completion, stop ----------

  private async run(child: Child, adapter: RuntimeAdapter, ctx: RuntimeContext): Promise<void> {
    try {
      const opening = adapter.start(ctx)
      child.opening = opening.then(
        () => {},
        () => {}
      )
      const session = await opening
      child.session = session
      if (child.done) {
        // Stopped (stopAll or a failure) while opening: end the session that just came up.
        child.stopped = session.stop().then(
          () => session.finished.catch(() => {}),
          () => {}
        )
        return
      }
      void session.finished.then(
        () => {
          if (child.done) return
          if (child.lastText) this.finish(child, true, child.lastText)
          else this.finish(child, false, 'Bridged report failed: the session ended without a report.')
        },
        (e: unknown) => this.finish(child, false, `Bridged report failed: ${errorText(e)}`)
      )
      this.maybeComplete(child)
    } catch (e) {
      this.finish(child, false, `Bridged report failed: ${errorText(e)}`)
    }
  }

  private maybeComplete(child: Child): void {
    if (child.done || !child.idle || !child.session) return
    if (child.poll) clearTimeout(child.poll)
    child.poll = undefined
    let ok = true
    try {
      const s = child.session.settlement?.()
      ok = !s || (s.rootIdle && s.quiescent)
    } catch {
      ok = true
    }
    if (ok) {
      this.finish(child, true, child.lastText || child.agents.get(child.agentId)?.result || child.agents.get(child.agentId)?.lastText || '')
      return
    }
    child.poll = setTimeout(() => {
      child.poll = undefined
      this.maybeComplete(child)
    }, BRIDGE_POLL_MS)
  }

  /** End the child (once): settle its agents, resolve the spawn, stop its session. */
  private finish(child: Child, ok: boolean, text: string, outcome: RunOutcome = ok ? 'finished' : 'failed'): void {
    if (child.done) return
    child.done = true
    if (child.poll) clearTimeout(child.poll)
    child.poll = undefined
    const parent = this.deps.parent()
    const secrets = this.secrets()
    for (const a of [...child.agents.values()]) {
      const settled = settleAgent(a, a.id !== child.agentId && isLiveAgent(a), outcome, child.agentId)
      const final = a.id === child.agentId && ok ? { ...settled, ...(text && !settled.result ? { result: cutResult(text, 500) } : {}) } : settled
      if (final !== a) {
        child.agents.set(a.id, final)
        this.deps.emit({ type: 'agent.upsert', runId: parent.run.id, agent: redactDeep(final, secrets) })
      }
    }
    const session = child.session
    if (session) {
      child.stopped = session.stop().then(
        () => session.finished.catch(() => {}),
        () => {}
      )
    }
    child.resolve({ agentId: child.agentId, handle: child.handle, text: cutResult(redactText(text, secrets)), ok })
  }

  /** Stop every child. Their spawns resolve `ok: false` "Stopped: <reason>". Waits for the sessions to end (bounded). */
  async stopAll(reason: string): Promise<void> {
    const list = [...this.children.values()]
    for (const c of list) if (!c.done) this.finish(c, false, `Stopped: ${reason}`, 'stopped')
    // A child still opening is stopped as soon as it opens (run() sees `done`); wait for that too, within the bound below.
    const waits = list
      .filter((c) => c.stopped || (c.opening && !c.session))
      .map(async (c) => {
        await c.opening
        await c.stopped
      })
    if (!waits.length) return
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.allSettled(waits),
      new Promise<void>((r) => {
        timer = setTimeout(r, BRIDGE_STOP_TIMEOUT_MS)
      })
    ])
    if (timer) clearTimeout(timer)
  }
}
