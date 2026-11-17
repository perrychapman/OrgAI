import { Box, Text } from 'ink'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { motionEnabled, subscribeTick } from './activity'
import { useTuiEnv } from './context'
import { graphemes, textWidth, truncateEnd } from './panes/text'
import { asciiOnly, glyphs, terminalPalette } from './theme'
import type { TuiEnv } from './types'

const WORDMARK = ['█▀█ █▀█ █▀▀ ▄▀█ █', '█▄█ █▀▄ █▄█ █▀█ █'] as const
const SWEEP_MS = 1_000
const IDLE_MS = 5_000

function brandColorEnabled(env: TuiEnv): boolean {
  return env.color && !env.screenReader && !env.dumbTerminal
}

function mixHex(from: string, to: string, amount: number): string {
  const a = from.slice(1).match(/../g)?.map((part) => parseInt(part, 16))
  const b = to.slice(1).match(/../g)?.map((part) => parseInt(part, 16))
  if (!a || !b || a.length !== 3 || b.length !== 3) return to
  const clamped = Math.max(0, Math.min(1, amount))
  return `#${a.map((value, i) => Math.round(value + (b[i]! - value) * clamped).toString(16).padStart(2, '0')).join('')}`
}

function sweepColor(distance: number, base: string, accent: string): string {
  if (distance < 1) return accent
  if (distance < 2) return mixHex(base, accent, 0.62)
  if (distance < 3) return mixHex(base, accent, 0.26)
  return base
}

/** Includes a breathing row below the two-line mark; callers reserve this exact height. */
export function brandHeight(width: number, env: TuiEnv, prominent = false): 1 | 3 {
  return prominent && width >= 44 && env.bufferMode === 'fullscreen' && !asciiOnly(env) ? 3 : 1
}

/**
 * The sweep phase: 0..1 across SWEEP_MS, then a static IDLE_MS. The shared tick is subscribed only during the sweep;
 * the idle window costs one timeout, not a frame loop.
 */
function useBrandPhase(active: boolean): number {
  const [phase, setPhase] = useState(0)
  const [sweeping, setSweeping] = useState(true)
  const started = useRef(Date.now())
  useEffect(() => {
    if (!active) {
      setPhase(0)
      return undefined
    }
    started.current = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (): void => {
      const cycle = (Date.now() - started.current) % (SWEEP_MS + IDLE_MS)
      if (cycle < SWEEP_MS) {
        setSweeping(true)
        timer = setTimeout(schedule, SWEEP_MS - cycle)
      } else {
        setSweeping(false)
        setPhase(0)
        timer = setTimeout(schedule, SWEEP_MS + IDLE_MS - cycle)
      }
    }
    schedule()
    return () => {
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [active])
  useEffect(() => {
    if (!active || !sweeping) return undefined
    const update = (): void => {
      const cycle = (Date.now() - started.current) % (SWEEP_MS + IDLE_MS)
      setPhase(cycle < SWEEP_MS ? cycle / SWEEP_MS : 0)
    }
    update()
    return subscribeTick(update)
  }, [active, sweeping])
  return phase
}

function markRow(row: string, phase: number, env: TuiEnv): ReactElement {
  const palette = terminalPalette(env)
  const parts = graphemes(row)
  const end = Math.max(1, textWidth(row))
  const center = phase <= 0 ? -100 : phase * (end + 8) - 4
  const colored = brandColorEnabled(env)
  let column = 0
  return (
    <Text key={row}>
      {parts.map((part, i) => {
        const color = sweepColor(Math.abs(column - center), palette.brandBase, palette.accent)
        const node = <Text key={`${i}:${part}`} bold={colored} color={colored ? color : undefined}>{part}</Text>
        column += textWidth(part)
        return node
      })}
    </Text>
  )
}

export interface BrandProps {
  width: number
  version?: string
  prominent?: boolean
  /** Suspended or otherwise static views pass false to avoid scheduling decoration. */
  animated?: boolean
}

/** A compact OrgAI wordmark with a restrained, theme-aware purple sweep in prominent views. */
export function Brand({ width, version, prominent = false, animated = true }: BrandProps) {
  const env = useTuiEnv()
  const size = Math.max(0, Math.floor(width))
  const expanded = brandHeight(size, env, prominent) === 3
  const animate = expanded && animated && motionEnabled(env)
  const phase = useBrandPhase(animate)
  const suffix = version ? `  ${version}` : ''
  const palette = terminalPalette(env)
  const colored = brandColorEnabled(env)
  if (expanded) {
    return <Box width={size} height={3} flexDirection="column" flexShrink={0} overflow="hidden">
      {markRow(WORDMARK[0], phase, env)}
      {markRow(WORDMARK[1], phase, env)}
      <Text color={colored ? palette.brandBase : undefined}> </Text>
    </Box>
  }
  const wordmark = `${asciiOnly(env) ? '*' : '✦'} OrgAI`
  const label = truncateEnd(`${wordmark}${suffix}`, size, glyphs(env).ellipsis)
  const visibleWordmark = label.startsWith(wordmark) ? wordmark : label
  const rest = label.slice(visibleWordmark.length)
  return (
    <Text bold={colored} color={colored ? palette.brandBase : undefined} wrap="truncate-end">
      {visibleWordmark}
      {rest ? <Text dimColor={colored}>{rest}</Text> : null}
    </Text>
  )
}
