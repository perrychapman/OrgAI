import { describe, expect, it } from 'vitest'
import { sanitizeArgs, isCredentialArg, capabilityId, clampText, hiddenCharIn, hiddenCharProblem, displayPath, isKeyLikeArg, isKeyLikeValue, isSecretFlag, isSecretName, scrubUrl, validKeyName, MCP_TARGET_MAX, mcpSpecDigest, reviewTarget } from './sanitize'

describe('hiddenCharIn / hiddenCharProblem', () => {
  it('finds bidi, zero-width and control characters; multi-line fields allow tab and line breaks', () => {
    expect(hiddenCharIn('a‮b')).toBe('U+202E')
    expect(hiddenCharIn('a​b')).toBe('U+200B')
    expect(hiddenCharIn('tag\u{e0041}')).toBe('U+E0041')
    expect(hiddenCharIn('a\tb')).toBe('U+0009')
    expect(hiddenCharIn('a\tb\r\nc', { multiline: true })).toBeNull()
    expect(hiddenCharIn('a\u0007b', { multiline: true })).toBe('U+0007')
    expect(hiddenCharIn('plain')).toBeNull()
    expect(hiddenCharIn(42)).toBeNull()
    expect(hiddenCharProblem('The URL', 'x‮')).toBe('The URL contains a hidden character (U+202E, a control, zero-width, bidi or other invisible character); remove it.')
    expect(hiddenCharProblem('The URL', 'x')).toBeNull()
  })
})

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

describe('scrubUrl long segments', () => {
  it('redacts 20+ char letter-digit segments and keeps short ones', () => {
    expect(scrubUrl('https://h.example/mcp/a1b2c3d4e5f6g7h8i9j0k1/v2')).toBe('https://h.example/mcp/[redacted]/v2')
    expect(scrubUrl('https://h.example/some-long-readable-segment-name/x')).toBe('https://h.example/some-long-readable-segment-name/x')
  })
})

describe('sanitizeArgs', () => {
  it('recognises credential args', () => {
    expect(isCredentialArg('mysql://u:p@h/db')).toBe(true)
    expect(isCredentialArg('--db=postgres://u:p@h')).toBe(true)
    expect(isCredentialArg('token abcdef1')).toBe(true)
    expect(isCredentialArg('Authorization=x')).toBe(true)
    expect(isCredentialArg('https://h.example/path')).toBe(false)
  })
  it('drops secret flags with their value and names them without values', () => {
    const r = sanitizeArgs(['run', '--header=Foo: SECRETV', '-H', 'SECRETV2', '--keep'])
    expect(r.kept).toEqual(['run', '--keep'])
    expect(r.dropped).toBe(3)
    expect(r.notes.join(' ')).toContain('--header')
    expect(r.notes.join(' ')).not.toContain('SECRET')
  })
})

describe('reviewTarget and mcpSpecDigest', () => {
  const base = { id: '', name: 'x', transport: 'stdio' as const, enabled: true, source: 'local' as const, addedAt: '', command: 'npx', args: ['-y', 'pkg@1.0.0'] }

  it('reviewTarget is the whole command up to MCP_TARGET_MAX and blocks anything longer', () => {
    expect(reviewTarget(base)).toEqual({ target: 'npx -y pkg@1.0.0' })
    const at = reviewTarget({ ...base, args: ['x'.repeat(MCP_TARGET_MAX - 4)] })
    expect(at.target.length).toBe(MCP_TARGET_MAX)
    expect(at.blockedReason).toBeUndefined()
    expect(reviewTarget({ ...base, args: ['x'.repeat(MCP_TARGET_MAX)] }).blockedReason).toBe('Command too long to review')
    expect(reviewTarget({ transport: 'http', url: `https://h.example/${'p'.repeat(400)}` }).blockedReason).toBe('Address too long to review')
    expect(reviewTarget({ ...base, args: ['a\nb'] }).blockedReason).toMatch(/hidden or control/)
  })

  it('mcpSpecDigest changes with the args tail, the URL and the secret slots', () => {
    const d = mcpSpecDigest(base)
    expect(mcpSpecDigest({ ...base })).toBe(d)
    expect(mcpSpecDigest({ ...base, args: ['-y', 'pkg@1.0.1'] })).not.toBe(d)
    expect(mcpSpecDigest({ ...base, args: ['-y', 'pkg@1.0.0', '--extra'] })).not.toBe(d)
    expect(mcpSpecDigest({ ...base, secretEnv: ['TOKEN'] })).not.toBe(d)
    expect(mcpSpecDigest({ ...base, secretHeaders: ['Authorization'] })).not.toBe(d)
    expect(mcpSpecDigest({ ...base, env: { MODE: 'fast' } })).not.toBe(d)
    expect(mcpSpecDigest({ ...base, transport: 'http', url: 'https://a.example/mcp' })).not.toBe(mcpSpecDigest({ ...base, transport: 'http', url: 'https://b.example/mcp' }))
    // Order of slot names does not matter.
    expect(mcpSpecDigest({ ...base, secretEnv: ['A', 'B'] })).toBe(mcpSpecDigest({ ...base, secretEnv: ['B', 'A'] }))
  })
})

describe('reviewTarget follow-up', () => {
  it('quotes a command with spaces so it cannot pass for command plus args', () => {
    expect(reviewTarget({ transport: 'stdio', command: 'node --require x', args: [] }).target).toBe('"node --require x"')
    expect(reviewTarget({ transport: 'stdio', command: 'C:/Program Files/x.exe', args: ['--a'] }).target).toBe('"C:/Program Files/x.exe" --a')
  })

  it('blocks every invisible character range, and clampText strips them', () => {
    for (const ch of ['\u00ad', '\u034f', '\u061c', '\u115f', '\u180e', '\u2060', '\u2064', '\u3164', '\ufeff', '\u{e0001}', '\u{e007f}']) {
      expect(reviewTarget({ transport: 'stdio', command: 'npx', args: [`a${ch}b`] }).blockedReason).toMatch(/hidden or control/)
      expect(clampText(`a${ch}b`)).toBe('a b')
    }
  })

  it('shows headers of a remote and env of a command', () => {
    expect(reviewTarget({ transport: 'http', url: 'https://h.example/mcp', headers: { 'X-Mode': 'ro' } }).target).toBe('https://h.example/mcp -H "X-Mode: ro"')
    expect(reviewTarget({ transport: 'stdio', command: 'npx', args: ['p'], env: { B: '2', A: '1' } }).target).toBe('A=1 B=2 npx p')
  })
})
