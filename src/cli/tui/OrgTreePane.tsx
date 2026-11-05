/**
 * The org tree pane (W4-T3, cli-spec 5.1). Pure display plus its own selection and scroll state. Rows arrive from
 * selectors.ts already sanitized, labelled through agentLabel and with their state word; this pane only lays them
 * out: tree indent, state glyph, label, role (when it differs), state word and cost flush right, and the activity on a
 * dim second line when the height allows. Agents of earlier chain members sit under a dim "Earlier sessions" line.
 * Input arrives only through the InputBus while focused (Up/Down, PageUp/PageDown, Home/End).
 */
import { useRef, useState } from 'react'
import { useFocusHandler, useTuiEnv } from './context'
import { glyphs, stateGlyph, stateTone } from './theme'
import type { OrgTreePaneProps, OrgTreeRow, TuiEnv } from './types'
import { PaneLines, alignSegs, cutSegs, keepVisible, moveIndex, navKey, type PaneLine, type Seg } from './panes/lines'
import { textWidth, truncateEnd } from './panes/text'

/** Tree prefix per row: indentation plus a branch glyph for nested agents (no glyphs for a screen reader). */
export function treePrefixes(rows: readonly OrgTreeRow[], env: TuiEnv): string[] {
  const g = glyphs(env)
  return rows.map((row, i) => {
    if (row.depth <= 0) return ''
    if (env.screenReader) return '  '.repeat(row.depth)
    let last = true
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[j].depth < row.depth) break
      if (rows[j].depth === row.depth) {
        last = false
        break
      }
    }
    return '  '.repeat(row.depth - 1) + (last ? g.lastBranch : g.branch) + ' '
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

function rowLine(item: Item, selected: boolean, focused: boolean, width: number, env: TuiEnv): Seg[] {
  const row = item.row!
  const inv = selected && focused
  const marker = selected ? (focused ? '>' : '*') : ' '
  const tone = stateTone(row.state)
  const left: Seg[] = [{ text: `${marker} ${item.prefix}`, inverse: inv }]
  if (!env.screenReader) left.push({ text: `${stateGlyph(row.state, env)} `, tone, inverse: inv })
  left.push({ text: row.label, bold: row.isRoot, inverse: inv })
  if (row.role && row.role !== row.label) left.push({ text: ` (${row.role})`, dim: !inv, inverse: inv })
  left.push({ text: `  ${row.stateWord}`, tone, inverse: inv })
  const right: Seg | undefined = row.costText ? { text: row.costText, dim: !inv, inverse: inv } : undefined
  return alignSegs(left, right, width, env, { inverse: inv })
}

export function OrgTreePane(props: OrgTreePaneProps) {
  const env = useTuiEnv()
  const width = Math.max(0, Math.floor(props.width))
  const height = Math.max(0, Math.floor(props.height))
  const [localSel, setLocalSel] = useState<string | undefined>(undefined)
  const topRef = useRef(0)

  const { items, selectable } = buildItems(props.rows, env)
  const selId =
    (props.selectedId && selectable.some((r) => r.id === props.selectedId) ? props.selectedId : undefined) ??
    (localSel && selectable.some((r) => r.id === localSel) ? localSel : undefined) ??
    selectable[0]?.id
  // The handler reads and moves the selection through a ref: several keys can arrive before the next render.
  const selRef = useRef<string | undefined>(selId)
  selRef.current = selId

  const bodyH = Math.max(0, height - 1)
  // Activity lines only when every row (and the header) still fits with two lines per agent.
  const withActivity = selectable.some((r) => r.activity) && items.length + selectable.length <= bodyH

  useFocusHandler(
    'tree',
    (e) => {
      const k = navKey(e)
      if (!k) return false
      if (selectable.length === 0) return true
      const perRow = withActivity ? 2 : 1
      const cur = Math.max(0, selectable.findIndex((r) => r.id === selRef.current))
      const next = moveIndex(cur, k, selectable.length, Math.max(1, Math.floor(bodyH / perRow) - 1))
      const id = selectable[next].id
      const changed = id !== selRef.current
      selRef.current = id
      setLocalSel(id)
      if (changed) props.onSelect?.(id)
      return true
    },
    props.focused
  )

  const ell = glyphs(env).ellipsis
  const count = props.rows.length
  const title = truncateEnd(`Agents (${count})`, width, ell)
  const lines: PaneLine[] = []
  let selFrom = 0
  let selTo = 0
  for (const item of items) {
    if (item.kind === 'header') {
      lines.push({ key: 'earlier', segs: cutSegs([{ text: '  Earlier sessions', dim: true }], width, env) })
      continue
    }
    const row = item.row!
    const selected = row.id === selId
    if (selected) selFrom = lines.length
    lines.push({ key: `${row.runId}:${row.id}`, segs: rowLine(item, selected, props.focused, width, env) })
    if (withActivity) {
      const indent = ' '.repeat(Math.min(width, 2 + textWidth(item.prefix) + (env.screenReader ? 0 : 2)))
      const act = row.activity ? `${indent}${row.activity}` : ''
      lines.push({ key: `${row.runId}:${row.id}:activity`, segs: act ? cutSegs([{ text: act, dim: true }], width, env) : [] })
    }
    if (selected) selTo = lines.length - 1
  }

  let body: PaneLine[]
  if (lines.length === 0) {
    body = [{ key: 'empty', segs: cutSegs([{ text: 'No agents yet', dim: true }], width, env) }]
  } else {
    const top = keepVisible(topRef.current, selFrom, selTo, bodyH, lines.length)
    topRef.current = top
    body = lines.slice(top, top + bodyH)
  }
  const all: PaneLine[] = [{ key: 'title', segs: [{ text: title, bold: true, tone: props.focused ? 'accent' : undefined }] }, ...body]
  return <PaneLines width={width} height={height} lines={all} env={env} />
}
