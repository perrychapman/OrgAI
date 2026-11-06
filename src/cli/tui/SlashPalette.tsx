/**
 * The slash command palette (W4-T4): an overlay list above the Composer. The query line is editable (typing filters,
 * Backspace on a bare '/' closes), Up / Down select, Tab completes the selected name, Enter runs it with the typed
 * arguments, Esc (or Ctrl+C) closes. Input arrives through the InputBus ('palette'), never Ink's useInput.
 */
import { Box, Text } from 'ink'
import { useMemo, useRef, useState } from 'react'
import { useFocusHandler, useTuiEnv } from './context'
import { cleanLine, matchCommands, parseSlash } from './slashCommands'
import { sanitizeTty } from './sanitizeTty'
import { asciiOnly, toneColor } from './theme'
import type { InputEvent, SlashCommand, SlashPaletteProps, TuiState } from './types'

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function dropLastGrapheme(s: string): string {
  const parts = Array.from(segmenter.segment(s), (g) => g.segment)
  parts.pop()
  return parts.join('')
}

/** A query always starts with '/' and is one line. */
function normalizeQuery(q: string): string {
  const one = sanitizeTty(q ?? '').replace(/\n/g, ' ')
  return one.startsWith('/') ? one : `/${one}`
}

export interface PaletteState {
  query: string
  selected: number
}

export type PaletteAction = { kind: 'close' } | { kind: 'run'; cmd: SlashCommand; args: string }

/** The command Enter runs: an exact name or alias typed as the first word wins over the selection. */
function chosen(matches: SlashCommand[], query: string, selected: number): SlashCommand | undefined {
  const parsed = parseSlash(query)
  if (parsed) {
    const exact = matches.find((c) => c.name === parsed.name || (c.aliases ?? []).includes(parsed.name))
    if (exact) return exact
  }
  return matches[Math.max(0, Math.min(selected, matches.length - 1))]
}

/** Pure palette step: the next state, an action, or null when the event is not the palette's. */
export function paletteReduce(
  st: PaletteState,
  e: InputEvent,
  commands: readonly SlashCommand[],
  state: TuiState
): { st: PaletteState; action?: PaletteAction } | null {
  const matches = matchCommands(commands, st.query, state)
  if (e.type === 'paste') return { st: { query: normalizeQuery(st.query + e.text), selected: 0 } }
  switch (e.name) {
    case 'char': {
      if (e.ctrl && e.ch === 'c') return { st, action: { kind: 'close' } }
      if (e.ctrl && e.ch === 'u') return { st: { query: '/', selected: 0 } }
      if (e.ctrl || e.alt || !e.ch) return null
      return { st: { query: normalizeQuery(st.query + e.ch), selected: 0 } }
    }
    case 'backspace': {
      if (st.query === '/' || st.query === '') return { st, action: { kind: 'close' } }
      return { st: { query: normalizeQuery(dropLastGrapheme(st.query)), selected: 0 } }
    }
    case 'up':
      return { st: { ...st, selected: matches.length ? (st.selected - 1 + matches.length) % matches.length : 0 } }
    case 'down':
      return { st: { ...st, selected: matches.length ? (st.selected + 1) % matches.length : 0 } }
    case 'tab': {
      const cmd = matches[Math.min(st.selected, matches.length - 1)]
      if (!cmd) return { st }
      const args = parseSlash(st.query)?.args ?? ''
      return { st: { query: `/${cmd.name} ${args}`, selected: 0 } }
    }
    case 'enter': {
      const cmd = chosen(matches, st.query, st.selected)
      if (!cmd) return { st }
      return { st, action: { kind: 'run', cmd, args: parseSlash(st.query)?.args ?? '' } }
    }
    case 'escape':
      return { st, action: { kind: 'close' } }
    default:
      return null
  }
}

export function SlashPalette(props: SlashPaletteProps) {
  const env = useTuiEnv()
  const ascii = asciiOnly(env)
  const [st, setSt] = useState<PaletteState>(() => ({ query: normalizeQuery(props.query || '/'), selected: 0 }))
  const stRef = useRef(st)
  const propsRef = useRef(props)
  propsRef.current = props

  useFocusHandler(
    'palette',
    (e) => {
      const p = propsRef.current
      const r = paletteReduce(stRef.current, e, p.commands, p.state)
      if (!r) return false
      if (r.st !== stRef.current) {
        stRef.current = r.st
        setSt(r.st)
      }
      if (r.action?.kind === 'close') p.onClose()
      else if (r.action?.kind === 'run') p.onRun(r.action.cmd, r.action.args)
      return true
    },
    props.focused
  )

  const matches = useMemo(() => matchCommands(props.commands, st.query, props.state), [props.commands, props.state, st.query])
  const listRows = Math.max(1, props.height - 1)
  const sel = Math.min(st.selected, Math.max(0, matches.length - 1))
  const first = Math.max(0, Math.min(sel - listRows + 1, matches.length - listRows))
  const shown = matches.slice(first, first + listRows)
  const accent = toneColor('accent', env)
  const dim = toneColor('dim', env)
  const marker = ascii ? '>' : '›'

  return (
    <Box flexDirection="column" width={props.width}>
      <Box>
        <Text color={accent} wrap="truncate-end">
          {st.query}
        </Text>
        {props.focused ? <Text inverse> </Text> : null}
      </Box>
      {matches.length === 0 ? (
        <Text dimColor color={dim}>
          No matching command. Esc closes.
        </Text>
      ) : (
        shown.map((cmd, i) => {
          const isSel = first + i === sel
          const head = `/${cleanLine(cmd.name, 32)}${cmd.args ? ` ${cleanLine(cmd.args, 40)}` : ''}`
          return (
            <Box key={cmd.name}>
              <Text inverse={isSel} wrap="truncate-end">
                {`${isSel ? marker : ' '} ${head.padEnd(20)} `}
              </Text>
              <Text dimColor color={dim} wrap="truncate-end">
                {cleanLine(cmd.summary, 120)}
              </Text>
            </Box>
          )
        })
      )}
    </Box>
  )
}
