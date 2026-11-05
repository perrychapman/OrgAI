/**
 * Pure pane layout (W4-T3, cli-spec 5.1). Full-screen: a 1-row status bar on top, the body, then the Decision Tray and
 * the Composer at the bottom; the body is a two-column split from SPLIT_MIN_COLS columns and one stacked column below
 * (re-run on every resize; the buffer mode itself never changes). Inline: the transcript goes to scrollback through
 * Ink's <Static> (a height-0 box) under a pinned 3-line footer: status, tray and composer lines.
 *
 * Guarantees for any input: integer sizes >= 0, column widths sum to at most `cols`, each column's heights plus the
 * status, tray and composer rows sum to at most `rows`, hidden panes get no box, and the same input gives the same plan.
 */
import { SPLIT_MIN_COLS, type LayoutInput, type LayoutPlan, type PaneBox, type PaneId } from './types'

/** The split's left column: about this share of the width ... */
const TREE_COL_SHARE = 0.34
/** ... clamped to these columns. */
const TREE_COL_MIN = 28
const TREE_COL_MAX = 48
/** Split: the plan takes at most a third of its column, and is left out below this many rows. */
const SPLIT_PLAN_MIN = 4
/** Split: worktrees take at most this share of the left column, and are left out below this many rows. */
const SPLIT_WORKTREES_SHARE = 0.4
const PANE_MIN = 3
/** Stacked shares of the body rows. */
const STACKED_SHARE: Record<'tree' | 'plan' | 'worktrees', number> = { tree: 0.3, plan: 0.25, worktrees: 0.2 }
/** Stacked: the transcript keeps at least this many rows; panes are dropped in this order until it does. */
const STACKED_TRANSCRIPT_MIN = 5
const STACKED_DROP_ORDER = ['worktrees', 'plan', 'tree'] as const

function nat(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

export function computeLayout(input: LayoutInput): LayoutPlan {
  const cols = nat(input.cols)
  const rows = nat(input.rows)
  const visible = input.visible

  if (input.bufferMode === 'inline') {
    // Pinned footer: one status line, one tray line, one composer line.
    const statusRows = Math.min(1, rows)
    const composerH = Math.min(nat(input.composerRows) > 0 ? 1 : 0, rows - statusRows)
    const trayH = Math.min(nat(input.trayRows) > 0 ? 1 : 0, rows - statusRows - composerH)
    return {
      mode: 'stacked',
      statusRows,
      panes: visible.transcript ? [{ pane: 'transcript', column: 0, width: cols, height: 0 }] : [],
      tray: { width: cols, height: trayH },
      composer: { width: cols, height: composerH }
    }
  }

  const statusRows = Math.min(1, rows)
  const composerH = Math.min(nat(input.composerRows), rows - statusRows)
  const trayH = Math.min(nat(input.trayRows), rows - statusRows - composerH)
  const body = rows - statusRows - composerH - trayH
  const tray = { width: cols, height: trayH }
  const composer = { width: cols, height: composerH }

  if (cols >= SPLIT_MIN_COLS) {
    return { mode: 'split', statusRows, panes: splitPanes(cols, body, visible), tray, composer }
  }
  return { mode: 'stacked', statusRows, panes: stackedPanes(cols, body, visible), tray, composer }
}

function splitPanes(cols: number, body: number, visible: Record<PaneId, boolean>): PaneBox[] {
  const left = visible.tree || visible.worktrees
  const right = visible.transcript || visible.plan
  let leftW = 0
  if (left && right) {
    leftW = Math.max(TREE_COL_MIN, Math.min(TREE_COL_MAX, Math.round(cols * TREE_COL_SHARE)))
    leftW = Math.min(leftW, cols)
  } else if (left) {
    leftW = cols
  }
  const rightW = right ? cols - leftW : 0
  const out: PaneBox[] = []

  if (left) {
    let wt = 0
    if (visible.worktrees) {
      if (!visible.tree) wt = body
      else {
        wt = Math.floor(body * SPLIT_WORKTREES_SHARE)
        if (wt < PANE_MIN || body - wt < PANE_MIN) wt = 0
      }
    }
    if (visible.tree) out.push({ pane: 'tree', column: 0, width: leftW, height: body - wt })
    if (visible.worktrees && (wt > 0 || !visible.tree)) out.push({ pane: 'worktrees', column: 0, width: leftW, height: wt })
  }
  if (right) {
    let plan = 0
    if (visible.plan) {
      if (!visible.transcript) plan = body
      else {
        plan = Math.floor(body / 3)
        if (plan < SPLIT_PLAN_MIN) plan = 0
      }
    }
    if (visible.transcript) out.push({ pane: 'transcript', column: 1, width: rightW, height: body - plan })
    if (visible.plan && (plan > 0 || !visible.transcript)) out.push({ pane: 'plan', column: 1, width: rightW, height: plan })
  }
  // A lone column is column 0.
  if (!left) for (const p of out) p.column = 0
  return out
}

function stackedPanes(cols: number, body: number, visible: Record<PaneId, boolean>): PaneBox[] {
  const shown = new Set<'tree' | 'plan' | 'worktrees'>()
  for (const p of ['tree', 'plan', 'worktrees'] as const) if (visible[p]) shown.add(p)
  const transcriptMin = visible.transcript ? STACKED_TRANSCRIPT_MIN : 0

  const heights = (): Record<'tree' | 'plan' | 'worktrees', number> => {
    const h = { tree: 0, plan: 0, worktrees: 0 }
    // Without a transcript the other panes share the whole body by their weights.
    const total = [...shown].reduce((a, p) => a + STACKED_SHARE[p], 0)
    for (const p of shown) {
      h[p] = visible.transcript ? Math.floor(body * STACKED_SHARE[p]) : total > 0 ? Math.floor((body * STACKED_SHARE[p]) / total) : 0
    }
    return h
  }

  let h = heights()
  for (const p of STACKED_DROP_ORDER) {
    const used = [...shown].reduce((a, q) => a + h[q], 0)
    const tooSmall = [...shown].some((q) => h[q] < PANE_MIN)
    if (body - used >= transcriptMin && !tooSmall) break
    // Drop the next pane in order (worktrees, then plan, then tree) if it is shown.
    if (shown.has(p)) {
      shown.delete(p)
      h = heights()
    }
  }
  // Without a transcript, give the last pane the rounding remainder.
  const out: PaneBox[] = []
  const order = ['tree', 'plan', 'worktrees'] as const
  const usedAll = [...shown].reduce((a, q) => a + h[q], 0)
  let remainder = body - usedAll
  if (!visible.transcript) {
    const lastShown = [...order].reverse().find((p) => shown.has(p))
    if (lastShown) {
      h[lastShown] += remainder
      remainder = 0
    }
  }
  for (const p of order) if (shown.has(p)) out.push({ pane: p, column: 0, width: cols, height: h[p] })
  if (visible.transcript) out.push({ pane: 'transcript', column: 0, width: cols, height: Math.max(0, remainder) })
  return out
}
