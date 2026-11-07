import { describe, expect, it } from 'vitest'
import { safeMermaidSvg, scanSvgText, type SvgElementLike, type SvgParse } from './outputSvg'

const CLEAN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><style>#m{font-family:sans-serif;fill:#333}</style>' +
  '<defs><marker id="arrow"><path d="M0 0L10 5L0 10z"/></marker></defs>' +
  '<g class="node"><rect width="40" height="20" style="fill:url(#g)"/><text x="5" y="10">Start</text></g>' +
  '<path d="M1 1L9 9" marker-end="url(#arrow)"/><use href="#arrow"/></svg>'

// A tiny fake DOM: the unit environment is node, so the parse and serialize steps are injected.
function fakeParse(root: SvgElementLike, hasParseError = false): SvgParse {
  return () => ({ documentElement: root, hasParseError })
}
const el = (tagName: string, attrs: Record<string, string> = {}, children: SvgElementLike[] = []): SvgElementLike => ({
  tagName,
  attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
  children
})

describe('scanSvgText', () => {
  it('passes a clean drawing', () => {
    expect(scanSvgText(CLEAN)).toBeNull()
  })
  it.each([
    ['script', '<svg><script>alert(1)</script></svg>'],
    ['foreignObject', '<svg><foreignObject><div/></foreignObject></svg>'],
    ['iframe', '<svg><iframe src="x"/></svg>'],
    ['object', '<svg><object data="x"/></svg>'],
    ['embed', '<svg><embed src="x"/></svg>'],
    ['handler', '<svg><rect onload="x()"/></svg>'],
    ['handler spaced', '<svg><rect fill="red"  onclick = "x()"/></svg>'],
    ['javascript', '<svg><a href="#">javascript:alert(1)</a></svg>'],
    ['external href', '<svg><a href="https://evil.example/">x</a></svg>'],
    ['external xlink', '<svg><use xlink:href="https://evil.example/s.svg#a"/></svg>'],
    ['empty href', '<svg><a href="">x</a></svg>'],
    ['external url()', '<svg><rect style="fill:url(https://evil.example/x)"/></svg>'],
    ['quoted url()', '<svg><rect fill="url(\'http://x/y\')"/></svg>'],
    ['import', '<svg><style>@import "x.css";</style></svg>']
  ])('refuses %s', (_n, svg) => {
    expect(scanSvgText(svg)).not.toBeNull()
  })
})

describe('safeMermaidSvg', () => {
  const ser = (): string => CLEAN
  it('returns the serialized markup for a clean tree', () => {
    const root = el('svg', { viewBox: '0 0 1 1' }, [el('g', {}, [el('rect', { fill: 'url(#g)' })]), el('use', { 'xlink:href': '#a' })])
    expect(safeMermaidSvg(CLEAN, fakeParse(root), ser)).toEqual({ ok: true, svg: CLEAN })
  })
  it('refuses at the text layer before parsing', () => {
    let parsed = false
    const r = safeMermaidSvg('<svg><script/></svg>', () => {
      parsed = true
      return { documentElement: el('svg'), hasParseError: false }
    }, ser)
    expect(r.ok).toBe(false)
    expect(parsed).toBe(false)
  })
  it('refuses parse errors and non-svg roots', () => {
    expect(safeMermaidSvg(CLEAN, fakeParse(el('svg'), true), ser).ok).toBe(false)
    expect(safeMermaidSvg(CLEAN, fakeParse(el('html')), ser).ok).toBe(false)
    expect(safeMermaidSvg(CLEAN, () => { throw new Error('x') }, ser).ok).toBe(false)
  })
  it('refuses bad nodes found by the tree walk', () => {
    expect(safeMermaidSvg(CLEAN, fakeParse(el('svg', {}, [el('g', {}, [el('svg:foreignObject')])])), ser).ok).toBe(false)
    expect(safeMermaidSvg(CLEAN, fakeParse(el('svg', {}, [el('rect', { onmouseover: 'x' })])), ser).ok).toBe(false)
    expect(safeMermaidSvg(CLEAN, fakeParse(el('svg', {}, [el('a', { href: 'http://x' })])), ser).ok).toBe(false)
    expect(safeMermaidSvg(CLEAN, fakeParse(el('svg', {}, [el('rect', { fill: 'url(http://x)' })])), ser).ok).toBe(false)
  })
  it('checks the re-serialized markup too', () => {
    expect(safeMermaidSvg(CLEAN, fakeParse(el('svg')), () => '<svg><script/></svg>').ok).toBe(false)
  })
})
