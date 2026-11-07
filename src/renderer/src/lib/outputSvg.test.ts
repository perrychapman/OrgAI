import { describe, expect, it } from 'vitest'
// xmldom is already in node_modules (a transitive dependency); it stands in for the browser's DOMParser here.
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { activeContentIn, safeMermaidSvg } from './outputSvg'

const parse = (s: string): Document =>
  new DOMParser({ errorHandler: { warning: () => {}, error: (m: string) => { throw new Error(m) }, fatalError: (m: string) => { throw new Error(m) } } }).parseFromString(s, 'image/svg+xml') as unknown as Document
const serialize = (n: Node): string => new XMLSerializer().serializeToString(n as never)
const check = (s: string) => safeMermaidSvg(s, parse, serialize)
const wrap = (inner: string, attrs = ''): string => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>${inner}</svg>`

describe('safeMermaidSvg', () => {
  it('passes a plain drawing and returns re-serialized markup', () => {
    const r = check(wrap('<style>#m{fill:red;stroke:url(#grad)}</style><g class="node"><rect width="10" height="10" fill="url(#grad)"/><text>Hi</text></g><marker id="a"/><use href="#a"/>'))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.svg).toContain('<text>Hi</text>')
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

describe('activeContentIn', () => {
  it('allows fragment urls only', () => {
    expect(activeContentIn('fill:url(#a)')).toBeNull()
    expect(activeContentIn("fill:url('#a')")).toBeNull()
    expect(activeContentIn('fill:url(a.png)')).not.toBeNull()
    expect(activeContentIn('plain text')).toBeNull()
  })
})
