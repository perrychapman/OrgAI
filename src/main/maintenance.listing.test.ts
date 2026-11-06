import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project } from '@shared/types'
import { MaintenanceService } from './maintenance'
import type { ProjectStore } from './store/projects'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' })
}

function repoWithLeftover(): string {
  const root = mkdtempSync(join(tmpdir(), 'orgai-maint-git-'))
  git(root, 'init', '-q')
  writeFileSync(join(root, 'a.txt'), 'a', 'utf8')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'init')
  git(root, 'worktree', 'add', '-q', '-b', 'worktree-agent-left1', join(root, '.claude', 'worktrees', 'agent-left1'))
  return root
}

function service(project: Partial<Project>): MaintenanceService {
  return new MaintenanceService({ get: () => project as Project } as unknown as ProjectStore)
}

describe('listWorktrees ignores the isolation setting', () => {
  it('lists a leftover branch with isolation off on a work project', async () => {
    const root = repoWithLeftover()
    try {
      const list = await service({ id: 'p', path: root, isolateWriters: false, roles: [] }).listWorktrees('p')
      expect(list.map((w) => w.branch)).toEqual(['worktree-agent-left1'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lists a leftover branch for an engagement', async () => {
    const root = repoWithLeftover()
    try {
      const list = await service({ id: 'p', path: root, kind: 'engagement', roles: [] }).listWorktrees('p')
      expect(list.map((w) => w.branch)).toEqual(['worktree-agent-left1'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('stays empty for a folder that is not a git repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orgai-maint-nogit-'))
    try {
      expect(await service({ id: 'p', path: root, kind: 'engagement', roles: [] }).listWorktrees('p')).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
