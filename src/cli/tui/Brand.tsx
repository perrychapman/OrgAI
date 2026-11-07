import { Box, Text } from 'ink'
import { useEffect, useState, type ReactElement } from 'react'
import { motionEnabled } from './activity'
import { useTuiEnv } from './context'
import { graphemes, textWidth, truncateEnd } from './panes/text'
import { asciiOnly, glyphs, terminalPalette } from './theme'
import type { TuiEnv } from './types'

const WORDMARK = ['█▀█ █▀█ █▀▀ ▄▀█ █', '█▄█ █▀▄ █▄█ █▀█ █'] as const
const WORDMARK_WIDTH = textWidth(WORDMARK[0])
const SWEEP_MS = 1_000
const IDLE_MS = 5_000
const TICK_MS = 80

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

function useBrandPhase(active: boolean): number {
  const [phase, setPhase] = useState(0)
  useEffect(() => {
    if (!active) {
      setPhase(0)
      return undefined
    }
    const started = Date.now()
    const update = () => {
      const cycle = (Date.now() - started) % (SWEEP_MS + IDLE_MS)
      setPhase(cycle < SWEEP_MS ? cycle / SWEEP_MS : 0)
    }
    update()
    const timer = setInterval(update, TICK_MS)
    return () => clearInterval(timer)
  }, [active])
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

function metadataRow(metadata: string, env: TuiEnv): ReactElement {
  const name = metadata.startsWith('OrgAI') ? 'OrgAI' : metadata
  const suffix = metadata.startsWith('OrgAI') ? metadata.slice(5) : ''
  const palette = terminalPalette(env)
  const colored = brandColorEnabled(env)
  return <Text color={colored ? palette.brandBase : undefined} bold={colored}>{name}{suffix ? <Text dimColor={colored}>{suffix}</Text> : null}</Text>
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
    const metadata = truncateEnd(`OrgAI${suffix}`, Math.max(0, size - WORDMARK_WIDTH - 3), glyphs(env).ellipsis)
    return <Box width={size} height={3} flexDirection="column" flexShrink={0} overflow="hidden">
      <Box width={size} height={1} flexShrink={0}>
        {markRow(WORDMARK[0], phase, env)}
        <Text>   </Text>
        {metadataRow(metadata, env)}
      </Box>
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
