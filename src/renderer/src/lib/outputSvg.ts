// The guard for mermaid's rendered SVG (docs/design/outputs.md section 4): the only markup the renderer ever inserts.
// Layer 1 scans the text; layer 2 parses it as XML and walks every element and attribute.

export type SafeSvg = { ok: true; svg: string } | { ok: false; reason: string }

const BAD_TAGS = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed', 'animate', 'set'])

/** Text-level refusals; returns the reason or null. */
export function scanSvgText(svg: string): string | null {
  if (/<\s*(script|foreignObject|iframe|object|embed)\b/i.test(svg)) return 'it contains a script, embedded content or a foreign object'
  if (/javascript:/i.test(svg)) return 'it contains a javascript: address'
  if (/<[^>]*\son[a-z]+\s*=/i.test(svg)) return 'it contains an event handler'
  for (const m of svg.matchAll(/url\(\s*(['"]?)\s*([^'")\s]?)/gi)) {
    if (m[2] !== '#') return 'it refers to something outside itself'
  }
  for (const m of svg.matchAll(/(?:xlink:)?href\s*=\s*(["'])\s*(.?)/gi)) {
    if (m[2] !== '#') return 'it links outside itself'
  }
  if (/@import/i.test(svg)) return 'it imports a style sheet'
  return null
}

export interface SvgElementLike {
  tagName: string
  attributes: ArrayLike<{ name: string; value: string }>
  children: ArrayLike<SvgElementLike>
}
export type SvgParse = (text: string) => { documentElement: SvgElementLike; hasParseError: boolean }

function walk(el: SvgElementLike): string | null {
  const tag = el.tagName.toLowerCase().replace(/^.*:/, '')
  if (BAD_TAGS.has(tag)) return `it contains <${tag}>`
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes[i]
    const name = a.name.toLowerCase()
    if (name.startsWith('on')) return 'it contains an event handler'
    if ((name === 'href' || name === 'xlink:href') && !a.value.trim().startsWith('#')) return 'it links outside itself'
    if (/javascript:/i.test(a.value)) return 'it contains a javascript: address'
    if (/url\(\s*['"]?\s*[^#'")\s]/i.test(a.value)) return 'it refers to something outside itself'
  }
  for (let i = 0; i < el.children.length; i++) {
    const r = walk(el.children[i])
    if (r) return r
  }
  return null
}

function domParse(text: string): ReturnType<SvgParse> {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  const hasParseError = doc.getElementsByTagName('parsererror').length > 0
  return { documentElement: doc.documentElement as unknown as SvgElementLike, hasParseError }
}

/**
 * Check mermaid's SVG. `parse` and `serialize` are injectable for tests (the unit environment has no DOM).
 * Returns the re-serialized markup on success.
 */
export function safeMermaidSvg(
  svg: string,
  parse: SvgParse = domParse,
  serialize: (el: SvgElementLike) => string = (el) => new XMLSerializer().serializeToString(el as unknown as Node)
): SafeSvg {
  const text = scanSvgText(svg)
  if (text) return { ok: false, reason: text }
  let parsed: ReturnType<SvgParse>
  try {
    parsed = parse(svg)
  } catch {
    return { ok: false, reason: 'it is not valid SVG' }
  }
  if (parsed.hasParseError) return { ok: false, reason: 'it is not valid SVG' }
  if (parsed.documentElement.tagName.toLowerCase() !== 'svg') return { ok: false, reason: 'it is not an SVG drawing' }
  const bad = walk(parsed.documentElement)
  if (bad) return { ok: false, reason: bad }
  const out = serialize(parsed.documentElement)
  const again = scanSvgText(out)
  if (again) return { ok: false, reason: again }
  return { ok: true, svg: out }
}
