import { describe, expect, it } from 'vitest'
import { capabilityId, clampText, displayPath, isKeyLikeArg, isKeyLikeValue, isSecretFlag, isSecretName, scrubUrl, validKeyName } from './sanitize'

describe('clampText', () => {
  it('removes controls and bidi characters, collapses whitespace and clamps', () => {
    expect(clampText('a\u0000b\n\tc\u202ed  e')).toBe('a b c d e')
    expect(clampText('x'.repeat(50), 10)).toBe('xxxxxxxxx…')
    expect(clampText(42)).toBe('')
    expect(clampText(undefined)).toBe('')
  })
})

describe('scrubUrl', () => {
  it('keeps origin and path only', () => {
    expect(scrubUrl('https://u:p@h.example:8443/a/b?api_key=1#f')).toBe('https://h.example:8443/a/b')
  })
  it('refuses other schemes, junk and long input', () => {
    expect(scrubUrl('file:///etc/passwd')).toBeNull()
    expect(scrubUrl('javascript:alert(1)')).toBeNull()
    expect(scrubUrl('nope')).toBeNull()
    expect(scrubUrl(5)).toBeNull()
    expect(scrubUrl('https://h.example/' + 'a'.repeat(3000))).toBeNull()
  })
  it('redacts key-like path segments', () => {
    expect(scrubUrl('https://h.example/mcp/sk-abcdef123456')).toBe('https://h.example/mcp/[redacted]')
  })
})

describe('key detection', () => {
  it('recognizes key-like values', () => {
    for (const v of ['sk-ant-abc123456789', 'ghp_' + 'a'.repeat(30), 'github_pat_' + 'A'.repeat(30), 'xoxb-1234567890-abc', 'Bearer abcdefgh', 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abcdefghij', 'a1'.repeat(20)]) expect(isKeyLikeValue(v)).toBe(true)
    for (const v of ['short', '@scope/pkg@1.2.3', 'server.js', '--verbose', '/usr/local/bin/some/long/path/name12345678901234']) expect(isKeyLikeValue(v)).toBe(false)
  })
  it('flags key-like args and secret flags', () => {
    expect(isKeyLikeArg('--token=abc')).toBe(true)
    expect(isKeyLikeArg('API_KEY=value')).toBe(true)
    expect(isKeyLikeArg('--port=3000')).toBe(false)
    expect(isKeyLikeArg('pkg@1.0.0')).toBe(false)
    expect(isSecretFlag('--api-key')).toBe(true)
    expect(isSecretFlag('--token')).toBe(true)
    expect(isSecretFlag('-y')).toBe(false)
    expect(isSecretFlag('--port')).toBe(false)
    expect(isSecretName('GITHUB_TOKEN')).toBe(true)
    expect(isSecretName('PORT')).toBe(false)
  })
  it('validates slot names', () => {
    expect(validKeyName('X-Api-Key')).toBe(true)
    expect(validKeyName('A=B')).toBe(false)
    expect(validKeyName('a b')).toBe(false)
    expect(validKeyName('a'.repeat(129))).toBe(false)
    expect(validKeyName(3)).toBe(false)
  })
})

describe('displayPath and capabilityId', () => {
  it('shortens the home and uses slashes', () => {
    const home = process.platform === 'win32' ? 'C:\\Users\\me' : '/home/me'
    const sep = process.platform === 'win32' ? '\\' : '/'
    expect(displayPath(`${home}${sep}.claude${sep}skills`, home)).toBe('~/.claude/skills')
    expect(displayPath(home, home)).toBe('~')
  })
  it('makes stable distinct ids', () => {
    const a = capabilityId('local', 'mcp', 'k', 'n')
    expect(a).toMatch(/^cap-[0-9a-f]{24}$/)
    expect(capabilityId('local', 'mcp', 'k', 'n')).toBe(a)
    expect(capabilityId('repo', 'mcp', 'k', 'n')).not.toBe(a)
    expect(capabilityId('local', 'skill', 'k', 'n')).not.toBe(a)
  })
})
