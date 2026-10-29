import { z } from 'zod'
import type { McpServerSpec, PlanStep, ProposalDecision, QuestionAnswer, RunPlan } from '@shared/types'
import { PERMISSION_MODES, TOOL_CATALOG } from '@shared/types'
import { MAX_AUTO_CONTINUES_LIMIT, MAX_CONCURRENT_SUBAGENTS_LIMIT, MAX_SUBAGENT_DEPTH_LIMIT } from '@shared/defaults'
import { PROPOSAL_TOOLS } from '@shared/setup'
import { toRoles } from '../ai/draft'
import { ROOT_AGENT_ID, type RuntimeContext } from './types'
import { pendingWorktrees } from './worktrees'
import { PLAN_TOOLS, finishedCount, remainingSteps } from './continuation'

/**
 * The harness's own tools, defined once for every provider. Each definition is a name, a description,
 * a zod object for its input and a handler that returns the text the model receives. Adapters expose
 * them however their SDK takes custom tools (Claude: an in-process MCP server named "orgai") and keep
 * their own namespacing out of these names.
 */

type PermissionModeValue = (typeof PERMISSION_MODES)[number]

/** Work-run tool: retry merging report branches after a conflict or hold. */
export const INTEGRATE_TOOL = 'integrate_worktrees'

/** Callbacks a tool handler needs from the adapter. */
export interface HarnessToolHooks {
  /** A blocking setup tool came back from the user: flip the root out of "waiting". */
  onDecided?(): void
  /** Work runs: merge one waiting report branch; returns a one-line result. */
  integratePending?(wt: { path: string; branch: string }): Promise<string>
  /** Work runs: a plan tool changed the plan (the adapter shows the step in progress on the root node). */
  onPlanUpdated?(plan: RunPlan): void
  /**
   * request_mcp_install was approved and RunManager added the server to the run (ctx.mcpServers() now lists
   * it): attach it to the live session (Claude: Query.setMcpServers with every resolved server; Codex: restart
   * or resume the thread with the new config). Resolves with the tool prefix the agent should use
   * (mcp__<name>__) or rejects with a reason the tool returns to the agent. Missing = the server is available
   * from the next run only.
   */
  addMcpServer?(spec: McpServerSpec): Promise<string>
}

/**
 * Which agents get a harness tool. 'root' (the default): the root role only. 'spawners': the root and every
 * role with canSpawn (the MCP tools list_mcp_servers, search_mcp_registry, request_mcp_install).
 */
export type HarnessToolAudience = 'root' | 'spawners'

/** Harness tools that return at once; every other harness tool waits on the user (the node shows "waiting"). */
const NON_BLOCKING_TOOLS = new Set<string>([PLAN_TOOLS.set, PLAN_TOOLS.update, PLAN_TOOLS.complete, PLAN_TOOLS.blocked, INTEGRATE_TOOL])

/** True when a harness tool (bare name) blocks until the user answers. */
export function isBlockingHarnessTool(name: string): boolean {
  return !NON_BLOCKING_TOOLS.has(name)
}

export interface HarnessToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string
  description: string
  /** Default 'root'. */
  audience?: HarnessToolAudience
  inputSchema: z.ZodObject<S>
  handler(ctx: RuntimeContext, args: z.infer<z.ZodObject<S>>, hooks: HarnessToolHooks): Promise<string>
}

/** A definition bound to one session: `call` validates the arguments and runs the handler. */
export interface HarnessTool {
  name: string
  description: string
  audience: HarnessToolAudience
  inputSchema: z.ZodObject<z.ZodRawShape>
  call(args: unknown): Promise<string>
}

function defineTool<S extends z.ZodRawShape>(def: HarnessToolDef<S>): HarnessToolDef {
  return def as unknown as HarnessToolDef
}

function bind(defs: HarnessToolDef[], ctx: RuntimeContext, hooks: HarnessToolHooks): HarnessTool[] {
  return defs.map((def) => ({
    name: def.name,
    description: def.description,
    audience: def.audience ?? 'root',
    inputSchema: def.inputSchema,
    call: async (args) => def.handler(ctx, def.inputSchema.parse(args ?? {}), hooks)
  }))
}

/** Server-level instructions for the setup tools, for SDKs that support them. */
export const SETUP_TOOLS_INSTRUCTIONS =
  'Proposal tools for OrgAI setup. Each call blocks until the user decides; the result begins with APPROVED or REVISE.'

export function decisionText(d: ProposalDecision, applied: string): string {
  return d.behavior === 'approve' ? `APPROVED. ${applied}` : `REVISE. The user asked for changes:\n${d.feedback}`
}

export function answerText(answer: QuestionAnswer): string {
  const parts: string[] = []
  if (answer.selected.length) parts.push(answer.selected.join(', '))
  if (answer.text?.trim()) parts.push(answer.selected.length ? `Note from the user: ${answer.text.trim()}` : answer.text.trim())
  return parts.length ? parts.join('\n') : 'The user did not answer (the session may be ending). Ask again in prose if it still matters.'
}

export const draftRoleSchema = z.object({
  name: z.string().describe('Human-readable role name'),
  description: z.string().describe('One sentence telling a manager when to delegate to this role'),
  responsibilities: z.array(z.string()),
  prompt: z.string().describe('System prompt, second person, 60 to 160 words'),
  tools: z
    .array(z.string())
    .describe(`Subset of: ${TOOL_CATALOG.join(', ')}. SendMessage and ListAgents let a role message other running agents and see who is running`),
  model: z.string().describe('One of: inherit, fable, opus, sonnet, haiku'),
  canSpawn: z.boolean(),
  spawnable: z.array(z.string()).describe('Names of roles this role may delegate to, normally its direct reports'),
  reportsTo: z.string().nullable().describe('Name of the manager role, or null for the single root orchestrator')
})

export const proposeArchitecture = defineTool({
  name: PROPOSAL_TOOLS.architecture,
  description: 'Propose the project architecture: stack, modules, conventions, commands and risks. Blocks until the user approves or asks for changes.',
  inputSchema: z.object({
    title: z.string().describe('Short title for the proposal card'),
    summary: z.string().describe('Two to five sentences describing the architecture'),
    stack: z.array(z.string()).describe('Languages, frameworks, services, one per entry'),
    modules: z.array(z.object({ name: z.string(), purpose: z.string(), paths: z.array(z.string()) })),
    conventions: z.array(z.string()).describe('Coding, testing, naming and workflow conventions'),
    commands: z.array(z.object({ name: z.string(), command: z.string() })).describe('Build, test, lint, dev commands'),
    risks: z.array(z.string()).describe('Gaps or risks the user should know about')
  }),
  async handler(ctx, { title, ...payload }, hooks) {
    const d = await ctx.requestProposal({ kind: 'architecture', agentId: ROOT_AGENT_ID, title, payload })
    hooks.onDecided?.()
    return decisionText(d, 'The architecture was saved and written to .orgai/ARCHITECTURE.md. Continue with the org chart.')
  }
})

export const proposeOrgChart = defineTool({
  name: PROPOSAL_TOOLS.orgChart,
  description: 'Propose the org chart of agent roles. Blocks until the user approves or asks for changes.',
  inputSchema: z.object({
    title: z.string(),
    rationale: z.string().describe('Two or three sentences on why this structure fits the project'),
    roles: z.array(draftRoleSchema)
  }),
  async handler(ctx, { title, rationale, roles }, hooks) {
    let converted
    try {
      converted = toRoles({ rationale, roles })
    } catch (e) {
      return `REVISE. The org chart could not be validated: ${(e as Error).message}`
    }
    const d = await ctx.requestProposal({ kind: 'orgChart', agentId: ROOT_AGENT_ID, title, payload: { roles: converted, rationale } })
    hooks.onDecided?.()
    return decisionText(d, 'The org chart was applied to the project. Continue with the settings.')
  }
})

export const proposeSettings = defineTool({
  name: PROPOSAL_TOOLS.settings,
  description: 'Propose run settings and the project brief. Blocks until the user approves or asks for changes.',
  inputSchema: z.object({
    title: z.string(),
    rationale: z.string(),
    brief: z.string().describe('Concise project brief every agent will read, 40 to 120 words'),
    permissionMode: z
      .enum(PERMISSION_MODES as [PermissionModeValue, ...PermissionModeValue[]])
      .optional()
      .describe("'auto' (unattended: a classifier approves each call and asks only when unsure) is recommended; 'acceptEdits' asks for every command"),
    maxBudgetUsd: z.number().nullable().optional().describe('Spend cap per run in USD; null for no cap'),
    maxSubagentDepth: z.number().int().min(1).max(MAX_SUBAGENT_DEPTH_LIMIT).optional(),
    maxConcurrentSubagents: z.number().int().min(1).max(MAX_CONCURRENT_SUBAGENTS_LIMIT).optional(),
    allowRules: z
      .array(z.string())
      .optional()
      .describe(
        'Claude Code permission rules saved as project allow rules so these calls never ask, e.g. "Bash(npm:*)", "Bash(git status:*)". Only safe commands the workflow needs; never rm, git push, git reset --hard or sudo'
      ),
    isolateWriters: z
      .boolean()
      .optional()
      .describe('Run writing reports in their own git worktrees and merge them back; true for git repositories with more than one writing role'),
    reviewMerges: z
      .boolean()
      .optional()
      .describe("Show the user each report's diff and wait for approval before merging it; only when the user wants to review changes"),
    autoContinue: z
      .boolean()
      .optional()
      .describe('Keep the orchestrator going until its plan is complete, stopping only for genuine decisions; true unless the user wants to steer every turn'),
    maxAutoContinues: z
      .number()
      .int()
      .min(0)
      .max(MAX_AUTO_CONTINUES_LIMIT)
      .optional()
      .describe('Automatic continues allowed per run (default 40); lower it for small projects or tight budgets')
  }),
  async handler(ctx, { title, ...payload }, hooks) {
    const d = await ctx.requestProposal({ kind: 'settings', agentId: ROOT_AGENT_ID, title, payload })
    hooks.onDecided?.()
    return decisionText(d, 'The settings were applied. If everything is approved, call complete_setup.')
  }
})

export const askUser = defineTool({
  name: PROPOSAL_TOOLS.question,
  description:
    'Ask the user to choose between options. Blocks until they answer and returns the chosen labels plus any note they typed. Use prose for open-ended questions.',
  inputSchema: z.object({
    question: z.string().describe('The question, one or two sentences'),
    options: z
      .array(z.object({ label: z.string().describe('Short option label'), description: z.string().optional().describe('One line on what this option means') }))
      .min(2)
      .max(6),
    allowMultiple: z.boolean().optional().describe('Let the user pick more than one option; default false'),
    allowFreeText: z.boolean().optional().describe('Offer a free-text box for notes or another answer; default true')
  }),
  async handler(ctx, { question, options, allowMultiple, allowFreeText }, hooks) {
    const answer = await ctx.requestQuestion({
      agentId: ROOT_AGENT_ID,
      question,
      options,
      allowMultiple: allowMultiple ?? false,
      allowFreeText: allowFreeText ?? true
    })
    hooks.onDecided?.()
    return answerText(answer)
  }
})

export const completeSetup = defineTool({
  name: PROPOSAL_TOOLS.complete,
  description: 'Mark setup complete once the architecture, org chart and settings are all approved.',
  inputSchema: z.object({ summary: z.string().describe('What was decided and what the user should do next, under 120 words') }),
  async handler(ctx, { summary }, hooks) {
    await ctx.completeSetup(summary)
    hooks.onDecided?.()
    const next =
      ctx.project.setup?.kind === 'new'
        ? ' This is a new project: tell the user to press "Scaffold the project" on the live view so the approved org chart builds the initial structure from the architecture document.'
        : ''
    return `Setup is marked complete. Give the user a brief closing message.${next}`
  }
})

export const integrateWorktrees = defineTool({
  name: INTEGRATE_TOOL,
  description:
    'Merge every report branch that is still waiting (left by a merge conflict or refusal) into the main checkout. Commit your own changes first. Returns the result per branch.',
  inputSchema: z.object({}),
  async handler(ctx, _args, hooks) {
    const pending = await pendingWorktrees(ctx.project.path)
    if (!pending.length) return 'No report branches are waiting.'
    if (!hooks.integratePending) return 'Merging report branches is not available in this run.'
    const lines: string[] = []
    for (const wt of pending) lines.push(await hooks.integratePending(wt))
    return lines.join('\n')
  }
})

/** Setup runs: proposal tools, ask_user and complete_setup, in the order the Architect uses them. */
/** Work runs: the orchestrator proposes a revised chart when a task exposes a gap. Applies to future runs. */
export const proposeOrgChange = defineTool({
  name: PROPOSAL_TOOLS.orgChange,
  description:
    'Propose a revision of the org chart for future runs: the full chart with minimal changes (a new specialty, a sharper prompt, missing tools, a changed reporting line). Blocks until the user approves or asks for changes. This session keeps its current roles.',
  inputSchema: z.object({
    title: z.string().describe('Short title naming the change, e.g. "Add a database specialist"'),
    rationale: z.string().describe('What this run revealed and exactly what changes; two to four sentences'),
    roles: z.array(draftRoleSchema).describe('The complete revised chart, unchanged roles included')
  }),
  async handler(ctx, { title, rationale, roles }, hooks) {
    let converted
    try {
      converted = toRoles({ rationale, roles })
    } catch (e) {
      return `REVISE. The org chart could not be validated: ${(e as Error).message}`
    }
    const d = await ctx.requestProposal({ kind: 'orgChart', agentId: ROOT_AGENT_ID, title, payload: { roles: converted, rationale } })
    hooks.onDecided?.()
    return decisionText(d, 'The org chart was updated for future runs. This session keeps its current roles; carry on with the task.')
  }
})

// ---------- plan tools (work runs) ----------

const STEP_STATUSES = ['pending', 'in_progress', 'done', 'blocked', 'skipped'] as const

function stepLine(s: PlanStep): string {
  return `${s.id} ${s.title}${s.owner ? ` [${s.owner}]` : ''}`
}

function progressLine(plan: RunPlan): string {
  const remaining = remainingSteps(plan)
  return (
    `Progress: ${finishedCount(plan)} of ${plan.steps.length} done.` +
    (remaining.length ? ` Remaining: ${remaining.map((s) => `${s.id} ${s.title} (${s.status})`).join('; ')}.` : ' Every step is done or skipped.')
  )
}

const stepInput = z.object({
  title: z.string().min(1).describe('One concrete, checkable step'),
  owner: z.string().optional().describe('Role slug or report handle expected to do it')
})

export const setPlan = defineTool({
  name: PLAN_TOOLS.set,
  description:
    'Create or replace the plan for this run: the goal and the concrete steps in order (the last step is verification: build and tests, then the final report). Every step starts pending; ids are p1..pn. The harness uses the plan to keep the run going until it is complete.',
  inputSchema: z.object({
    goal: z.string().min(1).describe("The user's goal in one or two sentences"),
    steps: z.array(stepInput).min(1).max(40)
  }),
  async handler(ctx, { goal, steps }, hooks) {
    const previous = ctx.getPlan()
    const plan: RunPlan = {
      goal: goal.trim(),
      steps: steps.map((s, i) => ({ id: `p${i + 1}`, title: s.title.trim(), status: 'pending' as const, ...(s.owner?.trim() ? { owner: s.owner.trim() } : {}) })),
      status: 'active',
      // Re-planning keeps the run's automatic-continue count, so the limit still holds.
      autoContinues: previous?.autoContinues ?? 0,
      updatedAt: Date.now()
    }
    await ctx.updatePlan(plan)
    hooks.onPlanUpdated?.(plan)
    return (
      `Plan saved with ${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}: ${plan.steps.map(stepLine).join('; ')}. ` +
      'Mark each step with update_plan as you go (in_progress when you start it, done when it is finished) and call complete_plan when every step is done. Start on p1 now.'
    )
  }
})

export const updatePlan = defineTool({
  name: PLAN_TOOLS.update,
  description:
    'Update plan steps by id: in_progress when you start one, done when it is finished, skipped when it turned out unnecessary, blocked when it cannot proceed (say why in note). Optionally append new steps with add. Updating a blocked plan makes it active again.',
  inputSchema: z.object({
    steps: z
      .array(
        z.object({
          id: z.string().describe('Step id, e.g. p2'),
          status: z.enum(STEP_STATUSES),
          note: z.string().optional().describe('Short note, e.g. what was done or why it is blocked')
        })
      )
      .optional(),
    add: z.array(stepInput).optional().describe('New steps to append to the plan, in order')
  }),
  async handler(ctx, { steps, add }, hooks) {
    const current = ctx.getPlan()
    if (!current) return 'There is no plan yet. Call set_plan with the goal and the steps first.'
    const byId = new Map(current.steps.map((s) => [s.id, { ...s }]))
    const unknown: string[] = []
    const changed: string[] = []
    for (const u of steps ?? []) {
      const step = byId.get(u.id.trim())
      if (!step) {
        unknown.push(u.id)
        continue
      }
      step.status = u.status
      if (u.note?.trim()) step.note = u.note.trim()
      changed.push(`${step.id} ${u.status}`)
    }
    const next: PlanStep[] = current.steps.map((s) => byId.get(s.id) ?? s)
    let n = current.steps.reduce((max, s) => Math.max(max, Number(/^p(\d+)$/.exec(s.id)?.[1] ?? 0)), 0)
    for (const a of add ?? []) {
      n++
      next.push({ id: `p${n}`, title: a.title.trim(), status: 'pending', ...(a.owner?.trim() ? { owner: a.owner.trim() } : {}) })
      changed.push(`p${n} added`)
    }
    const reopened = current.status !== 'active'
    const plan: RunPlan = { ...current, steps: next, status: 'active', updatedAt: Date.now() }
    delete plan.blockedReason
    if (reopened) delete plan.summary
    await ctx.updatePlan(plan)
    hooks.onPlanUpdated?.(plan)
    const parts = [changed.length ? `Updated: ${changed.join(', ')}.` : 'Nothing changed.']
    if (unknown.length) parts.push(`Unknown step ids: ${unknown.join(', ')}. The plan has ${current.steps.map((s) => s.id).join(', ')}.`)
    if (reopened) parts.push('The plan is active again.')
    parts.push(progressLine(plan))
    return parts.join(' ')
  }
})

export const completePlan = defineTool({
  name: PLAN_TOOLS.complete,
  description: 'Mark the plan complete once every step is done and verified (build and tests pass). Ends the automatic continuation.',
  inputSchema: z.object({ summary: z.string().min(1).describe('What was done and verified, under 150 words') }),
  async handler(ctx, { summary }, hooks) {
    const current = ctx.getPlan()
    if (!current) return 'There is no plan to complete. Give the user your final report.'
    const plan: RunPlan = { ...current, status: 'done', summary: summary.trim(), updatedAt: Date.now() }
    delete plan.blockedReason
    await ctx.updatePlan(plan)
    hooks.onPlanUpdated?.(plan)
    const open = remainingSteps(plan)
    return (
      'Plan marked complete. Give the user your final report now.' +
      (open.length ? ` Note: ${open.map((s) => s.id).join(', ')} ${open.length === 1 ? 'was' : 'were'} not marked done; say why in the report.` : '')
    )
  }
})

export const markBlocked = defineTool({
  name: PLAN_TOOLS.blocked,
  description:
    'Stop the automatic continuation because the run needs a decision or something only the user can provide. The harness tells the user the reason. Use ask_user instead when the choice fits a few options.',
  inputSchema: z.object({ reason: z.string().min(1).describe('What the user must decide or provide, and why the work cannot continue without it') }),
  async handler(ctx, { reason }, hooks) {
    const current = ctx.getPlan()
    const plan: RunPlan = current
      ? { ...current, status: 'blocked', blockedReason: reason.trim(), updatedAt: Date.now() }
      : { goal: ctx.prompt.trim().slice(0, 300), steps: [], status: 'blocked', blockedReason: reason.trim(), autoContinues: 0, updatedAt: Date.now() }
    await ctx.updatePlan(plan)
    hooks.onPlanUpdated?.(plan)
    return 'The plan is marked blocked; the harness stopped the automatic continues and told the user. End your turn with a short message saying what you need. When the user answers, call update_plan to resume the plan.'
  }
})

export const SETUP_TOOL_DEFS: HarnessToolDef[] = [proposeArchitecture, proposeOrgChart, proposeSettings, askUser, completeSetup]
/** Work runs: plan tools, ask_user, the merge-retry tool and org chart revisions. */
export const WORK_TOOL_DEFS: HarnessToolDef[] = [setPlan, updatePlan, completePlan, markBlocked, askUser, integrateWorktrees, proposeOrgChange]

export function setupTools(ctx: RuntimeContext, hooks: HarnessToolHooks = {}): HarnessTool[] {
  return bind(SETUP_TOOL_DEFS, ctx, hooks)
}

export function workTools(ctx: RuntimeContext, hooks: HarnessToolHooks = {}): HarnessTool[] {
  return bind(WORK_TOOL_DEFS, ctx, hooks)
}

/** MCP assistant runs ('mcp-assist'): registry search, the server list and the proposal tool. Filled by the MCP brief. */
export const MCP_ASSIST_TOOL_DEFS: HarnessToolDef[] = [askUser]

/**
 * The harness tools for a run, by kind. Adapters call this instead of choosing setupTools / workTools
 * themselves, then give each tool to the root, or to the root and every canSpawn role (tool.audience).
 */
export function harnessToolsFor(ctx: RuntimeContext, hooks: HarnessToolHooks = {}): HarnessTool[] {
  if (ctx.run.kind === 'setup') return setupTools(ctx, hooks)
  if (ctx.run.kind === 'mcp-assist') return bind(MCP_ASSIST_TOOL_DEFS, ctx, hooks)
  return workTools(ctx, hooks)
}
