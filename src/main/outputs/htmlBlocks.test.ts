import { describe, expect, it } from 'vitest'
import { OUTPUT_PREVIEW_DOC_IMAGE_MAX_BYTES } from '@shared/types'
import { HTML_MAX_BLOCKS, htmlToBlocks, safeHref } from './htmlBlocks'

// 1x1 transparent png
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const blocks = (h: string) => htmlToBlocks(h).blocks
const json = (h: string): string => JSON.stringify(htmlToBlocks(h))

describe('structure', () => {
  it('headings, paragraphs and inline styles', () => {
    expect(blocks('<h1>Title</h1><p>a <strong>b</strong> <em>c</em> <u>d</u> <s>e</s> <code>f</code> <b><i>g</i></b></p>')).toEqual([
      { type: 'heading', level: 1, runs: [{ text: 'Title' }] },
      {
        type: 'paragraph',
        runs: [
          { text: 'a ' },
          { text: 'b', bold: true },
          { text: ' ' },
          { text: 'c', italic: true },
          { text: ' ' },
          { text: 'd', underline: true },
          { text: ' ' },
          { text: 'e', strike: true },
          { text: ' ' },
          { text: 'f', code: true },
          { text: ' ' },
          { text: 'g', bold: true, italic: true }
        ]
      }
    ])
  })
  it('lists flatten to one level', () => {
    expect(blocks('<ul><li>a</li><li>b<ul><li>b1</li></ul></li></ul><ol><li>x</li></ol>')).toEqual([
      { type: 'list', ordered: false, items: [[{ text: 'a' }], [{ text: 'b' }], [{ text: 'b1' }]] },
      { type: 'list', ordered: true, items: [[{ text: 'x' }]] }
    ])
  })
  it('tables with header rows and flattened cell content', () => {
    expect(blocks('<table><thead><tr><th>H1</th><th>H2</th></tr></thead><tbody><tr><td><p>a</p><p>b</p></td><td>c</td></tr></tbody></table>')).toEqual([
      { type: 'table', headerRows: 1, rows: [[[{ text: 'H1' }], [{ text: 'H2' }]], [[{ text: 'a b' }], [{ text: 'c' }]]] }
    ])
    expect(blocks('<table><tr><td>a</td></tr></table>')[0]).toEqual({ type: 'table', rows: [[[{ text: 'a' }]]] })
  })
  it('a nested table flattens into its cell', () => {
    const b = blocks('<table><tr><td>x<table><tr><td>inner</td></tr></table></td></tr></table>')
    expect(b).toHaveLength(1)
    expect(JSON.stringify(b)).toContain('inner')
  })
  it('pre becomes code, br a newline, entities decode', () => {
    expect(blocks('<pre><code>a  b\n  c &lt;x&gt;</code></pre>')).toEqual([{ type: 'code', text: 'a  b\n  c <x>' }])
    expect(blocks('<p>a<br/>b &amp; &#169; &#x41; &copy; &bogus;</p>')).toEqual([{ type: 'paragraph', runs: [{ text: 'a\nb & © A © &bogus;' }] }])
  })
  it('text outside tags becomes a paragraph; unknown tags keep their text', () => {
    expect(blocks('hello <blink>there</blink> <sup>2</sup>')).toEqual([{ type: 'paragraph', runs: [{ text: 'hello there 2' }] }])
  })
  it('a valid image, with alt', () => {
    const b = blocks(`<p>before</p><p><img src="data:image/png;base64,${PNG}" alt="a &amp; b"/></p>`)
    expect(b[1]).toEqual({ type: 'image', dataUrl: `data:image/png;base64,${PNG}`, alt: 'a & b' })
  })
})

describe('hostile input', () => {
  it('drops script and style content entirely', () => {
    const j = json('<p>a</p><script>alert(1)</script><style>p{x:url(http://e)}</style><template><p>t</p></template><iframe src="x">frame</iframe><object>o</object><SCRIPT>y</SCRIPT ><p>b</p>')
    expect(j).not.toMatch(/alert|url|frame|"t"|"o"|"y"/)
    expect(j).toContain('"a"')
    expect(j).toContain('"b"')
  })
  it('keeps only http, https and mailto links', () => {
    const run = (h: string) => (blocks(h)[0] as { runs: { href?: string }[] }).runs[0]
    expect(run('<p><a href="https://a.example/x?y=1&amp;z=2">t</a></p>').href).toBe('https://a.example/x?y=1&z=2')
    expect(run('<p><a href="mailto:a@b.c">t</a></p>').href).toBe('mailto:a@b.c')
    for (const bad of [
      'javascript:alert(1)', ' JaVaScRiPt:alert(1)', '&#106;avascript:alert(1)', '&#x6A;avascript:alert(1)', 'java\tscript:alert(1)', 'java&#9;script:alert(1)', 'data:text/html;base64,AAAA',
      'vbscript:x', 'file:///etc/passwd', '//evil/x', '/relative', 'relative', '#frag', 'http:evil', 'https://', 'https://a b', 'https://a\u0000b', ''
    ]) {
      expect(run(`<p><a href="${bad}">t</a></p>`).href, bad).toBeUndefined()
    }
    expect(safeHref('javascript:1')).toBeUndefined()
  })
  it('never lets event attributes or other attributes through', () => {
    const j = json('<p onclick="x()" style="a:b" class="c" id="d">t</p><a href="https://ok.example" onclick="x()" target="_blank">l</a>')
    expect(j).not.toMatch(/onclick|style|class|target|_blank/)
  })
  it('refuses images that are not small base64 raster data', () => {
    expect(blocks('<p><img src="https://evil/x.png" alt="x"/></p>')).toEqual([])
    expect(blocks(`<p><img src="data:image/svg+xml;base64,${Buffer.from('<svg onload=alert(1)/>').toString('base64')}"/></p>`)).toEqual([])
    expect(blocks('<p><img src="data:image/png;base64,@@@@"/></p>')).toEqual([])
    expect(blocks('<p><img src="javascript:alert(1)"/></p>')).toEqual([])
    // declared png but the bytes are not
    expect(blocks(`<p><img src="data:image/png;base64,${Buffer.from('not a png at all').toString('base64')}"/></p>`)).toEqual([])
  })
  it('flags an oversize image as truncated', () => {
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(OUTPUT_PREVIEW_DOC_IMAGE_MAX_BYTES + 10)]).toString('base64')
    const r = htmlToBlocks(`<p><img src="data:image/png;base64,${big}"/></p><p>after</p>`)
    expect(r.truncated).toBe(true)
    expect(r.blocks.map((b) => b.type)).toEqual(['paragraph'])
  })
  it('handles malformed markup without throwing', () => {
    for (const h of ['<p', '<p a="', '<a href=', '</', '<<<>>>', '<!-- never closed', '<![CDATA[x', '<?php', '<p>a</b></i></div>', '<table><tr><td>', '<ul><li>x', '</ul></ol></table></td>', '<script>unterminated', '<img>', '<a>', '&', '&#;', '&#99999999;']) {
      expect(() => htmlToBlocks(h)).not.toThrow()
    }
    expect(blocks('<p>a</p><!-- <script>x</script> --><p>b</p>')).toHaveLength(2)
  })
})

describe('caps and linear time', () => {
  it('caps blocks', () => {
    const r = htmlToBlocks('<p>x</p>'.repeat(HTML_MAX_BLOCKS + 50))
    expect(r.blocks.length).toBe(HTML_MAX_BLOCKS)
    expect(r.truncated).toBe(true)
  })
  it('caps text', () => {
    const r = htmlToBlocks(`<p>${'a'.repeat(3 * 1024 * 1024)}</p>`)
    expect(r.truncated).toBe(true)
    const t = (r.blocks[0] as { runs: { text: string }[] }).runs[0].text
    expect(t.length).toBeLessThanOrEqual(2 * 1024 * 1024)
  })
  const fast = (h: string): void => {
    const t0 = performance.now()
    htmlToBlocks(h)
    expect(performance.now() - t0).toBeLessThan(1500)
  }
  it('100k nested and unclosed tags', () => {
    fast('<b><i><u><a href="https://x.example"><ul><li><table><tr><td>'.repeat(20_000))
    fast('<div>'.repeat(100_000))
    fast('<ul>'.repeat(100_000))
    fast('<table>'.repeat(100_000))
    fast('<a href="https://x.example">'.repeat(100_000))
    fast('<p>'.repeat(100_000))
  })
  it('a 5 MB attribute and an unterminated one', () => {
    fast(`<p onclick="${'x'.repeat(5 * 1024 * 1024)}">t</p>`)
    fast(`<a href="${'h'.repeat(5 * 1024 * 1024)}">t</a>`)
    fast(`<img src="data:image/png;base64,${'A'.repeat(5 * 1024 * 1024)}">`)
    fast(`<p data-x="${'x'.repeat(5 * 1024 * 1024)}`)
  })
  it('many entities, comments, raw-text elements and stray angle brackets', () => {
    fast('&amp;'.repeat(500_000))
    fast('&a'.repeat(500_000))
    fast('<!--'.repeat(200_000))
    fast('<script>'.repeat(100_000))
    fast('</script'.repeat(100_000) + '<script>')
    fast('<'.repeat(500_000))
    fast('<a '.repeat(200_000))
  })
})
