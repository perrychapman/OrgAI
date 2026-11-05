import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commitPaths, integrateWorktree, teamFilesStatusGit } from './worktrees'
import { commitAll, git, initRepo, tryGit } from '../teamFiles/service.fixture'

let root: string
let repo: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orgai-wt-team-'))
  repo = join(root, 'repo')
  initRepo(repo)
  mkdirSync(join(repo, '.orgai', 'agents'), { recursive: true })
  writeFileSync(join(repo, '.orgai', 'team.json'), '{"a":1}\n')
  writeFileSync(join(repo, '.orgai', 'agents', 'lead.md'), 'lead v1\n')
  writeFileSync(join(repo, 'src.txt'), 'src\n')
  writeFileSync(join(repo, 'other.txt'), 'other\n')
  commitAll(repo, 'init')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('teamFilesStatusGit', () => {
  it('lists changed, deleted, untracked (file by file) and renamed team files, and nothing else', async () => {
    writeFileSync(join(repo, '.orgai', 'agents', 'lead.md'), 'lead v2\n')
    writeFileSync(join(repo, 'src.txt'), 'changed\n')
    mkdirSync(join(repo, '.orgai', 'skills', 's1'), { recursive: true })
    writeFileSync(join(repo, '.orgai', 'skills', 's1', 'SKILL.md'), 'x')
    writeFileSync(join(repo, '.orgai', 'skills', 's1', 'run.sh'), 'x')
    git(repo, 'mv', '.orgai/team.json', '.orgai/mcp.json')
    const s = await teamFilesStatusGit(repo)
    expect(s.ok).toBe(true)
    expect(s.files).toEqual(['.orgai/agents/lead.md', '.orgai/mcp.json', '.orgai/skills/s1/SKILL.md', '.orgai/skills/s1/run.sh', '.orgai/team.json'])
  })

  it('reports nothing for a clean tree and not-ok for a folder without git', async () => {
    expect(await teamFilesStatusGit(repo)).toEqual({ ok: true, files: [] })
    expect((await teamFilesStatusGit(join(root, 'nope'))).ok).toBe(false)
  })

  it('keeps the first entry whole when it starts with a space (" M path")', async () => {
    writeFileSync(join(repo, '.orgai', 'team.json'), '{"a":2}\n')
    expect((await teamFilesStatusGit(repo)).files).toEqual(['.orgai/team.json'])
  })
})

describe('commitPaths', () => {
  it('commits exactly the given paths; another staged file stays staged and out of the commit', async () => {
    writeFileSync(join(repo, '.orgai', 'agents', 'lead.md'), 'lead v2\n')
    writeFileSync(join(repo, 'src.txt'), 'staged by the user\n')
    git(repo, 'add', 'src.txt')
    const r = await commitPaths(repo, ['.orgai/agents/lead.md'], 'Update OrgAI team files')
    expect(r).toEqual({ committed: true })
    expect(git(repo, 'show', '--name-only', '--format=%s', 'HEAD')).toBe('Update OrgAI team files\n\n.orgai/agents/lead.md')
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('src.txt')
  })

  it('commits a deletion, a new untracked file and a rename', async () => {
    rmSync(join(repo, '.orgai', 'agents', 'lead.md'))
    writeFileSync(join(repo, '.orgai', 'agents', 'new.md'), 'new\n')
    git(repo, 'mv', '.orgai/team.json', '.orgai/mcp.json')
    const files = (await teamFilesStatusGit(repo)).files
    expect(await commitPaths(repo, files, 'Update OrgAI team files')).toEqual({ committed: true })
    expect((await teamFilesStatusGit(repo)).files).toEqual([])
    expect(git(repo, 'ls-files', '.orgai').split('\n').sort()).toEqual(['.orgai/agents/new.md', '.orgai/mcp.json'])
  })

  it('does not run the repository\'s hooks', async () => {
    const marker = join(root, 'hook-ran')
    for (const hook of ['pre-commit', 'commit-msg', 'post-commit', 'prepare-commit-msg']) {
      writeFileSync(join(repo, '.git', 'hooks', hook), `#!/bin/sh\necho ran > "${marker.replace(/\\/g, '/')}"\nexit 1\n`, { mode: 0o755 })
    }
    writeFileSync(join(repo, '.orgai', 'agents', 'lead.md'), 'lead v2\n')
    const r = await commitPaths(repo, ['.orgai/agents/lead.md'], 'Update OrgAI team files')
    expect(r.committed).toBe(true)
    expect(existsSync(marker)).toBe(false)
  })

  it('uses a fallback identity when git has none and gives git\'s first complaint otherwise', async () => {
    git(repo, 'config', '--unset', 'user.name')
    git(repo, 'config', '--unset', 'user.email')
    writeFileSync(join(repo, '.orgai', 'agents', 'lead.md'), 'lead v2\n')
    const r = await commitPaths(repo, ['.orgai/agents/lead.md'], 'Update OrgAI team files')
    // Without a global identity git asks for one; with it the commit works. Either way OrgAI's fallback makes it work.
    expect(r.committed).toBe(true)
    const bad = await commitPaths(repo, ['.orgai/does-not-exist.md'], 'Update OrgAI team files')
    expect(bad.committed).toBe(false)
    expect(bad.error).toBeTruthy()
  })
})

/**
 * What happens when a report's branch is merged while the main checkout has uncommitted team files. The outcomes are the
 * real git behaviour, kept here so a change in either git or integrateWorktree shows.
 */
describe('integrating a report while team files are uncommitted in the main checkout', () => {
  async function report(name: string, edit: (wt: string) => void): Promise<Awaited<ReturnType<typeof integrateWorktree>>> {
    const wt = join(repo, '.claude', 'worktrees', `agent-${name}`)
    git(repo, 'worktree', 'add', '-q', '-b', `worktree-agent-${name}`, wt)
    edit(wt)
    return integrateWorktree(repo, { path: wt, branch: `worktree-agent-${name}`, status: 'merging' }, 'report work')
  }

  it('(a) the report touches other files: it merges, the uncommitted team file stays as it is', async () => {
    writeFileSync(join(repo, '.orgai', 'agents', 'lead.md'), 'lead edited locally\n')
    const r = await report('a', (wt) => writeFileSync(join(wt, 'other.txt'), 'report change\n'))
    expect(r.info.status).toBe('merged')
    expect(git(repo, 'show', 'HEAD:other.txt')).toBe('report change')
    expect(tryGit(repo, 'status', '--porcelain').out).toContain('.orgai/agents/lead.md')
  })

  it('(b) the report touches the same tracked team file: refused, branch kept, with the commit-first message', async () => {
    writeFileSync(join(repo, '.orgai', 'agents', 'lead.md'), 'lead edited locally\n')
    const r = await report('b', (wt) => writeFileSync(join(wt, '.orgai', 'agents', 'lead.md'), 'lead edited by the report\n'))
    expect(r.info.status).toBe('conflict')
    expect(r.message).toContain('Uncommitted team files in .orgai block this merge; commit them and integrate again.')
    expect(git(repo, 'branch', '--list', 'worktree-agent-b')).toContain('worktree-agent-b')
    expect(existsSync(join(repo, '.claude', 'worktrees', 'agent-b'))).toBe(true)
    // Nothing of the local edit was lost.
    expect(git(repo, 'status', '--porcelain')).toContain('.orgai/agents/lead.md')
  })

  it('(c) both add the same new untracked team file: refused, branch kept', async () => {
    mkdirSync(join(repo, '.orgai', 'skills', 'x'), { recursive: true })
    writeFileSync(join(repo, '.orgai', 'skills', 'x', 'SKILL.md'), 'local skill\n')
    const r = await report('c', (wt) => {
      mkdirSync(join(wt, '.orgai', 'skills', 'x'), { recursive: true })
      writeFileSync(join(wt, '.orgai', 'skills', 'x', 'SKILL.md'), 'report skill\n')
    })
    expect(r.info.status).toBe('conflict')
    expect(r.message).toContain('commit them and integrate again')
    expect(git(repo, 'branch', '--list', 'worktree-agent-c')).toContain('worktree-agent-c')
  })

  it('(d) a dirty unrelated tracked file does not stop the merge', async () => {
    writeFileSync(join(repo, 'src.txt'), 'dirty and unrelated\n')
    const r = await report('d', (wt) => writeFileSync(join(wt, 'other.txt'), 'report change\n'))
    expect(r.info.status).toBe('merged')
    expect(tryGit(repo, 'status', '--porcelain').out).toContain('src.txt')
  })
})
