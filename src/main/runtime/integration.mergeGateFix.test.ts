import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentInstance, WorktreeInfo } from '@shared/types'
import { WorktreeIntegrator } from './integration'
import { gitGuarded, integrateWorktree, mergeAttributeRefusal, mergeCarriedConfigArgs, mergeMadeMove, mergeScratchDir, prepareRepo, sweepMergeScratch } from './worktrees'
import { pinRoot, rootDrift, rootVerdict } from './rootPin'
import { resetOrgAiMoves } from './orgaiMoves'
import { fakeCtx, project } from './testHelpers'

vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

// Security fix round on the merge gate, against real git and the real test gate (no mocks):
// H1 (carried settings snapshot, forced write protections), M1 (exact ledger moves), M2 (what the re-ask shows),
// M4 (filters), and the Lows (renamed paths, the scratch index).

let root: string
let scripts: string
let home: string

const norm = (p: string): string => p.replace(/\\/g, '/')
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Pin', '-c', 'user.email=pin@orgai.local', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
function put(dir: string, rel: string, content: string): void {
  const full = join(dir, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content, 'utf8')
}
async function until(cond: () => boolean, ms = 40_000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for the test command')
    await new Promise((r) => setTimeout(r, 40))
  }
}
function waiter(): string {
  const path = join(scripts, 'wait.js')
  writeFileSync(
    path,
    "const fs = require('fs'), p = require('path'); const [,, dir, id, waitFor] = process.argv;\n" +
      "fs.writeFileSync(p.join(dir, 'started-' + id), '1'); const t0 = Date.now();\n" +
      "while (waitFor !== 'none' && !fs.existsSync(waitFor) && Date.now() - t0 < 40000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);\n"
  )
  return path
}
const waitCommand = (id: string, waitFor: string): string => `node "${waiter()}" "${scripts}" ${id} "${waitFor}"`

const saved: Record<string, string | undefined> = {}
function useGlobalHome(): void {
  for (const k of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) saved[k] = process.env[k]
  delete process.env.GIT_CONFIG_GLOBAL
  process.env.HOME = process.env.USERPROFILE = process.env.XDG_CONFIG_HOME = home
}

beforeEach(() => {
  resetOrgAiMoves()
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-fix-')))
  scripts = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-fix-scripts-')))
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-fix-home-')))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.name', 'Pin')
  git(root, 'config', 'user.email', 'pin@orgai.local')
  git(root, 'config', 'core.autocrlf', 'false')
  put(root, 'package.json', '{"name":"fixture"}\n')
  put(root, 'src/app.js', 'export const a = 1\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'initial')
})

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    git(root, 'worktree', 'prune')
  } catch {
    /* ignore */
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  rmSync(scripts, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

function addWorktree(id: string, files: Record<string, string> = { [`src/${id}.js`]: `export const ${id} = 1\n` }): WorktreeInfo {
  const rel = `.claude/worktrees/agent-${id}`
  const branch = `worktree-agent-${id}`
  git(root, 'worktree', 'add', '-q', '-b', branch, rel)
  for (const [f, c] of Object.entries(files)) put(join(root, rel), f, c)
  return { path: join(root, rel), branch, status: 'active' }
}

function integrator(testCommand: string, review = false) {
  const ctx = fakeCtx({ project: project({ path: root, requireTestsPass: true, testCommand, reviewMerges: review }) })
  const agents = new Map<string, AgentInstance>()
  const i = new WorktreeIntegrator(ctx, { agent: (id) => agents.get(id), setWorktree: () => {}, notify: () => {} })
  const logs = (): string[] => ctx.events.flatMap((e) => (e.type === 'log' ? [`${e.level}: ${e.message}`] : []))
  return { i, ctx, logs }
}

const headOf = (dir: string): string => git(dir, 'rev-parse', 'HEAD')

describe('H1: the merge carries a snapshot taken before the test command, and git\'s write protections are forced', () => {

  // Names that alias the git folder on Windows (NTFS) when the protections are off: a trailing space, an alternate-stream suffix,
  // a trailing dot. Elsewhere they are ordinary names, and the assertion (nothing under .git) holds all the same.
  it.each([['.git '], ['.git::$INDEX_ALLOCATION'], ['.git.'], ['GIT~1']])('a test command that turns core.protectNTFS off globally cannot make the merge write through the alias "%s" into the real .git', async (alias) => {
    await prepareRepo(root)
    const wt = addWorktree('h1a')
    useGlobalHome()
    // The gate step stands in for the test command: repository code run as the user. It (1) turns the protections off in the
    // user's global config and (2) lands a commit on the branch whose tree holds an entry named like the alias with a file in
    // it, built with plumbing in a scratch index (the copy itself cannot hold such a file). Then the merge of that commit runs.
    // With the protections off, git writes that file into the real .git on Windows.
    const res = await integrateWorktree(root, { ...wt, status: 'merging' }, 'H1A', async (_files, tip) => {
      git(root, 'config', '--global', 'core.protectNTFS', 'false')
      git(root, 'config', '--global', 'core.protectHFS', 'false')
      const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: 'planted\n', encoding: 'utf8' }).trim()
      const env = { ...process.env, GIT_INDEX_FILE: join(scripts, 'evil.index') }
      const run = (...a: string[]): string => execFileSync('git', ['-c', 'core.protectNTFS=false', '-c', 'user.name=Evil', '-c', 'user.email=evil@x.local', ...a], { cwd: root, env, encoding: 'utf8' }).trim()
      run('read-tree', tip)
      run('update-index', '--add', '--cacheinfo', `100644,${blob},${alias}/pwned`)
      const evil = run('commit-tree', run('write-tree'), '-p', tip, '-m', 'planted alias')
      git(root, 'update-ref', `refs/heads/${wt.branch}`, evil)
      return { behavior: 'merge' as const, sha: evil }
    })
    // The attack was in place: the global config now has the protections off.
    expect(readFileSync(join(home, '.gitconfig'), 'utf8').toLowerCase()).toContain('protectntfs = false')
    // And nothing was written under the real .git: git refused the merge, or it landed without writing through the alias.
    expect(existsSync(join(root, '.git', 'pwned')), `${res.message}`).toBe(false)
    expect(existsSync(join(root, '.git', 'objects', 'pwned'))).toBe(false)
    expect(readdirSync(join(root, '.git')).filter((n) => n.toLowerCase().includes('pwned'))).toEqual([])
    // With the write protections forced on, git refuses a tree with such a name (while the attributes are read, or in the merge).
    if (alias !== '.git.' && alias !== 'GIT~1') {
      expect(res.info.status, res.message).toBe('conflict')
      expect(res.message).toMatch(/could not read the attributes|could not be merged automatically/)
    }
  }, 60_000)

  it('the guarded runner forces core.protectNTFS and core.protectHFS to true, whatever the repository config says', async () => {
    git(root, 'config', 'core.protectNTFS', 'false')
    git(root, 'config', 'core.protectHFS', 'false')
    expect((await gitGuarded(root, ['config', '--get', 'core.protectNTFS'])).out).toBe('true')
    expect((await gitGuarded(root, ['config', '--get', 'core.protectHFS'])).out).toBe('true')
  })

  it('a test command that rewrites the global identity and line-ending settings does not change what the merge uses', async () => {
    await prepareRepo(root)
    git(root, 'config', '--unset', 'user.name')
    git(root, 'config', '--unset', 'user.email')
    git(root, 'config', '--unset', 'core.autocrlf')
    writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Before Person\n\temail = before@example.test\n[core]\n\tautocrlf = true\n')
    useGlobalHome()
    put(root, 'src/crlf.txt', 'a\r\nb\r\nc\r\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'crlf file')
    const wt = addWorktree('h1b', { 'src/crlf.txt': 'a\r\nb2\r\nc\r\n' })
    const later = new Date(Date.now() + 5000)
    utimesSync(join(root, 'src/crlf.txt'), later, later)
    // Repository code run as the user edits the global config while the tests run.
    const g = integrator('git config --global core.autocrlf false && git config --global user.name "Evil Person" && git config --global user.email evil@example.test')
    const out = await g.i.integratePending(wt)
    expect(readFileSync(join(home, '.gitconfig'), 'utf8')).toContain('Evil Person')
    // The merge used the snapshot read before the command: autocrlf=true (the CRLF file is not read as edited) and the old identity.
    expect(out, out).toMatch(/Merged worktree-agent-h1b/)
    expect(execFileSync('git', ['log', '-1', '--format=%an <%ae>'], { cwd: root, encoding: 'utf8' }).trim()).toBe('Before Person <before@example.test>')
  }, 60_000)

  it('the same with a review card: the snapshot taken before the command is the one used', async () => {
    await prepareRepo(root)
    git(root, 'config', '--unset', 'user.name')
    git(root, 'config', '--unset', 'user.email')
    writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Before Person\n\temail = before@example.test\n')
    useGlobalHome()
    const wt = addWorktree('h1c')
    const g = integrator('git config --global user.name "Evil Person"', true)
    const out = await g.i.integratePending(wt)
    expect(out, out).toMatch(/Merged worktree-agent-h1c/)
    expect(execFileSync('git', ['log', '-1', '--format=%an'], { cwd: root, encoding: 'utf8' }).trim()).toBe('Before Person')
  }, 60_000)

  it('review round 2 keeps the first snapshot: a round-1 command that moves the tip and rewrites the global settings gets a refusal, never the rewritten values', async () => {
    await prepareRepo(root)
    git(root, 'config', '--unset', 'user.name')
    git(root, 'config', '--unset', 'user.email')
    writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Before Person\n\temail = before@example.test\n[core]\n\tautocrlf = false\n')
    useGlobalHome()
    const wt = addWorktree('h1r2')
    const script = join(scripts, 'round1.js')
    writeFileSync(
      script,
      "const { execFileSync } = require('child_process'), fs = require('fs'), p = require('path');\n" +
        "const marker = p.join(process.argv[2], 'ran'); if (fs.existsSync(marker)) process.exit(0); fs.writeFileSync(marker, '1');\n" +
        "const g = (a) => execFileSync('git', a, { stdio: 'ignore' });\n" +
        "g(['config', '--global', 'user.name', 'Evil Person']); g(['config', '--global', 'core.autocrlf', 'true']);\n" +
        "g(['-c', 'user.name=T', '-c', 'user.email=t@x.test', 'commit', '--allow-empty', '-q', '-m', 'moved by the tests']);\n"
    )
    const g = integrator(`node "${script}" "${scripts}"`, true)
    const out = await g.i.integratePending(wt)
    expect(readFileSync(join(home, '.gitconfig'), 'utf8')).toContain('Evil Person')
    expect(out).toMatch(/git settings .* changed while the tests ran/)
    expect(out).not.toMatch(/Merged worktree-agent-h1r2/)
    expect(git(root, 'log', '-1', '--format=%an')).not.toBe('Evil Person')
  }, 60_000)

  /** Remove a key from the repository's own config (a fresh Windows repo carries filemode and symlinks there). */
  function unsetLocal(...keys: string[]): void {
    for (const k of keys) {
      try {
        git(root, 'config', '--unset', k)
      } catch {
        /* not set */
      }
    }
  }

  it('carries exactly the allowed keys with validated values: no protectNTFS/HFS, no other setting, no safe.directory text from config', async () => {
    unsetLocal('user.name', 'user.email', 'core.autocrlf', 'core.filemode', 'core.symlinks', 'core.eol', 'core.safecrlf')
    writeFileSync(
      join(home, '.gitconfig'),
      [
        '[core]',
        '\tprotectNTFS = false',
        '\tprotectHFS = false',
        '\tautocrlf = input',
        '\teol = CRLF',
        '\tsafecrlf = warn',
        '\tfilemode = off',
        '\tsymlinks = yes',
        '\tfsmonitor = evil',
        '\thooksPath = /tmp/evil',
        '\tignorecase = true',
        '\tlongpaths = true',
        '[user]',
        '\tname = Some Person',
        '\temail = some@example.test',
        '[safe]',
        '\tdirectory = /somewhere/else',
        '\tdirectory = *',
        '[commit]',
        '\tgpgsign = true',
        ''
      ].join('\n')
    )
    useGlobalHome()
    const args = await mergeCarriedConfigArgs(root)
    expect(args.filter((_, i) => i % 2 === 0).every((a) => a === '-c')).toBe(true)
    expect(args.filter((_, i) => i % 2 === 1).sort()).toEqual(
      [
        'core.autocrlf=input',
        'core.eol=crlf',
        'core.safecrlf=warn',
        'core.filemode=false',
        'core.symlinks=true',
        'user.name=Some Person',
        'user.email=some@example.test',
        // "*" in the user's config trusts the folder: the path OrgAI computed is passed, never the config's text.
        `safe.directory=${root}`
      ].sort()
    )
    expect(args.join(' ').toLowerCase()).not.toContain('protectntfs')
    expect(args.join(' ')).not.toContain('/somewhere/else')
    expect(args.join(' ')).not.toContain('evil')
  })

  it('values outside the allowed ones are dropped, and safe.directory is not passed when config does not trust the folder', async () => {
    unsetLocal('user.name', 'user.email', 'core.autocrlf', 'core.filemode', 'core.symlinks', 'core.eol', 'core.safecrlf')
    writeFileSync(join(home, '.gitconfig'), '[core]\n\tautocrlf = maybe\n\teol = weird\n\tfilemode = sometimes\n[user]\n\tname = Only Name\n[safe]\n\tdirectory = /not/this/one\n')
    useGlobalHome()
    const args = (await mergeCarriedConfigArgs(root)).join(' ')
    // (A stock Git for Windows system config may still carry core.symlinks / core.autocrlf of its own; the global ones above are junk.)
    expect(args).not.toMatch(/core\.eol|core\.filemode|Only Name|safe\.directory|maybe|weird|sometimes/)
  })

  it('a value the repository\'s own config sets is not copied onto the command line (it would override the repository)', async () => {
    unsetLocal('user.name', 'user.email')
    git(root, 'config', 'core.autocrlf', 'false')
    writeFileSync(join(home, '.gitconfig'), '[core]\n\tautocrlf = true\n')
    useGlobalHome()
    expect((await mergeCarriedConfigArgs(root)).join(' ')).not.toContain('core.autocrlf')
  })
})

describe('M1: the ledger records only the move OrgAI\'s own merge made', () => {
  it('a ref moved by someone else between the gate and the merge is not recorded as OrgAI\'s, and the chain check reports it', async () => {
    await prepareRepo(root)
    const wt = addWorktree('m1a')
    const pin = await pinRoot(root)
    // The gate's verify step runs under the lock just before the merge: a plumbing commit lands in that window (another
    // report's test command, `git -C <root> commit`).
    const res = await integrateWorktree(root, { ...wt, status: 'merging' }, 'M1A', async (_files, tip) => ({
      behavior: 'merge' as const,
      sha: tip,
      verify: async () => {
        git(root, 'commit', '--allow-empty', '-q', '-m', 'landed in the window')
        return undefined
      }
    }))
    expect(res.info.status, res.message).toBe('merged')
    expect(git(root, 'log', '--format=%s').split(/\r?\n/)).toContain('landed in the window')
    expect((await rootVerdict(root, pin)).kind).toBe('folder')
    expect(await rootDrift(root, pin)).toMatch(/Not merged: while the project's tests ran/)
  })

  it('a merge that nobody interfered with is still recorded: a pin taken before it reads as OrgAI\'s own', async () => {
    await prepareRepo(root)
    const wt = addWorktree('m1b')
    const pin = await pinRoot(root)
    const res = await integrateWorktree(root, { ...wt, status: 'merging' }, 'M1B')
    expect(res.info.status, res.message).toBe('merged')
    const v = await rootVerdict(root, pin)
    expect(v.kind, JSON.stringify({ v, pin, now: await pinRoot(root) })).toBe('orgai')
  })

  it('mergeMadeMove: a merge commit whose parents are the HEAD read before and the merged sha; or a fast-forward to that sha', async () => {
    const base = headOf(root)
    git(root, 'checkout', '-q', '-b', 'side')
    put(root, 'side.txt', 's\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'side')
    const side = headOf(root)
    git(root, 'checkout', '-q', 'main')
    const state = (head: string) => ({ head, branch: 'refs/heads/main' })
    // Fast-forward: HEAD is the merged sha and the old HEAD is its ancestor.
    expect(await mergeMadeMove(root, state(base), state(side), side)).toBe(true)
    // Not the sha that was merged, or the old HEAD is not a parent: not OrgAI's.
    expect(await mergeMadeMove(root, state(base), state(side), base)).toBe(false)
    git(root, 'merge', '--no-ff', '-q', '-m', 'merge side', 'side')
    const merged = headOf(root)
    expect(await mergeMadeMove(root, state(base), state(merged), side)).toBe(true)
    // Somebody's commit in between: the first parent is not the HEAD OrgAI read.
    expect(await mergeMadeMove(root, state(side), state(merged), side)).toBe(false)
    expect(await mergeMadeMove(root, state(base), state(merged), base)).toBe(false)
    // Different branch, no movement, unborn: never.
    expect(await mergeMadeMove(root, { head: base, branch: 'refs/heads/other' }, state(merged), side)).toBe(false)
    expect(await mergeMadeMove(root, state(merged), state(merged), side)).toBe(false)
    expect(await mergeMadeMove(root, { head: 'none', branch: 'detached' }, state(merged), side)).toBe(false)
  })

  it('the switch to mainBranch records the exact commits it checked out: the chain from a pin before it is unbroken', async () => {
    await prepareRepo(root)
    git(root, 'branch', 'trunk')
    git(root, 'checkout', '-q', '-b', 'feature')
    const was = headOf(root)
    const wt = addWorktree('m1c')
    const pin = await pinRoot(root)
    const res = await integrateWorktree(root, { ...wt, status: 'merging' }, 'M1C', undefined, { mainBranch: 'trunk' })
    expect(res.info.status, res.message).toBe('merged')
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('trunk')
    expect(pin.head).toBe(was)
    expect((await rootVerdict(root, pin)).kind).toBe('orgai')
  })
})

describe('M2: the re-ask shows what changed in the project folder', () => {
  async function withUserChange(during: () => void) {
    await prepareRepo(root)
    const wt = addWorktree('n1')
    const go = join(scripts, 'go')
    const g = integrator(waitCommand('n', norm(go)), true)
    const run = g.i.integratePending(wt)
    await until(() => existsSync(join(scripts, 'started-n')))
    during()
    writeFileSync(go, '1')
    const out = await run
    return { g, out }
  }

  it('gives the root\'s own diff --stat, bounded plain text labelled as the repository\'s, and says approving merges on top of that change', async () => {
    const { g, out } = await withUserChange(() => {
      put(root, 'notes/user-added.txt', 'one\ntwo\n')
      writeFileSync(join(root, 'package.json'), '{"name":"edited by the user"}\n')
      // A subject with a bidi override and an escape character, as repository text can carry.
      git(root, 'add', 'notes/user-added.txt')
      git(root, 'commit', '-q', '-m', `evil${String.fromCodePoint(0x202e)} subject${String.fromCodePoint(0x1b)}[31m red`)
      writeFileSync(join(root, 'package.json'), '{"name":"edited again, uncommitted"}\n')
    })
    expect(out).toMatch(/Merged worktree-agent-n1/)
    expect(g.ctx.requestMergeReview).toHaveBeenCalledTimes(2)
    const note = vi.mocked(g.ctx.requestMergeReview).mock.calls[1]![0].stat
    expect(note).toContain('The project folder changed while the tests ran')
    expect(note).toContain('tracked files or staged changes differ')
    expect(note).toMatch(/project folder itself changed while the tests ran/i)
    expect(note).toMatch(/if you approve, OrgAI merges the report on top of that change/i)
    expect(note).toMatch(/text from the repository .*not from OrgAI/i)
    // The commits' own change, and the uncommitted one, as git's own stat.
    expect(note).toMatch(/notes\/user-added\.txt\s+\|\s+2 \+\+/)
    expect(note).toMatch(/package\.json\s+\|/)
    expect(note).toContain('subject')
    // Control and bidi characters of the commit subject are gone.
    const hidden = [...note].filter((ch) => {
      const c = ch.codePointAt(0) ?? 0
      return (c < 0x20 && c !== 0x0a) || (c >= 0x7f && c <= 0x9f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)
    })
    expect(hidden).toEqual([])
  }, 60_000)

  it('is bounded: a folder change of many files lists a few lines of stat and says how many more', async () => {
    const { g } = await withUserChange(() => {
      for (let i = 0; i < 60; i++) put(root, `bulk/file-${String(i).padStart(2, '0')}.txt`, 'x\n')
      git(root, 'add', '-A')
      git(root, 'commit', '-q', '-m', 'many files')
    })
    const note = vi.mocked(g.ctx.requestMergeReview).mock.calls[1]![0].stat
    expect(note).toContain('bulk/file-00.txt')
    expect(note).not.toContain('bulk/file-59.txt')
    expect(note).toMatch(/more line/)
    expect(Buffer.byteLength(note, 'utf8')).toBeLessThan(6000)
  }, 60_000)
})

describe('M4: filters (git-lfs and other clean/smudge programs)', () => {
  it('an attribute filter on a file the merge changes refuses the automatic merge with a plain reason, and the branch is kept', async () => {
    await prepareRepo(root)
    put(root, '.gitattributes', '*.dat filter=lfs diff=lfs -text\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'lfs attributes')
    const wt = addWorktree('f1', { 'src/big.dat': 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n', 'src/small.js': 'export const s = 1\n' })
    const res = await integrateWorktree(root, { ...wt, status: 'merging' }, 'F1')
    expect(res.info.status).toBe('conflict')
    expect(res.message).toMatch(/Not merged: a filter is set for src\/big\.dat \(filter=lfs\)/)
    expect(res.message).toContain('Merge it by hand')
    expect(res.message).toContain('the branch is kept')
    expect(existsSync(wt.path)).toBe(true)
    expect(existsSync(join(root, 'src/big.dat'))).toBe(false)
    expect(existsSync(join(root, 'src/small.js'))).toBe(false)
  })

  it('a filter attribute the merged commit itself adds is refused too; a filter on files the merge does not touch is not', async () => {
    await prepareRepo(root)
    const wt = addWorktree('f2', { '.gitattributes': 'src/*.js filter=custom\n', 'src/f2.js': 'export const f2 = 1\n' })
    const res = await integrateWorktree(root, { ...wt, status: 'merging' }, 'F2')
    expect(res.info.status).toBe('conflict')
    expect(res.message).toMatch(/filter is set for src\/f2\.js \(filter=custom\)/)
    // Not touching the filtered files: merges as always.
    put(root, '.gitattributes', '*.dat filter=lfs\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'attrs')
    const wt2 = addWorktree('f3')
    const res2 = await integrateWorktree(root, { ...wt2, status: 'merging' }, 'F3')
    expect(res2.info.status, res2.message).toBe('merged')
  })

  it('with a repository filter driver the pin still reads HEAD, the index and the staged changes, so parallel OrgAI merges chain', async () => {
    git(root, 'config', 'filter.lfsish.clean', 'cat')
    git(root, 'config', 'filter.lfsish.smudge', 'cat')
    const pin = await pinRoot(root)
    expect(pin.worktree).toBe('not pinned')
    for (const k of ['head', 'index', 'changes', 'config', 'hooks'] as const) expect(pin[k], k).not.toMatch(/^unreadable:/)
    await prepareRepo(root)
    const a = addWorktree('p1')
    const b = addWorktree('p2')
    const one = integrator(waitCommand('a', `${norm(scripts)}/started-b`))
    const two = integrator(waitCommand('b', `${norm(root)}/src/p1.js`))
    const [ra, rb] = await Promise.all([one.i.integratePending(a), two.i.integratePending(b)])
    expect(ra).toMatch(/Merged worktree-agent-p1/)
    expect(rb).toMatch(/Merged worktree-agent-p2/)
    expect(two.logs().some((l) => l.includes('another merge into') && l.includes('tests ran'))).toBe(true)
  }, 90_000)
})

describe('Lows', () => {
  it('a renamed file is looked up under both names: an attribute on the old name refuses the merge', async () => {
    put(root, 'src/old.js', 'export const old = 1\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'old')
    await prepareRepo(root)
    const rel = '.claude/worktrees/agent-r1'
    git(root, 'worktree', 'add', '-q', '-b', 'worktree-agent-r1', rel)
    git(join(root, rel), 'mv', 'src/old.js', 'src/new.js')
    git(join(root, rel), 'commit', '-q', '-m', 'rename')
    // The attribute sits on the OLD name only (an untracked .gitattributes in the root).
    put(root, '.gitattributes', 'src/old.js merge=union\n')
    const res = await integrateWorktree(root, { path: join(root, rel), branch: 'worktree-agent-r1', status: 'merging' }, 'R1')
    expect(res.info.status).toBe('conflict')
    expect(res.message).toMatch(/src\/old\.js \(merge=union\)/)
    expect(existsSync(join(root, 'src/new.js'))).toBe(false)
    // Directly: the changed-file list names only the new path, the check adds the old one.
    expect(await mergeAttributeRefusal(root, git(root, 'rev-parse', 'worktree-agent-r1'), ['src/new.js'])).toMatch(/src\/old\.js \(merge=union\)/)
  })

  it('the scratch index lives under one OrgAI temp folder, is gone after a check, and a stale one a crash left is swept', async () => {
    const dir = mergeScratchDir()
    expect(dir).toContain('orgai-merge-scratch')
    await mergeAttributeRefusal(root, headOf(root), ['src/app.js'])
    expect(existsSync(dir) ? readdirSync(dir).filter((n) => /\.index/.test(n)) : []).toEqual([])
    // A crash left an index and its lock; another process's fresh one must stay.
    mkdirSync(dir, { recursive: true })
    const stale = join(dir, 'crash-left.index')
    const staleLock = join(dir, 'crash-left.index.lock')
    const fresh = join(dir, 'in-use-now.index')
    for (const f of [stale, staleLock, fresh]) writeFileSync(f, 'x')
    const old = new Date(Date.now() - 60 * 60_000)
    utimesSync(stale, old, old)
    utimesSync(staleLock, old, old)
    expect(sweepMergeScratch()).toBe(2)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(staleLock)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    rmSync(fresh, { force: true })
  })
})
