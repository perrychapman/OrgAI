/**
 * `orgai decide <requestId> <verb> [options]` (cli-spec 3.4(4), 5.3, 6.3(3)): resolve one pending decision card.
 *
 * The host is never started: pending cards live only in a running host's memory. The request id is looked up through
 * the socket-only runs:findDecision channel (pending cards plus RunManager's resolved-card tombstones), the card is
 * read from runs:pendingCards, the verb is checked against the card's kind, and the exact decision channel and payload
 * of cli-spec 5.3 is called with `expectedRevision` (--revision, else the lookup's revision), so a card that changed
 * since the user read it is refused by the host as 'stale-revision'.
 *
 * Verbs per kind:
 * - permission: allow | allow-session | allow-project (durable) | deny
 * - rules: grant | grant-project (durable) | deny
 * - proposal: approve | revise | decline
 * - question: answer
 * - merge: merge | hold | discard (durable)
 * - mcpInstall: allow | save-project (durable) | save-library (durable) | deny
 *
 * A durable verb needs --yes, or a y/N answer on /dev/tty when stdin and stdout are terminals. Secret values come only
 * from the environment (`--secret NAME=ENV_VAR`), are never accepted on argv and never printed.
 *
 * Exit codes: 0 applied; 1 already resolved, cancelled, stale revision, declined confirmation or no host; 2 not found,
 * a verb the card does not take, a missing --yes / env var / flag value.
 */
import {
  proposalSecretKey,
  type CardKind,
  type DecisionLookup,
  type DecisionOutcome,
  type DecidedBy,
  type McpInstallDecision,
  type MergeReview,
  type McpInstallRequest,
  type PendingCards,
  type PermissionDecision,
  type PermissionRequest,
  type PermissionRuleDecision,
  type PermissionRuleRequest,
  type Proposal,
  type ProposalDecision,
  type QuestionAnswer,
  type UserQuestion
} from '../../shared/types'
import { missingScopesError } from '../client/ensureHost'
import { consumeSecretEnv } from '../client/launcher'
import { parseFlags, type FlagValues } from '../flags'
import { manageDeps } from '../manage'
import { emit, isJsonOutput, safeLine, type Json } from '../output'
import { warnVersionSkew } from '../runRef'
import { CliError, EXIT, type CliContext, type CommandFn, type ConnectResult, type HostCallError, type HostClient } from '../types'

export const NO_HOST_FOR_DECIDE = 'No OrgAI host is running; pending decisions live only in a running host.'
export const STALE_CARD = 'The card changed; run orgai inbox again'

/** The verbs each card kind takes, in the order help lists them. */
export const DECIDE_VERBS: Readonly<Record<CardKind, readonly string[]>> = {
  permission: ['allow', 'allow-session', 'allow-project', 'deny'],
  rules: ['grant', 'grant-project', 'deny'],
  proposal: ['approve', 'revise', 'decline'],
  question: ['answer'],
  merge: ['merge', 'hold', 'discard'],
  mcpInstall: ['allow', 'save-project', 'save-library', 'deny']
}

/** Verbs that change something beyond this run (or throw work away): they need --yes or a terminal confirmation. */
const DURABLE: Readonly<Record<CardKind, Readonly<Record<string, string>>>> = {
  permission: { 'allow-project': 'Always allow this for the project (saved to its permission rules)?' },
  rules: { 'grant-project': 'Grant these rules for the project (saved to its permission rules)?' },
  proposal: {},
  question: {},
  merge: { discard: "Discard this agent's worktree and its changes?" },
  mcpInstall: {
    'save-project': 'Install this MCP server and save it to the project?',
    'save-library': 'Install this MCP server and save it to the app-wide library?'
  }
}

const KIND_LABEL: Record<CardKind, string> = {
  permission: 'permission',
  rules: 'rule request',
  proposal: 'proposal',
  question: 'question',
  merge: 'merge review',
  mcpInstall: 'MCP install'
}

/** An environment variable name (POSIX-ish; also covers Windows names without odd characters). */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

/** Replaceable for tests: the y/N confirmation a durable verb asks on the terminal (manage.ts by default). */
export const decideDeps = {
  confirm: (question: string): Promise<boolean> => manageDeps.ttyConfirm(question)
}

/** Who resolved a card, in words. */
export function surfaceText(by: DecidedBy | undefined): string {
  if (!by) return 'another window'
  const where = by.surface === 'desktop' ? 'the OrgAI app' : by.surface === 'tui' ? 'the terminal UI' : by.surface === 'cli' ? 'the CLI' : 'the headless decision policy'
  return by.reportedPid !== undefined && Number.isInteger(by.reportedPid) ? `${where} (pid ${by.reportedPid})` : where
}

const flagSpec = {
  revision: { type: 'string' },
  yes: { type: 'boolean', short: 'y' },
  message: { type: 'string' },
  note: { type: 'string' },
  secret: { type: 'string', multiple: true },
  option: { type: 'string', multiple: true },
  pick: { type: 'string', multiple: true },
  text: { type: 'string' }
} as const

type DecideFlags = FlagValues<typeof flagSpec>

/** connect with ['read', 'decide']; never starts a host. */
async function connectForDecide(ctx: CliContext): Promise<HostClient> {
  const res: ConnectResult = await ctx.connect(['read', 'decide'], { clientKind: 'cli', waitStartingMs: 2000 })
  if (res.ok) {
    warnVersionSkew(ctx, res.client)
    // 'decide' needs Terminal access set to full in the OrgAI window (review H2); say so before reading any card.
    const missing = missingScopesError(res.client, ['read', 'decide'])
    if (missing) {
      res.client.close()
      throw missing
    }
    return res.client
  }
  if (res.reason === 'no_host') throw new CliError(NO_HOST_FOR_DECIDE, EXIT.failure)
  if (res.reason === 'auth_failed') throw new CliError(safeLine(res.message) || 'The OrgAI host refused the handshake.', EXIT.auth)
  if (res.reason === 'starting' || res.reason === 'draining') {
    throw new CliError(res.reason === 'starting' ? 'OrgAI is still starting; try again in a moment.' : 'OrgAI is shutting down; pending decisions end with it.', EXIT.hostBusy)
  }
  throw new CliError(safeLine(res.message) || `Could not connect to the OrgAI host (${res.reason}).`, EXIT.failure)
}

/** A host RPC failure as a CliError (exit 1, sanitized message). */
function hostFailure(e: unknown): CliError {
  if (e instanceof CliError) return e
  const data = (e as Partial<HostCallError>)?.data
  const message = data?.message ?? (e instanceof Error ? e.message : String(e))
  return new CliError(safeLine(message) || 'The OrgAI host refused the decision.', EXIT.failure)
}

function cardOf(cards: Partial<PendingCards> | undefined, kind: CardKind, id: string): unknown {
  const c = cards ?? {}
  const list: { id: string }[] | undefined =
    kind === 'permission' ? c.permissions
    : kind === 'rules' ? c.ruleRequests
    : kind === 'proposal' ? c.proposals
    : kind === 'question' ? c.questions
    : kind === 'merge' ? c.mergeReviews
    : c.mcpInstalls
  return Array.isArray(list) ? list.find((x) => x && x.id === id) : undefined
}

/** `--secret NAME=ENV_VAR` specs read from the environment; a missing or empty variable is a usage error. */
function readSecrets(ctx: CliContext, specs: readonly string[] | undefined, known: readonly string[]): Record<string, string> | undefined {
  if (!specs || specs.length === 0) return undefined
  const out: Record<string, string> = {}
  for (const spec of specs) {
    const eq = spec.lastIndexOf('=')
    const name = eq > 0 ? spec.slice(0, eq) : ''
    const envVar = eq > 0 ? spec.slice(eq + 1) : ''
    if (!name || !ENV_NAME_RE.test(envVar)) {
      throw new CliError('--secret takes NAME=ENV_VAR: the value is read from that environment variable, never from the command line.', EXIT.usage)
    }
    if (!known.includes(name)) {
      throw new CliError(
        known.length ? `This card has no secret "${safeLine(name)}". Its secrets: ${known.map(safeLine).join(', ')}.` : 'This card takes no secrets.',
        EXIT.usage
      )
    }
    // Taken out of the environment once read (review M13).
    const value = consumeSecretEnv(ctx.env, envVar)
    if (value === undefined || value === '') throw new CliError(`The environment variable ${envVar} (for --secret ${safeLine(name)}) is not set or empty.`, EXIT.usage)
    out[name] = value
  }
  return out
}

/** The selected labels from --option and --pick, checked against the question. */
function questionAnswer(q: UserQuestion, f: DecideFlags): QuestionAnswer {
  const options = Array.isArray(q.options) ? q.options : []
  const labels = options.map((o) => o.label)
  const selected: string[] = []
  const add = (label: string): void => {
    if (!selected.includes(label)) selected.push(label)
  }
  for (const raw of f.option ?? []) {
    if (!labels.includes(raw)) {
      throw new CliError(
        labels.length ? `"${safeLine(raw)}" is not an option. The options: ${labels.map((l) => `"${safeLine(l)}"`).join(', ')}.` : 'This question offers no options; use --text.',
        EXIT.usage
      )
    }
    add(raw)
  }
  for (const raw of f.pick ?? []) {
    const n = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN
    if (!Number.isInteger(n) || n < 1 || n > labels.length) {
      throw new CliError(labels.length ? `--pick takes a number from 1 to ${labels.length}.` : 'This question offers no options; use --text.', EXIT.usage)
    }
    add(labels[n - 1])
  }
  if (!q.allowMultiple && selected.length > 1) throw new CliError('This question takes one option; give one --option or --pick.', EXIT.usage)
  const text = f.text
  if (text !== undefined && !q.allowFreeText) throw new CliError('This question does not take free text; use --option or --pick.', EXIT.usage)
  if (selected.length === 0 && (text === undefined || text.trim() === '')) {
    throw new CliError(q.allowFreeText ? 'Give an answer: --option, --pick or --text.' : 'Give an answer: --option or --pick.', EXIT.usage)
  }
  return text !== undefined && text !== '' ? { selected, text } : { selected }
}

interface DecisionCall {
  channel: string
  payload: Record<string, unknown>
}

/** The exact channel and payload of cli-spec 5.3 for this card, verb and flags. */
export function buildDecision(ctx: CliContext, kind: CardKind, card: unknown, verb: string, f: DecideFlags, runId: string, requestId: string, expectedRevision: number): DecisionCall {
  const noSecrets = (): void => {
    if (f.secret && f.secret.length > 0) throw new CliError(`--secret does not apply to ${verb} on a ${KIND_LABEL[kind]}.`, EXIT.usage)
  }
  const noAnswerFlags = (): void => {
    if ((f.option && f.option.length) || (f.pick && f.pick.length) || f.text !== undefined) {
      throw new CliError('--option, --pick and --text only answer a question.', EXIT.usage)
    }
  }
  if (kind !== 'question') noAnswerFlags()
  switch (kind) {
    case 'permission': {
      noSecrets()
      const decision: PermissionDecision =
        verb === 'deny' ? { behavior: 'deny', message: f.message && f.message.trim() ? f.message : 'Denied by user' }
        : { behavior: 'allow', scope: verb === 'allow-project' ? 'project' : verb === 'allow-session' ? 'session' : 'once' }
      return { channel: 'runs:decide', payload: { runId, requestId, expectedRevision, decision } }
    }
    case 'rules': {
      noSecrets()
      const message = f.message ?? f.note
      const decision: PermissionRuleDecision =
        verb === 'deny' ? (message !== undefined && message.trim() ? { behavior: 'deny', message } : { behavior: 'deny' })
        : { behavior: 'grant', scope: verb === 'grant-project' ? 'project' : 'run' }
      return { channel: 'permissions:decideRequest', payload: { runId, requestId, expectedRevision, decision } }
    }
    case 'proposal': {
      const p = card as Proposal
      let decision: ProposalDecision
      if (verb === 'approve') {
        const slots = p.kind === 'mcpServers' ? (p.payload.secrets ?? []).map((s) => proposalSecretKey(s)) : []
        const secrets = readSecrets(ctx, f.secret, slots)
        decision = secrets ? { behavior: 'approve', secrets } : { behavior: 'approve' }
      } else if (verb === 'revise') {
        noSecrets()
        const feedback = f.note ?? f.message
        if (feedback === undefined || !feedback.trim()) throw new CliError('revise needs --note "<what to change>".', EXIT.usage)
        decision = { behavior: 'revise', feedback }
      } else {
        noSecrets()
        const note = f.note ?? f.message
        decision = note !== undefined && note.trim() ? { behavior: 'decline', note } : { behavior: 'decline' }
      }
      return { channel: 'setup:decide', payload: { runId, proposalId: requestId, expectedRevision, decision } }
    }
    case 'question': {
      noSecrets()
      return { channel: 'setup:answer', payload: { runId, questionId: requestId, expectedRevision, answer: questionAnswer(card as UserQuestion, f) } }
    }
    case 'merge': {
      noSecrets()
      const behavior = verb as 'merge' | 'hold' | 'discard'
      return { channel: 'merges:decide', payload: { runId, reviewId: requestId, expectedRevision, decision: { behavior } } }
    }
    case 'mcpInstall': {
      const req = card as McpInstallRequest
      const approved = verb !== 'deny'
      const scope: McpInstallDecision['scope'] = verb === 'save-project' ? 'project' : verb === 'save-library' ? 'library' : 'run'
      const decision: McpInstallDecision = { approved, scope }
      const note = f.note ?? (verb === 'deny' ? f.message : undefined)
      if (note !== undefined && note.trim()) decision.note = note
      if (approved) {
        const secrets = readSecrets(ctx, f.secret, Array.isArray(req.requiredSecrets) ? req.requiredSecrets : [])
        if (secrets) decision.secrets = secrets
      } else noSecrets()
      return { channel: 'mcp:answerInstall', payload: { runId, requestId, expectedRevision, decision } }
    }
  }
}

/** What the card asks, in one line (text output only). */
function cardLine(kind: CardKind, card: unknown): string {
  switch (kind) {
    case 'permission': {
      const c = card as PermissionRequest
      return `${KIND_LABEL[kind]}: ${safeLine(c.toolName)}`
    }
    case 'rules':
      return `${KIND_LABEL[kind]}: ${(card as PermissionRuleRequest).rules?.map(safeLine).join(', ') ?? ''}`
    case 'proposal':
      return `${KIND_LABEL[kind]}: ${safeLine((card as Proposal).title)}`
    case 'question':
      return `${KIND_LABEL[kind]}: ${safeLine((card as UserQuestion).question)}`
    case 'merge':
      return `${KIND_LABEL[kind]}: ${safeLine((card as MergeReview).branch)}`
    case 'mcpInstall':
      return `${KIND_LABEL[kind]}: ${safeLine((card as McpInstallRequest).spec?.name ?? '')}`
  }
}

/** Exit code of a DecisionOutcome status. */
export function outcomeExit(status: DecisionOutcome['status']): number {
  if (status === 'applied') return EXIT.ok
  if (status === 'not-found') return EXIT.usage
  return EXIT.failure
}

/** The text lines of an outcome. */
function outcomeLines(o: DecisionOutcome, kind: CardKind | undefined): string[] {
  const what = kind ? `${KIND_LABEL[kind]} ${safeLine(o.requestId)}` : safeLine(o.requestId)
  switch (o.status) {
    case 'applied': {
      const lines = [`Decided ${what}: ${safeLine(o.effectiveDecision ?? 'done')}.`]
      if (o.applyError) lines.push(`It could not be applied: ${safeLine(o.applyError)}. The agent was asked to revise.`)
      return lines
    }
    case 'already-resolved':
      return [`Already decided${o.effectiveDecision ? ` (${safeLine(o.effectiveDecision)})` : ''}. Resolved by ${surfaceText(o.decidedBy)}.`]
    case 'cancelled':
      return [o.decidedBy ? `Cancelled. Resolved by ${surfaceText(o.decidedBy)}.` : `The ${kind ? KIND_LABEL[kind] : 'decision'} was cancelled; its run ended or moved on.`]
    case 'stale-revision':
      return [`${STALE_CARD}.`]
    case 'not-found':
      return [`No pending decision ${safeLine(o.requestId)}.`]
  }
}

/** Print an outcome in the chosen format and return its exit code. Text failures go to stderr. */
function report(ctx: CliContext, requestId: string, kind: CardKind | undefined, outcome: DecisionOutcome): number {
  const code = outcomeExit(outcome.status)
  const value: Json = { requestId, kind: kind ?? null, outcome }
  if (isJsonOutput(ctx)) {
    emit(ctx, value, () => [])
    return code
  }
  const lines = outcomeLines(outcome, kind)
  if (code === EXIT.ok) emit(ctx, value, () => lines)
  else ctx.io.stderr.write(`${lines.join('\n')}\n`)
  return code
}

/** A host answer as a DecisionOutcome; an older host answering nothing counts as applied with the verb sent. */
function asOutcome(raw: unknown, requestId: string, runId: string, sent: string): DecisionOutcome {
  if (raw && typeof raw === 'object' && typeof (raw as DecisionOutcome).status === 'string') {
    const o = raw as DecisionOutcome
    if (['applied', 'already-resolved', 'stale-revision', 'cancelled', 'not-found'].includes(o.status)) return { ...o, requestId: o.requestId || requestId }
  }
  return { status: 'applied', runId, requestId, effectiveDecision: sent }
}

/** The effective decision word a payload asks for (the fallback for a host that answers nothing). */
function sentWord(kind: CardKind, verb: string): string {
  if (kind === 'permission') return verb === 'deny' ? 'deny' : 'allow'
  if (kind === 'rules') return verb === 'deny' ? 'deny' : 'grant'
  if (kind === 'question') return 'answer'
  if (kind === 'mcpInstall') return verb === 'deny' ? 'deny' : 'allow'
  return verb
}

export const runDecide: CommandFn = async (ctx: CliContext, args: string[]): Promise<number> => {
  const { values: f, positionals } = parseFlags(args, flagSpec)
  if (positionals.length !== 2) {
    throw new CliError('Use: orgai decide <requestId> <verb> [options]. Run orgai inbox to see the open decisions.', EXIT.usage)
  }
  const [requestId, verbRaw] = positionals
  if (!REQUEST_ID_RE.test(requestId)) throw new CliError(`"${safeLine(requestId.slice(0, 64))}" is not a request id.`, EXIT.usage)
  const verb = verbRaw.trim().toLowerCase()
  let revisionFlag: number | undefined
  if (f.revision !== undefined) {
    if (!/^\d{1,9}$/.test(f.revision.trim())) throw new CliError('--revision needs a whole number.', EXIT.usage)
    revisionFlag = Number(f.revision.trim())
  }

  const client = await connectForDecide(ctx)
  try {
    const lookup = await client.call<DecisionLookup>('runs:findDecision', [requestId]).catch((e: unknown) => {
      throw hostFailure(e)
    })
    if (!lookup || typeof lookup !== 'object' || lookup.status === 'not-found') {
      return report(ctx, requestId, undefined, { status: 'not-found', requestId })
    }
    if (lookup.status === 'applied' || lookup.status === 'cancelled') {
      return report(ctx, requestId, lookup.kind, {
        status: lookup.status === 'applied' ? 'already-resolved' : 'cancelled',
        runId: lookup.runId,
        requestId,
        ...(lookup.effectiveDecision ? { effectiveDecision: lookup.effectiveDecision } : {}),
        ...(lookup.decidedBy ? { decidedBy: lookup.decidedBy } : {})
      })
    }
    if (lookup.status !== 'pending') return report(ctx, requestId, undefined, { status: 'not-found', requestId })
    const kind = lookup.kind
    const verbs = DECIDE_VERBS[kind]
    if (!verbs) throw new CliError(`Unknown decision kind "${safeLine(kind)}".`, EXIT.failure)
    if (!verbs.includes(verb)) {
      throw new CliError(`"${safeLine(verbRaw)}" does not answer a ${KIND_LABEL[kind]}. Use one of: ${verbs.join(', ')}.`, EXIT.usage)
    }
    const cards = await client.call<PendingCards>('runs:pendingCards', [lookup.runId]).catch((e: unknown) => {
      throw hostFailure(e)
    })
    const card = cardOf(cards, kind, requestId)
    if (!card) return report(ctx, requestId, kind, { status: 'stale-revision', runId: lookup.runId, requestId })
    const expectedRevision = revisionFlag ?? lookup.revision
    const call = buildDecision(ctx, kind, card, verb, f, lookup.runId, requestId, expectedRevision)

    const durable = DURABLE[kind][verb]
    if (durable && !f.yes) {
      if (!(ctx.io.stdinIsTTY && ctx.io.stdout.isTTY)) throw new CliError(`${verb} is saved beyond this run; add --yes to confirm it.`, EXIT.usage)
      if (!isJsonOutput(ctx)) ctx.io.stderr.write(`${cardLine(kind, card)}\n`)
      if (!(await decideDeps.confirm(durable))) throw new CliError('Not confirmed; nothing was decided.', EXIT.failure)
    }

    const raw = await client.call<unknown>(call.channel, [call.payload], { timeoutMs: 120_000 }).catch((e: unknown) => {
      throw hostFailure(e)
    })
    return report(ctx, requestId, kind, asOutcome(raw, requestId, lookup.runId, sentWord(kind, verb)))
  } finally {
    client.close()
  }
}
