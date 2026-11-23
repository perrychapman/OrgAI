import { describe, expect, it } from 'vitest'
import type { OrgChartProposalPayload, Role, RunRosterChange } from '../../shared/types'
import { orgChartAppliesNow, orgChartCardDiff, orgChartCardLines, orgChartRoleLines, orgChartSummaryLine, rosterNotice, type OrgCardFormat } from './orgChartCard'

const role = (id: string, over: Partial<Role> = {}): Role => ({
  id,
  slug: id,
  name: `Name ${id}`,
  description: `desc ${id}`,
  responsibilities: [`work ${id}`],
  prompt: `prompt ${id}`,
  tools: ['Read'],
  model: 'claude-sonnet-5',
  canSpawn: false,
  spawnable: [],
  requiredReports: [],
  reportsTo: null,
  position: { x: 0, y: 0 },
  color: '#ffffff',
  ...over
})

const lead = role('lead', { name: 'Lead', description: 'runs the team' })
const dev = role('dev', { name: 'Dev', description: 'builds', reportsTo: 'lead' })
const qa = role('qa', { name: 'QA', description: 'writes tests', reportsTo: 'lead', canSpawn: true, spawnable: ['dev'], requiredReports: ['dev'] })

const fmt: OrgCardFormat = {
  one: (s, max = 200) => String(s ?? '').slice(0, max),
  text: (s) => String(s ?? '')
}

const payload = (roles: Role[], over: Partial<OrgChartProposalPayload> = {}): OrgChartProposalPayload => ({ roles, rationale: '', ...over })

describe('orgChartCardDiff', () => {
  it('has no diff without a run baseline and without saved roles', () => {
    expect(orgChartCardDiff(payload([lead]), undefined)).toBeUndefined()
    expect(orgChartSummaryLine(payload([lead]), undefined)).toBeUndefined()
    expect(orgChartCardLines(payload([lead]), undefined, false, fmt)).toBeUndefined()
  })

  it('compares with the run when the card carries its own baseline, with the saved roles otherwise', () => {
    expect(orgChartCardDiff(payload([lead], { runBaseline: [lead] }), [lead, qa])?.against).toBe('run')
    expect(orgChartCardDiff(payload([lead], { runBaseline: [] }), [lead, qa])?.against).toBe('run')
    expect(orgChartCardDiff(payload([lead]), [lead, qa])?.against).toBe('saved')
  })

  it('treats a payload whose roles are not an array as an empty chart', () => {
    const broken = { roles: null, rationale: '', runBaseline: [lead] } as unknown as OrgChartProposalPayload
    const d = orgChartCardDiff(broken, undefined)
    expect(d?.diff.removed.map((r) => r.id)).toEqual(['lead'])
  })
})

describe('orgChartSummaryLine', () => {
  it('names what the card is compared with', () => {
    expect(orgChartSummaryLine(payload([lead, qa], { runBaseline: [lead] }), undefined)).toBe("1 added (compared with this run's team)")
    expect(orgChartSummaryLine(payload([lead]), [lead, qa])).toBe('1 removed (compared with the saved team)')
    expect(orgChartSummaryLine(payload([lead], { runBaseline: [lead] }), undefined)).toBe("No changes (compared with this run's team)")
  })
})

describe('orgChartCardLines', () => {
  const runBase = payload([lead, dev, qa], { runBaseline: [lead, dev] })

  it('shows an added role with its parent, its model and what it may start', () => {
    expect(orgChartCardLines(runBase, undefined, false, fmt)).toEqual([
      "1 added (compared with this run's team)",
      '+ QA (reports to Lead), Everyday: writes tests',
      '    spawns: Dev',
      '    must delegate to: Dev',
      '2 roles unchanged'
    ])
  })

  it('full adds the added role\'s responsibilities, tools and prompt', () => {
    const lines = orgChartCardLines(runBase, undefined, true, fmt) ?? []
    expect(lines).toContain('    * work qa')
    expect(lines).toContain('    Tools: Read')
    expect(lines).toContain('    Prompt:')
    expect(lines).toContain('      prompt qa')
    expect(lines).toContain('2 roles unchanged: Lead, Dev')
  })

  it('a changed role lists each field, and hides a long prompt behind v until full', () => {
    const before = role('dev', { name: 'Dev', description: 'builds', reportsTo: 'lead', model: 'claude-sonnet-5', effort: 'medium', prompt: 'the old text' })
    const after = role('dev', { name: 'Dev', description: 'builds', reportsTo: 'lead', model: 'claude-opus-4-1', effort: 'high', prompt: 'the new text\nsecond line' })
    const short = orgChartCardLines(payload([after], { runBaseline: [before] }), undefined, false, fmt) ?? []
    expect(short).toEqual([
      "1 changed (compared with this run's team)",
      '~ Dev',
      '    model: Everyday -> Deep',
      '    effort: medium -> high',
      '    prompt changed (v shows the new text)'
    ])
    const full = orgChartCardLines(payload([after], { runBaseline: [before] }), undefined, true, fmt) ?? []
    expect(full).toContain('    prompt changed')
    expect(full).toContain('    New prompt:')
    expect(full).toContain('      the new text')
    expect(full).toContain('      second line')
    expect(full).not.toContain('    prompt changed (v shows the new text)')
  })

  it('a changed responsibilities list shows both sides when full', () => {
    const before = role('dev', { name: 'Dev', reportsTo: 'lead', responsibilities: ['build it'] })
    const after = role('dev', { name: 'Dev', reportsTo: 'lead', responsibilities: ['build it', 'review it'] })
    const short = orgChartCardLines(payload([after], { runBaseline: [before] }), undefined, false, fmt) ?? []
    expect(short).toContain('    responsibilities changed (v shows them)')
    const full = orgChartCardLines(payload([after], { runBaseline: [before] }), undefined, true, fmt) ?? []
    expect(full).toEqual([
      "1 changed (compared with this run's team)",
      '~ Dev',
      '    responsibilities changed',
      '    Now:',
      '      * build it',
      '      * review it',
      '    Before:',
      '      * build it'
    ])
    const emptied = orgChartCardLines(payload([role('dev', { name: 'Dev', reportsTo: 'lead', responsibilities: [] })], { runBaseline: [before] }), undefined, true, fmt) ?? []
    expect(emptied).toContain('      (none)')
  })

  it('a renamed role says what it was called', () => {
    const before = role('r1', { slug: 'backend-dev', name: 'Backend Dev' })
    const after = role('r1', { slug: 'backend-developer', name: 'Backend Developer' })
    const lines = orgChartCardLines(payload([after], { runBaseline: [before] }), undefined, false, fmt) ?? []
    expect(lines[1]).toBe('~ Backend Developer (renamed from Backend Dev)')
    expect(lines).toContain('    name: Backend Dev -> Backend Developer')
    expect(lines).toContain('    id: backend-dev -> backend-developer')
  })

  it('a removed role keeps the parent it had', () => {
    const lines = orgChartCardLines(payload([lead], { runBaseline: [lead, qa] }), undefined, false, fmt) ?? []
    expect(lines).toEqual(["1 removed (compared with this run's team)", '- QA (was reporting to Lead)', '1 role unchanged'])
  })

  it('a role with no parent is nobody', () => {
    const lines = orgChartCardLines(payload([qa, dev], { runBaseline: [dev] }), undefined, false, fmt) ?? []
    expect(lines).toContain('+ QA (reports to nobody), Everyday: writes tests')
  })

  it('the rationale closes the card', () => {
    const lines = orgChartCardLines(payload([lead, qa], { runBaseline: [lead], rationale: '  no tester yet  ' }), undefined, false, fmt) ?? []
    expect(lines[lines.length - 1]).toBe('Why:   no tester yet  ')
    expect(orgChartCardLines(payload([lead, qa], { runBaseline: [lead], rationale: '   ' }), undefined, false, fmt)?.at(-1)).toBe('1 role unchanged')
  })

  it('full shows a long value whole, and keeps a value that has line breaks on one line', () => {
    const long = 'd'.repeat(500)
    const added = payload([lead, role('qa', { name: 'QA', reportsTo: 'lead', description: long })], { runBaseline: [lead] })
    expect((orgChartCardLines(added, undefined, true, fmt) ?? []).some((l) => l.includes(long))).toBe(true)
    const short = orgChartCardLines(added, undefined, false, fmt) ?? []
    expect(short.some((l) => l.includes(long))).toBe(false)
    expect(short.some((l) => l.includes(long.slice(0, 200)))).toBe(true)

    const before = role('dev', { name: 'Dev', reportsTo: 'lead', description: long })
    const after = role('dev', { name: 'Dev', reportsTo: 'lead', description: 'builds' })
    const both = payload([after], { runBaseline: [before] })
    // Both sides of a changed field: the whole text, so two values that differ only at the end do not read the same.
    expect((orgChartCardLines(both, undefined, true, fmt) ?? []).some((l) => l.includes(long))).toBe(true)
    const clipped = orgChartCardLines(both, undefined, false, fmt) ?? []
    expect(clipped.some((l) => l.includes(long))).toBe(false)
    expect(clipped.some((l) => l.includes(long.slice(0, 300)))).toBe(true)

    const wrapped = orgChartCardLines(payload([lead, role('qa', { name: 'QA', reportsTo: 'lead', description: 'first line\nsecond line' })], { runBaseline: [lead] }), undefined, true, fmt) ?? []
    expect(wrapped).toContain('+ QA (reports to Lead), Everyday: first line\nsecond line')
    expect(wrapped.filter((l) => l.startsWith('+ QA'))).toHaveLength(1)
  })

  it('every value the card shows goes through the formatter', () => {
    const upper: OrgCardFormat = { one: (s) => String(s ?? '').toUpperCase(), text: (s) => String(s ?? '').toUpperCase() }
    const lines = orgChartCardLines(payload([lead, qa], { runBaseline: [lead], rationale: 'need a tester' }), undefined, false, upper) ?? []
    expect(lines).toContain('+ QA (reports to LEAD), EVERYDAY: WRITES TESTS')
    expect(lines).toContain('Why: NEED A TESTER')
  })
})

describe('orgChartRoleLines', () => {
  const baseDev = role('dev', { name: 'Dev', description: 'builds', reportsTo: 'lead', tools: ['Read'] })
  const ops = role('ops', { name: 'Ops', reportsTo: 'lead' })
  const arch = role('arch', { name: 'Arch', reportsTo: 'lead' })
  const newQa = role('qa', { name: 'QA', reportsTo: 'lead' })
  const extra = role('newr', { name: 'New Role', reportsTo: 'lead' })
  const movedDev = role('dev', { name: 'Dev', description: 'builds', reportsTo: 'lead', tools: ['Read', 'Grep'], connection: 'ollama' })

  it('names the roles the card moves: added, then changed with the fields that change, then removed', () => {
    expect(orgChartRoleLines(payload([lead, movedDev, newQa], { runBaseline: [lead, baseDev, ops] }), undefined, fmt)).toEqual(['+ QA', '~ Dev: connection, tools', '- Ops'])
    // At the cap exactly, nothing is left out, so there is no "more" line.
    expect(orgChartRoleLines(payload([lead, movedDev, newQa], { runBaseline: [lead, baseDev, ops] }), undefined, fmt, 3)).toEqual(['+ QA', '~ Dev: connection, tools', '- Ops'])
  })

  it('a renamed role says what it was called, like the card\'s own line', () => {
    const before = role('r1', { slug: 'backend-dev', name: 'Backend Dev' })
    const after = role('r1', { slug: 'backend-developer', name: 'Backend Developer' })
    expect(orgChartRoleLines(payload([after], { runBaseline: [before] }), undefined, fmt)).toEqual(['~ Backend Developer (renamed from Backend Dev): name, id'])
  })

  it('cuts the list to max and says how many are left and that v shows them', () => {
    const p = payload([lead, movedDev, newQa, extra], { runBaseline: [lead, baseDev, ops, arch] })
    expect(orgChartRoleLines(p, undefined, fmt, 3)).toEqual(['+ QA', '+ New Role', '+3 more (v shows all)'])
    expect(orgChartRoleLines(p, undefined, fmt, 6)).toEqual(['+ QA', '+ New Role', '~ Dev: connection, tools', '- Ops', '- Arch'])
  })

  it('is an empty array when the card changes nothing', () => {
    expect(orgChartRoleLines(payload([lead, baseDev], { runBaseline: [lead, baseDev] }), undefined, fmt)).toEqual([])
  })

  it('is nothing when there is nothing to compare with', () => {
    expect(orgChartRoleLines(payload([lead]), undefined, fmt)).toBeUndefined()
  })

  it('names and field names go through the formatter', () => {
    const long = role('r9', { name: 'R'.repeat(80) })
    expect(orgChartRoleLines(payload([long], { runBaseline: [] }), undefined, fmt)).toEqual([`+ ${'R'.repeat(60)}`])
    const upper: OrgCardFormat = { one: (s, max = 200) => String(s ?? '').slice(0, max).toUpperCase(), text: (s) => String(s ?? '').toUpperCase() }
    expect(orgChartRoleLines(payload([lead, movedDev], { runBaseline: [lead, baseDev] }), undefined, upper)).toEqual(['~ DEV: CONNECTION, TOOLS'])
  })
})

describe('orgChartAppliesNow', () => {
  const card = (kind: string, effect: string | undefined, baseline: Role[] | undefined): { kind: string; effect?: string; payload?: unknown } => ({
    kind,
    ...(effect === undefined ? {} : { effect }),
    payload: payload(baseline ?? [], baseline === undefined ? {} : { runBaseline: baseline })
  })

  it('is true for a now or after-turn org chart card that carries the run baseline', () => {
    expect(orgChartAppliesNow(card('orgChart', 'now', [lead]))).toBe(true)
    expect(orgChartAppliesNow(card('orgChart', 'after-turn', [lead]))).toBe(true)
    expect(orgChartAppliesNow(card('orgChart', 'now', []))).toBe(true)
  })

  it('is false for a next-run card, a card without a baseline and any other kind', () => {
    expect(orgChartAppliesNow(card('orgChart', 'next-run', [lead]))).toBe(false)
    expect(orgChartAppliesNow(card('orgChart', undefined, [lead]))).toBe(false)
    expect(orgChartAppliesNow(card('orgChart', 'now', undefined))).toBe(false)
    expect(orgChartAppliesNow(card('mcpServers', 'now', [lead]))).toBe(false)
  })
})

describe('rosterNotice', () => {
  const change = (over: Partial<RunRosterChange> = {}): RunRosterChange => ({ added: [], changed: [], removed: [], deferred: [], ...over })

  it('says what the run\'s team became', () => {
    expect(rosterNotice(change({ added: ['r1'] }))).toEqual({ text: 'The team of this run changed: 1 role added.', tone: 'ok' })
    expect(rosterNotice(change({ added: ['r1', 'r2'] }))).toEqual({ text: 'The team of this run changed: 2 roles added.', tone: 'ok' })
    expect(rosterNotice(change({ changed: ['r1'], removed: ['r2', 'r3'] }))).toEqual({ text: 'The team of this run changed: 1 changed, 2 removed.', tone: 'ok' })
  })

  it('names a run that is not on screen by its tag', () => {
    expect(rosterNotice(change({ added: ['r1'] }), 'R2')?.text).toBe('The team of R2 changed: 1 role added.')
  })

  it('adds what waits for the next run, with the first deferred role and its reason', () => {
    const one = rosterNotice(change({ changed: ['r1'], deferred: [{ id: 'r9', name: 'QA', reason: 'The run was still starting' }] }))
    expect(one).toEqual({ text: 'The team of this run changed: 1 changed. 1 waits for the next run: QA: The run was still starting.', tone: 'warn' })
    const two = rosterNotice(change({ added: ['r1'], deferred: [{ id: 'r9', name: 'QA', reason: 'No budget left.' }, { id: 'r8', name: 'Dev', reason: 'other' }] }))
    expect(two?.text).toBe('The team of this run changed: 1 role added. 2 wait for the next run: QA: No budget left.')
    expect(two?.tone).toBe('warn')
  })

  it('is nothing when the change moved nothing', () => {
    expect(rosterNotice(change())).toBeUndefined()
  })
})

describe('rosterNotice with nothing applied', () => {
  it('says the team did not change when every role waits', () => {
    expect(rosterNotice({ added: [], changed: [], removed: [], deferred: [{ id: 'r1', name: 'Ops', reason: 'Its slug is taken' }] })).toEqual({
      text: 'The team of this run did not change. 1 waits for the next run: Ops: Its slug is taken.',
      tone: 'warn'
    })
  })
})
