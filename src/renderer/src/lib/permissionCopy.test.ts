import { describe, expect, it } from 'vitest'
import type { PermissionSuggestion } from '@shared/types'
import {
  PERMISSION_MODE_TRADEOFF,
  SINGLE_SLASH_REASON,
  allowedFolderDraftProblem,
  checkRuleDraft,
  collapseRules,
  noRuleLine,
  droppedFolderNotice,
  droppedFolders,
  isAbsolutePath,
  isInsidePath,
  mcpServerOf,
  normalizePath,
  parentPath,
  permissionLocation,
  ruleChip,
  ruleInfo,
  ruleSubject,
  rulesApplyInMode,
  scopeCopy
} from './permissionCopy'

const WIN = { projectPath: 'C:\\Users\\me\\notes-app' }
const POSIX = { projectPath: '/home/me/notes-app' }

describe('paths', () => {
  it('normalizes separators, dots and trailing slashes', () => {
    expect(normalizePath('C:\\a\\.\\b\\..\\c\\')).toBe('C:/a/c')
    expect(normalizePath('/a//b/../../..')).toBe('/')
    expect(normalizePath('C:\\')).toBe('C:/')
    expect(normalizePath('a/../../b')).toBe('../b')
    expect(normalizePath('\\\\srv\\share\\x')).toBe('//srv/share/x')
  })
  it('tells absolute paths', () => {
    expect(isAbsolutePath('C:\\x')).toBe(true)
    expect(isAbsolutePath('/x')).toBe(true)
    expect(isAbsolutePath('\\\\srv\\s')).toBe(true)
    expect(isAbsolutePath('x/y')).toBe(false)
    expect(isAbsolutePath('C:')).toBe(false)
  })
  it('compares Windows paths case-insensitively and by whole segments', () => {
    expect(isInsidePath('c:/users/ME/notes-app/src', 'C:\\Users\\me\\notes-app')).toBe(true)
    expect(isInsidePath('C:\\Users\\me\\notes-app2', 'C:\\Users\\me\\notes-app')).toBe(false)
    expect(isInsidePath('/home/Me/x', '/home/me')).toBe(false)
    expect(parentPath('C:\\a\\b.txt')).toBe('C:/a')
    expect(parentPath('C:\\b.txt')).toBe('C:/')
  })
})

describe('permissionLocation', () => {
  it('places an edit in the project with its relative path', () => {
    expect(permissionLocation('Edit', { file_path: 'src/example.ts' }, WIN)).toMatchObject({ kind: 'project', label: 'In the project', detail: 'src/example.ts', attention: false })
    expect(permissionLocation('Write', { file_path: '/home/me/notes-app/a.md' }, POSIX)).toMatchObject({ kind: 'project', detail: 'a.md' })
  })
  it('names a worktree', () => {
    const loc = permissionLocation('Bash', { command: 'cd C:\\Users\\me\\notes-app\\.claude\\worktrees\\agent-a1b2 && npm test' }, WIN)
    expect(loc).toMatchObject({ kind: 'worktree', label: 'Starts in worktree agent-a1b2 (inside the project)', attention: false })
    // A report working in its worktree, relative file path.
    const agentCwd = 'C:\\Users\\me\\notes-app\\.claude\\worktrees\\agent-x'
    expect(permissionLocation('Edit', { file_path: 'src/a.ts' }, { ...WIN, agentCwd })).toMatchObject({ kind: 'worktree', label: 'In worktree agent-x (inside the project)', detail: 'src/a.ts' })
    expect(permissionLocation('Bash', { command: 'npm test' }, { ...WIN, agentCwd })).toMatchObject({ kind: 'worktree', label: 'Starts in worktree agent-x (inside the project)' })
  })
  it('flags a folder outside the project', () => {
    const loc = permissionLocation('Edit', { file_path: 'C:\\Users\\me\\shared-lib\\index.js' }, WIN)
    expect(loc).toMatchObject({ kind: 'outside', attention: true, detail: 'index.js' })
    expect(loc?.label).toBe('Outside the project: C:\\Users\\me\\shared-lib')
    expect(permissionLocation('Edit', { file_path: '../shared-lib/index.js' }, POSIX)?.label).toBe('Outside the project: /home/me/shared-lib')
    expect(permissionLocation('Bash', { command: 'cd .. && ls' }, POSIX)).toMatchObject({ kind: 'outside', label: 'Starts outside the project: /home/me' })
  })
  it('fails closed on commands it cannot follow (review H1)', () => {
    const unknown = (cmd: string, ctx = POSIX): void => {
      const loc = permissionLocation('Bash', { command: cmd }, ctx)
      expect(loc?.kind, cmd).toBe('unknown')
      expect(loc?.attention, cmd).toBe(true)
    }
    unknown('cd -- ~/.ssh && cat id_rsa')
    unknown('cd -P /etc && cat passwd')
    unknown("cd ''/etc && cat passwd")
    unknown('cd "/etc" x && ls')
    unknown('cd $HOME && ls')
    unknown('cd *.d && ls')
    unknown('cd && ls')
    unknown('cd - && ls')
    unknown('(cd / && rm -rf x)')
    unknown('bash -c "cd / && rm -rf x"')
    unknown('sh -lc "cd /; ls"')
    unknown('eval "cd /" && ls')
    unknown('npm test\ncd / && rm -rf x')
    unknown('cd a\\b && ls')
    unknown('pushd /x && popd && ls')
    unknown('cd D: && dir', WIN)
    unknown('cd C:..\\..\\Windows && dir', WIN)
    unknown('cd \\Windows && dir', WIN)
    unknown('cd\\ ; dir', WIN)
    unknown('Set-Location -Path $env:TEMP; ls', WIN)
  })
  it('understands the cd forms it can follow exactly', () => {
    expect(permissionLocation('PowerShell', { command: 'cd..; ls' }, WIN)).toMatchObject({ kind: 'outside', label: 'Starts outside the project: C:\\Users\\me' })
    expect(permissionLocation('Bash', { command: 'cd/d C:\\Users\\me\\notes-app\\src && dir' }, WIN)).toMatchObject({ kind: 'project', detail: 'src' })
    expect(permissionLocation('PowerShell', { command: 'Set-Location -Path C:\\Windows; ls' }, WIN)).toMatchObject({ kind: 'outside' })
    expect(permissionLocation('Bash', { command: 'cd "/home/me/notes-app/my dir" && ls' }, POSIX)).toMatchObject({ kind: 'project', detail: 'my dir' })
  })
  it('treats drive-relative and odd file paths as unclear', () => {
    expect(permissionLocation('Edit', { file_path: 'C:..\\..\\Windows\\x' }, WIN)?.kind).toBe('unknown')
    expect(permissionLocation('Edit', { file_path: '\\Windows\\x' }, WIN)?.kind).toBe('unknown')
    expect(permissionLocation('Edit', { file_path: '/home/me/notes-app\\x' }, POSIX)?.kind).toBe('unknown')
    expect(permissionLocation('Bash', { command: 'ls', cwd: 'D:x' }, WIN)?.kind).toBe('unknown')
  })
  it('replaces invisible characters in the tooltip path', () => {
    expect(permissionLocation('Edit', { file_path: '/home/me/notes-app/a\u202Eb.js' }, POSIX)?.full).not.toMatch(/\u202E/)
  })
  it('names an allowed folder', () => {
    const loc = permissionLocation('Edit', { file_path: '/home/me/shared-lib/x/y.js' }, { ...POSIX, allowedDirectories: ['/home/me/shared-lib'] })
    expect(loc).toMatchObject({ kind: 'allowed', label: 'In an allowed folder: /home/me/shared-lib', detail: 'x/y.js', attention: false })
  })
  it('follows relative cd steps and cwd, and stops at an unknown target', () => {
    expect(permissionLocation('Bash', { command: 'cd packages/api && npm test' }, POSIX)).toMatchObject({ kind: 'project', label: 'Starts in the project', detail: 'packages/api' })
    expect(permissionLocation('Bash', { command: 'npm test', cwd: '/tmp' }, POSIX)).toMatchObject({ kind: 'outside' })
    expect(permissionLocation('Bash', { command: 'cd "$HOME" && rm x' }, POSIX)).toMatchObject({ kind: 'unknown', attention: true })
    expect(permissionLocation('Bash', { command: 'cd ~ && ls' }, POSIX)?.kind).toBe('unknown')
    expect(permissionLocation('Bash', { command: 'cd /d D:\\work && dir' }, WIN)).toMatchObject({ kind: 'outside', label: 'Starts outside the project: D:\\work' })
    expect(permissionLocation('Bash', { command: "cd '/home/me/notes-app/src' && ls" }, POSIX)).toMatchObject({ kind: 'project', detail: 'src' })
    // A trailing cd does not move the real step.
    expect(permissionLocation('Bash', { command: 'npm test && cd /tmp' }, POSIX)?.kind).toBe('project')
  })
  it('gives no line for tools without a place, or a bad project path', () => {
    expect(permissionLocation('WebSearch', { query: 'x' }, POSIX)).toBeNull()
    expect(permissionLocation('Edit', {}, POSIX)).toBeNull()
    expect(permissionLocation('Edit', { file_path: 'a' }, { projectPath: 'relative' })).toBeNull()
    expect(permissionLocation('Edit', null, POSIX)).toBeNull()
  })
  it('strips control and bidi characters from labels', () => {
    const loc = permissionLocation('Edit', { file_path: '/evil\u202Edir/x.js' }, POSIX)
    expect(loc?.label).not.toMatch(/\u202E/)
  })
})

const rules = (...r: string[]): PermissionSuggestion => ({
  type: 'addRules',
  behavior: 'allow',
  destination: 'session',
  rules: r.map((x) => {
    const m = /^([\w-]+)\((.*)\)$/.exec(x)
    return m ? { toolName: m[1], ruleContent: m[2] } : { toolName: x }
  })
})

describe('scopeCopy', () => {
  it('has only the once line without suggestions', () => {
    expect(scopeCopy(undefined)).toEqual({ once: 'Allow once: this call only.' })
    expect(scopeCopy([])).toEqual({ once: 'Allow once: this call only.' })
  })
  it('explains a prefix rule', () => {
    const c = scopeCopy([rules('Bash(npm test:*)')], 'auto')
    expect(c.session).toBe('Allow for session: stops asking for "npm test" commands until you end this session.')
    expect(c.project).toBe('Always allow for project: stops asking for "npm test" commands in this project.')
  })
  it('joins rules, folders and a mode', () => {
    const c = scopeCopy(
      [rules('Bash(git status)', 'WebSearch'), { type: 'addDirectories', directories: ['/home/me/shared-lib'], destination: 'session' }, { type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      'default'
    )
    expect(c.session).toBe('Allow for session: auto-accepts file edits, allows edits and reads in /home/me/shared-lib and stops asking for the command "git status" and every WebSearch call until you end this session.')
    expect(c.project).toBe(
      "Always allow for project: switches this project to Auto-accept file edits, adds /home/me/shared-lib to this project's allowed folders and stops asking for the command \"git status\" and every WebSearch call in this project."
    )
  })
  it('names a server-level MCP rule as every tool of the server', () => {
    expect(scopeCopy([rules('mcp__github')], 'auto').project).toBe('Always allow for project: stops asking for every github tool in this project.')
  })
  it('switches the mode only from Ask for everything risky', () => {
    const mode: PermissionSuggestion = { type: 'setMode', mode: 'acceptEdits', destination: 'session' }
    expect(scopeCopy([mode], 'auto').project).toBe('Always allow for project: the same as Allow for session; nothing is saved for later runs.')
    expect(scopeCopy([mode], 'default').project).toBe('Always allow for project: switches this project to Auto-accept file edits.')
  })
  it('ignores deny rules and malformed entries', () => {
    const deny: PermissionSuggestion = { type: 'addRules', behavior: 'deny', destination: 'session', rules: [{ toolName: 'Bash' }] }
    expect(scopeCopy([deny, null as unknown as PermissionSuggestion])).toEqual({ once: 'Allow once: this call only.' })
  })
})

describe('rule words', () => {
  it('says what a rule covers', () => {
    expect(ruleSubject('Bash(npm test *)')).toBe('"npm test" commands')
    expect(ruleSubject('mcp__github')).toBe('every github tool')
    expect(ruleSubject('mcp__github__*')).toBe('every github tool')
    expect(ruleSubject('Bash')).toBe('every shell command')
    expect(ruleSubject('Read(src/**)')).toBe('Read calls matching src/**')
  })
  it('marks whole-tool and broad chips', () => {
    expect(ruleChip('Edit')).toEqual({ text: 'Edit', wholeTool: true, broad: true })
    expect(ruleChip('Bash(npm test:*)')).toMatchObject({ wholeTool: false, broad: false })
    expect(ruleChip('mcp__github')).toMatchObject({ wholeTool: false, broad: true })
    expect(ruleChip('All tools of github')).toMatchObject({ wholeTool: false, broad: true })
    expect(ruleChip('Edits and reads in /x')).toMatchObject({ wholeTool: false, broad: false })
  })
  it('explains a card without rules, for shell commands only', () => {
    expect(noRuleLine('Bash', false)).toBe('No rule can cover this command (pipes, redirects and $(…) always ask).')
    expect(noRuleLine('Bash', true)).toBeNull()
    expect(noRuleLine('Edit', false)).toBeNull()
  })
  it('collapses duplicate saved rules with a count', () => {
    expect(collapseRules(['Bash(cd:*)', 'WebSearch', 'Bash(cd:*)', 'Bash(cd:*)'])).toEqual([
      { rule: 'Bash(cd:*)', count: 3 },
      { rule: 'WebSearch', count: 1 }
    ])
  })
  it('names the kind of a saved rule', () => {
    expect(ruleInfo('Bash(npm test:*)')).toMatchObject({ kind: 'prefix', label: 'command prefix', live: true })
    expect(ruleInfo('Bash(npm test *)')).toMatchObject({ kind: 'prefix', live: true })
    expect(ruleInfo('Bash(git status)')).toMatchObject({ kind: 'exact', label: 'exact command', live: true })
    expect(ruleInfo('WebSearch')).toMatchObject({ kind: 'wholeTool', label: 'whole tool', live: true })
    expect(ruleInfo('mcp__linear__*')).toMatchObject({ kind: 'server', label: 'all tools of linear', live: true })
    expect(ruleInfo('Edit(/x/**)')).toMatchObject({ kind: 'pattern', live: false })
    expect(ruleInfo('Bash(cd * && ls)')).toMatchObject({ kind: 'pattern', live: false })
  })
  it('never treats the harness server as a server rule', () => {
    expect(mcpServerOf('mcp__orgai')).toBeNull()
    expect(mcpServerOf('mcp__a__b')).toBeNull()
    expect(mcpServerOf('mcp__a_')).toBeNull()
  })
})

describe('checkRuleDraft', () => {
  it('accepts the supported forms', () => {
    for (const r of ['Bash(npm test:*)', 'Bash(npm test *)', 'Bash(git status)', 'WebSearch', 'mcp__github', 'mcp__github__*', ' Read(src/**) ']) {
      expect(checkRuleDraft(r).ok).toBe(true)
    }
  })
  it('refuses whole-tool shell and edit rules with a reason', () => {
    for (const r of ['Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      const c = checkRuleDraft(r)
      expect(c.ok).toBe(false)
      if (!c.ok) expect(c.reason).toMatch(/whole-tool/)
    }
    const all = checkRuleDraft('Bash(*)')
    expect(all.ok).toBe(false)
  })
  it('refuses malformed drafts', () => {
    expect(checkRuleDraft('').ok).toBe(false)
    expect(checkRuleDraft('a\nb').ok).toBe(false)
    expect(checkRuleDraft('mcp__*').ok).toBe(false)
    expect(checkRuleDraft('mcp__orgai__*').ok).toBe(false)
    expect(checkRuleDraft('mcp__orgai').ok).toBe(false)
    expect(checkRuleDraft('Bash(').ok).toBe(false)
    expect(checkRuleDraft('1abc').ok).toBe(false)
    expect(checkRuleDraft(`Bash(${'x'.repeat(600)})`).ok).toBe(false)
    for (const r of ['Bash(*:*)', 'Bash(* *)', 'Bash( )', 'Bash(:*)']) expect(checkRuleDraft(r).ok, r).toBe(false)
  })
  it('refuses a single leading slash on file rules', () => {
    const c = checkRuleDraft('Edit(/Users/me/docs/**)')
    expect(c.ok).toBe(false)
    if (!c.ok) expect(c.reason).toBe(SINGLE_SLASH_REASON)
    expect(checkRuleDraft('Read(/etc/hosts)').ok).toBe(false)
    expect(checkRuleDraft('Edit(//Users/me/docs/**)').ok).toBe(true)
    expect(checkRuleDraft('Edit(src/**)').ok).toBe(true)
  })
  it('warns on destructive prefixes and server-wide rules', () => {
    const rm = checkRuleDraft('Bash(rm -rf:*)')
    expect(rm.ok && rm.warning).toMatch(/Careful/)
    const push = checkRuleDraft('Bash(git push:*)')
    expect(push.ok && push.warning).toMatch(/Careful/)
    const srv = checkRuleDraft('mcp__github')
    expect(srv.ok && srv.warning).toMatch(/every tool of github/)
    const ok = checkRuleDraft('Bash(npm test:*)')
    expect(ok.ok && ok.warning).toBeFalsy()
  })
})

describe('modes', () => {
  it('has a trade-off for every mode and knows where rules apply', () => {
    expect(PERMISSION_MODE_TRADEOFF.auto).toMatch(/Fewest prompts/)
    expect(PERMISSION_MODE_TRADEOFF.default).toMatch(/Most prompts/)
    expect(rulesApplyInMode('acceptEdits')).toBe(true)
    expect(rulesApplyInMode('plan')).toBe(false)
    expect(rulesApplyInMode('bypassPermissions')).toBe(false)
  })
})

describe('allowed folders', () => {
  it('checks a draft', () => {
    expect(allowedFolderDraftProblem('  ', [])).toMatch(/Enter/)
    expect(allowedFolderDraftProblem('C:\\A\\b\\', ['c:/a/b'])).toMatch(/already/)
    expect(allowedFolderDraftProblem('/x', Array.from({ length: 20 }, (_, i) => `/d${i}`))).toMatch(/at most 20/)
    expect(allowedFolderDraftProblem('/x'.repeat(600), [])).toMatch(/too long/)
    expect(allowedFolderDraftProblem('/x', ['/y'])).toBeNull()
  })
  it('finds folders main dropped', () => {
    expect(droppedFolders(['/a', 'rel', 'C:\\X\\'], ['/a', 'C:\\X'])).toEqual(['rel'])
    expect(droppedFolders(['/a', '/a'], ['/a'])).toEqual([])
    expect(droppedFolders(['rel'], undefined)).toEqual(['rel'])
    expect(droppedFolderNotice('rel')).toBe("rel was not saved: must be an absolute folder, not a drive root, not OrgAI's data folder, and not the same folder as one already listed.")
  })
})
