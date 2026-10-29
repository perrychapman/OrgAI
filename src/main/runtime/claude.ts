import { basename, join } from 'node:path'
import {
  createSdkMcpServer,
  query,
  tool,
  type AgentDefinition,
  type HookCallback,
  type McpSdkServerConfigWithInstance,
  type Options,
  type PreToolUseHookInput,
  type PostToolUseHookInput,
  type SubagentStartHookInput,
  type SubagentStopHookInput,
  type SDKMessage,
  type SDKUserMessage,
  type Query
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { AgentInstance, Project, Role, RunEvent, TranscriptBlock, WorktreeInfo } from '@shared/types'
import { SPAWN_TOOL } from '@shared/types'
import { newId } from '@shared/defaults'
import { PROPOSAL_TOOLS } from '@shared/setup'
import { toRoles } from '../ai/draft'
import type { CompletionInput, RuntimeAdapter, RuntimeContext, RuntimeSession } from './types'
import { commitLeftovers, findWorktree, inspectPending, integrateWorktree, isGitRepo, pendingWorktrees, prepareRepo } from './worktrees'

const INTEGRATE_TOOL = 'integrate_worktrees'
const WRITE_TOOLS = new Set(['Edit', 'Write', 'Bash', 'NotebookEdit'])

function canWrite(role: Role): boolean {
  return role.tools.some((t) => WRITE_TOOLS.has(t))
}

const ROOT_ID = 'root'
/** MCP server name for the harness's own tools; tool names surface as mcp__orgai__<name>. */
const ORGAI_MCP = 'orgai'
const ORGAI_TOOL_PREFIX = `mcp__${ORGAI_MCP}__`

const PROPOSAL_ACTIVITY: Record<string, string> = {
  [PROPOSAL_TOOLS.architecture]: 'Proposing the architecture…',
  [PROPOSAL_TOOLS.orgChart]: 'Proposing the org chart…',
  [PROPOSAL_TOOLS.settings]: 'Proposing run settings…',
  [PROPOSAL_TOOLS.complete]: 'Wrapping up setup…',
  [PROPOSAL_TOOLS.question]: 'Asking you a question…'
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

function describeTool(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  const str = (k: string): string => (typeof i[k] === 'string' ? (i[k] as string) : '')
  const file = (): string => basename(str('file_path') || str('path') || str('notebook_path') || '')
  switch (name) {
    case 'Read':
      return `Reading ${file()}`
    case 'Edit':
      return `Editing ${file()}`
    case 'Write':
      return `Writing ${file()}`
    case 'NotebookEdit':
      return `Editing notebook ${file()}`
    case 'Bash':
      return `$ ${str('command').replace(/\s+/g, ' ').slice(0, 70)}`
    case 'Grep':
      return `Searching for "${str('pattern').slice(0, 40)}"`
    case 'Glob':
      return `Finding ${str('pattern').slice(0, 50)}`
    case 'WebSearch':
      return `Searching the web: ${str('query').slice(0, 50)}`
    case 'WebFetch':
      return `Fetching ${str('url').slice(0, 60)}`
    case 'Agent':
    case 'Task':
      return `Delegating to ${str('subagent_type') || 'a subagent'}`
    case 'TodoWrite':
      return 'Updating task list'
    default:
      if (name.startsWith(ORGAI_TOOL_PREFIX)) return PROPOSAL_ACTIVITY[name.slice(ORGAI_TOOL_PREFIX.length)] ?? 'Talking to the harness'
      return `Using ${name}`
  }
}

function buildRolePrompt(role: Role, roles: Role[], project: Project, isSetup: boolean, isolation: boolean): string {
  const parts: string[] = [role.prompt.trim()]
  if (role.responsibilities.length) {
    parts.push(`Your responsibilities:\n${role.responsibilities.map((r) => `- ${r}`).join('\n')}`)
  }
  const reports = roles.filter((r) => role.canSpawn && role.spawnable.includes(r.id))
  if (reports.length) {
    parts.push(
      `You lead the following specialists. Delegate to them with the Agent tool, passing subagent_type exactly as written:\n` +
        reports.map((r) => `- ${r.slug}: ${r.description}`).join('\n') +
        `\nYou may only delegate to these roles. Give each delegate a complete, self-contained brief.`
    )
    if (isolation && role.reportsTo === null) {
      parts.push(
        `Parallel work is safe: every report that can edit files runs in its own git worktree, so you may delegate several tasks at once. ` +
          `When a report finishes, the harness commits its branch and merges it into the main checkout, then tells you the result in a message. ` +
          `If a merge conflicts, the branch is kept and you integrate it yourself: in the main checkout run git merge <branch>, resolve the conflicts, ` +
          `then git worktree remove --force <path> and git branch -d <branch>; or commit your own changes and call ${INTEGRATE_TOOL} to retry. ` +
          `Keep your own edits in the main checkout small while reports are running, commit them before retrying a merge, and verify the merged result (build, tests) before reporting to the user.`
      )
    }
  } else if (!isSetup) {
    parts.push('You have no reports. Do the assigned work yourself and report back concisely when finished.')
  }
  if (isolation && role.reportsTo !== null && canWrite(role)) {
    parts.push(
      `You work in an isolated git worktree of the repository, on your own branch. Edit only files inside your current working directory; ` +
        `the main checkout is off limits and other reports cannot see your changes until they are merged. Do not run git merge, checkout, rebase or push. ` +
        `You may commit as you go; the harness commits anything left over and merges your branch when you report back. List every file you changed in your report.`
    )
  }
  if (!isSetup) {
    if (project.setup?.architecturePath) {
      parts.push(`The agreed architecture and conventions live in ${project.setup.architecturePath}. Read it before changing code and follow it.`)
      if (role.reportsTo === null) {
        parts.push(
          `When a task changes the stack, module layout, conventions or commands, update ${project.setup.architecturePath} in the same run so it stays true, and mention the update in your report.`
        )
      }
    }
    if (project.brief.trim()) parts.push(`About this project:\n${project.brief.trim()}`)
  }
  return parts.join('\n\n')
}

function buildAgents(ctx: RuntimeContext, rootExtraTools: string[], isolation: boolean): Record<string, AgentDefinition> {
  const isSetup = ctx.run.kind === 'setup'
  const agents: Record<string, AgentDefinition> = {}
  for (const role of ctx.roles) {
    const tools: string[] = [...role.tools, ...(role.reportsTo === null ? rootExtraTools : [])]
    if (role.canSpawn) tools.push(SPAWN_TOOL)
    const def: AgentDefinition = {
      description: role.description,
      prompt: buildRolePrompt(role, ctx.roles, ctx.project, isSetup, isolation),
      tools,
      model: role.model || 'inherit'
    }
    if (role.effort) def.effort = role.effort
    agents[role.slug] = def
  }
  return agents
}

/** Work-run harness tools: lets the orchestrator retry merging report branches after a conflict. */
function buildWorkServer(root: string, integrate: (wt: { path: string; branch: string }) => Promise<string>): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: ORGAI_MCP,
    version: '1.0.0',
    tools: [
      tool(
        INTEGRATE_TOOL,
        'Merge every report branch that is still waiting (left by a merge conflict or refusal) into the main checkout. Commit your own changes first. Returns the result per branch.',
        {},
        async () => {
          const pending = await pendingWorktrees(root)
          if (!pending.length) return { content: [{ type: 'text', text: 'No report branches are waiting.' }] }
          const lines: string[] = []
          for (const wt of pending) lines.push(await integrate(wt))
          return { content: [{ type: 'text', text: lines.join('\n') }] }
        }
      )
    ]
  })
}

const draftRoleSchema = z.object({
  name: z.string().describe('Human-readable role name'),
  description: z.string().describe('One sentence telling a manager when to delegate to this role'),
  responsibilities: z.array(z.string()),
  prompt: z.string().describe('System prompt, second person, 60 to 160 words'),
  tools: z.array(z.string()).describe('Subset of: Read, Glob, Grep, Edit, Write, Bash, WebSearch, WebFetch, TodoWrite, NotebookEdit'),
  model: z.string().describe('One of: inherit, fable, opus, sonnet, haiku'),
  canSpawn: z.boolean(),
  spawnable: z.array(z.string()).describe('Names of roles this role may delegate to, normally its direct reports'),
  reportsTo: z.string().nullable().describe('Name of the manager role, or null for the single root orchestrator')
})

/**
 * The harness's own tools, offered only to setup runs. Each proposal tool blocks until
 * the user decides and returns APPROVED or REVISE plus feedback so the Architect can iterate.
 */
function buildSetupServer(ctx: RuntimeContext, onDecided: () => void): McpSdkServerConfigWithInstance {
  const reply = (text: string): { content: { type: 'text'; text: string }[] } => ({ content: [{ type: 'text', text }] })
  const decisionText = (d: { behavior: 'approve' } | { behavior: 'revise'; feedback: string }, applied: string): string =>
    d.behavior === 'approve' ? `APPROVED. ${applied}` : `REVISE. The user asked for changes:\n${d.feedback}`

  return createSdkMcpServer({
    name: ORGAI_MCP,
    version: '1.0.0',
    instructions: 'Proposal tools for OrgAI setup. Each call blocks until the user decides; the result begins with APPROVED or REVISE.',
    tools: [
      tool(
        PROPOSAL_TOOLS.architecture,
        'Propose the project architecture: stack, modules, conventions, commands and risks. Blocks until the user approves or asks for changes.',
        {
          title: z.string().describe('Short title for the proposal card'),
          summary: z.string().describe('Two to five sentences describing the architecture'),
          stack: z.array(z.string()).describe('Languages, frameworks, services, one per entry'),
          modules: z.array(z.object({ name: z.string(), purpose: z.string(), paths: z.array(z.string()) })),
          conventions: z.array(z.string()).describe('Coding, testing, naming and workflow conventions'),
          commands: z.array(z.object({ name: z.string(), command: z.string() })).describe('Build, test, lint, dev commands'),
          risks: z.array(z.string()).describe('Gaps or risks the user should know about')
        },
        async ({ title, ...payload }) => {
          const d = await ctx.requestProposal({ kind: 'architecture', agentId: ROOT_ID, title, payload })
          onDecided()
          return reply(decisionText(d, 'The architecture was saved and written to .orgai/ARCHITECTURE.md. Continue with the org chart.'))
        }
      ),
      tool(
        PROPOSAL_TOOLS.orgChart,
        'Propose the org chart of agent roles. Blocks until the user approves or asks for changes.',
        {
          title: z.string(),
          rationale: z.string().describe('Two or three sentences on why this structure fits the project'),
          roles: z.array(draftRoleSchema)
        },
        async ({ title, rationale, roles }) => {
          let converted
          try {
            converted = toRoles({ rationale, roles })
          } catch (e) {
            return reply(`REVISE. The org chart could not be validated: ${(e as Error).message}`)
          }
          const d = await ctx.requestProposal({ kind: 'orgChart', agentId: ROOT_ID, title, payload: { roles: converted, rationale } })
          onDecided()
          return reply(decisionText(d, 'The org chart was applied to the project. Continue with the settings.'))
        }
      ),
      tool(
        PROPOSAL_TOOLS.settings,
        'Propose run settings and the project brief. Blocks until the user approves or asks for changes.',
        {
          title: z.string(),
          rationale: z.string(),
          brief: z.string().describe('Concise project brief every agent will read, 40 to 120 words'),
          permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan']).optional(),
          maxBudgetUsd: z.number().nullable().optional().describe('Spend cap per run in USD; null for no cap'),
          maxSubagentDepth: z.number().int().min(1).max(5).optional(),
          maxConcurrentSubagents: z.number().int().min(1).max(20).optional(),
          isolateWriters: z.boolean().optional().describe('Run writing reports in their own git worktrees and merge them back; true for git repositories with more than one writing role')
        },
        async ({ title, ...payload }) => {
          const d = await ctx.requestProposal({ kind: 'settings', agentId: ROOT_ID, title, payload })
          onDecided()
          return reply(decisionText(d, 'The settings were applied. If everything is approved, call complete_setup.'))
        }
      ),
      tool(
        PROPOSAL_TOOLS.question,
        'Ask the user to choose between options. Blocks until they answer and returns the chosen labels plus any note they typed. Use prose for open-ended questions.',
        {
          question: z.string().describe('The question, one or two sentences'),
          options: z
            .array(z.object({ label: z.string().describe('Short option label'), description: z.string().optional().describe('One line on what this option means') }))
            .min(2)
            .max(6),
          allowMultiple: z.boolean().optional().describe('Let the user pick more than one option; default false'),
          allowFreeText: z.boolean().optional().describe('Offer a free-text box for notes or another answer; default true')
        },
        async ({ question, options, allowMultiple, allowFreeText }) => {
          const answer = await ctx.requestQuestion({
            agentId: ROOT_ID,
            question,
            options,
            allowMultiple: allowMultiple ?? false,
            allowFreeText: allowFreeText ?? true
          })
          onDecided()
          return reply(answerText(answer))
        }
      ),
      tool(
        PROPOSAL_TOOLS.complete,
        'Mark setup complete once the architecture, org chart and settings are all approved.',
        { summary: z.string().describe('What was decided and what the user should do next, under 120 words') },
        async ({ summary }) => {
          await ctx.completeSetup(summary)
          onDecided()
          const next =
            ctx.project.setup?.kind === 'new'
              ? ' This is a new project: tell the user to press "Scaffold the project" on the live view so the approved org chart builds the initial structure from the architecture document.'
              : ''
          return reply(`Setup is marked complete. Give the user a brief closing message.${next}`)
        }
      )
    ]
  })
}

function answerText(answer: { selected: string[]; text?: string }): string {
  const parts: string[] = []
  if (answer.selected.length) parts.push(answer.selected.join(', '))
  if (answer.text?.trim()) parts.push(answer.selected.length ? `Note from the user: ${answer.text.trim()}` : answer.text.trim())
  return parts.length ? parts.join('\n') : 'The user did not answer (the session may be ending). Ask again in prose if it still matters.'
}

/** True when a tool's file_path points at the project's architecture document (in the main checkout or a worktree). */
function isArchitectureFile(filePath: unknown, architecturePath: string): boolean {
  if (typeof filePath !== 'string' || !filePath) return false
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
  const file = norm(filePath)
  const target = norm(architecturePath)
  return file === target || file.endsWith(`/${target}`)
}

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

class ClaudeSession implements RuntimeSession {
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
  private rolesBySlug: Map<string, Role>
  private root: Role
  private isSetup: boolean
  /** Writing reports get their own git worktree. Only for work runs inside a git repository. */
  private isolation: boolean
  /** Agent tool_use ids that were given isolation:"worktree". */
  private isolatedSpawns = new Set<string>()
  /** agent id -> the brief it was spawned with, for commit messages. */
  private spawnDescription = new Map<string, string>()
  private sessionLogged = false
  /** agent id -> message id -> latest usage, so streamed and re-sent messages are counted once. */
  private usageByMessage = new Map<string, Map<string, { input: number; output: number }>>()
  private seenBlocks = new Set<string>()
  private seenToolUses = new Set<string>()

  constructor(private ctx: RuntimeContext) {
    const root = ctx.roles.find((r) => r.reportsTo === null) ?? ctx.roles[0]
    if (!root) throw new Error('Project has no roles')
    this.root = root
    this.isSetup = ctx.run.kind === 'setup'
    this.isolation = !this.isSetup && ctx.project.isolateWriters !== false && isGitRepo(ctx.project.path)
    this.rolesBySlug = new Map(ctx.roles.map((r) => [r.slug, r]))
    this.finished = this.run()
  }

  // ---------- public API ----------

  async send(text: string): Promise<void> {
    this.input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null
    })
    this.transcript(ROOT_ID, { kind: 'user', text })
    this.setState(ROOT_ID, 'thinking', 'Thinking…')
  }

  async interrupt(): Promise<void> {
    try {
      await this.q?.interrupt()
    } catch (e) {
      this.log('warn', `Interrupt failed: ${(e as Error).message}`)
    }
  }

  async stop(): Promise<void> {
    this.input.end()
    this.abort.abort()
  }

  // ---------- internals ----------

  private emit(e: RunEvent): void {
    this.ctx.emit(e)
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.emit({ type: 'log', runId: this.ctx.run.id, level, message })
  }

  private transcript(agentId: string, block: TranscriptBlock): void {
    this.emit({
      type: 'transcript',
      runId: this.ctx.run.id,
      entry: { id: newId('t'), agentId, at: Date.now(), block }
    })
  }

  private upsert(agent: AgentInstance): void {
    this.agents.set(agent.id, agent)
    this.emit({ type: 'agent.upsert', runId: this.ctx.run.id, agent: { ...agent } })
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

  // ---------- worktree integration ----------

  /**
   * Report branches left by earlier runs (conflicts, crashes) must not be forgotten: commit any
   * uncommitted work so it is safe, then tell the orchestrator they exist.
   */
  private async reconcileLeftovers(): Promise<string | null> {
    const root = this.ctx.project.path
    const pending = await inspectPending(root)
    if (!pending.length) return null
    const lines: string[] = []
    for (const wt of pending) {
      let note = ''
      if (wt.exists && wt.uncommittedFiles > 0) {
        const c = await commitLeftovers(wt.path, 'OrgAI: uncommitted work left by an earlier run')
        note = c.committed ? ' (uncommitted work was just committed to keep it safe)' : c.error ? ` (could not commit leftovers: ${c.error})` : ''
      }
      const files = wt.changedFiles.length ? `, touches ${wt.changedFiles.slice(0, 8).join(', ')}${wt.changedFiles.length > 8 ? ', …' : ''}` : ''
      lines.push(`- ${wt.branch}: ${wt.commitsAhead} commit(s) ahead${files}${wt.lastSubject ? `, last: "${wt.lastSubject}"` : ''}${note}`)
      this.log('warn', `Leftover report branch from an earlier run: ${wt.branch}${note}`)
    }
    return (
      `Harness: ${pending.length} report branch${pending.length === 1 ? '' : 'es'} from earlier runs ${pending.length === 1 ? 'is' : 'are'} still waiting in this repository:\n${lines.join('\n')}\n` +
      `Before new work, decide what to do with them: inspect with git log and git diff, then call ${INTEGRATE_TOOL} to merge the ones worth keeping, or tell the user which ones you recommend discarding. The user can also handle them from the project's maintenance panel.`
    )
  }

  /** A finished isolated report gets its branch committed and merged exactly once. */
  private integrateIfIsolated(agent: AgentInstance): void {
    if (!agent.worktree || agent.worktree.status !== 'active') return
    agent.worktree = { ...agent.worktree, status: 'merging' }
    this.upsert(agent)
    void this.integrate(agent)
  }

  private async integrate(agent: AgentInstance): Promise<void> {
    const root = this.ctx.project.path
    const located = await findWorktree(root, agent.id)
    const info: WorktreeInfo = { ...agent.worktree!, ...(located ?? {}), status: 'merging' }
    const brief = this.spawnDescription.get(agent.id) ?? agent.activity
    const result = await integrateWorktree(root, info, `${agent.name}: ${brief}`.slice(0, 120))
    const current = this.agents.get(agent.id) ?? agent
    current.worktree = result.info
    this.upsert(current)
    const level = result.info.status === 'conflict' ? 'warn' : 'info'
    this.log(level, `${agent.name}: ${result.message}`)
    if (result.info.status === 'merged' || result.info.status === 'conflict') {
      this.notifyOrchestrator(
        result.info.status === 'merged'
          ? `Harness: ${agent.name}'s report was merged into the main checkout. ${result.message} Verify the merged result before relying on it.`
          : `Harness: ${agent.name}'s report could not be merged automatically. ${result.message} Integrate branch ${result.info.branch} yourself (git merge in the main checkout, resolve conflicts, then git worktree remove --force "${result.info.path}" and git branch -d ${result.info.branch}), or commit your own changes and call ${INTEGRATE_TOOL}.`
      )
    }
  }

  /** Retry from the orchestrator's integrate tool: find the agent that owns the branch, or integrate anonymously. */
  private async integratePending(wt: { path: string; branch: string }): Promise<string> {
    const owner = [...this.agents.values()].find((a) => a.worktree?.branch === wt.branch)
    const info: WorktreeInfo = { path: wt.path, branch: wt.branch, status: 'merging', changedFiles: owner?.worktree?.changedFiles }
    if (owner) {
      owner.worktree = info
      this.upsert(owner)
    }
    const brief = owner ? this.spawnDescription.get(owner.id) ?? owner.activity : wt.branch
    const result = await integrateWorktree(this.ctx.project.path, info, `${owner?.name ?? 'report'}: ${brief}`.slice(0, 120))
    if (owner) {
      owner.worktree = result.info
      this.upsert(owner)
    }
    this.log(result.info.status === 'conflict' ? 'warn' : 'info', `${owner?.name ?? wt.branch}: ${result.message}`)
    return `${wt.branch}: ${result.message}`
  }

  /** Queue a harness message for the orchestrator; it starts a new turn if the orchestrator is idle. */
  private notifyOrchestrator(text: string): void {
    this.input.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })
    this.transcript(ROOT_ID, { kind: 'system', text })
    const root = this.agents.get(ROOT_ID)
    if (root && (root.state === 'idle' || root.state === 'done')) this.setState(ROOT_ID, 'thinking', 'Integrating a report…')
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

  private buildHooks(): Options['hooks'] {
    const preToolUse: HookCallback = async (raw) => {
      const input = raw as PreToolUseHookInput
      const agentId = input.agent_id ?? ROOT_ID
      this.lastToolAgent.set(input.tool_name, agentId)
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
        this.setState(agentId, 'delegating', describeTool(input.tool_name, toolInput))
        // Writing reports spawned by the orchestrator get their own worktree. Nested spawns stay in
        // their parent's checkout; merging worktrees into worktrees is not worth the complexity.
        const target = this.rolesBySlug.get(requested)
        if (this.isolation && !input.agent_id && target && canWrite(target) && !toolInput.isolation) {
          this.isolatedSpawns.add(input.tool_use_id)
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              updatedInput: { ...toolInput, isolation: 'worktree' }
            }
          }
        }
        return {}
      }

      // The first tool call from an isolated agent reveals its real worktree path.
      const agent = this.agents.get(agentId)
      if (agent?.worktree && agent.worktree.status === 'active' && input.cwd && input.cwd !== this.ctx.project.path && agent.worktree.path !== input.cwd) {
        agent.worktree = { ...agent.worktree, path: input.cwd }
        this.upsert(agent)
      }

      // Proposal tools block on the user, so the node shows "waiting" until they decide.
      const state = input.tool_name.startsWith(ORGAI_TOOL_PREFIX) ? 'waiting' : 'tool'
      this.setState(agentId, state, describeTool(input.tool_name, toolInput))
      return {}
    }

    const postToolUse: HookCallback = async (raw) => {
      const input = raw as PostToolUseHookInput
      const agentId = input.agent_id ?? ROOT_ID
      // Calls that never needed a permission prompt still leave an issuer queued; drop it now.
      this.takeIssuer(permissionKey(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>), agentId)
      const archPath = this.ctx.project.setup?.architecturePath
      if (!this.isSetup && archPath && (input.tool_name === 'Edit' || input.tool_name === 'Write')) {
        const filePath = ((input.tool_input ?? {}) as Record<string, unknown>).file_path
        if (isArchitectureFile(filePath, archPath)) {
          this.log('info', `${this.agents.get(agentId)?.name ?? agentId} updated ${archPath}`)
          void this.ctx.noteArchitectureUpdated().catch((e) => this.log('warn', `Could not record the architecture update: ${(e as Error).message}`))
        }
      }
      const a = this.agents.get(agentId)
      if (a && a.state !== 'done' && a.state !== 'error') this.setState(agentId, 'thinking', 'Thinking…')
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
      this.upsert(a)
      this.integrateIfIsolated(a)
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

  private buildOptions(): Options {
    const { project } = this.ctx
    const env: Record<string, string | undefined> = {
      ...process.env,
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: String(project.maxSubagentDepth),
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: String(project.maxConcurrentSubagents),
      // Only org-chart roles may be spawned; drop the SDK's built-in general-purpose default.
      CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1'
    }
    if (project.provider.auth.kind === 'apiKey') {
      env.ANTHROPIC_API_KEY = process.env[project.provider.auth.envVar]
    }

    // Setup runs get the harness's proposal tools; work runs with isolation get the merge-retry tool.
    let harnessServer: McpSdkServerConfigWithInstance | undefined
    let extraTools: string[] = []
    if (this.isSetup) {
      harnessServer = buildSetupServer(this.ctx, () => {
        const a = this.agents.get(ROOT_ID)
        if (a && a.state === 'waiting') this.setState(ROOT_ID, 'thinking', 'Thinking…')
      })
      extraTools = Object.values(PROPOSAL_TOOLS).map((t) => `${ORGAI_TOOL_PREFIX}${t}`)
    } else if (this.isolation) {
      harnessServer = buildWorkServer(project.path, (wt) => this.integratePending(wt))
      extraTools = [`${ORGAI_TOOL_PREFIX}${INTEGRATE_TOOL}`]
    }

    const options: Options = {
      cwd: project.path,
      agents: buildAgents(this.ctx, extraTools, this.isolation),
      agent: this.root.slug,
      // Setup never edits files, so a plan-only project setting must not block the Architect's read tools.
      permissionMode: this.isSetup ? 'acceptEdits' : project.permissionMode,
      allowDangerouslySkipPermissions: !this.isSetup && project.permissionMode === 'bypassPermissions',
      settingSources: ['project'],
      hooks: this.buildHooks(),
      abortController: this.abort,
      env,
      stderr: (data) => {
        const line = data.trim()
        if (line) this.log('warn', line)
      },
      canUseTool: async (toolName, input) => {
        // The harness's own tools carry their approval inside the proposal round-trip.
        if (toolName.startsWith(ORGAI_TOOL_PREFIX)) return { behavior: 'allow', updatedInput: input }
        const agentId = this.takeIssuer(permissionKey(toolName, input)) ?? this.lastToolAgent.get(toolName) ?? ROOT_ID
        this.setState(agentId, 'waiting', `Needs approval: ${describeTool(toolName, input)}`)
        const decision = await this.ctx.requestPermission({
          agentId,
          toolName,
          input,
          summary: describeTool(toolName, input)
        })
        const a = this.agents.get(agentId)
        if (a && a.state === 'waiting') this.setState(agentId, 'tool', describeTool(toolName, input))
        if (decision.behavior === 'allow') return { behavior: 'allow', updatedInput: input }
        return { behavior: 'deny', message: decision.message }
      }
    }
    if (harnessServer) options.mcpServers = { [ORGAI_MCP]: harnessServer }
    if (this.root.model && this.root.model !== 'inherit') options.model = this.root.model
    if (project.maxBudgetUsd && !this.isSetup) options.maxBudgetUsd = project.maxBudgetUsd
    return options
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
    this.transcript(ROOT_ID, { kind: 'user', text: this.ctx.prompt })

    let firstMessage = this.ctx.hiddenContext
      ? `${this.ctx.prompt}\n\n---\nContext from the harness (not visible to the user):\n${this.ctx.hiddenContext}`
      : this.ctx.prompt

    try {
      if (this.isolation) {
        await prepareRepo(this.ctx.project.path)
        this.log('info', 'Writing reports run in isolated git worktrees; the harness merges each one back when it reports.')
        const leftover = await this.reconcileLeftovers()
        if (leftover) firstMessage += `\n\n---\n${leftover}`
      }
      this.input.push({
        type: 'user',
        message: { role: 'user', content: firstMessage },
        parent_tool_use_id: null
      })
      this.q = query({ prompt: this.input, options: this.buildOptions() })
      for await (const msg of this.q) this.handle(msg)
      this.emit({ type: 'run.status', runId, status: 'finished' })
    } catch (e) {
      if (this.abort.signal.aborted) {
        this.emit({ type: 'run.status', runId, status: 'finished' })
      } else {
        const message = (e as Error).message ?? String(e)
        this.log('error', message)
        this.setState(ROOT_ID, 'error', message.slice(0, 80))
        this.emit({ type: 'run.status', runId, status: 'error', error: message })
      }
    } finally {
      for (const a of this.agents.values()) {
        if (a.state !== 'done' && a.state !== 'error') {
          a.state = 'done'
          a.endedAt = Date.now()
          this.upsert(a)
        }
      }
    }
  }

  private handle(msg: SDKMessage): void {
    const runId = this.ctx.run.id
    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init') {
          const root = this.ensureAgent(ROOT_ID)
          root.model = msg.model
          this.upsert(root)
          this.emit({ type: 'run.status', runId, status: 'running', sessionId: msg.session_id })
          // The SDK re-emits init on every resumed turn (reports landing, harness messages); log it once.
          if (!this.sessionLogged) {
            this.sessionLogged = true
            this.log('info', `Session ${msg.session_id} started with Claude Code ${msg.claude_code_version} (${msg.model})`)
          }
        } else if (msg.subtype === 'task_started') {
          // Background shell commands and MCP calls are tasks too; only subagents belong on the chart.
          if (msg.task_type && msg.task_type !== 'local_agent') break
          const parentId =
            msg.parent_task_id ??
            (msg.tool_use_id ? this.toolUseIssuer.get(msg.tool_use_id) : undefined) ??
            ROOT_ID
          if (msg.tool_use_id) this.taskByToolUse.set(msg.tool_use_id, msg.task_id)
          const slug = msg.subagent_type ?? 'general-purpose'
          const role = this.rolesBySlug.get(slug)
          const existing = this.agents.get(msg.task_id)
          if (msg.description) this.spawnDescription.set(msg.task_id, msg.description)
          const isolated = !!msg.tool_use_id && this.isolatedSpawns.has(msg.tool_use_id)
          const worktree: WorktreeInfo | undefined =
            existing?.worktree ??
            (isolated
              ? {
                  path: join(this.ctx.project.path, '.claude', 'worktrees', `agent-${msg.task_id}`),
                  branch: `worktree-agent-${msg.task_id}`,
                  status: 'active'
                }
              : undefined)
          this.upsert({
            ...(existing ?? this.ensureAgent(msg.task_id, { roleSlug: slug, parentId })),
            roleId: role?.id ?? null,
            roleSlug: slug,
            name: role?.name ?? slug,
            parentId,
            spawnToolUseId: msg.tool_use_id ?? null,
            activity: msg.description?.slice(0, 90) || existing?.activity || 'Starting…',
            ...(worktree ? { worktree } : {})
          })
        } else if (msg.subtype === 'task_notification') {
          const a = this.agents.get(msg.task_id)
          if (a) {
            a.state = msg.status === 'completed' ? 'done' : 'error'
            a.activity = msg.status === 'completed' ? 'Reported back' : `Task ${msg.status}`
            a.result = a.result ?? msg.summary
            a.endedAt = Date.now()
            this.upsert(a)
            this.integrateIfIsolated(a)
          }
        }
        break
      }
      case 'assistant': {
        const agentId = this.resolveAgentId(msg)
        const a = this.ensureAgent(agentId)
        const usage = msg.message.usage
        const messageId = msg.message.id || msg.uuid
        if (usage) {
          // Streaming emits one message per content block and the CLI may re-send a message after a
          // permission answer, all sharing message.id. Count each message id once, using its latest usage.
          const perAgent = this.usageByMessage.get(agentId) ?? new Map<string, { input: number; output: number }>()
          perAgent.set(messageId, {
            input: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
            output: usage.output_tokens ?? 0
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
            this.seenBlocks.add(blockKey)
            this.toolUseIssuer.set(block.id, agentId)
            this.transcript(agentId, { kind: 'tool_use', id: block.id, name: block.name, input: block.input })
          }
        }
        if (msg.error) this.log('warn', `Assistant message error: ${JSON.stringify(msg.error)}`)
        this.upsert(a)
        break
      }
      case 'user': {
        const agentId = this.resolveAgentId(msg)
        const content = msg.message.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
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
        this.emit({ type: 'run.cost', runId, totalCostUsd: msg.total_cost_usd })
        const root = this.ensureAgent(ROOT_ID)
        root.costUsd = msg.total_cost_usd
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

  async complete(input: CompletionInput): Promise<string> {
    const options: Options = {
      cwd: input.cwd,
      systemPrompt: { type: 'custom', prompt: input.system },
      tools: [],
      maxTurns: 1,
      settingSources: [],
      permissionMode: 'dontAsk'
    }
    if (input.model) options.model = input.model
    let text = ''
    for await (const msg of query({ prompt: input.prompt, options })) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) if (block.type === 'text') text += block.text
      } else if (msg.type === 'result' && msg.subtype !== 'success') {
        throw new Error(`Completion failed: ${msg.subtype}`)
      }
    }
    return text
  }
}
