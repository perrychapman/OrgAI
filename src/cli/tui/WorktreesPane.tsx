/**
 * The worktrees pane (W4-T3). One line per agent worktree: branch, agent label, status in plain words, changed file
 * count and merge target. Pure display plus its own selection and scroll state; while focused Up/Down (PageUp,
 * PageDown, Home, End) select and `v` or Enter calls onViewDiff for the selected row. Strings arrive sanitized.
 */
import { useRef, useState } from 'react'
import type { WorktreeStatus } from '../../shared/types'
import { useFocusHandler, useTuiEnv } from './context'
import { glyphs } from './theme'
import type { Tone, TuiEnv, WorktreeRow, WorktreesPaneProps } from './types'
import { PaneLines, paneHeading, alignSegs, cutSegs, keepVisible, moveIndex, navKey, type PaneLine, type Seg } from './panes/lines'

/** Plain words per worktree status. */
export const WORKTREE_STATUS_WORD: Record<WorktreeStatus, string> = {
  active: 'active',
  merging: 'merging',
  merged: 'merged',
  empty: 'no changes',
  conflict: 'conflict',
  removed: 'removed',
  review: 'needs review',
  held: 'held',
  'waiting-children': 'waiting for reports'
}

export const WORKTREE_STATUS_TONE: Record<WorktreeStatus, Tone | undefined> = {
  active: 'running',
  merging: 'running',
  merged: 'ok',
  empty: 'dim',
  conflict: 'danger',
  removed: 'dim',
  review: 'warn',
  held: 'warn',
  'waiting-children': undefined
}

const rowId = (r: WorktreeRow): string => `${r.runId}:${r.agentId}`

function filesText(n: number): string {
  return `${n} ${n === 1 ? 'file' : 'files'}`
}

/** "-> main" / "→ parent", or "into main" for a screen reader. */
export function mergeTargetText(target: WorktreeRow['mergeTarget'], env: TuiEnv): string {
  return env.screenReader ? `into ${target}` : `${glyphs(env).arrow} ${target}`
}

function rowLine(row: WorktreeRow, selected: boolean, focused: boolean, width: number, env: TuiEnv): Seg[] {
  const inv = selected && focused
  const marker = selected ? (focused ? '>' : '*') : ' '
  const word = WORKTREE_STATUS_WORD[row.status] ?? row.status
  const left: Seg[] = [
    { text: `${marker} `, inverse: inv },
    { text: row.branch, inverse: inv },
    { text: `  ${row.label}`, dim: !inv, inverse: inv },
    { text: `  ${word}`, tone: WORKTREE_STATUS_TONE[row.status], inverse: inv }
  ]
  const right: Seg = { text: `${filesText(row.changedFiles)} ${mergeTargetText(row.mergeTarget, env)}`, dim: !inv, inverse: inv }
  return alignSegs(left, right, width, env, { inverse: inv })
}

export function WorktreesPane(props: WorktreesPaneProps) {
  const env = useTuiEnv()
  const width = Math.max(0, Math.floor(props.width))
  const height = Math.max(0, Math.floor(props.height))
  const [localSel, setLocalSel] = useState<string | undefined>(undefined)
  const topRef = useRef(0)

  const rows = props.rows
  const selIndex = Math.max(0, localSel ? rows.findIndex((r) => rowId(r) === localSel) : 0)
  // Keys can arrive several per render: the handler works on a ref.
  const selRef = useRef(selIndex)
  selRef.current = selIndex
  const bodyH = Math.max(0, height - 1)

  useFocusHandler(
    'worktrees',
    (e) => {
      if (e.type === 'key' && !e.ctrl && !e.alt && (e.name === 'enter' || (e.name === 'char' && e.ch === 'v'))) {
        const row = rows[selRef.current]
        if (row) props.onViewDiff?.(row)
        return true
      }
      const k = navKey(e)
      if (!k) return false
      if (rows.length === 0) return true
      const next = moveIndex(selRef.current, k, rows.length, Math.max(1, bodyH - 1))
      selRef.current = next
      setLocalSel(rowId(rows[next]))
      return true
    },
    props.focused
  )

  const title: PaneLine = {
    key: 'title',
    segs: paneHeading(`Worktrees (${rows.length})`, width, props.focused, env)
  }
  let body: PaneLine[]
  if (rows.length === 0) {
    body = [{ key: 'empty', segs: cutSegs([{ text: 'No agent worktrees', dim: true }], width, env) }]
  } else {
    const top = keepVisible(topRef.current, selIndex, selIndex, bodyH, rows.length)
    topRef.current = top
    body = rows.slice(top, top + bodyH).map((r, i) => ({
      key: rowId(r),
      segs: rowLine(r, top + i === selIndex, props.focused, width, env)
    }))
  }
  return <PaneLines width={width} height={height} lines={[title, ...body]} env={env} />
}
