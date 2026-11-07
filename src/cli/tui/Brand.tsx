import { Box, Text } from 'ink'
import { useTuiEnv } from './context'
import { textWidth, truncateEnd } from './panes/text'
import { asciiOnly, glyphs } from './theme'
import type { TuiEnv } from './types'

const WORDMARK = ['█▀█ █▀█ █▀▀ ▄▀█ █', '█▄█ █▀▄ █▄█ █▀█ █'] as const
const WORDMARK_WIDTH = textWidth(WORDMARK[0])

/** Includes a breathing row below the two-line mark; callers reserve this exact height. */
export function brandHeight(width: number, env: TuiEnv, prominent = false): 1 | 3 {
  return prominent && width >= 44 && env.bufferMode === 'fullscreen' && !asciiOnly(env) ? 3 : 1
}

/** A static wordmark follows the terminal foreground: white in dark terminals. */
export function Brand({ width, version, prominent = false }: {
  width: number
  version?: string
  prominent?: boolean
}) {
  const env = useTuiEnv()
  const size = Math.max(0, Math.floor(width))
  const expanded = brandHeight(size, env, prominent) === 3
  const suffix = version ? `  ${version}` : ''
  if (expanded) {
    const metadata = truncateEnd(`OrgAI${suffix}`, Math.max(0, size - WORDMARK_WIDTH - 3), glyphs(env).ellipsis)
    return <Box width={size} height={3} flexDirection="column" flexShrink={0} overflow="hidden">
      <Box width={size} height={1} flexShrink={0}>
        <Text bold={env.color}>{WORDMARK[0]}</Text>
        <Text>   </Text>
        <Text bold={env.color}>{metadata.startsWith('OrgAI') ? 'OrgAI' : metadata}<Text dimColor={env.color}>{metadata.startsWith('OrgAI') ? metadata.slice(5) : ''}</Text></Text>
      </Box>
      <Text bold={env.color}>{WORDMARK[1]}</Text>
      <Text> </Text>
    </Box>
  }
  const wordmark = `${asciiOnly(env) ? '*' : '✦'} OrgAI`
  const label = truncateEnd(`${wordmark}${suffix}`, size, glyphs(env).ellipsis)
  const visibleWordmark = label.startsWith(wordmark) ? wordmark : label
  const rest = label.slice(visibleWordmark.length)
  return (
    <Text bold={env.color} wrap="truncate-end">
      {visibleWordmark}
      {rest ? <Text dimColor={env.color}>{rest}</Text> : null}
    </Text>
  )
}
