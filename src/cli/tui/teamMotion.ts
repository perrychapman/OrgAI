import { useEffect, useRef, useState } from 'react'
import { subscribeTick, TICK_MS } from './activity'
import type { TeamMessageRow } from './collaboration'
import type { TuiEnv } from './types'
import { asciiOnly } from './theme'
import { textWidth, truncateEnd } from './panes/text'

/** About 1.7 s of courier travel, one frame per shared tick. */
export const MESSAGE_PULSE_FRAMES = 14
export const MESSAGE_PULSE_MS = TICK_MS

/** Animate only newly observed agent-to-agent events, never existing history or a changed run. */
export function useMessagePulse(message: TeamMessageRow | undefined, runId: string | undefined, enabled: boolean): number | undefined {
  const seen = useRef({ runId, key: message?.key })
  const [pulse, setPulse] = useState<{ runId?: string; key: string; frame: number }>()
  useEffect(() => {
    const fresh = seen.current.runId === runId && seen.current.key !== message?.key
    seen.current = { runId, key: message?.key }
    setPulse(undefined)
    if (!enabled || !fresh || !message?.toId || message.toId === message.fromId) return undefined
    let frame = 0
    setPulse({ runId, key: message.key, frame })
    const off = subscribeTick(() => {
      frame++
      if (frame >= MESSAGE_PULSE_FRAMES) {
        off()
        setPulse(undefined)
      } else setPulse({ runId, key: message.key, frame })
    })
    return off
  }, [message?.key, runId, enabled])
  return enabled && pulse?.key === message?.key && pulse?.runId === runId ? pulse?.frame : undefined
}

/** A small courier travels in the actual sender-to-recipient direction; the resting label is explicit history. */
export function messageRoute(message: TeamMessageRow, width: number, env: TuiEnv, frame?: number): string {
  if (env.screenReader) return truncateEnd(`Last message from ${message.fromLabel} to ${message.toLabel}`, width, '...')
  const ascii = asciiOnly(env)
  const active = frame !== undefined
  const position = Math.min(5, Math.floor((frame ?? 0) * 6 / MESSAGE_PULSE_FRAMES))
  const route = active
    ? ` ${(ascii ? '-' : '─').repeat(position)}${ascii ? '*' : '●'}${(ascii ? '-' : '─').repeat(5 - position)}${ascii ? '>' : '›'} `
    : ascii ? ' -> ' : ' → '
  const prefix = active ? '' : 'Last: '
  const labelRoom = Math.max(0, width - textWidth(prefix + route))
  const from = truncateEnd(message.fromLabel, Math.floor(labelRoom / 2), ascii ? '...' : '…')
  const to = truncateEnd(message.toLabel, labelRoom - textWidth(from), ascii ? '...' : '…')
  return truncateEnd(prefix + from + route + to, width, ascii ? '...' : '…')
}
