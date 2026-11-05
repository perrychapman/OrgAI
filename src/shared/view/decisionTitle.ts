/**
 * Decision card titles (ui-review-2.md B.7): the title is the action the user is asked to allow or answer, never the
 * agent. Every helper takes untrusted agent text, flattens it to one line, drops bidi and control characters and clips
 * it; the full text lives in the card body. Output is only ever rendered as React text.
 */

import type { ProjectKind, ProposalKind } from '@shared/types'
import { HIDDEN_OR_CONTROL_RUN } from './hiddenChars'

const MAX_TITLE = 120

const CONTROL = HIDDEN_OR_CONTROL_RUN

/** One line, no control or bidi override characters, clipped to `max` with an ellipsis. */
export function oneLine(s: unknown, max = MAX_TITLE): string {
  const t = (typeof s === 'string' ? s : '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1))}…` : t
}

/** The last path segment, for either separator. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/**
 * Split a shell command line into its steps on `&&`, `||` and `;` outside quotes (the same split the harness's rule
 * matcher uses). Steps are trimmed; empty ones are dropped.
 */
export function shellSegments(command: string): string[] {
  const parts: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
      continue
    }
    if (ch === ';') {
      parts.push(cur)
      cur = ''
      continue
    }
    if ((ch === '&' || ch === '|') && command[i + 1] === ch) {
      parts.push(cur)
      cur = ''
      i++
      continue
    }
    cur += ch
  }
  parts.push(cur)
  return parts.map((p) => p.trim()).filter(Boolean)
}

const CD_STEP = /^(?:cd|chdir|pushd|popd|set-location|sl)(?=$|[\s\\/.])/i

/** True for a step that only changes folder (`cd x`, `cd..`, `cd/d x`, `pushd x`, `popd`, `Set-Location x`). */
export function isCdSegment(segment: string): boolean {
  return CD_STEP.test(segment.trim())
}

/**
 * The step of a command line the user is really asked about: the last step that is not a change of folder, plus how
 * many other such steps there are. A line of only `cd` steps names its last step.
 */
export function shellAction(line: string): { action: string; more: number } {
  const steps = shellSegments(line)
  if (steps.length <= 1) return { action: line.trim(), more: 0 }
  const actions = steps.filter((s) => !isCdSegment(s))
  if (actions.length === 0) return { action: steps[steps.length - 1], more: 0 }
  return { action: actions[actions.length - 1], more: actions.length - 1 }
}

/** "Run npm test", "Edit server.js", "Write notes.md", "Read a.ts", "Use <tool>". */
export function permissionTitle(toolName: string, input: unknown): string {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const file = str(o.file_path) ?? str(o.notebook_path) ?? str(o.path)
  switch (toolName) {
    case 'Bash':
    case 'PowerShell': {
      const cmd = str(o.command)
      const lines = cmd?.split(/\r?\n/).filter((l) => l.trim()) ?? []
      const first = lines[0] ?? ''
      if (!first) return 'Run a shell command'
      // A compound first line names its real action: the last step that is not a change of folder.
      const { action, more } = shellAction(first)
      const head = more > 0 ? `Run ${action} (+${more} more)` : `Run ${action}`
      const base = oneLine(head)
      const extra = lines.length - 1
      if (extra > 0) return `${oneLine(head, MAX_TITLE - 16)} (+${extra} ${extra === 1 ? 'line' : 'lines'})`
      return base.endsWith('…') ? `${oneLine(head, MAX_TITLE - 20)} (long command)` : base
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return file ? oneLine(`Edit ${baseName(file)}`) : `Use ${oneLine(toolName, 40)}`
    case 'Write':
      return file ? oneLine(`Write ${baseName(file)}`) : `Use ${oneLine(toolName, 40)}`
    case 'Read':
      return file ? oneLine(`Read ${baseName(file)}`) : `Use ${oneLine(toolName, 40)}`
    case 'WebFetch': {
      const url = str(o.url)
      return url ? oneLine(`Fetch ${hostOf(url)}`) : 'Fetch a web page'
    }
    case 'WebSearch': {
      const q = str(o.query)
      return q ? oneLine(`Search the web: ${q}`) : 'Search the web'
    }
    default:
      return `Use ${oneLine(toolName, 60) || 'a tool'}`
  }
}

/** "Answer: <question>". */
export function questionTitle(question: string): string {
  return oneLine(`Answer: ${question}`)
}

/**
 * "Allow <rule>" for one rule, "Allow N rules" otherwise. `risky` counts rules that are broad or approve a whole tool;
 * the marker stays in the title so a collapsed card still shows it.
 */
export function rulesTitle(rules: readonly string[], risky = 0): string {
  const flag = risky > 0 ? (rules.length === 1 ? ' (broad)' : ` (${risky} broad)`) : ''
  if (rules.length === 1) return `${oneLine(`Allow ${rules[0]}`, MAX_TITLE - flag.length)}${flag}`
  return `Allow ${rules.length} rules${flag}`
}

/** The kind of a proposal, as the user reads it (Needs-you labels, tray chips, card titles). */
export const PROPOSAL_KIND_LABEL: Record<ProposalKind, string> = {
  architecture: 'Architecture',
  orgChart: 'Org chart',
  settings: 'Run settings',
  mcpServers: 'MCP servers',
  skills: 'Skills'
}

/** The kind label for one project: an engagement's architecture proposal is its "Engagement plan". */
export function proposalKindLabel(kind: ProposalKind, projectKind?: ProjectKind): string {
  return kind === 'architecture' && projectKind === 'engagement' ? 'Engagement plan' : PROPOSAL_KIND_LABEL[kind]
}

/** "Approve architecture proposal", "Approve MCP servers proposal": a leading capital on a plain word is lowered, an acronym is kept. */
export function proposalTitle(kind: ProposalKind): string {
  const label = PROPOSAL_KIND_LABEL[kind]
  const word = /^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label
  return oneLine(`Approve ${word} proposal`)
}

/** "Merge engineer-1's changes". */
export function mergeTitle(agentName: string): string {
  return oneLine(`Merge ${agentName}'s changes`)
}

/** "Install <server>". */
export function installTitle(serverName: string): string {
  return oneLine(`Install ${serverName}`)
}

/**
 * True when a shell command is more than its title shows: several non-empty lines, a first line clipped for the title,
 * or several steps (the title names one; a `cd` or an earlier step is in the body only).
 */
export function isHiddenCommand(toolName: string, input: unknown): boolean {
  if (toolName !== 'Bash' && toolName !== 'PowerShell') return false
  const t = permissionTitle(toolName, input)
  if (t.endsWith(' lines)') || t.endsWith(' line)') || t.endsWith('(long command)')) return true
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const cmd = str(o.command)
  return !!cmd && shellSegments(cmd.split(/\r?\n/)[0] ?? '').length > 1
}
