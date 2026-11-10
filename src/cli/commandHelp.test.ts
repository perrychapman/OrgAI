import { describe, expect, it } from 'vitest'
import { COMMANDS } from './commandTable'
import { commandHelp, generalHelp } from './index'
import { completionScript, SHELLS } from './commands/completions'

/** Every command the cli-parity packages added shows in --help with a summary, in its own help and in completions. */
const RECENT: Record<string, string[]> = {
  settings: ['settings get <key>', 'settings set <key> <value>'],
  connections: ['connections tier <id>', '--reset', '--dry-run'],
  models: ['resolve', 'prices [set|unset <model>]', '--input', '--cache-write'],
  team: ['role add <name>', 'role set <role>', 'role rm <role>', 'role move <role>', '--reports-to'],
  org: ['draft "<description>"', '--apply', '--from', 'revise "<instruction>"'],
  runs: ['runs model <runId-or-R#>', '--logs'],
  resume: ['--now', '--cancel-auto-resume'],
  exec: ['--image'],
  outputs: ['outputs show <output>', 'outputs revise <output> "<instruction>"', 'outputs note <output> "<text>"', 'list [--run <run>]']
}

describe('help and completions cover the recently added commands', () => {
  it('lists each command with a one-line summary in orgai --help', () => {
    const help = generalHelp()
    for (const name of Object.keys(RECENT)) {
      const entry = COMMANDS.find((c) => c.name === name)
      expect(entry, name).toBeDefined()
      expect(entry!.available).toBe(true)
      expect(entry!.summary).not.toMatch(/\n/)
      expect(entry!.summary.length).toBeGreaterThan(8)
      expect(help).toContain(entry!.summary)
    }
  })

  it('names each new form in the command help', () => {
    for (const [name, needles] of Object.entries(RECENT)) {
      const text = commandHelp(COMMANDS.find((c) => c.name === name)!)
      for (const n of needles) expect(text, `${name}: ${n}`).toContain(n)
    }
  })

  it('completions come from the table: outputs and its subcommands are offered', () => {
    for (const shell of SHELLS) {
      const script = completionScript(shell)
      for (const w of ['outputs', 'revise', 'note', 'tier', 'resolve']) expect(script, `${shell} ${w}`).toContain(w)
    }
  })
})
