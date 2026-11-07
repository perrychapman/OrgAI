import { useEffect, useState } from 'react'
import type { TuiEnv } from './types'
import type { AgentState } from '../../shared/types'

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
