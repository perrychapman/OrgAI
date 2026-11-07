import { it } from 'vitest'
import ExcelJS from 'exceljs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { previewFile } from './preview'
it('dbg', async () => {
  const wb = new ExcelJS.Workbook()
  wb.addWorksheet('Data').addRow(['n'])
  const buf = Buffer.from(await wb.xlsx.writeBuffer())
  const p = join(mkdtempSync(join(tmpdir(), 'zz-')), 'a.xlsx')
  writeFileSync(p, buf)
  console.log(JSON.stringify(await previewFile(p, 'xlsx')))
})
