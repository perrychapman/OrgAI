import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OutputDiff } from '@shared/types'
import { OUTPUT_TEXT_MAX_BYTES, OUTPUT_THUMB_IMAGE_MAX_BYTES, OUTPUT_THUMB_LINES_MAX_CHARS } from '@shared/types'
import { compareFiles, renderDeck, textForAgent, thumbForFile } from './formats'
import { parseCsv } from './diff'
import { diffOps, wordMarks } from './diffCore'
import { renderProduced } from './writers'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-formats-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const f = (name: string, data: Buffer | string): string => {
  const p = join(dir, name)
  writeFileSync(p, data)
  return p
}

const deck = async (n: number, title = 'Slide'): Promise<Buffer> =>
  renderDeck({ slides: Array.from({ length: n }, (_, i) => ({ layout: 'content' as const, title: `${title} ${i + 1}`, bullets: [{ text: `point ${i + 1}` }, { text: 'sub', level: 1 as const }], notes: i === 0 ? 'first notes' : undefined })) }, { read: () => PNG })

describe('thumbForFile', () => {
  it('pptx gives the first slide only, with small pictures kept and large ones dropped to placeholders', async () => {
    const small = await renderDeck({ slides: [{ layout: 'image', title: 'One', image: { path: 'a', alt: 'tiny' } }, { layout: 'content', title: 'Two' }] }, { read: () => PNG })
    const t = await thumbForFile(f('a.pptx', small), 'pptx')
    expect(t.kind).toBe('slide')
    if (t.kind === 'slide') {
      expect(t.size).toEqual({ w: 960, h: 540 })
      expect(t.slide.title).toBe('One')
      expect(t.slide.shapes.some((s) => s.type === 'image')).toBe(true)
    }
    const bigPng = Buffer.concat([PNG, Buffer.from(Array.from({ length: 100_000 }, (_, i) => (i * 7919) % 251))])
    const big = await renderDeck({ slides: [{ layout: 'image', title: 'One', image: { path: 'a', alt: 'huge' } }] }, { read: () => bigPng })
    const t2 = await thumbForFile(f('b.pptx', big), 'pptx')
    expect(t2.kind === 'slide' && t2.slide.shapes.some((s) => s.type === 'image')).toBe(false)
    expect(t2.kind === 'slide' && t2.slide.shapes.some((s) => s.type === 'placeholder' && s.alt === 'huge')).toBe(true)
  })
  it('image only when the file is already small; svg only when safe and small', async () => {
    expect(await thumbForFile(f('a.png', PNG), 'image')).toEqual({ kind: 'image', dataUrl: `data:image/png;base64,${PNG.toString('base64')}` })
    expect(await thumbForFile(f('big.png', Buffer.concat([PNG, Buffer.alloc(OUTPUT_THUMB_IMAGE_MAX_BYTES)])), 'image')).toEqual({ kind: 'none' })
    expect(await thumbForFile(f('x.png', Buffer.from('<svg onload="x()"/>')), 'image')).toEqual({ kind: 'none' })
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'
    expect(await thumbForFile(f('a.svg', svg), 'svg')).toEqual({ kind: 'svg', text: svg })
    expect(await thumbForFile(f('b.svg', '<svg><script>1</script></svg>'), 'svg')).toEqual({ kind: 'none' })
    expect(await thumbForFile(f('c.svg', `<svg xmlns="http://www.w3.org/2000/svg">${'<rect/>'.repeat(20000)}</svg>`), 'svg')).toEqual({ kind: 'none' })
  })
  it('text kinds give at most 4 lines and the character budget; docx the first blocks; xlsx a 4 x 6 block', async () => {
    const t = await thumbForFile(f('a.md', '# Title\n\n\nline two\nline three\nline four\nline five'), 'markdown')
    expect(t).toEqual({ kind: 'lines', lines: ['# Title', 'line two', 'line three', 'line four'] })
    const long = await thumbForFile(f('b.txt', Array.from({ length: 4 }, () => 'x'.repeat(200)).join('\n')), 'text')
    expect(long.kind === 'lines' && long.lines.join('').length).toBeLessThanOrEqual(OUTPUT_THUMB_LINES_MAX_CHARS)
    expect(await thumbForFile(f('c.json', ''), 'json')).toEqual({ kind: 'none' })
    const docx = await renderProduced({ kind: 'docx', title: 't', content: '# Report\n\nFirst paragraph.\n\n- a\n- b\n\nLast.' })
    expect(await thumbForFile(f('a.docx', docx), 'docx')).toEqual({ kind: 'lines', lines: ['Report', 'First paragraph.', '- a', '- b'] })
    const rows = Array.from({ length: 10 }, (_, r) => Array.from({ length: 9 }, (_, c) => (c === 0 ? `r${r}` : r * c)))
    const xlsx = await renderProduced({ kind: 'xlsx', title: 't', content: { sheets: [{ name: 'S', rows }] } })
    const cells = await thumbForFile(f('a.xlsx', xlsx), 'xlsx')
    expect(cells.kind === 'cells' && cells.rows.length).toBe(4)
    expect(cells.kind === 'cells' && cells.rows[0].length).toBe(6)
    expect(cells.kind === 'cells' && cells.rows[1][0]).toBe('r1')
  })
  it('pdf, other, junk and missing files are none and never throw', async () => {
    expect(await thumbForFile(f('a.pdf', '%PDF'), 'pdf')).toEqual({ kind: 'none' })
    expect(await thumbForFile(f('a.bin', 'x'), 'other')).toEqual({ kind: 'none' })
    expect(await thumbForFile(f('bad.pptx', 'junk'), 'pptx')).toEqual({ kind: 'none' })
    expect(await thumbForFile(f('bad.docx', 'junk'), 'docx')).toEqual({ kind: 'none' })
    expect(await thumbForFile(join(dir, 'missing.md'), 'markdown')).toEqual({ kind: 'none' })
  })
})

describe('textForAgent', () => {
  it('reads text kinds as stored, cuts at the byte cap on a code point, flags truncation', async () => {
    expect(await textForAgent(f('a.md', '# hi\né'), 'markdown')).toEqual({ text: '# hi\né', truncated: false })
    expect(await textForAgent(f('b.svg', '<svg/>'), 'svg')).toEqual({ text: '<svg/>', truncated: false })
    const big = 'a'.repeat(OUTPUT_TEXT_MAX_BYTES - 1) + '€tail'
    const r = await textForAgent(f('c.txt', big), 'text')
    expect('text' in r && r.truncated).toBe(true)
    expect('text' in r && r.text).not.toContain('�')
    expect('text' in r && Buffer.byteLength(r.text)).toBeLessThanOrEqual(OUTPUT_TEXT_MAX_BYTES)
  })
  it('docx as markdown-like text', async () => {
    const docx = await renderProduced({ kind: 'docx', title: 't', content: '# Plan\n\nSome **bold** text.\n\n- one\n- two\n\n1. first\n\n| A | B |\n|---|---|\n| 1 | 2 |\n' })
    const r = await textForAgent(f('a.docx', docx), 'docx')
    expect('text' in r).toBe(true)
    const t = 'text' in r ? r.text : ''
    expect(t).toContain('# Plan')
    expect(t).toContain('Some bold text.')
    expect(t).toContain('- one\n- two')
    expect(t).toContain('1. first')
    expect(t).toMatch(/\| A \| B \|\n\| --- \| --- \|\n\| 1 \| 2 \|/)
  })
  it('xlsx as tab-separated text per sheet', async () => {
    const xlsx = await renderProduced({ kind: 'xlsx', title: 't', content: { sheets: [{ name: 'Sales', rows: [['Region', 'Q1'], ['EMEA', 12]] }, { name: 'Notes', rows: [['a\tb']] }] } })
    const r = await textForAgent(f('a.xlsx', xlsx), 'xlsx')
    expect(r).toEqual({ text: '## Sheet Sales\nRegion\tQ1\nEMEA\t12\n\n## Sheet Notes\na b', truncated: false })
  })
  it('pptx per slide with the title, text and speaker notes', async () => {
    const r = await textForAgent(f('a.pptx', await deck(2)), 'pptx')
    expect('text' in r).toBe(true)
    const t = 'text' in r ? r.text : ''
    expect(t).toContain('## Slide 1: Slide 1')
    expect(t).toContain('- point 1\n  - sub')
    expect(t).toContain('Speaker notes: first notes')
    expect(t).toContain('## Slide 2: Slide 2')
    expect(t.indexOf('Speaker notes')).toBeLessThan(t.indexOf('## Slide 2'))
  })
  it('refuses image, pdf, other and unreadable files with plain sentences', async () => {
    const msg = 'OrgAI cannot read this kind of file as text.'
    expect(await textForAgent(f('a.png', PNG), 'image')).toEqual({ refused: msg })
    expect(await textForAgent(f('a.pdf', '%PDF'), 'pdf')).toEqual({ refused: msg })
    expect(await textForAgent(f('a.bin', 'x'), 'other')).toEqual({ refused: msg })
    const bad = await textForAgent(f('bad.docx', 'junk'), 'docx')
    expect('refused' in bad && bad.refused.length).toBeGreaterThan(0)
    expect(await textForAgent(join(dir, 'gone.md'), 'markdown')).toHaveProperty('refused')
  })
})

describe('diffCore', () => {
  it('yields a correct edit script (apply it to get b)', () => {
    const cases: [string[], string[]][] = [
      [[], []],
      [['a'], []],
      [[], ['a']],
      [['a', 'b', 'c'], ['a', 'x', 'c']],
      [['a', 'b', 'c', 'd', 'e'], ['b', 'c', 'e', 'f']],
      [['x', 'y'], ['y', 'x']],
      [Array.from({ length: 50 }, (_, i) => `l${i}`), Array.from({ length: 50 }, (_, i) => (i % 5 === 0 ? `c${i}` : `l${i}`))]
    ]
    for (const [a, b] of cases) {
      const ops = diffOps(a, b)
      const rebuilt: string[] = []
      for (const o of ops) {
        if (o.op === 'eq') {
          expect(a[o.a]).toBe(b[o.b])
          rebuilt.push(a[o.a])
        } else if (o.op === 'add') rebuilt.push(b[o.b])
      }
      expect(rebuilt).toEqual(b)
      expect(ops.filter((o) => o.op !== 'add').map((o) => o.a)).toEqual(a.map((_, i) => i))
    }
  })
  it('falls back to a coarse but correct script past the D cap', () => {
    const a = Array.from({ length: 300 }, (_, i) => `a${i}`)
    const b = Array.from({ length: 300 }, (_, i) => `b${i}`)
    const ops = diffOps(a, b, 50)
    expect(ops.filter((o) => o.op === 'del').length).toBe(300)
    expect(ops.filter((o) => o.op === 'add').length).toBe(300)
  })
  it('marks changed words', () => {
    const m = wordMarks('the quick brown fox', 'the slow brown dog')
    expect(m.a.map(([s, e]) => 'the quick brown fox'.slice(s, e))).toEqual(['quick', 'fox'])
    expect(m.b.map(([s, e]) => 'the slow brown dog'.slice(s, e))).toEqual(['slow', 'dog'])
  })
})

describe('compareFiles', () => {
  it('text: hunks with 3 lines of context, line numbers, counts and word marks', async () => {
    const a = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
    const b = [...a]
    b[9] = 'line 10 changed here'
    b.splice(20, 0, 'inserted line')
    const d = await compareFiles(f('a.txt', a.join('\n') + '\n'), f('b.txt', b.join('\n') + '\n'), 'text')
    expect(d.kind).toBe('text')
    if (d.kind !== 'text') return
    expect(d.added).toBe(2)
    expect(d.removed).toBe(1)
    expect(d.hunks).toHaveLength(2)
    const h0 = d.hunks[0]
    expect(h0.lines.map((l) => l.op)).toEqual(['eq', 'eq', 'eq', 'del', 'add', 'eq', 'eq', 'eq'])
    expect(h0.aStart).toBe(7)
    expect(h0.aCount).toBe(7)
    expect(h0.bStart).toBe(7)
    expect(h0.bCount).toBe(7)
    expect(h0.lines[3]).toMatchObject({ op: 'del', a: 10, text: 'line 10' })
    expect(h0.lines[4]).toMatchObject({ op: 'add', b: 10, text: 'line 10 changed here' })
    expect(h0.lines[3].marks).toBeUndefined() // only whole words added on the right: nothing removed to mark on the left
    expect(h0.lines[4].marks?.map(([s, e]) => h0.lines[4].text.slice(s, e).trim())).toContain('changed here')
    const h1 = d.hunks[1]
    expect(h1.lines.filter((l) => l.op === 'add')).toHaveLength(1)
    expect(h1.lines.find((l) => l.op === 'add')).toMatchObject({ b: 21, text: 'inserted line' })
    expect(d.truncated).toBeUndefined()
  })
  it('text: identical files give no hunks; every text kind uses the line diff', async () => {
    for (const [name, kind] of [['a.md', 'markdown'], ['a.json', 'json'], ['a.mmd', 'mermaid'], ['a.svg', 'svg']] as const) {
      const d = await compareFiles(f(name, 'x\ny'), f(`2${name}`, 'x\ny'), kind)
      expect(d).toEqual({ kind: 'text', hunks: [], added: 0, removed: 0 })
    }
  })
  it('text: truncates past the changed-line cap and says so', async () => {
    const a = Array.from({ length: 6000 }, (_, i) => `a${i}`).join('\n')
    const b = Array.from({ length: 6000 }, (_, i) => `b${i}`).join('\n')
    const d = await compareFiles(f('a.txt', a), f('b.txt', b), 'text')
    expect(d.kind === 'text' && d.truncated).toBe(true)
    expect(d.kind === 'text' && d.hunks.reduce((s, h) => s + h.lines.filter((l) => l.op !== 'eq').length, 0)).toBe(5000)
    expect(d.kind === 'text' && d.added).toBe(6000)
  })
  it('docx: blocks with word marks on changed ones', async () => {
    const mk = (md: string): Promise<Buffer> => renderProduced({ kind: 'docx', title: 't', content: md })
    const a = f('a.docx', await mk('# Plan\n\nWe ship in March.\n\nOld paragraph.\n\nTail.'))
    const b = f('b.docx', await mk('# Plan\n\nWe ship in April.\n\nTail.\n\nNew last.'))
    const d = await compareFiles(a, b, 'docx')
    expect(d.kind).toBe('blocks')
    if (d.kind !== 'blocks') return
    const ops = d.rows.map((r) => r.op)
    expect(ops[0]).toBe('eq')
    expect(ops).toContain('chg')
    const chg = d.rows.find((r) => r.op === 'chg' && r.marks)
    expect(chg?.marks?.a?.length).toBeGreaterThan(0)
    expect(d.rows.some((r) => r.op === 'add')).toBe(true)
  })
  it('xlsx and csv: cell changes, row ops by content', async () => {
    const mk = (rows: (string | number)[][]): Promise<Buffer> => renderProduced({ kind: 'xlsx', title: 't', content: { sheets: [{ name: 'S', rows }, ...(rows.length > 3 ? [{ name: 'Extra', rows: [['x']] }] : [])] } })
    const a = f('a.xlsx', await mk([['k', 'v'], ['a', 1], ['b', 2]]))
    const b = f('b.xlsx', await mk([['k', 'v'], ['a', 5], ['inserted', 9], ['b', 2]]))
    const d = await compareFiles(a, b, 'xlsx')
    expect(d.kind).toBe('cells')
    if (d.kind !== 'cells') return
    const s = d.sheets.find((x) => x.name === 'S')
    expect(s?.status).toBe('changed')
    expect(s?.changes).toEqual([{ r: 1, c: 1, op: 'chg', was: 1, now: 5 }])
    expect(s?.rowOps).toEqual([{ r: 2, op: 'add' }])
    expect(d.sheets.find((x) => x.name === 'Extra')?.status).toBe('added')
    // csv: RFC 4180
    const ca = f('a.csv', 'name,note\r\n"Smith, J","said ""hi"""\r\nplain,x\r\n')
    const cb = f('b.csv', 'name,note\r\n"Smith, J","said ""bye"""\r\nplain,x\r\n')
    const cd = await compareFiles(ca, cb, 'csv')
    expect(cd).toEqual({ kind: 'cells', sheets: [{ name: '', status: 'changed', changes: [{ r: 1, c: 1, op: 'chg', was: 'said "hi"', now: 'said "bye"' }], rowOps: [] }] })
    expect(parseCsv('a,"b\nc",d\n')).toEqual([['a', 'b\nc', 'd']])
    const same = await compareFiles(ca, ca, 'csv')
    expect(same.kind === 'cells' && same.sheets[0].status).toBe('same')
  })
  it('pptx: aligned by title so an inserted slide does not shift the rest', async () => {
    const mk = (titles: string[], tweak = ''): Promise<Buffer> => renderDeck({ slides: titles.map((t) => ({ layout: 'content' as const, title: t, bullets: [{ text: `about ${t}${t === tweak ? ' (edited)' : ''}` }] })) }, { read: () => PNG })
    const a = f('a.pptx', await mk(['Intro', 'Plan', 'Risks', 'End']))
    const b = f('b.pptx', await mk(['Intro', 'Inserted', 'Plan', 'Risks', 'End'], 'Risks'))
    const d = await compareFiles(a, b, 'pptx')
    expect(d).toEqual({
      kind: 'slides',
      pairs: [
        { a: 1, b: 1, status: 'same' },
        { b: 2, status: 'added' },
        { a: 2, b: 3, status: 'same' },
        { a: 3, b: 4, status: 'changed' },
        { a: 4, b: 5, status: 'same' }
      ]
    })
    const removed = await compareFiles(b, a, 'pptx')
    expect(removed.kind === 'slides' && removed.pairs.find((p) => p.status === 'removed')).toEqual({ a: 2, status: 'removed' })
  })
  it('image, pdf and other are none; an unreadable side says which', async () => {
    for (const kind of ['image', 'pdf', 'other'] as const) {
      const d = await compareFiles(f('a', 'x'), f('b', 'y'), kind)
      expect(d.kind).toBe('none')
    }
    const bad = await compareFiles(f('bad.docx', 'junk'), f('c.docx', await renderProduced({ kind: 'docx', title: 't', content: 'x' })), 'docx')
    expect(bad.kind === 'none' && bad.reason).toMatch(/older version/)
    const missing: OutputDiff = await compareFiles(join(dir, 'nope.txt'), join(dir, 'nope2.txt'), 'text')
    expect(missing.kind).toBe('none')
  })
})
