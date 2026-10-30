import { describe, expect, it } from 'vitest'
import { isValidRule, matchesBashRule, matchingRule, shellRulesFor, splitCommand, unwrapShellCommand } from './ruleMatch'

describe('isValidRule', () => {
  it('accepts tool names, prefix rules and exact rules', () => {
    for (const r of ['WebSearch', 'Bash(gh:*)', 'Bash(git push:*)', 'Bash(git status)', 'WebFetch(domain:example.com)', ' Bash(npm run:*) ']) {
      expect(isValidRule(r), r).toBe(true)
    }
  })
  it('rejects empty, multi-line and malformed rules', () => {
    for (const r of ['', '  ', 'Bash(', 'Bash()', 'gh repo create', 'Bash(x)\nrm', '(Bash)', '1Tool']) expect(isValidRule(r), JSON.stringify(r)).toBe(false)
  })
})

describe('splitCommand', () => {
  it('splits on && || ; outside quotes', () => {
    expect(splitCommand('gh repo create x --public && git push -u origin main; git branch dev')).toEqual([
      'gh repo create x --public',
      'git push -u origin main',
      'git branch dev'
    ])
    expect(splitCommand(`git commit -m "a && b; c" || echo no`)).toEqual([`git commit -m "a && b; c"`, 'echo no'])
    expect(splitCommand("echo 'a;b'")).toEqual(["echo 'a;b'"])
  })
  it('keeps empty segments so a trailing operator cannot match', () => {
    expect(splitCommand('npm test &&')).toEqual(['npm test', ''])
  })
})

describe('shellRulesFor / matchesBashRule', () => {
  const rules = ['Bash(npm test:*)', 'Bash(git status)', 'Bash(gh:*)', 'Bash(git push:*)', 'Edit', 'Read']
  it('matches prefix and exact rules as whole words', () => {
    expect(matchesBashRule('npm test', rules)).toBe(true)
    expect(matchesBashRule('npm test -- --watch', rules)).toBe(true)
    expect(matchesBashRule('git status', rules)).toBe(true)
    expect(matchesBashRule('git status -s', rules)).toBe(false)
    expect(matchesBashRule('npm testing', rules)).toBe(false)
    expect(matchesBashRule('npm install', rules)).toBe(false)
    expect(matchesBashRule('ghx', rules)).toBe(false)
  })
  it('covers compound commands only when every segment is covered, and names the rules used', () => {
    expect(shellRulesFor('gh repo create a/b --public --push && git push -u origin dev', rules)).toEqual(['Bash(gh:*)', 'Bash(git push:*)'])
    expect(shellRulesFor('gh repo create a/b && git branch dev', rules)).toBeNull()
    expect(shellRulesFor('npm test; npm test', rules)).toEqual(['Bash(npm test:*)'])
    expect(matchesBashRule('npm test && rm -rf x', rules)).toBe(false)
    expect(matchesBashRule('npm test &&', rules)).toBe(false)
  })
  it('never matches pipes, redirects, substitution, background jobs or newlines', () => {
    for (const c of ['npm test | tee out', 'npm test > out.txt', 'npm test $(whoami)', 'npm test `id`', 'npm test\nrm x', 'npm test &', 'npm test < in']) {
      expect(matchesBashRule(c, rules), c).toBe(false)
    }
  })
  it('unwraps shell wrappers', () => {
    expect(matchesBashRule(`bash -lc 'npm test --silent'`, rules)).toBe(true)
    expect(matchesBashRule(`bash -lc 'npm test && rm x'`, rules)).toBe(false)
    expect(unwrapShellCommand('ls -la')).toBe('ls -la')
  })
  it('ignores a wildcard-only or empty prefix', () => {
    expect(matchesBashRule('anything', ['Bash(:*)', 'Bash(*)'])).toBe(false)
  })
})

describe('matchingRule', () => {
  const rules = ['WebSearch', 'Bash(gh:*)', 'PowerShell(Get-ChildItem:*)', 'Read(//tmp/**)']
  it('allows a whole tool by name and a shell command by its tool rules', () => {
    expect(matchingRule('WebSearch', { query: 'x' }, rules)).toBe('WebSearch')
    expect(matchingRule('Bash', { command: 'gh repo create a/b --public' }, rules)).toBe('Bash(gh:*)')
    expect(matchingRule('PowerShell', { command: 'Get-ChildItem .' }, rules)).toBe('PowerShell(Get-ChildItem:*)')
  })
  it('does not cross tools or decide content rules it does not understand', () => {
    expect(matchingRule('PowerShell', { command: 'gh repo create a/b' }, rules)).toBeUndefined()
    expect(matchingRule('Bash', { command: 'Get-ChildItem .' }, rules)).toBeUndefined()
    expect(matchingRule('Read', { file_path: '/tmp/x' }, rules)).toBeUndefined()
    expect(matchingRule('Bash', {}, rules)).toBeUndefined()
    expect(matchingRule('Bash', { command: 'rm -rf /' }, ['Bash'])).toBe('Bash')
  })
})
