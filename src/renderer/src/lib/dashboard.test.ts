import { describe, expect, it } from 'vitest'
import {
  LAST_SEEN_KEY,
  buildAttentionCtx,
  deleteProjectBody,
  elapsedLabel,
  endedKind,
  errorFirstLine,
  forgetConfirmText,
  forgetNoticeText,
  removeConfirmLabel,
  tileRemoveLabel,
  FIRST_LAUNCH_LINE,
  clockLabel,
  pausedRuns,
  resetsAtText,
  planStepLabel,
  projectAttentionOrder,
  readLastSeen,
  resetsInLabel,
  sinceLastSeen,
  statusSentence,
  writeLastSeen,
  type EndedRunLike,
  type StatusInput
} from './dashboard'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const NOW = 10 * DAY

describe('projectAttentionOrder', () => {
  const ps = [
    { id: 'a', name: 'Alpha' },
    { id: 'b', name: 'Beta' },
    { id: 'c', name: 'Gamma' },
    { id: 'd', name: 'Delta' }
  ]
  it('orders by decisions, live runs, newest start, then name', () => {
    const out = projectAttentionOrder(ps, {
      a: { decisions: 0, liveRuns: 1, newestStart: 5 },
      b: { decisions: 2, liveRuns: 0, newestStart: 1 },
      c: { decisions: 0, liveRuns: 0, newestStart: 9 },
      d: { decisions: 0, liveRuns: 0 }
    })
    expect(out.map((p) => p.id)).toEqual(['b', 'a', 'c', 'd'])
  })
  it('falls back to name when nothing differs and does not mutate', () => {
    const input = [ps[2], ps[0], ps[1]]
    const out = projectAttentionOrder(input, {})
    expect(out.map((p) => p.name)).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(input[0].id).toBe('c')
  })
  it('puts a project with no runs after one with an old run', () => {
    const out = projectAttentionOrder(ps.slice(0, 2), { b: { decisions: 0, liveRuns: 0, newestStart: 1 } })
    expect(out.map((p) => p.id)).toEqual(['b', 'a'])
  })
})

describe('buildAttentionCtx team files', () => {
  it('counts a team-files item as one decision of its project', () => {
    const ctx = buildAttentionCtx([], {}, [{ projectId: 'p9' }])
    expect(ctx.p9?.decisions).toBe(1)
  })
})

describe('buildAttentionCtx', () => {
  it('counts live runs, decisions and the newest start from runs and history', () => {
    const ctx = buildAttentionCtx(
      [
        {
          summary: { id: 'r1', projectId: 'p1', status: 'running', startedAt: 50 },
          agents: { a1: { name: 'X' } },
          questions: [{ id: 'q1', agentId: 'a1', question: 'Which?' }]
        },
        { summary: { id: 'r2', projectId: 'p1', status: 'finished', startedAt: 40 }, agents: {} }
      ],
      { p1: [{ id: 'r2', startedAt: 40 }], p2: [{ id: 'r3', startedAt: 7 }, { id: 'r4', startedAt: 9 }], p3: [] }
    )
    expect(ctx.p1).toEqual({ decisions: 1, liveRuns: 1, newestStart: 50 })
    expect(ctx.p2).toEqual({ decisions: 0, liveRuns: 0, newestStart: 9 })
    expect(ctx.p3).toEqual({ decisions: 0, liveRuns: 0 })
  })
})

describe('last seen storage', () => {
  const store = (initial?: string): { map: Map<string, string>; getItem(k: string): string | null; setItem(k: string, v: string): void } => {
    const map = new Map<string, string>()
    if (initial !== undefined) map.set(LAST_SEEN_KEY, initial)
    return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) }
  }
  it('round trips', () => {
    const s = store()
    writeLastSeen(s, 1234.9)
    expect(s.map.get(LAST_SEEN_KEY)).toBe('1234')
    expect(readLastSeen(s)).toBe(1234)
  })
  it('returns null for absent, junk and no storage', () => {
    expect(readLastSeen(store())).toBeNull()
    expect(readLastSeen(store('abc'))).toBeNull()
    expect(readLastSeen(store(''))).toBeNull()
    expect(readLastSeen(store('-5'))).toBeNull()
    expect(readLastSeen(store('Infinity'))).toBeNull()
    expect(readLastSeen(null)).toBeNull()
    expect(readLastSeen(undefined)).toBeNull()
  })
  it('tolerates throwing storage', () => {
    const bad = {
      getItem: (): string | null => {
        throw new Error('no')
      },
      setItem: (): void => {
        throw new Error('no')
      }
    }
    expect(readLastSeen(bad)).toBeNull()
    expect(() => writeLastSeen(bad, 5)).not.toThrow()
  })
  it('ignores a bad timestamp on write', () => {
    const s = store()
    writeLastSeen(s, NaN)
    writeLastSeen(s, 0)
    expect(s.map.size).toBe(0)
  })
})

describe('endedKind', () => {
  const r = (extra: Partial<EndedRunLike>): EndedRunLike => ({ id: 'r', status: 'finished', startedAt: 1, ...extra })
  it('classifies', () => {
    expect(endedKind(r({}))).toBe('finished')
    expect(endedKind(r({ status: 'error' }))).toBe('failed')
    expect(endedKind(r({ endedBy: 'user' }))).toBe('stopped')
    expect(endedKind(r({ endedBy: 'app', endedWhile: 'working' }))).toBe('closed')
    expect(endedKind(r({ endedBy: 'app', endedWhile: 'waiting' }))).toBe('closed-waiting')
    expect(endedKind(r({ endedWithApp: true }))).toBe('closed')
    expect(endedKind(r({ status: 'paused' }))).toBe('paused')
  })
  it('is null for live runs', () => {
    for (const status of ['starting', 'running', 'idle', 'stopping'] as const) expect(endedKind(r({ status }))).toBeNull()
  })
})

describe('sinceLastSeen', () => {
  const T0 = NOW - 2 * DAY
  const run = (id: string, startedAt: number, extra: Partial<EndedRunLike> = {}): EndedRunLike => ({ id, status: 'finished', startedAt, ...extra })
  it('keeps runs that ended after lastSeen, newest first, and skips live and paused ones', () => {
    const out = sinceLastSeen(
      [
        run('old', 1, { endedAt: T0 + 100 }),
        run('a', 1, { endedAt: T0 + 300 }),
        run('b', 2, { endedAt: T0 + 200, status: 'error' }),
        run('live', 3, { status: 'running' }),
        run('p', 4, { status: 'paused' })
      ],
      T0 + 150,
      NOW
    )
    expect(out.items.map((i) => i.run.id)).toEqual(['a', 'b'])
    expect(out.items[1].kind).toBe('failed')
    expect(out.more).toBe(0)
  })
  it('excludes a run that ended exactly at lastSeen', () => {
    expect(sinceLastSeen([run('a', 1, { endedAt: T0 })], T0, NOW).items).toHaveLength(0)
  })
  it('limits to 7 days', () => {
    const out = sinceLastSeen([run('in', 1, { endedAt: NOW - 6 * DAY }), run('out', 2, { endedAt: NOW - 8 * DAY })], 0, NOW)
    expect(out.items.map((i) => i.run.id)).toEqual(['in'])
  })
  it('keeps work and quick runs only', () => {
    const out = sinceLastSeen([run('w', 1, { endedAt: T0, kind: 'work' }), run('s', 2, { endedAt: T0, kind: 'setup' })], 0, NOW)
    expect(out.items.map((i) => i.run.id)).toEqual(['w'])
  })
  it('caps at 6 by default and counts the rest', () => {
    const rows = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => run(`r${n}`, n, { endedAt: T0 + n }))
    expect(sinceLastSeen(rows, 0, NOW).items).toHaveLength(6)
    const out = sinceLastSeen(rows, 0, NOW, { cap: 3 })
    expect(out.items.map((i) => i.run.id)).toEqual(['r8', 'r7', 'r6'])
    expect(out.more).toBe(5)
  })
  it('counts a duplicated run once', () => {
    const a = run('a', 1, { endedAt: T0 })
    expect(sinceLastSeen([a, { ...a }], 0, NOW).items).toHaveLength(1)
  })
  it('shows one row per chain, its newest member', () => {
    const first = run('c1', 1, { endedAt: T0, sessionId: 's' })
    const second = run('c2', 2, { endedAt: T0 + 50, sessionId: 's', resumedFrom: 'c1' })
    const out = sinceLastSeen([first, second], 0, NOW)
    expect(out.items.map((i) => i.run.id)).toEqual(['c2'])
  })
  it('hides a chain whose newest member is live', () => {
    const first = run('c1', 1, { endedAt: T0, sessionId: 's' })
    const second = run('c2', 2, { status: 'running', sessionId: 's', resumedFrom: 'c1' })
    expect(sinceLastSeen([first, second], 0, NOW).items).toHaveLength(0)
  })
  it('keeps a run cut while waiting until clearedAt passes it, other kinds follow lastSeen', () => {
    const cut = run('cut', 1, { endedAt: T0 + 100, endedBy: 'app', endedWhile: 'waiting' })
    const done = run('done', 2, { endedAt: T0 + 100 })
    const rows = [cut, done]
    const lastSeen = T0 + 500
    expect(sinceLastSeen(rows, lastSeen, NOW, { clearedAt: T0 }).items.map((i) => i.run.id)).toEqual(['cut'])
    expect(sinceLastSeen(rows, lastSeen, NOW, { clearedAt: T0 + 500 }).items).toHaveLength(0)
    expect(sinceLastSeen(rows, lastSeen, NOW).items).toHaveLength(0)
  })
})

describe('pausedRuns', () => {
  it('lists chains whose newest member is paused, newest start first', () => {
    const rows: EndedRunLike[] = [
      { id: 'a', status: 'paused', startedAt: 1 },
      { id: 'b', status: 'paused', startedAt: 5 },
      { id: 'c', status: 'finished', startedAt: 9 },
      { id: 'd1', status: 'paused', startedAt: 2, sessionId: 'x' },
      { id: 'd2', status: 'finished', startedAt: 3, sessionId: 'x', resumedFrom: 'd1' }
    ]
    expect(pausedRuns(rows).map((r) => r.id)).toEqual(['b', 'a'])
  })
})

describe('errorFirstLine', () => {
  it('takes the first non-empty line and cuts at 100', () => {
    expect(errorFirstLine('\n  Boom\nsecond')).toBe('Boom')
    expect(errorFirstLine(undefined)).toBe('')
    const cut = errorFirstLine('x'.repeat(150))
    expect(cut).toHaveLength(100)
    expect(cut.endsWith('…')).toBe(true)
  })
})

describe('elapsedLabel', () => {
  it('formats', () => {
    expect(elapsedLabel(NOW, NOW)).toBe('just started')
    expect(elapsedLabel(NOW - 59_000, NOW)).toBe('just started')
    expect(elapsedLabel(NOW - 4 * MIN, NOW)).toBe('4 min')
    expect(elapsedLabel(NOW - (HOUR + 12 * MIN), NOW)).toBe('1 h 12 min')
    expect(elapsedLabel(NOW - 2 * HOUR, NOW)).toBe('2 h')
    expect(elapsedLabel(NOW - 2 * DAY - HOUR, NOW)).toBe('2 d')
  })
  it('treats a future start as just started', () => {
    expect(elapsedLabel(NOW + 5 * MIN, NOW)).toBe('just started')
  })
})

describe('planStepLabel', () => {
  const plan = (status: string, ...s: string[]): { status: string; steps: { status: string }[] } => ({ status, steps: s.map((st) => ({ status: st })) })
  it('names the first step not done', () => {
    expect(planStepLabel(plan('active', 'done', 'done', 'in_progress', 'pending', 'pending', 'pending', 'pending'))).toBe('Step 3 of 7')
  })
  it('counts only steps that are not skipped', () => {
    expect(planStepLabel(plan('active', 'done', 'skipped', 'pending'))).toBe('Step 2 of 2')
    expect(planStepLabel(plan('active', 'skipped', 'pending', 'pending'))).toBe('Step 1 of 2')
  })
  it('says blocked and done from the plan status', () => {
    expect(planStepLabel(plan('blocked', 'done', 'pending'))).toBe('Plan blocked')
    expect(planStepLabel(plan('done', 'done'))).toBe('Plan done')
  })
  it('is null without a plan or counted steps', () => {
    expect(planStepLabel(null)).toBeNull()
    expect(planStepLabel(undefined)).toBeNull()
    expect(planStepLabel({ steps: [] })).toBeNull()
    expect(planStepLabel(plan('active', 'skipped'))).toBeNull()
  })
})

describe('statusSentence', () => {
  const base: StatusInput = { workingAgents: 0, agentRuns: 0, workingRuns: 0, openRuns: 0, pausedRuns: 0, closedWaiting: 0 }
  const s = (over: Partial<StatusInput>): string => statusSentence({ ...base, ...over })
  it('names working agents and their runs', () => {
    expect(s({ workingAgents: 1, agentRuns: 1, workingRuns: 1, openRuns: 1 })).toBe('1 agent working in 1 run.')
    expect(s({ workingAgents: 3, agentRuns: 2, workingRuns: 2, openRuns: 4 })).toBe('3 agents working in 2 runs.')
  })
  it('falls back to working runs, then open runs, then nothing', () => {
    expect(s({ workingRuns: 2, openRuns: 2 })).toBe('2 runs working.')
    expect(s({ workingRuns: 1, openRuns: 1 })).toBe('1 run working.')
    expect(s({ openRuns: 1 })).toBe('1 run open, none working.')
    expect(s({ openRuns: 3 })).toBe('3 runs open, none working.')
    expect(s({})).toBe('Nothing is running.')
  })
  it('never mentions decisions', () => {
    expect(s({ openRuns: 2 })).not.toMatch(/decision|need/i)
  })
  it('adds paused, with the soonest resume time when there is one', () => {
    expect(s({ pausedRuns: 2 })).toBe('Nothing is running. 2 paused.')
    const at = new Date(2026, 10, 7, 14, 5).getTime()
    const time = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    expect(s({ pausedRuns: 1, pausedUntil: at })).toBe(`Nothing is running. 1 paused until ${time}.`)
    expect(s({ pausedRuns: 1, pausedUntil: null })).toBe('Nothing is running. 1 paused.')
  })
  it('keeps the runs cut by a quit', () => {
    expect(s({ closedWaiting: 1 })).toBe('Nothing is running. 1 was waiting on you when OrgAI closed.')
    expect(s({ closedWaiting: 2, openRuns: 1, workingRuns: 1, pausedRuns: 1 })).toBe('1 run working. 1 paused. 2 were waiting on you when OrgAI closed.')
  })
  it('welcomes on first launch', () => {
    expect(s({ firstLaunch: true, workingAgents: 4 })).toBe(`Welcome to OrgAI. ${FIRST_LAUNCH_LINE}`)
  })
})

describe('resetsAtText and clockLabel', () => {
  const now = new Date(2026, 10, 7, 12, 0, 0).getTime()
  it('prints a clock time within a day and the weekday beyond', () => {
    const soon = new Date(2026, 10, 7, 14, 10).getTime()
    expect(resetsAtText(soon, now)).toBe(clockLabel(soon))
    expect(resetsAtText(soon, now)).not.toMatch(/[A-Za-z]{3}/)
    const later = new Date(2026, 10, 12, 9, 0).getTime()
    expect(resetsAtText(later, now)).toContain(new Date(later).toLocaleDateString([], { weekday: 'short' }))
  })
  it('is empty for unknown times', () => {
    expect(resetsAtText(null, now)).toBe('')
    expect(clockLabel(undefined)).toBe('')
  })
})

describe('resetsInLabel', () => {
  const now = new Date(2026, 10, 7, 12, 0, 0).getTime()
  it('is empty without a reset time', () => {
    expect(resetsInLabel(null, now)).toBe('')
    expect(resetsInLabel(undefined, now)).toBe('')
    expect(resetsInLabel(Number.NaN, now)).toBe('')
  })
  it('counts down in minutes and hours', () => {
    expect(resetsInLabel(now + 30_000, now)).toBe('resets in under a minute')
    expect(resetsInLabel(now - 5_000, now)).toBe('resets in under a minute')
    expect(resetsInLabel(now + 25 * MIN, now)).toBe('resets in 25 min')
    expect(resetsInLabel(now + 2 * HOUR + 10 * MIN, now)).toBe('resets in 2 h 10 min')
    expect(resetsInLabel(now + 3 * HOUR, now)).toBe('resets in 3 h')
  })
  it('names the weekday and time from 24 h on', () => {
    const at = new Date(2026, 10, 12, 9, 0).getTime()
    const label = resetsInLabel(at, now)
    expect(label).toBe(`resets ${new Date(at).toLocaleDateString([], { weekday: 'short' })} ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`)
    expect(resetsInLabel(now + 24 * HOUR, now)).toMatch(/^resets \S+ \S+/)
  })
})

describe('deleteProjectBody', () => {
  const also = 'Its project skills and saved service secrets go too. Files in its folder are untouched.'
  it('covers the cases', () => {
    expect(deleteProjectBody({ openRuns: 1, historyRuns: 3 })).toBe(`Ends 1 open run and deletes the history, transcripts and costs of 3 runs. ${also}`)
    expect(deleteProjectBody({ openRuns: 2, historyRuns: 1 })).toBe(`Ends 2 open runs and deletes the history, transcripts and costs of 1 run. ${also}`)
    expect(deleteProjectBody({ openRuns: 0, historyRuns: 4 })).toBe(`Deletes the history, transcripts and costs of 4 runs. ${also}`)
    expect(deleteProjectBody({ openRuns: 0, historyRuns: 0 })).toBe('Removes the project from OrgAI. Files in its folder are untouched.')
  })
})

describe('forget an engagement', () => {
  const counts = {
    projectId: 'p',
    kind: 'engagement' as const,
    runsRemoved: 23,
    runsKept: 0,
    notesRemoved: 12,
    skillsRemoved: 3,
    documentRemoved: true,
    rulesRemoved: true,
    teamReviewRemoved: true,
    skillEvaluationRemoved: true,
    knowledgeRemoved: 0
  }
  it('words the menu item and button per kind', () => {
    expect(tileRemoveLabel('engagement')).toBe('Forget engagement…')
    expect(tileRemoveLabel('code')).toBe('Delete project…')
    expect(removeConfirmLabel('engagement')).toBe('Forget engagement')
    expect(removeConfirmLabel('code')).toBe('Delete project')
  })
  it('lists the counts and leaves zero rows out', () => {
    const t = forgetConfirmText({ ...counts, knowledgeRemoved: 40 }, 1, 'Acme')
    expect(t.lines).toEqual([
      'The engagement plan',
      '12 context notes',
      '40 recorded items',
      'Saved permission rules',
      'Ends 1 open run and deletes 23 runs with their transcripts and costs',
      '3 skill copies made for it',
      '2 team review files'
    ])
    expect(t.uncounted).toBeNull()
    expect(t.stays).toContain('files in Acme')
    const bare = forgetConfirmText({ ...counts, runsRemoved: 0, notesRemoved: 0, skillsRemoved: 0, documentRemoved: false, rulesRemoved: false, teamReviewRemoved: false, skillEvaluationRemoved: false }, 0, '')
    expect(bare.lines).toEqual([])
  })
  it('names the kinds without numbers when the count is unavailable', () => {
    const t = forgetConfirmText(null, 0, 'Acme')
    expect(t.lines).toEqual([])
    expect(t.uncounted).toBe('its plan, context notes, what the team recorded, saved rules, runs and costs')
  })
  it('counts recorded items with the singular form', () => {
    expect(forgetConfirmText({ ...counts, knowledgeRemoved: 1 }, 0, 'Acme').lines).toContain('1 recorded item')
    expect(forgetNoticeText('Acme', { ...counts, knowledgeRemoved: 1 })).toBe('Forgot Acme. Deleted the plan, 12 notes, 1 recorded item, its saved rules, 23 runs, 3 skill copies.')
  })
  it('words the notice from the returned counts', () => {
    expect(forgetNoticeText('Acme', counts)).toBe('Forgot Acme. Deleted the plan, 12 notes, its saved rules, 23 runs, 3 skill copies.')
    expect(forgetNoticeText('Acme', { ...counts, knowledgeRemoved: 40 })).toBe('Forgot Acme. Deleted the plan, 12 notes, 40 recorded items, its saved rules, 23 runs, 3 skill copies.')
    expect(forgetNoticeText('Acme', { ...counts, runsRemoved: 0, notesRemoved: 0, skillsRemoved: 0, documentRemoved: false, rulesRemoved: false })).toBe('Forgot Acme.')
  })
})
