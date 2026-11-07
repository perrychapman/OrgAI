/**
 * Decision tray actions to the exact cli-spec 5.3 payloads (W4-T2), plus the card text the tray and the inline
 * scrollback show. Pure: no React, no I/O.
 *
 * The payloads match src/shared/types.ts and `orgai decide`'s buildDecision (src/cli/commands/decide.ts), which is the
 * code truth where the spec table differs: a proposal revise sends `feedback`, a rules deny sends `message`. Every
 * payload carries `expectedRevision: card.ref.revision`, so a card that changed after the user read it is refused by
 * the host as 'stale-revision'.
 *
 * Every string from a card is untrusted (agent text): it is passed through showHidden (hidden, bidi and control
 * characters become visible \uXXXX escapes and the line is badged) and sanitizeTty before it is returned.
 */
import {
  proposalSecretKey,
  type McpInstallDecision,
  type McpProposalServer,
  type PermissionDecision,
  type PermissionRuleDecision,
  type Proposal,
  type ProposalDecision,
  type QuestionAnswer
} from '../../shared/types'
import { installTitle, mergeTitle, oneLine, permissionTitle, proposalKindLabel, proposalTitle, questionTitle, rulesTitle } from '../../shared/view/decisionTitle'
import { hasHidden, showHidden } from '../../shared/view/hiddenChars'
import {
  diffMcpProposal,
  effectLine,
  proposalEffectCopy,
  proposalScope,
  proposalTarget,
  secretsLine,
  targetText,
  uniqueSecretSlots,
  upsertAction
} from '../../shared/view/mcpProposal'
import { pinnedVersionOf } from '../../shared/view/mcpVersion'
import { collapseRules, noRuleLine, permissionOffer, referenceEffect, referenceLocation, ruleChip } from '../../shared/view/permissionCopy'
import { graphemes, graphemeWidth, textWidth } from './panes/text'
import { sanitizeTty } from './sanitizeTty'
import type { DecisionCall, TrayCard } from './types'

export type TrayAction =
  | { kind: 'permission'; act: 'allow-once' | 'allow-session' | 'allow-project' }
  | { kind: 'permission'; act: 'deny'; message?: string }
  | { kind: 'rules'; act: 'grant-run' | 'grant-project' }
  | { kind: 'rules'; act: 'deny'; message?: string }
  | { kind: 'proposal'; act: 'approve'; secrets?: Record<string, string> }
  | { kind: 'proposal'; act: 'revise'; feedback: string }
  | { kind: 'proposal'; act: 'decline'; note?: string }
  | { kind: 'question'; act: 'answer'; selected: string[]; text?: string }
  | { kind: 'merge'; act: 'merge' | 'hold' | 'discard' }
  | { kind: 'mcpInstall'; act: 'allow-run' | 'save-project' | 'save-library'; secrets?: Record<string, string>; note?: string }
  | { kind: 'mcpInstall'; act: 'deny'; note?: string }

/** One key binding shown on a card. */
export interface TrayBinding {
  key: string
  label: string
  act: string
  /** Needs a second confirming key press bound to the same card key. */
  twoStep?: boolean
  /** The action takes a typed note. */
  text?: 'optional' | 'required'
}

/** The default deny message of a permission card (cli-spec 5.3: the TUI defaults it when left blank). */
export const DEFAULT_DENY_MESSAGE = 'Denied by user'

/** At most this many question options get a digit key. */
const QUESTION_KEYS_MAX = 9

// ---------- Secret slots ----------

/** A secret the tray collects before it sends an action: the payload key and a label to show. */
export interface SecretSlotView {
  key: string
  label: string
  description?: string
}

/** The secret slots an action of this card can carry (mcpServers proposals and MCP installs), deduplicated. */
export function secretSlotsFor(card: TrayCard): SecretSlotView[] {
  if (card.kind === 'proposal') {
    const p = card.card
    if (p.kind !== 'mcpServers') return []
    return uniqueSecretSlots(p.payload).map(({ slot }) => ({
      key: proposalSecretKey(slot),
      label: oneText(`${slot.name} (${slot.kind === 'header' ? 'header' : 'env'}, ${slot.serverId})`, 120),
      ...(slot.description ? { description: oneText(slot.description, 200) } : {})
    }))
  }
  if (card.kind === 'mcpInstall') {
    const names = Array.isArray(card.card.requiredSecrets) ? card.card.requiredSecrets : []
    const seen = new Set<string>()
    const out: SecretSlotView[] = []
    for (const n of names) {
      if (typeof n !== 'string' || seen.has(n)) continue
      seen.add(n)
      out.push({ key: n, label: oneText(n, 120) })
    }
    return out
  }
  return []
}

// ---------- Bindings ----------

export function bindingsFor(card: TrayCard): TrayBinding[] {
  switch (card.kind) {
    case 'permission': {
      const offer = permissionOffer(card.card)
      const out: TrayBinding[] = [{ key: 'y', label: 'Allow once', act: 'allow-once' }]
      if (offer.canScope) {
        out.push({ key: 's', label: 'Allow for session', act: 'allow-session' })
        out.push({ key: 'a', label: 'Always allow for project', act: 'allow-project', twoStep: true })
      }
      out.push({ key: 'n', label: 'Deny', act: 'deny', text: 'optional' })
      out.push({ key: 'v', label: 'Full view', act: 'view' })
      return out
    }
    case 'rules':
      return [
        { key: 'r', label: 'Grant for run', act: 'grant-run' },
        { key: 'a', label: 'Always grant for project', act: 'grant-project', twoStep: true },
        { key: 'n', label: 'Deny', act: 'deny', text: 'optional' }
      ]
    case 'proposal': {
      const out: TrayBinding[] = [{ key: 'y', label: 'Approve', act: 'approve' }]
      if (secretSlotsFor(card).length > 0) out.push({ key: 's', label: 'Enter secrets', act: 'secrets' })
      out.push({ key: 'e', label: 'Revise', act: 'revise', text: 'required' })
      if (card.runKind === 'work') out.push({ key: 'd', label: 'Decline', act: 'decline', text: 'optional' })
      out.push({ key: 'v', label: 'View full text', act: 'view' })
      return out
    }
    case 'question': {
      const q = card.card
      const options = Array.isArray(q.options) ? q.options.slice(0, QUESTION_KEYS_MAX) : []
      const out: TrayBinding[] = options.map((o, i) => ({ key: String(i + 1), label: oneText(o?.label, 40), act: 'pick' }))
      if (q.allowMultiple) out.push({ key: 'space', label: 'Toggle', act: 'toggle' })
      if (options.length > 0) out.push({ key: 'enter', label: 'Submit', act: 'submit' })
      if (q.allowFreeText) out.push({ key: 'c', label: 'Custom answer', act: 'custom', text: 'required' })
      return out
    }
    case 'merge':
      return [
        { key: 'v', label: 'View diff', act: 'view' },
        { key: 'm', label: 'Merge', act: 'merge' },
        { key: 'h', label: 'Hold (keep branch)', act: 'hold' },
        { key: 'x', label: 'Discard', act: 'discard', twoStep: true }
      ]
    case 'mcpInstall':
      return [
        { key: 'r', label: 'Allow for run', act: 'allow-run' },
        { key: 'p', label: 'Save to project', act: 'save-project', twoStep: true },
        { key: 'l', label: 'Save to library', act: 'save-library', twoStep: true },
        { key: 'n', label: 'Deny', act: 'deny', text: 'optional' }
      ]
  }
}

/** The confirmation question of a two-step binding. */
export function confirmQuestion(card: TrayCard, b: TrayBinding): string {
  switch (b.act) {
    case 'allow-project':
      return 'Always allow for project (saved to permission rules)?'
    case 'grant-project':
      return 'Always grant these rules for the project (saved to permission rules)?'
    case 'discard':
      return "Discard this agent's worktree and its changes?"
    case 'save-project':
      return 'Install this MCP server and save it to the project?'
    case 'save-library':
      return 'Install this MCP server and save it to the app-wide library?'
    default:
      return `${b.label} (${cardTitle(card)})?`
  }
}

// ---------- Payloads ----------

function blank(s: string | undefined): boolean {
  return s === undefined || s.trim() === ''
}

function cleanSecrets(secrets: Record<string, string> | undefined, allowed: readonly string[]): Record<string, string> | undefined {
  if (!secrets) return undefined
  const out: Record<string, string> = {}
  for (const k of allowed) {
    const v = secrets[k]
    if (typeof v === 'string' && v !== '') out[k] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export function decisionFor(card: TrayCard, action: TrayAction): DecisionCall {
  if (card.kind !== action.kind) throw new Error(`A ${action.kind} action cannot answer a ${card.kind} card.`)
  const runId = card.ref.runId
  const requestId = card.ref.requestId
  const expectedRevision = card.ref.revision
  switch (action.kind) {
    case 'permission': {
      const decision: PermissionDecision =
        action.act === 'deny'
          ? { behavior: 'deny', message: blank(action.message) ? DEFAULT_DENY_MESSAGE : (action.message as string) }
          : { behavior: 'allow', scope: action.act === 'allow-project' ? 'project' : action.act === 'allow-session' ? 'session' : 'once' }
      return { channel: 'runs:decide', payload: { runId, requestId, expectedRevision, decision } }
    }
    case 'rules': {
      const decision: PermissionRuleDecision =
        action.act === 'deny'
          ? blank(action.message)
            ? { behavior: 'deny' }
            : { behavior: 'deny', message: action.message as string }
          : { behavior: 'grant', scope: action.act === 'grant-project' ? 'project' : 'run' }
      return { channel: 'permissions:decideRequest', payload: { runId, requestId, expectedRevision, decision } }
    }
    case 'proposal': {
      let decision: ProposalDecision
      if (action.act === 'approve') {
        const secrets = cleanSecrets(action.secrets, secretSlotsFor(card).map((s) => s.key))
        decision = secrets ? { behavior: 'approve', secrets } : { behavior: 'approve' }
      } else if (action.act === 'revise') {
        if (blank(action.feedback)) throw new Error('Revise needs feedback.')
        decision = { behavior: 'revise', feedback: action.feedback }
      } else {
        decision = blank(action.note) ? { behavior: 'decline' } : { behavior: 'decline', note: action.note as string }
      }
      return { channel: 'setup:decide', payload: { runId, proposalId: requestId, expectedRevision, decision } }
    }
    case 'question': {
      const answer: QuestionAnswer = blank(action.text) ? { selected: [...action.selected] } : { selected: [...action.selected], text: action.text as string }
      return { channel: 'setup:answer', payload: { runId, questionId: requestId, expectedRevision, answer } }
    }
    case 'merge':
      return { channel: 'merges:decide', payload: { runId, reviewId: requestId, expectedRevision, decision: { behavior: action.act } } }
    case 'mcpInstall': {
      const approved = action.act !== 'deny'
      const scope: McpInstallDecision['scope'] = action.act === 'save-project' ? 'project' : action.act === 'save-library' ? 'library' : 'run'
      const decision: McpInstallDecision = { approved, scope }
      if (!blank(action.note)) decision.note = action.note as string
      if (action.act !== 'deny') {
        const secrets = cleanSecrets(action.secrets, secretSlotsFor(card).map((s) => s.key))
        if (secrets) decision.secrets = secrets
      }
      return { channel: 'mcp:answerInstall', payload: { runId, requestId, expectedRevision, decision } }
    }
  }
}

// ---------- Text ----------

const HIDDEN_BADGE = '[hidden characters shown as \\u escapes]'

/** Untrusted multi-line text: hidden characters made visible, then sanitized (newlines kept). */
function text(s: unknown): string {
  const raw = typeof s === 'string' ? s : s === undefined || s === null ? '' : String(s)
  return sanitizeTty(showHidden(raw.replace(/\r\n?/g, '\n')))
}

/** Untrusted one-line text, clipped. */
function oneText(s: unknown, max = 200): string {
  return oneLine(text(s), max)
}

/** Whether any string in the value tree holds a hidden character (bounded walk). */
function anyHidden(v: unknown, depth = 0): boolean {
  if (depth > 6) return false
  if (typeof v === 'string') return hasHidden(v)
  if (Array.isArray(v)) return v.some((x) => anyHidden(x, depth + 1))
  if (v && typeof v === 'object') return Object.entries(v).some(([k, x]) => hasHidden(k) || anyHidden(x, depth + 1))
  return false
}

export function cardTitle(card: TrayCard): string {
  switch (card.kind) {
    case 'permission':
      return oneText(permissionTitle(String(card.card.toolName ?? ''), card.card.input))
    case 'rules': {
      const rules = Array.isArray(card.card.rules) ? card.card.rules.filter((r) => typeof r === 'string') : []
      const flagged = Array.isArray(card.card.flagged) ? card.card.flagged.length : 0
      return oneText(rulesTitle(rules, flagged))
    }
    case 'proposal': {
      const p = card.card
      if (p.kind === 'architecture' && card.projectKind === 'engagement') return 'Approve engagement plan'
      return oneText(proposalTitle(p.kind))
    }
    case 'question':
      return oneText(questionTitle(String(card.card.question ?? '')))
    case 'merge':
      return oneText(mergeTitle(String(card.card.agentName ?? 'an agent')))
    case 'mcpInstall':
      return oneText(installTitle(String(card.card.spec?.name ?? 'an MCP server')))
  }
}

/** Short kind word for headers ("permission", "proposal" ...). */
export function cardKindWord(card: TrayCard): string {
  switch (card.kind) {
    case 'permission':
      return 'permission'
    case 'rules':
      return 'rule request'
    case 'proposal':
      return `${proposalKindLabel(card.card.kind, card.projectKind).toLowerCase()} proposal`
    case 'question':
      return 'question'
    case 'merge':
      return 'merge review'
    case 'mcpInstall':
      return 'MCP install'
  }
}

/** The most characters of a tool input the full view (v) carries. */
export const INPUT_FULL_MAX = 65536
/** The most characters of a tool input the card itself shows before cutting with "...". */
const INPUT_CARD_MAX = 600

function inputText(input: unknown, full: boolean): string {
  try {
    const s = JSON.stringify(input)
    if (s === undefined) return ''
    const max = full ? INPUT_FULL_MAX : INPUT_CARD_MAX
    if (s.length <= max) return s
    return full ? `${s.slice(0, max)} (cut at ${max} characters)` : `${s.slice(0, max - 3)}...`
  } catch {
    return ''
  }
}

function permissionLines(card: Extract<TrayCard, { kind: 'permission' }>, full = false): string[] {
  const c = card.card
  const out: string[] = []
  const tool = String(c.toolName ?? '')
  const o = c.input && typeof c.input === 'object' ? (c.input as Record<string, unknown>) : {}
  if (c.summary) out.push(text(c.summary))
  if ((tool === 'Bash' || tool === 'PowerShell') && typeof o.command === 'string') out.push(`Command: ${text(o.command)}`)
  else {
    const file = [o.file_path, o.notebook_path, o.path].find((x) => typeof x === 'string')
    if (typeof file === 'string') out.push(`File: ${text(file)}`)
    else out.push(`Tool: ${oneText(tool, 80)}${Object.keys(o).length ? ` ${text(inputText(c.input, full))}` : ''}`)
  }
  const offer = permissionOffer(c)
  if (offer.referenceFolder) {
    out.push(text(referenceLocation(offer.referenceFolder).label))
    out.push(referenceEffect(tool))
  } else if (offer.showRuleChips) {
    const labels = Array.isArray(c.ruleLabels) ? c.ruleLabels.filter((l) => typeof l === 'string') : []
    for (const l of labels) {
      const chip = ruleChip(text(l))
      out.push(`Rule: ${chip.text}${chip.broad ? ' (broad)' : ''}`)
    }
  } else {
    const line = noRuleLine(tool, (c.suggestions?.length ?? 0) > 0)
    if (line) out.push(line)
  }
  return out
}

function rulesLines(card: Extract<TrayCard, { kind: 'rules' }>): string[] {
  const c = card.card
  const rules = Array.isArray(c.rules) ? c.rules : []
  const flagged = new Set(Array.isArray(c.flagged) ? c.flagged : [])
  const out: string[] = []
  for (const { rule, count } of collapseRules(rules)) {
    out.push(`Rule: ${oneText(rule, 300)}${count > 1 ? ` (x${count})` : ''}${flagged.has(rule) ? ' (broad)' : ''}`)
  }
  if (c.reason) out.push(`Reason: ${text(c.reason)}`)
  return out
}

function mcpServerLines(s: McpProposalServer, scope: 'library' | 'project'): string[] {
  const out = [`- ${text(upsertAction(s, scope))}`, `  ${text(effectLine(s))}`]
  const target = proposalTarget(s)
  if (target) out.push(`  ${s.transport === 'stdio' ? 'Runs' : 'Address'}: ${text(target)}`)
  if (s.transport === 'stdio') {
    const v = pinnedVersionOf(s)
    out.push(v ? `  Pinned version ${oneText(v, 60)}` : '  Not pinned to a version')
  }
  if (Array.isArray(s.roles)) out.push(`  Roles: ${s.roles.length ? s.roles.map((r) => oneText(r, 40)).join(', ') : 'none'}`)
  return out
}

function settingsValue(v: unknown): string {
  if (v === null) return 'none'
  if (Array.isArray(v)) return v.map((x) => oneText(x, 120)).join(', ')
  if (typeof v === 'string') return text(v)
  return oneText(JSON.stringify(v), 200)
}

function proposalLines(card: Extract<TrayCard, { kind: 'proposal' }>, full: boolean): string[] {
  const p: Proposal = card.card
  const out: string[] = [`${proposalKindLabel(p.kind, card.projectKind)}: ${oneText(p.title, 200)}`]
  const effect = proposalEffectCopy(p.effect)
  if (effect) out.push(effect)
  switch (p.kind) {
    case 'architecture': {
      const a = p.payload
      if (a.summary) out.push(text(a.summary))
      if (Array.isArray(a.stack) && a.stack.length) out.push(`Stack: ${a.stack.map((s) => oneText(s, 60)).join(', ')}`)
      const mods = Array.isArray(a.modules) ? a.modules : []
      const shown = full ? mods : mods.slice(0, 5)
      for (const m of shown) out.push(`- ${oneText(m?.name, 60)}: ${text(m?.purpose)}`)
      if (shown.length < mods.length) out.push(`(+${mods.length - shown.length} more modules; v shows everything)`)
      if (full) {
        for (const c of a.conventions ?? []) out.push(`Convention: ${text(c)}`)
        for (const c of a.commands ?? []) out.push(`Command ${oneText(c?.name, 60)}: ${text(c?.command)}`)
        for (const r of a.risks ?? []) out.push(`Risk: ${text(r)}`)
      }
      break
    }
    case 'orgChart': {
      const roles = Array.isArray(p.payload.roles) ? p.payload.roles : []
      out.push(`${roles.length} ${roles.length === 1 ? 'role' : 'roles'}:`)
      for (const r of roles) {
        const lead = r.reportsTo ? '' : ' (orchestrator)'
        out.push(`- ${oneText(r.name, 60)}${lead}${r.model ? `, ${oneText(r.model, 40)}` : ''}: ${oneText(r.description, 200)}`)
        if (full) {
          for (const resp of r.responsibilities ?? []) out.push(`    * ${text(resp)}`)
          if (Array.isArray(r.tools) && r.tools.length) out.push(`    Tools: ${r.tools.map((t) => oneText(t, 40)).join(', ')}`)
          if (r.prompt) out.push('    Prompt:', ...text(r.prompt).split('\n').map((l) => `      ${l}`))
        }
      }
      if (p.payload.rationale) out.push(`Why: ${text(p.payload.rationale)}`)
      break
    }
    case 'settings': {
      for (const [k, v] of Object.entries(p.payload)) {
        if (k === 'rationale' || v === undefined) continue
        out.push(`${oneText(k, 40)}: ${settingsValue(v)}`)
      }
      if (p.payload.rationale) out.push(`Why: ${text(p.payload.rationale)}`)
      break
    }
    case 'mcpServers': {
      const payload = p.payload
      const scope = proposalScope(payload)
      out.push(text(diffMcpProposal(payload, null, []).summary))
      for (const s of payload.upsert ?? []) out.push(...mcpServerLines(s, scope))
      for (const id of payload.remove ?? []) out.push(`- Remove ${oneText(id, 60)}`)
      const sec = secretsLine(payload)
      if (sec) out.push(`${text(sec)} (s enters them now)`)
      if (payload.rationale) out.push(`Why: ${text(payload.rationale)}`)
      break
    }
    case 'skills': {
      for (const it of p.payload.items ?? []) {
        const name = oneText(it?.draft?.name, 64)
        const roles = Array.isArray(it?.roles) && it.roles.length ? `, roles ${it.roles.map((r) => oneText(r, 40)).join(', ')}` : ''
        out.push(`- ${oneText(it?.action, 10)} ${name} (${oneText(it?.scope, 10)}${roles})${it?.draft?.description ? `: ${oneText(it.draft.description, 300)}` : ''}`)
        if (full && it?.draft?.body) out.push(...text(it.draft.body).split('\n').map((l) => `    ${l}`))
      }
      if (p.payload.rationale) out.push(`Why: ${text(p.payload.rationale)}`)
      break
    }
  }
  return out
}

function questionLines(card: Extract<TrayCard, { kind: 'question' }>): string[] {
  const q = card.card
  const out = [text(q.question)]
  const options = Array.isArray(q.options) ? q.options : []
  options.forEach((o, i) => {
    const n = i < QUESTION_KEYS_MAX ? `${i + 1}.` : ' -'
    out.push(`${n} ${oneText(o?.label, 120)}${o?.description ? ` - ${oneText(o.description, 300)}` : ''}`)
  })
  if (q.allowMultiple) out.push('Choose one or more (Space toggles).')
  if (q.allowFreeText) out.push('c types your own answer.')
  return out
}

function mergeLines(card: Extract<TrayCard, { kind: 'merge' }>): string[] {
  const m = card.card
  const out = [`Branch: ${oneText(m.branch, 200)}`, `Agent: ${oneText(m.agentName, 80)}`]
  if (m.stat) out.push(...text(m.stat).split('\n').filter((l) => l.trim()))
  const files = Array.isArray(m.changedFiles) ? m.changedFiles : []
  out.push(`${files.length} changed ${files.length === 1 ? 'file' : 'files'}:`)
  for (const f of files.slice(0, 20)) out.push(`  ${oneText(f, 300)}`)
  if (files.length > 20) out.push(`  (+${files.length - 20} more)`)
  return out
}

function installLines(card: Extract<TrayCard, { kind: 'mcpInstall' }>): string[] {
  const c = card.card
  const spec = c.spec ?? ({} as McpInstallRequest['spec'])
  const out = [`Server: ${oneText(spec.name, 120)}`]
  if (c.reason) out.push(`Why: ${text(c.reason)}`)
  const t = spec.transport ? targetText(spec) : ''
  if (t) out.push(`${spec.transport === 'stdio' ? 'Runs' : 'Address'}: ${text(t)}`)
  if (spec.transport === 'stdio') {
    const v = pinnedVersionOf(spec)
    out.push(v ? `Pinned version ${oneText(v, 60)}` : 'Not pinned to a version')
  }
  if (Array.isArray(spec.roles)) out.push(`Roles: ${spec.roles.length ? spec.roles.map((r) => oneText(r, 40)).join(', ') : 'none'}`)
  else out.push('Roles: every role')
  const secrets = Array.isArray(c.requiredSecrets) ? c.requiredSecrets : []
  if (secrets.length) out.push(`Needs secrets: ${secrets.map((s) => oneText(s, 60)).join(', ')}`)
  return out
}

type McpInstallRequest = Extract<TrayCard, { kind: 'mcpInstall' }>['card']

function rawLines(card: TrayCard, full: boolean): string[] {
  let lines: string[]
  switch (card.kind) {
    case 'permission':
      lines = permissionLines(card, full)
      break
    case 'rules':
      lines = rulesLines(card)
      break
    case 'proposal':
      lines = proposalLines(card, full)
      break
    case 'question':
      lines = questionLines(card)
      break
    case 'merge':
      lines = mergeLines(card)
      break
    case 'mcpInstall':
      lines = installLines(card)
      break
  }
  if (anyHidden(card.card)) lines.unshift(HIDDEN_BADGE)
  return lines
}

/** The most characters of one body item (a command, a summary) the card itself shows when the card has a full view. */
export const CARD_ITEM_MAX = 600
/** The most characters the full view (v) carries in all, for every card kind. */
export const FULL_VIEW_MAX = 65536
const FULL_VIEW_CUT = '(cut at 64 KB)'

/** Cards that offer a full view (v): only they cut a body item at CARD_ITEM_MAX. */
function hasFullView(card: TrayCard): boolean {
  return card.kind === 'permission' || card.kind === 'proposal' || card.kind === 'merge'
}

/** `s` cut to `max` characters without splitting a surrogate pair. */
function cutChars(s: string, max: number): string {
  let end = Math.min(s.length, max)
  const last = s.charCodeAt(end - 1)
  if (end < s.length && last >= 0xd800 && last <= 0xdbff) end--
  return s.slice(0, end)
}

/** The body items (each may hold line breaks); `cut` says the card or the full view left text out. */
function logicalLines(card: TrayCard, full: boolean): { lines: string[]; cut: boolean } {
  const raw = rawLines(card, full)
  let cut = false
  if (full) {
    // One cap for every body kind: the whole full view carries at most FULL_VIEW_MAX characters.
    let used = 0
    const out: string[] = []
    for (const l of raw) {
      if (used + l.length > FULL_VIEW_MAX) {
        const room = FULL_VIEW_MAX - used
        if (room > 0) out.push(cutChars(l, room))
        out.push(FULL_VIEW_CUT)
        cut = true
        break
      }
      used += l.length + 1
      out.push(l)
    }
    return { lines: out, cut }
  }
  const viewable = hasFullView(card)
  const max = viewable ? CARD_ITEM_MAX : FULL_VIEW_MAX
  const lines = raw.map((l) => {
    if (l.length <= max) return l
    cut = true
    return `${cutChars(l, max)} ... (cut${viewable ? '; v shows all' : ''})`
  })
  return { lines, cut }
}

/**
 * Wrap one line to `width` terminal columns (CJK and emoji count 2, never a code-point count). Breaks at the last space
 * in the second half of the line when there is one, else hard at a grapheme boundary. Linear in the line.
 */
export function wrapLine(line: string, width: number): string[] {
  const w = Math.max(10, Math.floor(width))
  if (textWidth(line) <= w) return [line]
  const gs = graphemes(line)
  const ws = gs.map(graphemeWidth)
  const n = gs.length
  const out: string[] = []
  let i = 0
  while (i < n) {
    let col = 0
    let j = i
    let space = -1
    while (j < n && col + ws[j] <= w) {
      if (gs[j] === ' ' && col * 2 > w) space = j
      col += ws[j]
      j++
    }
    if (j >= n) {
      out.push(gs.slice(i).join(''))
      break
    }
    let cutAt = j
    if (gs[j] !== ' ' && space > i) cutAt = space
    if (cutAt === i) cutAt = i + 1 // a grapheme wider than the line: never loop
    out.push(gs.slice(i, cutAt).join('').trimEnd())
    i = cutAt
    while (i < n && gs[i] === ' ') i++
  }
  return out
}

export interface CardDetail {
  lines: string[]
  /** A body item was cut at CARD_ITEM_MAX: the end of the card is not on screen until v shows it. */
  capped: boolean
}

const detailCache = new WeakMap<object, Map<string, CardDetail>>()

/** The card's wrapped body (memoised per card data and width) and whether it was cut. */
export function cardDetail(card: TrayCard, width: number): CardDetail {
  const data = card.card as object
  const key = `${Math.floor(width)}|${card.kind}|${card.projectKind ?? ''}|${card.runKind}`
  let perCard = detailCache.get(data)
  const hit = perCard?.get(key)
  if (hit) return hit
  const { lines: items, cut } = logicalLines(card, false)
  const lines: string[] = []
  for (const l of items) for (const part of l.split('\n')) lines.push(...wrapLine(part, width))
  const detail: CardDetail = { lines, capped: cut }
  if (!perCard) detailCache.set(data, (perCard = new Map()))
  if (perCard.size >= 8) perCard.clear()
  perCard.set(key, detail)
  return detail
}

export function cardDetailLines(card: TrayCard, width: number): string[] {
  return cardDetail(card, width).lines
}

/** The phrases of a card's key hint line ("y Allow once"), in order; the tray wraps them only between phrases. */
export function hintPhrases(card: TrayCard, dumb: boolean): string[] {
  const bs = bindingsFor(card)
  const parts: string[] = []
  const picks = bs.filter((b) => b.act === 'pick')
  if (picks.length) parts.push(picks.length === 1 ? '1 Pick' : `1-${picks.length} Pick`)
  for (const b of bs) {
    if (b.act === 'pick') continue
    const k = b.key === 'space' ? 'Space' : b.key === 'enter' ? 'Enter' : b.key
    parts.push(`${k} ${b.label}${b.text === 'optional' ? ' (note)' : ''}`)
  }
  parts.push('Esc Back', '? Keys')
  if (dumb) parts.push('(then Enter)')
  return parts
}

/** Joins phrases with `sep` into lines of at most `width` columns, breaking only between phrases (a phrase wider than a line is cut with `ellipsis`). */
export function wrapPhrases(phrases: readonly string[], sep: string, width: number, ellipsis = '...'): string[] {
  const w = Math.max(10, Math.floor(width))
  const out: string[] = []
  let cur = ''
  for (const raw of phrases) {
    const chars = Array.from(raw)
    const p = chars.length > w ? `${chars.slice(0, Math.max(1, w - ellipsis.length)).join('')}${ellipsis}` : raw
    if (cur === '') cur = p
    else if (Array.from(cur + sep + p).length <= w) cur += sep + p
    else {
      out.push(cur)
      cur = p
    }
  }
  if (cur !== '') out.push(cur)
  return out
}

/** The full view (v) text and whether it was cut at FULL_VIEW_MAX. */
export function cardFullView(card: TrayCard): { text: string; cut: boolean } {
  const head = `${cardTitle(card)}\n\n`
  if (card.kind === 'merge') {
    const m = card.card
    const stat = text(m.stat)
    const patch = text(m.patch)
    const cut = patch.length > FULL_VIEW_MAX
    return { text: `${head}${stat ? `${stat.trimEnd()}\n\n` : ''}${cut ? `${cutChars(patch, FULL_VIEW_MAX)}\n${FULL_VIEW_CUT}` : patch}`, cut }
  }
  const { lines, cut } = logicalLines(card, true)
  return { text: `${head}${lines.join('\n')}\n`, cut }
}

export function cardFullText(card: TrayCard): string {
  return cardFullView(card).text
}
