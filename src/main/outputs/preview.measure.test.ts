import ExcelJS from 'exceljs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { OutputWorkbookInput } from '@shared/types'
import { DOCX_PREVIEW_MAX_XML_BYTES, XLSX_PREVIEW_MAX_XML_BYTES, previewDocx, previewFile, previewXlsx } from './preview'
import { renderProduced } from './writers'
import { zipEntrySize, zipSumSizes, zipVerifyEntries } from './zipGuard'

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

const markdown = (size = 1_000_000): string => {
  const parts: string[] = []
  let i = 0
  let len = 0
  while (len < size) {
    parts.push(`## Section ${i}\n\nParagraph ${i} with **bold**, *italic* and a [link](https://example.org/${i}) plus filler text to take space.\n\n- item a ${i}\n- item b ${i}\n  - nested ${i}\n\n1. first\n2. second\n\n| Name | Qty | Note |\n|---|---:|---|\n| apple ${i} | ${i} | red |\n| pear ${i} | ${i + 1} | green |\n`)
    len += parts[parts.length - 1].length + 1
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

/** Run by hand: OUTPUTS_MEASURE=1 npx vitest run src/main/outputs/preview.measure.test.ts (timings swing 2x under load, so it never gates CI). */
describe.runIf(process.env.OUTPUTS_MEASURE === '1')('preview timings', () => {
  it('xlsx 10,000 x 26 and 1,000 x 256', async () => {
    console.log(`[measure] machine: ${cpus()[0]?.model ?? '?'} x${cpus().length}, ${process.platform}, node ${process.version}`)
    for (const [rows, cols] of [[10_000, 26], [1_000, 256]] as const) {
      const buf = (await timed(`write xlsx ${rows}x${cols}`, () => renderProduced({ kind: 'xlsx', title: 't', content: grid(rows, cols) }))).value
      const path = join(dir, `g-${rows}x${cols}.xlsx`)
      writeFileSync(path, buf)
      console.log(`[measure] xlsx ${rows}x${cols} file: ${Math.round(buf.length / 1024)} KB`)
      const v0 = performance.now()
      expect(zipVerifyEntries(buf as Buffer)).toBeNull()
      console.log(`[measure] xlsx ${rows}x${cols} zipVerifyEntries: ${Math.round((performance.now() - v0) * 10) / 10} ms`)
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
  it('docx preview time against document.xml size (no threshold), then the cut-off', async () => {
    console.log(`[measure] threshold DOCX_PREVIEW_MAX_XML_BYTES = ${DOCX_PREVIEW_MAX_XML_BYTES}`)
    console.log('[measure] md KB | document.xml KB | docx KB | preview ms (best of 3, no threshold)')
    for (const kb of [100, 200, 300, 500, 1000]) {
      const md = markdown(kb * 1000)
      const buf = (await renderProduced({ kind: 'docx', title: 't', content: md })) as Buffer
      const path = join(dir, `md-${kb}.docx`)
      writeFileSync(path, buf)
      const xml = zipEntrySize(buf, 'word/document.xml') ?? -1
      let best = Infinity
      for (let run = 1; run <= 3; run++) {
        const r = await timed(`preview docx ${kb} KB markdown run ${run}`, () => previewDocx(path, Number.POSITIVE_INFINITY))
        expect(r.value.kind).toBe('document')
        best = Math.min(best, r.ms)
        expect(r.ms).toBeLessThan(10_000)
      }
      const v0 = performance.now()
      expect(zipVerifyEntries(buf)).toBeNull()
      const verifyMs = Math.round((performance.now() - v0) * 10) / 10
      console.log(`[measure] table: ${Math.round(md.length / 1024)} | ${Math.round(xml / 1024)} | ${Math.round(buf.length / 1024)} | ${best} | verify ${verifyMs}`)
      const real = await timed(`previewFile docx ${kb} KB markdown (real threshold)`, () => previewFile(path, 'docx'))
      expect(real.value.kind).toBe(xml > DOCX_PREVIEW_MAX_XML_BYTES ? 'none' : 'document')
      expect(real.ms).toBeLessThan(10_000)
    }
  }, 300_000)
  it('xlsx preview time and memory against summed XML size (no threshold), then the cut-off', async () => {
    console.log(`[measure] threshold XLSX_PREVIEW_MAX_XML_BYTES = ${XLSX_PREVIEW_MAX_XML_BYTES}`)
    console.log('[measure] target MB | package xml MB | file KB | preview ms (best of 2, no threshold) | heapUsed delta MB | rss MB')
    for (const mb of [2, 4, 8, 12]) {
      const cols = 26
      // Worst case for cells per byte: tiny numbers only (about 27 bytes of XML per cell), written with exceljs directly.
      const rows = Math.round((mb * 1024 * 1024) / (cols * 27))
      const wb = new ExcelJS.Workbook()
      const ws = wb.addWorksheet('Dense')
      for (let r = 0; r < rows; r++) ws.addRow(Array.from({ length: cols }, (_, c) => (r + c) % 10))
      const buf = Buffer.from(await wb.xlsx.writeBuffer())
      const path = join(dir, `x-${mb}.xlsx`)
      writeFileSync(path, buf)
      const xml = zipSumSizes(buf, () => true) ?? -1
      let best = Infinity
      const h0 = process.memoryUsage().heapUsed
      for (let run = 1; run <= 2; run++) {
        const r = await timed(`preview xlsx ${mb} MB target run ${run}`, () => previewXlsx(path, Number.POSITIVE_INFINITY))
        expect(r.value.kind).toBe('sheets')
        best = Math.min(best, r.ms)
      }
      const m = process.memoryUsage()
      console.log(`[measure] xlsx table: ${mb} | ${(xml / 1048576).toFixed(1)} | ${Math.round(buf.length / 1024)} | ${best} | ${Math.round((m.heapUsed - h0) / 1048576)} | ${Math.round(m.rss / 1048576)}`)
      const real = await previewFile(path, 'xlsx')
      expect(real.kind).toBe(xml > XLSX_PREVIEW_MAX_XML_BYTES ? 'none' : 'sheets')
    }
  }, 600_000)
})
