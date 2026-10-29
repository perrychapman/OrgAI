import { z } from 'zod'
import type { ProposalDecision, QuestionAnswer } from '@shared/types'
import { PROPOSAL_TOOLS } from '@shared/setup'
import { toRoles } from '../ai/draft'
import { ROOT_AGENT_ID, type RuntimeContext } from './types'
import { pendingWorktrees } from './worktrees'

/**
 * The harness's own tools, defined once for every provider. Each definition is a name, a description,
 * a zod object for its input and a handler that returns the text the model receives. Adapters expose
 * them however their SDK takes custom tools (Claude: an in-process MCP server named "orgai") and keep
 * their own namespacing out of these names.
 */

/** Work-run tool: retry merging report branches after a conflict or hold. */
export const INTEGRATE_TOOL = 'integrate_worktrees'

/** Callbacks a tool handler needs from the adapter. */
export interface HarnessToolHooks {
  /** A blocking setup tool came back from the user: flip the root out of "waiting". */
  onDecided?(): void
  /** Work runs: merge one waiting report branch; returns a one-line result. */
  integratePending?(wt: { path: string; branch: string }): Promise<string>
}

export interface HarnessToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string
  description: string
  inputSchema: z.ZodObject<S>
  handler(ctx: RuntimeContext, args: z.infer<z.ZodObject<S>>, hooks: HarnessToolHooks): Promise<string>
}

/** A definition bound to one session: `call` validates the arguments and runs the handler. */
export interface HarnessTool {
  name: string
  description: string
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
  tools: z.array(z.string()).describe('Subset of: Read, Glob, Grep, Edit, Write, Bash, WebSearch, WebFetch, TodoWrite, NotebookEdit'),
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
    permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan']).optional(),
    maxBudgetUsd: z.number().nullable().optional().describe('Spend cap per run in USD; null for no cap'),
    maxSubagentDepth: z.number().int().min(1).max(5).optional(),
    maxConcurrentSubagents: z.number().int().min(1).max(20).optional(),
    isolateWriters: z
      .boolean()
      .optional()
      .describe('Run writing reports in their own git worktrees and merge them back; true for git repositories with more than one writing role'),
    reviewMerges: z
      .boolean()
      .optional()
      .describe("Show the user each report's diff and wait for approval before merging it; only when the user wants to review changes")
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
export const SETUP_TOOL_DEFS: HarnessToolDef[] = [proposeArchitecture, proposeOrgChart, proposeSettings, askUser, completeSetup]
/** Work runs with isolation: the merge-retry tool. */
export const WORK_TOOL_DEFS: HarnessToolDef[] = [integrateWorktrees]

export function setupTools(ctx: RuntimeContext, hooks: HarnessToolHooks = {}): HarnessTool[] {
  return bind(SETUP_TOOL_DEFS, ctx, hooks)
}

export function workTools(ctx: RuntimeContext, hooks: HarnessToolHooks = {}): HarnessTool[] {
  return bind(WORK_TOOL_DEFS, ctx, hooks)
}
