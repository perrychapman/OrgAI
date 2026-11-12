import { describe, expect, it } from 'vitest'
import type { Schedule, ScheduleHistoryEntry, ScheduleSkipReason } from '../types'
import {
  SKIP_REASON_TEXT,
  formNextRuns,
  formProblems,
  formTiming,
  formToSaveInput,
  historyCost,
  historyRow,
  lastResultText,
  localInstant,
  newScheduleForm,
  nextRunView,
  outcomeText,
  relativeUntil,
  resultText,
  resultWhy,
  scheduleChip,
  scheduleRow,
  scheduleRows,
  scheduleToForm,
  schedulesFoldVerbs,
  sortHistory,
  targetText,
  toggleAction
} from './schedules'

const NOW = new Date(2026, 10, 12, 10, 0, 0, 0).getTime()
const H = 3_600_000

function sched(over: Partial<Schedule> = {}): Schedule {
  return {
    id: 'sch_abcd',
    name: 'Nightly PR review',
    prompt: 'Review new PRs.',
    target: { kind: 'team', projectId: 'p1' },
    timing: { kind: 'daily', time: '00:00' },
    enabled: true,
    missed: 'run-once',
    state: 'active',
    createdAt: NOW - 10 * H,
    updatedAt: NOW - H,
    createdBy: 'user',
    nextRunAt: NOW + 14 * H,
    consecutiveFailures: 0,
    unread: 0,
    ...over
  }
}
const entry = (over: Partial<ScheduleHistoryEntry> = {}): ScheduleHistoryEntry => ({
  id: 'h1',
  scheduleId: 'sch_abcd',
  slotAt: NOW - H,
  at: NOW - H,
  trigger: 'timer',
  result: 'started',
  ...over
})
const PROJECTS = [{ id: 'p1', name: 'Notes API' }]

describe('relativeUntil', () => {
  it('words future times and due ones', () => {
    expect(relativeUntil(NOW - 1, NOW)).toBe('due now')
    expect(relativeUntil(NOW + 20_000, NOW)).toBe('in under a minute')
    expect(relativeUntil(NOW + 5 * 60_000, NOW)).toBe('in 5 min')
    expect(relativeUntil(NOW + 3 * H, NOW)).toBe('in 3 h')
    expect(relativeUntil(NOW + 50 * H, NOW)).toBe('in 2 d')
  })
})

describe('nextRunView', () => {
  it('shows relative and absolute for an active schedule', () => {
    const v = nextRunView(sched(), NOW)
    expect(v.due).toBe(true)
    expect(v.relative).toBe('in 14 h')
    expect(v.absolute).toBe('13 Nov 2026 00:00')
  })
  it('explains why nothing is due', () => {
    expect(nextRunView(sched({ enabled: false, state: 'paused', nextRunAt: undefined }), NOW).relative).toBe('Not scheduled while paused')
    expect(nextRunView(sched({ state: 'done', nextRunAt: undefined }), NOW).relative).toBe('No more runs')
    expect(nextRunView(sched({ nextRunAt: undefined }), NOW).relative).toBe('Not scheduled')
    const held = nextRunView(sched(), NOW, true)
    expect(held.due).toBe(false)
    expect(held.relative).toMatch(/all schedules paused/)
  })
})

describe('scheduleChip and toggleAction', () => {
  it('maps every state', () => {
    expect(scheduleChip(sched())).toEqual({ label: 'Active', tone: 'success' })
    expect(scheduleChip(sched({ state: 'paused', enabled: false })).label).toBe('Paused')
    expect(scheduleChip(sched({ state: 'active', enabled: false })).label).toBe('Paused')
    expect(scheduleChip(sched({ state: 'error', stateReason: 'The project is gone.' }))).toEqual({ label: 'Needs attention', tone: 'warning', reason: 'The project is gone.' })
    expect(scheduleChip(sched({ state: 'error' })).reason).toMatch(/3 failed runs/)
    expect(scheduleChip(sched({ state: 'done' })).label).toBe('Done')
  })
  it('offers Pause, Resume or nothing', () => {
    expect(toggleAction(sched())).toBe('Pause')
    expect(toggleAction(sched({ enabled: false, state: 'paused' }))).toBe('Resume')
    expect(toggleAction(sched({ enabled: false, state: 'error' }))).toBe('Resume')
    expect(toggleAction(sched({ state: 'done' }))).toBeNull()
  })
})

describe('targetText', () => {
  it('names the project or the Chat folder', () => {
    expect(targetText({ kind: 'team', projectId: 'p1' }, PROJECTS)).toBe('Team run on Notes API')
    expect(targetText({ kind: 'team', projectId: 'p1', team: 'single' }, PROJECTS)).toBe('One assistant on Notes API')
    expect(targetText({ kind: 'team', projectId: 'gone' }, PROJECTS)).toBe('Team run on a project that no longer exists')
    expect(targetText({ kind: 'ask' }, PROJECTS)).toBe('Chat (scratch folder)')
    expect(targetText({ kind: 'ask', folder: 'C:\\work\\reports\\', allowEdits: true }, PROJECTS)).toBe('Chat in reports, can change files')
  })
})

describe('history wording', () => {
  it('has a sentence for every skip reason', () => {
    const reasons: ScheduleSkipReason[] = ['previous-running', 'too-many-running', 'app-closed', 'paused-globally', 'project-missing', 'usage-limited', 'start-refused']
    for (const r of reasons) {
      expect(SKIP_REASON_TEXT[r]).toMatch(/^Skipped: .+\.$/)
      expect(resultText({ result: 'skipped', reason: r })).toBe(SKIP_REASON_TEXT[r])
      expect(resultWhy({ result: 'skipped', reason: r })).toMatch(/^[A-Z0-9]/)
    }
    expect(resultText({ result: 'skipped', reason: 'too-many-running' })).toBe('Skipped: 2 scheduled runs were already going.')
  })
  it('appends OrgAI-written detail to refusals and failures only', () => {
    expect(resultText({ result: 'skipped', reason: 'start-refused', detail: 'The folder is not trusted.' })).toBe('Skipped: OrgAI could not start the run. The folder is not trusted.')
    expect(resultText({ result: 'skipped', reason: 'app-closed', detail: 'x' })).toBe(SKIP_REASON_TEXT['app-closed'])
    expect(resultText({ result: 'failed', detail: 'No model is set.' })).toBe('Could not start. No model is set.')
    expect(resultWhy({ result: 'failed' })).toBe('OrgAI could not start the run.')
    expect(resultWhy({ result: 'failed', detail: 'No model is set.' })).toBe('No model is set.')
    expect(resultText({ result: 'started' })).toBe('Started')
    expect(resultWhy({ result: 'started' })).toBe('')
  })
  it('words outcomes with the run status words', () => {
    expect(outcomeText(entry({ outcome: 'finished' }))).toBe('Finished')
    expect(outcomeText(entry({ outcome: 'error' }))).toBe('Failed')
    expect(outcomeText(entry({ outcome: 'stopped' }))).toBe('Stopped')
    expect(outcomeText(entry({ outcome: 'needs-you' }))).toBe('Needs you')
    expect(outcomeText(entry({ runId: 'run_1' }))).toBe('Running')
    expect(outcomeText(entry({ result: 'skipped', reason: 'app-closed' }))).toBe('')
  })
  it('never shows an unknown cost as $0', () => {
    expect(historyCost(entry())).toBeNull()
    expect(historyCost(entry({ costUsd: null }))).toEqual({ costUsd: null, costSource: 'unknown' })
    expect(historyCost(entry({ costUsd: 0.42 }))).toEqual({ costUsd: 0.42, costSource: 'computed', sourceMixed: true })
  })
  it('builds a row with trigger, tone and run link data', () => {
    const r = historyRow(entry({ trigger: 'catch-up', runId: 'run_1', projectId: 'p1', outcome: 'error', costUsd: 1 }))
    expect(r.trigger).toBe('Missed run, caught up')
    expect(r.tone).toBe('danger')
    expect(r.runId).toBe('run_1')
    expect(r.projectId).toBe('p1')
    expect(historyRow(entry({ trigger: 'manual' })).trigger).toBe('Run now')
    expect(historyRow(entry({ result: 'skipped', reason: 'paused-globally' })).tone).toBe('warning')
  })
  it('sorts newest first', () => {
    expect(sortHistory([entry({ id: 'a', at: 1 }), entry({ id: 'b', at: 3 }), entry({ id: 'c', at: 2 })]).map((e) => e.id)).toEqual(['b', 'c', 'a'])
  })
})

describe('rows', () => {
  it('derives the list row', () => {
    const r = scheduleRow(sched({ unread: 2, createdBy: 'agent' }), { now: NOW, projects: PROJECTS })
    expect(r).toMatchObject({ name: 'Nightly PR review', target: 'Team run on Notes API', timing: 'Every day at 00:00', unread: 2, toggle: 'Pause', fromAgent: true })
    expect(r.chip.label).toBe('Active')
    expect(r.lastResult).toBe('Not run yet')
  })
  it('falls back for last result without lastEntry', () => {
    expect(lastResultText(sched({ consecutiveFailures: 2 }))).toBe('2 failed in a row')
    expect(lastResultText(sched({ lastSlotAt: NOW - H }))).toBe('Last due 12 Nov 2026 09:00')
    expect(lastResultText(sched({ lastEntry: { at: NOW - H, slotAt: NOW - H, trigger: 'timer', result: 'started', outcome: 'finished', runId: 'r' } }))).toBe('Finished · 12 Nov 2026 09:00')
    expect(lastResultText(sched({ lastEntry: { at: NOW - H, slotAt: NOW - H, trigger: 'timer', result: 'skipped', reason: 'app-closed' } }))).toBe(`${SKIP_REASON_TEXT['app-closed']} · 12 Nov 2026 09:00`)
  })
  it('sorts by name and survives a malformed timing', () => {
    const rows = scheduleRows([sched({ id: 'sch_b', name: 'beta' }), sched({ id: 'sch_a', name: 'Alpha', timing: { kind: 'cron', expression: 'nope' } })], { now: NOW, projects: PROJECTS })
    expect(rows.map((r) => r.name)).toEqual(['Alpha', 'beta'])
    expect(rows[0].timing).toBe('Timing not valid')
  })
})

describe('editor mapping', () => {
  const roundTrip = (s: Schedule) => formToSaveInput(scheduleToForm(s, NOW), NOW, s)

  it('maps each preset to a ScheduleTiming', () => {
    const f = newScheduleForm({ projectId: 'p1', now: NOW })
    expect(formTiming({ ...f, preset: 'daily', time: '00:00' })).toEqual({ kind: 'daily', time: '00:00' })
    expect(formTiming({ ...f, preset: 'weekdays', time: '09:30' })).toEqual({ kind: 'daily', time: '09:30', days: [1, 2, 3, 4, 5] })
    expect(formTiming({ ...f, preset: 'weekly', days: [5, 1] })).toEqual({ kind: 'daily', time: '09:00', days: [1, 5] })
    expect(formTiming({ ...f, preset: 'weekly', days: [] })).toBe('Choose at least one day.')
    expect(formTiming({ ...f, preset: 'every', everyCount: '2', everyUnit: 'hours' })).toEqual({ kind: 'interval', everyMinutes: 120 })
    expect(formTiming({ ...f, preset: 'every', everyCount: '30', everyUnit: 'minutes' })).toEqual({ kind: 'interval', everyMinutes: 30 })
    expect(formTiming({ ...f, preset: 'once', onceDate: '2026-11-14', onceTime: '08:00' })).toEqual({ kind: 'once', at: new Date(2026, 10, 14, 8, 0).getTime() })
    expect(formTiming({ ...f, preset: 'custom', cron: '  0  0 * * 1 ' })).toEqual({ kind: 'cron', expression: '0 0 * * 1' })
  })

  it('round-trips every timing kind through the form', () => {
    const cases: Schedule['timing'][] = [
      { kind: 'daily', time: '00:00' },
      { kind: 'daily', time: '09:30', days: [1, 2, 3, 4, 5] },
      { kind: 'daily', time: '07:15', days: [0, 6] },
      { kind: 'interval', everyMinutes: 120, anchor: NOW - 5 * H },
      { kind: 'interval', everyMinutes: 45 },
      { kind: 'once', at: new Date(2026, 10, 14, 8, 0).getTime() },
      { kind: 'cron', expression: '0 0 * * 1' }
    ]
    for (const timing of cases) {
      const r = roundTrip(sched({ timing }))
      expect(r.ok, JSON.stringify(timing)).toBe(true)
      if (r.ok) expect(r.value.timing).toEqual(timing)
    }
  })

  it('round-trips targets and options, with expectedUpdatedAt on edit', () => {
    const s = sched({
      target: { kind: 'ask', folder: 'C:/work', allowEdits: true },
      missed: 'skip',
      modelSelection: { model: 'm-1', connection: 'default' },
      permissionMode: 'plan',
      budgetUsd: 2.5
    })
    const r = roundTrip(s)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toMatchObject({
      id: 'sch_abcd',
      expectedUpdatedAt: s.updatedAt,
      target: { kind: 'ask', folder: 'C:/work', allowEdits: true },
      missed: 'skip',
      modelSelection: { model: 'm-1', connection: 'default' },
      permissionMode: 'plan',
      budgetUsd: 2.5
    })
    expect(r.value.enabled).toBeUndefined()
    const single = roundTrip(sched({ target: { kind: 'team', projectId: 'p1', team: 'single' } }))
    expect(single.ok && single.value.target).toEqual({ kind: 'team', projectId: 'p1', team: 'single' })
  })

  it('clears optional fields with null on edit and omits them on create', () => {
    const s = sched({ modelSelection: { model: 'm', connection: 'c' }, permissionMode: 'plan', budgetUsd: 3 })
    const f = { ...scheduleToForm(s, NOW), model: null, permissionMode: '' as const, budget: '' }
    const r = formToSaveInput(f, NOW, s)
    expect(r.ok && r.value).toMatchObject({ modelSelection: null, permissionMode: null, budgetUsd: null })
    const created = formToSaveInput({ ...newScheduleForm({ projectId: 'p1', now: NOW }), name: 'n', prompt: 'p' }, NOW)
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.value.enabled).toBe(true)
    expect('modelSelection' in created.value || 'permissionMode' in created.value || 'budgetUsd' in created.value || 'id' in created.value).toBe(false)
  })

  it('reports field problems', () => {
    const f = newScheduleForm({ now: NOW })
    const p = formProblems({ ...f, targetKind: 'team', projectId: '', budget: '-1' }, NOW)
    expect(Object.keys(p).sort()).toEqual(['budget', 'name', 'project', 'prompt'])
    expect(formProblems({ ...f, name: 'x', prompt: 'y', budget: '5000' }, NOW).budget).toMatch(/at most \$1,000/)
    expect(formProblems({ ...f, preset: 'every', everyCount: '10', everyUnit: 'minutes' }, NOW).timing).toMatch(/15 minutes/)
    expect(formProblems({ ...f, preset: 'once', onceDate: '2020-01-01', onceTime: '08:00' }, NOW).timing).toBe('Choose a time in the future.')
    expect(formProblems({ ...f, preset: 'custom', cron: '* * * * *' }, NOW).timing).toMatch(/shortest allowed gap/)
    const r = formToSaveInput({ ...f, name: '', prompt: 'x' }, NOW)
    expect(r).toEqual({ ok: false, problem: 'Give the schedule a name.', field: 'name' })
  })

  it('lists the next three runs live, none while the timing is wrong', () => {
    const f = { ...newScheduleForm({ now: NOW }), preset: 'daily' as const, time: '00:00' }
    expect(formNextRuns(f, NOW)).toEqual([new Date(2026, 10, 13).getTime(), new Date(2026, 10, 14).getTime(), new Date(2026, 10, 15).getTime()])
    expect(formNextRuns({ ...f, preset: 'custom', cron: 'bad' }, NOW)).toEqual([])
  })

  it('parses local dates strictly', () => {
    expect(localInstant('2026-02-30', '08:00')).toBeNull()
    expect(localInstant('2026-02-28', '24:00')).toBeNull()
    expect(localInstant('2026-02-28', '08:05')).toBe(new Date(2026, 1, 28, 8, 5).getTime())
  })
})

describe('schedulesFoldVerbs', () => {
  it('names each change', () => {
    expect(
      schedulesFoldVerbs(
        [
          { action: 'create', schedule: { name: 'A', prompt: 'p', target: { kind: 'ask' }, timing: { kind: 'daily', time: '00:00' } }, summary: '', nextRuns: [] },
          { action: 'pause', scheduleId: 'sch_1', summary: '', nextRuns: [] },
          { action: 'remove', scheduleId: 'sch_2', summary: '', nextRuns: [] }
        ],
        (id) => (id === 'sch_1' ? 'Docs sync' : undefined)
      )
    ).toEqual(['new A', 'pause Docs sync', 'delete a schedule'])
  })
})
