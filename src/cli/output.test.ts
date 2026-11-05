import { describe, expect, it, vi } from 'vitest'

// The real sanitizer is W2-T6's; until it lands the contracts stub passes text through. These tests prove output
// routes every untrusted string through sanitizeTty, with a stand-in that strips what the real one strips; the last
// block runs against the real module once it is implemented.
vi.mock('./tui/sanitizeTty', () => ({
  // eslint-disable-next-line no-control-regex
  sanitizeTty: (s: string) => s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[‪-‮⁦-⁩]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}))

import { ellipsisEnd, ellipsisMiddle, emit, emitLine, relativeTime, safe, safeLine, styleFor, table, withSchema } from './output'
import { fakeContext } from './testing/fakeContext'
import { CLI_JSON_SCHEMA_VERSION } from './types'

describe('emit', () => {
  it('json is one pretty object with schemaVersion first', () => {
    const f = fakeContext({ globals: { outputFormat: 'json' } })
    emit(f.ctx, { a: 1, schemaVersion: 99 }, () => 'never')
    const parsed = JSON.parse(f.out())
    expect(parsed).toEqual({ schemaVersion: CLI_JSON_SCHEMA_VERSION, a: 1 })
    expect(Object.keys(parsed)[0]).toBe('schemaVersion')
    expect(f.out()).toContain('\n  "a": 1')
  })

  it('stream-json is one compact line with schemaVersion', () => {
    const f = fakeContext({ globals: { outputFormat: 'stream-json' } })
    emit(f.ctx, { a: 1 }, () => 'never')
    emitLine(f.ctx, { b: 2 })
    const lines = f.out().trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { schemaVersion: CLI_JSON_SCHEMA_VERSION, a: 1 },
      { schemaVersion: CLI_JSON_SCHEMA_VERSION, b: 2 }
    ])
  })

  it('JSON keeps untrusted strings as they are (JSON.stringify escapes controls)', () => {
    const f = fakeContext({ globals: { outputFormat: 'json' } })
    emit(f.ctx, { title: 'a\x1b]52;c;ZXZpbA==\x07b' }, () => '')
    expect(f.out()).not.toContain('\x1b')
    expect(JSON.parse(f.out()).title).toBe('a\x1b]52;c;ZXZpbA==\x07b')
  })

  it('text prints the renderer lines', () => {
    const f = fakeContext()
    emit(f.ctx, { a: 1 }, () => ['one', 'two'])
    expect(f.out()).toBe('one\ntwo\n')
    expect(withSchema({ x: 1 })).toEqual({ schemaVersion: CLI_JSON_SCHEMA_VERSION, x: 1 })
  })
})

describe('sanitizing and style', () => {
  it('drops an OSC 52 clipboard write from a title and a bidi override from a run name', () => {
    expect(safeLine('Fix\x1b]52;c;ZXZpbA==\x07 tests')).toBe('Fix tests')
    expect(safeLine('Ship ‮evil‬ now')).toBe('Ship evil now')
    expect(safeLine('a\n\n b')).toBe('a b')
    expect(safe('a\nb')).toBe('a\nb')
  })

  it('no colour when color is false; SGR around sanitized text when true', () => {
    const plain = styleFor(fakeContext({ globals: { color: false } }).ctx)
    expect(plain.red('x')).toBe('x')
    const color = styleFor(fakeContext({ globals: { color: true } }).ctx)
    expect(color.red('x')).toBe('\x1b[31mx\x1b[39m')
  })
})

describe('tables and widths', () => {
  it('ellipsis at the end and in the middle', () => {
    expect(ellipsisEnd('abcdefgh', 5)).toBe('abcd…')
    expect(ellipsisMiddle('/Users/me/projects/app', 11)).toBe('/User…s/app')
    expect(ellipsisEnd('abc', 5)).toBe('abc')
  })

  it('fits the width by shrinking the flex column', () => {
    const st = styleFor(fakeContext().ctx)
    const lines = table(
      [{ header: 'RUN' }, { header: 'NAME', flex: true }, { header: 'COST', align: 'right' }],
      [['R1', 'a very long run name that will not fit in forty columns at all', '$0.42']],
      40,
      st
    )
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(40)
    expect(lines[1]).toContain('…')
    expect(lines[1].endsWith('$0.42')).toBe(true)
  })

  it('relative times', () => {
    const now = 1_000_000_000_000
    const fmt = () => 'DATE'
    expect(relativeTime(now - 1000, now, fmt)).toBe('just now')
    expect(relativeTime(now - 5 * 60_000, now, fmt)).toBe('5m ago')
    expect(relativeTime(now - 3 * 3600_000, now, fmt)).toBe('3h ago')
    expect(relativeTime(1, now + 400 * 86400_000, fmt)).toBe('DATE')
  })
})

describe('with the real sanitizeTty (W2-T6)', async () => {
  const real = await vi.importActual<typeof import('./tui/sanitizeTty')>('./tui/sanitizeTty')
  const implemented = real.sanitizeTty('\x1b]52;c;x\x07') !== '\x1b]52;c;x\x07'
  it.skipIf(!implemented)('strips OSC 52 and bidi overrides', () => {
    expect(real.sanitizeTty('a\x1b]52;c;ZXZpbA==\x07b')).toBe('ab')
    expect(real.sanitizeTty('x‮y')).not.toContain('‮')
  })
})
