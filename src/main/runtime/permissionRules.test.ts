import { describe, expect, it } from 'vitest'
import { isUnsafeAllowRule, isWholeToolRule } from './permissionRules'

describe('isUnsafeAllowRule', () => {
  it('accepts the safe workflow and git commands the Architect proposes', () => {
    for (const r of ['Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git worktree:*)', 'WebSearch', 'Read', 'mcp__orgai__x']) {
      expect(isUnsafeAllowRule(r), r).toBe(false)
    }
  })

  it('refuses blanket shell access and destructive commands', () => {
    for (const r of ['Bash', 'PowerShell', 'Bash()', 'Bash(*)', 'Bash(:*)', 'Bash(rm:*)', 'Bash(rm -rf node_modules)', 'Bash(sudo:*)', 'Bash(git push:*)', 'Bash(git reset --hard:*)', 'Bash(git clean -fd)', 'PowerShell(Remove-Item:*)', 'not a rule!']) {
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
