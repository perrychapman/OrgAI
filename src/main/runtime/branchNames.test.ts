import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { gitExecutable } from '../host/systemBinaries'
import { BRANCH_SLUG_MAX, branchNameFor, branchNameMatcher, cleanBranchNamePattern, defaultBranchName, isValidBranchName, slugPart } from './branchNames'

describe('slugPart', () => {
  it('lower-cases, collapses anything but [a-z0-9] to one dash and trims dashes', () => {
    expect(slugPart('Fix the Login Bug!')).toBe('fix-the-login-bug')
    expect(slugPart('  --a__b--  ')).toBe('a-b')
    expect(slugPart('Zażółć gęślą')).toMatch(/^[a-z0-9-]+$/)
  })

  it('cuts at the maximum and never ends with a dash', () => {
    const slug = slugPart(`${'a'.repeat(39)} tail`)
    expect(slug).toBe('a'.repeat(39))
    expect(slugPart('x'.repeat(100)).length).toBe(BRANCH_SLUG_MAX)
    expect(slugPart('word '.repeat(30)).endsWith('-')).toBe(false)
  })

  it('gives an empty string for nothing usable or a non-string', () => {
    for (const v of ['', '   ', '///', '日本語', 5, null, undefined, {}]) expect(slugPart(v)).toBe('')
  })
})

describe('isValidBranchName', () => {
  it('accepts ordinary report and feature names', () => {
    for (const ok of ['worktree-agent-ab12', 'orgai/fix-login-ab12', 'release/1.2.x', 'a', 'a.b/c_d']) expect(isValidBranchName(ok), ok).toBe(true)
  })

  it('refuses the names git refuses and the ones that read as options or paths', () => {
    const bad = [
      '', '-x', '--force', '/a', 'a/', 'a//b', 'a..b', '../a', 'a.', 'a.lock', 'a/b.lock', 'a/.b', '.a', '@', 'a@{u}', 'a b', 'a\tb', 'a\nb', 'a\u007fb', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[0]', 'a\\b',
      'x'.repeat(201), 'ünï', 5, null, undefined
    ]
    for (const name of bad) expect(isValidBranchName(name), String(name)).toBe(false)
  })

  it('agrees with git check-ref-format on a spread of names', () => {
    const bin = gitExecutable()
    if (!bin) return
    const dir = mkdtempSync(join(tmpdir(), 'orgai-refname-'))
    try {
      const names = ['ok', 'a/b', 'a.b', 'a..b', 'a/.b', 'a.lock', 'a/b.lock', 'a//b', 'a/', '/a', 'a b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a@{b', '@', 'a.', 'a-b_c', '1.2.3']
      for (const name of names) {
        let gitOk = true
        try {
          execFileSync(bin, ['check-ref-format', '--branch', name], { cwd: dir, stdio: 'ignore' })
        } catch {
          gitOk = false
        }
        // OrgAI is allowed to be stricter, never looser.
        if (!gitOk) expect(isValidBranchName(name), name).toBe(false)
        if (isValidBranchName(name)) expect(gitOk, name).toBe(true)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('cleanBranchNamePattern', () => {
  it('keeps safe patterns, trimmed', () => {
    expect(cleanBranchNamePattern('orgai/{task}')).toBe('orgai/{task}')
    expect(cleanBranchNamePattern(' team/{role}/{task}-{id} ')).toBe('team/{role}/{task}-{id}')
    expect(cleanBranchNamePattern('a'.repeat(80))).toBe('a'.repeat(80))
  })

  it('drops traversal, ref injection, unknown placeholders and every shape git or a shell could misread', () => {
    const bad = [
      '', '../x', 'a/../b', 'a//b', '/x', '-x', '.x', 'a/', 'a.', 'a.lock', 'a/.b', 'a.lock/b', 'a'.repeat(81), '{task', 'task}', '{id}}', '{foo}', '{TASK}', '{}', 'a b', 'a@{u}', 'a~', 'a^', 'a:', 'a?', 'a*', 'a[', 'a\\',
      'a;b', 'a|b', 'a$b', 'a`b', 'a$(x)', 'a\u0000b', '日本/{task}', 7, null, undefined
    ]
    for (const value of bad) expect(cleanBranchNamePattern(value), String(value)).toBeUndefined()
  })
})

describe('branchNameFor', () => {
  const parts = { task: 'Fix the login bug', role: 'Backend Dev', id: 'a1b2c3' }

  it('expands the placeholders as slugs', () => {
    expect(branchNameFor('orgai/{task}-{id}', parts)).toBe('orgai/fix-the-login-bug-a1b2c3')
    expect(branchNameFor('team/{role}/{task}-{id}', parts)).toBe('team/backend-dev/fix-the-login-bug-a1b2c3')
  })

  it('appends -<id> when the pattern has no {id}', () => {
    expect(branchNameFor('orgai/{task}', parts)).toBe('orgai/fix-the-login-bug-a1b2c3')
    expect(branchNameFor('orgai/work', parts)).toBe('orgai/work-a1b2c3')
  })

  it('keeps each slug within the maximum and the whole name valid', () => {
    const name = branchNameFor('orgai/{role}/{task}', { task: 'x '.repeat(100), role: 'r'.repeat(100), id: 'i'.repeat(100) })
    expect(isValidBranchName(name)).toBe(true)
    for (const part of name.slice('orgai/'.length).split('/')) expect(part.length).toBeLessThanOrEqual(BRANCH_SLUG_MAX * 2 + 1)
  })

  it('says "task" or "role" for a placeholder with nothing usable', () => {
    expect(branchNameFor('orgai/{role}/{task}', { task: '!!!', role: '', id: 'q9' })).toBe('orgai/role/task-q9')
  })

  it('never lets a hostile brief out of [a-z0-9-]', () => {
    const name = branchNameFor('orgai/{task}', { task: '../../etc/passwd; rm -rf ~ $(whoami) @{u} --force', id: 'z1' })
    expect(name).toMatch(/^orgai\/[a-z0-9-]+$/)
    expect(isValidBranchName(name)).toBe(true)
  })

  it("falls back to today's name for no pattern, an unusable pattern and an unusable id", () => {
    expect(branchNameFor(undefined, parts)).toBe('worktree-agent-a1b2c3')
    expect(branchNameFor('', parts)).toBe('worktree-agent-a1b2c3')
    expect(branchNameFor('../{task}', parts)).toBe('worktree-agent-a1b2c3')
    expect(branchNameFor('{task', parts)).toBe('worktree-agent-a1b2c3')
    expect(branchNameFor(undefined, { id: 'A/B C' })).toBe('worktree-agent-a-b-c')
    expect(branchNameFor(undefined, { id: '' })).toBe('worktree-agent-agent')
    expect(defaultBranchName('xyz')).toBe('worktree-agent-xyz')
  })

  it('falls back to today\'s name when the expanded name would be too long', () => {
    const pattern = 'orgai/' + '{task}/'.repeat(10) + 'end'
    expect(cleanBranchNamePattern(pattern)).toBe(pattern)
    expect(branchNameFor(pattern, { task: 't'.repeat(60), id: 'i1' })).toBe('worktree-agent-i1')
  })
})

describe('branchNameMatcher', () => {
  it('matches the names branchNameFor makes and nothing else', () => {
    const matcher = branchNameMatcher('orgai/{task}')
    expect(matcher).not.toBeNull()
    expect(matcher?.test(branchNameFor('orgai/{task}', { task: 'Fix login', id: 'ab12' }))).toBe(true)
    expect(matcher?.test('orgai/fix-login')).toBe(true)
    for (const other of ['main', 'orgai', 'orgai/', 'orgai/Fix', 'feature/orgai/x-y', 'orgai/x-y/z', 'orgaiX/x-y', 'xorgai/x-y']) expect(matcher?.test(other), other).toBe(false)
  })

  it('handles {id} in the pattern and regex characters in the literal part', () => {
    const matcher = branchNameMatcher('team.v1/{role}-{id}')
    expect(matcher?.test('team.v1/dev-ab12')).toBe(true)
    expect(matcher?.test('teamxv1/dev-ab12')).toBe(false)
  })

  it('is null when the pattern could match the user\'s own branches or is unusable', () => {
    for (const pattern of ['{task}', '{role}/{task}', 'a/{task}', 'a-{task}', undefined, '', '../x/{task}', '{bad}']) expect(branchNameMatcher(pattern), String(pattern)).toBeNull()
  })

  it('does not take long on a long hostile name', () => {
    const matcher = branchNameMatcher('orgai/{task}-{role}-{id}')
    const started = Date.now()
    expect(matcher?.test(`orgai/${'a-'.repeat(120)}!`)).toBe(false)
    expect(Date.now() - started).toBeLessThan(500)
  })
})
