import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PermissionRequest } from '@shared/types'
import {
  QUICK_SESSION_EDIT_SUGGESTION,
  editTargets,
  isQuickSessionEditGrant,
  isQuickSessionEditSuggestion,
  isQuickWriteTool,
  quickEditCovered,
  quickEditPreApproved,
  quickFolderEditCovered,
  quickSessionEditSuggestion
} from './sessionEdits'

let root: string
let folder: string

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'orgai-qse-')))
  folder = join(root, 'chat')
  mkdirSync(folder, { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('isQuickWriteTool', () => {
  it('is true for edits and commands only', () => {
    for (const t of ['Edit', 'Write', 'Bash']) expect(isQuickWriteTool(t)).toBe(true)
    for (const t of ['Read', 'Grep', 'WebFetch', '', undefined, 3]) expect(isQuickWriteTool(t)).toBe(false)
  })
})

describe('quickFolderEditCovered', () => {
  it('covers files inside the folder, absolute or relative', () => {
    expect(quickFolderEditCovered(folder, join(folder, 'a.txt'))).toBe(true)
    expect(quickFolderEditCovered(folder, join(folder, 'sub', 'deep', 'a.txt'))).toBe(true)
    expect(quickFolderEditCovered(folder, 'a.txt')).toBe(true)
    expect(quickFolderEditCovered(folder, join('sub', 'a.txt'))).toBe(true)
  })

  it('refuses outside paths, the folder itself, parent hops and junk', () => {
    expect(quickFolderEditCovered(folder, join(root, 'other.txt'))).toBe(false)
    expect(quickFolderEditCovered(folder, join(folder, '..', 'other.txt'))).toBe(false)
    expect(quickFolderEditCovered(folder, '../other.txt')).toBe(false)
    expect(quickFolderEditCovered(folder, folder)).toBe(false)
    expect(quickFolderEditCovered(folder, '')).toBe(false)
    expect(quickFolderEditCovered(folder, 'a\u0000b')).toBe(false)
    expect(quickFolderEditCovered(folder, undefined)).toBe(false)
    expect(quickFolderEditCovered('relative/dir', 'a.txt')).toBe(false)
  })

  it('refuses protected folders at any depth, case-insensitive', () => {
    for (const rel of ['.git/config', '.claude/settings.json', '.codex/x', '.agents/x', '.orgai/org.json', '.vscode/tasks.json', '.idea/x', '.github/workflows/ci.yml', 'pkg/.git/hooks/pre-commit', 'a/b/.CLAUDE/x', '.Git/config']) {
      expect(quickFolderEditCovered(folder, rel), rel).toBe(false)
    }
  })

  it('refuses protected file names at any depth', () => {
    for (const rel of ['.mcp.json', 'CLAUDE.md', 'sub/claude.local.md', 'AGENTS.md', 'x/.envrc', '.npmrc', 'a/.yarnrc.yml', '.gitattributes', '.gitmodules']) {
      expect(quickFolderEditCovered(folder, rel), rel).toBe(false)
    }
    expect(quickFolderEditCovered(folder, 'README.md')).toBe(true)
  })

  it('judges a path inside a worktree under .claude/worktrees from inside the worktree', () => {
    expect(quickFolderEditCovered(folder, '.claude/worktrees/agent-1/src/a.ts')).toBe(true)
    expect(quickFolderEditCovered(folder, '.claude/worktrees/agent-1/.git/config')).toBe(false)
    expect(quickFolderEditCovered(folder, '.claude/worktrees/agent-1/CLAUDE.md')).toBe(false)
    expect(quickFolderEditCovered(folder, '.claude/worktrees/agent-1')).toBe(false)
    expect(quickFolderEditCovered(folder, '.claude/settings.json')).toBe(false)
    expect(quickFolderEditCovered(folder, '.claude/worktrees/a.txt')).toBe(false)
  })

  it('refuses a link inside the folder that points outside it', () => {
    const outside = join(root, 'outside')
    mkdirSync(outside, { recursive: true })
    try {
      symlinkSync(outside, join(folder, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      return // links not permitted here
    }
    expect(quickFolderEditCovered(folder, join('link', 'a.txt'))).toBe(false)
    expect(quickFolderEditCovered(folder, join(folder, 'link', 'new', 'a.txt'))).toBe(false)
  })

  it('refuses win32 alternate spellings of protected names, only on win32', () => {
    for (const rel of ['.git./config', '.git /config', '.git::$INDEX_ALLOCATION/x', 'GIT~1/config', 'a.txt:stream', 'x/CLAUDE.md.']) {
      expect(quickFolderEditCovered(folder, rel, 'win32'), rel).toBe(false)
    }
    expect(quickFolderEditCovered(folder, 'a.txt', 'win32')).toBe(true)
  })

  it('refuses a network path', () => {
    expect(quickFolderEditCovered('\\\\host\\share\\chat', '\\\\host\\share\\chat\\a.txt', 'win32')).toBe(false)
  })
})

describe('editTargets and quickEditCovered', () => {
  it('reads file_path, notebook_path and Codex changes', () => {
    expect(editTargets('Edit', { file_path: 'a.txt' })).toEqual(['a.txt'])
    expect(editTargets('NotebookEdit', { notebook_path: 'n.ipynb' })).toEqual(['n.ipynb'])
    expect(editTargets('Write', { changes: [{ path: 'a' }, { path: 'b' }] })).toEqual(['a', 'b'])
    expect(editTargets('Write', { changes: [{ path: 'a' }, {}] })).toBeNull()
    expect(editTargets('Bash', { command: 'ls' })).toBeNull()
    expect(editTargets('Edit', null)).toBeNull()
    expect(editTargets('Edit', {})).toBeNull()
  })

  it('a grantRoot request is never covered', () => {
    expect(editTargets('Write', { grantRoot: '/x', file_path: 'a' })).toBeNull()
    expect(quickEditCovered(folder, 'Write', { grantRoot: folder, changes: [{ path: 'a.txt' }] })).toBe(false)
  })

  it('needs every Codex change covered', () => {
    expect(quickEditCovered(folder, 'Write', { changes: [{ path: 'a.txt' }, { path: 'b/c.txt' }] })).toBe(true)
    expect(quickEditCovered(folder, 'Write', { changes: [{ path: 'a.txt' }, { path: '.git/config' }] })).toBe(false)
    expect(quickEditCovered(folder, 'Write', { changes: [{ path: 'a.txt' }, { path: join(root, 'o.txt') }] })).toBe(false)
  })
})

describe('suggestion, grant and pre-approval', () => {
  const run = (f = folder) => ({ quick: { folder: f, team: 'single' as const, allowEdits: false, gitRepo: false } })
  const req = (over: Partial<PermissionRequest> = {}): Pick<PermissionRequest, 'toolName' | 'input' | 'suggestions' | 'referenceFolder'> => ({
    toolName: 'Edit',
    input: { file_path: join(folder, 'a.txt') },
    suggestions: [{ ...QUICK_SESSION_EDIT_SUGGESTION }],
    ...over
  })

  it('offers the suggestion only on a quick run for a covered edit', () => {
    expect(quickSessionEditSuggestion(run(), 'Edit', { file_path: join(folder, 'a.txt') })).toEqual(QUICK_SESSION_EDIT_SUGGESTION)
    expect(quickSessionEditSuggestion({}, 'Edit', { file_path: join(folder, 'a.txt') })).toBeNull()
    expect(quickSessionEditSuggestion(undefined, 'Edit', {})).toBeNull()
    expect(quickSessionEditSuggestion(run(), 'Edit', { file_path: join(root, 'x') })).toBeNull()
    expect(quickSessionEditSuggestion(run(), 'Bash', { command: 'ls' })).toBeNull()
    expect(isQuickSessionEditSuggestion(QUICK_SESSION_EDIT_SUGGESTION)).toBe(true)
    expect(isQuickSessionEditSuggestion({ type: 'setMode', mode: 'acceptEdits', destination: 'projectSettings' } as never)).toBe(false)
  })

  it('grants only on a quick run, a session allow and a card that offered the suggestion', () => {
    const allowSession = { behavior: 'allow', scope: 'session' } as const
    expect(isQuickSessionEditGrant(run(), req(), allowSession)).toBe(true)
    expect(isQuickSessionEditGrant({}, req(), allowSession)).toBe(false)
    expect(isQuickSessionEditGrant(run(), req(), { behavior: 'allow', scope: 'once' })).toBe(false)
    expect(isQuickSessionEditGrant(run(), req(), { behavior: 'allow', scope: 'project' })).toBe(false)
    expect(isQuickSessionEditGrant(run(), req(), { behavior: 'deny', message: 'no' })).toBe(false)
    expect(isQuickSessionEditGrant(run(), req(), undefined)).toBe(false)
    expect(isQuickSessionEditGrant(run(), req({ suggestions: undefined }), allowSession)).toBe(false)
    expect(isQuickSessionEditGrant(run(), req({ referenceFolder: '/ref' }), allowSession)).toBe(false)
    expect(isQuickSessionEditGrant(run(), req({ input: { file_path: join(root, 'x') } }), allowSession)).toBe(false)
    expect(isQuickSessionEditGrant(run(), req({ toolName: 'Bash', input: { command: 'ls' } }), allowSession)).toBe(false)
  })

  it('pre-approves only with the flag set and a covered edit', () => {
    const on = { run: run(), quickSessionEdits: () => true }
    expect(quickEditPreApproved(on, 'Edit', { file_path: join(folder, 'a.txt') })).toBe(true)
    expect(quickEditPreApproved(on, 'Edit', { file_path: join(root, 'x') })).toBe(false)
    expect(quickEditPreApproved(on, 'Edit', { file_path: '.git/config' })).toBe(false)
    expect(quickEditPreApproved(on, 'Bash', { command: 'ls' })).toBe(false)
    expect(quickEditPreApproved({ run: run(), quickSessionEdits: () => false }, 'Edit', { file_path: 'a.txt' })).toBe(false)
    expect(quickEditPreApproved({ run: run() }, 'Edit', { file_path: 'a.txt' })).toBe(false)
    expect(quickEditPreApproved({ run: {}, quickSessionEdits: () => true }, 'Edit', { file_path: 'a.txt' })).toBe(false)
  })
})
