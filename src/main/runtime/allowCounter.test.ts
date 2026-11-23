import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PermissionSuggestion } from '@shared/types'
import { ALLOW_COUNT_KEYS_MAX, ALLOW_COUNT_KEY_MAX_CHARS, ALLOW_COUNT_MAX, allowCountFile, allowCountKey, allowCountOf, bumpAllowCount, readAllowCounts } from './allowCounter'
import { removeProjectData } from '../store/projectData'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orgai-allow-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const rule = (toolName: string, ruleContent?: string): PermissionSuggestion => ({ type: 'addRules', rules: [{ toolName, ...(ruleContent ? { ruleContent } : {}) }], behavior: 'allow', destination: 'session' })

describe('allowCountKey', () => {
  it('is the rule matching derives for the call: tool plus command shape, not the raw command', () => {
    expect(allowCountKey('Bash', { command: 'npm test' })).toBe('Bash(npm test:*)')
    expect(allowCountKey('Bash', { command: 'npm test -- --watch' })).toBe('Bash(npm test:*)')
    expect(allowCountKey('Bash', { command: 'git status' })).toBe('Bash(git status:*)')
    expect(allowCountKey('PowerShell', { command: 'npm test' })).toBe('PowerShell(npm test:*)')
    expect(allowCountKey('WebSearch', { query: 'x' })).toBe('WebSearch')
  })

  it("prefers the request's own suggestions (the adapter built them with the right options) and sorts several rules", () => {
    expect(allowCountKey('Bash', { command: 'cd wt && npm test' }, [rule('Bash', 'npm test:*')])).toBe('Bash(npm test:*)')
    const two: PermissionSuggestion = {
      type: 'addRules',
      rules: [
        { toolName: 'Bash', ruleContent: 'npm test:*' },
        { toolName: 'Bash', ruleContent: 'git status:*' }
      ],
      behavior: 'allow',
      destination: 'session'
    }
    expect(allowCountKey('Bash', {}, [two])).toBe('Bash(git status:*) | Bash(npm test:*)')
  })

  it('has no key for a call no rule covers (compound with a pipe, an unusable command) so it is never counted', () => {
    expect(allowCountKey('Bash', { command: 'cat a | grep b' })).toBeNull()
    expect(allowCountKey('Bash', { command: '' })).toBeNull()
    expect(allowCountKey('Bash', undefined)).toBeNull()
    expect(allowCountKey('', {})).toBeNull()
    expect(allowCountKey('Bash', { command: `npm test ${'x'.repeat(10)}` }, [rule('Bash', 'a'.repeat(ALLOW_COUNT_KEY_MAX_CHARS))])).toBeNull()
  })

  it('ignores deny suggestions and non-rule suggestions', () => {
    const deny: PermissionSuggestion = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm:*' }], behavior: 'deny', destination: 'session' }
    const mode: PermissionSuggestion = { type: 'setMode', mode: 'acceptEdits', destination: 'session' }
    expect(allowCountKey('Bash', { command: 'npm test' }, [deny, mode])).toBe('Bash(npm test:*)')
  })
})

describe('counter file', () => {
  it('is absent (undefined, never 0) until an allow is counted, then counts per key and per project', () => {
    expect(allowCountOf(dir, 'p1', 'Bash(npm test:*)')).toBeUndefined()
    expect(bumpAllowCount(dir, 'p1', 'Bash(npm test:*)')).toBe(1)
    expect(bumpAllowCount(dir, 'p1', 'Bash(npm test:*)')).toBe(2)
    expect(bumpAllowCount(dir, 'p1', 'Bash(git status:*)')).toBe(1)
    expect(allowCountOf(dir, 'p1', 'Bash(npm test:*)')).toBe(2)
    expect(allowCountOf(dir, 'p1', 'Bash(git status:*)')).toBe(1)
    expect(allowCountOf(dir, 'p2', 'Bash(npm test:*)')).toBeUndefined()
  })

  it('persists in the project data folder as plain JSON, atomically (no temp files left), and survives a re-read', () => {
    bumpAllowCount(dir, 'p1', 'Read')
    bumpAllowCount(dir, 'p1', 'Read')
    const file = allowCountFile(dir, 'p1')
    expect(file).toBe(join(dir, 'projects', 'p1', 'allow-counts.json'))
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ v: 1, entries: [['Read', 2]] })
    expect(readdirSync(dirname(file))).toEqual(['allow-counts.json'])
    expect([...readAllowCounts(dir, 'p1')]).toEqual([['Read', 2]])
  })

  it('is removed with the project data', () => {
    bumpAllowCount(dir, 'p1', 'Read')
    removeProjectData(dir, 'p1')
    expect(existsSync(allowCountFile(dir, 'p1'))).toBe(false)
    expect(allowCountOf(dir, 'p1', 'Read')).toBeUndefined()
  })

  it('keeps at most 500 keys and drops the least recently allowed', () => {
    for (let i = 0; i < ALLOW_COUNT_KEYS_MAX; i++) bumpAllowCount(dir, 'p1', `Bash(k${i}:*)`)
    expect(readAllowCounts(dir, 'p1').size).toBe(ALLOW_COUNT_KEYS_MAX)
    // k0 is the oldest; allowing it again makes k1 the oldest
    bumpAllowCount(dir, 'p1', 'Bash(k0:*)')
    bumpAllowCount(dir, 'p1', 'Bash(new:*)')
    const counts = readAllowCounts(dir, 'p1')
    expect(counts.size).toBe(ALLOW_COUNT_KEYS_MAX)
    expect(counts.has('Bash(k1:*)')).toBe(false)
    expect(counts.get('Bash(k0:*)')).toBe(2)
    expect(counts.get('Bash(new:*)')).toBe(1)
    expect([...counts.keys()].at(-1)).toBe('Bash(new:*)')
  })

  it('caps a count at 9999', () => {
    const file = allowCountFile(dir, 'p1')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ v: 1, entries: [['Read', 9998], ['Glob', 50000]] }))
    expect(allowCountOf(dir, 'p1', 'Glob')).toBe(ALLOW_COUNT_MAX)
    expect(bumpAllowCount(dir, 'p1', 'Read')).toBe(9999)
    expect(bumpAllowCount(dir, 'p1', 'Read')).toBe(ALLOW_COUNT_MAX)
  })

  it('is cleaned on read: junk, bad counts, long keys, duplicates and too many entries', () => {
    const file = allowCountFile(dir, 'p1')
    mkdirSync(dirname(file), { recursive: true })
    const many = Array.from({ length: ALLOW_COUNT_KEYS_MAX + 20 }, (_, i) => [`K${i}`, 1])
    writeFileSync(
      file,
      JSON.stringify({
        v: 1,
        entries: [['a', 0], ['b', -3], ['c', 'x'], ['', 4], [7, 4], ['d'], 'e', null, ['long'.padEnd(ALLOW_COUNT_KEY_MAX_CHARS + 1, 'x'), 2], ['dup', 1], ['dup', 5], ['frac', 2.9], ['inf', Infinity], ...many]
      })
    )
    const counts = readAllowCounts(dir, 'p1')
    expect(counts.size).toBe(ALLOW_COUNT_KEYS_MAX)
    for (const bad of ['a', 'b', 'c', '', 'd', 'e', 'inf']) expect(counts.has(bad)).toBe(false)
    // the 500 most recent survive: the early valid ones (dup, frac) were pushed out by the many
    expect(counts.has('K519')).toBe(true)
    expect(counts.has('K0')).toBe(false)
    expect([...counts.values()].every((n) => Number.isInteger(n) && n >= 1 && n <= ALLOW_COUNT_MAX)).toBe(true)
  })

  it('reads a damaged, wrong-shaped or oversized file as nothing, and the next allow starts over', () => {
    const file = allowCountFile(dir, 'p1')
    mkdirSync(dirname(file), { recursive: true })
    for (const text of ['{not json', '[]', 'null', '{"entries":"x"}', '"x"', '']) {
      writeFileSync(file, text)
      expect(readAllowCounts(dir, 'p1').size).toBe(0)
    }
    writeFileSync(file, JSON.stringify({ v: 1, entries: [['Read', 1]], pad: 'x'.repeat(600 * 1024) }))
    expect(readAllowCounts(dir, 'p1').size).toBe(0)
    expect(bumpAllowCount(dir, 'p1', 'Read')).toBe(1)
  })

  it('refuses an unsafe project id, an empty data folder and an uncountable key without throwing', () => {
    expect(bumpAllowCount(dir, '../escape', 'Read')).toBeUndefined()
    expect(bumpAllowCount('', 'p1', 'Read')).toBeUndefined()
    expect(bumpAllowCount(dir, 'p1', '')).toBeUndefined()
    expect(bumpAllowCount(dir, 'p1', 'x'.repeat(ALLOW_COUNT_KEY_MAX_CHARS + 1))).toBeUndefined()
    expect(readAllowCounts(dir, '../escape').size).toBe(0)
    expect(existsSync(join(dir, 'escape'))).toBe(false)
  })

  it('returns plain structured-clone safe values', () => {
    bumpAllowCount(dir, 'p1', 'Read')
    expect(structuredClone([...readAllowCounts(dir, 'p1')])).toEqual([['Read', 1]])
  })
})
