import { describe, expect, it } from 'vitest'
import {
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
    // The card reads any second line as hidden (isHiddenCommand), which is stricter than the 2-line limit.
    expect(inlineAllowable(sh('a\nb'))).toBe(false)
    expect(inlineAllowable(sh('a\nb\nc'))).toBe(false)
    // Past about 120 characters the card's own title is clipped, so isHiddenCommand already refuses.
    expect(inlineAllowable(sh('x'.repeat(100)))).toBe(true)
    expect(inlineAllowable(sh('x'.repeat(201)))).toBe(false)
  })
  it('refuses a compound command the card reads as hidden steps', () => {
    expect(inlineAllowable(sh('cd src && npm test'))).toBe(false)
  })
  it('refuses a shell request without a command', () => {
    expect(inlineAllowable({ toolName: 'PowerShell', input: {} })).toBe(false)
  })
  it('allows file tools with a path', () => {
    expect(inlineAllowable({ toolName: 'Edit', input: { file_path: '/p/a.ts' } })).toBe(true)
    expect(inlineAllowable({ toolName: 'Write', input: { file_path: 'a.ts' } })).toBe(true)
    expect(inlineAllowable({ toolName: 'Read', input: { path: '/p' } })).toBe(true)
    expect(inlineAllowable({ toolName: 'Edit', input: {} })).toBe(false)
  })
  it('allows other tools only with a short clean summary', () => {
    expect(inlineAllowable({ toolName: 'WebFetch', summary: 'Fetch example.com' })).toBe(true)
    expect(inlineAllowable({ toolName: 'WebFetch', summary: 'x'.repeat(201) })).toBe(false)
    expect(inlineAllowable({ toolName: 'WebFetch', summary: 'a\u202eb' })).toBe(false)
    expect(inlineAllowable({ toolName: 'WebFetch', summary: '' })).toBe(false)
  })
  it('sets the row mode', () => {
    expect(permissionInlineMode(sh('npm test'))).toBe('allow')
    expect(permissionInlineMode(sh('a\nb\nc'))).toBe('none')
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
  it('flags a long command and shows its first line only', () => {
    const a = permissionAsk(sh('a\nb\nc'), 'x')
    expect(a.long).toBe(true)
    expect(a.object).toBe('a')
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
  it('names other tools and uses the summary', () => {
    const a = permissionAsk({ toolName: 'WebFetch', summary: 'Fetch example.com' }, 'w')
    expect(a).toMatchObject({ kind: 'other', lead: 'w wants to use WebFetch:', object: 'Fetch example.com' })
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
  })
})
