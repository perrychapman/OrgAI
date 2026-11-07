import { describe, expect, it } from 'vitest'
import { KEY_REMOVED_RE, checkLines, reportsNote } from './proxyChecks'

const base = { reached: true, keyAccepted: true, modelCount: 9, reportsPrices: false, reportsSpend: false }

describe('checkLines', () => {
  it('lists three passing lines', () => {
    expect(checkLines(base, 'mock-proxy.example.com').map((l) => [l.check, l.ok, l.text])).toEqual([
      ['reached', true, 'Reached mock-proxy.example.com'],
      ['key', true, 'Key accepted'],
      ['models', true, '9 models listed']
    ])
  })
  it('stops after a refused key', () => {
    const lines = checkLines({ ...base, keyAccepted: false, modelCount: null }, 'h')
    expect(lines.map((l) => l.text)).toEqual(['Reached h', 'The key was refused'])
    expect(lines[1].ok).toBe(false)
  })
  it('reports an unreachable host alone', () => {
    expect(checkLines({ ...base, reached: false, keyAccepted: null, modelCount: null }, 'h').map((l) => l.text)).toEqual(['Could not reach h'])
  })
  it('handles one model and no checks', () => {
    expect(checkLines({ ...base, modelCount: 1 }, 'h')[2].text).toBe('1 model listed')
    expect(checkLines(undefined, 'h')).toEqual([])
  })
})

describe('reportsNote', () => {
  it('words each combination', () => {
    expect(reportsNote(base)).toMatch(/does not report prices or spend/)
    expect(reportsNote({ ...base, reportsPrices: true, reportsSpend: true })).toBe('This proxy reports prices and spend.')
    expect(reportsNote({ ...base, reportsPrices: true })).toMatch(/prices but not spend/)
    expect(reportsNote({ ...base, reportsSpend: true })).toMatch(/spend but not prices/)
    expect(reportsNote({ ...base, reportsPrices: null, reportsSpend: null })).toBeNull()
    expect(reportsNote({ ...base, reached: false })).toBeNull()
    expect(reportsNote(undefined)).toBeNull()
  })
})

describe('KEY_REMOVED_RE', () => {
  it('matches main text', () => {
    expect(KEY_REMOVED_RE.test('The address moved to another host, so the saved key was removed. Enter the key again.')).toBe(true)
    expect(KEY_REMOVED_RE.test('The key was refused (401).')).toBe(false)
  })
})
