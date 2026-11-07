import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { diffText } from './diff'
import { diffOps } from './diffCore'
import { compareFiles } from './formats'
import { renderProduced } from './writers'

/** Compare timings at the caps. Logged; asserted against generous bounds (the point is no quadratic or exponential blowup). */

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-diff-measure-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const time = (label: string, fn: () => void): number => {
  const t0 = performance.now()
  fn()
  const t = performance.now() - t0
  console.log(`[diff measure] ${label}: ${t.toFixed(0)} ms`)
  return t
}

const lines = (n: number, f: (i: number) => string): string => Array.from({ length: n }, (_, i) => f(i)).join('\n')

describe('text diff timing', () => {
  it('5,000 lines: identical, sparse edits, heavy edits, nothing in common, reordered', () => {
    const base = lines(5000, (i) => `line ${i} of the file with some words in it`)
    expect(time('identical', () => diffText(base, base))).toBeLessThan(2000)
    const sparse = lines(5000, (i) => (i % 50 === 0 ? `line ${i} CHANGED` : `line ${i} of the file with some words in it`))
    let d = diffText(base, sparse)
    expect(d.kind === 'text' && d.removed).toBe(100)
    expect(time('sparse (2%)', () => diffText(base, sparse))).toBeLessThan(3000)
    const heavy = lines(5000, (i) => (i % 3 === 0 ? `line ${i} CHANGED` : `line ${i} of the file with some words in it`))
    expect(time('heavy (33%)', () => (d = diffText(base, heavy)))).toBeLessThan(10_000)
    const none = lines(5000, (i) => `other ${i}`)
    expect(time('no lines in common (fallback)', () => (d = diffText(base, none)))).toBeLessThan(5000)
    expect(d.kind === 'text' && d.truncated).toBe(true)
    const reversed = base.split('\n').reverse().join('\n')
    expect(time('reversed', () => (d = diffText(base, reversed)))).toBeLessThan(10_000)
  })
  it('the edit script itself on 10,000 items with 1,400 edits stays fast and memory-bounded', () => {
    const a = Array.from({ length: 10_000 }, (_, i) => `k${i}`)
    const b = a.map((x, i) => (i % 7 === 0 ? `z${i}` : x))
    const t = time('diffOps 10k, 1.4k edits', () => diffOps(a, b))
    expect(t).toBeLessThan(10_000)
  })
  it('a long line pair does not blow up the word marks', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `w${i}`).join(' ')
    const b = Array.from({ length: 3000 }, (_, i) => (i % 2 ? `x${i}` : `w${i}`)).join(' ')
    expect(time('word marks on 3000-word lines', () => diffText(a, b))).toBeLessThan(3000)
  })
})

describe('sheet and deck diff timing', () => {
  it('500 x 64 sheets, every cell changed', async () => {
    const mk = (k: number): Promise<Buffer> => renderProduced({ kind: 'xlsx', title: 't', content: { sheets: [{ name: 'S', rows: Array.from({ length: 500 }, (_, r) => Array.from({ length: 64 }, (_, c) => r * c + k)) }] } })
    const a = join(dir, 'a.xlsx')
    const b = join(dir, 'b.xlsx')
    writeFileSync(a, await mk(0))
    writeFileSync(b, await mk(1))
    const t0 = performance.now()
    const d = await compareFiles(a, b, 'xlsx')
    const t = performance.now() - t0
    console.log(`[diff measure] xlsx 500x64 all changed: ${t.toFixed(0)} ms`)
    expect(d.kind === 'cells' && d.sheets[0].changes.length).toBe(5000) // capped, truncated
    expect(d.kind === 'cells' && d.sheets[0].truncated).toBe(true)
    expect(t).toBeLessThan(15_000)
  })
})
