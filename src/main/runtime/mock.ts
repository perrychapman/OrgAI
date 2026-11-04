import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AgentInstance, ConnectionId, ImageAttachment, McpServerSpec, PermissionSuggestion, PluginSpec, ProviderId, Role, RunEvent, RunPlan, TokenUsage, TranscriptBlock } from '@shared/types'
import { CHAT_HARNESS_TOOLS, HARNESS_PROJECT_ID, MCP_HARNESS_TOOLS, SKILLS_PROJECT_ID, SKILL_ASSIST_HARNESS_TOOLS, SKILL_HARNESS_TOOLS, SPAWN_TOOL } from '@shared/types'
import { mcpServersForRole, newId, projectKindOf } from '@shared/defaults'
import { ROOT_AGENT_ID, isSetupLikeRun, type AdapterModelInfo, type CompletionInput, type PeerMessage, type RuntimeAdapter, type RuntimeContext, type RuntimeSession } from './types'
import { harnessToolsFor, isBlockingHarnessTool, type ConfigChange, type ConfigChangeResult, type HarnessTool, type HarnessToolAudience, type HarnessToolHooks, type McpAttachResult } from './harnessTools'
import { agentInstalledServers, mcpCallDenial, withoutServerRules } from './mcpGrants'
import {
  REFERENCE_EDIT_TOOLS,
  commandReferenceTouch,
  editTargetOf as referenceEditTarget,
  referenceCommandMessage,
  referenceEditDenial,
  referenceFolderOf,
  referenceRefusalEntry,
  referenceTouchOf
} from './referenceDirectories'
import { ContinuationDriver, PLAN_TOOLS, stepActivity } from './continuation'
import { authFailureMessage, describeTool, harnessToolActivity } from './activity'
import { EDIT_TOOLS, allowRuleStrings, applyAllowScope, chooseSuggestions, editTargetOf, isOfferableDirectory, listRules, suggestionLabels, type AllowScopePersist } from './permissionRules'
import { isTrustRestrictedRun, isWorkspaceConfigPath } from '../quick/scratch'
import { composeFirstMessage, peerMessageText } from './prompts'
import { resolveParent } from './agentTree'
import { HandleNamer, mapSendMessage, messageTranscriptText, spawnHandle } from './network'
import { SHELL_TOOLS, isFreeCdTarget, matchOptionsFor, matchingRule, type MatchOptions } from './ruleMatch'
import { countUsage, setModelTokens, usageOf } from './runUsage'

/**
 * A scripted, token-free provider. It plays a script of steps and emits the same normalized RunEvents a
 * real adapter would, going through the same RuntimeContext round-trips (permissions, proposals, setup
 * completion) and the shared harness tools. Used by tests and for UI work: set ORGAI_MOCK=1 and a
 * project's provider.id to "mock"; ORGAI_MOCK_SCRIPT may point at a JSON MockScript.
 *
 * Prompt markers (default script only): [mock:auth-fail], [mock:skill], [mock:mcp-midrun], [mock:config-change],
 * [mock:no-price], [mock:computed-cost], [mock:title-fail] (complete()), [mock:deep-tree] (deepTreeSteps: root ->
 * mock-lead -> mock-lead-report-1 / -2, every report finishes) and [mock:fatigue] (fatigueSteps): the root
 * runs `cd <project>/.claude/worktrees/agent-x && npm test` with a provider-style compound rule suggestion (the card
 * offers `Bash(npm test:*)`), a report edits `<parent of project>/sibling-notes/README.md` with setMode acceptEdits +
 * addDirectories suggestions, then the root runs `cd <project>/sub && npm test` (no card once `Bash(npm test:*)` is
 * granted; the free cd needs no rule). [mock:reference-edit] (referenceEditSteps): a report tries an Edit under the
 * run's first reference folder and gets the reference gate's refusal plus one harness row "Refused: brief.md is in a
 * reference folder (read only)"; the run goes on to its usual end. [mock:reference-shell] (referenceShellSteps): the
 * root runs Bash `del "<first reference folder>/brief.md"` with no `ask` on the step; the reference shell guard forces
 * a card with referenceFolder and no suggestions (allow: result 'ok', nothing runs; deny: the deny text).
 *
 * Reference folders (same as the Claude adapter): a shell step touching one always asks, never through a rule, a
 * suggestion shortcut or acceptEdits; a Read / Glob / Grep card under one carries referenceFolder and no suggestions.
 *
 * Permission asks follow the Claude adapter: saved, session and live rules (matchingRule with matchOptionsFor, so a
 * `cd` into the project or an allowed directory needs no rule), and an edit is pre-approved when its file is inside
 * the project, an allowed directory or a session-granted directory AND the project mode is 'acceptEdits' (not on a
 * trust-restricted run) or the session was granted acceptEdits. Deviation: the real CLI's auto mode also
 * auto-approves in-cwd edits; the mock does not, so e2e can rely on the default script's Edit card.
 */

export type MockStep =
  /** Assistant text from an agent (default: the root). */
  | { type: 'text'; agent?: string; text: string }
  | { type: 'thinking'; agent?: string; text: string }
  /**
   * A tool call. With `ask`, it first needs the user's approval through ctx.requestPermission. With
   * `background` too, the turn goes on without waiting for the answer (a report's call still pending
   * while the orchestrator's turn ends).
   */
  | {
      type: 'tool'
      agent?: string
      name: string
      input?: Record<string, unknown>
      result?: string
      ask?: boolean
      background?: boolean
      /** Provider-style permission suggestions passed to chooseSuggestions as `provided` (like the CLI's canUseTool). */
      suggestions?: PermissionSuggestion[]
    }
  /** Spawn a report. `role` is a slug; default: the first role the parent may spawn. */
  | { type: 'spawn'; id: string; role?: string; description: string; parent?: string; /** Handle; default <role>-<n>. */ name?: string }
  /** An agent messages another by handle or role slug (SendMessage). `from` defaults to the root. */
  | { type: 'message'; from?: string; to: string; text: string }
  /** A report finishes and reports back to its parent. */
  | { type: 'finish'; id: string; result: string }
  /** Call one of the harness's own tools by bare name (propose_architecture, ask_user, complete_setup, ...). */
  | { type: 'harness'; name: string; args?: Record<string, unknown>; /** Re-run the call when the user asks for changes. Default true. */ retryOnRevise?: boolean }
  /**
   * The plan's usage limit rejects the next request: reports ctx.rateLimited (with `until` ms from now,
   * when given) and ends the session, like the Claude adapter does at the next result.
   */
  | { type: 'rateLimit'; window?: string; untilInMs?: number }
  /** The orchestrator sets its plan (set_plan). Steps are titles or { title, owner }. */
  | { type: 'plan'; goal: string; steps: (string | { title: string; owner?: string })[] }
  /** The orchestrator updates plan steps (update_plan). */
  | { type: 'planUpdate'; steps: { id: string; status: 'pending' | 'in_progress' | 'done' | 'blocked' | 'skipped'; note?: string }[] }
  /** The orchestrator completes the plan (complete_plan). */
  | { type: 'planComplete'; summary: string }
  /** An API retry (rate limit or overload) against an agent's request; counted in usage.retries. */
  | { type: 'retry'; agent?: string }

export interface MockScript {
  /** Pause before each step, in milliseconds. Default 400. */
  delayMs?: number
  /** Steps for work runs. */
  work?: MockStep[]
  /** Steps for setup runs. */
  setup?: MockStep[]
  /** Steps for MCP assistant runs ('mcp-assist'). */
  mcpAssist?: MockStep[]
  /** Steps for Skill assistant runs ('skill-assist'). The default is built per run (propose 'mock-skill'). */
  skillAssist?: MockStep[]
  /** Reply to follow-up messages; "{text}" is replaced with the user's message. */
  reply?: string
  /**
   * Turns played for successive harness nudges (automatic continues), in order. Once used up, a nudge
   * gets a one-line text reply that changes nothing.
   */
  continue?: MockStep[][]
}

/** The default script's silent, unpriced report. */
export const UNPRICED_REPORT_ID = 'mock-report-2'
/** Model ids the mock reports. 'mock-unpriced' is in no price table. */
export const MOCK_UNPRICED_MODEL = 'mock-unpriced'
/** Prompt markers: every agent unpriced (unknown cost), or priced from the built-in table (no provider cost). */
export const NO_PRICE_TOKEN = '[mock:no-price]'
export const COMPUTED_COST_TOKEN = '[mock:computed-cost]'

const DEFAULT_WORK: MockStep[] = [
  { type: 'thinking', text: 'The request is small; one report can do it while I review.' },
  { type: 'text', text: 'Planning the work: I will read the project, delegate the change and review the result.' },
  { type: 'tool', name: 'Read', input: { file_path: 'README.md' }, result: '# Mock project\n' },
  { type: 'retry' },
  { type: 'spawn', id: 'mock-report-1', description: 'Implement the requested change' },
  { type: 'tool', agent: 'mock-report-1', name: 'Read', input: { file_path: 'src/example.ts' }, result: 'export const x = 1\n' },
  { type: 'tool', agent: 'mock-report-1', name: 'Edit', input: { file_path: 'src/example.ts', old_string: 'x = 1', new_string: 'x = 2' }, ask: true, result: 'File updated.' },
  { type: 'text', agent: 'mock-report-1', text: 'Done. Changed src/example.ts.' },
  { type: 'finish', id: 'mock-report-1', result: 'Changed src/example.ts (x is now 2). Files touched: src/example.ts' },
  // Spends tokens, reports nothing (the "produced nothing" case), and runs on a model with no known price.
  { type: 'spawn', id: UNPRICED_REPORT_ID, description: 'Look for related tests' },
  { type: 'tool', agent: UNPRICED_REPORT_ID, name: 'Glob', input: { pattern: '**/*.test.ts' }, result: '' },
  { type: 'finish', id: UNPRICED_REPORT_ID, result: '' },
  { type: 'text', text: 'The report finished: src/example.ts was updated. Anything else?' }
]

const DEFAULT_SETUP: MockStep[] = [
  { type: 'text', text: 'I will look at the repository first, then propose the architecture.' },
  { type: 'tool', name: 'Glob', input: { pattern: '**/*' }, result: 'README.md\nsrc/example.ts' },
  { type: 'tool', name: 'Bash', input: { command: 'git status --short' }, ask: true, result: '' },
  {
    type: 'harness',
    name: 'propose_architecture',
    args: {
      title: 'Mock architecture',
      summary: 'A small TypeScript project used to exercise the harness without spending tokens.',
      stack: ['TypeScript', 'Node.js'],
      modules: [{ name: 'core', purpose: 'Example code', paths: ['src/'] }],
      conventions: ['Strict TypeScript', 'Tests beside the modules'],
      commands: [{ name: 'test', command: 'npm test' }],
      risks: ['This is a scripted mock; nothing was analysed.']
    }
  },
  {
    type: 'harness',
    name: 'propose_org_chart',
    args: {
      title: 'Mock org chart',
      rationale: 'One lead delegating to one engineer is enough to exercise spawning.',
      roles: [
        {
          name: 'Lead',
          description: 'Plans the work and delegates it.',
          responsibilities: ['Plan', 'Delegate', 'Review'],
          prompt: 'You are the lead. Break the request into briefs, delegate them, and review what comes back.',
          tools: ['Read', 'Glob', 'Grep'],
          model: 'deep',
          canSpawn: true,
          spawnable: ['Engineer'],
          reportsTo: null
        },
        {
          name: 'Engineer',
          description: 'Implements a brief.',
          responsibilities: ['Implement', 'Report the files changed'],
          prompt: 'You are an engineer. Implement the brief, stay within its files, and list every file you touched.',
          tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'],
          model: 'everyday',
          canSpawn: false,
          spawnable: [],
          reportsTo: 'Lead'
        }
      ]
    }
  },
  {
    type: 'harness',
    name: 'propose_settings',
    args: {
      title: 'Mock settings',
      rationale: 'Defaults are fine for a mock.',
      brief: 'A mock project used to exercise OrgAI without spending tokens.',
      maxSubagentDepth: 2,
      maxConcurrentSubagents: 3
    }
  },
  { type: 'harness', name: 'complete_setup', args: { summary: 'Mock setup finished: architecture, org chart and settings were approved.' } },
  { type: 'text', text: 'Setup is complete.' }
]

const DEFAULT_MCP_ASSIST: MockStep[] = [
  { type: 'text', text: 'I will check which MCP servers the project has, then look in the registry.' },
  { type: 'harness', name: MCP_HARNESS_TOOLS.listServers, args: {} },
  { type: 'harness', name: MCP_HARNESS_TOOLS.searchRegistry, args: { query: 'filesystem' } },
  {
    type: 'harness',
    name: MCP_HARNESS_TOOLS.proposeServers,
    args: {
      title: 'Mock MCP servers',
      rationale: 'A filesystem server lets the roles read shared notes.',
      upsert: [{ id: 'mcp-mock-fs', name: 'mock-fs', transport: 'stdio', command: 'npx', args: ['-y', 'mock-fs-server@1.0.0'], enabled: true, source: 'registry', registry: { name: 'io.github.mock/fs-server', version: '1.0.0', registryType: 'npm', identifier: 'mock-fs-server' }, addedAt: '2026-01-01T00:00:00.000Z' }]
    }
  },
  { type: 'text', text: 'The MCP servers are set up.' }
]

/** The skill the default skill-assist script proposes. */
export const MOCK_SKILL_DRAFT = {
  name: 'mock-skill',
  description: 'Use when the user asks for a quick checklist review of a change. Gives a short, repeatable checklist.',
  body: '# Mock skill\n\n1. Read the change.\n2. Check it against the project conventions.\n3. Report what you found in three bullet points.\n'
}

/** Marker: the default skill-assist script is built per run from the project (see defaultSkillAssistSteps). */
const DEFAULT_SKILL_ASSIST: MockStep[] = []

export const DEFAULT_MOCK_SCRIPT: Required<MockScript> = {
  delayMs: 400,
  work: DEFAULT_WORK,
  setup: DEFAULT_SETUP,
  mcpAssist: DEFAULT_MCP_ASSIST,
  skillAssist: DEFAULT_SKILL_ASSIST,
  reply: 'Mock reply to: {text}',
  continue: []
}

/** The script from ORGAI_MOCK_SCRIPT (a JSON file), filled in from the default; the default when unset. */
export function loadMockScript(env: NodeJS.ProcessEnv = process.env): { script: Required<MockScript>; error?: string } {
  const file = env.ORGAI_MOCK_SCRIPT
  if (!file) return { script: DEFAULT_MOCK_SCRIPT }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as MockScript
    return { script: { ...DEFAULT_MOCK_SCRIPT, ...parsed } }
  } catch (e) {
    return { script: DEFAULT_MOCK_SCRIPT, error: `Could not read ORGAI_MOCK_SCRIPT ${file}: ${(e as Error).message}` }
  }
}

const STOPPED = Symbol('stopped')
/** Synthetic price per token so the canvas shows moving numbers. */
const USD_PER_TOKEN = 0.000003

/** Trigger token: the mock behaves as if the provider refused the credentials. */
const AUTH_FAIL_TOKEN = '[mock:auth-fail]'

/** Trigger token: the root calls list_skills (or loads its first granted skill). */
const SKILL_TOKEN = '[mock:skill]'

/** Trigger token (work runs, default script): request_mcp_install mid-run, then call the new server from the root and a report. */
export const MCP_MIDRUN_TOKEN = '[mock:mcp-midrun]'
/** The server the [mock:mcp-midrun] script asks for, its report's id and the tool both agents call. */
export const MOCK_MIDRUN_SERVER = 'mock-midrun'
export const MOCK_MIDRUN_REPORT = 'mock-midrun-report'
export const MOCK_MIDRUN_TOOL = `mcp__${MOCK_MIDRUN_SERVER}__ping`

/**
 * The [mock:mcp-midrun] turn: ask for a server, then (once approved) call one of its tools from the root and from a
 * spawned report. Each call goes through the MCP grant gate and then the permission card, like the live adapter; a
 * role the install card left out gets the gate's denial as the tool result.
 */
const MCP_MIDRUN_STEPS: MockStep[] = [
  { type: 'text', text: 'This needs a server the project does not have; asking you to add it.' },
  {
    type: 'harness',
    name: MCP_HARNESS_TOOLS.requestInstall,
    retryOnRevise: false,
    args: {
      reason: 'Mock: exercise attaching an MCP server mid-run.',
      manual: { name: MOCK_MIDRUN_SERVER, transport: 'stdio', command: 'npx', args: ['-y', 'mock-midrun-server@1.0.0'] }
    }
  },
  { type: 'tool', name: MOCK_MIDRUN_TOOL, ask: true, result: 'PONG' },
  { type: 'spawn', id: MOCK_MIDRUN_REPORT, description: 'Ping the new MCP server' },
  { type: 'tool', agent: MOCK_MIDRUN_REPORT, name: MOCK_MIDRUN_TOOL, ask: true, result: 'PONG' },
  { type: 'finish', id: MOCK_MIDRUN_REPORT, result: 'Pinged the new MCP server.' },
  { type: 'text', text: 'Mock: the new MCP server was used.' }
]

/** Trigger token (work runs, default script): the permission-fatigue script (fatigueSteps). */
export const FATIGUE_TOKEN = '[mock:fatigue]'
/** The report the [mock:fatigue] script spawns. */
export const MOCK_FATIGUE_REPORT = 'mock-fatigue-report'

/**
 * The [mock:fatigue] turn for a project folder: a compound `cd <worktree> && npm test` with the CLI's compound rule
 * suggestion (replaced on the card by `Bash(npm test:*)`), an edit outside the project with setMode acceptEdits +
 * addDirectories suggestions, then `cd <project>/sub && npm test`. Nothing touches the disk.
 */
export function fatigueSteps(projectPath: string): MockStep[] {
  const worktree = join(projectPath, '.claude', 'worktrees', 'agent-x')
  const sibling = join(dirname(projectPath), 'sibling-notes')
  const sub = join(projectPath, 'sub')
  const bashRule = (cmd: string): PermissionSuggestion[] => [
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: `${cmd} *` }], behavior: 'allow', destination: 'localSettings' }
  ]
  const first = `cd ${worktree} && npm test`
  const last = `cd ${sub} && npm test`
  return [
    { type: 'text', text: 'Running the tests in the worktree.' },
    { type: 'tool', name: 'Bash', input: { command: first }, ask: true, suggestions: bashRule(first), result: 'Tests passed.' },
    { type: 'spawn', id: MOCK_FATIGUE_REPORT, description: 'Update the sibling notes' },
    {
      type: 'tool',
      agent: MOCK_FATIGUE_REPORT,
      name: 'Edit',
      input: { file_path: join(sibling, 'README.md'), old_string: 'old', new_string: 'new' },
      ask: true,
      suggestions: [
        { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
        { type: 'addDirectories', directories: [sibling], destination: 'session' }
      ],
      result: 'File updated.'
    },
    { type: 'finish', id: MOCK_FATIGUE_REPORT, result: 'Updated the sibling notes. Files touched: ../sibling-notes/README.md' },
    { type: 'tool', name: 'Bash', input: { command: last }, ask: true, suggestions: bashRule(last), result: 'Tests passed.' },
    { type: 'text', text: 'Mock: the fatigue script is done.' }
  ]
}

/** Trigger token (work runs, default script): a report tries to edit a file in the first reference folder (referenceEditSteps). */
export const REFERENCE_EDIT_TOKEN = '[mock:reference-edit]'
/** The report the [mock:reference-edit] script spawns. */
export const MOCK_REFERENCE_REPORT = 'mock-reference-report'

/**
 * The [mock:reference-edit] turn: a report reads, then tries an Edit under `ref` (the run's first reference folder),
 * which the reference gate refuses with referenceFolderMessage (the denial is the tool result), then finishes and the
 * root wraps up as usual. Without a reference folder the edit step is left out. Nothing touches the disk.
 */
export function referenceEditSteps(ref: string | undefined): MockStep[] {
  return [
    { type: 'text', text: 'Checking the client material.' },
    { type: 'spawn', id: MOCK_REFERENCE_REPORT, description: 'Review the client material' },
    ...(ref
      ? ([
          { type: 'tool', agent: MOCK_REFERENCE_REPORT, name: 'Read', input: { file_path: join(ref, 'brief.md') }, result: '# Client brief\n' },
          { type: 'tool', agent: MOCK_REFERENCE_REPORT, name: 'Edit', input: { file_path: join(ref, 'brief.md'), old_string: 'old', new_string: 'new' }, ask: true, result: 'File updated.' }
        ] satisfies MockStep[])
      : []),
    { type: 'finish', id: MOCK_REFERENCE_REPORT, result: 'Reviewed the client material; it is read-only, so notes go in the project folder.' },
    { type: 'text', text: 'Mock: the reference-edit script is done.' }
  ]
}

/** Appended to the deny text for an edit under a reference folder (same as claude.ts REFERENCE_COPY_HINT). */
export const MOCK_REFERENCE_COPY_HINT = '; write a copy in the working folder instead'

/** Trigger token (work runs, default script): the root runs a shell command naming a file in the first reference folder (referenceShellSteps). */
export const REFERENCE_SHELL_TOKEN = '[mock:reference-shell]'

/**
 * The [mock:reference-shell] turn: the root runs Bash `del "<ref>/brief.md"` with no `ask` on the step; the reference
 * shell guard forces a card with referenceFolder and no suggestions. Allow gives result 'ok' (the mock executes
 * nothing), Deny the deny text. Without a reference folder the command step is left out.
 */
export function referenceShellSteps(ref: string | undefined): MockStep[] {
  return [
    { type: 'text', text: 'Tidying the client material.' },
    ...(ref ? ([{ type: 'tool', name: 'Bash', input: { command: `del "${join(ref, 'brief.md')}"` } }] satisfies MockStep[]) : []),
    { type: 'text', text: 'Mock: the reference-shell script is done.' }
  ]
}

/** Trigger token (work runs, default script): the root changes its own project's MCP servers and skills mid-run. */
/** Trigger token (work runs, default script): a three-level agent tree whose reports all finish (deepTreeSteps). */
export const DEEP_TREE_TOKEN = '[mock:deep-tree]'
/** The agent ids (= handles) the [mock:deep-tree] script spawns. */
export const MOCK_DEEP_LEAD = 'mock-lead'
export const MOCK_DEEP_LEAD_REPORTS = ['mock-lead-report-1', 'mock-lead-report-2'] as const

/**
 * The [mock:deep-tree] turn: the root spawns `mock-lead` (role `leadSlug`), which spawns two reports of `reportSlug`;
 * both report back to mock-lead, which then reports back to the root. Scripted spawns are the harness's own fixture,
 * so they are not checked against the parent role's spawnable list (spawnStep never enforces it).
 */
export function deepTreeSteps(leadSlug: string, reportSlug: string): MockStep[] {
  const [r1, r2] = MOCK_DEEP_LEAD_REPORTS
  return [
    { type: 'text', text: 'Planning the work: one lead will split it between two reports.' },
    { type: 'spawn', id: MOCK_DEEP_LEAD, name: MOCK_DEEP_LEAD, role: leadSlug, description: 'Lead the deep-tree work' },
    { type: 'text', agent: MOCK_DEEP_LEAD, text: 'Splitting the work in two.' },
    { type: 'spawn', id: r1, name: r1, parent: MOCK_DEEP_LEAD, role: reportSlug, description: 'Do the first half' },
    { type: 'spawn', id: r2, name: r2, parent: MOCK_DEEP_LEAD, role: reportSlug, description: 'Do the second half' },
    { type: 'tool', agent: r1, name: 'Read', input: { file_path: 'README.md' }, result: '# Mock project\n' },
    { type: 'finish', id: r1, result: 'First half done.' },
    { type: 'tool', agent: r2, name: 'Glob', input: { pattern: 'src/**' }, result: 'src/example.ts' },
    { type: 'finish', id: r2, result: 'Second half done.' },
    { type: 'text', agent: MOCK_DEEP_LEAD, text: 'Both reports are done.' },
    { type: 'finish', id: MOCK_DEEP_LEAD, result: 'Both halves done by mock-lead-report-1 and mock-lead-report-2.' },
    { type: 'text', text: 'The lead finished: both halves are done. Anything else?' }
  ]
}

export const CONFIG_CHANGE_TOKEN = '[mock:config-change]'
/** The server and the skill the [mock:config-change] script proposes. */
export const MOCK_CONFIG_SERVER = 'mock-notes'
export const MOCK_CONFIG_SKILL = 'mock-config-skill'
/** Harness tools the [mock:config-change] script calls (work-run tools; a run without them logs a warning and goes on). */
const PROPOSE_MCP_TOOL = MCP_HARNESS_TOOLS.proposeServers
const PROPOSE_SKILLS_TOOL = SKILL_ASSIST_HARNESS_TOOLS.propose

/**
 * The [mock:config-change] turn for a root role: propose an MCP server and a project skill granted to the root, then
 * load the skill. Each approved proposal reaches the session through the configChanged hook (the mock applies it at
 * once), and the tool results land in the transcript as usual.
 */
export function configChangeSteps(rootSlug: string): MockStep[] {
  return [
    {
      type: 'harness',
      name: PROPOSE_MCP_TOOL,
      retryOnRevise: false,
      args: {
        title: 'Add mock notes server',
        rationale: 'Mock config change.',
        upsert: [{ name: MOCK_CONFIG_SERVER, transport: 'stdio', command: 'npx', args: ['-y', 'mock-fs-server@1.0.0'], roles: [rootSlug] }]
      }
    },
    {
      type: 'harness',
      name: PROPOSE_SKILLS_TOOL,
      retryOnRevise: false,
      args: {
        title: 'Add mock skill',
        rationale: 'Mock config change.',
        items: [
          {
            action: 'create',
            scope: 'project',
            draft: { name: MOCK_CONFIG_SKILL, description: 'Use for the mock config change.', body: 'Say that the mock config change worked.' },
            roles: [rootSlug]
          }
        ]
      }
    },
    { type: 'harness', name: SKILL_HARNESS_TOOLS.load, args: { name: MOCK_CONFIG_SKILL } },
    { type: 'text', text: 'Config change done.' }
  ]
}

export class MockSession implements RuntimeSession {
  readonly finished: Promise<void>
  /** Harness messages delivered to the orchestrator (automatic continues), in order. For tests. */
  readonly harnessMessages: string[] = []
  /** Raw messages from other runs delivered through receive(), in order. For tests. */
  readonly peerMessages: PeerMessage[] = []
  /**
   * What a real adapter would grant: role slug -> names of the MCP servers that role may use, from the LIVE server
   * list (servers installed mid-run and the install card's roles included). For tests.
   */
  get mcpServersByRole(): Record<string, string[]> {
    const specs = { mcpServers: this.liveMcpServers() }
    return Object.fromEntries(this.ctx.roles.map((r) => [r.slug, mcpServersForRole(specs, r).map((s) => s.name)]))
  }
  /** The enabled plugins the session would load. For tests. */
  readonly plugins: PluginSpec[] = []
  /** Which adapter and connection the run was routed to; never secrets. Undefined without ctx.connection. For tests. */
  readonly connection?: { adapter: ProviderId; connection: ConnectionId }
  /** Servers attached mid-run through the harness's addMcpServer hook, in order. For tests. */
  readonly addedMcpServers: McpServerSpec[] = []
  /** Changes reported through the harness's configChanged hook (approved propose_mcp_servers / propose_skills), in order. For tests. */
  readonly configChanges: ConfigChange[] = []
  private hooks: HarnessToolHooks
  private agents = new Map<string, AgentInstance>()
  private rolesBySlug: Map<string, Role>
  private root: Role
  private isSetup: boolean
  private tools: HarnessTool[]
  private inbox: { text: string; harness: boolean }[] = []
  private continueTurns: MockStep[][]
  private continuation: ContinuationDriver
  private wake: (() => void) | null = null
  private stopped = false
  private interrupted = false
  private stopSignal: Promise<typeof STOPPED>
  private signalStop!: () => void
  /** agent id -> spawning tool_use id, for the parent's tool_result. */
  private spawnToolUse = new Map<string, string>()
  /** Allow rules granted for the rest of this session. */
  private sessionRules = new Set<string>()
  /** A setMode acceptEdits granted for the rest of this session (the CLI's session permission mode). */
  private sessionAcceptEdits = false
  /** Folders granted for the rest of this session (addDirectories). */
  private sessionDirs = new Set<string>()
  private handles = new HandleNamer()
  /** Harness tool name -> audience, for the MCP grant gate (same as the Claude adapter's PreToolUse). */
  private harnessAudiences = new Map<string, HarnessToolAudience>()

  constructor(
    private ctx: RuntimeContext,
    private script: Required<MockScript>,
    loadError?: string
  ) {
    const root = ctx.roles.find((r) => r.reportsTo === null) ?? ctx.roles[0]
    if (!root) throw new Error('Project has no roles')
    this.root = root
    this.isSetup = isSetupLikeRun(ctx.run.kind)
    this.rolesBySlug = new Map(ctx.roles.map((r) => [r.slug, r]))
    const onDecided = (): void => {
      const a = this.agents.get(ROOT_AGENT_ID)
      if (a && a.state === 'waiting') this.setState(ROOT_AGENT_ID, 'thinking', 'Thinking…')
    }
    const onPlanUpdated = (plan: RunPlan): void => {
      const a = this.agents.get(ROOT_AGENT_ID)
      const activity = stepActivity(plan)
      if (a && activity && a.state !== 'done' && a.state !== 'error') this.setState(ROOT_AGENT_ID, a.state, activity)
    }
    this.hooks = { onDecided, onPlanUpdated, addMcpServer: (spec) => this.addMcpServer(spec), configChanged: (change) => this.configChanged(change) }
    this.tools = harnessToolsFor(ctx, this.hooks)
    this.harnessAudiences = new Map(this.tools.map((t) => [t.name, t.audience]))
    this.plugins.push(...(ctx.plugins?.() ?? []).filter((p) => p.enabled))
    if (ctx.connection) this.connection = { adapter: ctx.connection.adapter, connection: ctx.connection.connection }
    this.continueTurns = [...(script.continue ?? [])]
    this.continuation = new ContinuationDriver({
      kind: ctx.run.kind,
      projectKind: projectKindOf(ctx.project),
      autoContinue: ctx.autoContinue,
      maxAutoContinues: ctx.maxAutoContinues,
      delayMs: ctx.continuationDelayMs,
      getPlan: () => ctx.getPlan(),
      updatePlan: (plan) => ctx.updatePlan(plan),
      liveReports: () => [...this.agents.values()].filter((a) => a.id !== ROOT_AGENT_ID && a.state !== 'done' && a.state !== 'error').length,
      pendingInteractions: () => ctx.pendingInteractions(),
      rateLimited: () => false,
      stopping: () => this.stopped,
      orchestratorBusy: () => {
        const root = this.agents.get(ROOT_AGENT_ID)
        return !!root && root.state !== 'idle' && root.state !== 'done'
      },
      nudge: (text, activity, summary) => this.deliverHarness(text, activity, { summary }),
      log: (level, message) => this.log(level, message),
      tellUser: (text) => this.transcript(ROOT_AGENT_ID, { kind: 'system', text }, { source: 'harness' })
    })
    this.stopSignal = new Promise((resolve) => (this.signalStop = () => resolve(STOPPED)))
    if (loadError) this.log('warn', loadError)
    this.finished = this.run()
  }

  // ---------- public API ----------

  async send(text: string, images?: ImageAttachment[]): Promise<void> {
    this.continuation.userMessage()
    this.transcript(ROOT_AGENT_ID, images?.length ? { kind: 'user', text, images } : { kind: 'user', text })
    this.setState(ROOT_AGENT_ID, 'thinking', 'Thinking…')
    // An image-only message is still a turn; give the scripted reply something to echo.
    const n = images?.length ?? 0
    this.inbox.push({ text: text || (n ? `[${n} image${n === 1 ? '' : 's'}]` : ''), harness: false })
    this.poke()
  }

  /** Ends the current turn before its next step; a blocking request in flight still waits for its answer. */
  async interrupt(): Promise<void> {
    this.continuation.hold()
    this.interrupted = true
    this.poke()
  }

  /** A message from another run: delivered like a harness message, but RunManager writes the transcript block. */
  async receive(message: PeerMessage): Promise<void> {
    if (this.stopped) return
    this.peerMessages.push(message)
    this.deliverHarness(peerMessageText(message), 'Reading a message from another run…', { transcript: false })
  }

  async stop(): Promise<void> {
    this.continuation.dispose()
    this.stopped = true
    this.signalStop()
    this.poke()
  }

  /**
   * The addMcpServer harness hook: record the server. The mock has no whitelists to widen, so the tools are callable
   * at once ('now'); the per-role grant gate in toolStep still applies (the Claude adapter answers 'after-idle').
   */
  async addMcpServer(spec: McpServerSpec): Promise<McpAttachResult> {
    this.addedMcpServers.push(spec)
    return { prefix: `mcp__${spec.name}__`, availability: 'now' }
  }

  /**
   * The configChanged harness hook: record the change and apply it at once ('now'). The MCP grant gate already reads
   * the live server list; a skills change re-binds the harness tools so list_skills / load_skill see the live
   * ctx.skills() (the Claude adapter's Skill gate reads the live grants the same way, and answers 'after-idle' when a
   * re-created query is needed).
   */
  async configChanged(change: ConfigChange): Promise<ConfigChangeResult> {
    this.configChanges.push(structuredClone(change))
    if (change.skills) {
      this.tools = harnessToolsFor(this.ctx, this.hooks)
      this.harnessAudiences = new Map(this.tools.map((t) => [t.name, t.audience]))
    }
    return { availability: 'now' }
  }

  /** The run's MCP servers as they are now (project servers plus run-scoped installs). */
  private liveMcpServers(): McpServerSpec[] {
    return this.ctx.mcpServers ? this.ctx.mcpServers() : (this.ctx.project.mcpServers ?? [])
  }

  /** The role behind an agent id (the root's for the root). */
  private roleOf(agentId: string): Role | undefined {
    if (agentId === ROOT_AGENT_ID) return this.root
    const a = this.agents.get(agentId)
    return (a?.roleId ? this.ctx.roles.find((r) => r.id === a.roleId) : undefined) ?? (a ? this.rolesBySlug.get(a.roleSlug) : undefined)
  }

  // ---------- events ----------

  private emit(e: RunEvent): void {
    this.ctx.emit(e)
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.emit({ type: 'log', runId: this.ctx.run.id, level, message })
  }

  private transcript(agentId: string, block: TranscriptBlock, opts?: { source?: 'harness' }): void {
    this.emit({ type: 'transcript', runId: this.ctx.run.id, entry: { id: newId('t'), agentId, at: Date.now(), block, ...(opts?.source ? { source: opts.source } : {}) } })
  }

  private upsert(agent: AgentInstance): void {
    this.agents.set(agent.id, agent)
    this.emit({ type: 'agent.upsert', runId: this.ctx.run.id, agent: { ...agent, ...(agent.usage ? { usage: structuredClone(agent.usage) } : {}) } })
  }

  private ensureAgent(id: string, init?: Partial<AgentInstance>): AgentInstance {
    let a = this.agents.get(id)
    if (!a) {
      const role = this.rolesBySlug.get(init?.roleSlug ?? this.root.slug)
      a = {
        id,
        roleId: role?.id ?? null,
        roleSlug: role?.slug ?? this.root.slug,
        name: role?.name ?? id,
        parentId: id === ROOT_AGENT_ID ? null : ROOT_AGENT_ID,
        spawnToolUseId: null,
        state: 'starting',
        activity: 'Starting…',
        model: this.usageModel(id),
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

  /** Synthetic usage: every step costs a little, so tokens and cost move like a real run. */
  private charge(agentId: string, text: string): void {
    const a = this.ensureAgent(agentId)
    const model = this.usageModel(agentId)
    const before = usageOf(a).models.find((m) => m.model === model)
    const prev: TokenUsage = before ? before.tokens : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    // 800 input-side tokens per response, split like a real cached session.
    const next: TokenUsage = {
      input: prev.input + 200,
      output: prev.output + Math.max(20, Math.ceil(text.length / 4)),
      cacheRead: prev.cacheRead + 500,
      cacheWrite: prev.cacheWrite + 100
    }
    const unit = next.input + next.cacheRead * 0.1 + next.cacheWrite * 1.25 + 5 * next.output
    setModelTokens(a, model, next, this.providerCosted(agentId) ? unit * USD_PER_TOKEN : undefined)
    countUsage(a, 'turns')
    a.costUsd = this.providerCosted(agentId) ? (a.inputTokens + 5 * a.outputTokens) * USD_PER_TOKEN : 0
  }

  /** The model id this agent reports, by default Opus for the root and Sonnet for reports. */
  private usageModel(agentId: string): string {
    const prompt = this.ctx.prompt
    if (prompt.includes(NO_PRICE_TOKEN) || (agentId === UNPRICED_REPORT_ID && !prompt.includes(COMPUTED_COST_TOKEN))) return MOCK_UNPRICED_MODEL
    if (prompt.includes(COMPUTED_COST_TOKEN)) return 'claude-sonnet-4-5'
    return agentId === ROOT_AGENT_ID ? 'claude-opus-4-5' : 'claude-sonnet-4-5'
  }

  /** Whether the mock "provider" reports a cost for this agent (like Anthropic does; LiteLLM and Codex do not). */
  private providerCosted(agentId: string): boolean {
    return this.usageModel(agentId) !== MOCK_UNPRICED_MODEL && !this.ctx.prompt.includes(COMPUTED_COST_TOKEN)
  }

  /** Provider-reported cost only: agents without one are priced by RunManager. */
  private totalCost(): number {
    let usd = 0
    for (const a of this.agents.values()) for (const m of a.usage?.models ?? []) usd += m.providerCostUsd ?? 0
    return usd
  }

  // ---------- control flow ----------

  private poke(): void {
    const w = this.wake
    this.wake = null
    w?.()
  }

  /** Wait `ms`, cut short by stop or interrupt. */
  private pause(ms: number): Promise<void> {
    if (ms <= 0 || this.stopped || this.interrupted) return Promise.resolve()
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.wake = null
        resolve()
      }, ms)
      this.wake = () => {
        clearTimeout(t)
        resolve()
      }
    })
  }

  private untilStopped<T>(p: Promise<T>): Promise<T | typeof STOPPED> {
    return Promise.race([p, this.stopSignal])
  }

  private nextMessage(): Promise<{ text: string; harness: boolean } | null> {
    if (this.inbox.length) return Promise.resolve(this.inbox.shift()!)
    if (this.stopped) return Promise.resolve(null)
    return new Promise((resolve) => {
      this.wake = () => resolve(this.stopped ? null : this.inbox.shift() ?? { text: '', harness: false })
    })
  }

  /** A harness message for the orchestrator (the Claude adapter's notifyOrchestrator path). */
  private deliverHarness(text: string, activity: string, opts: { transcript?: boolean; summary?: string } = {}): void {
    this.harnessMessages.push(text)
    if (opts.transcript !== false) {
      this.transcript(ROOT_AGENT_ID, { kind: 'system', text: opts.summary ?? text, ...(opts.summary ? { detail: text } : {}) }, { source: 'harness' })
    }
    const root = this.agents.get(ROOT_AGENT_ID)
    if (root && (root.state === 'idle' || root.state === 'done')) this.setState(ROOT_AGENT_ID, 'thinking', activity)
    this.emit({ type: 'run.status', runId: this.ctx.run.id, status: 'running' })
    this.inbox.push({ text, harness: true })
    this.poke()
  }

  private async run(): Promise<void> {
    const runId = this.ctx.run.id
    this.ensureAgent(ROOT_AGENT_ID, {
      roleId: this.root.id,
      roleSlug: this.root.slug,
      name: this.root.name,
      parentId: null,
      state: 'thinking',
      activity: 'Reading your request…'
    })
    if (this.ctx.resumeSessionId) {
      this.transcript(ROOT_AGENT_ID, { kind: 'system', text: `Continued from run ${this.ctx.run.resumedFrom ?? this.ctx.resumeSessionId}` }, { source: 'harness' })
    }
    const firstImages = this.ctx.images
    this.transcript(
      ROOT_AGENT_ID,
      firstImages?.length ? { kind: 'user', text: this.ctx.prompt, images: firstImages } : { kind: 'user', text: this.ctx.prompt }
    )
    const sessionId = this.ctx.resumeSessionId ?? `mock-${runId}`
    try {
      this.emit({ type: 'run.status', runId, status: 'running', sessionId })
      const first = composeFirstMessage(this.ctx.prompt, this.ctx.hiddenContext)
      this.log('info', `Mock session ${sessionId} started (${this.ctx.run.kind} script, first message ${first.length} chars)`)
      if (this.ctx.prompt.includes(AUTH_FAIL_TOKEN)) return this.failAuth()
      await this.skillStep(ROOT_AGENT_ID, this.root)
      await this.turn(this.firstTurnSteps())
      while (!this.stopped) {
        const next = await this.nextMessage()
        if (next === null) break
        if (!next.text) continue
        if (!next.harness && next.text.includes(AUTH_FAIL_TOKEN)) return this.failAuth()
        this.emit({ type: 'run.status', runId, status: 'running' })
        if (next.harness) await this.turn(this.continueTurns.shift() ?? [{ type: 'text', text: 'Mock: continuing with the plan.' }])
        else await this.turn([{ type: 'text', text: this.script.reply.replace('{text}', next.text) }])
      }
      this.emit({ type: 'run.status', runId, status: 'finished' })
    } catch (e) {
      const message = (e as Error).message ?? String(e)
      this.log('error', message)
      this.setState(ROOT_AGENT_ID, 'error', message.slice(0, 80))
      this.emit({ type: 'run.status', runId, status: 'error', error: message })
    } finally {
      this.continuation.dispose()
      for (const a of this.agents.values()) {
        if (a.state !== 'done' && a.state !== 'error') {
          a.state = 'done'
          a.endedAt = Date.now()
          this.upsert(a)
        }
      }
    }
  }

  /** Like the Claude path on an auth failure: one harness row, the root in error, the run ends 'error'. */
  private failAuth(): void {
    const message = authFailureMessage(this.ctx.connection?.connection)
    this.transcript(ROOT_AGENT_ID, { kind: 'system', text: message, detail: 'Invalid API key · Please run /login' }, { source: 'harness' })
    this.log('error', 'Authentication failed: Invalid API key · Please run /login')
    this.setState(ROOT_AGENT_ID, 'error', 'Connection refused')
    this.emit({ type: 'run.status', runId: this.ctx.run.id, status: 'error', error: message })
  }

  /**
   * The first turn's steps. The built-in setup and mcp-assist scripts adapt to the MCP library; a custom script
   * (ORGAI_MOCK_SCRIPT or MockAdapterOptions.script) runs exactly as written.
   */
  private firstTurnSteps(): MockStep[] {
    const library = this.ctx.mcpLibrary?.() ?? []
    if (this.ctx.run.kind === 'mcp-assist') {
      const steps = this.script.mcpAssist
      if (steps !== DEFAULT_MCP_ASSIST || this.ctx.project.id === HARNESS_PROJECT_ID) return steps
      return steps.map((st) => {
        if (st.type !== 'harness' || st.name !== MCP_HARNESS_TOOLS.proposeServers) return st
        const upsert: Record<string, unknown>[] = ((st.args?.upsert as Record<string, unknown>[] | undefined) ?? []).map((u) => ({ ...u, projectOnly: false }))
        if (library[0]) upsert.push({ libraryId: library[0].id })
        return { ...st, args: { ...st.args, upsert } }
      })
    }
    if (this.ctx.run.kind === 'skill-assist') {
      if (this.script.skillAssist !== DEFAULT_SKILL_ASSIST) return this.script.skillAssist
      return this.defaultSkillAssistSteps()
    }
    if (this.ctx.run.kind === 'work' && this.ctx.run.quick && this.script.work === DEFAULT_WORK) {
      const n = this.ctx.listProjects?.().length ?? 0
      return [
        { type: 'harness', name: CHAT_HARNESS_TOOLS[0], args: {} },
        { type: 'text', text: `I can see ${n} OrgAI project${n === 1 ? '' : 's'}. Tell me what you would like to do.` }
      ]
    }
    if (this.isSetup && this.script.setup === DEFAULT_SETUP && library[0]) {
      const at = DEFAULT_SETUP.findIndex((st) => st.type === 'harness' && st.name === 'complete_setup')
      const item: Record<string, unknown> = { libraryId: library[0].id, ...(this.root ? { roles: [this.root.slug] } : {}) }
      const step: MockStep = {
        type: 'harness',
        name: MCP_HARNESS_TOOLS.proposeServers,
        retryOnRevise: false,
        args: { title: 'Suggested tools', rationale: `The MCP library already has "${library[0].name}"; linking it saves setting it up again.`, upsert: [item] }
      }
      return at < 0 ? [...DEFAULT_SETUP, step] : [...DEFAULT_SETUP.slice(0, at), step, ...DEFAULT_SETUP.slice(at)]
    }
    if (!this.isSetup && this.ctx.run.kind === 'work' && this.script.work === DEFAULT_WORK && this.ctx.prompt.includes(MCP_MIDRUN_TOKEN)) return MCP_MIDRUN_STEPS
    if (!this.isSetup && this.ctx.run.kind === 'work' && !this.ctx.run.quick && this.script.work === DEFAULT_WORK && this.ctx.prompt.includes(CONFIG_CHANGE_TOKEN)) return configChangeSteps(this.root.slug)
    if (!this.isSetup && this.ctx.run.kind === 'work' && !this.ctx.run.quick && this.script.work === DEFAULT_WORK && this.ctx.prompt.includes(FATIGUE_TOKEN)) return fatigueSteps(this.ctx.project.path)
    if (!this.isSetup && this.ctx.run.kind === 'work' && !this.ctx.run.quick && this.script.work === DEFAULT_WORK && this.ctx.prompt.includes(REFERENCE_EDIT_TOKEN)) {
      const ref = this.ctx.referenceDirectories?.()[0]
      if (!ref) this.log('info', 'Mock [mock:reference-edit]: this run has no reference folder, so the edit step is skipped.')
      return referenceEditSteps(ref)
    }
    if (!this.isSetup && this.ctx.run.kind === 'work' && !this.ctx.run.quick && this.script.work === DEFAULT_WORK && this.ctx.prompt.includes(REFERENCE_SHELL_TOKEN)) {
      const ref = this.ctx.referenceDirectories?.()[0]
      if (!ref) this.log('info', 'Mock [mock:reference-shell]: this run has no reference folder, so the command step is skipped.')
      return referenceShellSteps(ref)
    }
    if (!this.isSetup && this.ctx.run.kind === 'work' && !this.ctx.run.quick && this.script.work === DEFAULT_WORK && this.ctx.prompt.includes(DEEP_TREE_TOKEN)) {
      const lead = this.firstSpawnableSlug(this.root)
      return deepTreeSteps(lead, this.firstSpawnableSlug(this.rolesBySlug.get(lead), lead))
    }
    return this.isSetup ? this.script.setup : this.script.work
  }

  /**
   * Skill assistant default: list the library, then propose one 'mock-skill' (library scope on the skills project;
   * project scope granted to the project's first role, or library scope when the project has no roles).
   */
  private defaultSkillAssistSteps(): MockStep[] {
    const roleSlug = this.ctx.project.id === SKILLS_PROJECT_ID ? undefined : this.ctx.project.roles[0]?.slug
    const item = {
      action: 'create',
      scope: roleSlug ? 'project' : 'library',
      draft: { name: MOCK_SKILL_DRAFT.name, description: MOCK_SKILL_DRAFT.description, body: MOCK_SKILL_DRAFT.body },
      ...(roleSlug ? { roles: [roleSlug] } : {})
    }
    return [
      { type: 'text', text: 'I will look at the skill library first, then propose a skill.' },
      { type: 'harness', name: SKILL_ASSIST_HARNESS_TOOLS.list, args: {} },
      { type: 'harness', name: SKILL_ASSIST_HARNESS_TOOLS.propose, args: { title: 'Mock skill', rationale: 'A short checklist skill exercises the proposal flow without spending tokens.', items: [item] } },
      { type: 'text', text: 'The skill is set up.' }
    ]
  }

  private async turn(steps: MockStep[]): Promise<void> {
    this.interrupted = false
    this.setState(ROOT_AGENT_ID, 'thinking', 'Thinking…')
    for (const step of steps) {
      await this.pause(this.script.delayMs)
      if (this.stopped || this.interrupted) break
      await this.step(step)
    }
    if (this.stopped) return
    if (this.interrupted) this.log('info', 'Turn interrupted.')
    this.emit({ type: 'run.cost', runId: this.ctx.run.id, totalCostUsd: this.totalCost() })
    const root = this.ensureAgent(ROOT_AGENT_ID)
    root.state = 'idle'
    const reportsRunning = [...this.agents.values()].some((x) => x.id !== ROOT_AGENT_ID && x.state !== 'done' && x.state !== 'error')
    root.activity = reportsRunning ? 'Waiting on reports…' : 'Waiting for you'
    this.upsert(root)
    this.emit({ type: 'run.status', runId: this.ctx.run.id, status: 'idle' })
    if (!this.interrupted && !this.isSetup) this.continuation.turnEnded()
  }

  private async step(step: MockStep): Promise<void> {
    switch (step.type) {
      case 'text': {
        const agentId = step.agent ?? ROOT_AGENT_ID
        const a = this.ensureAgent(agentId)
        this.emit({ type: 'agent.partial', runId: this.ctx.run.id, agentId, text: step.text.slice(0, Math.ceil(step.text.length / 2)) })
        a.lastText = step.text.trim().slice(0, 200)
        this.charge(agentId, step.text)
        this.transcript(agentId, { kind: 'text', text: step.text })
        this.emit({ type: 'agent.partial', runId: this.ctx.run.id, agentId, text: '' })
        this.upsert(a)
        return
      }
      case 'thinking': {
        this.transcript(step.agent ?? ROOT_AGENT_ID, { kind: 'thinking', text: step.text })
        return
      }
      case 'tool':
        return this.toolStep(step)
      case 'spawn':
        return this.spawnStep(step)
      case 'finish': {
        const a = this.ensureAgent(step.id)
        a.result = step.result
        a.state = 'done'
        a.activity = 'Reported back'
        a.endedAt = Date.now()
        this.upsert(a)
        const toolUseId = this.spawnToolUse.get(step.id)
        if (toolUseId) this.transcript(a.parentId ?? ROOT_AGENT_ID, { kind: 'tool_result', toolUseId, content: step.result, isError: false })
        if (a.parentId) this.setState(a.parentId, 'thinking', 'Thinking…')
        return
      }
      case 'harness':
        return this.harnessStep(step)
      case 'retry': {
        const a = this.ensureAgent(step.agent ?? ROOT_AGENT_ID)
        countUsage(a, 'retries')
        this.log('info', `API request retried (attempt 1 of 3) for ${a.name}`)
        this.upsert(a)
        return
      }
      case 'plan':
        return this.harnessStep({
          type: 'harness',
          name: PLAN_TOOLS.set,
          args: { goal: step.goal, steps: step.steps.map((s) => (typeof s === 'string' ? { title: s } : s)) }
        })
      case 'planUpdate':
        return this.harnessStep({ type: 'harness', name: PLAN_TOOLS.update, args: { steps: step.steps } })
      case 'planComplete':
        return this.harnessStep({ type: 'harness', name: PLAN_TOOLS.complete, args: { summary: step.summary } })
      case 'message': {
        const from = step.from ?? ROOT_AGENT_ID
        const input = { to: step.to, message: step.text }
        this.transcript(from, { kind: 'tool_use', id: newId('tu'), name: 'SendMessage', input })
        const m = mapSendMessage(from, input, this.agents.values())
        if (!m) return
        this.emit({ type: 'agent.message', runId: this.ctx.run.id, ...m })
        this.transcript(from, { kind: 'system', text: messageTranscriptText(m) })
        if (m.to) this.transcript(m.to, { kind: 'user', text: step.text })
        return
      }
      case 'rateLimit': {
        const until = step.untilInMs !== undefined ? Date.now() + step.untilInMs : undefined
        const window = step.window ?? 'five_hour'
        this.emit({
          type: 'usage.status',
          runId: this.ctx.run.id,
          usage: {
            authMode: 'subscription',
            subscriptionType: 'mock',
            available: true,
            windows: { fiveHour: { utilization: 100, resetsAt: until ?? null } },
            status: 'rejected',
            limitedWindow: window,
            ...(until ? { limitedUntil: until } : {}),
            updatedAt: Date.now()
          }
        })
        this.log('warn', 'Mock usage limit reached; ending the session.')
        this.ctx.rateLimited({ window, ...(until ? { until } : {}) })
        this.stopped = true
        this.signalStop()
        return
      }
    }
  }

  private async toolStep(step: Extract<MockStep, { type: 'tool' }>): Promise<void> {
    const agentId = step.agent ?? ROOT_AGENT_ID
    const input = step.input ?? {}
    const id = newId('tu')
    this.transcript(agentId, { kind: 'tool_use', id, name: step.name, input })
    this.charge(agentId, JSON.stringify(input))
    countUsage(this.ensureAgent(agentId), 'toolCalls')
    this.setState(agentId, 'tool', describeTool(step.name, input))
    // Same refusal as the Claude adapter's PreToolUse deny: build sessions never write <workspace>/.claude (no card, no allow rule).
    const ws = this.ctx.run.buildWorkspace
    if (ws && MOCK_CONFIG_WRITE_TOOLS.has(step.name)) {
      const target = step.name === 'NotebookEdit' ? (input.notebook_path ?? input.file_path) : (input.file_path ?? input.notebook_path)
      if (isWorkspaceConfigPath(ws, target)) {
        this.transcript(agentId, { kind: 'tool_result', toolUseId: id, content: 'Build sessions cannot write OrgAI or Claude settings under .claude/ in the workspace.', isError: true })
        this.setState(agentId, 'thinking', 'Thinking…')
        return
      }
    }
    // Same reference-folder gate as the Claude adapter's PreToolUse: edit tools under a reference folder (or naming no
    // path while any exist) are refused before any rule, mode or card. The list is live; the mock's cwd is the project.
    // An unreadable list refuses an edit tool (same wording as the Claude adapter). The refusal also writes one harness
    // row on the agent ("Refused: <file> is in a reference folder (read only)").
    const refusal = this.referenceEditRefusal(step.name, input)
    if (refusal) {
      this.log('warn', `Blocked ${step.name} by ${this.agents.get(agentId)?.name ?? agentId}: ${refusal.reason}`)
      this.transcript(agentId, { kind: 'tool_result', toolUseId: id, content: refusal.reason, isError: true })
      this.transcript(agentId, { kind: 'system', ...refusal.entry }, { source: 'harness' })
      this.setState(agentId, 'thinking', 'Thinking…')
      return
    }
    // Same per-role MCP grant gate as the Claude adapter's PreToolUse, from the live server list; the MCP resource
    // tools are gated on input.server.
    const mcpDenial = mcpCallDenial(step.name, { role: this.roleOf(agentId), isRoot: agentId === ROOT_AGENT_ID }, this.liveMcpServers(), this.harnessAudiences, input)
    if (mcpDenial) {
      this.log('warn', `Blocked ${step.name} by ${this.agents.get(agentId)?.name ?? agentId}: ${mcpDenial}`)
      this.transcript(agentId, { kind: 'tool_result', toolUseId: id, content: mcpDenial, isError: true })
      this.setState(agentId, 'thinking', 'Thinking…')
      return
    }
    // Reference folders (same as the Claude adapter): a shell command touching one always asks (even a step without
    // `ask`), never through a rule, suggestion shortcut or mode; a Read / Glob / Grep card under one names the folder.
    // Such cards carry referenceFolder and no suggestions, and an allow grants this call only.
    const ref = this.referenceTouch(step.name, input)
    if (ref?.forced) this.log('info', `Asking about ${step.name} by ${this.agents.get(agentId)?.name ?? agentId}: ${ref.folder ? referenceCommandMessage(ref.folder, ref.how ?? 'names') : 'the reference folders could not be read'}`)
    const refField = ref?.folder ? { referenceFolder: ref.folder } : {}
    if (step.ask && step.background) {
      // Leave the request pending and carry on; the result lands whenever the user answers.
      this.setState(agentId, 'waiting', `Needs approval: ${describeTool(step.name, input)}`)
      void this.ctx.requestPermission({ agentId, toolName: step.name, input, summary: describeTool(step.name, input), ...refField }).then((decision) => {
        if (this.stopped) return
        const denied = decision.behavior === 'deny'
        this.transcript(agentId, { kind: 'tool_result', toolUseId: id, content: denied ? decision.message : step.result ?? 'ok', isError: denied })
        const a = this.agents.get(agentId)
        if (a && a.state === 'waiting') this.setState(agentId, 'thinking', 'Thinking…')
      })
      return
    }
    if (step.ask || ref?.forced) {
      const restricted = isTrustRestrictedRun(this.ctx.run)
      let suggestions: PermissionSuggestion[] = []
      let preApproved = false
      let opts: MatchOptions | undefined
      // A touching shell command skips every allow path (and never reads matchOptionsFor, which an unreadable list breaks).
      if (!ref?.forced) {
        const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : undefined
        opts = { ...matchOptionsFor(this.ctx), ...(cwd ? { effectiveCwd: cwd } : {}) }
        // Same as the Claude adapter: server-level rules are offered for the user's MCP servers only (never one an agent
        // installed this run, never orgai), and a trust-restricted run never gets a setMode suggestion.
        const installedAll = agentInstalledServers(this.liveMcpServers(), this.ctx.project.mcpServers, this.addedMcpServers.map((x) => x.name))
        const userMcpServers = [...new Set(this.liveMcpServers().filter((s) => s.enabled && s.name !== 'orgai' && !installedAll.has(s.name)).map((s) => s.name))]
        // A read under a reference folder gets no suggestions (M2).
        const chosen = ref ? [] : chooseSuggestions(step.name, input, step.suggestions, false, { ...opts, userMcpServers })
        suggestions = restricted ? chosen.filter((s) => s.type !== 'setMode') : chosen
        const rules = allowRuleStrings(suggestions)
        // A quick run or build session never reads saved rules from the user's folder (same as the Claude adapter).
        // Saved rules come from ctx.savedRules() (OrgAI's data folder for engagements), else the folder's file.
        const savedRules = isTrustRestrictedRun(this.ctx.run) ? [] : this.ctx.savedRules ? this.ctx.savedRules() : listRules(this.ctx.project.path)
        const saved = new Set([...savedRules, ...this.sessionRules])
        // Live grants (request_permission_rules, the rules panel) count too, like the real adapters' matchers.
        // A server an agent installed this run is never approved by a server-level rule (same as the Claude adapter).
        const installed = step.name.startsWith('mcp__') ? installedAll : new Set<string>()
        // The suggestion shortcut stands in for the CLI's own match of allowedTools and session updates, which never
        // carry Bash / PowerShell rules (Claude adapter H-A / H1): shell calls are approved only through matchingRule.
        const savedUsable = new Set(withoutServerRules([...saved], installed).filter((r) => !/^(Bash|PowerShell)(\(|$)/.test(r.trim())))
        const usable = withoutServerRules([...saved, ...(this.ctx.allowedRules?.() ?? [])], installed)
        preApproved =
          (rules.length > 0 && rules.every((r) => savedUsable.has(r))) ||
          matchingRule(step.name, input, usable, opts) !== undefined ||
          this.editPreApproved(step.name, input, restricted)
      }
      if (!preApproved) {
        this.setState(agentId, 'waiting', `Needs approval: ${describeTool(step.name, input)}`)
        const decision = await this.untilStopped(
          this.ctx.requestPermission({
            agentId,
            toolName: step.name,
            input,
            summary: describeTool(step.name, input),
            ...(suggestions.length ? { suggestions, ruleLabels: suggestionLabels(suggestions) } : {}),
            ...refField
          })
        )
        if (decision === STOPPED) return
        const a = this.agents.get(agentId)
        if (a && a.state === 'waiting') this.setState(agentId, 'tool', describeTool(step.name, input))
        if (decision.behavior === 'deny') {
          this.transcript(agentId, { kind: 'tool_result', toolUseId: id, content: decision.message, isError: true })
          this.setState(agentId, 'thinking', 'Thinking…')
          return
        }
        // A reference-folder card grants this call only: no rule, folder or mode is kept.
        if (ref || !opts) {
          this.transcript(agentId, { kind: 'tool_result', toolUseId: id, content: step.result ?? 'ok', isError: false })
          this.setState(agentId, 'thinking', 'Thinking…')
          return
        }
        // Same as the Claude adapter: a trust-restricted run never persists anything (project scope becomes session).
        const granted = applyAllowScope(
          this.ctx.project.path,
          restricted && decision.scope === 'project' ? { ...decision, scope: 'session' } : decision,
          suggestions,
          (level, message) => this.log(level, message),
          restricted ? undefined : allowScopePersist(this.ctx),
          { toolName: step.name, input, opts }
        )
        for (const r of allowRuleStrings(granted ?? [])) this.sessionRules.add(r)
        for (const s of granted ?? []) {
          // A trust-restricted run stays ask-only: a session acceptEdits is never honoured there.
          if (s.type === 'setMode' && s.mode === 'acceptEdits' && !restricted) this.sessionAcceptEdits = true
          // Only folders the card may offer (never the data folder, home, a credential folder or a root).
          if (s.type === 'addDirectories') for (const d of s.directories) if (isOfferableDirectory(d, opts)) this.sessionDirs.add(d)
        }
      }
    }
    this.transcript(agentId, { kind: 'tool_result', toolUseId: id, content: step.result ?? 'ok', isError: false })
    this.setState(agentId, 'thinking', 'Thinking…')
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
   * Same as the Claude adapter's referenceEditRefusal: the deny text for an edit tool under a reference folder (plus
   * MOCK_REFERENCE_COPY_HINT) and its harness row. The mock's cwd is the project folder.
   */
  private referenceEditRefusal(toolName: string, input: Record<string, unknown>): { reason: string; entry: { text: string; detail: string } } | null {
    if (!REFERENCE_EDIT_TOOLS.has(toolName)) return null
    const refs = this.referenceList()
    if (refs === undefined) return null
    if (refs === 'unreadable') {
      return { reason: 'OrgAI could not check the reference folders, so this edit was refused. Try again shortly.', entry: referenceRefusalEntry(undefined, 'a reference folder') }
    }
    const cwd = this.ctx.project.path
    const denial = referenceEditDenial(toolName, input, refs, cwd)
    if (!denial) return null
    const target = referenceEditTarget(toolName, input)
    const hit = referenceFolderOf(target, refs, cwd)
    return { reason: `${denial}${MOCK_REFERENCE_COPY_HINT}`, entry: referenceRefusalEntry(hit ? target : undefined, hit ?? refs[0] ?? 'a reference folder') }
  }

  /**
   * The reference folder a call touches, for the permission path. Shell tools (forced: always asked): commandReferenceTouch
   * from input.cwd, else the project folder; an unreadable list counts as touching with no folder. Read / Glob / Grep
   * (not forced): referenceTouchOf. null otherwise.
   */
  private referenceTouch(toolName: string, input: Record<string, unknown>): { folder: string | null; how?: 'names' | 'runs-in'; forced: boolean } | null {
    const shell = SHELL_TOOLS.has(toolName)
    if (!shell && toolName !== 'Read' && toolName !== 'Glob' && toolName !== 'Grep') return null
    const refs = this.referenceList()
    if (refs === undefined) return null
    if (refs === 'unreadable') return shell ? { folder: null, forced: true } : null
    if (!refs.length) return null
    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : this.ctx.project.path
    const opts = { shell: toolName === 'PowerShell' ? ('powershell' as const) : ('bash' as const) }
    if (shell) {
      if (typeof input.command !== 'string') return null
      const touch = commandReferenceTouch(input.command, cwd, refs, opts)
      return touch ? { ...touch, forced: true } : null
    }
    const folder = referenceTouchOf(toolName, input, refs, cwd, opts)
    return folder ? { folder, forced: false } : null
  }

  /**
   * An edit the CLI would auto-accept: the file is inside the project, an allowed directory or a session directory,
   * and the session runs in acceptEdits (project mode, not on a trust-restricted run, or a session grant). The
   * project's 'auto' mode deliberately does not count (see the header comment).
   */
  private editPreApproved(toolName: string, input: unknown, restricted: boolean): boolean {
    if (!EDIT_TOOLS.has(toolName)) return false
    const acceptEdits = !restricted && (this.sessionAcceptEdits || this.ctx.project.permissionMode === 'acceptEdits')
    if (!acceptEdits) return false
    const target = editTargetOf(input)
    if (!target) return false
    const opts = matchOptionsFor(this.ctx)
    return isFreeCdTarget(target, { ...opts, freeDirs: [...(opts.freeDirs ?? []), ...this.sessionDirs] })
  }

  /** The first role `parent` may spawn, else the first non-root role, else `fallback` (default: the root's slug). */
  private firstSpawnableSlug(parent: Role | undefined, fallback?: string): string {
    const allowed = parent ? this.ctx.roles.filter((r) => parent.spawnable.includes(r.id)) : []
    return allowed[0]?.slug ?? fallback ?? this.ctx.roles.find((r) => r.reportsTo !== null)?.slug ?? this.root.slug
  }

  private async spawnStep(step: Extract<MockStep, { type: 'spawn' }>): Promise<void> {
    const parentId = step.parent ?? ROOT_AGENT_ID
    const parent = this.ensureAgent(parentId)
    const slug = step.role ?? this.firstSpawnableSlug(this.rolesBySlug.get(parent.roleSlug))
    const { handle } = spawnHandle(this.handles, slug, step.name)
    const input = { subagent_type: slug, description: step.description, prompt: step.description, name: handle }
    const toolUseId = newId('tu')
    this.transcript(parentId, { kind: 'tool_use', id: toolUseId, name: SPAWN_TOOL, input })
    countUsage(parent, 'toolCalls')
    this.setState(parentId, 'delegating', describeTool(SPAWN_TOOL, input))
    this.spawnToolUse.set(step.id, toolUseId)
    const role = this.rolesBySlug.get(slug)
    const agentParent = resolveParent(this.agents, step.id, parentId, ROOT_AGENT_ID)
    this.upsert({
      ...this.ensureAgent(step.id, { roleSlug: slug, parentId: agentParent }),
      roleId: role?.id ?? null,
      roleSlug: slug,
      name: role?.name ?? slug,
      parentId: agentParent,
      spawnToolUseId: toolUseId,
      handle,
      state: 'thinking',
      activity: step.description.slice(0, 90) || 'Reading the brief…'
    })
    this.transcript(step.id, { kind: 'user', text: step.description })
    if (role) await this.skillStep(step.id, role)
  }

  /** Skill ids already loaded by an agent (once per agent). */
  private skillLoaded = new Set<string>()

  /**
   * Skills: an agent whose role has a granted run skill loads the first one through the bound load_skill tool (which
   * emits skill.used). With [mock:skill] and no grant the root calls list_skills instead. Work runs only.
   */
  private async skillStep(agentId: string, role: Role): Promise<void> {
    if (this.isSetup || this.skillLoaded.has(agentId)) return
    const granted = (this.ctx.skills?.() ?? []).filter((s) => s.roleIds.includes(role.id))
    let name: string
    let args: Record<string, unknown>
    if (granted.length) {
      name = SKILL_HARNESS_TOOLS.load
      args = { name: granted[0]!.name }
    } else if (agentId === ROOT_AGENT_ID && this.ctx.prompt.includes(SKILL_TOKEN)) {
      name = SKILL_HARNESS_TOOLS.list
      args = {}
    } else return
    this.skillLoaded.add(agentId)
    const t = this.tools.find((x) => x.name === name)
    if (!t) return
    const id = newId('tu')
    this.transcript(agentId, { kind: 'tool_use', id, name, input: args })
    countUsage(this.ensureAgent(agentId), 'toolCalls')
    let text: string
    let isError = false
    try {
      const res = await this.untilStopped(t.call(args, { agentId, roleId: role.id }))
      if (res === STOPPED) return
      text = res
    } catch (e) {
      text = (e as Error).message
      isError = true
    }
    this.transcript(agentId, { kind: 'tool_result', toolUseId: id, content: text, isError })
  }

  private async harnessStep(step: Extract<MockStep, { type: 'harness' }>): Promise<void> {
    const t = this.tools.find((x) => x.name === step.name)
    if (!t) {
      this.log('warn', `Mock script calls unknown harness tool ${step.name} for a ${this.ctx.run.kind} run`)
      return
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = newId('tu')
      this.transcript(ROOT_AGENT_ID, { kind: 'tool_use', id, name: step.name, input: step.args ?? {} })
      countUsage(this.ensureAgent(ROOT_AGENT_ID), 'toolCalls')
      this.setState(ROOT_AGENT_ID, isBlockingHarnessTool(step.name) ? 'waiting' : 'tool', harnessToolActivity(step.name))
      let text: string
      let isError = false
      try {
        const res = await this.untilStopped(t.call(step.args ?? {}, { agentId: ROOT_AGENT_ID, roleId: this.root.id }))
        if (res === STOPPED) return
        text = res
      } catch (e) {
        text = (e as Error).message
        isError = true
      }
      this.transcript(ROOT_AGENT_ID, { kind: 'tool_result', toolUseId: id, content: text, isError })
      const a = this.agents.get(ROOT_AGENT_ID)
      if (a && (a.state === 'waiting' || a.state === 'tool')) this.setState(ROOT_AGENT_ID, 'thinking', stepActivity(this.ctx.getPlan()) ?? 'Thinking…')
      if (isError || !text.startsWith('REVISE') || step.retryOnRevise === false || this.stopped || this.interrupted) return
      this.transcript(ROOT_AGENT_ID, { kind: 'text', text: 'Revising the proposal with your feedback.' })
    }
  }
}

export interface MockAdapterOptions {
  /** Use this script instead of ORGAI_MOCK_SCRIPT or the default. Missing fields come from the default. */
  script?: MockScript
}

/** What a 'project' scope may persist besides rules: the ctx hooks bound to ctx, each undefined when absent. */
function allowScopePersist(ctx: RuntimeContext): AllowScopePersist {
  return {
    ...(ctx.allowDirectories ? { allowDirectories: (dirs: string[]) => ctx.allowDirectories!(dirs) } : {}),
    ...(ctx.acceptEditsForProject ? { acceptEditsForProject: () => ctx.acceptEditsForProject!() } : {}),
    ...(ctx.saveProjectRules ? { saveProjectRules: (rules: string[]) => ctx.saveProjectRules!(rules) } : {})
  }
}

const MOCK_CONFIG_WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export class MockAdapter implements RuntimeAdapter {
  readonly id = 'mock' as const
  /** Every session this adapter started, oldest first. For tests. */
  readonly sessions: MockSession[] = []

  constructor(private options: MockAdapterOptions = {}) {}

  async start(ctx: RuntimeContext): Promise<RuntimeSession> {
    // Read the script per run so edits to the JSON file apply without a restart.
    const loaded = this.options.script ? { script: { ...DEFAULT_MOCK_SCRIPT, ...this.options.script } } : loadMockScript()
    const session = new MockSession(ctx, loaded.script, 'error' in loaded ? loaded.error : undefined)
    this.sessions.push(session)
    return session
  }

  private usage(input: CompletionInput): void {
    input.onUsage?.({ tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, model: input.model ?? 'mock' })
  }

  /** A fixed model list: the four builtin aliases plus one id outside any known family, so discovering a new family is testable. */
  async listModels(): Promise<AdapterModelInfo[] | null> {
    return [
      { id: 'fable', label: 'Fable', description: 'Most capable model for the hardest work' },
      { id: 'opus', label: 'Opus', description: 'Deep reasoning for complex tasks' },
      { id: 'sonnet', label: 'Sonnet', description: 'Balanced model for everyday work' },
      { id: 'haiku', label: 'Haiku', description: 'Fast model for simple tasks' },
      { id: 'mock-lyric', label: 'Lyric', description: 'Fastest model for quick lookups' }
    ]
  }

  /** A fixed org chart draft, in the JSON shape the drafter expects. */
  async complete(input: CompletionInput): Promise<string> {
    if (input.signal?.aborted) throw new Error('Completion cancelled')
    if (input.prompt.includes(AUTH_FAIL_TOKEN)) throw new Error(authFailureMessage(input.connection?.connection))
    if (input.kind === 'title') {
      if (input.prompt.includes('[mock:title-fail]')) throw new Error('Mock title failure')
      if (input.prompt.includes('[mock:title-slow]')) await abortableDelay(50, input.signal)
      const m = /<message>\s*([\s\S]*?)\s*<\/message>/.exec(input.prompt)
      const words = (m ? m[1]! : input.prompt)
        .split(/\s+/)
        .map((w) => w.replace(/[^\p{L}\p{N}'-]/gu, ''))
        .filter(Boolean)
        .slice(0, 4)
      const title = words.join(' ')
      this.usage(input)
      return title.charAt(0).toUpperCase() + title.slice(1)
    }
    if (input.kind === 'recommend' && input.prompt.includes('[mock:recommend-fail]')) throw new Error('Mock recommend failure')
    this.usage(input)
    if (input.kind === 'recommend') return mockRecommend(input.prompt)
    if (input.kind === 'skills') {
      return JSON.stringify({
        suggestions: [
          {
            name: 'mock-suggested-skill',
            description: 'Use when the mock run repeats the same steps; a deterministic suggestion from the mock adapter.',
            body: '# Mock skill\n\nSteps the mock suggests.',
            rationale: 'Deterministic mock suggestion.',
            findingIds: []
          }
        ]
      })
    }
    const setupStep = DEFAULT_SETUP.find((s): s is Extract<MockStep, { type: 'harness' }> => s.type === 'harness' && s.name === 'propose_org_chart')
    const args = setupStep?.args ?? { rationale: '', roles: [] }
    return JSON.stringify({ rationale: args.rationale, roles: args.roles })
  }
}

function dataFields(rest: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of rest.split(' | ')) {
    const i = part.indexOf('=')
    if (i > 0 && !(part.slice(0, i).trim() in out)) out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}

/** Deterministic answer to the Team recommend prompt; parses its line-anchored data lines. */
function mockRecommend(prompt: string): string {
  const scope = /^scope (\S+)\s*$/m.exec(prompt)?.[1]
  const roles = [...prompt.matchAll(/^role (\S+) \|(.*)$/gm)].map((m) => ({ id: m[1]!, f: dataFields(m[2]!.replace(/^\s*/, '')) }))
  const candidates = [...prompt.matchAll(/^candidate (\S+) \|(.*)$/gm)].map((m) => ({ id: m[1]!, f: dataFields(m[2]!.replace(/^\s*/, '')) }))
  if (roles.length === 0) return JSON.stringify({ recommendations: [], gaps: [] })
  const target = scope ?? (roles.find((r) => r.f.root === 'no') ?? roles[0]!).id
  const picks: { id: string; reason: string }[] = []
  const add = (c: { id: string } | undefined, reason: string): void => {
    if (c && !picks.some((p) => p.id === c.id)) picks.push({ id: c.id, reason })
  }
  add(candidates.find((c) => c.f.kind === 'skill' && c.f.origin === 'repo'), 'Mock: this repo skill fits the role.')
  add(
    candidates.find((c) => c.f.kind === 'skill' && c.f.origin === 'local' && /code[- ]review/i.test(c.f.name ?? '')),
    'Mock: this code-review skill fits the role.'
  )
  add(candidates.find((c) => c.f.kind === 'mcp' && c.f.origin === 'local'),'Mock: this local MCP server fits the role.')
  add(candidates.find((c) => c.f.kind === 'mcp' && c.f.origin === 'registry'), 'Mock: this registry MCP server fits the role.')
  add(
    candidates.find((c) => c.f.kind === 'connector' && (c.f.name ?? '').toLowerCase().includes('github')) ?? candidates.find((c) => c.f.kind === 'connector'),
    'Mock: this connector fits the role.'
  )
  if (picks.length === 0) for (const c of candidates.slice(0, 3)) add(c, `Mock: this ${c.f.kind ?? 'capability'} fits the role.`)
  return JSON.stringify({
    recommendations: picks.map((p) => ({ candidateId: p.id, roleIds: [target], reason: p.reason, access: 'read' })),
    gaps: [{ roleId: target, need: 'No skill covers writing tests for this role (mock gap).' }]
  })
}

/** A timer that rejects with 'Completion cancelled' when the signal aborts first. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Completion cancelled'))
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('Completion cancelled'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
