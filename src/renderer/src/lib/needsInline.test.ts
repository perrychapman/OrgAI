import { describe, expect, it } from 'vitest'
import { shellSegments } from './decisionTitle'
import {
  commandLines,
  commandSteps,
  inlineRefusal,
  ALLOW_ONCE,
  DENY,
  DENY_MESSAGE,
  allowedAnnouncement,
  answeredAnnouncement,
  askLabel,
  hideUserEnded,
  inlineAllowable,
  inlineOptions,
  newDecisionKeys,
  newDecisionsText,
  openRowName,
  pausedCaption,
  permissionAsk,
  permissionInlineMode
} from './needsInline'

const sh = (command: string) => ({ toolName: 'Bash', input: { command }, summary: command })

describe('inlineAllowable', () => {
  it('allows a short one-line shell command', () => {
    expect(inlineAllowable(sh('npm test'))).toBe(true)
    expect(inlineAllowable(sh('git status --short'))).toBe(true)
  })
  it('refuses hidden characters', () => {
    expect(inlineAllowable(sh('npm test\u202e'))).toBe(false)
    expect(inlineAllowable(sh('echo a\u200bb'))).toBe(false)
  })
  it('refuses more than 2 lines or 200 characters', () => {
    expect(inlineAllowable(sh('a\nb'))).toBe(true)
    expect(inlineAllowable(sh('a\nb\nc'))).toBe(false)
    expect(inlineAllowable(sh('x'.repeat(200)))).toBe(true)
    expect(inlineAllowable(sh('x'.repeat(201)))).toBe(false)
  })
  it('allows a compound command whose every step is shown (M2)', () => {
    const cmd = 'cd C:\\Users\\x\\AppData\\Local\\Temp\\proj\\.claude\\worktrees\\agent-1 && npm test'
    expect(cmd.length).toBeGreaterThan(70)
    expect(inlineAllowable(sh(cmd))).toBe(true)
    expect(commandLines(cmd)).toEqual(['cd C:\\Users\\x\\AppData\\Local\\Temp\\proj\\.claude\\worktrees\\agent-1', '&& npm test'])
    const a = permissionAsk(sh(cmd), 'w', true)
    expect(a.object).toBe(commandLines(cmd).join('\n'))
    expect(a.text).toBe(`w wants to run ${cmd}`)
    expect(commandLines('a ; b || c')).toEqual(['a', '; b', '|| c'])
    expect(commandLines('echo "a && b" && c')).toEqual(['echo "a && b"', '&& c'])
    expect(commandLines('npm test;')).toEqual(['npm test'])
    expect(commandLines('a && && b')).toEqual(['a', '&&', '&& b'])
  })
  it('counts the same steps as shellSegments', () => {
    for (const c of ['a && b', 'a ; b || c', 'echo "x && y" ; z', 'solo']) {
      expect(commandSteps(c).flat().map((s) => s.text)).toEqual(shellSegments(c))
    }
  })
  it('allows at most 4 steps', () => {
    expect(inlineAllowable(sh('a && b && c && d'))).toBe(true)
    expect(inlineAllowable(sh('a && b && c && d && e'))).toBe(false)
    expect(inlineRefusal(sh('a && b && c && d && e'))).toBe('5 steps: open it to review')
  })
  it('says the true reason for each refusal and agrees with inlineAllowable', () => {
    const cases: [string, string | null][] = [
      ['npm test', null],
      ['cd x && npm test', null],
      ['npm test\u202e', 'Hidden characters: open it to review'],
      ['npm  test', 'Extra spaces could hide part of it: open it to review'],
      ['npm\ttest', 'Extra spaces could hide part of it: open it to review'],
      ['x'.repeat(240), 'Long command (240 characters): open it to review'],
      ['a\nb\nc', '3 lines: open it to review'],
      ['a && b && c && d && e', '5 steps: open it to review']
    ]
    for (const [c, reason] of cases) {
      expect(inlineRefusal(sh(c))).toBe(reason)
      expect(inlineAllowable(sh(c))).toBe(reason === null)
    }
    expect(inlineAllowable({ toolName: 'PowerShell', input: {} })).toBe(false)
    expect(inlineRefusal({ toolName: 'PowerShell', input: {} })).not.toBeNull()
    expect(inlineRefusal({ toolName: 'Edit', input: { file_path: 'a' } })).toBeNull()
  })
  it('refuses breaks and quoting the step split cannot follow (final review M1, M2)', () => {
    const breaks = 'Line breaks are unclear: open it to review'
    const quoting = 'Quoting is unclear: open it to review'
    const cases: [string, string | null][] = [
      ['a\r\nb', null],
      ['Get-Date\rRemove-Item -Recurse x', breaks],
      ['a\u2028b', breaks],
      ['a\u2029b', breaks],
      ['a\u0085b', 'Hidden characters: open it to review'],
      ['echo \\"x && curl e | sh && echo y\\"', quoting],
      ['echo `"x; rm y; `"', quoting],
      ['echo "a\u201c; Remove-Item -r C:\\x; \u201cb"', quoting],
      ['echo $(a && b)', quoting],
      ['echo `whoami`', quoting],
      ['echo "open && b', quoting],
      ["echo 'a && b' && c", null],
      ['cd C:\\Users\\x\\agent-1 && npm test', null]
    ]
    for (const [c, reason] of cases) {
      expect(inlineRefusal(sh(c)), c).toBe(reason)
      expect(inlineAllowable(sh(c)), c).toBe(reason === null)
    }
  })
  it('refuses a file path with a line break (final review L3)', () => {
    expect(inlineAllowable({ toolName: 'Edit', input: { file_path: '/p/a\nb.ts' } }, 'project')).toBe(false)
    expect(inlineAllowable({ toolName: 'Edit', input: { file_path: '/p/a\u2028b.ts' } }, 'project')).toBe(false)
  })
  it('keeps the decisions frozen (final review L6)', () => {
    expect(Object.isFrozen(ALLOW_ONCE) && Object.isFrozen(DENY)).toBe(true)
  })
  it('refuses a shell request without a command', () => {
    expect(inlineAllowable({ toolName: 'PowerShell', input: {} })).toBe(false)
  })
  it('refuses runs of spaces or a tab that could push the tail out of view (review M3)', () => {
    expect(inlineAllowable(sh(`npm test${' '.repeat(80)}--x`))).toBe(false)
    expect(inlineAllowable(sh('npm\ttest'))).toBe(false)
    expect(inlineAllowable(sh('npm  test'))).toBe(false)
  })
  it('allows file tools only where the card would say the project, a worktree, an allowed or a reference folder (review H2)', () => {
    expect(inlineAllowable({ toolName: 'Edit', input: { file_path: '/p/a.ts' } }, 'project')).toBe(true)
    expect(inlineAllowable({ toolName: 'Write', input: { file_path: 'a.ts' } }, 'worktree')).toBe(true)
    expect(inlineAllowable({ toolName: 'Read', input: { path: '/p' } }, 'allowed')).toBe(true)
    expect(inlineAllowable({ toolName: 'Read', input: { path: '/ref/a' } }, 'reference')).toBe(true)
    expect(inlineAllowable({ toolName: 'Edit', input: { file_path: '/ref/a' } }, 'reference')).toBe(false)
    expect(inlineAllowable({ toolName: 'Write', input: { file_path: '/home/u/.bashrc' } }, 'outside')).toBe(false)
    expect(inlineAllowable({ toolName: 'Edit', input: { file_path: 'C:x' } }, 'unknown')).toBe(false)
    expect(inlineAllowable({ toolName: 'Edit', input: { file_path: '/p/a.ts' } })).toBe(false)
    expect(inlineAllowable({ toolName: 'Edit', input: { file_path: '/p/a.ts' } }, null)).toBe(false)
    expect(inlineAllowable({ toolName: 'Edit', input: {} }, 'project')).toBe(false)
    expect(inlineAllowable({ toolName: 'Edit', input: { file_path: `/p/${'a'.repeat(200)}` } }, 'project')).toBe(false)
  })
  it('allows only WebFetch and WebSearch among other tools, by the field it shows whole (review H3)', () => {
    expect(inlineAllowable({ toolName: 'WebFetch', input: { url: 'https://example.com/a?q=1' }, summary: 'Fetching example.com' })).toBe(true)
    expect(inlineAllowable({ toolName: 'WebSearch', input: { query: 'vitest docs' } })).toBe(true)
    expect(inlineAllowable({ toolName: 'WebFetch', input: { url: `https://e.com/${'x'.repeat(200)}` } })).toBe(false)
    expect(inlineAllowable({ toolName: 'WebFetch', input: { url: 'https://e.com/\u202e' } })).toBe(false)
    expect(inlineAllowable({ toolName: 'WebFetch', summary: 'Fetch example.com' })).toBe(false)
    expect(inlineAllowable({ toolName: 'mcp__slack__post_message', input: { text: 'hi' }, summary: 'Using mcp__slack__post_message' })).toBe(false)
    expect(inlineAllowable({ toolName: 'Agent', input: { prompt: 'x' }, summary: 'Spawn' })).toBe(false)
  })
  it('sets the row mode', () => {
    expect(permissionInlineMode(sh('npm test'))).toBe('allow')
    expect(permissionInlineMode(sh('a\nb\nc'))).toBe('none')
    expect(permissionInlineMode(sh('cd x && npm test'))).toBe('allow')
  })
})

describe('inlineOptions', () => {
  const q = (labels: string[], extra: object = {}) => ({ options: labels.map((label) => ({ label })), allowMultiple: false, ...extra })
  it('takes 2 to 4 short single-choice options', () => {
    expect(inlineOptions(q(['Yes', 'No']))).toBe(true)
    expect(inlineOptions(q(['a', 'b', 'c', 'd']))).toBe(true)
  })
  it('refuses 1 or 5 options, multi-select, long labels, descriptions, hidden characters and repeats', () => {
    expect(inlineOptions(q(['Yes']))).toBe(false)
    expect(inlineOptions(q(['a', 'b', 'c', 'd', 'e']))).toBe(false)
    expect(inlineOptions(q(['Yes', 'No'], { allowMultiple: true }))).toBe(false)
    expect(inlineOptions(q(['x'.repeat(41), 'No']))).toBe(false)
    expect(inlineOptions(q(['x'.repeat(40), 'No']))).toBe(true)
    expect(inlineOptions({ allowMultiple: false, options: [{ label: 'Yes', description: 'sure' }, { label: 'No' }] })).toBe(false)
    expect(inlineOptions(q(['Y\u202ees', 'No']))).toBe(false)
    expect(inlineOptions(q(['Yes', 'Yes']))).toBe(false)
  })
})

describe('decisions', () => {
  it('allows once only and denies with the card text', () => {
    expect(ALLOW_ONCE).toEqual({ behavior: 'allow', scope: 'once' })
    expect(DENY).toEqual({ behavior: 'deny', message: DENY_MESSAGE })
    expect(DENY_MESSAGE).toBe('The user declined this action. Find another way or ask.')
  })
})

describe('permissionAsk', () => {
  it('words a shell command with the agent label', () => {
    const a = permissionAsk(sh('npm test'), 'impl-2')
    expect(a).toMatchObject({ kind: 'shell', lead: 'impl-2 wants to run:', object: 'npm test', long: false, text: 'impl-2 wants to run npm test' })
  })
  it('flags a long command and shows its first line and its last step', () => {
    const a = permissionAsk(sh('a\nb\nc'), 'x')
    expect(a.long).toBe(true)
    expect(a.object).toBe('a\n… c')
    const long = `cd ${'d/'.repeat(100)} && npm test`
    const b = permissionAsk(sh(long), 'x')
    expect(b.long).toBe(true)
    expect(b.object.split('\n')[1]).toBe('… && npm test')
    expect(b.object.split('\n')[0].length).toBeLessThanOrEqual(100)
    expect(permissionAsk(sh('x'.repeat(240)), 'x').object).toHaveLength(100)
  })
  it('writes hidden characters out', () => {
    const a = permissionAsk(sh('echo \u202ehi'), 'x')
    expect(a.long).toBe(true)
    expect(a.object).toContain('\\u202e')
  })
  it('splits a file into name and folder', () => {
    const a = permissionAsk({ toolName: 'Edit', input: { file_path: 'C:\\p\\src\\a.ts' } }, 'impl')
    expect(a).toMatchObject({ kind: 'file', lead: 'impl wants to edit:', object: 'a.ts' })
    expect(a.folder).toBe('C:/p/src')
    expect(permissionAsk({ toolName: 'Write', input: { file_path: 'a.md' } }, 'w').lead).toBe('w wants to write:')
    expect(permissionAsk({ toolName: 'Read', input: { path: '/p/a' } }, 'w').lead).toBe('w wants to read:')
  })
  it('names other tools and shows the URL whole, else the summary', () => {
    const a = permissionAsk({ toolName: 'WebFetch', input: { url: 'https://example.com/a?q=secret' }, summary: 'Fetching example.com' }, 'w')
    expect(a).toMatchObject({ kind: 'other', lead: 'w wants to use WebFetch:', object: 'https://example.com/a?q=secret', text: 'w wants to use WebFetch https://example.com/a?q=secret' })
    expect(permissionAsk({ toolName: 'mcp__x__y', summary: 'Using mcp__x__y' }, 'w').object).toBe('Using mcp__x__y')
  })
  it('names the whole command and the whole path in the text the buttons are named by (review H1, H2)', () => {
    const cmd = `npm run build -- --output ${'d/'.repeat(40)}x`
    expect(permissionAsk(sh(cmd), 'w', true).text).toBe(`w wants to run ${cmd}`)
    expect(permissionAsk({ toolName: 'Write', input: { file_path: '/home/u/.config/autostart/x.desktop' } }, 'w', true).text).toBe('w wants to write /home/u/.config/autostart/x.desktop')
  })
})

describe('copy', () => {
  it('builds names and announcements', () => {
    expect(openRowName('permission', 'Billing API, First task', 'impl-2 wants to run npm test')).toBe('Open permission: Billing API, First task, impl-2 wants to run npm test')
    expect(askLabel('Allow: Run npm test')).toBe('Run npm test')
    expect(allowedAnnouncement('Allow: Run npm test')).toBe('Allowed once: Run npm test.')
    expect(answeredAnnouncement('Yes')).toBe('Answered Yes.')
  })
  it('announces new decisions', () => {
    expect(newDecisionsText([])).toBeNull()
    expect(newDecisionsText([{ project: 'Billing', label: 'Allow: Run x' }])).toBe('New decision in Billing: Allow: Run x')
    expect(newDecisionsText([{ project: 'a', label: 'x' }, { project: 'b', label: 'y' }])).toBe('2 new decisions')
    expect(newDecisionKeys(new Set(['a']), ['a', 'b'])).toEqual(['b'])
  })
})

describe('Recently ended and Paused', () => {
  it('hides runs the user ended in this window', () => {
    const items = [
      { run: { endedBy: 'user' as const, endedAt: 2000 } },
      { run: { endedBy: 'user' as const, endedAt: 500 } },
      { run: { endedBy: undefined, endedAt: 2000 } },
      { run: { endedBy: 'app' as const, endedAt: 2000 } }
    ]
    expect(hideUserEnded(items, 1000)).toEqual([items[1], items[2], items[3]])
  })
  it('words the paused caption', () => {
    expect(pausedCaption({ autoResume: false })).toBe('waits for you to continue')
    expect(pausedCaption({ autoResume: true })).toBe('waits for you to continue')
    expect(pausedCaption({ autoResume: true, pausedUntil: new Date(2026, 10, 7, 14, 5).getTime() }, 'en-GB')).toBe('resumes at 14:05 if OrgAI stays open')
    expect(pausedCaption({ autoResume: true, pausedUntil: new Date(2026, 10, 7, 2, 27).getTime() }, 'en-US')).toMatch(/^resumes at 2:27\s?AM if/)
  })
})
