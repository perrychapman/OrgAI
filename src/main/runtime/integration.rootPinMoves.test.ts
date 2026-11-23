import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentInstance, WorktreeInfo } from '@shared/types'
import { WorktreeIntegrator } from './integration'
import { guardedGitEnv, integrateWorktree, mergeAttributeRefusal, prepareRepo } from './worktrees'
import { attributeDirsOf, fileDigest, pinRoot, rootDrift, rootVerdict } from './rootPin'
import { resetOrgAiMoves } from './orgaiMoves'
import { fakeCtx, project } from './testHelpers'

vi.mock('../log', () => ({ logRunEvent: () => {}, logPermission: () => {}, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

// Third pass, R2 and S2, against real git and the real test gate (no mocks):
// - OrgAI's own merges that land while a test command runs (parallel reports) are not drift;
// - the user's commit while the tests ran is asked about once more (with a review card) or refused (without), never kept silently;
// - the merge ignores the user's global git config and attributes, and refuses an attribute-selected merge driver.

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

/** A test command that says it started (a file in `dir`) and then waits for a file to exist, or not at all ('none'). */
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
const waitCommand = (id: string, waitFor: string): string => `node "${waiter()}" "${scripts}" ${id} "${waitFor === 'none' ? 'none' : waitFor}"`

/** A command that edits the checkout through the shared git folder (repository code that misbehaves). */
function script(name: string, body: string): string {
  const path = join(scripts, name)
  writeFileSync(path, `const { execFileSync } = require('node:child_process'); const fs = require('node:fs'); const path = require('node:path'); const root = process.argv[2];\nconst git = (...a) => execFileSync('git', ['-c', 'user.name=Evil', '-c', 'user.email=evil@x.local', '-C', root, ...a], { stdio: 'ignore' });\n${body}\n`)
  return `node "${path}" "${root}"`
}

const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  resetOrgAiMoves()
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-moves-')))
  scripts = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-moves-scripts-')))
  home = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-moves-home-')))
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

const mergesOf = (): number => git(root, 'log', '--merges', '--format=%H').split(/\r?\n/).filter(Boolean).length

describe('OrgAI\'s own merges while the tests ran are not drift (R2)', () => {
  it('two reports finishing together both merge: the second one\'s tests end after the first one merged into the same checkout', async () => {
    await prepareRepo(root)
    const a = addWorktree('pa')
    const b = addWorktree('pb')
    const one = integrator(waitCommand('a', `${norm(scripts)}/started-b`))
    // B ends its tests only after A's merge landed, so its HEAD moved under it while its command ran.
    const two = integrator(waitCommand('b', `${norm(root)}/src/pa.js`))
    const [ra, rb] = await Promise.all([one.i.integratePending(a), two.i.integratePending(b)])
    expect(ra).toMatch(/Merged worktree-agent-pa/)
    expect(rb).toMatch(/Merged worktree-agent-pb/)
    expect(existsSync(join(root, 'src/pa.js'))).toBe(true)
    expect(existsSync(join(root, 'src/pb.js'))).toBe(true)
    expect(mergesOf()).toBe(2)
    expect(two.logs().some((l) => l.includes('another merge into') && l.includes('tests ran'))).toBe(true)
  }, 90_000)

  it('the same with a review card: the second report is not asked again', async () => {
    await prepareRepo(root)
    const a = addWorktree('ra')
    const b = addWorktree('rb')
    const one = integrator(waitCommand('a', `${norm(scripts)}/started-b`), true)
    const two = integrator(waitCommand('b', `${norm(root)}/src/ra.js`), true)
    const [ra, rb] = await Promise.all([one.i.integratePending(a), two.i.integratePending(b)])
    expect(ra).toMatch(/Merged/)
    expect(rb).toMatch(/Merged/)
    expect(two.ctx.requestMergeReview).toHaveBeenCalledTimes(1)
  }, 90_000)

  it('a user commit between two OrgAI merges breaks the chain: it is not explained by OrgAI', async () => {
    await prepareRepo(root)
    const a = addWorktree('ca')
    const pin = await pinRoot(root)
    // OrgAI merges A, then the user commits, then OrgAI merges B: the second merge starts from a HEAD the first did not make.
    const first = await integrateWorktree(root, { ...a, status: 'merging' }, 'A')
    expect(first.info.status, first.message).toBe('merged')
    git(root, 'commit', '--allow-empty', '-q', '-m', 'user')
    const b = addWorktree('cb')
    const second = await integrateWorktree(root, { ...b, status: 'merging' }, 'B')
    expect(second.info.status, second.message).toBe('merged')
    const v = await rootVerdict(root, pin)
    expect(v.kind).toBe('folder')
    expect(await rootDrift(root, pin)).toMatch(/Not merged: while the project's tests ran/)
    // Whereas OrgAI's merges alone are explained.
    const pin2 = await pinRoot(root)
    const c = addWorktree('cc')
    const third = await integrateWorktree(root, { ...c, status: 'merging' }, 'C')
    expect(third.info.status, third.message).toBe('merged')
    expect((await rootVerdict(root, pin2)).kind).toBe('orgai')
    expect(await rootDrift(root, pin2)).toBeUndefined()
  })

  it('OrgAI\'s merges do not hide an edit of a tracked file made as well', async () => {
    await prepareRepo(root)
    const a = addWorktree('ea')
    const pin = await pinRoot(root)
    const first = await integrateWorktree(root, { ...a, status: 'merging' }, 'A')
    expect(first.info.status, first.message).toBe('merged')
    expect((await rootVerdict(root, pin)).kind).toBe('orgai')
    writeFileSync(join(root, 'package.json'), '{"name":"edited"}\n')
    const v = await rootVerdict(root, pin)
    expect(v.kind).toBe('folder')
    if (v.kind === 'folder') expect(v.labels).toEqual(['its tracked files'])
  })
})

describe('the user changed the project folder while the tests ran (R2)', () => {
  /** Runs the gate with a command that waits for "go"; `during` acts on the folder meanwhile (the user). */
  async function withUserChange(review: boolean, during: () => void, answers?: ('merge' | 'hold' | 'discard')[]) {
    await prepareRepo(root)
    const wt = addWorktree('u1')
    const go = join(scripts, 'go')
    const g = integrator(waitCommand('u', norm(go)), review)
    if (answers) {
      let n = 0
      vi.mocked(g.ctx.requestMergeReview).mockImplementation(async () => ({ behavior: answers[Math.min(n++, answers.length - 1)] }))
    }
    const run = g.i.integratePending(wt)
    await until(() => existsSync(join(scripts, 'started-u')))
    during()
    writeFileSync(go, '1')
    return { wt, g, out: await run }
  }

  it('with a review card, a commit by the user during the tests asks the user once more, with the reason and the new commit, then merges', async () => {
    const { g, out, wt } = await withUserChange(true, () => git(root, 'commit', '--allow-empty', '-q', '-m', 'user work in the folder'))
    expect(g.ctx.requestMergeReview).toHaveBeenCalledTimes(2)
    const second = vi.mocked(g.ctx.requestMergeReview).mock.calls[1]![0]
    expect(second.stat).toContain('The project folder changed while the tests ran')
    expect(second.stat).toContain('user work in the folder')
    expect(second.checks).toMatchObject({ tests: 'passed' })
    expect(out).toMatch(/Merged worktree-agent-u1/)
    expect(existsSync(join(root, 'src/u1.js'))).toBe(true)
    expect(git(root, 'log', '--format=%s').split(/\r?\n/)).toContain('user work in the folder')
    expect(existsSync(wt.path)).toBe(false)
    expect(g.logs().some((l) => l.startsWith('warn:') && l.includes('project folder changed while the tests ran'))).toBe(true)
  }, 60_000)

  it('the user can decline the second question: nothing is merged and the copy is kept on hold', async () => {
    const { g, out, wt } = await withUserChange(true, () => git(root, 'commit', '--allow-empty', '-q', '-m', 'user work'), ['merge', 'hold'])
    expect(g.ctx.requestMergeReview).toHaveBeenCalledTimes(2)
    expect(out).toMatch(/holding worktree-agent-u1 for later review|not merged/i)
    expect(existsSync(join(root, 'src/u1.js'))).toBe(false)
    expect(existsSync(wt.path)).toBe(true)
  }, 60_000)

  it('an edit of a tracked file by the user asks as well (a staged change too)', async () => {
    const { g, out } = await withUserChange(true, () => writeFileSync(join(root, 'package.json'), '{"name":"user edit"}\n'))
    expect(g.ctx.requestMergeReview).toHaveBeenCalledTimes(2)
    expect(vi.mocked(g.ctx.requestMergeReview).mock.calls[1]![0].stat).toContain('tracked files or staged changes differ')
    expect(out).toMatch(/Merged/)
  }, 60_000)

  it('without a review card nobody can be asked: the merge is refused with a plain reason and the copy is kept', async () => {
    const { g, out, wt } = await withUserChange(false, () => git(root, 'commit', '--allow-empty', '-q', '-m', 'user work'))
    expect(out).toMatch(/Not merged: while the project's tests ran, its HEAD commit of .* changed/)
    expect(out).toContain('cannot tell its changes from yours')
    expect(g.ctx.requestMergeReview).not.toHaveBeenCalled()
    expect(existsSync(wt.path)).toBe(true)
    expect(existsSync(join(root, 'src/u1.js'))).toBe(false)
  }, 60_000)

  it('a change to the repository config is refused even with a review card, and nobody is asked again', async () => {
    const { g, out } = await withUserChange(true, () => git(root, 'config', 'alias.zz', 'status'))
    expect(out).toMatch(/Not merged: .*the repository config/)
    expect(g.ctx.requestMergeReview).toHaveBeenCalledTimes(1)
    expect(existsSync(join(root, 'src/u1.js'))).toBe(false)
  }, 60_000)

  it('a test command that commits on the root is still refused (no review card)', async () => {
    await prepareRepo(root)
    const wt = addWorktree('tc')
    const g = integrator(script('commit.js', "git('commit', '--allow-empty', '-q', '-m', 'planted')"))
    const out = await g.i.integratePending(wt)
    expect(out).toMatch(/Not merged: while the project's tests ran, its HEAD commit of .* changed/)
    expect(existsSync(wt.path)).toBe(true)
    expect(existsSync(join(root, 'src/tc.js'))).toBe(false)
  }, 60_000)

  it('a command that plants an untracked .gitattributes in the root is refused, with or without a card', async () => {
    for (const review of [false, true]) {
      resetOrgAiMoves()
      await prepareRepo(root)
      const id = review ? 'ar' : 'an'
      const wt = addWorktree(id)
      const g = integrator(script(`attr-${id}.js`, "fs.writeFileSync(path.join(root, '.gitattributes'), '*.js merge=union\\n')"), review)
      const out = await g.i.integratePending(wt)
      expect(out, `review ${review}`).toMatch(/Not merged: .*its untracked \.gitattributes files/)
      expect(existsSync(join(root, `src/${id}.js`))).toBe(false)
      rmSync(join(root, '.gitattributes'), { force: true })
    }
  }, 90_000)
})

describe('the merge ignores the user\'s global git setup and refuses an attribute-selected driver (S2)', () => {
  function useHome(): void {
    for (const k of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) saved[k] = process.env[k]
    delete process.env.GIT_CONFIG_GLOBAL
    process.env.HOME = process.env.USERPROFILE = process.env.XDG_CONFIG_HOME = home
  }

  it('a merge driver and an attributes file in the global config do not run on the merge: the content is the plain text merge', async () => {
    await prepareRepo(root)
    put(root, 'src/multi.js', ['one', 'two', 'three', 'four', 'five', ''].join('\n'))
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'multi')
    const wt = addWorktree('g1', { 'src/multi.js': ['one', 'two', 'three', 'four', 'FIVE', ''].join('\n') })
    put(root, 'src/multi.js', ['ONE', 'two', 'three', 'four', 'five', ''].join('\n'))
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'main edits line one')
    // The user's global config: a driver, and a global attributes file that selects it for every .js file.
    const marker = join(scripts, 'driver-ran.txt')
    const driver = join(scripts, 'driver.js')
    writeFileSync(driver, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); require('fs').writeFileSync(process.argv[2], 'OWNED\\n')\n`)
    writeFileSync(join(home, 'attrs'), '*.js merge=owned\n')
    writeFileSync(join(home, '.gitconfig'), `[merge "owned"]\n\tdriver = node ${norm(driver)} %A\n[core]\n\tattributesFile = ${norm(join(home, 'attrs'))}\n`)
    useHome()
    // (Checked by hand: with the merge's isolation switched off, git runs the driver here and the marker appears.)
    const res = await integrateWorktree(root, { ...wt, status: 'merging' }, 'G1')
    expect(res.info.status, res.message).toBe('merged')
    expect(existsSync(marker)).toBe(false)
    expect(readFileSync(join(root, 'src/multi.js'), 'utf8').replace(/\r\n/g, '\n')).toBe(['ONE', 'two', 'three', 'four', 'FIVE', ''].join('\n'))
  })

  it('the merge commit keeps the user\'s own identity from the global config (read separately, not through the merge)', async () => {
    await prepareRepo(root)
    const wt = addWorktree('i1')
    git(root, 'config', '--unset', 'user.name')
    git(root, 'config', '--unset', 'user.email')
    writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Global Person\n\temail = global@example.test\n')
    useHome()
    const res = await integrateWorktree(root, { ...wt, status: 'merging' }, 'I1')
    expect(res.info.status, res.message).toBe('merged')
    expect(execFileSync('git', ['log', '-1', '--format=%an <%ae>'], { cwd: root, encoding: 'utf8', env: { ...process.env } }).trim()).toBe('Global Person <global@example.test>')
  })

  it('the line-ending setting of the user\'s global config still reaches the merge: a CRLF checkout is not read as edited', async () => {
    // A stock Git for Windows has core.autocrlf on in its system config; ignoring it would make every CRLF file look edited and
    // the merge would refuse to overwrite it ("Your local changes ... would be overwritten").
    await prepareRepo(root)
    git(root, 'config', '--unset', 'core.autocrlf')
    writeFileSync(join(home, '.gitconfig'), '[core]\n\tautocrlf = true\n')
    useHome()
    put(root, 'src/crlf.txt', 'a\r\nb\r\nc\r\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'crlf file')
    const wt = addWorktree('cr1', { 'src/crlf.txt': 'a\r\nb2\r\nc\r\n' })
    // The file on disk is CRLF and the index holds LF; a new mtime makes git compare content, not stat data.
    const later = new Date(Date.now() + 5000)
    utimesSync(join(root, 'src/crlf.txt'), later, later)
    const res = await integrateWorktree(root, { ...wt, status: 'merging' }, 'CR1')
    expect(res.info.status, res.message).toBe('merged')
    expect(readFileSync(join(root, 'src/crlf.txt'), 'utf8')).toContain('b2')
  })

  it('merge=union selected by an untracked .gitattributes in the root is refused, and the copy is kept', async () => {
    await prepareRepo(root)
    const wt = addWorktree('x1')
    put(root, '.gitattributes', 'src/*.js merge=union\n')
    const res = await integrateWorktree(root, { ...wt, status: 'merging' }, 'X1')
    expect(res.info.status).toBe('conflict')
    expect(res.message).toMatch(/Not merged: a merge attribute selects a custom merge for src\/x1\.js \(merge=union\)/)
    expect(existsSync(wt.path)).toBe(true)
    expect(existsSync(join(root, 'src/x1.js'))).toBe(false)
  })

  it('a merge driver selected by .git/info/attributes is refused; so is one the branch\'s own .gitattributes adds', async () => {
    await prepareRepo(root)
    const wt = addWorktree('x2')
    writeFileSync(join(root, '.git', 'info', 'attributes'), 'src/*.js merge=evil\n')
    const res = await integrateWorktree(root, { ...wt, status: 'merging' }, 'X2')
    expect(res.info.status).toBe('conflict')
    expect(res.message).toContain('merge=evil')
    writeFileSync(join(root, '.git', 'info', 'attributes'), '')
    const wt2 = addWorktree('x3', { '.gitattributes': 'src/*.js merge=union\n', 'src/x3.js': 'export const x3 = 1\n' })
    const res2 = await integrateWorktree(root, { ...wt2, status: 'merging' }, 'X3')
    expect(res2.info.status).toBe('conflict')
    expect(res2.message).toMatch(/src\/x3\.js \(merge=union\)/)
    expect(existsSync(join(root, 'src/x3.js'))).toBe(false)
  })

  it('merge attributes that cannot change content (binary, text, unset) are not refused', async () => {
    await prepareRepo(root)
    put(root, '.gitattributes', 'src/*.js merge=binary\n*.txt -merge\n*.md merge=text\n')
    git(root, 'add', '.gitattributes')
    git(root, 'commit', '-q', '-m', 'attrs')
    const wt = addWorktree('x4')
    const res = await integrateWorktree(root, { ...wt, status: 'merging' }, 'X4')
    expect(res.info.status, res.message).toBe('merged')
    expect(await mergeAttributeRefusal(root, git(root, 'rev-parse', 'HEAD'), ['src/app.js', 'a.txt', 'b.md'])).toBeUndefined()
  })

  it('a failed attribute read refuses (it never passes)', async () => {
    expect(await mergeAttributeRefusal(join(root, 'does-not-exist'), 'deadbeef', ['a.js'])).toMatch(/could not read/)
  })
})

describe('the pin reads files without following or waiting on them (rootPin.ts)', () => {
  it('a missing file is "none"; a regular small file has a stable digest that follows its content', () => {
    const f = join(scripts, 'cfg')
    expect(fileDigest(f)).toBe('none')
    writeFileSync(f, 'a')
    const a = fileDigest(f)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(fileDigest(f)).toBe(a)
    writeFileSync(f, 'b')
    expect(fileDigest(f)).not.toBe(a)
  })

  it('a folder, and a file over the size cap, are unreadable: they never equal another reading, even themselves', () => {
    const dir = join(scripts, 'a-folder')
    mkdirSync(dir)
    expect(fileDigest(dir)).toMatch(/^unreadable:/)
    expect(fileDigest(dir)).not.toBe(fileDigest(dir))
    const big = join(scripts, 'big')
    writeFileSync(big, Buffer.alloc(4 * 1024 * 1024 + 1))
    const d = fileDigest(big)
    expect(d).toMatch(/^unreadable:/)
    expect(d).not.toBe(fileDigest(big))
  })

  it.skipIf(process.platform === 'win32')('a FIFO is never opened for reading (it would wait for a writer) and a symlink is not followed', () => {
    const fifo = join(scripts, 'fifo')
    execFileSync('mkfifo', [fifo])
    const t0 = Date.now()
    expect(fileDigest(fifo)).toMatch(/^unreadable:/)
    expect(Date.now() - t0).toBeLessThan(2000)
    const target = join(scripts, 'target')
    writeFileSync(target, 'x')
    const link = join(scripts, 'link')
    execFileSync('ln', ['-s', target, link])
    expect(fileDigest(link)).toMatch(/^unreadable:/)
  })

  it('a symlink is unreadable where the account may create one', () => {
    const target = join(scripts, 'target2')
    writeFileSync(target, 'x')
    const link = join(scripts, 'link2')
    try {
      symlinkSync(target, link)
    } catch {
      return // creating links needs a privilege on this machine
    }
    expect(fileDigest(link)).toMatch(/^unreadable:/)
  })

  it('a hook that is a symlink is recorded by its target: retargeting it is a change (and the git folder itself is not read through it)', async () => {
    const hook = join(root, '.git', 'hooks', 'pre-commit')
    mkdirSync(dirname(hook), { recursive: true })
    const t1 = join(scripts, 't1')
    const t2 = join(scripts, 't2')
    writeFileSync(t1, '#!/bin/sh\n')
    writeFileSync(t2, '#!/bin/sh\n')
    try {
      symlinkSync(t1, hook)
    } catch {
      return
    }
    const a = await pinRoot(root)
    rmSync(hook)
    symlinkSync(t2, hook)
    const b = await pinRoot(root)
    expect(b.hooks).not.toBe(a.hooks)
  })

  it('untracked .gitattributes of the root and of the folders a merge changes are pinned; tracked ones are not', async () => {
    expect(attributeDirsOf(['a.js', 'src/deep/b.js', 'src/c.js'])).toEqual(['', 'src', 'src/deep'])
    const dirs = attributeDirsOf(['src/x.js'])
    const a = await pinRoot(root, { attrDirs: dirs })
    put(root, 'src/.gitattributes', '*.js merge=union\n')
    const b = await pinRoot(root, { attrDirs: dirs })
    expect(b.attributes).not.toBe(a.attributes)
    // Tracked, it is reviewed content: not part of this pin.
    git(root, 'add', 'src/.gitattributes')
    git(root, 'commit', '-q', '-m', 'attrs')
    expect((await pinRoot(root, { attrDirs: dirs })).attributes).toBe(a.attributes)
    // A different folder is not looked at.
    const c = await pinRoot(root, { attrDirs: [''] })
    put(root, 'other/.gitattributes', 'x\n')
    expect((await pinRoot(root, { attrDirs: [''] })).attributes).toBe(c.attributes)
  })
})

describe('the guarded runner for a linked worktree (S2)', () => {
  it('drops inherited GIT_* variables and ignores replace objects, like a plain checkout', async () => {
    await prepareRepo(root)
    const wt = addWorktree('env1')
    for (const k of ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_DIR', 'GIT_INDEX_FILE']) saved[k] = process.env[k]
    process.env.GIT_AUTHOR_NAME = 'Inherited'
    process.env.GIT_COMMITTER_EMAIL = 'inherited@example.test'
    process.env.GIT_DIR = join(scripts, 'elsewhere')
    process.env.GIT_INDEX_FILE = join(scripts, 'elsewhere-index')
    const linked = guardedGitEnv(wt.path)
    expect(linked.GIT_NO_REPLACE_OBJECTS).toBe('1')
    for (const k of ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_DIR', 'GIT_INDEX_FILE']) expect(linked[k]).toBeUndefined()
    const plain = guardedGitEnv(root)
    expect(plain.GIT_NO_REPLACE_OBJECTS).toBe('1')
    expect(plain.GIT_AUTHOR_NAME).toBeUndefined()
  })
})
