/**
 * The Decision Tray (cli-spec 5.3, W4-T2). Keys reach it only while it has focus, through the InputBus
 * (useFocusHandler 'tray'); characters typed in the Composer never get here.
 *
 * - Card-swap guard: whenever the top card's key changes (another card, or the same request at a new revision) action
 *   keys are ignored for CARD_SWAP_GUARD_MS; the guard is observed at render and again inside the key handler, so a
 *   key that arrives before the new frame is drawn is still measured against the new card.
 * - Two-step actions (always allow / grant for project, discard a worktree, save an MCP install) open a confirmation
 *   bound to the card key. If that card leaves the tray or changes while it is open (or a note or secret field is
 *   open), it closes at once with a status line ("Resolved in another window (the desktop app)").
 * - TERM=dumb: a single-key action is shown as pending and only Enter commits it (Esc clears).
 * - Secrets are typed into a masked field, never rendered, and dropped from memory when the call is made.
 * - One decision call at a time; the outcome becomes a status line.
 *
 * Mutable tray state lives in a ref (several keys can arrive before React re-renders); `bump` re-renders.
 */
import { Box, Text } from 'ink'
import { useLayoutEffect, useRef, useState } from 'react'
import { CardSwapGuard } from './cardGuard'
import { applyEdit, shownValue } from './cards/textEdit'
import { boundCardClosedStatus, outcomeStatus, rejectionStatus, type TrayStatus } from './cards/status'
import { useFocusHandler, useTuiEnv } from './context'
import {
  bindingsFor,
  cardDetailLines,
  cardFullText,
  cardKindWord,
  cardTitle,
  confirmQuestion,
  decisionFor,
  secretSlotsFor,
  wrapLine,
  type SecretSlotView,
  type TrayAction,
  type TrayBinding
} from './decisions'
import { glyphs, toneColor } from './theme'
import type { DecisionTrayProps, InputEvent, KeyEvent, TrayCard, TuiEnv } from './types'

type Mode =
  | { t: 'idle' }
  | { t: 'confirm'; key: string; binding: TrayBinding }
  | { t: 'text'; key: string; binding: TrayBinding; value: string }
  | {
      t: 'secrets'
      key: string
      /** The action the secrets go with (approve, allow-run, save-project, save-library). */
      binding: TrayBinding
      slots: SecretSlotView[]
      index: number
      /** Collected values; cleared as soon as the call is built. */
      values: Record<string, string>
      value: string
      /** MCP installs need every value; proposal secrets may be left for later. */
      required: boolean
    }

interface QuestionState {
  key: string
  cursor: number
  selected: number[]
}

interface TrayState {
  mode: Mode
  status?: TrayStatus
  /** TERM=dumb: the key waiting for Enter. */
  pending?: { key: string; event: KeyEvent }
  busy: boolean
  guardHint: boolean
  scroll: number
  scrollKey?: string
  question?: QuestionState
}

const NAV_KEYS = new Set(['up', 'down', 'pageup', 'pagedown', 'home', 'end'])
const NEXT_CARDS_MAX = 3

/** `cards` with the card of `key` moved to the front (unchanged when it is not there). */
function orderFirst(cards: TrayCard[], key: string): TrayCard[] {
  const at = cards.findIndex((c) => c.key === key)
  return at <= 0 ? cards : [cards[at], ...cards.slice(0, at), ...cards.slice(at + 1)]
}

function keyLabel(k: string): string {
  return k === 'space' ? 'Space' : k === 'enter' ? 'Enter' : k
}

function bindingKeyOf(e: KeyEvent): string | undefined {
  if (e.ctrl || e.alt) return undefined
  if (e.name === 'enter') return 'enter'
  if (e.name !== 'char' || typeof e.ch !== 'string') return undefined
  if (e.ch === ' ') return 'space'
  return e.ch.toLowerCase()
}

/** Hint text for a card's bindings. */
function hintsFor(card: TrayCard, env: TuiEnv): string {
  const bs = bindingsFor(card)
  const parts: string[] = []
  const picks = bs.filter((b) => b.act === 'pick')
  if (picks.length) parts.push(picks.length === 1 ? '1 Pick' : `1-${picks.length} Pick`)
  for (const b of bs) if (b.act !== 'pick') parts.push(`${keyLabel(b.key)} ${b.label}`)
  parts.push('Esc Back')
  return parts.join(' · ') + (env.dumbTerminal ? ' (then Enter)' : '')
}

function actionFor(card: TrayCard, b: TrayBinding, extra: { text?: string; secrets?: Record<string, string> } = {}): TrayAction | null {
  switch (card.kind) {
    case 'permission':
      if (b.act === 'deny') return { kind: 'permission', act: 'deny', message: extra.text }
      if (b.act === 'allow-once' || b.act === 'allow-session' || b.act === 'allow-project') return { kind: 'permission', act: b.act }
      return null
    case 'rules':
      if (b.act === 'deny') return { kind: 'rules', act: 'deny', message: extra.text }
      if (b.act === 'grant-run' || b.act === 'grant-project') return { kind: 'rules', act: b.act }
      return null
    case 'proposal':
      if (b.act === 'approve' || b.act === 'secrets') return { kind: 'proposal', act: 'approve', secrets: extra.secrets }
      if (b.act === 'revise') return { kind: 'proposal', act: 'revise', feedback: extra.text ?? '' }
      if (b.act === 'decline') return { kind: 'proposal', act: 'decline', note: extra.text }
      return null
    case 'merge':
      if (b.act === 'merge' || b.act === 'hold' || b.act === 'discard') return { kind: 'merge', act: b.act }
      return null
    case 'mcpInstall':
      if (b.act === 'deny') return { kind: 'mcpInstall', act: 'deny', note: extra.text }
      if (b.act === 'allow-run' || b.act === 'save-project' || b.act === 'save-library') return { kind: 'mcpInstall', act: b.act, secrets: extra.secrets }
      return null
    case 'question':
      return null
  }
}

export function DecisionTray(props: DecisionTrayProps) {
  const env = useTuiEnv()
  const g = glyphs(env)
  const now = props.now ?? Date.now
  const guardRef = useRef<CardSwapGuard | null>(null)
  if (!guardRef.current) guardRef.current = new CardSwapGuard()
  const guard = guardRef.current
  const st = useRef<TrayState>({ mode: { t: 'idle' }, busy: false, guardHint: false, scroll: 0 }).current
  const [, setTick] = useState(0)
  const mounted = useRef(true)
  const bump = (): void => {
    if (mounted.current) setTick((n) => n + 1)
  }
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      clearSecrets()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Enter on an agent row asks for that agent's card first; the rest keep their order. A key that is no longer open is ignored.
  const cards = props.focusKey ? orderFirst(props.cards, props.focusKey) : props.cards
  const top: TrayCard | undefined = cards[0]
  const topKey = top?.key

  function clearSecrets(): void {
    if (st.mode.t === 'secrets') {
      st.mode.values = {}
      st.mode.value = ''
    }
  }

  function closeMode(status?: TrayStatus): void {
    clearSecrets()
    st.mode = { t: 'idle' }
    st.pending = undefined
    if (status) st.status = status
  }

  /** Closes a bound mode whose card is no longer the top card; resets per-card state. Returns true when it changed anything. */
  function syncWithTop(): boolean {
    let changed = false
    if (st.mode.t !== 'idle' && st.mode.key !== topKey) {
      const boundKey = st.mode.key
      const bound = cards.find((c) => c.key === boundKey) ?? props.resolved.find((r) => r.key === boundKey) ?? parseBound(boundKey)
      closeMode(bound ? boundCardClosedStatus(bound, props.resolved) : { text: 'The card changed', tone: 'dim' })
      changed = true
    }
    if (st.pending && st.pending.key !== topKey) {
      st.pending = undefined
      changed = true
    }
    if (st.scrollKey !== topKey) {
      st.scrollKey = topKey
      st.scroll = 0
      st.guardHint = false
    }
    if (top?.kind === 'question' && st.question?.key !== topKey) st.question = { key: top.key, cursor: 0, selected: [] }
    return changed
  }

  // Render-time observation: the window starts when a card is shown, before any key for it can arrive.
  guard.observe(topKey, now())
  syncWithTop()

  useLayoutEffect(() => {
    guard.observe(topKey, now())
    if (syncWithTop()) bump()
  })

  async function send(card: TrayCard, action: TrayAction): Promise<void> {
    if (st.busy) return
    let call
    try {
      call = decisionFor(card, action)
    } catch (e) {
      st.status = rejectionStatus(e)
      bump()
      return
    }
    st.busy = true
    st.status = { text: 'Sending...', tone: 'dim' }
    bump()
    try {
      const outcome = await props.onDecide(card, call)
      st.status = outcomeStatus(outcome)
    } catch (e) {
      st.status = rejectionStatus(e)
    } finally {
      st.busy = false
      // Nothing secret stays reachable from the call object we built.
      call = undefined
      bump()
    }
  }

  /** Run a binding after any confirmation: collect secrets or a note when it needs them, else send. */
  function proceed(card: TrayCard, b: TrayBinding): void {
    const slots = secretSlotsFor(card)
    const needsSecrets =
      (card.kind === 'mcpInstall' && b.act !== 'deny' && slots.length > 0) || (card.kind === 'proposal' && b.act === 'secrets' && slots.length > 0)
    if (needsSecrets) {
      st.mode = { t: 'secrets', key: card.key, binding: b, slots, index: 0, values: {}, value: '', required: card.kind === 'mcpInstall' }
      st.status = undefined
      bump()
      return
    }
    if (b.text) {
      st.mode = { t: 'text', key: card.key, binding: b, value: '' }
      st.status = undefined
      bump()
      return
    }
    const action = actionFor(card, b)
    if (action) void send(card, action)
  }

  function runBinding(card: TrayCard, b: TrayBinding): void {
    if (b.act === 'view') {
      const title = cardTitle(card)
      void props.onViewText(title, cardFullText(card)).catch((e: unknown) => {
        st.status = rejectionStatus(e)
        bump()
      })
      return
    }
    if (card.kind === 'question') {
      questionKey(card, b)
      return
    }
    if (b.twoStep) {
      st.mode = { t: 'confirm', key: card.key, binding: b }
      st.status = undefined
      bump()
      return
    }
    proceed(card, b)
  }

  function questionKey(card: Extract<TrayCard, { kind: 'question' }>, b: TrayBinding): void {
    const q = card.card
    const qs = st.question ?? (st.question = { key: card.key, cursor: 0, selected: [] })
    const options = Array.isArray(q.options) ? q.options : []
    if (b.act === 'pick') {
      const i = Number(b.key) - 1
      if (i < 0 || i >= options.length) return
      qs.cursor = i
      if (!q.allowMultiple) qs.selected = [i]
      st.status = undefined
      bump()
      return
    }
    if (b.act === 'toggle') {
      const i = qs.cursor
      qs.selected = qs.selected.includes(i) ? qs.selected.filter((x) => x !== i) : [...qs.selected, i].sort((a, z) => a - z)
      bump()
      return
    }
    if (b.act === 'custom') {
      st.mode = { t: 'text', key: card.key, binding: b, value: '' }
      st.status = undefined
      bump()
      return
    }
    if (b.act === 'submit') {
      if (qs.selected.length === 0) {
        st.status = { text: q.allowFreeText ? 'Pick an option first, or press c to type an answer' : 'Pick an option first', tone: 'warn' }
        bump()
        return
      }
      void send(card, { kind: 'question', act: 'answer', selected: qs.selected.map((i) => options[i]?.label).filter((l): l is string => typeof l === 'string') })
    }
  }

  function submitText(card: TrayCard, mode: Extract<Mode, { t: 'text' }>, value: string): void {
    if (mode.binding.text === 'required' && value.trim() === '') {
      st.status = { text: card.kind === 'question' ? 'Type an answer, or Esc to cancel' : 'Type what to change, or Esc to cancel', tone: 'warn' }
      bump()
      return
    }
    closeMode()
    if (card.kind === 'question') {
      const options = Array.isArray(card.card.options) ? card.card.options : []
      const selected = (st.question?.key === card.key ? st.question.selected : []).map((i) => options[i]?.label).filter((l): l is string => typeof l === 'string')
      void send(card, { kind: 'question', act: 'answer', selected, text: value })
      return
    }
    const action = actionFor(card, mode.binding, { text: value })
    if (action) void send(card, action)
  }

  function secretStep(card: TrayCard, mode: Extract<Mode, { t: 'secrets' }>, value: string): void {
    if (mode.required && value === '') {
      st.status = { text: `${mode.slots[mode.index]?.label ?? 'This secret'} is required, or Esc to cancel`, tone: 'warn' }
      bump()
      return
    }
    const slot = mode.slots[mode.index]
    if (slot && value !== '') mode.values[slot.key] = value
    mode.value = ''
    if (mode.index + 1 < mode.slots.length) {
      mode.index += 1
      st.status = undefined
      bump()
      return
    }
    const secrets = mode.values
    const binding = mode.binding
    // Out of component state before the call: the values live only in the payload being sent.
    mode.values = {}
    st.mode = { t: 'idle' }
    const action = actionFor(card, binding, { secrets })
    if (action) void send(card, action)
  }

  function scrollBy(e: KeyEvent, bodyRows: number, total: number): void {
    const max = Math.max(0, total - bodyRows)
    const step = e.name === 'pageup' || e.name === 'pagedown' ? Math.max(1, bodyRows - 1) : 1
    if (e.name === 'up' || e.name === 'pageup') st.scroll = Math.max(0, st.scroll - step)
    else if (e.name === 'down' || e.name === 'pagedown') st.scroll = Math.min(max, st.scroll + step)
    else if (e.name === 'home') st.scroll = 0
    else if (e.name === 'end') st.scroll = max
    bump()
  }

  // ---------- Layout ----------

  const width = Math.max(20, props.width)
  const detail = top ? cardDetailLines(top, width - 2) : []
  const statusRows = st.status ? 1 : 0
  const hints = top ? wrapLine(hintsFor(top, env), width) : []
  const nextCards = cards.slice(1, 1 + NEXT_CARDS_MAX)
  const moreRows = cards.length - 1 > NEXT_CARDS_MAX ? 1 : 0
  const modeRows = st.mode.t !== 'idle' || st.pending ? 1 : 0
  const bodyRows = Math.max(1, props.height - 1 - statusRows - hints.length - nextCards.length - moreRows - modeRows)

  function handle(e: InputEvent): boolean {
    guard.observe(topKey, now())
    syncWithTop()
    const card = top
    if (e.type === 'key' && (e.name === 'backtab' || (e.name === 'escape' && st.mode.t === 'idle' && !st.pending))) {
      closeMode()
      props.onLeave()
      bump()
      return true
    }
    if (!card) return e.type === 'key'
    const mode = st.mode

    // Note and secret fields take every character and paste.
    if (mode.t === 'text' || mode.t === 'secrets') {
      const r = applyEdit(mode.value, e)
      if (r.kind === 'cancel') {
        closeMode({ text: 'Cancelled', tone: 'dim' })
        bump()
      } else if (r.kind === 'edit') {
        mode.value = r.value
        bump()
      } else if (r.kind === 'submit') {
        if (mode.t === 'text') submitText(card, mode, r.value)
        else secretStep(card, mode, r.value)
      }
      return true
    }
    if (e.type === 'paste') return true

    if (NAV_KEYS.has(e.name)) {
      scrollBy(e, bodyRows, detail.length)
      return true
    }
    if (e.name === 'escape') {
      if (st.pending) st.pending = undefined
      else closeMode({ text: 'Cancelled', tone: 'dim' })
      bump()
      return true
    }

    // TERM=dumb: Enter commits the pending key.
    let ev: KeyEvent = e
    let committed = false
    if (env.dumbTerminal && e.name === 'enter' && st.pending) {
      ev = st.pending.event
      st.pending = undefined
      committed = true
    }

    const k = bindingKeyOf(ev)
    if (!k) return true

    if (st.busy) {
      st.status = { text: 'Still sending the last decision...', tone: 'dim' }
      bump()
      return true
    }
    if (!guard.accepts(now())) {
      st.guardHint = true
      st.pending = undefined
      bump()
      return true
    }
    st.guardHint = false

    if (mode.t === 'confirm') {
      if (k === 'y' || k === mode.binding.key) {
        if (env.dumbTerminal && !committed) {
          st.pending = { key: card.key, event: ev }
          bump()
          return true
        }
        const b = mode.binding
        st.mode = { t: 'idle' }
        proceed(card, b)
        bump()
      }
      return true
    }

    const b = bindingsFor(card).find((x) => x.key === k)
    if (!b) return true
    const gated = env.dumbTerminal && !committed && b.act !== 'pick' && b.act !== 'toggle' && b.act !== 'submit'
    if (gated) {
      st.pending = { key: card.key, event: ev }
      bump()
      return true
    }
    runBinding(card, b)
    return true
  }

  useFocusHandler('tray', handle, props.focused)

  // ---------- Render ----------

  const color = (tone: TrayStatus['tone']): string | undefined => toneColor(tone, env)
  const statusLine = st.status ? (
    <Text color={color(st.status.tone)} dimColor={st.status.tone === 'dim' && !env.color} wrap="truncate-end">
      {st.status.text}
    </Text>
  ) : null

  const modeLine = renderModeLine()

  function renderModeLine(): string | null {
    const m = st.mode
    if (m.t === 'confirm' && top) {
      const keys = m.binding.key === 'y' ? 'y' : `${m.binding.key}/y`
      return `${confirmQuestion(top, m.binding)} ${keys} to confirm${env.dumbTerminal ? ' (then Enter)' : ''}, Esc to cancel`
    }
    if (m.t === 'text') {
      const label = m.binding.act === 'revise' ? 'What should change' : m.binding.act === 'custom' ? 'Your answer' : 'Note (optional)'
      return `${label}: ${shownValue(m.value, false, width - label.length - 30)}_  Enter sends, Esc cancels`
    }
    if (m.t === 'secrets') {
      const slot = m.slots[m.index]
      const n = `${m.index + 1}/${m.slots.length}`
      return `Secret ${n} ${slot?.label ?? ''}${m.required ? '' : ' (optional)'}: ${shownValue(m.value, true, 24)}_  Enter next, Esc cancels`
    }
    if (st.pending) return `Pending: ${st.pending.event.ch ?? ''}. Enter commits, Esc clears`
    return null
  }

  if (!top) {
    if (props.variant === 'footer') return statusLine ?? <Text dimColor>No decisions waiting</Text>
    return (
      <Box flexDirection="column" width={width}>
        <Text dimColor>Needs you: nothing waiting</Text>
        {statusLine}
      </Box>
    )
  }

  const title = cardTitle(top)
  const guardMark = st.guardHint && !guard.accepts(now()) ? ` ${g.ellipsis}` : ''

  if (props.variant === 'footer') {
    const who = top.agentLabel ? `${top.agentLabel}: ` : ''
    const text = modeLine ?? (st.status ? `${title} · ${st.status.text}` : `${top.runTag} ${who}${title} · ${hintsFor(top, env)}`)
    return (
      <Box width={width}>
        <Text wrap="truncate-end" color={modeLine ? toneColor('warn', env) : undefined}>
          {text}
          {guardMark}
        </Text>
      </Box>
    )
  }

  const shown = detail.slice(st.scroll, st.scroll + bodyRows)
  const q = top.kind === 'question' && st.question?.key === top.key ? st.question : undefined
  const header = `Needs you (${cards.length}) ${g.bullet} ${top.runTag} ${g.bullet} ${top.agentLabel ? `${top.agentLabel} ${g.bullet} ` : ''}${cardKindWord(top)}: ${title}`
  return (
    <Box flexDirection="column" width={width}>
      <Text bold color={toneColor('warn', env)} wrap="truncate-end">
        {header}
        {guardMark}
      </Text>
      {shown.map((l, i) => (
        <Text key={`d${st.scroll + i}`} wrap="truncate-end">
          {' '}
          {questionMark(l, q, top)}
          {l}
        </Text>
      ))}
      {modeLine ? (
        <Text color={toneColor('warn', env)} wrap="truncate-end">
          {modeLine}
        </Text>
      ) : null}
      {statusLine}
      {hints.map((h, i) => (
        <Text key={`h${i}`} color={toneColor('accent', env)} wrap="truncate-end">
          {h}
        </Text>
      ))}
      {nextCards.map((c) => (
        <Text key={c.key} dimColor wrap="truncate-end">
          {g.arrow} {c.runTag} {cardTitle(c)}
        </Text>
      ))}
      {moreRows ? <Text dimColor>and {cards.length - 1 - NEXT_CARDS_MAX} more</Text> : null}
    </Box>
  )
}

/** A selection marker before a question's numbered option line ("[x] 2. SQLite"). */
function questionMark(line: string, q: QuestionState | undefined, card: TrayCard): string {
  if (card.kind !== 'question' || !q) return ''
  const m = /^(\d)\. /.exec(line)
  if (!m) return ''
  const i = Number(m[1]) - 1
  const on = q.selected.includes(i)
  const cursor = card.card.allowMultiple && q.cursor === i ? '>' : ' '
  return `${cursor}${card.card.allowMultiple ? (on ? '[x]' : '[ ]') : on ? '(*)' : '( )'} `
}

/** A bound card key ("host|run|kind|request|revision") as a ref, for the closed-confirmation sentence. */
function parseBound(key: string): Pick<TrayCard, 'key' | 'ref'> | undefined {
  const parts = key.split('|')
  if (parts.length < 5) return undefined
  const revision = Number(parts[parts.length - 1])
  const [hostInstanceId, runId, kind] = parts
  const requestId = parts.slice(3, -1).join('|')
  return { key, ref: { hostInstanceId, runId, kind: kind as TrayCard['ref']['kind'], requestId, revision } }
}
