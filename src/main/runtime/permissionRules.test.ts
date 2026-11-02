import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PermissionSuggestion } from '@shared/types'
import {
  applyAllowScope,
  blanketRuleRefusal,
  chooseSuggestions,
  isBlanketAllowRule,
  deriveSuggestions,
  isUnsafeAllowRule,
  isWholeToolRule,
  listRules,
  ruleLabel,
  segmentRulePrefix,
  shellRuleContents,
  suggestionLabels
} from './permissionRules'

const posixOpts = { cwd: '/home/u/proj', freeDirs: ['/home/u/proj'], platform: 'linux' as const }

describe('per-segment shell rules', () => {
  it('use the first word, or the first two after a launcher', () => {
    expect(segmentRulePrefix('Bash', 'npm test -- --watch')).toBe('npm test')
    expect(segmentRulePrefix('Bash', 'git status --short')).toBe('git status')
    expect(segmentRulePrefix('Bash', 'ls -la')).toBe('ls')
    expect(segmentRulePrefix('Bash', 'python3 script.py')).toBe('python3 script.py')
    expect(segmentRulePrefix('Bash', 'git -C x status')).toBeNull()
    expect(segmentRulePrefix('Bash', 'npm')).toBeNull()
    expect(segmentRulePrefix('Bash', 'FOO=1 npm test')).toBeNull()
    expect(segmentRulePrefix('Bash', '"quoted" x')).toBeNull()
  })

  it('never derive a destructive prefix', () => {
    for (const s of ['rm -rf x', 'git push origin', 'git reset --hard', 'sudo ls', 'Remove-Item x']) expect(segmentRulePrefix('Bash', s), s).toBeNull()
  })

  it('split compound commands and skip free cd segments', () => {
    expect(shellRuleContents('Bash', 'cd wt && npm test && git status', posixOpts)).toEqual(['npm test:*', 'git status:*'])
    expect(shellRuleContents('Bash', 'npm test; npm test && rm -rf x')).toEqual(['npm test:*'])
    expect(shellRuleContents('Bash', 'git log | head -5')).toEqual(['git log:*', 'head:*'])
    // A cd that is not free still needs coverage.
    expect(shellRuleContents('Bash', 'cd /elsewhere && make build', posixOpts)).toEqual(['cd:*', 'make build:*'])
    expect(deriveSuggestions('Bash', { command: 'cd src && npm test' }, posixOpts)).toEqual([
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'session' }
    ])
    expect(deriveSuggestions('Bash', { command: 'rm -rf x' })).toEqual([])
  })
})

describe('edit tools never get a whole-tool rule (UX H4)', () => {
  it('derive acceptEdits, plus the folder when the file is outside the project and allowed dirs', () => {
    const opts = { cwd: '/home/u/proj', freeDirs: ['/home/u/proj', '/home/u/notes'], platform: 'linux' as const }
    const mode = { type: 'setMode', mode: 'acceptEdits', destination: 'session' }
    expect(deriveSuggestions('Edit', { file_path: '/home/u/proj/src/a.ts' }, opts)).toEqual([mode])
    expect(deriveSuggestions('Write', { file_path: 'src/a.ts' }, opts)).toEqual([mode])
    expect(deriveSuggestions('MultiEdit', { file_path: '/home/u/notes/x/a.md' }, opts)).toEqual([mode])
    expect(deriveSuggestions('Edit', { file_path: '/home/u/sibling/README.md' }, opts)).toEqual([
      mode,
      { type: 'addDirectories', directories: ['/home/u/sibling'], destination: 'session' }
    ])
    expect(deriveSuggestions('NotebookEdit', { notebook_path: '/srv/nb/a.ipynb' }, opts)).toEqual([
      mode,
      { type: 'addDirectories', directories: ['/srv/nb'], destination: 'session' }
    ])
    // A file in a root gives no folder; no path gives the mode alone.
    expect(deriveSuggestions('Edit', { file_path: '/a.txt' }, opts)).toEqual([mode])
    expect(deriveSuggestions('Edit', {}, opts)).toEqual([mode])
    const win = { cwd: 'C:\\p', freeDirs: ['C:\\p'], platform: 'win32' as const }
    expect(deriveSuggestions('Edit', { file_path: 'c:\\P\\src\\a.ts' }, win)).toEqual([mode])
    expect(deriveSuggestions('Edit', { file_path: 'C:\\other\\a.ts' }, win)).toEqual([mode, { type: 'addDirectories', directories: ['C:\\other'], destination: 'session' }])
  })

  it('other tools keep whole-tool derivation', () => {
    expect(deriveSuggestions('WebSearch', {})).toEqual([{ type: 'addRules', rules: [{ toolName: 'WebSearch' }], behavior: 'allow', destination: 'session' }])
    expect(deriveSuggestions('mcp__gh__x', {})).toEqual([{ type: 'addRules', rules: [{ toolName: 'mcp__gh__x' }], behavior: 'allow', destination: 'session' }])
  })

  it('bare edit and shell rules are unsafe, refused for saving with a readable reason, and never written by a project scope', () => {
    for (const r of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell']) {
      expect(isUnsafeAllowRule(r), r).toBe(true)
      expect(isBlanketAllowRule(r), r).toBe(true)
      expect(blanketRuleRefusal(r), r).toMatch(/would allow/)
    }
    for (const r of ['Edit(src/**)', 'WebSearch', 'Bash(npm test:*)']) {
      expect(isBlanketAllowRule(r), r).toBe(false)
      expect(blanketRuleRefusal(r), r).toBeNull()
    }
    const dir = mkdtempSync(join(tmpdir(), 'orgai-scope-'))
    try {
      const logs: string[] = []
      const s: PermissionSuggestion[] = [{ type: 'addRules', rules: [{ toolName: 'Edit' }, { toolName: 'WebFetch' }], behavior: 'allow', destination: 'session' }]
      expect(applyAllowScope(dir, { behavior: 'allow', scope: 'project' }, s, (_l, m) => logs.push(m))).toEqual(s)
      expect(listRules(dir)).toEqual(['WebFetch'])
      expect(logs[0]).toMatch(/Not saved for the project \(too broad\): Edit/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('chooseSuggestions', () => {
  const compound: PermissionSuggestion = {
    type: 'addRules',
    rules: [{ toolName: 'Bash', ruleContent: 'cd /home/u/proj/.claude/worktrees/agent-x && npm test *' }],
    behavior: 'allow',
    destination: 'localSettings'
  }
  it('replaces a provider rule spanning several segments with per-segment rules', () => {
    const out = chooseSuggestions('Bash', { command: 'cd /home/u/proj/.claude/worktrees/agent-x && npm test' }, [compound], false, posixOpts)
    expect(out).toEqual([{ ...compound, rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }] }])
    expect(suggestionLabels(out)).toEqual(['Bash(npm test:*)'])
  })
  it('keeps single-segment provider rules and other suggestions as they are', () => {
    const single: PermissionSuggestion = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }], behavior: 'allow', destination: 'localSettings' }
    const dirs: PermissionSuggestion = { type: 'addDirectories', directories: ['/home/u/notes'], destination: 'session' }
    expect(chooseSuggestions('Bash', { command: 'npm test' }, [single, dirs])).toEqual([single, dirs])
  })
  it('drops a compound provider suggestion that yields no safe rule, and honours suppression', () => {
    const bad: PermissionSuggestion = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'cd src && rm -rf x' }], behavior: 'allow', destination: 'session' }
    expect(chooseSuggestions('Bash', { command: 'cd src && rm -rf x' }, [bad], false, posixOpts)).toEqual([])
    expect(chooseSuggestions('Bash', { command: 'npm test' }, [compound], true)).toEqual([])
  })
})

describe('suggestion labels', () => {
  it('names folders and the acceptEdits mode in plain words', () => {
    expect(
      suggestionLabels([
        { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
        { type: 'addDirectories', directories: ['/home/u/notes'], destination: 'session' },
        { type: 'setMode', mode: 'plan', destination: 'session' }
      ])
    ).toEqual(['Auto-accept file edits in this project', 'Edits and reads in /home/u/notes', 'Permission mode: plan'])
  })
})

describe('applyAllowScope', () => {
  const editSuggestions: PermissionSuggestion[] = [
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    { type: 'addDirectories', directories: ['/home/u/notes'], destination: 'session' },
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'session' }
  ]
  const fake = () => {
    const calls: { dirs: string[][]; mode: number } = { dirs: [], mode: 0 }
    return {
      calls,
      persist: {
        allowDirectories: (dirs: string[]) => {
          calls.dirs.push(dirs)
          return dirs
        },
        acceptEditsForProject: () => {
          calls.mode++
          return true
        }
      }
    }
  }

  it('project scope saves rules, folders and the acceptEdits mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orgai-scope-'))
    try {
      const { calls, persist } = fake()
      const out = applyAllowScope(dir, { behavior: 'allow', scope: 'project' }, editSuggestions, () => {}, persist)
      expect(out).toEqual(editSuggestions)
      expect(listRules(dir)).toEqual(['Bash(npm test:*)'])
      expect(calls).toEqual({ dirs: [['/home/u/notes']], mode: 1 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('session and once scopes persist nothing; without persist hooks only rules can be saved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orgai-scope-'))
    try {
      const { calls, persist } = fake()
      expect(applyAllowScope(dir, { behavior: 'allow', scope: 'session' }, editSuggestions, () => {}, persist)).toEqual(editSuggestions)
      expect(applyAllowScope(dir, { behavior: 'allow' }, editSuggestions, () => {}, persist)).toBeNull()
      expect(calls).toEqual({ dirs: [], mode: 0 })
      expect(listRules(dir)).toEqual([])
      expect(applyAllowScope(dir, { behavior: 'allow', scope: 'project' }, editSuggestions, () => {})).toEqual(editSuggestions)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a throwing persist hook logs a warning and still grants the session', () => {
    const logs: string[] = []
    const out = applyAllowScope(
      join(tmpdir(), 'orgai-never-created', 'x'),
      { behavior: 'allow', scope: 'project' },
      [editSuggestions[1]],
      (_l, m) => logs.push(m),
      { allowDirectories: () => { throw new Error('boom') } }
    )
    expect(out).toEqual([editSuggestions[1]])
    expect(logs).toEqual(['Could not save allowed folders: boom'])
  })
})

describe('isUnsafeAllowRule', () => {
  it('accepts the safe workflow and git commands the Architect proposes', () => {
    for (const r of ['Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git worktree:*)', 'WebSearch', 'Read', 'mcp__orgai__x']) {
      expect(isUnsafeAllowRule(r), r).toBe(false)
    }
  })

  it('refuses blanket shell access and destructive commands', () => {
    for (const r of ['Bash', 'PowerShell', 'Bash()', 'Bash(*)', 'Bash( *)', 'Bash(rm *)', 'Bash(git push *)', 'Bash(:*)','Bash(rm:*)', 'Bash(rm -rf node_modules)', 'Bash(sudo:*)', 'Bash(git push:*)', 'Bash(git reset --hard:*)', 'Bash(git clean -fd)', 'PowerShell(Remove-Item:*)', 'not a rule!']) {
      expect(isUnsafeAllowRule(r), r).toBe(true)
    }
  })

  it('does not mistake commands that merely start with a destructive verb', () => {
    expect(isUnsafeAllowRule('Bash(rmdir-helper:*)')).toBe(false)
    expect(isUnsafeAllowRule('Bash(npm run dd-report:*)')).toBe(false)
  })
})

describe('isWholeToolRule', () => {
  it('flags bare tool names only', () => {
    expect(isWholeToolRule('WebSearch')).toBe(true)
    expect(isWholeToolRule('mcp__orgai__propose_settings')).toBe(true)
    expect(isWholeToolRule('Bash(npm:*)')).toBe(false)
    expect(isWholeToolRule('WebFetch(domain:example.com)')).toBe(false)
  })
})

describe('server-level MCP rules', () => {
  it('saves mcp__<server> forms and refuses wildcards and the harness server', () => {
    for (const r of ['mcp__github', 'mcp__github__*']) expect(isUnsafeAllowRule(r), r).toBe(false)
    for (const r of ['mcp__*', 'mcp__orgai', 'mcp__orgai__*', 'mcp__a*']) expect(isUnsafeAllowRule(r), r).toBe(true)
  })
  it('labels both server forms the same way', () => {
    expect(ruleLabel('mcp__github')).toBe('All tools of github')
    expect(ruleLabel('mcp__github__*')).toBe('All tools of github')
    expect(ruleLabel('mcp__github__create')).toBe('mcp__github__create')
    expect(suggestionLabels([{ type: 'addRules', rules: [{ toolName: 'mcp__github__*' }, { toolName: 'Edit' }], behavior: 'allow', destination: 'session' }])).toEqual(['All tools of github', 'Edit'])
  })
})
