import { Text } from 'ink'
import { useTuiEnv } from './context'
import { motionEnabled, useActivityTick } from './activity'
import { sliceToWidth, textWidth } from './panes/text'
import { glyphs, toneColor } from './theme'

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
  /** Follow the terminal foreground, with a neutral shimmer instead of an accent color. */
  monochrome?: boolean
}

/** Thinking label: explicit phase lets it share the work spinner's timer. */
export function Shimmer({ text, active = true, phase, monochrome = true }: ShimmerProps) {
  const env = useTuiEnv()
  const tick = useActivityTick(active, env, { kind: 'decorative' })
  const resolvedPhase = motionEnabled(env) ? phase ?? tick : 0
  if (!env.color || env.screenReader || env.dumbTerminal) return <Text>{text}</Text>
  const parts = graphemes(text)
  return (
    <Text>
      {parts.map((part, i) => {
        const shade = shimmerColor(i, resolvedPhase, parts.length)
        return <Text key={`${i}:${part}`} color={monochrome ? undefined : shade} bold={shade !== SHIMMER_RAMP[3]} dimColor={monochrome && shade === SHIMMER_RAMP[3]}>
          {part}
        </Text>
      })}
    </Text>
  )
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
