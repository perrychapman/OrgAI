import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { COMMANDS } from '../commandTable'
import { fakeContext } from '../testing/fakeContext'
import { EXIT } from '../types'
import { completionCommands, completionScript, runCompletions, SHELLS } from './completions'

function hasShell(sh: string): boolean {
  try {
    execFileSync(sh, ['-c', 'exit 0'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe('orgai completions', () => {
  for (const shell of SHELLS) {
    it(`${shell}: lists every available command, its subcommands and flag values`, async () => {
      const f = fakeContext()
      expect(await runCompletions(f.ctx, [shell])).toBe(EXIT.ok)
      const out = f.out()
      for (const c of COMMANDS.filter((x) => x.available)) {
        expect(out).toContain(c.name)
        for (const s of c.subcommands ?? []) expect(out).toContain(s)
      }
      expect(out).toContain('stream-json')
      expect(out).toContain('inproc')
      expect(out).toContain('all-projects')
    })

    it.skipIf(!hasShell(shell))(`${shell}: the script parses`, () => {
      const flag = shell === 'fish' ? '--no-execute' : '-n'
      execFileSync(shell, [flag], { input: completionScript(shell), stdio: ['pipe', 'pipe', 'pipe'] })
    })
  }

  it('offers available commands only', () => {
    expect(completionCommands().map((c) => c.entry.name)).toEqual(COMMANDS.filter((x) => x.available).map((x) => x.name))
    expect(completionScript('bash')).not.toMatch(/compgen -W "[^"]*\bexec\b/)
  })

  it('an unknown shell is exit 2', async () => {
    const f = fakeContext()
    await expect(runCompletions(f.ctx, ['powershell'])).rejects.toMatchObject({ exitCode: EXIT.usage })
    await expect(runCompletions(f.ctx, [])).rejects.toMatchObject({ exitCode: EXIT.usage })
  })
})
