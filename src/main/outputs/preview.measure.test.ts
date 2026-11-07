import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { OutputWorkbookInput } from '@shared/types'
import { previewFile } from './preview'
import { renderProduced } from './writers'

/**
 * Timings of the real preview path on fixtures at the produce caps. Logged, and asserted only against a generous bound
 * so a slow CI runner stays green. The target for the preview itself is well under a second.
 */

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-measure-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const grid = (rows: number, cols: number): OutputWorkbookInput => ({
  sheets: [
    {
      name: 'Data',
      columns: Array.from({ length: cols }, (_, c) => ({ header: `col ${c}` })),
      rows: Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => (c % 3 === 0 ? r * c + 0.25 : `cell ${r}/${c}`))),
      numberFormat: Array.from({ length: cols }, (_, c) => (c % 3 === 0 ? '#,##0.00' : null))
    }
  ]
})

const markdown = (): string => {
  const parts: string[] = []
  let i = 0
  while (parts.join('\n').length < 1_000_000) {
    parts.push(`## Section ${i}\n\nParagraph ${i} with **bold**, *italic* and a [link](https://example.org/${i}) plus filler text to take space.\n\n- item a ${i}\n- item b ${i}\n  - nested ${i}\n\n1. first\n2. second\n\n| Name | Qty | Note |\n|---|---:|---|\n| apple ${i} | ${i} | red |\n| pear ${i} | ${i + 1} | green |\n`)
    i++
  }
  return parts.join('\n')
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = performance.now()
  const value = await fn()
  const ms = Math.round(performance.now() - t0)
  console.log(`[measure] ${label}: ${ms} ms`)
  return { value, ms }
}

describe('preview timings', () => {
  it('xlsx 10,000 x 26 and 1,000 x 256', async () => {
    console.log(`[measure] machine: ${cpus()[0]?.model ?? '?'} x${cpus().length}, ${process.platform}, node ${process.version}`)
    for (const [rows, cols] of [[10_000, 26], [1_000, 256]] as const) {
      const buf = (await timed(`write xlsx ${rows}x${cols}`, () => renderProduced({ kind: 'xlsx', title: 't', content: grid(rows, cols) }))).value
      const path = join(dir, `g-${rows}x${cols}.xlsx`)
      writeFileSync(path, buf)
      console.log(`[measure] xlsx ${rows}x${cols} file: ${Math.round(buf.length / 1024)} KB`)
      for (let run = 1; run <= 3; run++) {
        const r = await timed(`preview xlsx ${rows}x${cols} run ${run}`, () => previewFile(path, 'xlsx'))
        expect(r.value.kind).toBe('sheets')
        if (r.value.kind === 'sheets') {
          const s = r.value.sheets[0]
          if (run === 1) console.log(`[measure]   shown ${s.rows.length} rows x ${s.rows[0]?.length} cols, truncatedRows ${s.truncatedRows}, truncatedCols ${s.truncatedCols}`)
        }
        expect(r.ms).toBeLessThan(10_000)
      }
    }
  }, 120_000)
  it('docx from about 1 MB of markdown', async () => {
    const md = markdown()
    console.log(`[measure] markdown: ${Math.round(md.length / 1024)} KB`)
    const buf = (await timed('write docx', () => renderProduced({ kind: 'docx', title: 't', content: md }))).value
    const path = join(dir, 'big.docx')
    writeFileSync(path, buf)
    console.log(`[measure] docx file: ${Math.round(buf.length / 1024)} KB`)
    for (let run = 1; run <= 3; run++) {
      const r = await timed(`preview docx run ${run}`, () => previewFile(path, 'docx'))
      expect(r.value.kind).toBe('document')
      if (r.value.kind === 'document' && run === 1) console.log(`[measure]   blocks ${r.value.blocks.length}, truncated ${r.value.truncated === true}`)
      expect(r.ms).toBeLessThan(10_000)
    }
  }, 120_000)
})
