/**
 * Sequence diff (Myers O(ND), bounded) and word marks. Pure. Used by diff.ts.
 *
 * `diffOps` trims the common prefix and suffix, then runs Myers with a hard cap on D (MYERS_MAX_D; trace memory is about
 * D^2 ints, 1,500 is about 9 MB) and falls back to "delete the whole middle, add the whole middle" when the cap is hit, so
 * the worst case is bounded and the result is still a correct (coarser) edit script.
 */
import type { OutputDiffMark } from '@shared/types'

export interface DiffOp {
  op: 'eq' | 'del' | 'add'
  /** 0-based index in A (eq, del) or -1. */
  a: number
  /** 0-based index in B (eq, add) or -1. */
  b: number
}

export const MYERS_MAX_D = 1500

/** Edit script of the middle part, or null when D exceeds maxD. Indexes are relative to the given arrays. */
function myers(a: ArrayLike<number>, b: ArrayLike<number>, maxD: number): DiffOp[] | null {
  const n = a.length
  const m = b.length
  if (n === 0 && m === 0) return []
  const max = Math.min(n + m, maxD)
  const off = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  let found = -1
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1]
      else x = v[off + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[off + k] = x
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
  }
  if (found < 0) return null
  const out: DiffOp[] = []
  let x = n
  let y = m
  for (let d = found; d >= 0; d--) {
    const snap = trace[d]
    const at = (k: number): number => snap[k + d + 1]
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = d === 0 ? 0 : at(prevK)
    const prevY = d === 0 ? 0 : prevX - prevK
    while (x > prevX && y > prevY) {
      out.push({ op: 'eq', a: x - 1, b: y - 1 })
      x--
      y--
    }
    if (d > 0) {
      if (x === prevX) out.push({ op: 'add', a: -1, b: prevY })
      else out.push({ op: 'del', a: prevX, b: -1 })
    }
    x = prevX
    y = prevY
  }
  return out.reverse()
}

/** Edit script turning `a` into `b` (items compared by string equality). */
export function diffOps(a: string[], b: string[], maxD: number = MYERS_MAX_D): DiffOp[] {
  const ids = new Map<string, number>()
  const idOf = (s: string): number => {
    let i = ids.get(s)
    if (i === undefined) {
      i = ids.size
      ids.set(s, i)
    }
    return i
  }
  const A = a.map(idOf)
  const B = b.map(idOf)
  let p = 0
  while (p < A.length && p < B.length && A[p] === B[p]) p++
  let s = 0
  while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++
  const midA = A.slice(p, A.length - s)
  const midB = B.slice(p, B.length - s)
  const ops: DiffOp[] = []
  for (let i = 0; i < p; i++) ops.push({ op: 'eq', a: i, b: i })
  const mid = myers(midA, midB, maxD)
  if (mid) {
    for (const o of mid) ops.push({ op: o.op, a: o.a < 0 ? -1 : o.a + p, b: o.b < 0 ? -1 : o.b + p })
  } else {
    for (let i = 0; i < midA.length; i++) ops.push({ op: 'del', a: p + i, b: -1 })
    for (let j = 0; j < midB.length; j++) ops.push({ op: 'add', a: -1, b: p + j })
  }
  for (let i = 0; i < s; i++) ops.push({ op: 'eq', a: A.length - s + i, b: B.length - s + i })
  // within one run of changes, deletions come before additions (callers pair them by position)
  for (let i = 0; i < ops.length; ) {
    if (ops[i].op === 'eq') {
      i++
      continue
    }
    let j = i
    while (j < ops.length && ops[j].op !== 'eq') j++
    const run = ops.slice(i, j)
    const sorted = [...run.filter((o) => o.op === 'del'), ...run.filter((o) => o.op === 'add')]
    for (let k = 0; k < sorted.length; k++) ops[i + k] = sorted[k]
    i = j
  }
  return ops
}

const WORD = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu
export const WORD_MARK_MAX_TOKENS = 600

/** Changed spans inside two paired lines (word level). Empty marks when either line is too long to tokenise. */
export function wordMarks(a: string, b: string): { a: OutputDiffMark[]; b: OutputDiffMark[] } {
  const ta = a.match(WORD) ?? []
  const tb = b.match(WORD) ?? []
  if (ta.length > WORD_MARK_MAX_TOKENS || tb.length > WORD_MARK_MAX_TOKENS) return { a: [], b: [] }
  const ops = diffOps(ta, tb, 400)
  const mark = (toks: string[], keep: Set<number>): OutputDiffMark[] => {
    const out: OutputDiffMark[] = []
    let pos = 0
    toks.forEach((t, i) => {
      const end = pos + t.length
      if (!keep.has(i)) {
        const last = out[out.length - 1]
        if (last && last[1] === pos) last[1] = end
        else out.push([pos, end])
      }
      pos = end
    })
    return out
  }
  const ka = new Set<number>()
  const kb = new Set<number>()
  for (const o of ops) if (o.op === 'eq') {
    ka.add(o.a)
    kb.add(o.b)
  }
  return { a: mark(ta, ka), b: mark(tb, kb) }
}
