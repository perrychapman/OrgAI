import { afterEach, describe, expect, it } from 'vitest'
import type { HostScope, PendingWorktree, Project } from '../../shared/types'
import { manageDeps } from '../manage'
import { resetSkewWarning } from '../runRef'
import { fakeContext, FakeHostClient, project, type Answer } from '../testing/fakeContext'
import { CliError } from '../types'
import { runWorktrees, worktreeDeps } from './worktrees'

const ALL: { grantedScopes: HostScope[] } = { grantedScopes: ['read', 'operate', 'decide', 'configure'] }
const realDeps = { ...manageDeps }
const realWt = { ...worktreeDeps }
afterEach(() => {
  Object.assign(manageDeps, realDeps)
  Object.assign(worktreeDeps, realWt)
  resetSkewWarning()
})

const P = project('p1', '/work', { name: 'App' })
const E = project('e1', '/work', { name: 'Client', kind: 'engagement' } as Partial<Project>)
const wt: PendingWorktree = {
  path: '/work/.claude/worktrees/agent-a1',
  branch: 'worktree-agent-a1',
  agentId: 'a1',
  exists: true,
  uncommittedFiles: 1,
  commitsAhead: 2,
  changedFiles: ['src/a.ts', 'src/b.ts'],
  lastSubject: 'Add a\x1b[2J'
}

function setup(answers: Record<string, Answer>, opts: { project?: Project; tty?: boolean; color?: boolean; cwd?: string; format?: 'text' | 'json' } = {}) {
  const client = new FakeHostClient({ 'projects:list': () => [opts.project ?? P], ...answers }, { hello: ALL })
  const f = fakeContext({ connect: [client], cwd: opts.cwd ?? '/work', stdinIsTTY: !!opts.tty, globals: { color: !!opts.color, outputFormat: opts.format ?? 'text' } })
  if (opts.tty) f.ctx.io.stdout.isTTY = true
  return { f, client }
}

async function exitOf(p: Promise<number>): Promise<number> {
  try {
    return await p
  } catch (e) {
    if (e instanceof CliError) return e.exitCode
    throw e
  }
}

describe('worktrees list', () => {
  it('shows branch, agent, files, commits ahead and state', async () => {
    const { f, client } = setup({ 'maintenance:listWorktrees': () => [wt] })
    expect(await runWorktrees(f.ctx, ['list'])).toBe(0)
    expect(client.callsOf('maintenance:listWorktrees')).toEqual([['p1']])
    expect(f.out()).toMatch(/worktree-agent-a1\s+a1\s+2\s+2\s+1 uncommitted/)
    expect(f.out()).not.toContain('\x1b')
  })

  it('works from inside a managed worktree (resolved to the main checkout) and in JSON', async () => {
    const { f } = setup({ 'maintenance:listWorktrees': () => [] }, { cwd: '/work/.claude/worktrees/agent-a1', format: 'json' })
    expect(await runWorktrees(f.ctx, ['list'])).toBe(0)
    expect(JSON.parse(f.out())).toMatchObject({ project: { id: 'p1' }, worktrees: [] })
  })
})

describe('worktrees diff', () => {
  const diff = { stat: ' a.ts | 1 +', patch: '+added \x1b]0;title\x07line\n-removed\x1b[2J\n' }

  it('plain sanitized text when stdout is not a terminal', async () => {
    const { f, client } = setup({ 'maintenance:diff': () => diff })
    expect(await runWorktrees(f.ctx, ['diff', 'worktree-agent-a1'])).toBe(0)
    expect(client.callsOf('maintenance:diff')).toEqual([[{ projectId: 'p1', branch: 'worktree-agent-a1' }]])
    expect(f.out()).toContain('+added line')
    expect(f.out()).not.toContain('\x1b')
  })

  it('on a colour terminal only trusted SGR colour remains', async () => {
    const { f } = setup({ 'maintenance:diff': () => diff }, { tty: true, color: true })
    expect(await runWorktrees(f.ctx, ['diff', 'worktree-agent-a1'])).toBe(0)
    expect(f.out()).toContain('\x1b[32m+added line\x1b[0m')
    expect(f.out()).not.toContain('\x1b]')
    expect(f.out()).not.toContain('\x1b[2J')
  })

  it('--pager hands the text to showInPager', async () => {
    let shown = ''
    worktreeDeps.showInPager = async (text) => ((shown = text), 'shown')
    const { f } = setup({ 'maintenance:diff': () => diff })
    expect(await runWorktrees(f.ctx, ['diff', 'worktree-agent-a1', '--pager'])).toBe(0)
    expect(shown).toContain('+added')
    expect(f.out()).toBe('')
  })

  it('refuses a branch with control characters before connecting', async () => {
    const { f } = setup({})
    expect(await exitOf(runWorktrees(f.ctx, ['diff', 'a\x1bb']))).toBe(2)
    expect(f.connectCalls).toEqual([])
  })
})

describe('worktrees merge / discard / uninstall', () => {
  it('a merge conflict is exit 1 with the host message', async () => {
    const { f } = setup({ 'maintenance:integrateWorktree': () => ({ ok: false, message: 'Conflict in README.md; the branch was kept.' }) })
    await expect(runWorktrees(f.ctx, ['merge', 'worktree-agent-a1'])).rejects.toMatchObject({ exitCode: 1, message: 'Conflict in README.md; the branch was kept.' })
  })

  it('a clean merge prints the message', async () => {
    const { f, client } = setup({ 'maintenance:integrateWorktree': () => ({ ok: true, message: 'Merged worktree-agent-a1.' }) })
    expect(await runWorktrees(f.ctx, ['merge', 'worktree-agent-a1'])).toBe(0)
    expect(client.callsOf('maintenance:integrateWorktree')).toEqual([[{ projectId: 'p1', branch: 'worktree-agent-a1' }]])
    expect(f.out()).toContain('Merged worktree-agent-a1.')
  })

  it('discard needs --yes without a terminal', async () => {
    const { f, client } = setup({ 'maintenance:discardWorktree': () => ({ ok: true, message: 'Discarded.' }) })
    expect(await exitOf(runWorktrees(f.ctx, ['discard', 'worktree-agent-a1']))).toBe(2)
    expect(client.callsOf('maintenance:discardWorktree')).toEqual([])
  })

  it('discard with --yes; unfinished git state is exit 1', async () => {
    let s = setup({ 'maintenance:discardWorktree': () => ({ ok: true, message: 'Discarded worktree-agent-a1.' }) })
    expect(await runWorktrees(s.f.ctx, ['discard', 'worktree-agent-a1', '--yes'])).toBe(0)
    s = setup({ 'maintenance:discardWorktree': () => ({ ok: false, message: 'A merge is in progress (MERGE_HEAD).' }) })
    await expect(runWorktrees(s.f.ctx, ['discard', 'worktree-agent-a1', '--yes'])).rejects.toMatchObject({ exitCode: 1, message: expect.stringContaining('MERGE_HEAD') })
  })

  it('a terminal y/N answers discard', async () => {
    manageDeps.ttyConfirm = async () => true
    const { f, client } = setup({ 'maintenance:discardWorktree': () => ({ ok: true, message: 'Discarded.' }) }, { tty: true })
    expect(await runWorktrees(f.ctx, ['discard', 'worktree-agent-a1'])).toBe(0)
    expect(client.callsOf('maintenance:discardWorktree')).toHaveLength(1)
  })

  it('uninstall is refused on an engagement with exit 2', async () => {
    const { f, client } = setup({ 'maintenance:uninstallRepo': () => ({ ok: true, message: '' }) }, { project: E })
    expect(await exitOf(runWorktrees(f.ctx, ['uninstall', '--yes']))).toBe(2)
    expect(client.callsOf('maintenance:uninstallRepo')).toEqual([])
  })

  it('uninstall on a code project with --yes', async () => {
    const { f, client } = setup({ 'maintenance:uninstallRepo': () => ({ ok: true, message: 'Removed CLAUDE.md (OrgAI section).' }) })
    expect(await runWorktrees(f.ctx, ['uninstall', '--yes'])).toBe(0)
    expect(client.callsOf('maintenance:uninstallRepo')).toEqual([['p1']])
  })
})
