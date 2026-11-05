/**
 * The status bar (W4-T3): one line with the project, the followed run (tag and title), its status word (from
 * statusText, via the selectors) in its tone, cost, "N need you", live run count, connection state and the read-only
 * reason, then the newest notice or the key hints, all cut to the width. Strings arrive sanitized. A screen reader
 * gets plain words separated by commas, never glyphs.
 */
import { Box, Text } from 'ink'
import { useTuiEnv } from './context'
import { asciiOnly } from './theme'
import type { ConnectionState, StatusBarProps, StatusSummary, Tone, TuiEnv } from './types'
import { cutSegs, styleFor, type Seg } from './panes/lines'

const CONNECTION_TEXT: Record<ConnectionState, { text: string; tone?: Tone } | undefined> = {
  connecting: { text: 'Connecting', tone: 'dim' },
  live: undefined,
  reconnecting: { text: 'Reconnecting', tone: 'warn' },
  gone: { text: 'Connection lost', tone: 'danger' }
}

export function needsYouText(n: number): string {
  return `${n} need${n === 1 ? 's' : ''} you`
}

/** The status segments (without separators). */
export function statusSegments(s: StatusSummary): Seg[] {
  const out: Seg[] = []
  if (s.projectName) out.push({ text: s.projectName, bold: true })
  const run = [s.runTag, s.runTitle].filter(Boolean).join(' ')
  if (run) out.push({ text: run })
  if (s.statusWord) out.push({ text: s.statusWord, tone: s.tone })
  if (s.costText) out.push({ text: s.costText, dim: true })
  out.push({ text: needsYouText(s.needsYou), tone: s.needsYou > 0 ? 'warn' : 'dim' })
  if (s.liveRuns > 0) out.push({ text: `${s.liveRuns} live`, dim: true })
  const conn = CONNECTION_TEXT[s.connection]
  if (conn) out.push(conn)
  if (s.readOnlyReason) out.push({ text: s.readOnlyReason, tone: 'warn' })
  return out
}

function separator(env: TuiEnv): string {
  if (env.screenReader) return ', '
  return asciiOnly(env) ? ' | ' : ' · '
}

export function StatusBar(props: StatusBarProps) {
  const env = useTuiEnv()
  const width = Math.max(0, Math.floor(props.width))
  if (width === 0) return <Box width={0} height={1} />
  const sep = separator(env)
  const segs: Seg[] = []
  for (const seg of statusSegments(props.summary)) {
    if (segs.length > 0) segs.push({ text: sep, dim: true })
    segs.push(seg)
  }
  const tail: Seg | undefined = props.notice
    ? { text: props.notice.text, tone: props.notice.tone ?? 'accent' }
    : props.hints
      ? { text: props.hints, dim: true }
      : undefined
  if (tail) segs.push({ text: env.screenReader ? '. ' : '   ' }, tail)
  const line = cutSegs(segs, width, env)
  return (
    <Box width={width} height={1} overflow="hidden">
      <Text wrap="truncate-end">
        {line.map((s, i) => (
          <Text key={i} {...styleFor(s, env)}>
            {s.text}
          </Text>
        ))}
      </Text>
    </Box>
  )
}
