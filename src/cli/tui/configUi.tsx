/**
 * The parts the Team and Settings views share (cli-parity 3.7): one framed screen (title, body, an in-place message,
 * a footer of keys) and the small dialogs an edit opens inside it (pick one, tick several, type a value, confirm).
 * Keyboard only; Esc always backs out one level. Every line is cut to the width here (least important text last in
 * the producer's order), so nothing depends on Ink's own wrapping.
 */
import { Box, Text } from 'ink'
import { cutSegs, PaneLines, styleFor, type PaneLine, type Seg } from './panes/lines'
import { truncateEnd, wrapText } from './panes/text'
import { sanitizeTty } from './sanitizeTty'
import { asciiOnly, glyphs, separatorFor } from './theme'
import type { InputEvent, TuiEnv } from './types'

export interface PickOption {
  value: string
  label: string
  /** Shown dim after the label, cut first when the line is narrow. */
  detail?: string
}

export type Dialog =
  | { kind: 'pick'; title: string; options: PickOption[]; sel: number; onPick(value: string): void }
  | { kind: 'checks'; title: string; options: PickOption[]; checked: string[]; sel: number; onDone(values: string[]): void }
  | { kind: 'input'; title: string; text: string; hint: string; onSubmit(text: string): void }
  /** `lines` are read before `y`; n or Esc cancels. */
  | { kind: 'confirm'; title: string; lines: string[]; onYes(): void }

/** A message shown in place above the footer. */
export interface Message {
  text: string
  tone: 'danger' | 'ok' | 'warn' | 'dim'
}

/** One untrusted line for the terminal: sanitized, whitespace folded. */
export const clean = (s: unknown, max = 400): string => {
  const t = sanitizeTty(typeof s === 'string' ? s : String(s ?? '')).replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** An error from validation or the host, cleaned for the terminal. */
export const errorMessage = (e: unknown): Message => ({ text: clean(e instanceof Error ? e.message : String(e), 600) || 'Something went wrong.', tone: 'danger' })

const isChar = (e: InputEvent): e is Extract<InputEvent, { type: 'key' }> & { ch: string } => e.type === 'key' && e.name === 'char' && !e.ctrl && !e.alt && typeof e.ch === 'string'
export const keyIs = (e: InputEvent, name: string): boolean => e.type === 'key' && e.name === name
export const charOf = (e: InputEvent): string | undefined => (isChar(e) ? e.ch : undefined)
export const isCtrlC = (e: InputEvent): boolean => e.type === 'key' && e.name === 'char' && e.ctrl && e.ch === 'c'

/** List movement shared by every list: Up/Down (j/k), Home/End, PgUp/PgDn. Undefined when the key is not a move. */
export function moveSel(e: InputEvent, sel: number, count: number, page: number): number | undefined {
  if (count <= 0) return undefined
  const ch = charOf(e)
  if (keyIs(e, 'down') || ch === 'j') return Math.min(count - 1, sel + 1)
  if (keyIs(e, 'up') || ch === 'k') return Math.max(0, sel - 1)
  if (keyIs(e, 'home')) return 0
  if (keyIs(e, 'end')) return count - 1
  if (keyIs(e, 'pagedown')) return Math.min(count - 1, sel + Math.max(1, page))
  if (keyIs(e, 'pageup')) return Math.max(0, sel - Math.max(1, page))
  return undefined
}

/**
 * The key handling of an open dialog: the dialog to show next (undefined closes it; Esc / Ctrl+C close it) and, for a
 * choice made, the callback to run after the dialog is set (so a callback may open the next dialog).
 */
export function dialogKey(d: Dialog, e: InputEvent, page: number): { next: Dialog | undefined; then?: () => void } {
  if (keyIs(e, 'escape') || isCtrlC(e)) return { next: undefined }
  const ch = charOf(e)
  switch (d.kind) {
    case 'pick': {
      const moved = moveSel(e, d.sel, d.options.length, page)
      if (moved !== undefined) return { next: { ...d, sel: moved } }
      const o = d.options[d.sel]
      if (keyIs(e, 'enter') && o) return { next: undefined, then: () => d.onPick(o.value) }
      return { next: d }
    }
    case 'checks': {
      const moved = moveSel(e, d.sel, d.options.length, page)
      if (moved !== undefined) return { next: { ...d, sel: moved } }
      if (ch === ' ' || ch === 'x') {
        const v = d.options[d.sel]?.value
        if (v === undefined) return { next: d }
        return { next: { ...d, checked: d.checked.includes(v) ? d.checked.filter((x) => x !== v) : [...d.checked, v] } }
      }
      if (keyIs(e, 'enter')) {
        const values = d.options.map((o) => o.value).filter((v) => d.checked.includes(v))
        return { next: undefined, then: () => d.onDone(values) }
      }
      return { next: d }
    }
    case 'input': {
      if (keyIs(e, 'enter')) return { next: undefined, then: () => d.onSubmit(d.text) }
      if (keyIs(e, 'backspace') || keyIs(e, 'delete')) return { next: { ...d, text: Array.from(d.text).slice(0, -1).join('') } }
      if (e.type === 'paste') return { next: { ...d, text: (d.text + e.text.replace(/[\r\n]+/g, ' ')).slice(0, 400) } }
      if (ch !== undefined && ch >= ' ') return { next: { ...d, text: (d.text + ch).slice(0, 400) } }
      return { next: d }
    }
    case 'confirm': {
      if (ch === 'y' || ch === 'Y') return { next: undefined, then: d.onYes }
      if (ch === 'n' || ch === 'N') return { next: undefined }
      return { next: d }
    }
  }
}

/** The footer keys of an open dialog. */
export function dialogKeys(d: Dialog): string[] {
  switch (d.kind) {
    case 'pick':
      return ['Up/Down select', 'Enter picks', 'Esc back']
    case 'checks':
      return ['Up/Down select', 'Space toggles', 'Enter saves', 'Esc back']
    case 'input':
      return ['type the value', 'Enter saves', 'Esc back']
    case 'confirm':
      return ['y confirms', 'n or Esc cancels']
  }
}

/** A list window of `room` rows that keeps `sel` in view. */
export function windowOf<T>(items: readonly T[], sel: number, room: number): { start: number; items: T[] } {
  const r = Math.max(1, room)
  const start = Math.max(0, Math.min(sel - Math.floor(r / 2), items.length - r))
  return { start, items: items.slice(start, start + r) }
}

/** An option line: marker, label, then the detail (cut first). */
function optionLine(key: string, o: PickOption, selected: boolean, width: number, env: TuiEnv, check?: boolean): PaneLine {
  const marker = selected ? '> ' : '  '
  const box = check === undefined ? '' : asciiOnly(env) ? (check ? '[x] ' : '[ ] ') : check ? '[x] ' : '[ ] '
  const head = `${marker}${box}${clean(o.label, 200)}`
  const detail = o.detail ? clean(o.detail, 300) : ''
  const ell = glyphs(env).ellipsis
  const segs: Seg[] = [{ text: truncateEnd(head, width, ell), ...(selected ? { bold: true, tone: 'accent' as const } : {}) }]
  const room = width - segs[0].text.length - 2
  if (detail && room >= 6) segs.push({ text: `  ${truncateEnd(detail, room, ell)}`, dim: true })
  return { key, segs }
}

/** The body lines of an open dialog within `width` x `height` (title first). */
export function dialogLines(d: Dialog, width: number, height: number, env: TuiEnv): PaneLine[] {
  const ell = glyphs(env).ellipsis
  const out: PaneLine[] = [{ key: 'dtitle', segs: cutSegs([{ text: clean(d.title, 300), bold: true }], width, env) }]
  const room = Math.max(1, height - 1)
  switch (d.kind) {
    case 'pick': {
      const w = windowOf(d.options, d.sel, room)
      w.items.forEach((o, i) => out.push(optionLine(`o${w.start + i}`, o, w.start + i === d.sel, width, env)))
      break
    }
    case 'checks': {
      const w = windowOf(d.options, d.sel, room)
      w.items.forEach((o, i) => out.push(optionLine(`c${w.start + i}`, o, w.start + i === d.sel, width, env, d.checked.includes(o.value))))
      break
    }
    case 'input': {
      const cursor = asciiOnly(env) ? '_' : '▏'
      const shown = d.text.length > width - 4 ? `${ell}${d.text.slice(-(width - 4 - ell.length))}` : d.text
      out.push({ key: 'in', segs: [{ text: '> ', tone: 'accent' }, { text: shown }, { text: cursor, tone: 'accent' }] })
      if (d.hint) for (const [i, l] of wrapText(clean(d.hint, 400), width).entries()) out.push({ key: `h${i}`, segs: [{ text: l, dim: true }] })
      break
    }
    case 'confirm': {
      let i = 0
      for (const raw of d.lines) {
        for (const l of raw === '' ? [''] : wrapText(sanitizeTty(raw), width)) out.push({ key: `l${i++}`, segs: l ? [{ text: l, ...(raw.startsWith('May spend more') ? { tone: 'warn' as const } : {}) }] : [] })
      }
      break
    }
  }
  return out.slice(0, Math.max(1, height))
}

export interface ConfigFrameProps {
  width: number
  height: number
  env: TuiEnv
  title: string
  body: PaneLine[]
  message?: Message
  keys: string[]
}

/**
 * The screen of a view: an optional border (full screen, not for a screen reader), a bold title, the body, the message
 * in place and the keys (wrapped to at most three lines; two at 80 columns). `contentSize` gives the body's room for a frame.
 */
export function contentSize(width: number, height: number, env: TuiEnv, keys: string[], message?: Message): { width: number; bodyRows: number; framed: boolean } {
  const framed = env.bufferMode !== 'inline' && !env.screenReader
  const w = Math.max(10, width - (framed ? 4 : 2))
  const keyRows = Math.min(3, wrapText(keys.join(separatorFor(env)), w).length)
  const msgRows = message ? Math.min(3, wrapText(message.text, w).length) : 0
  const bodyRows = Math.max(1, height - (framed ? 2 : 0) - 1 - keyRows - msgRows)
  return { width: w, bodyRows, framed }
}

export function ConfigFrame(props: ConfigFrameProps) {
  const { env } = props
  const { width: w, bodyRows, framed } = contentSize(props.width, props.height, env, props.keys, props.message)
  const keyLines = wrapText(props.keys.join(separatorFor(env)), w).slice(0, 3)
  const msgLines = props.message ? wrapText(props.message.text, w).slice(0, 3) : []
  const border: { borderStyle?: 'single' | 'classic' } = framed ? { borderStyle: asciiOnly(env) ? 'classic' : 'single' } : {}
  return (
    <Box {...border} flexDirection="column" paddingX={framed ? 1 : 0} width={props.width} height={env.bufferMode === 'inline' ? undefined : props.height} flexShrink={0} overflow="hidden">
      <Text wrap="truncate-end" {...styleFor({ bold: true }, env)}>
        {truncateEnd(clean(props.title, 300), w, glyphs(env).ellipsis)}
      </Text>
      <PaneLines width={w} height={bodyRows} lines={props.body} env={env} />
      {msgLines.map((l, i) => (
        <Text key={`m${i}`} wrap="truncate-end" {...styleFor({ tone: props.message!.tone }, env)}>
          {l}
        </Text>
      ))}
      {keyLines.map((l, i) => (
        <Text key={`k${i}`} wrap="truncate-end" {...styleFor({ dim: true }, env)}>
          {l}
        </Text>
      ))}
    </Box>
  )
}
