/**
 * /skills: the list at 120 columns, Space on/off (with the hint when no role holds the skill), the role ticks saved as
 * one complete set of role ids, the confirm naming the roles that lose a removal, adding a library skill for the roles
 * ticked, the text arriving after the details open (a failed read, a read overtaken by a newer one), the read-only
 * refusals, the live-run note, and Esc.
 * The host is an in-memory fake of TuiToolsApi that keeps a skill list and records every call.
 */
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Project, SkillContent, SkillFileInfo, SkillInfo, SkillLibraryInfo, SkillSpec } from '../../shared/types'
import { fixtureProject, mountView, tick } from './configTestUtil'
import { SKILLS_LIVE_NOTE, SkillsView, type SkillsViewProps } from './SkillsView'
import { char, env, key } from './panes/testUtil'
import type { SkillPatch, TuiToolsApi } from './toolsApi'

const mounted: { unmount(): void }[] = []
afterEach(() => {
  for (const r of mounted.splice(0)) r.unmount()
})

const ENV = env({ color: false })

const file = (path: string, bytes = 100): SkillFileInfo => ({ path, bytes })

const skill = (over: Partial<SkillSpec> & Pick<SkillSpec, 'id' | 'name'> & { grantedTo?: string[]; libraryMissing?: true }): SkillInfo => ({
  spec: {
    id: over.id,
    name: over.name,
    description: over.description ?? 'Use it for this work.',
    enabled: over.enabled ?? true,
    source: over.source ?? 'user',
    digest: over.digest ?? 'digest',
    files: over.files ?? [file('SKILL.md')],
    addedAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...(over.libraryId ? { libraryId: over.libraryId } : {})
  },
  grantedTo: over.grantedTo ?? [],
  ...(over.libraryMissing ? { libraryMissing: true } : {})
})

const libEntry = (id: string, name: string, description?: string): SkillLibraryInfo => ({
  entry: { id, name, description: description ?? '', source: 'user', digest: 'digest', files: [file('SKILL.md')], addedAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z' },
  usedBy: []
})

const text = (body: string): SkillContent => ({ skillMd: `---\nname: x\n---\n${body}`, body, files: [file('SKILL.md', 200)] })

const skills = (): SkillInfo[] => [
  skill({ id: 's1', name: 'Docs', description: 'Reads the project docs.', grantedTo: ['lead', 'dev'] }),
  skill({ id: 's2', name: 'Search', enabled: false, grantedTo: ['lead'] }),
  skill({ id: 's3', name: 'Tracker', description: 'Reads the issue tracker.' })
]

export interface FakeTools extends TuiToolsApi {
  stored: Project
  /** The skills the project holds (skills:list answers from this). */
  held: SkillInfo[]
  library: SkillLibraryInfo[]
  /** The text skills:read gives, by skill id. */
  texts: Record<string, SkillContent>
  /** Every skills:update the view made, in order. */
  updates: { skillId: string; patch: SkillPatch }[]
  /** Every skills:linkLibrary the view made. */
  links: { libraryId: string; roleIds: string[] }[]
  /** Every skills:remove the view made. */
  removes: string[]
  /** Every skills:read the view made. */
  reads: string[]
  /** Set to hold every read back until the test opens the gate. */
  gate?: Promise<void>
  /** Set to make skills:read fail with this message. */
  failRead?: string
  /** The text skillLibrary:read gives, by library id. */
  libTexts: Record<string, SkillContent>
  /** Every skillLibrary:read the view made. */
  libReads: string[]
  /** Set to make skillLibrary:read fail with this message. */
  failLibRead?: string
}

function fakeTools(over: Partial<Pick<FakeTools, 'held' | 'library'>> = {}): FakeTools {
  const done = (): { project: Project; skills: SkillInfo[] } => ({ project: structuredClone(api.stored), skills: structuredClone(api.held) })
  const api: FakeTools = {
    stored: fixtureProject(),
    held: skills(),
    library: [libEntry('l1', 'Notion', 'Reads and writes Notion pages.')],
    texts: { s1: text('Use it when the project docs matter.'), s2: text('Search the stored notes.'), s3: text('Read one issue at a time.') },
    updates: [],
    links: [],
    removes: [],
    reads: [],
    libTexts: { l1: text('Write the Notion page the user names.') },
    libReads: [],
    ...over,
    project: async () => structuredClone(api.stored),
    skills: async () => structuredClone(api.held),
    skillLibrary: async () => structuredClone(api.library),
    async readSkill(_projectId, skillId) {
      api.reads.push(skillId)
      if (api.gate) await api.gate
      if (api.failRead) throw new Error(api.failRead)
      const found = api.texts[skillId]
      if (!found) throw new Error('That skill has no text to read.')
      return structuredClone(found)
    },
    async readLibrarySkill(libraryId) {
      api.libReads.push(libraryId)
      if (api.failLibRead) throw new Error(api.failLibRead)
      const found = api.libTexts[libraryId]
      if (!found) throw new Error('That library skill has no text to read.')
      return structuredClone(found)
    },
    async updateSkill(_projectId, skillId, patch) {
      api.updates.push({ skillId, patch })
      api.held = api.held.map((s) => {
        if (s.spec.id !== skillId) return s
        if ('enabled' in patch) return { ...s, spec: { ...s.spec, enabled: patch.enabled } }
        return { ...s, grantedTo: [...patch.roleIds] }
      })
      return done()
    },
    async linkSkill(_projectId, libraryId, roleIds) {
      api.links.push({ libraryId, roleIds: [...roleIds] })
      const entry = api.library.find((e) => e.entry.id === libraryId)
      if (entry) {
        const spec: SkillSpec = { id: `sk-${libraryId}`, name: entry.entry.name, description: entry.entry.description, enabled: true, source: 'library', digest: 'digest', files: entry.entry.files, addedAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z', libraryId }
        api.held = [...api.held, { spec, grantedTo: [...roleIds] }]
      }
      return done()
    },
    async removeSkill(_projectId, skillId) {
      api.removes.push(skillId)
      api.held = api.held.filter((s) => s.spec.id !== skillId)
      return done()
    },
    // The view never touches the MCP half of the api.
    mcpServers: async () => [],
    mcpLibrary: async () => [],
    setMcp: async () => undefined as never,
    linkMcp: async () => undefined as never,
    removeMcp: async () => undefined as never,
    setMcpSecret: async () => undefined as never,
    setMcpLibrarySecret: async () => undefined as never
  }
  return api
}

function skillsView(width: number, over: Partial<SkillsViewProps> = {}, api = fakeTools()) {
  const onClose = vi.fn()
  const v = mountView(() => <SkillsView width={width} height={24} env={ENV} projectId="p1" api={api} onClose={onClose} {...over} />, ENV)
  mounted.push(v.r)
  return { ...v, api, onClose }
}

const widest = (frame: string): number => Math.max(...frame.split('\n').map((l) => [...l].length))
/** The frame's lines joined across the border, so a wrapped message can be read as one sentence. */
const unwrapped = (frame: string): string => frame.replace(/\s*│\n│\s*/g, ' ')
/** The row the frame highlights (its `> ` marker), the border aside; undefined when no row is highlighted. */
const selectedRow = (frame: string): string | undefined => frame.split('\n').map((l) => l.replace(/^│ /, '')).find((l) => l.startsWith('> '))
/** A read the test answers itself, in the order it wants. */
function deferredText(): { promise: Promise<SkillContent>; give(body: string): void } {
  let release = (_content: SkillContent): void => {}
  const promise = new Promise<SkillContent>((resolve) => {
    release = resolve
  })
  return { promise, give: (body) => release(text(body)) }
}
/** A read the test lets go when it wants it to finish. */
function deferred(): { promise: Promise<void>; open(): void } {
  let release = (): void => {}
  const promise = new Promise<void>((resolve) => {
    release = () => resolve()
  })
  return { promise, open: () => release() }
}

describe('Skills view', () => {
  it('lists every skill with its state, who holds it and what to watch out for', async () => {
    const v = skillsView(120)
    await tick(60)
    const f = v.frame()
    expect(f).toContain('Skills of App (3 skills)')
    expect(f).toMatch(/Docs\s+on · Lead, Dev/)
    expect(f).toMatch(/Search\s+off · Lead/)
    expect(f).toMatch(/Tracker\s+on · no role · no agent can load it/)
    expect(f).toContain('Space on/off')
    expect(f).toContain('l add from library')
    expect(widest(f)).toBeLessThanOrEqual(120)
  })

  it('fits 80 columns: the keys wrap onto the footer and every row stays inside', async () => {
    const v = skillsView(80)
    await tick(60)
    const f = v.frame()
    expect(widest(f)).toBeLessThanOrEqual(80)
    expect(f).toContain('Tracker')
    expect(f).toContain('Esc back')
  })

  it('Enter shows the loading line and then the skill text', async () => {
    const api = fakeTools()
    const gate = deferred()
    api.gate = gate.promise
    const v = skillsView(120, {}, api)
    await tick(60)
    await v.keys(key('enter'))
    let f = v.frame()
    expect(f).toContain('Skill · Docs')
    expect(f).toContain('granted to: Lead, Dev')
    expect(f).toContain('source: this project')
    expect(f).toContain('Loading the text...')
    expect(f).toContain('Up/Down scroll')
    gate.open()
    await tick(60)
    f = v.frame()
    expect(f).toContain('SKILL.md')
    expect(f).toContain('Use it when the project docs matter.')
    expect(f).not.toContain('Loading the text...')
    expect(api.reads).toEqual(['s1'])
  })

  it('a failed read says the text could not be read and keeps the details open', async () => {
    const api = fakeTools()
    api.failRead = 'The skill folder cannot be read.'
    const v = skillsView(120, {}, api)
    await tick(60)
    await v.keys(key('enter'))
    await tick(60)
    const f = v.frame()
    expect(f).toContain('Skill · Docs')
    expect(f).toContain('The text could not be read.')
    expect(f).not.toContain('Loading the text...')
    // The details line is the whole story: the status line stays free.
    expect(f).not.toContain('The skill folder cannot be read.')
  })

  it('a read that arrives after a newer one does not replace the newer text', async () => {
    const api = fakeTools()
    const first = deferredText()
    const second = deferredText()
    let call = 0
    api.readSkill = async (_projectId, skillId) => {
      api.reads.push(skillId)
      return (call++ === 0 ? first : second).promise
    }
    const v = skillsView(120, {}, api)
    await tick(60)
    // Open the details (read 1), then save (its re-read is read 2) and answer them the other way round.
    await v.keys(key('enter'))
    expect(v.frame()).toContain('Loading the text...')
    await v.keys(char(' '))
    expect(api.reads).toEqual(['s1', 's1'])
    second.give('new text')
    await tick(60)
    first.give('old text')
    await tick(60)
    const f = v.frame()
    expect(f).toContain('new text')
    expect(f).not.toContain('old text')
    expect(f).not.toContain('Loading the text...')
  })

  it('Esc closes the details first, then the view', async () => {
    const v = skillsView(120)
    await tick(60)
    await v.keys(key('enter'))
    expect(v.frame()).toContain('Skill · Docs')
    await v.keys(key('escape'))
    expect(v.frame()).toContain('Skills of App (3 skills)')
    expect(v.onClose).not.toHaveBeenCalled()
    await v.keys(key('escape'))
    expect(v.onClose).toHaveBeenCalledTimes(1)
  })

  it('Space turns the selected skill off and says so', async () => {
    const v = skillsView(120)
    await tick(60)
    await v.keys(char(' '))
    expect(v.api.updates).toEqual([{ skillId: 's1', patch: { enabled: false } }])
    const f = v.frame()
    expect(f).toContain('Turned Docs off.')
    expect(f).toMatch(/Docs\s+off · Lead, Dev/)
    expect(v.api.held.find((s) => s.spec.id === 's1')?.spec.enabled).toBe(false)
  })

  it('Space turns a skill on and says when no role holds it', async () => {
    const v = skillsView(120)
    await tick(60)
    await v.keys(key('down'), key('down'), char(' '))
    expect(v.api.updates).toEqual([{ skillId: 's3', patch: { enabled: false } }])
    expect(v.frame()).toContain('Turned Tracker off.')
    await v.keys(char(' '))
    await tick(60)
    expect(v.api.updates).toHaveLength(1)
    expect(v.frame()).toContain('Turn Tracker on?')
    await v.keys(char('y'))
    expect(v.api.updates[1].patch).toEqual({ enabled: true })
    expect(v.frame()).toContain('Turned Tracker on. No role holds it yet: press r.')
  })

  it('r ticks the roles that may load a skill; Enter saves the whole set', async () => {
    const v = skillsView(120)
    await tick(60)
    // Docs is held by Lead and Dev already: saving the boxes as they are changes nothing.
    await v.keys(char('r'))
    expect(v.frame()).toContain('Roles that may load Docs')
    expect(v.frame()).toContain('Space toggles')
    await v.keys(key('enter'))
    expect(v.frame()).toContain('Nothing changed.')
    expect(v.api.updates).toHaveLength(0)
    // Tick Qa as well, then save.
    await v.keys(char('r'), key('down'), key('down'), char(' '), key('enter'))
    await tick(60)
    expect(v.api.updates).toEqual([])
    await v.keys(char('y'))
    expect(v.api.updates).toEqual([{ skillId: 's1', patch: { roleIds: ['lead', 'dev', 'qa'] } }])
    const f = v.frame()
    expect(f).toContain('Docs is now granted to Lead, Dev, Qa.')
    expect(f).toMatch(/Docs\s+on · 3 roles/)
  })

  it('r unticks every role and the skill reaches no agent', async () => {
    const v = skillsView(120)
    await tick(60)
    await v.keys(char('r'), char(' '), key('down'), char(' '), key('enter'))
    expect(v.api.updates[0].patch).toEqual({ roleIds: [] })
    expect(v.frame()).toContain('Docs is now granted to no role.')
    expect(v.frame()).toMatch(/Docs\s+on · no role · no agent can load it/)
  })

  it('x names the roles that lose it and removes only on y', async () => {
    const v = skillsView(120)
    await tick(60)
    await v.keys(key('down'), char('x'))
    expect(v.frame()).toContain('Remove Search from this project?')
    expect(v.frame()).toContain('These roles lose it: Lead.')
    expect(v.frame()).toContain('Press y to remove, n or Esc to keep it.')
    expect(v.api.removes).toHaveLength(0)
    await v.keys(char('y'))
    expect(v.api.removes).toEqual(['s2'])
    const f = v.frame()
    expect(f).toContain('Removed Search.')
    expect(f).toContain('Skills of App (2 skills)')
  })

  it('keeps a row highlighted when the last skill in the list is removed', async () => {
    const v = skillsView(120)
    await tick(60)
    // Tracker is the last row: after its removal the selection falls back to the new last row.
    await v.keys(key('down'), key('down'), char('x'), char('y'))
    expect(v.api.removes).toEqual(['s3'])
    const f = v.frame()
    expect(f).toContain('Removed Tracker.')
    expect(selectedRow(f)).toContain('Search')
  })

  it('x says nothing about roles for a skill no role holds, and keeps the library entry', async () => {
    const api = fakeTools()
    api.held = [...api.held, skill({ id: 's4', name: 'Notion', libraryId: 'l1' })]
    const v = skillsView(120, {}, api)
    await tick(60)
    // Notion sorts between Docs and Search: open its details, then remove it.
    await v.keys(key('down'), key('enter'))
    expect(v.frame()).toContain('Skill · Notion')
    expect(v.frame()).toContain('source: library entry l1')
    await v.keys(char('x'))
    expect(v.frame()).toContain('Remove Notion from this project?')
    expect(v.frame()).not.toContain('These roles lose it')
    await v.keys(char('y'))
    expect(v.api.removes).toEqual(['s4'])
    expect(v.frame()).toContain('Skills of App')
    expect(v.api.library).toHaveLength(1)
  })

  it('l adds a library skill for the roles ticked', async () => {
    const v = skillsView(120)
    await tick(60)
    await v.keys(char('l'))
    expect(v.frame()).toContain('Add a skill from your library')
    expect(v.frame()).toContain('Notion')
    await v.keys(key('enter'))
    expect(v.frame()).toContain('Roles that may load Notion')
    expect(v.frame()).toContain('[ ] Lead')
    await v.keys(key('down'), char(' '), key('enter'))
    expect(v.api.links).toEqual([])
    await v.keys(char('y'))
    expect(v.api.links).toEqual([{ libraryId: 'l1', roleIds: ['dev'] }])
    const f = v.frame()
    expect(f).toContain('Added Notion for 1 role.')
    expect(f).toMatch(/Notion\s+on · Dev/)
  })

  it('l with nothing ticked adds the skill for no role', async () => {
    const v = skillsView(120)
    await tick(60)
    await v.keys(char('l'), key('enter'), key('enter'), char('y'))
    expect(v.api.links).toEqual([{ libraryId: 'l1', roleIds: [] }])
    expect(v.frame()).toContain('Added Notion. No role holds it yet: press r.')
  })

  it('l says so when the library has nothing else to add', async () => {
    const v = skillsView(120, {}, fakeTools({ library: [] }))
    await tick(60)
    await v.keys(char('l'))
    expect(v.frame()).toContain('Your library has no other skill to add. Add one with: orgai skills library create')
    expect(v.api.links).toHaveLength(0)
  })

  it('an empty project says how to add one and can still add its first skill', async () => {
    const v = skillsView(120, {}, fakeTools({ held: [] }))
    await tick(60)
    const f = v.frame()
    expect(f).toContain('Skills of App (0 skills)')
    expect(f).toContain('This project has no skills. Press l to add one from your library, or run: orgai skills create')
    await v.keys(char('l'))
    await tick(60)
    expect(v.frame()).toContain('Add a skill from your library')
    await v.keys(key('enter'))
    expect(v.frame()).toContain('Roles that may load Notion')
    await v.keys(key('down'), char(' '), key('enter'), char('y'))
    await tick(60)
    expect(v.api.links).toEqual([{ libraryId: 'l1', roleIds: ['dev'] }])
    expect(v.frame()).toContain('Added Notion for 1 role.')
  })

  it('refuses every edit in a read-only session', async () => {
    const v = skillsView(120, { readOnly: 'Another orgai owns this data folder.' })
    await tick(60)
    await v.keys(char(' '), char('r'), char('l'), char('x'))
    expect(v.frame()).toContain('Read-only: Another orgai owns this data folder.')
    expect(v.api.updates).toHaveLength(0)
    expect(v.api.links).toHaveLength(0)
    expect(v.api.removes).toHaveLength(0)
  })

  it('a live run that did not take the save itself gets the note after one', async () => {
    const v = skillsView(120, { liveRun: true })
    await tick(60)
    await v.keys(char(' '))
    const f = unwrapped(v.frame())
    expect(f).toContain('Turned Docs off.')
    expect(f).toContain(SKILLS_LIVE_NOTE)
  })

  it('Space on an off skill shows what it is and the first lines of SKILL.md, and saves only after y', async () => {
    const v = skillsView(120)
    await tick(60)
    await v.keys(key('down'), char(' '))
    await tick(60)
    const f = v.frame()
    expect(f).toContain('Turn Search on?')
    expect(f).toContain('Search the stored notes.')
    expect(f).toContain('SKILL.md')
    expect(f).toContain('source: this project')
    expect(v.api.updates).toHaveLength(0)
    await v.keys(char('y'))
    expect(v.api.updates).toEqual([{ skillId: 's2', patch: { enabled: true } }])
  })

  it('any other key cancels and saves nothing', async () => {
    const v = skillsView(120)
    await tick(60)
    await v.keys(key('down'), char(' '))
    await tick(60)
    await v.keys(key('enter'))
    expect(v.frame()).not.toContain('Turn Search on?')
    expect(v.api.updates).toHaveLength(0)
  })

  it('refuses the widening save when SKILL.md cannot be read: no confirmation, nothing saved, the command named', async () => {
    const api = fakeTools()
    api.failRead = 'nope'
    const v = skillsView(120, {}, api)
    await tick(60)
    await v.keys(key('down'), char(' '))
    await tick(60)
    const f = unwrapped(v.frame())
    expect(f).toContain('could not be read, so it was not saved')
    expect(f).toContain('orgai skills command')
    expect(f).not.toContain('Turn Search on?')
    await v.keys(char('y'))
    expect(api.updates).toHaveLength(0)
  })

  it('reads SKILL.md again at confirm time instead of using the text cached for the details', async () => {
    const api = fakeTools()
    const v = skillsView(120, {}, api)
    await tick(60)
    await v.keys(key('down'), key('enter'))
    await tick(60)
    expect(v.frame()).toContain('Search the stored notes.')
    // The text changes on disk after the details cached it.
    api.texts.s2 = text('Search the NEW notes.')
    await v.keys(char(' '))
    await tick(60)
    const f = v.frame()
    expect(f).toContain('Turn Search on?')
    expect(f).toContain('Search the NEW notes.')
    expect(api.reads).toEqual(['s2', 's2'])
  })

  it('a read that fails at confirm time refuses even when the details cached the text before', async () => {
    const api = fakeTools()
    const v = skillsView(120, {}, api)
    await tick(60)
    await v.keys(key('down'), key('enter'))
    await tick(60)
    api.failRead = 'gone'
    await v.keys(char(' '))
    await tick(60)
    expect(unwrapped(v.frame())).toContain('was not saved')
    expect(v.frame()).not.toContain('Turn Search on?')
    await v.keys(char('y'))
    expect(api.updates).toHaveLength(0)
  })

  it('a confirmation that fit when it opened is closed, not accepted, after the window shrinks', async () => {
    const api = fakeTools()
    api.texts.s2 = text(Array.from({ length: 12 }, (_, i) => `rule number ${i}`).join('\n'))
    let resize: (rows: number) => void = () => undefined
    function Resizable() {
      const [rows, setRows] = useState(60)
      resize = setRows
      return <SkillsView width={120} height={rows} env={ENV} projectId="p1" api={api} onClose={() => undefined} />
    }
    const v = mountView(() => <Resizable />, ENV)
    mounted.push(v.r)
    await tick(60)
    await v.keys(key('down'), char(' '))
    await tick(60)
    expect(v.frame()).toContain('Turn Search on?')
    resize(14)
    await tick(60)
    await v.keys(char('y'))
    expect(api.updates).toHaveLength(0)
    expect(unwrapped(v.frame())).toContain('too long to show whole')
    expect(v.frame()).not.toContain('Turn Search on?')
    await v.keys(char('y'))
    expect(api.updates).toHaveLength(0)
  })

  it('a roles change that only removes saves at once; one that adds asks', async () => {
    const v = skillsView(120)
    await tick(60)
    // Docs is held by Lead and Dev: untick Dev.
    await v.keys(char('r'), key('down'), char(' '), key('enter'))
    expect(v.api.updates).toEqual([{ skillId: 's1', patch: { roleIds: ['lead'] } }])
    expect(v.frame()).not.toContain('load Docs?')
  })

  it('a library link names its source and shows the first lines of the entry\'s SKILL.md, read with skillLibrary:read', async () => {
    const v = skillsView(120)
    await tick(60)
    await v.keys(char('l'), key('enter'), key('enter'))
    await tick(60)
    const f = v.frame()
    expect(f).toContain('Add Notion from your library?')
    expect(f).toContain('source: library entry l1')
    expect(f).toContain('Write the Notion page the user names.')
    expect(f).not.toContain('cannot be read here')
    expect(v.api.libReads).toEqual(['l1'])
    await v.keys(char('q'))
    expect(v.api.links).toHaveLength(0)
  })

  it('a library link whose text cannot be read opens no confirmation and names the command', async () => {
    const api = fakeTools()
    api.failLibRead = 'no access'
    const v = skillsView(120, {}, api)
    await tick(60)
    await v.keys(char('l'), key('enter'), key('enter'))
    await tick(60)
    const f = unwrapped(v.frame())
    expect(f).toContain('could not be read, so it was not added')
    expect(f).toContain('orgai skills command')
    expect(f).not.toContain('Add Notion from your library?')
    await v.keys(char('y'))
    expect(api.links).toHaveLength(0)
  })

  it('a hostile description never reaches the frame as an escape', async () => {
    const api = fakeTools()
    api.held[1].spec.description = 'x\u001b[2Jy\u001b]0;pwn\u0007z‮w'
    const v = skillsView(120, {}, api)
    await tick(60)
    await v.keys(key('down'), char(' '))
    await tick(60)
    // eslint-disable-next-line no-control-regex
    expect(/[\u001b\u0007‮]/.test(v.frame())).toBe(false)
    expect(v.frame()).toContain('Turn Search on?')
  })

  it('Ctrl+C closes the view', async () => {
    const v = skillsView(120)
    await tick(60)
    await v.keys(key('char', { ch: 'c', ctrl: true, raw: '\u0003' }))
    expect(v.onClose).toHaveBeenCalledTimes(1)
  })
})
