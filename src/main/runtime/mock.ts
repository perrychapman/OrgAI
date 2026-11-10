import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { validModelId } from '../connections/codexAccount'
import { normalizeTranscriptContent, normalizeTranscriptMedia } from './transcriptMedia'
import { dirname, join } from 'node:path'
import type { AgentInstance, ConnectionId, Effort, ModelTier, ImageAttachment, McpServerSpec, PermissionSuggestion, PluginSpec, ProviderId, Role, RunEvent, RunPlan, TokenUsage, TranscriptBlock } from '@shared/types'
import { CHAT_HARNESS_TOOLS, ENGAGEMENT_CONTEXT_TOOL, HARNESS_PROJECT_ID, KNOWLEDGE_FACT_MAX_CHARS, KNOWLEDGE_RECALL_TOOL, KNOWLEDGE_TOOL, MCP_HARNESS_TOOLS, OUTPUT_TOOLS, SKILLS_PROJECT_ID, SKILL_ASSIST_HARNESS_TOOLS, SKILL_HARNESS_TOOLS, SPAWN_TOOL } from '@shared/types'
import { cleanRequiredReports, effortOptionsFor, mcpServersForRole, newId, projectKindOf, settingTier } from '@shared/defaults'
import { ROOT_AGENT_ID, isSetupLikeRun, type AdapterModelInfo, type BridgeSpawnResult, type CompletionInput, type ExecActivityReason, type PeerMessage, type RootTurnEnd, type RuntimeAdapter, type RuntimeContext, type RuntimeSession, type SessionSettlement } from './types'
import { datum, harnessToolsFor, isBlockingHarnessTool, type BackgroundReport, type ConfigChange, type ConfigChangeResult, type HarnessTool, type HarnessToolAudience, type HarnessToolHooks, type McpAttachResult } from './harnessTools'
import { agentInstalledServers, mcpCallDenial, withoutServerRules } from './mcpGrants'
import { SELF_CONTROL_PATHS_UNAVAILABLE_LOG, SELF_CONTROL_REFUSAL_TEXT, checkSelfControlDenial, readControlProtectedPaths, selfControlLogLine } from './selfControlGate'
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
import { ContinuationDriver, PLAN_TOOLS, agentSlots, rootRoleNames, stepActivity } from './continuation'
import { authFailureMessage, describeTool, harnessToolActivity } from './activity'
import { EDIT_TOOLS, allowRuleStrings, applyAllowScope, chooseSuggestions, editTargetOf, isOfferableDirectory, listRules, suggestionLabels, type AllowScopePersist } from './permissionRules'
import { isTrustRestrictedRun, isWorkspaceConfigPath } from '../quick/scratch'
import { quickEditCard, quickEditFree } from './quickEditCard'
import { composeFirstMessage, peerMessageText } from './prompts'
import { staffingProfileDep, withRootStaffingBrief } from '../store/staffingProfile'
import { firstMessageHiddenContext, spawnKnowledge, userMessageKnowledge, withSpawnKnowledge, withUserMessageKnowledge } from './knowledgeDelivery'
import { resolveParent } from './agentTree'
import { HandleNamer, mapSendMessage, messageTranscriptText, spawnHandle } from './network'
import { SHELL_TOOLS, isFreeCdTarget, matchOptionsFor, matchingRule, type MatchOptions } from './ruleMatch'
import { countUsage, setModelTokens, usageOf } from './runUsage'
import { cliProjectSettings, projectSettingsLoad } from './claude'
import { APP_REFERENCE_TOOL, OPEN_IN_APP_TOOL, PROPOSE_APP_SETTINGS_TOOL, PROPOSE_PROJECT_SETTINGS_TOOL } from '@shared/types'
import { bridgedRolesOf, bridgedSpawnDenial } from './claude'
import { BRIDGE_HARNESS_TOOLS } from '@shared/types'
import { buildRolePrompt } from './prompts'
import { obligationsFor } from './delegation'
import { StaffingBook } from './staffingBook'
import { recordStaffing } from './staffing'
import { buildContextPack, contextPackRefusal, contextPackResultLine, contextPackRoots, withContextPack, type ContextPack } from './contextPack'
import { waitingNote, waitingNoteExcluded } from './waitingNote'

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
 * [mock:folder-config] (folderConfigSteps): folder config trust. When ctx.folderConfigLoads() is not false the root
 * reads `<project>/.claude/settings.json` permissions.allow (same reader as the Claude adapter) and says "Folder config
 * loaded."; otherwise it says "Folder config ignored." and reads nothing. Then Bash `npm test` runs with no card when a
 * loaded rule covers it, else it asks through the normal permission card.
 * [mock:knowledge] (knowledgeSteps, engagement work runs): before the default script the root reads the graph's
 * vocabulary, records Acme Corp (organisation), Jane Doe (person), a decision and a risk with facts, links them,
 * saves the context note "Kickoff call summary", searches "Acme", reads Acme Corp back and retires its fact "Fiscal
 * year ends in March" (skipped when the fact cannot be read back), then says MOCK_KNOWLEDGE_DONE; without a knowledge
 * graph (a code project) it says MOCK_KNOWLEDGE_NONE instead and the default script follows either way.
 * [mock:knowledge-recall] (knowledgeRecallSteps, engagement work runs): the same seeding steps, then knowledge_recall
 * "Acme billing" twice (the second shows the dedupe path), says MOCK_KNOWLEDGE_RECALLED, and plays the default script
 * with the first report's brief naming Jane Doe so knowledgeContext fires with purpose 'spawn'; MOCK_KNOWLEDGE_NONE
 * without a knowledge graph.
 * [mock:outputs] (outputsSteps, work runs of a stored project): the root says MOCK_OUTPUTS_START, calls produce_output
 * for a docx "Project plan" (Markdown with bold, italic, bullets, a table, a numbered list, a rule and fenced code), an
 * xlsx "Budget" (two sheets; the cell '=SUM(B2:B4)' is passed through for main to store as text), a mermaid
 * "Architecture diagram" and a markdown "Summary", writes a real 1x1 PNG to `<project>/outputs/logo.png` itself and
 * register_output's it as "Logo", then register_output's '../outside.txt' (main refuses it; the script goes on), says
 * MOCK_OUTPUTS_DONE and plays the default script. Without ctx.outputs it says MOCK_OUTPUTS_NONE instead.
 * [mock:outputs-all] (outputsSteps(true)): the same, then a 5-slide pptx "Project deck", report.csv, config.json,
 * logo.svg and the mermaid "Large system map" (80 nodes), "Sequence" and "Broken diagram" (outputsMoreSteps), then
 * MOCK_OUTPUTS_ALL_DONE. [mock:outputs-v2] (outputsV2Steps): a later run writes the docx, xlsx, deck, architecture
 * diagram and report.csv again under the same file names with one change each, so each becomes version 2.
 * Revise requests (OUTPUTS_REVISE_TOKEN, no prompt marker needed): a user message, or a started / continued run's
 * prompt, carrying OrgAI's "The user wrote (request rev_...):" line makes the root read_output the named output and
 * produce_output it again at the same file name with a visible change (reviseOutputStep). Peer messages never do.
 *
 *
 * Chat (quick) markers (quick runs, default script): [mock:chat-edit] (chatEditSteps): list_projects, then an Edit of
 * `<folder>/notes.md` that asks through ctx.requestPermission (the card carries the quick session edit suggestion);
 * allowed, the file is really written (MOCK_CHAT_NOTES) and the assistant says "I wrote notes.md.", then Bash `npm test`
 * asks (allowed: "npm test passed.", nothing runs; denied: "I did not run npm test."); a denied edit says "I did not
 * change anything." and the turn ends (no Bash). After a session allow of a covered edit, RunManager's
 * ctx.quickSessionEdits() makes later covered edits free (quickEditFree), like the Claude and Codex adapters.
 * [mock:chat-mcp] (CHAT_MCP_STEPS): request_mcp_install for the [mock:mcp-midrun] server through the real harness tool,
 * then "The server was added for this chat." or "You declined the server."; the mock attaches 'now'.
 * [mock:self-config] (selfConfigSteps) and [mock:self-config-project] (selfConfigProjectSteps): the self-configuration
 * tools through the real harness tools (app_reference, open_in_app, propose_app_settings; list_projects then
 * propose_project_settings for the first project), answered by the result's first word (harnessAnswer / firstProject).
 *
 * Every user message and spawn brief goes through ctx.knowledgeContext like the other adapters (knowledgeDelivery.ts);
 * the mock has no model, so what a model would receive is kept in `deliveredMessages` and scripted replies echo only
 * what the user typed.
 *
 * Headless exec markers (work runs, default script; cli-spec Wave 3, relied on by e2e/cli-exec.mjs and RunManager tests):
 * [mock:exec-plan] (execPlanSteps): set_plan with 2 steps, both updated done, complete_plan, a closing text; the exec
 * outcome is 'completed'. [mock:exec-blocked] (execBlockedSteps): set_plan, then mark_blocked with a reason; outcome
 * 'blocked'. [mock:exec-question] (execQuestionSteps): ask_user with the options "(Recommended) Keep the default" and
 * "Change it", then a text that echoes the answer ("You chose: <answer>"). [mock:turn-fail] (turnFailSteps): one text,
 * then the root turn ends failed (RootTurnEnd errorSubtype 'error_during_execution', root state 'error', run.status
 * 'idle'; the session stays open). [mock:rate-limit] (rateLimitSteps): one text, then the rateLimit step with
 * untilInMs 1500 and the session ends (RunManager pauses the run). [mock:exec-slow] (execSlowSteps): about 30 text
 * steps one second apart, cut short by interrupt and stop. Every root turn end calls ctx.onRootTurnEnded before
 * run.status 'idle' (the auth-fail marker reports ok false with isAuthError, before its 'error' status).
 * Required-delegation markers (work runs, default script; chart root -> manager -> two required workers): [mock:delegation-ok]
 * (delegationSteps: the manager spawns both workers, both report, then it reports), [mock:delegation-fix] (the manager
 * tries to finish without them, is corrected by the harness gate, then spawns them and finishes), [mock:delegation-skip]
 * (never complies: the second finish is accepted as failed and its report carries the failure line) and
 * [mock:delegation-claim] (like skip, and the manager's report claims both workers ran). Each ends with the plan steps
 * when [mock:exec-plan] is also in the prompt. The mock calls ctx.delegation at each spawn, completion and delivery
 * and prefixes receiptText to the report its parent receives; it is the reference for the real adapters.
 * Run staffing marker (work runs, default script): [mock:staffing] (staffingSteps): the root sets a two-step plan whose steps
 * carry `staff`, spawns the first two roles it may spawn (one per step, the second step asking for a tier above the
 * role's ceiling when the chart has one) and both report back, so RunRecord.staffing can be asserted without a model.
 * Every scripted spawn goes through a StaffingBook (the `spawn` step may carry `tier` and `effort` as the on-call values),
 * a report's model is the resolved one (MockSession.staffedFor) and each spawn appends a row through recordStaffing.
 * Model switching markers (all run kinds): [mock:model-switch] yields one root text then idle, without cards;
 * replies echo the active root model. [mock:model-switch-limit] ends the first session at a usage limit with
 * a reset 24 hours away (set autoResume off in the test); [mock:model-switch-error] ends it with a provider error.
 * Both recovery markers yield the simple idle script when resumed, so recovery never repeats the failure.
 * [mock:media]: text/image/text tool result, unsupported audio, then a standalone assistant PNG; no files or network.
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
  | { type: 'transcript'; block: TranscriptBlock }
  /**
   * Assistant text from an agent (default: the root). It streams as one agent.partial with the first half of `text`,
   * then the transcript entry, then an agent.partial '' clear. With `partials` (cli-spec Wave 4, e2e/cli-tui.mjs splits
   * an escape sequence across two chunks), each string is emitted in order as a cumulative agent.partial instead of the
   * half-text one, with the script's `delayMs` between them; an interrupt or stop during those waits cuts them short:
   * the remaining partials are skipped, the '' clear is still emitted and no transcript entry is written.
   */
  | { type: 'text'; agent?: string; text: string; partials?: string[] }
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
      /** After the call ran (allowed or pre-approved): write this text to `input.file_path` for real (Edit / Write steps). */
      writeContent?: string
      /** After the call ran: the root says this. */
      onAllow?: string
      /** After a deny: the root says this and the turn ends (the rest of the steps are skipped). */
      onDeny?: string
    }
  /** Spawn a report. `role` is a slug; default: the first role the parent may spawn. */
  | { type: 'spawn'; id: string; role?: string; description: string; parent?: string; /** Run staffing: the tier and effort stated on the spawn call itself. */ tier?: ModelTier; effort?: Effort; /** Handle; default <role>-<n>. */ name?: string; /** The brief it receives; default `description`. */ brief?: string; /** Context pack (contextPack.ts): paths the lead read, inlined into the report's first message. */ files?: string[] }
  /** An agent messages another by handle or role slug (SendMessage). `from` defaults to the root. */
  | { type: 'message'; from?: string; to: string; text: string }
  /** A report finishes and reports back to its parent. */
  | { type: 'finish'; id: string; result: string; /** Steps run when the delegation gate corrects the agent (the agent complies), before it tries to finish again. */ comply?: MockStep[] }
  /** Call one of the harness's own tools by bare name (propose_architecture, ask_user, complete_setup, ...). */
  | {
      type: 'harness'
      name: string
      args?: Record<string, unknown>
      /** Re-run the call when the user asks for changes. Default true. */
      retryOnRevise?: boolean
      /** After the call, the root says this text with "{result}" replaced by the tool's answer. */
      echo?: string
      /** After the call, the root says `then` when the answer contains `contains`, else `else`. */
      echoIf?: { contains: string; then: string; else: string }
      /** After the call, the root says the answer's first non-empty line, or this text when it has none. */
      echoFirstLine?: string
    }
  /**
   * engagement_knowledge from the root: `get` the entity `node` (a name), find the id of its live fact whose text is
   * `fact` in the fenced result (knowledgeFactId) and `retire` it with `reason`. When the entity or the fact cannot be
   * read back, the retire is skipped with a log line; the run never fails on it.
   */
  | { type: 'retireFact'; node: string; fact: string; reason?: string }
  /**
   * Answer an output revision request (spec outputs-2 16.7, OUTPUTS_REVISE_TOKEN): parse `message` (parseReviseRequest),
   * read_output 'read' the named output, then produce_output at the same file name with a visible change, and say
   * whether the result answered the request. Anything that does not parse is said and nothing is written.
   */
  | { type: 'reviseOutput'; message: string }
  /**
   * The root writes a file itself (no tool card, no transcript row; like an agent's own Write): `base64` decoded to
   * `<project folder>/<path>`, parent folders created. A failure is logged at warn and the script goes on.
   */
  | { type: 'writeFile'; path: string; base64: string }
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
  /** Wait `ms` more before the next step (cut short by interrupt and stop). */
  | { type: 'wait'; ms: number }
  /**
   * The root turn ends failed here (like a Claude result with subtype `subtype`, default 'error_during_execution'):
   * the rest of the turn is skipped, the root goes to 'error' and run.status 'idle' follows; the session stays open.
   */
  | { type: 'fail'; subtype?: string }
  | MockHarnessAnswerStep
  | MockFirstProjectStep

/**
 * A harness tool call from the root, never retried on REVISE; then the root says the `text` of the first answer whose
 * `prefix` starts the tool's result, else `otherwise` (also when the tool is not bound for the run or the session
 * stopped mid-call). Used by the self-configuration markers (selfConfigSteps).
 */
export interface MockHarnessAnswerStep {
  type: 'harnessAnswer'
  name: string
  args?: Record<string, unknown>
  answers: { prefix: string; text: string }[]
  otherwise: string
}

/**
 * list_projects from the root, then `then` with `projectId` set to the first project's id in the result
 * (firstProjectId); without one the root says `none` and the step ends.
 */
export interface MockFirstProjectStep {
  type: 'firstProject'
  then: MockHarnessAnswerStep
  none: string
}

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

/** Trigger token (Chat / quick runs, default script): an edit and a command that ask (chatEditSteps). */
export const CHAT_EDIT_TOKEN = '[mock:chat-edit]'
/** Trigger token (Chat / quick runs, default script): request_mcp_install for the mock-midrun server (CHAT_MCP_STEPS). */
export const CHAT_MCP_TOKEN = '[mock:chat-mcp]'
/** The text [mock:chat-edit] writes into `<folder>/notes.md` once the edit is allowed. */
export const MOCK_CHAT_NOTES = '# Notes\n\nWritten by the mock Chat assistant.\n'
export const MOCK_CHAT_EDIT_DONE = 'I wrote notes.md.'
export const MOCK_CHAT_EDIT_DENIED = 'I did not change anything.'
export const MOCK_CHAT_TEST_DONE = 'npm test passed.'
export const MOCK_CHAT_TEST_DENIED = 'I did not run npm test.'
export const MOCK_CHAT_MCP_ADDED = 'The server was added for this chat.'
export const MOCK_CHAT_MCP_DECLINED = 'You declined the server.'

/**
 * The [mock:chat-edit] turn in a Chat folder: list_projects, then an Edit of `<folder>/notes.md` that asks like a real
 * call (a covered edit's card offers the quick session edit grant). Allowed: the file is written for real and the
 * assistant says MOCK_CHAT_EDIT_DONE, then Bash `npm test` asks (allowed: MOCK_CHAT_TEST_DONE, nothing really runs;
 * denied: MOCK_CHAT_TEST_DENIED). Denied: MOCK_CHAT_EDIT_DENIED and the turn ends there.
 */
export function chatEditSteps(folder: string): MockStep[] {
  return [
    { type: 'harness', name: CHAT_HARNESS_TOOLS[0], args: {} },
    {
      type: 'tool',
      name: 'Edit',
      input: { file_path: join(folder, 'notes.md'), old_string: '', new_string: MOCK_CHAT_NOTES },
      ask: true,
      writeContent: MOCK_CHAT_NOTES,
      onAllow: MOCK_CHAT_EDIT_DONE,
      onDeny: MOCK_CHAT_EDIT_DENIED
    },
    { type: 'tool', name: 'Bash', input: { command: 'npm test' }, ask: true, result: 'Tests passed.', onAllow: MOCK_CHAT_TEST_DONE, onDeny: MOCK_CHAT_TEST_DENIED }
  ]
}

/** The [mock:chat-mcp] turn: request_mcp_install (the [mock:mcp-midrun] server) through the real harness tool, then the answer. */
const CHAT_MCP_STEPS: MockStep[] = [
  {
    type: 'harness',
    name: MCP_HARNESS_TOOLS.requestInstall,
    retryOnRevise: false,
    args: {
      reason: 'Mock: this chat needs a server it does not have.',
      manual: { name: MOCK_MIDRUN_SERVER, transport: 'stdio', command: 'npx', args: ['-y', 'mock-midrun-server@1.0.0'] }
    },
    echoIf: { contains: 'The user approved', then: MOCK_CHAT_MCP_ADDED, else: MOCK_CHAT_MCP_DECLINED }
  }
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

/** Trigger token (work runs, default script): the folder's own settings.json decides whether `npm test` asks (folderConfigSteps). */
export const FOLDER_CONFIG_TOKEN = '[mock:folder-config]'
export const MOCK_FOLDER_CONFIG_LOADED = 'Folder config loaded.'
export const MOCK_FOLDER_CONFIG_IGNORED = 'Folder config ignored.'

/**
 * The [mock:folder-config] turn: says whether the folder's config loaded, then runs Bash `npm test`. `covered` (a loaded
 * rule matches the command) leaves out the card; otherwise the step asks. Pure.
 */
export function folderConfigSteps(loaded: boolean, covered: boolean): MockStep[] {
  return [
    { type: 'text', text: loaded ? MOCK_FOLDER_CONFIG_LOADED : MOCK_FOLDER_CONFIG_IGNORED },
    { type: 'tool', name: 'Bash', input: { command: 'npm test' }, ...(covered ? {} : { ask: true }), result: 'Tests passed.' },
    { type: 'text', text: 'Mock: the folder-config script is done.' }
  ]
}

/** Trigger token (work runs, default script): the root changes its own project's MCP servers and skills mid-run. */
/** Trigger token (work runs, default script): a three-level agent tree whose reports all finish (deepTreeSteps). */
export const DEEP_TREE_TOKEN = '[mock:deep-tree]'

/** Trigger token (work runs, default script): a plan whose steps carry `staff`, then one scripted spawn per step. */
export const STAFFING_TOKEN = '[mock:staffing]'
/** The agent ids the [mock:staffing] script spawns. */
export const MOCK_STAFFING_REPORTS = ['mock-staffed-1', 'mock-staffed-2'] as const

/**
 * The [mock:staffing] turn: set_plan with two steps that carry `staff` (the first asks `first` for a fast / low pick, the
 * second asks `second` for top / max, which the chart's ceiling clamps), then one spawn per step; each step is marked done when its report
 * finishes and the plan is completed.
 */
export function staffingSteps(firstSlug: string, secondSlug: string): MockStep[] {
  const [a, b] = MOCK_STAFFING_REPORTS
  return [
    { type: 'text', text: 'Planning the work: two steps, each staffed on purpose.' },
    {
      type: 'plan',
      goal: 'Staff two steps',
      steps: [
        { title: 'Do the routine part', staff: { role: firstSlug, tier: 'fast', effort: 'low' } },
        { title: 'Do the hard part', staff: { role: secondSlug, tier: 'top', effort: 'max' } }
      ] as never
    },
    { type: 'spawn', id: a, name: a, role: firstSlug, description: 'Do the routine part' },
    { type: 'spawn', id: b, name: b, role: secondSlug, description: 'Do the hard part' },
    { type: 'finish', id: a, result: 'Routine part done.' },
    { type: 'planUpdate', steps: [{ id: 'p1', status: 'done' }] },
    { type: 'finish', id: b, result: 'Hard part done.' },
    { type: 'planUpdate', steps: [{ id: 'p2', status: 'done' }] },
    // Completed, so the run ends here instead of being nudged to finish the plan until the continue limit.
    { type: 'planComplete', summary: 'Both steps are done.' },
    { type: 'text', text: 'Both steps are done.' }
  ]
}

/** Required-delegation markers (work runs, default script). See the file header. */
export const DELEGATION_OK_TOKEN = '[mock:delegation-ok]'
export const DELEGATION_FIX_TOKEN = '[mock:delegation-fix]'
export const DELEGATION_SKIP_TOKEN = '[mock:delegation-skip]'
export const DELEGATION_CLAIM_TOKEN = '[mock:delegation-claim]'
/** The manager tries to finish while its workers still run; the finish stays pending and completes once both report. */
export const DELEGATION_EARLY_TOKEN = '[mock:delegation-early]'
/** The agent ids the delegation scripts spawn. */
export const MOCK_DELEGATION_MANAGER = 'mock-manager'
export const MOCK_DELEGATION_WORKERS = ['mock-worker-1', 'mock-worker-2'] as const
export const MOCK_DELEGATION_CLAIM = 'I spawned both workers and obtained both reports before synthesizing.'

/**
 * The required-delegation turn: the root spawns the manager (`managerSlug`); `variant` decides how it treats its required
 * workers (`workerSlugs`, spawned under it). 'fix' complies after the harness correction, 'skip' and 'claim' never do.
 */
export function delegationSteps(variant: 'ok' | 'early' | 'fix' | 'skip' | 'claim', managerSlug: string, workerSlugs: readonly string[]): MockStep[] {
  const m = MOCK_DELEGATION_MANAGER
  const workers = workerSlugs.map((slug, i) => ({ slug, id: MOCK_DELEGATION_WORKERS[i] ?? `mock-worker-${i + 1}` }))
  const spawnAll = (): MockStep[] => workers.map((w) => ({ type: 'spawn', id: w.id, name: w.id, parent: m, role: w.slug, description: `Do the ${w.slug} part` }) as MockStep)
  const finishAll = (): MockStep[] => workers.map((w) => ({ type: 'finish', id: w.id, result: `${w.slug} part done.` }) as MockStep)
  const head: MockStep[] = [
    { type: 'text', text: 'Planning the work: one manager owns it.' },
    { type: 'spawn', id: m, name: m, role: managerSlug, description: 'Manage the work' }
  ]
  if (variant === 'early') {
    return [...head, ...spawnAll(), { type: 'finish', id: m, result: 'Both parts are done and combined.' }, ...finishAll(), { type: 'text', text: 'The manager finished.' }]
  }
  if (variant === 'ok') {
    return [...head, ...spawnAll(), ...finishAll(), { type: 'finish', id: m, result: 'Both parts are done and combined.' }, { type: 'text', text: 'The manager finished.' }]
  }
  const claim = variant === 'claim'
  return [
    ...head,
    { type: 'text', agent: m, text: claim ? MOCK_DELEGATION_CLAIM : 'Wrapping up.' },
    {
      type: 'finish',
      id: m,
      result: claim ? MOCK_DELEGATION_CLAIM : 'Done.',
      ...(variant === 'fix' ? { comply: [...spawnAll(), ...finishAll()] } : {})
    },
    { type: 'text', text: 'The manager finished.' }
  ]
}

/** Headless exec markers (work runs, default script). See the file header. */
export const EXEC_PLAN_TOKEN = '[mock:exec-plan]'
export const EXEC_BLOCKED_TOKEN = '[mock:exec-blocked]'
export const EXEC_QUESTION_TOKEN = '[mock:exec-question]'
export const TURN_FAIL_TOKEN = '[mock:turn-fail]'
export const RATE_LIMIT_TOKEN = '[mock:rate-limit]'
export const MODEL_SWITCH_TOKEN = '[mock:model-switch]'
export const MEDIA_TOKEN = '[mock:media]'
/** Fixed 1x1 PNG, also used by the Outputs fixture. Returned bytes only; no path reads. */
export const MOCK_MEDIA_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
export function mediaSteps(): MockStep[] {
  const image = { type: 'image', mimeType: 'image/png', data: MOCK_MEDIA_PNG }
  return [
    { type: 'transcript', block: { kind: 'tool_use', id: 'mock-media-result', name: 'mcp__fixture__media', input: {} } },
    { type: 'transcript', block: { kind: 'tool_result', toolUseId: 'mock-media-result', ...normalizeTranscriptContent([
      { type: 'text', text: 'Before the image.' }, image, { type: 'text', text: 'After the image.' },
      { type: 'audio', mimeType: 'audio/wav', data: 'AAAA' }
    ]), isError: false } },
    { type: 'transcript', block: { kind: 'tool_use', id: 'mock-media-image-only', name: 'mcp__fixture__image_only', input: {} } },
    { type: 'transcript', block: { kind: 'tool_result', toolUseId: 'mock-media-image-only', ...normalizeTranscriptContent([image]), isError: false } },
    { type: 'transcript', block: { kind: 'tool_use', id: 'mock-media-unavailable', name: 'mcp__fixture__unavailable', input: {} } },
    { type: 'transcript', block: { kind: 'tool_result', toolUseId: 'mock-media-unavailable', ...normalizeTranscriptContent([
      { type: 'text', text: 'Unavailable image sources.' },
      { type: 'image', source: { type: 'url', url: 'https://example.invalid/private.png' } },
      { type: 'image' }
    ]), isError: false } },
    { type: 'transcript', block: { kind: 'media', media: normalizeTranscriptMedia(image) } },
    { type: 'text', text: 'MOCK_MEDIA_DONE' }
  ]
}
export const MODEL_SWITCH_LIMIT_TOKEN = '[mock:model-switch-limit]'
export const MODEL_SWITCH_ERROR_TOKEN = '[mock:model-switch-error]'
export const EXEC_SLOW_TOKEN = '[mock:exec-slow]'
/** The [mock:exec-question] options, in order; the first is the recommended one. */
export const EXEC_QUESTION_OPTIONS = ['(Recommended) Keep the default', 'Change it'] as const
export const EXEC_BLOCKED_REASON = 'Mock: the work needs a decision only you can make.'
/** Steps in [mock:exec-slow] and the time between them (ms). */
export const EXEC_SLOW_STEPS = 30
export const EXEC_SLOW_STEP_MS = 1000

/** [mock:exec-plan]: a plan with two steps, both done, then complete_plan and a closing text. */
export function execPlanSteps(): MockStep[] {
  return [
    { type: 'text', text: 'Planning the work.' },
    { type: 'plan', goal: 'Mock exec: make the requested change', steps: ['Read the code', 'Make the change'] },
    { type: 'planUpdate', steps: [{ id: 'p1', status: 'done' }] },
    { type: 'planUpdate', steps: [{ id: 'p2', status: 'done', note: 'Changed src/example.ts' }] },
    { type: 'planComplete', summary: 'Both steps are done and verified.' },
    { type: 'text', text: 'All done: both plan steps are complete.' }
  ]
}

/** [mock:exec-blocked]: a plan, then mark_blocked with EXEC_BLOCKED_REASON. */
export function execBlockedSteps(): MockStep[] {
  return [
    { type: 'plan', goal: 'Mock exec: a change that needs a decision', steps: ['Decide the approach', 'Make the change'] },
    { type: 'harness', name: PLAN_TOOLS.blocked, args: { reason: EXEC_BLOCKED_REASON } },
    { type: 'text', text: 'I need a decision from you before I can go on.' }
  ]
}

/** [mock:exec-question]: ask_user with EXEC_QUESTION_OPTIONS, then a text echoing the answer. */
export function execQuestionSteps(): MockStep[] {
  return [
    {
      type: 'harness',
      name: 'ask_user',
      retryOnRevise: false,
      args: { question: 'Which setting should I use?', options: EXEC_QUESTION_OPTIONS.map((label) => ({ label })), allowFreeText: false },
      echo: 'You chose: {result}'
    }
  ]
}

/** [mock:turn-fail]: one text, then the root turn fails with error_during_execution. */
export function turnFailSteps(): MockStep[] {
  return [
    { type: 'text', text: 'Starting on the request.' },
    { type: 'fail', subtype: 'error_during_execution' }
  ]
}

/** [mock:rate-limit]: one text, then the plan's usage limit (reset in 1.5 s) and the session ends. */
export function rateLimitSteps(): MockStep[] {
  return [
    { type: 'text', text: 'Starting on the request.' },
    { type: 'rateLimit', untilInMs: 1500 }
  ]
}

/** [mock:exec-slow]: EXEC_SLOW_STEPS texts about EXEC_SLOW_STEP_MS apart (`delayMs` is the script's per-step pause). */
export function execSlowSteps(delayMs: number): MockStep[] {
  const extra = Math.max(0, EXEC_SLOW_STEP_MS - Math.max(0, delayMs))
  const out: MockStep[] = []
  for (let i = 1; i <= EXEC_SLOW_STEPS; i++) {
    if (extra) out.push({ type: 'wait', ms: extra })
    out.push({ type: 'text', text: `Working slowly: step ${i} of ${EXEC_SLOW_STEPS}.` })
  }
  return out
}
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

/** Trigger token (engagement work runs, default script): the root records what it learned in the knowledge graph (knowledgeSteps). */
export const KNOWLEDGE_TOKEN = '[mock:knowledge]'
/** What the [mock:knowledge] script records, by name, and the fact the root retires afterwards. */
export const MOCK_KNOWLEDGE = {
  client: 'Acme Corp',
  sponsor: 'Jane Doe',
  decision: 'Migrate billing to Stripe',
  risk: 'Legacy export format undocumented',
  noteTitle: 'Kickoff call summary',
  retiredFact: 'Fiscal year ends in March'
} as const
/** The root's sentence after the [mock:knowledge] steps. */
export const MOCK_KNOWLEDGE_DONE = 'I recorded what I learned about the engagement.'
/** The root's sentence when [mock:knowledge] is set but the run has no knowledge graph (not an engagement work run). */
export const MOCK_KNOWLEDGE_NONE = 'No knowledge graph is available in this run.'
/** Trigger token (engagement work runs, default script): the root seeds the graph, recalls from it twice, then spawns (knowledgeRecallSteps). */
export const KNOWLEDGE_RECALL_TOKEN = '[mock:knowledge-recall]'
export const MOCK_KNOWLEDGE_RECALL_QUERY = 'Acme billing'
/** The root's sentence after the two recalls. */
export const MOCK_KNOWLEDGE_RECALLED = 'I recalled what the team knows.'
/** The first report's brief on a [mock:knowledge-recall] run; it names a recorded person so knowledgeContext fires. */
export const MOCK_KNOWLEDGE_RECALL_BRIEF = 'Implement the requested change. Check the billing wording with Jane Doe.'

/**
 * The [mock:knowledge] steps, each a real harness tool call through the mock's tool path (RunManager counts the
 * writes and writes the harness transcript rows): vocabulary; Acme Corp (organisation) and Jane Doe (person) with
 * aliases, summaries and facts; Jane works-at Acme; the decision "Migrate billing to Stripe" decided-by Jane; the risk
 * "Legacy export format undocumented"; the context note "Kickoff call summary"; a search for "Acme"; then a `get` of
 * Acme Corp and the retire of its fact "Fiscal year ends in March" (retireFact). Nothing touches the disk directly.
 */
export function knowledgeSteps(): MockStep[] {
  const kg = (args: Record<string, unknown>): MockStep => ({ type: 'harness', name: KNOWLEDGE_TOOL, args })
  return [
    kg({ action: 'vocabulary' }),
    kg({
      action: 'upsert_node',
      kind: 'organisation',
      name: MOCK_KNOWLEDGE.client,
      aliases: ['Acme'],
      summary: 'The client. Mid-size manufacturer moving its billing off a legacy system.',
      facts: ['Headquartered in Leeds', MOCK_KNOWLEDGE.retiredFact]
    }),
    kg({
      action: 'upsert_node',
      kind: 'person',
      name: MOCK_KNOWLEDGE.sponsor,
      aliases: ['J. Doe'],
      summary: 'Chief Financial Officer at Acme Corp and the engagement sponsor.',
      facts: ['Role: CFO', 'Prefers written summaries before meetings']
    }),
    kg({ action: 'link', from: MOCK_KNOWLEDGE.sponsor, to: MOCK_KNOWLEDGE.client, relation: 'works-at' }),
    kg({ action: 'upsert_node', kind: 'decision', name: MOCK_KNOWLEDGE.decision, facts: ['Agreed at the kickoff call'] }),
    kg({ action: 'link', from: MOCK_KNOWLEDGE.decision, to: MOCK_KNOWLEDGE.sponsor, relation: 'decided-by', note: 'Sponsor sign-off' }),
    kg({ action: 'upsert_node', kind: 'risk', name: MOCK_KNOWLEDGE.risk, facts: ['No one at Acme owns the export spec'] }),
    {
      type: 'harness',
      name: ENGAGEMENT_CONTEXT_TOOL,
      args: {
        action: 'save',
        title: MOCK_KNOWLEDGE.noteTitle,
        text: 'Kickoff call with Jane Doe (CFO).\n\nAgreed to migrate billing to Stripe before the March year end. Open risk: the legacy export format is undocumented.'
      }
    },
    kg({ action: 'search', query: 'Acme' }),
    { type: 'retireFact', node: MOCK_KNOWLEDGE.client, fact: MOCK_KNOWLEDGE.retiredFact, reason: 'Corrected: fiscal year ends in April' },
    { type: 'text', text: MOCK_KNOWLEDGE_DONE }
  ]
}

/**
 * The [mock:knowledge-recall] steps after the seeding ones: knowledge_recall twice with one query through the real
 * harness tool (RunManager counts both, writes the rows and answers the repeat from its "already shown" state), the
 * done sentence, then the default script with the first report's brief naming Jane Doe.
 */
export function knowledgeRecallSteps(): MockStep[] {
  const recall: MockStep = { type: 'harness', name: KNOWLEDGE_RECALL_TOOL, args: { query: MOCK_KNOWLEDGE_RECALL_QUERY } }
  const firstSpawn = DEFAULT_WORK.findIndex((s) => s.type === 'spawn')
  return [
    ...knowledgeSteps(),
    recall,
    recall,
    { type: 'text', text: MOCK_KNOWLEDGE_RECALLED },
    ...DEFAULT_WORK.map((s, i) => (i === firstSpawn && s.type === 'spawn' ? { ...s, brief: MOCK_KNOWLEDGE_RECALL_BRIEF } : s))
  ]
}

/** Trigger token (work runs of a stored project, default script): the root produces and registers outputs first (outputsSteps). */
export const OUTPUTS_TOKEN = '[mock:outputs]'
/** The root's first sentence on a [mock:outputs] run. */
export const MOCK_OUTPUTS_START = 'I will produce the deliverables first.'
/** The root's sentence after the [mock:outputs] steps (4 produced + 1 registered; the refused register does not count). */
export const MOCK_OUTPUTS_DONE = 'I produced 5 outputs.'
/** The root's sentence when [mock:outputs] is set but the run has no outputs (ctx.outputs missing). */
export const MOCK_OUTPUTS_NONE = 'No outputs are available in this run.'
/** A real 1x1 PNG the [mock:outputs] root writes itself before register_output. */
export const MOCK_OUTPUT_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
/** Where that PNG lands, relative to the project folder (also the register_output path). */
export const MOCK_OUTPUT_PNG_PATH = 'outputs/logo.png'
/** The docx Markdown: heading, bold / italic, bullets, a GFM table, a numbered list, a rule and fenced code. */
export const MOCK_OUTPUT_DOCX_MARKDOWN = [
  '# Project plan',
  '',
  'This plan covers the **scope**, the *phases* and who owns each one.',
  '',
  '- Agree the scope with the sponsor',
  '- Build in two phases',
  '- Launch after the review',
  '',
  '| Phase | Owner | Weeks |',
  '| --- | --- | --- |',
  '| Design | Ana | 2 |',
  '| Build | Ben | 6 |',
  '| Launch | Cleo | 1 |',
  '',
  '1. Sign off the plan',
  '2. Start the design phase',
  '',
  '---',
  '',
  '```',
  'npm run build',
  '```'
].join('\n')
/** The xlsx workbook. The '=SUM' string is deliberate: main must store it as text, never a formula. */
export const MOCK_OUTPUT_WORKBOOK = {
  sheets: [
    {
      name: 'Budget',
      columns: [{ header: 'Item' }, { header: 'Cost', width: 14 }],
      rows: [['Design', 1200], ['Build', 3400], ['Launch', 800], ['=SUM(B2:B4)', 'see note']],
      numberFormat: [null, '#,##0.00']
    },
    { name: 'Notes', rows: [['Prepared by the mock team'], ['Costs are illustrative']] }
  ]
}
export const MOCK_OUTPUT_MERMAID = 'flowchart LR\n  A[Client] --> B[API]\n  B --> C[(Database)]\n  B --> D[Queue]'
export const MOCK_OUTPUT_SUMMARY = '# Summary\n\nThe plan, budget and diagram are in the outputs folder.\n\n- Project plan\n- Budget\n- Architecture diagram\n\n| Item | State |\n| --- | --- |\n| Plan | done |'

/**
 * The [mock:outputs] steps, each output call a real harness tool call through the mock's tool path (RunManager writes
 * the index, emits output.created and writes the harness rows): the start sentence; produce_output docx "Project plan"
 * (fileName project-plan), xlsx "Budget" (the tool's `workbook` field), mermaid "Architecture diagram", markdown
 * "Summary"; the root writes MOCK_OUTPUT_PNG_PATH itself (writeFile) and calls register_output "Logo" on it; then
 * register_output '../outside.txt' "Outside", which main refuses (the script goes on); then the done sentence.
 * With `all` ([mock:outputs-all]) the seven Outputs 2 outputs follow the refused register (outputsMoreSteps) and the
 * done sentence is MOCK_OUTPUTS_ALL_DONE.
 */
export function outputsSteps(all = false): MockStep[] {
  return [
    { type: 'text', text: MOCK_OUTPUTS_START },
    produceStep({ kind: 'docx', title: 'Project plan', fileName: 'project-plan', description: 'Scope, phases and owners', content: MOCK_OUTPUT_DOCX_MARKDOWN }),
    produceStep({ kind: 'xlsx', title: 'Budget', workbook: MOCK_OUTPUT_WORKBOOK }),
    produceStep({ kind: 'mermaid', title: 'Architecture diagram', content: MOCK_OUTPUT_MERMAID }),
    produceStep({ kind: 'markdown', title: 'Summary', content: MOCK_OUTPUT_SUMMARY }),
    { type: 'writeFile', path: MOCK_OUTPUT_PNG_PATH, base64: MOCK_OUTPUT_PNG_BASE64 },
    registerStep({ path: MOCK_OUTPUT_PNG_PATH, title: 'Logo', description: 'Written by the mock with its own tools' }),
    registerStep({ path: '../outside.txt', title: 'Outside' }),
    ...(all ? outputsMoreSteps() : []),
    { type: 'text', text: all ? MOCK_OUTPUTS_ALL_DONE : MOCK_OUTPUTS_DONE }
  ]
}

function produceStep(args: Record<string, unknown>): MockStep {
  return { type: 'harness', name: OUTPUT_TOOLS.produce, args, retryOnRevise: false }
}
function registerStep(args: Record<string, unknown>): MockStep {
  return { type: 'harness', name: OUTPUT_TOOLS.register, args, retryOnRevise: false }
}

// ---------- Outputs 2 (spec outputs-2 section 16.7) ----------

/** Trigger token (work runs of a stored project, default script): the five [mock:outputs] outputs plus the seven Outputs 2 ones. */
export const OUTPUTS_ALL_TOKEN = '[mock:outputs-all]'
/** Trigger token: a later run writes the [mock:outputs-all] file names again, so each becomes version 2 (outputsV2Steps). */
export const OUTPUTS_V2_TOKEN = '[mock:outputs-v2]'
/**
 * The revise behaviour's name in the docs. It needs no prompt marker: any user message (or a continued / started run's
 * prompt) on a default-script work run carrying OrgAI's revise marker line is answered (reviseOutputStep).
 */
export const OUTPUTS_REVISE_TOKEN = '[mock:outputs-revise]'
/** The root's sentence after the [mock:outputs-all] steps (4 + 7 produced, 1 registered). */
export const MOCK_OUTPUTS_ALL_DONE = 'I produced 12 outputs.'
export const MOCK_OUTPUTS_V2_START = 'I will update the deliverables.'
export const MOCK_OUTPUTS_V2_DONE = 'I updated 5 outputs.'
export const MOCK_REVISE_START = 'I will read the output, then revise it.'
export const MOCK_REVISE_UNPARSED = 'I could not tell which output that request is about, so I changed nothing.'
export const MOCK_REVISE_REGISTERED = 'That output is a file the team registered, and I can only revise produced outputs, so I changed nothing.'
export const MOCK_REVISE_UNREADABLE = 'I could not read that output, so I changed nothing.'
export const MOCK_REVISE_UNCHANGED = 'I could not change that output, so I left it as it was.'
export const MOCK_REVISE_NOT_ANSWERED = 'I wrote the output again, but OrgAI did not link it to the request.'
/** What the root says once produce_output answered the request. */
export function mockReviseDone(requestId: string): string {
  return `I revised the output for request ${requestId}.`
}

/** The 5-slide deck: title, bullets, two-content, the logo image, a table; speaker notes on slides 1 and 3. */
export const MOCK_OUTPUT_DECK = {
  size: '16:9',
  slides: [
    { layout: 'title', title: 'Project kickoff', subtitle: 'The mock team, November 2026', notes: 'Welcome everyone and introduce the team.' },
    { layout: 'content', title: 'Goals', bullets: [{ text: 'Ship the first phase' }, { text: 'Design review in week 2', level: 1 }, { text: 'Stay inside the budget' }] },
    {
      layout: 'two-content',
      title: 'Options',
      left: [{ type: 'bullets', bullets: [{ text: 'Build in house' }, { text: 'Full control', level: 1 }] }],
      right: [{ type: 'body', text: 'Buy a service\nFaster start' }],
      notes: 'Recommend building in house.'
    },
    { layout: 'image', title: 'Our logo', image: { path: 'outputs/logo.png', alt: 'The mock logo', caption: 'A one-pixel stand-in' } },
    { layout: 'content', title: 'Timeline', table: { header: true, rows: [['Phase', 'Weeks'], ['Design', '2'], ['Build', '6'], ['Launch', '1']] } }
  ]
}
/** report.csv: a header and 6 rows; the last row's cell '=SUM(C2:C6)' must stay text. */
export const MOCK_OUTPUT_CSV = 'Item,Owner,Cost\nDesign,Ana,1200\nBuild,Ben,3400\nLaunch,Cleo,800\nReview,Dan,300\nSupport,Eve,500\nTotal,,=SUM(C2:C6)\n'
export const MOCK_OUTPUT_JSON = JSON.stringify({ name: 'mock-project', version: 1, features: { outputs: true, versions: true }, owners: ['Ana', 'Ben'] }, null, 2) + '\n'
export const MOCK_OUTPUT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect x="4" y="4" width="56" height="56" rx="12" fill="#3b82f6"/><text x="32" y="40" font-size="20" text-anchor="middle" fill="#ffffff">M</text></svg>\n'
/** "Large system map": flowchart TD with 80 nodes (a tree, each node under node floor((i - 2) / 3) + 1). */
export const MOCK_OUTPUT_LARGE_MAP = [
  'flowchart TD',
  ...Array.from({ length: 80 }, (_, k) => `  N${k + 1}[Service ${k + 1}]`),
  ...Array.from({ length: 79 }, (_, k) => `  N${Math.floor(k / 3) + 1} --> N${k + 2}`)
].join('\n')
export const MOCK_OUTPUT_SEQUENCE = 'sequenceDiagram\n  participant C as Client\n  participant A as API\n  participant D as Database\n  C->>A: Request\n  A->>D: Query\n  D-->>A: Rows\n  A-->>C: Response'
/** "Broken diagram": line 2 is a syntax error. */
export const MOCK_OUTPUT_BROKEN = 'flowchart TD\n  A[Start] --> --> B[\n  B --> C[End]'

/** The seven Outputs 2 outputs ([mock:outputs-all], after the logo PNG exists for the deck's image slide). */
export function outputsMoreSteps(): MockStep[] {
  return [
    produceStep({ kind: 'pptx', title: 'Project deck', fileName: 'project-deck', description: 'Kickoff slides', deck: MOCK_OUTPUT_DECK }),
    produceStep({ kind: 'csv', title: 'Report', fileName: 'report', content: MOCK_OUTPUT_CSV }),
    produceStep({ kind: 'json', title: 'Config', fileName: 'config', content: MOCK_OUTPUT_JSON }),
    produceStep({ kind: 'svg', title: 'Logo drawing', fileName: 'logo', content: MOCK_OUTPUT_SVG }),
    produceStep({ kind: 'mermaid', title: 'Large system map', content: MOCK_OUTPUT_LARGE_MAP }),
    produceStep({ kind: 'mermaid', title: 'Sequence', content: MOCK_OUTPUT_SEQUENCE }),
    produceStep({ kind: 'mermaid', title: 'Broken diagram', content: MOCK_OUTPUT_BROKEN })
  ]
}

export const MOCK_OUTPUT_DOCX_MARKDOWN_V2 = MOCK_OUTPUT_DOCX_MARKDOWN.replace(
  'This plan covers the **scope**, the *phases* and who owns each one.',
  'This plan, revised after the review, covers the **scope**, the *phases* and who owns each one.'
)
/** Budget v2: two cells changed (Design 1200 -> 1500, Launch 800 -> 950). */
export const MOCK_OUTPUT_WORKBOOK_V2 = {
  sheets: MOCK_OUTPUT_WORKBOOK.sheets.map((s, i) =>
    i === 0 ? { ...s, rows: s.rows.map((r) => (r[0] === 'Design' ? ['Design', 1500] : r[0] === 'Launch' ? ['Launch', 950] : r)) } : s
  )
}
/** Deck v2: slide 3 changed and a sixth slide added. */
export const MOCK_OUTPUT_DECK_V2 = {
  ...MOCK_OUTPUT_DECK,
  slides: [
    ...MOCK_OUTPUT_DECK.slides.map((s, i) => (i === 2 ? { ...s, title: 'Options compared', right: [{ type: 'body', text: 'Buy a service\nFaster start, higher running cost' }] } : s)),
    { layout: 'section', title: 'Next steps' }
  ]
}
/** architecture.mmd v2: node D renamed. */
export const MOCK_OUTPUT_MERMAID_V2 = MOCK_OUTPUT_MERMAID.replace('D[Queue]', 'D[Event bus]')
/** report.csv v2: the Build row changed. */
export const MOCK_OUTPUT_CSV_V2 = MOCK_OUTPUT_CSV.replace('Build,Ben,3400', 'Build,Ben,3600')

/** [mock:outputs-v2]: the same file names as [mock:outputs-all], each with a change, so each becomes version 2. */
export function outputsV2Steps(): MockStep[] {
  return [
    { type: 'text', text: MOCK_OUTPUTS_V2_START },
    produceStep({ kind: 'docx', title: 'Project plan', fileName: 'project-plan', description: 'Scope, phases and owners', content: MOCK_OUTPUT_DOCX_MARKDOWN_V2 }),
    produceStep({ kind: 'xlsx', title: 'Budget', workbook: MOCK_OUTPUT_WORKBOOK_V2 }),
    produceStep({ kind: 'pptx', title: 'Project deck', fileName: 'project-deck', description: 'Kickoff slides', deck: MOCK_OUTPUT_DECK_V2 }),
    produceStep({ kind: 'mermaid', title: 'Architecture diagram', content: MOCK_OUTPUT_MERMAID_V2 }),
    produceStep({ kind: 'csv', title: 'Report', fileName: 'report', content: MOCK_OUTPUT_CSV_V2 }),
    { type: 'text', text: MOCK_OUTPUTS_V2_DONE }
  ]
}

/** OrgAI's revise marker line (outputs/revise.ts composeReviseMessage); only this line carries the user's words. */
const REVISE_MARKER_RE = /^The user wrote \(request (rev_[0-9a-f]{16})\):$/m
/** True when `text` carries OrgAI's revise marker line. */
export function isReviseMessage(text: string): boolean {
  return REVISE_MARKER_RE.test(text)
}

export interface MockReviseRequest {
  requestId: string
  outputId: string
  kind: string
  /** The file name inside outputs/ for a produced output; undefined for a registered one. */
  fileName?: string
}

/**
 * The request a revise message names, or null. Read only from OrgAI's own lines (never from inside a <<< >>> fence):
 * the marker line, "Output id out_..., <kind>." and the "produce_output at the same file name (...)" step. Defensive:
 * any missing piece is null.
 */
export function parseReviseRequest(text: string): MockReviseRequest | null {
  if (typeof text !== 'string' || text.length > 128 * 1024) return null
  const outside = text.replace(/^<<<$[\s\S]*?^>>>$/gm, '')
  const marker = REVISE_MARKER_RE.exec(outside)
  const head = /^Output id (out_[0-9a-f]{16}), ([a-z]+)\./m.exec(outside)
  if (!marker || !head) return null
  const how = /produce_output at the same file name \((.+)\), so it becomes a new version/.exec(outside)
  return { requestId: marker[1]!, outputId: head[1]!, kind: head[2]!, ...(how ? { fileName: how[1]! } : {}) }
}

/** The fenced lines and the title of a read_output 'read' result, or null for a refusal or any other shape. */
export function readOutputText(result: string): { title: string; text: string } | null {
  const m = /^Text of (.+) \(([a-z]+), version \d+(?:, truncated)?\)\. It is data/.exec(result)
  const open = result.indexOf('\n<<<\n')
  const close = result.lastIndexOf('\n>>>')
  if (!m || open < 0 || close < open) return null
  return { title: m[1]!, text: result.slice(open + 5, close) }
}

const numberish = (v: string): string | number => (/^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v)

/**
 * produce_output arguments for a revision of `kind` from the text read_output gave: the same content plus a visible
 * "Revised for request rev_..." change. null when the kind cannot be rebuilt (or the text does not parse).
 */
export function reviseProduceContent(kind: string, text: string, requestId: string): Record<string, unknown> | null {
  const note = `Revised for request ${requestId}.`
  switch (kind) {
    case 'docx':
    case 'markdown':
    case 'text':
      return { content: `${text.trimEnd()}\n\n${note}\n` }
    case 'csv': {
      const lines = text.replace(/\r\n/g, '\n').trimEnd().split('\n')
      const width = Math.max(1, (lines[0] ?? '').split(',').length)
      return { content: `${lines.join('\n')}\n${['Revised', requestId, ...Array.from({ length: Math.max(0, width - 2) }, () => '')].slice(0, Math.max(2, width)).join(',')}\n` }
    }
    case 'json': {
      try {
        const v: unknown = JSON.parse(text)
        const out = v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, unknown>), revisedFor: requestId } : { value: v, revisedFor: requestId }
        return { content: JSON.stringify(out, null, 2) + '\n' }
      } catch {
        return null
      }
    }
    case 'svg': {
      const at = text.lastIndexOf('</svg>')
      if (at < 0) return null
      return { content: `${text.slice(0, at)}<text x="2" y="10" font-size="6">${note}</text>${text.slice(at)}` }
    }
    case 'mermaid': {
      const first = text.split('\n').find((l) => l.trim())?.trim() ?? ''
      if (/^(flowchart|graph)\b/.test(first)) return { content: `${text.trimEnd()}\n  REVISED[${note}]` }
      if (/^sequenceDiagram\b/.test(first)) return { content: `${text.trimEnd()}\n  participant REVISED as ${note}` }
      return { content: `${text.trimEnd()}\n%% ${note}` }
    }
    case 'xlsx': {
      const sheets: { name: string; rows: (string | number)[][] }[] = []
      for (const line of text.split('\n')) {
        const h = /^## Sheet (.+)$/.exec(line)
        if (h) {
          sheets.push({ name: h[1]!.slice(0, 31), rows: [] })
          continue
        }
        if (!line.trim() || /^\(\d+ more rows not shown\)$/.test(line)) continue
        if (!sheets.length) sheets.push({ name: 'Sheet1', rows: [] })
        sheets.at(-1)!.rows.push(line.split('\t').map(numberish))
      }
      if (!sheets.length) return null
      sheets[0]!.rows.push(['Revised', requestId])
      return { workbook: { sheets } }
    }
    case 'pptx': {
      type Slide = { layout: 'content'; title: string; bullets?: { text: string; level: 0 | 1 | 2 }[]; body?: string; table?: { rows: string[][] }; notes?: string }
      const slides: Slide[] = []
      for (const line of text.split('\n')) {
        const h = /^## Slide \d+:?\s?(.*)$/.exec(line)
        if (h) {
          slides.push({ layout: 'content', title: h[1]!.trim() || 'Slide' })
          continue
        }
        const s = slides.at(-1)
        if (!s || !line.trim() || /^\[.*\]$/.test(line.trim())) continue
        const notes = /^Speaker notes: (.*)$/.exec(line)
        const bullet = /^( *)- (.*)$/.exec(line)
        if (notes) s.notes = notes[1]!
        else if (line.includes('\t')) (s.table ??= { rows: [] }).rows.push(line.split('\t'))
        else if (bullet) (s.bullets ??= []).push({ text: bullet[2]!, level: Math.min(2, Math.floor(bullet[1]!.length / 2)) as 0 | 1 | 2 })
        else s.body = s.body ? `${s.body}\n${line}` : line
      }
      if (!slides.length) return null
      return { deck: { slides: [...slides, { layout: 'content', title: 'Revised', body: note }] } }
    }
    default:
      return null
  }
}

/**
 * The id of the live fact whose text is `text` in an engagement_knowledge `get` result: its fact lines read
 * `  kf_<id> | <text>` with ` | retired` appended on a retired one. The text is compared as datum() renders it
 * (whitespace runs joined, angle brackets replaced), so a plain fact reads back unchanged. undefined when there is no
 * such live fact or the result is not a `get` block (a refusal, "No entity ...").
 */
export function knowledgeFactId(result: string, text: string): string | undefined {
  const want = datum(text, KNOWLEDGE_FACT_MAX_CHARS)
  const retiredSuffix = ' | retired'
  for (const line of result.split('\n')) {
    const m = /^\s+(kf_[A-Za-z0-9_-]+) \| (.*)$/.exec(line)
    if (!m) continue
    const rest = m[2]!
    if (rest.endsWith(retiredSuffix)) continue
    if (rest === want) return m[1]!
  }
  return undefined
}

export const BRIDGED_TOKEN = '[mock:bridged]'
/** Like [mock:bridged], with background: true: the root carries on with the default script and the report arrives as a harness message. */
export const BRIDGED_BG_TOKEN = '[mock:bridged-bg]'
/** The brief the [mock:bridged] root hands its first bridged report. */
export const MOCK_BRIDGED_BRIEF = 'Mock bridged brief.'
/** The root's sentence when [mock:bridged] is set but the run has no bridged report (no ctx.bridge or no bridged roles). */
export const MOCK_BRIDGED_NONE = 'No bridged report in this run.'
/** The root's sentence after delegate_agent answered nothing. */
export const MOCK_BRIDGED_DONE = 'Mock delegation done.'
/** What the root of a bridged child session (ctx.bridgedChild) says before it goes idle. */
export const MOCK_BRIDGED_CHILD_TEXT = 'Mock bridged report done.'

/**
 * The [mock:bridged] turn (work runs, default script): delegate_agent through the real harness tool for `slug` (the
 * first bridged role), say the result's first line, then the default script. Without a bridged role: one sentence,
 * then the default script.
 */
export function bridgedSteps(slug: string | undefined, rest: MockStep[], background = false): MockStep[] {
  if (!slug) return [{ type: 'text', text: MOCK_BRIDGED_NONE }, ...rest]
  const args = { role: slug, brief: MOCK_BRIDGED_BRIEF, ...(background ? { background: true } : {}) }
  return [{ type: 'harness', name: BRIDGE_HARNESS_TOOLS.delegate, retryOnRevise: false, args, echoFirstLine: MOCK_BRIDGED_DONE }, ...rest]
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
  /** What a real adapter would hand the model for user messages and spawn briefs, knowledge blocks included. For tests. */
  readonly deliveredMessages: { agentId: string; text: string }[] = []
  /** The standing knowledge index each agent's system prompt would carry (PromptFlags.knowledgeBrief), in spawn order. For tests. */
  readonly promptKnowledgeBriefs: { agentId: string; brief: string | undefined }[] = []
  private hooks: HarnessToolHooks
  private agents = new Map<string, AgentInstance>()
  private rolesBySlug: Map<string, Role>
  private root: Role
  private rootModelOverride?: string
  private isSetup: boolean
  private tools: HarnessTool[]
  private inbox: { text: string; harness: boolean }[] = []
  private continueTurns: MockStep[][]
  private continuation: ContinuationDriver
  private wake: (() => void) | null = null
  private stopped = false
  private ended = false
  private interrupted = false
  /** Interrupted by the user, until their next message (Claude's `held`): background reports' results wait for that message. */
  private held = false
  /** Harness notices that arrived while held: they come with the user's next message (Claude's heldNotices). */
  private heldNotices: string[] = []
  /** Bridged reports delegate_agent started in the background and still working: agent id -> report. */
  private bridgedLive = new Map<string, BackgroundReport>()
  /** Epoch ms the newest background bridged report ended; bookkeeping for the continuation wait. */
  private lastBridgedEndedAt?: number
  /** Root turn ends so far (RootTurnEnd.turnGen). */
  private rootTurnGen = 0
  /** A root turn is being played (turn()). */
  private inTurn = false
  /** Set by a 'fail' step: the SDK-style subtype the current root turn failed with. */
  private turnFailure: string | null = null
  /** Set by a tool step's `onDeny`: the rest of this turn's steps are skipped (the turn ends normally). */
  private turnHalt = false
  /** Set by a 'rateLimit' step: the turn ended on a usage limit. */
  private limited = false
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
    this.staffing = new StaffingBook({
      project: ctx.project,
      rootTier: root.tier ?? settingTier(root.model),
      tierModels: () => ctx.connection?.tierModels ?? {},
      adapterEfforts: effortOptionsFor('mock'),
      plan: () => ctx.getPlan(),
      // The project profile's default pick for an unrequested spawn (spec 4.5); none on a fixed project.
      ...staffingProfileDep(ctx)
    })
    const onDecided = (): void => {
      const a = this.agents.get(ROOT_AGENT_ID)
      if (a && a.state === 'waiting') this.setState(ROOT_AGENT_ID, 'thinking', 'Thinking…')
    }
    const onPlanUpdated = (plan: RunPlan): void => {
      const a = this.agents.get(ROOT_AGENT_ID)
      const activity = stepActivity(plan)
      if (a && activity && a.state !== 'done' && a.state !== 'error') this.setState(ROOT_AGENT_ID, a.state, activity)
    }
    this.hooks = {
      onDecided,
      onPlanUpdated,
      addMcpServer: (spec) => this.addMcpServer(spec),
      configChanged: (change) => this.configChanged(change),
      backgroundDelegation: {
        blocker: (caller, roleId) => this.backgroundBlocker(caller.agentId, roleId),
        started: (report) => {
          this.bridgedLive.set(report.agentId, report)
          this.noteActivity('subagent')
        },
        ended: (report, result, text) => this.backgroundEnded(report, result, text)
      }
    }
    this.tools = harnessToolsFor(ctx, this.hooks)
    this.harnessAudiences = new Map(this.tools.map((t) => [t.name, t.audience]))
    this.plugins.push(...(ctx.plugins?.() ?? []).filter((p) => p.enabled))
    if (ctx.connection) this.connection = { adapter: ctx.connection.adapter, connection: ctx.connection.connection }
    this.continueTurns = [...(script.continue ?? [])]
    // Background bridged reports are not agents of this session but still count as working reports.
    const live = (): number => [...this.agents.values()].filter((a) => a.id !== ROOT_AGENT_ID && a.state !== 'done' && a.state !== 'error').length + this.bridgedLive.size
    // The plan tools count free agent slots from ctx.liveReports; only this adapter knows its live threads.
    // A child or fake context without it reads as zero live reports.
    ctx.liveReports = live
    this.continuation = new ContinuationDriver({
      kind: ctx.run.kind,
      projectKind: projectKindOf(ctx.project),
      // Getters: RunManager's setLive re-clamp of ctx reaches the live driver.
      get autoContinue() {
        return ctx.autoContinue
      },
      get maxAutoContinues() {
        return ctx.maxAutoContinues
      },
      delayMs: ctx.continuationDelayMs,
      getPlan: () => ctx.getPlan(),
      updatePlan: (plan) => ctx.updatePlan(plan),
      liveReports: live,
      slots: () => agentSlots(ctx, live()),
      ownRoles: () => rootRoleNames(ctx.roles),
      lastReportEndedAt: () => {
        let last = this.lastBridgedEndedAt
        for (const a of this.agents.values()) if (a.id !== ROOT_AGENT_ID && a.endedAt !== undefined && (last === undefined || a.endedAt > last)) last = a.endedAt
        return last
      },
      pendingInteractions: () => ctx.pendingInteractions(),
      rateLimited: () => false,
      stopping: () => this.stopped,
      orchestratorBusy: () => {
        const root = this.agents.get(ROOT_AGENT_ID)
        return !!root && root.state !== 'idle' && root.state !== 'done'
      },
      nudge: (text, activity, summary) => this.deliverHarness(text, activity, { summary }),
      log: (level, message) => this.log(level, message),
      tellUser: (text) => this.transcript(ROOT_AGENT_ID, { kind: 'system', text }, { source: 'harness' }),
      onSettled: () => this.noteActivity('continuation')
    })
    this.stopSignal = new Promise((resolve) => (this.signalStop = () => resolve(STOPPED)))
    if (loadError) this.log('warn', loadError)
    this.finished = this.run()
  }

  // ---------- public API ----------

  async send(text: string, images?: ImageAttachment[]): Promise<void> {
    this.continuation.userMessage()
    this.held = false
    this.transcript(ROOT_AGENT_ID, images?.length ? { kind: 'user', text, images } : { kind: 'user', text })
    // Notices held while the run waited for the user come first, like the Claude adapter's.
    const notes = this.heldNotices.splice(0)
    const body = withUserMessageKnowledge(text, userMessageKnowledge(this.ctx, text, (m) => this.log('warn', m)))
    this.deliveredMessages.push({ agentId: ROOT_AGENT_ID, text: notes.length ? `${notes.join('\n\n')}\n\n---\n${body}` : body })
    this.setState(ROOT_AGENT_ID, 'thinking', 'Thinking…')
    // An image-only message is still a turn; give the scripted reply something to echo.
    const n = images?.length ?? 0
    this.inbox.push({ text: text || (n ? `[${n} image${n === 1 ? '' : 's'}]` : ''), harness: false })
    this.poke()
  }

  /** Ends the current turn before its next step; a blocking request in flight still waits for its answer. */
  async interrupt(): Promise<void> {
    this.continuation.hold()
    this.held = true
    this.interrupted = true
    this.poke()
  }

  /** A message from another run: delivered like a harness message, but RunManager writes the transcript block. */
  async receive(message: PeerMessage): Promise<void> {
    if (this.stopped) return
    this.peerMessages.push(message)
    this.deliverHarness(peerMessageText(message), 'Reading a message from another run…', { transcript: false })
  }

  /** Reference switching behavior: no new turn, transcript or continuation reset. */
  async switchModel(input: { model: string; connection?: RuntimeContext['connection'] }): Promise<void> {
    if (this.ctx.bridgedChild) throw new Error('Only the run root can switch models.')
    if (!validModelId(input.model)) throw new Error('Invalid model id.')
    if (input.connection && (input.connection.adapter !== this.ctx.connection?.adapter || input.connection.connection !== this.ctx.connection?.connection)) {
      throw new Error('Switching connections requires transporting the conversation and is not supported by this session.')
    }
    if (this.stopped || this.ended) throw new Error('This session is not live; continue the run before switching models.')
    const state = this.settlement()
    if (!state.rootIdle || !state.quiescent || this.ctx.pendingInteractions() > 0) {
      throw new Error('Switch models when the root is idle and all decision cards are answered.')
    }
    this.rootModelOverride = input.model
    const root = this.agents.get(ROOT_AGENT_ID)
    if (root) {
      root.model = input.model
      this.upsert(root)
    }
  }

  /** delegate_agent background: true blocks for a report's call (harness messages reach only the root) and a required delegation. */
  private backgroundBlocker(callerId: string | undefined, roleId: string): string | undefined {
    if (callerId !== undefined && callerId !== ROOT_AGENT_ID) return 'only the orchestrator can delegate in the background'
    if (!this.ctx.delegation) return undefined
    const obligations = obligationsFor(this.ctx.roles, this.ctx.run.overrides?.strictDelegation === true)
    if (obligations[this.root.id]?.includes(roleId) || (obligations[roleId]?.length ?? 0) > 0) return 'required delegations run in the foreground'
    return undefined
  }

  /**
   * A background bridged report ended (the Claude adapter's backgroundEnded): no longer live; its result is a harness
   * message, or waits for the user's next message while held or when the harness stopped it; nothing after stop.
   */
  private backgroundEnded(report: BackgroundReport, result: BridgeSpawnResult, text: string): void {
    this.bridgedLive.delete(report.agentId)
    this.lastBridgedEndedAt = Date.now()
    this.noteActivity('report')
    if (this.stopped || this.ended) {
      this.log('info', `Bridged report ${report.handle} ended after the session stopped; its report was not delivered.`)
      return
    }
    const message = `Harness: ${text}`
    const summary = result.stopped ? `${report.handle} was stopped.` : result.ok ? `${report.handle} reported back.` : `${report.handle} failed.`
    if (result.stopped || this.held) {
      this.heldNotices.push(message)
      this.transcript(ROOT_AGENT_ID, { kind: 'system', text: summary, detail: message }, { source: 'harness' })
    } else this.deliverHarness(message, 'Reading a report…', { summary })
  }

  /** RuntimeSession.nudge: a harness message for the orchestrator (the delegation correction), not an auto-continue. */
  async nudge(text: string): Promise<void> {
    this.deliverHarness(text, 'Reading a harness reminder…')
  }

  /** Headless exec settlement view (cli-spec 6.2(2)). The mock has no integrator or restarts. */
  settlement(): SessionSettlement {
    const root = this.agents.get(ROOT_AGENT_ID)
    const rootIdle = !this.inTurn && (!root || root.state === 'idle' || root.state === 'done' || root.state === 'error')
    return {
      rootTurnGen: this.rootTurnGen,
      rootIdle,
      continuationSettled: this.continuation.isSettledForTurn(this.rootTurnGen),
      nudgeTurn1Sent: this.continuation.nudgeTurn1Sent,
      quiescent: !this.inTurn && this.inbox.length === 0 && this.bridgedLive.size === 0 && this.heldNotices.length === 0
    }
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

  /** Exec settlement: adapter-internal activity (a listener's throw never breaks the session). */
  private noteActivity(reason: ExecActivityReason): void {
    try {
      this.ctx.noteActivity?.(reason)
    } catch {
      /* ignore */
    }
  }

  /** Count a root turn end and report it (before run.status 'idle'). Returns its generation. */
  private reportRootTurnEnd(e: Omit<RootTurnEnd, 'turnGen'>): number {
    this.rootTurnGen += 1
    const turnGen = this.rootTurnGen
    try {
      this.ctx.onRootTurnEnded?.({ turnGen, ...e })
    } catch (err) {
      this.log('warn', `Root turn end listener failed: ${(err as Error)?.message ?? String(err)}`)
    }
    return turnGen
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
    if (agentId === ROOT_AGENT_ID && this.rootModelOverride) return this.rootModelOverride
    if (agentId === ROOT_AGENT_ID && this.modelSwitchMarker() && this.root.model && this.root.model !== 'inherit') return this.root.model
    const staffed = this.staffed.get(agentId)?.model
    if (staffed) return staffed
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
    this.noteActivity('message')
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
      this.promptKnowledgeBriefs.push({ agentId: ROOT_AGENT_ID, brief: this.ctx.knowledgeBrief?.() })
      const first = composeFirstMessage(this.ctx.prompt, firstMessageHiddenContext(withRootStaffingBrief(this.ctx), (m) => this.log('warn', m)))
      this.deliveredMessages.push({ agentId: ROOT_AGENT_ID, text: first })
      this.log('info', `Mock session ${sessionId} started (${this.ctx.run.kind} script, first message ${first.length} chars)`)
      if (this.ctx.prompt.includes(AUTH_FAIL_TOKEN)) return this.failAuth()
      if (this.ctx.prompt.includes(MODEL_SWITCH_ERROR_TOKEN) && !this.ctx.resumeSessionId) throw new Error('Mock provider error for model switching recovery.')
      await this.skillStep(ROOT_AGENT_ID, this.root)
      await this.turn(this.firstTurnSteps())
      while (!this.stopped) {
        const next = await this.nextMessage()
        if (next === null) break
        if (!next.text) continue
        if (!next.harness && next.text.includes(AUTH_FAIL_TOKEN)) return this.failAuth()
        this.emit({ type: 'run.status', runId, status: 'running' })
        if (next.harness) await this.turn(this.continueTurns.shift() ?? [{ type: 'text', text: 'Mock: continuing with the plan.' }])
        else if (this.answersRevisions() && isReviseMessage(next.text)) await this.turn([{ type: 'text', text: MOCK_REVISE_START }, { type: 'reviseOutput', message: next.text }])
        else await this.turn([{ type: 'text', text: this.modelSwitchMarker() ? `Mock reply (${this.usageModel(ROOT_AGENT_ID)}): ${next.text}` : this.script.reply.replace('{text}', next.text) }])
      }
      this.emit({ type: 'run.status', runId, status: 'finished' })
    } catch (e) {
      const message = (e as Error).message ?? String(e)
      this.log('error', message)
      this.setState(ROOT_AGENT_ID, 'error', message.slice(0, 80))
      this.emit({ type: 'run.status', runId, status: 'error', error: message })
    } finally {
      this.ended = true
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
    const message = authFailureMessage(this.ctx.connection?.connection, this.ctx.connection?.name)
    this.transcript(ROOT_AGENT_ID, { kind: 'system', text: message, detail: 'Invalid API key · Please run /login' }, { source: 'harness' })
    this.log('error', 'Authentication failed: Invalid API key · Please run /login')
    this.setState(ROOT_AGENT_ID, 'error', 'Connection refused')
    this.continuation.skipTurn(this.reportRootTurnEnd({ ok: false, isAuthError: true }))
    this.emit({ type: 'run.status', runId: this.ctx.run.id, status: 'error', error: message })
  }

  /**
   * The first turn's steps. The built-in setup and mcp-assist scripts adapt to the MCP library; a custom script
   * (ORGAI_MOCK_SCRIPT or MockAdapterOptions.script) runs exactly as written.
   */
  private firstTurnSteps(): MockStep[] {
    if (this.ctx.prompt.includes(MEDIA_TOKEN)) return mediaSteps()
    if (this.modelSwitchMarker()) {
      if (this.ctx.prompt.includes(MODEL_SWITCH_LIMIT_TOKEN) && !this.ctx.resumeSessionId) return [{ type: 'rateLimit', untilInMs: 24 * 60 * 60 * 1000 }]
      return [{ type: 'text', text: `Mock root model: ${this.usageModel(ROOT_AGENT_ID)}` }]
    }
    const bridged = this.bridgedTurnSteps()
    if (bridged) return bridged
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
      if (this.ctx.prompt.includes(CHAT_EDIT_TOKEN)) return chatEditSteps(this.ctx.run.quick.folder)
      if (this.ctx.prompt.includes(CHAT_MCP_TOKEN)) return CHAT_MCP_STEPS
      const selfConfig = selfConfigMarkerSteps(this.ctx.prompt)
      if (selfConfig) return selfConfig
      const n = this.ctx.listProjects?.().length ?? 0
      return [
        { type: 'harness', name: CHAT_HARNESS_TOOLS[0], args: {} },
        { type: 'text', text: `I can see ${n} OrgAI project${n === 1 ? '' : 's'}. Tell me what you would like to do.` }
      ]
    }
    // A single-agent work run (team 'single'): like a Chat conversation, one reply to the prompt, no spawning, no plan.
    if (this.ctx.run.kind === 'work' && this.ctx.run.team === 'single' && this.script.work === DEFAULT_WORK) {
      return [{ type: 'text', text: this.script.reply.replace('{text}', this.ctx.prompt) }]
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
    if (!this.isSetup && this.ctx.run.kind === 'work' && !this.ctx.run.quick && this.script.work === DEFAULT_WORK && this.ctx.prompt.includes(FOLDER_CONFIG_TOKEN)) {
      // One read of the gate for the turn, like the Claude adapter's per-query snapshot.
      const loaded = projectSettingsLoad(this.ctx)
      const rules = loaded ? cliProjectSettings(this.ctx, true).rules : []
      const covered = rules.length > 0 && matchingRule('Bash', { command: 'npm test' }, rules, this.safeMatchOptions('Bash') ?? undefined) !== undefined
      return folderConfigSteps(loaded, covered)
    }
    if (!this.isSetup && this.ctx.run.kind === 'work' && !this.ctx.run.quick && this.script.work === DEFAULT_WORK && this.ctx.prompt.includes(REFERENCE_EDIT_TOKEN)) {
      const list = this.referenceList()
      const ref = Array.isArray(list) ? list[0] : undefined
      if (!ref) this.log('info', 'Mock [mock:reference-edit]: this run has no reference folder, so the edit step is skipped.')
      return referenceEditSteps(ref)
    }
    if (!this.isSetup && this.ctx.run.kind === 'work' && !this.ctx.run.quick && this.script.work === DEFAULT_WORK && this.ctx.prompt.includes(REFERENCE_SHELL_TOKEN)) {
      const list = this.referenceList()
      const ref = Array.isArray(list) ? list[0] : undefined
      if (!ref) this.log('info', 'Mock [mock:reference-shell]: this run has no reference folder, so the command step is skipped.')
      return referenceShellSteps(ref)
    }
    if (!this.isSetup && this.ctx.run.kind === 'work' && !this.ctx.run.quick && this.script.work === DEFAULT_WORK && this.ctx.prompt.includes(STAFFING_TOKEN)) {
      const spawnable = (this.root.spawnable ?? []).map((id) => this.ctx.roles.find((r) => r.id === id)?.slug).filter((x): x is string => !!x)
      const first = spawnable[0] ?? this.firstSpawnableSlug(this.root)
      return staffingSteps(first, spawnable[1] ?? first)
    }
    const delegation = this.delegationMarkerSteps()
    if (delegation) return delegation
    const execMarker = this.execMarkerSteps()
    if (execMarker) return execMarker
    if (!this.isSetup && this.ctx.run.kind === 'work' && !this.ctx.run.quick && this.script.work === DEFAULT_WORK && this.ctx.prompt.includes(DEEP_TREE_TOKEN)) {
      const lead = this.firstSpawnableSlug(this.root)
      return deepTreeSteps(lead, this.firstSpawnableSlug(this.rolesBySlug.get(lead), lead))
    }
    if (this.answersRevisions() && isReviseMessage(this.ctx.prompt)) {
      // A revise request that started or continued this run: answer it and go idle (no default script).
      return [{ type: 'text', text: MOCK_REVISE_START }, { type: 'reviseOutput', message: this.ctx.prompt }]
    }
    if (!this.isSetup && this.ctx.run.kind === 'work' && !this.ctx.run.quick && this.script.work === DEFAULT_WORK && (this.ctx.prompt.includes(OUTPUTS_ALL_TOKEN) || this.ctx.prompt.includes(OUTPUTS_V2_TOKEN))) {
      const available = !!this.ctx.outputs && this.tools.some((t) => t.name === OUTPUT_TOOLS.produce)
      const v2 = this.ctx.prompt.includes(OUTPUTS_V2_TOKEN)
      if (!available) this.log('info', `Mock ${v2 ? OUTPUTS_V2_TOKEN : OUTPUTS_ALL_TOKEN}: this run has no outputs (not a work run of a stored project), so the output steps are skipped.`)
      const first: MockStep[] = !available ? [{ type: 'text', text: MOCK_OUTPUTS_NONE }] : v2 ? outputsV2Steps() : outputsSteps(true)
      return [...first, ...DEFAULT_WORK]
    }
    if (!this.isSetup && this.ctx.run.kind === 'work' && !this.ctx.run.quick && this.script.work === DEFAULT_WORK && this.ctx.prompt.includes(OUTPUTS_TOKEN)) {
      // The tools are bound on every work run and answer "Outputs are not available" themselves without ctx.outputs.
      const available = !!this.ctx.outputs && this.tools.some((t) => t.name === OUTPUT_TOOLS.produce)
      if (!available) this.log('info', 'Mock [mock:outputs]: this run has no outputs (not a work run of a stored project), so the output steps are skipped.')
      const first: MockStep[] = available ? outputsSteps() : [{ type: 'text', text: MOCK_OUTPUTS_NONE }]
      return [...first, ...DEFAULT_WORK]
    }
    if (!this.isSetup && this.ctx.run.kind === 'work' && !this.ctx.run.quick && this.script.work === DEFAULT_WORK && this.ctx.prompt.includes(KNOWLEDGE_RECALL_TOKEN)) {
      const available = !!this.ctx.knowledge && !!this.ctx.knowledgeRecall && this.tools.some((t) => t.name === KNOWLEDGE_RECALL_TOOL)
      if (available) return knowledgeRecallSteps()
      this.log('info', 'Mock [mock:knowledge-recall]: this run has no knowledge graph (not an engagement work run), so the recall steps are skipped.')
      return [{ type: 'text', text: MOCK_KNOWLEDGE_NONE }, ...DEFAULT_WORK]
    }
    if (!this.isSetup && this.ctx.run.kind === 'work' && !this.ctx.run.quick && this.script.work === DEFAULT_WORK && this.ctx.prompt.includes(KNOWLEDGE_TOKEN)) {
      // The tool is bound on engagement work runs only, and answers the same sentence itself without ctx.knowledge.
      const available = !!this.ctx.knowledge && this.tools.some((t) => t.name === KNOWLEDGE_TOOL)
      if (!available) this.log('info', 'Mock [mock:knowledge]: this run has no knowledge graph (not an engagement work run), so the knowledge steps are skipped.')
      const first: MockStep[] = available ? knowledgeSteps() : [{ type: 'text', text: MOCK_KNOWLEDGE_NONE }]
      return [...first, ...DEFAULT_WORK]
    }
    return this.isSetup ? this.script.setup : this.script.work
  }

  /**
   * Bridged reports (work runs, default script), or null. A bridged child session's root (ctx.bridgedChild) says
   * MOCK_BRIDGED_CHILD_TEXT and its turn ends (idle; never nudged, autoContinue is false). [mock:bridged] on a parent
   * run: bridgedSteps for the first bridged role, then the default script; [mock:bridged-bg] the same with background: true.
   */
  private bridgedTurnSteps(): MockStep[] | null {
    if (this.isSetup || this.ctx.run.kind !== 'work' || this.ctx.run.quick || this.script.work !== DEFAULT_WORK) return null
    if (this.ctx.bridgedChild) return [{ type: 'text', text: MOCK_BRIDGED_CHILD_TEXT }]
    const background = this.ctx.prompt.includes(BRIDGED_BG_TOKEN)
    if (!background && !this.ctx.prompt.includes(BRIDGED_TOKEN)) return null
    const first = bridgedRolesOf(this.ctx)[0]
    const available = !!first && this.tools.some((t) => t.name === BRIDGE_HARNESS_TOOLS.delegate)
    if (!available) this.log('info', 'Mock [mock:bridged]: this run has no bridged report, so the delegation step is skipped.')
    return bridgedSteps(available ? first.slug : undefined, DEFAULT_WORK, background)
  }

  /**
   * The system prompt a real adapter would give `role` in this session (buildRolePrompt with the run's flags, bridged
   * marks included: bridgeVia 'delegate_agent' like Claude). For tests; the mock sends no prompts.
   */
  rolePromptFor(role: Role): string {
    const bridgedRoles = bridgedRolesOf(this.ctx)
    return buildRolePrompt(role, this.ctx.roles, this.ctx.project, {
      isSetup: this.isSetup,
      isolation: false,
      ...(this.ctx.run.overrides?.strictDelegation ? { strictDelegation: true } : {}),
      ...(this.ctx.run.quick ? { quick: this.ctx.run.quick } : {}),
      ...(this.ctx.run.team ? { team: this.ctx.run.team } : {}),
      ...(this.ctx.staffingGoal ? { staffingGoal: this.ctx.staffingGoal } : {}),
      ...(bridgedRoles.length ? { bridgedRoles, bridgeVia: 'delegate_agent' as const } : {}),
      ...(this.ctx.bridgedChild ? { bridged: true } : {})
    })
  }

  private modelSwitchMarker(): boolean {
    return [MODEL_SWITCH_TOKEN, MODEL_SWITCH_LIMIT_TOKEN, MODEL_SWITCH_ERROR_TOKEN].some((token) => this.ctx.prompt.includes(token))
  }

  /** Run staffing: the same book the real adapters keep; scripted spawns resolve through it. */
  private staffing: StaffingBook
  /** agentId -> what a staffed report runs on: the resolved model and the effort every message to it would carry. */
  private staffed = new Map<string, { model?: string; effort?: Effort }>()

  /** What the staffing book gave a report that runs on a picked model / effort (undefined = as configured). For tests. */
  staffedFor(agentId: string): { model?: string; effort?: Effort } | undefined {
    return this.staffed.get(agentId)
  }

  /** Spawn step ids whose native spawn was refused (a bridged role); their later steps are skipped. */
  private deniedSpawns = new Set<string>()

  /** True for a step played by, spawned under or finishing an agent whose spawn was refused. */
  private stepOfDeniedSpawn(step: MockStep): boolean {
    const ids: (string | undefined)[] = []
    if ('agent' in step) ids.push(step.agent)
    if (step.type === 'spawn') ids.push(step.parent)
    if (step.type === 'finish') ids.push(step.id)
    if (step.type === 'message') ids.push(step.from)
    return ids.some((id) => id !== undefined && this.deniedSpawns.has(id))
  }

  /** The headless exec markers' first turn (work runs, default script), or null. */
  /** The [mock:delegation-*] turn (root -> manager -> required workers), then the exec plan steps with [mock:exec-plan]. */
  private delegationMarkerSteps(): MockStep[] | null {
    if (this.isSetup || this.ctx.run.kind !== 'work' || this.ctx.run.quick || this.script.work !== DEFAULT_WORK) return null
    const prompt = this.ctx.prompt
    const variant = prompt.includes(DELEGATION_CLAIM_TOKEN) ? 'claim' : prompt.includes(DELEGATION_SKIP_TOKEN) ? 'skip' : prompt.includes(DELEGATION_FIX_TOKEN) ? 'fix' : prompt.includes(DELEGATION_OK_TOKEN) ? 'ok' : prompt.includes(DELEGATION_EARLY_TOKEN) ? 'early' : null
    if (!variant) return null
    const managerSlug = this.firstSpawnableSlug(this.root)
    const manager = this.rolesBySlug.get(managerSlug)
    const required = manager ? (cleanRequiredReports(manager) ?? manager.spawnable) : []
    const slugs = required.map((id) => this.ctx.roles.find((r) => r.id === id)?.slug).filter((x): x is string => !!x)
    return [...delegationSteps(variant, managerSlug, slugs), ...(prompt.includes(EXEC_PLAN_TOKEN) ? execPlanSteps() : [])]
  }

  private execMarkerSteps(): MockStep[] | null {
    if (this.isSetup || this.ctx.run.kind !== 'work' || this.ctx.run.quick || this.script.work !== DEFAULT_WORK) return null
    const prompt = this.ctx.prompt
    if (prompt.includes(EXEC_PLAN_TOKEN)) return execPlanSteps()
    if (prompt.includes(EXEC_BLOCKED_TOKEN)) return execBlockedSteps()
    if (prompt.includes(EXEC_QUESTION_TOKEN)) return execQuestionSteps()
    if (prompt.includes(TURN_FAIL_TOKEN)) return turnFailSteps()
    if (prompt.includes(RATE_LIMIT_TOKEN)) return rateLimitSteps()
    if (prompt.includes(EXEC_SLOW_TOKEN)) return execSlowSteps(this.script.delayMs)
    return null
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
    this.turnFailure = null
    this.turnHalt = false
    this.inTurn = true
    try {
      this.setState(ROOT_AGENT_ID, 'thinking', 'Thinking…')
      for (const step of steps) {
        await this.pause(this.script.delayMs)
        if (this.stopped || this.interrupted) break
        await this.step(step)
        if (this.turnFailure || this.turnHalt) break
      }
      if (this.stopped) {
        // A usage limit ends the session mid-turn: the turn end is still reported (limited), then the session ends.
        if (this.limited) this.continuation.skipTurn(this.reportRootTurnEnd({ ok: true, limited: true }))
        return
      }
      if (this.interrupted) this.log('info', 'Turn interrupted.')
      this.emit({ type: 'run.cost', runId: this.ctx.run.id, totalCostUsd: this.totalCost() })
      const root = this.ensureAgent(ROOT_AGENT_ID)
      const failure = this.turnFailure as string | null // set by a fail step (step() mutates it)
      if (failure) {
        root.state = 'error'
        root.activity = failure.replace(/^error_/, '').replace(/_/g, ' ')
        this.log('error', `Run ended: ${failure}`)
      } else {
        root.state = 'idle'
        const reportsRunning = [...this.agents.values()].some((x) => x.id !== ROOT_AGENT_ID && x.state !== 'done' && x.state !== 'error')
        root.activity = reportsRunning ? 'Waiting on reports…' : 'Waiting for you'
      }
      this.upsert(root)
      this.inTurn = false
      // Exec settlement (cli-spec 6.2(2)): every root turn end is reported before 'idle'.
      const interrupted = this.interrupted
      const turnGen = this.reportRootTurnEnd(failure ? { ok: false, errorSubtype: failure } : { ok: true, ...(interrupted ? { interrupted: true } : {}) })
      this.emit({ type: 'run.status', runId: this.ctx.run.id, status: 'idle' })
      if (failure || interrupted) this.continuation.skipTurn(turnGen)
      else this.continuation.turnEnded(turnGen)
    } finally {
      this.inTurn = false
      this.turnFailure = null
      this.turnHalt = false
    }
  }

  private async step(step: MockStep): Promise<void> {
    if (this.deniedSpawns.size && this.stepOfDeniedSpawn(step)) return
    switch (step.type) {
      case 'text': {
        const agentId = step.agent ?? ROOT_AGENT_ID
        const a = this.ensureAgent(agentId)
        if (Array.isArray(step.partials)) {
          let first = true
          for (const chunk of step.partials) {
            if (!first) await this.pause(this.script.delayMs)
            first = false
            if (this.stopped || this.interrupted) break
            this.emit({ type: 'agent.partial', runId: this.ctx.run.id, agentId, text: String(chunk) })
          }
          if (this.stopped || this.interrupted) {
            this.emit({ type: 'agent.partial', runId: this.ctx.run.id, agentId, text: '' })
            return
          }
        } else this.emit({ type: 'agent.partial', runId: this.ctx.run.id, agentId, text: step.text.slice(0, Math.ceil(step.text.length / 2)) })
        a.lastText = step.text.trim().slice(0, 200)
        this.charge(agentId, step.text)
        this.transcript(agentId, { kind: 'text', text: step.text })
        this.emit({ type: 'agent.partial', runId: this.ctx.run.id, agentId, text: '' })
        this.upsert(a)
        return
      }
      case 'transcript':
        this.transcript(ROOT_AGENT_ID, step.block)
        return
      case 'thinking': {
        this.transcript(step.agent ?? ROOT_AGENT_ID, { kind: 'thinking', text: step.text })
        return
      }
      case 'tool':
        return this.toolStep(step)
      case 'spawn':
        return this.spawnStep(step)
      case 'finish':
        return this.finishStep(step)
      case 'harness': {
        const result = await this.harnessStep(step)
        if (step.echo !== undefined && result !== undefined && !this.stopped && !this.interrupted) {
          await this.step({ type: 'text', text: step.echo.replace('{result}', result) })
        }
        if (step.echoIf && result !== undefined && !this.stopped && !this.interrupted) {
          await this.step({ type: 'text', text: result.includes(step.echoIf.contains) ? step.echoIf.then : step.echoIf.else })
        }
        if (step.echoFirstLine !== undefined && !this.stopped && !this.interrupted) {
          const line = (result ?? '').split(/\r?\n/).map((l) => l.trim()).find(Boolean)
          await this.step({ type: 'text', text: line ?? step.echoFirstLine })
        }
        return
      }
      case 'retireFact':
        return this.retireFactStep(step)
      case 'reviseOutput':
        return this.reviseOutputStep(step.message)
      case 'writeFile': {
        const target = join(this.ctx.project.path, step.path)
        try {
          mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, Buffer.from(step.base64, 'base64'))
          this.log('info', `Mock: wrote ${step.path} in the project folder.`)
        } catch (e) {
          this.log('warn', `Mock: could not write ${step.path}: ${(e as Error).message}`)
        }
        return
      }
      case 'harnessAnswer':
        return this.harnessAnswerStep(step)
      case 'firstProject':
        return this.firstProjectStep(step)
      case 'wait':
        await this.pause(step.ms)
        return
      case 'fail':
        this.turnFailure = step.subtype ?? 'error_during_execution'
        return
      case 'retry': {
        const a = this.ensureAgent(step.agent ?? ROOT_AGENT_ID)
        countUsage(a, 'retries')
        this.log('info', `API request retried (attempt 1 of 3) for ${a.name}`)
        this.upsert(a)
        return
      }
      case 'plan':
        await this.harnessStep({
          type: 'harness',
          name: PLAN_TOOLS.set,
          args: { goal: step.goal, steps: step.steps.map((s) => (typeof s === 'string' ? { title: s } : s)) }
        })
        return
      case 'planUpdate':
        await this.harnessStep({ type: 'harness', name: PLAN_TOOLS.update, args: { steps: step.steps } })
        return
      case 'planComplete':
        await this.harnessStep({ type: 'harness', name: PLAN_TOOLS.complete, args: { summary: step.summary } })
        return
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
        this.limited = true
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
    // Same self-control gate as the Claude adapter's PreToolUse (cli-spec 3.4(1)), before every other check, rule and
    // mode: the orgai command and OrgAI's control files are refused outright.
    const selfDenial = this.selfControlDenial(agentId, step.name, input)
    if (selfDenial) {
      this.transcript(agentId, { kind: 'tool_result', toolUseId: id, content: selfDenial, isError: true })
      this.transcript(agentId, { kind: 'system', text: SELF_CONTROL_REFUSAL_TEXT }, { source: 'harness' })
      this.setState(agentId, 'thinking', 'Thinking…')
      return
    }
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
      let cardSuggestions: PermissionSuggestion[] = []
      let preApproved = false
      let opts: MatchOptions | undefined
      // A touching shell command skips every allow path (and never reads matchOptionsFor, which an unreadable list breaks).
      // When the folder lists cannot be read now (safeMatchOptions null, review L1) the call is asked with no suggestions
      // and no rule allow, and an allow grants this call only (same as the Claude adapter).
      const base = ref?.forced ? null : this.safeMatchOptions(step.name)
      if (base) {
        const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : undefined
        opts = { ...base, ...(cwd ? { effectiveCwd: cwd } : {}) }
        // Same as the Claude adapter: server-level rules are offered for the user's MCP servers only (never one an agent
        // installed this run, never orgai), and a trust-restricted run never gets a setMode suggestion.
        const installedAll = agentInstalledServers(this.liveMcpServers(), this.ctx.project.mcpServers, this.addedMcpServers.map((x) => x.name))
        const userMcpServers = [...new Set(this.liveMcpServers().filter((s) => s.enabled && s.name !== 'orgai' && !installedAll.has(s.name)).map((s) => s.name))]
        // A read under a reference folder gets no suggestions (M2).
        const chosen = ref ? [] : chooseSuggestions(step.name, input, step.suggestions, false, { ...opts, userMcpServers })
        suggestions = restricted ? chosen.filter((s) => s.type !== 'setMode') : chosen
        cardSuggestions = suggestions
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
      // Chat (quick) session edit grant (same as the Claude and Codex adapters): after every deny gate above, an edit
      // whose every file is inside the chat's folder needs no card once the user allowed a covered edit for the session.
      if (!preApproved && !ref && quickEditFree(this.ctx, step.name, input, this.ctx.project.path)) preApproved = true
      if (!preApproved) {
        // A covered quick edit also offers "Allow for session"; that suggestion is on the card only (applyAllowScope
        // below gets `suggestions` without it), so it never turns on sessionAcceptEdits.
        const card = ref ? { suggestions: cardSuggestions, ruleLabels: suggestionLabels(cardSuggestions) } : quickEditCard(this.ctx.run, step.name, input, this.ctx.project.path, cardSuggestions)
        this.setState(agentId, 'waiting', `Needs approval: ${describeTool(step.name, input)}`)
        const decision = await this.untilStopped(
          this.ctx.requestPermission({
            agentId,
            toolName: step.name,
            input,
            summary: describeTool(step.name, input),
            ...(card.suggestions.length ? { suggestions: card.suggestions, ruleLabels: card.ruleLabels } : {}),
            ...refField
          })
        )
        if (decision === STOPPED) return
        const a = this.agents.get(agentId)
        if (a && a.state === 'waiting') this.setState(agentId, 'tool', describeTool(step.name, input))
        if (decision.behavior === 'deny') {
          this.transcript(agentId, { kind: 'tool_result', toolUseId: id, content: decision.message, isError: true })
          this.setState(agentId, 'thinking', 'Thinking…')
          if (step.onDeny !== undefined) {
            await this.step({ type: 'text', text: step.onDeny })
            this.turnHalt = true
          }
          return
        }
        // A reference-folder card grants this call only: no rule, folder or mode is kept.
        if (ref || !opts) return this.toolRan(agentId, id, step, input)
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
    return this.toolRan(agentId, id, step, input)
  }

  /** A tool call that ran: its result, then the step's `writeContent` (written for real) and `onAllow` text. */
  private async toolRan(agentId: string, id: string, step: Extract<MockStep, { type: 'tool' }>, input: Record<string, unknown>): Promise<void> {
    let content = step.result ?? 'ok'
    let isError = false
    if (step.writeContent !== undefined) {
      const target = typeof input.file_path === 'string' ? input.file_path : ''
      try {
        if (!target) throw new Error('no file_path')
        writeFileSync(target, step.writeContent)
      } catch (e) {
        content = `Could not write ${target || 'the file'}: ${(e as Error).message}`
        isError = true
      }
    }
    this.transcript(agentId, { kind: 'tool_result', toolUseId: id, content, isError })
    this.setState(agentId, 'thinking', 'Thinking…')
    if (step.onAllow !== undefined && !isError) await this.step({ type: 'text', text: step.onAllow })
  }

  /**
   * matchOptionsFor(ctx) now, or null when a folder list (allowed, reference, protected) cannot be read (review L1):
   * the caller then asks, with no rule allow and no suggestions. Same as the Claude and Codex adapters.
   */
  private safeMatchOptions(toolName: string): MatchOptions | null {
    try {
      return matchOptionsFor(this.ctx)
    } catch (e) {
      this.log('warn', `Could not read the run's folders for ${toolName}, so it needs your approval: ${(e as Error).message}`)
      return null
    }
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

  /** Set once the "self-control gate skipped" line was logged for this run. */
  private selfControlSkipLogged = false

  /**
   * Same as the Claude adapter's selfControlDenial: SELF_CONTROL_DENIAL_MESSAGE for a call that runs the orgai command
   * or opens OrgAI's control files (logged as a warning), else null. The cwd is input.cwd, else the project folder. An
   * empty or unreadable protected list denies shell commands (SELF_CONTROL_UNCHECKED_MESSAGE, review M2) and leaves
   * file tools to the normal flow (logged once per run).
   */
  private selfControlDenial(agentId: string, toolName: string, input: Record<string, unknown>): string | null {
    const { paths, unavailable } = readControlProtectedPaths(this.ctx.controlProtectedPaths?.bind(this.ctx))
    if (unavailable && !this.selfControlSkipLogged) {
      this.selfControlSkipLogged = true
      this.log('warn', SELF_CONTROL_PATHS_UNAVAILABLE_LOG)
    }
    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : this.ctx.project.path
    const denial = checkSelfControlDenial(toolName, input, {
      protectedPaths: paths,
      pathsUnavailable: unavailable,
      cwd,
      shell: toolName === 'PowerShell' ? 'powershell' : 'bash'
    })
    if (!denial) return null
    this.log('warn', selfControlLogLine(toolName, this.agents.get(agentId)?.name ?? agentId))
    return denial
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
    const opts = this.safeMatchOptions(toolName)
    if (!opts) return false
    return isFreeCdTarget(target, { ...opts, freeDirs: [...(opts.freeDirs ?? []), ...this.sessionDirs] })
  }

  /** The first role `parent` may spawn, else the first non-root role, else `fallback` (default: the root's slug). */
  private firstSpawnableSlug(parent: Role | undefined, fallback?: string): string {
    const allowed = parent ? this.ctx.roles.filter((r) => parent.spawnable.includes(r.id)) : []
    // A bridged role is never spawned natively (delegate_agent only); prefer a native one when there is one.
    const bridged = new Set(bridgedRolesOf(this.ctx).map((b) => b.roleId))
    const native = allowed.find((r) => !bridged.has(r.id))
    if (native) return native.slug
    return allowed[0]?.slug ?? fallback ?? this.ctx.roles.find((r) => r.reportsTo !== null)?.slug ?? this.root.slug
  }

  /** Finishes the gate said to wait on (agent id -> step), retried when a child of that agent finishes. */
  private readonly pendingFinish = new Map<string, Extract<MockStep, { type: 'finish' }>>()

  /**
   * A report finishes. With ctx.delegation the gate is asked first (spec 5.2): a correction is shown to the agent, `comply`
   * steps run, then it tries again; the report its parent receives carries the harness receipt, and delivery is confirmed.
   */
  private async finishStep(step: Extract<MockStep, { type: 'finish' }>): Promise<void> {
    const gate = this.ctx.delegation
    let text = step.result
    let failed = false
    if (gate) {
      const ask = (): ReturnType<typeof gate.completion> => gate.completion(step.id, { canCorrect: true, canWait: true, reportText: step.result })
      let d = ask()
      if (d.action === 'correct' && d.text) {
        this.transcript(step.id, { kind: 'system', text: d.text }, { source: 'harness' })
        for (const c of step.comply ?? []) {
          if (this.stopped || this.interrupted) return
          await this.step(c)
        }
        d = ask()
      }
      // 'none': the agent already ended. 'wait': a required child is still running; the finish stays pending and is retried
      // when one of its children finishes (like Codex's held report).
      if (d.action === 'wait') {
        this.pendingFinish.set(step.id, step)
        return
      }
      if (d.action === 'none' || d.action === 'correct') return
      this.pendingFinish.delete(step.id)
      failed = d.action === 'fail'
      const receipt = gate.receiptText(step.id)
      if (receipt) text = `${receipt}\n\n${step.result}`
    }
    this.staffing.ended(step.id, { failed })
    const a = this.ensureAgent(step.id)
    a.result = step.result
    a.state = 'done'
    a.activity = 'Reported back'
    a.endedAt = Date.now()
    this.upsert(a)
    this.noteActivity('report')
    const toolUseId = this.spawnToolUse.get(step.id)
    if (toolUseId) this.transcript(a.parentId ?? ROOT_AGENT_ID, { kind: 'tool_result', toolUseId, content: text, isError: false })
    gate?.delivered(step.id)
    if (a.parentId) {
      this.setState(a.parentId, 'thinking', 'Thinking…')
      const pending = this.pendingFinish.get(a.parentId)
      if (pending && !this.stopped && !this.interrupted) {
        const running = [...this.agents.values()].some((x) => x.parentId === a.parentId && x.state !== 'done' && x.state !== 'error')
        if (!running) await this.finishStep(pending)
      }
    }
  }

  private async spawnStep(step: Extract<MockStep, { type: 'spawn' }>): Promise<void> {
    const parentId = step.parent ?? ROOT_AGENT_ID
    const parent = this.ensureAgent(parentId)
    const slug = step.role ?? this.firstSpawnableSlug(this.rolesBySlug.get(parent.roleSlug))
    const { handle } = spawnHandle(this.handles, slug, step.name)
    const brief = step.brief ?? step.description
    const input = { subagent_type: slug, description: step.description, prompt: brief, name: handle }
    const toolUseId = newId('tu')
    this.transcript(parentId, { kind: 'tool_use', id: toolUseId, name: SPAWN_TOOL, input })
    countUsage(parent, 'toolCalls')
    // Like Claude's PreToolUse: a bridged role is never spawned natively. The step's later steps are skipped.
    const bridgedDenial = bridgedSpawnDenial(this.ctx, slug)
    if (bridgedDenial) {
      this.log('warn', `Blocked spawn: ${parent.roleSlug} -> ${slug} (bridged role)`)
      this.transcript(parentId, { kind: 'tool_result', toolUseId, content: bridgedDenial, isError: true })
      this.deniedSpawns.add(step.id)
      return
    }
    this.setState(parentId, 'delegating', describeTool(SPAWN_TOOL, input))
    this.spawnToolUse.set(step.id, toolUseId)
    if (!this.agents.has(step.id)) this.noteActivity('subagent')
    const role = this.rolesBySlug.get(slug)
    // Run staffing: bind to the plan step and resolve before the report exists; apply only an override.
    const onCall = step.tier || step.effort ? { ...(step.tier ? { tier: step.tier } : {}), ...(step.effort ? { effort: step.effort } : {}) } : undefined
    const decision = role ? this.staffing.decide({ key: step.id, role, ...(parentId !== ROOT_AGENT_ID ? { parentAgentId: parentId } : {}), ...(onCall ? { onCall } : {}) }) : undefined
    const staffedModel = decision?.resolved.tierChanged && decision.resolved.model && decision.resolved.model !== 'inherit' ? decision.resolved.model : undefined
    if (decision?.resolved.overrides) this.staffed.set(step.id, { ...(staffedModel ? { model: staffedModel } : {}), ...(decision.resolved.effortChanged && decision.resolved.effort ? { effort: decision.resolved.effort } : {}) })
    else this.staffed.delete(step.id)
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
      activity: step.description.slice(0, 90) || 'Reading the brief…',
      ...(staffedModel ? { model: staffedModel } : {})
    })
    if (decision) {
      const row = this.staffing.started(step.id, step.id, Date.now())
      if (row) recordStaffing(this.ctx, row).catch((e: Error) => this.log('warn', `Could not record the staffing of ${handle}: ${e.message}`))
    }
    if (role) this.ctx.delegation?.noteSpawn(step.id, agentParent ?? parentId, role.id)
    this.transcript(step.id, { kind: 'user', text: brief })
    // After the upsert, so the row lands on the report (like Codex); the block stays out of its transcript entry.
    this.promptKnowledgeBriefs.push({ agentId: step.id, brief: this.ctx.knowledgeBrief?.() })
    // Context pack (split-execution 3.2), as on Codex: the same read checks, the block appended to the first message.
    const pack = step.files?.length ? this.contextPackFor(step.files) : undefined
    const first = withSpawnKnowledge(brief, spawnKnowledge(this.ctx, brief, step.id, (m) => this.log('warn', m)))
    this.deliveredMessages.push({ agentId: step.id, text: pack ? withContextPack(first, pack) : first })
    // What Codex's spawn_report result would carry (the mock's spawn has no result until the report finishes): the pack
    // line and the one-report-and-waiting note, as harness rows on the spawning agent and in spawnNotes.
    const notes = [pack ? contextPackResultLine(pack) : '', role ? (this.waitingNoteFor(parentId, role.id) ?? '') : ''].filter(Boolean)
    for (const text of notes) {
      this.spawnNotes.push({ agentId: parentId, reportId: step.id, text })
      this.transcript(parentId, { kind: 'system', text }, { source: 'harness' })
    }
    if (role) await this.skillStep(step.id, role)
  }

  /** The spawn results' extra lines (context pack, waiting note) in order, for tests. */
  readonly spawnNotes: { agentId: string; reportId: string; text: string }[] = []

  /** Set once the one-report-and-waiting note was given (at most once per run). */
  private waitingNoteShown = false

  /** The one-report-and-waiting note (waitingNote.ts) for a spawn by `callerId`, as on Codex. */
  private waitingNoteFor(callerId: string, roleId: string): string | undefined {
    const live = (a: AgentInstance): boolean => a.id !== ROOT_AGENT_ID && a.state !== 'done' && a.state !== 'error'
    const running = [...this.agents.values()].filter(live)
    const note = waitingNote({
      callerIsRoot: callerId === ROOT_AGENT_ID && !this.ctx.bridgedChild,
      callerRunningReports: running.filter((a) => a.parentId === callerId).length,
      spawnedRoleId: roleId,
      requiredRoleIds: obligationsFor(this.ctx.roles, this.ctx.run.overrides?.strictDelegation === true)[this.root.id] ?? [],
      plan: this.ctx.getPlan(),
      assignments: this.ctx.getStaffing()?.assignments ?? [],
      runningAgentIds: new Set(running.map((a) => a.id)),
      shown: this.waitingNoteShown,
      excludedRun: waitingNoteExcluded(this.ctx.run, this.isSetup)
    })
    if (note) this.waitingNoteShown = true
    return note
  }

  /** The context pack for a mock spawn: the lead and the report work in the project folder. */
  private contextPackFor(files: string[]): ContextPack {
    const { paths, unavailable } = readControlProtectedPaths(this.ctx.controlProtectedPaths?.bind(this.ctx))
    const cwd = this.ctx.project.path
    return buildContextPack(files, {
      callerCwd: cwd,
      readRoots: contextPackRoots(this.ctx, [cwd]),
      protectedPaths: paths,
      pathsUnavailable: unavailable,
      refuseAll: contextPackRefusal(this.ctx.run, this.isSetup)
    })
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

  /**
   * A harness tool call from the root. Returns the tool's last result text (a thrown error's message counts), or
   * undefined when the tool is not bound for this run or the session stopped mid-call.
   */
  private async harnessStep(step: Extract<MockStep, { type: 'harness' }>): Promise<string | undefined> {
    const t = this.tools.find((x) => x.name === step.name)
    if (!t) {
      this.log('warn', `Mock script calls unknown harness tool ${step.name} for a ${this.ctx.run.kind} run`)
      return undefined
    }
    let last: string | undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = newId('tu')
      this.transcript(ROOT_AGENT_ID, { kind: 'tool_use', id, name: step.name, input: step.args ?? {} })
      countUsage(this.ensureAgent(ROOT_AGENT_ID), 'toolCalls')
      this.setState(ROOT_AGENT_ID, isBlockingHarnessTool(step.name) ? 'waiting' : 'tool', harnessToolActivity(step.name))
      let text: string
      let isError = false
      try {
        const res = await this.untilStopped(t.call(step.args ?? {}, { agentId: ROOT_AGENT_ID, roleId: this.root.id }))
        if (res === STOPPED) return undefined
        text = res
      } catch (e) {
        text = (e as Error).message
        isError = true
      }
      last = text
      this.transcript(ROOT_AGENT_ID, { kind: 'tool_result', toolUseId: id, content: text, isError })
      const a = this.agents.get(ROOT_AGENT_ID)
      if (a && (a.state === 'waiting' || a.state === 'tool')) this.setState(ROOT_AGENT_ID, 'thinking', stepActivity(this.ctx.getPlan()) ?? 'Thinking…')
      if (isError || !text.startsWith('REVISE') || step.retryOnRevise === false || this.stopped || this.interrupted) return text
      this.transcript(ROOT_AGENT_ID, { kind: 'text', text: 'Revising the proposal with your feedback.' })
    }
    return last
  }

  /**
   * The retireFact step: read the entity back with engagement_knowledge `get`, find the fact's id in the fenced result
   * and `retire` it. When the entity or the fact cannot be read back (no graph, a refusal, the fact missing or already
   * retired) the retire is skipped with an info log line, never a failure.
   */
  /** Revise requests are answered on default-script work runs (never setup-like, quick or custom scripts). */
  private answersRevisions(): boolean {
    return !this.isSetup && this.ctx.run.kind === 'work' && !this.ctx.run.quick && this.script.work === DEFAULT_WORK
  }

  /** The reviseOutput step (see MockStep): read_output, then produce_output at the same file name, through the real tools. */
  private async reviseOutputStep(message: string): Promise<void> {
    const req = parseReviseRequest(message)
    if (!req) {
      this.log('info', 'Mock [mock:outputs-revise]: the revise request did not parse, so nothing was written.')
      await this.step({ type: 'text', text: MOCK_REVISE_UNPARSED })
      return
    }
    if (!req.fileName) {
      await this.step({ type: 'text', text: MOCK_REVISE_REGISTERED })
      return
    }
    const read = await this.harnessStep({ type: 'harness', name: OUTPUT_TOOLS.read, args: { action: 'read', outputId: req.outputId }, retryOnRevise: false })
    if (this.stopped || this.interrupted) return
    const got = read === undefined ? null : readOutputText(read)
    if (!got) {
      await this.step({ type: 'text', text: MOCK_REVISE_UNREADABLE })
      return
    }
    const content = reviseProduceContent(req.kind, got.text, req.requestId)
    if (!content) {
      await this.step({ type: 'text', text: MOCK_REVISE_UNCHANGED })
      return
    }
    const produced = await this.harnessStep({ type: 'harness', name: OUTPUT_TOOLS.produce, args: { kind: req.kind, title: got.title, fileName: req.fileName, ...content }, retryOnRevise: false })
    if (this.stopped || this.interrupted) return
    const answered = produced !== undefined && produced.includes(`This answers the user's revision request ${req.requestId}`)
    await this.step({ type: 'text', text: answered ? mockReviseDone(req.requestId) : produced?.startsWith('REFUSED:') ? MOCK_REVISE_UNCHANGED : MOCK_REVISE_NOT_ANSWERED })
  }

  private async retireFactStep(step: Extract<MockStep, { type: 'retireFact' }>): Promise<void> {
    const got = await this.harnessStep({ type: 'harness', name: KNOWLEDGE_TOOL, args: { action: 'get', name: step.node } })
    if (this.stopped || this.interrupted) return
    const factId = got === undefined ? undefined : knowledgeFactId(got, step.fact)
    if (!factId) {
      this.log('info', `Mock: the fact "${step.fact}" of ${step.node} could not be read back from the knowledge graph, so the retire step is skipped.`)
      return
    }
    await this.harnessStep({ type: 'harness', name: KNOWLEDGE_TOOL, args: { action: 'retire', factId, ...(step.reason ? { reason: step.reason } : {}) } })
  }

  /** The harnessAnswer step: one call through the real harness tool (no REVISE retry), then the matching sentence. */
  private async harnessAnswerStep(step: MockHarnessAnswerStep): Promise<void> {
    const result = await this.harnessStep({ type: 'harness', name: step.name, args: step.args ?? {}, retryOnRevise: false })
    if (this.stopped || this.interrupted) return
    const answer = result === undefined ? undefined : step.answers.find((a) => result.startsWith(a.prefix))
    await this.step({ type: 'text', text: answer?.text ?? step.otherwise })
  }

  /** The firstProject step: list_projects, then `then` for the first project's id, or the `none` sentence. */
  private async firstProjectStep(step: MockFirstProjectStep): Promise<void> {
    const listed = await this.harnessStep({ type: 'harness', name: CHAT_HARNESS_TOOLS[0], args: {} })
    if (this.stopped || this.interrupted) return
    const projectId = listed === undefined ? undefined : firstProjectId(listed)
    if (!projectId) {
      this.log('info', 'Mock: list_projects named no project, so the project settings proposal is skipped.')
      await this.step({ type: 'text', text: step.none })
      return
    }
    await this.harnessAnswerStep({ ...step.then, args: { ...step.then.args, projectId } })
  }
}

/** Trigger token (Chat / quick runs, default script): look up the theme, open Appearance, propose the light theme (selfConfigSteps). */
export const SELF_CONFIG_TOKEN = '[mock:self-config]'
/** Trigger token (Chat / quick runs, default script): propose a $5 spend cap for the first listed project (selfConfigProjectSteps). */
export const SELF_CONFIG_PROJECT_TOKEN = '[mock:self-config-project]'
export const MOCK_SELF_CONFIG_LOOKUP = "Let me look that up in OrgAI's reference."
export const MOCK_SELF_CONFIG_DONE = 'Done: the theme is now light.'
export const MOCK_SELF_CONFIG_SAME = 'The theme is already light.'
export const MOCK_SELF_CONFIG_LEFT = 'Understood; I left the settings alone.'
export const MOCK_SELF_CONFIG_PROJECT_DONE = 'Done: that project now has a $5 cap from its next run.'
export const MOCK_SELF_CONFIG_PROJECT_LEFT = 'Understood; I left the project alone.'
export const MOCK_SELF_CONFIG_NO_PROJECT = 'You have no OrgAI projects yet.'

/**
 * The [mock:self-config] turn: app_reference locate "theme" (the text result is not read), open_in_app on
 * app-settings-general-appearance, then propose_app_settings appearance.theme = light. A result starting APPROVED says
 * MOCK_SELF_CONFIG_DONE, "Nothing to change" MOCK_SELF_CONFIG_SAME, anything else (REVISE, DECLINED, a refusal, the
 * tool's own unavailable text, an unbound tool) MOCK_SELF_CONFIG_LEFT. Every call goes through the real harness tool.
 */
export function selfConfigSteps(): MockStep[] {
  return [
    { type: 'text', text: MOCK_SELF_CONFIG_LOOKUP },
    { type: 'harness', name: APP_REFERENCE_TOOL, args: { action: 'locate', query: 'theme' } },
    { type: 'harness', name: OPEN_IN_APP_TOOL, args: { surfaceId: 'app-settings-general-appearance' } },
    {
      type: 'harnessAnswer',
      name: PROPOSE_APP_SETTINGS_TOOL,
      args: { title: 'Switch to the light theme', rationale: 'You asked for a lighter look.', changes: [{ field: 'appearance.theme', value: 'light' }] },
      answers: [
        { prefix: 'APPROVED', text: MOCK_SELF_CONFIG_DONE },
        { prefix: 'Nothing to change', text: MOCK_SELF_CONFIG_SAME }
      ],
      otherwise: MOCK_SELF_CONFIG_LEFT
    }
  ]
}

/**
 * The [mock:self-config-project] turn: list_projects, then propose_project_settings maxBudgetUsd 5 for the first
 * project's id (MOCK_SELF_CONFIG_PROJECT_DONE on APPROVED, else MOCK_SELF_CONFIG_PROJECT_LEFT), or
 * MOCK_SELF_CONFIG_NO_PROJECT when the list names none.
 */
export function selfConfigProjectSteps(): MockStep[] {
  return [
    {
      type: 'firstProject',
      none: MOCK_SELF_CONFIG_NO_PROJECT,
      then: {
        type: 'harnessAnswer',
        name: PROPOSE_PROJECT_SETTINGS_TOOL,
        args: { title: 'Cap the spend', rationale: 'A small cap for a test project.', maxBudgetUsd: 5 },
        answers: [{ prefix: 'APPROVED', text: MOCK_SELF_CONFIG_PROJECT_DONE }],
        otherwise: MOCK_SELF_CONFIG_PROJECT_LEFT
      }
    }
  ]
}

/** The self-configuration marker's first turn for a quick run's prompt, or null when neither marker is set. */
export function selfConfigMarkerSteps(prompt: string): MockStep[] | null {
  if (prompt.includes(SELF_CONFIG_PROJECT_TOKEN)) return selfConfigProjectSteps()
  if (prompt.includes(SELF_CONFIG_TOKEN)) return selfConfigSteps()
  return null
}

/**
 * The id of the first project in a list_projects result: the `id=<id>` field of the first line inside `<projects>`
 * (fields are joined by " | "). undefined when the block is missing or empty (no projects, the tool unavailable).
 */
export function firstProjectId(result: string): string | undefined {
  const lines = result.split('\n')
  const open = lines.indexOf('<projects>')
  if (open < 0) return undefined
  const line = lines[open + 1]
  if (line === undefined || line === '</projects>') return undefined
  const m = /(?:^| \| )id=([A-Za-z0-9_-]+)(?: \||$)/.exec(line)
  return m?.[1]
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
    if (input.prompt.includes(AUTH_FAIL_TOKEN)) throw new Error(authFailureMessage(input.connection?.connection, input.connection?.name))
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
