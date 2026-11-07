import { describe, expect, it } from 'vitest'
import { computeLayout } from './layout'
import { SPLIT_MIN_COLS, type LayoutInput, type LayoutPlan, type PaneId } from './types'

const ALL: Record<PaneId, boolean> = { tree: true, transcript: true, plan: true, worktrees: true }

const input = (over: Partial<LayoutInput> = {}): LayoutInput => ({
  cols: 120,
  rows: 40,
  bufferMode: 'fullscreen',
  visible: ALL,
  trayRows: 0,
  composerRows: 3,
  ...over
})

const panes = (p: LayoutPlan): PaneId[] => p.panes.map((b) => b.pane)

function checkSums(inp: LayoutInput, plan: LayoutPlan): void {
  const all = [plan.statusRows, plan.tray.width, plan.tray.height, plan.composer.width, plan.composer.height]
  for (const b of plan.panes) all.push(b.width, b.height)
  for (const n of all) {
    expect(Number.isInteger(n)).toBe(true)
    expect(n).toBeGreaterThanOrEqual(0)
  }
  const fixed = plan.statusRows + plan.tray.height + plan.composer.height
  for (const col of [0, 1] as const) {
    const boxes = plan.panes.filter((b) => b.column === col)
    const h = boxes.reduce((a, b) => a + b.height, 0)
    expect(fixed + h).toBeLessThanOrEqual(inp.rows)
  }
  const colWidth = (c: 0 | 1): number => Math.max(0, ...plan.panes.filter((b) => b.column === c).map((b) => b.width))
  expect(colWidth(0) + colWidth(1)).toBeLessThanOrEqual(inp.cols)
  expect(plan.tray.width).toBeLessThanOrEqual(inp.cols)
  expect(plan.composer.width).toBeLessThanOrEqual(inp.cols)
  // Hidden panes never get a box.
  for (const b of plan.panes) expect(inp.visible[b.pane]).toBe(true)
}

describe('computeLayout', () => {
  it('splits at exactly SPLIT_MIN_COLS columns and stacks one column narrower', () => {
    expect(SPLIT_MIN_COLS).toBe(110)
    const split = computeLayout(input({ cols: 110 }))
    expect(split.mode).toBe('split')
    const tree = split.panes.find((b) => b.pane === 'tree')
    const transcript = split.panes.find((b) => b.pane === 'transcript')
    expect(tree?.column).toBe(0)
    expect(transcript?.column).toBe(1)
    expect(split.gutter).toBe(1)
    expect((tree?.width ?? 0) + (split.gutter ?? 0) + (transcript?.width ?? 0)).toBe(110)
    expect(tree?.width).toBeGreaterThanOrEqual(28)
    expect(tree?.width).toBeLessThanOrEqual(48)
    const stacked = computeLayout(input({ cols: 109 }))
    expect(stacked.mode).toBe('stacked')
    expect(stacked.panes.every((b) => b.column === 0 && b.width === 109)).toBe(true)
  })

  it('clamps the tree column to 28..48 and keeps the plan to a third of the right column', () => {
    const wide = computeLayout(input({ cols: 300, rows: 60 }))
    expect(wide.panes.find((b) => b.pane === 'tree')?.width).toBe(48)
    const plan = wide.panes.find((b) => b.pane === 'plan')
    const body = 60 - 1 - 3
    expect(plan?.height).toBeLessThanOrEqual(Math.floor(body / 3))
    expect(plan?.height).toBeGreaterThanOrEqual(4)
    expect(wide.statusRows).toBe(1)
    // Short split: the plan cannot get 4 rows and is left out, the transcript keeps the column.
    const short = computeLayout(input({ cols: 120, rows: 14, composerRows: 3 }))
    expect(panes(short)).not.toContain('plan')
    expect(short.panes.find((b) => b.pane === 'transcript')?.height).toBe(10)
  })

  it('never exceeds cols or rows over a grid of sizes and visibility combinations', () => {
    const ids: PaneId[] = ['tree', 'transcript', 'plan', 'worktrees']
    for (let mask = 0; mask < 16; mask++) {
      const visible = Object.fromEntries(ids.map((p, i) => [p, (mask & (1 << i)) !== 0])) as Record<PaneId, boolean>
      for (let cols = 40; cols <= 300; cols += 13) {
        for (let rows = 10; rows <= 100; rows += 7) {
          for (const trayRows of [0, 4]) {
            for (const bufferMode of ['fullscreen', 'inline'] as const) {
              const inp = input({ cols, rows, visible, trayRows, bufferMode })
              checkSums(inp, computeLayout(inp))
            }
          }
        }
      }
    }
  })

  it('drops worktrees, then plan when stacked space runs out; the tree and the transcript are never dropped', () => {
    const at = (rows: number): PaneId[] => panes(computeLayout(input({ cols: 80, rows, composerRows: 3 })))
    expect(at(60)).toEqual(['tree', 'plan', 'worktrees', 'transcript'])
    const seen: PaneId[][] = []
    for (let rows = 60; rows >= 6; rows--) seen.push(at(rows))
    for (const s of seen) {
      expect(s).toContain('transcript')
      expect(s).toContain('tree')
    }
    // Each pane, once dropped, stays dropped on smaller terminals, and they go in order.
    const firstMissing = (p: PaneId): number => seen.findIndex((s) => !s.includes(p))
    expect(firstMissing('worktrees')).toBeGreaterThan(-1)
    expect(firstMissing('worktrees')).toBeLessThanOrEqual(firstMissing('plan'))
    for (const p of ['worktrees', 'plan'] as const) {
      const i = firstMissing(p)
      for (const s of seen.slice(i)) expect(s).not.toContain(p)
    }
    // The transcript keeps at least 5 rows whenever another pane is shown and the body has the room for both.
    for (let rows = 60; rows >= 14; rows--) {
      const plan = computeLayout(input({ cols: 80, rows, composerRows: 3 }))
      if (plan.panes.length > 1) expect(plan.panes.find((b) => b.pane === 'transcript')!.height).toBeGreaterThanOrEqual(5)
    }
    expect(at(14)).toEqual(['tree', 'transcript'])
  })

  it('gives the stacked tree max(6, 30%) of the body, or what its rows want up to half of it', () => {
    const only = { tree: true, transcript: true, plan: false, worktrees: false }
    const tree = (rows: number, treeRows?: number): number =>
      computeLayout(input({ cols: 90, rows, visible: only, trayRows: 6, composerRows: 3, ...(treeRows !== undefined ? { treeRows } : {}) })).panes.find((b) => b.pane === 'tree')!.height
    // 90x30: body = 30 - 1 - 3 - 6 = 20; 30% = 6.
    expect(tree(30)).toBe(6)
    expect(tree(30, 8)).toBe(8)
    expect(tree(30, 40)).toBe(10)
    // Plan and worktrees are dropped before the tree gives up a row.
    const full = computeLayout(input({ cols: 90, rows: 24, trayRows: 6, composerRows: 3, treeRows: 8 }))
    expect(full.panes.find((b) => b.pane === 'tree')!.height).toBeGreaterThanOrEqual(6)
    expect(full.panes.find((b) => b.pane === 'transcript')!.height).toBeGreaterThanOrEqual(5)
  })

  it('split: worktrees take what their rows want, not 40% of the column', () => {
    const wt = (wanted?: number): number =>
      computeLayout(input({ cols: 120, rows: 40, trayRows: 0, ...(wanted !== undefined ? { worktreeRows: wanted } : {}) })).panes.find((b) => b.pane === 'worktrees')!.height
    expect(wt()).toBe(Math.floor(35 * 0.4))
    expect(wt(4)).toBe(4)
  })

  it('gives the tray 0 rows without cards and its rows with them', () => {
    const none = computeLayout(input({ trayRows: 0 }))
    expect(none.tray.height).toBe(0)
    const some = computeLayout(input({ trayRows: 6 }))
    expect(some.tray.height).toBe(6)
    expect(some.composer.height).toBe(3)
  })

  it('returns the inline plan: a height-0 transcript box and a pinned footer (status, tray rows, one composer row)', () => {
    const plan = computeLayout(input({ bufferMode: 'inline', cols: 90, rows: 20, trayRows: 1, composerRows: 3 }))
    expect(plan.mode).toBe('stacked')
    expect(plan.panes).toEqual([{ pane: 'transcript', column: 0, width: 90, height: 0 }])
    expect(plan.statusRows + plan.tray.height + plan.composer.height).toBe(3)
    // R2-M2: a focused tray may take up to INLINE_TRAY_MAX rows for its title and wrapped key rows, never more.
    expect(computeLayout(input({ bufferMode: 'inline', cols: 90, rows: 20, trayRows: 3, composerRows: 3 })).tray.height).toBe(3)
    expect(computeLayout(input({ bufferMode: 'inline', cols: 90, rows: 20, trayRows: 9, composerRows: 3 })).tray.height).toBe(4)
  })

  it('reserves the palette rows between the tray and the composer and honours composer rows 1..7', () => {
    for (const [cols, rows] of [
      [120, 40],
      [100, 30],
      [80, 24],
      [70, 24]
    ] as const) {
      for (let composerRows = 1; composerRows <= 7; composerRows++) {
        for (const paletteRows of [0, 6, 9, 30]) {
          for (const trayRows of [0, 5]) {
            for (const bufferMode of ['fullscreen', 'inline'] as const) {
              const inp = input({ cols, rows, composerRows, paletteRows, trayRows, bufferMode })
              const plan = computeLayout(inp)
              checkSums(inp, plan)
              const pal = plan.palette!
              expect(pal.width).toBe(cols)
              expect(plan.statusRows + plan.tray.height + pal.height + plan.composer.height).toBeLessThanOrEqual(rows)
              for (const col of [0, 1] as const) {
                const h = plan.panes.filter((b) => b.column === col).reduce((a, b) => a + b.height, 0)
                expect(plan.statusRows + plan.tray.height + pal.height + plan.composer.height + h).toBeLessThanOrEqual(rows)
              }
              if (bufferMode === 'fullscreen') {
                expect(plan.composer.height).toBe(composerRows)
                if (paletteRows > 0 && composerRows + 1 + paletteRows <= rows) expect(pal.height).toBe(paletteRows)
              }
            }
          }
        }
      }
    }
    const open = computeLayout(input({ paletteRows: 8, trayRows: 4, composerRows: 2 }))
    expect(open.palette).toEqual({ width: 120, height: 8 })
    const closed = computeLayout(input({ composerRows: 2 }))
    expect(closed.palette).toEqual({ width: 120, height: 0 })
    // The palette takes its rows from the body.
    const tr = (p: LayoutPlan): number => p.panes.filter((b) => b.column === 1).reduce((a, b) => a + b.height, 0)
    expect(tr(closed) - tr(computeLayout(input({ composerRows: 2, paletteRows: 8 })))).toBe(8)
  })

  it('leaves a 1-column gutter in the split only, widths plus gutter equal cols', () => {
    for (const cols of [110, 120, 150, 300]) {
      const plan = computeLayout(input({ cols }))
      expect(plan.mode).toBe('split')
      expect(plan.gutter).toBe(1)
      const w0 = Math.max(...plan.panes.filter((b) => b.column === 0).map((b) => b.width))
      const w1 = Math.max(...plan.panes.filter((b) => b.column === 1).map((b) => b.width))
      expect(w0 + 1 + w1).toBe(cols)
    }
    for (const cols of [70, 80, 109]) expect(computeLayout(input({ cols })).gutter).toBe(0)
    expect(computeLayout(input({ cols: 120, bufferMode: 'inline' })).gutter).toBe(0)
    // One column only: no gutter.
    const lone = computeLayout(input({ cols: 120, visible: { tree: false, transcript: true, plan: false, worktrees: false } }))
    expect(lone.gutter).toBe(0)
    expect(lone.panes[0]?.width).toBe(120)
  })

  it('is deterministic and handles tiny and degenerate terminals', () => {
    const inp = input({ cols: 40, rows: 10, trayRows: 3 })
    expect(computeLayout(inp)).toEqual(computeLayout({ ...inp }))
    checkSums(inp, computeLayout(inp))
    for (const [cols, rows] of [
      [0, 0],
      [1, 1],
      [2, 3],
      [40, 4]
    ]) {
      const tiny = input({ cols, rows, trayRows: 5 })
      checkSums(tiny, computeLayout(tiny))
    }
    const nan = computeLayout(input({ cols: Number.NaN, rows: -5 }))
    expect(nan.composer.height).toBe(0)
    expect(nan.panes.every((b) => b.width === 0 && b.height === 0)).toBe(true)
  })
})
