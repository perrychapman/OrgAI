/**
 * The org tree pane (W4-T3, cli-spec 5.1; ux-review-tui-org.md F1, F2, F5, F10). Pure display plus its own selection and
 * scroll state. Rows arrive from selectors.ts already sanitized, labelled through agentLabel and with their state word.
 * Sidebar agents get separate name/status lines and gaps when space permits; short terminals use one line: tree indent (capped at four levels, then "+N"), state glyph, label,
 * the role only when it adds something and fits, the state word (never cut before the role, the activity or the middle
 * of the handle), chips (`! N` open cards, `2f` / `review` / `conflict` / `held` for the worktree) and the cost flush
 * right. Finished subtrees arrive folded as "N done" rows (Right / Enter expand, Left folds back, `h` toggles Hide
 * finished). The selected row's activity is one footer line under the rows. `n` / `N` jump to the next / previous agent
 * with an open card, Enter on such a row focuses the tray on its card. Agents of earlier chain members sit under a dim
 * "Earlier sessions" line. Input arrives only through the InputBus while focused.
 */
import { useRef, useState } from 'react'
import { splitLabelTail } from '../../shared/view/agentTree'
import { agentActivityLabel, distinctActivity, isWorkingAgentState, motionEnabled, useActivityTick } from './activity'
import { messageRoute, useMessagePulse } from './teamMotion'
import type { TeamMessageRow } from './collaboration'
import { useFocusHandler, useTuiEnv } from './context'
import { treeCounts } from './treeRows'
import { waitingWords, worktreeChipWords } from './selectors'
import { glyphs, stateGlyph, stateTone } from './theme'
import type { OrgTreePaneProps, OrgTreeRow, Tone, TuiEnv } from './types'
import { PaneLines, alignSegs, cutSegs, keepVisible, moveIndex, navKey, type PaneLine, type Seg } from './panes/lines'
import { sliceToWidth, textWidth, truncateEnd } from './panes/text'

const LABEL_MIN = 14
export const TREE_INDENT_MAX = 4

export function treePrefixes(rows: readonly OrgTreeRow[], env: TuiEnv): string[] {
  const g = glyphs(env)
  return rows.map((row, i) => {
    if (row.depth <= 0) return ''
    const capped = Math.min(row.depth, TREE_INDENT_MAX)
    const extra = row.depth - capped
    const more = extra > 0 ? `+${extra} ` : ''
    if (env.screenReader) return '  '.repeat(capped) + more
    let last = true
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[j].depth < row.depth) break
      if (rows[j].depth === row.depth) {
        last = false
        break
      }
    }
    return '  '.repeat(capped - 1) + more + (last ? g.lastBranch : g.branch) + ' '
  })
}

interface Item {
  kind: 'row' | 'header'
  row?: OrgTreeRow
  prefix: string
}

export function clipMiddle(label: string, max: number, ell: string): string {
  if (textWidth(label) <= max) return label
  const { head, tail } = splitLabelTail(label)
  if (!tail) return truncateEnd(label, max, ell)
  const room = max - textWidth(tail) - textWidth(ell)
  if (room < 2) return truncateEnd(label, max, ell)
  return `${sliceToWidth(head, room)}${ell}${tail}`
}

interface Chip {
  text: string
  tone: Tone
}

function chipsOf(row: OrgTreeRow, env: TuiEnv): Chip[] {
  const out: Chip[] = []
  const sr = env.screenReader
  if (row.waiting && row.waiting > 0) out.push({ text: sr ? waitingWords(row.waiting) : `! ${row.waiting}`, tone: 'warn' })
  if (row.worktreeChip) {
    out.push({
      text: sr ? worktreeChipWords(row.worktreeChip) : row.worktreeChip,
      tone: row.worktreeChip === 'conflict' ? 'danger' : row.worktreeChip === 'held' ? 'dim' : row.worktreeChip === 'review' ? 'warn' : 'dim'
    })
  }
  return out
}

function spinnerFrame(env: TuiEnv, phase: number): string {
  const frames = glyphs(env).spinner
  return frames[((phase % frames.length) + frames.length) % frames.length]!
}

function shimmerSeg(seg: Seg, active: boolean): Seg {
  return active ? { ...seg, shimmer: true } : seg
}

/** One row, one line. Role and handle give way before the state word and chips. */
export function rowLine(item: Item, selected: boolean, focused: boolean, width: number, env: TuiEnv, phase = 0, motion = false, highlight = false, compact = false, stackedStatus = false): Seg[] {
  const row = item.row!
  if (width < 20) return cutSegs([{ text: row.label, tone: row.identityTone ?? 'identity', bold: true, inverse: selected && focused }], width, env)
  const g = glyphs(env)
  const group = row.kind === 'group'
  const inv = selected && focused
  const marker = selected ? (focused ? '>' : '*') : ' '
  const tone = stateTone(row.state)
  const live = motion && !row.earlier && isWorkingAgentState(row.state)
  const thinking = live
  const lead = compact ? item.prefix : `${marker} ${item.prefix}`
  const glyph = env.screenReader ? '' : `${live ? spinnerFrame(env, phase) : stateGlyph(row.state, env)} `
  const label0 = group && env.screenReader ? `${row.label}, folded` : row.label
  const role = !group && row.roleShown !== false && row.role && row.role !== row.label ? ` (${row.role})` : ''
  const traffic = highlight ? (env.screenReader ? ', messaging' : env.unicode ? ' ↔' : ' *') : row.traffic ? (env.screenReader ? ', messaging' : '~') : ''
  const wordPrefix = !stackedStatus && row.stateWord ? '  ' : ''
  const chipRow = compact ? { ...row,
    waiting: (row.waiting ?? 0) > 1 ? row.waiting : undefined,
    worktreeChip: ['conflict', 'review', 'held'].includes(row.worktreeChip ?? '') ? row.worktreeChip : undefined
  } : row
  const chips = chipsOf(chipRow, env)
  const expander = group ? (env.screenReader ? '' : ' >') : ''
  const cost = compact ? '' : row.costText ? `${row.costText}${expander}` : expander.trim()

  const chipsW = (list: Chip[]): number => list.reduce((n, c) => n + 1 + textWidth(c.text), 0)
  const activityRoom = width - textWidth(lead + glyph + traffic) - Math.min(LABEL_MIN, textWidth(label0)) - 2 - chipsW(chips) - (cost ? textWidth(cost) + 1 : 0)
  const word = stackedStatus ? '' : isWorkingAgentState(row.state) ? truncateEnd(agentActivityLabel(row), Math.max(8, Math.min(24, activityRoom)), g.ellipsis) : row.stateWord
  const need = (labelW: number, withRole: boolean, list: Chip[]): number =>
    textWidth(lead) + textWidth(glyph) + labelW + (withRole ? textWidth(role) : 0) + textWidth(wordPrefix) + textWidth(word) + textWidth(traffic) + chipsW(list) + (cost ? textWidth(cost) + 1 : 0)
  let useRole = !compact && !stackedStatus && role !== ''
  let label = label0
  let list = chips
  if (need(textWidth(label), useRole, list) > width) useRole = false
  if (need(textWidth(label), useRole, list) > width) {
    while (list.length > 0 && width - need(0, false, list) < Math.min(compact ? 4 : LABEL_MIN, textWidth(label0))) list = list.slice(0, -1)
    const room = width - need(0, false, list)
    label = room >= 4 ? clipMiddle(label0, room, g.ellipsis) : label0
  }

  const left: Seg[] = [{ text: lead, inverse: inv }]
  if (glyph) left.push({ text: glyph, tone, inverse: inv })
  left.push({ text: label, bold: !group, tone: group ? undefined : row.identityTone ?? 'identity', inverse: inv })
  if (useRole) left.push({ text: role, dim: !inv, inverse: inv })
  if (wordPrefix) left.push({ text: wordPrefix, inverse: inv })
  if (word) left.push(shimmerSeg({ text: word, tone: thinking ? undefined : tone, inverse: inv }, thinking))
  if (traffic) left.push({ text: traffic, tone: highlight && !inv ? 'message' : tone, inverse: inv })
  for (const c of list) left.push({ text: ` ${c.text}`, tone: c.tone, inverse: inv })
  const right: Seg | undefined = cost ? { text: cost, dim: !inv, inverse: inv } : undefined
  return alignSegs(left, right, width, env, { inverse: inv })
}

export function messageLines(row: OrgTreeRow, env: TuiEnv, width: number): string[] {
  const list = (peers: readonly { label: string; count: number }[]): string => {
    const shown = peers.slice(0, 3).map((p) => `${p.label} (${p.count})`)
    if (peers.length > 3) shown.push(`+${peers.length - 3} more`)
    return shown.join(', ')
  }
  const out = row.msgOut?.length ? list(row.msgOut) : ''
  const inn = row.msgIn?.length ? list(row.msgIn) : ''
  const g = glyphs(env)
  const back = g.arrow === '->' ? '<-' : '←'
  const parts = env.screenReader ? [out ? `sent to ${out}` : '', inn ? `got from ${inn}` : ''] : [out ? `${g.arrow} ${out}` : '', inn ? `${back} ${inn}` : '']
  const present = parts.filter(Boolean)
  const joined = present.join(env.screenReader ? '; ' : '  ')
  return textWidth(joined) <= width ? (joined ? [joined] : []) : present
}

function titleText(rows: readonly OrgTreeRow[], env: TuiEnv, zoomPath?: string): string {
  const { total, working, waiting } = treeCounts(rows)
  const bullet = ` ${glyphs(env).bullet} `
  const parts = [zoomPath ? `Focus: ${zoomPath} (${total})` : `Agents ${total}`]
  if (working > 0) parts.push(`${working} working`)
  if (waiting > 0) parts.push(env.screenReader ? waitingWords(waiting) : `! ${waiting}`)
  return parts.join(bullet)
}

function buildItems(rows: readonly OrgTreeRow[], env: TuiEnv): { items: Item[]; selectable: OrgTreeRow[] } {
  const current = rows.filter((r) => !r.earlier)
  const earlier = rows.filter((r) => r.earlier)
  const items: Item[] = []
  const cp = treePrefixes(current, env)
  current.forEach((row, i) => items.push({ kind: 'row', row, prefix: cp[i]! }))
  if (earlier.length > 0) {
    items.push({ kind: 'header', prefix: '' })
    const ep = treePrefixes(earlier, env)
    earlier.forEach((row, i) => items.push({ kind: 'row', row, prefix: `  ${ep[i]!}` }))
  }
  return { items, selectable: [...current, ...earlier] }
}

function messagePreview(message: TeamMessageRow, env: TuiEnv, width: number): Seg[] {
  const target = message.toLabel || (message.toId ? 'Unknown recipient' : 'you')
  const text = message.text.replace(/\s+/g, ' ').trim()
  const segs: Seg[] = env.screenReader
    ? [
        { text: 'message from ', tone: 'message' },
        { text: message.fromLabel, tone: 'identity', bold: true },
        { text: ' to ', tone: 'message' },
        { text: target, tone: 'identity', bold: true },
        { text: ': ' },
        { text, tone: 'muted' }
      ]
    : [
        { text: `${glyphs(env).arrow} `, tone: 'message' },
        { text: message.fromLabel, tone: 'identity', bold: true },
        { text: ` ${glyphs(env).arrow} `, tone: 'message' },
        { text: target, tone: 'identity', bold: true },
        { text: ': ' },
        { text, tone: 'muted' }
      ]
  return cutSegs(segs, width, env)
}

const isChar = (e: Parameters<Parameters<typeof useFocusHandler>[1]>[0], ch: string): boolean =>
  e.type === 'key' && e.name === 'char' && !e.ctrl && !e.alt && e.ch === ch

type MotionOrgTreePaneProps = OrgTreePaneProps & { animated?: boolean; messages?: TeamMessageRow[]; compact?: boolean; teamSize?: number }

export function OrgTreePane(props: MotionOrgTreePaneProps) {
  const env = useTuiEnv()
  const width = Math.max(0, Math.floor(props.width))
  const height = Math.max(0, Math.floor(props.height))
  const [localSel, setLocalSel] = useState<string | undefined>(undefined)
  const topRef = useRef(0)
  const newest = props.messages?.at(-1)
  const motionAllowed = props.animated !== false && width > 0 && height > 0 && motionEnabled(env)
  const hasLiveRows = props.rows.some((row) => !row.earlier && isWorkingAgentState(row.state))
  const phase = useActivityTick(motionAllowed && hasLiveRows, env)
  const runId = props.rows.find(row => !row.earlier)?.runId
  const pulse = useMessagePulse(newest, runId, motionAllowed)

  const { items, selectable } = buildItems(props.rows, env)
  const has = (id: string | undefined): id is string => id !== undefined && selectable.some((r) => r.id === id)
  const selId = (has(props.selectedId) ? props.selectedId : undefined) ?? (has(localSel) ? localSel : undefined) ?? (selectable.find((r) => r.waiting) ?? selectable[0])?.id
  const selRef = useRef<string | undefined>(selId)
  selRef.current = selId
  const compact = props.compact === true && !props.focused && (!!props.teamSize || (selectable.length === 1 && selectable[0]?.kind !== 'group'))
  const bodyH = Math.max(0, height - 1)
  const selRow = selectable.find((r) => r.id === selId)
  const activity = selRow?.kind === 'group' ? selRow.activity : distinctActivity(selRow?.activity, selRow ? agentActivityLabel(selRow) : undefined)
  const footerText = activity && selRow ? (selRow.kind === 'group' ? activity : `${selRow.label}: ${activity}`) : ''
  const footer = !compact && footerText !== '' && bodyH >= 3
  const msgAll = !compact && selRow && selRow.kind !== 'group' ? messageLines(selRow, env, width) : []
  const msgTexts = bodyH >= (footer ? 4 : 3) + (msgAll.length > 1 ? 1 : 0) ? msgAll : bodyH >= (footer ? 4 : 3) ? [msgAll.join(env.screenReader ? '; ' : '  ')].filter(Boolean) : []
  const footerRows = (footer ? 1 : 0) + msgTexts.length
  const railMessages = width >= 28 && bodyH >= footerRows + 3 ? (props.messages ?? []).slice(compact ? -1 : -2) : []
  const rowsH = Math.max(0, bodyH - footerRows - railMessages.length)
  const rowCount = selectable.length
  const headers = items.length - rowCount
  // Degrade to single lines when the terminal cannot fit the roomier roster.
  const stackedStatus = props.compact === true && width >= 28 && rowsH >= rowCount * 2 + headers
  const spaced = stackedStatus && rowsH >= rowCount * 3 - 1 + headers
  const stride = stackedStatus ? spaced ? 3 : 2 : 1

  const select = (id: string): void => {
    const changed = id !== selRef.current
    selRef.current = id
    setLocalSel(id)
    if (changed) props.onSelect?.(id)
  }

  useFocusHandler(
    'tree',
    (e) => {
      if (e.type !== 'key') return false
      const cur = Math.max(0, selectable.findIndex((r) => r.id === selRef.current))
      const row = selectable[cur]
      const k = navKey(e)
      if (k) {
        if (selectable.length === 0) return true
        select(selectable[moveIndex(cur, k, selectable.length, Math.max(1, Math.floor(rowsH / stride) - 1))]!.id)
        return true
      }
      if (e.ctrl || e.alt) return false
      if (e.name === 'right' || e.name === 'left' || e.name === 'enter') {
        if (!row) return true
        if (e.name === 'right') {
          if (row.kind === 'group') props.onExpand?.(row)
        } else if (e.name === 'left') props.onCollapse?.(row)
        else if (row.kind === 'group') props.onExpand?.(row)
        else if (row.waiting) props.onFocusCard?.(row)
        else props.onActivate?.(row)
        return true
      }
      if (isChar(e, 'z')) {
        if (row && row.kind !== 'group' && row.kind !== 'role' && !row.earlier) props.onZoom?.(row)
        else props.onNotice?.('Pick an agent of this session to focus on.')
        return true
      }
      if (isChar(e, 'Z') || e.name === 'backspace') {
        props.onUnzoom?.()
        return true
      }
      if (isChar(e, 'h')) {
        props.onToggleFold?.()
        return true
      }
      if (isChar(e, 'n') || isChar(e, 'N')) {
        const back = e.ch === 'N'
        const waiting = selectable.map((r, i) => (r.waiting ? i : -1)).filter((i) => i >= 0)
        if (waiting.length === 0) {
          props.onNotice?.('Nothing needs you.')
          return true
        }
        const next = back ? ([...waiting].reverse().find((i) => i < cur) ?? waiting[waiting.length - 1]!) : (waiting.find((i) => i > cur) ?? waiting[0]!)
        select(selectable[next]!.id)
        return true
      }
      return false
    },
    props.focused
  )

  const lines: PaneLine[] = []
  const lineOf = new Map<string, number>()
  let selAt = 0
  for (const [index, item] of items.entries()) {
    if (item.kind === 'header') {
      lines.push({ key: 'earlier', segs: cutSegs([{ text: '  Earlier sessions', dim: true }], width, env) })
      continue
    }
    const row = item.row!
    const selected = row.id === selId
    if (selected) selAt = lines.length
    lineOf.set(row.id, lines.length)
    const involved = Boolean(pulse !== undefined && newest && !row.earlier && row.runId === newest.runId && (row.id === newest.fromId || row.id === newest.toId))
    lines.push({ key: `${row.runId}:${row.id}`, segs: rowLine(item, selected, props.focused, width, env, phase, motionAllowed, involved, compact, stackedStatus) })
    if (stackedStatus) {
      const indent = Math.min(width, textWidth(item.prefix) + (compact ? 2 : 4))
      const working = isWorkingAgentState(row.state)
      lines.push({ key: `${row.runId}:${row.id}:status`, segs: cutSegs([
        { text: ' '.repeat(indent) },
        shimmerSeg({ text: agentActivityLabel(row), tone: working ? undefined : stateTone(row.state), dim: !working }, working && motionAllowed)
      ], width, env) })
      if (spaced && items[index + 1]?.kind === 'row') lines.push({ key: `${row.runId}:${row.id}:gap`, segs: [] })
    }
  }

  let body: PaneLine[]
  let top = 0
  if (lines.length === 0) body = [{ key: 'empty', segs: cutSegs([{ text: 'No agents yet', dim: true }], width, env) }]
  else {
    top = keepVisible(topRef.current, selAt, selAt + (stackedStatus ? 1 : 0), rowsH, lines.length)
    topRef.current = top
    body = lines.slice(top, top + rowsH)
  }
  if (footer && lines.length > 0) body.push({ key: 'footer', segs: cutSegs([{ text: footerText, dim: true }], width, env) })
  if (lines.length > 0) msgTexts.forEach((text, i) => body.push({ key: `messages${i}`, segs: cutSegs([{ text, dim: true }], width, env) }))

  const offscreen = selectable.reduce((n, r) => {
    const at = lineOf.get(r.id)
    return r.waiting && at !== undefined && (at < top || at >= top + rowsH) ? n + r.waiting : n
  }, 0)
  const rightParts: string[] = []
  if (props.planChip && !compact) rightParts.push(props.planChip)
  if (offscreen > 0) rightParts.push(env.screenReader ? `${waitingWords(offscreen)} off screen` : `! ${offscreen} off screen`)
  const right: Seg | undefined = rightParts.length ? { text: rightParts.join(` ${glyphs(env).bullet} `), dim: true } : undefined
  const title = props.teamSize && !props.zoomPath ? `Team ${props.teamSize}` : compact && !props.zoomPath ? 'Agents 1' : titleText(props.rows, env, props.zoomPath)
  const titleSegs = alignSegs([{ text: title, bold: true, tone: props.focused ? 'accent' : undefined }], right, width, env)
  const rail = railMessages.map((message) => ({ key: `message:${message.key}`, segs: compact || (message.key === newest?.key && pulse !== undefined)
    ? cutSegs([{ text: messageRoute(message, width, env, message.key === newest?.key ? pulse : undefined), tone: pulse !== undefined ? 'message' : 'muted' }], width, env)
    : messagePreview(message, env, width) }))
  const all: PaneLine[] = [{ key: 'title', segs: titleSegs }, ...body, ...rail]
  return <PaneLines width={width} height={height} lines={all} env={env} phase={phase} />
}
