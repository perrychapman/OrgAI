import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Project } from '../../shared/types'
import { resolveProject } from './resolveProject'

const proj = (id: string, path: string): Project => ({ id, path, name: id }) as unknown as Project
const noGit = (): undefined => undefined
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const temp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'rp-')))
  dirs.push(d)
  return d
}

describe('resolveProject', () => {
  it('the deepest project containing cwd wins (monorepo)', () => {
    const projects = [proj('root', '/repo'), proj('api', '/repo/packages/api')]
    expect(resolveProject(projects, { cwd: '/repo/packages/api/src', platform: 'linux', git: noGit })).toMatchObject({ project: { id: 'api' }, via: 'cwd' })
    expect(resolveProject(projects, { cwd: '/repo/packages/web', platform: 'linux', git: noGit })).toMatchObject({ project: { id: 'root' }, via: 'cwd' })
    expect(resolveProject(projects, { cwd: '/elsewhere', platform: 'linux', git: noGit })).toEqual({ via: 'none' })
  })

  it('finds an engagement folder without git, through every ancestor', () => {
    const base = temp()
    const deep = join(base, 'client', 'a', 'b', 'c')
    mkdirSync(deep, { recursive: true })
    const r = resolveProject([proj('eng', join(base, 'client'))], { cwd: deep, git: noGit })
    expect(r).toMatchObject({ project: { id: 'eng' }, via: 'cwd' })
  })

  it('--project by id and by path; unknown is an error', () => {
    const projects = [proj('p1', '/repo/one'), proj('p2', '/repo/two')]
    expect(resolveProject(projects, { flag: 'p2', cwd: '/', platform: 'linux', git: noGit })).toMatchObject({ project: { id: 'p2' }, via: 'flag' })
    expect(resolveProject(projects, { flag: '../one', cwd: '/repo/two', platform: 'linux', git: noGit })).toMatchObject({ project: { id: 'p1' }, via: 'flag' })
    expect(resolveProject(projects, { flag: 'zzz', cwd: '/', platform: 'linux', git: noGit })).toEqual({ via: 'flag', error: 'No OrgAI project matches zzz.' })
  })

  it('a symlinked cwd resolves through its real path', () => {
    const base = temp()
    mkdirSync(join(base, 'real', 'sub'), { recursive: true })
    symlinkSync(join(base, 'real'), join(base, 'link'))
    const r = resolveProject([proj('p', join(base, 'real'))], { cwd: join(base, 'link', 'sub'), git: noGit })
    expect(r).toMatchObject({ project: { id: 'p' } })
    // And a project stored through the link matches a real cwd.
    const r2 = resolveProject([proj('q', join(base, 'link'))], { cwd: join(base, 'real', 'sub'), git: noGit })
    expect(r2).toMatchObject({ project: { id: 'q' } })
  })

  it('folds case on darwin and win32, not on linux', () => {
    const projects = [proj('p', '/Users/Me/Repo')]
    const id = (x: string): string => x
    expect(resolveProject(projects, { cwd: '/users/me/repo/src', platform: 'darwin', git: noGit, canonical: id })).toMatchObject({ project: { id: 'p' } })
    expect(resolveProject(projects, { cwd: '/users/me/repo/src', platform: 'linux', git: noGit, canonical: id })).toEqual({ via: 'none' })
    expect(resolveProject([proj('w', 'C:\\Code\\App')], { cwd: 'c:\\code\\app\\x', platform: 'win32', git: noGit, canonical: id })).toMatchObject({
      project: { id: 'w' }
    })
  })

  it('a managed agent worktree resolves to the parent project with managedWorktree', () => {
    const projects = [proj('p', '/repo')]
    const git = (_cwd: string, args: string[]): string => (args.includes('--git-dir') ? '/repo/.git/worktrees/agent-x' : '/repo/.git')
    const r = resolveProject(projects, { cwd: '/repo/.claude/worktrees/agent-x/src', platform: 'linux', git })
    expect(r).toEqual({ project: projects[0], via: 'cwd', managedWorktree: { mainCheckout: '/repo' } })
    const r2 = resolveProject(projects, { cwd: '/repo/.claude/worktrees/agent-y', platform: 'linux', git: noGit })
    expect(r2).toMatchObject({ project: { id: 'p' }, managedWorktree: { mainCheckout: '/repo' } })
  })

  it.skipIf(process.platform === 'win32')('the default git runner asks about the folder with -C, from the temp dir (review H1)', () => {
    const base = temp()
    const repo = join(base, 'main')
    mkdirSync(repo)
    const run = (cwd: string, args: string[]): void => void execFileSync('git', args, { cwd, stdio: 'ignore' })
    run(repo, ['init', '-q'])
    run(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'])
    const wt = join(repo, '.claude', 'worktrees', 'agent-z')
    run(repo, ['worktree', 'add', '-q', '-b', 'wt-z', wt])
    // A different main checkout path from the lexical fallback would only come from git's answer.
    const r = resolveProject([proj('p', repo)], { cwd: wt })
    expect(r).toMatchObject({ project: { id: 'p' }, managedWorktree: { mainCheckout: realpathSync(repo) } })
  })
})
