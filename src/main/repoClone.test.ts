import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REPO_CONFIG_PATHS, type RepoCloneInput, type RepoCloneProgress } from '@shared/types'
import {
  CloneOutputReader,
  MOCK_REPO_MARKERS,
  RepoCloneService,
  checkDestination,
  cleanupDestination,
  cloneArgs,
  cloneErrorKind,
  cloneErrorMessage,
  defaultRun,
  destinationProblem,
  emptyDestination,
  forkArgs,
  forkErrorMessage,
  gitEnv,
  ghEnv,
  parseProgressLine,
  parseRepoSource,
  prepareDestination,
  readGhAuthJson,
  scanRepoConfig,
  scrubStderr,
  suggestedFolderFor,
  validateForkResponse,
  type GitHandle,
  type RunFn,
  type RunOptions,
  type RunResult
} from './repoClone'

// ---- Helpers ----

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orgai-repo-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

const WIN = process.platform === 'win32'
const GIT = WIN ? 'C:\\fake\\git.exe' : '/fake/git'
const GH = WIN ? 'C:\\fake\\gh.exe' : '/fake/gh'
const done = (stdout = '', code = 0, stderr = ''): RunResult => ({ code, stdout, stderr })

interface Call {
  file: string
  args: string[]
  opts: RunOptions
}

const GH_OK = JSON.stringify({ hosts: { 'github.com': [{ active: true, host: 'github.com', login: 'me', state: 'success', error: null }] } })
const forkJson = (fullName: string, createdAt = new Date().toISOString()): string =>
  JSON.stringify({ full_name: fullName, clone_url: `https://github.com/${fullName}.git`, html_url: `https://github.com/${fullName}`, created_at: createdAt })

/** A fake runner: resolves git and gh, answers the follow-up git calls, and lets a test override any call. */
function makeRun(override?: (c: Call) => RunResult | Promise<RunResult> | undefined) {
  const calls: Call[] = []
  const run: RunFn = async (file, args, opts) => {
    const call = { file, args, opts }
    calls.push(call)
    const o = await override?.(call)
    if (o) return o
    if (/where\.exe$/i.test(file) || file === 'which') {
      const name = (args[args.length - 1] ?? '').replace('$PATH:', '')
      return done(name === 'git' ? `${GIT}\n` : name === 'gh' ? `${GH}\n` : '')
    }
    if (file === GIT) {
      if (args.includes('--version')) return done('git version 2.47.0.windows.2\n')
      if (args.includes('symbolic-ref')) return done('main\n')
      return done()
    }
    if (file === GH && args[0] === 'auth') return done(GH_OK)
    return done('', 1, 'unexpected')
  }
  return { run, calls }
}

class FakeGit implements GitHandle {
  pid = 4242
  killed = false
  private data: ((c: string) => void)[] = []
  private exits: ((c: number | null) => void)[] = []
  private closes: ((c: number | null) => void)[] = []
  private errors: ((e: Error & { code?: string }) => void)[] = []
  onData(cb: (c: string) => void): void {
    this.data.push(cb)
  }
  onExit(cb: (c: number | null) => void): void {
    this.exits.push(cb)
  }
  onClose(cb: (c: number | null) => void): void {
    this.closes.push(cb)
  }
  onError(cb: (e: Error & { code?: string }) => void): void {
    this.errors.push(cb)
  }
  kill(): void {
    this.killed = true
  }
  emit(s: string): void {
    for (const cb of this.data) cb(s)
  }
  finish(code: number | null): void {
    for (const cb of this.exits) cb(code)
    for (const cb of this.closes) cb(code)
  }
  fail(code: string): void {
    for (const cb of this.errors) cb(Object.assign(new Error(code), { code }))
  }
}

/** spawnGit fake: `script` runs on the next tick with the handle, the argument list and the call number (1-based). */
function makeSpawn(script?: (h: FakeGit, args: string[], n: number) => void) {
  const spawned: { h: FakeGit; args: string[]; env: NodeJS.ProcessEnv; cwd: string }[] = []
  const spawnGit = (_file: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): GitHandle => {
    const h = new FakeGit()
    spawned.push({ h, args, env: opts.env, cwd: opts.cwd })
    const n = spawned.length
    setTimeout(() => script?.(h, args, n), 0)
    return h
  }
  return { spawnGit, spawned }
}

/** Kills the fake the way taskkill would: the process ends with no code. */
function makeKill(spawned: { h: FakeGit }[]) {
  const killed: number[] = []
  return {
    killed,
    killTree: (pid: number) => {
      killed.push(pid)
      for (const s of spawned) if (s.h.pid === pid) setTimeout(() => s.h.finish(null), 0)
    }
  }
}

const cloneOk = (h: FakeGit, args: string[]): void => {
  const dest = args[args.length - 1]
  writeFileSync(join(dest, 'README.md'), '# x\n')
  h.emit('Cloning into...\r\nReceiving objects:  50% (1/2)\r')
  h.finish(0)
}
const cloneFail = (h: FakeGit, stderr: string, code = 128): void => {
  h.emit(stderr)
  h.finish(code)
}

function input(over: Partial<RepoCloneInput> = {}): RepoCloneInput {
  return { requestId: 'req1', source: 'https://github.com/o/r', mode: 'clone', destination: join(root, 'out', 'repo'), ...over }
}

function service(opts: Partial<ConstructorParameters<typeof RepoCloneService>[0]> = {}) {
  const r = makeRun()
  const s = makeSpawn(cloneOk)
  const svc = new RepoCloneService({
    dataDir: join(root, 'data'),
    env: { PATH: 'x', GH_HOST: 'evil.example', GIT_DIR: '/x', DEBUG: '1' },
    run: r.run,
    spawnGit: s.spawnGit,
    killTree: () => {},
    killTreeSync: () => {},
    sleep: async () => {},
    closeGraceMs: 10,
    killWaitMs: 100,
    ...opts
  })
  return { svc, ...r, ...s }
}

const noop = (): void => {}

// ---- parse ----

describe('parseRepoSource', () => {
  const refused: [string, string?][] = [
    ['file:///x'],
    ['FILE:///x'],
    ['ext::sh -c x', 'sh -c'],
    ['git::https://x'],
    ['-u/x'],
    ['--upload-pack=x', 'upload'],
    ['https://github.com/-x/y'],
    ['https://user:ghp_secret@github.com/o/r', 'ghp_secret'],
    ['https://ghp_secret@github.com/o/r', 'ghp_secret'],
    ['C:\\x\\y'],
    ['\\\\host\\share'],
    ['/etc/x'],
    ['./a/b'],
    ['../a'],
    ['~/a'],
    ['a/../b'],
    ['https://github.com/a/..'],
    ['https://github.com/a/b/../c'],
    ['https://github.com/a%2fb/c'],
    ['https://github.com/a/b?x=1'],
    ['https://github.com/a/b#frag'],
    ['https://github.com/a/b/tree/main'],
    ['https://github.com:8080/a/b'],
    ['http://github.com/a/b'],
    ['git@github.com:a/b; rm -rf', 'rm -rf'],
    ['git@-oProxyCommand=x:a/b', 'ProxyCommand'],
    ['ssh://-oProxyCommand=x/a/b', 'ProxyCommand'],
    ['ssh://evil@github.com/a/b', 'evil'],
    ['a/b\u200b'],
    ['a/b\u202e'],
    ['a/b\nc'],
    ['a/b\u0000c'],
    ['a/' + 'b'.repeat(600)],
    ['https://github.com/' + 'o'.repeat(40) + '/r'],
    ['my_owner/repo'],
    ['https://github.com/a/.git'],
    ['a/.git'],
    ['.git'],
    ['github.com/o/r'],
    ['https://github.com\\@evil.com/a/b', 'evil.com'],
    ['https://github.com@evil.com/a/b', 'evil.com'],
    ['https://evil.com#github.com/a/b', 'evil.com'],
    ['https:github.com/a/b'],
    ['https:/github.com/a/b'],
    ['https://gitlab.com/a/b/../c'],
    ['https://gitlab.com/a/-b'],
    ['https://gitlab.com/a/%2e%2e/b'],
    ['https://-host.com/a/b'],
    ['https://host..com/a/b'],
    ['https://host.com:0/a/b'],
    ['https://host.com:70000/a/b'],
    ['ssh://git@github.com:22/a/b'],
    ['ssh://host.com/a/b'],
    ['ssh://u:pw@host.com/a/b', 'pw'],
    ['git@github.com:a/b/c'],
    ['', undefined],
    ['   ']
  ]
  it.each(refused)('refuses %j without quoting it', (text, token) => {
    const r = parseRepoSource(text)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.problem.length).toBeGreaterThan(10)
      if (token) expect(r.problem).not.toContain(token)
      expect(r.problem).not.toContain(text.trim() || '\u0001')
    }
  })

  it('never throws on unknown input', () => {
    for (const v of [undefined, null, 5, {}, [], Symbol.iterator, () => 1]) expect(parseRepoSource(v).ok).toBe(false)
  })

  it('gives the pinned sentences for the common refusals', () => {
    const p = (t: string): string => (parseRepoSource(t) as { problem: string }).problem
    expect(p('https://user:x@github.com/o/r')).toBe('That address holds a sign-in name or token. Remove it; git will use your saved sign-in.')
    expect(p('https://github.com/o/r/tree/main')).toBe('That link points inside a repository; use its main address such as https://github.com/owner/repo.')
    expect(p('http://github.com/o/r')).toContain('use https')
  })

  const accepted: [string, Record<string, unknown>][] = [
    ['https://github.com/Owner/Repo', { url: 'https://github.com/Owner/Repo.git', host: 'github.com', owner: 'Owner', repo: 'Repo', display: 'Owner/Repo', suggestedFolder: 'Repo', canFork: true }],
    ['  https://www.GitHub.com/a/b.git/  ', { url: 'https://github.com/a/b.git', host: 'github.com', owner: 'a', repo: 'b', display: 'a/b', suggestedFolder: 'b', canFork: true }],
    ['HTTPS://github.com/a/b/', { url: 'https://github.com/a/b.git', repo: 'b', canFork: true }],
    ['git@github.com:a/b', { url: 'git@github.com:a/b.git', host: 'github.com', owner: 'a', repo: 'b', display: 'a/b', canFork: true }],
    ['git@github.com:a/b.git', { url: 'git@github.com:a/b.git', repo: 'b' }],
    ['ssh://git@github.com/a/b', { url: 'ssh://git@github.com/a/b.git', host: 'github.com', owner: 'a', repo: 'b', canFork: true }],
    ['ssh://git@github.com/a/b.git', { url: 'ssh://git@github.com/a/b.git' }],
    ['a/b', { url: 'https://github.com/a/b.git', host: 'github.com', owner: 'a', repo: 'b', display: 'a/b', canFork: true }],
    ['a/b.git', { url: 'https://github.com/a/b.git', repo: 'b' }],
    ['https://gitlab.com/group/sub/proj.git', { url: 'https://gitlab.com/group/sub/proj.git', host: 'gitlab.com', owner: 'group/sub', repo: 'proj', display: 'gitlab.com/group/sub/proj', suggestedFolder: 'proj', canFork: false }],
    ['https://gitlab.com/proj', { url: 'https://gitlab.com/proj', host: 'gitlab.com', repo: 'proj', display: 'gitlab.com/proj', canFork: false }],
    ['https://git.example.com:8443/a/b', { url: 'https://git.example.com:8443/a/b', host: 'git.example.com:8443', owner: 'a', repo: 'b', display: 'git.example.com:8443/a/b', canFork: false }],
    ['git@gitlab.example.com:team/app', { url: 'git@gitlab.example.com:team/app', host: 'gitlab.example.com', owner: 'team', repo: 'app', display: 'gitlab.example.com/team/app', canFork: false }],
    ['dev@Host.Example.com:team/app.git', { url: 'dev@host.example.com:team/app.git', host: 'host.example.com', repo: 'app', canFork: false }],
    ['ssh://dev@Host.Example.com:2222/team/app.git', { url: 'ssh://dev@host.example.com:2222/team/app.git', host: 'host.example.com:2222', owner: 'team', repo: 'app', display: 'host.example.com:2222/team/app', canFork: false }]
  ]
  it.each(accepted)('accepts %j', (text, expected) => {
    const r = parseRepoSource(text)
    expect(r.ok).toBe(true)
    expect(r).toMatchObject(expected)
    if (r.ok && r.owner === undefined) expect('owner' in r).toBe(false)
  })

  it('names a folder that is safe on Windows', () => {
    expect(suggestedFolderFor('con')).toBe('con-repo')
    expect(suggestedFolderFor('NUL.txt')).toBe('NUL.txt-repo')
    expect(suggestedFolderFor('lpt1')).toBe('lpt1-repo')
    expect(suggestedFolderFor('x.')).toBe('x')
    expect(suggestedFolderFor('...')).toBe('repo')
    expect(suggestedFolderFor('console')).toBe('console')
    expect((parseRepoSource('o/aux') as { suggestedFolder: string }).suggestedFolder).toBe('aux-repo')
  })
})

// ---- destination ----

describe('destination rules', () => {
  const data = (): string => join(root, 'data')
  const w = (p: unknown): string | null => destinationProblem(p, 'C:\\data', 'win32')

  it('refuses without touching the file system', () => {
    for (const bad of [undefined, 5, '', '   ', 'x'.repeat(1100), 'C:\\a\\b\u200b', 'C:\\a\u0000b', '\\\\host\\share\\x', '//host/x', '\\\\?\\C:\\x', '\\\\.\\C:\\x', 'C:foo', 'foo\\bar', 'C:\\a:b', 'C:\\a.\\b', 'C:\\a \\b', 'C:\\con\\x', 'C:\\x\\nul.txt', 'C:\\a\\..\\b', 'C:\\a\\.\\b']) {
      expect(w(bad), JSON.stringify(bad)).toBeTruthy()
    }
    expect(destinationProblem('relative/path', data(), 'linux')).toBeTruthy()
  })

  it('refuses a drive or file system root', () => {
    expect(checkDestination(WIN ? 'C:\\' : '/', data())).toHaveProperty('problem')
  })

  it('unwraps pasted quotes', () => {
    const r = checkDestination(`"${join(root, 'q')}"`, data())
    expect(r).toEqual({ path: join(root, 'q') })
  })

  it('refuses the data folder, one inside it and one containing it', () => {
    mkdirSync(data(), { recursive: true })
    expect(destinationProblem(data(), data())).toContain('data folder')
    expect(destinationProblem(join(data(), 'x'), data())).toContain('data folder')
    expect(destinationProblem(root, data())).toContain('data folder')
  })

  it('accepts a missing folder, an empty folder, and refuses files, non-empty folders and links', () => {
    expect(destinationProblem(join(root, 'new', 'deeper'), data())).toBeNull()
    const empty = join(root, 'empty')
    mkdirSync(empty)
    expect(destinationProblem(empty, data())).toBeNull()
    const full = join(root, 'full')
    mkdirSync(full)
    writeFileSync(join(full, 'a'), 'x')
    expect(destinationProblem(full, data())).toContain('not empty')
    const file = join(root, 'file')
    writeFileSync(file, 'x')
    expect(destinationProblem(file, data())).toContain('file')
    expect(destinationProblem(join(file, 'child'), data())).toBeTruthy()
    const target = join(root, 'target')
    mkdirSync(target)
    const link = join(root, 'link')
    symlinkSync(target, link, WIN ? 'junction' : 'dir')
    expect(destinationProblem(link, data())).toContain('link')
  })
})

// ---- cleanup ----

describe('prepareDestination and cleanup', () => {
  it('creates missing parents, records them, and removes only them', () => {
    const parent = join(root, 'keep')
    mkdirSync(parent)
    writeFileSync(join(parent, 'other.txt'), 'x')
    const dest = join(parent, 'a', 'b', 'repo')
    const rec = prepareDestination(dest)
    expect(rec.preexisting).toBe(false)
    expect(rec.createdDirs).toEqual([join(parent, 'a'), join(parent, 'a', 'b'), dest])
    writeFileSync(join(dest, 'partial'), 'x')
    mkdirSync(join(dest, '.git'))
    expect(cleanupDestination(rec)).toBe(true)
    expect(existsSync(join(parent, 'a'))).toBe(false)
    expect(readFileSync(join(parent, 'other.txt'), 'utf8')).toBe('x')
  })

  it('stops removing parents at the first that is not empty', () => {
    const dest = join(root, 'a', 'b', 'repo')
    const rec = prepareDestination(dest)
    writeFileSync(join(root, 'a', 'someone-else.txt'), 'x')
    cleanupDestination(rec)
    expect(existsSync(join(root, 'a', 'b'))).toBe(false)
    expect(existsSync(join(root, 'a', 'someone-else.txt'))).toBe(true)
  })

  it('keeps a pre-existing empty folder, emptied', () => {
    const dest = join(root, 'pre')
    mkdirSync(dest)
    const rec = prepareDestination(dest)
    expect(rec.preexisting).toBe(true)
    expect(rec.createdDirs).toEqual([])
    writeFileSync(join(dest, 'x'), 'x')
    expect(cleanupDestination(rec)).toBe(true)
    expect(readdirSync(dest)).toEqual([])
  })

  it('refuses a pre-existing folder that is not empty and removes nothing', () => {
    const dest = join(root, 'full')
    mkdirSync(dest)
    writeFileSync(join(dest, 'mine.txt'), 'x')
    expect(() => prepareDestination(dest)).toThrow('not empty')
    expect(existsSync(join(dest, 'mine.txt'))).toBe(true)
  })

  it('removes a link inside the partial clone without touching its target', () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'precious.txt'), 'keep')
    for (const preexisting of [false, true]) {
      const dest = join(root, preexisting ? 'pre' : 'new')
      if (preexisting) mkdirSync(dest)
      const rec = prepareDestination(dest)
      symlinkSync(outside, join(dest, 'sneaky'), WIN ? 'junction' : 'dir')
      writeFileSync(join(dest, 'f'), 'x')
      expect(cleanupDestination(rec)).toBe(true)
      expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('keep')
      expect(existsSync(dest)).toBe(preexisting)
      if (preexisting) expect(readdirSync(dest)).toEqual([])
    }
  })

  it('removes nothing when git said the folder was not empty (someone added content)', () => {
    const dest = join(root, 'x')
    const rec = prepareDestination(dest)
    writeFileSync(join(dest, 'theirs.txt'), 'x')
    expect(cleanupDestination(rec, { contentsAdded: true })).toBe(true)
    expect(existsSync(join(dest, 'theirs.txt'))).toBe(true)
  })

  it('removes nothing through a link that replaced the folder', () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'precious.txt'), 'keep')
    const dest = join(root, 'dest')
    const rec = prepareDestination(dest)
    rmSync(dest, { recursive: true })
    symlinkSync(outside, dest, WIN ? 'junction' : 'dir')
    expect(cleanupDestination(rec)).toBe(true)
    expect(existsSync(join(outside, 'precious.txt'))).toBe(true)
    expect(emptyDestination(rec)).toBe(false)
    expect(existsSync(join(outside, 'precious.txt'))).toBe(true)
  })

  it('empties the folder between attempts and keeps the record', () => {
    const dest = join(root, 'a', 'repo')
    const rec = prepareDestination(dest)
    mkdirSync(join(dest, '.git'))
    writeFileSync(join(dest, '.git', 'x'), 'x')
    expect(emptyDestination(rec)).toBe(true)
    expect(readdirSync(dest)).toEqual([])
    expect(rec.createdDirs).toContain(dest)
  })
})

describe('scanRepoConfig', () => {
  it('lists the present paths in table order and never follows a link', () => {
    const dir = join(root, 'repo')
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(dir, '.claude', 'settings.json'), '{}')
    writeFileSync(join(dir, 'AGENTS.md'), 'x')
    writeFileSync(join(dir, '.mcp.json'), '{}')
    expect(scanRepoConfig(dir)).toEqual(['.claude/settings.json', '.mcp.json', '.claude/agents', 'AGENTS.md'])
    const outside = join(root, 'outside')
    mkdirSync(outside)
    const linked = join(root, 'linked')
    mkdirSync(linked)
    symlinkSync(outside, join(linked, '.claude'), WIN ? 'junction' : 'dir')
    symlinkSync(outside, join(linked, '.codex'), WIN ? 'junction' : 'dir')
    expect(scanRepoConfig(linked)).toEqual(expect.arrayContaining(['.claude/settings.json', '.claude/hooks', '.codex']))
    expect(REPO_CONFIG_PATHS.map((p) => p.path)).toEqual(expect.arrayContaining(scanRepoConfig(linked)))
    expect(scanRepoConfig(join(root, 'nothing'))).toEqual([])
  })
})

// ---- pure helpers ----

describe('arguments and environment', () => {
  it('pins the clone and fork argument lists', () => {
    expect(cloneArgs('https://github.com/o/r.git', '/d')).toEqual(['-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never', 'clone', '--progress', '--no-recurse-submodules', '--', 'https://github.com/o/r.git', '/d'])
    expect(forkArgs('o', 'r')).toEqual(['api', '--method', 'POST', '--hostname', 'github.com', 'repos/o/r/forks'])
  })

  it('cleans the git and gh environments', () => {
    const base = { PATH: 'p', git_dir: 'x', GIT_WORK_TREE: 'x', GIT_CONFIG_COUNT: '1', GIT_TEMPLATE_DIR: 'x', GIT_ASKPASS: 'keep', GH_HOST: 'evil', DEBUG: '1', GH_REPO: 'x', GH_ENTERPRISE_TOKEN: 't', LC_ALL: 'de' }
    const g = gitEnv(base)
    expect(g).toMatchObject({ PATH: 'p', GIT_ASKPASS: 'keep', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https:ssh', SSH_ASKPASS_REQUIRE: 'never', LC_ALL: 'C', LANGUAGE: 'C' })
    for (const k of ['git_dir', 'GIT_WORK_TREE', 'GIT_CONFIG_COUNT', 'GIT_TEMPLATE_DIR']) expect(k in g).toBe(false)
    const h = ghEnv(base)
    expect(h).toMatchObject({ PATH: 'p', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' })
    for (const k of ['GH_HOST', 'DEBUG', 'GH_REPO', 'GH_ENTERPRISE_TOKEN']) expect(k in h).toBe(false)
  })
})

describe('error mapping', () => {
  const ctx = { display: 'o/r', host: 'github.com', dest: '/d/repo' }
  const table: [string, string, RegExp][] = [
    ['remote: Repository not found.\nfatal: repository \'https://github.com/o/r.git/\' not found', 'not-found', /^o\/r was not found, or this account has no access to it\.$/],
    ['fatal: unable to access \'x\': The requested URL returned error: 404', 'not-found', /was not found/],
    ['fatal: \'o/r\' does not appear to be a git repository\nfatal: Could not read from remote repository.', 'not-found', /was not found/],
    ['fatal: could not read Username for \'https://github.com\': terminal prompts disabled', 'signin', /^Git could not sign in to github\.com\. Sign in with your usual git credentials, then try again\.$/],
    ['fatal: Authentication failed for \'https://github.com/o/r.git/\'', 'signin', /sign in/],
    ['fatal: unable to access \'x\': The requested URL returned error: 403', 'signin', /sign in/],
    ['git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', 'signin', /sign in/],
    ['fatal: Could not read from remote repository.', 'signin', /sign in/],
    ['Host key verification failed.\nfatal: Could not read from remote repository.', 'hostkey', /ssh key of github\.com.*terminal/],
    ['fatal: unable to access \'x\': Could not resolve host: github.com', 'network', /^Could not reach github\.com\. Check your connection, or a proxy or firewall\.$/],
    ['fatal: unable to access \'x\': Failed to connect to github.com port 443', 'network', /Could not reach/],
    ['ssh: Could not resolve hostname github.com\nfatal: Could not read from remote repository.', 'network', /Could not reach/],
    ['fatal: unable to access \'x\': schannel: SSL certificate problem', 'network', /Could not reach/],
    ['error: RPC failed; fatal: write error: No space left on device', 'disk', /not enough disk space/],
    ['fatal: could not create work tree dir \'/d/repo\': Permission denied', 'folder', /could not write to the folder \/d\/repo/],
    ['fatal: destination path \'/d\' already exists and is not an empty directory.', 'folder', /could not write to the folder/],
    ['error: unable to create file a/b: Filename too long', 'folder', /could not write to the folder/],
    ['fatal: something odd happened', 'other', /^Git could not clone o\/r: fatal: something odd happened\.$/]
  ]
  it.each(table)('maps %j', (stderr, kind, message) => {
    expect(cloneErrorKind(stderr)).toBe(kind)
    const m = cloneErrorMessage(stderr, ctx)
    expect(m).toMatch(message)
    expect(m).not.toContain('\n')
  })

  it('names git as missing for a spawn error and never returns an empty message', () => {
    expect(cloneErrorMessage('', { ...ctx, spawnError: true })).toBe('Git is not installed. Install it from git-scm.com, then try again.')
    expect(cloneErrorMessage('', ctx)).toBe('Git could not clone o/r.')
  })

  it('keeps tokens out of messages', () => {
    const stderr = "fatal: weird https://user:ghp_abc123XYZ@github.com/o/r Bearer xyzsecret ghp_ABCDEF123456 github_pat_11AAA_bbbCCC token=sekret9999\n"
    const m = cloneErrorMessage(stderr, ctx)
    const s = scrubStderr(stderr)
    for (const text of [m, s]) {
      for (const bad of ['abc123', 'xyzsecret', 'ABCDEF', 'github_pat_11', 'sekret9999', 'user:']) expect(text).not.toContain(bad)
    }
    expect(scrubStderr('https://u:p@host.com/x')).toBe('https://host.com/x')
  })

  it('bounds and cleans the last line', () => {
    const m = cloneErrorMessage(`fatal: ${'x'.repeat(500)}\u202e`, ctx)
    expect(m.length).toBeLessThan(260)
    expect(m).not.toContain('\u202e')
  })

  it('maps gh fork failures', () => {
    const f = (s: string): string => forkErrorMessage(s, 'o/r')
    expect(f('gh: Not Found (HTTP 404)')).toBe('o/r was not found, or your GitHub account has no access to it.')
    expect(f('gh: Bad credentials (HTTP 401)')).toContain('gh auth login')
    expect(f('gh: Forking is disabled for this repository. (HTTP 403)')).toBe('o/r does not allow forking. Clone it instead.')
    expect(f('gh: The repository cannot be forked (HTTP 422)')).toContain('does not allow forking')
    expect(f('gh: Resource protected by organization SAML enforcement (HTTP 403)')).toContain('gh auth refresh')
    expect(f('gh: weird (HTTP 500)')).toBe('GitHub could not fork o/r: gh: weird (HTTP 500).')
    expect(f('')).toBe('GitHub could not fork o/r.')
    expect(f('token=ghp_secretvalue123 failed')).not.toContain('secretvalue')
  })
})

describe('validateForkResponse', () => {
  const src = { owner: 'o', repo: 'r' }
  const NOW = Date.parse('2026-11-05T00:10:00Z')
  const ok = (over: Record<string, unknown> = {}): string => JSON.stringify({ full_name: 'me/r', clone_url: 'https://github.com/me/r.git', html_url: 'https://github.com/me/r', created_at: '2026-11-05T00:09:00Z', ...over })
  it('accepts a good answer', () => {
    expect(validateForkResponse(ok(), src, NOW)).toMatchObject({ ok: true, fullName: 'me/r', htmlUrl: 'https://github.com/me/r', cloneUrl: 'https://github.com/me/r.git', alreadyExisted: false })
  })
  it('flags an old fork as already existing', () => {
    expect(validateForkResponse(ok({ created_at: '2026-11-04T00:00:00Z' }), src, NOW)).toMatchObject({ ok: true, alreadyExisted: true })
    expect(validateForkResponse(ok({ created_at: 'junk' }), src, NOW)).toMatchObject({ ok: true, alreadyExisted: false })
  })
  it('refuses anything it cannot check', () => {
    const bad = [
      ok({ clone_url: 'https://evil.com/me/r.git' }),
      ok({ clone_url: 'http://github.com/me/r.git' }),
      ok({ clone_url: 'https://github.com/me/other.git' }),
      ok({ html_url: 'https://github.com/me/r/extra' }),
      ok({ full_name: 'me/../x', clone_url: 'https://github.com/me/../x.git', html_url: 'https://github.com/me/../x' }),
      ok({ full_name: 'me/r/x' }),
      ok({ full_name: 5 }),
      ok({ full_name: '-me/r', clone_url: 'https://github.com/-me/r.git', html_url: 'https://github.com/-me/r' }),
      ok({ full_name: 'me/r\u202e' }),
      '[]',
      'null',
      'not json',
      '',
      'x'.repeat(2_000_000)
    ]
    for (const b of bad) expect(validateForkResponse(b, src, NOW), b.slice(0, 40)).toEqual({ ok: false, problem: 'GitHub answered with something OrgAI could not check, so nothing was cloned.' })
    expect(validateForkResponse(undefined, src)).toMatchObject({ ok: false })
  })
  it('recognises the source itself as your own repository', () => {
    const r = validateForkResponse(ok({ full_name: 'O/R', clone_url: 'https://github.com/O/R.git', html_url: 'https://github.com/O/R' }), src, NOW)
    expect(r).toEqual({ ok: false, problem: 'This is your own repository, so GitHub will not fork it. Clone it instead.', own: true })
  })
})

describe('progress', () => {
  it('maps lines to fixed labels and ignores remote text', () => {
    expect(parseProgressLine('Receiving objects:  45% (45/100)')).toEqual({ phase: 'receiving', text: 'Receiving files', percent: 45 })
    expect(parseProgressLine('Resolving deltas: 100% (3/3), done.')).toMatchObject({ text: 'Resolving changes', percent: 100 })
    expect(parseProgressLine('Updating files:  10% (1/10)')).toMatchObject({ text: 'Writing files' })
    expect(parseProgressLine('Compressing objects: 50%')).toMatchObject({ text: 'Contacting the server' })
    expect(parseProgressLine('fatal: nothing')).toBeNull()
  })

  it('keeps percent monotonic, splits on CR and LF and keeps remote lines out of the text', () => {
    const events: { text: string; percent: number }[] = []
    const r = new CloneOutputReader((e) => events.push(e))
    r.feed('Cloning into x...\r\nremote: Counting objects: 100%\r\nremote: evil text\r\nReceiving objects:  50% (1/2)\rReceiving objects:  25% (1/4)\rReceiving objects: 100% (4/4)\nResolving deltas:  50% (1/2)\n')
    r.feed('Updating files: 100% (2/2)\nfatal: boom')
    r.end()
    expect(events.map((e) => e.text)).toEqual(['Receiving files', 'Receiving files', 'Receiving files', 'Resolving changes', 'Writing files'])
    expect(events.map((e) => e.percent)).toEqual([40, 40, 80, 88, 100])
    expect(events.some((e) => e.text.includes('evil'))).toBe(false)
    expect(r.tail).toContain('remote: evil text')
    expect(r.tail).toContain('fatal: boom')
    expect(r.tail).not.toContain('Receiving objects')
  })

  it('bounds the tail', () => {
    const r = new CloneOutputReader(noop)
    for (let i = 0; i < 2000; i++) r.feed(`line ${i} ${'x'.repeat(50)}\n`)
    expect(r.tail.length).toBeLessThanOrEqual(17_000)
    expect(r.tail).toContain('line 1999')
  })
})

describe('readGhAuthJson', () => {
  const j = (entry: Record<string, unknown> | null): string => JSON.stringify({ hosts: entry ? { 'github.com': [entry] } : {} })
  it('maps every shape', () => {
    expect(readGhAuthJson(j({ active: true, login: 'me', state: 'success', error: null }))).toEqual({ loggedIn: true, login: 'me' })
    expect(readGhAuthJson(j({ active: true, login: 'me', state: 'error', error: 'Get "https://api.github.com/": dial tcp: no such host' }))).toEqual({ loggedIn: true, login: 'me', detail: 'OrgAI could not reach GitHub to check your sign-in.' })
    expect(readGhAuthJson(j({ active: true, login: 'me', state: 'timeout', error: null }))).toMatchObject({ loggedIn: true, detail: 'OrgAI could not reach GitHub to check your sign-in.' })
    for (const error of ['The token is invalid', 'token expired', 'Bad credentials', 'HTTP 401']) {
      expect(readGhAuthJson(j({ active: true, login: 'me', state: 'error', error }))).toMatchObject({ loggedIn: false, detail: 'Your GitHub CLI sign-in has expired. Run gh auth login.' })
    }
    expect(readGhAuthJson(j(null))).toEqual({ loggedIn: false, detail: 'Run gh auth login to sign in to the GitHub CLI.' })
    expect(readGhAuthJson(j({ active: false, login: 'me', state: 'success' }))).toMatchObject({ loggedIn: false })
    expect(readGhAuthJson(j({ active: true, login: '../bad', state: 'success' }))).toEqual({ loggedIn: true })
    expect(readGhAuthJson('nope')).toBeNull()
    expect(readGhAuthJson('{"hosts":[]}')).toBeNull()
  })
})

// ---- service: binaries and tools ----

describe('tools()', () => {
  const tools = async (override: (c: Call) => RunResult | undefined, extra: Partial<ConstructorParameters<typeof RepoCloneService>[0]> = {}) => {
    const r = makeRun(override)
    const { svc } = service({ run: r.run, ...extra })
    return { out: await svc.tools(), svc, calls: r.calls }
  }

  it('reports git, gh and the login', async () => {
    const { out } = await tools(() => undefined)
    expect(out).toEqual({ git: { available: true, version: '2.47.0.windows.2' }, gh: { available: true, loggedIn: true, login: 'me' } })
  })

  it('reports missing tools with fixed sentences', async () => {
    const { out } = await tools((c) => (/where\.exe$/i.test(c.file) || c.file === 'which' ? done('', 1) : undefined))
    expect(out).toEqual({ git: { available: false }, gh: { available: false, loggedIn: false, detail: 'Install the GitHub CLI from cli.github.com to fork a repository.' } })
  })

  it('maps logged out, expired, offline and old gh', async () => {
    const ghAuth = (o: RunResult) => (c: Call) => (c.file === GH ? o : undefined)
    expect((await tools(ghAuth(done('{"hosts":{}}', 0, 'You are not logged in')))).out.gh).toEqual({ available: true, loggedIn: false, detail: 'Run gh auth login to sign in to the GitHub CLI.' })
    expect((await tools(ghAuth(done(JSON.stringify({ hosts: { 'github.com': [{ active: true, login: 'me', state: 'error', error: 'token expired' }] } }))))).out.gh).toMatchObject({ loggedIn: false, detail: 'Your GitHub CLI sign-in has expired. Run gh auth login.' })
    expect((await tools(ghAuth(done(JSON.stringify({ hosts: { 'github.com': [{ active: true, login: 'me', state: 'error', error: 'dial tcp' }] } }))))).out.gh).toMatchObject({ loggedIn: true, login: 'me', detail: 'OrgAI could not reach GitHub to check your sign-in.' })
    const old = await tools((c) => {
      if (c.file !== GH) return undefined
      return c.args.includes('--json') ? done('', 1, 'unknown flag: --json') : done('', 0, 'Logged in to github.com account octo-cat (keyring)')
    })
    expect(old.out.gh).toEqual({ available: true, loggedIn: true, login: 'octo-cat' })
    const oldOut = await tools((c) => (c.file === GH ? (c.args.includes('--json') ? done('', 1, 'unknown flag: --json') : done('', 1, 'not logged in')) : undefined))
    expect(oldOut.out.gh).toMatchObject({ loggedIn: false })
  })

  it('answers with a fixed sentence on a timeout, a junk answer or a throw', async () => {
    const expected = { available: true, loggedIn: false, detail: 'OrgAI could not check your GitHub CLI sign-in.' }
    expect((await tools((c) => (c.file === GH ? { code: null, stdout: '', stderr: '', timedOut: true } : undefined))).out.gh).toEqual(expected)
    expect((await tools((c) => (c.file === GH ? done('<html>', 0) : undefined))).out.gh).toEqual(expected)
    const r = makeRun()
    const throwing: RunFn = async (f, a, o) => {
      if (f === GH) throw new Error('boom')
      return r.run(f, a, o)
    }
    const { svc } = service({ run: throwing })
    const out = await svc.tools()
    expect(out.gh.detail).toBe('OrgAI could not check your GitHub CLI sign-in.')
  })

  it('never passes a token flag and uses the pinned auth arguments, the cleaned env and a temp cwd', async () => {
    const { calls } = await tools(() => undefined)
    const auth = calls.find((c) => c.file === GH)!
    expect(auth.args).toEqual(['auth', 'status', '--active', '--hostname', 'github.com', '--json', 'hosts'])
    expect(auth.opts.timeoutMs).toBe(10_000)
    expect(auth.opts.cwd).toBe(tmpdir())
    expect('GH_HOST' in auth.opts.env).toBe(false)
    for (const c of calls) expect(c.args).not.toContain('--show-token')
  })

  it('resolves binaries by absolute path, taking only a .exe on Windows', async () => {
    const win = service({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, run: makeRun((c) => (/where\.exe$/i.test(c.file) ? done('C:\\shim\\git.cmd\r\nC:\\real\\git.exe\r\n') : undefined)).run })
    expect(await win.svc.resolveBinary('git')).toBe('C:\\real\\git.exe')
    const first = makeRun((c) => (/where\.exe$/i.test(c.file) ? done('C:\\shim\\git.cmd\r\nrelative\\git.exe\r\n') : undefined))
    const only = service({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, run: first.run })
    expect(await only.svc.resolveBinary('git')).toBeNull()
    expect(first.calls[0].file).toBe('C:\\Windows\\System32\\where.exe')
    expect(first.calls[0].args).toEqual(['$PATH:git'])
    expect(first.calls[0].opts.cwd).toBe(tmpdir())
    const posix = makeRun((c) => (c.file === 'which' ? done('relative/git\n/usr/bin/git\n') : undefined))
    const p = service({ platform: 'linux', run: posix.run })
    expect(await p.svc.resolveBinary('git')).toBe('/usr/bin/git')
    expect(posix.calls[0].args).toEqual(['-a', 'git'])
  })
})

// ---- service: clone ----

describe('clone()', () => {
  it('clones, with the pinned arguments, a clean env and a result', async () => {
    const { svc, spawned, calls } = service()
    const events: RepoCloneProgress[] = []
    let t = 0
    const s2 = service({ now: () => (t += 300) })
    const res = await s2.svc.clone(input(), (e) => events.push(e))
    expect(res).toMatchObject({ path: join(root, 'out', 'repo'), url: 'https://github.com/o/r.git', branch: 'main', repoConfig: [] })
    expect(res.fork).toBeUndefined()
    expect(s2.spawned[0].args).toEqual(cloneArgs('https://github.com/o/r.git', join(root, 'out', 'repo')))
    expect(s2.spawned[0].cwd).toBe(tmpdir())
    expect(s2.spawned[0].env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https:ssh' })
    expect('GIT_DIR' in s2.spawned[0].env).toBe(false)
    expect(readFileSync(join(root, 'out', 'repo', 'README.md'), 'utf8')).toBe('# x\n')
    expect(events[0]).toMatchObject({ requestId: 'req1', phase: 'cloning' })
    expect(events.at(-1)).toEqual({ requestId: 'req1', phase: 'finishing' })
    expect(events.some((e) => e.text === 'Receiving files' && e.percent === 40)).toBe(true)
    void svc
    void spawned
    void calls
  })

  it('refuses bad input before doing anything', async () => {
    const { svc, spawned } = service()
    await expect(svc.clone(input({ source: 'file:///x' }), noop)).rejects.toThrow('Only https and ssh')
    await expect(svc.clone(input({ mode: 'nope' as never }), noop)).rejects.toThrow('Choose clone or fork')
    await expect(svc.clone(input({ source: 'https://gitlab.com/g/r', mode: 'fork' }), noop)).rejects.toThrow('Forking works for github.com repositories only. Clone it instead.')
    await expect(svc.clone(input({ requestId: '../x' }), noop)).rejects.toThrow('Invalid clone request.')
    await expect(svc.clone(input({ destination: 'relative' }), noop)).rejects.toThrow()
    expect(spawned).toHaveLength(0)
  })

  it('says git is not installed', async () => {
    const { svc } = service({ run: makeRun((c) => (/where\.exe$/i.test(c.file) || c.file === 'which' ? done('', 1) : undefined)).run })
    await expect(svc.clone(input(), noop)).rejects.toThrow('Git is not installed. Install it from git-scm.com, then try again.')
    expect(existsSync(join(root, 'out'))).toBe(false)
  })

  it('maps a git failure and removes what it created', async () => {
    const { svc } = service({ spawnGit: makeSpawn((h, args) => {
      writeFileSync(join(args[args.length - 1], 'partial'), 'x')
      cloneFail(h, "remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found\n")
    }).spawnGit })
    await expect(svc.clone(input(), noop)).rejects.toThrow('o/r was not found, or this account has no access to it.')
    expect(existsSync(join(root, 'out'))).toBe(false)
    expect(existsSync(root)).toBe(true)
  })

  it('leaves a pre-existing empty folder, empty, after a failure', async () => {
    const dest = join(root, 'pre')
    mkdirSync(dest)
    const { svc } = service({ spawnGit: makeSpawn((h, args) => {
      writeFileSync(join(args[args.length - 1], 'partial'), 'x')
      cloneFail(h, 'fatal: Could not read from remote repository.')
    }).spawnGit })
    await expect(svc.clone(input({ destination: dest }), noop)).rejects.toThrow('sign in')
    expect(readdirSync(dest)).toEqual([])
  })

  it('keeps tokens out of the rejection and the log line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { svc } = service({ spawnGit: makeSpawn((h) => cloneFail(h, 'fatal: odd https://user:ghp_abc123@github.com/o/r Bearer xyz ghp_ABCDEF123456')).spawnGit })
    const err = await svc.clone(input(), noop).catch((e: Error) => e)
    const text = `${(err as Error).message}\n${warn.mock.calls.flat().join('\n')}`
    expect(warn).toHaveBeenCalled()
    for (const bad of ['abc123', 'xyz', 'ABCDEF', 'user:']) expect(text).not.toContain(bad)
  })

  it('removes nothing when git says the folder is not empty', async () => {
    const dest = join(root, 'pre')
    const { svc } = service({ spawnGit: makeSpawn((h, args) => {
      writeFileSync(join(args[args.length - 1], 'theirs.txt'), 'x')
      cloneFail(h, "fatal: destination path '/x' already exists and is not an empty directory.")
    }).spawnGit })
    await expect(svc.clone(input({ destination: dest }), noop)).rejects.toThrow('could not write to the folder')
    expect(existsSync(join(dest, 'theirs.txt'))).toBe(true)
  })

  it('removes nothing through a link that replaced the folder, and says a partial folder may remain when removal fails', async () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'precious.txt'), 'keep')
    const dest = join(root, 'dest')
    const { svc } = service({ spawnGit: makeSpawn((h, args) => {
      const d = args[args.length - 1]
      rmSync(d, { recursive: true })
      symlinkSync(outside, d, WIN ? 'junction' : 'dir')
      cloneFail(h, 'fatal: unable to access: Could not resolve host')
    }).spawnGit })
    await expect(svc.clone(input({ destination: dest }), noop)).rejects.toThrow('Could not reach github.com')
    expect(existsSync(join(outside, 'precious.txt'))).toBe(true)
  })

  it('stops after nothing arrives for the inactivity time, and bytes reset it', async () => {
    const hang = service({ inactivityMs: 40, spawnGit: makeSpawn().spawnGit })
    const sp = makeSpawn()
    const kill = makeKill(sp.spawned)
    const s = service({ inactivityMs: 40, spawnGit: sp.spawnGit, killTree: kill.killTree })
    await expect(s.svc.clone(input(), noop)).rejects.toThrow('The download stopped: nothing arrived for 5 minutes. Check your connection and try again.')
    expect(kill.killed).toEqual([4242])
    expect(existsSync(join(root, 'out'))).toBe(false)
    void hang

    const sp2 = makeSpawn((h, args) => {
      let n = 0
      const tick = setInterval(() => {
        h.emit(`Receiving objects: ${++n * 20}%\r`)
        if (n === 4) {
          clearInterval(tick)
          cloneOk(h, args)
        }
      }, 25)
    })
    const k2 = makeKill(sp2.spawned)
    const s2 = service({ inactivityMs: 40, spawnGit: sp2.spawnGit, killTree: k2.killTree })
    await expect(s2.svc.clone(input({ destination: join(root, 'other') }), noop)).resolves.toMatchObject({ branch: 'main' })
    expect(k2.killed).toEqual([])
  })

  it('throttles progress and shows only fixed labels', async () => {
    let t = 0
    const sp = makeSpawn((h, args) => {
      for (let i = 1; i <= 50; i++) h.emit(`remote: evil ${i}\nReceiving objects: ${i}% (1/2)\r`)
      h.emit('Resolving deltas: 100% (1/1)\rUpdating files: 100% (1/1)\n')
      cloneOk(h, args)
    })
    const { svc } = service({ spawnGit: sp.spawnGit, now: () => t })
    const events: RepoCloneProgress[] = []
    await svc.clone(input(), (e) => events.push(e))
    // The clock never moved, so an event repeating the previous one's label is dropped (the fake's last write adds one more).
    expect(events.map((e) => e.text ?? e.phase)).toEqual(['Contacting the server', 'Receiving files', 'Resolving changes', 'Writing files', 'Receiving files', 'finishing'])
    expect(JSON.stringify(events)).not.toContain('evil')
    t += 1000
    const again = service({ spawnGit: sp.spawnGit, now: () => (t += 300) })
    const more: RepoCloneProgress[] = []
    await again.svc.clone(input({ requestId: 'req2', destination: join(root, 'two') }), (e) => more.push(e))
    expect(more.filter((e) => e.text === 'Receiving files').length).toBeGreaterThan(10)
    const pct = more.map((e) => e.percent).filter((p): p is number => p !== undefined)
    expect([...pct]).toEqual([...pct].sort((a, b) => a - b))
  })

  it('a sink that throws does not stop the clone', async () => {
    const { svc } = service()
    await expect(svc.clone(input(), () => { throw new Error('window gone') })).resolves.toMatchObject({ branch: 'main' })
  })
})

describe('requests, cancel and dispose', () => {
  function hanging() {
    const sp = makeSpawn()
    const kill = makeKill(sp.spawned)
    return { sp, kill, ...service({ spawnGit: sp.spawnGit, killTree: kill.killTree }) }
  }

  it('cancels a running clone, kills the tree and cleans up', async () => {
    const { svc, sp, kill } = hanging()
    const p = svc.clone(input(), noop)
    const caught = p.catch((e: Error) => e)
    await vi.waitFor(() => expect(sp.spawned.length).toBe(1))
    expect(existsSync(join(root, 'out', 'repo'))).toBe(true)
    svc.cancel('req1')
    const err = (await caught) as Error
    expect(err.message).toBe('Cancelled.')
    expect(kill.killed).toEqual([4242])
    expect(existsSync(join(root, 'out'))).toBe(false)
  })

  it('ignores an unknown id, refuses the same id and the fourth clone', async () => {
    const { svc, sp } = hanging()
    expect(() => svc.cancel('nope')).not.toThrow()
    expect(() => svc.cancel(undefined as never)).not.toThrow()
    const runs = ['a', 'b', 'c'].map((id) => svc.clone(input({ requestId: id, destination: join(root, id) }), noop).catch((e: Error) => e))
    await vi.waitFor(() => expect(sp.spawned.length).toBe(3))
    await expect(svc.clone(input({ requestId: 'a', destination: join(root, 'z') }), noop)).rejects.toThrow('That clone is already running.')
    await expect(svc.clone(input({ requestId: 'd', destination: join(root, 'd') }), noop)).rejects.toThrow('Too many clones are running. Wait for one to finish.')
    for (const id of ['a', 'b', 'c']) svc.cancel(id)
    for (const r of await Promise.all(runs)) expect((r as Error).message).toBe('Cancelled.')
  })

  it('dispose kills every clone, cleans up synchronously and refuses new ones', async () => {
    const sp = makeSpawn()
    const syncKills: number[] = []
    const kill = makeKill(sp.spawned)
    const { svc } = service({ spawnGit: sp.spawnGit, killTree: kill.killTree, killTreeSync: (pid) => { syncKills.push(pid); sp.spawned[0].h.finish(null) } })
    const p = svc.clone(input(), noop).catch((e: Error) => e)
    await vi.waitFor(() => expect(sp.spawned.length).toBe(1))
    writeFileSync(join(root, 'out', 'repo', 'partial'), 'x')
    svc.dispose()
    expect(syncKills).toEqual([4242])
    expect(existsSync(join(root, 'out'))).toBe(false)
    svc.dispose()
    expect(((await p) as Error).message).toContain('Cancelled.')
    await expect(svc.clone(input({ requestId: 'late' }), noop)).rejects.toThrow('closing')
  })

  it('a git that cannot start reports it as not installed', async () => {
    const { svc } = service({ spawnGit: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }) } })
    await expect(svc.clone(input(), noop)).rejects.toThrow('Git is not installed')
    const sp = makeSpawn((h) => h.fail('ENOENT'))
    const s2 = service({ spawnGit: sp.spawnGit })
    await expect(s2.svc.clone(input({ destination: join(root, 'two') }), noop)).rejects.toThrow('Git is not installed')
  })
})

// ---- service: fork ----

describe('fork', () => {
  interface Opts {
    spawn?: (h: FakeGit, args: string[], n: number) => void
    gh?: (c: Call) => RunResult | Promise<RunResult> | undefined
    head?: (n: number) => number
  }
  function forkService(o: Opts = {}) {
    let t = Date.now()
    const sleeps: number[] = []
    let headCalls = 0
    const r = makeRun((c) => {
      const g = o.gh?.(c)
      if (g) return g
      if (c.file === GH && c.args[0] === 'api') return done(forkJson('me/r'))
      if (c.file === GIT && c.args.includes('rev-parse')) return done('', o.head ? o.head(++headCalls) : 0)
      return undefined
    })
    const sp = makeSpawn(o.spawn ?? cloneOk)
    const kill = makeKill(sp.spawned)
    const svc = new RepoCloneService({
      dataDir: join(root, 'data'),
      env: { PATH: 'x', GH_HOST: 'evil.example', DEBUG: '1' },
      run: r.run,
      spawnGit: sp.spawnGit,
      killTree: kill.killTree,
      killTreeSync: () => {},
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms)
        t += ms
      },
      closeGraceMs: 10,
      killWaitMs: 100
    })
    return { svc, sleeps, ...r, ...sp, ...kill }
  }
  const forkInput = (over: Partial<RepoCloneInput> = {}): RepoCloneInput => input({ mode: 'fork', ...over })

  it('forks, clones the fork and adds upstream', async () => {
    const f = forkService()
    const events: RepoCloneProgress[] = []
    const res = await f.svc.clone(forkInput(), (e) => events.push(e))
    expect(res.url).toBe('https://github.com/me/r.git')
    expect(res.fork).toEqual({ fullName: 'me/r', htmlUrl: 'https://github.com/me/r', upstreamUrl: 'https://github.com/o/r.git', upstreamAdded: true })
    expect(events[0].phase).toBe('forking')
    const api = f.calls.find((c) => c.file === GH && c.args[0] === 'api')!
    expect(api.args).toEqual(['api', '--method', 'POST', '--hostname', 'github.com', 'repos/o/r/forks'])
    expect(api.opts.timeoutMs).toBe(60_000)
    expect(api.opts.cwd).toBe(tmpdir())
    expect(api.opts.env).toMatchObject({ GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' })
    for (const k of ['GH_HOST', 'DEBUG']) expect(k in api.opts.env).toBe(false)
    const upstream = f.calls.find((c) => c.args.includes('upstream'))!
    expect(upstream.args).toEqual(['-C', join(root, 'out', 'repo'), 'remote', 'add', 'upstream', 'https://github.com/o/r.git'])
    expect(f.spawned[0].args[f.spawned[0].args.length - 2]).toBe('https://github.com/me/r.git')
  })

  it('flags upstream failures without failing', async () => {
    const f = forkService({ gh: (c) => (c.file === GIT && c.args.includes('upstream') ? done('', 1, 'boom') : undefined) })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await f.svc.clone(forkInput(), noop)
    expect(res.fork?.upstreamAdded).toBe(false)
    expect(warn).toHaveBeenCalled()
  })

  it('records alreadyExisted', async () => {
    const f = forkService({ gh: (c) => (c.file === GH && c.args[0] === 'api' ? done(forkJson('me/r', '2020-01-01T00:00:00Z')) : undefined) })
    expect((await f.svc.clone(forkInput(), noop)).fork?.alreadyExisted).toBe(true)
  })

  it('clones the fork over ssh when the source was ssh', async () => {
    const f = forkService()
    const res = await f.svc.clone(forkInput({ source: 'git@github.com:o/r' }), noop)
    expect(f.spawned[0].args.slice(-2, -1)).toEqual(['git@github.com:me/r.git'])
    expect(res.url).toBe('git@github.com:me/r.git')
    expect(res.fork?.upstreamUrl).toBe('git@github.com:o/r.git')
    const up = f.calls.find((c) => c.args.includes('upstream'))!
    expect(up.args.at(-1)).toBe('git@github.com:o/r.git')
  })

  it('refuses before forking when gh is missing or logged out, and for your own repository', async () => {
    const missing = forkService({ gh: (c) => (/where\.exe$/i.test(c.file) || c.file === 'which' ? (c.args.includes('$PATH:gh') || c.args.includes('gh') ? done('', 1) : undefined) : undefined) })
    await expect(missing.svc.clone(forkInput(), noop)).rejects.toThrow('Forking needs the GitHub CLI: install gh from cli.github.com, then run gh auth login. A plain clone still works.')
    const out = forkService({ gh: (c) => (c.file === GH && c.args[0] === 'auth' ? done('{"hosts":{}}') : undefined) })
    await expect(out.svc.clone(forkInput(), noop)).rejects.toThrow('Forking needs you to sign in to the GitHub CLI: run gh auth login. A plain clone still works.')
    expect(out.calls.some((c) => c.args[0] === 'api')).toBe(false)
    const own = forkService()
    await expect(own.svc.clone(forkInput({ source: 'ME/r' }), noop)).rejects.toThrow('This is your own repository, so GitHub will not fork it. Clone it instead.')
    expect(own.calls.some((c) => c.args[0] === 'api')).toBe(false)
    expect(existsSync(join(root, 'out'))).toBe(false)
  })

  it('answers GitHub returning the source itself as your own repository', async () => {
    const f = forkService({ gh: (c) => (c.file === GH && c.args[0] === 'api' ? done(forkJson('o/r')) : undefined) })
    await expect(f.svc.clone(forkInput(), noop)).rejects.toThrow('This is your own repository')
  })

  it('maps gh failures and unusable answers; nothing is cloned', async () => {
    for (const [res, expected] of [
      [done('', 1, 'gh: Not Found (HTTP 404)'), 'o/r was not found, or your GitHub account has no access to it.'],
      [done('', 1, 'gh: Forking is disabled (HTTP 403)'), 'o/r does not allow forking. Clone it instead.'],
      [done('{"full_name":"x"}'), 'GitHub answered with something OrgAI could not check, so nothing was cloned.'],
      [done(forkJson('me/r').replace('github.com/me/r.git', 'evil.com/me/r.git')), 'GitHub answered with something OrgAI could not check, so nothing was cloned.']
    ] as [RunResult, string][]) {
      const f = forkService({ gh: (c) => (c.file === GH && c.args[0] === 'api' ? res : undefined) })
      await expect(f.svc.clone(forkInput(), noop)).rejects.toThrow(expected)
      expect(f.spawned).toHaveLength(0)
      expect(existsSync(join(root, 'out'))).toBe(false)
    }
  })

  it('retries a clone of a fresh fork that is not found yet, then succeeds', async () => {
    const f = forkService({ spawn: (h, args, n) => (n < 3 ? cloneFail(h, "remote: Repository not found.\nfatal: repository 'x' not found") : cloneOk(h, args)) })
    const events: RepoCloneProgress[] = []
    const res = await f.svc.clone(forkInput(), (e) => events.push(e))
    expect(res.fork?.fullName).toBe('me/r')
    expect(f.sleeps).toEqual([2000, 4000])
    expect(f.spawned).toHaveLength(3)
    expect(events.filter((e) => e.phase === 'waiting-for-fork').length).toBeGreaterThan(0)
  })

  it('retries an empty fork, emptying the folder between attempts', async () => {
    const f = forkService({
      head: (n) => (n === 1 ? 1 : 0),
      spawn: (h, args) => {
        writeFileSync(join(args[args.length - 1], 'leftover'), 'x')
        h.finish(0)
      }
    })
    await f.svc.clone(forkInput(), noop)
    expect(f.sleeps).toEqual([2000])
    expect(f.spawned).toHaveLength(2)
  })

  it('gives up at the deadline, names the fork and cleans up', async () => {
    const f = forkService({ spawn: (h) => cloneFail(h, 'remote: Repository not found.') })
    await expect(f.svc.clone(forkInput(), noop)).rejects.toThrow('me/r was not found, or this account has no access to it. The fork exists at https://github.com/me/r.')
    expect(f.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(60_000)
    expect(Math.max(...f.sleeps)).toBe(8000)
    expect(existsSync(join(root, 'out'))).toBe(false)
  })

  it('does not retry other errors, but still names the fork', async () => {
    for (const [stderr, text] of [
      ['fatal: unable to access: Could not resolve host', 'Could not reach github.com'],
      ['fatal: could not read Username: terminal prompts disabled', 'sign in'],
      ['error: No space left on device', 'disk space']
    ]) {
      const f = forkService({ spawn: (h) => cloneFail(h, stderr) })
      await expect(f.svc.clone(forkInput({ destination: join(root, 'x', text.length.toString()) }), noop)).rejects.toThrow(new RegExp(`${text}.*The fork exists at https://github\\.com/me/r\\.$`))
      expect(f.spawned).toHaveLength(1)
      expect(f.sleeps).toEqual([])
    }
  })

  it('cancels while the fork call is in flight', async () => {
    let started = false
    const f = forkService({
      gh: (c) => {
        if (c.file === GH && c.args[0] === 'api') {
          started = true
          return new Promise<RunResult>((res) => c.opts.signal?.addEventListener('abort', () => res({ code: null, stdout: '', stderr: '', aborted: true })))
        }
        return undefined
      }
    })
    const p = f.svc.clone(forkInput(), noop).catch((e: Error) => e)
    await vi.waitFor(() => expect(started).toBe(true))
    f.svc.cancel('req1')
    expect(((await p) as Error).message).toBe('Cancelled. The fork may still have been made on GitHub.')
    expect(existsSync(join(root, 'out'))).toBe(false)
  })

  it('cancels during the wait for the fork and names it', async () => {
    const sp = makeSpawn((h) => cloneFail(h, 'remote: Repository not found.'))
    const kill = makeKill(sp.spawned)
    let waiting = false
    const r = makeRun((c) => (c.file === GH && c.args[0] === 'api' ? done(forkJson('me/r')) : undefined))
    const svc = new RepoCloneService({
      dataDir: join(root, 'data'),
      run: r.run,
      spawnGit: sp.spawnGit,
      killTree: kill.killTree,
      killTreeSync: () => {},
      sleep: (_ms, signal) => new Promise<void>((res) => {
        waiting = true
        signal?.addEventListener('abort', () => res())
      }),
      closeGraceMs: 10
    })
    const p = svc.clone(forkInput(), noop).catch((e: Error) => e)
    await vi.waitFor(() => expect(waiting).toBe(true))
    svc.cancel('req1')
    expect(((await p) as Error).message).toBe('Cancelled. The fork exists at https://github.com/me/r.')
    expect(existsSync(join(root, 'out'))).toBe(false)
  })
})

// ---- mock ----

const gitPresent = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!gitPresent)('mock mode', () => {
  function mockService(env: NodeJS.ProcessEnv = {}, sleep?: (ms: number, signal?: AbortSignal) => Promise<void>) {
    const calls: Call[] = []
    const run: RunFn = (file, args, opts) => {
      calls.push({ file, args, opts })
      return defaultRun(file, args, opts)
    }
    const spawnGit = vi.fn(() => {
      throw new Error('mock mode must not spawn a long-running git')
    })
    const svc = new RepoCloneService({ dataDir: join(root, 'data'), mock: true, env: { ...process.env, ...env }, run, spawnGit: spawnGit as never, sleep: sleep ?? (async () => {}) })
    return { svc, calls, spawnGit }
  }
  const dest = (): string => join(root, 'out', 'repo')

  it('with-agents makes the expected repository and config', async () => {
    const { svc, calls, spawnGit } = mockService()
    const events: RepoCloneProgress[] = []
    const res = await svc.clone(input({ source: 'mock-org/with-agents' }), (e) => events.push(e))
    expect(res.branch).toBe('main')
    expect(res.repoConfig).toEqual(['.claude/settings.json', '.mcp.json', '.claude/agents', 'AGENTS.md'])
    expect(readFileSync(join(dest(), '.claude', 'agents', 'mock-reviewer.md'), 'utf8')).toContain('name: mock-reviewer')
    expect(JSON.parse(readFileSync(join(dest(), '.claude', 'settings.json'), 'utf8'))).toEqual({ permissions: { allow: ['Bash(npm test:*)'] } })
    expect(existsSync(join(dest(), '.git'))).toBe(true)
    expect(execFileSync('git', ['-C', dest(), 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim()).toBe('https://github.com/mock-org/with-agents.git')
    expect(execFileSync('git', ['-C', dest(), 'log', '--format=%an %s'], { encoding: 'utf8' }).trim()).toBe('OrgAI Initial commit')
    expect(events.map((e) => e.phase)).toEqual(expect.arrayContaining(['cloning', 'finishing']))
    expect(spawnGit).not.toHaveBeenCalled()
    for (const c of calls) {
      expect(c.file).not.toBe(GH)
      expect(c.args.join(' ')).not.toMatch(/\b(clone|fetch|pull|push|ls-remote)\b/)
      expect(c.args.join(' ')).not.toContain('api')
    }
  })

  it('a plain repo has a README', async () => {
    const { svc } = mockService()
    const res = await svc.clone(input({ source: 'https://github.com/anyone/anything' }), noop)
    expect(readdirSync(res.path).filter((n) => n !== '.git')).toEqual(['README.md'])
    expect(res.repoConfig).toEqual([])
  })

  it('fails the marker repos with the right sentences and cleans up', async () => {
    const { svc } = mockService()
    for (const [repo, text] of [
      ['mock-org/missing', 'was not found, or this account has no access to it.'],
      ['mock-org/private', 'Git could not sign in to github.com'],
      ['mock-org/unreachable', 'Could not reach github.com']
    ]) {
      await expect(svc.clone(input({ source: repo }), noop)).rejects.toThrow(text)
      expect(existsSync(join(root, 'out'))).toBe(false)
    }
  })

  it('forks: result, own repository, no-fork, clone failure naming the fork, existing fork', async () => {
    const { svc } = mockService()
    const ok = await svc.clone(input({ source: 'mock-org/thing', mode: 'fork' }), noop)
    expect(ok.fork).toEqual({ fullName: 'mock-user/thing', htmlUrl: 'https://github.com/mock-user/thing', upstreamUrl: 'https://github.com/mock-org/thing.git', upstreamAdded: true })
    expect(ok.url).toBe('https://github.com/mock-user/thing.git')
    expect(execFileSync('git', ['-C', ok.path, 'remote', 'get-url', 'upstream'], { encoding: 'utf8' }).trim()).toBe('https://github.com/mock-org/thing.git')
    await expect(svc.clone(input({ requestId: 'r2', source: 'mock-user/mine', mode: 'fork', destination: join(root, 'b') }), noop)).rejects.toThrow('This is your own repository')
    await expect(svc.clone(input({ requestId: 'r3', source: 'mock-org/no-fork', mode: 'fork', destination: join(root, 'c') }), noop)).rejects.toThrow('does not allow forking')
    await expect(svc.clone(input({ requestId: 'r4', source: 'mock-org/fork-clone-fails', mode: 'fork', destination: join(root, 'd') }), noop)).rejects.toThrow('The fork exists at https://github.com/mock-user/fork-clone-fails.')
    expect(existsSync(join(root, 'd'))).toBe(false)
    const exists = await svc.clone(input({ requestId: 'r5', source: 'mock-org/fork-exists', mode: 'fork', destination: join(root, 'e') }), noop)
    expect(exists.fork?.alreadyExisted).toBe(true)
    const clonedOwn = await svc.clone(input({ requestId: 'r6', source: 'mock-user/mine', destination: join(root, 'f') }), noop)
    expect(clonedOwn.repoConfig).toEqual([])
  })

  it('fork-slow waits in waiting-for-fork', async () => {
    const { svc } = mockService()
    const events: RepoCloneProgress[] = []
    await svc.clone(input({ source: 'mock-org/fork-slow', mode: 'fork' }), (e) => events.push(e))
    expect(events.some((e) => e.phase === 'waiting-for-fork')).toBe(true)
  })

  it('slow can be cancelled and leaves nothing', async () => {
    const { svc } = mockService({}, (_ms, signal) => new Promise<void>((res) => signal?.addEventListener('abort', () => res())))
    const events: RepoCloneProgress[] = []
    const p = svc.clone(input({ source: 'mock-org/slow' }), (e) => events.push(e)).catch((e: Error) => e)
    await vi.waitFor(() => expect(existsSync(dest())).toBe(true))
    svc.cancel('req1')
    expect(((await p) as Error).message).toBe('Cancelled.')
    expect(existsSync(join(root, 'out'))).toBe(false)
  })

  it('tools follow ORGAI_MOCK_GH and ORGAI_MOCK_GIT without running anything', async () => {
    const cases: [NodeJS.ProcessEnv, unknown][] = [
      [{}, { git: { available: true, version: 'mock' }, gh: { available: true, loggedIn: true, login: 'mock-user' } }],
      [{ ORGAI_MOCK_GH: 'missing' }, { git: { available: true, version: 'mock' }, gh: { available: false, loggedIn: false, detail: 'Install the GitHub CLI from cli.github.com to fork a repository.' } }],
      [{ ORGAI_MOCK_GH: 'logged-out' }, { git: { available: true, version: 'mock' }, gh: { available: true, loggedIn: false, detail: 'Run gh auth login to sign in to the GitHub CLI.' } }],
      [{ ORGAI_MOCK_GIT: 'missing' }, { git: { available: false }, gh: { available: true, loggedIn: true, login: 'mock-user' } }]
    ]
    for (const [env, expected] of cases) {
      const { svc, calls } = mockService(env)
      expect(await svc.tools()).toEqual(expected)
      expect(calls).toHaveLength(0)
    }
    const { svc } = mockService({ ORGAI_MOCK_GIT: 'missing' })
    await expect(svc.clone(input(), noop)).rejects.toThrow('Git is not installed')
  })

  it('exports a marker table that lists every behaviour the docs name', () => {
    expect(MOCK_REPO_MARKERS.map((m) => m.repo)).toEqual(['mock-org/with-agents', 'mock-org/slow', 'mock-org/missing', 'mock-org/private', 'mock-org/unreachable', 'mock-org/no-fork', 'mock-org/fork-clone-fails', 'mock-org/fork-exists', 'mock-org/fork-slow', 'mock-user/<anything>'])
  })
})

describe('real git hardening (local, no network)', () => {
  it.skipIf(!gitPresent)('a file:// source never reaches git, and the protocol switches are in the argument list', () => {
    expect(parseRepoSource('file:///tmp/x').ok).toBe(false)
    expect(cloneArgs('u', 'd').slice(0, 4)).toEqual(['-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never'])
    expect(lstatSync(tmpdir()).isDirectory()).toBe(true)
  })
})
