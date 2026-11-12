import { describe, expect, it } from 'vitest'
// xmldom is already in node_modules (a transitive dependency); it stands in for the browser's DOMParser here.
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { activeContentIn, safeMermaidSvg } from './outputSvg'

const parse = (s: string): Document =>
  new DOMParser({ errorHandler: { warning: () => {}, error: (m: string) => { throw new Error(m) }, fatalError: (m: string) => { throw new Error(m) } } }).parseFromString(s, 'image/svg+xml') as unknown as Document
const serialize = (n: Node): string => new XMLSerializer().serializeToString(n as never)
const check = (s: string) => safeMermaidSvg(s, parse)
const wrap = (inner: string, attrs = ''): string => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>${inner}</svg>`

describe('safeMermaidSvg', () => {
  it('passes a plain drawing and returns the checked root', () => {
    const r = check(wrap('<style>#m{fill:red;stroke:url(#grad)}</style><g class="node"><rect width="10" height="10" fill="url(#grad)"/><text>Hi</text></g><marker id="a"/><use href="#a"/>'))
    expect(r.ok).toBe(true)
    if (r.ok) expect(serialize(r.root)).toContain('<text>Hi</text>')
  })
  it('refuses a root that is not svg', () => {
    expect(check('<html><body/></html>').ok).toBe(false)
  })
  it('refuses unreadable markup', () => {
    expect(check(wrap('<parsererror>bad</parsererror>')).ok).toBe(false)
    expect(safeMermaidSvg('x', () => { throw new Error('no') }).ok).toBe(false)
  })
  it('refuses script and other active elements', () => {
    for (const bad of ['<script>alert(1)</script>', '<foreignObject><div/></foreignObject>', '<iframe src="#"/>', '<object data="x"/>', '<embed src="x"/>', '<set attributeName="href" to="javascript:x"/>', '<animate attributeName="href" values="x"/>']) {
      expect(check(wrap(bad)).ok, bad).toBe(false)
    }
  })
  it('refuses event handlers in any case', () => {
    expect(check(wrap('<g/>', 'onload="x()"')).ok).toBe(false)
    expect(check(wrap('<rect onClick="x()"/>')).ok).toBe(false)
    expect(check(wrap('<rect ONMOUSEOVER="x()"/>')).ok).toBe(false)
  })
  it('refuses outside links', () => {
    expect(check(wrap('<use href="https://evil.example/a.svg#x"/>')).ok).toBe(false)
    expect(check(wrap('<use xlink:href="https://evil.example/a.svg#x"/>')).ok).toBe(false)
    expect(check(wrap('<a href="https://evil.example"><text>x</text></a>')).ok).toBe(false)
    expect(check(wrap('<image href="data:image/png;base64,AAAA"/>')).ok).toBe(false)
  })
  it('refuses javascript: addresses, however spelled', () => {
    expect(check(wrap('<a href="javascript:alert(1)"/>')).ok).toBe(false)
    expect(check(wrap('<a xlink:href=" JaVa\tScript:alert(1)"/>')).ok).toBe(false)
    expect(check(wrap('<rect style="fill:red" data-x="javascript:alert(1)"/>')).ok).toBe(false)
  })
  it('refuses active content in style text and style attributes', () => {
    expect(check(wrap('<style>@import url(https://evil.example/a.css);</style>')).ok).toBe(false)
    expect(check(wrap('<style>.a{background:url(http://evil.example/x.png)}</style>')).ok).toBe(false)
    expect(check(wrap('<style>.a{background:url("https://evil.example/x.png")}</style>')).ok).toBe(false)
    expect(check(wrap('<rect style="fill:url(https://evil.example/x)"/>')).ok).toBe(false)
    expect(check(wrap('<rect fill="url(javascript:alert(1))"/>')).ok).toBe(false)
    expect(check(wrap('<style>.a{width:expression(alert(1))}</style>')).ok).toBe(false)
    expect(check(wrap('<style><![CDATA[.a{background:url(http://evil.example/x)}]]></style>')).ok).toBe(false)
  })
})

describe('safeMermaidSvg, differences between XML and HTML parsing', () => {
  it('refuses comments and processing instructions anywhere', () => {
    expect(check(wrap('<!--><img src=x>--><g/>')).ok).toBe(false)
    expect(check(wrap('<style><?x ><img src=x> ?>.a{fill:red}</style>')).ok).toBe(false)
    expect(check(wrap('<g><!-- hi --></g>')).ok).toBe(false)
    expect(check(`<!-- before -->${wrap('<g/>')}`).ok).toBe(false)
  })
  it('refuses CDATA outside style but not inside it', () => {
    expect(check(wrap('<text><![CDATA[x]]></text>')).ok).toBe(false)
    expect(check(wrap('<style><![CDATA[.a{fill:red}]]></style>')).ok).toBe(true)
  })
  it('refuses elements outside the SVG namespace', () => {
    expect(check(wrap('<xhtml:p xmlns:xhtml="http://www.w3.org/1999/xhtml">x</xhtml:p>')).ok).toBe(false)
    expect(check(wrap('<img xmlns="http://www.w3.org/1999/xhtml"/>')).ok).toBe(false)
    expect(check('<svg xmlns="http://example.com/other"/>').ok).toBe(false)
  })
  it('refuses resource and form attributes', () => {
    for (const a of ['src="x"', 'srcset="x"', 'action="x"', 'formaction="x"', 'data="x"', 'poster="x"', 'tabindex="0"', 'tabindex="-1"']) expect(check(wrap(`<rect ${a}/>`)).ok, a).toBe(false)
  })
  it('refuses links, even to a fragment', () => {
    expect(check(wrap('<a href="#x"><text>x</text></a>')).ok).toBe(false)
    expect(check(wrap('<a><text>x</text></a>')).ok).toBe(false)
  })
  it('refuses CSS escapes and other ways to name an address', () => {
    expect(check(wrap('<style>.a{background:\\75rl(http://evil.example/x)}</style>')).ok).toBe(false)
    expect(check(wrap('<rect style="fill:u\\72l(http://evil.example/x)"/>')).ok).toBe(false)
    expect(check(wrap('<style>.a{background:image-set("http://evil.example/x.png" 1x)}</style>')).ok).toBe(false)
    expect(check(wrap('<style>.a{background:src("http://evil.example/x.png")}</style>')).ok).toBe(false)
    expect(check(wrap('<style>.a{background:image-set(url(#a) 1x)}</style>')).ok).toBe(false)
  })
})

describe('activeContentIn', () => {
  it('allows fragment urls only', () => {
    expect(activeContentIn('fill:url(#a)')).toBeNull()
    expect(activeContentIn("fill:url('#a')")).toBeNull()
    expect(activeContentIn('fill:url(a.png)')).not.toBeNull()
    expect(activeContentIn('plain text')).toBeNull()
  })
})
