import { useEffect, useState } from 'react'
import type { TuiEnv } from './types'
import type { AgentState } from '../../shared/types'
import { sanitizeTty } from './sanitizeTty'
import { commandSummary, isCompoundCommand } from './streamRows'
import { truncateEnd } from './panes/text'

/** Reflect reported activity without exposing a raw shell command in the status label. */
export function agentActivityLabel(row: { state: AgentState; stateWord: string; activity: string; activityIsCompound?: boolean }): string {
  if (!isWorkingAgentState(row.state)) return row.stateWord
  const detail = sanitizeTty(row.activity).replace(/\s+/g, ' ').trim().replace(/[.\u2026]+$/, '')
  if (/^\$\s|^Running command\b|^Run \//i.test(detail)) {
    const command = commandSummary(detail.replace(/^(?:\$\s*|Running command:?\s*|Run\s+)/i, '')).replace(/^["']/, '')
    if (row.activityIsCompound || isCompoundCommand(command) || isCompoundCommand(row.activity)) return 'Running a command'
    if (/^(?:npm|pnpm|yarn|bun)(?: run)? (?:test|vitest|jest)\b|^(?:pytest|vitest|jest)\b/.test(command)) return 'Running tests'
    if (/^(?:npm|pnpm|yarn|bun)(?: run)? (?:typecheck|check-types)\b|^tsc\b/.test(command)) return 'Checking types'
    if (/^(?:npm|pnpm|yarn|bun)(?: run)? (?:build)\b/.test(command)) return 'Building the project'
    if (/^(?:cat|sed|head|tail|less)\b/.test(command)) return 'Reading files'
    if (/^(?:rg|grep|find|ls)\b/.test(command)) return 'Searching files'
    if (/^git\s+(?:status|log|branch)\b/.test(command)) return 'Checking the repository'
    if (/^git\s+diff\b/.test(command)) return 'Reviewing changes'
    return 'Running a command'
  }
  if (detail && !/^(?:thinking|working|starting|using a tool|delegating)$/i.test(detail)) return truncateEnd(detail, 56, '…')
  return row.state === 'starting' ? 'Starting' : row.state === 'tool' ? 'Using a tool' : row.state === 'delegating' ? 'Delegating work' : 'Working'
}

export interface ActivityTickOptions {
  /** Decorative motion uses its own cadence, while the default remains the genuine-work spinner cadence. */
  kind?: 'activity' | 'decorative'
}

export function motionEnabled(env: TuiEnv): boolean {
  return env.bufferMode === 'fullscreen' && env.color && !env.screenReader && !env.dumbTerminal && !env.reducedMotion
}

export function isWorkingAgentState(state: AgentState): boolean {
  return state === 'starting' || state === 'thinking' || state === 'tool' || state === 'delegating'
}

/** Keep activity details only when they add something beyond the displayed state label. */
export function distinctActivity(activity: string | undefined, stateWord: string | undefined): string {
  const normalized = (value: string): string => value.replace(/\s+/g, ' ').trim().replace(/[.\u2026]+$/, '').trim().toLowerCase()
  const detail = activity ?? ''
  return normalized(detail) === normalized(stateWord ?? '') ? '' : detail
}

/** Animate genuine work or explicitly requested decoration, with no timer in inaccessible/static modes. */
export function useActivityTick(active: boolean, env: TuiEnv, options: ActivityTickOptions = {}): number {
  const [tick, setTick] = useState(0)
  const kind = options.kind ?? 'activity'
  useEffect(() => {
    if (!active || !motionEnabled(env)) return undefined
    const timer = setInterval(() => setTick(t => t + 1), kind === 'decorative' ? 100 : 90)
    return () => clearInterval(timer)
  }, [active, env.bufferMode, env.screenReader, env.dumbTerminal, env.reducedMotion, env.color, kind])
  return tick
}

export function elapsedLabel(startedAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  if (!Number.isFinite(seconds)) return ''
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}
