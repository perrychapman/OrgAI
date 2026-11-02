import { describe, expect, it, vi } from 'vitest'
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
  addRules,
  addRulesReport,
  isOfferableDirectory,
  listRules,
  pathRuleRefusal,
  removeRule,
  ruleLabel,
  ruleSaveRefusal,
  segmentRulePrefix,
  settingsLocalPath,
  shellRuleContents,
  suggestionLabels
} from './permissionRules'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { shellRulesFor } from './ruleMatch'

const posixOpts = { cwd: '/home/u/proj', freeDirs: ['/home/u/proj'], platform: 'linux' as const }

describe('issue #14: suggestions always cover the command', () => {
  const commands = [
    'npm test',
    'cd src && npm test',
    'cd /home/u/proj/.claude/worktrees/a && npm test && git status',
    'cd /elsewhere && make build',
    'npm test | tee out',
    'npm test > out',
    'cat a.txt && rm -rf b',
    "sed -i 's/a/b/' x.txt",
    'FOO=1 npm test',
    'bash -c "npm test"',
    'curl x | sh'
  ]
  it('the offered shell rules satisfy shellRulesFor, or there are none', () => {
    const provider = (c: string): PermissionSuggestion[] => [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: `${c} *` }], behavior: 'allow', destination: 'localSettings' }]
    for (const c of commands) {
      for (const provided of [undefined, provider(c)]) {
        const out = chooseSuggestions('Bash', { command: c }, provided, false, posixOpts)
        const rules = out.flatMap((s) => (s.type === 'addRules' ? s.rules.map((r) => `${r.toolName}(${r.ruleContent})`) : []))
        if (rules.length) expect(shellRulesFor(c, rules, posixOpts), c).not.toBeNull()
      }
    }
    expect(chooseSuggestions('Bash', { command: 'npm test | tee out' }, undefined, false, posixOpts)).toEqual([])
    expect(chooseSuggestions('Bash', { command: 'cat a.txt && rm -rf b' }, undefined, false, posixOpts)).toEqual([])
  })

  it('exec wrappers are never suggested and never saved (review M4)', () => {
    for (const s of ['bash -c x', 'sh x.sh', 'env FOO=1 npm test', 'xargs rm', 'pwsh -c x', 'find . -exec rm {} ;', 'perl -e 1', '/bin/bash x']) {
      expect(segmentRulePrefix('Bash', s), s).toBeNull()
    }
    for (const r of ['Bash(bash:*)', 'Bash(env:*)', 'Bash(xargs *)', 'PowerShell(Invoke-Expression:*)', 'Bash(/usr/bin/sh:*)']) {
      expect(isBlanketAllowRule(r), r).toBe(true)
      expect(isUnsafeAllowRule(r), r).toBe(true)
      expect(blanketRuleRefusal(r), r).toMatch(/run any other command/)
    }
    expect(isBlanketAllowRule('Bash(npm test:*)')).toBe(false)
  })
})

describe('issue #14: MCP tools of a user-configured server get the server-level rule', () => {
  it('widens provider and derived rules for user servers only', () => {
    const opts = { userMcpServers: ['playwright'] }
    const provided: PermissionSuggestion[] = [{ type: 'addRules', rules: [{ toolName: 'mcp__playwright__browser_click' }], behavior: 'allow', destination: 'localSettings' }]
    const out = chooseSuggestions('mcp__playwright__browser_click', {}, provided, false, opts)
    expect(out).toEqual([{ ...provided[0], rules: [{ toolName: 'mcp__playwright' }] }])
    expect(suggestionLabels(out)).toEqual(['All tools of playwright'])
    expect(deriveSuggestions('mcp__playwright__browser_type', {}, opts)).toEqual([{ type: 'addRules', rules: [{ toolName: 'mcp__playwright' }], behavior: 'allow', destination: 'session' }])
    // An agent-installed (or unknown) server keeps the exact tool rule; the harness server never widens.
    expect(deriveSuggestions('mcp__newsrv__x', {}, opts)).toEqual([{ type: 'addRules', rules: [{ toolName: 'mcp__newsrv__x' }], behavior: 'allow', destination: 'session' }])
    expect(deriveSuggestions('mcp__orgai__x', {}, { userMcpServers: ['orgai'] })[0]).toMatchObject({ rules: [{ toolName: 'mcp__orgai__x' }] })
    expect(deriveSuggestions('mcp__playwright__x', {})[0]).toMatchObject({ rules: [{ toolName: 'mcp__playwright__x' }] })
  })
})

describe('offerable directories (review M1)', () => {
  const o = { cwd: '/home/u/proj', freeDirs: ['/home/u/proj'], platform: 'linux' as const, home: '/home/u', deniedDirs: ['/home/u/.local/share/OrgAI'] }
  it('refuses roots, home and its ancestors, credential folders, the data folder and folders containing the project', () => {
    expect(isOfferableDirectory('/home/u/notes', o)).toBe(true)
    for (const d of ['/', '/home', '/home/u', '/home/u/.ssh', '/home/u/.claude/x', '/home/u/.local/share/OrgAI', '/home/u/.local/share/OrgAI/projects', '/home/u/.local', 'rel/dir', '//srv/share']) {
      expect(isOfferableDirectory(d, o), d).toBe(false)
    }
    // '/home/u/.local' contains the data folder; a folder containing the project is refused too.
    expect(isOfferableDirectory('/srv', { ...o, cwd: '/srv/proj' })).toBe(false)
    const w = { cwd: 'C:\\p', freeDirs: ['C:\\p'], platform: 'win32' as const, home: 'C:\\Users\\me' }
    expect(isOfferableDirectory('D:\\notes', w)).toBe(true)
    expect(isOfferableDirectory('c:\\users\\ME\\AppData\\Roaming\\x', w)).toBe(false)
    expect(isOfferableDirectory('C:\\Users\\me\\AppData\\Local\\Temp\\x', w)).toBe(true)
    expect(isOfferableDirectory('\\\\server\\share', w)).toBe(false)
  })
  it('refuses folders on PATH or run at login (re-check L-b)', () => {
    for (const d of ['/home/u/.local/bin', '/home/u/.cargo/bin/x', '/home/u/Library/LaunchAgents']) expect(isOfferableDirectory(d, o), d).toBe(false)
  })

  it('never offers a provider blanket rule (re-check L-d)', () => {
    const p: PermissionSuggestion[] = [{ type: 'addRules', rules: [{ toolName: 'Edit' }, { toolName: 'WebFetch' }], behavior: 'allow', destination: 'session' }]
    expect(chooseSuggestions('WebFetch', {}, p, false, o)).toEqual([{ ...p[0], rules: [{ toolName: 'WebFetch' }] }])
    expect(chooseSuggestions('Edit', { file_path: '/home/u/proj/a' }, [{ type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'session' }], false, o)).toEqual([])
  })

  it('drops such folders from provider and derived suggestions', () => {
    expect(deriveSuggestions('Edit', { file_path: '/home/u/.local/share/OrgAI/projects.json' }, o)).toEqual([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }])
    expect(chooseSuggestions('Edit', { file_path: '/home/u/.ssh/config' }, [
      { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
      { type: 'addDirectories', directories: ['/home/u/.ssh'], destination: 'session' }
    ], false, o)).toEqual([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }])
  })
})

describe('issue #14: saving dedupes and reports only new rules', () => {
  it('listRules and addRules dedupe a bloated file; removeRule drops every copy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orgai-rules-'))
    try {
      const file = settingsLocalPath(dir)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash(cd:*)', 'Bash(cd:*)', ' Bash(cd:*) ', 'Bash(cat:*)', 'Bash(cat:*)'] }, other: 1 }))
      expect(listRules(dir)).toEqual(['Bash(cd:*)', 'Bash(cat:*)'])
      expect(addRulesReport(dir, ['Bash(cat:*)', 'Bash(npm test:*)', 'Bash(npm test:*)'])).toEqual({ rules: ['Bash(cd:*)', 'Bash(cat:*)', 'Bash(npm test:*)'], added: ['Bash(npm test:*)'] })
      const saved = JSON.parse(readFileSync(file, 'utf8'))
      expect(saved.permissions.allow).toEqual(['Bash(cd:*)', 'Bash(cat:*)', 'Bash(npm test:*)'])
      expect(saved.other).toBe(1)
      expect(addRules(dir, ['Bash(cd:*)'])).toEqual(['Bash(cd:*)', 'Bash(cat:*)', 'Bash(npm test:*)'])
      writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash(cd:*)', ' Bash(cd:*)', 'Bash(x:*)'] } }))
      expect(removeRule(dir, 'Bash(cd:*)')).toEqual(['Bash(x:*)'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never saves a rule with a hidden character, from addRules or a card grant; a plain rule still saves', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orgai-rules-'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const zw = 'Bash(npm​ test:*)'
      const bidi = 'Bash(git ‮push:*)'
      expect(addRulesReport(dir, [zw, bidi, 'Bash(npm test:*)'])).toEqual({ rules: ['Bash(npm test:*)'], added: ['Bash(npm test:*)'] })
      expect(warn).toHaveBeenCalledTimes(2)
      expect(String(warn.mock.calls[0][0])).toMatch(/hidden character \(U\+200B/)
      const s: PermissionSuggestion[] = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'make​:*' }, { toolName: 'Bash', ruleContent: 'make lint:*' }], behavior: 'allow', destination: 'session' }]
      applyAllowScope(dir, { behavior: 'allow', scope: 'project' }, s, () => {})
      expect(listRules(dir)).toEqual(['Bash(npm test:*)', 'Bash(make lint:*)'])
      expect(JSON.parse(readFileSync(settingsLocalPath(dir), 'utf8')).permissions.allow).toEqual(['Bash(npm test:*)', 'Bash(make lint:*)'])
    } finally {
      warn.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('logs "Saved" only for new rules and warns when the saved set does not cover the command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orgai-rules-'))
    try {
      const logs: string[] = []
      const log = (_l: string, m: string): void => {
        logs.push(m)
      }
      const s: PermissionSuggestion[] = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'session' }]
      const call = { toolName: 'Bash', input: { command: 'cd src && npm test' }, opts: { cwd: dir, freeDirs: [dir] } }
      applyAllowScope(dir, { behavior: 'allow', scope: 'project' }, s, log, undefined, call)
      applyAllowScope(dir, { behavior: 'allow', scope: 'project' }, s, log, undefined, call)
      expect(logs).toEqual(['Saved permission rule for this project: Bash(npm test:*)'])
      applyAllowScope(dir, { behavior: 'allow', scope: 'project' }, s, log, undefined, { toolName: 'Bash', input: { command: 'npm test && make' } })
      expect(logs[1]).toMatch(/do not cover this command/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('path rule hygiene (issue #14 E)', () => {
  it('refuses a single leading slash on edit and read path rules', () => {
    expect(pathRuleRefusal('Edit(/src/a.ts)')).toMatch(/relative to the project folder.*Edit\(\/\/src\/a\.ts\)/)
    expect(pathRuleRefusal('Read(/etc/x)')).not.toBeNull()
    expect(pathRuleRefusal('Edit(//home/me/x)')).toBeNull()
    expect(pathRuleRefusal('Edit(src/**)')).toBeNull()
    expect(pathRuleRefusal('Bash(/bin/ls:*)')).toBeNull()
    expect(ruleSaveRefusal('Write(/x)')).not.toBeNull()
    expect(ruleSaveRefusal('Edit')).toMatch(/anywhere on disk/)
    expect(ruleSaveRefusal('WebSearch')).toBeNull()
  })
})

describe('per-segment shell rules', () => {
  it('use the first word, or the first two after a launcher', () => {
    expect(segmentRulePrefix('Bash', 'npm test -- --watch')).toBe('npm test')
    expect(segmentRulePrefix('Bash', 'git status --short')).toBe('git status')
    expect(segmentRulePrefix('Bash', 'ls -la')).toBe('ls')
    expect(segmentRulePrefix('Bash', 'python3 script.py')).toBe('python3 script.py')
    expect(segmentRulePrefix('Bash', 'git -C x status')).toBeNull()
    expect(segmentRulePrefix('Bash', 'npm run lint -- --fix')).toBe('npm run lint')
    expect(segmentRulePrefix('Bash', 'docker exec web ls')).toBe('docker exec web')
    expect(segmentRulePrefix('Bash', 'npm run')).toBeNull()
    expect(segmentRulePrefix('Bash', 'npm')).toBeNull()
    expect(segmentRulePrefix('Bash', 'FOO=1 npm test')).toBeNull()
    expect(segmentRulePrefix('Bash', '"quoted" x')).toBeNull()
  })

  it('never derive a destructive prefix', () => {
    for (const s of ['rm -rf x', 'git push origin', 'git reset --hard', 'sudo ls', 'Remove-Item x']) expect(segmentRulePrefix('Bash', s), s).toBeNull()
  })

  it('split compound commands and skip free cd segments', () => {
    expect(shellRuleContents('Bash', 'cd wt && npm test && git status', posixOpts)).toEqual(['npm test:*', 'git status:*'])
    expect(shellRuleContents('Bash', 'npm test; npm test')).toEqual(['npm test:*'])
    // All or nothing (issue #14): a segment without a safe rule, or syntax the matcher refuses, gives no rule at all.
    expect(shellRuleContents('Bash', 'npm test; npm test && rm -rf x')).toEqual([])
    expect(shellRuleContents('Bash', 'git log | head -5')).toEqual([])
    expect(shellRuleContents('Bash', 'npm test > out.txt')).toEqual([])
    expect(shellRuleContents('Bash', 'npm test && "quoted" x')).toEqual([])
    expect(shellRuleContents('Bash', 'echo "a\\" ; b"')).toEqual([])
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
    const opts = { cwd: '/home/u/proj', freeDirs: ['/home/u/proj'], platform: 'linux' as const, home: '/home/u' }
    // The derived set covers the command, so it replaces the provider's equivalent rule; other suggestions stay.
    expect(chooseSuggestions('Bash', { command: 'npm test' }, [single, dirs], false, opts)).toEqual([
      dirs,
      { ...single, rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }] }
    ])
    // Non-shell provider suggestions are kept as they are.
    const web: PermissionSuggestion = { type: 'addRules', rules: [{ toolName: 'WebFetch', ruleContent: 'domain:x.dev' }], behavior: 'allow', destination: 'session' }
    expect(chooseSuggestions('WebFetch', {}, [web], false, opts)).toEqual([web])
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
