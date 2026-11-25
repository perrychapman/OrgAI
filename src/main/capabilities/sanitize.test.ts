import { describe, expect, it } from 'vitest'
import { sanitizeArgs, isCredentialArg, capabilityId, clampText, hiddenCharIn, hiddenCharProblem, displayPath, isKeyLikeArg, isKeyLikeValue, isSecretFlag, isSecretName, redactCredentialWords, scrubLocalPaths, scrubUrl, validKeyName, MCP_TARGET_MAX, mcpSpecDigest, reviewTarget } from './sanitize'

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
    // Unicode line and paragraph separators end a line: refused on one line, allowed like LF in multi-line fields and prose.
    const [ls, ps] = [String.fromCodePoint(0x2028), String.fromCodePoint(0x2029)]
    expect(hiddenCharIn(`a${ls}b`)).toBe('U+2028')
    expect(hiddenCharIn(`a${ps}b`)).toBe('U+2029')
    expect(hiddenCharIn(`a${ls}${ps}b`, { multiline: true })).toBeNull()
    expect(hiddenCharIn(`a${ls}${ps}b`, { prose: true })).toBeNull()
    expect(clampText(`a${ls}b${ps}c`)).toBe('a b c')
    // Prose keeps emoji and Persian joiners and soft hyphens, refuses bidi, zero-width space and controls.
    expect(hiddenCharIn('\u{1F469}‍\u{1F4BB} می‌ co­op\n\t', { prose: true })).toBeNull()
    expect(hiddenCharIn('a‮b', { prose: true })).toBe('U+202E')
    expect(hiddenCharIn('a​b', { prose: true })).toBe('U+200B')
    expect(hiddenCharIn('a⁧b', { prose: true })).toBe('U+2067')
    expect(hiddenCharIn('a\u0007b', { prose: true })).toBe('U+0007')
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

describe('scrubLocalPaths', () => {
  it('replaces drive, home-relative and rooted paths and a URL host, and leaves ordinary text and rules alone', () => {
    expect(scrubLocalPaths('Read(C:\\Users\\a\\x.txt) and Read(~/proj/y) and Bash(node /opt/t.js)')).toBe('Read([path]) and Read([path]) and Bash(node [path])')
    expect(scrubLocalPaths('Read(//c/work/**)')).toBe('Read([path])')
    expect(scrubLocalPaths('fetched https://host.example/p')).toBe('fetched https:[path]')
    expect(scrubLocalPaths('Bash(npm run build:*) and WebFetch(domain:github.com) v1.2.3 node.js')).toBe('Bash(npm run build:*) and WebFetch(domain:github.com) v1.2.3 node.js')
    expect(scrubLocalPaths(undefined as unknown as string)).toBe('')
  })

  it('removes a path whose folder names hold spaces whole, with no fragment left', () => {
    expect(scrubLocalPaths('C:\\Users\\chapp\\OneDrive - Acme Corp\\Clients\\X')).toBe('[path]')
    expect(scrubLocalPaths('C:\\Users\\John Smith\\Documents\\x.txt')).toBe('[path]')
    expect(scrubLocalPaths('D:\\Client Work\\Acme')).toBe('[path]')
    for (const out of [
      scrubLocalPaths('Read(C:\\Users\\chapp\\OneDrive - Acme Corp\\Clients\\X\\plan.md)'),
      scrubLocalPaths('Read(D:\\Client Work\\Acme\\notes.txt) and Read(~/My Stuff/Acme Corp/x.txt)'),
      scrubLocalPaths('looked for a connection (C:\\Users\\John Smith\\Acme Corp)')
    ]) {
      expect(out).not.toMatch(/Acme|Smith|Client|Work|OneDrive|Corp/)
    }
    expect(scrubLocalPaths('Read(D:\\Client Work\\Acme\\notes.txt) and Read(~/My Stuff/Acme Corp/x.txt)')).toBe('Read([path]) and Read([path])')
    expect(scrubLocalPaths('Read(\\\\fileserver\\Team Share\\Acme\\x) and Read(\\\\?\\C:\\Big Folder\\y) and Read(file:///C:/Big Folder/y)')).toBe('Read([path]) and Read([path]) and Read(file:[path])')
  })

  it('removes relative paths, `..` paths and any word that holds a separator', () => {
    expect(scrubLocalPaths('Read(secrets/prod.env)')).toBe('Read([path])')
    expect(scrubLocalPaths('Read(..\\..\\x)')).toBe('Read([path])')
    expect(scrubLocalPaths('Bash(cat secrets/prod.env)')).toBe('Bash(cat [path])')
    // Adjacent removed words collapse into one token.
    expect(scrubLocalPaths('Bash(cat a\\b.txt c/d.txt)')).toBe('Bash(cat [path])')
    // The stated rule: a word holding / or \ is removed ("and/or", "read/write" too); "v1.2.3" and "node.js" are not.
    expect(scrubLocalPaths('read/write')).toBe('[path]')
    expect(scrubLocalPaths('and/or read/write v1.2.3 node.js')).toBe('[path] v1.2.3 node.js')
  })

  it('removes user@host, IPv4 and IPv6 literals and private host names', () => {
    expect(scrubLocalPaths('Bash(ssh admin@db.internal)')).toBe('Bash(ssh [host])')
    expect(scrubLocalPaths('mail me@example.com')).toBe('mail [host]')
    expect(scrubLocalPaths('WebFetch(domain:db.internal) and nas.home and git.corp.example')).toBe('WebFetch(domain:[host]) and [host] and [host]')
    expect(scrubLocalPaths('open github.com and example.org/x.local')).toBe('open github.com and [path]')
    expect(scrubLocalPaths('Bash(curl 10.0.0.5:8080)')).toBe('Bash(curl [host]:8080)')
    expect(scrubLocalPaths('ping 192.168.1.20 and 2001:db8::1 and ::1 and fe80:0:0:0:1:2:3:4')).toBe('ping [host] and [host] and [host] and [host]')
    expect(scrubLocalPaths('host DB-01.Intranet, printer.lan; x.local')).toBe('host [host], [host]; [host]')
    // Over-removal, by design: anything shaped name@name goes, a package pin included.
    expect(scrubLocalPaths('npm i left-pad@1.2.3')).toBe('npm i [host]')
    expect(scrubLocalPaths('Bash(npm run build:*) WebFetch(domain:github.com)')).toBe('Bash(npm run build:*) WebFetch(domain:github.com)')
  })

  it('keeps a bare ~ and a bare host name (residue, stated)', () => {
    expect(scrubLocalPaths('~ and db01')).toBe('~ and db01')
  })
})

describe('redactCredentialWords', () => {
  it('removes URL userinfo of any scheme and keeps the rest of the address', () => {
    expect(redactCredentialWords('git clone https://user:pass@host.example/repo.git')).toBe('git clone https://host.example/repo.git')
    expect(redactCredentialWords('Bash(psql postgres://admin:hunter2@db:5432/app)')).toBe('Bash(psql postgres://db:5432/app)')
    expect(redactCredentialWords('fetch https://example.com/@scope/pkg')).toBe('fetch https://example.com/@scope/pkg')
  })

  it('drops the value after a credential flag: next word, quoted run, glued or inline', () => {
    expect(redactCredentialWords('Bash(curl -u user:pass https://x.example)')).toBe('Bash(curl -u [redacted] https://x.example)')
    expect(redactCredentialWords('Bash(curl -uuser:pass https://x.example)')).toBe('Bash(curl -u[redacted] https://x.example)')
    expect(redactCredentialWords('Bash(mysql --password secret db)')).toBe('Bash(mysql --password [redacted] db)')
    expect(redactCredentialWords('Bash(mysql --password "my pass word" db)')).toBe('Bash(mysql --password "[redacted]" db)')
    expect(redactCredentialWords('Bash(tool --token ab --api-key x1 --auth foo --bearer bar)')).toBe('Bash(tool --token [redacted] --api-key [redacted] --auth [redacted] --bearer [redacted])')
    expect(redactCredentialWords('tool --token=ab --password=xy -u=me:pw')).toBe('tool --token=[redacted] --password=[redacted] -u=[redacted]')
    expect(redactCredentialWords('Bash(curl --user me:pw -X POST)')).toBe('Bash(curl --user [redacted] -X POST)')
    // A flag followed by another flag has no value to drop.
    expect(redactCredentialWords('tool --token --verbose')).toBe('tool --token --verbose')
  })

  it('drops header values, quoted or not, and Authorization headers', () => {
    expect(redactCredentialWords('Bash(curl --header "Authorization: Bearer abc.def" https://x.example)')).toBe('Bash(curl --header "[redacted]" https://x.example)')
    expect(redactCredentialWords("Bash(curl -H 'X-Api-Key: zzz' x)")).toBe('Bash(curl -H \'[redacted]\' x)')
    expect(redactCredentialWords('curl --header Authorization: Bearer abc123 https://x')).toBe('curl --header [redacted] https://x')
    expect(redactCredentialWords('curl --header Authorization: Basic dXNlcjpwdw== https://x')).toBe('curl --header [redacted] https://x')
    expect(redactCredentialWords('sent Authorization: Basic dXNlcjpwdw== ok')).toBe('sent Authorization: [redacted] ok')
    expect(redactCredentialWords('curl --header=Foo:bar x')).toBe('curl --header=[redacted] x')
  })

  it('masks KEY=value pairs whose name says secret, and bare key-like words', () => {
    expect(redactCredentialWords('Bash(DB_PASSWORD=hunter2 npm test)')).toBe('Bash(DB_PASSWORD=[redacted] npm test)')
    expect(redactCredentialWords('export GITHUB_TOKEN=abc')).toBe('export GITHUB_TOKEN=[redacted]')
    expect(redactCredentialWords('use sk-abcdef123456 now')).toBe('use [redacted] now')
    expect(redactCredentialWords('jwt eyJhbGciOiJI.eyJzdWIiOiIx.abcdefghij1 ok')).toBe('jwt [redacted] ok')
  })

  it('leaves ordinary text alone and is idempotent', () => {
    for (const t of ['Bash(npm run build:*) and Read(src/**)', 'denied Bash(git status) -x -h --verbose', 'name=value other=thing']) expect(redactCredentialWords(t)).toBe(t)
    for (const t of ['curl -u me:pw --password x --header "A: b"', 'Bash(curl --header Authorization: Bearer abc https://u:p@h/x)']) {
      const once = redactCredentialWords(t)
      expect(redactCredentialWords(once)).toBe(once)
    }
  })

  it('never throws on odd input', () => {
    for (const t of ['', ' ', '--password', '-u', '--header "unclosed', '"""', undefined as unknown as string, '--token=']) expect(() => redactCredentialWords(t)).not.toThrow()
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
  it('stays linear on hostile long input', () => {
    const start = Date.now()
    for (const s of ['a'.repeat(300_000), `${'a'.repeat(100_000)}://${'b'.repeat(100_000)}`, 'x://'.repeat(50_000), `a:${'/'.repeat(100_000)}`, `${'a='.repeat(50_000)}@@@@`]) isCredentialArg(s)
    expect(Date.now() - start).toBeLessThan(2000)
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
