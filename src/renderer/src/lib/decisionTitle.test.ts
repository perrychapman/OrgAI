import { describe, expect, it } from 'vitest'
import { baseName, installTitle, mergeTitle, oneLine, permissionTitle, proposalTitle, questionTitle, rulesTitle } from './decisionTitle'

describe('decisionTitle', () => {
  it('names the action for a shell command and uses the first line', () => {
    expect(permissionTitle('Bash', { command: 'npm test\nrm -rf x' })).toBe('Run npm test')
    expect(permissionTitle('Bash', {})).toBe('Run a shell command')
  })
  it('uses the file name for edits, writes and reads', () => {
    expect(permissionTitle('Edit', { file_path: 'C:\\repo\\src\\server.js' })).toBe('Edit server.js')
    expect(permissionTitle('Write', { file_path: '/a/b/notes.md' })).toBe('Write notes.md')
    expect(permissionTitle('Read', { file_path: '/a/b.ts' })).toBe('Read b.ts')
    expect(permissionTitle('Edit', null)).toBe('Use Edit')
  })
  it('falls back for other tools and odd input', () => {
    expect(permissionTitle('Glob', 'x')).toBe('Use Glob')
    expect(permissionTitle('WebFetch', { url: 'https://example.com/a?b' })).toBe('Fetch example.com')
  })
  it('flattens control and bidi characters and clips', () => {
    expect(oneLine('a\u202Eb\tc\nd')).toBe('a b c d')
    expect(oneLine('x'.repeat(300)).length).toBe(120)
    expect(baseName('a\\b/c.txt')).toBe('c.txt')
  })
  it('clips at exactly 120 characters with an ellipsis and strips isolates', () => {
    expect(oneLine('y'.repeat(120))).toBe('y'.repeat(120))
    expect(oneLine('y'.repeat(121))).toBe(`${'y'.repeat(119)}…`)
    expect(oneLine('a⁦b⁩c‪d')).toBe('a b c d')
    expect(oneLine(42)).toBe('')
    expect(permissionTitle('Bash', { command: 'echo ‮hi\nsecond' })).toBe('Run echo hi')
  })
  it('builds the other kinds', () => {
    expect(questionTitle('Which db?')).toBe('Answer: Which db?')
    expect(rulesTitle(['Bash(npm test:*)'])).toBe('Allow Bash(npm test:*)')
    expect(rulesTitle(['a', 'b'])).toBe('Allow 2 rules')
    expect(proposalTitle('Architecture')).toBe('Approve architecture proposal')
    expect(mergeTitle('engineer-1')).toBe("Merge engineer-1's changes")
    expect(installTitle('docs')).toBe('Install docs')
  })
})
