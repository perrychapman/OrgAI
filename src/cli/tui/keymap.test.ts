import { describe, expect, it } from 'vitest'
import { bindingsFor } from './decisions'
import { glyphLegend, helpKeyLines, hintItems, KEYMAP, keysFor, paneHint, scopeOf, statusHint, whichKeyLines, type KeyScope } from './keymap'
import { HELP_TEXT, SLASH_COMMANDS } from './slashCommands'

const UNI = { unicode: true, screenReader: false, dumbTerminal: false }
const SCOPES: KeyScope[] = ['global', 'composer', 'tree', 'transcript', 'plan', 'worktrees', 'inspector', 'tray']

describe('KEYMAP is the one table', () => {
  it('every entry appears in /help (HELP_TEXT), keys and label both', () => {
    for (const k of KEYMAP) {
      expect(HELP_TEXT, `${k.scope}: ${k.keys}`).toContain(k.keys)
      expect(HELP_TEXT, `${k.scope}: ${k.label}`).toContain(k.label)
    }
  })

  it('every entry appears in the which-key overlay of its pane, and the global ones in every overlay', () => {
    for (const scope of SCOPES) {
      if (scope === 'composer' || scope === 'tray' || scope === 'global') continue
      const text = whichKeyLines(scope, UNI).lines.join('\n')
      for (const k of [...keysFor(scope), ...keysFor('global')]) {
        expect(text, `${scope}: ${k.keys}`).toContain(k.keys)
        expect(text, `${scope}: ${k.label}`).toContain(k.label)
      }
    }
  })

  it('has the phase 1 keys and the new ones', () => {
    const tree = keysFor('tree').map((k) => k.keys).join(' | ')
    for (const needle of ['Up', 'Enter', 'Left', 'Right', 'h', 'n, N', 'z', 'Z, Backspace']) expect(tree).toContain(needle)
    expect(keysFor('inspector').map((k) => k.keys)).toEqual(expect.arrayContaining(['d', 'w', 't', 'u', 'Esc']))
    expect(keysFor('global').map((k) => k.keys)).toEqual(expect.arrayContaining(['?', '[ , ]', 'm']))
  })

  it('the slash commands the keys mention exist (/focus, /usage, /fold, /plan, /wt, /retro, /agent)', () => {
    const names = new Set(SLASH_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]))
    for (const n of ['focus', 'usage', 'fold', 'plan', 'wt', 'retro', 'agent', 'runs']) expect(names.has(n), n).toBe(true)
  })

  it('helpKeyLines starts with Keys and groups by pane', () => {
    const lines = helpKeyLines()
    expect(lines[0]).toBe('Keys')
    expect(lines).toEqual(expect.arrayContaining(['Agents', 'Agent inspector', 'Transcript', 'Worktrees', 'Plan', 'Composer']))
  })
})

describe('hints are pane-aware and short', () => {
  it('tree: 4 to 5 keys, swapped by row kind, always closing with ? all keys', () => {
    const agent = paneHint('tree', 'agent').split(' · ')
    const group = paneHint('tree', 'group').split(' · ')
    const waiting = paneHint('tree', 'waiting').split(' · ')
    for (const h of [agent, group, waiting]) {
      expect(h.length).toBeGreaterThanOrEqual(3)
      expect(h.length).toBeLessThanOrEqual(5)
      expect(h[h.length - 1]).toBe('? all keys')
    }
    expect(agent).toContain('Enter details')
    expect(group).toContain('Enter/Right unfold')
    expect(waiting).toContain('Enter decide')
    expect(agent).not.toContain('Enter/Right unfold')
  })

  it('the inspector hint changes with whether the agent needs you', () => {
    expect(paneHint('inspector', 'waiting')).toContain('d decide')
    expect(paneHint('inspector', 'agent')).toContain('w diff')
    expect(paneHint('inspector', 'agent')).not.toContain('d decide')
    expect(paneHint('inspector', 'bare')).not.toMatch(/w diff|d decide/)
  })

  it('with a width the least important keys drop and the closing ? all keys stays', () => {
    const wide = paneHint('tree', 'agent', 5)
    const narrow = paneHint('tree', 'agent', 5, 38)
    expect(narrow.length).toBeLessThanOrEqual(38)
    expect(narrow.length).toBeLessThan(wide.length)
    expect(narrow.endsWith('? all keys')).toBe(true)
    expect(narrow.startsWith('Up/Down move')).toBe(true)
  })

  it('the status hint for a pane is short and carries the Esc way back', () => {
    const h = statusHint('tree', { readOnly: false, stopOnQuit: false, row: 'agent' })
    expect(h.length).toBeLessThan(70)
    expect(h).toContain('? all keys')
    expect(h).toContain('Esc composer')
    expect(statusHint('composer', { readOnly: false, stopOnQuit: false })).toContain('Enter sends')
    expect(statusHint('composer', { readOnly: true, stopOnQuit: false })).not.toContain('Enter sends')
    expect(statusHint('composer', { readOnly: false, stopOnQuit: true })).toContain('stops and quits')
    expect(statusHint('tray', { readOnly: false, stopOnQuit: false })).toContain('Esc back')
  })

  it('the exact composer and tray hints, per buffer mode and separator rule', () => {
    const full = { unicode: true, screenReader: false, dumbTerminal: false, bufferMode: 'fullscreen' as const }
    const o = { readOnly: false, stopOnQuit: false }
    expect(statusHint('composer', { ...o, env: full })).toBe('Enter sends · / commands · Alt+D decisions · Tab panes · Esc Esc interrupts · Ctrl+C twice quits')
    const inline = statusHint('composer', { ...o, env: { ...full, bufferMode: 'inline' } })
    expect(inline).toBe('Enter sends · / commands · Alt+D decisions · /agent <name> shows an agent · Esc Esc interrupts · Ctrl+C twice quits')
    expect(inline).not.toContain('Tab panes')
    expect(statusHint('composer', { readOnly: true, stopOnQuit: false, env: { ...full, bufferMode: 'inline' } })).not.toContain('Tab panes')
    expect(statusHint('tray', { ...o, env: full })).toBe('Keys on the card · ? keys · Esc back')
    expect(statusHint('tray', { ...o, env: { ...full, screenReader: true } })).toBe('Keys on the card, ? keys, Esc back')
    expect(statusHint('tray', { ...o, env: { ...full, unicode: false } })).toBe('Keys on the card | ? keys | Esc back')
    expect(statusHint('composer', { ...o, env: { ...full, screenReader: true } })).not.toContain('·')
    expect(hintItems('a · b · c', ' · ')).toEqual(['a', 'b', 'c'])
  })

  it('the Esc, ? and tray wording', () => {
    const find = (scope: string, keys: string) => KEYMAP.find((k) => k.scope === scope && k.keys === keys)
    expect(find('global', 'Esc')?.label).toBe('From a pane: back to the composer. On the composer: press Esc twice to interrupt the running turn')
    expect(find('global', '?')?.label).toBe('The keys of the focused pane, the tray, or an empty composer')
    expect(find('composer', 'Esc')?.label).toBe('Interrupt the running turn (press twice)')
    expect(find('composer', 'Esc')?.hint?.text).toBe('Esc Esc interrupts')
    expect(find('composer', '? (empty composer)')?.label).toBe("The composer's keys")
    expect(find('tray', '?')?.label).toBe("The tray's keys")
    expect(find('tray', 'Permission')?.label).toContain('n deny (opens an optional note), v full view; y/s/a work once the end of the command was shown (a cut command needs v)')
    // L7: scrolling and the way back apply to every card kind.
    expect(find('tray', 'Up, Down, PgUp, PgDn')?.label).toContain('every kind')
    expect(find('tray', 'Esc')?.label).toContain('every kind')
  })

  it('the tray status hint reads the KEYMAP entries, so there is no second copy to drift (M5)', () => {
    const o = { readOnly: false, stopOnQuit: false }
    const trayHints = KEYMAP.filter((k) => k.scope === 'tray' && k.hint).sort((a, b) => a.hint!.order - b.hint!.order).map((k) => k.hint!.text)
    expect(statusHint('tray', o)).toBe(trayHints.join(' · '))
    const composerHints = KEYMAP.filter((k) => k.scope === 'composer' && k.hint).sort((a, b) => a.hint!.order - b.hint!.order).map((k) => k.hint!.text)
    expect(statusHint('composer', o)).toBe([...composerHints, 'Ctrl+C twice quits'].join(' · '))
    // "Tab panes" is said once.
    expect(statusHint('composer', o).split('Tab panes').length - 1).toBe(1)
    expect(statusHint('composer', { ...o, readOnly: true }).split('Tab panes').length - 1).toBe(1)
  })

  it('scopeOf maps pane focus targets and not the palette', () => {
    expect(scopeOf('inspector')).toBe('inspector')
    expect(scopeOf('palette')).toBeUndefined()
  })
})

describe('glyph legend', () => {
  it('unicode, ascii and screen reader forms', () => {
    expect(glyphLegend(UNI).join(' ')).toContain('✓ finished')
    expect(glyphLegend({ ...UNI, unicode: false }).join(' ')).toContain('v finished')
    expect(glyphLegend({ ...UNI, unicode: false }).join(' ')).toContain('o idle')
    const sr = glyphLegend({ ...UNI, screenReader: true }).join(' ')
    expect(sr).not.toMatch(/[✓✗●◆]/)
    expect(sr).toContain('Needs you')
  })

  it('the overlay carries the legend line and points at /help', () => {
    const { title, lines } = whichKeyLines('tree', { ...UNI, unicode: false })
    expect(title).toBe('Keys: Agents')
    expect(lines.join('\n')).toContain('o idle  * thinking  # tool  ! needs you  > delegating  v finished  x failed')
    expect(lines.join('\n')).toContain('/help')
  })
})

describe('every card binding is in its KEYMAP tray label (M5)', () => {
  const base = { key: 'k', ref: { hostInstanceId: 'h', runId: 'r', requestId: 'q', kind: 'permission', revision: 1 }, runTag: 'R1', runKind: 'work', arrivedSeq: 1 }
  const perm = { id: 'q', runId: 'r', agentId: 'root', toolName: 'Bash', input: { command: 'ls' }, summary: 's', suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }], behavior: 'allow', destination: 'session' }], ruleLabels: ['Bash(ls:*)'] }
  const upsert = [{ id: 'gh', name: 'github', transport: 'stdio', command: 'npx', args: ['x@1.0.0'], source: 'agent' }]
  const cards: [string, string, unknown][] = [
    ['Permission', 'permission', { ...base, kind: 'permission', card: perm }],
    ['Permission', 'permission (reference folder)', { ...base, kind: 'permission', card: { ...perm, referenceFolder: '/refs' } }],
    ['Rule request', 'rules', { ...base, kind: 'rules', card: { id: 'q', runId: 'r', agentId: 'root', rules: ['Bash(gh:*)'], flagged: [] } }],
    ['Proposal', 'proposal (work, no secrets)', { ...base, kind: 'proposal', card: { id: 'q', runId: 'r', agentId: 'root', kind: 'settings', title: 't', payload: {} } }],
    ['Proposal', 'proposal (secrets)', { ...base, kind: 'proposal', card: { id: 'q', runId: 'r', agentId: 'root', kind: 'mcpServers', title: 't', payload: { upsert, secrets: [{ serverId: 'gh', kind: 'env', name: 'T' }] } } }],
    ['Proposal', 'proposal (setup)', { ...base, kind: 'proposal', runKind: 'setup', card: { id: 'q', runId: 'r', agentId: 'root', kind: 'settings', title: 't', payload: {} } }],
    ['Question', 'question (multiple, free text)', { ...base, kind: 'question', card: { id: 'q', runId: 'r', agentId: 'root', question: 'Q?', options: [{ label: 'A' }, { label: 'B' }], allowMultiple: true, allowFreeText: true } }],
    ['Question', 'question (single)', { ...base, kind: 'question', card: { id: 'q', runId: 'r', agentId: 'root', question: 'Q?', options: [{ label: 'A' }], allowMultiple: false, allowFreeText: false } }],
    ['Merge review', 'merge', { ...base, kind: 'merge', card: { id: 'q', runId: 'r', agentId: 'w', agentName: 'w', branch: 'b', path: '/x', changedFiles: [], stat: '', patch: '' } }],
    ['MCP install', 'mcpInstall', { ...base, kind: 'mcpInstall', card: { id: 'q', runId: 'r', agentId: 'root', reason: 'r', spec: upsert[0], requiredSecrets: [] } }]
  ]
  for (const [keys, name, card] of cards) {
    it(`${name}: every key and action is in the "${keys}" label`, () => {
      const label = (KEYMAP.find((k) => k.scope === 'tray' && k.keys === keys)?.label ?? '').toLowerCase()
      expect(label).not.toBe('')
      const bs = bindingsFor(card as never)
      expect(bs.length).toBeGreaterThan(0)
      for (const b of bs) {
        if (b.act === 'pick') {
          expect(label).toContain('1-9 pick')
          continue
        }
        const key = b.key
        const word = b.label.toLowerCase().split(' ')[0]
        expect(label, `${name}: ${b.key} ${b.label}`).toContain(`${key} ${word}`)
        if (b.twoStep) expect(label, `${name}: ${b.key} asks to confirm`).toMatch(/confirm|ask/)
        if (b.text === 'optional' && b.act === 'deny' && keys === 'Permission') expect(label).toContain('note')
      }
    })
  }
})
