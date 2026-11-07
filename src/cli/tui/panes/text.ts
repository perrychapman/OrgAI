/**
 * Terminal cell width helpers for the TUI panes (W4-T3). Pure. Counts East Asian wide and fullwidth characters and
 * most emoji as 2 columns and combining marks / zero-width joiners / variation selectors as 0, so a pane can cut a
 * line to its width before Ink lays it out (output.ts ellipsisEnd counts code points, which overflows on CJK text).
 * Every string reaching these helpers is already sanitized (cli-spec 5.2): no control characters, no escapes.
 */

/** Columns a single code point takes. */
export function codePointWidth(cp: number): number {
  if (cp === 0) return 0
  // Combining marks, zero-width space / joiners, variation selectors, tag characters.
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xe0000 && cp <= 0xe01ef)
  ) {
    return 0
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x231a && cp <= 0x231b) ||
    (cp >= 0x23e9 && cp <= 0x23ec) ||
    (cp >= 0x25fd && cp <= 0x25fe) ||
    (cp >= 0x2614 && cp <= 0x2615) ||
    (cp >= 0x2648 && cp <= 0x2653) ||
    (cp >= 0x26aa && cp <= 0x26ab) ||
    (cp >= 0x26bd && cp <= 0x26be) ||
    (cp >= 0x26c4 && cp <= 0x26c5) ||
    cp === 0x26a1 ||
    cp === 0x26ce ||
    cp === 0x26d4 ||
    cp === 0x26ea ||
    (cp >= 0x26f2 && cp <= 0x26f5) ||
    cp === 0x26fa ||
    cp === 0x26fd ||
    cp === 0x2705 ||
    (cp >= 0x270a && cp <= 0x270b) ||
    cp === 0x2728 ||
    cp === 0x274c ||
    cp === 0x274e ||
    (cp >= 0x2753 && cp <= 0x2755) ||
    cp === 0x2757 ||
    (cp >= 0x2795 && cp <= 0x2797) ||
    cp === 0x27b0 ||
    cp === 0x27bf ||
    (cp >= 0x2b1b && cp <= 0x2b1c) ||
    cp === 0x2b50 ||
    cp === 0x2b55 ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x16fe0 && cp <= 0x18cff) ||
    (cp >= 0x1b000 && cp <= 0x1b2ff) ||
    cp === 0x1f004 ||
    cp === 0x1f0cf ||
    cp === 0x1f18e ||
    (cp >= 0x1f191 && cp <= 0x1f19a) ||
    (cp >= 0x1f200 && cp <= 0x1f251) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f7e0 && cp <= 0x1f7eb) ||
    (cp >= 0x1f90c && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}

const PLAIN_ASCII = /^[\x20-\x7e]*$/
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** The grapheme clusters of `s` (a cut must never fall inside one). */
export function graphemes(s: string): string[] {
  if (PLAIN_ASCII.test(s)) return s.split('')
  return Array.from(segmenter.segment(s), (x) => x.segment)
}

/**
 * Columns one grapheme cluster takes: the first visible code point's width (so marks after a wide character add 0 and
 * a ZWJ sequence such as a family emoji stays 2), 2 for an emoji with VS16 (U+FE0F) or a keycap, 2 for a regional
 * indicator pair (flag), 0 for a cluster of zero-width code points only.
 */
export function graphemeWidth(g: string): number {
  let first: number | undefined
  let w = 0
  let ri = 0
  let vs16 = false
  let keycap = false
  for (const ch of g) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp === 0xfe0f) vs16 = true
    if (cp === 0x20e3) keycap = true
    if (cp >= 0x1f1e6 && cp <= 0x1f1ff) ri++
    if (first === undefined) {
      const cw = codePointWidth(cp)
      if (cw > 0) {
        first = cp
        w = cw
      }
    }
  }
  if (first === undefined) return 0
  if (ri >= 2) return 2
  if (vs16 && (first >= 0x80 || keycap)) return 2
  return w
}

/** Columns a string takes (no line breaks expected; a tab counts as 1, the sanitizer expands tabs). */
export function textWidth(s: string): number {
  if (PLAIN_ASCII.test(s)) return s.length
  let w = 0
  for (const g of graphemes(s)) w += graphemeWidth(g)
  return w
}

/** The grapheme clusters of `s`, produced lazily (a caller that stops early never segments the rest). */
function* lazyGraphemes(s: string): Generator<string> {
  for (const x of segmenter.segment(s)) yield x.segment
}

/** The longest prefix of `s` that fits in `width` columns; never splits a grapheme cluster. Lazy: stops at the cut. */
export function sliceToWidth(s: string, width: number): string {
  if (width <= 0) return ''
  if (PLAIN_ASCII.test(s)) return s.length <= width ? s : s.slice(0, width)
  let w = 0
  let end = 0
  for (const g of lazyGraphemes(s)) {
    const cw = graphemeWidth(g)
    if (w + cw > width) break
    w += cw
    end += g.length
  }
  return s.slice(0, end)
}

/** Cut `s` to `width` columns, ending in `ellipsis` when it was cut. */
export function truncateEnd(s: string, width: number, ellipsis = '…'): string {
  const w = Math.max(0, Math.floor(width))
  if (textWidth(s) <= w) return s
  const ew = textWidth(ellipsis)
  if (ew >= w) return sliceToWidth(ellipsis, w)
  return sliceToWidth(s, w - ew) + ellipsis
}

/** `s` padded with spaces to exactly `width` columns (cut first when longer). */
export function padToWidth(s: string, width: number, ellipsis = '…'): string {
  const cut = truncateEnd(s, width, ellipsis)
  return cut + ' '.repeat(Math.max(0, width - textWidth(cut)))
}

/**
 * `left` and `right` on one line of `width` columns: right flush right, left cut with an ellipsis to make room
 * (one space between). When even `right` does not fit, the line is just `left` cut to the width.
 */
export function alignRight(left: string, right: string, width: number, ellipsis = '…'): string {
  const w = Math.max(0, Math.floor(width))
  if (!right) return truncateEnd(left, w, ellipsis)
  const rw = textWidth(right)
  if (rw + 2 > w) return truncateEnd(left, w, ellipsis)
  const room = w - rw - 1
  const l = truncateEnd(left, room, ellipsis)
  return l + ' '.repeat(w - textWidth(l) - rw) + right
}

/** A plain-ASCII logical line, wrapped with slices (one pass, each head is at most `w` characters). */
function wrapAscii(line: string, w: number, out: string[]): void {
  let start = 0
  while (line.length - start > w) {
    const head = line.slice(start, start + w)
    const space = head.lastIndexOf(' ')
    if (space > 0 && line[start + w] !== ' ') {
      out.push(head.slice(0, space))
      start += space + 1
    } else {
      out.push(head)
      start += w
      if (line[start] === ' ') start++
    }
  }
  out.push(line.slice(start))
}

/**
 * A logical line with wide or combining characters: one lazy pass over its grapheme clusters. The current output line
 * is a list of clusters; at an overflow it breaks at the last space (the clusters after it carry over) or hard.
 */
function wrapWide(line: string, w: number, out: string[]): void {
  let cur: string[] = []
  let curW = 0
  let lastSp = -1
  const add = (g: string): void => {
    const cw = graphemeWidth(g)
    if (curW + cw <= w) {
      cur.push(g)
      curW += cw
      if (g === ' ' && cur.length > 1) lastSp = cur.length - 1
      return
    }
    // A character wider than the whole line cannot be shown: drop it.
    if (cur.length === 0) return
    let carry: string[] = []
    if (lastSp > 0 && g[0] !== ' ') {
      out.push(cur.slice(0, lastSp).join(''))
      carry = cur.slice(lastSp + 1)
    } else {
      out.push(cur.join(''))
      if (g[0] === ' ') g = ''
    }
    cur = []
    curW = 0
    lastSp = -1
    for (const c of carry) add(c)
    if (g) add(g)
  }
  for (const g of lazyGraphemes(line)) add(g)
  out.push(cur.join(''))
}

/**
 * Wraps text to `width` columns: every logical line (split on newline) is broken at spaces where possible, else hard.
 * An empty logical line stays one empty line. width <= 0 gives no lines. One pass over each line (issue #35 M1).
 */
export function wrapText(text: string, width: number): string[] {
  const w = Math.floor(width)
  if (w <= 0) return []
  const out: string[] = []
  for (const logical of text.split('\n')) {
    if (logical === '') out.push('')
    else if (PLAIN_ASCII.test(logical)) wrapAscii(logical, w, out)
    else wrapWide(logical, w, out)
  }
  return out
}

/** Clamp a number into [min, max] (max wins when min > max). */
export function clampInt(n: number, min: number, max: number): number {
  const v = Number.isFinite(n) ? Math.floor(n) : min
  return Math.max(Math.min(v, max), Math.min(min, max))
}
