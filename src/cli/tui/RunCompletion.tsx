import { Box } from 'ink'
import type { AgentInstance, RunStatus, TranscriptBlock } from '../../shared/types'
import { PaneLines, type PaneLine } from './panes/lines'
import { sanitizeTty } from './sanitizeTty'
import type { TuiState } from './types'
import { useTuiEnv } from './context'

const TERMINAL_STATUSES = new Set<RunStatus>(['finished', 'error', 'paused'])
const CHECK_TOOL_NAMES = new Set(['bash', 'shell', 'exec', 'exec_command', 'run_command', 'powershell', 'command'])

function safe(value: unknown): string {
  return sanitizeTty(String(value ?? '')).replace(/\s+/g, ' ').trim()
}

function elapsed(startedAt: unknown, endedAt: unknown): string | undefined {
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || typeof endedAt !== 'number' || !Number.isFinite(endedAt)) return undefined
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return mins ? `${hours}h ${mins}m` : `${hours}h`
}

type OutcomeTone = 'ok' | 'warn' | 'danger' | undefined

function outcomeLabel(summary: TuiState['runs'][string]['summary']): { heading: string; outcome: string; tone: OutcomeTone } {
  const labels: Record<string, string> = {
    completed: 'Completed',
    'completed-unplanned': 'Completed (unplanned)',
    'unmerged-conflicts': 'Completed with unmerged conflicts',
    blocked: 'Blocked',
    'incomplete-plan': 'Incomplete plan',
    'delegation-incomplete': 'Required delegation incomplete',
    'needs-decision': 'Needs a decision',
    'budget-exceeded': 'Budget exceeded',
    'rate-limited': 'Rate limited',
    'auth-error': 'Authentication failed',
    failed: 'Failed',
    stalled: 'Stalled',
    interrupted: 'Interrupted'
  }
  if (summary.status === 'error') return { heading: 'Run failed', outcome: `Failed${summary.error ? `: ${safe(summary.error)}` : ''}`, tone: 'danger' }
  if (summary.status === 'paused') return { heading: 'Run paused', outcome: `Paused${summary.pauseReason ? `: ${safe(summary.pauseReason)}` : ''}`, tone: 'warn' }
  const outcome = summary.execOutcome ? labels[summary.execOutcome] ?? safe(summary.execOutcome) : 'Finished'
  const tone = summary.execOutcome === 'completed' || summary.execOutcome === 'completed-unplanned' ? 'ok' : summary.execOutcome ? 'warn' : undefined
  return { heading: 'Run finished', outcome, tone }
}

function planLine(run: TuiState['runs'][string]): string | undefined {
  const steps = run.plan?.steps
  if (!Array.isArray(steps) || steps.length === 0) return undefined
  const done = steps.filter((step) => step.status === 'done').length
  return `Plan: ${done}/${steps.length} steps done`
}

function changesLine(run: TuiState['runs'][string]): string {
  const files: string[] = []
  let recorded = false
  for (const agent of Object.values(run.agents) as AgentInstance[]) {
    const changed = agent.worktree?.changedFiles
    if (!agent.worktree) continue
    recorded = recorded || Array.isArray(changed)
    if (Array.isArray(changed)) for (const file of changed) {
      const clean = safe(file)
      if (clean && !files.includes(clean)) files.push(clean)
    }
  }
  if (!recorded) return 'Changes: not recorded | /diff <branch|agent>'
  if (files.length === 0) return 'Changes: 0 files recorded | /diff <branch|agent>'
  const shown = files.slice(0, 3).join(', ')
  const more = files.length > 3 ? `, +${files.length - 3} more` : ''
  return `Changes: ${files.length} file${files.length === 1 ? '' : 's'} recorded (${shown}${more}) | /diff <branch|agent>`
}

function isCheckCommand(command: string): boolean {
  const commandLine = command.trim()
  if (!commandLine || /[;&|`$()]/.test(commandLine)) return false
  return /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|build|lint|typecheck|quality[_-]?gate)\b/i.test(commandLine) ||
    /^(?:pytest|vitest|jest|tsc|eslint|cargo\s+test|go\s+test|make\s+test)\b/i.test(commandLine) ||
    /^git\s+diff\s+--check\b/i.test(commandLine)
}

function checkResult(content: string, isError: boolean): boolean | undefined {
  if (isError) return false
  const raw = sanitizeTty(content).trim()
  if (!raw) return undefined
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const exitLine = /^(?:\[\s*)?(?:process\s+)?(?:exit(?:ed)?\s+with\s+code|exit\s+code|status|code)\s*[:=]?\s*(\d+)\s*\]?$/i
  for (let i = lines.length - 1; i >= 0; i--) {
    const exit = lines[i].match(exitLine)
    if (exit) return Number(exit[1]) === 0
  }
  if (lines.length === 1 && /^(?:pass(?:ed)?|clean|ok|success(?:ful)?)\.?$/i.test(lines[0])) return true
  return undefined
}

function checkEvidence(run: TuiState['runs'][string]): { text: string; failed: boolean } | undefined {
  const commands = new Map<string, string>()
  const latest = new Map<string, { command: string; failed: boolean } | undefined>()
  for (const entry of run.transcript) {
    const block = entry.block as TranscriptBlock
    if (block.kind === 'tool_use') {
      if (!CHECK_TOOL_NAMES.has(block.name.toLowerCase()) || !block.input || typeof block.input !== 'object') continue
      const input = block.input as { command?: unknown; cmd?: unknown }
      const command = safe(input.command ?? input.cmd)
      if (command && isCheckCommand(command)) commands.set(block.id, command)
    } else if (block.kind === 'tool_result') {
      const command = commands.get(block.toolUseId)
      if (!command) continue
      const normalized = command.replace(/\s+/g, ' ').trim()
      const result = checkResult(block.content, block.isError)
      latest.set(normalized, result === undefined ? undefined : { command, failed: !result })
    }
  }
  const checks = [...latest.values()].filter((check): check is { command: string; failed: boolean } => check !== undefined)
  if (checks.length === 0) return undefined
  return { text: `Checks: ${checks.map((check) => `${check.command} ${check.failed ? 'failed' : 'passed'}`).join('; ')}`, failed: checks.some((check) => check.failed) }
}

/** Pure, evidence-only completion copy for the active terminal run. */
export function completionLines(state: TuiState): string[] {
  const active = state.activeRunId ? state.runs[state.activeRunId] : undefined
  if (!active || !TERMINAL_STATUSES.has(active.summary.status)) return []
  const result = outcomeLabel(active.summary)
  const lines = [`${result.heading}`, `Outcome: ${result.outcome}${elapsed(active.summary.startedAt, active.summary.endedAt) ? ` | Elapsed: ${elapsed(active.summary.startedAt, active.summary.endedAt)}` : ''}`]
  const plan = planLine(active)
  if (plan) lines.push(plan)
  lines.push(changesLine(active))
  const checks = checkEvidence(active)
  if (checks) lines.push(checks.text)
  return lines.slice(0, 5)
}

/** Compact, static terminal result summary. The shell decides when this component is shown. */
export function RunCompletion(props: { width: number; height: number; state: TuiState }) {
  const env = useTuiEnv()
  const width = Math.max(0, Math.floor(props.width))
  const height = Math.max(0, Math.floor(props.height))
  const lines = completionLines(props.state)
  if (width === 0 || height === 0 || lines.length === 0) return <Box width={width} height={height} />
  const inset = width >= 2 ? 1 : 0
  const inner = Math.max(0, width - inset * 2)
  const status = props.state.activeRunId ? props.state.runs[props.state.activeRunId]?.summary.status : undefined
  const failedCheck = lines.some((line) => line.startsWith('Checks:') && line.includes(' failed'))
  const result = status ? outcomeLabel(props.state.runs[props.state.activeRunId!].summary) : undefined
  const rows: PaneLine[] = lines.map((text, i) => ({
    key: `completion-${i}`,
    segs: [{ text, ...(i === 0 ? { bold: true } : {}), ...(i < 2 && result?.tone ? { tone: result.tone } : {}), ...(i > 1 && failedCheck && text.startsWith('Checks:') ? { tone: 'danger' as const } : {}) }]
  }))
  return (
    <Box width={width} height={height} paddingX={inset} flexDirection="column" overflow="hidden">
      <PaneLines width={inner} height={Math.min(height, rows.length)} env={env} lines={rows} />
    </Box>
  )
}
