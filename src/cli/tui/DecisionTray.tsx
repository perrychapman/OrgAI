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
  cardDetail,
  cardFullView,
  cardKindWord,
  cardTitle,
  confirmQuestion,
  decisionFor,
  hintPhrases,
  proposalPreview,
  secretSlotsFor,
  wrapPhrases,
  type SecretSlotView,
  type TrayAction,
  type TrayBinding
} from './decisions'
import { UNFOCUSED_HINT } from './keymap'
import { styleFor, type Seg } from './panes/lines'
import { truncateEnd } from './panes/text'
import { asciiOnly, glyphs, separatorFor, toneColor } from './theme'
import { NEXT_CARDS_MAX, PROPOSAL_CARD_MAX_WIDTH } from './trayLayout'
import type { DecisionTrayProps, InputEvent, KeyEvent, TrayCard } from './types'

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
  /** The last line of the card body has been on screen (or v was used): permission keys y / s / a unlock. */
  readAll: boolean
  question?: QuestionState
}

const NAV_KEYS = new Set(['up', 'down', 'pageup', 'pagedown', 'home', 'end'])
/** The decision keys a long permission card holds back until its body was read. */
const GATED_KEYS = new Set(['y', 's', 'a'])
/** The shortest body worth showing beside the queue and hints. */
const MIN_BODY_FOR_QUEUE = 3

/** `cards` with the card of `key` moved to the front (unchanged when it is not there). */
function orderFirst(cards: TrayCard[], key: string): TrayCard[] {
  const at = cards.findIndex((c) => c.key === key)
  return at <= 0 ? cards : [cards[at], ...cards.slice(0, at), ...cards.slice(at + 1)]
}

function bindingKeyOf(e: KeyEvent): string | undefined {
  if (e.ctrl || e.alt) return undefined
  if (e.name === 'enter') return 'enter'
  if (e.name !== 'char' || typeof e.ch !== 'string') return undefined
  if (e.ch === ' ') return 'space'
  return e.ch.toLowerCase()
}

/** What a key inside the swap-guard window is told: the card was replaced, or it only just arrived (R2-L6). */
export const GUARD_SWAPPED_NOTICE = 'The card just changed: wait a moment, then press the key again.'
export const GUARD_ARRIVED_NOTICE = 'This card only just arrived: wait a moment, then press the key again.'


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

export function DecisionTray(props: DecisionTrayProps & { compact?: boolean }) {
  const env = useTuiEnv()
  const g = glyphs(env)
  const now = props.now ?? Date.now
  const guardRef = useRef<CardSwapGuard | null>(null)
  if (!guardRef.current) guardRef.current = new CardSwapGuard()
  const guard = guardRef.current
  const sep = separatorFor(env)
  const st = useRef<TrayState>({ mode: { t: 'idle' }, busy: false, guardHint: false, scroll: 0, readAll: false }).current
  const notice = (text: string, tone?: TrayStatus['tone']): void => props.onNotice?.(text, tone ?? 'warn')
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
      st.readAll = false
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
      const full = cardFullView(card)
      if (full.cut && card.kind === 'permission') {
        // The full view itself is cut: the rest of the command cannot be read here, so v does not unlock y / s / a.
        st.status = { text: 'The full view is cut at 64 KB: the rest cannot be read here. Deny it, or answer elsewhere.', tone: 'warn' }
        bump()
      } else st.readAll = true
      void props.onViewText(title, full.text).catch((e: unknown) => {
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

  const proposalCard = props.compact && props.variant === 'full' && top && proposalPreview(top, props.width) !== undefined
  const panelWidth = Math.min(props.width, PROPOSAL_CARD_MAX_WIDTH)
  const width = Math.max(20, proposalCard ? panelWidth - 3 : props.width)
  const height = Math.max(1, Math.floor(props.height))
  const focused = props.focused
  const ell = g.ellipsis
  // Question lines carry a selection marker ("> [x] ") in front, so they wrap narrower and are never cut.
  const detailView = top ? cardDetail(top, width - (top.kind === 'question' ? 8 : 2)) : undefined
  const preview = props.compact && top ? proposalPreview(top, width - 2) : undefined
  const detail = preview ?? detailView?.lines ?? []
  const statusRows = st.status ? 1 : 0
  const modeRows = st.mode.t !== 'idle' || st.pending ? 1 : 0
  const phrases = top ? hintPhrases(top, env.dumbTerminal, props.compact) : []
  if (props.compact) phrases.push(focused ? 'Esc to type' : props.focusHint ?? 'Shift+Tab to choose')
  let hints = top ? (focused || props.compact ? wrapPhrases(phrases, sep, width, ell) : [UNFOCUSED_HINT]) : []
  const maxHints = Math.max(1, height - 1 - statusRows - modeRows - 1)
  if (hints.length > maxHints) {
    hints = hints.slice(0, maxHints)
    hints[maxHints - 1] = truncateEnd(`${hints[maxHints - 1]} ${ell}`, width, ell)
  }
  const nextCards = cards.slice(1, 1 + NEXT_CARDS_MAX)
  const moreRows = cards.length - 1 > NEXT_CARDS_MAX ? 1 : 0
  const actionGap = proposalCard && height >= 6 ? 1 : 0
  const avail = height - 1 - statusRows - modeRows - hints.length - actionGap
  // Queued cards: listed while the body keeps room, else one count line, else nothing.
  let queueMode: 'list' | 'count' | 'none' = 'none'
  if (cards.length > 1) {
    if (avail - (nextCards.length + moreRows) >= MIN_BODY_FOR_QUEUE) queueMode = 'list'
    else if (avail - 1 >= 1) queueMode = 'count'
  }
  const queueRows = queueMode === 'list' ? nextCards.length + moreRows : queueMode === 'count' ? 1 : 0
  const bodyAvail = Math.max(1, avail - queueRows)
  const cut = detail.length > bodyAvail
  const cueRows = cut && bodyAvail >= 2 ? 1 : 0
  const bodyRows = Math.max(1, bodyAvail - cueRows)
  st.scroll = Math.min(st.scroll, Math.max(0, detail.length - bodyRows))
  // The body's last line is on screen: a long permission card may now be answered with y / s / a. A body that was
  // cut (a long command) is never "on screen": only v, which shows all of it, unlocks. In the footer the body is printed
  // into scrollback once, so the card counts as read when its key was printed (App passes the keys it printed).
  if (top && !detailView?.capped) {
    if (props.variant === 'footer') {
      if (props.printed === undefined || props.printed.has(top.key)) st.readAll = true
    } else if (st.scroll + bodyRows >= detail.length && 1 + bodyRows <= height) st.readAll = true
  }

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

    if (e.name === 'char' && e.ch === '?' && !e.ctrl && !e.alt && props.onHelp) {
      props.onHelp()
      return true
    }

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
      notice(guard.replaced ? GUARD_SWAPPED_NOTICE : GUARD_ARRIVED_NOTICE)
      bump()
      return true
    }
    st.guardHint = false

    if (mode.t === 'confirm') {
      if (k !== 'y' && k !== mode.binding.key) notice(`Answer the confirm first: ${mode.binding.key === 'y' ? 'y' : `${mode.binding.key} or y`} confirms, Esc cancels.`)
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
    if (!b) {
      if (card.kind === 'question' && /^[0-9]$/.test(k)) {
        const n = Array.isArray(card.card.options) ? Math.min(card.card.options.length, 9) : 0
        notice(n === 0 ? 'This question has no options to pick.' : n === 1 ? 'Pick 1.' : `Pick 1 to ${n}.`)
      } else if (k !== 'enter' || card.kind !== 'question') {
        notice(props.onHelp ? 'Not a key here. ? shows the keys.' : 'Not a key here.', 'dim')
      }
      return true
    }
    if (card.kind === 'permission' && GATED_KEYS.has(k) && !st.readAll) {
      notice(
        detailView?.capped
          ? 'The command is cut here: press v to read all of it first.'
          : props.variant === 'footer'
            ? 'Read the whole command first: v shows it all.'
            : 'Read the whole command first: Down scrolls, v shows it all.'
      )
      return true
    }
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

  // Every attribute goes through styleFor, which sets nothing when colour is off.
  const statusLine = st.status ? (
    <Text {...styleFor({ tone: st.status.tone }, env)} wrap="truncate-end">
      {truncateEnd(st.status.text, width, ell)}
    </Text>
  ) : null

  const modeLine = renderModeLine()

  function renderModeLine(): string | null {
    const m = st.mode
    if (m.t === 'confirm' && top) {
      const keys = m.binding.key === 'y' ? 'y' : `${m.binding.key}/y`
      return `${confirmQuestion(top, m.binding)} ${keys} to confirm${env.dumbTerminal ? ' (then Enter)' : ''}${sep}Esc cancels`
    }
    if (m.t === 'text') {
      const note = m.binding.act !== 'revise' && m.binding.act !== 'custom'
      const label = m.binding.act === 'revise' ? 'What should change' : m.binding.act === 'custom' ? 'Your answer' : 'Note (optional)'
      return `${label}: ${shownValue(m.value, false, width - label.length - 40)}_  Enter sends${sep}Esc cancels${note ? ' the note' : ''}`
    }
    if (m.t === 'secrets') {
      const slot = m.slots[m.index]
      const n = `${m.index + 1}/${m.slots.length}`
      return `Secret ${n} ${slot?.label ?? ''}${m.required ? '' : ' (optional)'}: ${shownValue(m.value, true, 24)}_  Enter next${sep}Esc cancels`
    }
    if (st.pending) return `Pending: ${st.pending.event.ch ?? ''}. Enter commits${sep}Esc clears`
    return null
  }

  if (!top) {
    if (props.variant === 'footer') return statusLine ?? <Text {...styleFor({ dim: true }, env)}>No decisions waiting</Text>
    return (
      <Box flexDirection="column" width={width}>
        <Text {...styleFor({ dim: true }, env)}>Needs you: nothing waiting</Text>
        {statusLine}
      </Box>
    )
  }

  const title = cardTitle(top)
  const guardMark = st.guardHint && !guard.accepts(now()) ? ` ${ell}` : ''

  if (props.variant === 'footer') {
    const who = top.agentLabel ? `${top.agentLabel}: ` : ''
    const phrases = hintPhrases(top, env.dumbTerminal)
    // With room for more than one row the keys get rows of their own, wrapped at separators, so none is cut off (R2-M2);
    // with one row they follow the title on the same line as before.
    const keyRows = focused && !modeLine && !st.status && height > 1 ? wrapPhrases(phrases, sep, width, ell).slice(0, height - 1) : []
    const hintText = focused ? phrases.join(sep) : UNFOCUSED_HINT
    const text =
      modeLine ??
      (st.status ? `${title}${sep}${st.status.text}` : keyRows.length > 0 ? `${top.runTag} ${who}${title}` : `${top.runTag} ${who}${title}${sep}${hintText}`)
    return (
      <Box flexDirection="column" width={width}>
        <Text wrap="truncate-end" {...styleFor(modeLine ? { tone: 'warn' } : {}, env)}>
          {truncateEnd(`${text}${guardMark}`, width, ell)}
        </Text>
        {keyRows.map((r, i) => (
          <Text key={i} wrap="truncate-end" {...styleFor({ tone: 'accent' }, env)}>
            {truncateEnd(r, width, ell)}
          </Text>
        ))}
      </Box>
    )
  }

  const shown = detail.slice(st.scroll, st.scroll + bodyRows)
  const q = top.kind === 'question' && st.question?.key === top.key ? st.question : undefined
  // A screen reader hears words, not marker glyphs: "Focused:" instead of ">" and the separator rule's commas.
  const lead = env.screenReader ? (focused ? 'Focused: ' : '') : focused ? '> ' : '  '
  const header = props.compact
    ? `${proposalCard ? '' : lead}${top.kind === 'proposal' ? title.replace(/^Approve /, 'Review ').replace(/ proposal$/, '') : top.kind === 'permission' ? 'Approval needed' : 'Decision needed'}${cards.length > 1 ? ` (${cards.length})` : ''}${top.kind === 'proposal' ? '' : `${sep}${top.runTag}`}${top.agentLabel ? `${sep}${top.agentLabel}` : ''}`
    : `${lead}Needs you (${cards.length})${sep}${top.runTag}${sep}${top.agentLabel ? `${top.agentLabel}${sep}` : ''}${cardKindWord(top)}: ${title}`
  const hidden = detail.length - st.scroll - bodyRows
  const canView = bindingsFor(top).some((b) => b.act === 'view')
  const cue =
    cueRows === 0
      ? null
      : hidden > 0
        ? `${hidden} more ${hidden === 1 ? 'line' : 'lines'}${sep}Down scrolls${canView ? `${sep}v full view` : ''}`
        : `End of card${sep}Up scrolls back${canView ? `${sep}v full view` : ''}`

  const rows: { key: string; text: string; style: Omit<Seg, 'text'> }[] = []
  rows.push({ key: 'head', text: `${header}${guardMark}`, style: proposalCard ? { tone: 'muted' } : focused ? { tone: 'warn', bold: true } : { dim: true } })
  shown.forEach((l, i) => rows.push({ key: `d${st.scroll + i}`, text: `${proposalCard ? '' : ' '}${questionMark(l, q, top)}${l}`, style: proposalCard ? st.scroll + i === 0 ? { bold: true } : { tone: 'muted' } : {} }))
  if (cue) rows.push({ key: 'cue', text: cue, style: { tone: 'dim' } })
  if (modeLine) rows.push({ key: 'mode', text: modeLine, style: { tone: 'warn' } })
  if (st.status) rows.push({ key: 'status', text: st.status.text, style: { tone: st.status.tone } })
  if (actionGap) rows.push({ key: 'action-gap', text: '', style: {} })
  hints.forEach((h, i) => rows.push({ key: `h${i}`, text: h, style: proposalCard ? {} : focused ? { tone: 'accent' } : { dim: true } }))
  if (queueMode === 'list') {
    for (const c of nextCards) rows.push({ key: `n${c.key}`, text: `${env.screenReader ? 'Next:' : g.arrow} ${c.runTag} ${cardTitle(c)}`, style: { dim: true } })
    if (moreRows) rows.push({ key: 'more', text: `and ${cards.length - 1 - NEXT_CARDS_MAX} more`, style: { dim: true } })
  } else if (queueMode === 'count') {
    rows.push({ key: 'count', text: `+${cards.length - 1} more ${cards.length - 1 === 1 ? 'card' : 'cards'}`, style: { dim: true } })
  }
  return (
    <Box flexDirection="column" width={proposalCard ? panelWidth : width} height={height} overflow="hidden"
      {...(proposalCard ? { paddingLeft: 1, paddingRight: 1, ...(env.screenReader ? { paddingLeft: 2 } : { borderStyle: asciiOnly(env) ? 'classic' as const : 'single' as const, borderTop: false, borderRight: false, borderBottom: false, borderColor: toneColor(focused ? 'accent' : 'muted', env) }) } : {})}>
      {rows.slice(0, height).map((r) => (
        <Text key={r.key} {...styleFor(r.style, env)} wrap="truncate-end">
          {proposalCard && r.key.startsWith('h') && r.key !== 'head'
            ? truncateEnd(r.text, width, ell).split(/(\[[^\]]+\])/).map((part, i) => <Text key={i} {...styleFor(part.startsWith('[') ? { tone: 'accent', bold: true } : {}, env)}>{part}</Text>)
            : truncateEnd(r.text, width, ell)}
        </Text>
      ))}
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
