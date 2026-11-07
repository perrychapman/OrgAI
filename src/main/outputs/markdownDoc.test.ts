import { describe, expect, it } from 'vitest'
import { markdownToDocx, parseInline, parseMarkdown } from './markdownDoc'

const text = (runs: { text: string }[]): string => runs.map((r) => r.text).join('')

describe('inline', () => {
  it('bold, italic, strike, code', () => {
    expect(parseInline('a **b** __c__ *d* _e_ ~~f~~ `g`')).toEqual([
      { text: 'a ' },
      { text: 'b', bold: true },
      { text: ' ' },
      { text: 'c', bold: true },
      { text: ' ' },
      { text: 'd', italic: true },
      { text: ' ' },
      { text: 'e', italic: true },
      { text: ' ' },
      { text: 'f', strike: true },
      { text: ' ' },
      { text: 'g', code: true }
    ])
  })
  it('nests bold and italic', () => {
    expect(parseInline('***both***')).toEqual([{ text: 'both', bold: true, italic: true }])
    expect(parseInline('**a *b* c**')).toEqual([{ text: 'a ', bold: true }, { text: 'b', bold: true, italic: true }, { text: ' c', bold: true }])
  })
  it('keeps unclosed emphasis literal', () => {
    expect(text(parseInline('**oops and *more'))).toBe('**oops and *more')
    expect(parseInline('2 * 3 * 4')).toEqual([{ text: '2 * 3 * 4' }])
    expect(parseInline('snake_case_name')).toEqual([{ text: 'snake_case_name' }])
  })
  it('links only for http, https and mailto', () => {
    expect(parseInline('[x](https://a.example/p)')).toEqual([{ text: 'x', href: 'https://a.example/p' }])
    expect(parseInline('[m](mailto:a@b.c)')).toEqual([{ text: 'm', href: 'mailto:a@b.c' }])
    expect(parseInline('[j](javascript:alert(1))').some((r) => r.href)).toBe(false)
    expect(parseInline('[j](javascript:alert)')).toEqual([{ text: 'j' }])
    expect(parseInline('[f](file:///etc/passwd)')).toEqual([{ text: 'f' }])
    expect(parseInline('[r](rel/path)')).toEqual([{ text: 'r' }])
    expect(text(parseInline('[unclosed](http://x'))).toBe('[unclosed](http://x')
  })
  it('handles escapes', () => {
    expect(parseInline('\\*not\\*')).toEqual([{ text: '*not*' }])
  })
})

describe('blocks', () => {
  it('headings and paragraphs joined with a space', () => {
    const b = parseMarkdown('# One\n\n###### Six ##\n\nline a\nline b\n\n####### seven')
    expect(b[0]).toMatchObject({ type: 'heading', level: 1 })
    expect(b[1]).toMatchObject({ type: 'heading', level: 6 })
    expect(text((b[1] as { runs: { text: string }[] }).runs)).toBe('Six')
    expect(text((b[2] as { runs: { text: string }[] }).runs)).toBe('line a line b')
    expect(b[3]).toMatchObject({ type: 'paragraph' })
  })
  it('lists with one nesting level', () => {
    const b = parseMarkdown('- a\n- b\n  - b1\n  - b2\n- c\n\n1. x\n2. y\n\t1. y1')
    expect(b[0]).toMatchObject({ type: 'list', ordered: false })
    const l = b[0] as { items: { runs: { text: string }[]; children?: { items: unknown[] } }[] }
    expect(l.items.map((i) => text(i.runs))).toEqual(['a', 'b', 'c'])
    expect(l.items[1].children?.items.length).toBe(2)
    expect(b[1]).toMatchObject({ type: 'list', ordered: true })
    expect((b[1] as { items: { children?: unknown }[] }).items[1].children).toBeTruthy()
  })
  it('tables with alignment', () => {
    const b = parseMarkdown('| A | B | C |\n|:--|:-:|--:|\n| 1 | **2** | 3 |\n| x |')
    expect(b[0]).toMatchObject({ type: 'table', align: ['left', 'center', 'right'] })
    const t = b[0] as { header: unknown[]; rows: { length: number }[][] }
    expect(t.header.length).toBe(3)
    expect(t.rows.length).toBe(2)
    expect(t.rows[1].length).toBe(3)
  })
  it('fenced code keeps lines, unclosed fences run to the end', () => {
    expect(parseMarkdown('```js\nlet a = 1\n\n  b\n```\nafter')).toEqual([
      { type: 'code', lines: ['let a = 1', '', '  b'] },
      { type: 'paragraph', runs: [{ text: 'after' }] }
    ])
    expect(parseMarkdown('```\nx\ny')).toEqual([{ type: 'code', lines: ['x', 'y'] }])
  })
  it('rules and page breaks', () => {
    expect(parseMarkdown('---\n\n***\n\n\\pagebreak\n\n<!-- pagebreak -->').map((b) => b.type)).toEqual(['rule', 'rule', 'pageBreak', 'pageBreak'])
  })
  it('a list interrupts a paragraph and CRLF is fine', () => {
    expect(parseMarkdown('intro\r\n- one\r\n- two').map((b) => b.type)).toEqual(['paragraph', 'list'])
  })
})

describe('linear time', () => {
  const run = (s: string): number => {
    const t0 = performance.now()
    parseMarkdown(s)
    return performance.now() - t0
  }
  it.each([
    ['stars', '*'.repeat(500_000)],
    ['double stars', '**'.repeat(250_000)],
    ['brackets', '['.repeat(500_000)],
    ['bracket parens', '[a](x'.repeat(100_000)],
    ['open brackets with a close', '['.repeat(250_000) + ']'],
    ['backticks', '`'.repeat(500_000)],
    ['underscores', '_a'.repeat(250_000)],
    ['tildes', '~~a'.repeat(160_000)],
    ['spaced stars', '*a '.repeat(160_000)],
    ['list lines', '- a\n'.repeat(100_000)],
    ['table rows', '|a|b|\n|-|-|\n' + '|1|2|\n'.repeat(100_000)]
  ])('%s under a second', (_n, s) => {
    expect(run(s)).toBeLessThan(1000)
  })
})

describe('docx', () => {
  it('renders a zip', async () => {
    const buf = await markdownToDocx('# T\n\nhello **world**\n\n- a\n  - b\n\n1. x\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\ncode\n```\n\n---\n\n[l](https://e.example)', 'T')
    expect(buf.subarray(0, 2).toString()).toBe('PK')
    expect(buf.length).toBeGreaterThan(1000)
  })
  it('renders an empty document', async () => {
    expect((await markdownToDocx('')).subarray(0, 2).toString()).toBe('PK')
  })
})
