/**
 * The org tree pane (W4-T3, cli-spec 5.1; ux-review-tui-org.md F1, F2, F5, F10). Pure display plus its own selection and
 * scroll state. Rows arrive from selectors.ts already sanitized, labelled through agentLabel and with their state word.
 * One line per agent, never a blank activity line: tree indent (capped at four levels, then "+N"), state glyph, label,
 * the role only when it adds something and fits, the state word (never cut before the role, the activity or the middle
 * of the handle), chips (`! N` open cards, `2f` / `review` / `conflict` / `held` for the worktree) and the cost flush
 * right. Finished subtrees arrive folded as "N done" rows (Right / Enter expand, Left folds back, `h` toggles Hide
 * finished). The selected row's activity is one footer line under the rows. `n` / `N` jump to the next / previous agent
 * with an open card, Enter on such a row focuses the tray on its card. Agents of earlier chain members sit under a dim
 * "Earlier sessions" line. Input arrives only through the InputBus while focused.
 */
import { useRef, useState } from 'react'
import { splitLabelTail } from '../../shared/view/agentTree'
import { useFocusHandler, useTuiEnv } from './context'
import { treeCounts } from './treeRows'
import { waitingWords, worktreeChipWords } from './selectors'
import { glyphs, stateGlyph, stateTone } from './theme'
import type { OrgTreePaneProps, OrgTreeRow, Tone, TuiEnv } from './types'
import { PaneLines, alignSegs, cutSegs, keepVisible, moveIndex, navKey, type PaneLine, type Seg } from './panes/lines'
import { sliceToWidth, textWidth, truncateEnd } from './panes/text'

/** A handle is cut in the middle only down to this many columns; the chips give way before it gets shorter. */
const LABEL_MIN = 14

/** Tree indent stops growing at this depth; deeper rows show how many levels they are below it ("+2"). */
export const TREE_INDENT_MAX = 4

/** Tree prefix per row: indentation plus a branch glyph for nested agents (no glyphs for a screen reader). */
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

function buildItems(rows: readonly OrgTreeRow[], env: TuiEnv): { items: Item[]; selectable: OrgTreeRow[] } {
  const current = rows.filter((r) => !r.earlier)
  const earlier = rows.filter((r) => r.earlier)
  const items: Item[] = []
  const cp = treePrefixes(current, env)
  current.forEach((row, i) => items.push({ kind: 'row', row, prefix: cp[i] }))
  if (earlier.length > 0) {
    items.push({ kind: 'header', prefix: '' })
    const ep = treePrefixes(earlier, env)
    earlier.forEach((row, i) => items.push({ kind: 'row', row, prefix: `  ${ep[i]}` }))
  }
  return { items, selectable: [...current, ...earlier] }
}

/** `label` cut to `max` columns in the middle, keeping its last characters ("mock-lead-rep…ort-2") so siblings stay apart. */
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
  if (row.worktreeChip) out.push({ text: sr ? worktreeChipWords(row.worktreeChip) : row.worktreeChip, tone: row.worktreeChip === 'conflict' ? 'danger' : row.worktreeChip === 'held' ? 'dim' : row.worktreeChip === 'review' ? 'warn' : 'dim' })
  return out
}

/**
 * One row, one line. Cut order when the line is too wide: the role, then the handle's middle (its end stays), then the
 * chips; the state word is never cut before those.
 */
function rowLine(item: Item, selected: boolean, focused: boolean, width: number, env: TuiEnv): Seg[] {
  const row = item.row!
  const g = glyphs(env)
  const group = row.kind === 'group'
  const inv = selected && focused
  const marker = selected ? (focused ? '>' : '*') : ' '
  const tone = stateTone(row.state)
  const lead = `${marker} ${item.prefix}`
  const glyph = env.screenReader ? '' : `${stateGlyph(row.state, env)} `
  const label0 = group && env.screenReader ? `${row.label}, folded` : row.label
  const role = !group && row.roleShown !== false && row.role && row.role !== row.label ? ` (${row.role})` : ''
  // A recent message to or from the agent: `~` after the state word (words for a screen reader), F6.
  const traffic = row.traffic ? (env.screenReader ? ', messaging' : '~') : ''
  const word = row.stateWord ? `  ${row.stateWord}${traffic}` : ''
  const chips = chipsOf(row, env)
  const expander = group ? (env.screenReader ? '' : ' >') : ''
  const cost = row.costText ? `${row.costText}${expander}` : expander.trim()

  const chipsW = (list: Chip[]): number => list.reduce((n, c) => n + 1 + textWidth(c.text), 0)
  const need = (labelW: number, withRole: boolean, list: Chip[]): number =>
    textWidth(lead) + textWidth(glyph) + labelW + (withRole ? textWidth(role) : 0) + textWidth(word) + chipsW(list) + (cost ? textWidth(cost) + 1 : 0)

  let useRole = role !== ''
  let label = label0
  let list = chips
  if (need(textWidth(label), useRole, list) > width) useRole = false
  if (need(textWidth(label), useRole, list) > width) {
    // Shorten the handle (its end stays), but not below LABEL_MIN columns: the chips go first, the worktree one before `! N`.
    while (list.length > 0 && width - need(0, false, list) < Math.min(LABEL_MIN, textWidth(label0))) list = list.slice(0, -1)
    const room = width - need(0, false, list)
    label = room >= 4 ? clipMiddle(label0, room, g.ellipsis) : label0
  }

  const left: Seg[] = [{ text: lead, inverse: inv }]
  if (glyph) left.push({ text: glyph, tone, inverse: inv })
  left.push({ text: label, bold: row.isRoot, inverse: inv })
  if (useRole) left.push({ text: role, dim: !inv, inverse: inv })
  if (word) left.push({ text: word, tone, inverse: inv })
  for (const c of list) left.push({ text: ` ${c.text}`, tone: c.tone, inverse: inv })
  const right: Seg | undefined = cost ? { text: cost, dim: !inv, inverse: inv } : undefined
  return alignSegs(left, right, width, env, { inverse: inv })
}

/**
 * The message lines of a selected agent (F6): `-> writer-1 (2)  <- mock-lead (1)` on one line, or sent and got on two
 * lines when they do not fit `width`. Three peers each at most.
 */
export function messageLines(row: OrgTreeRow, env: TuiEnv, width: number): string[] {
  const list = (peers: readonly { label: string; count: number }[]): string => {
    const shown = peers.slice(0, 3).map((p) => `${p.label} (${p.count})`)
    if (peers.length > 3) shown.push(`+${peers.length - 3} more`)
    return shown.join(', ')
  }
  const out = row.msgOut?.length ? list(row.msgOut) : ''
  const inn = row.msgIn?.length ? list(row.msgIn) : ''
  const g = glyphs(env)
  const back = g.arrow === '->' ? '<-' : '\u2190'
  const parts = env.screenReader ? [out ? `sent to ${out}` : '', inn ? `got from ${inn}` : ''] : [out ? `${g.arrow} ${out}` : '', inn ? `${back} ${inn}` : '']
  const present = parts.filter(Boolean)
  const joined = present.join(env.screenReader ? '; ' : '  ')
  return textWidth(joined) <= width ? (joined ? [joined] : []) : present
}

/** "Agents 6 · 1 working · ! 1", or "Focus: Orchestrator > mock-lead · 3" while the tree is rooted at one agent. */
function titleText(rows: readonly OrgTreeRow[], env: TuiEnv, zoomPath?: string): string {
  const { total, working, waiting } = treeCounts(rows)
  const bullet = ` ${glyphs(env).bullet} `
  const parts = [zoomPath ? `Focus: ${zoomPath} (${total})` : `Agents ${total}`]
  if (working > 0) parts.push(`${working} working`)
  if (waiting > 0) parts.push(env.screenReader ? waitingWords(waiting) : `! ${waiting}`)
  return parts.join(bullet)
}

const isChar = (e: Parameters<Parameters<typeof useFocusHandler>[1]>[0], ch: string): boolean =>
  e.type === 'key' && e.name === 'char' && !e.ctrl && !e.alt && e.ch === ch

export function OrgTreePane(props: OrgTreePaneProps) {
  const env = useTuiEnv()
  const width = Math.max(0, Math.floor(props.width))
  const height = Math.max(0, Math.floor(props.height))
  const [localSel, setLocalSel] = useState<string | undefined>(undefined)
  const topRef = useRef(0)

  const { items, selectable } = buildItems(props.rows, env)
  const has = (id: string | undefined): id is string => id !== undefined && selectable.some((r) => r.id === id)
  // No choice yet: the first agent that needs you, else the first row.
  const selId = (has(props.selectedId) ? props.selectedId : undefined) ?? (has(localSel) ? localSel : undefined) ?? (selectable.find((r) => r.waiting) ?? selectable[0])?.id
  // The handler reads and moves the selection through a ref: several keys can arrive before the next render.
  const selRef = useRef<string | undefined>(selId)
  selRef.current = selId

  const bodyH = Math.max(0, height - 1)
  const selRow = selectable.find((r) => r.id === selId)
  // The selected row's activity (or the names a folded group holds) and its message counts are footer lines, when the pane has the room.
  const footerText = selRow?.activity ? (selRow.kind === 'group' ? selRow.activity : `${selRow.label}: ${selRow.activity}`) : ''
  const footer = footerText !== '' && bodyH >= 3
  const msgAll = selRow && selRow.kind !== 'group' ? messageLines(selRow, env, width) : []
  const msgTexts = bodyH >= (footer ? 4 : 3) + (msgAll.length > 1 ? 1 : 0) ? msgAll : bodyH >= (footer ? 4 : 3) ? [msgAll.join(env.screenReader ? '; ' : '  ')].filter(Boolean) : []
  const footerRows = (footer ? 1 : 0) + msgTexts.length
  const rowsH = Math.max(0, bodyH - footerRows)

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
        select(selectable[moveIndex(cur, k, selectable.length, Math.max(1, rowsH - 1))].id)
        return true
      }
      if (e.ctrl || e.alt) return false
      if (e.name === 'right' || e.name === 'left' || e.name === 'enter') {
        if (!row) return true
        if (e.name === 'right') {
          if (row.kind === 'group') props.onExpand?.(row)
        } else if (e.name === 'left') {
          props.onCollapse?.(row)
        } else if (row.kind === 'group') props.onExpand?.(row)
        else if (row.waiting) props.onFocusCard?.(row)
        else props.onActivate?.(row)
        return true
      }
      if (isChar(e, 'z')) {
        if (row && row.kind !== 'group' && !row.earlier) props.onZoom?.(row)
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
          props.onNotice?.('No agent needs you in this run.')
          return true
        }
        const next = back ? ([...waiting].reverse().find((i) => i < cur) ?? waiting[waiting.length - 1]) : (waiting.find((i) => i > cur) ?? waiting[0])
        select(selectable[next].id)
        return true
      }
      return false
    },
    props.focused
  )

  const lines: PaneLine[] = []
  const lineOf = new Map<string, number>()
  let selAt = 0
  for (const item of items) {
    if (item.kind === 'header') {
      lines.push({ key: 'earlier', segs: cutSegs([{ text: '  Earlier sessions', dim: true }], width, env) })
      continue
    }
    const row = item.row!
    const selected = row.id === selId
    if (selected) selAt = lines.length
    lineOf.set(row.id, lines.length)
    lines.push({ key: `${row.runId}:${row.id}`, segs: rowLine(item, selected, props.focused, width, env) })
  }

  let body: PaneLine[]
  let top = 0
  if (lines.length === 0) {
    body = [{ key: 'empty', segs: cutSegs([{ text: 'No agents yet', dim: true }], width, env) }]
  } else {
    top = keepVisible(topRef.current, selAt, selAt, rowsH, lines.length)
    topRef.current = top
    body = lines.slice(top, top + rowsH)
  }
  if (footer && lines.length > 0) {
    body.push({ key: 'footer', segs: cutSegs([{ text: footerText, dim: true }], width, env) })
  }
  if (lines.length > 0) {
    msgTexts.forEach((text, i) => body.push({ key: `messages${i}`, segs: cutSegs([{ text, dim: true }], width, env) }))
  }

  // The title: counts on the left; the plan chip and how many waiting agents are scrolled out of view on the right.
  const offscreen = selectable.reduce((n, r) => {
    const at = lineOf.get(r.id)
    return r.waiting && at !== undefined && (at < top || at >= top + rowsH) ? n + r.waiting : n
  }, 0)
  const rightParts: string[] = []
  if (props.planChip) rightParts.push(props.planChip)
  if (offscreen > 0) rightParts.push(env.screenReader ? `${waitingWords(offscreen)} off screen` : `! ${offscreen} off screen`)
  const right: Seg | undefined = rightParts.length ? { text: rightParts.join(` ${glyphs(env).bullet} `), dim: true } : undefined
  const titleSegs = alignSegs([{ text: titleText(props.rows, env, props.zoomPath), bold: true, tone: props.focused ? 'accent' : undefined }], right, width, env)
  const all: PaneLine[] = [{ key: 'title', segs: titleSegs }, ...body]
  return <PaneLines width={width} height={height} lines={all} env={env} />
}
