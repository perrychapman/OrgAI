/**
 * /team (cli-parity 3.7): the saved roles as a tree at 80 and 120 columns, navigation, an edit round trip through the
 * commands' planner and projects:save, the "May spend more" confirmation, and errors shown in place.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeConfig, fixtureProject, mountView, TIERS, tick } from './configTestUtil'
import { char, env, key } from './panes/testUtil'
import { LIVE_RUN_NOTE, TeamView, type TeamViewProps } from './TeamView'

const mounted: { unmount(): void }[] = []
afterEach(() => {
  for (const r of mounted.splice(0)) r.unmount()
})

const ENV = env({ color: false })

function teamView(width: number, over: Partial<TeamViewProps> = {}, api = fakeConfig()) {
  const onClose = vi.fn()
  const v = mountView(() => <TeamView width={width} height={24} env={ENV} projectId="p1" api={api} onClose={onClose} {...over} />, ENV)
  mounted.push(v.r)
  return { ...v, api, onClose }
}

const widest = (frame: string): number => Math.max(...frame.split('\n').map((l) => [...l].length))

describe('Team view', () => {
  it('shows the saved roles as a tree with tier, model id, effort, staffing and "runs on" at 120 columns', async () => {
    const v = teamView(120)
    await tick(60)
    const f = v.frame()
    expect(f).toContain('Team of App (4 roles, saved)')
    expect(f).toMatch(/> Lead\s+deep \(claude-opus-5\) · high · as configured \(top\)/)
    expect(f).toMatch(/├─ Dev\s+everyday \(gw-mid\) · medium · as configured · on Gateway/)
    expect(f).toMatch(/│?\s+└─ Intern\s+fast \(claude-haiku-5\) · medium · as configured/)
    expect(f).toContain('Enter details')
    expect(widest(f)).toBeLessThanOrEqual(120)
  })

  it('fits 80 columns: the least important words go first, the keys wrap onto the footer', async () => {
    const v = teamView(80)
    await tick(60)
    const f = v.frame()
    expect(widest(f)).toBeLessThanOrEqual(80)
    expect(f).toContain('Lead')
    expect(f).toContain('deep (claude-opus-5)')
    expect(f).toContain('Esc back')
    expect(f).toContain('x remove')
  })

  it('Enter opens the details (prompt preview, tools, spawnable, MCP); Esc backs out one level, then closes', async () => {
    const v = teamView(100)
    await tick(60)
    await v.keys(key('down'), key('enter'))
    let f = v.frame()
    expect(f).toContain('Team · Dev')
    expect(f).toContain('runs on: Gateway (pinned')
    expect(f).toContain('spawning: Intern')
    expect(f).toContain('tools: Read')
    expect(f).toContain('MCP grants: none')
    expect(f).toContain('Prompt (')
    expect(f).toContain('You are dev.')
    await v.keys(key('escape'))
    f = v.frame()
    expect(f).toContain('Team of App')
    expect(v.onClose).not.toHaveBeenCalled()
    await v.keys(key('escape'))
    expect(v.onClose).toHaveBeenCalledTimes(1)
  })

  it('an edit round trip: effort lowered through the planner and saved with projects:save', async () => {
    const v = teamView(100)
    await tick(60)
    // Rows: Lead, Dev, Intern, Qa.
    await v.keys(key('down'), char('e'))
    expect(v.frame()).toContain('Effort of Dev')
    // default, low, medium (current): pick low.
    await v.keys(key('up'), key('enter'))
    expect(v.api.saves).toHaveLength(1)
    expect(v.api.saves[0].roles.find((r) => r.id === 'dev')?.effort).toBe('low')
    const f = v.frame()
    expect(f).toContain('Saved Dev: effort low.')
    expect(f).toMatch(/Dev\s+everyday \(gw-mid\) · low/)
  })

  it('a change that may spend more shows the sentence and saves only on y', async () => {
    const v = teamView(100)
    await tick(60)
    await v.keys(key('down'), key('down'), key('down'), char('m'))
    // Tiers first: top, deep, everyday (current), fast. Pick deep.
    expect(v.frame()).toContain('Model of Qa')
    await v.keys(key('up'), key('enter'))
    let f = v.frame()
    expect(f).toContain('May spend more:')
    expect(f).toContain('y confirms')
    await v.keys(char('n'))
    expect(v.api.saves).toHaveLength(0)
    await v.keys(char('m'), key('up'), key('enter'), char('y'))
    expect(v.api.saves).toHaveLength(1)
    const qa = v.api.saves[0].roles.find((r) => r.id === 'qa')!
    expect([qa.model, qa.tier]).toEqual([TIERS.deep, 'deep'])
    f = v.frame()
    expect(f).toContain('Saved Qa: model deep.')
  })

  it('shows a validation error in place (a taken slug) and a host error cleaned for the terminal', async () => {
    const api = fakeConfig()
    const v = teamView(100, {}, api)
    await tick(60)
    await v.keys(key('down'), char('n'))
    // Clear "Dev" and type "Qa".
    await v.keys(key('backspace'), key('backspace'), key('backspace'), char('Q'), char('a'), key('enter'))
    expect(v.frame()).toContain('the slug "qa" is taken by Qa')
    expect(api.saves).toHaveLength(0)
    api.failSave = 'Disk \x1b[31mfull\x07 now'
    await v.keys(char('e'), key('home'), key('enter'))
    const f = v.frame()
    expect(f).toContain('Disk full now')
    expect(f).not.toContain('\x07')
  })

  it('without an editor the prompt key names the command; with one it saves the edited prompt', async () => {
    let v = teamView(100)
    await tick(60)
    await v.keys(char('p'))
    expect(v.frame()).toContain('orgai team role set lead --edit')
    v.r.unmount()
    const editText = vi.fn(async (t: string) => `${t}\nAlways write tests.`)
    v = teamView(100, { editText })
    await tick(60)
    await v.keys(char('p'))
    await tick(60)
    expect(editText).toHaveBeenCalledWith('You are lead.\nWork carefully.')
    expect(v.api.saves[0].roles.find((r) => r.id === 'lead')?.prompt).toContain('Always write tests.')
  })

  it('adds a role under the selected one, removes one with a reparent choice, and says a live run keeps its team', async () => {
    const v = teamView(100, { liveRun: true })
    await tick(60)
    await v.keys(char('a'), char('O'), char('p'), char('s'), key('enter'))
    await tick(60)
    let f = v.frame()
    // Lead could already spawn, so nothing may spend more: saved at once.
    expect(v.api.saves).toHaveLength(1)
    expect(v.api.saves[0].roles.some((r) => r.name === 'Ops' && r.reportsTo === 'lead')).toBe(true)
    expect(f).toContain('Added Ops under Lead.')
    expect(f.replace(/\s*│\n│\s*/g, ' ')).toContain(LIVE_RUN_NOTE)
    // Remove Dev (it has Intern): pick who takes Intern, then confirm.
    await v.keys(key('home'), key('down'), char('x'))
    expect(v.frame()).toContain('who takes it?')
    await v.keys(key('home'), key('enter'))
    f = v.frame()
    expect(f).toContain('Remove Dev from App? Its report (Intern) moves to Lead.')
    await v.keys(char('y'))
    const last = v.api.saves.at(-1)!
    expect(last.roles.some((r) => r.id === 'dev')).toBe(false)
    expect(last.roles.find((r) => r.id === 'intern')?.reportsTo).toBe('lead')
  })

  it('refuses edits in a read-only session', async () => {
    const v = teamView(100, { readOnly: 'Another orgai owns this data folder.' })
    await tick(60)
    await v.keys(char('e'))
    expect(v.frame()).toContain('Read-only: Another orgai owns this data folder.')
    expect(v.api.saves).toHaveLength(0)
  })

  it('the top role cannot be reparented', async () => {
    const v = teamView(100, {}, fakeConfig(fixtureProject()))
    await tick(60)
    await v.keys(char('r'))
    expect(v.frame()).toContain('Lead is the top of the chart')
  })
})
