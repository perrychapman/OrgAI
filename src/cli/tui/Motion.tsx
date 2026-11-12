import { Text } from 'ink'
import { useTuiEnv } from './context'
import { motionEnabled, useActivityTick } from './activity'
import { sliceToWidth, textWidth } from './panes/text'
import { glyphs, terminalPalette, toneColor } from './theme'

const SHIMMER_RAMP = ['#167eae', '#6d69b5', '#8b55ae', '#767676'] as const

const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : undefined

function graphemes(text: string): string[] {
  return segmenter ? Array.from(segmenter.segment(text), part => part.segment) : Array.from(text)
}

function mod(n: number, m: number): number {
  return ((n % m) + m) % m
}

/** The bounded indigo-purple/blue sweep used by decorative brand and working labels. */
export function shimmerColor(index: number, phase: number, length = 12): string {
  const center = mod(phase, length + 8) - 4
  const distance = Math.abs(index - center)
  return SHIMMER_RAMP[Math.min(SHIMMER_RAMP.length - 1, Math.floor(distance))]!
}

export interface ShimmerProps {
  text: string
  active?: boolean
  phase?: number
  /** Use the theme's readable neutral foregrounds instead of an accent color. */
  monochrome?: boolean
}

/** Thinking label: explicit phase lets it share the work spinner's timer. */
export function Shimmer({ text, active = true, phase, monochrome = true }: ShimmerProps) {
  const env = useTuiEnv()
  const tick = useActivityTick(active, env, { kind: 'decorative' })
  const resolvedPhase = motionEnabled(env) ? phase ?? tick : 0
  if (!motionEnabled(env)) return <Text>{text}</Text>
  const palette = terminalPalette(env)
  return (
    <Text>
      {shimmerSpans(text, resolvedPhase, monochrome, palette).map((span, i) => (
        <Text key={i} color={span.color} bold={span.bold}>
          {span.text}
        </Text>
      ))}
    </Text>
  )
}

export interface ShimmerSpan {
  text: string
  color: string
  bold: boolean
}

/**
 * The shimmer as runs of contiguous characters with identical color and weight (a handful of Yoga nodes, not one per
 * grapheme), the way MotionRule groups its band.
 */
export function shimmerSpans(text: string, phase: number, monochrome: boolean, palette: { primary: string; secondary: string }): ShimmerSpan[] {
  const parts = graphemes(text)
  const spans: ShimmerSpan[] = []
  parts.forEach((part, i) => {
    const shade = shimmerColor(i, phase, parts.length)
    // Explicit foregrounds keep both ends of the neutral sweep readable in either theme.
    const color = monochrome ? (shade === SHIMMER_RAMP[3] ? palette.secondary : palette.primary) : shade
    const bold = shade !== SHIMMER_RAMP[3]
    const last = spans.at(-1)
    if (last && last.color === color && last.bold === bold) last.text += part
    else spans.push({ text: part, color, bold })
  })
  return spans
}

export interface SpinnerProps {
  label: string
  active?: boolean
  /** Share a parent activity tick when this spinner is rendered inside a composed status line. */
  phase?: number
  /** Set false for a plain label with only the activity glyph. */
  shimmer?: boolean
}

/** A genuine-work spinner with a label; inactive means no timer, not that the activity glyph disappears. */
export function Spinner({ label, active = true, phase, shimmer = true }: SpinnerProps) {
  const env = useTuiEnv()
  const tick = useActivityTick(active, env)
  const resolvedPhase = motionEnabled(env) ? phase ?? tick : 0
  const frames = glyphs(env).spinner
  const glyph = env.screenReader ? '' : `${frames[mod(resolvedPhase, frames.length)]} `
  const labelNode = shimmer ? <Shimmer text={label} active={false} phase={resolvedPhase} /> : label
  return (
    <Text color={toneColor('running', env)}>
      {glyph}
      {labelNode}
    </Text>
  )
}


/** A single traveling highlight, grouped into runs rather than one React node per terminal column. */
export function MotionRule({ width, active = true, phase, text }: { width: number; active?: boolean; phase?: number; text?: string }) {
  const env = useTuiEnv()
  const tick = useActivityTick(active, env, { kind: 'decorative' })
  const size = Math.max(0, Math.floor(width))
  const content = sliceToWidth(text ?? glyphs(env).h.repeat(size), size)
  const animated = motionEnabled(env) && (active || phase !== undefined)
  const resolvedPhase = phase ?? tick
  if (!animated) return <Text dimColor={env.color} wrap="truncate-end">{content}</Text>
  const center = (mod(resolvedPhase, 48) / 47) * (size + 16) - 8
  const groups: { text: string; band: boolean }[] = []
  let column = 0
  for (const part of graphemes(content)) {
    const band = Math.abs(column - center) < 5
    const last = groups.at(-1)
    if (last?.band === band) last.text += part
    else groups.push({ text: part, band })
    column += textWidth(part)
  }
  return <Text wrap="truncate-end">{groups.map((group, i) => <Text key={i} bold={group.band} dimColor={!group.band} color={group.band ? SHIMMER_RAMP[0] : undefined}>{group.text}</Text>)}</Text>
}
